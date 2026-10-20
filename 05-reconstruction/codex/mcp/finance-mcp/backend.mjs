/**
 * backend.mjs — 财税工具的后端适配器
 *
 * MCP 工具调用统一翻译成 HTTP：POST {FINANCE_API_BASE}/agent/tools/{toolName}
 * （路由实现在 06-workbench/server/server.mjs，执行层在 agent-tools.mjs）
 *
 * 环境变量：
 *   FINANCE_API_BASE        后端地址，默认 http://127.0.0.1:8787
 *   FINANCE_API_TOKEN       可选 Bearer Token
 *   FINANCE_API_TIMEOUT_MS  单次请求超时，默认 15000
 */

const API_BASE = String(process.env.FINANCE_API_BASE ?? "http://127.0.0.1:8787").replace(/\/+$/, "");
const API_TOKEN = process.env.FINANCE_API_TOKEN || "";
const TIMEOUT_MS = Number(process.env.FINANCE_API_TIMEOUT_MS || 15000);

/** 后端调用失败（不可达 / 超时 / 非 2xx / 非 JSON）统一用这个错误类型。 */
export class BackendError extends Error {
  constructor(code, message, details = null) {
    super(message || code);
    this.name = "BackendError";
    this.code = code;
    this.details = details;
  }
}

/** 少量不需要后端的工具可在这里实现；返回 undefined 表示交给后端。 */
export function localOnly(name) {
  const table = {};
  return table[name];
}

export function backendInfo() {
  return { apiBase: API_BASE, timeoutMs: TIMEOUT_MS, hasToken: !!API_TOKEN };
}

/**
 * 把 MCP 工具调用翻译成后端 HTTP 调用。
 * 失败时抛 BackendError（带 code），由 MCP 层转成 isError 的结构化内容。
 */
export async function callBackend(name, args, catalog) {
  if (!API_BASE) {
    throw new BackendError(
      "backend_not_configured",
      `工具 ${name} 需要财税后端，但 FINANCE_API_BASE 为空。请设置后重试。`
    );
  }

  // finance_query 的最小校验：nodeId 必须在能力目录内（避免静默错误）
  if (name === "finance_query") {
    const catalogIds = new Set(Object.keys(catalog?.finance_query_catalog || {}));
    const prefixes = ["invoice.", "voucher.", "ledger.", "report.", "fund.", "period_end.", "enterprise_account."];
    const id = String(args?.nodeId || "");
    if (catalogIds.size && !catalogIds.has(id) && !prefixes.some((p) => id.startsWith(p))) {
      throw new BackendError("unknown_node_id", `未知查询能力：${id}（先用 finance_query_catalog 查看）`, { nodeId: id });
    }
  }

  const url = `${API_BASE}/agent/tools/${encodeURIComponent(name)}`;
  // ACL verification + dedicated Edge startup + CDP connect are bounded but
  // can exceed the ordinary 15 s request budget. Repeating open is idempotent.
  const privateQuery = name === "tax_query_collect" || name === "tax_query_compare";
  const requestTimeoutMs = privateQuery ? 180000 : name === "tax_browser_open" ? 60000 : name === "tax_live_collect" ? 90000 : TIMEOUT_MS;
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(API_TOKEN ? { authorization: `Bearer ${API_TOKEN}` } : {}),
      },
      body: JSON.stringify(args ?? {}),
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
  } catch (e) {
    if (privateQuery) throw new BackendError("query_backend_unavailable", "固定查询后端不可用或超时", { tool: name });
    const timedOut = e?.name === "TimeoutError" || e?.name === "AbortError";
    const reason = timedOut
      ? `请求超时（${requestTimeoutMs}ms）`
      : String(e?.cause?.code || e?.message || e);
    throw new BackendError(
      "backend_unreachable",
      `无法连接财税后端 ${API_BASE}：${reason}。请确认 06-workbench 已启动，且 FINANCE_API_BASE 指向它。`,
      { apiBase: API_BASE, tool: name }
    );
  }

  const text = await res.text();
  let data = null;
  let parsed = true;
  try { data = text ? JSON.parse(text) : null; } catch { parsed = false; }

  if (!res.ok) {
    if (privateQuery) throw new BackendError("query_backend_rejected", "固定查询后端拒绝请求", { tool: name, httpStatus: res.status });
    const code = (parsed && data && (data.error || data.code)) || `backend_http_${res.status}`;
    const message = (parsed && data && (data.message || data.error))
      || `后端返回 HTTP ${res.status}：${text.slice(0, 200)}`;
    throw new BackendError(code, message, parsed ? data : { raw: text.slice(0, 500) });
  }
  if (!parsed) {
    if (privateQuery) throw new BackendError("query_backend_invalid_json", "固定查询后端响应格式错误", { tool: name });
    throw new BackendError(
      "backend_invalid_json",
      `后端返回非 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`,
      { tool: name }
    );
  }
  return data;
}
