// 固定单请求 worker；全部账簿修改都经过公开导入业务层。
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, lstatSync, realpathSync, openSync, fstatSync, closeSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { capturePostingCode, validatePostingRequest, POSTING_VERSION } from './offline-posting.mjs';
let openOfflineActionInput, assertOfflineActionInputCurrent, buildOfflineActionPlanFromFiles, getAccountingProfile, VAT_SOURCE_SYSTEM, hash, stable, requireValue, auditResultDigest, auditCanonicalDigest, queryOperation, inspectAuditSchema, getBatch, getVoucherSource, listBatchVouchers, getEnterpriseAccountSet, getAccountSetEnterprise, getSourceBinding, persistedVoucherFingerprint, voucherFingerprint;
const initialCode = capturePostingCode(), codeDigest = initialCode.digest;
let expectedCode;
function assertCodeCurrent() { if (!expectedCode || JSON.stringify(initialCode) !== JSON.stringify(expectedCode) || JSON.stringify(capturePostingCode()) !== JSON.stringify(expectedCode)) throw Object.assign(new Error('posting_code_restart_required'), { code: 'posting_code_restart_required' }); }
async function loadApplication() {
  ({ openOfflineActionInput, assertOfflineActionInputCurrent } = await import('./offline-action-input.mjs'));
  ({ buildOfflineActionPlanFromFiles } = await import('./offline-action-plan.mjs'));
  ({ getAccountingProfile } = await import('./accounting-profiles.mjs'));
  ({ VAT_SOURCE_SYSTEM } = await import('./tax-calculation.mjs'));
  ({ hash, stable, requireValue } = await import('./offline-material-adapters.mjs'));
  ({ auditResultDigest, auditCanonicalDigest } = await import('./local-audit.mjs'));
  ({ queryOperation, inspectAuditSchema } = await import('./local-audit-storage.mjs'));
  ({ getBatch, getVoucherSource, listBatchVouchers, getEnterpriseAccountSet, getAccountSetEnterprise, getSourceBinding, persistedVoucherFingerprint, voucherFingerprint } = await import('./import-storage.mjs'));
  assertCodeCurrent();
}

