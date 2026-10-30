import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { inspectDownloadMenuValue, passiveDownloadMenuScript, createDownloadMenuLocalIndex } from '../server/tax-download-menu.mjs';

const NOW = 1_800_000_000_000;
const ORIGIN = 'https://etax.fujian.chinatax.gov.cn:8443';
const PORTAL = `${ORIGIN}/loginb/`;
const raw = (val, exp = NOW + 1000) => JSON.stringify({ val, exp });
const leaf = (gnmc = '发票查询', cddz = '/szzh/invoice/query', yyfwqdz = ORIGIN) => ({ gnmc, cddz, yyfwqdz, arr: [] });

test('projects fixed categories and technical paths/query keys, never labels or values', () => {
  const result = inspectDownloadMenuValue(raw([
    leaf('SENTINEL_企业名称发票查询', '/szzh/invoice/query?type=SENTINEL_业务值'),
    leaf('财务报表查询', '/szzh/zhcx/cwbbsbxxcx/cwbbxxcxDetail'),
    leaf('账簿下载', '/szzh/accounting/download'),
    leaf('申报表下载', '/szzh/sbbdxz?cdlj=%2Fszzh%2Freport%2Fdownload'),
  ]), NOW);
  assert.equal(result.status, 'menu_observed');
  assert.equal(result.requestAuthorized, false);
  assert.equal(result.evidence, 'passive_menu_only');
  assert.equal(result.cacheFresh, true);
  assert.equal(result.expirySemanticsVerified, false);
  assert.equal(result.expiryAssessment, 'timestamp_heuristic_only');
  assert.equal(result.counts.allowed, 4);
  assert.deepEqual(result.entries.map(x => x.category), ['filing_form_download', 'accounting_history', 'financial_report', 'invoice']);
  assert.equal(result.entries[0].technicalDestination, '/szzh/report/download');
  assert.deepEqual(result.entries[3].queryKeys, ['type']);
  assert.ok(!JSON.stringify(result).includes('SENTINEL'));
});

test('only leaf arr nodes are matched; irrelevant/menu-parent labels are omitted', () => {
  const result = inspectDownloadMenuValue(raw([{ ...leaf(), arr: [leaf('财务报表查询')] }, leaf('企业名称与地址')]), NOW);
  assert.equal(result.counts.nodes, 3);
  assert.equal(result.counts.matched, 1);
  assert.equal(result.entries[0].category, 'financial_report');
});

test('write actions and credential links remain blocked technical clues', () => {
  const result = inspectDownloadMenuValue(raw([
    leaf('发票查询及作废'), leaf('申报表下载并提交'), leaf('发票下载', '/loginb/'),
    leaf('发票查询', '/szzh/invoice/query?ticket=SENTINEL_TICKET'),
    leaf('发票统计', '/szzh/invoice/query?access_token=SENTINEL_TOKEN'),
  ]), NOW);
  assert.equal(result.counts.matched, 5);
  assert.equal(result.counts.blocked, 5);
  assert.equal(result.counts.allowed, 0);
  assert.ok(result.entries.every(x => x.blockedReason));
  assert.ok(!JSON.stringify(result).includes('SENTINEL'));
});

test('rejects unverified origins, credentials, unsafe ports, IDs, hashes and unknown query names', () => {
  const result = inspectDownloadMenuValue(raw([
    leaf('发票查询', 'https://SENTINEL_HOST.chinatax.gov.cn/szzh/query'),
    leaf('发票查询', `${ORIGIN.replace('8443', '9999')}/szzh/query`),
    leaf('发票查询', 'https://SENTINEL_USER:SENTINEL_PASS@etax.fujian.chinatax.gov.cn:8443/szzh/query'),
    leaf('发票查询', '/szzh/913500001234567890'),
    leaf('发票查询', '/szzh/550e8400-e29b-41d4-a716-446655440000'),
    leaf('发票查询', '/szzh/SENTINEL_DYNAMIC_RESOURCE'),
    leaf('发票查询', '/szzh/发票'), leaf('发票查询', '/szzh/%71uery'),
    leaf('发票查询', '/szzh/query#SENTINEL_HASH'),
    leaf('发票查询', '/szzh/query?SENTINEL_KEY=SENTINEL_VALUE'),
    leaf('发票查询', '/szzh/../query'),
  ]), NOW);
  // 未知 ASCII 资源现在只作为脱敏结构保留；
  // 接受其投影绝不表示已验证只读语义或导航。
  assert.equal(result.counts.blocked, 10);
  assert.equal(result.counts.allowed, 1);
  assert.equal(result.readOnlyVerified, false);
  assert.equal(result.navigationAuthorized, false);
  assert.ok(result.counts.unknownPaths >= 5);
  const serialized = JSON.stringify(result);
  for (const sentinel of ['SENTINEL', '913500001234567890', '550e8400']) assert.ok(!serialized.includes(sentinel));
});

