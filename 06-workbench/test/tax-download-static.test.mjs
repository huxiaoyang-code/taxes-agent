import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { inspectDownloadSource } from '../server/tax-download-static.mjs';

// 所有来源均为合成数据；此处绝不加载私有采集的 JS 或税务数据。
const inspect = source => {
  const result = inspectDownloadSource(source);
  assert.equal(result.status, 'inspected');
  assert.equal(result.requestAuthorized, false);
  assert.equal(result.analysis, 'static_candidates_only');
  return result;
};

test('requires explicit parser capability, failing closed without the flag', () => {
  const url = new URL('../server/tax-download-static.mjs', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `import {inspectDownloadSource} from ${JSON.stringify(url)}; console.log(JSON.stringify(inspectDownloadSource('fetch("/szzh/export")')))`], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } });
  assert.equal(child.status, 0);
  const result = JSON.parse(child.stdout);
  assert.equal(result.status, 'parser_unavailable');
  assert.deepEqual(result.calls, []);
  assert.deepEqual(result.paths, []);
});

test('finds API location, method, body/query keys and history/detail candidates', () => {
  const source = `function getDetail(row) {
    return request('/szzh/DescribeSbmxcx2', {method:'POST', body:{gzlx:row.gzlx, sbuuid:row.sbuuid}, params:{pageNum:1}})
      .then(response => getDetails(response.Data));
  }
  const getDetails = data => fetch('/szc/report/detail', {method:'GET', params:{id:data.id}});
  getDetail(row);`;
  const result = inspect(source);
  assert.equal(result.functions.length, 3);
  assert.equal(result.calls.length, 5);
  const request = result.calls.find(c => c.technicalTail === 'request');
  assert.deepEqual(request.arguments[0], { index: 0, kind: 'static_path', path: '/szzh/DescribeSbmxcx2' });
  assert.deepEqual(request.arguments[1].methods, ['POST']);
  assert.ok(request.signals.includes('history_query'));
  assert.deepEqual(request.arguments[1].objects, [
    { key: 'body', keys: ['gzlx', 'sbuuid'], unknownKeys: 0 },
    { key: 'params', keys: ['pageNum'], unknownKeys: 0 },
  ]);
  assert.equal(source.slice(request.location.start, request.location.start + 7), 'request');
  assert.ok(result.calls.find(c => c.technicalTail === 'getDetails').signals.includes('detail'));
  assert.equal(result.links.filter(l => l.kind === 'lexical_binding_candidate').length, 2);
  assert.equal(result.links.filter(l => l.kind === 'callback_syntax_candidate').length, 1);
});

test('links multiple lexical consumers and callbacks without claiming a full runtime graph', () => {
  const result = inspect(`function downloadFile(row){return fetch('/dppt/invoice/download').then(response=>response.blob()).then(data=>saveAs(new Blob([data]), 'private-name.xlsx'));}
    function getDetail(row){downloadFile(row); downloadFile(row); router.push({path:'/kpfw/invoice/detail',query:{id:row.id,sbuuid:row.sbuuid}});}
    getDetail(row);`);
  assert.equal(result.links.filter(l => l.kind === 'lexical_binding_candidate').length, 3);
  assert.equal(result.calls.filter(c => c.technicalTail === 'downloadFile').length, 2);
  assert.ok(result.calls.find(c => c.technicalTail === 'blob').signals.includes('binary'));
  assert.ok(result.calls.find(c => c.technicalTail === 'Blob').signals.includes('binary'));
  assert.ok(result.calls.find(c => c.technicalTail === 'saveAs').signals.includes('download'));
  assert.ok(result.calls.find(c => c.technicalTail === 'push').signals.includes('routing'));
  assert.ok(!JSON.stringify(result).includes('private-name'));
});

test('does not parse comments, source strings, regex or template text into calls', () => {
  const source = [
    `// fetch('/szzh/download')`,
    `/* saveAs('/dppt/export') */`,
    `const text = "getDetail('/szc/report/detail')";`,
    'const data = `downloadFile("/kpfw/export") ${row.id}`;',
    String.raw`const query = /fetch\(['"]\/szzh\/download/;`,
    `fetch('/dppt/invoice/query');`,
  ].join('\n');
  const result = inspect(source);
  assert.equal(result.calls.length, 1);
  assert.deepEqual(result.paths.map(p => p.path), ['/dppt/invoice/query']);
});

