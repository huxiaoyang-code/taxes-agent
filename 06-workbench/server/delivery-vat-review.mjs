// 在原表的一般项目本月数中按栏次和项目双重定位，再独立核账与交付底稿。
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {parseCsv} from './csv-rows.mjs';
import {parseMoney,formatCents} from './money.mjs';
import {readDeliveryWorkbook} from './delivery-workbook.mjs';

const lines = [
  ['24', '本期应纳', 'currentMinor', /应纳税额合计|本期应纳/],
  ['25', '期初未缴', 'openingMinor', /期初未缴/],
  ['26', '出口退税', null, /实收出口.*退税额|出口退税/],
  ['27', '本期已缴', 'paidMinor', /本期已缴/],
  ['32', '期末未缴', 'closingMinor', /期末未缴/],
];
const norm = x => String(x ?? '').normalize('NFKC').replace(/\s/g,'');
function minor(value) {
  const text=norm(value);
  if(!/^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(text))return null;
  const n = parseMoney(text.replaceAll(',',''), {allowEmpty:false, allowNegative:true, maxCents:null});
  return n.ok && !n.subCent ? n.cents.toString() : null;
}
function field(headers, aliases) {
  const columns = headers.flatMap((v,i) => aliases.includes(norm(v)) ? [i] : []);
  return columns.length === 1 ? columns[0] : -1;
}
function declaredRows(rows) {
  for (let i=0; i<rows.length; i++) {
    const cols = [['纳税人名称','企业名称'],['所属期','税款所属期'],['栏次','行次'],
      ['项目','表内项目'],['一般项目本月数','一般项目/本月数']].map(keys=>field(rows[i],keys));
    if (cols.includes(-1)) continue;
    const other=field(rows[i],['即征即退项目本月数','即征即退项目/本月数']);
    const taxId=field(rows[i],['纳税人识别号','统一社会信用代码']);
    return rows.slice(i+1).map(row=>[...cols.map(k=>row[k]),other<0?'':row[other],taxId<0?'':row[taxId]]);
  }
  return null;
}
function readForm(file,timeLeft) {
  if (/\.csv$/i.test(file.name)) return declaredRows(parseCsv(file.bytes.toString('utf8')));
  if (/\.pdf$/i.test(file.name)) {
    const reader=fileURLToPath(new URL('./delivery-vat-pdf.py',import.meta.url));
    const run=spawnSync(process.env.FINANCE_PYTHON_PATH || (process.platform==='win32'?'python':'python3'),
      ['-E','-P',reader],{input:file.bytes,timeout:Math.max(1,Math.min(20000,timeLeft)),maxBuffer:1024*1024,windowsHide:true});
    if (run.status!==0) throw Error('vat_original_reader_unavailable');
    return JSON.parse(run.stdout.toString());
  }
  return null;
}
// 交接摘要把未标口径的应交税费与申报合计作差时，需要回到发生额、期末余额及申报栏次。
const amountText=String.raw`([+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?)`;
const vagueTaxBridge=new RegExp('账[载面](?:应交税费|应交增值税)[:=]?'+amountText+'元?[,，、]?(?:与|对比)(?:本期)?申报(?:数|合计)?[:=]?'+amountText+'元?[,，、]?(?:仅差|差额|相差|差)[:=]?'+amountText+'元?(?![.\\d])','u');
function vagueComparison(row){
  if(row.some(c=>typeof c==='string' && /历史|旧版|修前|原错误|原误|假设/u.test(c)))return null;
  for(const cell of row){
    if(typeof cell!=='string' || !cell.includes('申报'))continue;
    const match=vagueTaxBridge.exec(norm(cell));
    if(match)return match;
  }
  return null;
}
function tables(file) {
  if (/\.xlsx$/i.test(file.name)) return readDeliveryWorkbook(file.bytes)
    .filter(s=>/税费|增值税|账税/.test(s.name)||s.rows.some(r=>r.cells.some(c=>norm(c)==='税种')||vagueComparison(r.cells)))
    .map(s=>({name:file.name+' / '+s.name,rows:s.rows.map(r=>r.cells),numbers:s.rows.map(r=>r.number)}));
  if (/\.csv$/i.test(file.name)) {
    const numbers=[];
    return [{name:file.name,rows:parseCsv(file.bytes.toString('utf8'),numbers),numbers}];
  }
  if (/\.md$/i.test(file.name)) {
    const rows=[],numbers=[];
    for(const [index,text] of file.bytes.toString('utf8').split(/\r?\n/).entries()){
      const line=text.trim();
      if(line.startsWith('|')){rows.push(line.replace(/^\||\|$/g,'').split('|').map(s=>s.trim()));numbers.push(index+1);}
      else if(vagueComparison([line])){rows.push([line]);numbers.push(index+1);}
    }
    return [{name:file.name,rows,numbers}];
  }
  return [];
}
export function reviewDeliveryVat({files,sources,vatLedger,period,enterpriseName,enterpriseKey,taxpayerId}) {
  const issues=[], forms=[], coverage={originals:0,originalLines:0,workpapers:0,ledgerRows:0};
  const add=(code,location,owner='bookkeeper',detail={})=>issues.push({code,owner,location,...detail});
  const deadline=Date.now()+45000;
  for (const source of sources) {
    const csv=/\.csv$/i.test(source.name);
    if (!csv && !/\.pdf$/i.test(source.name)) continue;
    let rows;
    if(!csv&&Date.now()>=deadline){
      add('vat_source_scan_incomplete',source.name,'product',{note:'PDF识别未完成，需核定尚未读取的申报原件。'});
      break;
    }
    try { rows=readForm(source,deadline-Date.now()); } catch {
      // 无法辨认的文件可能是另一版申报原表，不能当作已排除。
      add('vat_original_reader_unavailable',source.name,'product');continue;
    }
    if (!rows) continue;
    if (!rows.length&&!/增值税.*申报|申报.*增值税/.test(source.name))continue;
    const current=rows.filter(row=>norm(row[1])===period);
    if (rows.length && !current.length) continue;
    const eligible=current.filter(r=>[enterpriseName,enterpriseKey].filter(Boolean).map(norm).includes(norm(r[0]))&&
      (!taxpayerId||!norm(r[6])||norm(r[6])===norm(taxpayerId)));
    if (!eligible.length) {add('vat_form_scope_unverified',source.name,'accountant');continue;}
    const values={};
    for (const [number,, ,title] of lines) {
      const candidates=eligible.filter(row=>norm(row[2]).split('=')[0]===number);
      const row=candidates[0], location=source.name+' / '+number+'栏';
      if(candidates.length!==1 || !title.test(norm(row[3])) || minor(row[4])===null) {
        add('vat_form_field_unverified',location,'accountant');continue;
      }
      if (norm(row[5]) && !['—','——','--'].includes(norm(row[5])) && minor(row[5])!=='0')
        add('vat_other_tax_scope_requires_review',location,'accountant');
      values[number]=minor(row[4]);
    }
    if (Object.keys(values).length===lines.length) forms.push({name:source.name,values});
  }
  coverage.originals=forms.length;
  if (!forms.length) add('vat_original_required','本期增值税申报原表','accountant');
  if (forms.some(f=>JSON.stringify(f.values)!==JSON.stringify(forms[0].values))) add('vat_original_versions_conflict','本期申报原表','accountant');
  const amounts=forms[0]?.values??{};
  coverage.originalLines=Object.keys(amounts).length;
  if (forms.length) {
    if (BigInt(amounts[24])+BigInt(amounts[25])+BigInt(amounts[26])-BigInt(amounts[27])!==BigInt(amounts[32]))
      add('vat_original_rollforward',forms[0].name,'accountant');
    for (const [number,label,ledgerKey] of lines.filter(l=>l[2])) {
      if(vatLedger?.[ledgerKey]==null) { add('vat_ledger_field_unverified',label,'accountant');continue; }
      coverage.ledgerRows++;
      if (String(vatLedger[ledgerKey])!==amounts[number]){
        const gap=BigInt(vatLedger[ledgerKey])-BigInt(amounts[number]);
        const carried=number==='32'&&vatLedger.openingMinor!=null&&
          BigInt(vatLedger.openingMinor)-BigInt(amounts[25])===gap&&
          String(vatLedger.currentMinor)===amounts[24]&&String(vatLedger.paidMinor)===amounts[27]&&amounts[26]==='0';
        add('vat_ledger_reconciliation',label+' / 第'+number+'栏','accountant',{actual:String(vatLedger[ledgerKey]),expected:amounts[number],
          differenceMinor:String(gap),note:carried?'本期发生、缴纳已核平；差额自期初延续，须查前期申报及缴退抵原件（金额单位：分）。':'金额单位：分。核对原表和同期未交增值税明细。'});
      }
    }
  }
  for (const file of files) {
    if(!/\.(?:xlsx|csv|md)$/i.test(file.name))continue;
    if(!/\.xlsx$/i.test(file.name)&&!['税种','应交税费','应交增值税'].some(term=>file.bytes.includes(Buffer.from(term))))continue;
    let docs;
    try { docs=tables(file); } catch { if(/税费|财务报表|增值税/.test(file.name))add('vat_workbook_unreadable',file.name,'product');continue; }
    for (const {name,rows,numbers} of docs) {
      const seen=new Set();let matched=false,cols,legacy,firstRow=0;
      function finishBlock(){
        if(matched){
          coverage.workpapers++;
          if(cols)for(const [,label,key] of lines)if(key&&!seen.has(label))
            add('vat_workpaper_comparison_missing',name+' / 表头行'+firstRow+' / '+label);
        }else if(cols&&/增值税/.test(name))add('vat_workpaper_empty',name+' / 表头行'+firstRow);
        seen.clear();matched=false;
      }
      for(const [index,row] of rows.entries()){
        const vague=vagueComparison(row);
        if(vague)add('vat_summary_basis_unverified',name+' / 第'+numbers[index]+'行','bookkeeper',{
          actual:'账 '+vague[1]+' 元 / 申报 '+vague[2]+' 元',expected:'本期发生对本期申报，期末余额对期末未缴',
          note:'摘要未指明账载口径与申报栏次。分别注明发生额、余额和各自差额，或引用已核底稿。'});
        const header=[['税种'],['核对项目','申报项目'],['申报栏次','栏次'],['申报金额','申报数'],['账载项目','账载口径'],['账载金额','账载数']].map(k=>field(row,k));
        if(row.some(c=>norm(c)==='税种')){
          finishBlock();firstRow=numbers[index];
          legacy={flow:row.findIndex(c=>/^申报.*应纳/.test(norm(c))),books:row.findIndex(c=>/^账载/.test(norm(c))),
            end:row.some(c=>/^账载期末/.test(norm(c))),period:field(row,['所属期','税款所属期']),subject:field(row,['企业名称','纳税人名称'])};
          cols=header.includes(-1)?undefined:header;
          continue;
        }
        if(cols?norm(row[cols[0]])!=='增值税':!row.some(c=>norm(c)==='增值税'))continue;
        matched=true;
        const location=name+' / 增值税第'+numbers[index]+'行';
        const statedPeriod=legacy?.period>=0?norm(row[legacy.period]):null;
        if(legacy?.period>=0&&statedPeriod!==period)add('vat_workpaper_period_mismatch',location,'bookkeeper',{actual:statedPeriod,expected:period});
        if(legacy?.subject>=0&&![enterpriseName,enterpriseKey].filter(Boolean).map(norm).includes(norm(row[legacy.subject])))
          add('vat_workpaper_subject_mismatch',location);
        if(!cols){
          if(legacy?.flow>=0&&legacy.books>=0&&(legacy.end||row.some(c=>/期末/.test(norm(c))))){
            add('vat_field_binding_mismatch',location,'bookkeeper',{actual:'申报本期 '+norm(row[legacy.flow])+' / 账载期末 '+norm(row[legacy.books]),
              expected:'第24栏对本期发生，第32栏对期末余额',note:'本期应纳与账载期末错配。按两个原表栏次分别重新生成同类底稿。'});
          }else add('vat_comparison_basis_missing',location,'bookkeeper',{note:'分别列本期应纳、期初未缴、本期已缴、期末未缴，注明原表栏次及账载口径。'});
          continue;
        }
        const [tax,label,line,claimed,bookLabel,bookValue]=cols.map(k=>norm(row[k]));
        if(tax!=='增值税')continue;
        const definition=lines.find(l=>l[1]===label&&l[2]);
        if(definition){
          if(seen.has(label))add('vat_duplicate_comparison',location);
          seen.add(label);
        }
        if(!definition||bookLabel!==label||definition[0]!==line.replace(/^第|栏$/g,'')){
          add('vat_field_binding_mismatch',location,'bookkeeper',{actual:line+' / '+bookLabel,
            expected:definition?definition[0]+' / '+label:label,note:'更正源栏次与账载字段绑定，重新生成使用该绑定的底稿。'});continue;
        }
        const declared=amounts[definition[0]],posted=vatLedger?.[definition[2]];
        if(!forms.length||minor(claimed)!==declared||posted==null||minor(bookValue)!==String(posted)){
          add('vat_workpaper_value_mismatch',location,'bookkeeper',{
            actual:'申报 '+claimed+' 元 / 账载 '+bookValue+' 元',
            expected:'原表 '+(declared==null?'待核':formatCents(declared)+' 元')+' / 账库 '+(posted==null?'待核':formatCents(posted)+' 元'),
            note:'按'+(forms[0]?.name??'本期原表')+'第'+definition[0]+'栏和同期账库的'+label+'分别重算。'});
        }
      }
      finishBlock();
    }
  }
  if(!coverage.workpapers)add('vat_workpaper_required','本期账税核对底稿');
  return {issues,coverage};
}
