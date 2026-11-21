import assert from 'node:assert/strict';
import test from 'node:test';
import { searchStaPolicies } from '../server/official-policy-sta.mjs';

function record(i) {
  return {
    title: `合成<span>政策</span>${i}`, url: `http://fgk.chinatax.gov.cn/test/${i}/content.html`,
    column: '政策法规', pubDate: '2026-11-05 10:00:00', cwrq: '2026-11-04 00:00:00',
    pubName: '国家税务总局', govDoc: { docNum: '合成文号' }, xxgk_aging: '尚未生效', label: '税务规范性文件',
  };
}

function serve(t, total, { modify, fail } = {}) {
  const requested = [];
  t.mock.method(globalThis, 'fetch', async target => {
    const url = new URL(target);
    assert.equal(url.origin + url.pathname, 'https://www.chinatax.gov.cn/search5/search/s');
    assert.equal(url.searchParams.get('column'), '政策法规');
    assert.equal(url.searchParams.get('searchWord'), '电子发票');
    assert.equal(url.searchParams.get('pageSize'), '10');
    const page = Number(url.searchParams.get('pageNum'));
    requested.push(page);
    if (fail === page) return new Response('暂不可用', { status: 503 });
    const rows = [];
    for (let n = page * 10; n < Math.min(total, (page + 1) * 10); n++) rows.push(modify?.(record(n), n) ?? record(n));
    return Response.json({ searchResultAll: { status: 1000, total, searchTotal: rows } });
  });
  return requested;
}

test('总局政策栏目按业务分页连续取固定十条页，元数据区分发布与成文日期', async t => {
  const requested = serve(t, 76);
  const options = { page: 2, limit: 7 };
  const result = await searchStaPolicies('电子发票', options);
  assert.deepEqual(requested, [0, 1]);
  assert.deepEqual(result.hits.map(hit => hit.title), Array.from({ length: 7 }, (_, i) => '合成政策' + (7 + i)));
  assert.deepEqual(result.hits[0], {
    title: '合成政策7', url: 'https://fgk.chinatax.gov.cn/test/7/content.html', publishedOn: '2026-11-05',
    publisher: '国家税务总局', documentNumber: '合成文号', indexedStatus: '尚未生效', category: '税务规范性文件',
  });
  assert.equal(result.hasMore, true);
  assert.equal(result.skipped, 0);
});

test('总局末页、超过末页和关键词零匹配分别返回准确行数', async t => {
  const req = serve(t, 23);
  const result = await searchStaPolicies('电子发票', { page: 4, limit: 7 });
  assert.deepEqual(req, [2]);
  assert.equal(result.hits.length, 2);
  assert.equal(result.hasMore, false);
  const empty = { hits: [], hasMore: false, skipped: 0 };
  assert.deepEqual(await searchStaPolicies('电子发票', { page: 5, limit: 7 }), empty);
  t.mock.restoreAll();
  serve(t, 0);
  assert.deepEqual(await searchStaPolicies('电子发票'), empty);
});

test('跨三原站页时单页失败保留其余命中并显示缺失数量', async t => {
  const req = serve(t, 64, { fail: 2 });
  const result = await searchStaPolicies('电子发票', { page: 2, limit: 19 });
  assert.deepEqual(req, [1, 2, 3]);
  assert.equal(result.skipped, 10);
  assert.deepEqual(result.hits.map(hit => hit.title), [19,30,31,32,33,34,35,36,37].map(i => '合成政策' + i));
  assert.equal(result.hasMore, true);
});

test('跳过不属于政策法规栏目的条目与不合规链接，官方附件保留来源地址', async t => {
  serve(t, 3, { modify(row, i) {
    if (i === 0) return { ...row, column: '新闻发布' };
    if (i === 1) return { ...row, url: 'https://example.org/' };
    return { ...row, url: 'https://fgk.chinatax.gov.cn/attachment.pdf' };
  } });
  const result = await searchStaPolicies('电子发票');
  assert.equal(result.skipped, 2);
  assert.equal(result.hits[0].url, 'https://fgk.chinatax.gov.cn/attachment.pdf');
});

test('来源响应异常不计作无匹配，并限制对外页码范围', async t => {
  serve(t, 0, { fail: 0 });
  await assert.rejects(searchStaPolicies('电子发票'), /policy_search_http_503/);
  t.mock.restoreAll();
  t.mock.method(globalThis, 'fetch', async () => Response.json({ searchResultAll: { status: 500, total: 0, searchTotal: [] } }));
  await assert.rejects(searchStaPolicies('电子发票'), /policy_search_sta_format/);
  await assert.rejects(searchStaPolicies('电子发票', { page: 21 }), RangeError);
});
