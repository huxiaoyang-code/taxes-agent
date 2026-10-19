import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildTaxPreparation, PREPARATION_RESOURCES } from '../server/tax-preparation.mjs';

const base = { companyRef: 'company-synthetic-1', period: '2026-09' };
const allCoverage = () => PREPARATION_RESOURCES.map((resource) => ({ ...base, resource, status: 'success', complete: true, count: 1, evidenceLevel: 'repeated', sourceRef: 'evidence-synthetic-1', evidencePersisted: true, metadataOnly: false }));
test('no data produces actionable gaps and separate unknown filing states', () => {
  const r = buildTaxPreparation(base);
  assert.equal(r.submittable, false);
  assert.equal(r.obligationsComplete, false);
  assert.equal(r.status, 'blocked');
  assert.equal(r.coverage.length, 10);
  assert.ok(r.coverage.every((row) => row.count === null && row.complete === false));
  assert.ok(r.gaps.some((g) => g.code === 'existing_account_set_not_linked'));
  assert.deepEqual(r.filingStates, { financialStatements: 'unknown', taxDeclaration: 'unknown', payment: 'unknown' });
});
test('complete synthetic sources cannot prove real collection or obligations', () => {
  const coverage = allCoverage().map((row) => ({ ...row, evidenceLevel: 'synthetic' }));
  const r = buildTaxPreparation({ ...base, coverage });
  assert.ok(r.coverage.every((row) => row.complete === false));
  assert.equal(r.gaps.filter((g) => g.code === 'resource_not_verified').length, 7);
  assert.ok(r.coverage.slice(7).every((row) => row.applicability === 'needs_assessment'));
});
test('all repeated resources and accounting still block without official rules, form and events', () => {
  const r = buildTaxPreparation({ ...base, coverage: allCoverage(), accountSet: { linked: true, periodAvailable: true } });
  assert.ok(r.coverage.every((row) => row.complete));
  for (const code of ['applicable_official_rules_unverified', 'applicable_form_version_unverified', 'enterprise_events_unverified', 'historical_dependencies_unresolved']) {
    assert.ok(r.gaps.some((g) => g.code === code), code);
  }
  assert.equal(r.status, 'blocked');
  assert.equal(r.submittable, false);
  assert.equal(r.ruleSet.version, null);
  assert.ok(r.validations.every((v) => v.status !== 'passed'));
});
test('partial, denied, unsupported, and unknown empty results are distinct', () => {
  const states = ['partial', 'permission_denied', 'unsupported', 'not_acquired', 'failed'];
  const coverage = states.map((status, index) => ({ ...allCoverage()[index], status, count: 0 }));
  const r = buildTaxPreparation({ ...base, coverage });
  assert.deepEqual(r.coverage.slice(0, states.length).map((row) => row.status), states);
  assert.ok(r.coverage.every((row) => !row.complete));
});
test('explicit verified no-record result is evidence, not a zero tax obligation', () => {
  const coverage = [{ ...allCoverage()[0], status: 'no_records', count: 0 }];
  const r = buildTaxPreparation({ ...base, coverage });
  assert.equal(r.coverage[0].complete, true);
  assert.equal(r.obligationsComplete, false);
  assert.deepEqual(r.fields, []);
});
test('field provenance preserves known zero but omits actual value and arbitrary text', () => {
  const r = buildTaxPreparation({ ...base, fields: [{ fieldId: 'synthetic_revenue', period: base.period, status: 'known', value: 0, sourceKind: 'local_account_set', sourceRef: 'book-1', sourceVersion: 'v1', secret: 'should-never-appear' }] });
  assert.equal(r.fields[0].status, 'requires_rule_validation');
  assert.equal(Object.hasOwn(r.fields[0], 'value'), false);
  assert.equal(JSON.stringify(r).includes('should-never-appear'), false);
  assert.equal(r.fields[0].ruleVersion, null);
});
test('unknown fields stay unknown; missing provenance and wrong period block', () => {
  const r = buildTaxPreparation({ ...base, fields: [{ fieldId: 'synthetic_revenue', status: 'unknown', value: null, period: '2026-08' }] });
  for (const code of ['field_source_missing', 'field_period_mismatch', 'field_value_unknown']) assert.ok(r.gaps.some((g) => g.code === code));
  assert.equal(r.fields[0].status, 'incomplete');
  assert.equal(Object.hasOwn(r.fields[0], 'value'), false);
});
test('existing account set with missing period requests local accounting data', () => {
  const r = buildTaxPreparation({ ...base, accountSet: { linked: true, periodAvailable: false } });
  assert.ok(r.gaps.some((g) => g.code === 'accounting_period_unavailable'));
});
test('invalid input, duplicate resources, scope and period mismatches fail closed', () => {
  for (const bad of [
    { period: '2026-13' }, { companyRef: '../raw' }, { coverage: {} }, { fields: {} },
    { coverage: [allCoverage()[0], allCoverage()[0]] },
    { coverage: [{ ...allCoverage()[0], period: '2026-08' }] },
    { coverage: [{ ...allCoverage()[0], companyRef: 'company-other' }] },
    { coverage: [{ ...allCoverage()[0], count: -1 }] },
    { coverage: [{ ...allCoverage()[0], status: 'no_records', count: 1 }] },
    { fields: [{ fieldId: 'x' }, { fieldId: 'x' }] },
  ]) assert.throws(() => buildTaxPreparation({ ...base, ...bad }), (e) => e.code === 'tax_preparation_input_invalid');
});
test('a success flag lacking explicit company and period cannot prove coverage', () => {
  const { period, companyRef, ...row } = allCoverage()[0];
  const result = buildTaxPreparation({ ...base, coverage: [row] });
  assert.equal(result.coverage[0].complete, false);
});
test('an ephemeral source reference cannot stand in for persisted real evidence', () => {
  const result = buildTaxPreparation({ ...base, coverage: [{ ...allCoverage()[0], evidencePersisted: false, metadataOnly: true }] });
  assert.equal(result.coverage[0].complete, false);
  assert.equal(result.coverage[0].evidencePersisted, false);
  assert.equal(result.coverage[0].metadataOnly, true);
});