test('actual expression inside template is analyzed, template-derived paths remain unknown', () => {
  const result = inspect('const path = `/szzh/${getDetail(row)}`; fetch(`/dppt/invoice/${row.id}`);');
  assert.equal(result.calls.length, 2);
  assert.equal(result.paths.length, 0);
  assert.equal(result.calls.find(c => c.technicalTail === 'fetch').arguments[0].kind, 'unknown');
});

test('leakage sentinels cannot escape through literals, names, object keys, headers or unsafe paths', () => {
  const secrets = ['SENTINEL_IDENTIFIER_SECRET', 'SENTINEL_PROPERTY_SECRET', 'SENTINEL_HEADER_SECRET', 'SENTINEL_LITERAL_SECRET', '913500001234567890', '100000000000000000000000000', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJTRUNSRVQifQ.signature', '550e8400-e29b-41d4-a716-446655440000', 'randomResourceSecret'];
  const source = `function ${secrets[0]}(){
    request('/szzh/export?token=${secrets[3]}', {headers:{'${secrets[2]}':'${secrets[6]}'}, data:{'${secrets[1]}':'${secrets[4]}',nsrsbh:'${secrets[4]}',amount:${secrets[5]}}});
    fetch('/szzh/${secrets[7]}'); fetch('/dppt/${secrets[8]}'); fetch('/szc/${secrets[4]}');
    window['${secrets[1]}']('${secrets[3]}');
    response.headers.get('content-disposition');
  } ${secrets[0]}();`;
  const result = inspect(source), json = JSON.stringify(result);
  for (const secret of secrets) assert.ok(!json.includes(secret), `must omit synthetic sentinel ${secret}`);
  assert.deepEqual(result.paths, []);
  assert.ok(result.unknown.names > 0);
  assert.ok(result.unknown.paths >= 4);
  assert.ok(result.calls.some(c => c.signals.includes('content_disposition')));
});

test('paths use a finite technical segment vocabulary and reject URL/query/hash/escaped separators', () => {
  const paths = ['/szzh/invoice/export', '/szc/report/detail/', '/kpfw/queryList', '/dppt/downloadFile',
    '/szzh/export?x=1', '/szzh/export#secret', '/szzh/SECRET', '/evil/export', '/szzh/123',
    'https://example.test/szzh/export', '//szzh/export', '/szzh/../export', '/szzh/export%2Fsecret'];
  const result = inspect(paths.map(p => `fetch(${JSON.stringify(p)});`).join('\n'));
  assert.deepEqual(result.paths.map(p => p.path), paths.slice(0, 4));
});

test('dynamic fields, spread arguments, aliases and dynamic dispatch stay unknown', () => {
  const result = inspect(`function getDetail(row) { request(row.path, {data:{[row.id]:row.name, ...row}}); row[row.method](...row.args); }
    const downloadFile = getDetail; downloadFile(row); getDetail(row);`);
  assert.ok(result.unknown.dynamicProperties > 0);
  assert.ok(result.unknown.objectKeys >= 2);
  assert.ok(result.unknown.dynamicArguments > 0);
  assert.equal(result.links.filter(l => l.kind === 'lexical_binding_candidate').length, 1);
});

test('resolves lexical shadowing and refuses reassigned function bindings', () => {
  const result = inspect(`function getDetail(){}; function downloadFile(getDetail){ getDetail(); }
    {const getDetail = ()=>fetch('/szzh/report/detail'); getDetail();}
    getDetail(); downloadFile = row.method; downloadFile();`);
  const edges = result.links.filter(l => l.kind === 'lexical_binding_candidate');
  assert.equal(edges.length, 2);
  assert.notEqual(edges[0].toFunctionId, edges[1].toFunctionId);
  assert.equal(result.calls.filter(c => c.technicalTail === 'downloadFile').length, 1);
});

test('fixed Chinese labels survive while arbitrary UI/business text is suppressed', () => {
  const result = inspect(`const routes=[{label:'财务报表',title:'查看详情',name:'某企业私密名称',path:'/szc/report/detail'}];`);
  assert.deepEqual(result.labels.map(x => x.label), ['财务报表', '查看详情']);
  assert.ok(!JSON.stringify(result).includes('某企业'));
});

test('input failures never include parser messages or the invalid source', () => {
  for (const value of [null, {}, 42]) assert.equal(inspectDownloadSource(value).status, 'invalid_source');
  const result = inspectDownloadSource('function SENTINEL_PARSE_SECRET ( {');
  assert.equal(result.status, 'parse_error');
  assert.ok(!JSON.stringify(result).includes('SENTINEL'));
  assert.equal(inspectDownloadSource('x'.repeat(4_000_001)).status, 'source_limit');
});

test('bounded output reports truncation for a large valid synthetic source', () => {
  const result = inspect(`fetch('/szzh/export');`.repeat(300));
  assert.equal(result.calls.length, result.limits.entries);
  assert.equal(result.paths.length, result.limits.entries);
  assert.equal(result.counts.calls, 300);
  assert.equal(result.truncated, true);
  assert.ok(result.unknown.omittedEntries > 0);
  assert.ok(JSON.stringify(result).length < 200_000);
});

test('source is never executed', () => {
  globalThis.SENTINEL_EXECUTION_SECRET = false;
  inspect('globalThis.SENTINEL_EXECUTION_SECRET = true; throw new Error("SENTINEL_THROW_SECRET");');
  assert.equal(globalThis.SENTINEL_EXECUTION_SECRET, false);
  delete globalThis.SENTINEL_EXECUTION_SECRET;
});

test('verified public technical route segments are retained without arbitrary segment generalization', () => {
  const paths = ['/szc/szzh/sjswszzh/zhcx/v1/DescribeSbmxxqcx', '/szzh/zhcx/cwbbsbxxcx/cwbbxxcxDetail',
    '/szc/szzh/sjswszzh/zhcx/v1/DescribeFpCx'];
  const result = inspect(paths.map(p => `request(${JSON.stringify(p)},{method:'post'});`).join('\n'));
  assert.deepEqual(result.paths.map(p => p.path), paths);
  assert.ok(result.calls[0].signals.includes('detail'));
  assert.ok(result.calls[2].signals.includes('invoice'));
  assert.deepEqual(result.calls[0].arguments[1].methods, ['POST']);
});

test('observed technical names and case-sensitive keys survive without leaking business sentinels', () => {
  // 下方所有前缀和值均为合成数据，不是实际端点契约。
  const secret = 'SENTINEL_OBSERVED_BUSINESS_VALUE';
  const unknown = 'SENTINEL_UNKNOWN_TECHNICAL_PREFIX';
  const result = inspect(`function getCwbbzlList(){return fetch('/szzh/getCwbbzlList');}
    function queryZlbscjb(){return request('/szzh/queryZlbscjb', {method:'POST',body:{
      Skssqq:'${secret}',Skssqz:'${secret}',PageNum:'${secret}',PageSize:'${secret}',
      SENTINEL_UNKNOWN_BODY_KEY:'${secret}'}});}
    function DescribeNsrjbxx(){return fetch('/szzh/DescribeNsrjbxx');}
    getCwbbzlList(); queryZlbscjb(); DescribeNsrjbxx();
    fetch('/szzh/${unknown}/queryZlbscjb');`);
  for (const name of ['getCwbbzlList', 'queryZlbscjb', 'DescribeNsrjbxx']) {
    assert.ok(result.functions.some(f => f.name === name));
    assert.ok(result.calls.some(c => c.technicalTail === name));
    assert.ok(result.paths.some(p => p.path === `/szzh/${name}`));
  }
  const request = result.calls.find(c => c.technicalTail === 'request');
  assert.deepEqual(request.arguments[1].objects, [{ key: 'body',
    keys: ['Skssqq', 'Skssqz', 'PageNum', 'PageSize'], unknownKeys: 1 }]);
  assert.deepEqual(request.arguments[1].methods, ['POST']);
  const serialized = JSON.stringify(result);
  for (const sentinel of [secret, unknown, 'SENTINEL_UNKNOWN_BODY_KEY']) assert.ok(!serialized.includes(sentinel));
  assert.equal(result.paths.length, 3);
  assert.ok(result.unknown.paths > 0);
  assert.equal(result.requestAuthorized, false);
});

test('long member chains are bounded and do not throw or leak source', () => {
  const result = inspect('row' + '.id'.repeat(15_000) + '();');
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0].callee, null);
  assert.equal(result.truncated, true);
});

