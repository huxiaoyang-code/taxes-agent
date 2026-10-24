// Synthetic raw facts -> existing formal posting bridge. No expected entries as inputs.
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createPostingFixture, postingRequest, executionRequest, readJson, writeJson } from './offline-posting-fixture.mjs';
import { runOfflinePosting } from '../../server/offline-posting.mjs';
export { readJson, writeJson };
export function createPeriodFixture(directory,{post=true,prepay=false,zero=false}={}) {
  const f=createPostingFixture(directory);
  const materials=readJson(join(f.dir,'materials.json')), d=readJson(join(f.dir,'declaration.json')), af=readJson(join(f.dir,'accounting.json')), basic=readJson(join(f.dir,'business.json'));
  for(const name of ['purchase.csv','bank.csv'])writeFileSync(join(f.dir,name),readFileSync(join(f.dir,name),'utf8').replaceAll('2026-03','2026-01'));
  for(const fact of af.facts)if(fact.kind==='administrative_service'){fact.completionDate='2026-01-19';fact.benefitFrom='2026-01-01';fact.benefitTo='2026-01-31';}
  for(const fact of basic.facts)if(fact.factId==='admin-basic')fact.date='2026-01-19';
  if(!prepay){materials.sources=materials.sources.filter(s=>s.sourceId!=='bank');af.facts=af.facts.filter(f=>f.kind!=='service_prepayment');d.bankAccounts.accountIds=[];d.bankFacts=[];d.coverage=d.coverage.filter(c=>c.kind!=='bank');}
  if(zero){materials.sources=[];af.facts=[];basic.facts=[];d.coverage=d.coverage.map(c=>({...c,state:'no_activity',sourceIds:[]}));}
  writeJson(join(f.dir,'materials.json'),materials);writeJson(join(f.dir,'declaration.json'),d);writeJson(join(f.dir,'accounting.json'),af);writeJson(join(f.dir,'business.json'),basic);
  f.request={version:'offline-period-plan-input/1',inputPath:f.inputPath,target:{dbPath:f.dbPath,databaseInstanceId:f.instanceId,enterpriseKey:f.key,accountSetId:f.id},month:'2026-01'};
  return f;
}
export async function postPeriodFixture(f,kinds=['service_sale','administrative_service']) {
  const results=[];
  for(const kind of kinds){const r=await postingRequest(f,kind),p=runOfflinePosting(r);if(p.status!=='prepared')throw new Error(JSON.stringify(p));const v=runOfflinePosting(executionRequest(r,p));if(v.status!=='applied')throw new Error(JSON.stringify(v));results.push(v);}
  return results;
}
export function dbSnapshot(f){const db=new DatabaseSync(f.dbPath,{readOnly:true});try{const schema=db.prepare('SELECT * FROM sqlite_master ORDER BY type,name').all();return JSON.stringify({schema,tables:schema.filter(r=>r.type==='table').map(r=>[r.name,db.prepare('SELECT * FROM "'+r.name.replaceAll('"','""')+'"').all().map(r=>JSON.stringify(r)).sort()])});}finally{db.close();}}
export function mutateDb(f,sql,...params){const db=new DatabaseSync(f.dbPath);try{return db.prepare(sql).run(...params);}finally{db.close();}}