const profileId = 'small-2011-basic-v1';
const base = () => ({ version: POSTING_VERSION, periodComplete: false, submittable: false });
const reject = (code, extra = {}) => ({ ...base(), status: 'blocked', code, applied: false, ...extra });
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino && a.birthtimeMs === b.birthtimeMs && b.nlink === 1;
function checkedFile(path) {
  requireValue(typeof path === 'string' && resolve(path) === path && basename(path) === 'workbench.db', 'posting_db_path_invalid');
  for (let p = path;; p = dirname(p)) {
    const s = lstatSync(p); requireValue(!s.isSymbolicLink() && realpathSync.native(p).toLowerCase() === p.toLowerCase(), 'posting_db_alias');
    if (dirname(p) === p) break;
  }
  const s = lstatSync(path); requireValue(s.isFile() && s.nlink === 1 && s.size >= 4096, 'posting_db_invalid'); return s;
}
function targetState(db, target, candidate) {
  const schema = inspectAuditSchema(db);
  requireValue(schema.ok && schema.version === 2 && schema.activeInstanceId === target.databaseInstanceId, 'posting_instance_mismatch');
  requireValue(db.prepare('SELECT MAX(version) v FROM schema_migrations').get()?.v === 5 && db.prepare('PRAGMA table_info(vouchers)').all().some(c => c.name === 'kind'), 'posting_schema_unsupported');
  const set = db.prepare('SELECT * FROM account_sets WHERE id=?').get(target.accountSetId);
  requireValue(set && getEnterpriseAccountSet(db, target.enterpriseKey)?.account_set_id === set.id && getAccountSetEnterprise(db, set.id)?.enterprise_key === target.enterpriseKey, 'posting_enterprise_binding_mismatch');
  requireValue(set.accounting_profile_id === profileId && set.accounting_standard === '小企业会计准则', 'posting_profile_unsupported');
  const codes = [...new Set(candidate.entries.map(e => e.accountCode))].sort();
  const profile = getAccountingProfile(profileId), accounts = db.prepare('SELECT * FROM accounts WHERE account_set_id=? ORDER BY code').all(set.id);
  const policyAccounts = [];
  for (const code of codes) {
    const a = accounts.find(a => a.code === code), expected = profile.coa.find(a => a.code === code);
    requireValue(a && expected && a.name === expected.name && a.category === expected.category && a.direction === expected.direction && a.contra === (expected.contra === true ? 1 : 0), 'posting_account_semantics_unsupported');
    requireValue(a.is_leaf === 1 && !accounts.some(x => x.code !== code && x.code.startsWith(code)), 'posting_account_not_leaf');
    policyAccounts.push({ code, name: a.name, category: a.category, direction: a.direction, contra: a.contra, isLeaf: true, noDescendants: true });
  }
  const auxTables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'aux_%'").all();
  if (auxTables.length) {
    requireValue(auxTables.some(x => x.name === 'aux_requirements'), 'posting_aux_unverified');
    const requirements = db.prepare('SELECT * FROM aux_requirements WHERE account_set_id=?').all(set.id);
    requireValue(!requirements.some(r => codes.includes(r.code) && (r.project !== 0 || r.department !== 0 || r.party !== 0)), 'posting_aux_required');
  }
  const binding = getSourceBinding(db, VAT_SOURCE_SYSTEM, target.enterpriseKey);
  requireValue(!binding || binding.account_set_id === set.id, 'posting_source_binding_mismatch');
  const policy = { version: 'offline-posting-policy/1', profileId, accounts: policyAccounts, auxiliary: 'no_required_dimensions_for_used_codes', sourceSystem: VAT_SOURCE_SYSTEM, codeDigest };
  return { policy, policyDigest: hash(stable(policy)), sourceBindingExists: !!binding, startPeriod: set.start_period };
}
function optionsFor(target, task, policyDigest, batchId, startPeriod) {
  const c = task.candidate;
  return { mode: 'append', dryRun: false, accountSetId: target.accountSetId, confirmNewBinding: true, batchId,
    source: { system: VAT_SOURCE_SYSTEM, enterpriseKey: target.enterpriseKey },
    offlinePosting: { version: POSTING_VERSION, taskId: task.taskId, dependencyDigest: task.dependencyDigest, policyDigest },
    payload: { account_set: { name: 'Offline existing account set', start_period: startPeriod, profileId }, vouchers: [{ sourceVoucherId: c.businessKey, period: c.date.slice(0, 7), date: c.date, summary: `offline:${c.businessKey}`, entries: c.entries.map(e => ({ code: e.accountCode, debit: e.debit, credit: e.credit, summary: e.detail ?? c.kind })) }] } };
}
const requestDigest = options => auditCanonicalDigest(['audit-request-v1', 'import.append', { domainRequestDigest: auditResultDigest(options) }]);
function exactCents(value) {
  if ((typeof value !== 'number' && typeof value !== 'string') || typeof value === 'number' && (!Number.isFinite(value) || value < 0)) return null;
  const s = String(value); if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(s)) return null;
  const [whole, fraction = ''] = s.split('.'), cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  return cents <= 99999999999999n ? cents : null;
}
// 只读证明由已有存储 API 及官方审计查询组装。
function durableState(db, target, ids, options) {
  db.exec('BEGIN');
  try { const value = readDurableState(db, target, ids, options); db.exec('COMMIT'); return value; }
  catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
}
function readDurableState(db, target, ids, options) {
  let operation;
  try { operation = queryOperation(db, { databaseInstanceId: target.databaseInstanceId, operationId: ids.operationId }); }
  catch { return { status: 'needs_local_review', code: 'posting_audit_unavailable', applied: 'unknown' }; }
  const batch = getBatch(db, ids.batchId), source = getVoucherSource(db, VAT_SOURCE_SYSTEM, target.enterpriseKey, ids.businessKey);
  if (operation.code === 'not_found') return !batch && !source ? { status: 'not_applied', code: 'posting_not_found', applied: false } : { status: 'needs_local_review', code: 'posting_unmatched_existing_source_or_batch', applied: 'unknown' };
  // queryOperation 有意不含请求/动作绑定；这里只读其持久化记录，不作修改。
  const row = db.prepare('SELECT * FROM audit_operations WHERE database_instance_id=? AND operation_id=? AND attempt=1').get(target.databaseInstanceId, ids.operationId);
  if (!row || row.request_digest !== requestDigest(options) || row.action !== 'import.append' || row.actor !== 'cli' || row.scope_kind !== 'account_set' || JSON.parse(row.targets_json).accountSetId !== target.accountSetId || row.parent_operation_id !== null || db.prepare('SELECT COUNT(*) n FROM audit_operations WHERE database_instance_id=? AND operation_id=?').get(target.databaseInstanceId, ids.operationId).n !== 1) return { status: 'conflict', code: 'posting_semantic_conflict', applied: operation.ok === true ? true : 'unknown' };
  if (operation.durability !== 'committed' || operation.state === 'pending') return { status: 'needs_local_review', code: operation.code, applied: 'unknown' };
  if (!operation.ok) return { status: 'needs_local_review', code: 'posting_previous_failure', applied: false };
  const receipt = operation.receipt;
  if (!receipt || receipt.receiptVersion !== 2 || receipt.databaseInstanceId !== target.databaseInstanceId || receipt.operationId !== ids.operationId || receipt.attempt !== 1 || receipt.targets.accountSetId !== target.accountSetId || receipt.state !== 'succeeded') return { status: 'needs_local_review', code: 'posting_receipt_inconsistent', applied: 'unknown' };
  const links = listBatchVouchers(db, ids.batchId), v = source && db.prepare('SELECT * FROM vouchers WHERE id=?').get(source.voucher_id);
  const entries = v && db.prepare('SELECT id,line_no,code,summary,debit,credit FROM voucher_entries WHERE voucher_id=? ORDER BY line_no').all(v.id);
  const wantedFingerprint = voucherFingerprint(options.payload.vouchers[0]);
  const wantedVoucher = options.payload.vouchers[0];
  if (v && (v.kind !== 'normal' || !entries || entries.length !== wantedVoucher.entries.length || v.period !== wantedVoucher.period || v.voucher_date !== wantedVoucher.date || v.word !== '记' || v.summary !== wantedVoucher.summary || !Number.isSafeInteger(v.number) || v.number < 1 || entries.some((e, i) => {
    const wanted = wantedVoucher.entries[i], debit = exactCents(e.debit), credit = exactCents(e.credit);
    return typeof e.debit !== 'number' || typeof e.credit !== 'number' || debit === null || credit === null || debit !== exactCents(wanted.debit) || credit !== exactCents(wanted.credit) || e.code !== wanted.code || e.summary !== wanted.summary || e.line_no !== i + 1 || !Number.isSafeInteger(e.id) || e.id < 1;
  }))) return { status: 'needs_local_review', code: 'posting_stored_entries_inconsistent', applied: 'unknown' };
  const link = links[0];
  if (!batch || batch.status !== 'completed' || batch.attempts !== 1 || batch.account_set_id !== target.accountSetId || batch.mode !== 'append' || batch.source_system !== VAT_SOURCE_SYSTEM || batch.enterprise_key !== target.enterpriseKey || !source || source.batch_id !== ids.batchId || source.account_set_id !== target.accountSetId || source.content_fingerprint !== wantedFingerprint || !source.voucher_fingerprint || !v || v.account_set_id !== target.accountSetId || v.status !== 'posted' || persistedVoucherFingerprint(v, entries) !== source.voucher_fingerprint || links.length !== 1 || link.source_voucher_id !== ids.businessKey || link.source_system !== VAT_SOURCE_SYSTEM || link.enterprise_key !== target.enterpriseKey || link.account_set_id !== target.accountSetId || link.voucher_id !== v.id || link.content_fingerprint !== wantedFingerprint || link.action !== 'created') return { status: 'needs_local_review', code: 'posting_ledger_evidence_inconsistent', applied: 'unknown' };
  // 独立核对保存的批次指纹是否匹配这一精确单凭证请求。
  const m = options.payload.account_set;
  const wantedBatch = hash(JSON.stringify({ mode: 'append', targetAccountSetId: target.accountSetId, source: options.source, meta: { name: m.name, taxpayer_type: '', accounting_standard: '', start_period: m.start_period }, accounts: [], opening_balances: [], vouchers: [{ sourceVoucherId: ids.businessKey, fingerprint: wantedFingerprint }] }));
  if (batch.content_fingerprint !== wantedBatch) return { status: 'needs_local_review', code: 'posting_batch_fingerprint_inconsistent', applied: 'unknown' };
  return { status: 'recovered', code: 'posting_persisted_evidence_verified', applied: true, evidence: { databaseInstanceId: target.databaseInstanceId, operationId: ids.operationId, attempt: 1, eventId: receipt.eventId, batchId: ids.batchId, voucherId: v.id, sourceVoucherId: ids.businessKey, posted: true, fingerprintVerified: true, originalResponseReplayed: false, entries: entries.map((e, i) => ({ entryId: e.id, lineNo: e.line_no, accountCode: e.code, debit: e.debit, credit: e.credit, candidateEntryIndex: i })) } };
}
async function handle(request) {
  validatePostingRequest(request);
  let session, ro, writeDb, fd, ids, common, options, invoked = false, historical = false;
  try {
    const t = request.target, initial = checkedFile(t.dbPath); fd = openSync(t.dbPath, 'r'); requireValue(sameFile(initial, fstatSync(fd)), 'posting_db_changed');
    ro = new DatabaseSync(t.dbPath, { readOnly: true });
    requireValue(sameFile(initial, checkedFile(t.dbPath)) && sameFile(initial, fstatSync(fd)), 'posting_db_changed');
    const identity = hash(stable(['offline-posting/1', t.databaseInstanceId, t.enterpriseKey, t.accountSetId, request.selected.businessKey]));
    ids = { operationId: identity, batchId: identity, businessKey: request.selected.businessKey };
    common = { ...base(), ...ids, target: { ...t }, taskId: request.selected.taskId };
    // 打开当前材料前先读取持久化结果；原件缺失或更正
    // 不能抹去已知提交，也不能使 pending 尝试可安全重复。
    let audit;
    try { audit = inspectAuditSchema(ro); requireValue(audit.ok, 'posting_audit_unavailable'); }
    catch (e) { historical = 'unknown'; throw e; }
    requireValue(audit.activeInstanceId === t.databaseInstanceId, 'posting_instance_mismatch');
    let known;
    try { known = queryOperation(ro, { databaseInstanceId: t.databaseInstanceId, operationId: ids.operationId }); }
    catch (e) { historical = 'unknown'; throw e; }
    const old = ro.prepare('SELECT * FROM audit_operations WHERE database_instance_id=? AND operation_id=? AND attempt=1').get(t.databaseInstanceId, ids.operationId);
    if (known.code !== 'not_found') historical = known.ok && known.durability === 'committed' && old?.action === 'import.append' && old.actor === 'cli' && JSON.parse(old.targets_json).accountSetId === t.accountSetId ? true : 'unknown';
    else if (getBatch(ro, ids.batchId) || getVoucherSource(ro, VAT_SOURCE_SYSTEM, t.enterpriseKey, ids.businessKey)) historical = 'unknown';
    session = await openOfflineActionInput(resolve(request.inputPath));
    const plan = await buildOfflineActionPlanFromFiles(session);
    requireValue(plan.scope.accountSetId === String(t.accountSetId) && plan.scope.enterpriseKey === t.enterpriseKey && plan.scope.currency === 'CNY' && plan.scope.unit === 'yuan', 'posting_scope_mismatch');
    const task = plan.tasks.find(x => x.taskId === request.selected.taskId && x.businessKey === request.selected.businessKey);
    requireValue(task, 'posting_task_missing');
    const { offlineActionSessionEvidence } = await import('./offline-action-input.mjs');
    common = { ...base(), ...ids, scope: plan.scope, target: { ...t }, taskId: task.taskId, dependencyDigest: task.dependencyDigest, candidate: task.candidate, inputEvidence: offlineActionSessionEvidence(session), branches: plan.tasks.filter(x => x.operation === 'prepare_candidate').map(x => ({ taskId: x.taskId, businessKey: x.businessKey, status: x.status, reasons: x.reasons.map(r => ({ code: r.code, field: r.field })) })) };
    if (task.status !== 'candidate_preparation_ready' || !task.candidate) return { ...common, ...reject(historical === false ? 'posting_task_blocked' : 'posting_current_inputs_unverified', { status: historical === false ? 'blocked' : 'needs_local_review', applied: historical }), taskStatus: task.status, reasons: task.reasons };
    const state = targetState(ro, t, task.candidate); options = optionsFor(t, task, state.policyDigest, ids.batchId, state.startPeriod);
    common.policyDigest = state.policyDigest; common.policy = state.policy;
    const prior = durableState(ro, t, ids, options);
    assertCodeCurrent(); requireValue(sameFile(initial, checkedFile(t.dbPath)) && sameFile(initial, fstatSync(fd)), 'posting_db_changed');
    if (prior.status !== 'not_applied') return { ...common, ...prior };
    if (request.command === 'query') return { ...common, ...prior };
    const closed = ro.prepare('SELECT status FROM periods WHERE account_set_id=? AND period=?').get(t.accountSetId, task.candidate.date.slice(0, 7));
    requireValue(closed?.status !== 'closed', 'posting_period_closed');
    if (request.command === 'prepare') return { ...common, status: 'prepared', code: 'posting_explicit_confirmation_required', applied: false, requiresNewSourceConfirmation: !state.sourceBindingExists };
    const c = request.confirmation;
    requireValue(c.operationId === ids.operationId && c.dependencyDigest === task.dependencyDigest && c.policyDigest === state.policyDigest, 'posting_confirmation_stale');
    requireValue(state.sourceBindingExists || c.confirmNewSourceBinding === true, 'posting_new_source_confirmation_required');
    await assertOfflineActionInputCurrent(session); assertCodeCurrent();
    requireValue(sameFile(initial, checkedFile(t.dbPath)) && sameFile(initial, fstatSync(fd)), 'posting_db_changed');
    // 本模块只允许作为固定全新 worker 执行，不存在先前缓存的 db.mjs。
    process.env.WORKBENCH_DATA_DIR = dirname(t.dbPath);
    ({ db: writeDb } = await import('./db.mjs'));
    requireValue(sameFile(initial, checkedFile(t.dbPath)) && writeDb.prepare('PRAGMA database_list').get().file.toLowerCase() === t.dbPath.toLowerCase(), 'posting_db_changed');
    const current = targetState(writeDb, t, task.candidate); requireValue(current.policyDigest === state.policyDigest, 'posting_policy_changed');
    requireValue(durableState(writeDb, t, ids, options).status === 'not_applied', 'posting_state_changed');
    await assertOfflineActionInputCurrent(session); assertCodeCurrent();
    const IM = await import('./import-incremental.mjs');
    const { withRequestMetadata } = await import('./local-audit-coordinator.mjs');
    assertCodeCurrent();
    requireValue(targetState(writeDb, t, task.candidate).policyDigest === state.policyDigest && durableState(writeDb, t, ids, options).status === 'not_applied', 'posting_state_changed');
    invoked = true;
    const value = withRequestMetadata({ operationId: ids.operationId, actor: 'cli' }, () => IM.importIncremental(options));
    const after = durableState(writeDb, t, ids, options);
    if (!value.ok || value.status !== 'applied' || after.status !== 'recovered') return { ...common, ...after, value, status: after.status === 'not_applied' ? 'blocked' : after.status, code: after.status === 'not_applied' ? 'posting_import_rejected' : after.code };
    const batchEvidence = IM.getImportBatch(ids.batchId);
    try { await assertOfflineActionInputCurrent(session); assertCodeCurrent(); requireValue(sameFile(initial, checkedFile(t.dbPath)) && sameFile(initial, fstatSync(fd)), 'posting_db_changed'); requireValue(targetState(writeDb, t, task.candidate).policyDigest === state.policyDigest, 'posting_policy_changed'); }
    catch { return { ...common, ...after, status: 'needs_local_review', code: 'posting_applied_input_stale', applied: true }; }
    return { ...common, status: 'applied', code: 'posting_applied', applied: true, value, batchEvidence, evidence: after.evidence };
  } catch (error) {
    if (invoked && ids && options && writeDb) {
      try { const evidence = durableState(writeDb, request.target, ids, options); return { ...common, ...evidence, status: 'needs_local_review', code: evidence.applied === true ? 'posting_applied_response_unavailable' : evidence.code, applied: evidence.applied }; } catch { return { ...common, status: 'needs_local_review', code: 'posting_commit_unknown', applied: 'unknown' }; }
    }
    const known = new Set(['posting_db_path_invalid','posting_db_alias','posting_db_invalid','posting_db_changed','posting_instance_mismatch','posting_schema_unsupported','posting_enterprise_binding_mismatch','posting_profile_unsupported','posting_account_semantics_unsupported','posting_account_not_leaf','posting_aux_unverified','posting_aux_required','posting_source_binding_mismatch','posting_scope_mismatch','posting_task_missing','posting_period_closed','posting_confirmation_stale','posting_new_source_confirmation_required','posting_policy_changed','posting_state_changed']);
    return { ...common, ...reject(historical === false ? known.has(error?.code) ? error.code : 'posting_input_or_target_rejected' : 'posting_current_inputs_unverified', { status: historical === false ? 'blocked' : 'needs_local_review', applied: historical }) };
  } finally {
    // 资源清理不能将已知持久结果替换为 applied:false。
    for (const close of [() => session?.close(), () => ro?.close(), () => writeDb?.close(), () => { if (fd !== undefined) closeSync(fd); }]) { try { close(); } catch { /* 子进程退出；持久化结果已经记录 */ } }
  }
}
if (process.argv.length === 2 && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.on('error', () => { process.exitCode = 5; });
  let result;
  try {
    const envelope = JSON.parse(readFileSync(0, 'utf8'));
    if (Object.keys(envelope).sort().join(',') !== 'expectedCode,request,version' || envelope.version !== 'offline-posting-private/1') throw new Error('private_transport_required');
    expectedCode = envelope.expectedCode; assertCodeCurrent();
    await loadApplication(); result = await handle(envelope.request);
  }
  catch { result = { ...base(), status: 'needs_local_review', code: 'posting_code_or_transport_rejected', applied: 'unknown' }; }
  try { process.stdout.write(JSON.stringify(result)); } catch { process.exitCode = 5; }
}