test('invalid cdlj destinations never echo parameter values', () => {
  for (const destination of ['/szzh/913500001234567890', '/szzh/report/download?token=SENTINEL', 'https://example.test/SENTINEL', '/loginb/']) {
    const result = inspectDownloadMenuValue(raw([leaf('申报表下载', `/szzh/sbbdxz?cdlj=${encodeURIComponent(destination)}`)]), NOW);
    assert.equal(result.entries[0].technicalDestination, null);
    assert.ok(result.entries[0].blockedReason);
    assert.ok(!JSON.stringify(result).includes('SENTINEL'));
  }
});

test('envelope, freshness, raw size, node/depth limits fail closed', () => {
  assert.equal(inspectDownloadMenuValue(null, NOW).status, 'missing_menu');
  assert.equal(inspectDownloadMenuValue(raw([], NOW - 2), NOW).status, 'historical_menu_observed');
  assert.equal(inspectDownloadMenuValue(raw([], NOW - 2), NOW).cacheFresh, false);
  assert.equal(inspectDownloadMenuValue(raw([], NOW - 1), NOW).status, 'menu_observed');
  assert.equal(inspectDownloadMenuValue(raw([], NOW + 100 * 365 * 86400000), NOW).status, 'menu_observed');
  for (const value of ['bad JSON', raw({}, NOW), JSON.stringify({ val: [], exp: NOW, extra: 1 }), JSON.stringify({ val: [], exp: null }), ' '.repeat(512001)]) {
    assert.equal(inspectDownloadMenuValue(value, NOW).status, 'invalid_menu');
  }
  assert.equal(inspectDownloadMenuValue(raw(Array.from({ length: 5001 }, () => ({}))), NOW).status, 'invalid_menu');
  let tree = leaf();
  for (let i = 0; i < 12; i++) tree = { arr: [tree] };
  const result = inspectDownloadMenuValue(raw([tree]), NOW);
  assert.equal(result.status, 'invalid_menu');
  assert.deepEqual(result.entries, []);
});

test('does not inspect object inputs or invoke their getters', () => {
  let called = false;
  const value = { get val() { called = true; throw new Error('SENTINEL'); } };
  assert.equal(inspectDownloadMenuValue(value, NOW).status, 'invalid_menu');
  assert.equal(called, false);
});

test('output is bounded while redacted candidate counts include omitted entries', () => {
  const result = inspectDownloadMenuValue(raw(Array.from({ length: 100 }, () => leaf('发票查询', '/szzh/SENTINEL'))), NOW);
  assert.equal(result.entries.length, 80);
  assert.equal(result.counts.matched, 100);
  assert.equal(result.counts.blocked, 0);
  assert.equal(result.counts.allowed, 100);
  assert.equal(result.counts.unknownPaths, 100);
  assert.equal(result.counts.omitted, 20);
  assert.equal(result.truncated, true);
});

function runScript({ href = PORTAL, value = raw([leaf()]), afterHref, prototype } = {}) {
  const storage = new Map([['mhNavDataAfter_mh', value], ['unrelated_credential', 'SENTINEL_STORAGE_SECRET']]);
  const before = [...storage];
  Object.defineProperty(storage, 'getItem', { get() { throw new Error('application getter must not run'); } });
  let hrefReads = 0, forbidden = 0;
  const reject = () => { forbidden++; throw new Error('forbidden action'); };
  const context = { URL, Storage: { prototype: prototype ?? { getItem: Map.prototype.get } }, sessionStorage: storage,
    location: { get href() { hrefReads++; return hrefReads > 1 && afterHref ? afterHref : href; } },
    Date: { now: () => NOW }, fetch: reject, XMLHttpRequest: reject, document: new Proxy({}, { get: reject }),
    localStorage: new Proxy({}, { get: reject }), window: new Proxy({}, { get: reject }) };
  const result = JSON.parse(JSON.stringify(vm.runInNewContext(passiveDownloadMenuScript(), context, { timeout: 1000 })));
  assert.deepEqual([...storage], before);
  assert.equal(forbidden, 0);
  return { result, hrefReads };
}

test('synthetic VM script performs only fixed native known-key read; no DOM, requests or writes', () => {
  const { result, hrefReads } = runScript();
  assert.equal(result.status, 'menu_observed');
  assert.equal(result.counts.matched, 1);
  assert.equal(hrefReads, 2);
  assert.ok(!JSON.stringify(result).includes('SENTINEL'));
  assert.ok(!passiveDownloadMenuScript().includes('setItem'));
});

