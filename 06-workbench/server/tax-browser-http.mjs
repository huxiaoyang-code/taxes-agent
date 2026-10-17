// tax-browser-http.mjs — /api/tax-browser/* 的 HTTP 接线（回环 + 同源令牌 + 严格 JSON）
//
// 安全约定（详见 docs/TAX-BROWSER.md）：
//   - 所有响应都不带 access-control-allow-origin 通配头；本模块从不设置 CORS 放行头，
//     恶意来源拿不到任何可读响应，也无法通过预检。
//   - Host 必须是回环（127.0.0.1 / localhost / [::1] + 端口）；Origin 若出现则必须与
//     Host 精确同源（覆盖 localhost 别名）。CLI 无 Origin 也可以调用，但所有 POST 仍必须
//     携带服务端签发的令牌（login 用 config 返回的一次性 loginToken；read/close/import 用
//     不可猜的 sessionId）， hostile origin 无法取得这些令牌。
//   - GET 只读（config / session 状态），不启动浏览器、不读取税局。
//   - POST 必须是 application/json（表单/文本一律拒绝），并做会话校验。
//   - 错误只返回结构化 code + 固定文案，不透出浏览器原始输出、页面全文或凭据。
//   - 本模块只做「接线」：地区/会话/读取/导入逻辑全部在 TaxBrowserService（可注入假浏览器测试），
//     生产 server.mjs 注入真实实现，HTTP 层不存在任何 fake 开关或任意目标参数。

const MAX_BODY_BYTES = 1 << 20;

/** Host 是否为回环（127.0.0.1 / localhost / [::1]，可带端口）。 */
export function isLoopbackHost(host) {
  if (typeof host !== "string") return false;
  const m = /^(\[::1\]|127\.0\.0\.1|localhost)(?::(\d{1,5}))?$/.exec(host.trim().toLowerCase());
  if (!m) return false;
  if (m[2] !== undefined) {
    const port = Number(m[2]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
  }
  return true;
}

/**
 * 连接来源是否为回环连接（按有效 IP 判断，而非字符串前缀）。
 * 接受 127.0.0.1、::1、::ffff:127.0.0.1；IPv4 回环范围 127.0.0.0/8。
 * 绝不读取 X-Forwarded-* 等可由调用方伪造的头部。
 */
export function isLoopbackAddress(addr) {
  if (typeof addr !== "string" || addr === "") return false;
  let a = addr.trim().toLowerCase();
  if (a.startsWith("::ffff:")) a = a.slice(7);
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a);
  if (m) {
    const parts = m.slice(1).map(Number);
    if (parts.some((n) => n > 255)) return false;
    return parts[0] === 127;
  }
  return a === "::1";
}

/**
 * 回环 Host + 同源 Origin 检查。
 * 返回 { ok, origin, reason }：
 *   - host_not_local：Host 不是回环（含 DNS rebinding 场景）
 *   - origin_not_allowed：Origin 存在但与 Host 不同源（覆盖 localhost 别名）
 *   - ok=true 且 origin=null 表示没有 Origin（CLI / 顶层导航，响应本就不可跨源读取）
 */
export function checkLocalOrigin(req) {
  const host = req.headers.host;
  if (!isLoopbackHost(host)) return { ok: false, origin: null, reason: "host_not_local" };
  const origin = req.headers.origin;
  if (origin === undefined || origin === null || origin === "") return { ok: true, origin: null, reason: null };
  const originStr = String(origin).trim();
  if (originStr === `http://${host}`) return { ok: true, origin: originStr, reason: null };
  return { ok: false, origin: originStr, reason: "origin_not_allowed" };
}

/** 本地 JSON 响应：无任何 CORS 放行头（同源 UI 不需要，跨源一律不可读）。 */
const jsonLocal = (res, code, data) => {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(body);
};

const errorBody = (code, message) => ({ error: code, message });

/**
 * 明确的安全错误码字典：每个已知错误码只映射到固定的 状态码 + 固定文案。
 * 永不透传 err.message / err.details；未知 code 一律 500 tax_browser_internal。
 * 使用 null 原型 + own 属性查找，拒绝 __proto__/constructor/toString 等怪 code。
 */
