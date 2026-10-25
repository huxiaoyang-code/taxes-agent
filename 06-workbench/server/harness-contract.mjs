// Shared boundary: business modules declare what they implement; the Harness owns
// scheduling and evidence lifecycle. No accounting decisions or database imports.
export const HARNESS_CONTRACT_VERSION = 'finance-harness/1';
export const CAPABILITY_CONTRACT_VERSION = 'finance-capability/1';
export const FACT_STATES = Object.freeze(['provided', 'missing', 'conflict', 'unknown', 'unsupported', 'not_applicable']);
export const EXECUTION_STATES = Object.freeze(['not_started', 'prepared', 'executed', 'failed', 'unknown', 'stale']);
export const REVIEW_STATES = Object.freeze(['pending', 'accepted', 'rejected', 'stale']);
export const RULE_STATES = Object.freeze(['uncovered', 'enterprise_exception', 'public_candidate', 'public_rule']);
export const FAILURE_LAYERS = Object.freeze(['skill', 'capability', 'mcp', 'parser', 'business_rule', 'agent_judgment', 'environment']);

const fail = code => { throw Object.assign(new Error(code), { code }); };
const check = (value, code) => { if (!value) fail(code); };
const record = (v, code) => check(v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype, code);
const text = (v, code) => check(typeof v === 'string' && v.trim().length > 0 && v.length <= 32768 && !v.includes('\0'), code);
export const digestPattern = /^[a-f0-9]{64}$/;
export const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const id = (v, code) => check(typeof v === 'string' && idPattern.test(v), code);
const list = (v, code) => check(Array.isArray(v) && v.length <= 10000, code);
const fields = (v, required, optional, code) => {
  record(v, code);
  check(required.every(k => Object.hasOwn(v, k)) && Object.keys(v).every(k => [...required, ...optional].includes(k)), code);
};

export function validateHarnessScope(scope) {
  fields(scope, ['enterpriseKey', 'accountSetId', 'databaseInstanceId', 'period', 'currency'], [], 'harness_scope_invalid');
  text(scope.enterpriseKey, 'harness_scope_invalid');
  check(scope.enterpriseKey === scope.enterpriseKey.normalize('NFKC').trim() && Number.isSafeInteger(scope.accountSetId) && scope.accountSetId > 0, 'harness_scope_invalid');
  id(scope.databaseInstanceId, 'harness_scope_invalid');
  check(typeof scope.currency === 'string' && /^[A-Z]{3}$/.test(scope.currency), 'harness_scope_invalid');
  check(typeof scope.period === 'string' && /^20\d\d(?:-(0[1-9]|1[0-2]|Q[1-4]))?$/.test(scope.period), 'harness_scope_invalid');
  return scope;
}

// Explicit containment is useful for adapters; equality must still use the full
// period string so a monthly execution cannot become a quarterly confirmation.
export function scopeContainsMonth(scope, month) {
  validateHarnessScope(scope);
  if (typeof month !== 'string' || !/^20\d\d-(0[1-9]|1[0-2])$/.test(month)) return false;
  if (/^20\d\d$/.test(scope.period)) return scope.period === month.slice(0, 4);
  return scope.period.includes('-Q')
    ? scope.period.slice(0, 4) === month.slice(0, 4) && Number(scope.period.at(-1)) === Math.ceil(Number(month.slice(5)) / 3)
    : scope.period === month;
}

// Containment never widens a business function's implemented period support.
export function capabilitySupportsScope(capability, scope) {
  validateHarnessScope(scope);
  const kind = scope.period.length === 4 ? 'year' : scope.period.includes('-Q') ? 'quarter' : 'month';
  return (capability.supportedPeriods ?? ['month', 'quarter']).includes(kind);
}

/** entrypoint names are declarations, never executable paths supplied by a model.
 * The adapter registry must bind each name to a fixed local business function.
 * supportConditions describe limits and do not assert that input facts satisfy them.
 */
