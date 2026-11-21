import test from 'node:test';
import assert from 'node:assert/strict';
import {searchCouncilPolicies, searchOfficialPolicies} from '../server/official-policy-search.mjs';
import {fetchPolicySearch} from '../server/official-policy-transport.mjs';

const council = 'https://sousuo.www.gov.cn';
const official = 'https://www.gov.cn/zhengce/synthetic.htm';
const catalog = rows => ({code:200, searchVO:{catMap:{
  gongwen:{catName:'国务院文件', totalCount:7, listVO:rows},
}}});

test('国务院按栏目取真实的检索页，升级站内旧链接，抛出无法识别的数据', async t => {
  const replies = [
    catalog([{title:'<b>合成</b>文件', url:official.replace('https:', 'http:'), pubtimeStr:'2026.03.02'},
      {title:'其他结果', url:'https://example.com/synthetic.htm'}]),
    {code:1001, msg:'抱歉，没有找到相关结果'},
    {code:1001, msg:'服务暂不可用'},
    {code:200, searchVO:{catMap:{}}},
  ];
  t.mock.method(globalThis, 'fetch', async url => {
    assert.equal(url.origin, council);
    assert.equal(url.searchParams.get('q'), '合成公开文件');
    assert.equal(url.searchParams.get('p'), '2');
    assert.equal(url.searchParams.get('n'), '2');
    return Response.json(replies.shift());
  });
  const search = () => searchCouncilPolicies('合成公开文件', {page:2, limit:2});
  assert.deepEqual(await search(), {
    hits:[{title:'合成文件', url:official, category:'国务院文件', publishedOn:'2026-03-02'}],
    skipped:1, hasMore:true,
  });
  assert.deepEqual(await search(), {hits:[], hasMore:false});
  await assert.rejects(search, /council_format/);
  await assert.rejects(search, /council_format/);
});

test('公共检索在本机拒绝路径、联系方式及格式无效的参数', async t => {
  const net = t.mock.method(globalThis, 'fetch', () => { throw Error('unexpected call'); });
  const invalid = [
    {query:'D:\\合成资料\\客户原件'}, {query:'/synthetic/files/receipt'},
    {query:'询问 synthetic@example.com'}, {query:'联系电话 13800000000'},
    {query:'Authorization: Basic synthetic'}, {query:'合同编号：合成合同'},
    {query:'示例 税号 123456789012345678'}, {query:'合成政策', page:21},
    {query:'合成政策', limit:0}, {query:'合成文件', limit:'2'},
  ];
  for (const args of invalid) await assert.rejects(() => searchOfficialPolicies(args), {code:'invalid_arguments'});
  assert.equal(net.mock.callCount(), 0);
});

test('一处来源故障时，保留其余结果并准确标注核对范围', async t => {
  let mode = 'partial';
  t.mock.method(globalThis, 'fetch', async input => {
    const url = new URL(input);
    if (url.origin === council && mode !== 'offline') {
      return Response.json(mode === 'zero' ? {code:1001, msg:'没有找到相关结果'} :
        catalog([{title:'政策命中', url:official}, {title:'同一文件', url:official}]));
    }
    return new Response(null, {status:503});
  });
  const search = () => searchOfficialPolicies({query:'国家税务总局公告2026年第6号'});
  const some = await search();
  assert.equal(some.status, 'partial');
  assert.equal(some.providers.filter(p => p.status === 'unavailable').length, 2);
  assert.equal(some.results.length, 1);
  assert.equal(some.results[0].url, official);
  assert.equal(some.hasMore, true);
  mode = 'zero';
  const incomplete = await search();
  assert.equal(incomplete.status, 'partial');
  assert.deepEqual(incomplete.results, []);
  mode = 'offline';
  const offline = await search();
  assert.equal(offline.status, 'unavailable');
  assert.deepEqual(offline.results, []);
});

test('在线索引限制响应大小，只跟随官方检索站点的跳转', async t => {
  const responses = [
    new Response(null, {status:302, headers:{location:'/new-search'}}),
    new Response('ok'), new Response(null, {status:302, headers:{location:'https://example.com/'}}),
    new Response('abc', {headers:{'content-length':'3000000'}}),
  ];
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push(url.href);
    assert.equal(options.method, 'GET');
    assert.equal(options.credentials, 'omit');
    return responses.shift();
  });
  const search = () => fetchPolicySearch(council);
  assert.equal((await search()).bytes.toString(), 'ok');
  await assert.rejects(search, /origin_invalid/);
  await assert.rejects(search, /response_too_large/);
  assert.deepEqual(calls, [council+'/', council+'/new-search', council+'/', council+'/']);
});