const SAFE_ERRORS = Object.freeze(Object.assign(Object.create(null), {
  tax_browser_internal: { status: 500, message: "服务内部错误" },

  // HTTP 接线/请求层
  method_not_allowed: { status: 405, message: "请求方法不被允许" },
  not_found: { status: 404, message: "未知的 tax-browser 接口" },
  host_not_local: { status: 403, message: "请求 Host 不是本机回环地址" },
  origin_not_allowed: { status: 403, message: "请求来源不是本服务允许的同源来源" },
  remote_not_local: { status: 403, message: "请求来源不是本机回环连接" },
  json_content_type_required: { status: 400, message: "POST 必须是 application/json" },
  invalid_json: { status: 400, message: "请求体不是合法 JSON" },
  body_too_large: { status: 400, message: "请求体超过大小上限" },
  body_read_failed: { status: 400, message: "请求体读取失败" },

  // TaxBrowserError（浏览器/会话/读取）——状态码与原行为一致（未特判者为 400）
  tax_browser_region_not_supported: { status: 400, message: "当前仅支持指定地区的浏览器人工登录导入" },
  tax_browser_launch_failed: { status: 400, message: "浏览器窗口启动失败，请重试" },
  tax_browser_launch_timeout: { status: 400, message: "浏览器启动超时" },
  tax_browser_browser_exited: { status: 400, message: "浏览器窗口已退出" },
  tax_browser_connect_failed: { status: 400, message: "无法建立本地浏览器调试连接" },
  tax_browser_cdp_closed: { status: 400, message: "本地浏览器调试连接已关闭" },
  tax_browser_cdp_error: { status: 400, message: "浏览器调试命令失败" },
  tax_browser_cdp_timeout: { status: 400, message: "浏览器调试命令超时" },
  tax_browser_login_token_invalid: { status: 403, message: "登录令牌无效或已过期" },
  tax_browser_limit_reached: { status: 400, message: "同时进行的采集会话已达上限" },
  tax_browser_not_installed: { status: 503, message: "未找到本机 Chrome/Edge" },
  tax_browser_read_failed: { status: 400, message: "页面读取失败，请稍后重试" },
  tax_browser_read_timeout: { status: 504, message: "读取超时，请稍后重试" },
  tax_browser_page_not_supported: { status: 409, message: "当前页面不在允许来源内" },
  tax_browser_no_valid_records: { status: 422, message: "识别到记录但税号校验未通过" },
  tax_browser_layout_unrecognized: { status: 422, message: "当前页面未识别到企业记录" },
  tax_browser_session_closed: { status: 409, message: "会话已关闭" },
  tax_browser_session_expired: { status: 410, message: "会话已过期" },
  tax_browser_session_not_found: { status: 404, message: "未知或已清理的会话" },
  tax_browser_session_id_required: { status: 400, message: "缺少 sessionId" },
  tax_browser_request_field_rejected: { status: 400, message: "请求包含不支持的字段" },
  tax_browser_candidates_invalid: { status: 400, message: "candidateIds 非法" },
  tax_browser_candidate_not_found: { status: 400, message: "候选不在本会话采集结果中" },
  tax_browser_import_unavailable: { status: 400, message: "当前服务未接入导入实现" },

  // TaxImportError（导入校验）——原行为均为 400
  start_period_required: { status: 400, message: "必须显式选择启用期间" },
  start_period_invalid: { status: 400, message: "启用期间格式应为 YYYY-MM" },
  accounting_standard_required: { status: 400, message: "必须显式选择会计准则" },
  accounting_standard_invalid: { status: 400, message: "会计准则不合法" },
  taxpayer_type_required: { status: 400, message: "必须显式选择纳税人类型" },
  taxpayer_type_invalid: { status: 400, message: "纳税人类型不合法" },
  import_mode_invalid: { status: 400, message: "mode 必须是 create 或 bind" },
  items_invalid: { status: 400, message: "候选企业列表非法" },
  region_required: { status: 400, message: "缺少地区溯源信息" },
  taxpayer_id_invalid: { status: 400, message: "企业税号严格校验未通过" },
  taxpayer_id_duplicated: { status: 400, message: "同一批请求中税号重复" },
  enterprise_name_invalid: { status: 400, message: "企业名称不合法" },
  bind_single_candidate_only: { status: 400, message: "绑定已有账套一次只能选择 1 家企业" },
  accountSetId_required: { status: 400, message: "绑定模式必须显式提供目标账套 accountSetId" },
  account_set_not_found: { status: 400, message: "本地账套不存在" },
  account_set_already_bound: { status: 400, message: "账套已绑定其他税号" },
  taxpayer_id_already_bound: { status: 400, message: "该税号已绑定其他账套" },
  account_set_not_empty: { status: 400, message: "账套不是空账套，绑定导入只允许空账套" },
  name_change_confirmation_required: { status: 400, message: "名称变更须先 dryRun 预览并显式确认" },
}));

const lookupSafeError = (code) =>
  (typeof code === "string" && Object.prototype.hasOwnProperty.call(SAFE_ERRORS, code))
    ? SAFE_ERRORS[code]
    : null;

/**
 * 把服务层错误映射为固定文案的 HTTP 错误；绝不透出 err.message / err.details。
 * 未知 code（含 __proto__/constructor 等）一律 500 tax_browser_internal。
 */