export function validateCapabilityDeclaration(c) {
  const code = 'harness_capability_invalid';
  fields(c, ['version', 'capabilityId', 'description', 'availability', 'necessaryFacts', 'supportConditions', 'entrypoint', 'ruleVersion', 'codeDigest', 'effect', 'resultSchema', 'traceReferences'], ['recovery', 'supportedPeriods'], code);
  check(c.version === CAPABILITY_CONTRACT_VERSION, code); id(c.capabilityId, code); text(c.description, code);
  check(['available', 'limited', 'unavailable'].includes(c.availability), code);
  list(c.necessaryFacts, code);
  const names = new Set();
  for (const f of c.necessaryFacts) {
    fields(f, ['factId', 'description'], [], code); id(f.factId, code); text(f.description, code);
    check(!names.has(f.factId), code); names.add(f.factId);
  }
  list(c.supportConditions, code); c.supportConditions.forEach(v => text(v, code));
  if (c.supportedPeriods !== undefined) { list(c.supportedPeriods, code); check(c.supportedPeriods.length > 0 && c.supportedPeriods.every(v => ['month', 'quarter', 'year'].includes(v)), code); }
  id(c.entrypoint, code); text(c.ruleVersion, code); check(digestPattern.test(c.codeDigest), code);
  check(['read', 'write'].includes(c.effect), code); record(c.resultSchema, code);
  list(c.traceReferences, code); c.traceReferences.forEach(validateTraceReference);
  if (c.effect === 'write') {
    fields(c.recovery, ['queryEntrypoint', 'identityFields'], [], code); id(c.recovery.queryEntrypoint, code);
    list(c.recovery.identityFields, code); check(c.recovery.identityFields.length > 0, code);
    c.recovery.identityFields.forEach(v => id(v, code));
  } else check(c.recovery === undefined, code);
  return c;
}

export function validateTraceReference(ref) {
  const code = 'harness_trace_invalid';
  fields(ref, ['kind', 'locator', 'digest'], [], code);
  check(['source', 'rule', 'code', 'execution', 'validation', 'policy', 'artifact'].includes(ref.kind), code);
  text(ref.locator, code); check(digestPattern.test(ref.digest), code);
  return ref;
}

export function validateFact(f) {
  const code = 'harness_fact_invalid';
  fields(f, ['factId', 'state', 'reason', 'sourceRefs'], ['value'], code);
  id(f.factId, code); check(FACT_STATES.includes(f.state), code); text(f.reason, code);
  list(f.sourceRefs, code); f.sourceRefs.forEach(v => id(v, code));
  if (f.state === 'provided') check(Object.hasOwn(f, 'value') && f.sourceRefs.length > 0, code);
  else check(!Object.hasOwn(f, 'value'), code);
  return f;
}

/** Execution, accountant review, and public rule promotion are independent axes.
 * A receipt from the fixed business adapter is authoritative for actual effects.
 * An unknown write is query-only until a business recovery result resolves it.
 */
export function validateExecutionReceipt(r) {
  const code = 'harness_receipt_invalid';
  fields(r, ['taskId', 'operationId', 'targetVersion', 'dependencyDigest', 'capabilityId', 'ruleVersion', 'codeDigest', 'executionState', 'reviewState', 'ruleState', 'resultRefs', 'actualImpact'], ['recovery', 'failure'], code);
  id(r.taskId, code); id(r.operationId, code); id(r.capabilityId, code);
  check(digestPattern.test(r.dependencyDigest) && digestPattern.test(r.targetVersion) && digestPattern.test(r.codeDigest), code); text(r.ruleVersion, code);
  check(EXECUTION_STATES.includes(r.executionState) && REVIEW_STATES.includes(r.reviewState) && RULE_STATES.includes(r.ruleState), code);
  list(r.resultRefs, code); r.resultRefs.forEach(v => text(v, code)); record(r.actualImpact, code);
  if (r.executionState === 'unknown') {
    fields(r.recovery, ['queryEntrypoint', 'identity'], [], code); id(r.recovery.queryEntrypoint, code); record(r.recovery.identity, code);
    check(r.reviewState !== 'accepted', code);
  }
  if (r.executionState === 'stale') check(r.reviewState === 'stale', code);
  if (r.failure !== undefined) {
    fields(r.failure, ['layer', 'code', 'reproductionRefs'], [], code);
    check(FAILURE_LAYERS.includes(r.failure.layer), code); id(r.failure.code, code);
    list(r.failure.reproductionRefs, code); r.failure.reproductionRefs.forEach(v => text(v, code));
  }
  return r;
}

