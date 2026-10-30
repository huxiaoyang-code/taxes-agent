import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TaxGateway } from '../server/tax-gateway.mjs';
import { TaxAcquisition } from '../server/tax-acquisition.mjs';

const resource = 'tax_assessments', period = '2026-09';
const accounting = {
  getAccountSet(id) { if (id !== 7) throw Error('missing'); return { id, name: 'PRIVATE_SYNTHETIC_COMPANY' }; },
  listPeriods: () => [{ period }], listAccounts: () => [{ code: '1001' }], listVouchers: () => [],
};
function adapter(overrides = {}) {
  return {
    adapterId: 'synthetic-readonly', region: '350000', version: 'test', label: 'Synthetic only',
    capabilities: { resources: ['identity', 'authorized_enterprises', 'enterprise_profile', resource, 'declaration_status'], loginMethods: ['sms'], challengeActions: [] },
    readonlyEvidence: { [resource]: { sideEffectFree: true, evidenceLevel: 'synthetic', contractVersion: 'v1' } },
    startLogin: () => ({ status: 'authenticated' }), logout: () => ({ status: 'logged_out' }),
    verifyScope: (ctx) => ({ scopeRevision: 'synthetic-rev-1', httpStatus: 200, schemaValidated: true, businessCodeValidated: true, businessOk: true, authorized: true, enterpriseId: ctx.enterprise.enterpriseId }),
    queryPage: (ctx, params) => ({ scopeRevision: 'synthetic-rev-1', httpStatus: 200, schemaValidated: true, businessCodeValidated: true, businessOk: true, enterpriseId: ctx.enterprise.enterpriseId, period: params.period,
      data: [{ taxType: 'synthetic-tax', taxName: 'PRIVATE_SYNTHETIC_COMPANY' }],
      pagination: { page: params.page, pageSize: params.pageSize, total: 1, hasMore: false } }),
    ...overrides,
  };
}
async function setup(overrides = {}, gatewayOptions = {}) {
  const gateway = new TaxGateway({ accountSetExists: (id) => id === 7, ...gatewayOptions });
  gateway.registerAdapter(adapter(overrides));
  const session = await gateway.startLogin({ region: '350000', enterprise: { enterpriseId: 'PRIVATE_SYNTHETIC_E1' } });
  const service = new TaxAcquisition({ gateway, accounting });
  const args = { sessionId: session.sessionId, resource, period };
  return { gateway, service, args };
}
const code = (expected) => (e) => { assert.equal(e.code, expected); return true; };