function sendError(res, err) {
  const code = err && typeof err.code === "string" ? err.code : "";
  const entry = lookupSafeError(code);
  if (!entry) return jsonLocal(res, 500, errorBody("tax_browser_internal", SAFE_ERRORS.tax_browser_internal.message));
  return jsonLocal(res, entry.status, errorBody(code, entry.message));
}

/** 以固定错误码拒绝（Host/Origin/远端/方法等），文案来自安全字典。 */
const rejectWith = (res, code) => sendError(res, { code });

function readJsonBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    const contentType = String(req.headers["content-type"] || "");
    if (!/^application\/json\s*(;|$)/i.test(contentType)) {
      rejectBody(Object.assign(new Error("json_content_type_required"), { code: "json_content_type_required" }));
      return;
    }
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        rejectBody(Object.assign(new Error("body_too_large"), { code: "body_too_large" }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolveBody({});
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        rejectBody(Object.assign(new Error("invalid_json"), { code: "invalid_json" }));
      }
    });
    req.on("error", (e) => rejectBody(Object.assign(e, { code: "body_read_failed" })));
  });
}

/**
 * 创建 /api/tax-browser/* 路由。返回 async (req, res, url, method) => void；
 * 未匹配的路径返回 404。service 由调用方注入（生产=真实实现，测试=假浏览器实现）。
 */
export function createTaxBrowserRoutes(service) {
  const sessionIdOf = (url) => {
    const m = /^\/api\/tax-browser\/sessions\/([A-Za-z0-9_-]+)(?:\/(read|close|import))?$/.exec(url.pathname);
    return m ? { sid: m[1], action: m[2] || null } : null;
  };

  return async function taxBrowserRoute(req, res, url, method) {
    try {
      // 预检：不设置任何 CORS 放行头（跨源预检必然失败；同源 UI 不需要预检）。
      if (method === "OPTIONS") {
        res.writeHead(204, { allow: "GET,POST,OPTIONS" });
        return res.end();
      }

      // 连接层回环校验（按有效 IP 判断，绝不信任 X-Forwarded-*）：
      // 拒绝远端伪造 Host/Origin 的请求，即使它猜对了 Host 头也不放行。
      if (!isLoopbackAddress(req.socket?.remoteAddress)) return rejectWith(res, "remote_not_local");

      // Host/Origin 同源校验（纯 helper，保留 header 级测试兼容；socket 层已在前面把关）。
      const originCheck = checkLocalOrigin(req);
      if (!originCheck.ok) return rejectWith(res, originCheck.reason);

      const path = url.pathname;

      // ---------------- GET /api/tax-browser/config（只读；发放一次性 loginToken）
      if (path === "/api/tax-browser/config") {
        if (method !== "GET") return rejectWith(res, "method_not_allowed");
        const config = service.describeConfig();
        return jsonLocal(res, 200, { ...config, loginToken: service.issueLoginToken() });
      }

      // ---------------- POST /api/tax-browser/sessions（打开官方登录窗口）
      if (path === "/api/tax-browser/sessions") {
        if (method !== "POST") return rejectWith(res, "method_not_allowed");
        let body;
        try {
          body = await readJsonBody(req);
        } catch (e) {
          return rejectWith(res, e && typeof e.code === "string" ? e.code : "invalid_json");
        }
        const result = await service.openSession({
          region: body?.region,
          city: body?.city,
          loginToken: body?.loginToken,
        });
        return jsonLocal(res, 201, result);
      }

      // ---------------- /api/tax-browser/sessions/:sid[/(read|close|import)]
      const match = sessionIdOf(url);
      if (match) {
        const { sid, action } = match;
        if (method === "GET" && !action) {
          const result = service.getSession({ sessionId: sid });
          return jsonLocal(res, 200, result);
        }
        if (method === "POST" && action) {
          let body;
          try {
            body = await readJsonBody(req);
          } catch (e) {
            return rejectWith(res, e && typeof e.code === "string" ? e.code : "invalid_json");
          }
          if (action === "read") {
            const result = await service.readCurrentPage({ sessionId: sid });
            return jsonLocal(res, 200, result);
          }
          if (action === "close") {
            const result = await service.closeSession({ sessionId: sid });
            return jsonLocal(res, 200, { session: result, closed: true, note: "本地采集会话已关闭（不代表已从税局服务端退出）" });
          }
          // action === "import"
          const result = await service.importCandidates({
            sessionId: sid,
            candidateIds: body?.candidateIds,
            mode: body?.mode,
            create: body?.create,
            accountSetId: body?.accountSetId,
            dryRun: body?.dryRun === true,
            confirmNameChange: body?.confirmNameChange === true,
          });
          return jsonLocal(res, 200, result);
        }
        return rejectWith(res, "method_not_allowed");
      }

      // 未知路径：固定文案，绝不回显 url.pathname。
      return rejectWith(res, "not_found");
    } catch (err) {
      return sendError(res, err);
    }
  };
}
