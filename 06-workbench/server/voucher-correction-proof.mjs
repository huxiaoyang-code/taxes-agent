// 委托创建时固定原件版本。正式更正时从原件复读，工作区后来生成的取数表不能为自己作证。
import {createHash} from 'node:crypto';
import {lstatSync, readFileSync, readdirSync, realpathSync} from 'node:fs';
import {dirname, extname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {parseEvidenceCsv} from './business-evidence.mjs';
import {readXlsxStructure} from './offline-invoice-xlsx.mjs';
import {verifyDocument} from './voucher-correction-document.mjs';
import {parseMoney} from './money.mjs';
import {readBankImageRows} from './voucher-correction-image.mjs';
import {validateSchemaValue} from './harness-schema-validation.mjs';

const string = {type:'string', minLength:1, maxLength:2000};
const index = {type:'integer', minimum:1, maximum:10000};
const coordinates = {type:'array', minItems:4, maxItems:4, items:{type:'integer',minimum:0,maximum:32768}};
const columns = ['date','party','inflow','outflow','balance'];
const object = (properties,required) => ({type:'object',additionalProperties:false,properties,required});
const imageFields = ['date','party','amount','priorBalance','balance'];
const line = object({
  row:index, bankCode:string, counterCode:string,
  cells:object(Object.fromEntries(imageFields.map(k=>[k,coordinates])),imageFields),
},['row','bankCode','counterCode']);
export const CORRECTION_PROOF_SCHEMA = object({
  kind:{enum:['bank_statement','document']}, path:string, sha256:{type:'string',pattern:'^[a-f0-9]{64}$'},
  lines:{type:'array',minItems:1,maxItems:100,items:line},sheet:string,headerRow:index,
  columns:object(Object.fromEntries([...columns,'priorBalance'].map(k=>[k,string])),columns),
},['kind','path','sha256']);

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => {throw Object.assign(new Error(code),{code});};
const imageTypes = new Set(['.png','.jpg','.jpeg']);
const supported = new Set(['.json','.csv','.xlsx',...imageTypes]);

function regularFile(path,root) {
  const rel=relative(root,path);
  if (!rel || isAbsolute(rel) || rel==='..' || rel.startsWith('..'+sep)) fail('correction_original_outside_scope');
  for(let cursor=path;;cursor=dirname(cursor)){
    if(lstatSync(cursor).isSymbolicLink()) fail('correction_original_link');
    if(cursor===root) break;
    if(dirname(cursor)===cursor) fail('correction_original_outside_scope');
  }
  const st=lstatSync(path);
  if(!st.isFile() || st.nlink!==1 || st.size>8*1024*1024) fail('correction_original_file_invalid');
}

export function captureCorrectionSources(sourceRoot,{paths}={}){
  if(!sourceRoot || !isAbsolute(sourceRoot)) fail('correction_original_root_required');
  const root=realpathSync(sourceRoot), result=[];
  // 默认取原件目录的直接文件，混放旧整理件时宿主显式指定原件；子目录原件可显式选择。
  const files=paths??readdirSync(root,{withFileTypes:true}).filter(e=>e.isFile()).map(e=>join(root,e.name));
  for(const file of new Set(files)){
    const path=resolve(file);
    if(!supported.has(extname(path).toLowerCase())){
      if(paths) fail('correction_original_format_unsupported');
      continue;
    }
    if(!paths && lstatSync(path).size>8*1024*1024) continue;
    regularFile(path,root);
    result.push({path,sha256:sha(readFileSync(path))});
  }
  return result.sort((a,b)=>a.path.localeCompare(b.path));
}

function cents(value,optional=false) {
  // 不吞 OCR 中的异常字符；只接受合法的千分位格式。
  let v=typeof value==='string'?value.trim():value;
  if(typeof v==='string' && /^-?\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(v)) v=v.replaceAll(',','');
  const m=parseMoney(v,{allowNegative:true,allowEmpty:optional});
  if(!m.ok || m.subCent) fail('correction_original_amount_ambiguous');
  return m.cents;
}
function sideTotals(entries){
  const out=new Map();
  for (const {code,debit,credit} of entries){
    const d=cents(debit,true), c=cents(credit,true);
    if(d<0n || c<0n || (d===0n)===(c===0n)) fail('correction_entry_direction_invalid');
    const side=code+(d>0n?'/D':'/C');
    out.set(side,(out.get(side)??0n)+d+c);
  }
  return out;
}
function canonicalDate(value){
  const raw=String(value).trim();
  const match=/^(\d{4})[-年/.](\d{1,2})[-月/.](\d{1,2})日?$/.exec(raw)??/^(\d{4})(\d{2})(\d{2})$/.exec(raw);
  if(!match) fail('correction_original_date_ambiguous');
  const day=match[1]+'-'+match[2].padStart(2,'0')+'-'+match[3].padStart(2,'0');
  if(!Number.isFinite(Date.parse(day)) || new Date(day).toISOString().slice(0,10)!==day) fail('correction_original_date_ambiguous');
  return day;
}
const norm=v=>String(v??'').normalize('NFKC').replace(/\s+/g,'');
function matchesParty(name,party){
  return party && (name===party || ['-','—','/','／','：',':'].some(s=>name.endsWith(s+party)));
}

// 不能通过同时反选收付列和前后余额列，把一张真实收款单解释为付款。
const knownBankHeaders={
  date:['日期','交易日期','记账日期','交易日','date','transactiondate'],
  party:['户名','对方户名','对方名称','交易对手','交易对方','对方单位','party','counterparty'],
  inflow:['入','收入','收入金额','收入发生额','收款金额','入账金额','存入','存入金额','inflow','deposit'],
  outflow:['出','支出','支出金额','支出发生额','付款金额','转出金额','取出','取出金额','outflow','withdrawal'],
  balance:['余','余额','交易后余额','账户余额','本笔余额','账面余额','balance','closingbalance'],
  priorBalance:['前','上笔余额','前余额','交易前余额','期初余额','priorbalance','openingbalance'],
};

function readStatement(bytes,proof){
  const h=proof.headerRow??1, columns=proof.columns;
  if(!columns || new Set(Object.values(columns)).size!==Object.keys(columns).length) fail('correction_bank_columns_invalid');
  let headers, rows, layout;
  if(extname(proof.path).toLowerCase()==='.xlsx'){
    if(!proof.sheet) fail('correction_bank_columns_invalid');
    layout=readXlsxStructure(bytes,{sheet:proof.sheet});
    headers=layout.rows.find(r=>r.rowNumber===h)?.cells;
    rows=layout.rows.filter(r=>r.rowNumber>h).sort((a,b)=>a.rowNumber-b.rowNumber);
  }else if(extname(proof.path).toLowerCase()==='.csv'){
    const table=parseEvidenceCsv(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
    headers=table[h-1];
    rows=table.slice(h).map((cells,i)=>({rowNumber:h+i+1,cells}));
  }else fail('correction_bank_columns_invalid');
  const indices={};
  for(const [key,label] of Object.entries(columns)){
    const heading=norm(label).toLowerCase();
    if(Object.entries(knownBankHeaders).some(([other,names])=>other!==key && names.includes(heading))) fail('correction_bank_columns_invalid');
    const matching=headers?.flatMap((v,i)=>v===label?[i]:[])??[];
    if(matching.length!==1) fail('correction_bank_columns_invalid');
    indices[key]=matching[0];
  }
  return new Map(rows.map(({rowNumber,cells,types})=>{
    const record=Object.fromEntries(Object.entries(indices).map(([key,i])=>[key,cells[i]??'']));
    const type=types?.[indices.date];
    if(type?.type==='n' && record.date && !/^\d{8}$/.test(record.date)){
      const format=layout.formatCodes.get(type.format)??'';
      if(!/^\d{1,6}$/.test(record.date) || !(['14','15','22'].includes(type.format) || /^y{2,4}[-/]m{1,2}[-/]d{1,2}$/i.test(format)))
        fail('correction_original_date_ambiguous');
      const serial=Number(record.date);
      if(!layout.date1904 && serial<=60) fail('correction_original_date_ambiguous');
      const epoch=layout.date1904?Date.UTC(1904,0,1):Date.UTC(1899,11,30);
      record.date=new Date(epoch+serial*86400000).toISOString().slice(0,10);
    }
    return [rowNumber,record];
  }));
}

function evidenceRows(evidence,proof){
  return new Set((evidence?.mappings??[]).filter(m=>m.inputPointer.startsWith('/entries/')).flatMap(m=>m.sources??[])
    .filter(s=>s.sha256===proof.sha256 && (s.sheet??null)===(proof.sheet??null)).map(s=>s.row));
}

function verifyBank({before,after,proof,bytes,sourceRoot,accountName,previousEvidence,getPeers}){
  if(!proof.lines?.length || new Set(proof.lines.map(l=>l.row)).size!==proof.lines.length) fail('correction_bank_rows_required');
  const isImage=imageTypes.has(extname(proof.path).toLowerCase());
  const table=isImage?null:readStatement(bytes,proof);
  const imageRows=isImage?readBankImageRows(bytes,proof.lines):null;
  const entries=[],claimKeys=[],events=[];
  for(const [i,line] of proof.lines.entries()){
    const {row,bankCode,counterCode}=line;
    if(!bankCode.startsWith('1002') || !before.entries.some(e=>e.code===bankCode) || counterCode.startsWith('1002')) fail('correction_bank_account_mismatch');
    let date,party,diff,amount,balance;
    if(isImage){
      const read=imageRows[i];
      date=read.date; party=read.party; amount=cents(read.amount);
      balance=cents(read.balance);
      diff=balance-cents(read.priorBalance);
    }else{
      const record=table.get(row);
      if(!record) fail('correction_bank_rows_required');
      date=record.date; party=record.party;
      const inflow=cents(record.inflow,true), outflow=cents(record.outflow,true);
      if(inflow<0n || outflow<0n || (inflow===0n)===(outflow===0n)) fail('correction_bank_direction_ambiguous');
      amount=inflow+outflow;
      balance=cents(record.balance);
      const delta=inflow-outflow;
      if(record.priorBalance!==undefined){
        diff=balance-cents(record.priorBalance);
      }else{
        // 原件可能按交易倒序导出。只有相邻且业务日期不晚于当前行的前余额能核实该收付。
        const prior=[table.get(row-1),table.get(row+1)].find(r=>r?.balance &&
          (!r.date || canonicalDate(r.date)<=canonicalDate(date)) && balance-cents(r.balance)===delta);
        if(!prior) fail('correction_bank_balance_conflict');
        diff=balance-cents(prior.balance);
      }
      if(diff!==delta) fail('correction_bank_balance_conflict');
    }
    if(amount<=0n || (diff<0n?-diff:diff)!==amount) fail('correction_bank_balance_conflict');
    if(canonicalDate(date)!==after.voucher_date) fail('correction_bank_date_conflict');
    // 税款入库日期需查税款凭证；银行清算差一天不能单独推翻凭证日期。
    if(before.voucher_date!==after.voucher_date && [...before.entries,...after.entries].some(e=>e.code.startsWith('2221'))) fail('correction_tax_receipt_required');
    const name=norm(accountName(counterCode)), counterparty=norm(party);
    if(!matchesParty(name,counterparty)) fail('correction_bank_counterparty_mismatch');
    // 用原始交易内容定位，重复提供同一行、改用另一份同内容文件也不能重复入账。
    claimKeys.push(sha(JSON.stringify([canonicalDate(date),counterparty,diff.toString(),balance.toString()])));
    if(!isImage) claimKeys.push(sha(JSON.stringify([proof.sha256,proof.sheet??null,row])));
    events.push({row,date:canonicalDate(date),counterparty,diff,bankCode,counterCode});
    const num=Number(amount)/100;
    entries.push({code:bankCode,debit:diff>0n?num:0,credit:diff<0n?num:0},
      {code:counterCode,debit:diff<0n?num:0,credit:diff>0n?num:0});
  }
  const expected=sideTotals(entries), actual=sideTotals(after.entries);
  if(expected.size!==actual.size || [...expected].some(([k,v])=>actual.get(k)!==v)) fail('correction_bank_ledger_mismatch');
  // 防止把另一笔真实流水拿来替换一个完全无关的凭证。
  const old=sideTotals(before.entries);
  const changedDate=before.voucher_date!==after.voucher_date;
  const sameBankAmount=[...actual.keys()].filter(k=>k.startsWith('1002')).every(k=>old.get(k)===actual.get(k));
  const sharedParty=[...old.keys()].some(k=>!k.startsWith('1002') && expected.has(k));
  if(changedDate && (old.size!==actual.size || [...old].some(([k,v])=>actual.get(k)!==v))) fail('correction_bank_original_event_mismatch');
  if(new Set(claimKeys).size!==claimKeys.length) fail('correction_bank_row_duplicate');
  const priorRows=evidenceRows(previousEvidence,proof);
  const selected=new Set(proof.lines.map(l=>l.row));
  const linkedRows=!isImage && [...selected].every(row=>priorRows.has(row));
  const priorSources=(previousEvidence?.mappings??[]).flatMap(m=>m.sources??[]);
  if(priorSources.some(s=>s.path && resolve(s.path)===resolve(proof.path) && s.sha256 && s.sha256!==proof.sha256))
    fail('correction_original_revision_mismatch');
  if(!linkedRows){
    if(!sharedParty && (changedDate || !sameBankAmount)) fail('correction_bank_original_event_mismatch');
    // 也核对原件内尚未入账的其他候选交易；给出某一行的位置本身不能消除歧义。
    for(const [i,read] of (imageRows??[]).entries()){
      const event=events[i];
      for(const record of read.otherRows){
        const date=canonicalDate(record.date), sameParty=norm(record.party)===event.counterparty;
        const sameAmount=cents(record.amount)===(event.diff<0n?-event.diff:event.diff);
        if(changedDate?sameParty && sameAmount:date===event.date && (sharedParty && sameParty || sameBankAmount && sameAmount))
          fail('correction_bank_ambiguous_event');
      }
    }
    for(const [row,record] of table??[]){
      if(selected.has(row) || !record.date || (!record.inflow && !record.outflow)) continue;
      const date=canonicalDate(record.date);
      if(!changedDate && date!==after.voucher_date) continue;
      const net=cents(record.inflow,true)-cents(record.outflow,true);
      if(events.some(e=> (e.diff>0n)===(net>0n) &&
        (changedDate?net===e.diff && norm(record.party)===e.counterparty:
          (sharedParty && norm(record.party)===e.counterparty || sameBankAmount && net===e.diff))))
        fail('correction_bank_ambiguous_event');
    }
  }
  for(const peer of getPeers?.()??[]){
    if([...evidenceRows(peer.previousEvidence,proof)].some(row=>selected.has(row))) fail('correction_bank_ambiguous_event');
    if(!changedDate && peer.voucher_date!==after.voucher_date) continue;
    const bankLines=peer.entries.filter(e=>e.code.startsWith('1002'));
    const sides=new Map();
    for(const e of bankLines){
      const net=cents(e.debit,true)-cents(e.credit,true),side=e.code+(net>0n?'/D':'/C');
      sides.set(side,(sides.get(side)??0n)+(net<0n?-net:net));
    }
    const matchingBank=[...actual.keys()].filter(k=>k.startsWith('1002') && sides.has(k));
    const peerSharesParty=peer.entries.some(e=>!e.code.startsWith('1002') &&
      actual.has(e.code+(cents(e.debit,true)>0n?'/D':'/C')));
    const exactEvent=events.some(event=>{
      if(peer.voucher_date!==event.date) return false;
      const allocated=peer.entries.some(p=>p.code===event.counterCode && cents(p.credit,true)-cents(p.debit,true)===event.diff);
      const includesFlow=bankLines.some(p=>{
        const movement=cents(p.debit,true)-cents(p.credit,true);
        return event.diff>0n?movement>=event.diff:movement<=event.diff;
      });
      return allocated && includesFlow;
    });
    if(exactEvent || !linkedRows && (matchingBank.some(k=>sides.get(k)===actual.get(k)) ||
        !changedDate && sharedParty && peerSharesParty && matchingBank.length>0)) fail('correction_bank_ambiguous_event');
  }
  return claimKeys;
}

export function verifyCorrectionProof({before,after,proof,originals,sourceRoot,accountName,businessEvidence,previousEvidence,getPeers}){
  if(validateSchemaValue(CORRECTION_PROOF_SCHEMA,proof).length) fail('correction_proof_invalid');
  if(!sourceRoot || !isAbsolute(proof.path) || !Array.isArray(originals)) fail('correction_original_scope_required');
  const path=resolve(proof.path),root=realpathSync(sourceRoot);
  if(!originals.some(o=>o.path===path && o.sha256===proof.sha256)) fail('correction_original_not_delegated');
  regularFile(path,root);
  const bytes=readFileSync(path);
  if(sha(bytes)!==proof.sha256) fail('correction_original_changed');
  let claimKeys=[];
  if(proof.kind==='bank_statement') claimKeys=verifyBank({before,after,proof,bytes,sourceRoot:root,accountName,previousEvidence,getPeers});
  else claimKeys=verifyDocument({before,after,proof,path,root,businessEvidence,previousEvidence,getPeers});
  return {claimKeys,kind:proof.kind,sha256:proof.sha256,rows:proof.lines?.map(l=>l.row)??[],verified:true};
}
