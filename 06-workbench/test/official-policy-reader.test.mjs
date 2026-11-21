import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { officialPolicyUrl, readOfficialPolicy } from '../server/official-policy-reader.mjs';

const url = 'https://fgk.chinatax.gov.cn/synthetic/policy.html';
const canonical = 'https://www.mof.gov.cn/synthetic/policy.html';
const article = `<html><head><meta name=ArticleTitle content="合成税务公告">
  <meta name=PubDate content="2026-11-02"><meta name=SiteName content="合成站点">
  <meta name=ContentSource content="合成发布单位"><title>站点名称</title></head><body>
  <nav>全站导航</nav><h5>合成公告2026年第1号</h5>
  <p class=arc_date><span class=xg>部分有效</span><span>成文日期：2026-10-31</span></p>
  <div class=zscont>具体条件见第二条。</div><div class=arc_cont>
  <p>第一条　合成规则 &amp; 限定条件。</p>
  <p>第二条　<span style="display: none">隐藏文字</span>规定如下。</p>
  <table><tr><td>条件一</td><td>适用</td></tr></table>
  <script>thisIsNotAnArticle()</script><a href="../docs/file.doc">附件1：合成附件</a>
  <a href="https://example.org/offsite.pdf">附件2</a></div>
  <aside><a href="other.pdf">其他公告的附件</a></aside><footer>全站页脚</footer></body></html>`;
const html = data => new Response(data, { headers: { 'content-type': 'text/html;charset=UTF-8' } });
const hash = content => createHash('sha256').update(content).digest('hex');

test('只发起匿名 HTTPS GET，按最终来源记录标题、来源、日期、摘要及附件', async t => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (requested, options) => {
    assert.equal(options.method, 'GET');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'manual');
    assert.deepEqual(Object.keys(options.headers), ['Accept']);
    assert.ok(options.signal instanceof AbortSignal);
    requests.push(requested);
    return requested === canonical ? html(article) : new Response(null, { status: 302, headers: { location: canonical } });
  });
  const result = await readOfficialPolicy({ url: url + '#anchor' });
  assert.deepEqual(requests, [url, canonical]);
  assert.equal(result.status, 'read');
  assert.equal(result.source.requestedUrl, url);
  assert.equal(result.source.url, canonical);
  assert.equal(result.source.host, 'www.mof.gov.cn');
  assert.deepEqual(result.source.redirects, [canonical]);
  assert.ok(Number.isFinite(Date.parse(result.source.retrievedAt)));
  assert.equal(result.source.sha256, hash(article));
  assert.equal(result.source.byteLength, Buffer.byteLength(article));
  assert.equal(result.source.title, '合成税务公告');
  assert.equal(result.source.siteName, '合成站点');
  assert.equal(result.source.origin, '合成发布单位');
  assert.equal(result.source.issuedOn, '2026-10-31');
  assert.equal(result.source.publishedOn, '2026-11-02');
  assert.equal(result.source.documentNumber, '合成公告2026年第1号');
  assert.equal(result.source.observedStatus, '部分有效');
  assert.equal(result.source.annotation, '具体条件见第二条。');
  assert.match(result.text, /第一条　合成规则 & 限定条件。\n第二条　规定如下。/);
  assert.match(result.text, /条件一\t适用/);
  assert.doesNotMatch(result.text, /全站|隐藏文字|thisIsNotAnArticle|其他公告的附件/);
  assert.deepEqual(result.attachments, [{ title: '附件1：合成附件', url: 'https://www.mof.gov.cn/docs/file.doc' }]);
  assert.equal(result.attachmentCount, 1);
  assert.equal(result.totalCharacters, result.text.length);
  assert.equal(result.nextOffset, null);
});

test('分页收集同一份完整原文；文件变化时按所给字节摘要拒绝续页', async t => {
  let body = article;
  t.mock.method(globalThis, 'fetch', async () => html(body));
  const full = await readOfficialPolicy({ url });
  const first = await readOfficialPolicy({ url, limit: 14 });
  const rest = await readOfficialPolicy({ url, offset: first.nextOffset, expectedSha256: first.source.sha256 });
  assert.equal(first.nextOffset, 14);
  assert.equal(rest.offset, 14);
  assert.equal(first.text + rest.text, full.text);
  body = body.replace('合成规则', '修改条款');
  const changed = await readOfficialPolicy({ url, offset: 14, expectedSha256: first.source.sha256 });
  assert.equal(changed.code, 'source_changed');
  assert.equal(changed.text, undefined);
  assert.equal((await readOfficialPolicy({ url, offset: 10000 })).code, 'offset_out_of_bounds');
});