test('default adapter registry remains empty and unsupported', async () => {
  const gateway = new TaxGateway();
  assert.equal(gateway.listRegions().summary.adaptersTotal, 0);
  await assert.rejects(() => gateway.startLogin({ region: '350000' }), code('tax_region_not_configured'));
});
test('safe summary, opaque provenance and coverage do not return business values', async () => {
  const { service, args } = await setup();
  const result = await service.collect(args);
  assert.equal(result.count, 1); assert.equal(result.complete, true); assert.equal(result.evidenceLevel, 'synthetic');
  assert.match(result.sourceRef, /^read_/);
  assert.match(result.companyRef, /^scope_/);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SYNTHETIC/);
  const cov = await service.coverage({ sessionId: args.sessionId, period });
  assert.equal(cov.resources.find((r) => r.resource === resource).count, 1);
  assert.equal(cov.resources.find((r) => r.resource === 'invoices').status, 'unsupported');
});
test('each collection invokes the adapter again with a new provenance reference', async () => {
  let calls = 0;
  const base = adapter();
  const { service, args } = await setup({ queryPage(ctx, params) { calls++; return base.queryPage(ctx, params); } });
  const first = await service.collect(args), second = await service.collect(args);
  assert.equal(calls, 2); assert.notEqual(first.sourceRef, second.sourceRef);
  assert.equal(first.evidenceLevel, 'synthetic'); assert.equal(second.evidenceLevel, 'synthetic');
});
test('two pages over 500 rows retain complete count instead of truncating', async () => {
  let calls = 0;
  const { service, args } = await setup({ queryPage(ctx, p) {
    calls++; const size = p.page === 1 ? 500 : 101;
    return { scopeRevision: 'synthetic-rev-1', httpStatus: 200, schemaValidated: true, businessCodeValidated: true, businessOk: true, enterpriseId: ctx.enterprise.enterpriseId, period: p.period,
      data: Array.from({ length: size }, (_, n) => ({ taxType: `synthetic-${p.page}-${n}` })),
      pagination: { page: p.page, pageSize: p.pageSize, total: 601, hasMore: p.page === 1 } };
  } });
  const result = await service.collect(args);
  assert.equal(result.count, 601); assert.equal(result.pages, 2); assert.equal(calls, 2);
});
test('empty list with verified business scope/pagination is explicitly no_records', async () => {
  const { service, args } = await setup({ queryPage(ctx, p) { return { scopeRevision: 'synthetic-rev-1', httpStatus: 200, schemaValidated: true, businessCodeValidated: true, businessOk: true, enterpriseId: ctx.enterprise.enterpriseId, period: p.period,
    data: [], pagination: { page: 1, pageSize: p.pageSize, total: 0, hasMore: false } }; } });
  const result = await service.collect(args);
  assert.equal(result.status, 'no_records'); assert.equal(result.count, 0);
});
for (const [name, change, expected] of [
  ['HTTP 500 with a success body', (r) => { r.httpStatus = 500; }, 'tax_response_invalid'],
  ['missing schema proof', (r) => { delete r.schemaValidated; }, 'tax_response_invalid'],
  ['missing business-code proof', (r) => { delete r.businessCodeValidated; }, 'tax_response_invalid'],
  ['missing business success', (r) => { delete r.businessOk; }, 'tax_business_error'],
  ['business error despite data', (r) => { r.businessOk = false; r.errorCode = 'business_error'; }, 'tax_business_error'],
  ['permission denied', (r) => { r.businessOk = false; r.errorCode = 'permission_denied'; }, 'tax_permission_denied'],
  ['wrong enterprise', (r) => { r.enterpriseId = 'other'; }, 'tax_scope_mismatch'],
  ['wrong period', (r) => { r.period = '2026-08'; }, 'tax_scope_mismatch'],
  ['changed authentication revision', (r) => { r.scopeRevision = 'synthetic-rev-2'; }, 'tax_scope_mismatch'],
  ['missing pagination', (r) => { delete r.pagination; }, 'tax_pagination_invalid'],
  ['early termination', (r) => { r.pagination.total = 2; }, 'tax_pagination_incomplete'],
  ['wrong shape', (r) => { r.data = {}; }, 'tax_response_invalid'],
  ['missing business fields', (r) => { r.data = [{}]; }, 'tax_response_invalid'],
  ['null primary field', (r) => { r.data = [{ taxType: null }]; }, 'tax_response_invalid'],
  ['object primary field', (r) => { r.data = [{ taxType: { nested: 'bad' } }]; }, 'tax_response_invalid'],
  ['oversized page is rejected, never sliced', (r) => { r.data = Array.from({ length: 501 }, (_, n) => ({ taxType: String(n) })); r.pagination.total = 501; }, 'tax_response_invalid'],
]) test(`${name} fails without successful coverage`, async () => {
  const base = adapter();
  const { service, args } = await setup({ queryPage(ctx, p) { const result = base.queryPage(ctx, p); change(result); return result; } });
  await assert.rejects(() => service.collect(args), code(expected));
  const cov = await service.coverage({ sessionId: args.sessionId, period });
  assert.equal(cov.resources.find((r) => r.resource === resource).complete, false);
});
test('transient error receives only one retry per page', async () => {
  let calls = 0; const base = adapter();
  const { service, args } = await setup({ queryPage(ctx, p) { return ++calls === 1 ? { businessOk: false, errorCode: 'transient' } : base.queryPage(ctx, p); } });
  assert.equal((await service.collect(args)).count, 1); assert.equal(calls, 2);
});
test('persistent transient error terminates after two attempts', async () => {
  let calls = 0;
  const { service, args } = await setup({ queryPage() { calls++; return { businessOk: false, errorCode: 'transient' }; } });
  await assert.rejects(() => service.collect(args)); assert.equal(calls, 2);
});
test('session expiration halts acquisition and cannot be read as no-record', async () => {
  const { service, args } = await setup({ queryPage() { return { businessOk: false, errorCode: 'session_expired' }; } });
  await assert.rejects(() => service.collect(args), code('tax_session_expired'));
  await assert.rejects(() => service.prepare({ sessionId: args.sessionId, period }), code('tax_session_expired'));
});
test('read lacking side-effect-free proof is never executed', async () => {
  let calls = 0;
  const { service, args } = await setup({ readonlyEvidence: {}, queryPage() { calls++; } });
  await assert.rejects(() => service.collect(args), code('tax_resource_unsupported'));
  assert.equal(calls, 0);
});
test('unsupported resources return explicit unsupported coverage', async () => {
  const { service, args } = await setup();
  await assert.rejects(() => service.collect({ ...args, resource: 'invoices' }), code('tax_resource_unsupported'));
  const cov = await service.coverage({ sessionId: args.sessionId, period });
  assert.equal(cov.resources.find((r) => r.resource === 'invoices').status, 'unsupported');
});
test('repeated page rows invalidate completeness', async () => {
  const base = adapter();
  const { service, args } = await setup({ queryPage(ctx, p) { const r = base.queryPage(ctx, p); r.pagination.total = 2; r.pagination.hasMore = p.page === 1; return r; } });
  await assert.rejects(() => service.collect(args), code('tax_pagination_duplicate'));
});
test('pagination has a bounded 20-page stop', async () => {
  let calls = 0;
  const { service, args } = await setup({ queryPage(ctx, p) { calls++; return { scopeRevision: 'synthetic-rev-1', httpStatus: 200, schemaValidated: true, businessCodeValidated: true, businessOk: true, enterpriseId: ctx.enterprise.enterpriseId, period: p.period,
    data: [{ taxType: `page-${p.page}` }], pagination: { page: p.page, pageSize: p.pageSize, total: 21, hasMore: true } }; } });
  await assert.rejects(() => service.collect(args), code('tax_pagination_limit')); assert.equal(calls, 20);
});
test('late result after logout cannot become usable coverage', async () => {
  let release, entered;
  const pending = new Promise((resolve) => { entered = resolve; });
  const base = adapter();
  const { gateway, service, args } = await setup({ queryPage(ctx, p) { entered(); return new Promise((resolve) => { release = () => resolve(base.queryPage(ctx, p)); }); } });
  const collection = service.collect(args); await pending;
  await gateway.logout({ sessionId: args.sessionId }); release();
  await assert.rejects(() => collection);
  assert.equal([...service.records.values()].some((r) => r.complete), false);
});
test('company change during await discards the late result', async () => {
  let release, entered;
  const pending = new Promise((resolve) => { entered = resolve; }); const base = adapter();
  const { gateway, service, args } = await setup({ queryPage(ctx, p) { const result = base.queryPage(ctx, p); entered(); return new Promise((resolve) => { release = () => resolve(result); }); } });
  const collection = service.collect(args); await pending;
  gateway.sessions.get(args.sessionId).enterprise = { enterpriseId: 'OTHER_SYNTHETIC_E2' }; release();
  await assert.rejects(() => collection, code('tax_scope_changed'));
  assert.equal([...service.records.values()].some((r) => r.complete), false);
});
test('failed refresh removes earlier successful coverage', async () => {
  let fail = false; const base = adapter();
  const { service, args } = await setup({ queryPage(ctx, p) { return fail ? { businessOk: false, errorCode: 'permission_denied' } : base.queryPage(ctx, p); } });
  await service.collect(args); fail = true;
  await assert.rejects(() => service.collect(args), code('tax_permission_denied'));
  assert.equal([...service.records.values()].some((r) => r.complete), false);
});
test('link reads an existing account set without import or creation and preparation blocks', async () => {
  const { service, args } = await setup();
  const linked = await service.linkAccountSet({ sessionId: args.sessionId, accountSetId: 7 });
  assert.equal(linked.linked, true); assert.equal(linked.identityMatched, false);
  assert.doesNotMatch(JSON.stringify(linked), /PRIVATE_SYNTHETIC/);
  const prepared = await service.prepare({ sessionId: args.sessionId, period });
  assert.equal(prepared.status, 'blocked'); assert.equal(prepared.submittable, false);
  assert.ok(prepared.gaps.some((g) => g.code === 'account_set_enterprise_match_unverified'));
  await assert.rejects(() => service.linkAccountSet({ sessionId: args.sessionId, accountSetId: 8 }), code('account_set_not_found'));
});
test('tool arguments cannot inject URLs, headers, company scope or field values', async () => {
  const { service, args } = await setup();
  for (const extra of [{ url: 'https://example.invalid' }, { headers: {} }, { enterpriseId: 'other' }, { token: 'fake' }]) {
    await assert.rejects(() => service.collect({ ...args, ...extra }), code('tax_acquisition_input_invalid'));
  }
  await assert.rejects(() => service.prepare({ sessionId: args.sessionId, period, fields: [{ value: 1 }] }), code('tax_acquisition_input_invalid'));
  await assert.rejects(() => service.collect({ ...args, period: '2026-13' }), code('tax_period_invalid'));
});
test('slow reads time out, propagate cancellation, and never commit their late success', async () => {
  let release, capturedSignal; const base = adapter();
  const { service, args } = await setup({ queryPage(ctx, p) { capturedSignal = p.signal; return new Promise((resolve) => { release = () => resolve(base.queryPage(ctx, p)); }); } }, { requestTimeoutMs: 15 });
  await assert.rejects(() => service.collect(args), code('tax_request_timeout'));
  assert.equal(capturedSignal.aborted, true); release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal([...service.records.values()].some((r) => r.complete), false);
});
test('scope verification has its own bounded timeout', async () => {
  const { service, args } = await setup({ verifyScope() { return new Promise(() => {}); } }, { requestTimeoutMs: 15 });
  await assert.rejects(() => service.verifySession({ sessionId: args.sessionId }), code('tax_request_timeout'));
});
test('newer acquisition wins over an older in-flight response for the same scope', async () => {
  let release, entered; let calls = 0; const pending = new Promise((resolve) => { entered = resolve; }); const base = adapter();
  const { service, args } = await setup({ queryPage(ctx, p) { const r = base.queryPage(ctx, p); if (++calls === 1) { entered(); return new Promise((resolve) => { release = () => resolve(r); }); } return r; } });
  const older = service.collect(args); await pending;
  const newer = await service.collect(args); release();
  await assert.rejects(() => older, code('tax_read_superseded'));
  const cov = await service.coverage({ sessionId: args.sessionId, period });
  assert.equal(cov.resources.find((r) => r.resource === resource).sourceRef, newer.sourceRef);
});
test('changing totals between pages refuses a complete snapshot', async () => {
  const { service, args } = await setup({ queryPage(ctx, p) { return { scopeRevision: 'synthetic-rev-1', httpStatus: 200, schemaValidated: true, businessCodeValidated: true, businessOk: true, enterpriseId: ctx.enterprise.enterpriseId, period: p.period,
    data: [{ taxType: `page-${p.page}` }], pagination: { page: p.page, pageSize: p.pageSize, total: p.page === 1 ? 2 : 3, hasMore: p.page === 1 } }; } });
  await assert.rejects(() => service.collect(args), code('tax_pagination_invalid'));
});
test('scope changed between completed calls cannot reuse earlier coverage or account link', async () => {
  const { gateway, service, args } = await setup();
  await service.collect(args);
  await service.linkAccountSet({ sessionId: args.sessionId, accountSetId: 7 });
  gateway.sessions.get(args.sessionId).enterprise = { enterpriseId: 'OTHER_SYNTHETIC_E2' };
  await assert.rejects(() => service.coverage({ sessionId: args.sessionId, period }), code('tax_scope_changed'));
  await assert.rejects(() => service.prepare({ sessionId: args.sessionId, period }), code('tax_scope_changed'));
});
test('a request delayed in initial scope verification cannot overtake a newer completed collection', async () => {
  let release, entered; let verifications = 0;
  const pending = new Promise((resolve) => { entered = resolve; }); const base = adapter();
  const { service, args } = await setup({ verifyScope(ctx) {
    const result = base.verifyScope(ctx);
    if (++verifications === 1) { entered(); return new Promise((resolve) => { release = () => resolve(result); }); }
    return result;
  } });
  const older = service.collect(args); await pending;
  const newer = await service.collect(args); release();
  await assert.rejects(() => older, code('tax_read_superseded'));
  const cov = await service.coverage({ sessionId: args.sessionId, period });
  assert.equal(cov.resources.find((r) => r.resource === resource).sourceRef, newer.sourceRef);
});
test('failed refresh at initial scope verification invalidates earlier successful coverage', async () => {
  let deny = false; const base = adapter();
  const { service, args } = await setup({ verifyScope(ctx) {
    return deny ? { businessOk: false, errorCode: 'permission_denied' } : base.verifyScope(ctx);
  } });
  await service.collect(args); deny = true;
  await assert.rejects(() => service.collect(args), code('tax_permission_denied'));
  deny = false;
  const cov = await service.coverage({ sessionId: args.sessionId, period });
  const record = cov.resources.find((r) => r.resource === resource);
  assert.equal(record.complete, false);
  assert.notEqual(record.status, 'success');
});
test('new authentication revision for the same company expires previously verified references', async () => {
  let revision = 'synthetic-rev-1'; const base = adapter();
  const { service, args } = await setup({ verifyScope(ctx) { return { ...base.verifyScope(ctx), scopeRevision: revision }; } });
  await service.collect(args); revision = 'synthetic-rev-2';
  await assert.rejects(() => service.coverage({ sessionId: args.sessionId, period }), code('tax_scope_changed'));
  await assert.rejects(() => service.prepare({ sessionId: args.sessionId, period }), code('tax_session_expired'));
});
for (const [method, extra] of [
  ['verifySession', {}], ['collect', { resource, period }], ['coverage', { period }],
  ['linkAccountSet', { accountSetId: 7 }], ['prepare', { period }],
]) test(`${method} rejects noncanonical session identifiers before adapter verification`, async () => {
  let verifications = 0; const base = adapter();
  const { service, args } = await setup({ verifyScope(ctx) { verifications++; return base.verifyScope(ctx); } });
  for (const sessionId of [undefined, null, 1, true, {}, [], '', ' ', ` ${args.sessionId}`, `${args.sessionId} `, `\t${args.sessionId}\n`]) {
    await assert.rejects(() => service[method]({ ...extra, sessionId }), code('tax_acquisition_input_invalid'));
  }
  assert.equal(verifications, 0);
});
test('whitespace session alias cannot start a refresh or create a separate coverage key', async () => {
  let deny = false, verifications = 0; const base = adapter();
  const { service, args } = await setup({ verifyScope(ctx) { verifications++; return deny ? { businessOk: false, errorCode: 'permission_denied' } : base.verifyScope(ctx); } });
  const first = await service.collect(args); const before = verifications; deny = true;
  await assert.rejects(() => service.collect({ ...args, sessionId: ` ${args.sessionId} ` }), code('tax_acquisition_input_invalid'));
  assert.equal(verifications, before, 'malformed input is not an attempted authenticated refresh');
  assert.equal(service.recordKeys.size, 1); deny = false;
  const cov = await service.coverage({ sessionId: args.sessionId, period });
  assert.equal(cov.resources.find((r) => r.resource === resource).sourceRef, first.sourceRef);
  // 作用域校验失败时，有效刷新仍会使该结果失效。
  deny = true;
  await assert.rejects(() => service.collect(args), code('tax_permission_denied')); deny = false;
  const after = await service.coverage({ sessionId: args.sessionId, period });
  assert.equal(after.resources.find((r) => r.resource === resource).complete, false);
});
test('whitespace alias cannot bypass a concurrent acquisition operation token', async () => {
  let release, entered, calls = 0; const base = adapter();
  const pending = new Promise((resolve) => { entered = resolve; });
  const { service, args } = await setup({ queryPage(ctx, p) { calls++; entered(); return new Promise((resolve) => { release = () => resolve(base.queryPage(ctx, p)); }); } });
  const collection = service.collect(args); await pending;
  await assert.rejects(() => service.collect({ ...args, sessionId: `${args.sessionId} ` }), code('tax_acquisition_input_invalid'));
  assert.equal(calls, 1); assert.equal(service.inflight.size, 1); release();
  const result = await collection;
  const cov = await service.coverage({ sessionId: args.sessionId, period });
  assert.equal(cov.resources.find((r) => r.resource === resource).sourceRef, result.sourceRef);
});