test('catch destructuring patterns shadow outer function bindings', () => {
  for (const pattern of ['{getDetail}', '[getDetail]', '{data:getDetail}', '{data:getDetail=()=>{}}', '[...getDetail]', '{...getDetail}']) {
    const result = inspect(`function getDetail(){}; try {} catch(${pattern}) {getDetail();}`);
    assert.deepEqual(result.links, [], pattern);
    assert.equal(result.unknown.unresolvedCalls, 1);
  }
});

test('destructured parameter/local bindings and assignments do not fabricate outer links', () => {
  const result = inspect(`function getDetail(){};
    function downloadFile({getDetail}) {getDetail();}
    {const {getDetail}=row; getDetail();}
    ({getDetail}=row); getDetail();`);
  assert.deepEqual(result.links, []);
});

test('AST size limit discards incomplete findings and returns a fixed safe result', () => {
  const result = inspectDownloadSource(';'.repeat(160_000));
  assert.equal(result.status, 'ast_limit');
  assert.equal(result.truncated, true);
  assert.deepEqual(result.calls, []);
  assert.deepEqual(result.functions, []);
});

test('late download/API/row consumers survive hundreds of generic bundle calls and functions', () => {
  const preamble = Array.from({ length: 300 }, (_, i) => `function z${i}(){a();} z${i}();`).join('\n');
  const result = inspect(preamble + `
    function getDetail(row) { downloadFile(row); }
    function downloadFile(row) {
      request({url:'/szc/szzh/sjswszzh/zhcx/v1/DescribeSbmxxqcx', method:'post', data:{sbuuid:row.sbuuid}})
        .then(response=>saveAs(new Blob([response]), 'SENTINEL_LATE_FILENAME'));
    }
    getDetail(row);`);
  assert.equal(result.truncated, true);
  assert.ok(result.calls.some(c => c.technicalTail === 'saveAs'));
  assert.ok(result.calls.some(c => c.technicalTail === 'getDetail'));
  assert.ok(result.calls.some(c => c.technicalTail === 'downloadFile'));
  const request = result.calls.find(c => c.technicalTail === 'request');
  assert.deepEqual(request.arguments[0].paths, [{ key: 'url', path: '/szc/szzh/sjswszzh/zhcx/v1/DescribeSbmxxqcx' }]);
  assert.deepEqual(request.arguments[0].objects, [{ key: 'data', keys: ['sbuuid'], unknownKeys: 0 }]);
  assert.ok(result.functions.some(f => f.name === 'getDetail'));
  assert.ok(result.functions.some(f => f.name === 'downloadFile'));
  assert.ok(result.links.some(l => l.kind === 'lexical_binding_candidate'));
  const functions = new Set(result.functions.map(f => f.id));
  const calls = new Set(result.calls.map(c => c.id));
  for (const c of result.calls) if (c.functionId) assert.ok(functions.has(c.functionId));
  for (const l of result.links) {
    assert.ok(calls.has(l.callId));
    assert.ok(functions.has(l.toFunctionId));
    if (l.fromFunctionId) assert.ok(functions.has(l.fromFunctionId));
  }
  for (const list of ['calls', 'functions', 'paths', 'properties', 'links', 'labels']) assert.ok(result[list].length <= result.limits.entries);
  assert.ok(!JSON.stringify(result).includes('SENTINEL_LATE_FILENAME'));
});