test('只披露正文、注释与关联文件区的官方链接，优先报告修订线索', async t => {
  const content = `<title>合成修订公告</title><nav><a href="/login">账号</a></nav>
    <div class=zscont><a href="http://www.gov.cn/x/repeal">部分条款废止</a></div>
    <article><p>查阅<a href="../law">上位法</a>。</p><a href="https://example.org/ref">其他站点</a></article>
    <div class=relevance><div class=gljdlist><a href="/faq">官方解读</a></div></div>
    <footer><a href="/contact">联系</a></footer>`;
  t.mock.method(globalThis, 'fetch', async () => html(content));
  const result = await readOfficialPolicy({ url });
  assert.deepEqual(result.relatedLinks, [
    { title: '部分条款废止', location: 'annotation', url: 'https://www.gov.cn/x/repeal', declaredUrl: 'http://www.gov.cn/x/repeal' },
    { title: '官方解读', location: 'related_section', url: 'https://fgk.chinatax.gov.cn/faq' },
    { title: '上位法', location: 'article', url: 'https://fgk.chinatax.gov.cn/law' },
  ]);
  assert.equal(result.relatedLinkCount, 3);
});

test('附件和关联条数注明可见总数，公布与发文日期只从本页标题区取', async t => {
  const rows = Array.from({ length: 65 }, (_, i) => `<a href="/ref/${i}">法规${i}</a><a href="./${i}.pdf">附表</a>`).join('');
  let content = `<title>合成文件</title><article><p>发布日期：2012-01-05（本条所引文件）</p>
    <p>成文日期：2008-10-15（所附参考文件）；本公告自2026年12月1日施行。</p>
    <p>备案日期为2026年11月1日。</p>${rows}</article><aside>发布日期：2001年10月1日</aside>`;
  t.mock.method(globalThis, 'fetch', async () => html(content));
  const result = await readOfficialPolicy({ url });
  assert.equal(result.source.publishedOn, null);
  assert.equal(result.source.issuedOn, null);
  assert.equal(result.relatedLinkCount, 65);
  assert.equal(result.relatedLinks.length, 30);
  assert.equal(result.attachmentCount, 65);
  assert.equal(result.attachments.length, 50);
  content = content.replace('<article>', '<div><span>发布时间：<span>2026-11-21 11:00</span></span></div><article>');
  assert.equal((await readOfficialPolicy({ url })).source.publishedOn, '2026-11-21');
  content = content.replace('<article>', `<table><tr><td>标　题：</td><td>正式公文题名</td></tr>
    <tr><td>发文机关：</td><td>合成单位</td><td>成文日期：</td><td>2026年10月1日</td></tr>
    <tr><td>发文字号：</td><td>合成1号</td><td>发布日期：</td><td>2026年10月5日</td></tr></table><article>`);
  const fields = (await readOfficialPolicy({ url })).source;
  assert.equal(fields.title, '正式公文题名');
  assert.equal(fields.issuingAuthority, '合成单位');
  assert.equal(fields.documentNumber, '合成1号');
  assert.equal(fields.issuedOn, '2026年10月1日');
  assert.equal(fields.publishedOn, '2026年10月5日');
});

