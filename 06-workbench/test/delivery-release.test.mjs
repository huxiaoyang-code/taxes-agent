import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {existsSync,mkdtempSync,mkdirSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Worker} from 'node:worker_threads';
import {publishReviewedDelivery,verifyReviewedDelivery} from '../server/delivery-release.mjs';
import {readDeliveryBooks} from '../server/delivery-books-review.mjs';

const scope={accountSetId:1,period:'2026-09',enterpriseKey:'company-A',databaseInstanceId:'verified-instance'};
const version='a'.repeat(32);
function fixture(other=false){
  const workspace=mkdtempSync(join(tmpdir(),'reviewed-ledger-')),snapshotPath=join(workspace,'snapshot.sqlite');
  const db=new DatabaseSync(snapshotPath);
  try{
    db.exec(`CREATE TABLE account_sets(id INTEGER,name TEXT,accounting_profile_id TEXT,accounting_standard TEXT,start_period TEXT);
    INSERT INTO account_sets VALUES(1,'合成甲','small-2011-basic-v1','小企业会计准则','2026-09');
    CREATE TABLE import_enterprise_account_sets(account_set_id INTEGER,enterprise_key TEXT,enterprise_name TEXT);
    INSERT INTO import_enterprise_account_sets VALUES(1,'company-A','合成甲');
    CREATE TABLE audit_database_instances(instance_id TEXT,is_active INTEGER);INSERT INTO audit_database_instances VALUES('verified-instance',1);
    CREATE TABLE periods(account_set_id INTEGER,period TEXT,status TEXT);INSERT INTO periods VALUES(1,'2026-09','open');
    CREATE TABLE accounts(account_set_id INTEGER,code TEXT,name TEXT,category TEXT,direction TEXT,contra INTEGER);
    INSERT INTO accounts VALUES(1,'1405','库存商品','资产','debit',0),(1,'3001','实收资本','权益','credit',0);
    CREATE TABLE opening_balances(account_set_id INTEGER,code TEXT,debit REAL,credit REAL);
    INSERT INTO opening_balances VALUES(1,'1405',5,0),(1,'3001',0,5);
    CREATE TABLE vouchers(id INTEGER,account_set_id INTEGER,period TEXT,voucher_date TEXT,kind TEXT,status TEXT,word TEXT,number INTEGER);
    INSERT INTO vouchers VALUES(1,1,'2026-09','2026-09-01','normal','posted','记',1);
    CREATE TABLE voucher_entries(voucher_id INTEGER,line_no INTEGER,code TEXT,debit REAL,credit REAL);
    INSERT INTO voucher_entries VALUES(1,1,'1405',4,0),(1,2,'3001',0,4);`);
    if(other)db.exec(`INSERT INTO account_sets VALUES(2,'SYNTHETIC_OTHER_COMPANY_PRIVATE','small-2011-basic-v1','小企业会计准则','2026-09');
    INSERT INTO import_enterprise_account_sets VALUES(2,'private-B','SYNTHETIC_OTHER_COMPANY_PRIVATE');
    INSERT INTO vouchers VALUES(2,2,'2026-09','2026-09-02','normal','posted','记',1);
    INSERT INTO voucher_entries VALUES(2,1,'1405',990,0),(2,2,'3001',0,990);
    INSERT INTO vouchers VALUES(3,1,'2026-10','2026-10-01','normal','posted','记',1);
    INSERT INTO voucher_entries VALUES(3,1,'1405',800,0),(3,2,'3001',0,800);
    CREATE TABLE privileged_cache(value TEXT);INSERT INTO privileged_cache VALUES('SYNTHETIC_PRIVATE_PAYLOAD');`);
  }finally{db.close();}
  return {workspace,snapshotPath,scope,version,files:[{name:'报表/最终.csv',bytes:Buffer.from('合成试算')}]};
}
test('单企业交付保留原文件与完整快照，可重复发布，损坏、替换和额外文件阻断',()=>{
  const f=fixture(),relative=publishReviewedDelivery(f),dir=join(f.workspace,relative);
  assert.equal(relative,'reviewed/'+version);
  const manifest=JSON.parse(readFileSync(join(dir,'manifest.json')));
  const trusted=createHash('sha256').update(readFileSync(join(dir,'manifest.json'))).digest('hex');
  const inspect=()=>verifyReviewedDelivery({...f,manifestSha256:trusted});
  assert.equal(inspect(),relative);
  assert.equal(manifest.ledger.mode,'single-account-snapshot');
  assert.deepEqual(readFileSync(join(dir,'books.sqlite')),readFileSync(f.snapshotPath));
  assert.deepEqual(readFileSync(join(dir,'outputs',f.files[0].name)),f.files[0].bytes);
  assert.equal(publishReviewedDelivery(f),relative);
  assert.throws(()=>publishReviewedDelivery({...f,files:[{...f.files[0],sha256:'wrong'}]}),/file_changed/);
  assert.throws(()=>publishReviewedDelivery({...f,files:[{...f.files[0],bytes:Buffer.from('其他文件')}] }),/damaged/);
  mkdirSync(join(dir,'extra'));
  assert.throws(inspect,/damaged/);
  assert.throws(()=>publishReviewedDelivery(f),/damaged/);
  writeFileSync(join(dir,'outputs',f.files[0].name),'现场改写');
  assert.throws(()=>publishReviewedDelivery(f),/damaged/);
  assert.deepEqual(readdirSync(join(f.workspace,'reviewed')),[version]);
});
test('多账套导出的数据库可重算同版，不含其他账套、后期凭证、未授权全局表与原库页',()=>{
  const f=fixture(true),before=readDeliveryBooks({dbPath:f.snapshotPath,scope},[]);
  const dir=join(f.workspace,publishReviewedDelivery(f));
  assert.equal(JSON.parse(readFileSync(join(dir,'manifest.json'))).ledger.mode,'account-period-ledger');
  const book=join(dir,'books.sqlite');
  const after=readDeliveryBooks({dbPath:book,scope},[]);
  assert.equal(after.bookDigest,before.bookDigest);
  assert.equal(after.inventoryMinor,'900');
  for(const word of ['SYNTHETIC_OTHER_COMPANY_PRIVATE','SYNTHETIC_PRIVATE_PAYLOAD','private-B'])assert.equal(readFileSync(book).includes(Buffer.from(word)),false);
  const check=new DatabaseSync(book,{readOnly:true});
  try{
    assert.deepEqual(check.prepare('SELECT id FROM vouchers').all().map(r=>r.id),[1]);
    assert.equal(check.prepare('SELECT count(*) AS n FROM voucher_entries').get().n,2);
  }finally{check.close();}
  assert.equal(publishReviewedDelivery(f),'reviewed/'+version);
  assert.throws(()=>publishReviewedDelivery({...f,scope:{...scope,enterpriseKey:'private-B'}}),/scope_conflict/);
  for(const name of ['../outside','D:/alias','sub\\name','x:alt','NUL','dir./file','absolute/../file']){
    assert.throws(()=>publishReviewedDelivery({...f,files:[{name,bytes:Buffer.alloc(1)}]}),/file_invalid/);
  }
});
test('两个同时发布者复用完整版本，路径大小写歧义不会生成新包',async()=>{
  const f=fixture(true);
  const module=new URL('../server/delivery-release.mjs',import.meta.url).href;
  function run(){
    const source=`const {parentPort,workerData}=require('node:worker_threads');import(workerData.module).then(m=>{const f=workerData.f;f.files=f.files.map(x=>({...x,bytes:Buffer.from(x.bytes)}));parentPort.postMessage(m.publishReviewedDelivery(f))})`;
    const worker=new Worker(source,{eval:true,workerData:{module,f}});
    return new Promise((ok,no)=>{worker.once('message',ok);worker.once('error',no);});
  }
  assert.deepEqual(await Promise.all([run(),run()]),['reviewed/'+version,'reviewed/'+version]);
  assert.deepEqual(readdirSync(join(f.workspace,'reviewed')),[version]);
  assert.throws(()=>publishReviewedDelivery({...f,files:['same','SAME'].map(name=>({name,bytes:Buffer.alloc(1)}))}),/file_invalid/);
});

