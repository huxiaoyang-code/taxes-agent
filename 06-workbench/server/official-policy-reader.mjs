// 只读取公开机关网页。网页元数据按其原标签保存，发布日期、成文日期和检索时点分别列示。
import { createHash } from 'node:crypto';
import { parse } from 'parse5';

const maxBytes = 2 * 1024 * 1024;
const fileExtension = /\.(?:pdf|docx?|xlsx?|pptx?|rtf|ofd|zip|rar|7z|wps|et)(?:$|[?#])/i;
const omitted = new Set(['script', 'style', 'template', 'noscript', 'iframe', 'form', 'nav', 'footer', 'svg', 'button']);
const blocks = new Set(['article', 'section', 'aside', 'div', 'p', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'tr', 'br', 'hr', 'blockquote']);
const attr = (element, name) => element.attrs?.find(attribute => attribute.name === name)?.value;
const problem = (code, message) => Object.assign(new Error(message), { code });

export function officialPolicyUrl(value, base) {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096 || /[\\\u0000-\u001f\u007f]/.test(value)) {
    throw problem('invalid_url', '请提供公开机关文件的完整 HTTPS 地址。');
  }
  let url;
  try { url = new URL(value, base); } catch { throw problem('invalid_url', '无法识别政策文件地址。'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !/(^|\.)gov\.cn$/.test(url.hostname)) {
    throw problem('unofficial_url', '只接受使用默认 HTTPS 端口、无登录凭据的中国政府和人大公开文件地址。');
  }
  for (const name of url.searchParams.keys()) {
    if (/^(?:(?:access|refresh|id)?token|apikey|authorization|cookie|password|session(?:id)?|jsessionid)$/i.test(name.replace(/[_-]/g, ''))) {
      throw problem('credential_in_url', '请使用不含会话、密码或访问令牌的公开文件链接。');
    }
  }
  url.hash = '';
  return url;
}

async function getResponse(initialUrl, signal) {
  let url = initialUrl;
  const redirects = [];
  for (;;) {
    const response = await fetch(url.href, {
      method: 'GET', credentials: 'omit', redirect: 'manual', signal,
      headers: { Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5' },
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return { response, url, redirects };
    await response.body?.cancel();
    if (redirects.length >= 4) throw problem('redirect_limit', '官方页面重定向次数过多，请核对文件地址。');
    url = officialPolicyUrl(response.headers.get('location'), url);
    redirects.push(url.href);
  }
}

async function readBytes(response) {
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel();
    throw problem('response_too_large', '文件超过 2 MiB 的网页读取上限。');
  }
  const parts = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.byteLength;
    if (size > maxBytes) throw problem('response_too_large', '解码后文件超过 2 MiB 的网页读取上限。');
    parts.push(chunk);
  }
  return Buffer.concat(parts, size);
}

function decode(bytes, contentType) {
  const peek = bytes.subarray(0, 4096).toString('latin1');
  const label = /charset\s*=\s*["']?([\w.-]+)/i;
  const found = contentType.match(label)?.[1] ?? peek.match(/<meta\b[^>]*charset\s*=\s*["']?([\w.-]+)/i)?.[1];
  let labels = found ? [found] : ['utf-8', 'gb18030'];
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) labels = ['utf-8'];
  if (bytes[0] === 0xff && bytes[1] === 0xfe) labels = ['utf-16le'];
  if (bytes[0] === 0xfe && bytes[1] === 0xff) labels = ['utf-16be'];
  for (const encoding of labels) {
    try {
      const decoder = new TextDecoder(encoding, { fatal: true });
      return { value: decoder.decode(bytes), encoding: decoder.encoding };
    } catch { /* 无编码声明时再按中文传统编码尝试。 */ }
  }
  throw problem('unreadable_encoding', '无法按页面声明的字符集无损读取正文。');
}

function hidden(node) {
  return omitted.has(node.tagName) || attr(node, 'hidden') !== undefined || attr(node, 'aria-hidden') === 'true'
    || /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\b/i.test(attr(node, 'style') || '');
}

function* nodes(root) {
  const pending = [root];
  while (pending.length) {
    const node = pending.pop();
    if (hidden(node)) continue;
    yield node;
    const children = node.childNodes ?? [];
    for (let index = children.length - 1; index >= 0; index--) pending.push(children[index]);
  }
}

function visibleText(root) {
  if (!root) return '';
  const parts = [];
  const pending = [root];
  while (pending.length) {
    const node = pending.pop();
    if (typeof node === 'string') { parts.push(node); continue; }
    if (hidden(node)) continue;
    if (node.nodeName === '#text') { parts.push(node.value.replace(/[\t\r\n ]+/g, ' ')); continue; }
    if (blocks.has(node.tagName)) { parts.push('\n'); pending.push('\n'); }
    if (node.tagName === 'td' || node.tagName === 'th') pending.push('\t');
    const children = node.childNodes ?? [];
    for (let index = children.length - 1; index >= 0; index--) pending.push(children[index]);
  }
  return parts.join('').split('\n').map(line => line.replace(/[ \u00a0]+/g, ' ').trim()).filter(Boolean).join('\n');
}

function labeledDate(elements, label) {
  // 只接受标题区独立标注的日期；正文里的实施、备案和被引用文件的日期不属于本页元数据。
  const pattern = new RegExp('^\\s*(?:' + label + ')[：:\\s]+(\\d{4}[-年./]\\d{1,2}[-月./]\\d{1,2}日?)');
  for (const node of elements) {
    if (!node.childNodes?.some(child => child.nodeName === '#text' && patternPrefix.test(child.value.trim()))) continue;
    const date = visibleText(node).match(pattern);
    if (date) return date[1];
  }
  return null;
}
const patternPrefix = /^(?:发布时间|发布日期|成文日期|发文日期)/;

// 不同公开站点的正文标记。具体正文优先于整页容器，以免菜单、检索条目或登录表单被当作法律条文。
const articleMarkers = new Set(['arc_cont', 'article_content', 'article-content', 'articlecontent', 'articlecon',
  'pages_content', 'pages_content1', 'zoom', 'ucapcontent', 'trs_editor', 'trs_ueditor',
  'zw', 'zwcon', 'zwcontent', 'xl_content', 'artibody', 'content-detail', 'content_detail']);

function bodyRank(node) {
  const markers = ((attr(node, 'id') ?? '') + ' ' + (attr(node, 'class') ?? '')).toLowerCase().split(/\s+/);
  if (markers.some(marker => articleMarkers.has(marker))) return 3;
  if (node.tagName === 'article' || attr(node, 'itemprop') === 'articleBody') return 2;
  if (node.tagName === 'main' || attr(node, 'role') === 'main') return 1;
  return 0;
}

// srcset 中 data URL 自带逗号，不能拆成相对于机关网站的地址。
function imageCandidates(element) {
  const urls = [attr(element, 'data-src'), attr(element, 'data-original'), attr(element, 'src')];
  const candidates = attr(element, 'srcset') ?? attr(element, 'data-srcset') ?? '';
  const tokens = /[^\s,]\S*/g;
  let match;
  while ((match = tokens.exec(candidates))) {
    const token = match[0];
    urls.push(token.replace(/,+$/, ''));
    if (!token.endsWith(',')) {
      const separator = candidates.indexOf(',', tokens.lastIndex);
      if (separator < 0) break;
      tokens.lastIndex = separator + 1;
    }
  }
  return urls.filter(Boolean);
}

function articleImages(body, url, text, title) {
  const images = [];
  const labels = new Set([title]);
  let count = 0;
  let previousText = '';
  for (const node of nodes(body)) {
    if (node.nodeName === '#text') {
      previousText = (previousText + node.value.replace(/\s+/g, ' ')).slice(-160);
      continue;
    }
    const isPicture = node.tagName === 'picture';
    if (!isPicture && (node.tagName !== 'img' || node.parentNode?.tagName === 'picture')) continue;
    const members = isPicture ? [...nodes(node)].filter(child => ['source', 'img'].includes(child.tagName)) : [node];
    const img = members.find(child => child.tagName === 'img');
    const alt = img && (attr(img, 'alt') || attr(img, 'title'));
    const container = node.parentNode;
    const figure = container?.tagName === 'figure' ? container : container?.parentNode?.tagName === 'figure' ? container.parentNode : null;
    const caption = visibleText(figure?.childNodes?.find(child => child.tagName === 'figcaption'));
    const candidates = members.flatMap(imageCandidates);
    // 只过滤明确的工具图标、空白追踪像素。旧公文的重要附表常无 alt，仍须登记。
    if (/^(?:打印(?:本页)?|分享(?:到)?|扫一扫|返回顶部|关闭窗口)$/.test(alt?.trim() ?? '') ||
        (candidates.length && candidates.every(value => /\/(?:art_ico_print|print(?:[_-]?icon)?|share(?:[_-]?icon)?|spacer|blank|loading|qrcode)\.(?:gif|png|svg|jpe?g)(?:[?#]|$)/i.test('/' + value))) ||
        (img && ['width', 'height'].every(name => /^[01](?:px)?$/.test(attr(img, name) ?? '')))) continue;
    count++;
    if (caption) labels.add(caption);
    if (alt) labels.add(alt.trim());
    if (images.length >= 30) continue;
    const links = new Set();
    for (const candidate of candidates) {
      try {
        const link = officialPolicyUrl(candidate.replace(/^http:\/\//i, 'https://'), url);
        if (link.href !== url.href) links.add(link.href);
      } catch { /* 嵌入数据或外站图片保留未读状态，可回原页定位。 */ }
    }
    const [first, ...alternatives] = links;
    images.push({ index: count, status: 'unread', url: first ?? null, title: (alt || caption || '').trim().slice(0, 300) || null,
      precedingText: previousText.trim().slice(-120) || null, ...(alternatives.length && { alternativeUrls: alternatives.slice(0, 4) }) });
  }
  const imageOnly = count > 0 && text.split('\n').every(line => !line || labels.has(line) ||
    /^(?:附[件图表]\s*[一二三四五六七八九十\d]*[：:]?|点击(?:图片|查看大图)|.{0,50}税率表[一二三四五六七八九十\d]*)$/.test(line));
  return { inlineImages: images, inlineImageCount: count, imageOnly };
}

function pageLinks(elements, body, url) {
  const attachments = new Map();
  const related = new Map();
  const areas = [{ node: body, kind: 'article' }];
  for (const node of elements) {
    const markers = ((attr(node, 'class') ?? '') + ' ' + (attr(node, 'id') ?? '')).toLowerCase().split(/\s+/);
    if (markers.includes('zscont')) areas.push({ node, kind: 'annotation' });
    else if (markers.some(marker => ['gljdlist', 'glwjlist', 'glwdlist', 'relevance', 'related', 'relatedlinks', 'related-links'].includes(marker))) {
      areas.push({ node, kind: 'related_section' });
    } else if (markers.some(marker => ['attachment', 'attachments', 'file_append', 'fileappend', 'appendix', 'fjlist'].includes(marker))) {
      areas.push({ node, kind: 'attachments' });
    }
  }
  // 优先保留法规库注释及关联文件区中的生效、废止、修订或解释指向。
  areas.sort((a, b) => Number(a.kind === 'article') - Number(b.kind === 'article'));
  for (const area of areas) {
    for (const node of nodes(area.node)) {
      if (node.tagName !== 'a') continue;
      const href = attr(node, 'href')?.trim();
      if (!href || href.startsWith('#')) continue;
      const title = (visibleText(node) || attr(node, 'title') || '').trim().slice(0, 300);
      let link;
      try { link = officialPolicyUrl(href.replace(/^http:\/\//i, 'https://'), url); } catch { continue; }
      if (link.href === url.href) continue;
      const item = { title, url: link.href };
      if (/^http:\/\//i.test(href)) item.declaredUrl = new URL(href).href;
      if (fileExtension.test(link.href) || fileExtension.test(title) || /^附件(?:[一二三四五六七八九十\d：:、.\s]|$)/.test(title)) {
        attachments.set(link.href, item);
      } else if (title && area.kind !== 'attachments' && !related.has(link.href)) {
        related.set(link.href, { ...item, location: area.kind });
      }
    }
  }
  return { attachments: [...attachments.values()].slice(0, 50), attachmentCount: attachments.size,
    relatedLinks: [...related.values()].slice(0, 30), relatedLinkCount: related.size };
}

function articleInfo(html, url) {
  const root = parse(html);
  const elements = [...nodes(root)].filter(node => node.tagName);
  const meta = new Map(elements.filter(node => node.tagName === 'meta').map(node =>
    [(attr(node, 'name') ?? attr(node, 'property') ?? '').toLowerCase(), attr(node, 'content')?.trim()]));
  const firstTag = name => elements.find(node => node.tagName === name);
  const byClass = name => elements.find(node => (attr(node, 'class') ?? '').split(/\s+/).includes(name));
  let body;
  let rank = 0;
  for (const node of elements) {
    const weight = bodyRank(node);
    if (weight > rank) { rank = weight; body = node; }
  }
  const headerElements = elements.slice(0, elements.indexOf(body));
  const fields = new Map();
  for (const row of headerElements.filter(node => node.tagName === 'tr')) {
    const cells = row.childNodes.filter(node => node.tagName === 'td' || node.tagName === 'th');
    for (let i = 0; i < cells.length - 1; i++) {
      const key = visibleText(cells[i]).replace(/[\s：:]/g, '');
      if (['标题', '发文机关', '成文日期', '发布日期', '发文字号'].includes(key)) fields.set(key, visibleText(cells[i + 1]).slice(0, 500));
    }
  }
  const text = visibleText(body);
  const title = (fields.get('标题') || meta.get('articletitle') || visibleText(firstTag('h1')) || meta.get('og:title') || visibleText(firstTag('title'))).slice(0, 500);
  if (!title || !body || (rank === 1 && !meta.get('articletitle'))) {
    throw problem('article_not_found', '未识别出文件标题和正文，请打开具体文件页面，或改用其他官方转载页。');
  }
  const images = articleImages(body, url, text, title);
  if (!text && !images.inlineImageCount) throw problem('article_not_found', '页面正文为空，请核对其他官方原文。');
  const articleHead = byClass('article_head');
  const statusHeader = visibleText(articleHead);
  const numberedHeading = visibleText(firstTag('h5'));
  const publishedTag = visibleText(headerElements.find(node => node.tagName === 'publishtime'));
  const metadataPubDate = meta.get('pubdate')?.slice(0, 60) || null;
  const info = {
    title, origin: meta.get('contentsource')?.slice(0, 300) || null, issuingAuthority: fields.get('发文机关') || null,
    siteName: meta.get('sitename')?.slice(0, 300) || null,
    publishedOn: fields.get('发布日期') || labeledDate(headerElements, '发布时间|发布日期') || publishedTag.slice(0, 60) || metadataPubDate,
    metadataPubDate,
    issuedOn: fields.get('成文日期') || labeledDate(headerElements, '成文日期|发文日期'),
    documentNumber: (fields.get('发文字号') || meta.get('filenumber') || (/[令号]/.test(numberedHeading) ? numberedHeading : '')).slice(0, 160) || null,
    observedStatus: (visibleText(byClass('xg')) || statusHeader.match(/(?:有效性|文件状态|状态)[：:]\s*([^\s]{2,16})/)?.[1] || '').slice(0, 120) || null,
    annotation: visibleText(byClass('zscont')).slice(0, 1200) || null,
  };
  return { text, info, ...images, ...pageLinks(elements, body, url) };
}

function validateWindow(offset, limit, expectedSha256) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 12000) {
    throw problem('invalid_window', 'offset 应为非负整数，limit 应为 1 至 12000 个字符。');
  }
  if (expectedSha256 !== undefined && (typeof expectedSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(expectedSha256))) {
    throw problem('invalid_digest', 'expectedSha256 应为上次读取返回的 sha256。');
  }
}

export async function readOfficialPolicy({ url, offset = 0, limit = 6000, expectedSha256 } = {}) {
  let source;
  const signal = AbortSignal.timeout(15000);
  try {
    validateWindow(offset, limit, expectedSha256);
    const requestedUrl = officialPolicyUrl(url);
    source = { requestedUrl: requestedUrl.href };
    const { response, url: finalUrl, redirects } = await getResponse(requestedUrl, signal);
    const contentType = response.headers.get('content-type') ?? '';
    Object.assign(source, { url: finalUrl.href, host: finalUrl.hostname, retrievedAt: new Date().toISOString(), httpStatus: response.status, contentType, redirects });
    if (response.status !== 200) {
      await response.body?.cancel();
      throw problem('http_error', '官方站点返回 HTTP ' + response.status + '，未取得完整文件。');
    }
    const mediaType = contentType.split(';')[0].trim().toLowerCase();
    const knownText = ['text/html', 'application/xhtml+xml', 'text/plain'].includes(mediaType);
    if (fileExtension.test(finalUrl.href) || (mediaType && !knownText)) {
      await response.body?.cancel();
      return { status: 'attachment_unread', code: 'unsupported_format', message: '该资源的正文未解析，请按官方原链接核对原件。', source };
    }
    const bytes = await readBytes(response);
    Object.assign(source, { byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    if (expectedSha256 && expectedSha256 !== source.sha256) throw problem('source_changed', '当前网页内容已变化，请从第一页重新读取并核对引用。');
    if (bytes.subarray(0, 5).toString() === '%PDF-' || bytes.subarray(0, 2).toString() === 'PK') {
      return { status: 'attachment_unread', code: 'binary_document', message: '实际响应是二进制文件，正文未解析。', source };
    }
    const { value, encoding } = decode(bytes, contentType);
    source.encoding = encoding;
    let article;
    if (mediaType === 'text/plain' && !/<(?:!doctype|html|body|article)\b/i.test(value)) {
      const text = value.trim();
      if (!text || /[\u0000-\u0008]/.test(text)) throw problem('article_not_found', '官方页面未提供可读文本。');
      article = { text, info: { title: null, publishedOn: null, origin: null }, attachments: [], attachmentCount: 0,
        relatedLinks: [], relatedLinkCount: 0, inlineImages: [], inlineImageCount: 0 };
    } else {
      article = articleInfo(value, finalUrl);
    }
    Object.assign(source, article.info);
    if (offset > article.text.length) throw problem('offset_out_of_bounds', 'offset 超过当前正文长度。');
    const end = Math.min(offset + limit, article.text.length);
    const result = { status: 'read', source, text: article.text.slice(offset, end), offset, nextOffset: end < article.text.length ? end : null,
      totalCharacters: article.text.length, attachments: article.attachments, attachmentCount: article.attachmentCount,
      relatedLinks: article.relatedLinks, relatedLinkCount: article.relatedLinkCount, inlineImages: article.inlineImages,
      inlineImageCount: article.inlineImageCount };
    if (article.inlineImageCount) result.imageGuidance = '正文含未读取的图片。引用其中的表格或数值前，请到原页查看图片，或核对官方文字版。';
    if (article.imageOnly) Object.assign(result, { status: 'attachment_unread', code: 'image_only_article',
      message: '正文为图片，仅取得页面文字标签及图片位置，图片内容未解析。' });
    return result;
  } catch (error) {
    const diagnostic = signal.aborted ? problem('timeout', '读取官方站点超时，请稍后重试或改用官方转载页面。') :
      typeof error.code === 'string' && /^[a-z_]+$/.test(error.code) ? error : problem('network_error', '无法取得官方网页，请检查网络或改用其他官方原文地址。');
    return { status: 'unavailable', code: diagnostic.code, message: diagnostic.message, ...(source && { source }) };
  }
}
