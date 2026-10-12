/**
 * backend.mjs — 财税工具的后端适配器（骨架）
 *
 * 所有 22 个业务工具默认都转发到你的财税系统。你需要在这里：
 *   1) 设置 FINANCE_API_BASE / FINANCE_API_TOKEN（见 codex/.env.example）
 *   2) 按你的后端路由实现 callBackend()
 *
 * 之所以默认转发而不是内置逻辑：有数云的记账/发票/申报引擎在服务端，
 * 前端包里没有业务实现（见 ../ARCHITECTURE.md 第六节）。
 */

const API_BASE = process.env.FINANCE_API_BASE || "http://127.0.0.1:8787";
const API_TOKEN = process.env.FINANCE_API_TOKEN || "";

/** 少量不需要后端的工具可在这里实现；返回 undefined 表示交给后端。 */
export function localOnly(name) {
  const table = {
    // 示例：update_plan: (args) => ({ plan: args.plan ?? [] }),
  };
  return table[name];
}

/**
 * 把 MCP 工具调用翻译成后端 HTTP 调用。
 * 约定路由（可改）：POST {API_BASE}/agent/tools/{toolName}
 */
export async function callBackend(name, args, catalog) {
  if (!API_BASE) {
    throw new Error(
      `backend_not_configured: 工具 ${name} 需要财税后端。` +
      `请设置 FINANCE_API_BASE（当前为空）。可用查询能力 nodeId 见 finance_query_catalog，` +
      `子智能体见 catalog.subagents。`
    );
  }

  // finance_query 的最小校验：nodeId 必须在能力目录内（避免静默错误）
  if (name === "finance_query") {
    const catalogIds = new Set(Object.keys(catalog?.finance_query_catalog || {}));
    const prefixes = ["invoice.", "voucher.", "ledger.", "report.", "fund.", "period_end.", "enterprise_account."];
    const id = String(args?.nodeId || "");
    if (catalogIds.size && !catalogIds.has(id) && !prefixes.some((p) => id.startsWith(p))) {
      throw new Error(`unknown_node_id: ${id}（先用 finance_query_catalog 查看）`);
    }
  }

  const res = await fetch(`${API_BASE.replace(/\/$/, "")}/agent/tools/${encodeURIComponent(name)}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(API_TOKEN ? { authorization: `Bearer ${API_TOKEN}` } : {})
    },
    body: JSON.stringify(args ?? {})
  });

  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) {
    throw new Error(`backend_http_${res.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`);
  }
  return data;
}
