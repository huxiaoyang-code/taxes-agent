import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { inspectDownloadContractShape as inspect } from '../server/tax-download-contract-shape.mjs';

// Only synthetic component strings and synthetic observed keys. No private I/O.
const keys = ['Skssqq', 'Skssqz', 'PageNum', 'PageSize', 'reportType', 'status', 'category'];
const body = '{Skssqq:row.start,Skssqz:row.end,PageNum:1,PageSize:20,reportType:row.kind,status:row.status,category:row.category}';
const schema = (fields = [], complete = false) => ({ fields, complete, schemaOnly: true,
  evidence: 'static_candidate', readOnlyVerified: false, navigationTemplateAuthorized: false });
const withoutFieldSchema = out => out.routerCandidates.map(({ queryFieldSchema, ...route }) => route);
const closed = out => {
  for (const key of ['requestAuthorized', 'enterpriseBinding', 'consumable', 'readOnlyVerified']) assert.equal(out[key], false);
};
const omitted = (out, ...values) => { for (const value of values) assert.ok(!JSON.stringify(out).includes(value)); };

test('requires explicit parser capability without loading source or keys into error output', () => {
  const module = new URL('../server/tax-download-contract-shape.mjs', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import {inspectDownloadContractShape as i} from ${JSON.stringify(module)};console.log(JSON.stringify(i('const a={}',${JSON.stringify(keys)})))`],
  { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } });
  assert.equal(child.status, 0); const out = JSON.parse(child.stdout);
  assert.equal(out.status, 'parser_unavailable'); assert.equal(out.bodyShapeBound, false); closed(out);
});

test('binds the complete direct shape case-insensitively and returns names only', () => {
  const source = `function f(){return ${body};}`;
  const out = inspect(source, keys.map(key => key.toLowerCase()));
  assert.equal(out.status, 'inspected'); assert.equal(out.bodyShapeBound, true);
  assert.deepEqual(out.bodyFields, keys.map(name => ({ name, observedBodyKeyBound: true })));
  assert.equal(out.bodyCandidateCount, 1); closed(out);
  omitted(out, 'row.start', 'row.end', 'row.kind', 'row.category');
});

test('direct ASCII string keys bind while body values and expression sentinels never escape', () => {
  const secret = 'SENTINEL_BUSINESS_VALUE_913500001234567890';
  const source = `const f={${keys.map(key => `${JSON.stringify(key)}:'${secret}'`).join(',')}};`;
  const out = inspect(source, keys); assert.equal(out.bodyShapeBound, true); omitted(out, secret);
});

test('incomplete, extra and duplicate-case shapes return fixed placeholders', () => {
  for (const source of [body.replace(',category:row.category', ''), body.replace('category:row.category', 'SYNTHETIC_UNMATCHED_FIELD:1'),
    body.replace('}', ',SYNTHETIC_UNMATCHED_FIELD:1}'), body.replace('category:row.category', 'skssqq:1')]) {
    const out = inspect(`const value=${source}`, keys); assert.equal(out.bodyShapeBound, false);
    assert.deepEqual(out.bodyFields.map(field => field.name), keys.map((_, i) => `field_${i + 1}`));
    assert.ok(out.bodyFields.every(field => field.observedBodyKeyBound === false));
    omitted(out, 'row.category', 'SYNTHETIC_UNMATCHED_FIELD');
  }
});

test('multiple otherwise matching objects are ambiguous rather than selecting a guessed producer', () => {
  const out = inspect(`const a=${body};const b=${body}`, keys);
  assert.equal(out.bodyCandidateCount, 2); assert.equal(out.bodyShapeBound, false);
  assert.ok(out.bodyFields.every(field => field.observedBodyKeyBound === false));
});

test('spread, computed keys, methods and accessors cannot establish an object binding', () => {
  const shapes = [body.replace('category:row.category', '...row'), body.replace('category:row.category', '["category"]:1'),
    body.replace('category:row.category', 'category(){}'), body.replace('category:row.category', 'get category(){return 1}')];
  for (const shape of shapes) assert.equal(inspect(`const a=${shape}`, keys).bodyShapeBound, false);
});

test('observed key input must be exactly seven safe unique names', () => {
  const invalid = [null, {}, keys.slice(0, 6), [...keys, 'extra'], [...keys.slice(0, 6), 'skssqq'],
    [...keys.slice(0, 6), 'accessToken'], [...keys.slice(0, 6), '913500001234567890'],
    [...keys.slice(0, 6), '550e8400-e29b-41d4-a716-446655440000'],
    [...keys.slice(0, 6), 'abcd1234abcd1234'], [...keys.slice(0, 6), 'x'.repeat(41)], [...keys.slice(0, 6), '企业名称']];
  for (const observed of invalid) {
    const out = inspect(`const a=${body}`, observed); assert.equal(out.status, 'invalid_observed_keys');
    assert.deepEqual(out.observedBodyFields, []);
    assert.equal(out.bodyShapeBound, false); omitted(out, 'accessToken', '913500001234567890', '企业名称');
  }
});

test('only exact router.resolve and this.$router.resolve bind literal path to direct query keys', () => {
  const secret = 'SENTINEL_ROUTE_QUERY_VALUE';
  const out = inspect(`const a=router.resolve({path:'/reports/v1/detail',query:{sbuuid:'${secret}',yzpzzlDm:row.type,skssqq:row.start,skssqz:row.end}}).href;
    window.open(a); this.$router.resolve({path:'/cwbb/detail',query:{id:row.id}});`, keys);
  assert.deepEqual(withoutFieldSchema(out), [
    { path: '/reports/v1/detail', queryKeys: ['sbuuid', 'yzpzzlDm', 'skssqq', 'skssqz'], staticQueryObjectBound: true,
      querySchemaComplete: true, navigationTemplateAuthorized: false },
    { path: '/cwbb/detail', queryKeys: ['id'], staticQueryObjectBound: true,
      querySchemaComplete: true, navigationTemplateAuthorized: false }]);
  omitted(out, secret, 'row.type', 'row.start', 'window.open'); closed(out);
});

test('dynamic route shapes and unrelated literals or receivers do not become route findings', () => {
  const sources = [
    `other.resolve({path:'/reports/detail',query:{id:1}})`,
    `this.router.resolve({path:'/reports/detail',query:{id:1}})`,
    `router['resolve']({path:'/reports/detail',query:{id:1}})`,
    `router.resolve(row)`, `router.resolve({path:row.path,query:{id:1}})`,
    'router.resolve({path:`/reports/detail`,query:{id:1}})',
    `router.resolve({path:'/reports/detail',query:{id:1},other:1})`,
    `router.resolve({path:'/reports/detail',query:{id:1}},row)`,
    `const text="router.resolve({path:'/reports/detail',query:{id:1}})";`,
    `const x='/reports/detail';`];
  for (const source of sources) {
    const out = inspect(source, keys); assert.deepEqual(out.routerCandidates, [], source);
    omitted(out, '/reports/detail', 'SENTINEL_SECRET');
  }
});

test('strict static path candidates are independent of incomplete query schema and cannot become navigation templates', () => {
  const queries = ['row', '{...row}', '{["SENTINEL_DYNAMIC_KEY"]:"SENTINEL_BUSINESS_VALUE"}',
    '{id:1,ID:2}', '{accessToken:"SENTINEL_BUSINESS_VALUE"}',
    '{get SENTINEL_ACCESSOR(){return "SENTINEL_BUSINESS_VALUE"}}'];
  for (const query of queries) {
    const out = inspect(`this.$router.resolve({path:'/reports/detail',query:${query}})`, keys);
    assert.deepEqual(withoutFieldSchema(out), [{ path: '/reports/detail', queryKeys: [],
      staticQueryObjectBound: false, querySchemaComplete: false, navigationTemplateAuthorized: false }]);
    assert.equal(out.diagnostics.resolve.rejected.queryShape, 1);
    omitted(out, 'SENTINEL_DYNAMIC_KEY', 'SENTINEL_BUSINESS_VALUE', 'SENTINEL_ACCESSOR', 'accessToken'); closed(out);
  }
  for (const source of [
    `SENTINEL_ALIAS.resolve({path:'/reports/detail',query:row})`,
    `this.$router.resolve({path:row.path,query:row})`,
    `this.$router.resolve({path:'/reports/2026/detail',query:row})`,
    `this.$router.resolve({path:'/reports/detail',query:row,...row})`,
  ]) {
    const out = inspect(source, keys); assert.deepEqual(out.routerCandidates, []);
    omitted(out, '/reports/detail', '/reports/2026/detail', 'SENTINEL_ALIAS');
  }
});

test('route guards reject credentials, actions, URL syntax, traversal, IDs and size excesses', () => {
  const paths = ['https://example.test/reports/detail', '//example.test/detail', '/reports/detail?secret=1',
    '/reports/detail#secret', '/reports/%64etail', '/reports/../detail', '/reports\\detail',
    '/reports/submit', '/reports/delete', '/reports/auth', '/reports/accessToken', '/reports/login',
    '/reports/913500001234567890', '/reports/550e8400-e29b-41d4-a716-446655440000',
    '/reports/abcd1234abcd1234', `/reports/${'a'.repeat(41)}`, '/a/b/c/d/e/f/g/h/i/j/k', '/reports//detail'];
  for (const path of paths) {
    const out = inspect(`router.resolve({path:${JSON.stringify(path)},query:{id:1}})`, keys);
    assert.deepEqual(out.routerCandidates, [], path); omitted(out, path);
  }
});

test('pure numeric route segments cannot expose a year or short business ID', () => {
  for (const segment of ['1', '12', '123', '1234', '2026']) {
    const path = `/reports/${segment}/detail`;
    const out = inspect(`router.resolve({path:${JSON.stringify(path)},query:{id:1}})`, keys);
    assert.deepEqual(out.routerCandidates, []); omitted(out, path);
  }
});

test('objects over 32 keys fail closed and output leaves remain bounded', () => {
  const oversized = Array.from({ length: 33 }, (_, i) => `key${i}:1`).join(',');
  const out = inspect(`const x={${oversized}};router.resolve({path:'/report/detail',query:{${oversized}}});
    ${'router.resolve({path:"/report/detail",query:{id:1}});'.repeat(40)}`, keys);
  assert.equal(out.truncated, true);
  assert.ok(out.bodyFields.length + out.observedBodyFields.length
    + out.routerCandidates.reduce((n, route) => n + 1 + route.queryKeys.length, 0) <= 32);
  omitted(out, 'key32');
});

test('parse and AST limits discard findings and never include errors or source', () => {
  for (const source of [null, {}, 42]) assert.equal(inspect(source, keys).status, 'invalid_source');
  const bad = inspect('function SENTINEL_PARSE_SECRET ( {', keys);
  assert.equal(bad.status, 'parse_error'); omitted(bad, 'SENTINEL_PARSE_SECRET');
  assert.equal(inspect('x'.repeat(4_000_001), keys).status, 'source_limit');
  const limited = inspect(`const x=${body};` + ';'.repeat(160_000), keys);
  assert.equal(limited.status, 'ast_limit'); assert.equal(limited.bodyShapeBound, false);
  assert.deepEqual(limited.routerCandidates, []);
  assert.ok(limited.bodyFields.every(field => field.observedBodyKeyBound === false));
});

test('source is never executed and does not return function text or source hashes', () => {
  globalThis.SENTINEL_SHAPE_EXECUTION = false;
  const out = inspect(`globalThis.SENTINEL_SHAPE_EXECUTION=true;throw new Error('SENTINEL_ERROR');const a=${body};`, keys);
  assert.equal(globalThis.SENTINEL_SHAPE_EXECUTION, false); delete globalThis.SENTINEL_SHAPE_EXECUTION;
  omitted(out, 'SENTINEL_SHAPE_EXECUTION', 'SENTINEL_ERROR', 'function', 'hash', 'digest'); closed(out);
});

test('fixed body diagnostics explain intersection and exact case without revealing unmatched keys', () => {
  const out = inspect(`const value={skssqq:1,skssqz:2,pageNum:3,pageSize:4,
    SYNTHETIC_UNMATCHED_A:5,SYNTHETIC_UNMATCHED_B:6,SYNTHETIC_UNMATCHED_C:7};`, keys);
  assert.equal(out.bodyShapeBound, false);
  assert.deepEqual(out.diagnostics.body, { intersectionHistogram: [0, 0, 0, 0, 1, 0, 0, 0],
    maximumIntersection: 4, maximumCandidateCount: 1, keyCountMin: 7, keyCountMax: 7, exactCaseIntersectionMax: 0,
    rejectedAtMaximum: { spread: false, computed: false, methodOrAccessor: false,
      unsafeKey: false, caseCollision: false, over32: false, keySetMismatch: true } });
  omitted(out, 'SYNTHETIC_UNMATCHED_A', 'SYNTHETIC_UNMATCHED_B', 'SYNTHETIC_UNMATCHED_C', 'skssqq');
});

test('safe observed DTO key metadata is independent of static binding and never carries values', () => {
  for (const source of ['const payload={unrelated:1};', 'function ( {']) {
    const out = inspect(source, keys);
    assert.equal(out.bodyShapeBound, false);
    assert.deepEqual(out.observedBodyFields, keys.map(name => ({ name, evidence: 'observed_request_metadata', schemaOnly: true })));
    assert.ok(out.bodyFields.every(field => field.observedBodyKeyBound === false));
    omitted(out, 'unrelated'); closed(out);
  }
  const invalid = inspect(`const a=${body}`, [...keys.slice(0, 6), 'BearerCredential']);
  assert.deepEqual(invalid.observedBodyFields, []); omitted(invalid, 'BearerCredential', 'Skssqq');
});

test('body diagnostics reject shapes without relaxing the seven-key gate', () => {
  const cases = [
    [body.replace('}', ',...row}'), 'spread'],
    [body.replace('category:row.category', '["category"]:1'), 'computed'],
    [body.replace('category:row.category', 'category(){}'), 'methodOrAccessor'],
    [body.replace('category:row.category', 'accessToken:1'), 'unsafeKey'],
    [body.replace('category:row.category', 'skssqq:1'), 'caseCollision'],
    [body.replace('}', ',' + Array.from({ length: 26 }, (_, i) => `extra${i}:1`).join(',') + '}'), 'over32'],
  ];
  for (const [shape, reason] of cases) {
    const out = inspect(`const value=${shape}`, keys);
    assert.equal(out.bodyShapeBound, false); assert.equal(out.diagnostics.body.rejectedAtMaximum[reason], true, reason);
    omitted(out, 'accessToken', 'extra25', 'row.category');
  }
});

test('resolve diagnostics classify aliases and reject causes without emitting their names or unbound path', () => {
  const source = `SYNTHETIC_OWNER_ALIAS.resolve({path:'/reports/detail',query:{id:'SENTINEL_QUERY_VALUE'}});
    SYNTHETIC_MEMBER_ALIAS.$router.resolve({path:'/reports/detail',query:{id:1}});
    router['resolve']({path:'/reports/detail',query:{id:1}});
    router.resolve(row);this.$router.resolve({path:row.path,query:row});
    router.resolve({path:'/reports/2026/detail',query:{id:1}});`;
  const out = inspect(source, keys);
  assert.deepEqual(out.routerCandidates, []);
  assert.deepEqual(out.diagnostics.resolve.ownerKinds, { router_identifier: 2, this_router: 1,
    identifier_alias: 1, router_member_alias: 1, computed: 1, other: 0 });
  assert.deepEqual(out.diagnostics.resolve.rejected, { notExactOwner: 3, argumentShape: 1,
    objectShape: 0, pathNotLiteral: 1, pathRejected: 1, queryShape: 1 });
  omitted(out, 'SYNTHETIC_OWNER_ALIAS', 'SYNTHETIC_MEMBER_ALIAS', 'SENTINEL_QUERY_VALUE', '/reports/detail', '/reports/2026/detail');
});

test('high-density objects do not crowd out maximum-intersection diagnostics or grow diagnostic output', () => {
  const noise = 'const x={SENTINEL_BUSINESS_KEY:"SENTINEL_BUSINESS_VALUE"};';
  const source = `{${noise.repeat(400).replaceAll('const x=', 'void ')}}const actual=${body};`;
  const out = inspect(source, keys); assert.equal(out.status, 'inspected'); assert.equal(out.bodyShapeBound, true);
  assert.equal(out.diagnostics.body.intersectionHistogram[0], 400);
  assert.equal(out.diagnostics.body.intersectionHistogram[7], 1);
  assert.equal(out.diagnostics.body.maximumIntersection, 7);
  assert.equal(out.diagnostics.body.maximumCandidateCount, 1);
  assert.equal(out.diagnostics.body.exactCaseIntersectionMax, 7);
  const leaves = value => value && typeof value === 'object' ? Object.values(value).reduce((sum, item) => sum + leaves(item), 0) : 1;
  assert.equal(leaves(out.diagnostics), 32);
  omitted(out, 'SENTINEL_BUSINESS_KEY', 'SENTINEL_BUSINESS_VALUE');
  const limited = inspect(source + ';'.repeat(160_000), keys);
  assert.equal(limited.status, 'ast_limit');
  assert.ok(limited.diagnostics.body.intersectionHistogram.every(count => count === 0));
});

test('detail query field schema permits only fixed token metadata without disclosing credential values', () => {
  const out = inspect(`function detail(SYNTHETIC_PARAMETER_ALIAS){this.$router.resolve({path:'/reports/detail',query:{
    token:'SENTINEL_CREDENTIAL_VALUE',sbuuid:SYNTHETIC_PARAMETER_ALIAS.sbuuid,
    yzpzzlDm:SYNTHETIC_PARAMETER_ALIAS.yzpzzlDm,current:sessionState.current}})}`, keys);
  const route = out.routerCandidates[0];
  assert.deepEqual(route.queryKeys, []); assert.equal(route.staticQueryObjectBound, false);
  assert.equal(route.querySchemaComplete, false); assert.equal(route.navigationTemplateAuthorized, false);
  assert.deepEqual(route.queryFieldSchema, schema([
    { name: 'token', credentialField: true, sourceKind: 'static_literal' },
    { name: 'sbuuid', credentialField: false, sourceKind: 'parameter_property', sourceProperty: 'sbuuid' },
    { name: 'yzpzzlDm', credentialField: false, sourceKind: 'parameter_property', sourceProperty: 'yzpzzlDm' },
    { name: 'current', credentialField: false, sourceKind: 'dynamic_unknown' },
  ], true));
  omitted(out, 'SENTINEL_CREDENTIAL_VALUE', 'SYNTHETIC_PARAMETER_ALIAS', 'sessionState', 'current_session'); closed(out);
});

test('query values expose only literal, nearest direct parameter property or unknown syntax categories', () => {
  const out = inspect(`function outer(SYNTHETIC_OUTER){return function inner(SYNTHETIC_INNER){
    router.resolve({path:'/reports/detail',query:{token:window.secretToken,
      first:SYNTHETIC_OUTER.sbuuid,second:SYNTHETIC_INNER.sbuuid,third:SYNTHETIC_INNER['SENTINEL_COMPUTED_PROPERTY'],
      fourth:SYNTHETIC_INNER.accessToken,fifth:unknownFunction('SENTINEL_ARGUMENT_VALUE')}})}}`, keys);
  const fields = out.routerCandidates[0].queryFieldSchema.fields;
  assert.deepEqual(fields.map(field => field.sourceKind), ['dynamic_unknown', 'dynamic_unknown', 'parameter_property',
    'dynamic_unknown', 'dynamic_unknown', 'dynamic_unknown']);
  assert.equal(fields[2].sourceProperty, 'sbuuid');
  omitted(out, 'SYNTHETIC_OUTER', 'SYNTHETIC_INNER', 'secretToken', 'SENTINEL_COMPUTED_PROPERTY',
    'accessToken', 'unknownFunction', 'SENTINEL_ARGUMENT_VALUE');
});

test('shadowed, reassigned, destructured and default parameters are conservatively unknown', () => {
  const sources = [
    `function f(row){{let row;router.resolve({path:'/reports/detail',query:{token:row.sbuuid}})}}`,
    `function f(row){router.resolve({path:'/reports/detail',query:{token:row.sbuuid}});row=other;}`,
    `function f({row}){router.resolve({path:'/reports/detail',query:{token:row.sbuuid}})}`,
    `function f(row={}){router.resolve({path:'/reports/detail',query:{token:row.sbuuid}})}`,
    `function f(row){try{}catch({row}){router.resolve({path:'/reports/detail',query:{token:row.sbuuid}})}}`,
    `function f(row){eval('SENTINEL_NOT_EXECUTED');router.resolve({path:'/reports/detail',query:{token:row.sbuuid}})}`,
  ];
  for (const source of sources) {
    const out = inspect(source, keys), field = out.routerCandidates[0].queryFieldSchema.fields[0];
    assert.equal(field.sourceKind, 'dynamic_unknown'); assert.equal(Object.hasOwn(field, 'sourceProperty'), false);
    omitted(out, 'SENTINEL_NOT_EXECUTED');
  }
  const arrow = inspect(`const f=row=>router.resolve({path:'/reports/detail',query:{token:row.sbuuid}})`, keys);
  assert.equal(arrow.routerCandidates[0].queryFieldSchema.fields[0].sourceKind, 'parameter_property');
});

test('detail query schema rejects the entire object on unsafe structure or names', () => {
  const queries = ['{token:1,...row}', '{token:1,["SENTINEL_DYNAMIC_QUERY_KEY"]:2}',
    '{token:1,get SENTINEL_ACCESSOR(){return "SENTINEL_VALUE"}}', '{token(){}}',
    '{token:1,Token:2}', '{token:1,accessToken:"SENTINEL_VALUE"}',
    '{token:1,"913500001234567890":2}', '{token:1,abcd1234abcd1234:2}',
    '{token:1,' + 'a'.repeat(41) + ':2}',
    '{token:1,' + Array.from({ length: 16 }, (_, i) => `field${i}:1`).join(',') + '}'];
  for (const query of queries) {
    const out = inspect(`router.resolve({path:'/reports/detail',query:${query}})`, keys);
    assert.deepEqual(out.routerCandidates[0].queryFieldSchema, schema());
    omitted(out, 'SENTINEL_DYNAMIC_QUERY_KEY', 'SENTINEL_ACCESSOR', 'SENTINEL_VALUE', 'accessToken', '913500001234567890');
  }
});

test('query schema output is bounded without altering original route selection or authority', () => {
  const out = inspect('router.resolve({path:"/reports/detail",query:{token:"SENTINEL_VALUE"}});'.repeat(40), keys);
  assert.equal(out.routerCandidates.length, 18); // Original 32-name budget minus body/observed fields.
  assert.equal(out.truncated, true);
  let fieldCount = 0, names = out.bodyFields.length + out.observedBodyFields.length;
  for (const route of out.routerCandidates) {
    assert.deepEqual(route.queryKeys, []); assert.equal(route.querySchemaComplete, false);
    assert.equal(route.staticQueryObjectBound, false); assert.equal(route.navigationTemplateAuthorized, false);
    fieldCount += route.queryFieldSchema.fields.length;
    names += 1 + route.queryKeys.length + route.queryFieldSchema.fields.reduce((n, f) => n + 1 + (f.sourceProperty ? 1 : 0), 0);
  }
  assert.ok(fieldCount <= 16); assert.ok(names <= 32); omitted(out, 'SENTINEL_VALUE');
});
