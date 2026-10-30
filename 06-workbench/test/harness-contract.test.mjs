import assert from 'node:assert/strict';
import { CAPABILITY_CONTRACT_VERSION, validateCapabilityDeclaration, validateHarnessScope, scopeContainsMonth, validateFact, validateExecutionReceipt, validatePlanGraph, validateFeedback } from '../server/harness-contract.mjs';

const scope = { enterpriseKey: 'synthetic-company-a', accountSetId: 1, databaseInstanceId: 'synthetic-instance', period: '2026-01', currency: 'CNY' };
assert.equal(validateHarnessScope(scope), scope);
const quarter = {...scope, period:'2026-Q2'}; validateHarnessScope(quarter);
assert.equal(scopeContainsMonth(quarter,'2026-04'),true);
assert.equal(scopeContainsMonth(quarter,'2026-03'),false);
assert.equal(scopeContainsMonth(quarter,'2025-04'),false);
assert.equal(scopeContainsMonth(scope,'2026-02'),false);
assert.throws(()=>validateHarnessScope({...scope,period:'2026-Q5'}),{code:'harness_scope_invalid'});
for (const patch of [{ accountSetId: 0 }, { period: '2026-13' }, { enterpriseKey: ' synthetic' }, { defaultAccountSet: true }]) {
  assert.throws(() => validateHarnessScope({ ...scope, ...patch }), { code: 'harness_scope_invalid' });
}
const capability = { version: CAPABILITY_CONTRACT_VERSION, capabilityId: 'offline.posting', description: 'Existing selected business posting only', availability: 'limited', necessaryFacts: [{ factId: 'source', description: 'Verified existing input manifest' }], supportConditions: ['Only business keys accepted by runOfflinePosting'], entrypoint: 'offline.posting', ruleVersion: 'posting/1', codeDigest: 'b'.repeat(64), effect: 'write', resultSchema: { type: 'object', required: ['status'] }, traceReferences: [{kind: 'code', locator: 'server/offline-posting.mjs', digest: 'b'.repeat(64)}], recovery: { queryEntrypoint: 'offline.posting.query', identityFields: ['businessKey', 'operationId'] } };
assert.equal(validateCapabilityDeclaration(capability), capability);
const clone = x => JSON.parse(JSON.stringify(x));
for (const mutate of [c => delete c.recovery, c => c.recovery.identityFields = [], c => c.entrypoint = 'node arbitrary.mjs', c => c.necessaryFacts.push(c.necessaryFacts[0]), c => c.effect = 'online_tax_submission']) {
  const c = clone(capability); mutate(c);
  assert.throws(() => validateCapabilityDeclaration(c), { code: 'harness_capability_invalid' });
}
// 读取能力不得意外将恢复能力宣告为执行权限。
const read = { ...capability, effect: 'read' }; delete read.recovery;
validateCapabilityDeclaration(read);
assert.throws(() => validateCapabilityDeclaration({ ...read, recovery: capability.recovery }), { code: 'harness_capability_invalid' });
const fact = { factId: 'source', state: 'provided', reason: 'Parsed and independently reconciled against source', sourceRefs: ['source-1'], value: { arbitraryCustomerLayout: true } };
validateFact(fact);
for (const state of ['missing', 'conflict', 'unknown', 'unsupported', 'not_applicable']) {
  const classified = { factId: 'source', state, reason: 'Explicit evidence-based classification', sourceRefs: [] };
  validateFact(classified);
  assert.throws(() => validateFact({ ...classified, value: 0 }), { code: 'harness_fact_invalid' });
}
assert.throws(() => validateFact({ ...fact, sourceRefs: [] }), { code: 'harness_fact_invalid' });
assert.throws(() => validateFact({ ...fact, state: 'not_applicable', reason: '' }), { code: 'harness_fact_invalid' });
const receipt = { taskId: 'task-1', operationId: 'operation-1', targetVersion: 'a'.repeat(64), dependencyDigest: 'a'.repeat(64), capabilityId: capability.capabilityId, ruleVersion: 'posting/1', codeDigest: 'b'.repeat(64), executionState: 'executed', reviewState: 'pending', ruleState: 'enterprise_exception', resultRefs: ['local:synthetic-receipt'], actualImpact: { voucherIds: [1], outcome: 'committed' } };
// 已执行不表示已复核，也不表示已提升为通用业务规则。
validateExecutionReceipt(receipt);
const unknown = { ...receipt, executionState: 'unknown', recovery: { queryEntrypoint: 'offline.posting.query', identity: { operationId: receipt.operationId } } };
validateExecutionReceipt(unknown);
assert.throws(() => validateExecutionReceipt({ ...unknown, reviewState: 'accepted' }), { code: 'harness_receipt_invalid' });
const noRecovery = { ...unknown }; delete noRecovery.recovery;
assert.throws(() => validateExecutionReceipt(noRecovery), { code: 'harness_receipt_invalid' });
assert.throws(() => validateExecutionReceipt({ ...receipt, executionState: 'stale' }), { code: 'harness_receipt_invalid' });
validateExecutionReceipt({ ...receipt, executionState: 'stale', reviewState: 'stale', failure: { layer: 'business_rule', code: 'rule_changed', reproductionRefs: ['synthetic:repro'] } });
const first = {taskId:'first', capabilityId:'offline.posting', goal:'First independent branch', factIds:['source'], dependsOn:[]};
const second = {...first,taskId:'second', dependsOn:['first']};
validatePlanGraph([first, second]);
for (const bad of [[first, first], [first, {...second, dependsOn:['absent']}], [{...first,dependsOn:['second']}, second]]) {
  assert.throws(() => validatePlanGraph(bad), {code:'harness_plan_invalid'});
}
const feedback = {taskId:receipt.taskId,targetVersion:receipt.targetVersion,dependencyDigest:receipt.dependencyDigest,decision:'propose_public_rule',reason:'Accountant chooses a candidate with explicit applicability',reviewer:'synthetic-accountant',evidenceRefs:capability.traceReferences};
validateFeedback(feedback);
assert.throws(() => validateFeedback({...feedback,decision:'auto_promote_all_enterprises'}),{code:'harness_feedback_invalid'});
console.log('harness-contract: scope, declarations, evidence classifications, independent review/rule states and unknown-write recovery passed');
