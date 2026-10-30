// 专用的本机不可变复核回执；不写业务数据库，也不另建恢复引擎。
import { mkdir, open, readdir, unlink, lstat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join, resolve, dirname, relative, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hash, stable, fields, requireValue as check, validateScope, identifier } from './offline-material-adapters.mjs';
import { checkedPath, readLocalFile } from './offline-material-store.mjs';
import { openVatInputFiles } from './offline-vat-input.mjs';
import { createAccountantReview, assertAccountantReviewCurrent } from './accountant-review.mjs';
import { exportAccountantReview } from './accountant-review-export.mjs';
import { validateFeedback, validateBinding, assertFeedbackTarget, assertSelectedConfirmation } from './accountant-review-feedback.mjs';

export const REVIEW_STORE_VERSION = 'offline-accountant-review-store/1';
const DIGEST = /^[a-f0-9]{64}$/, LIMIT = 64 * 1024 * 1024;
const same = (a, b) => stable(a) === stable(b);
const json = bytes => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
// 只包含本次读取、重放和校验路径的显式依赖闭包，并非全部服务端代码。
export const REVIEW_CODE_FILES = Object.freeze([
  'accountant-review-store.mjs', 'accountant-review-feedback.mjs', 'accountant-review.mjs', 'accountant-review-export.mjs',
  'offline-vat-input.mjs', 'offline-ledger-snapshot.mjs', 'offline-accounting-readiness.mjs',
  'offline-materials.mjs', 'offline-material-adapters.mjs', 'offline-material-store.mjs', 'offline-invoice-xlsx.mjs',
  'offline-contracts.mjs', 'offline-bookkeeping.mjs', 'offline-voucher-rules.mjs', 'offline-task-planner.mjs',
  'material-completeness.mjs', 'customer-data-request.mjs', 'tax-calculation.mjs', 'tax-rule-registry.mjs',
  'enterprise-identity.mjs', 'import-storage.mjs', 'bank-import.mjs', 'money.mjs', 'accounting-profiles.mjs',
  'local-audit-storage.mjs', 'local-audit.mjs', 'local-batch-storage.mjs', 'database-open-guard.mjs',
]);
const codeFiles = REVIEW_CODE_FILES.map(f => new URL(f, import.meta.url));
const codeDigest = () => hash(stable(codeFiles.map(f => hash(readFileSync(f)))));
const loadedCodeDigest = codeDigest();
const identity = s => `${s.dev}:${s.ino}:${s.birthtimeMs}`;
const flags = { periodComplete: false, submittable: false, authorizesExecution: false, sourceAuthenticity: 'unverified', actorAuthentication: 'local_operator_declaration_only' };
const inside = (root, p) => { const r = relative(root, p); return r === '' || r.split(/[\\/]/)[0] !== '..' && !isAbsolute(r); };
// 既有加载器将不存在的可选清单成员表示为 undefined；
// 严格匹配其导出的 manifest JSON，不能把 null/false/zero 视为缺失。
const bindingFor = (bundle, inventory) => ({ bundleDigest: bundle.contentDigest, inputHash: bundle.computation.inputHash, ruleVersion: bundle.computation.ruleVersion, ruleDigest: bundle.computation.ruleDigest, calculationVersion: bundle.computation.version, ledgerSnapshotDigest: bundle.computation.ledgerSnapshotDigest, ruleCodeDigest: loadedCodeDigest, inputFilesDigest: hash(stable(JSON.parse(JSON.stringify(inventory)))) });
const cellKey = c => `${c.row}:${c.column}:${c.period}`;
function differences(previous, current) {
  if (!previous) return [];
  const old = new Map(previous.computation.cells.map(c => [cellKey(c), c]));
  return current.computation.cells.flatMap(c => { const before = old.get(cellKey(c)), select = x => ({ status: x.status, minor: x.minor, value: x.value }); return same(select(before), select(c)) ? [] : [{ row: c.row, column: c.column, period: c.period, before: select(before), after: select(c) }]; });
}
async function writeNew(path, bytes) {
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}
async function rootInfo(path) { const root = await checkedPath(path, true); return { root, identity: identity(await lstat(root)) }; }
async function rootStill(info) { check((await rootInfo(info.root)).identity === info.identity, 'review_store_path_changed'); }
async function exists(path) { try { await lstat(path); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }

export async function initReviewStore(path, scope) {
  scope = structuredClone(scope);
  validateScope(scope); const root = resolve(path); await checkedPath(dirname(root), true);
  await mkdir(root, { mode: 0o700 }); // 绝不接管已有或执行中断留下的目录。
  await mkdir(join(root, 'receipts')); await mkdir(join(root, 'artifacts'));
  const metadata = { version: REVIEW_STORE_VERSION, storeId: randomUUID(), scope: structuredClone(scope) };
  await writeNew(join(root, 'store.json'), stable(metadata) + '\n');
  return { status: 'initialized', scope: structuredClone(scope), journalHead: null, ...flags };
}
async function verifyArtifact(root, version) {
  const dir = join(root, 'artifacts', version.versionId); await checkedPath(dir, true);
  check(same((await readdir(dir)).sort(), ['bundle.json', 'manifest.json', 'workpaper.xlsx']), 'review_artifact_layout_invalid');
  check(Array.isArray(version.artifactFiles) && version.artifactFiles.length === 3, 'review_artifact_metadata_invalid');
  for (const [i, file] of version.artifactFiles.entries()) {
    fields(file, ['name', 'bytes', 'sha256']);
    check(file.name === ['bundle.json', 'manifest.json', 'workpaper.xlsx'][i] && Number.isSafeInteger(file.bytes) && file.bytes > 0 && file.bytes <= LIMIT && DIGEST.test(file.sha256), 'review_artifact_metadata_invalid');
  }
  const actual = [];
  let bundle, manifest;
  for (const name of ['bundle.json', 'manifest.json', 'workpaper.xlsx']) {
    const file = await readLocalFile(join(dir, name), version.artifactFiles.find(f => f.name === name).bytes); actual.push({ name, bytes: file.bytes.length, sha256: hash(file.bytes) });
    if (name === 'bundle.json') bundle = json(file.bytes);
    if (name === 'manifest.json') manifest = json(file.bytes);
  }
  check(same(actual, version.artifactFiles), 'review_artifact_corrupt');
  check(bundle.version === 'offline-accountant-review/1' && bundle.kind === 'accountant_review_draft' && same(bundle.scope, version.scope), 'review_artifact_scope_invalid');
  const { contentDigest, ...content } = bundle;
  check(hash(stable(content)) === contentDigest && contentDigest === version.binding.bundleDigest, 'review_artifact_digest_invalid');
  check(bundle.accountantApproval === 'pending' && bundle.confirmationStatus === 'pending' && bundle.periodComplete === false && bundle.submittable === false && bundle.authorizesExecution === false, 'review_artifact_not_pending');
  check(manifest.version === 'offline-accountant-review-manifest/1' && manifest.status === 'complete_draft' && manifest.accountantApproval === 'pending' && manifest.submittable === false && manifest.authorizesExecution === false && manifest.bundleDigest === contentDigest, 'review_manifest_invalid');
  check(same(manifest.files, actual.filter(f => f.name !== 'manifest.json')), 'review_manifest_files_invalid');
  const binding = bindingFor(bundle, manifest.inputFiles); binding.ruleCodeDigest = version.binding.ruleCodeDigest;
  check(same(binding, version.binding), 'review_artifact_binding_invalid');
  return bundle;
}
async function loadStore(path) {
  const info = await rootInfo(path), metaBytes = (await readLocalFile(join(info.root, 'store.json'))).bytes, meta = json(metaBytes);
  fields(meta, ['version', 'storeId', 'scope']); validateScope(meta.scope);
  check(meta.version === REVIEW_STORE_VERSION && /^[a-f0-9-]{36}$/.test(meta.storeId), 'review_store_metadata_invalid');
  await checkedPath(join(info.root, 'receipts'), true); await checkedPath(join(info.root, 'artifacts'), true);
  const names = (await readdir(join(info.root, 'receipts'))).sort();
  check(names.length <= 2000 && names.every((name, i) => name === `${String(i + 1).padStart(8, '0')}.json`), 'review_journal_layout_invalid');
  const versions = [], feedbacks = [], bundles = new Map(), seenFeedbacks = new Set(); let head = null;
  for (const name of names) {
    const file = join(info.root, 'receipts', name), size = (await lstat(file)).size;
    check(size > 0 && size <= 2 * 1024 * 1024, 'review_receipt_limit_or_partial');
    const receipt = json((await readLocalFile(file, size)).bytes);
    fields(receipt, ['version', 'sequence', 'previousHead', 'metadataDigest', 'kind', 'data', 'digest']);
    const { digest, ...body } = receipt;
    check(receipt.version === 'offline-accountant-review-receipt/1' && receipt.sequence === Number(name.slice(0, 8)) && receipt.previousHead === head && receipt.metadataDigest === hash(metaBytes) && hash(stable(body)) === digest, 'review_journal_corrupt');
    const d = receipt.data, current = versions.at(-1);
    if (receipt.kind === 'register') {
      fields(d, ['versionId', 'scope', 'inputPath', 'binding', 'supersedes', 'artifactFiles', 'fieldDifferences']);
      identifier(d.versionId); validateBinding(d.binding); check(!versions.some(v => v.versionId === d.versionId) && same(d.scope, meta.scope) && d.supersedes === (current?.versionId ?? null) && typeof d.inputPath === 'string' && resolve(d.inputPath) === d.inputPath && !inside(info.root, d.inputPath), 'review_version_invalid');
      const bundle = await verifyArtifact(info.root, d);
      check(same(d.fieldDifferences, differences(current ? bundles.get(current.versionId) : null, bundle)), 'review_differences_invalid');
      bundles.set(d.versionId, bundle); versions.push(d);
    } else if (receipt.kind === 'feedback') {
      validateFeedback(d); assertFeedbackTarget(d, current, meta.scope);
      check(d.expectedJournalHead === head && !seenFeedbacks.has(d.feedbackId), 'review_feedback_journal_invalid');
      if (d.action === 'confirm_selected_fields') assertSelectedConfirmation(d, bundles.get(d.versionId));
      seenFeedbacks.add(d.feedbackId); feedbacks.push(d);
    } else check(false, 'review_receipt_kind_invalid');
    head = digest;
  }
  await rootStill(info);
  return { info, meta, metaBytes, versions, feedbacks, bundles, head, count: names.length };
}
async function lockStore(path) {
  const info = await rootInfo(path), lockPath = join(info.root, 'writer.lock'), bytes = stable({ version: 'offline-review-writer/1', token: randomUUID(), pid: process.pid }) + '\n';
  await writeNew(lockPath, bytes);
  return { info, release: async () => { await rootStill(info); check((await readLocalFile(lockPath)).bytes.equals(Buffer.from(bytes)), 'review_lock_changed'); await unlink(lockPath); } };
}
async function append(state, kind, data, beforeCommit) {
  check(state.count < 2000, 'review_receipt_capacity_reached');
  const now = await loadStore(state.info.root); check(now.head === state.head, 'review_cas_mismatch'); await rootStill(state.info);
  await beforeCommit();
  const body = { version: 'offline-accountant-review-receipt/1', sequence: state.count + 1, previousHead: state.head, metadataDigest: hash(state.metaBytes), kind, data };
  const receipt = { ...body, digest: hash(stable(body)) };
  const bytes = stable(receipt) + '\n'; check(Buffer.byteLength(bytes) <= 2 * 1024 * 1024, 'review_receipt_limit_or_partial');
  await writeNew(join(state.info.root, 'receipts', `${String(receipt.sequence).padStart(8, '0')}.json`), bytes);
  return receipt.digest;
}
async function freshVersion(version) {
  let session;
  try {
    check(codeDigest() === loadedCodeDigest, 'review_code_restart_required');
    session = await openVatInputFiles(version.inputPath);
    const bundle = createAccountantReview(session.rawInput, session.source, session.snapshot);
    const inventory = await assertAccountantReviewCurrent(bundle, session);
    const current = same(bindingFor(bundle, inventory), version.binding) && same(bundle.scope, version.scope);
    return { current, reason: current ? 'actual_input_rules_and_ledger_match' : 'input_rules_or_ledger_changed', bundle };
  } catch { return { current: false, reason: 'fresh_read_or_recalculation_failed' }; }
  finally { session?.close(); }
}
function view(state, fresh, writerBlocked = false) {
  const current = state.versions.at(-1), last = state.feedbacks.filter(f => f.versionId === current?.versionId).at(-1);
  const effective = !!current && fresh.current && !writerBlocked && last?.action === 'confirm_selected_fields';
  const reviewState = writerBlocked ? 'blocked' : !current ? 'no_version' : !fresh.current ? 'stale' : !last ? current.supersedes ? 'changed_pending_review' : 'pending_review' : ({ request_materials: 'materials_requested', reject: 'rejected', confirm_selected_fields: 'selected_fields_confirmed' })[last.action];
  return { version: REVIEW_STORE_VERSION, status: writerBlocked ? 'blocked' : !current ? 'empty' : !fresh.current ? 'stale' : fresh.bundle.computation.calculationReady ? 'current' : fresh.bundle.computation.status,
    scope: structuredClone(state.meta.scope), journalHead: state.head, writerBlocked, reviewState,
    current: current ? { ...structuredClone(current), freshness: fresh.current ? 'current' : 'stale', freshnessReason: fresh.reason, calculationReady: !!fresh.current && fresh.bundle.computation.calculationReady, effectiveConfirmation: effective, confirmedFields: effective ? structuredClone(last.selectedFields) : [] } : null,
    history: state.versions.map(v => ({ ...structuredClone(v), state: v.versionId === current?.versionId ? fresh.current ? 'current' : 'stale' : 'superseded', effectiveConfirmation: v.versionId === current?.versionId && effective })),
    feedbacks: state.feedbacks.map(f => ({ payload: structuredClone(f), status: effective && f === last ? 'recorded_effective' : fresh.current && !writerBlocked && f === last ? 'recorded_current' : 'recorded_stale/history', effectiveConfirmation: effective && f === last })), ...flags };
}
export async function inspectReviewStore(path) {
  const state = await loadStore(path), current = state.versions.at(-1), fresh = current ? await freshVersion(current) : { current: false };
  const after = await loadStore(path); check(after.head === state.head, 'review_query_changed_retry');
  return view(state, fresh, await exists(join(state.info.root, 'writer.lock')));
}
export async function registerReview(path, inputPath, options) {
  options = structuredClone(options);
  fields(options, ['expectedJournalHead', 'supersedes']);
  const lock = await lockStore(path); let session;
  try {
    const state = await loadStore(path), current = state.versions.at(-1); check(state.info.identity === lock.info.identity, 'review_store_path_changed');
    check(options.expectedJournalHead === state.head && options.supersedes === (current?.versionId ?? null), 'review_cas_mismatch');
    check(codeDigest() === loadedCodeDigest, 'review_code_restart_required');
    const actualPath = await checkedPath(resolve(inputPath)); check(!inside(state.info.root, actualPath), 'review_input_inside_store');
    session = await openVatInputFiles(actualPath); const bundle = createAccountantReview(session.rawInput, session.source, session.snapshot);
    check(same(bundle.scope, state.meta.scope), 'review_scope_mismatch'); const inventory = await assertAccountantReviewCurrent(bundle, session);
    if (current && actualPath === current.inputPath && same(bindingFor(bundle, inventory), current.binding)) return { operation: 'replayed', ...(view(state, { current: true, bundle, reason: 'actual_input_rules_and_ledger_match' })) };
    check(state.count < 2000, 'review_receipt_capacity_reached');
    const versionId = 'review-' + randomUUID(), artifact = join(state.info.root, 'artifacts', versionId);
    await exportAccountantReview(bundle, artifact, { inputSession: session });
    const artifactFiles = [];
    for (const name of ['bundle.json', 'manifest.json', 'workpaper.xlsx']) { const size = (await lstat(join(artifact, name))).size; check(size > 0 && size <= LIMIT, 'review_artifact_limit'); const f = await readLocalFile(join(artifact, name), size); artifactFiles.push({ name, bytes: f.bytes.length, sha256: hash(f.bytes) }); }
    const data = { versionId, scope: structuredClone(bundle.scope), inputPath: actualPath, binding: bindingFor(bundle, inventory), supersedes: current?.versionId ?? null, artifactFiles, fieldDifferences: differences(current ? state.bundles.get(current.versionId) : null, bundle) };
    await verifyArtifact(state.info.root, data); await assertAccountantReviewCurrent(bundle, session); check(codeDigest() === loadedCodeDigest, 'review_code_restart_required');
    await append(state, 'register', data, async () => { await assertAccountantReviewCurrent(bundle, session); check(codeDigest() === loadedCodeDigest, 'review_code_restart_required'); });
    const committed = await loadStore(path);
    return { operation: 'registered', ...view(committed, await freshVersion(committed.versions.at(-1))) };
  } finally { session?.close(); await lock.release(); }
}
export async function recordReviewFeedback(path, payload) {
  payload = structuredClone(payload);
  validateFeedback(payload); const lock = await lockStore(path);
  try {
    const state = await loadStore(path), existing = state.feedbacks.find(f => f.feedbackId === payload.feedbackId), current = state.versions.at(-1); check(state.info.identity === lock.info.identity, 'review_store_path_changed');
    if (!existing) check(state.count < 2000, 'review_receipt_capacity_reached');
    const fresh = current ? await freshVersion(current) : { current: false };
    if (existing) {
      check(same(existing, payload), 'feedback_id_conflict');
      const result = view(state, fresh), feedbackStatus = result.feedbacks.find(f => f.payload.feedbackId === payload.feedbackId).status;
      return { operation: 'replayed', feedbackStatus, feedbackEffectiveConfirmation: feedbackStatus === 'recorded_effective', ...result };
    }
    assertFeedbackTarget(payload, current, state.meta.scope); check(payload.expectedJournalHead === state.head, 'review_cas_mismatch'); check(fresh.current, 'review_version_stale');
    if (payload.action === 'confirm_selected_fields') assertSelectedConfirmation(payload, fresh.bundle);
    // 提交前立即创建新的私有会话，持久化 ready 标志不能作为权威依据。
    const final = await freshVersion(current); check(final.current, 'review_version_stale');
    if (payload.action === 'confirm_selected_fields') assertSelectedConfirmation(payload, final.bundle);
    await append(state, 'feedback', structuredClone(payload), async () => { const latest = await freshVersion(current); check(latest.current, 'review_version_stale'); if (payload.action === 'confirm_selected_fields') assertSelectedConfirmation(payload, latest.bundle); });
    const committed = await loadStore(path), result = view(committed, await freshVersion(committed.versions.at(-1)));
    return { operation: 'recorded', feedbackStatus: result.feedbacks.at(-1).status, feedbackEffectiveConfirmation: result.feedbacks.at(-1).effectiveConfirmation, ...result };
  } finally { await lock.release(); }
}