test('中央和地方官网、人大链接以及相对路径独立校验每次跳转', async t => {
  for (const host of ['www.npc.gov.cn', 'www.gov.cn', 'czt.fujian.gov.cn', 'fgk.chinatax.gov.cn', 'szs.mof.gov.cn']) {
    assert.equal(officialPolicyUrl('https://' + host + '/f').hostname, host);
  }
  assert.equal(officialPolicyUrl('../rule', canonical).href, 'https://www.mof.gov.cn/rule');
  assert.equal(officialPolicyUrl(url + '?docId=10').search, '?docId=10');
  const requests = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 302, headers: { location: 'https://example.org/file' } }));
  for (const invalid of ['https://gov.cn.example.org', 'https://notgov.cn/r', 'http://gov.cn', 'https://user:pass@www.gov.cn',
    'https://www.gov.cn:444/r', 'file:///D:/book.xlsx', 'http://127.0.0.1',
    ...['access_token', 'accessToken', 'refreshToken', 'idToken', 'sessionId', 'api-key'].map(key => url + '?' + key + '=private')]) {
    const result = await readOfficialPolicy({ url: invalid });
    assert.equal(result.status, 'unavailable');
    assert.equal(result.source, undefined);
  }
  assert.equal(requests.mock.callCount(), 0);
  assert.equal((await readOfficialPolicy({ url })).code, 'unofficial_url');
  assert.equal(requests.mock.callCount(), 1);
  requests.mock.mockImplementation(async () => new Response(null, { status: 307, headers: { location: '/loop' } }));
  assert.equal((await readOfficialPolicy({ url })).code, 'redirect_limit');
});

test('传统中文编码、无声明的中文纯文本及无效编码分别处理', async t => {
  const bytes = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]); // GBK 编码的“中文”
  const source = Buffer.concat([Buffer.from('<meta charset=gb2312><title>test</title><article>'), bytes, Buffer.from('</article>')]);
  const retrieve = t.mock.method(globalThis, 'fetch', async () => new Response(source, { headers: { 'Content-Type': 'text/html' } }));
  const read = await readOfficialPolicy({ url });
  assert.equal(read.text, '中文');
  assert.equal(read.source.sha256, hash(source));
  retrieve.mock.mockImplementation(async () => new Response(bytes, { headers: { 'Content-Type': 'text/plain' } }));
  assert.equal((await readOfficialPolicy({ url })).text, '中文');
  retrieve.mock.mockImplementation(async () => new Response(bytes, { headers: { 'Content-Type': 'text/plain; charset=UTF-8' } }));
  assert.equal((await readOfficialPolicy({ url })).code, 'unreadable_encoding');
});

test('条文后的无 alt 位图保留原文位置、未读标记及链接，不计入打印和隐藏图标', async t => {
  const page = `<title>合成个税规则</title><meta name=PubDate content="2023-04-16 01:06:34">
    <header><img src="/header_logo.png"></header><span class=date>时间：<b><publishtime>2018-08-31</publishtime></b></span><article>
    <a><img src="/img/art_ico_print.png"></a><p><strong>第二十二条</strong> 本法自公布之日起施行。</p>
    <p><br><img src="files/table.bmp" border="0"><br></p><img alt=隐藏表 style="display:none" src=secret.bmp>
    <img src=tracker.gif width=1 height=1></article>`;
  const get = t.mock.method(globalThis, 'fetch', async () => html(page));
  const doc = await readOfficialPolicy({ url });
  assert.equal(doc.status, 'read');
  assert.equal(doc.text, '第二十二条 本法自公布之日起施行。');
  assert.equal(doc.inlineImageCount, 1);
  assert.equal(doc.source.publishedOn, '2018-08-31');
  assert.equal(doc.source.metadataPubDate, '2023-04-16 01:06:34');
  assert.deepEqual(doc.inlineImages[0], { index: 1, status: 'unread', url: 'https://fgk.chinatax.gov.cn/synthetic/files/table.bmp',
    title: null, precedingText: '第二十二条 本法自公布之日起施行。' });
  assert.match(doc.imageGuidance, /未读取/);
  const first = await readOfficialPolicy({ url, limit: 4 });
  const rest = await readOfficialPolicy({ url, offset: first.nextOffset, expectedSha256: hash(page) });
  assert.deepEqual(rest.inlineImages, doc.inlineImages);
  assert.equal(first.text + rest.text, doc.text);
  assert.equal(get.mock.callCount(), 3);
});

