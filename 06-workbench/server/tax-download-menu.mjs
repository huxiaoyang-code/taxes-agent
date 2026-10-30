import { randomBytes } from 'node:crypto';

// 仅投影一个已知键的本机菜单缓存，不请求或执行操作。
// value 是原生 Storage.prototype.getItem 返回的原始 JSON 字符串。
export function inspectDownloadMenuValue(value, now = Date.now()) {
  return projectDownloadMenuValue(value, now);
}

function projectDownloadMenuValue(value, now, retainLocal) {
  const result = { schemaVersion: 1, status: 'invalid_menu', evidence: 'passive_menu_only', cacheFresh: null, requestAuthorized: false,
    expirySemanticsVerified: false, expiryAssessment: 'timestamp_heuristic_only',
    navigationAuthorized: false, readOnlyVerified: false, sourceObservationVerified: false,
    sourceKind: 'known_key_menu_cache', entryAssociation: 'ephemeral_projection_only',
    entries: [], counts: { nodes: 0, matched: 0, allowed: 0, blocked: 0, unknownPaths: 0, omitted: 0 }, truncated: false };
  const fail = status => ({ ...result, status, entries: [] });
  if (value === null) return fail('missing_menu');
  if (typeof value !== 'string' || value.length > 512_000 || !Number.isFinite(now)) return fail('invalid_menu');
  let envelope;
  try { envelope = JSON.parse(value); } catch { return fail('invalid_menu'); }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) || Object.keys(envelope).sort().join(',') !== 'exp,val' || !Number.isFinite(envelope.exp) || !Array.isArray(envelope.val)) return fail('invalid_menu');
  // 仅辅助比较时间戳。网站 getter/setter 的过期语义
  // （包括哨兵值）尚未核实，不能据此证明认证或 TTL。
  result.cacheFresh = !(now - 1 > envelope.exp);
  if (!result.cacheFresh) result.evidence = 'historical_menu_only';
  const segments = new Set(`szzh szc kpfw dppt zhcx sjswszzh spHandler sbxx sbxxcx sbbdxz cwbbsbxxcx cwbbxxcxDetail nsrxxcx detail api v1 v2 v3 invoice invoices download export file files report reports financial accounting query list details print sbmxcx cwbbsb cwbb fpxx cx xz dc getDetail getDetails queryDetail queryList downloadFile exportFile exportExcel exportPdf DescribeSbmxcx2 DescribeSbmxxqInit DescribeSbmxxqcx DescribeSbmxxqzfbTree DescribeFpCx DescribeFpqk DescribeNsrfpxx DescribeNsrsbxx loginb`.split(' '));
  const keys = new Set(['cdlj', 'path', 'type', 'appId', 'menuId', 'gnDm', 'gndm']);
  const sensitive = /token|ticket|nonce|credential|password|session|authorization|accesskey|secret|sso|oauth/i;
  const action = /报送|缴款|更正|作废|保存|注册|登录|提交|撤销|申报办理|办理申报|在线申报|确认申报|sso|oauth|submit|save|register|revoke|cancel|payment|login/i;
  function pathProjection(path) {
    if (typeof path !== 'string' || path.length > 220 || !path.startsWith('/') || path.includes('//')) return { safe: false, exact: null, shape: null, unknown: 0 };
    const parts = path.split('/').filter(Boolean);
    if (!parts.length || parts.length > 12) return { safe: false, exact: null, shape: null, unknown: 0 };
    let safe = true, unknown = 0;
    const projected = parts.map(p => {
      if (segments.has(p)) return p;
      unknown++;
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(p) || /\d{6}|[a-f0-9]{16}|[a-f0-9]{8}-[a-f0-9]{4}-/i.test(p) || sensitive.test(p) || action.test(p)) safe = false;
      return ':redacted_segment';
    });
    return { safe, exact: safe && !unknown ? path : null, shape: '/' + projected.join('/') + (path.endsWith('/') ? '/' : ''), unknown };
  }
  function category(label) {
    if (/发票/.test(label) && /查询|统计|下载|导出/.test(label)) return 'invoice';
    if (/财务报表/.test(label) && /查询/.test(label)) return 'financial_report';
    if (/科目|凭证|账套|账簿/.test(label) && /查|下载|导出/.test(label)) return 'accounting_history';
    if (/申报表/.test(label) && /下载/.test(label)) return 'filing_form_download';
    return null;
  }
  const stack = envelope.val.map(item => ({ item, depth: 1 }));
  while (stack.length) {
    const { item, depth } = stack.pop();
    if (++result.counts.nodes > 5000 || depth > 12 || !item || typeof item !== 'object' || Array.isArray(item) || (item.arr !== undefined && !Array.isArray(item.arr))) return fail('invalid_menu');
    if (item.arr?.length) { for (let i = item.arr.length - 1; i >= 0; i--) stack.push({ item: item.arr[i], depth: depth + 1 }); continue; }
    if (typeof item.gnmc !== 'string' || item.gnmc.length > 128) continue;
    const group = category(item.gnmc);
    if (!group) continue;
    result.counts.matched++;
    const entry = { category: group, origin: null, path: null, pathShape: null, pathVerified: false, queryKeys: [],
      technicalDestination: null, technicalDestinationShape: null, routeRef: null, blockedReason: null };
    let localUrl = null;
    if (action.test(item.gnmc) || (/申报/.test(item.gnmc) && !/申报表.*下载|申报.*查询/.test(item.gnmc))) entry.blockedReason = 'unsafe_action';
    const service = item.yyfwqdz ?? '';
    if (typeof service !== 'string' || typeof item.cddz !== 'string' || service.length > 2048 || item.cddz.length > 2048) entry.blockedReason ??= 'missing_route';
    else try {
      // 已核实的菜单协议先拼接；否则 cddz 以斜杠开头时，
      // URL 解析会丢弃 /szc 等服务前缀。
      const combined = service + item.cddz;
      const url = new URL(combined, 'https://etax.fujian.chinatax.gov.cn:8443/loginb/');
      // 已核实官方主机词表保持有限，未知来源不回显。
      if (url.protocol !== 'https:' || !['etax.fujian.chinatax.gov.cn', 'fujian.chinatax.gov.cn', 'dppt.fujian.chinatax.gov.cn'].includes(url.hostname) || !['', '443', '8443'].includes(url.port) || url.username || url.password) entry.blockedReason ??= 'unsafe_origin';
      else {
        entry.origin = url.origin;
        const path = pathProjection(url.pathname);
        entry.pathShape = path.shape;entry.pathVerified = path.exact !== null;
        if (path.unknown || !path.safe) result.counts.unknownPaths++;
        if (!path.safe || /%|\\|(?:^|\/)\.\.(?:\/|$)/.test(combined.split(/[?#]/)[0])) entry.blockedReason ??= 'unsafe_path';
        else entry.path = path.exact;
        if (action.test(url.pathname) || sensitive.test(url.pathname)) entry.blockedReason ??= 'unsafe_action';
        if (url.hash) entry.blockedReason ??= 'unsafe_query';
        let destinationSeen = false;
        for (const [key, parameter] of url.searchParams) {
          if (sensitive.test(key)) { entry.blockedReason ??= 'credential_link'; continue; }
          if (!keys.has(key)) { entry.blockedReason ??= 'unknown_query_key'; continue; }
          if (!entry.queryKeys.includes(key)) entry.queryKeys.push(key);
          if (key === 'cdlj') {
            const destination = pathProjection(parameter);
            entry.technicalDestinationShape ??= destination.shape;
            if (destination.unknown || !destination.safe) result.counts.unknownPaths++;
            if (destination.safe && !action.test(parameter) && !sensitive.test(parameter) && !destinationSeen) entry.technicalDestination = destination.exact;
            else entry.blockedReason ??= 'unsafe_technical_destination';
            destinationSeen = true;
          }
        }
        if (entry.blockedReason === null) localUrl = url.href;
      }
    } catch { entry.blockedReason ??= 'invalid_route'; }
    result.counts[entry.blockedReason ? 'blocked' : 'allowed']++;
    if (result.entries.length < 80) {
      if (localUrl && retainLocal) retainLocal(entry, { url: localUrl, cacheExpiresAt: envelope.exp });
      result.entries.push(entry);
    }
    else { result.counts.omitted++; result.truncated = true; }
  }
  result.status = result.cacheFresh ? 'menu_observed' : 'historical_menu_observed';
  return result;
}

// 可信本机管理员能力，绝不暴露为 HTTP/Agent/MCP。实际观察 URL
// 只留在本实例闭包，不进入投影或 JSON 表示。
// 引用只标识当前快照，不代表稳定菜单身份。
// 解析不等于授权；父协调者须另行核实当前被动来源、范围及
// 只读语义后，才能发送精确 URL 发起导航。
export function createDownloadMenuLocalIndex(value, now = Date.now()) {
  const routes = new Map(), indexRef = randomBytes(24).toString('hex');
  const projection = projectDownloadMenuValue(value, now, (entry, local) => {
    const routeRef = 'menuroute_' + indexRef + '_' + routes.size;
    entry.routeRef = routeRef;
    routes.set(routeRef, { routeRef, category: entry.category, url: local.url, requestAuthorized: false, navigationAuthorized: false,
      readOnlyVerified: false, association: 'this_index_instance_only', sourceKind: 'known_key_menu_cache',
      expectedDocumentUrl: 'https://etax.fujian.chinatax.gov.cn:8443/loginb/', sourceObservationVerified: false, projectionCreatedAt: now,
      expirySemanticsVerified: false, expiryAssessment: 'timestamp_heuristic_only',
      cacheExpiresAt: local.cacheExpiresAt, cacheFresh: projectionFresh(local.cacheExpiresAt), evidence: projectionFresh(local.cacheExpiresAt) ? 'passive_menu_only' : 'historical_menu_only' });
  });
  function projectionFresh(exp) { return !(now - 1 > exp); }
  if (!['menu_observed', 'historical_menu_observed'].includes(projection.status)) routes.clear();
  const pending = [projection];
  while (pending.length) { const item = pending.pop();if (item && typeof item === 'object') { pending.push(...Object.values(item));Object.freeze(item); } }
  const index = Object.create(null);
  Object.defineProperties(index, { projection: { value: projection, enumerable: true },
    resolve: { value: routeRef => typeof routeRef === 'string' && routes.has(routeRef) ? structuredClone(routes.get(routeRef)) : null },
    toJSON: { value: () => projection } });
  return Object.freeze(index);
}

// 固定官方范围，只做一次原生已知键读取；不取得或释放
// 实时采集锁、不导航、不访问应用状态，也不调用处理器。
export function passiveDownloadMenuScript() {
  return `(() => {
    const empty = status => ({schemaVersion:1,status,evidence:'passive_menu_only',cacheFresh:null,expirySemanticsVerified:false,expiryAssessment:'timestamp_heuristic_only',requestAuthorized:false,navigationAuthorized:false,readOnlyVerified:false,sourceObservationVerified:false,sourceKind:'known_key_menu_cache',entryAssociation:'ephemeral_projection_only',entries:[],counts:{nodes:0,matched:0,allowed:0,blocked:0,unknownPaths:0,omitted:0},truncated:false});
    try {
      const expected = 'https://etax.fujian.chinatax.gov.cn:8443/loginb/';
      if (location.href !== expected) return empty('scope_mismatch');
      const read = Object.getOwnPropertyDescriptor(Storage.prototype, 'getItem')?.value;
      if (typeof read !== 'function' || !Function.prototype.toString.call(read).includes('[native code]')) return empty('capability_unavailable');
      const value = Reflect.apply(read, sessionStorage, ['mhNavDataAfter_mh']);
      if (location.href !== expected) return empty('scope_mismatch');
      return (${projectDownloadMenuValue.toString()})(value, Date.now());
    } catch { return empty('menu_unavailable'); }
  })()`;
}