// 合成适配器键留在可信适配器/网关边界内。
async function setupRecordRows(rows, { explicit = true, rowsPerPage = 1 } = {}) {
  const base = adapter();
  return setup({
    readonlyEvidence: { [resource]: { ...base.readonlyEvidence[resource], ...(explicit ? { recordIdentity: 'adapter_key' } : {}) } },
    queryPage(ctx, p) {
      const start = (p.page - 1) * rowsPerPage;
      return { ...base.queryPage(ctx, p), data: rows.slice(start, start + rowsPerPage),
        pagination: { page: p.page, pageSize: p.pageSize, total: rows.length, hasMore: start + rowsPerPage < rows.length } };
    },
  });
}

test('explicit stable keys distinguish records whose legacy DTO fields are identical', async () => {
  const { service, args } = await setupRecordRows([
    { taxType: 'synthetic-tax', recordKey: 'PRIVATE_SYNTHETIC_KEY_A', effectiveTo: '2026-09-30' },
    { taxType: 'synthetic-tax', recordKey: 'PRIVATE_SYNTHETIC_KEY_B', effectiveTo: '2026-12-31' },
  ]);
  const result = await service.collect(args);
  assert.equal(result.count, 2); assert.equal(result.complete, true); assert.equal(result.pages, 2);
  const coverage = await service.coverage({ sessionId: args.sessionId, period });
  assert.equal(coverage.resources.find((r) => r.resource === resource).count, 2);
  assert.doesNotMatch(JSON.stringify({ result, coverage }), /PRIVATE_SYNTHETIC_KEY|recordKey/);
});

