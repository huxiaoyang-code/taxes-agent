import {assert,fs,join,DatabaseSync,harness,runChild} from './auxiliary-storage.test.mjs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const withBank=process.argv.includes('--bank'); const h=await harness({bank:withBank});
try {
 const {db,dbPath,root,A,X,S,LB,makeSet,entity,allocate,voucher}=h;const setId=makeSet('backup'),p=entity(setId,'party','C');
 A.setOpeningBalances(setId,[{code:'1122',debit:1000},{code:'3001',credit:1000}]);allocate(setId,{openingCode:'1122'},[{partyId:p,debit:1200},{partyId:entity(setId,'party','D'),credit:200}]);
 const v=voucher(setId,'2025-12',[{code:'1002',debit:300},{code:'1122',credit:300}]);A.postVoucher(setId,v.id);const entryId=X.listAuxiliaryEntries(db,{accountSetId:setId,voucherId:v.id}).find(e=>e.code==='1122').entryId;allocate(setId,{entryId},[{partyId:p,credit:300}]);
 const IM=await import('../server/import-incremental.mjs');const imported=IM.importIncremental({dryRun:false,mode:'create',batchId:'backup-source',source:{system:'synthetic',enterpriseKey:'BACKUP-SOURCE'},payload:{account_set:{name:'Source backed',start_period:'2025-12'},vouchers:[{sourceVoucherId:'STABLE-SOURCE',period:'2025-12',date:'2025-12-02',number:1,entries:[{code:'1122',debit:25},{code:'5001',credit:25}]}]}});assert.equal(imported.ok,true);
 const report=X.auxiliaryLedger(db,{accountSetId:setId,period:'2025-12',code:'1122'}),history=db.prepare('SELECT * FROM aux_operations ORDER BY id').all(),sources=db.prepare('SELECT * FROM import_voucher_sources ORDER BY id').all();
 assert.equal(report.totals.closing,700);assert.equal(fs.existsSync(dbPath+'-wal'),true);
 const original=fs.readFileSync(dbPath),wal=fs.readFileSync(dbPath+'-wal');const backup=await LB.createBackup({dbPath,outDir:join(root,'official-backup')});assert.equal(backup.ok,true,JSON.stringify(backup));assert.deepEqual(fs.readFileSync(dbPath),original);assert.deepEqual(fs.readFileSync(dbPath+'-wal'),wal);
 assert.deepEqual(backup.manifest.components.map(c=>c.name),withBank?['bank','auxiliary']:['auxiliary']);assert.equal((await LB.verifyBackup({backupDir:backup.backupDir})).ok,true);
 const restored=await LB.restoreNew({backupDir:backup.backupDir,targetDir:join(root,'restored')});assert.equal(restored.ok,true,JSON.stringify(restored));const restoredPath=join(restored.targetDir,'workbench.db');const check=new DatabaseSync(restoredPath);check.exec('PRAGMA foreign_keys=ON');
 try {assert.deepEqual(X.auxiliaryLedger(check,{accountSetId:setId,period:'2025-12',code:'1122'}),report);assert.deepEqual(check.prepare('SELECT * FROM aux_operations ORDER BY id').all(),history);assert.deepEqual(check.prepare('SELECT * FROM import_voucher_sources ORDER BY id').all(),sources);assert.equal(check.prepare('PRAGMA foreign_key_check').all().length,0);X.createAuxiliaryEntity(check,{accountSetId:setId,kind:'project',code:'AFTER',name:'After restore',requestId:'after-restore'});}finally{check.close();}
 const continued=await runChild(['--input-type=module','-e',`const {db}=await import(${JSON.stringify(new URL('../server/db.mjs',import.meta.url).href)});const A=await import(${JSON.stringify(new URL('../server/accounting.mjs',import.meta.url).href)});const X=await import(${JSON.stringify(new URL('../server/auxiliary-accounting.mjs',import.meta.url).href)});try{const v=A.createVoucher(${setId},{period:'2026-01',voucher_date:'2026-01-05',entries:[{code:'1002',debit:17},{code:'1122',credit:17}]});A.postVoucher(${setId},v.id);if(X.auxiliaryLedger(db,{accountSetId:${setId},period:'2026-01',code:'1122'}).totals.closing!==683)throw new Error('continued amount');console.log('continued core API 683');}finally{db.close();}`],{env:{WORKBENCH_DATA_DIR:restored.targetDir}});assert.equal(continued.code,0,continued.stderr);assert.equal(continued.closed,true);
 const input=join(root,'ledger.json');fs.writeFileSync(input,JSON.stringify({accountSetId:setId,period:'2026-01',code:'1122'}));const cli=await runChild([fileURLToPath(new URL('../scripts/local-auxiliary.mjs',import.meta.url)),'ledger','--db',restoredPath,'--input',input]);assert.equal(cli.code,0,cli.stderr);assert.equal(JSON.parse(cli.stdout).result.totals.closing,683);
 function rebuildEntities(c,from,to) {const rows=c.prepare('SELECT * FROM aux_entities').all();c.exec('PRAGMA foreign_keys=OFF; DROP TABLE aux_entities');c.exec(S.AUX_DDL.find(sql=>sql.startsWith('CREATE TABLE aux_entities')).replace(from,to));for(const sql of S.AUX_DDL.filter(sql=>sql.startsWith('CREATE TRIGGER')&&sql.includes(' ON aux_entities ')))c.exec(sql);for(const r of rows)c.prepare('INSERT INTO aux_entities VALUES(?,?,?,?,?,?)').run(r.id,r.account_set_id,r.kind,r.code,r.name,r.active);}
 const mutations=[
  ['extra-index',c=>c.exec('CREATE INDEX rogue_aux_index ON aux_allocations(party_id)')],
  ['wrong-collation',c=>c.exec('DROP INDEX idx_aux_entry; CREATE INDEX idx_aux_entry ON aux_allocations(entry_id COLLATE NOCASE DESC)')],
  ['missing-trigger',c=>c.exec('DROP TRIGGER aux_voucher_update')],
  ['wrong-trigger',c=>{c.exec('DROP TRIGGER aux_voucher_update');c.exec("CREATE TRIGGER aux_voucher_update BEFORE UPDATE ON vouchers BEGIN SELECT 1; END");}],
  ['extra-unique',c=>c.exec('CREATE UNIQUE INDEX unique_aux_rogue ON aux_entities(name,id)')],
  ['wrong-fk',c=>rebuildEntities(c,'ON DELETE RESTRICT','ON DELETE CASCADE')],
  ['wrong-default',c=>rebuildEntities(c,'DEFAULT 1','DEFAULT 0')],
  ['future-version',c=>{c.exec('PRAGMA ignore_check_constraints=ON; UPDATE aux_component_migrations SET version=2');}],
  ['old-core',c=>{c.exec('DELETE FROM schema_migrations WHERE version=5');}],
 ];
 let i=0;for(const [label,mutate] of mutations) {
  const folder=join(root,'tampered-'+(++i));fs.cpSync(backup.backupDir,folder,{recursive:true});const snapshot=join(folder,LB.SNAPSHOT_FILE);const c=new DatabaseSync(snapshot);try{mutate(c);}finally{c.close();}
  const manifestFile=join(folder,LB.MANIFEST_FILE),manifest=JSON.parse(fs.readFileSync(manifestFile,'utf8')),bytes=fs.readFileSync(snapshot);manifest.snapshot.bytes=bytes.length;manifest.snapshot.sha256=createHash('sha256').update(bytes).digest('hex');fs.writeFileSync(manifestFile,JSON.stringify(manifest));
  const verified=await LB.verifyBackup({backupDir:folder});assert.equal(verified.ok,false,label);const target=join(root,'reject-'+i);const rejected=await LB.restoreNew({backupDir:folder,targetDir:target});assert.equal(rejected.ok,false,label);assert.equal(fs.existsSync(target),false,label);
  const sourceRejected=await LB.createBackup({dbPath:snapshot,outDir:join(root,'bad-source-'+i)});assert.equal(sourceRejected.ok,false,label);
 }
 const corrupt=join(root,'corrupt');fs.cpSync(backup.backupDir,corrupt,{recursive:true});fs.writeFileSync(join(corrupt,LB.SNAPSHOT_FILE),'not sqlite');assert.equal((await LB.verifyBackup({backupDir:corrupt})).ok,false);
 assert.deepEqual(db.prepare('SELECT * FROM aux_operations ORDER BY id').all(),history);assert.deepEqual(X.auxiliaryLedger(db,{accountSetId:setId,period:'2025-12',code:'1122'}),report);
 console.log('auxiliary-backup-integration '+(withBank?'bank1':'bank0')+' PASS: WAL, strict roundtrip, source rows, 683 continued write, nine schema mutations plus corrupt snapshot');
}finally{h.db.close();console.log('auxiliary-backup-integration database closed');}
if(!withBank){const child=await runChild([fileURLToPath(import.meta.url),'--bank']);process.stdout.write(child.stdout);assert.equal(child.code,0,child.stderr);assert.equal(child.closed,true);console.log('auxiliary-backup-integration bank child closed');}
