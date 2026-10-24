// Fixed business entrypoints. Loading/calculation never opens a database.
import { resolve, dirname, basename, isAbsolute, relative } from 'node:path';
import { lstatSync, realpathSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { evaluateAgencyAccounting, replayAgencyFinancials, buildAgencyBookkeeping, AGENCY_ACCOUNTING_RULE_VERSION, AGENCY_INDUSTRIES } from './agency-business-rules.mjs';
import { calculateAgencyObligations, calculateAgencyAnnualAdjustments, AGENCY_TAX_RULE_VERSION, cents, money } from './agency-tax-rules.mjs';
import { loadAgencyEvidence, readAgencySession, assertAgencyEvidenceCurrent, captureAgencyCode, agencyTargetSnapshot, withAgencyEvidence, agencyEvidenceArchiveRecords, assertAgencyLoadedCode, bindAgencyArchive } from './agency-business-evidence.mjs';
import { archiveMaterialEvidence, readArchivedMaterialEvidence } from './offline-material-store.mjs';
import { inspectAuditSchema, queryOperation } from './local-audit-storage.mjs';
import { auditCanonicalDigest, auditResultDigest } from './local-audit.mjs';
import { getBatch, listBatchVouchers, getVoucherSource, voucherFingerprint, persistedVoucherFingerprint } from './import-storage.mjs';
import { hash, stable, requireValue } from './offline-material-adapters.mjs';
import { getAccountingRoles } from './accounting-profiles.mjs';

export const AGENCY_BUSINESS_VERSION = 'agency-business-workpaper/1';
export const AGENCY_RULE_VERSION = `${AGENCY_ACCOUNTING_RULE_VERSION}+${AGENCY_TAX_RULE_VERSION}`;
export const AGENCY_SOURCE_SYSTEM = 'agency-business-v1';
export const loadAgencyMaterials = loadAgencyEvidence;
const prepared = new WeakMap();
const copy = structuredClone;
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const businessRevision = voucher => hash(stable({ period: voucher.period, date: voucher.date, summary: voucher.summary, entries: voucher.entries })).slice(0, 40);
const identity = (scope, batchId, dbPath) => ({ dbPath, databaseInstanceId: scope.databaseInstanceId, accountSetId: scope.accountSetId, enterpriseKey: scope.enterpriseKey, period: scope.period, batchId, operationId: `agency-${batchId}` });

export function buildAgencyWorkpaper(session, { previous } = {}) {
  const document = readAgencySession(session), { accounting, tax, periodCalculations } = replayAgencyFinancials(document);
  const sourceRefs = copy(session.sourceRefs);
  const result = { version: AGENCY_BUSINESS_VERSION, scope: copy(document.scope), industry: document.entity.industry, profileId: document.entity.profileId, bookkeeping: buildAgencyBookkeeping(document,accounting), accounting, periodCalculations, obligations: tax.obligations, payroll: tax.payroll, taxWorkpaper: tax.taxableProfitWorkpaper,
    annualCalculations: { status: 'raw_year_replay_required', entrypoint: 'calculateAgencyAnnualAdjustments', required: 'twelve current raw material sessions, same enterprise/account/database/year' },
    sourceRefs, ruleVersion: AGENCY_RULE_VERSION, codeDigest: session.codeDigest, dependencyDigest: session.dependencyDigest,
    issues: [...accounting.issues, ...tax.issues], impact: [], coverageVerified: accounting.accountingCoverageVerified, taxYearCoverageVerified:accounting.yearCoverageVerified,
    confirmationStatus: 'pending', accountantApproval: 'pending', authorizesExecution: false, submittable: false, periodComplete: false };
  if (previous) {
    requireValue(previous.version === AGENCY_BUSINESS_VERSION && stable(previous.scope) === stable(result.scope), 'agency_previous_scope_mismatch');
    const before = new Map(previous.accounting.vouchers.map(v => [v.sourceVoucherId, businessRevision(v)]));
    result.impact = accounting.vouchers.filter(v => before.get(v.sourceVoucherId) !== businessRevision(v)).map(v => ({ factId: v.factId, sourceVoucherId: v.sourceVoucherId, state: before.has(v.sourceVoucherId) ? 'changed' : 'added', affected: ['ledger', 'inventory_cost', 'financial_reports', 'vat', 'income_tax', 'accountant_review'], fromPeriod: v.period }));
    for (const old of previous.accounting.vouchers) if (!accounting.vouchers.some(v => v.sourceVoucherId === old.sourceVoucherId)) result.impact.push({ factId: old.factId, sourceVoucherId: old.sourceVoucherId, state: 'withdrawn', affected: ['ledger', 'inventory_cost', 'financial_reports', 'vat', 'income_tax', 'accountant_review'], fromPeriod: old.period });
  }
  result.contentDigest = hash(stable(result)); return result;
}

export async function buildAgencyAnnualWorkpaper(materialSessions) {
  requireValue(Array.isArray(materialSessions) && materialSessions.length > 0 && materialSessions.length <= 12, 'agency_annual_sessions_invalid');
  const documents = materialSessions.map(readAgencySession), first = documents[0], year = first.scope.period.slice(0, 4), startMonth = Number(first.entity.businessStartDate.slice(0, 4)) < Number(year) ? 1 : Number(first.entity.businessStartDate.slice(5, 7));
  const expected = Array.from({ length: 13 - startMonth }, (_, i) => `${year}-${String(i + startMonth).padStart(2, '0')}`);
  requireValue(documents.length === expected.length && expected.every(p => documents.filter(d => d.scope.period === p).length === 1), 'agency_annual_period_gap');
  requireValue(documents.every(d => ['enterpriseKey', 'accountSetId', 'databaseInstanceId', 'currency'].every(k => d.scope[k] === first.scope[k]) && d.scope.period.startsWith(year) && stable(d.entity) === stable(first.entity)), 'agency_annual_scope_conflict');
  const byId = new Map();
  for (const document of documents) for (const record of document.records) { const old = byId.get(record.id); requireValue(!old || stable(old) === stable(record), 'agency_annual_fact_version_conflict'); byId.set(record.id, record); }
  const document = { scope: { ...first.scope, period: `${year}-12` }, entity: first.entity, records: [...byId.values()] };
  const result = await calculateAgencyAnnualAdjustments({ document });
  materialSessions.forEach(assertAgencyEvidenceCurrent);
  result.entrypoint = 'buildAgencyAnnualWorkpaper'; result.ruleVersion = AGENCY_RULE_VERSION; result.dependencies = materialSessions.map(s => ({ period: s.scope.period, dependencyDigest: s.dependencyDigest, codeDigest: s.codeDigest, sourceRefs: s.sourceRefs }));
  result.dependencyDigest = hash(stable(result.dependencies)); result.contentDigest = hash(stable(result)); return result;
}

export function getAgencyCapabilities() {
  const code = assertAgencyLoadedCode();
  const common = { version: 'finance-capability/1', availability: 'limited', necessaryFacts: [{ factId: 'agency.raw_materials', description: '同企业/账套/数据库及期间绑定的原始业务事实、原文路径/摘要/指针' }], supportConditions: ['2026-2027 CNY local single-user multiple enterprises', `行业:${AGENCY_INDUSTRIES.join(',')}`, '客户提供原始订单/合同/交付/资金/工资等材料；程序派生金额', '地区政策未核实阻断对应义务，不将未知当零', '完整能力和未完成项以每份workpaper.issues为准'], ruleVersion: AGENCY_RULE_VERSION, codeDigest: code.digest, resultSchema: { version: AGENCY_BUSINESS_VERSION, accountantApproval: 'pending', periodComplete: false, submittable: false }, traceReferences: code.files.map(f => ({ kind: 'code', locator: f.path, digest: f.sha256 })) };
  return [
    { ...common, capabilityId: 'agency.workpaper', description: '重放原始业务事实生成会计成本/税费底稿及缺项', entrypoint: 'buildAgencyWorkpaper', effect: 'read' },
    { ...common, capabilityId: 'agency.posting', description: '人审绑定当前证据后经增量导入/审计正式入账；更正保留红冲历史', entrypoint: 'executeAgencyPosting', effect: 'write', recovery: { queryEntrypoint: 'queryAgencyPosting', identityFields: ['dbPath', 'databaseInstanceId', 'accountSetId', 'enterpriseKey', 'period', 'batchId', 'operationId', 'archivePath', 'archiveId'] } },
    { ...common, capabilityId: 'agency.annual-calculation', description: '全年原始资料重放的年度税会调整计算，年度流程由年度窗口编排', entrypoint: 'buildAgencyAnnualWorkpaper', effect: 'read' },
  ];
}

function checkedDatabasePath(path) {
  requireValue(typeof path === 'string' && isAbsolute(path) && resolve(path) === path && basename(path) === 'workbench.db', 'agency_db_path_invalid');
  for (let p = path;; p = dirname(p)) { const s = lstatSync(p); requireValue(!s.isSymbolicLink() && realpathSync.native(p).toLowerCase() === p.toLowerCase(), 'agency_db_alias'); if (dirname(p) === p) break; }
  const s = lstatSync(path); requireValue(s.isFile() && s.nlink === 1 && s.size >= 4096, 'agency_db_file_invalid'); return path;
}
async function application(dbPath) {
  checkedDatabasePath(dbPath);
  // Never silently attach to the repository's default data directory.
  requireValue(typeof process.env.WORKBENCH_DATA_DIR === 'string' && resolve(process.env.WORKBENCH_DATA_DIR, 'workbench.db').toLowerCase() === dbPath.toLowerCase(), 'agency_explicit_database_context_required');
  const { db } = await import('./db.mjs'); const I = await import('./import-incremental.mjs'); const C = await import('./local-audit-coordinator.mjs'); const S = await import('./local-audit-storage.mjs'); const A = await import('./accounting.mjs');
  requireValue(resolve(S.readAuditDatabasePath(db)).toLowerCase() === dbPath.toLowerCase(), 'agency_database_context_mismatch'); return { db, I, C, S, A };
}
function verifyExisting(app, scope) {
  const rows = app.db.prepare('SELECT * FROM import_voucher_sources WHERE source_system=? AND enterprise_key=? AND account_set_id=? ORDER BY voucher_id').all(AGENCY_SOURCE_SYSTEM, scope.enterpriseKey, scope.accountSetId);
  const batches = new Set(rows.map(r => r.batch_id));
  for (const batchId of batches) requireValue(app.I.verifyImportBatchSources(batchId, { accountSetId: scope.accountSetId, enterpriseKey: scope.enterpriseKey, sourceSystem: AGENCY_SOURCE_SYSTEM }).ok, 'agency_existing_posting_changed');
  return rows;
}
function reconcileLedger(app, document, workpaper, input) {
  const scope = document.scope, from = workpaper.accounting.replayFrom, roles = getAccountingRoles(workpaper.profileId);
  const actual = app.db.prepare("SELECT * FROM vouchers WHERE account_set_id=? AND status='posted' ORDER BY id").all(scope.accountSetId);
  const lines = id => app.db.prepare('SELECT * FROM voucher_entries WHERE voucher_id=? ORDER BY line_no').all(id);
  const actualSources = app.db.prepare('SELECT * FROM import_voucher_sources WHERE account_set_id=?').all(scope.accountSetId);
  const balances = new Map(); const put = (code, amount) => balances.set(code, (balances.get(code) ?? 0n) + amount);
  for (const row of app.db.prepare('SELECT * FROM opening_balances WHERE account_set_id=?').all(scope.accountSetId)) put(row.code, cents(row.debit)-cents(row.credit));
  for (const voucher of actual.filter(v => v.period < from)) for (const row of lines(voucher.id)) put(row.code, cents(row.debit)-cents(row.credit));
  const openings = evaluateAgencyAccounting({ ...document, records: document.records.filter(r => ['opening_balance','opening_inventory'].includes(r.type)) });
  requireValue(openings.issues.length === 0, 'agency_opening_material_incomplete');
  const expected = new Map(openings.reportDraftInputs.amounts.map(a => [a.code, BigInt(a.netMinor)]));
  requireValue([...new Set([...balances.keys(), ...expected.keys()])].every(code => (balances.get(code)??0n) === (expected.get(code)??0n)), 'agency_opening_ledger_reconciliation_required');
  const prior = actual.filter(v => v.period < from);
  if (prior.length) requireValue(input?.openingCarry?.reviewer && input.openingCarry.reason && input.openingCarry.throughPeriod < from && prior.every(v=>input.openingCarry.throughPeriod>=v.period), 'agency_prior_ledger_checkpoint_review_required');
  const wanted = [...workpaper.accounting.historicalVouchers, ...workpaper.accounting.vouchers], reused = new Set(), proof = [], usedMatches = new Set();
  const normalized = rows => stable(rows.map(r=>({code:r.code,debit:money(cents(r.debit)),credit:money(cents(r.credit))})).sort((a,b)=>stable(a).localeCompare(stable(b))));
  const plCodes = new Set(workpaper.accounting.reportDraftInputs.accounts.filter(a=>a.category==='损益').map(a=>a.code));
  const group = rows => { const m=new Map();for(const r of rows)m.set(r.code,(m.get(r.code)??0n)+cents(r.debit)-cents(r.credit));return m; };
  for (const voucher of actual) {
    const entries = lines(voucher.id), source = actualSources.find(s=>s.voucher_id===voucher.id), fingerprint = persistedVoucherFingerprint(voucher,entries);
    if (voucher.period < from) { proof.push({voucherId:voucher.id,period:voucher.period,fingerprint,kind:'verified_opening_checkpoint',source:source??null});continue; }
    if (source?.source_system === AGENCY_SOURCE_SYSTEM) {proof.push({voucherId:voucher.id,period:voucher.period,fingerprint,kind:'verified_agency_source'});continue;}
    let verifiedCarry = false;
    if (voucher.kind === 'carryforward' && voucher.period < scope.period) {
      const aggregated = group(entries);
      if (voucher.summary === '结转本期损益') {
        const original = group(actual.filter(v=>v.period===voucher.period&&v.kind!=='carryforward').flatMap(v=>lines(v.id)));
        let profit = 0n; const expectedCarry = new Map();for(const [code,amount] of original)if(plCodes.has(code)&&amount){expectedCarry.set(code,-amount);profit-=amount;}if(profit)expectedCarry.set(roles.currentYearProfit,-profit);
        verifiedCarry = expectedCarry.size===aggregated.size&&[...expectedCarry].every(([code,amount])=>aggregated.get(code)===amount);
      } else if(voucher.summary==='结转本年利润') {
        const preceding = actual.filter(v=>v.period<=voucher.period&&v.id!==voucher.id&&!(v.kind==='carryforward'&&v.summary==='结转本年利润'&&v.period===voucher.period));
        const profits = group(preceding.flatMap(v=>lines(v.id))); const net=profits.get(roles.currentYearProfit)??0n;
        verifiedCarry = aggregated.size===2&&aggregated.get(roles.currentYearProfit)===-net&&aggregated.get(roles.profitDistribution)===net;
      }
    }
    if(verifiedCarry){proof.push({voucherId:voucher.id,period:voucher.period,fingerprint,kind:'verified_core_profit_carry'});continue;}
    const match = input?.matches?.find(m=>m.existingVoucherId===voucher.id);
    requireValue(match&&input.reviewer&&input.reason&&match.reason&&!usedMatches.has(match.agencySourceVoucherId), 'agency_existing_voucher_reconciliation_required');
    const desired = wanted.find(v=>v.sourceVoucherId===match.agencySourceVoucherId), raw = desired&&document.records.find(r=>r.id===desired.factId);
    requireValue(desired&&raw?.businessIdentity&&stable(match.originalBusinessIdentity)===stable(raw.businessIdentity)&&voucher.period===desired.period&&voucher.voucher_date===desired.date&&normalized(entries)===normalized(desired.entries), 'agency_existing_voucher_business_mismatch');
    if(source){
      requireValue(match.existingSourceSystem===source.source_system&&match.existingSourceVoucherId===source.source_voucher_id&&source.source_voucher_id===raw.businessIdentity.documentNumber, 'agency_existing_source_identity_unproven');
      requireValue(app.I.verifyImportBatchSources(source.batch_id,{accountSetId:scope.accountSetId,enterpriseKey:scope.enterpriseKey,sourceSystem:source.source_system}).ok,'agency_existing_source_changed');
    }else requireValue(voucher.summary.includes(raw.businessIdentity.documentNumber)&&voucher.summary.includes(raw.businessIdentity.issuerKey),'agency_manual_original_identity_unproven');
    reused.add(desired.sourceVoucherId);usedMatches.add(desired.sourceVoucherId);proof.push({voucherId:voucher.id,period:voucher.period,fingerprint,kind:'human_matched_original_business',agencySourceVoucherId:desired.sourceVoucherId,originalBusinessIdentity:raw.businessIdentity,source:source??null,reason:match.reason,sourceRefs:raw.sourceRefs});
  }
  requireValue(!input?.matches||input.matches.length===usedMatches.size,'agency_reconciliation_unused_match');
  return { reused, proof, opening: [...expected].map(([code,amount])=>({code,net:money(amount)})), review: input??null };
}
function postingPlan(app, scope, workpaper, correction, reconciliation) {
  const existing = verifyExisting(app, scope), result = [], impacts = [];
  const active = new Map(), ordinals = new Map();
  for (const row of existing) {
    const m = /^A:([a-f0-9]{64}):(\d+):([a-f0-9]{40})$/.exec(row.source_voucher_id); if (!m) continue;
    const key = m[1], ordinal = Number(m[2]); ordinals.set(key, Math.max(ordinals.get(key) ?? 0, ordinal));
    if (existing.some(r => r.source_voucher_id === `R:${key}:${ordinal}`)) continue;
    requireValue(!active.has(key), 'agency_multiple_active_versions'); active.set(key, { row, ordinal, revision: m[3] });
  }
  const current = [...workpaper.accounting.historicalVouchers, ...workpaper.accounting.vouchers], wanted = new Set();
  const makeReverse = (key, old) => {
    requireValue(correction && typeof correction.reason === 'string' && correction.reason.trim().length > 0 && correction.previousSourceIds.includes(old.row.source_voucher_id), 'agency_explicit_correction_evidence_required');
    const voucher = app.db.prepare('SELECT * FROM vouchers WHERE id=?').get(old.row.voucher_id), entries = app.db.prepare('SELECT code,summary,debit,credit FROM voucher_entries WHERE voucher_id=? ORDER BY line_no').all(voucher.id);
    requireValue(voucher.account_set_id === scope.accountSetId && voucher.status === 'posted', 'agency_correction_original_invalid');
    if (voucher.period.slice(0, 4) < scope.period.slice(0, 4) && workpaper.profileId === 'enterprise-2019-general-basic-v1') requireValue(correction.priorYearAssessment?.material === false && correction.priorYearAssessment?.method === 'current_period_nonmaterial' && correction.priorYearAssessment?.reviewer && correction.priorYearAssessment?.reason, 'agency_prior_year_cas_materiality_and_restatement_required');
    result.push({ sourceVoucherId: `R:${key}:${old.ordinal}`, period: scope.period, date: `${scope.period}-01`, word: '记', summary: `更正红冲原凭证${voucher.id}`, entries: entries.map(e => ({ code: e.code, summary: e.summary, debit: money(cents(e.credit)), credit: money(cents(e.debit)) })) });
    impacts.push({ sourceVoucherId: old.row.source_voucher_id, originalVoucherId: voucher.id, originalPeriod: voucher.period, correctionPeriod: scope.period, affected: ['ledger', 'inventory', 'financial_reports', 'prior_tax_drafts', 'annual_calculations', 'accountant_review'], historicalTaxCorrection: 'accountant_confirmation_required' });
  };
  for (const v of current) {
    const key = v.sourceVoucherId.slice('agency:'.length), revision = businessRevision(v), old = active.get(key); wanted.add(key);
    if(reconciliation.reused.has(v.sourceVoucherId))continue;
    if (old?.revision === revision) continue;
    if (old) makeReverse(key, old);
    const ordinal = (ordinals.get(key) ?? 0) + 1;
    const corrected = old ? { period: scope.period, date: `${scope.period}-01` } : { period: v.period, date: v.date };
    result.push({ sourceVoucherId: `A:${key}:${ordinal}:${revision}`, ...corrected, word: '记', summary: v.summary, entries: v.entries.map(e => ({ ...e, summary: e.summary ?? v.summary })) });
  }
  for(const [key,old]of active)if(!wanted.has(key)&&!correction?.withdrawnSourceIds?.includes(old.row.source_voucher_id)){
    const period=app.db.prepare('SELECT period FROM vouchers WHERE id=?').get(old.row.voucher_id).period;
    requireValue(period<workpaper.accounting.replayFrom&&reconciliation.proof.some(p=>p.voucherId===old.row.voucher_id&&p.kind==='verified_opening_checkpoint'),'agency_owned_source_not_replayed');
  }
  // Withdrawal requires a complete source inventory, never absence caused by missing materials.
  if (correction?.withdrawnSourceIds?.length) for (const [key, old] of active) if (correction.withdrawnSourceIds.includes(old.row.source_voucher_id)) {
    requireValue(!wanted.has(key) && workpaper.coverageVerified, 'agency_withdrawal_coverage_or_fact_conflict');
    const original = app.db.prepare('SELECT period FROM vouchers WHERE id=?').get(old.row.voucher_id); requireValue(original.period === scope.period, 'agency_withdrawal_original_period_not_covered');
    makeReverse(key, old);
  }
  return { vouchers: result, impact: impacts };
}

export async function prepareAgencyPosting(session, { batchId, dbPath, evidenceDir, correction, ledgerReconciliation } = {}) {
  requireValue(typeof batchId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(batchId), 'agency_batch_id_invalid');
  const workpaper = buildAgencyWorkpaper(session), app = await application(dbPath); assertAgencyEvidenceCurrent(session);
  requireValue(workpaper.accounting.issues.length === 0, 'agency_accounting_incomplete');
  const targetDigest = agencyTargetSnapshot(app.db, session.scope), set = app.db.prepare('SELECT * FROM account_sets WHERE id=?').get(session.scope.accountSetId);
  requireValue(set.accounting_profile_id === workpaper.profileId, 'agency_target_profile_mismatch');
  if (correction) {
    requireValue(typeof correction.reason === 'string' && correction.reason.trim().length > 0 && Array.isArray(correction.previousEvidence) && correction.previousEvidence.length > 0 && Array.isArray(correction.previousSourceIds), 'agency_correction_invalid');
    const covered = new Set();
    for (const old of correction.previousEvidence) { const saved = await readArchivedMaterialEvidence(old.archivePath, old.archiveId), meta = saved.manifest.metadata; requireValue(meta.kind === 'agency_preparation' && ['enterpriseKey', 'accountSetId', 'databaseInstanceId'].every(k => meta.identity[k] === session.scope[k]), 'agency_correction_previous_scope_mismatch'); meta.options.payload.vouchers.forEach(v => covered.add(v.sourceVoucherId)); bindAgencyArchive(session, { path: old.archivePath, archiveId: old.archiveId }); }
    requireValue(correction.previousSourceIds.every(id => covered.has(id)), 'agency_correction_previous_source_missing');
  }
  const reconciliation = reconcileLedger(app,readAgencySession(session),workpaper,ledgerReconciliation);
  const plan = postingPlan(app, session.scope, workpaper, correction,reconciliation);
  const actualAccounts = app.db.prepare('SELECT code,category,direction,is_leaf FROM accounts WHERE account_set_id=?').all(session.scope.accountSetId), usedCodes = [...new Set(plan.vouchers.flatMap(v => v.entries.map(e => e.code)))];
  const additions = [];
  for (const code of usedCodes) {
    const expected = workpaper.accounting.reportDraftInputs.accounts.find(a => a.code === code), actual = actualAccounts.find(a => a.code === code); requireValue(expected, 'agency_account_semantics_unverified');
    if (actual) requireValue(actual.category === expected.category && actual.direction === expected.direction && actual.is_leaf === 1, 'agency_target_account_semantics_mismatch');
    else additions.push({ code, name: expected.name, category: expected.category, direction: expected.direction, ...(expected.contra ? { contra: true } : {}) });
  }
  const payload = { account_set: { name: set.name, start_period: set.start_period, profileId: workpaper.profileId }, ...(additions.length ? { accounts: additions } : {}), vouchers: plan.vouchers };
  const options = { mode: 'append', accountSetId: session.scope.accountSetId, batchId, source: { system: AGENCY_SOURCE_SYSTEM, enterpriseKey: session.scope.enterpriseKey }, confirmNewBinding: true, payload };
  const preview = plan.vouchers.length ? app.I.importIncremental({ ...options, dryRun: true }) : { ok: true, status: 'no_change' };
  if (!preview.ok) throw Object.assign(new Error('agency_import_preview_rejected'), { code: 'agency_import_preview_rejected', validation: preview });
  requireValue(typeof evidenceDir === 'string' && isAbsolute(evidenceDir), 'agency_evidence_directory_required'); const archiveRoot = resolve(evidenceDir);
  const overlaps = (a, b) => { const within = (x, y) => { const r = relative(x.toLowerCase(), y.toLowerCase()); return r === '' || !r.startsWith('..') && !isAbsolute(r); }; return within(a, b) || within(b, a); };
  requireValue(!overlaps(archiveRoot, dirname(dbPath)) && !session.sourceRefs.some(ref => overlaps(archiveRoot, dirname(ref.locator))), 'agency_evidence_directory_overlap');
  const reconciliationProof={proof:reconciliation.proof,opening:reconciliation.opening,review:reconciliation.review};
  const result = { version: 'agency-posting-prepare/1', identity: identity(session.scope, batchId, dbPath), dependencyDigest: session.dependencyDigest, codeDigest: session.codeDigest, targetDigest, targetVersion: workpaper.contentDigest, planDigest: hash(stable({options,reconciliationProof})), plannedVouchers: copy(plan.vouchers), reconciliation:reconciliationProof, impact: plan.impact, correction: correction ? copy(correction) : null, taxIssues: workpaper.issues.filter(i => !workpaper.accounting.issues.includes(i)), status: plan.vouchers.length ? 'prepared' : 'no_change', authorizesExecution: false, periodComplete: false, submittable: false };
  const archive = await archiveMaterialEvidence(archiveRoot, { scope: session.scope, records: [...agencyEvidenceArchiveRecords(session), { name: 'workpaper.json', bytes: Buffer.from(stable(workpaper)) }], metadata: { kind: 'agency_preparation', identity: result.identity, options, reconciliationProof, targetDigest, targetVersion: result.targetVersion, dependencyDigest: result.dependencyDigest, codeDigest: result.codeDigest, planDigest: result.planDigest, ruleVersion: AGENCY_RULE_VERSION, impact: result.impact, correction: correction ?? null } });
  result.archive = archive; result.identity = { ...result.identity, archivePath: archive.path, archiveId: archive.archiveId };
  bindAgencyArchive(session, archive);
  prepared.set(result, { session, options, reconciliationProof, targetDigest, workpaper, dbPath, archiveRoot }); return freeze(result);
}

export async function executeAgencyPosting(session, confirmation) {
  requireValue(confirmation && confirmation.decision === 'accept' && typeof confirmation.reviewer === 'string' && confirmation.reviewer.trim().length > 0, 'agency_accountant_confirmation_required');
  const proposal = confirmation.proposal, cap = prepared.get(proposal); requireValue(cap && cap.session === session && proposal.authorizesExecution === false, 'agency_preparation_untrusted');
  requireValue(confirmation.targetVersion === proposal.targetVersion && confirmation.dependencyDigest === proposal.dependencyDigest && confirmation.planDigest === proposal.planDigest, 'agency_confirmation_stale');
  const prior = await queryAgencyPosting(proposal.identity);
  if (prior.status !== 'not_started') return { ...prior, replayed: true };
  const app = await application(cap.dbPath); assertAgencyEvidenceCurrent(session);
  requireValue(buildAgencyWorkpaper(session).contentDigest === proposal.targetVersion && hash(stable({options:cap.options,reconciliationProof:cap.reconciliationProof})) === proposal.planDigest, 'agency_prepared_result_changed');
  if (proposal.status === 'no_change') { requireValue(agencyTargetSnapshot(app.db, session.scope) === proposal.targetDigest, 'agency_target_changed'); return { status: 'no_change', applied: false, periodComplete: false, submittable: false }; }
  const reviewArchive = await archiveMaterialEvidence(cap.archiveRoot, { scope: session.scope, records: [{ name: 'confirmation.json', bytes: Buffer.from(stable({ decision: confirmation.decision, reviewer: confirmation.reviewer, targetVersion: confirmation.targetVersion, dependencyDigest: confirmation.dependencyDigest, planDigest: confirmation.planDigest })) }], metadata: { kind: 'agency_accountant_confirmation', identity: proposal.identity, preparationArchiveId: proposal.archive.archiveId } });
  bindAgencyArchive(session, reviewArchive);
  let invoked = false, returned = false;
  try {
    invoked = true;
    const result = withAgencyEvidence(session, cap.targetDigest, () => app.C.withRequestMetadata({ operationId: proposal.identity.operationId, actor: 'cli' }, () => app.I.importIncremental({ ...cap.options, dryRun: false }))); returned = true;
    const recovery = await queryAgencyPosting(proposal.identity);
    const answer = { ...recovery, result, review: { reviewer: confirmation.reviewer, decision: 'accepted_for_accounting_posting', targetVersion: proposal.targetVersion, dependencyDigest: proposal.dependencyDigest, archive: reviewArchive }, periodComplete: false, submittable: false };
    try { answer.executionArchive = await archiveMaterialEvidence(cap.archiveRoot, { scope: session.scope, records: [{ name: 'execution.json', bytes: Buffer.from(stable(answer)) }], metadata: { kind: 'agency_execution_query', identity: proposal.identity, preparationArchiveId: proposal.archive.archiveId, confirmationArchiveId: reviewArchive.archiveId } }); }
    catch (error) { answer.executionArchive = { status: 'failed', code: error.code ?? 'agency_execution_archive_failed', actualPosting: 'see_persisted_query_evidence' }; }
    return answer;
  } catch (error) {
    const proof = app.C.operationErrorEvidence(error);
    const actual = returned || invoked && !proof ? 'unknown' : proof?.applied ?? false;
    return { status: actual === 'unknown' ? 'unknown' : 'failed', code: error.code ?? 'agency_posting_failed', applied: actual, recovery: { queryEntrypoint: 'queryAgencyPosting', identity: proposal.identity }, periodComplete: false, submittable: false };
  }
}

/** Recovery reads persisted audit/import/source/current posted entries, never a caller receipt. */
export async function queryAgencyPosting(id) {
  requireValue(id && id.operationId === `agency-${id.batchId}` && /^202[67]-\d\d$/.test(id.period), 'agency_query_identity_invalid');
  checkedDatabasePath(id.dbPath);
  const archive = await readArchivedMaterialEvidence(id.archivePath, id.archiveId), expected = archive.manifest.metadata;
  requireValue(expected.kind === 'agency_preparation' && ['dbPath', 'databaseInstanceId', 'accountSetId', 'enterpriseKey', 'period', 'batchId', 'operationId'].every(k => expected.identity[k] === id[k]), 'agency_query_archive_scope_mismatch');
  const db = new DatabaseSync(id.dbPath, { readOnly: true });
  try {
    const scope = { enterpriseKey: id.enterpriseKey, accountSetId: id.accountSetId, databaseInstanceId: id.databaseInstanceId, period: id.period, currency: 'CNY' };
    const schema = inspectAuditSchema(db); requireValue(schema.ok && schema.version === 2 && schema.activeInstanceId === id.databaseInstanceId, 'agency_query_schema_mismatch');
    agencyTargetSnapshot(db, scope);
    const operation = queryOperation(db, { databaseInstanceId: id.databaseInstanceId, operationId: id.operationId }), batch = getBatch(db, id.batchId);
    if (operation.code === 'not_found') {
      if(!batch&&expected.options.payload.vouchers.length===0){
        const verified=(expected.reconciliationProof?.proof??[]).every(p=>{const v=db.prepare('SELECT * FROM vouchers WHERE id=? AND account_set_id=?').get(p.voucherId,id.accountSetId);const e=v&&db.prepare('SELECT * FROM voucher_entries WHERE voucher_id=? ORDER BY line_no').all(v.id);return v?.status==='posted'&&persistedVoucherFingerprint(v,e)===p.fingerprint;});
        return {status:verified?'no_change':'unknown',applied:verified?false:'unknown',existingPostedEvidence:verified?expected.reconciliationProof:null,identity:id,periodComplete:false,submittable:false};
      }
      return { status: batch ? 'unknown' : 'not_started', applied: batch ? 'unknown' : false, identity: id, periodComplete: false, submittable: false };
    }
    if (!operation.ok || operation.durability !== 'committed' || !['succeeded', 'no_change'].includes(operation.state)) return { status: operation.durability === 'committed' && operation.state !== 'pending' ? 'failed' : 'unknown', applied: operation.durability === 'committed' && operation.state !== 'pending' ? false : 'unknown', identity: id, code: operation.code, periodComplete: false, submittable: false };
    const row = db.prepare('SELECT action,scope_kind,targets_json,request_digest FROM audit_operations WHERE database_instance_id=? AND operation_id=? AND attempt=1').get(id.databaseInstanceId, id.operationId);
    const requestDigest = auditCanonicalDigest(['audit-request-v1', 'import.append', { domainRequestDigest: auditResultDigest({ ...expected.options, dryRun: false }) }]);
    requireValue(row?.action === 'import.append' && row.scope_kind === 'account_set' && JSON.parse(row.targets_json).accountSetId === id.accountSetId && row.request_digest === requestDigest, 'agency_recovery_binding_mismatch');
    let valid = !!batch && batch.status === 'completed' && batch.account_set_id === id.accountSetId && batch.enterprise_key === id.enterpriseKey && batch.source_system === AGENCY_SOURCE_SYSTEM;
    const links = listBatchVouchers(db, id.batchId), wanted = expected.options.payload.vouchers;
    valid &&= links.length === wanted.length && new Set(links.map(l => l.source_voucher_id)).size === links.length;
    const actual = [];
    for (const v of wanted) {
      const link = links.find(l => l.source_voucher_id === v.sourceVoucherId), source = getVoucherSource(db, AGENCY_SOURCE_SYSTEM, id.enterpriseKey, v.sourceVoucherId);
      const stored = source && db.prepare('SELECT * FROM vouchers WHERE id=?').get(source.voucher_id), entries = stored && db.prepare('SELECT * FROM voucher_entries WHERE voucher_id=? ORDER BY line_no').all(stored.id);
      if (!link || !source || !stored || source.account_set_id !== id.accountSetId || link.account_set_id !== id.accountSetId || link.voucher_id !== stored.id || stored.account_set_id !== id.accountSetId || stored.status !== 'posted' || stored.period !== v.period || stored.voucher_date !== v.date || source.content_fingerprint !== voucherFingerprint(v) || link.content_fingerprint !== source.content_fingerprint || persistedVoucherFingerprint(stored, entries) !== source.voucher_fingerprint) { valid = false; continue; }
      actual.push({ voucherId: stored.id, sourceVoucherId: v.sourceVoucherId, period: stored.period, entries: entries.map(e => ({ code: e.code, debit: e.debit, credit: e.credit })) });
    }
    return { status: valid ? 'executed' : 'unknown', applied: valid ? true : 'unknown', identity: id, evidence: valid ? { operation, batchId: id.batchId, sourceVerified: true, actualVouchers: actual } : null, periodComplete: false, submittable: false };
  } finally { db.close(); }
}

export { calculateAgencyAnnualAdjustments };
