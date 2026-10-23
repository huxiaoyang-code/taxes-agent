import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
process.env.WORKBENCH_DATA_DIR = mkdtempSync(join(tmpdir(), 'enterprise-domain-'));
const { db } = await import('../server/db.mjs');
const A = await import('../server/accounting.mjs');
const I = await import('../server/import-incremental.mjs');
const pure = await import('../server/enterprise-identity.mjs');
const snap = () => JSON.stringify(['account_sets','accounts','periods','opening_balances','vouchers','voucher_entries','import_enterprise_account_sets','import_source_bindings','import_batches','import_voucher_sources','import_batch_vouchers'].map(t => db.prepare(`SELECT * FROM ${t}`).all()));
const create = (key, over={}) => A.createAccountSet({name:'同名合成企业',start_period:'2026-01', enterprise:{enterpriseKey:key},...over});
const rejects = (fn, code) => assert.throws(fn, e => e.code === code);
const payload = () => ({account_set:{name:'同名合成企业', start_period:'2026-01'}, opening_balances:[{code:'1002',debit:100},{code:'3001',credit:100}], vouchers:[{sourceVoucherId:'SOURCE-ORIGINAL-1',period:'2026-01', date:'2026-01-02',entries:[{code:'1002',debit:20},{code:'5001',credit:20}]}]});
test('pure normalization preserves case, NFKC/trim/finite numbers and rejects bad identity', () => {
 assert.equal(pure.normalizeEnterpriseIdentity({enterpriseKey:' ＡbＣ '}).enterpriseKey,'AbC');
 assert.equal(pure.normalizeEnterpriseIdentity({enterpriseKey:123}).enterpriseKey,'123');
 for(const key of [{},[],true,Infinity,'', 'a'.repeat(129),'A\u0000B']) rejects(()=>pure.normalizeEnterpriseIdentity({enterpriseKey:key}), key===''?'enterprise_identity_required':'enterprise_identity_invalid');
 rejects(()=>pure.normalizeEnterpriseIdentity(), 'enterprise_identity_required');
});
test('explicit invalid profileId/profile_id fail closed; omitted defaults and replay use persisted profile', () => {
 const before=snap();
 for(const field of ['profileId','profile_id']) for(const value of ['',null,123]) for(const dryRun of [true,false]) {
  const r=I.importIncremental({[field]:value,dryRun,batchId:'INVALID-'+field+'-'+String(value)+'-'+dryRun,source:{system:'profile-negative',enterpriseKey:'PROFILE-NEGATIVE'},payload:payload()});
  assert.equal(r.status,'rejected');assert.equal(r.validation.profileError.code,'accounting_profile_unknown');
 }
 assert.equal(snap(),before);
 const args={dryRun:false,batchId:'PROFILE-DEFAULT',source:{system:'profile-default',enterpriseKey:'PROFILE-DEFAULT'},payload:payload()};
 const first=I.importIncremental(args);assert.equal(first.status,'applied');assert.equal(A.getAccountSet(first.accountSetId).accounting_profile_id,'small-2011-basic-v1');
 assert.equal(I.importIncremental({...args,profileId:'',profile_id:null}).status,'idempotent_replay');
});
test('manual missing/invalid identity and bad profile are zero-write; same-key normalized conflict; different-key same-name legal', () => {
 const before=snap();
 rejects(()=>A.createAccountSet({name:'synthetic',start_period:'2026-01'}),'enterprise_identity_required');
 rejects(()=>create('bad-profile',{profileId:'UNKNOWN'}),'accounting_profile_unknown');
 rejects(()=>create('bad-profile',{accounting_standard:'企业会计准则',profileId:'small-2011-basic-v1'}),'accounting_profile_standard_mismatch');
 assert.equal(snap(),before);
 const a=create('ABC'); create('different');
 rejects(()=>create(' ＡＢＣ ',{name:'改名'}),'enterprise_already_bound');
 assert.equal(A.getAccountSet(a.id).enterprise.enterpriseKey,'ABC');
 const literal=create('stable-id',{name:'stable-id'}); assert.ok(literal.id);
});
test('canonical binding failure rolls back book, profile COA and period atomically', () => {
 const before=snap(); db.exec("CREATE TRIGGER fail_identity BEFORE INSERT ON import_enterprise_account_sets BEGIN SELECT RAISE(ABORT,'synthetic_failure'); END");
 try { assert.throws(()=>create('ROLLBACK')); assert.equal(snap(),before); } finally { db.exec('DROP TRIGGER fail_identity'); }
});
test('legacy envelope identity/profile is required in preview and apply and stays out of business meta', () => {
 const p=payload(), before=snap();
 for(const dryRun of [true,false]) {
  const r=A.importAccountSet(p,{dryRun}); assert.equal(r.validation.ok,false);assert.equal(r.validation.identityError.code,'enterprise_identity_required');assert.equal(r.created,null);
 }
 assert.equal(snap(),before);
 const r=A.importAccountSet(p,{enterprise:{enterpriseKey:'LEGACY-EXPLICIT'}});assert.ok(r.created);
 const tb=A.trialBalance(r.created.id,'2026-01'); assert.equal(tb.lines.find(x=>x.code==='1002').closing_debit,120);
 const duplicate=A.importAccountSet(p,{enterprise:{enterpriseKey:'LEGACY-EXPLICIT'},dryRun:false}); assert.equal(duplicate.validation.identityError.code,'enterprise_already_bound');
 assert.equal(p.account_set.enterprise,undefined);
});
test('historical unbound books remain readable; explicit confirmation binds once with original money/profile', () => {
 const set=create('HISTORICAL-TO-UNBIND'); A.setOpeningBalances(set.id,[{code:'1002',debit:77},{code:'3001',credit:77}]);
 db.prepare('DELETE FROM import_enterprise_account_sets WHERE account_set_id=?').run(set.id);
 const before=JSON.stringify(A.trialBalance(set.id,'2026-01'));
 assert.equal(A.getAccountSet(set.id).enterprise,null);
 const empty=snap(); rejects(()=>A.bindAccountSetEnterprise(set.id,{enterpriseKey:'HISTORICAL'}),'account_set_binding_confirmation_required');assert.equal(snap(),empty);
 assert.equal(A.bindAccountSetEnterprise(set.id,{enterpriseKey:'HISTORICAL'},{confirmNewBinding:true}).status,'bound');
 assert.equal(A.bindAccountSetEnterprise(set.id,{enterpriseKey:'HISTORICAL'}).status,'no_change');
 rejects(()=>A.bindAccountSetEnterprise(set.id,{enterpriseKey:'DIFFERENT'},{confirmNewBinding:true}),'account_set_bound_to_other_enterprise');
 rejects(()=>A.bindAccountSetEnterprise(create('OTHER-BOOK').id,{enterpriseKey:'HISTORICAL'},{confirmNewBinding:true}),'account_set_bound_to_other_enterprise');
 assert.equal(JSON.stringify(A.trialBalance(set.id,'2026-01')),before);
});
test('manual/legacy/incremental use one canonical domain across source systems; conflicting double identity rejects', () => {
 const p=payload(), source={system:'first',enterpriseKey:'UNIFIED'};
 create('UNIFIED'); const before=snap();
 for(const system of ['first','other']) {const r=I.importIncremental({payload:p,batchId:'duplicate-'+system,source:{...source,system},dryRun:false});assert.equal(r.status,'conflict');assert.ok(r.conflicts.some(x=>x.code==='enterprise_already_bound'));}
 const mismatch=I.importIncremental({payload:p,batchId:'mismatch',source:{system:'s',enterpriseKey:'UNUSED'},enterprise:{enterpriseKey:'OTHER'},dryRun:false}); assert.equal(mismatch.validation.identityError.code,'enterprise_identity_mismatch');
 assert.equal(snap(),before);
});
test('completed creates replay original IDs/fingerprint across restart; source links/posting/openings/content tampering rejects', () => {
 const args={payload:payload(),batchId:'EXACT-ORIGINAL',source:{system:'original',enterpriseKey:'REPLAY'},dryRun:false};
 const first=I.importIncremental(args);assert.equal(first.status,'applied');
 const batch=I.getImportBatch(args.batchId), before=snap();
 const child=spawnSync(process.execPath,['--input-type=module','-e',`import {importIncremental,getImportBatch} from './server/import-incremental.mjs'; const out=importIncremental(${JSON.stringify(args)}); console.log(JSON.stringify({out,batch:getImportBatch('EXACT-ORIGINAL')}));`],{cwd:join(import.meta.dirname,'..'),env:{...process.env},encoding:'utf8',timeout:15000,killSignal:'SIGKILL'});
 assert.equal(child.status,0,child.stderr); const restarted=JSON.parse(child.stdout.trim());
 assert.equal(restarted.out.status,'idempotent_replay');assert.deepEqual(restarted.batch,batch); assert.equal(snap(),before);
 const vid=batch.sourceTrace[0].voucherId;
 A.unpostVoucher(first.accountSetId,vid);assert.equal(I.importIncremental(args).status,'conflict');A.postVoucher(first.accountSetId,vid);
 db.prepare("UPDATE opening_balances SET debit=101 WHERE account_set_id=? AND code='1002'").run(first.accountSetId);assert.equal(I.importIncremental(args).status,'conflict');db.prepare("UPDATE opening_balances SET debit=100 WHERE account_set_id=? AND code='1002'").run(first.accountSetId);
 db.prepare('DELETE FROM import_batch_vouchers WHERE batch_id=?').run(args.batchId); assert.equal(I.importIncremental(args).status,'conflict');
 console.log('original replay evidence',JSON.stringify(batch));
});
process.on('exit',()=>{ try { db.close(); } catch {} });
