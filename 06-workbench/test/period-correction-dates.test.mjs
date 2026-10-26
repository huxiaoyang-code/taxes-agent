import assert from 'node:assert/strict';
import { mkdirSync,mkdtempSync,readFileSync,writeFileSync } from 'node:fs';
import { join,resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { preparePeriodScenario } from './period-business.test.mjs';
import { callHarnessAdapter,harnessCapabilities } from '../server/harness-adapters.mjs';
mkdirSync(resolve('.agent-runs'),{recursive:true});const f=preparePeriodScenario(mkdtempSync(resolve('.agent-runs/period-dates-parent-'))+'/fixture'),scope={...f.scope,period:'2026-01'},caps=harnessCapabilities(),proposals=[];
const rawPath=join(f.root,'customer-originals','2026-01.facts.json');
for(const [index,hours]of ['2','3','4'].entries()){
 const raw=JSON.parse(readFileSync(rawPath,'utf8'));raw.records.find(r=>r.type==='service_complete').work[0].units=hours;writeFileSync(rawPath,JSON.stringify(raw));
 const batchId='dates-'+index,feedbackPath=join(f.root,'feedback-'+index+'.json'),request={target:f.target,manifestPath:f.manifestPaths[0],batchId,evidenceDir:join(f.root,'evidence'),feedbackPath,...(index?{correction:{reason:'Synthetic repeated source correction, preserve business date',postingDate:index===1?'2026-01-26':'2026-01-27',previousEvidence:proposals.map(p=>({archivePath:p.identity.archivePath,archiveId:p.identity.archiveId})),previousSourceIds:proposals.flatMap(p=>p.plannedVouchers.map(v=>v.sourceVoucherId))}}:{})};
 if(index===0)mkdirSync(request.evidenceDir);
 const prep=await callHarnessAdapter({capabilityId:'agency.posting',scope,request,phase:'prepare',operationId:'agency-'+batchId,codeDigest:caps.get('agency.posting').codeDigest});assert.equal(prep.status,'prepared',JSON.stringify(prep));
 if(index){const service=prep.proposal.correctionDates.find(d=>d.originalBusinessDate==='2026-01-18');assert.ok(service);assert.equal(service.postingDate,index===1?'2026-01-26':'2026-01-27');assert.equal(service.reversedVoucherPostingDate,index===1?'2026-01-18':'2026-01-26');assert.equal(service.sourceBusinessDate,'2026-01-18');}
 writeFileSync(feedbackPath,JSON.stringify({decision:'accept',reviewer:'SYNTHETIC-TEST-ONLY',...Object.fromEntries(['targetVersion','dependencyDigest','planDigest'].map(k=>[k,prep.proposal[k]]))}));
 const result=await callHarnessAdapter({capabilityId:'agency.posting',scope,request,phase:'execute',operationId:'agency-'+batchId,codeDigest:caps.get('agency.posting').codeDigest,prepared:prep});assert.equal(result.applied,true,JSON.stringify(result));proposals.push(prep.proposal);
}
const db=new DatabaseSync(f.target.dbPath,{readOnly:true});assert.equal(db.prepare('SELECT voucher_date FROM vouchers WHERE id=1').get().voucher_date,'2026-01-18');assert.equal(db.prepare('SELECT COUNT(*) n FROM vouchers WHERE account_set_id=?').get(f.otherId).n,0);db.close();
console.log('PASS repeated Jan26/Jan27 corrections retain initial Jan18 business date and separate reversed-voucher posting dates; all histories retained: '+f.root);