for (const rowsPerPage of [1, 2]) {
  for (const conflicting of [false, true]) {
    test(`explicit key ${conflicting ? 'conflict' : 'duplicate'} fails closed ${rowsPerPage === 1 ? 'across pages' : 'within a page'}`, async () => {
      const rows = [{ taxType: 'synthetic-tax', recordKey: 'PRIVATE_SYNTHETIC_DUPLICATE_KEY', status: 'active' }];
      const { service, args } = await setupRecordRows(rows, { rowsPerPage });
      await service.collect(args);
      rows.push({ ...rows[0], status: conflicting ? 'inactive' : 'active' });
      await assert.rejects(() => service.collect(args), (error) => {
        assert.equal(error.code, conflicting ? 'tax_record_conflict' : 'tax_pagination_duplicate');
        assert.doesNotMatch(`${error.message}\n${error.stack}\n${JSON.stringify(error)}`, /PRIVATE_SYNTHETIC_DUPLICATE_KEY/);
        return true;
      });
      const coverage = await service.coverage({ sessionId: args.sessionId, period });
      const result = coverage.resources.find((r) => r.resource === resource);
      assert.equal(result.complete, false); assert.equal(result.count, null);
      assert.equal(result.status, 'failed'); assert.equal(result.sourceRef, null);
      assert.equal(result.errorCode, conflicting ? 'tax_record_conflict' : 'tax_pagination_duplicate');
      assert.doesNotMatch(JSON.stringify(coverage), /PRIVATE_SYNTHETIC_DUPLICATE_KEY|recordKey/);
    });
  }
}