test('被审查版本仅取本机证据，原件与交付同名也各自保留，不生成正式包',()=>{
  const f=fixture(true);
  const evidenceSources=[{name:f.files[0].name,bytes:Buffer.from('合成来源原件')}];
  const evidence={...f,evidenceSources},dir=join(f.workspace,publishReviewedDelivery(evidence));
  assert.equal(publishReviewedDelivery(evidence),'review-evidence/'+version);
  assert.equal(existsSync(join(f.workspace,'reviewed')),false);
  const manifest=JSON.parse(readFileSync(join(dir,'manifest.json')));
  assert.equal(manifest.format,'finance-local-review-evidence/1');
  assert.equal(manifest.sources.length,1);
  assert.equal(manifest.ledger.mode,'account-period-ledger');
  assert.deepEqual(readFileSync(join(dir,'sources',evidenceSources[0].name)),evidenceSources[0].bytes);
  assert.deepEqual(readFileSync(join(dir,'outputs',f.files[0].name)),f.files[0].bytes);
  writeFileSync(join(dir,'sources',evidenceSources[0].name),'改坏证据');
  assert.throws(()=>publishReviewedDelivery(evidence),/damaged/);
  assert.equal(publishReviewedDelivery(f),'reviewed/'+version);
  assert.equal(existsSync(join(f.workspace,'reviewed',version,'sources')),false);
});
