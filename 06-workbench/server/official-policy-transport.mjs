import { parseFragment } from 'parse5';
import { officialPolicyUrl } from './official-policy-reader.mjs';

// 公开搜索表单的只读网络请求。站点返回的文章链接由正文读取器另行核验。
const searchHosts = new Set(['sousuo.www.gov.cn', 'search.mof.gov.cn', 'www.chinatax.gov.cn']);
const maxBytes = 2 * 1024 * 1024;

export function visibleTitle(html) {
  if (typeof html !== 'string' || html.length > 4000) return '';
  function textOf(node) {
    if (node.nodeName === '#text') return node.value;
    if (node.nodeName === 'br') return ' ';
    if (['script', 'style', 'template'].includes(node.nodeName)) return '';
    return (node.childNodes ?? []).map(textOf).join('');
  }
  return textOf(parseFragment(html)).replace(/\s+/gu, ' ').trim().slice(0, 350);
}

export function officialResultUrl(value) {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) return null;
  try {
    return officialPolicyUrl(value.replace(/^http:/i, 'https:')).href;
  } catch {
    return null;
  }
}

function checkSearchUrl(value, base) {
  const url = new URL(value, base);
  if (url.protocol !== 'https:' || !searchHosts.has(url.hostname)
      || url.port || url.username || url.password) throw new Error('policy_search_origin_invalid');
  return url;
}

export async function fetchPolicySearch(value, {accept, signal = AbortSignal.timeout(9000)} = {}) {
  let url = checkSearchUrl(value);
  for (let hop = 0; hop < 4; hop++) {
    const response = await fetch(url, {method: 'GET', redirect: 'manual', credentials: 'omit',
      signal, headers: {accept: accept ?? 'application/json, text/html;q=0.8'}});
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location) throw new Error('policy_search_redirect_invalid');
      url = checkSearchUrl(location, url);
      continue;
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error('policy_search_http_' + response.status);
    }
    if (Number(response.headers.get('content-length')) > maxBytes) {
      await response.body.cancel();
      throw new Error('policy_search_response_too_large');
    }
    const reader = response.body.getReader();
    const chunks = [];
    let length = 0;
    try {
      for (;;) {
        const {value: chunk, done} = await reader.read();
        if (done) break;
        length += chunk.byteLength;
        if (length > maxBytes) {
          await reader.cancel();
          throw new Error('policy_search_response_too_large');
        }
        chunks.push(chunk);
      }
    } finally {
      reader.releaseLock();
    }
    return {url: url.href, bytes: Buffer.concat(chunks, length),
      contentType: response.headers.get('content-type') ?? ''};
  }
  throw new Error('policy_search_redirect_limit');
}
