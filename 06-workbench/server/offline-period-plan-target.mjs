// 使用一个全新只读 worker；父进程代码比较后才加载应用。
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, lstatSync, realpathSync, openSync, fstatSync, closeSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PERIOD_PLAN_VERSION, sha, capturePeriodPlanCode, validatePeriodPlanRequest, unavailable } from './offline-period-plan.mjs';
const initialCode = capturePeriodPlanCode(); let expectedCode;
const need = (yes, code) => { if (!yes) throw Object.assign(new Error(code), { code }); };
const currentCode = () => need(expectedCode && JSON.stringify(initialCode) === JSON.stringify(expectedCode) && JSON.stringify(capturePeriodPlanCode()) === JSON.stringify(expectedCode), 'period_plan_code_restart_required');
const same = (a,b) => a.dev===b.dev && a.ino===b.ino && a.birthtimeMs===b.birthtimeMs && b.nlink===1;
function checked(p) {
  need(resolve(p) === p && basename(p) === 'workbench.db', 'period_plan_db_path_invalid');
  for (let part=p;;part=dirname(part)) { const s=lstatSync(part); need(!s.isSymbolicLink() && realpathSync.native(part).toLowerCase()===part.toLowerCase(), 'period_plan_db_alias'); if (part===dirname(part)) break; }
  const s=lstatSync(p); need(s.isFile() && s.nlink===1 && s.size>=4096, 'period_plan_db_invalid'); return s;
}
// 包含全部表/结构记录及审计、导入、期间状态，此处没有业务算法。
function snapshot(db) {
  const schema=db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all();
  const tables=schema.filter(s=>s.type==='table').map(s=>({ name:s.name, rows:db.prepare('SELECT * FROM "'+s.name.replaceAll('"','""')+'"').all().map(r=>JSON.stringify(r,(_,v)=>typeof v==='bigint'?String(v):v)).sort() }));
  return sha(JSON.stringify({schema,tables}));
}
async function handle(request) {
  validatePeriodPlanRequest(request); currentCode();
  const { openOfflineActionInput, assertOfflineActionInputCurrent, offlineActionSessionEvidence } = await import('./offline-action-input.mjs');
  const { buildOfflineActionPlanFromFiles } = await import('./offline-action-plan.mjs');
  const { runOfflinePosting } = await import('./offline-posting.mjs');
  const { buildPeriodEndCheck, balancesThrough } = await import('./period-end-controls.mjs');
  const { validateManifest, REPORT_KINDS } = await import('./local-batch-storage.mjs');
  const { inspectAuditSchema } = await import('./local-audit-storage.mjs');
  const { getEnterpriseAccountSet, getAccountSetEnterprise } = await import('./import-storage.mjs');
  const { getAccountingProfile } = await import('./accounting-profiles.mjs');
  const { validateScope, stable } = await import('./offline-material-adapters.mjs');
  const { VAT_SOURCE_SYSTEM } = await import('./tax-calculation.mjs');
  currentCode(); let db,fd,session;
  try {
    const t=request.target, initial=checked(t.dbPath); fd=openSync(t.dbPath,'r'); need(same(initial,fstatSync(fd)), 'period_plan_db_changed');
    db=new DatabaseSync(t.dbPath,{readOnly:true});
    const assertIdentity=()=>need(same(initial,checked(t.dbPath)) && same(initial,fstatSync(fd)), 'period_plan_db_changed'); assertIdentity();
    db.exec('BEGIN'); const before=snapshot(db);
    const audit=inspectAuditSchema(db); need(audit.ok && audit.version===2 && audit.activeInstanceId===t.databaseInstanceId,'period_plan_instance_mismatch');
    need(db.prepare('SELECT MAX(version) v FROM schema_migrations').get()?.v===5,'period_plan_schema_unsupported');
    const set=db.prepare('SELECT * FROM account_sets WHERE id=?').get(t.accountSetId);
    need(set && getEnterpriseAccountSet(db,t.enterpriseKey)?.account_set_id===set.id && getAccountSetEnterprise(db,set.id)?.enterprise_key===t.enterpriseKey,'period_plan_enterprise_binding_mismatch');
    need(set.accounting_profile_id==='small-2011-basic-v1' && set.accounting_standard==='小企业会计准则','period_plan_profile_unsupported');
    const accounts=db.prepare('SELECT * FROM accounts WHERE account_set_id=? ORDER BY code').all(set.id), profile=getAccountingProfile('small-2011-basic-v1');
    need(accounts.length===profile.coa.length && profile.coa.every(e=>accounts.some(a=>a.code===e.code && a.name===e.name && a.category===e.category && a.direction===e.direction && a.contra===(e.contra===true?1:0) && a.is_leaf===1)), 'period_plan_chart_unsupported');
    session=await openOfflineActionInput(request.inputPath); const plan=await buildOfflineActionPlanFromFiles(session), range=validateScope(plan.scope);
    need(plan.scope.enterpriseKey===t.enterpriseKey && plan.scope.accountSetId===String(t.accountSetId) && plan.scope.currency==='CNY' && plan.scope.unit==='yuan' && request.month>=range.from && request.month<=range.to,'period_plan_scope_mismatch');
    const issues=[], add=(classification,code,subject,requestedFact,operatorOnly=true)=>issues.push({ classification,code,subject,requestedFact,operatorOnly, affects:['period_plan','period_reports'], acceptedMaterials:operatorOnly?['本机账务、来源及登记核查']:['原始业务JSON、登记/合同/验收说明及带确认人和依据的声明；附件未自动解析'], alternativeEvidence:operatorOnly?[]:['注明实际情况、期间、确认人和具体依据的本机说明；不要求客户制作会计分录'] });
    for (const r of plan.matrix) if (!['provided_valid','not_applicable'].includes(r.status) && !r.customerRequestSuperseded) add(r.status,r.reason,r.subject??r.id,(r.requestedFields??r.acceptedMaterials??[]).join('；'),!!r.operatorOnly);
    const d=plan.sources.declaration;
    const applicable = area => plan.matrix.find(r=>r.id===area)?.status==='not_applicable';
    if (request.month!==set.start_period) add('unsupported','period_plan_first_month_only','启用首月','当前计划仅核实实际账套启用首月，后续月份需核实前期真实结果');
    if (request.month.endsWith('-12')) add('unsupported','period_plan_year_end_unsupported','年末','年末利润分配依赖尚未接入此窄计划');
    if (d?.opening?.state!=='new_zero' || d?.history?.state!=='first_period') add('unsupported','period_plan_history_not_supported','期初与历史','期初余额或历史材料附件尚未自动解析，需后续支持；不能按零业务处理',false);
    const openings=db.prepare('SELECT * FROM opening_balances WHERE account_set_id=?').all(set.id);
    if (openings.some(r=>r.debit!==0 || r.credit!==0)) add('conflict','period_plan_opening_conflict','期初','无期初声明与实际期初余额冲突，核对实际建账依据',false);
    const period=db.prepare('SELECT * FROM periods WHERE account_set_id=? AND period=?').get(set.id,request.month);
    if (!period || period.status!=='open') add('conflict','period_plan_period_not_open','期间状态','核对实际期间状态；本计划不会创建或反结账');
    const vouchers=db.prepare('SELECT * FROM vouchers WHERE account_set_id=? ORDER BY id').all(set.id);
    if (vouchers.some(v=>v.period<set.start_period)) add('conflict','period_plan_prior_business','前期业务','新设首期声明与实际前期业务冲突，核对建账及历史依据',false);
    if (db.prepare('SELECT COUNT(*) n FROM asset_cards WHERE account_set_id=?').get(set.id).n) add('conflict','period_plan_asset_register_conflict','资产登记','无资产声明与实际资产卡片冲突，核对取得、用途、启用日期和依据',false);
    if (db.prepare('SELECT COUNT(*) n FROM asset_depreciation_runs WHERE account_set_id=?').get(set.id).n) add('unsupported','period_plan_depreciation_register_unsupported','折旧登记','现存计提登记的来源核验尚未接入本片');
    const auxiliaryRequirements=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='aux_requirements'").get()?db.prepare('SELECT * FROM aux_requirements WHERE account_set_id=? ORDER BY code').all(set.id):[];
    if (auxiliaryRequirements.some(r=>r.project!==0 || r.department!==0 || r.party!==0)) add('unsupported','period_plan_auxiliary_unsupported','辅助核算','当前期末计划未接入必填辅助维度，需后续支持');
    const balances=balancesThrough(db,set.id,request.month);
    if ([...balances].some(([code,b])=>/^(150|16|17|1801|2211)/.test(code) && b.net!==0n)) add('conflict','period_plan_asset_payroll_ledger_conflict','资产工资总账','核对资产、工资是否确实不适用及实际原始业务依据',false);
    if (['1001','1002'].some(code=>(balances.get(code)?.net??0n)<0n)) add('needs_local_review','period_plan_negative_cash_bank','资金来源','实际现金/银行余额为负，需核对完整账户、收付及资金来源事实；不补造期初或分录',false);
    const proofs=[], known=new Set();
    for (const task of plan.tasks.filter(x=>x.operation==='prepare_candidate')) {
      if (task.status!=='candidate_preparation_ready' || !task.candidate) { add(task.status==='candidate_preparation_ready'?'unsupported':task.status,'period_plan_unresolved_business',task.subject,'当前业务无法证明实际确认月或未支持，保守阻断整月；'+task.reasons.map(r=>r.requestedFact).join('；'),false); continue; }
      const q=runOfflinePosting({version:'offline-posting-input/1',command:'query',inputPath:request.inputPath,target:t,selected:{taskId:task.taskId,businessKey:task.businessKey}});
      const inMonth=task.candidate.date.slice(0,7)===request.month;
      proofs.push({ taskId:task.taskId,businessKey:task.businessKey,kind:task.kind,date:task.candidate.date,inMonth,dependencyDigest:task.dependencyDigest,policyDigest:q.policyDigest??null,status:q.status,code:q.code,applied:q.applied,evidence:q.evidence??null });
      if (inMonth) {
        if (q.status!=='recovered' || q.applied!==true || !q.evidence?.voucherId) add(q.status==='not_applied'?'missing':'needs_local_review',q.status==='not_applied'?'period_plan_business_not_posted':'period_plan_posting_unverified',task.subject,'此业务尚未证明实际入账：先使用既有正式过账接口或由操作者核查真实审计/来源；不要求客户制作分录');
        else known.add(q.evidence.voucherId);
      }
    }
    for (const v of vouchers.filter(v=>v.period===request.month)) if (!known.has(v.id)) add(v.kind==='normal'?'conflict':'unsupported','period_plan_unexplained_voucher','同期间凭证','当前凭证无本片逐业务来源证明，或属于未接入的结转/折旧；需本机核查');
    const sourceRows=db.prepare('SELECT s.* FROM import_voucher_sources s LEFT JOIN vouchers v ON s.voucher_id=v.id WHERE s.account_set_id=? AND (v.id IS NULL OR v.period<=?) ORDER BY s.source_system,s.source_voucher_id').all(set.id,request.month);
    const batchLinks=db.prepare('SELECT s.* FROM import_batch_vouchers s LEFT JOIN vouchers v ON s.voucher_id=v.id WHERE s.account_set_id=? AND (v.id IS NULL OR v.period<=?) ORDER BY s.batch_id,s.source_voucher_id').all(set.id,request.month);
    for (const rows of [sourceRows,batchLinks]) {
      if(rows.length!==known.size || rows.some(r=>!proofs.some(p=>p.inMonth && p.evidence?.voucherId===r.voucher_id && p.businessKey===r.source_voucher_id && p.evidence.batchId===r.batch_id && r.source_system===VAT_SOURCE_SYSTEM && r.enterprise_key===t.enterpriseKey))) add('conflict','period_plan_unexplained_source_relation','凭证来源关系','存在不能逐业务解释的同期间来源/批次关系，需本机操作者核查');
    }
    const sourceBindings=db.prepare('SELECT * FROM import_source_bindings WHERE enterprise_key=? ORDER BY source_system').all(t.enterpriseKey);
    if (known.size && !sourceBindings.some(r=>r.source_system===VAT_SOURCE_SYSTEM && r.enterprise_key===t.enterpriseKey)) add('conflict','period_plan_source_binding_missing','来源绑定','已入账业务的来源系统绑定缺失，需本机核查');
    const periodCheck=buildPeriodEndCheck(db,set.id,request.month);
    for (const b of periodCheck.blocking) if (b.code!=='profit_not_carried_forward') add('needs_local_review',b.code,b.title,b.message);
    const carry=periodCheck.blocking.some(b=>b.code==='profit_not_carried_forward');
    const relevant = {
      schema:db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all(), instance:t.databaseInstanceId,
      accountSet:set, accounts, openings, auxiliaryRequirements, sourceBindings, enterpriseBinding:getEnterpriseAccountSet(db,t.enterpriseKey),
      periods:db.prepare('SELECT * FROM periods WHERE account_set_id=? AND period<=? ORDER BY period').all(set.id,request.month),
      vouchers:vouchers.filter(v=>v.period<=request.month),
      entries:db.prepare('SELECT e.* FROM voucher_entries e JOIN vouchers v ON e.voucher_id=v.id WHERE v.account_set_id=? AND v.period<=? ORDER BY e.id').all(set.id,request.month),
      cards:db.prepare('SELECT * FROM asset_cards WHERE account_set_id=? ORDER BY id').all(set.id),
      depreciation:db.prepare('SELECT * FROM asset_depreciation_runs WHERE account_set_id=? ORDER BY id').all(set.id), sourceRows, batchLinks
    };
    await assertOfflineActionInputCurrent(session); currentCode(); assertIdentity();
    need(snapshot(db)===before,'period_plan_ledger_changed'); db.exec('COMMIT');
    // 结束持有的快照后重新读取实际当前行，不能使用过期 WAL 视图。
    db.exec('BEGIN'); need(snapshot(db)===before,'period_plan_ledger_changed'); db.exec('COMMIT');
    await assertOfflineActionInputCurrent(session); currentCode(); assertIdentity();
    const evidence={ code:expectedCode, ledgerDigest:sha(stable(relevant)), input:offlineActionSessionEvidence(session), actionPlanVersion:plan.planVersion, businesses:proofs, declarationVerification:'local_statements_attachments_unverified' };
    const bindingDigest=sha(stable({version:PERIOD_PLAN_VERSION,target:t,month:request.month,evidence}));
    let manifest=null;
    if (!issues.length) {
      manifest={schemaVersion:1,jobKey:'offline-period-'+bindingDigest,concurrency:1,items:[{itemKey:'period-'+request.month,source:{system:VAT_SOURCE_SYSTEM,enterpriseKey:t.enterpriseKey},accountSetId:set.id,periods:[{period:request.month,carryforward:carry?{yearEnd:false}:false,periodCheck:true,close:false,depreciation:false,reports:REPORT_KINDS.map(kind=>({kind,formats:['csv'],...(kind==='ledger'?{code:'1122'}:{})}))}]}]};
      need(validateManifest(manifest).ok,'period_plan_manifest_invalid');
    }
    return {version:PERIOD_PLAN_VERSION,status:issues.length?'blocked':'ready_for_manifest',code:issues.length?'period_plan_dependencies_blocked':'period_plan_readonly_admission_verified',authorizesExecution:false,periodComplete:false,submittable:false,month:request.month,target:t,scope:plan.scope,bindingDigest,evidence,issues,customerRequest:plan.customerRequest,periodCheck,remediableSteps:carry?[{operation:'carryforward',reason:'profit_not_carried_forward',performed:false}]:[],notApplicable:[{operation:'depreciation',state:applicable('assets') && !issues.some(i=>i.code.includes('asset') || i.code.includes('depreciation'))?'not_applicable':'unverified',performed:false}],manifest};
  } finally { try { session?.close(); } catch {} try { db?.close(); } catch {} if(fd!==undefined)closeSync(fd); }
}
if (process.argv.length===2 && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  let result;
  try { const e=JSON.parse(readFileSync(0,'utf8')); need(Object.keys(e).sort().join(',')==='expectedCode,request,version' && e.version==='offline-period-plan-private/1','period_plan_private_transport_required'); expectedCode=e.expectedCode; currentCode(); result=await handle(e.request); }
  catch(error) { const codes=new Set(['period_plan_request_invalid','period_plan_code_restart_required','period_plan_db_path_invalid','period_plan_db_alias','period_plan_db_invalid','period_plan_db_changed','period_plan_instance_mismatch','period_plan_schema_unsupported','period_plan_enterprise_binding_mismatch','period_plan_profile_unsupported','period_plan_chart_unsupported','period_plan_scope_mismatch','period_plan_ledger_changed']); result=unavailable(codes.has(error?.code)?error.code:'period_plan_input_or_target_rejected'); }
  process.stdout.write(JSON.stringify(result));
}
