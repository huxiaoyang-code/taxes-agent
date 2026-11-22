import assert from 'node:assert/strict';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {bind,http,note,read,save,sha,stdio} from './fixture.mjs';

export const targetPeriod='2026-10', next='2026-11', end='2026-12', asOf='2026-11-02';
const prior='2026-09', owner='合成青禾设备服务有限公司', issuer='合成嘉源机电';
const bill=(invoiceNumber,taxAmount,day)=>({invoiceNumber,taxAmount,issuer,issueDate:day,receipt:day,eligibility:'eligible'});
const months=[targetPeriod,next,end].map((period,i)=>({period,knownAt:'2026-10-31',basis:i?'forecast':'actual',salesExcludingVat:10000,outputVat:[600,700,500][i],state:'open',otherEffects:'none',prepaidVat:0,inputVatTransferOut:0}));
function sources(selection) {
  const originals={
    '九月底承接及客户约定':{
      opening:[{period:prior,knownAt:'2026-10-01',scope:'monthly_general_domestic',inventoryCoverage:'complete',carryCredit:0,ytdSalesExcludingVat:90000,ytdDueBeforePrepayment:3600,ytdComparable:true}],
      agreement:[{period:targetPeriod,effectiveThrough:end,knownAt:'2026-10-01',burdenMode:'monthly',minimumPercent:3}],
    },
    '购票登记及确认回单':{
      invoice:[bill('QH-0910',100,'2026-09-10'),bill('QH-0926',200,'2026-09-26')],
      confirmation:[{issuer,invoiceNumber:'QH-0910',taxPeriod:prior,knownAt:'2026-10-01',operationDate:'2026-10-01',receiptId:'SEP-CONFIRM-01'}],
    },
    '当期销项与后续预算':{month:selection?months:months.slice(0,2)},
    '九月申报及税款回单':{
      filing:[{period:prior,knownAt:'2026-10-08',receiptId:'SEP-FILING',declaredDue:250}],
      ...(selection?{event:[payment()]}:{}),
    },
  };
  if(selection)originals['购票登记及确认回单'].invoice.push(bill('QH-1020',150,'2026-10-20'),bill('QH-1101',70,'2026-11-01'),bill('QH-1116',500,'2026-11-16'));
  return originals;
}
function payment(){return {period:prior,knownAt:'2026-11-02',operationDate:'2026-10-09',eventId:'SEP-PAY-250',eventType:'payment',amount:250};}
function intake(f,originals,version){
  const path=join(f.audit,'agent-materials','资料定位-'+version+'.json');
  mkdirSync(join(f.audit,'agent-materials'),{recursive:true});
  const mappings=Object.keys(originals).map(name=>{
    const path=join(f.source,name+'.json'),doc=read(path);
    const tables=Object.entries(doc).filter(([,rows])=>Array.isArray(rows)).map(([kind,rows])=>({
      kind,rowsPointer:'/'+kind,fields:Object.fromEntries(Object.keys(rows[0]).map(key=>[key,{key}]))
    }));
    return {path,sha256:sha(path),ownerField:'name',owner:{jsonPointer:'/owner'},tables};
  });
  save(path,{version:'finance-vat-planning-materials/1',sources:mappings});return path;
}
export function planArgs(f){return {target:{accountSetId:f.accountSetId,period:targetPeriod},asOf,through:end,inputPath:f.inputPath};}
export async function seedVat(f){
  const account=await http(f.apiBase)('/api/account-sets',{name:owner,start_period:prior,taxpayer_type:'一般纳税人',enterprise:{enterpriseKey:'SYNTHETIC-QH-EVAL',enterpriseName:owner}});
  assert.equal(account.status,201,JSON.stringify(account.data));f.accountSetId=account.data.id;
  const selection=f.task==='vat-selection',originals=sources(selection);
  for(const [name,rows] of Object.entries(originals))save(join(f.source,name+'.json'),{owner,...rows});
  f.host=bind(f,selection?'host':'上次工作区',targetPeriod);
  f.inputPath=intake(f,originals,'初版');
  if(selection){
    note(f.host,'任务.txt','截至十一月二日，接上九月底的留抵和已用、未用票。十月能用的全选，与将十月新到的票留到十一月再选相比，哪种更符合我们已签的约定？两种都把十一月可用的新票用于十一月。把逐票去向、各月应纳、十月单月及累计税负、年底和付款月现金差异列出来。九月申报和银行实缴分别核实。留一份会计能继续使用的交接和报告。\n已核原件在业务资料目录，会计已整理位置索引 '+f.inputPath);
    return;
  }
  const old=await stdio(f,async call=>{
    const args=planArgs(f),inventory=await call('finance_vat_plan',args);
    const invoice=inventory.invoices.find(i=>i.taxAmount==='200.00');
    return call('finance_vat_plan',{...args,baseline:[],plan:[{invoiceRef:invoice.invoiceRef,period:targetPeriod}],handoff:{}});
  });
  f.previous=old.callRef;
  const history={callId:old.callRef,dataPath:old.handoff.dataPath,reportPath:old.handoff.reportPath,dataHash:sha(old.handoff.dataPath),reportHash:sha(old.handoff.reportPath),originals:read(old.handoff.dataPath).originals};
  save(join(f.reviewer,'before.json'),history);
  // 保存旧版本供验收者独立复核。客户提供同名登记表的新版本，既有底稿仍引用旧哈希。
  const changed='购票登记及确认回单',changedPath=join(f.source,changed+'.json');
  writeFileSync(join(f.reviewer,'旧购票登记.json'),readFileSync(changedPath),{flag:'wx'});
  originals[changed].invoice[1].taxAmount=220;
  writeFileSync(changedPath,JSON.stringify({owner,...originals[changed]},null,2)+'\n');
  originals['补到的九月税款支付凭证']={event:[payment()]};
  save(join(f.source,'补到的九月税款支付凭证.json'),{owner,...originals['补到的九月税款支付凭证']});
  f.inputPath=intake(f,originals,'补件后');
  f.host=bind(f,'host',next);
  note(f.host,'任务.txt','接上上次十月进项规划，十一月二日新到一张九月税款的银行支付回执，供应商同时交了更正登记表。按已约定的两种方案（保留未用，与最早可用时选用）续算。告诉我改了哪些所属期、付款月和底稿，哪些月份仍缺资料。保留上次版本，给下一位同事留下能从新工作区取回的报告、明细和待办。\n原件位置索引 '+f.inputPath);
}