test('synthetic VM rejects scope drift and getter/replaced Storage methods', () => {
  const mismatch = runScript({ href: `${PORTAL}?token=SENTINEL` }).result;
  assert.equal(mismatch.status, 'scope_mismatch');
  assert.equal(mismatch.expirySemanticsVerified, false);assert.equal(mismatch.expiryAssessment, 'timestamp_heuristic_only');
  assert.equal(runScript({ afterHref: `${ORIGIN}/other/` }).result.status, 'scope_mismatch');
  const prototype = {};
  Object.defineProperty(prototype, 'getItem', { get() { throw new Error('must not run'); } });
  assert.equal(runScript({ prototype }).result.status, 'capability_unavailable');
  assert.equal(runScript({ prototype: { getItem() { throw new Error('must not run'); } } }).result.status, 'capability_unavailable');
  assert.equal(runScript({ value: raw([], NOW - 2) }).result.status, 'historical_menu_observed');
});

test('verified concatenation retains service path prefix and spHandler destination', () => {
  const result = inspectDownloadMenuValue(raw([leaf('财务报表查询', '/szzh/sjswszzh/spHandler?cdlj=/szzh/zhcx/cwbbsbxxcx', `${ORIGIN}/szc`)]), NOW);
  assert.equal(result.counts.allowed, 1);
  assert.equal(result.entries[0].path, '/szc/szzh/sjswszzh/spHandler');
  assert.equal(result.entries[0].technicalDestination, '/szzh/zhcx/cwbbsbxxcx');
  assert.deepEqual(result.entries[0].queryKeys, ['cdlj']);
});

test('missing/null/empty services resolve against fixed document scope', () => {
  for (const yyfwqdz of [undefined, null, '']) {
    const item = { ...leaf(), yyfwqdz };
    const result = inspectDownloadMenuValue(raw([item]), NOW);
    assert.equal(result.entries[0].origin, ORIGIN);
    assert.equal(result.entries[0].path, '/szzh/invoice/query');
    assert.equal(result.entries[0].blockedReason, null);
  }
});

test('dppt official host is only a passive candidate while tpass stays blocked', () => {
  const result = inspectDownloadMenuValue(raw([
    leaf('发票查询', '/kpfw/invoice/query', 'https://dppt.fujian.chinatax.gov.cn:8443'),
    leaf('发票查询', '/kpfw/invoice/query', 'https://tpass.fujian.chinatax.gov.cn:8443'),
  ]), NOW);
  assert.equal(result.counts.allowed, 1);
  assert.equal(result.counts.blocked, 1);
  assert.equal(result.requestAuthorized, false);
  const dppt = result.entries.find(e => e.origin?.includes('dppt.'));
  assert.equal(dppt.path, '/kpfw/invoice/query');
  const blocked = result.entries.find(e => e.blockedReason);
  assert.equal(blocked.origin, null);
  assert.equal(blocked.blockedReason, 'unsafe_origin');
  assert.ok(!JSON.stringify(result).includes('tpass'));
});

test('expired cache retains only explicitly historical technical clues, with unsafe links still blocked', () => {
  const value = raw([
    leaf('财务报表查询', '/szzh/zhcx/cwbbsbxxcx/cwbbxxcxDetail'),
    leaf('发票下载', '/kpfw/invoice/download?ticket=SENTINEL_EXPIRED_TICKET'),
  ], NOW - 86400000);
  const { result } = runScript({ value });
  assert.equal(result.status, 'historical_menu_observed');
  assert.equal(result.cacheFresh, false);
  assert.equal(result.evidence, 'historical_menu_only');
  assert.equal(result.requestAuthorized, false);
  assert.equal(result.counts.matched, 2);
  assert.equal(result.counts.allowed, 1);
  assert.equal(result.counts.blocked, 1);
  assert.ok(result.entries.some(e => e.path === '/szzh/zhcx/cwbbsbxxcx/cwbbxxcxDetail'));
  assert.ok(result.entries.some(e => e.blockedReason === 'credential_link'));
  assert.ok(!JSON.stringify(result).includes('SENTINEL_EXPIRED_TICKET'));
});

test('unknown route names project fixed placeholders without per-route whitelisting or raw business values', () => {
  const value = raw([leaf('发票查询', '/kpfw/SENTINEL_UNKNOWN_ROUTE?cdlj=/szzh/zhcx/SENTINEL_UNKNOWN_DEST')], NOW - 2);
  const result = inspectDownloadMenuValue(value, NOW), entry = result.entries[0];
  assert.equal(result.status, 'historical_menu_observed');assert.equal(result.cacheFresh, false);
  assert.equal(result.requestAuthorized, false);assert.equal(result.navigationAuthorized, false);assert.equal(result.readOnlyVerified, false);
  assert.equal(entry.path, null);assert.equal(entry.pathVerified, false);
  assert.equal(entry.pathShape, '/kpfw/:redacted_segment');
  assert.equal(entry.technicalDestination, null);
  assert.equal(entry.technicalDestinationShape, '/szzh/zhcx/:redacted_segment');
  assert.equal(entry.blockedReason, null);assert.equal(entry.routeRef, null);
  assert.ok(!JSON.stringify(result).includes('SENTINEL'));
  assert.equal(result.counts.unknownPaths, 2);
});

