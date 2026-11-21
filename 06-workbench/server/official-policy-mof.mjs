import { parse } from 'parse5';
import { fetchPolicySearch, officialResultUrl } from './official-policy-transport.mjs';

const endpoint = 'https://search.mof.gov.cn/was5/web/search';

function* elements(node) {
  for (const child of node.childNodes ?? []) {
    if (child.tagName) yield child;
    yield* elements(child);
  }
}

function attr(node, name) {
  return node?.attrs?.find(item => item.name === name)?.value ?? '';
}

function content(node) {
  if (!node) return '';
  if (node.nodeName === '#text') return node.value;
  if (['script', 'style', 'template'].includes(node.tagName)) return '';
  return (node.childNodes ?? []).map(content).join('');
}

function invalidResponse() {
  return Object.assign(new Error('财政部返回了无法识别的政策搜索结果。'), { code: 'POLICY_SEARCH_RESPONSE_INVALID' });
}

function resultFromRow(row) {
  const nodes = [...elements(row)];
  const heading = nodes.find(node => node.tagName === 'dt');
  const link = heading && [...elements(heading)].find(node => node.tagName === 'a');
  const title = content(link).replace(/\s+/gu, ' ').trim();
  const url = officialResultUrl(attr(link, 'href'));
  if (!title || !url) return null;
  const stamp = nodes.find(node => node.tagName === 'span' && attr(node, 'class').split(/\s+/u).includes('fr'));
  const date = /^(\d{4})\.(\d{2})\.(\d{2})$/u.exec(content(stamp).trim());
  return { title, url, ...(date && { publishedOn: date.slice(1).join('-') }) };
}

export function parseMofSearch(html, { page = 1, limit = 8 } = {}) {
  const nodes = [...elements(parse(html))];
  const pageTitle = nodes.find(node => node.tagName === 'title');
  if (!content(pageTitle).includes('中华人民共和国财政部_全文检索')) throw invalidResponse();
  const body = nodes.find(node => node.tagName === 'body');
  const text = content(body);
  const count = /找到相关结果约\s*([\d,]+)\s*条/u.exec(text);
  const total = count && Number(count[1].replaceAll(',', ''));
  if (total === null && text.includes('没有找到和您的查询相匹配的结果')) return { hits: [], hasMore: false };
  if (total !== null && (page - 1) * limit >= total) return { hits: [], hasMore: false };

  const list = nodes.find(node => attr(node, 'class').split(/\s+/u).includes('list_search'));
  if (!list) throw invalidResponse();
  const rows = [...elements(list)].filter(node => node.tagName === 'dl');
  const hits = [];
  const urls = new Set();
  let skipped = 0;
  for (const row of rows.slice(0, limit)) {
    const result = resultFromRow(row);
    if (!result) skipped++;
    else if (!urls.has(result.url)) {
      urls.add(result.url);
      hits.push(result);
    }
  }
  if (!hits.length) throw invalidResponse();
  const hasMore = nodes.some(node => node.tagName === 'a' && attr(node, 'class').split(/\s+/u).includes('next-page'));
  return { hits, hasMore, ...(skipped && { skipped }) };
}

export async function searchMofPolicies(query, { page = 1, limit = 8, signal } = {}) {
  if (![page, limit].every(value => Number.isInteger(value) && value >= 1 && value <= 20)) {
    throw new RangeError('财政部搜索页码和每页条数均应为 1 至 20 的整数。');
  }
  const url = new URL(endpoint);
  // 272209 为财政部站内检索公开展示的“政策发布”栏目，支持正文匹配。
  url.search = new URLSearchParams({
    channelid: '272209', searchword: query, page: String(page), perpage: String(limit), orderby: '-DOCRELTIME',
  }).toString();
  const { bytes, contentType } = await fetchPolicySearch(url.href, { accept: 'text/html', signal });
  if (!/^text\/html\b/iu.test(contentType)) throw invalidResponse();
  return parseMofSearch(new TextDecoder('utf-8').decode(bytes), { page, limit });
}