test('explicit keys allow distinct filing versions chosen by the adapter', async () => {
  const { service, args } = await setupRecordRows([
    { taxType: 'synthetic-tax', recordKey: 'synthetic-record:original', status: 'accepted' },
    { taxType: 'synthetic-tax', recordKey: 'synthetic-record:correction-1', status: 'accepted' },
  ]);
  const result = await service.collect(args);
  assert.equal(result.count, 2); assert.equal(result.complete, true);
});

test('explicit key validation rejects missing, invalid and inherited keys without falling back', async () => {
  const badRows = [
    { taxType: 'synthetic-tax' },
    ...[undefined, null, 3, false, {}, [], '', ' ', ' leading', 'trailing ', 'line\nbreak', 'null\0byte', 'delete\x7f', 'control\x85', 'x'.repeat(257)]
      .map((recordKey) => ({ taxType: 'synthetic-tax', recordKey })),
    Object.assign(Object.create({ recordKey: 'PRIVATE_SYNTHETIC_INHERITED_KEY' }), { taxType: 'synthetic-tax' }),
  ];
  for (const row of badRows) {
    const { service, args } = await setupRecordRows([row]);
    await assert.rejects(() => service.collect(args), code('tax_record_key_invalid'));
    const coverage = await service.coverage({ sessionId: args.sessionId, period });
    const result = coverage.resources.find((r) => r.resource === resource);
    assert.equal(result.complete, false); assert.equal(result.count, null);
  }
});

