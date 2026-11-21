import assert from 'node:assert/strict';
import test from 'node:test';
import { parseMofSearch, searchMofPolicies } from '../server/official-policy-mof.mjs';

const pageWith = body => '<title>中华人民共和国财政部_全文检索</title>' + body;
const row = (url, title) => `<dl><dt><a href='${url}'>${title}</a></dt>
  <dd>这段摘要和发布日期属于检索列表。</dd><p><span class="fr">2026.01.05</span></p></dl>`;
const resultPage = (rows, navigation = '') => pageWith(
  `<div>找到相关结果约8条，用时0.01秒</div><div class="list_search">${rows}</div>${navigation}`,
);
const article = 'https://szs.mof.gov.cn/zhengcefabu/202601/t20260105_12345.htm';
const invalid = { code: 'POLICY_SEARCH_RESPONSE_INVALID' };

test('财政部仅从政策栏目取标题、原文链接与页面标注日期，识别下一页', () => {
  const rows = row(article.replace('https:', 'http:'), '关于<font color=red>纳税</font><br/>事项&nbsp;的公告');
  const page = resultPage(rows, '<a class="next-page" href="search?page=2">下一页</a>');
  assert.deepEqual(parseMofSearch(page), {
    hits: [{ title: '关于纳税事项 的公告', url: article, publishedOn: '2026-01-05' }], hasMore: true,
  });
});

test('同页去重、拒绝非官方链接，末页忽略注释中的翻页按钮', () => {
  const rows = row('https://example.org/not-a-policy', '不收录') +
    row('#导航', '无原文') + row(article, '政策') + row(article.replace('https:', 'http:'), '政策重复');
  assert.deepEqual(parseMofSearch(resultPage(rows, '<!-- <a class="next-page">下一页</a> -->')), {
    hits: [{ title: '政策', url: article, publishedOn: '2026-01-05' }], hasMore: false, skipped: 2,
  });
});

test('明确的零命中和请求超过末页均可返回空结果', () => {
  const expected = { hits: [], hasMore: false };
  assert.deepEqual(parseMofSearch(pageWith('很抱歉，没有找到和您的查询相匹配的结果。')), expected);
  assert.deepEqual(parseMofSearch(resultPage(''), { page: 3, limit: 4 }), expected);
});

test('来源异常、模板改版和只有无效链接的页面不冒充零命中', () => {
  for (const html of [
    '<title>请稍候</title>',
    pageWith('<div>暂时无法响应</div>'),
    resultPage(''),
    resultPage(row('https://example.org/', '外部网址')),
  ]) assert.throws(() => parseMofSearch(html), invalid);
});

test('发起财政部请求前拒绝无效分页', async () => {
  for (const options of [{ page: 0 }, { page: 21 }, { limit: 0 }, { limit: 2.5 }, { limit: 21 }]) {
    await assert.rejects(searchMofPolicies('增值税', options), RangeError);
  }
});
