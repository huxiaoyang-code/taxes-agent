// 企业特例的固定原生 worker，不执行外部提供的模块或 SQL。
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, statSync } from 'node:fs';
import { dirname, basename, isAbsolute } from 'node:path';
import { checkedPath, readLocalFile, readArchivedMaterialEvidence } from './offline-material-store.mjs';
import { captureHarnessCode } from './harness-code.mjs';
import { validateHarnessScope, scopeContainsMonth } from './harness-contract.mjs';
import { auditCanonicalDigest, auditResultDigest } from './local-audit.mjs';
import { queryOperation } from './local-audit-operation.mjs';
import { inspectAuditSchema } from './local-audit-storage.mjs';
import { inspectBatchSchema } from './local-batch-storage.mjs';
import { ANNUAL_CLOSE_CODE_ROOTS, createAnnualCloseAdapter } from './annual-close.mjs';
import { createPeriodAdapter, PERIOD_CAPABILITIES } from './period-business.mjs';
import * as Agency from './agency-business.mjs';
import { buildComprehensiveAnalysis } from './comprehensive-analysis.mjs';
import { hash, stable } from './harness-store.mjs';
const check = (v,code) => {if(!v)throw Object.assign(new Error(code),{code});};
const roots = ['./harness-domain-worker.mjs'];
let db, started = false, requestContext;
async function agencyCall(r,path) {
  const cap=Agency.getAgencyCapabilities().find(c=>c.capabilityId===r.action);check(cap&&cap.codeDigest===r.codeDigest,'harness_code_changed');
  const sameScope=s=>check(['enterpriseKey','accountSetId','databaseInstanceId','currency'].every(k=>s?.[k]===r.scope[k]),'harness_agency_scope_mismatch');
  const identity=r.prepared?.proposal?.identity??r.priorResult?.identity;
  const prove=async (domain,feedbackEvidence=r.priorResult?.feedbackEvidence)=>{
    const evidenceBindings=[];
    if(!feedbackEvidence&&r.request.feedbackPath){try{const file=await readLocalFile(r.request.feedbackPath);feedbackEvidence={path:file.canonicalPath,digest:hash(file.bytes),feedback:JSON.parse(file.bytes.toString('utf8'))};}catch{}}
    if(identity){const archive=await readArchivedMaterialEvidence(identity.archivePath,identity.archiveId);for(const record of archive.records.filter(f=>isAbsolute(f.name))){let current=null;try{current=hash((await readLocalFile(record.name)).bytes);}catch{}evidenceBindings.push({path:record.name,expected:hash(record.bytes),current});}}
    if(feedbackEvidence){let current=null;try{current=hash((await readLocalFile(feedbackEvidence.path)).bytes);}catch{}evidenceBindings.push({path:feedbackEvidence.path,expected:feedbackEvidence.digest,current});}
    const approval=r.prepared?.proposal,confirmationCurrent=!!approval&&feedbackEvidence?.feedback?.decision==='accept'&&typeof feedbackEvidence.feedback.reviewer==='string'&&!!feedbackEvidence.feedback.reviewer.trim()&&['targetVersion','dependencyDigest','planDigest'].every(k=>feedbackEvidence.feedback[k]===approval[k]);
    const evidenceCurrent=evidenceBindings.some(b=>b.current!==null&&b.expected!==b.current)?false:evidenceBindings.some(b=>b.current===null)?null:true;
    // 原生恢复只有在读取已提交操作（或无变更核对）并发现
    // 持久化指纹不匹配后，才显式输出这些 null 字段。
    // 传输或读取失败不包含上述任一字段。
    const businessProofCurrent=domain.evidence===null||domain.existingPostedEvidence===null?false:undefined;
    return {status:domain.status,applied:domain.applied,scope:r.scope,identity:domain.identity,domain,...(feedbackEvidence?{feedbackEvidence}:{}),...(businessProofCurrent===false?{businessProofCurrent}:{}),confirmationCurrent,evidenceCurrent,evidenceBindings,proofDigest:hash({domain,evidenceBindings,confirmationCurrent}),periodComplete:false,submittable:false};
  };
  const inspectIdentity=async()=>{
    check(identity&&identity.dbPath===path&&identity.period===r.scope.period&&identity.batchId===r.request.batchId&&identity.operationId===r.operationId,'harness_agency_identity_missing_or_changed');sameScope({...identity,currency:r.scope.currency});
    return Agency.queryAgencyPosting(identity);
  };
  if(r.action==='agency.posting'&&r.phase==='query')return prove(await inspectIdentity());
  check(r.phase==='execute'||r.phase==='prepare','harness_agency_phase_invalid');
  if(r.action==='agency.posting'&&r.phase==='execute') {
    const observed=await inspectIdentity();
    // 加载或重建任何提案前，先查询原始归档身份；
    // 未知或已提交结果绝不触发再次 execute。
    if(observed.status!=='not_started')return prove(observed);
    let file,feedback;
    try{file=await readLocalFile(r.request.feedbackPath);feedback=JSON.parse(file.bytes.toString('utf8'));}
    catch{return {status:'blocked',applied:false,code:'agency_accountant_confirmation_required',identity,queryEntrypoint:'queryAgencyPosting',periodComplete:false,submittable:false};}
    const old=r.prepared.proposal;
    const bound=feedback&&['accept','reject'].includes(feedback.decision)&&typeof feedback.reviewer==='string'&&feedback.reviewer.trim()&&['targetVersion','dependencyDigest','planDigest'].every(k=>feedback[k]===old[k]);
    const feedbackEvidence={path:file.canonicalPath,digest:hash(file.bytes),feedback};
    if(!bound)return {status:'blocked',applied:false,code:'agency_confirmation_stale',identity,feedbackEvidence,periodComplete:false,submittable:false};
    if(feedback.decision==='reject')return {status:'rejected',applied:false,code:'agency_accountant_rejected',identity,feedbackEvidence,periodComplete:false,submittable:false};
    const session=Agency.loadAgencyMaterials(r.request.manifestPath);sameScope(session.scope);check(session.scope.period===r.scope.period,'harness_period_mismatch');
    const proposal=await Agency.prepareAgencyPosting(session,{batchId:r.request.batchId,dbPath:path,evidenceDir:r.request.evidenceDir,correction:r.request.correction,ledgerReconciliation:r.request.ledgerReconciliation});
    check(['targetVersion','dependencyDigest','planDigest','codeDigest','targetDigest'].every(k=>proposal[k]===old[k])&&stable(proposal.identity)===stable(old.identity)&&proposal.archive.archiveId===old.archive.archiveId,'harness_agency_preparation_stale');
    check(hash((await readLocalFile(file.canonicalPath)).bytes)===feedbackEvidence.digest,'agency_confirmation_changed');
    started=true;
    const domain=await Agency.executeAgencyPosting(session,{...feedback,proposal});
    const observedAfter=await Agency.queryAgencyPosting(identity);
    return {...await prove(observedAfter,feedbackEvidence),domain,feedbackEvidence};
  }
  if(r.action==='agency.annual-calculation') {
    check(/^202[67]$/.test(r.scope.period)&&Array.isArray(r.request.manifestPaths)&&r.request.manifestPaths.length>0&&r.request.manifestPaths.length<=12,'harness_agency_annual_inputs_invalid');
    const sessions=r.request.manifestPaths.map(p=>Agency.loadAgencyMaterials(p));for(const s of sessions){sameScope(s.scope);check(s.scope.period.slice(0,4)===r.scope.period,'harness_period_mismatch');}
    const domain=await Agency.buildAgencyAnnualWorkpaper(sessions,{dbPath:path});sameScope(domain.scope);check(domain.scope.period===r.scope.period+'-12','harness_period_mismatch');
    return {status:'calculated',scope:r.scope,nativeScope:domain.scope,domain,periodComplete:false,submittable:false};
  }
  const session=Agency.loadAgencyMaterials(r.request.manifestPath);sameScope(session.scope);check(session.scope.period===r.scope.period,'harness_period_mismatch');
  if(r.action==='agency.workpaper')return {status:'workpaper',scope:r.scope,domain:Agency.buildAgencyWorkpaper(session,{dbPath:path}),periodComplete:false,submittable:false};
  check(r.action==='agency.posting'&&r.phase==='prepare','harness_agency_action_invalid');
  const proposal=await Agency.prepareAgencyPosting(session,{batchId:r.request.batchId,dbPath:path,evidenceDir:r.request.evidenceDir,correction:r.request.correction,ledgerReconciliation:r.request.ledgerReconciliation});
  check(proposal.identity.operationId===r.operationId,'harness_agency_operation_mismatch');
  return {status:'prepared',applied:false,scope:r.scope,proposal,periodComplete:false,submittable:false};
}
try {
  const r = JSON.parse(readFileSync(0,'utf8'));requestContext=r; validateHarnessScope(r.scope);
  check(captureHarnessCode(roots).digest === (r.workerCodeDigest??r.codeDigest),'harness_code_changed');
  check((['voucher.create','voucher.post','voucher.unpost'].includes(r.action)||PERIOD_CAPABILITIES.includes(r.action)||['agency.workpaper','agency.posting','agency.annual-calculation','annual.inspect','analysis.comprehensive'].includes(r.action)) && ['prepare','execute','query'].includes(r.phase),'harness_domain_action_invalid');
  let path;
  try { path = await checkedPath(r.target.dbPath); } catch (error) { if(r.action==='annual.inspect')check(false,'harness_annual_target_unavailable');throw error; }
  check(basename(path)==='workbench.db','harness_db_invalid');
  const before = statSync(path), verify = connection => {
    try {
    check(connection.prepare('SELECT instance_id FROM audit_database_instances WHERE is_active=1').get()?.instance_id===r.scope.databaseInstanceId,'harness_instance_mismatch');
    check(connection.prepare('SELECT enterprise_key FROM import_enterprise_account_sets WHERE account_set_id=?').get(r.scope.accountSetId)?.enterprise_key===r.scope.enterpriseKey,'harness_enterprise_mismatch');
    check(connection.prepare('SELECT MAX(version) v FROM schema_migrations').get()?.v===5,'harness_schema_unsupported');
    } catch(error) { if(r.action==='annual.inspect'&&!['harness_instance_mismatch','harness_enterprise_mismatch','harness_schema_unsupported'].includes(error.code))check(false,'harness_annual_database_not_ready');throw error; }
  };
  db = new DatabaseSync(path,{readOnly:true}); verify(db);
  if(r.action==='annual.inspect') {
    check(r.phase==='execute'&&/^20\d\d$/.test(r.scope.period)&&r.scope.currency==='CNY','harness_annual_scope_invalid');
    check(r.request&&Object.keys(r.request).length===1&&Object.hasOwn(r.request,'target'),'harness_annual_request_invalid');
    check(captureHarnessCode([...ANNUAL_CLOSE_CODE_ROOTS,'./harness-domain-worker.mjs']).digest===r.codeDigest,'harness_code_changed');
    check(inspectAuditSchema(db).ok&&inspectBatchSchema(db).ok,'harness_annual_database_not_ready');
    check(db.prepare('PRAGMA journal_mode').get().journal_mode==='wal','harness_annual_wal_required');
    db.close();db=null;
    // db.mjs 在构造连接时启用 SQLite readOnly，早于任何可能
    // 执行 DDL 或迁移的导入；此模式跳过全部安装器。
    process.env.WORKBENCH_DATABASE_MODE='readonly';process.env.WORKBENCH_DATA_DIR=dirname(path);
    const A=await import('./accounting.mjs'),D=await import('./db.mjs'),R=await import('./report-export.mjs');db=D.db;
    const now=statSync(await checkedPath(path));check(before.dev===now.dev&&before.ino===now.ino&&before.birthtimeMs===now.birthtimeMs,'harness_path_changed');verify(db);
    check(db.prepare('PRAGMA query_only').get().query_only===1&&db.prepare('SELECT total_changes() n').get().n===0,'harness_annual_readonly_connection_required');
    const domain=createAnnualCloseAdapter({db,buildReportExport:R.buildReportExport,periodEndCheck:A.periodEndCheck}).inspect({accountSetId:r.scope.accountSetId,enterpriseKey:r.scope.enterpriseKey,year:r.scope.period});
    check(['enterpriseKey','accountSetId','databaseInstanceId','currency'].every(k=>domain.scope[k]===r.scope[k])&&domain.scope.year===r.scope.period,'harness_annual_scope_mismatch');
    process.stdout.write(JSON.stringify({status:'annual_review_draft',scope:r.scope,domain,periodComplete:false,submittable:false}));
  } else if(r.action==='analysis.comprehensive') {
    check(r.phase==='execute','harness_read_phase_invalid');
    db.close();db=null;process.env.WORKBENCH_DATABASE_MODE='readonly';process.env.WORKBENCH_DATA_DIR=dirname(path);
    const A=await import('./accounting.mjs'),D=await import('./db.mjs');db=D.db;
    const now=statSync(await checkedPath(path));check(before.dev===now.dev&&before.ino===now.ino&&before.birthtimeMs===now.birthtimeMs,'harness_path_changed');verify(db);
    check(captureHarnessCode(roots).digest===r.codeDigest,'harness_code_changed');
    check(db.prepare('PRAGMA query_only').get().query_only===1&&db.prepare('SELECT total_changes() n').get().n===0,'harness_analysis_readonly_required');
    process.stdout.write(JSON.stringify(await buildComprehensiveAnalysis({db,incomeStatement:A.incomeStatement,cashFlowStatement:A.cashFlowStatement,scope:r.scope,request:r.request,priorResult:r.priorResult})));
  } else if(r.action.startsWith('period.')) {
    check(/^20\d\d-(0[1-9]|1[0-2])$/.test(r.scope.period),'harness_period_mismatch');
    db.close();db=null;process.env.WORKBENCH_DATA_DIR=dirname(path);
    if(['period.inspect','period.impact'].includes(r.action))process.env.WORKBENCH_DATABASE_MODE='readonly';
    const A=await import('./accounting.mjs'),D=await import('./db.mjs'),C=await import('./local-audit-coordinator.mjs');db=D.db;
    const now=statSync(await checkedPath(path));check(before.dev===now.dev&&before.ino===now.ino,'harness_path_changed');verify(db);
    check(captureHarnessCode(roots).digest===r.codeDigest,'harness_code_changed');
    started=r.phase==='execute'&&!['period.inspect','period.impact'].includes(r.action);
    process.stdout.write(JSON.stringify(await createPeriodAdapter({db,A,C}).call({scope:r.scope,action:r.action,phase:r.phase,request:r.request,operationId:r.operationId})));
  } else if(r.action.startsWith('agency.')) {
    db.close();db=null;process.env.WORKBENCH_DATA_DIR=dirname(path);
    process.stdout.write(JSON.stringify(await agencyCall(r,path)));
  } else {
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
      const draftCreation=r.action==='voucher.create'&&r.request.voucher.status!=='posted';
      check(draftCreation?['draft','posted'].includes(row.status):row.status===(r.action==='voucher.unpost'?'draft':'posted'),'harness_result_changed');
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
  }
} catch(e) {let uncertain=started;
  if(started&&db&&requestContext)try{const proof=queryOperation(db,{databaseInstanceId:requestContext.scope.databaseInstanceId,operationId:requestContext.operationId});if(!proof.ok&&proof.state!=='unknown')uncertain=false;}catch{}
  const annual=requestContext?.action==='annual.inspect',code=/^[a-z][a-z0-9_]+$/.test(e?.code??e?.message)?e.code??e.message:annual?'harness_annual_database_not_ready':'harness_domain_failed';
  process.stdout.write(JSON.stringify({status:uncertain?'unknown':'blocked',applied:uncertain?'unknown':false,code,...(requestContext?.action==='analysis.comprehensive'&&e.code==='analysis_context_invalid'?{details:e.details}:{}),...(annual?{initializationPerformed:false,handlingPath:'年度核对只接收已建账且结构就绪的现存目标。缺库/结构或WAL不支持时转交既有首次接入或显式升级/恢复流程，由另一线处理；此调用不创建、初始化、迁移或转换目标。范围或版本冲突先核实实际目标及证据，保留未完成。'}:{})}));}
finally {try{db?.close();}catch{}}