// Task projections never rewrite immutable execution receipts. Null means a
// temporary observation could not establish current applicability/confirmation.
export const HARNESS_STATE_AXES = Object.freeze({
  operationState: 'Historical execution outcome retained across dependency changes; executed does not imply current applicability or accountant acceptance',
  resultCurrent: 'true: executed result verified against current dependencies; false: inapplicable or blocked by verified change; null: temporarily unverifiable',
  confirmationCurrent: 'true: accepted review of the current result; false: absent, rejected or stale review; null: accepted result temporarily unverifiable',
});
export function validateHarnessTaskState(task) {
  check(EXECUTION_STATES.includes(task.operationState),'harness_task_state_invalid');
  check([true,false,null].includes(task.resultCurrent)&&[true,false,null].includes(task.confirmationCurrent),'harness_task_state_invalid');
  check(task.confirmationCurrent!==true||task.resultCurrent===true&&task.reviewState==='accepted','harness_task_state_invalid');
  return task;
}

// Facts refer to source evidence separately; runtime computes task input and
// dependency digests from current facts, capability code/rule and parent results.
// The Agent may replace the DAG; no fixed stage sequence is assumed here.
export function validatePlanGraph(tasks) {
  const code = 'harness_plan_invalid'; list(tasks, code); const byId = new Map();
  for (const t of tasks) {
    fields(t, ['taskId', 'capabilityId', 'factIds', 'dependsOn', 'goal'], ['externalDependencies'], code);
    id(t.taskId, code); id(t.capabilityId, code); text(t.goal, code);
    list(t.factIds, code); t.factIds.forEach(v => id(v, code));
    list(t.dependsOn, code); t.dependsOn.forEach(v => id(v, code));
    if (t.externalDependencies !== undefined) {
      list(t.externalDependencies, code);
      for (const ref of t.externalDependencies) {
        fields(ref, ['storePath', 'taskId', 'period', 'targetVersion', 'dependencyDigest'], [], code);
        text(ref.storePath, code); id(ref.taskId, code);
        check(/^20\d\d(?:-(0[1-9]|1[0-2]|Q[1-4]))?$/.test(ref.period) && digestPattern.test(ref.targetVersion) && digestPattern.test(ref.dependencyDigest), code);
      }
      check(new Set(t.externalDependencies.map(ref => `${ref.storePath}\0${ref.taskId}`)).size === t.externalDependencies.length, code);
    }
    check(!byId.has(t.taskId) && new Set(t.factIds).size === t.factIds.length && new Set(t.dependsOn).size === t.dependsOn.length, code);
    byId.set(t.taskId, t);
  }
  const visiting = new Set(), visited = new Set();
  const visit = id => {
    check(byId.has(id) && !visiting.has(id), code);
    if (visited.has(id)) return;
    visiting.add(id); byId.get(id).dependsOn.forEach(visit); visiting.delete(id); visited.add(id);
  };
  byId.forEach(t => visit(t.taskId)); return tasks;
}

export function validateFeedback(f) {
  const code = 'harness_feedback_invalid';
  fields(f, ['taskId', 'targetVersion', 'dependencyDigest', 'decision', 'reason', 'reviewer', 'evidenceRefs'], [], code);
  id(f.taskId, code); text(f.reason, code); text(f.reviewer, code);
  check(digestPattern.test(f.targetVersion) && digestPattern.test(f.dependencyDigest), code);
  check(['accept', 'reject', 'retain_enterprise_exception', 'propose_public_rule'].includes(f.decision), code);
  list(f.evidenceRefs, code); f.evidenceRefs.forEach(validateTraceReference); return f;
}
