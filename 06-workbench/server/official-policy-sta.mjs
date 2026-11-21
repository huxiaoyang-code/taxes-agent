import { fetchPolicySearch, officialResultUrl, visibleTitle } from './official-policy-transport.mjs';

// 总局站点按从零起的固定十条页返回，传入其他 pageSize 仍为十条。
const sourcePageSize = 10;
const endpoint = 'https://www.chinatax.gov.cn/search5/search/s';

async function sourcePage(query, number, signal) {
  const url = new URL(endpoint);
  url.search = new URLSearchParams({
    siteCode: 'bm29000002', searchSiteName: 'GSFFK', column: '政策法规', searchWord: query,
    type: '0', orderBy: '5', likeDoc: '0', wordPlace: '0', indexCode: '1', participleRule: '5',
    pageSize: String(sourcePageSize), pageNum: String(number),
  });
  const { bytes, contentType } = await fetchPolicySearch(url, { accept: 'application/json', signal });
  if (!/^application\/json\b/i.test(contentType)) throw new Error('policy_search_sta_format');
  const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))?.searchResultAll;
  if (data?.status !== 1000 || !Number.isSafeInteger(data.total) || data.total < 0 ||
      !Array.isArray(data.searchTotal) || data.searchTotal.length > sourcePageSize) {
    throw new Error('policy_search_sta_format');
  }
  return data;
}

function policyHit(row) {
  if (row?.column !== '政策法规') return null;
  const title = visibleTitle(row.title);
  const url = officialResultUrl(row.url);
  if (!title || !url) return null;
  const hit = { title, url };
  const published = /^(\d{4}-\d{2}-\d{2})(?:\s|$)/u.exec(row.pubDate);
  if (published) hit.publishedOn = published[1];
  const fields = {
    publisher: row.pubName, documentNumber: row.govDoc?.docNum,
    indexedStatus: row.xxgk_aging, category: row.label,
  };
  for (const [key, value] of Object.entries(fields)) {
    const clean = visibleTitle(value);
    if (clean) hit[key] = clean;
  }
  return hit;
}

export async function searchStaPolicies(query, { page = 1, limit = 8, signal } = {}) {
  if (![page, limit].every(value => Number.isInteger(value) && value >= 1 && value <= 20)) {
    throw new RangeError('税务总局搜索页码和每页条数均应为 1 至 20 的整数。');
  }
  const start = (page - 1) * limit;
  const end = start + limit;
  const firstPage = Math.floor(start / sourcePageSize);
  const lastPage = Math.floor((end - 1) / sourcePageSize);
  const requests = [];
  const deadline = signal ?? AbortSignal.timeout(9000);
  for (let number = firstPage; number <= lastPage; number++) {
    requests.push(sourcePage(query, number, deadline));
  }
  const pages = await Promise.allSettled(requests);
  const successful = pages.filter(result => result.status === 'fulfilled');
  if (!successful.length) throw pages[0].reason;
  const total = Math.max(...successful.map(result => result.value.total));
  const hits = [];
  let skipped = 0;
  for (let i = start; i < Math.min(end, total); i++) {
    const chunk = pages[Math.floor(i / sourcePageSize) - firstPage];
    const hit = chunk.status === 'fulfilled' && policyHit(chunk.value.searchTotal[i % sourcePageSize]);
    if (hit) hits.push(hit);
    else skipped++;
  }
  return { hits, hasMore: end < total, skipped };
}
