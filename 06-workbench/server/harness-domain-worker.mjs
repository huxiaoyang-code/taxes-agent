// Fixed native worker for enterprise exceptions. No supplied module or SQL is run.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, statSync } from 'node:fs';
import { dirname, basename } from 'node:path';
import { checkedPath } from './offline-material-store.mjs';
import { captureHarnessCode } from './harness-code.mjs';
import { validateHarnessScope, scopeContainsMonth } from './harness-contract.mjs';
import { auditCanonicalDigest, auditResultDigest } from './local-audit.mjs';
import { queryOperation } from './local-audit-operation.mjs';
const check = (v,code) => {if(!v)throw Object.assign(new Error(code),{code});};
const roots = ['./harness-domain-worker.mjs'];
let db, started = false, requestContext;
try {
  const r = JSON.parse(readFileSync(0,'utf8'));requestContext=r; validateHarnessScope(r.scope);
  check(captureHarnessCode(roots).digest === r.codeDigest,'harness_code_changed');
  check(['voucher.create','voucher.post','voucher.unpost'].includes(r.action) && ['execute','query'].includes(r.phase),'harness_domain_action_invalid');
  const path = await checkedPath(r.target.dbPath); check(basename(path)==='workbench.db','harness_db_invalid');
  const before = statSync(path), verify = connection => {
    check(connection.prepare('SELECT instance_id FROM audit_database_instances WHERE is_active=1').get()?.instance_id===r.scope.databaseInstanceId,'harness_instance_mismatch');
    check(connection.prepare('SELECT enterprise_key FROM import_enterprise_account_sets WHERE account_set_id=?').get(r.scope.accountSetId)?.enterprise_key===r.scope.enterpriseKey,'harness_enterprise_mismatch');
    check(connection.prepare('SELECT MAX(version) v FROM schema_migrations').get()?.v===5,'harness_schema_unsupported');
  };
  db = new DatabaseSync(path,{readOnly:true}); verify(db);
  const action = r.action==='voucher.create' && r.request.voucher?.status==='posted' ? 'voucher.create_posted' : r.action;
  const args = r.action==='voucher.create' ? [r.scope.accountSetId,r.request.voucher] : [r.scope.accountSetId,r.request.voucherId];
  if (r.action==='voucher.create') check(scopeContainsMonth(r.scope,r.request.voucher?.period),'harness_period_mismatch');
  else {const v=db.prepare('SELECT period FROM vouchers WHERE id=? AND account_set_id=?').get(r.request.voucherId,r.scope.accountSetId);check(v&&scopeContainsMonth(r.scope,v.period),'harness_period_mismatch');}
  const requestDigest=auditCanonicalDigest(['audit-request-v1',action,{domainRequestDigest:auditResultDigest(args)}]), scopeToken=auditCanonicalDigest(['audit-scope-v1','account_set',r.scope.accountSetId]);
  const existing=db.prepare('SELECT * FROM audit_operations WHERE database_instance_id=? AND operation_id=? AND attempt=1').get(r.scope.databaseInstanceId,r.operationId);
  if(existing)check(existing.action===action&&existing.request_digest===requestDigest&&existing.scope_token===scopeToken,'harness_operation_conflict');
  if(r.phase==='query') {
    const proof=queryOperation(db,{databaseInstanceId:r.scope.databaseInstanceId,operationId:r.operationId});
    let current=null;
    if(proof.ok) {
      const id=proof.receipt?.resultRefs?.find(x=>x.type==='voucher')?.id;
      const row=db.prepare('SELECT * FROM vouchers WHERE account_set_id=? AND id=?').get(r.scope.accountSetId,id);
      check(row,'harness_result_missing');
      const entries=db.prepare('SELECT * FROM voucher_entries WHERE voucher_id=? ORDER BY line_no').all(id);
      check(row.status===(r.action==='voucher.unpost'?'draft':r.action==='voucher.post'?'posted':r.request.voucher.status==='posted'?'posted':'draft'),'harness_result_changed');
      if(r.action==='voucher.create') {
        check(row.period===r.request.voucher.period&&entries.length===r.request.voucher.entries.length,'harness_result_changed');
        r.request.voucher.entries.forEach((e,i)=>check(entries[i].code===String(e.code)&&Number(entries[i].debit)===Number(e.debit??0)&&Number(entries[i].credit)===Number(e.credit??0),'harness_result_changed'));
      }
      current={voucherId:id,period:row.period,status:row.status,entries:entries.map(e=>({code:e.code,debit:e.debit,credit:e.credit}))};
    }
    process.stdout.write(JSON.stringify({status:proof.ok?'recovered':proof.state==='unknown'?'unknown':'not_executed',applied:proof.ok?true:proof.state==='unknown'?'unknown':false,proof,current}));
  } else {
    db.close(); db=null; process.env.WORKBENCH_DATA_DIR=dirname(path);
    const A=await import('./accounting.mjs'), D=await import('./db.mjs'), C=await import('./local-audit-coordinator.mjs'); db=D.db;
    const now=statSync(await checkedPath(path)); check(before.dev===now.dev&&before.ino===now.ino,'harness_path_changed'); verify(db);
    check(captureHarnessCode(roots).digest===r.codeDigest,'harness_code_changed'); started=true;
    const result=C.withRequestMetadata({operationId:r.operationId,actor:'agent'},()=>r.action==='voucher.create'?A.createVoucher(...args):r.action==='voucher.post'?A.postVoucher(...args):A.unpostVoucher(...args));
    const proof=queryOperation(db,{databaseInstanceId:r.scope.databaseInstanceId,operationId:r.operationId});
    check(proof.ok&&proof.receipt.resultDigest===auditResultDigest(result),'harness_result_unverified');
    process.stdout.write(JSON.stringify({status:'executed',applied:true,proof,current:{voucherId:result.id,period:result.period,status:result.status,entries:result.entries?.map(e=>({code:e.code,debit:e.debit,credit:e.credit}))}}));
  }
} catch(e) {let uncertain=started;
  if(started&&db&&requestContext)try{const proof=queryOperation(db,{databaseInstanceId:requestContext.scope.databaseInstanceId,operationId:requestContext.operationId});if(!proof.ok&&proof.state!=='unknown')uncertain=false;}catch{}
  process.stdout.write(JSON.stringify({status:uncertain?'unknown':'blocked',applied:uncertain?'unknown':false,code:/^[a-z][a-z0-9_]+$/.test(e?.code??e?.message)?e.code??e.message:'harness_domain_failed'}));}
finally {try{db?.close();}catch{}}