test('trusted local index keeps exact observed URL only in a nonserializable resolver closure', () => {
  const cddz = '/kpfw/SENTINEL_LOCAL_ROUTE?type=SENTINEL_BUSINESS_VALUE&cdlj=/szzh/zhcx/SENTINEL_LOCAL_DEST';
  const value = raw([leaf('发票查询', cddz)], NOW - 2);
  const index = createDownloadMenuLocalIndex(value, NOW), entry = index.projection.entries[0];
  assert.match(entry.routeRef, /^menuroute_[a-f0-9]{48}_0$/);
  assert.deepEqual(Object.keys(index), ['projection']);
  assert.equal(Object.getOwnPropertyDescriptor(index, 'resolve').enumerable, false);
  assert.ok(!JSON.stringify(index).includes('SENTINEL'));
  assert.ok(!JSON.stringify(index.projection).includes('SENTINEL'));
  const local = index.resolve(entry.routeRef);
  assert.equal(local.url, ORIGIN + cddz);
  assert.equal(local.category, entry.category);assert.equal(local.routeRef, entry.routeRef);
  assert.equal(local.cacheExpiresAt, NOW - 2);assert.equal(local.projectionCreatedAt, NOW);
  assert.equal(local.evidence, 'historical_menu_only');assert.equal(local.cacheFresh, false);
  assert.equal(local.requestAuthorized, false);assert.equal(local.navigationAuthorized, false);assert.equal(local.readOnlyVerified, false);
  assert.equal(local.sourceObservationVerified, false);
  assert.equal(local.expirySemanticsVerified, false);assert.equal(local.expiryAssessment, 'timestamp_heuristic_only');
  assert.equal(local.association, 'this_index_instance_only');
  assert.equal(local.sourceKind, 'known_key_menu_cache');
  assert.ok(Object.isFrozen(index));assert.ok(Object.isFrozen(index.projection.entries[0]));
  local.url = 'changed';assert.equal(index.resolve(entry.routeRef).url, ORIGIN + cddz);
  const other = createDownloadMenuLocalIndex(value, NOW);
  assert.notEqual(other.projection.entries[0].routeRef, entry.routeRef);
  assert.equal(other.resolve(entry.routeRef), null);assert.equal(index.resolve('menuroute_bad_0'), null);
  assert.equal(index.resolve({ toString() { throw Error('must not coerce'); } }), null);
});

test('unsafe/credential/ID destinations have no local resolution capability even with a structural projection', () => {
  const index = createDownloadMenuLocalIndex(raw([
    leaf('发票查询', '/kpfw/SENTINEL_ROUTE?ticket=SENTINEL_TICKET'),
    leaf('发票查询', '/kpfw/SENTINEL_ROUTE?cdlj=/szzh/913500001234567890'),
    leaf('发票查询', '/kpfw/SENTINEL_ROUTE?cdlj=/szzh/save'),
    leaf('发票查询', '/kpfw/SENTINEL_ROUTE?cdlj=/szzh/query&cdlj=/szzh/detail'),
  ]), NOW);
  assert.equal(index.projection.counts.blocked, 4);
  for (const entry of index.projection.entries) { assert.equal(entry.routeRef, null);assert.ok(entry.blockedReason); }
  assert.ok(!JSON.stringify(index).includes('SENTINEL'));
  assert.ok(!JSON.stringify(index).includes('913500001234567890'));
});

test('known observed financial and filing-download routes retain exact technical paths', () => {
  const result = inspectDownloadMenuValue(raw([
    leaf('财务报表查询', '/szzh/zhcx/cwbbsbxxcx'),
    leaf('财务报表查询', '/szzh/zhcx/cwbbsbxxcx/cwbbxxcxDetail'),
    leaf('申报表下载', '/szzh/zhcx/sbxx/sbbdxz'),
    leaf('发票查询', '/kpfw/spHandler?cdlj=/szzh/zhcx/SENTINEL_INVOICE_ROUTE', 'https://dppt.fujian.chinatax.gov.cn:8443'),
  ]), NOW);
  assert.equal(result.counts.allowed, 4);
  assert.ok(result.entries.some(e => e.path === '/szzh/zhcx/sbxx/sbbdxz'));
  const invoice = result.entries.find(e => e.category === 'invoice');
  assert.equal(invoice.path, '/kpfw/spHandler');
  assert.equal(invoice.technicalDestinationShape, '/szzh/zhcx/:redacted_segment');
  assert.ok(!JSON.stringify(result).includes('SENTINEL'));
});
