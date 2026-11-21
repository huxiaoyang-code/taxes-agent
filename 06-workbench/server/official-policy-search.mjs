import {searchMofPolicies} from './official-policy-mof.mjs';
import {searchStaPolicies} from './official-policy-sta.mjs';
import {publicPolicyQuery} from './official-policy-query.mjs';
import {fetchPolicySearch, visibleTitle, officialResultUrl} from './official-policy-transport.mjs';

const councilSite = 'https://sousuo.www.gov.cn/zcwjk/';
const mofSite = 'https://search.mof.gov.cn/';

export async function searchCouncilPolicies(query, {page, limit}) {
  const url = new URL('/search-gov/data', councilSite);
  url.search = new URLSearchParams({t:'zhengcelibrary', q:query, searchfield:'title',
    timetype:'timeqb', sort:'score', n:String(limit), p:String(page)});
  const {bytes} = await fetchPolicySearch(url, {accept:'application/json'});
  const data = JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(bytes));
  if (data?.code === 1001 && typeof data.msg === 'string' && data.msg.includes('没有找到相关结果')) {
    return {hits:[], hasMore:false};
  }
  const groups = data?.searchVO?.catMap;
  if (data?.code !== 200 || !groups || typeof groups !== 'object' || Array.isArray(groups) || !Object.keys(groups).length) {
    throw new Error('policy_search_council_format');
  }
  const hits = [];
  let hasMore = false;
  let skipped = 0;
  for (const [category, group] of Object.entries(groups)) {
    if (!Array.isArray(group?.listVO) || !Number.isSafeInteger(group.totalCount) || group.totalCount < 0) {
      throw new Error('policy_search_council_format');
    }
    hasMore ||= group.totalCount > page * limit;
    for (const item of group.listVO.slice(0, limit)) {
      const title = visibleTitle(item?.title);
      const href = officialResultUrl(item?.url);
      if (!title || !href) {
        skipped++;
        continue;
      }
      const day = String(item.pubtimeStr ?? '').match(/^(\d{4})[.-](\d{2})[.-](\d{2})$/);
      hits.push({title, url:href, category:visibleTitle(group.catName) || category,
        ...(day ? {publishedOn:day.slice(1).join('-')} : {})});
    }
  }
  return {hits, hasMore, skipped};
}

const engines = [
  {name:'税务总局政策法规', site:'https://fgk.chinatax.gov.cn/', search:searchStaPolicies},
  {name:'国务院政策文件库', site:councilSite, search:searchCouncilPolicies},
  {name:'财政部政策发布', site:mofSite, search:searchMofPolicies},
];

export async function searchOfficialPolicies({query, page = 1, limit = 5}) {
  const term = publicPolicyQuery(query);
  if (!term || !Number.isSafeInteger(page) || page < 1 || page > 20 ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > 20) {
    throw Object.assign(new Error('请使用公开法规名称、文号或主题词，按有效页码与页大小查询。'), {code:'invalid_arguments'});
  }
  const responses = await Promise.allSettled(engines.map(({search}) => search(term, {page, limit})));
  const results = [];
  const providers = [];
  const distinct = new Set();
  for (const [i, response] of responses.entries()) {
    const {name, site} = engines[i];
    if (response.status === 'rejected') {
      const message = String(response.reason?.message ?? '');
      const code = /^policy_search_[a-z0-9_]+$/.test(message) ? message : 'policy_search_source_unavailable';
      providers.push({name, site, status:'unavailable', code});
      continue;
    }
    const {hits, hasMore, skipped = 0} = response.value;
    providers.push({name, site, status:skipped ? 'partial' : 'searched', count:hits.length, hasMore, skipped});
    for (const hit of hits) {
      if (!distinct.has(hit.url)) {
        distinct.add(hit.url);
        results.push({...hit, provider:name});
      }
    }
  }
  const unavailable = providers.filter(p => p.status === 'unavailable').length;
  let status = results.length ? 'results' : 'no_results';
  if (unavailable === providers.length) status = 'unavailable';
  else if (unavailable || providers.some(p => p.status === 'partial')) status = 'partial';
  const moreIndexed = providers.some(p => p.hasMore);
  return {action:'search', status, query:term, page, limitPerChannel:limit, retrievedAt:new Date().toISOString(),
    results, providers, hasMore:moreIndexed && page < 20, ...(moreIndexed && page === 20 ? {pageLimitReached:true} : {}),
    guidance:'结果来自在线索引，检索日期与政策适用期另行核对。用 open 读官文及其修订、废止与附件。地方文件可从主管机关公开站点或宿主搜索发现后直接打开。'};
}