test('纯图片和响应式附表仅返回可查的图片与标签，限量披露并保留总数', async t => {
  let page = `<title>合成扫描附表</title><article><h1>合成扫描附表</h1><figure><picture>
    <source srcset="./rate.avif 1x,./rate2.avif 2x"><source srcset="data:image/png;base64,AAAB 1x, /x.webp 2x">
    <img src="https://www.gov.cn/x.png" alt="附表甲"></picture><figcaption>合成税率表</figcaption></figure>
    <img src="https://example.org/nonofficial.png" alt="附表乙"></article>`;
  t.mock.method(globalThis, 'fetch', async () => html(page));
  const doc = await readOfficialPolicy({ url });
  assert.equal(doc.status, 'attachment_unread');
  assert.equal(doc.code, 'image_only_article');
  assert.equal(doc.source.title, '合成扫描附表');
  assert.equal(doc.source.sha256, hash(page));
  assert.equal(doc.inlineImageCount, 2);
  assert.equal(doc.inlineImages[0].url, 'https://fgk.chinatax.gov.cn/synthetic/rate.avif');
  assert.equal(doc.inlineImages[0].title, '附表甲');
  assert.deepEqual(doc.inlineImages[0].alternativeUrls, ['https://fgk.chinatax.gov.cn/synthetic/rate2.avif',
    'https://fgk.chinatax.gov.cn/x.webp', 'https://www.gov.cn/x.png']);
  assert.equal(doc.inlineImages[1].url, null);
  assert.doesNotMatch(JSON.stringify(doc), /example\.org|AAAB/);
  page = '<title>合成图片原文</title><article>' + '<img src="a.bmp">'.repeat(40) + '</article>';
  const many = await readOfficialPolicy({ url });
  assert.equal(many.status, 'attachment_unread');
  assert.equal(many.totalCharacters, 0);
  assert.equal(many.inlineImageCount, 40);
  assert.equal(many.inlineImages.length, 30);
});

test('异常、未解析附件、检索页和不完整传输均不会产生正文证据', async t => {
  const retrieve = t.mock.method(globalThis, 'fetch', async () => new Response('Bad Gateway', { status: 502 }));
  assert.equal((await readOfficialPolicy({ url })).source.httpStatus, 502);
  retrieve.mock.mockImplementation(async () => { throw new TypeError('fetch failed'); });
  assert.equal((await readOfficialPolicy({ url })).code, 'network_error');
  for (const contentType of ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']) {
    retrieve.mock.mockImplementation(async () => new Response('data', { headers: { 'Content-Type': contentType } }));
    assert.equal((await readOfficialPolicy({ url })).status, 'attachment_unread');
  }
  retrieve.mock.mockImplementation(async () => html('%PDF-1.7'));
  assert.equal((await readOfficialPolicy({ url })).status, 'attachment_unread');
  retrieve.mock.mockImplementation(async () => html('<title>检索结果</title><main><h1>结果</h1><ul><li>候选标题</li></ul></main>'));
  assert.equal((await readOfficialPolicy({ url })).code, 'article_not_found');
  retrieve.mock.mockImplementation(async () => new Response(null, { status: 206 }));
  assert.equal((await readOfficialPolicy({ url })).code, 'http_error');
  retrieve.mock.mockImplementation(async () => new Response('tiny', { headers: { 'Content-Length': '4000000', 'Content-Type': 'text/html' } }));
  assert.equal((await readOfficialPolicy({ url })).code, 'response_too_large');
  retrieve.mock.mockImplementation(async () => html('x'.repeat(2 * 1024 * 1024 + 1)));
  assert.equal((await readOfficialPolicy({ url })).code, 'response_too_large');
});

test('读取窗口须在允许范围内，输入里的额外网络选项不会覆盖传输', async t => {
  const retrieve = t.mock.method(globalThis, 'fetch', async () => html(article));
  for (const args of [{ offset: -1 }, { limit: 0 }, { limit: 12001 }, { offset: 0.1 }, { expectedSha256: 'bad' }]) {
    assert.equal((await readOfficialPolicy({ url, ...args })).status, 'unavailable');
  }
  assert.equal(retrieve.mock.callCount(), 0);
  const result = await readOfficialPolicy({ url, method: 'POST', headers: { Cookie: 'private' }, fetch: () => assert.fail() });
  assert.equal(result.status, 'read');
  const [, options] = retrieve.mock.calls[0].arguments;
  assert.equal(options.method, 'GET');
  assert.equal(options.headers.Cookie, undefined);
});
