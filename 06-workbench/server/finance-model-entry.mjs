// finance-model-entry.mjs — 模型入口与本机引用读取的组装层（LOCAL-08 接线）。
//
// 职责边界：
//   - 把「原始领域执行」与「模型输出策略」组装成一条固定模型通道：
//     raw `callAgentTool` 仍然是本机兼容入口，模型通道只经 adapter 的投影信封；
//   - 本机引用读取（read / compute）由同一个进程级 FinanceOutputPolicy 实例签发，
//     能力对象（channel）只留在本模块闭包里，**不序列化到 HTTP / 模型 / 日志**；
//   - 不复制任何业务计算、DB 访问、输入业务校验或事务（全部复用 agent-tools.mjs）。
//
// 本模块只被 06-workbench/server/server.mjs（HTTP 入口）与本机测试引用。
// adapter 本身不 import agent-tools，避免循环与额外 DB 初始化。
import { callAgentTool } from "./agent-tools.mjs";
import { createFinanceModelAdapter } from "./finance-model-adapter.mjs";
import { FinanceOutputPolicy, OutputPolicyError } from "./finance-output-policy.mjs";

export const MODEL_ENTRY_VERSION = "finance-model-entry/v1";
export const LOCAL_CHANNEL_LABEL = "local_ui";

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

/** 只接受普通 JSON 对象：拒绝数组、类实例、访问器 / 伪造原型。 */
function plainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** 只读自有 data 属性（不触发 getter，不顺着原型链）。 */
function ownData(record, key) {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor || !hasOwn(descriptor, "value")) return undefined;
  return descriptor.value;
}

/** accountSetId 只接受正整数 / 纯数字字符串，避免 Number(true) === 1 之类的隐式选账套。 */
function normalizeAccountSetId(raw) {
  if (typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0) return raw;
  if (typeof raw === "string" && /^[1-9][0-9]{0,15}$/.test(raw)) {
    const id = Number(raw);
    if (Number.isSafeInteger(id) && id > 0) return id;
  }
  throw new OutputPolicyError("output_policy_account_set_invalid", "必须显式提供正整数 accountSetId");
}

/**
 * 本机读取请求的显式绑定校验：
 *   - 必须显式给 ref / accountSetId / operation；
 *   - 请求体里出现 `channel` / `local`（无论什么值）一律拒绝：能力只能来自本机签发；
 *   - 不解析、不转发任何调用方提供的 channel。
 */
function localRequest(body, { compute = false, channel } = {}) {
  if (!plainRecord(body)) {
    throw new OutputPolicyError("output_policy_local_request_invalid", "请求体必须是 JSON 对象");
  }
  if (hasOwn(body, "channel") || hasOwn(body, "local")) {
    throw new OutputPolicyError("output_policy_channel_untrusted",
      "不接受请求里的 channel / local 字段；能力对象只能由本机进程签发");
  }
  const ref = ownData(body, "ref");
  if (typeof ref !== "string") {
    throw new OutputPolicyError("output_policy_ref_invalid", "必须显式提供引用 ref");
  }
  const accountSetId = normalizeAccountSetId(ownData(body, "accountSetId"));
  const operation = ownData(body, "operation");
  if (operation === undefined || operation === null) {
    throw new OutputPolicyError("output_policy_operation_required", "必须显式提供 operation");
  }
  if (typeof operation !== "string") {
    throw new OutputPolicyError("output_policy_ref_binding_mismatch", "operation 必须是已登记的原始字符串");
  }
  // 能力对象永远来自本模块闭包（本机签发），绝不来自请求体。
  const context = { channel, accountSetId, operation };
  if (compute) {
    const op = ownData(body, "op");
    if (op !== undefined) context.op = op;
    if (hasOwn(body, "path")) context.path = ownData(body, "path");
  }
  return { ref, context };
}

/**
 * 创建一个模型入口实例。默认单例在模块底部创建（一个进程一个 policy，引用不会因每次
 * 请求新建 policy 而立即失效）。
 *
 * options：
 *   - executeRaw：注入的原始执行函数（默认真实 `callAgentTool`）；
 *   - policy：复用既有 FinanceOutputPolicy 实例（测试 / 多入口共享时）；
 *   - policyOptions：新建 policy 时传给构造函数的选项（**仅测试用**，生产不暴露）。
 */
export function createFinanceModelEntry(options = {}) {
  if (!plainRecord(options)) throw new TypeError("finance-model-entry: options 必须是对象");
  const injectedExecute = ownData(options, "executeRaw");
  const executeRaw = typeof injectedExecute === "function"
    ? injectedExecute
    : (name, args) => callAgentTool(name, args);
  const injectedPolicy = ownData(options, "policy");
  const policyOptions = ownData(options, "policyOptions");
  if (injectedPolicy !== undefined && !(injectedPolicy instanceof FinanceOutputPolicy)) {
    throw new TypeError("finance-model-entry: policy 必须是 FinanceOutputPolicy 实例");
  }
  const policy = injectedPolicy instanceof FinanceOutputPolicy
    ? injectedPolicy
    : new FinanceOutputPolicy(plainRecord(policyOptions) ? policyOptions : {});

  // 能力对象只存在于本闭包，不导出、不序列化：任何 HTTP / 模型请求都无法声明它。
  const channel = policy.issueChannel(LOCAL_CHANNEL_LABEL);
  const adapter = createFinanceModelAdapter({ executeRaw, policy });

  /** 普通财务工具的固定模型入口：永远返回信封，不抛原始异常。 */
  async function callModelTool(name, args = {}) {
    return adapter.callModelTool(name, args);
  }

  /** 本机读取原文：请求必须显式带 ref / accountSetId / operation。 */
  function readLocalReference(body) {
    const { ref, context } = localRequest(body, { channel });
    return policy.localRead(ref, context);
  }

  /** 本机受限算术（sum / count / min / max + 受限 path）。 */
  function computeLocalReference(body) {
    const { ref, context } = localRequest(body, { compute: true, channel });
    return policy.localCompute(ref, context);
  }

  /** 本机撤销引用（测试 / 本机收尾用；不挂到模型或 MCP 工具）。 */
  function revokeLocalReference(body) {
    const { ref, context } = localRequest(body, { channel });
    return policy.revokeLocalRef(ref, context);
  }

  function stats() {
    return {
      version: MODEL_ENTRY_VERSION,
      adapter: adapter.version,
      ...policy.stats(),
    };
  }

  return Object.freeze({
    version: MODEL_ENTRY_VERSION,
    policy,
    adapter,
    callModelTool,
    readLocalReference,
    computeLocalReference,
    revokeLocalReference,
    stats,
  });
}

/** 进程级默认实例：HTTP 服务与直接模型调用共用同一个 policy / 引用池。 */
export const financeModelEntry = createFinanceModelEntry();

export const callModelTool = financeModelEntry.callModelTool;
export const readLocalReference = financeModelEntry.readLocalReference;
export const computeLocalReference = financeModelEntry.computeLocalReference;
export const revokeLocalReference = financeModelEntry.revokeLocalReference;
export const financeModelEntryStats = financeModelEntry.stats;

export default financeModelEntry;
