// 私有配对能力保留在全新 worker 内；公开 JSON 仅供展示。
import { mkdir, open, unlink, lstat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join, dirname } from 'node:path';
import { checkedPath, readLocalFile } from './offline-material-store.mjs';
import { assertVatInputPairCurrent } from './offline-vat-input.mjs';
import { calculateOfflineVatQ2 } from './tax-calculation.mjs';
import { assessAccountingReadiness } from './offline-accounting-readiness.mjs';
import { hash, stable, requireValue } from './offline-material-adapters.mjs';
import { renderAccountantReviewDiagnosticWorkbook } from './accountant-review-export.mjs';
import { assertAccountantReviewQ2CodeCurrent } from './accountant-review-q2-code.mjs';
const capabilities = new WeakMap();
const freeze = v => { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); } return v; };
function materials(raw) {
  const { taxFacts, previousComputation, ...input } = raw, a = assessAccountingReadiness(input);
  return { rows: a.assessment.rows, records: a.assessment.records, sources: a.assessment.sources.map(({rawContent, ...s}) => s), replayIssues: a.replayIssues, declaration: raw.declaration,
    accountingFacts: { fileSha256: raw.accountingFacts.fileSha256, document: JSON.parse(raw.accountingFacts.text.replace(/^\uFEFF/, '')) }, taxFacts: { fileSha256: taxFacts.fileSha256, document: JSON.parse(taxFacts.text.replace(/^\uFEFF/, '')) } };
}
export async function createAccountantReviewQ2(pair) {
  const codeBinding = assertAccountantReviewQ2CodeCurrent(), before = await assertVatInputPairCurrent(pair), product = await calculateOfflineVatQ2(pair), after = await assertVatInputPairCurrent(pair);
  requireValue(stable(before) === stable(after), 'review_q2_context_stale');
  const periodEvidence = { prior: { scope: pair.prior.rawInput.scope, materials: materials(pair.prior.rawInput), ledgerSnapshot: pair.snapshots.prior }, target: { scope: pair.target.rawInput.scope, materials: materials(pair.target.rawInput), ledgerSnapshot: pair.snapshots.target } };
  const bundle = structuredClone({ version: 'offline-accountant-review-q2/1', kind: 'q2_accountant_review_draft', scope: product.computation.scope, status: product.computation.calculationReady ? 'selected_fields_draft' : product.computation.status,
    accountantApproval: 'pending', confirmationStatus: 'pending', periodComplete: false, submittable: false, authorizesExecution: false, sourceAuthenticity: 'unverified', onlineCompatibility: 'unverified', taxOfficeLoggedIn: false, submitted: false,
    freshness: 'fresh_native_worker_actual_pair_recomputed_and_rechecked', reviewScopeDescription: '2026Q1实际重算及2026Q2普通境内服务季度小规模选定服务列1/2/3/15/16/20/21/22；其余未算；21/22累计NA；累计映射待会计审定',
    ...product, codeBinding, periodEvidence, materials: periodEvidence.target.materials, ledgerSnapshot: periodEvidence.target.ledgerSnapshot,
    historyBridgeResolution: { originalMaterialQualityStatusesPreserved: true, priorAccountingExplained: product.computation.historyBridge.priorAccountingExplained, customerPreparedPriorLedgerOrTaxRequired: false, meaning: '实际提供的Q1已由本worker重算并逐笔对现库解释时，不再向客户索取预制前期账或税额；失败按实际原件/账务/工程异常分别核对。' },
    exceptions: [...product.priorComputation.issues.map(i => ({...i, field: 'prior.' + i.field})), ...product.computation.issues],
    pending: [{code:'accountant_review_pending',state:'pending',request:'核对本worker重读的双期原始资料、真实凭证分录、历史桥及规则；原材料有效不代表会计确认。'}, {code:'q2_year_to_date_mapping_pending',state:'pending',request:'累计映射为工程推断，待会计逐项审定。'}, {code:'q2_feedback_version_chain_pending_05D',state:'pending',request:'Q2反馈、更正及再确认版本链待OFFLINE-05D；正式连续更正仍依赖#80/#51。'}, ...product.computation.issues.map(i=>({code:i.code,state:'pending',field:i.field,classification:i.classification,request:i.requestedFact}))],
    limitations: [...product.computation.limitations, 'q2_feedback_version_chain_pending_05D', 'installed_third_party_packages_and_runtime_are_explicit_trust_boundary', 'unobserved_ABA_changes_not_detected', 'json_is_diagnostic_not_a_capability'] });
  bundle.contentDigest = hash(stable(bundle)); freeze(bundle);
  capabilities.set(bundle, { pair, codeBinding, rawDigest: hash(stable([pair.prior.rawInput,pair.target.rawInput])), productDigest: hash(stable(product)), snapshotDigest: hash(stable(pair.snapshots)), bundleDigest: hash(stable(bundle)) });
  await assertAccountantReviewQ2Current(bundle, pair); return bundle;
}
export async function assertAccountantReviewQ2Current(bundle, pair) {
  const cap = capabilities.get(bundle); requireValue(cap && cap.pair === pair, 'review_q2_bundle_untrusted');
  assertAccountantReviewQ2CodeCurrent(cap.codeBinding);
  const before = await assertVatInputPairCurrent(pair);
  requireValue(hash(stable([pair.prior.rawInput,pair.target.rawInput])) === cap.rawDigest && hash(stable(pair.snapshots)) === cap.snapshotDigest && hash(stable(bundle)) === cap.bundleDigest, 'review_q2_context_stale');
  const product = await calculateOfflineVatQ2(pair), after = await assertVatInputPairCurrent(pair);
  requireValue(hash(stable(product)) === cap.productDigest && stable(before) === stable(after), 'review_q2_context_stale');
  assertAccountantReviewQ2CodeCurrent(cap.codeBinding); return after.inputFiles;
}
const publications = new WeakMap();
const identity = s => ({ dev:s.dev, ino:s.ino, birthtimeMs:s.birthtimeMs });
const sameIdentity = (a,b) => a.dev===b.dev && a.ino===b.ino && a.birthtimeMs===b.birthtimeMs;
const publicationFailure = () => Object.assign(new Error('review_q2_publication_failed'), {code:'review_q2_publication_failed'});
async function writeExclusive(path, bytes) {
  const h = await open(path, 'wx', 0o600);
  try { const ownedIdentity=identity(await h.stat()); await h.writeFile(bytes); await h.sync(); return ownedIdentity; }
  catch { throw publicationFailure(); }
  finally { await h.close(); }
}
const validOutputStat = (s,expected,before=s) => s.isFile() && s.nlink===1 && s.size===expected.bytes && sameIdentity(s,expected.identity) && s.mtimeMs===before.mtimeMs && s.ctimeMs===before.ctimeMs;
async function verifyOutput(directory, expected) {
  try {
    const path=join(directory,expected.name), before=await lstat(path);
    requireValue(validOutputStat(before,expected), 'review_q2_publication_failed');
    const file=await readLocalFile(path,expected.bytes), after=await lstat(path);
    requireValue(validOutputStat(after,expected,before) && file.bytes.length===expected.bytes && hash(file.bytes)===expected.sha256, 'review_q2_publication_failed');
    return file.bytes;
  } catch { throw publicationFailure(); }
}
async function removeOwnMarker(directory, expected, publicationId) {
  if(!expected?.identity) return;
  try { const bytes=await verifyOutput(directory,expected); if(JSON.parse(bytes).publicationId===publicationId) await unlink(join(directory,expected.name)); }
  catch { /* 变化、未知或外来标记属于诊断残留，绝不删除。 */ }
}
// 不能从 manifest JSON、哈希或输出证明 DTO 恢复该私有身份。
export async function assertAccountantReviewQ2PublicationCurrent(manifest, bundle, pair) {
  const state=publications.get(manifest);
  requireValue(state && state.bundle===bundle && state.pair===pair, 'review_q2_publication_untrusted');
  await assertAccountantReviewQ2Current(bundle,pair);
  for(const file of state.expected) await verifyOutput(state.directory,file);
  return structuredClone(state.expected);
}
export async function invalidateAccountantReviewQ2Publication(manifest, bundle, pair) {
  const state=publications.get(manifest);
  requireValue(state && state.bundle===bundle && state.pair===pair, 'review_q2_publication_untrusted');
  await removeOwnMarker(state.directory,state.expected.find(f=>f.name==='manifest.json'),manifest.publicationId);
}
export async function exportAccountantReviewQ2(bundle, outputDirectory, pair, publicationId = randomUUID()) {
  requireValue(typeof outputDirectory === 'string' && isAbsolute(outputDirectory), 'review_q2_output_invalid');
  const inventory = await assertAccountantReviewQ2Current(bundle, pair);
  const localFiles = Object.entries(inventory).flatMap(([period, files])=>files.map((f,i)=>({...f,period,manifestPointer:`/inputFiles/${period}/${i}`})));
  const workbook = await renderAccountantReviewDiagnosticWorkbook(bundle, localFiles);
  await assertAccountantReviewQ2Current(bundle, pair);
  await checkedPath(dirname(outputDirectory), true);
  await mkdir(outputDirectory, {mode:0o700});
  const files = [{name:'bundle.json',bytes:Buffer.from(JSON.stringify(bundle,null,2)+'\n')},{name:'workpaper.xlsx',bytes:workbook.bytes}];
  const expected=[];
  for(const f of files) expected.push({name:f.name,bytes:f.bytes.length,sha256:hash(f.bytes),identity:await writeExclusive(join(outputDirectory,f.name),f.bytes)});
  const inputFiles = await assertAccountantReviewQ2Current(bundle, pair);
  for(const f of expected) await verifyOutput(outputDirectory,f);
  const manifest = {version:'offline-accountant-review-q2-manifest/1',publicationId,kind:'q2_accountant_review_draft',status:'complete_draft',accountantApproval:'pending',confirmationStatus:'pending',periodComplete:false,submittable:false,authorizesExecution:false,sourceAuthenticity:'unverified',taxOfficeLoggedIn:false,submitted:false,bundleDigest:bundle.contentDigest,codeBinding:bundle.codeBinding,inputFiles,files:files.map(f=>({name:f.name,bytes:f.bytes.length,sha256:hash(f.bytes)})),displayDiagnostics:workbook.diagnostics,meaning:'local_file_completeness_only_not_authentication_or_accountant_approval'};
  const bytes=Buffer.from(JSON.stringify(manifest,null,2)+'\n');
  const marker={name:'manifest.json',bytes:bytes.length,sha256:hash(bytes)};
  try {
    const h=await open(join(outputDirectory,marker.name),'wx',0o600);
    try { marker.identity=identity(await h.stat()); await h.writeFile(bytes); await h.sync(); } finally { await h.close(); }
    expected.push(marker);
    publications.set(manifest,{bundle,pair,directory:outputDirectory,expected});
    await assertAccountantReviewQ2PublicationCurrent(manifest,bundle,pair);
  } catch(e) { await removeOwnMarker(outputDirectory,marker,publicationId); throw /^E[A-Z]+$/.test(e?.code ?? '') ? publicationFailure() : e; }
  return manifest;
}