test('explicit key length boundary is accepted and a later missing key invalidates all pages', async () => {
  const rows = [{ taxType: 'synthetic-tax', recordKey: 'x'.repeat(256) }];
  const { service, args } = await setupRecordRows(rows);
  assert.equal((await service.collect(args)).count, 1);
  rows.push({ taxType: 'other-synthetic-tax' });
  await assert.rejects(() => service.collect(args), code('tax_record_key_invalid'));
  const coverage = await service.coverage({ sessionId: args.sessionId, period });
  assert.equal(coverage.resources.find((r) => r.resource === resource).count, null);
});

test('legacy adapters retain DTO-content identity even if rows contain recordKey', async () => {
  const duplicate = await setupRecordRows([
    { taxType: 'synthetic-tax', recordKey: 'A' },
    { taxType: 'synthetic-tax', recordKey: 'B' },
  ], { explicit: false });
  await assert.rejects(() => duplicate.service.collect(duplicate.args), code('tax_pagination_duplicate'));
  const distinct = await setupRecordRows([
    { taxType: 'synthetic-tax', recordKey: 'A', status: 'active' },
    { taxType: 'synthetic-tax', recordKey: 'A', status: 'inactive' },
  ], { explicit: false });
  assert.equal((await distinct.service.collect(distinct.args)).count, 2);
});

