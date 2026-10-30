/**
 * backend.mjs — 财税工具的后端适配器
 *
 * 两条固定通道（LOCAL-08）：
 *   - 普通财务工具：`POST {FINANCE_API_BASE}/agent/model-tools/{toolName}`，只接受模型投影信封；
 *   - 税务 / 目录工具：`POST {FINANCE_API_BASE}/agent/tools/{toolName}`，既有输入 / 输出 / 错误不变。
 *
 * 普通财务工具**不允许**在参数错误、HTTP 失败或响应不符合信封时回退到 `/agent/tools/*`：
 * 那条本机兼容通道会返回业务原文，回退即等于绕过输出边界。
 *
 * 环境变量：
 *   FINANCE_API_BASE        后端地址，默认 http://127.0.0.1:8787
 *   FINANCE_API_TOKEN       可选 Bearer Token
 *   FINANCE_API_TIMEOUT_MS  单次请求超时，默认 15000
 */
import {
  parseModelEnvelope,
  transportFailure,
} from "./finance-model-transport.mjs";
import { MODEL_PLAIN_TOOL_NAMES, MODEL_WRITE_TOOL_NAMES } from "./tools.mjs";
import { annotateFinanceCall } from '../../../../06-workbench/server/finance-call-chain.mjs';

const API_BASE = String(process.env.FINANCE_API_BASE ?? "http://127.0.0.1:8787").replace(/\/+$/, "");
const API_TOKEN = process.env.FINANCE_API_TOKEN || "";
const TIMEOUT_MS = Number(process.env.FINANCE_API_TIMEOUT_MS || 15000);

const MODEL_TOOLS = new Set(MODEL_PLAIN_TOOL_NAMES);
const MODEL_WRITE_TOOLS = new Set(MODEL_WRITE_TOOL_NAMES);

/** 后端调用失败（税务 / 目录通道）统一用这个错误类型。 */
export class BackendError extends Error {
  constructor(code, message, details = null) {
    super(message || code);
    this.name = "BackendError";
    this.code = code;
    this.details = details;
  }
}

/**
 * 模型通道的运输失败：只携带固定失败常量，绝不携带响应片段 / 地址 / 原始异常文本。
 * `failure` 结构与 finance-model-transport 一致，MCP 层直接据此给出 isError。
 */
export class ModelTransportError extends Error {
  constructor(failure) {
    super(failure.error.code);
    this.name = "ModelTransportError";
    this.code = failure.error.code;
    this.failure = failure;
  }
}

/** 少量不需要后端的工具可在这里实现；返回 undefined 表示交给后端。 */
export function localOnly(name) {
  const table = {};
  return table[name];
}

export function backendInfo() {
  // 调试信息不得回显 API_BASE / token / 路径（只给布尔与超时）。
  return { configured: !!API_BASE, timeoutMs: TIMEOUT_MS, hasToken: !!API_TOKEN };
}

const isModelTool = (name) => MODEL_TOOLS.has(name);

function modelFailure(code, forWrite) {
  return new ModelTransportError(transportFailure(code, { forWrite }));
}

/**
 * 把 MCP 工具调用翻译成后端 HTTP 调用。
 * 普通财务工具返回**已校验的纯数据信封**；税务 / 目录工具返回既有原始 DTO。
 */
export async function callBackend(name, args, catalog) {
  const modelMode = isModelTool(name);
  const forWrite = modelMode && MODEL_WRITE_TOOLS.has(name);

  if (!API_BASE) {
    if (modelMode) throw modelFailure("backend_not_configured", forWrite);
    throw new BackendError(
      "backend_not_configured",
      `工具 ${name} 需要财税后端，但 FINANCE_API_BASE 为空。请设置后重试。`
    );
  }

  const url = `${API_BASE}${modelMode ? "/agent/model-tools/" : "/agent/tools/"}${encodeURIComponent(name)}`;
  // 税务浏览器的 ACL 校验 / 专用 Edge 启动 / CDP 连接有界但可能超过普通 15s 预算；
  // 仅税务通道保留这些专用超时，普通财务工具固定使用 TIMEOUT_MS。
  const historyTool = ["tax_history_collect", "tax_history_compare"].includes(name);
  const requestTimeoutMs = historyTool ? 180000 : name === "tax_browser_open" ? 60000 : name === "tax_live_collect" ? 90000 : TIMEOUT_MS;
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(args?.operationId?{"X-Workbench-Operation-Id":args.operationId}:{}),
        ...(API_TOKEN ? { authorization: `Bearer ${API_TOKEN}` } : {}),
      },
      body: JSON.stringify(args ?? {}),
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    // 仅关联服务器实际返回的原生身份；不改请求ID、不以有ID推断写成功。
    annotateFinanceCall({nativeOperationId:res.headers?.get?.('X-Workbench-Operation-Id')??null});
  } catch (e) {
    if (modelMode) {
      const timedOut = e?.name === "TimeoutError" || e?.name === "AbortError";
      throw modelFailure(timedOut ? "backend_timeout" : "backend_unreachable", forWrite);
    }
    if (historyTool) throw new BackendError("history_backend_unavailable", "历史查询后端暂不可用");
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

  let text;
  try {
    text = await res.text();
  } catch {
    // 响应体读取失败：可能已到后端（写场景后果未知），只回固定常量。
    if (modelMode) throw modelFailure("backend_unreachable", forWrite);
    if (historyTool) throw new BackendError("history_backend_response_unconfirmed", "历史查询后端响应未确认");
    throw new BackendError("backend_unreachable", "后端响应读取失败");
  }

  if (modelMode) {
    if (!res.ok) throw modelFailure("backend_http_error", forWrite);
    const parsed = parseModelEnvelope(text);
    if (!parsed.ok) throw modelFailure(parsed.failure.error.code, forWrite);
    return parsed.envelope;
  }

  let data = null;
  let parsed = true;
  try { data = text ? JSON.parse(text) : null; } catch { parsed = false; }

  if (!res.ok) {
    if (historyTool) throw new BackendError("history_backend_failed", "历史查询后端失败");
    const code = (parsed && data && (data.error || data.code)) || `backend_http_${res.status}`;
    const message = (parsed && data && (data.message || data.error))
      || `后端返回 HTTP ${res.status}：${text.slice(0, 200)}`;
    throw new BackendError(code, message, parsed ? data : { raw: text.slice(0, 500) });
  }
  if (!parsed) {
    if (historyTool) throw new BackendError("history_backend_invalid_json", "历史查询后端响应无效");
    throw new BackendError(
      "backend_invalid_json",
      `后端返回非 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`,
      { tool: name }
    );
  }
  return data;
}
