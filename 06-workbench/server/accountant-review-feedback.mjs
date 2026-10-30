// 本机结构化声明；不是身份认证，也不是过账指令。
import { fields, requirePlainJson, requireValue as check, validateScope, identifier, stable } from './offline-material-adapters.mjs';

export const FEEDBACK_VERSION = 'offline-accountant-feedback/1';
export const BINDING_KEYS = ['bundleDigest', 'inputHash', 'ruleVersion', 'ruleDigest', 'calculationVersion', 'ledgerSnapshotDigest', 'ruleCodeDigest', 'inputFilesDigest'];
const DIGEST = /^[a-f0-9]{64}$/;
const text = v => check(typeof v === 'string' && v === v.trim() && v.length > 0 && v.length <= 4000 && !/[\u0000-\u001f\u007f]/.test(v), 'feedback_text_invalid');
export function validateBinding(binding) {
  fields(binding, BINDING_KEYS);
  for (const key of BINDING_KEYS) {
    if (['ruleVersion', 'calculationVersion'].includes(key)) text(binding[key]);
    else check(typeof binding[key] === 'string' && DIGEST.test(binding[key]), 'feedback_binding_invalid');
  }
}
export function validateFeedback(payload) {
  requirePlainJson(payload);
  fields(payload, ['version', 'feedbackId', 'action', 'scope', 'versionId', 'binding', 'expectedJournalHead', 'actor', 'occurredAt', 'reason'], ['facts', 'selectedFields']);
  check(payload.version === FEEDBACK_VERSION, 'feedback_version_invalid');
  identifier(payload.feedbackId); identifier(payload.versionId); validateScope(payload.scope); validateBinding(payload.binding);
  check(DIGEST.test(payload.expectedJournalHead), 'feedback_head_invalid');
  fields(payload.actor, ['name', 'role']); text(payload.actor.name); check(payload.actor.role === 'accountant', 'feedback_actor_invalid'); text(payload.reason);
  check(typeof payload.occurredAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(payload.occurredAt) && Number.isFinite(Date.parse(payload.occurredAt)) && new Date(payload.occurredAt).toISOString() === payload.occurredAt, 'feedback_time_invalid');
  check(['request_materials', 'reject', 'confirm_selected_fields'].includes(payload.action), 'feedback_action_invalid');
  if (payload.action === 'confirm_selected_fields') {
    check(!Object.hasOwn(payload, 'facts') && Array.isArray(payload.selectedFields) && payload.selectedFields.length > 0 && payload.selectedFields.length <= 16, 'feedback_fields_invalid');
    const seen = new Set();
    for (const c of payload.selectedFields) {
      fields(c, ['row', 'column', 'period']);
      check([1, 2, 3, 15, 16, 20, 21, 22].includes(c.row) && c.column === 'services' && ['current', 'yearToDate'].includes(c.period) && !(c.period === 'yearToDate' && [21, 22].includes(c.row)), 'feedback_fields_invalid');
      const key = stable(c); check(!seen.has(key), 'feedback_fields_duplicate'); seen.add(key);
    }
  } else {
    check(!Object.hasOwn(payload, 'selectedFields') && Array.isArray(payload.facts) && payload.facts.length > 0 && payload.facts.length <= 50, 'feedback_facts_invalid');
    for (const fact of payload.facts) { fields(fact, ['field', 'observedFact', 'requestedFact']); for (const value of Object.values(fact)) text(value); }
  }
  return payload;
}
export function assertFeedbackTarget(payload, current, scope) {
  check(current && payload.versionId === current.versionId && stable(payload.scope) === stable(scope) && stable(payload.binding) === stable(current.binding), 'feedback_target_mismatch');
}
export function assertSelectedConfirmation(payload, bundle) {
  check(bundle.computation.calculationReady === true && bundle.exceptions.length === 0, 'feedback_calculation_blocked');
  for (const f of payload.selectedFields) check(bundle.computation.cells.some(c => c.row === f.row && c.column === f.column && c.period === f.period && c.status === 'computed' && c.minor !== null), 'feedback_field_not_computed');
}