test('unknown record identity contracts cannot silently downgrade to legacy mode', () => {
  for (const recordIdentity of [undefined, null, '', 'adapter_keey', 'PRIVATE_SYNTHETIC_BAD_MODE', true, {}, []]) {
    const gateway = new TaxGateway();
    const base = adapter();
    assert.throws(() => gateway.registerAdapter(adapter({
      readonlyEvidence: { [resource]: { ...base.readonlyEvidence[resource], recordIdentity } },
    })), (error) => {
      assert.equal(error.code, 'tax_adapter_invalid');
      assert.doesNotMatch(`${error.message}\n${JSON.stringify(error)}`, /PRIVATE_SYNTHETIC_BAD_MODE/);
      return true;
    });
    assert.equal(gateway.listRegions().summary.adaptersTotal, 0);
  }
});

test('explicit record keys cannot bypass the existing read-only evidence gate', async () => {
  let calls = 0;
  const base = adapter();
  const { service, args } = await setup({
    readonlyEvidence: { [resource]: { ...base.readonlyEvidence[resource], sideEffectFree: false, recordIdentity: 'adapter_key' } },
    queryPage() { calls++; },
  });
  await assert.rejects(() => service.collect(args), code('tax_resource_unsupported'));
  assert.equal(calls, 0);
});
