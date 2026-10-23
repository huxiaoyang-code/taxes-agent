// A review draft is minted only by replaying raw materials and the private ledger capability.
import { assertVatInputCurrent, assertVatInputPayload } from './offline-vat-input.mjs';
import { calculateOfflineVat } from './tax-calculation.mjs';
import { assessAccountingReadiness } from './offline-accounting-readiness.mjs';
import { validateLedgerSnapshot } from './offline-ledger-snapshot.mjs';
import { hash, stable, requireValue } from './offline-material-adapters.mjs';

export const REVIEW_VERSION = 'offline-accountant-review/1';
const capabilities = new WeakMap();
const freeze = v => { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); } return v; };
const copy = structuredClone;
export function createAccountantReview(rawInput, source, snapshot) {
  assertVatInputPayload(rawInput, source, snapshot);
  const computation = calculateOfflineVat(rawInput, source, snapshot);
  const { taxFacts, previousComputation, ...accountingInput } = rawInput;
  const assessment = assessAccountingReadiness(accountingInput);
  const bundle = {
    version: REVIEW_VERSION, kind: 'accountant_review_draft', scope: copy(computation.scope),
    status: computation.calculationReady ? 'selected_fields_draft' : computation.status,
    accountantApproval: 'pending', confirmationStatus: 'pending', authorizesExecution: false,
    periodComplete: false, submittable: false, sourceAuthenticity: 'unverified',
    freshness: 'raw_input_replay_and_private_ledger_at_call_only_actual_files_require_loader_recheck',
    computation: copy(computation),
    materials: {
      rows: copy(assessment.assessment.rows), records: copy(assessment.assessment.records),
      sources: assessment.assessment.sources.map(({ rawContent, ...metadata }) => copy(metadata)),
      replayIssues: copy(assessment.replayIssues),
      declaration: copy(rawInput.declaration),
      accountingFacts: { fileSha256: rawInput.accountingFacts.fileSha256, document: JSON.parse(rawInput.accountingFacts.text.replace(/^\uFEFF/, '')) },
      taxFacts: { fileSha256: rawInput.taxFacts.fileSha256, document: JSON.parse(rawInput.taxFacts.text.replace(/^\uFEFF/, '')) },
    },
    ledgerSnapshot: copy(snapshot),
    exceptions: copy(computation.issues),
    pending: [
      { code: 'accountant_review_pending', state: 'pending', request: '会计逐项核对材料、资格、覆盖、原始凭证及选定税算字段；导出不代表已确认。' },
      ...computation.issues.map(i => ({ code: i.code, field: i.field, state: 'pending', classification: i.classification, request: i.requestedFact })),
      { code: 'feedback_correction_confirmation_chain_not_implemented', state: 'pending', request: '结构化反馈、驳回、更正再确认链尚未实现；不能复用旧草稿确认。' },
    ],
    limitations: [...computation.limitations, 'json_is_diagnostic_not_a_capability', 'no_accountant_approval_or_feedback_execution_endpoint'],
  };
  bundle.contentDigest = hash(stable(bundle));
  freeze(bundle);
  capabilities.set(bundle, { rawInput, rawDigest: hash(stable(rawInput)), source, snapshot, computationDigest: computation.contentDigest });
  return bundle;
}
// The public JSON, even byte-identical, cannot be used as this identity.
export async function assertAccountantReviewCurrent(bundle, inputSession) {
  const cap = capabilities.get(bundle);
  requireValue(cap, 'review_bundle_untrusted');
  await assertVatInputCurrent(cap.rawInput, cap.source, cap.snapshot, inputSession);
  requireValue(hash(stable(cap.rawInput)) === cap.rawDigest, 'review_input_changed');
  requireValue(validateLedgerSnapshot(cap.source, cap.snapshot).status === 'current', 'review_ledger_changed');
  requireValue(calculateOfflineVat(cap.rawInput, cap.source, cap.snapshot).contentDigest === cap.computationDigest, 'review_computation_changed');
  return await assertVatInputCurrent(cap.rawInput, cap.source, cap.snapshot, inputSession);
}
