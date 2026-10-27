import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync } from 'node:fs';
import { resolve,join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { prepareAnnualScenario } from './annual-close-harness.test.mjs';
import { callHarnessAdapter,harnessCapabilities } from '../server/harness-adapters.mjs';
export function preparePeriodScenario(directory,{compact=false}={}){
 const f=prepareAnnualScenario(directory,{empty:true});
 const janOriginal=join(f.root,'customer-originals','2026-01.original');writeFileSync(janOriginal,readFileSync(janOriginal,'utf8')+' 咨询服务业务日期明确为2026年1月18日。');
 const janPath=join(f.root,'customer-originals','2026-01.facts.json'),jan=JSON.parse(readFileSync(janPath,'utf8'));jan.records.find(r=>r.type==='service_complete').date='2026-01-18';writeFileSync(janPath,JSON.stringify(jan));
 const febPath=join(f.root,'customer-originals','2026-02.facts.json'),feb=JSON.parse(readFileSync(febPath,'utf8'));
 const raw=feb.records.find(r=>r.type==='period_coverage');feb.records.unshift({...raw,id:'independent-feb-expense',type:'expense',date:'2026-02-17',businessIdentity:{issuerKey:'SYNTHETIC-SUPPLIER',documentNumber:'FEB-ADMIN-1',event:'expense'},use:'admin',gross:'37.23',net:'37.23',invoiceTax:'0.00',inputVatTreatment:'non_deductible',settlement:'unpaid',benefitPeriod:'2026-02',taxNature:'ordinary'});writeFileSync(febPath,JSON.stringify(feb));
 const febOriginal=join(f.root,'customer-originals','2026-02.original');writeFileSync(febOriginal,readFileSync(febOriginal,'utf8').replace('本月无新增业务。','本月有以下独立业务。')+' 2月17日收到本月行政服务，37.23元、无税额、未付款，普通经营费用，仅本月受益；该业务与1月咨询独立。');
 if(compact){
  const old=f.target.enterpriseKey,newKey=old+'-COMPACT',env={...process.env,NODE_NO_WARNINGS:'1',WORKBENCH_DATA_DIR:dirname(f.target.dbPath)};
  const child=spawnSync(process.execPath,['--input-type=module','-e',`const A=await import(${JSON.stringify(new URL('../server/accounting.mjs',import.meta.url).href)}),{db}=await import(${JSON.stringify(new URL('../server/db.mjs',import.meta.url).href)});try{const created=A.createAccountSet({name:'Synthetic November new enterprise',start_period:'2026-11',profileId:'small-2011-basic-v1',enterprise:{enterpriseKey:${JSON.stringify(newKey)}}});A.ensurePeriod(created.id,'2027-01');console.log(JSON.stringify(created));}finally{db.close();}`],{env,encoding:'utf8',windowsHide:true});assert.equal(child.status,0,child.stderr);const account=JSON.parse(child.stdout);
  f.target={...f.target,enterpriseKey:newKey,accountSetId:account.id};f.scope={...f.scope,enterpriseKey:newKey,accountSetId:account.id};
  const dir=join(f.root,'agent-originals');mkdirSync(dir);const paths=[],sources=[],originals=[];
  const transform=text=>text.replaceAll('2026-01','2026-11').replaceAll('2026-02','2026-12').replaceAll('2026-Q1','2026-Q4').replaceAll(old,newKey).replaceAll('1月','11月').replaceAll('2月','12月');
  for(const [index,period]of ['2026-11','2026-12'].entries()){
   const oldPeriod=index===0?'2026-01':'2026-02',raw=JSON.parse(transform(readFileSync(join(f.root,'customer-originals',oldPeriod+'.facts.json'),'utf8')));raw.scope.accountSetId=account.id;
   const rawPath=join(dir,period+'.facts.json'),originalPath=join(dir,period+'.original');writeFileSync(rawPath,JSON.stringify(raw));writeFileSync(originalPath,transform(readFileSync(join(f.root,'customer-originals',oldPeriod+'.original'),'utf8'))+' 本企业2026年11月新设，之前无经营及余额，非真实企业。');
   sources.push({path:rawPath});originals.push({id:period,path:originalPath});const manifest=join(dir,period+'.manifest.json');writeFileSync(manifest,JSON.stringify({version:'agency-business-materials/1',scope:{...f.scope,period},sources:[...sources],originals:[...originals]}));paths.push(manifest);
  }
  f.manifestPaths=paths;f.sourcePath=join(dir,'2026-11.original');f.priorOriginal=join(dir,'prior.original');writeFileSync(f.priorOriginal,'合成目标企业2026年11月1日新设，之前无经营、账簿余额或历史税款；11月和12月原件完整，非真实企业或审定。');
 }
 const authorization={actor:'SYNTHETIC-TEST-OPERATOR',reason:'Synthetic test authorized period controls and correction of January business; not real accountant review',enterpriseKey:f.target.enterpriseKey,accountSetId:f.target.accountSetId,databaseInstanceId:f.target.databaseInstanceId,fromPeriod:compact?'2026-11':'2026-01',throughPeriod:'2027-01',actions:['period.reopen','period.unpost-derived','period.carryforward','period.close']};
 const metadata={...f,authorization,correctionPostingDate:compact?'2026-11-26':'2026-01-26',root:f.root};
 const put=(name,text)=>writeFileSync(join(f.root,name),compact?text.replaceAll('Jan','Nov').replaceAll('Feb','Dec').replaceAll('1-12月','11-12月').replaceAll('2026-01-26','2026-11-26'):text);
 put('metadata.json',JSON.stringify(metadata,null,2));
 put('goal-stage1.txt',`合成验收，资料及目标 ${join(f.root,'metadata.json')}。仅用Harness/MCP业务能力，自行建月Store及事实/任务，Jan agency.workpaper→agency.posting prepare，保留任务。不得自行制造会计接受；把原生proposal及storePath/taskId写 ${join(f.root,'pending-review.json')} 后停止。形状:{storePath,taskId,proposal,feedbackPath}，proposal完整来自原生prepare，不能自己算。不得读取independent-expectations或测试源码。`);
 put('goal-stage2.txt',`合成验收。读metadata.json和pending-review.json，反馈路径有验收者模拟接受。执行原Jan posting并query。然后通过Feb manifest重放2月独立费用，真实prepare Feb agency.posting。不得制造会计反馈；把原生proposal/storePath/taskId/feedbackPath写pending-feb-review.json，待验收者模拟接受后停止。原Jan成功会使上游旧workpaper stale；保留实际operation历史并刷新当前原件版本，不能重复入账。`);
 put('goal-stage2b.txt',`合成验收。验收者已提供pending-feb-review.json对应模拟接受。真实执行Feb posting并query。用period.inspect组织连续1-12月carryforward/close（12月yearEnd=true），每步当前stateDigest和metadata.authorization。period能力月scope，每月独立Store；跨Store依赖实际版本，harness_plan替换全图保留仍需任务。现batch的harnessTasks引用真实Store任务，不伪造offline ready manifest；全年batch用year scope。stage可记录精确原生operation已提交，保留resultCurrent/confirmationCurrent实际值，不能称整期/年度完成。关账后刷新monthly/annual workpaper，通过agency.annual-calculation和annual.inspect产出reviewTargets:[{storePath,taskId,targetVersion,dependencyDigest}]供验收者模拟复核。所有Store/jobKey/原生引用写stage2-result.json，不得制造反馈。`);
 put('goal-stage3.txt',`合成验收。读metadata.json、stage2-result.json及更正原件，先通过harness_feedback登记验收者提供的SYNTHETIC-TEST-ONLY驳回/更正要求（精确reviewTargets版本）；用period.impact并显式bindings列实际后期/税/年度结果及确认版本影响。在metadata.authorization范围按依赖逆序反结账/反过账派生：最新期先重开再撤年末/损益结转，才到前期；每次取当前period.inspect.stateDigest，保留历史。重放更正资料，关联原posting archive/source IDs准备agency更正。correction.postingDate已由合成操作者明确选择2026-01-26，保留原业务日期。previousEvidence/previousSourceIds真实；不得accept。原生proposal和storePath/taskId/feedbackPath写pending-correction-review.json，等验收者模拟人审。`);
 put('goal-stage4.txt',`合成验收。验收者已写pending-correction-review.json的模拟反馈。原Store执行更正并query原operation，重启只续未完/受影响任务。正序重算月税、结转/检查/关账，更新年度计算和annual.inspect，显式重绑跨Store版本。接续原批量job先查真实历史/当前版本，旧结果不当新版完成；旧确认失效，新结果待复核。保存final-result.json原生引用；年度数字、封账、会计确认分开。不得把模拟确认冒充真实审定。`);
 return metadata;
}
if(process.argv[2]==='prepare'){console.log(JSON.stringify(preparePeriodScenario(resolve(process.argv[3]),{compact:process.argv.includes('--compact')}),null,2));process.exit(0);}
async function testPeriodBusiness(){
mkdirSync(resolve('.agent-runs'),{recursive:true});const f=preparePeriodScenario(mkdtempSync(resolve('.agent-runs/period-parent-'))+'/fixture');
const caps=harnessCapabilities();
const call=async(action,period,request={},phase='execute',operationId='period-test-'+action+'-'+period)=>callHarnessAdapter({capabilityId:action,scope:{...f.scope,period},request:{target:f.target,...request},phase,operationId,codeDigest:caps.get(action).codeDigest});
const posting={manifestPath:f.manifestPaths[0],batchId:'period-original',evidenceDir:join(f.root,'evidence'),feedbackPath:join(f.root,'review.json')};mkdirSync(posting.evidenceDir);
const prepared=await call('agency.posting','2026-01',posting,'prepare','agency-period-original');assert.equal(prepared.status,'prepared',JSON.stringify(prepared));
writeFileSync(posting.feedbackPath,JSON.stringify({decision:'accept',reviewer:'SYNTHETIC-TEST-ONLY',...Object.fromEntries(['targetVersion','dependencyDigest','planDigest'].map(k=>[k,prepared.proposal[k]]))}));
const invokePosting=(request,prior,phase='execute',period='2026-01')=>callHarnessAdapter({capabilityId:'agency.posting',scope:{...f.scope,period},request:{target:f.target,...request},phase,operationId:'agency-'+request.batchId,codeDigest:caps.get('agency.posting').codeDigest,prepared:prior});
assert.equal((await invokePosting(posting,prepared)).applied,true);
const write=async(action,period,extra={})=>{const inspected=await call('period.inspect',period);const request={authorization:f.authorization,expectedStateDigest:inspected.stateDigest,...extra};const id='write-'+action+'-'+period+'-'+(extra.voucherId??'')+'-'+inspected.stateDigest.slice(0,24);const result=await call(action,period,request,'execute',id);assert.equal(result.applied,true,JSON.stringify(result));return {action,period,request,id,result};};
const proposals=[prepared.proposal];
for(let m=1;m<=12;m++){const period='2026-'+String(m).padStart(2,'0');
 if(m===2){const req={...posting,batchId:'period-feb',manifestPath:f.manifestPaths[1],feedbackPath:join(f.root,'feb-review.json')},prep=await call('agency.posting',period,req,'prepare','agency-period-feb');assert.equal(prep.status,'prepared',JSON.stringify(prep));proposals.push(prep.proposal);writeFileSync(req.feedbackPath,JSON.stringify({decision:'accept',reviewer:'SYNTHETIC-TEST-ONLY',...Object.fromEntries(['targetVersion','dependencyDigest','planDigest'].map(k=>[k,prep.proposal[k]]))}));assert.equal((await invokePosting(req,prep,'execute',period)).applied,true);}
 await write('period.carryforward',period,{yearEnd:m===12});await write('period.close',period);}
const impact=await call('period.impact','2026-01');assert.equal(impact.closedPeriods.length,12);assert.ok(impact.affectedYears.includes('2027'));assert.equal(impact.reverseSteps[0].period,'2026-12');
let interrupted;
for(const step of impact.reverseSteps)interrupted=await write(step.capabilityId,step.period,{...(step.voucherId?{voucherId:step.voucherId,expectedVoucherFingerprint:step.expectedVoucherFingerprint}:{})});
const replay=await call(interrupted.action,interrupted.period,interrupted.request,'query',interrupted.id);assert.equal(replay.applied,true);assert.equal(replay.proof.receipt.eventId,interrupted.result.proof.receipt.eventId);
const beforeDb=new DatabaseSync(f.target.dbPath,{readOnly:true}),originalRows=beforeDb.prepare("SELECT * FROM vouchers WHERE kind<>'carryforward' ORDER BY id").all(),unrelated=beforeDb.prepare("SELECT v.* FROM vouchers v JOIN import_voucher_sources s ON s.voucher_id=v.id WHERE v.account_set_id=? AND v.period='2026-02' AND v.kind<>'carryforward' ORDER BY v.id").all(f.target.accountSetId);beforeDb.close();
const rawPath=join(f.root,'customer-originals','2026-01.facts.json'),raw=JSON.parse(readFileSync(rawPath,'utf8'));raw.records.find(r=>r.type==='service_complete').work[0].units='3';writeFileSync(rawPath,JSON.stringify(raw));writeFileSync(f.sourcePath,readFileSync(f.sourcePath,'utf8').replace('2小时','3小时')+' 合成更正回函：原服务工时改为3，原业务日期不变，操作员选择更正记账日2026-01-26。');
const correction={reason:'Synthetic corrected service hours; original business retained',previousEvidence:proposals.map(p=>({archivePath:p.identity.archivePath,archiveId:p.identity.archiveId})),previousSourceIds:proposals.flatMap(p=>p.plannedVouchers.map(v=>v.sourceVoucherId))};
const corrReq={...posting,batchId:'period-correction',feedbackPath:join(f.root,'correction-review.json'),correction};
// Structural/date errors are rejected by the shared contract before the native call; a valid out-of-scope date still reaches the native period guard.
await assert.rejects(()=>call('agency.posting','2026-01',corrReq,'prepare','agency-period-correction'),e=>e.code==='harness_capability_input_invalid'&&e.details.problems.some(p=>p.inputPointer==='/correction/postingDate'&&p.keyword==='required'));
await assert.rejects(()=>call('agency.posting','2026-01',{...corrReq,correction:{...correction,postingDate:'2026-02-30'}},'prepare','agency-period-correction'),e=>e.code==='harness_capability_input_invalid'&&e.details.problems.some(p=>p.inputPointer==='/correction/postingDate'&&p.keyword==='format'));
const invalidPeriod=await call('agency.posting','2026-01',{...corrReq,correction:{...correction,postingDate:'2026-02-26'}},'prepare','agency-period-correction');assert.equal(invalidPeriod.code,'agency_correction_posting_period_mismatch');
corrReq.correction.postingDate='2026-01-26';const cp=await call('agency.posting','2026-01',corrReq,'prepare','agency-period-correction');assert.equal(cp.status,'prepared',JSON.stringify(cp));assert.ok(cp.proposal.plannedVouchers.every(v=>v.date==='2026-01-26'));assert.ok(cp.proposal.correctionDates.some(d=>d.originalBusinessDate==='2026-01-18'));
writeFileSync(corrReq.feedbackPath,JSON.stringify({decision:'accept',reviewer:'SYNTHETIC-TEST-ONLY',...Object.fromEntries(['targetVersion','dependencyDigest','planDigest'].map(k=>[k,cp.proposal[k]]))}));const changed=await invokePosting(corrReq,cp);assert.equal(changed.applied,true,JSON.stringify(changed));assert.equal((await invokePosting(corrReq,cp)).applied,true);
for(let m=1;m<=12;m++){const period='2026-'+String(m).padStart(2,'0');await write('period.carryforward',period,{yearEnd:m===12});await write('period.close',period);}
const finalDb=new DatabaseSync(f.target.dbPath,{readOnly:true});const balance=(code,excludeCarries=false)=>Math.round((finalDb.prepare("SELECT SUM(e.debit-e.credit) n FROM voucher_entries e JOIN vouchers v ON v.id=e.voucher_id WHERE v.account_set_id=? AND v.status='posted' AND e.code=? AND (?=0 OR v.kind<>'carryforward')").get(f.target.accountSetId,code,excludeCarries?1:0).n??0)*100);assert.equal(balance('1122'),30300);assert.equal(balance('5001',true),-30000);assert.equal(balance('5602',true),3723);assert.equal(balance('5801',true),1329);assert.equal(balance('3104'),-25248);for(const old of originalRows)assert.deepEqual(finalDb.prepare('SELECT * FROM vouchers WHERE id=?').get(old.id),old);assert.ok(finalDb.prepare("SELECT COUNT(*) n FROM vouchers WHERE status='superseded' AND kind='carryforward'").get().n>0);assert.equal(finalDb.prepare('SELECT COUNT(*) n FROM vouchers WHERE account_set_id=?').get(f.otherId).n,0);assert.equal(finalDb.prepare("SELECT COUNT(*) n FROM vouchers WHERE account_set_id=? AND period='2026-02' AND kind<>'carryforward'").get(f.target.accountSetId).n,unrelated.length);finalDb.close();
console.log('PASS continuous original posting, 12 native closes, cross-year impact, reverse dependency unseal and original operation recovery: '+f.root);

}
if(resolve(process.argv[1])===fileURLToPath(import.meta.url))await testPeriodBusiness();
