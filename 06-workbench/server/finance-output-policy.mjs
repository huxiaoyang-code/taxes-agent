// finance-output-policy.mjs — 模型输出 / 本机读取分道策略（独立模块，**尚未接线**）。
//
// 目的：把现有普通财务工具（accounting.mjs 的结果、agent-tools.mjs 的工具返回）
// 拆成两条通道，插件式地包一层，不复制任何业务算法、不改变记账结果：
//
//   1) 模型通道 wrapQuery / wrapWrite / resolveForModel
//      只输出**默认拒绝**的白名单 projection：有限数值、布尔、状态 token、期间，
//      外加一个不可猜测的本地引用。企业名、科目名/编码、摘要、往来、人员、
//      凭证行、源文件路径一律不出模型通道（靠显式字段白名单，不是敏感词黑名单）。
//
//   2) 本机通道 localRead / localCompute
//      必须持有本机签发的 capability channel 对象才能凭同一引用取回**原数据**，
//      并可做有限受控算术（sum / count / min / max）。
//      模型无法伪造：channel 是进程内对象标识，不来自调用参数；
//      模型参数里声称 local=true / channel="local" 一律拒绝，不做任何降级。
//
// 引用契约：随机 192 位、绑定账套 + 工具/操作 + 类别（query/write）、有到期时间、
// 可撤销、有最大持有数量 + 节点预算 + 字节预算；仅存于进程内（persistence=process_memory），
// 不落盘、不进日志。
//
// 输入卫生（两条通道共用）：
//   - operation 必须是**原始字符串**且已登记：先 `typeof === "string"`，再查表。任何查表 /
//     字符串转换 / 用户回调之前完成校验，因此带 toString 的对象不会被 `hasOwnProperty`
//     的 ToPropertyKey 触发，也不可能被当作 operation 原样放进模型信封；
//   - 原数据只经 `Object.getOwnPropertyDescriptor` 读自有 data 属性（不触发 getter），
//     且**先做有界形状检查再看摘要**；
//   - 读不到的恶意对象（例如 Proxy 陷阱抛错）一律 fail closed：查询拒绝、写结果降级，
//     绝不把 error.message / details / stack 带回模型。
//     注：JS 反射无法完全避免触发 Proxy 陷阱（ownKeys / getOwnPropertyDescriptor 本身就是陷阱），
//     本模块只承诺“不触发访问器 getter、不顺着原型链取值、失败即安全拒绝”，不承诺零陷阱。
//
// 边界：本模块不做多用户 / 权限体系（本机单用户），不访问数据库、不发网络请求、
// 不注册 HTTP / Agent / MCP / CLI 入口——接线由后续集成任务负责。
import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";

export const OUTPUT_POLICY_VERSION = "finance-output-policy/v1";
export const REF_PERSISTENCE = "process_memory";
/** 引用形状：192 位随机数，猜测不可行；格式校验只是快速失败，不是安全依据。 */
export const REF_PATTERN = /^finref_[a-f0-9]{48}$/;

const DEFAULT_TTL_MS = 15 * 60 * 1000;
const DEFAULT_MAX_REFS = 256;
const DEFAULT_NODE_BUDGET = 1_000_000;
const DEFAULT_VALUE_NODES = 200000;
// 字节预算：节点数不足以衡量一个 8 MiB 字符串（它只有 1 个节点）。
// 单值 4 MiB、累计 64 MiB 是本地策略上限，不是对外 SLA。
const DEFAULT_VALUE_BYTES = 4 * 1024 * 1024;
const DEFAULT_BYTE_BUDGET = 64 * 1024 * 1024;
/** 每个节点计入的固定结构化开销（8 B），用来避免大量空对象的计数塌缩。 */
const NODE_BYTE_COST = 8;
const MAX_RAW_ARRAY = 5000;
const MAX_DEPTH_RAW = 32;
/**
 * projection 里有限数值的绝对值上限（金额与计数共用）。
 * 账套 / 凭证等 ID 也走同一个数值通道：超过这个上限的 ID 无法进入 projection，
 * 会被消毒器丢弃并计入 projectionDropped。需要选择能力的 ID（账套列表 / 账套上下文）
 * 因此必须由调用方**明确拒绝**，不能静默丢掉（见 finance-model-adapter.mjs）。
 */
export const PROJECTION_NUMBER_LIMIT = 1e12;
const MONEY_LIMIT = PROJECTION_NUMBER_LIMIT;
const MAX_SEGMENTS = 8;
const MAX_COMPUTE_NODES = 1024;
const MAX_COMPUTE_ARRAY = 512;

// projection 自身的形状限制（即使 spec 写错，也不会把自由文本 / 大对象带出去）
const PROJ_KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
const OP_RE = /^[A-Za-z][A-Za-z0-9_.:]{0,63}$/;
const PROJ_TOKEN_RE = /^[a-z][a-z0-9_]{0,31}$/;
const PROJ_PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const PROJ_MAX_DEPTH = 3;
const PROJ_MAX_NODES = 96;
const PROJ_MAX_ARRAY = 32;
const PROJ_MAX_STRING = 40;
const BLOCKED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** 策略层结构化错误；code 固定、details 只放非敏感标量（键名 / 计数 / 枚举）。 */
export class OutputPolicyError extends Error {
  constructor(code, message, details = null) {
    super(message || code);
    this.name = "OutputPolicyError";
    this.code = code;
    this.details = details;
  }
}

// ---------------------------------------------------------------- 基础工具
const dict = (entries) => Object.assign(Object.create(null), entries);
const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

/**
 * 只读自有数据属性：不触发 getter / Proxy 陷阱链，不顺着原型链取值。
 * 原型注入（Object.create({...})、constructor 等）因此拿不到东西。
 */
function prop(obj, key) {
  if (obj === null || typeof obj !== "object") return undefined;
  const desc = Object.getOwnPropertyDescriptor(obj, key);
  if (!desc || !own(desc, "value")) return undefined;
  return desc.value;
}
const EMPTY = Object.freeze(Object.create(null));
/** 读失败一律当空对象，避免 specs 里到处判空；真正的形状问题由白名单丢弃。 */
const at = (value) => (value !== null && typeof value === "object" && !Array.isArray(value) ? value : EMPTY);
const num = (obj, key) => {
  const v = prop(obj, key);
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
};
const text = (obj, key) => {
  const v = prop(obj, key);
  return typeof v === "string" ? v : undefined;
};
const int = (obj, key) => {
  const v = num(obj, key);
  return Number.isSafeInteger(v) && v > 0 ? v : undefined;
};
const invalidSummary = (what) => new OutputPolicyError("output_policy_value_invalid", `摘要必需字段缺失或类型不符：${what}`);
const requireNum = (obj, key) => {
  const v = prop(obj, key);
  if (typeof v !== "number" || !Number.isFinite(v)) throw invalidSummary(key);
  return v;
};
const requireText = (obj, key) => {
  const v = prop(obj, key);
  if (typeof v !== "string") throw invalidSummary(key);
  return v;
};
const requireBoolean = (obj, key) => {
  const v = prop(obj, key);
  if (typeof v !== "boolean") throw invalidSummary(key);
  return v;
};
const requirePositiveInt = (obj, key) => {
  const v = int(obj, key);
  if (v === undefined) throw invalidSummary(key);
  return v;
};
const requireRecord = (obj, key) => {
  const v = prop(obj, key);
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw invalidSummary(key);
  return v;
};
const requireArray = (obj, key, max = MAX_RAW_ARRAY) => {
  const v = prop(obj, key);
  if (!Array.isArray(v)) throw invalidSummary(key);
  if (listLen(v) > max) throw new OutputPolicyError("output_policy_value_too_large", `${key} 数组长度超过上限`);
  return v;
};
const requireArrayValue = (value, what, max = MAX_RAW_ARRAY) => {
  if (!Array.isArray(value)) throw invalidSummary(what);
  if (listLen(value) > max) throw new OutputPolicyError("output_policy_value_too_large", `${what} 数组长度超过上限`);
  return value;
};
const periodOf = (obj, key) => {
  const v = text(obj, key);
  return typeof v === "string" && PROJ_PERIOD_RE.test(v) ? v : undefined;
};
/**
 * 投影期间的固定值域：必须是合法 `YYYY-MM`。
 * 只做「存在 + 类型」校验不够：自由 ASCII token 也能通过 token 白名单，等于把原值伪装成安全值。
 */
const requirePeriod = (obj, key) => {
  const v = periodOf(obj, key);
  if (v === undefined) throw invalidSummary(key);
  return v;
};
/** 固定枚举：缺失 / 未登记原值一律失败，绝不把任意小写 ASCII 当受控 token。 */
const requireEnumToken = (table, obj, key) => {
  const token = enumToken(table, requireText(obj, key));
  if (token === undefined) throw invalidSummary(key);
  return token;
};
/** 固定取值集合（代码常量域，例如凭证状态 / 资产种类 / 追溯状态）。 */
const requireChoice = (obj, key, choices) => {
  const v = requireText(obj, key);
  if (!choices.includes(v)) throw invalidSummary(key);
  return v;
};
const ASSET_KIND_CHOICES = Object.freeze(["fixed", "intangible"]);
const VOUCHER_STATUS_CHOICES = Object.freeze(["draft", "posted"]);
const PERIOD_STATUS_CHOICES = Object.freeze(["open", "closed"]);
const ASSET_KIND_TOKENS = dict({ fixed: "fixed", intangible: "intangible" });
// LOCAL-02 资产补项字段的受控值域：只投影业务必需的已登记 token。
const ASSET_LEDGER_STATUS_TOKENS = dict({ booked: "booked", pending_purchase_voucher: "pending_purchase_voucher" });
const ASSET_ORIGIN_TOKENS = dict({ purchase: "purchase", supplement: "supplement", import: "import" });
// 期末检查的固定步骤 / 固定阻塞码：未知值一律 fail closed，不把任意文本当 token。
const PERIOD_END_STATUS_CHOICES = Object.freeze(["ok", "blocked", "not_applicable"]);
const PERIOD_END_STEP_IDS = Object.freeze([
  "draft_vouchers", "trial_balance", "depreciation", "asset_reconciliation",
  "profit_carry_forward", "year_end_carry_forward", "period_sequence",
]);
const PERIOD_END_BLOCKING_CODES = Object.freeze([
  "period_has_draft_vouchers", "period_unbalanced", "depreciation_run_stale",
  "asset_ledger_pending", "depreciation_missing", "depreciation_draft_exists",
  "depreciation_life_expired_underprovided", "asset_missing_card", "asset_cost_mismatch",
  "asset_accumulated_mismatch", "asset_acquired_period_missing", "asset_purchase_voucher_pending",
  "profit_not_carried_forward", "profit_carry_stale", "year_end_not_carried",
  "previous_period_open", "previous_period_depreciation_pending",
  "later_period_closed", "carryforward_stale",
]);
const PERIOD_END_STEP_ID_SET = new Set(PERIOD_END_STEP_IDS);
const PERIOD_END_STATUS_SET = new Set(PERIOD_END_STATUS_CHOICES);
/**
 * 已登记固定代码常量的字面量集合。
 * 这些是**本模块自己的代码常量**（不是用户文本），其中最长的一条
 * （`depreciation_life_expired_underprovided`，39 字符）超过通用 token 的 32 字符预算。
 * 通用 token 预算不允许因此放宽（那会把任意自由字母串放进模型通道），所以只按
 * **精确字面量**给它们开一条窄通道，见 isProjectionStringAllowed。
 */
const REGISTERED_CODE_LITERALS = new Set(PERIOD_END_BLOCKING_CODES);

/**
 * 期末检查 DTO 的**全局一致性**（结构 + 步骤 / 阻塞语义），只读自有 data 属性。
 * 与 period-end-controls.buildPeriodEndCheck 的真实形状一一对应：
 *   - `period_end_check` 只读工具不传 `skip`，因此步骤恒为 7 个已登记步骤，**唯一且齐全**；
 *   - 步骤状态只有 ok / blocked / not_applicable（真实域没有 skipped 之类状态）；
 *   - 顶层 `blocking` 每条都带产生它的 `step`（buildPeriodEndCheck 逐条附上）；
 *   - `ready` ⇔ 没有 blocked 步骤且 `blocking` 为空；每个 blocked 步骤至少一条真实阻塞。
 * 一个步骤可以有**多条**阻塞原因（例如每张资产一条），多个步骤也可以共用同一个码，
 * 因此只校验「blocked 步骤 ⇔ 至少一条该步骤的阻塞」，不机械比较原因条数与步骤数。
 * 返回 true / false；调用方决定错误码（策略层抛 output_policy_value_invalid，
 * 适配层报 model_result_invalid），两者都不创建引用。
 */
export function isPeriodEndCheckConsistent(value) {
  const check = at(value);
  const ready = prop(check, "ready");
  if (typeof ready !== "boolean") return false;
  const steps = prop(check, "steps");
  if (!Array.isArray(steps) || listLen(steps) !== PERIOD_END_STEP_IDS.length) return false;
  const statusById = new Map();
  let blockedSteps = 0;
  for (let i = 0; i < PERIOD_END_STEP_IDS.length; i++) {
    const step = at(prop(steps, i));
    const id = prop(step, "id");
    const status = prop(step, "status");
    if (typeof id !== "string" || !PERIOD_END_STEP_ID_SET.has(id)) return false;
    if (statusById.has(id)) return false; // 重复步骤：投影会给出 8 个 id 却只有 7 个语义步骤
    if (typeof status !== "string" || !PERIOD_END_STATUS_SET.has(status)) return false;
    statusById.set(id, status);
    if (status === "blocked") blockedSteps++;
  }
  if (statusById.size !== PERIOD_END_STEP_IDS.length) return false; // 缺步骤（齐全）
  const blocking = prop(check, "blocking");
  if (!Array.isArray(blocking)) return false;
  const blockingCount = listLen(blocking);
  const blockedWithReason = new Set();
  for (let i = 0; i < blockingCount; i++) {
    const item = at(prop(blocking, i));
    const stepId = prop(item, "step");
    // 阻塞必须归属到一个**真实 blocked** 的步骤：不认识的步骤 / 未阻塞步骤都是矛盾。
    if (typeof stepId !== "string" || statusById.get(stepId) !== "blocked") return false;
    blockedWithReason.add(stepId);
  }
  if (ready !== (blockingCount === 0)) return false; // ready 与阻塞计数一致
  if (ready !== (blockedSteps === 0)) return false; // ready 与步骤状态一致
  if (blockedWithReason.size !== blockedSteps) return false; // 每个 blocked 步骤都要有真实原因
  return true;
}
// 与 import-incremental.mjs 的 VOUCHER_STATE 一一对应；"inconsistent" 是批次审计里既有的复核标记。
const TRACE_STATE_TOKENS = dict({
  ok: "ok", inconsistent: "inconsistent", missing: "missing", unposted: "unposted",
  unverified: "unverified", modified: "modified", other_account_set: "other_account_set",
});
/** 数组长度也走 data 属性描述符，避开 `arr.length` 的 Proxy get 陷阱。 */
const listLen = (arr) => {
  const n = prop(arr, "length");
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
};
const listOf = (obj, key, max = MAX_RAW_ARRAY) => {
  const v = prop(obj, key);
  if (!Array.isArray(v)) return [];
  if (listLen(v) > max) throw new OutputPolicyError("output_policy_value_too_large", `数组长度超过上限 ${max}`);
  return v;
};
const money = (v) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v * 100) / 100 : undefined);
const sumField = (list, key) => {
  let total = 0;
  const length = listLen(list);
  for (let i = 0; i < length; i++) {
    const row = prop(list, i);
    const value = prop(row, key);
    if (typeof value !== "number" || !Number.isFinite(value)) throw invalidSummary(key);
    total += value;
  }
  return total;
};
/** 引用参数先验类型：`REF_PATTERN.test(obj)` 会对对象调用 ToString，等于执行用户代码。 */
const isRef = (ref) => typeof ref === "string" && REF_PATTERN.test(ref);
/** 非策略层异常（含恶意 Proxy 陷阱抛出）一律归一为安全拒绝，不回显原文。 */
const asSafeReadError = (error) => (error instanceof OutputPolicyError
  ? error
  : new OutputPolicyError("output_policy_value_invalid", "原数据无法安全读取"));
/** 将内部失败分类成固定的降级原因（写结果专用，只输出常量 token）。 */
const classifyRawFailure = (error) => {
  if (error instanceof OutputPolicyError) {
    if (error.code === "output_policy_value_too_large") return "value_limit";
    if (error.code === "output_policy_value_invalid") return "value_invalid";
  }
  return "summary_unavailable";
};
/**
 * operation 严格先验：**原始字符串** + 已登记。
 * 顺序很关键：`own()` / 下标访问都会做 ToPropertyKey，先判 typeof 才能保证不执行
 * `{toString(){...}}` 这类用户代码，也不可能把非字符串原样放进信封。
 */
const requireSpec = (table, operation, category) => {
  if (typeof operation !== "string" || !own(table, operation)) {
    throw new OutputPolicyError("output_policy_unknown_operation", `${category} operation 未登记（只接受已登记的原始字符串）`);
  }
  const spec = table[operation];
  if (!spec) throw new OutputPolicyError("output_policy_unknown_operation", `${category} operation 未登记`);
  return spec;
};
const UNKNOWN_EVIDENCE = Object.freeze({ applied: "unknown", reason: "unverified_result" });
/** applied 只允许 true / false / "unknown"；reason 只允许安全 token，防止 spec 缺陷注文本。 */
const normalizeEvidence = (raw) => {
  const applied = prop(raw, "applied");
  if (applied !== true && applied !== false && applied !== "unknown") return UNKNOWN_EVIDENCE;
  const reason = prop(raw, "reason");
  const safeReason = typeof reason === "string" && PROJ_TOKEN_RE.test(reason) ? reason : undefined;
  return safeReason === undefined ? Object.freeze({ applied }) : Object.freeze({ applied, reason: safeReason });
};
const normSetId = (raw) => {
  const id = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new OutputPolicyError("output_policy_account_set_invalid", "accountSetId 必须是正整数");
  }
  return id;
};

// 业务枚举 → ASCII token：模型拿到的是受控词表，不是原文本。
const TAXPAYER_TOKENS = dict({ "小规模纳税人": "small_scale", "一般纳税人": "general" });
const STANDARD_TOKENS = dict({ "小企业会计准则": "small_business", "企业会计准则": "enterprise" });
const CATEGORY_TOKENS = dict({ "资产": "assets", "负债": "liabilities", "权益": "equity", "成本": "cost", "损益": "profit_loss" });
const DIRECTION_TOKENS = dict({ debit: "debit", credit: "credit" });
const STATUS_TOKENS = dict({ draft: "draft", posted: "posted", open: "open", closed: "closed" });
const MODE_TOKENS = dict({ create: "create", append: "append" });
const BATCH_STATUS_TOKENS = dict({ completed: "completed", failed: "failed", pending: "pending", started: "started" });
const IMPORT_STATUS_TOKENS = dict({
  preview: "preview", applied: "applied", idempotent_replay: "idempotent_replay",
});
const enumToken = (table, raw) => {
  if (typeof raw !== "string" || !own(table, raw)) return undefined;
  return table[raw];
};
/** 受控业务枚举词表出口：按枚举名取一个 frozen 映射，只接受已登记原始字符串。 */
export const ENUM_TOKENS = Object.freeze({
  taxpayer: TAXPAYER_TOKENS,
  standard: STANDARD_TOKENS,
  category: CATEGORY_TOKENS,
  direction: DIRECTION_TOKENS,
  status: STATUS_TOKENS,
  mode: MODE_TOKENS,
  batchStatus: BATCH_STATUS_TOKENS,
});
/** 把真实业务枚举值映射成受控 ASCII token；未登记值返回 undefined（不回声原值）。 */
export const enumTokenOf = (name, raw) => {
  if (typeof name !== "string" || !own(ENUM_TOKENS, name)) return undefined;
  return enumToken(ENUM_TOKENS[name], raw);
};

// ---------------------------------------------------------------- projection 消毒
/**
 * projection 允许的字符串：
 *   ① 通用 token（≤ 32 字符小写）与合法期间——自由文本 / 中文业务名 / 任意 ASCII 串仍按原预算丢弃；
 *   ② **精确等于**已登记固定代码常量的字面量（不受通用 token 长度限制）。
 * ② 只对代码常量表生效，不读取任何用户数据，也不放宽通用 token 的 32 字符预算 / 长度上限。
 * 真实域码（例如 39 字符的 `depreciation_life_expired_underprovided`）因此可以完整表示，
 * 而不是被通用预算静默丢弃、只剩下 `projectionDropped` 计数。
 */
const isProjectionStringAllowed = (value) => REGISTERED_CODE_LITERALS.has(value)
  || (value.length <= PROJ_MAX_STRING && (PROJ_TOKEN_RE.test(value) || PROJ_PERIOD_RE.test(value)));

/**
 * 白名单形状消毒：只保留有限数值（2 位小数、绝对值上限）、布尔、状态 token、期间，
 * 以及最多 32 个同类标量的数组、最多 3 层 / 96 节点的普通对象。
 * 其他一切（自由文本、中文业务名、Date/Map/类实例、函数、Symbol、BigInt、访问器属性）全部丢弃并计数。
 */
function sanitizeInto(target, source, state, depth) {
  const keys = Object.keys(source);
  for (const key of keys) {
    if (state.nodes > PROJ_MAX_NODES) throw new OutputPolicyError("output_policy_value_too_large", "projection 节点数超过上限");
    if (!PROJ_KEY_RE.test(key) || BLOCKED_KEYS.has(key)) { state.dropped++; continue; }
    const value = prop(source, key);
    if (value === undefined) continue; // 条件字段：spec 表达“没有”时正常省略
    state.nodes++;
    if (typeof value === "number") {
      if (!Number.isFinite(value) || Math.abs(value) > MONEY_LIMIT) { state.dropped++; continue; }
      target[key] = money(value);
    } else if (typeof value === "boolean") {
      target[key] = value;
    } else if (typeof value === "string") {
      if (!isProjectionStringAllowed(value)) {
        state.dropped++;
        continue;
      }
      target[key] = value;
    } else if (Array.isArray(value)) {
      const length = listLen(value);
      if (length > PROJ_MAX_ARRAY) { state.dropped++; continue; }
      const out = [];
      for (let i = 0; i < length; i++) {
        const item = prop(value, i);
        if (typeof item === "number" && Number.isFinite(item) && Math.abs(item) <= MONEY_LIMIT) out.push(money(item));
        else if (typeof item === "boolean") out.push(item);
        // 数组元素与标量值同一套白名单：状态 token 或期间（期间也是契约声明的允许类型），
        // 自由文本 / 中文业务名 / 任意长字符串仍然丢弃。
        else if (typeof item === "string" && isProjectionStringAllowed(item)) out.push(item);
        else state.dropped++;
      }
      target[key] = out;
    } else if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const proto = Object.getPrototypeOf(value);
      if (depth + 1 > PROJ_MAX_DEPTH || (proto !== Object.prototype && proto !== null)) { state.dropped++; continue; }
      const nested = {};
      sanitizeInto(nested, value, state, depth + 1);
      target[key] = nested;
    } else {
      state.dropped++;
    }
  }
}

/** 对任意对象做白名单投影；顶层不是普通对象即视为 spec 缺陷（fail closed）。 */
export function sanitizeProjection(candidate) {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new OutputPolicyError("output_policy_projection_invalid", "projection 顶层必须是普通对象");
  }
  const state = { nodes: 0, dropped: 0 };
  const value = {};
  sanitizeInto(value, candidate, state, 1);
  return { value: freezeDeep(value), dropped: state.dropped };
}

function freezeDeep(value) {
  if (value === null || typeof value !== "object") return value;
  for (const key of Object.keys(value)) freezeDeep(value[key]);
  return Object.freeze(value);
}

// ---------------------------------------------------------------- 原数据测量（容量 / 循环 / 原型 / 字节）
/**
 * 有界遍历原始结果：拒绝**真正的循环引用**、访问器属性、类实例与超量数据；不做 JSON.stringify。
 * 共享引用（DAG，同一对象出现在两个兄弟字段，例如增量导入结果的 created.sourceTrace 与
 * 顶层 sourceTrace）是合法业务 DTO，不当作循环：只用「当前路径祖先集」判循环，不用全局 seen。
 * 计量口径：`bytes = 8 × 节点数 + 字符串 UTF-8 字节 + 键名 UTF-8 字节`（重复访问也各计一次，保守）。
 * 节点数限制不了「1 个 8 MiB 字符串」，所以字节预算与节点预算必须分开。
 */
export function inspectRawValue(root, maxNodes = DEFAULT_VALUE_NODES, maxBytes = DEFAULT_VALUE_BYTES) {
  let nodes = 0;
  let bytes = NODE_BYTE_COST;
  const ancestors = new Set();
  const walk = (current, depth) => {
    nodes++;
    bytes += NODE_BYTE_COST;
    if (nodes > maxNodes) {
      throw new OutputPolicyError("output_policy_value_too_large", `原数据节点数超过上限 ${maxNodes}`);
    }
    if (bytes > maxBytes) {
      throw new OutputPolicyError("output_policy_value_too_large", `原数据字节数超过上限 ${maxBytes}`);
    }
    if (typeof current === "string") {
      bytes += Buffer.byteLength(current, "utf8");
      if (bytes > maxBytes) {
        throw new OutputPolicyError("output_policy_value_too_large", `原数据字节数超过上限 ${maxBytes}`);
      }
      return;
    }
    if (current === null || typeof current !== "object") return;
    if (depth > MAX_DEPTH_RAW) throw new OutputPolicyError("output_policy_value_invalid", "原数据嵌套层数超过上限");
    if (ancestors.has(current)) throw new OutputPolicyError("output_policy_value_invalid", "原数据存在循环引用");
    if (Array.isArray(current)) {
      if (listLen(current) > MAX_RAW_ARRAY) {
        throw new OutputPolicyError("output_policy_value_too_large", `数组长度超过上限 ${MAX_RAW_ARRAY}`);
      }
    } else {
      const proto = Object.getPrototypeOf(current);
      if (proto !== Object.prototype && proto !== null) {
        throw new OutputPolicyError("output_policy_value_invalid", "原数据包含非普通对象（Map/Date/类实例等）");
      }
    }
    ancestors.add(current);
    for (const key of Object.keys(current)) {
      const desc = Object.getOwnPropertyDescriptor(current, key);
      if (!desc || !own(desc, "value")) {
        throw new OutputPolicyError("output_policy_value_invalid", "原数据包含访问器属性");
      }
      bytes += Buffer.byteLength(key, "utf8");
      walk(desc.value, depth + 1);
    }
    ancestors.delete(current);
  };
  walk(root, 0);
  if (bytes > maxBytes) {
    throw new OutputPolicyError("output_policy_value_too_large", `原数据字节数超过上限 ${maxBytes}`);
  }
  return { nodes, bytes };
}

/** 兼容出口：只回节点数（byteBudget 用 inspectRawValue）。 */
export function measureRawValue(root, maxNodes = DEFAULT_VALUE_NODES) {
  return inspectRawValue(root, maxNodes, Number.POSITIVE_INFINITY).nodes;
}

// ---------------------------------------------------------------- 查询 projection 规格
// 每个 spec 只按固定键名取值：键名是代码常量，不是数据驱动，未知字段默认不出现。
const voucherListSummary = (value) => {
  const list = requireArrayValue(value, "vouchers");
  const length = listLen(list);
  let entries = 0, posted = 0, draft = 0;
  for (let i = 0; i < length; i++) {
    const v = at(prop(list, i));
    entries += listLen(requireArray(v, "entries"));
    const status = requireChoice(v, "status", VOUCHER_STATUS_CHOICES);
    if (status === "posted") posted++;
    else draft++;
  }
  const debit = sumFieldEntries(list, "debit");
  const credit = sumFieldEntries(list, "credit");
  return {
    voucherCount: length, entryCount: entries, postedCount: posted, draftCount: draft,
    totalDebit: money(debit), totalCredit: money(credit), balanced: Math.abs(debit - credit) < 0.005,
  };
};
const sumFieldEntries = (vouchers, field) => {
  let total = 0;
  const length = listLen(vouchers);
  for (let i = 0; i < length; i++) total += sumField(listOf(at(prop(vouchers, i)), "entries"), field);
  return total;
};
/** 兼容两种返回形状：直接数组，或 { items: [...] } 包装。 */
const itemsOf = (value) => (Array.isArray(value) ? value : listOf(at(value), "items"));
const lineValue = (rows, label) => {
  const length = listLen(rows);
  for (let i = 0; i < length; i++) {
    const row = at(prop(rows, i));
    if (text(row, "label") === label) {
      const value = prop(row, "value");
      if (typeof value !== "number" || !Number.isFinite(value)) throw invalidSummary(label);
      return value;
    }
  }
  throw invalidSummary(label);
};
const voucherDetailSummary = (value) => {
  const v = at(value);
  const entries = requireArray(v, "entries");
  const debit = sumField(entries, "debit");
  const credit = sumField(entries, "credit");
  return {
    voucherId: requirePositiveInt(v, "id"), period: requirePeriod(v, "period"),
    status: requireChoice(v, "status", VOUCHER_STATUS_CHOICES),
    lineCount: listLen(entries), totalDebit: money(debit), totalCredit: money(credit),
    balanced: Math.abs(debit - credit) < 0.005,
  };
};

// ---- 普通工具（非 finance_query）的真实 DTO 摘要 ----
// 账套 / 科目目录：只给计数与受控枚举，科目编码、名称一律不返回。
const accountDirectorySummary = (value) => {
  const accounts = Array.isArray(value) ? value : requireArray(at(value), "items");
  const length = listLen(accounts);
  const counts = { assets: 0, liabilities: 0, equity: 0, cost: 0, profit_loss: 0 };
  let leaf = 0, contra = 0;
  for (let i = 0; i < length; i++) {
    const account = at(prop(accounts, i));
    counts[requireEnumToken(CATEGORY_TOKENS, account, "category")]++;
    if (requireNum(account, "is_leaf") === 1) leaf++;
    if (requireNum(account, "contra") === 1) contra++;
  }
  return { accountCount: length, leafCount: leaf, contraCount: contra, byCategory: counts };
};
// 明细账：兼容 finance_query（裸 generalLedger）与 ledger_query（带 accountSetId 的包装）。
const ledgerSummary = (value) => {
  const ledger = at(value);
  const period = requirePeriod(ledger, "period");
  const direction = requireEnumToken(DIRECTION_TOKENS, ledger, "direction");
  const items = requireArray(ledger, "items");
  const opening = requireRecord(ledger, "opening");
  const openingDebit = requireNum(opening, "debit");
  const openingCredit = requireNum(opening, "credit");
  const periodDebit = sumField(items, "debit");
  const periodCredit = sumField(items, "credit");
  return {
    period,
    direction,
    itemCount: listLen(items),
    openingDebit: money(openingDebit), openingCredit: money(openingCredit),
    periodDebit: money(periodDebit), periodCredit: money(periodCredit),
    closingBalance: money(openingDebit - openingCredit + periodDebit - periodCredit),
  };
};
// 期初余额读取：只给条数与借贷合计（含是否平衡），不返回科目编码或逐项金额。
const openingBalanceSummary = (value) => {
  const items = requireArray(at(value), "items");
  const debit = sumField(items, "debit");
  const credit = sumField(items, "credit");
  return {
    itemCount: listLen(items),
    totalDebit: money(debit), totalCredit: money(credit),
    balanced: Math.abs(debit - credit) < 0.005,
  };
};
// 期间清单：只给状态计数。
const periodListSummary = (value) => {
  const items = requireArray(at(value), "items");
  const length = listLen(items);
  let open = 0, closed = 0;
  for (let i = 0; i < length; i++) {
    const status = requireChoice(at(prop(items, i)), "status", PERIOD_STATUS_CHOICES);
    if (status === "open") open++;
    else closed++;
  }
  return { periodCount: length, openPeriodCount: open, closedPeriodCount: closed };
};
// 凭证预检：只给是否通过、错误条数与借贷合计。
const voucherCheckSummary = (value) => {
  const v = at(value);
  const ok = requireBoolean(v, "ok");
  const debit = requireNum(v, "total_debit");
  const credit = requireNum(v, "total_credit");
  const errors = requireArray(v, "errors");
  return {
    checkOk: ok,
    errorCount: listLen(errors),
    totalDebit: money(debit), totalCredit: money(credit),
    balanced: Math.abs(debit - credit) < 0.005,
  };
};
// 资产卡片清单：只给张数与金额合计，卡片名称 / 科目编码不返回。
const assetListSummary = (value) => {
  const cards = requireArrayValue(value, "asset cards");
  const length = listLen(cards);
  let fixed = 0, intangible = 0, cost = 0, accumulated = 0, remaining = 0;
  for (let i = 0; i < length; i++) {
    const card = at(prop(cards, i));
    const kind = requireChoice(card, "kind", ASSET_KIND_CHOICES);
    if (kind === "intangible") intangible++;
    else fixed++;
    cost += requireNum(card, "original_cost");
    accumulated += requireNum(card, "accumulated");
    remaining += requireNum(card, "remaining");
  }
  return {
    cardCount: length, fixedCount: fixed, intangibleCount: intangible,
    totalOriginalCost: money(cost), totalAccumulated: money(accumulated), totalRemaining: money(remaining),
  };
};
// 导入批次审计：批次 ID / 来源系统 / 企业身份 / 凭证号一律不返回，只给状态 token 与计数。
const batchAuditSummary = (value) => {
  const v = at(value);
  const batch = requireRecord(v, "batch");
  const resultValue = prop(batch, "result");
  const result = resultValue === null || resultValue === undefined ? null : at(resultValue);
  if (resultValue !== null && resultValue !== undefined && result === EMPTY) throw invalidSummary("batch.result");
  const trace = requireArray(v, "sourceTrace");
  const length = listLen(trace);
  let ok = 0, inconsistent = 0;
  for (let i = 0; i < length; i++) {
    // 状态域与 VOUCHER_STATE 对齐：非 ok 一律计入需复核，不再静默漏计。
    const state = requireEnumToken(TRACE_STATE_TOKENS, at(prop(trace, i)), "state");
    if (state === "ok") ok++;
    else inconsistent++;
  }
  const batchStatus = requireEnumToken(BATCH_STATUS_TOKENS, batch, "status");
  const batchMode = requireEnumToken(MODE_TOKENS, batch, "mode");
  const accountSetId = int(batch, "accountSetId");
  if (accountSetId === undefined && prop(batch, "accountSetId") !== undefined
    && prop(batch, "accountSetId") !== null) throw invalidSummary("batch.accountSetId");
  const voucherCount = requireNum(v, "voucherCount");
  return {
    batchStatus,
    batchMode,
    accountSetId,
    traceCount: length, okTraceCount: ok, inconsistentTraceCount: inconsistent,
    voucherCount,
    accountSetCreated: result ? requireBoolean(result, "accountSetCreated") : undefined,
    vouchersCreated: result ? requireNum(result, "vouchersCreated") : undefined,
    vouchersDeduplicated: result ? requireNum(result, "vouchersDeduplicated") : undefined,
  };
};

const PROFILE_SUMMARIES = dict({
  "legacy-small-coa-v1": ["legacy_small_v1", "legacy-small-coa-baseline-v1", "legacy-small-coa-report-compat-v1", true],
  "small-2011-basic-v1": ["small_basic_v1", "small-2011-coa-basic-v1", "small-2011-report-basic-v1", false],
  "enterprise-2019-general-basic-v1": ["enterprise_basic_v1", "enterprise-2019-general-coa-basic-v1", "enterprise-2019-general-report-basic-v1", false],
});
const REPORT_DIAGNOSTICS = dict({
  report_account_unmapped: "unmapped", report_account_requires_detail: "requiresDetail",
  report_account_semantics_mismatch: "semanticsMismatch", declared_standard_profile_mismatch: "declaredMismatch",
  legacy_profile_compatibility: "legacy", cash_flow_classification_incomplete: "cashClassification",
});
function reportMappingSummary(value) {
  const context = requireRecord(value, "accountingContext");
  const profile = prop(PROFILE_SUMMARIES, requireText(context, "profileId"));
  if (!profile || requireText(context, "coaVersion") !== profile[1]
    || requireText(context, "reportMappingVersion") !== profile[2]
    || requireBoolean(context, "legacy") !== profile[3]) throw invalidSummary("accountingContext");
  const status = requireRecord(value, "reportStatus");
  const mappingStatus = requireChoice(status, "status", ["complete", "incomplete", "legacy_compatibility"]);
  const complete = requireBoolean(status, "complete"), partialValues = requireBoolean(status, "partialValues");
  if ((mappingStatus === "complete") !== complete || (complete && partialValues)
    || (mappingStatus === "legacy_compatibility") !== profile[3]) throw invalidSummary("reportStatus");
  const diagnostics = requireArray(status, "diagnostics"), diagnosticCounts = {};
  for (let i = 0; i < listLen(diagnostics); i++) {
    const key = prop(REPORT_DIAGNOSTICS, requireText(at(prop(diagnostics, i)), "code"));
    if (!key) throw invalidSummary("reportStatus");
    diagnosticCounts[key] = (diagnosticCounts[key] ?? 0) + 1;
  }
  if (complete && listLen(diagnostics)) throw invalidSummary("reportStatus");
  return { profile: profile[0], legacy: profile[3], mappingStatus, complete, partialValues,
    diagnosticCount: listLen(diagnostics), diagnosticCounts };
}

const QUERY_SPECS = dict({
  "finance_query:enterprise_account.account_set": (value) => {
    const set = at(value);
    return {
      accountSetId: requirePositiveInt(set, "id"),
      startPeriod: requirePeriod(set, "start_period"),
      // 税种 / 准则在库内是自由文本（createAccountSet 不限制），未知取值降级为受控 "unknown"；
      // 期间与状态不做这种降级：非法期间 / 状态必须失败。
      taxpayerType: enumToken(TAXPAYER_TOKENS, requireText(set, "taxpayer_type")) ?? "unknown",
      accountingStandard: enumToken(STANDARD_TOKENS, requireText(set, "accounting_standard")) ?? "unknown",
      hasDisplayName: requireText(set, "name").length > 0,
    };
  },
  "finance_query:enterprise_account.subject_system.all": accountDirectorySummary,
  "finance_query:voucher.generated.list": voucherListSummary,
  "finance_query:voucher.generated.summary": voucherListSummary,
  "finance_query:voucher.draft.summary": voucherListSummary,
  "finance_query:voucher.detail": voucherDetailSummary,
  "finance_query:report.balance_sheet": (value) => {
    const sheet = at(value);
    const totals = requireRecord(sheet, "totals");
    const assets = requireArray(sheet, "assets");
    const liabilities = requireArray(sheet, "liabilities");
    const totalAssets = requireNum(totals, "assets");
    const totalLiabilities = requireNum(totals, "liabilities");
    const totalEquity = requireNum(totals, "equity");
    return {
      ...reportMappingSummary(sheet),
      period: requirePeriod(sheet, "period"),
      assets: money(totalAssets), liabilities: money(totalLiabilities), equity: money(totalEquity),
      balanced: prop(sheet, "balanced") === true
        || Math.abs(totalAssets - (totalLiabilities + totalEquity)) < 0.005,
      lineCount: listLen(assets) + listLen(liabilities),
      // 固定 canonical 行（标签来自 accounting.mjs 代码常量，不是数据内容）
      cash: money(lineValue(assets, "货币资金")),
      receivables: money(lineValue(assets, "应收账款")),
      inventory: money(lineValue(assets, "存货")),
      fixedAssetsNet: money(lineValue(assets, "固定资产账面价值")),
    };
  },
  "finance_query:report.income_statement": (value) => {
    const statement = at(value);
    const current = requireRecord(statement, "current");
    const ytd = requireRecord(statement, "ytd");
    return {
      ...reportMappingSummary(statement),
      period: requirePeriod(statement, "period"),
      currentRevenue: money(requireNum(current, "营业收入")),
      currentCost: money(requireNum(current, "营业成本")),
      currentExpenses: money(requireNum(current, "销售费用") + requireNum(current, "管理费用")
        + requireNum(current, "财务费用")),
      currentProfitBeforeTax: money(requireNum(current, "利润总额")),
      currentNetProfit: money(requireNum(current, "净利润")),
      ytdRevenue: money(requireNum(ytd, "营业收入")),
      ytdNetProfit: money(requireNum(ytd, "净利润")),
    };
  },
  "finance_query:report.cash_flow_statement": (value) => {
    const statement = at(value);
    const totals = requireRecord(statement, "totals");
    const cash = requireRecord(statement, "cash");
    const operating = requireNum(totals, "operating");
    const investing = requireNum(totals, "investing");
    const financing = requireNum(totals, "financing");
    const netIncrease = requireNum(totals, "net_increase");
    const begin = requireNum(cash, "begin");
    const end = requireNum(cash, "end");
    const operatingRows = requireArray(statement, "operating");
    const investingRows = requireArray(statement, "investing");
    const financingRows = requireArray(statement, "financing");
    return {
      ...reportMappingSummary(statement),
      period: requirePeriod(statement, "period"),
      operating: money(operating), investing: money(investing), financing: money(financing),
      netIncrease: money(netIncrease),
      cashBegin: money(begin), cashEnd: money(end), cashChange: money(end - begin),
      // 真实现金流量表 DTO 一定带布尔 reconciles；缺失 / 类型错必须失败，
      // 不能把「不知道」投影成 false（那会让模型把未知勾稽状态当成已核对）。
      reconciles: requireBoolean(statement, "reconciles"),
      lineCount: listLen(operatingRows) + listLen(investingRows) + listLen(financingRows),
    };
  },
  "finance_query:report.trial_balance": (value) => {
    const balance = at(value);
    const totals = requireRecord(balance, "totals");
    const closingDebit = requireNum(totals, "closing_debit");
    const closingCredit = requireNum(totals, "closing_credit");
    return {
      period: requirePeriod(balance, "period"),
      lineCount: listLen(requireArray(balance, "lines")),
      openingDebit: money(requireNum(totals, "opening_debit")),
      openingCredit: money(requireNum(totals, "opening_credit")),
      periodDebit: money(requireNum(totals, "period_debit")),
      periodCredit: money(requireNum(totals, "period_credit")),
      closingDebit: money(closingDebit), closingCredit: money(closingCredit),
      balanced: Math.abs(closingDebit - closingCredit) < 0.005,
    };
  },
  "finance_query:period_end.summary": (value) => {
    const summary = at(value);
    const periods = requireArray(summary, "periods");
    const periodCount = listLen(periods);
    let open = 0, closed = 0;
    for (let i = 0; i < periodCount; i++) {
      const status = requireChoice(at(prop(periods, i)), "status", PERIOD_STATUS_CHOICES);
      if (status === "open") open++;
      else closed++;
    }
    const balance = requireRecord(summary, "trial_balance");
    const totals = requireRecord(balance, "totals");
    const closingDebit = requireNum(totals, "closing_debit");
    const closingCredit = requireNum(totals, "closing_credit");
    return {
      periodCount, openPeriodCount: open, closedPeriodCount: closed,
      period: requirePeriod(balance, "period"),
      closingDebit: money(closingDebit), closingCredit: money(closingCredit),
      balanced: Math.abs(closingDebit - closingCredit) < 0.005,
    };
  },
  "finance_query:ledger.general": ledgerSummary,
  // ---- 普通工具（非 finance_query）的只读能力：同样只给白名单摘要 ----
  voucher_check: voucherCheckSummary,
  account_list: accountDirectorySummary,
  opening_balance_get: openingBalanceSummary,
  period_list: periodListSummary,
  ledger_query: ledgerSummary,
  asset_list: assetListSummary,
  book_import_batch: batchAuditSummary,
  // 期末检查只读：只投影步骤状态 / 计数 / 固定阻塞码，不投影标题、原因、message、details、
  // 资产名 / 科目名 / 备注等任意用户文本。
  // 先做**全局一致性**校验（7 个已登记步骤唯一齐全 / ready 与 blocked 及阻塞计数一致 /
  // 每条阻塞归属于真实 blocked 步骤），再做计数：只校验单字段会把「ready:true + 空步骤」、
  // 「7 个重复步骤」或「ready:true + 全 blocked」这类矛盾 DTO 投影成一份看起来正常的摘要。
  period_end_check: (value) => {
    if (!isPeriodEndCheckConsistent(value)) throw invalidSummary("period_end_check");
    const check = at(value);
    const ready = requireBoolean(check, "ready");
    const steps = requireArray(check, "steps");
    let ok = 0, blocked = 0, notApplicable = 0;
    const stepIds = [];
    const stepStatuses = [];
    const blockedStepIds = [];
    for (let i = 0; i < listLen(steps); i++) {
      const step = at(prop(steps, i));
      const id = requireChoice(step, "id", PERIOD_END_STEP_IDS);
      const status = requireChoice(step, "status", PERIOD_END_STATUS_CHOICES);
      stepIds.push(id);
      stepStatuses.push(status);
      if (status === "ok") ok++;
      else if (status === "blocked") { blocked++; blockedStepIds.push(id); }
      else notApplicable++;
    }
    const blocking = requireArray(check, "blocking");
    const codes = [];
    for (let i = 0; i < listLen(blocking); i++) {
      // 只读固定 code；message / title / details 等自由文本从不进入投影。
      codes.push(requireChoice(at(prop(blocking, i)), "code", PERIOD_END_BLOCKING_CODES));
    }
    return {
      period: requirePeriod(check, "period"),
      ready,
      stepCount: listLen(steps),
      stepIds,
      stepStatuses,
      okStepCount: ok,
      blockedStepCount: blocked,
      notApplicableStepCount: notApplicable,
      blockedStepIds: [...new Set(blockedStepIds)],
      blockingCount: listLen(blocking),
      blockingCodes: [...new Set(codes)],
    };
  },
});

// ---------------------------------------------------------------- 写动作 projection 规格
// applied 三态：true 必须有正面业务证据；false 必须由域结果显式说明未生效；其余一律 "unknown"。
const WRITE_SPECS = dict({
  voucher_create: {
    summary: (value) => {
      const v = at(value);
      const entries = listOf(v, "entries");
      const debit = sumField(entries, "debit");
      const credit = sumField(entries, "credit");
      return {
        voucherId: int(v, "id"), period: periodOf(v, "period"), status: enumToken(STATUS_TOKENS, text(v, "status")),
        lineCount: listLen(entries), totalDebit: money(debit), totalCredit: money(credit),
        balanced: Math.abs(debit - credit) < 0.005,
      };
    },
    evidence: (value) => {
      const v = at(value);
      const id = int(v, "id");
      const status = text(v, "status");
      if (id !== undefined && (status === "draft" || status === "posted")) return { applied: true };
      if (status === "draft" || status === "posted") return { applied: "unknown", reason: "missing_voucher_id" };
      return { applied: "unknown", reason: "unverified_result" };
    },
  },
  voucher_post: {
    summary: voucherDetailSummary,
    evidence: (value) => {
      const v = at(value);
      const status = text(v, "status");
      if (int(v, "id") !== undefined && status === "posted") return { applied: true };
      if (status === "posted") return { applied: "unknown", reason: "missing_voucher_id" };
      return { applied: "unknown", reason: "unverified_result" };
    },
  },
  voucher_unpost: {
    summary: voucherDetailSummary,
    evidence: (value) => {
      const v = at(value);
      const status = text(v, "status");
      if (int(v, "id") !== undefined && status === "draft") return { applied: true };
      if (status === "draft") return { applied: "unknown", reason: "missing_voucher_id" };
      return { applied: "unknown", reason: "unverified_result" };
    },
  },
  voucher_delete: {
    summary: (value) => ({ deletedVoucherId: int(at(value), "deleted") }),
    evidence: (value) => (int(at(value), "deleted") !== undefined
      ? { applied: true }
      : { applied: "unknown", reason: "unverified_result" }),
  },
  period_set_status: {
    summary: (value) => {
      const v = at(value);
      return { period: periodOf(v, "period"), status: enumToken(STATUS_TOKENS, text(v, "status")) };
    },
    evidence: (value) => {
      const status = text(at(value), "status");
      if (status === "open" || status === "closed") return { applied: true };
      return { applied: "unknown", reason: "unverified_result" };
    },
  },
  opening_balance_set: {
    summary: (value) => ({ itemCount: listLen(itemsOf(value)) }),
    evidence: (value) => (Array.isArray(prop(at(value), "items")) || Array.isArray(value)
      ? { applied: true }
      : { applied: "unknown", reason: "unverified_result" }),
  },
  account_create: {
    summary: (value) => ({ accountCount: listLen(itemsOf(value)) }),
    evidence: (value) => (Array.isArray(prop(at(value), "items"))
      ? { applied: true }
      : { applied: "unknown", reason: "unverified_result" }),
  },
  account_set_create: {
    summary: (value) => {
      const v = at(value);
      return { accountSetId: int(v, "id"), startPeriod: periodOf(v, "start_period") };
    },
    evidence: (value) => (int(at(value), "id") !== undefined
      ? { applied: true }
      : { applied: "unknown", reason: "unverified_result" }),
  },
  asset_create: {
    summary: (value) => {
      const v = at(value);
      return {
        assetId: int(v, "id"),
        // 未登记 kind 不再一律标成 fixed：只投影登记过的种类。
        kind: enumToken(ASSET_KIND_TOKENS, text(v, "kind")),
        startPeriod: periodOf(v, "start_period"),
        usefulLifeMonths: num(v, "useful_life_months"),
        originalCost: money(num(v, "original_cost")),
      };
    },
    evidence: (value) => (int(at(value), "id") !== undefined
      ? { applied: true }
      : { applied: "unknown", reason: "unverified_result" }),
  },
  // 资产卡片维护（LOCAL-02 新工具）：写动作，结果只投影业务必需的新增字段；
  // 名称 / ledger_note / 科目编码等自由文本与实现细节不进入模型通道。
  asset_update: {
    summary: (value) => {
      const v = at(value);
      const acquired = prop(v, "acquired_period");
      return {
        assetId: requirePositiveInt(v, "id"),
        kind: requireChoice(v, "kind", ASSET_KIND_CHOICES),
        startPeriod: requirePeriod(v, "start_period"),
        ...(acquired === null || acquired === undefined || acquired === ""
          ? {}
          : { acquiredPeriod: requirePeriod(v, "acquired_period") }),
        originalCost: money(requireNum(v, "original_cost")),
        usefulLifeMonths: requireNum(v, "useful_life_months"),
        openingAccumulated: money(requireNum(v, "opening_accumulated")),
        accumulated: money(requireNum(v, "accumulated")),
        remaining: money(requireNum(v, "remaining")),
        ledgerStatus: requireEnumToken(ASSET_LEDGER_STATUS_TOKENS, v, "ledger_status"),
        origin: requireEnumToken(ASSET_ORIGIN_TOKENS, v, "origin"),
      };
    },
    evidence: (value) => (int(at(value), "id") !== undefined
      ? { applied: true }
      : { applied: "unknown", reason: "unverified_result" }),
  },
  depreciation_run: {
    summary: (value) => {
      const v = at(value);
      const voucher = prop(v, "voucher");
      const runs = listOf(v, "runs");
      return {
        voucherId: int(at(voucher), "id"),
        runCount: listLen(runs),
        totalAmount: money(sumField(runs, "amount")),
        period: periodOf(at(voucher), "period"),
      };
    },
    evidence: (value) => {
      const v = at(value);
      const voucher = prop(v, "voucher");
      if (int(at(voucher), "id") !== undefined) return { applied: true };
      const runs = prop(v, "runs");
      if (Array.isArray(runs) && listLen(runs) === 0 && (voucher === null || voucher === undefined)) {
        return { applied: false, reason: "nothing_due" };
      }
      return { applied: "unknown", reason: "unverified_result" };
    },
  },
  carry_forward_profit: {
    summary: (value) => {
      const v = at(value);
      const voucher = prop(v, "voucher");
      const yearEndVoucher = prop(v, "yearEndVoucher");
      return {
        voucherId: int(at(voucher), "id"),
        yearEndVoucherId: int(at(yearEndVoucher), "id"),
        profit: money(num(v, "profit")),
        revenue: money(num(v, "revenue")),
        expense: money(num(v, "expense")),
      };
    },
    evidence: (value) => {
      const v = at(value);
      const voucherId = int(at(prop(v, "voucher")), "id");
      const yearEndId = int(at(prop(v, "yearEndVoucher")), "id");
      if (voucherId !== undefined || yearEndId !== undefined) return { applied: true };
      return { applied: "unknown", reason: "unverified_result" };
    },
  },
  legacy_book_import: {
    summary: (value) => {
      const v = at(value);
      const validation = at(prop(v, "validation"));
      const created = at(prop(v, "created"));
      const errors = listOf(validation, "errors");
      const warnings = listOf(validation, "warnings");
      return {
        dryRun: prop(v, "dryRun") === true,
        validationOk: prop(validation, "ok") === true,
        blockedByValidation: listLen(errors) > 0,
        createdAccountSetId: int(created, "id"),
        createdAccountCount: num(created, "accounts"),
        createdVoucherCount: num(created, "vouchers"),
        warningCount: listLen(warnings),
      };
    },
    evidence: (value) => {
      const v = at(value);
      if (int(at(prop(v, "created")), "id") !== undefined) return { applied: true };
      if (prop(v, "dryRun") === true) return { applied: false, reason: "dry_run" };
      return { applied: "unknown", reason: "unverified_result" };
    },
  },
  book_import_incremental: {
    summary: (value) => {
      const v = at(value);
      const created = at(prop(v, "created"));
      const batch = at(prop(v, "batch"));
      const planned = at(prop(v, "planned"));
      return {
        status: enumToken(IMPORT_STATUS_TOKENS, text(v, "status")),
        accountSetId: int(created, "accountSetId") ?? int(v, "accountSetId"),
        accountSetCreated: prop(created, "accountSetCreated") === true,
        accountsAdded: num(created, "accountsAdded"),
        openingBalancesApplied: num(created, "openingBalancesApplied"),
        vouchersCreated: num(created, "vouchersCreated"),
        vouchersDeduplicated: num(created, "vouchersDeduplicated"),
        replayed: prop(v, "replayed") === true,
        conflictCount: listLen(listOf(v, "conflicts")),
        errorCount: listLen(listOf(v, "errors")),
        validationOk: prop(at(prop(v, "validation")), "ok") === true,
        batchStatus: enumToken(BATCH_STATUS_TOKENS, text(batch, "status")),
        plannedAccountSetCreated: prop(planned, "accountSetCreated") === true,
        plannedVouchers: listLen(listOf(planned, "vouchersToCreate")),
        plannedVouchersDeduplicated: listLen(listOf(planned, "vouchersDeduplicated")),
      };
    },
    evidence: (value) => {
      const v = at(value);
      const status = text(v, "status");
      if (status === "applied") {
        return int(at(prop(v, "created")), "accountSetId") !== undefined
          ? { applied: true }
          : { applied: "unknown", reason: "unverified_result" };
      }
      if (status === "idempotent_replay") return { applied: false, reason: "idempotent_replay" };
      if (status === "preview") return { applied: false, reason: "dry_run" };
      return { applied: "unknown", reason: "unverified_result" };
    },
  },
});

// A rejected DTO may still contain independently verifiable technical IDs. These
// bounded paths use own data descriptors only; no business summary or getter runs.
const WRITE_TECHNICAL_IDS = dict({
  voucher_create: { voucherId: ["id"] },
  voucher_post: { voucherId: ["id"] },
  voucher_unpost: { voucherId: ["id"] },
  voucher_delete: { deletedVoucherId: ["deleted"] },
  asset_create: { assetId: ["id"] },
  asset_update: { assetId: ["id"] },
  depreciation_run: { voucherId: ["voucher", "id"] },
  carry_forward_profit: { voucherId: ["voucher", "id"], yearEndVoucherId: ["yearEndVoucher", "id"] },
  account_set_create: { accountSetId: ["id"] },
  legacy_book_import: { createdAccountSetId: ["created", "id"] },
  book_import_incremental: { accountSetId: ["created", "accountSetId"] },
});
function technicalWriteIds(operation, value) {
  const projection = {};
  const paths = WRITE_TECHNICAL_IDS[operation] || EMPTY;
  for (const [key, path] of Object.entries(paths)) {
    try {
      let parent = value;
      for (let i = 0; i < path.length - 1; i++) parent = prop(at(parent), path[i]);
      const id = int(at(parent), path[path.length - 1]);
      if (id !== undefined) projection[key] = id;
    } catch { /* A failed descriptor read must not hide other independently safe IDs. */ }
  }
  return projection;
}

/**
 * 无引用摘要出口：供适配器在「没有可信账套绑定」时使用（全局上下文 / 批次未绑定 / create 失败未建账）。
 * 只返回白名单 projection：不创建引用、不返回原值，未知 operation 仍拒绝。
 * 反射失败不抛异常（调用方通常已将“未能绑定引用”降级），用 summaryUnavailable 标记。
 */
export function summarizeQueryResult(operation, value) {
  const summarize = requireSpec(QUERY_SPECS, operation, "query");
  try {
    const sanitized = sanitizeProjection(summarize(value));
    return { projection: sanitized.value, projectionDropped: sanitized.dropped, summaryUnavailable: false };
  } catch {
    return { projection: freezeDeep({}), projectionDropped: 0, summaryUnavailable: true };
  }
}

/** 写结果的无引用摘要（applied 三态来自同一份证据规则，不因未绑定引用而丢）。 */
export function summarizeWriteResult(operation, value) {
  const spec = requireSpec(WRITE_SPECS, operation, "write");
  let evidence = UNKNOWN_EVIDENCE;
  try {
    evidence = normalizeEvidence(spec.evidence(value));
  } catch {
    evidence = UNKNOWN_EVIDENCE;
  }
  let projection = freezeDeep({});
  let dropped = 0;
  let summaryUnavailable = false;
  try {
    const sanitized = sanitizeProjection(spec.summary(value));
    projection = sanitized.value;
    dropped = sanitized.dropped;
  } catch {
    summaryUnavailable = true;
  }
  return {
    applied: evidence.applied,
    ...(evidence.reason ? { appliedReason: evidence.reason } : {}),
    needsLocalReview: evidence.applied !== true,
    projection,
    projectionDropped: dropped,
    summaryUnavailable,
  };
}

/** 模块支持的 operation 列表（未知 operation 一律拒绝，不做兜底）。 */
export const SUPPORTED_OPERATIONS = Object.freeze({
  query: Object.freeze(Object.keys(QUERY_SPECS).sort()),
  write: Object.freeze(Object.keys(WRITE_SPECS).sort()),
});
export const MODEL_OUTPUT_CONTRACT = Object.freeze({
  version: OUTPUT_POLICY_VERSION,
  modelChannel: Object.freeze({
    allowedValueKinds: Object.freeze(["finite_number", "boolean", "status_token", "period", "opaque_local_ref"]),
    unknownFields: "deny",
    operationMustBeRegisteredString: true,
    neverReturned: Object.freeze(["enterprise_name", "account_name", "account_code", "entry_summary",
      "counterparty", "personnel", "voucher_line", "source_file_path", "raw_error_message"]),
  }),
  localChannel: Object.freeze({
    requiresIssuedChannel: true,
    channelFromModelArgs: "rejected",
    requiresExplicitAccountSetId: true,
    requiresExplicitOperation: true,
    arithmetic: Object.freeze(["sum", "count", "min", "max"]),
  }),
  ref: Object.freeze({
    persistence: REF_PERSISTENCE,
    pattern: REF_PATTERN.source,
    boundTo: Object.freeze(["accountSetId", "operation", "category"]),
    callRequires: Object.freeze(["accountSetId", "operation"]),
    expires: true,
    revocable: true,
    capacity: DEFAULT_MAX_REFS,
    budget: Object.freeze({ nodes: DEFAULT_NODE_BUDGET, bytes: DEFAULT_BYTE_BUDGET }),
  }),
});

// ---------------------------------------------------------------- 安全错误投影
// 只有固定 allowlist 的 code 能出模型通道；其他一律归为 operation_failed。
// error.message / error.details / error.stack 从不读取——它们可能带账套名、科目名、金额原文。
const ERROR_CODES = dict({
  account_set_not_found: "account_set",
  account_not_found: "account",
  period_closed: "period",
  period_invalid: "period",
  period_required: "period",
  period_before_start: "period",
  voucher_not_found: "voucher",
  voucher_invalid: "voucher",
  voucher_id_required: "voucher",
  account_set_id_required: "account_set",
  account_set_id_invalid: "account_set",
  code_required: "account",
  entries_required: "voucher",
  name_required: "input",
  start_period_invalid: "input",
  opening_items_invalid: "input",
  opening_rewrite_after_posting: "opening",
  opening_rewrite_period_closed: "opening",
  opening_borrow_lend_conflict: "opening",
  already_carried_forward: "period_end",
  already_year_end_carried: "period_end",
  depreciation_draft_exists: "depreciation",
  asset_has_depreciation_runs: "asset",
  payload_or_texts_or_files_required: "input",
  report_data_invalid: "report",
  // ---- 普通工具适配层（finance-model-adapter.mjs）自己的固定错误码 ----
  model_tool_unknown: "tool",
  model_tool_tax_excluded: "tool",
  model_tool_not_implemented: "tool",
  model_node_unknown: "tool",
  model_node_not_implemented: "tool",
  model_arguments_invalid: "input",
  account_set_id_conflict: "input",
  model_context_page_invalid: "input",
  model_scope_mismatch: "input",
  model_result_invalid: "output_policy",
  // ---- main 里已有、会被入口转发的领域域码（只回声常量，不回声原文）----
  operation_failed: "unknown",
  accountSetId_required: "account_set",
  accountSetId_invalid: "account_set",
  nodeId_required: "input",
  items_required: "input",
  enterprise_identity_required: "input",
  enterprise_identity_invalid: "input",
  enterprise_identity_mismatch: "input",
  enterprise_already_bound: "input",
  account_set_bound_to_other_enterprise: "input",
  account_set_binding_confirmation_required: "input",
  accounting_profile_unknown: "input",
  accounting_standard_invalid: "input",
  accounting_profile_standard_mismatch: "input",
  accounting_profile_legacy_not_creatable: "input",
  import_validation_failed: "import",
  import_conflict: "import",
  batch_not_found: "import",
  batchId_required: "input",
  code_and_name_required: "account",
  direction_invalid: "account",
  category_invalid: "account",
  status_invalid: "period",
  period_not_found: "period",
  period_has_draft_vouchers: "period",
  period_unbalanced: "period",
  posted_voucher_requires_unpost: "voucher",
  voucherId_required: "voucher",
  opening_unbalanced: "opening",
  opening_code_required: "opening",
  opening_amount_invalid: "opening",
  original_cost_invalid: "asset",
  useful_life_months_invalid: "asset",
  useful_life_months_out_of_range: "asset",
  residual_rate_invalid: "asset",
  assetId_required: "asset",
  asset_not_found: "asset",
  acquired_period_invalid: "asset",
  opening_accumulated_invalid: "asset",
  opening_accumulated_exceeds_depreciable: "asset",
  ledger_status_invalid: "asset",
  ledger_note_required: "asset",
  asset_origin_invalid: "asset",
  asset_card_affects_closed_period: "asset",
  asset_card_locked_by_posted_runs: "asset",
  asset_acquired_period_missing: "asset",
  asset_purchase_voucher_pending: "asset",
  asset_ledger_pending: "asset",
  asset_missing_card: "asset",
  asset_cost_mismatch: "asset",
  asset_accumulated_mismatch: "asset",
  period_end_check_failed: "period_end",
  later_period_closed: "period_end",
  later_year_end_carryforward_depends_on_period: "period_end",
  later_profit_carryforward_depends_on_period: "period_end",
  later_depreciation_depends_on_period: "period_end",
  carryforward_stale: "period_end",
  profit_not_carried_forward: "period_end",
  profit_carry_stale: "period_end",
  year_end_not_carried: "period_end",
  previous_period_open: "period_end",
  previous_period_depreciation_pending: "period_end",
  depreciation_missing: "depreciation",
  depreciation_run_stale: "depreciation",
  depreciation_life_expired_underprovided: "depreciation",
  depreciation_global_over_depreciable: "depreciation",
  voucher_number_unplanned: "voucher",
  depreciation_exceeds_depreciable: "depreciation",
  unknown_tool: "tool",
  tool_required: "tool",
  output_policy_ref_unknown: "output_policy",
  output_policy_ref_expired: "output_policy",
  output_policy_ref_invalid: "output_policy",
  output_policy_ref_binding_mismatch: "output_policy",
  output_policy_ref_cross_account: "output_policy",
  output_policy_ref_capacity_exceeded: "output_policy",
  output_policy_ref_revoked: "output_policy",
  output_policy_channel_required: "output_policy",
  output_policy_channel_untrusted: "output_policy",
  output_policy_channel_revoked: "output_policy",
  output_policy_unknown_operation: "output_policy",
  output_policy_operation_required: "output_policy",
  output_policy_account_set_invalid: "output_policy",
  output_policy_path_invalid: "output_policy",
  output_policy_compute_op_invalid: "output_policy",
  output_policy_value_too_large: "output_policy",
  output_policy_value_invalid: "output_policy",
  output_policy_disposed: "output_policy",
  output_policy_option_invalid: "output_policy",
  output_policy_projection_invalid: "output_policy",
});

/** 安全错误投影：结构化、可判定、无原始 message/details/stack。 */
export function safeErrorProjection(error, options = {}) {
  // code 只作为固定 allowlist 的查表键：不在表内的原始 message 一律不回声。
  let declaredCode;
  let declaredMessage;
  try {
    declaredCode = error !== null && typeof error === "object" ? prop(error, "code") : undefined;
    declaredMessage = error !== null && typeof error === "object" ? prop(error, "message") : undefined;
  } catch {
    declaredCode = undefined;
    declaredMessage = undefined;
  }
  const code = typeof declaredCode === "string" && own(ERROR_CODES, declaredCode) ? declaredCode
    : typeof declaredMessage === "string" && own(ERROR_CODES, declaredMessage) ? declaredMessage
      : "operation_failed";
  const operation = typeof options.operation === "string" && OP_RE.test(options.operation)
    ? options.operation
    : undefined;
  return {
    ok: false,
    outputPolicy: OUTPUT_POLICY_VERSION,
    ...(operation ? { operation } : {}),
    error: {
      code,
      category: own(ERROR_CODES, code) ? ERROR_CODES[code] : "unknown",
      retriable: false,
      messageKey: code,
    },
    rawErrorIncluded: false,
  };
}

// ---------------------------------------------------------------- 策略实例
export class FinanceOutputPolicy {
  #now;
  #ttlMs;
  #maxRefs;
  #valueNodes;
  #valueBytes;
  #refs = new Map();
  #channels = new Map();
  #nodes = 0;
  #bytes = 0;
  #nodeBudget;
  #byteBudget;
  #disposed = false;

  constructor(options = {}) {
    const opts = at(options);
    const ttl = num(opts, "ttlMs") ?? DEFAULT_TTL_MS;
    const maxRefs = num(opts, "maxRefs") ?? DEFAULT_MAX_REFS;
    const valueNodes = num(opts, "valueNodes") ?? DEFAULT_VALUE_NODES;
    const nodeBudget = num(opts, "nodeBudget") ?? DEFAULT_NODE_BUDGET;
    const valueBytes = num(opts, "valueBytes") ?? DEFAULT_VALUE_BYTES;
    const byteBudget = num(opts, "byteBudget") ?? DEFAULT_BYTE_BUDGET;
    if (!Number.isSafeInteger(ttl) || ttl <= 0) throw new OutputPolicyError("output_policy_option_invalid", "ttlMs 必须是正整数");
    if (!Number.isSafeInteger(maxRefs) || maxRefs <= 0) throw new OutputPolicyError("output_policy_option_invalid", "maxRefs 必须是正整数");
    if (!Number.isSafeInteger(valueNodes) || valueNodes <= 0) throw new OutputPolicyError("output_policy_option_invalid", "valueNodes 必须是正整数");
    if (!Number.isSafeInteger(nodeBudget) || nodeBudget <= 0) throw new OutputPolicyError("output_policy_option_invalid", "nodeBudget 必须是正整数");
    if (!Number.isSafeInteger(valueBytes) || valueBytes <= 0) throw new OutputPolicyError("output_policy_option_invalid", "valueBytes 必须是正整数");
    if (!Number.isSafeInteger(byteBudget) || byteBudget <= 0) throw new OutputPolicyError("output_policy_option_invalid", "byteBudget 必须是正整数");
    const now = prop(opts, "now");
    if (now !== undefined && typeof now !== "function") throw new OutputPolicyError("output_policy_option_invalid", "now 必须是函数");
    this.#now = now || Date.now;
    this.#ttlMs = ttl;
    this.#maxRefs = maxRefs;
    this.#valueNodes = valueNodes;
    this.#valueBytes = valueBytes;
    this.#nodeBudget = nodeBudget;
    this.#byteBudget = byteBudget;
  }

  /** 本机签发能力通道；只有拿到这个对象的本机代码才能读取原数据。 */
  issueChannel(label = "local") {
    this.#assertAlive();
    if (typeof label !== "string" || !PROJ_TOKEN_RE.test(label)) {
      throw new OutputPolicyError("output_policy_channel_untrusted", "channel 标签必须是小写 token");
    }
    const token = Object.freeze({ channelId: `localch_${randomBytes(16).toString("hex")}` });
    this.#channels.set(token, { label, createdAt: this.#now(), reads: 0, revoked: false });
    return token;
  }

  releaseChannel(token) {
    const record = this.#channels.get(token);
    if (!record) return { released: false };
    record.revoked = true;
    // 保留已释放记录以便区分“已释放”与“参数伪造”，并限制保留数量避免无界增长。
    if (this.#channels.size > 64) {
      for (const [key, value] of this.#channels) {
        if (value.revoked && this.#channels.size > 64) this.#channels.delete(key);
      }
    }
    return { released: true };
  }

  stats() {
    this.#sweep();
    let activeChannels = 0;
    for (const record of this.#channels.values()) if (!record.revoked) activeChannels++;
    return {
      refs: this.#refs.size,
      channels: activeChannels,
      maxRefs: this.#maxRefs,
      ttlMs: this.#ttlMs,
      nodes: this.#nodes,
      nodeBudget: this.#nodeBudget,
      bytes: this.#bytes,
      byteBudget: this.#byteBudget,
      persistence: REF_PERSISTENCE,
    };
  }

  /** 查询结果 → 模型摘要 + 本地引用。容量不足时报错（查询不退回原文）。 */
  wrapQuery(operation, options = {}) {
    this.#assertAlive();
    // ① operation 必须是已登记的原始字符串（先验类型，再查表，永不把入参放进信封）
    const summarize = requireSpec(QUERY_SPECS, operation, "query");
    const opts = at(options);
    const accountSetId = normSetId(prop(opts, "accountSetId"));
    const value = prop(opts, "value");
    // ② 先做安全形状 + 节点/字节预算检查，再看摘要：getter / 循环 / 类实例先拒绝。
    const inspection = this.#inspect(value);
    // ③ 摘要函数只读自有 data 属性；反射阶段抛错（恶意对象）归一为安全拒绝。
    let projection;
    try {
      projection = sanitizeProjection(summarize(value));
    } catch (error) {
      throw asSafeReadError(error);
    }
    const stored = this.#store(operation, "query", accountSetId, value, projection.value, inspection);
    if (!stored.ref) {
      throw new OutputPolicyError("output_policy_ref_capacity_exceeded", "本地引用数量、节点或字节预算已达上限，请先释放或等待到期");
    }
    return {
      ok: true,
      outputPolicy: OUTPUT_POLICY_VERSION,
      channel: "model",
      operation,
      operationCategory: "query",
      accountSetId,
      projection: stored.projection,
      projectionDropped: projection.dropped,
      localRef: stored.ref,
      refPersistence: REF_PERSISTENCE,
      refExpiresAt: stored.expiresAtIso,
      rawValuesIncluded: false,
    };
  }

  /** 已执行的写结果 → 模型摘要 + 本地引用；applied 只认正面证据。 */
  wrapWrite(operation, options = {}) {
    this.#assertAlive();
    // 预校验（未登记 operation / 缺账套）仍抛错：这是调用方用错，与“写已发生”无关。
    const spec = requireSpec(WRITE_SPECS, operation, "write");
    const opts = at(options);
    const accountSetId = normSetId(prop(opts, "accountSetId"));
    const value = prop(opts, "value");
    // ① applied 证据只靠自有 data 属性读取（无遍历、无 getter、无用户回调）；读不到就是 unknown。
    let evidence = UNKNOWN_EVIDENCE;
    try {
      evidence = normalizeEvidence(spec.evidence(value));
    } catch {
      evidence = UNKNOWN_EVIDENCE;
    }
    // ② 形状检查先于摘要；写已经发生，之后任何失败只能降级、不能抛给调用方。
    let inspection = null;
    let inspectReason = null;
    try {
      inspection = inspectRawValue(value, this.#valueNodes, this.#valueBytes);
    } catch (error) {
      inspectReason = classifyRawFailure(error);
    }
    let projection = freezeDeep({});
    let dropped = 0;
    let stored = { ref: null, expiresAtIso: null, reason: inspectReason };
    // 形状非法（getter / 循环 / 类实例）不再读业务字段；单纯超量仍可给摘要（spec 自身有界）。
    if (inspectReason === null || inspectReason === "value_limit") {
      try {
        const sanitized = sanitizeProjection(spec.summary(value));
        projection = sanitized.value;
        dropped = sanitized.dropped;
        if (inspection) stored = this.#store(operation, "write", accountSetId, value, projection, inspection);
      } catch (error) {
        projection = freezeDeep({});
        dropped = 0;
        if (stored.reason === null) stored = { ref: null, expiresAtIso: null, reason: classifyRawFailure(error) };
      }
    }
    // Malformed committed DTOs cannot supply business detail, but own data IDs remain
    // independently provable. Never traverse the rejected value or invoke accessors.
    if (stored.reason === "value_invalid" || stored.reason === "summary_unavailable") {
      projection = sanitizeProjection(technicalWriteIds(operation, value)).value;
    }
    return this.#writeEnvelope(operation, accountSetId, evidence, projection, dropped, stored);
  }

  /**
   * 执行一个同步写动作再包装：域异常不吞成功、也不伪造成失败。
   * 所有能预先确定的校验（operation / 账套 / 回调）都在 execute 之前完成；
   * 包装阶段失败一律返回安全信封（applied 未知时用 "unknown"，绝不反转为失败或伪成功）。
   */
  runWrite(operation, options = {}) {
    this.#assertAlive();
    requireSpec(WRITE_SPECS, operation, "write");
    const opts = at(options);
    const accountSetId = normSetId(prop(opts, "accountSetId"));
    const execute = prop(opts, "execute");
    if (typeof execute !== "function") throw new OutputPolicyError("output_policy_option_invalid", "execute 必须是函数");
    let value;
    try {
      value = execute();
    } catch (error) {
      return {
        ...safeErrorProjection(error, { operation }),
        channel: "model",
        operationCategory: "write",
        accountSetId,
        applied: "unknown",
        needsLocalReview: true,
      };
    }
    try {
      return this.wrapWrite(operation, { accountSetId, value });
    } catch {
      // 写已发生：包装异常不能冒泡（否则调用方会把它当业务失败并重试）。
      return this.#writeEnvelope(operation, accountSetId, UNKNOWN_EVIDENCE, freezeDeep({}), 0,
        { ref: null, expiresAtIso: null, reason: "summary_unavailable" });
    }
  }

  /** 模型再次解引用：永远只得到同一份白名单摘要，拿不到原数据。必须显式带账套与 operation。 */
  resolveForModel(ref, context = {}) {
    this.#assertAlive();
    const record = this.#take(ref, this.#ctxOf(context));
    return {
      ok: true,
      outputPolicy: OUTPUT_POLICY_VERSION,
      channel: "model",
      operation: record.operation,
      operationCategory: record.category,
      accountSetId: record.accountSetId,
      projection: record.projection,
      localRef: record.ref,
      refExpiresAt: new Date(record.expiresAt).toISOString(),
      rawValuesIncluded: false,
    };
  }

  /** 本机通道：凭引用取原数据（调用方必须显式传本机签发的 channel 能力对象）。 */
  localRead(ref, context) {
    this.#assertAlive();
    const channel = this.#channelRecord(context);
    const record = this.#take(ref, this.#ctxOf(context));
    record.reads++;
    channel.reads++;
    return {
      ok: true,
      channel: "local",
      channelLabel: channel.label,
      operation: record.operation,
      operationCategory: record.category,
      accountSetId: record.accountSetId,
      ref: record.ref,
      reads: record.reads,
      value: record.value,
    };
  }

  /** 本机通道：有限受控算术（只在本机执行，结果可交给本机 UI；不替代业务核算）。 */
  localCompute(ref, context) {
    this.#assertAlive();
    const channel = this.#channelRecord(context);
    const ctx = this.#ctxOf(context);
    const record = this.#take(ref, ctx);
    // 调用上下文也可能来自不可信来源：读不到就明确报参数错误，不把原始异常传出去。
    let op;
    let rawPath;
    try {
      op = prop(ctx, "op");
      rawPath = prop(ctx, "path");
    } catch {
      throw new OutputPolicyError("output_policy_compute_op_invalid", "调用上下文无法安全读取");
    }
    if (op !== "sum" && op !== "count" && op !== "min" && op !== "max") {
      throw new OutputPolicyError("output_policy_compute_op_invalid", "op 只支持 sum / count / min / max");
    }
    let segments;
    try {
      segments = normalizePath(rawPath);
    } catch (error) {
      if (error instanceof OutputPolicyError) throw error;
      throw new OutputPolicyError("output_policy_path_invalid", "path 无法安全读取");
    }
    const collected = collectNumbers(record.value, segments);
    let value = null;
    if (op === "count") value = collected.numbers.length;
    else if (collected.numbers.length) {
      const total = collected.numbers.reduce((acc, n) => (op === "sum" ? acc + n
        : op === "min" ? Math.min(acc, n) : Math.max(acc, n)), op === "min" ? Infinity : op === "max" ? -Infinity : 0);
      value = money(total);
    }
    if (typeof value === "number" && Math.abs(value) > MONEY_LIMIT) {
      throw new OutputPolicyError("output_policy_value_too_large", "计算结果超过金额上限");
    }
    channel.reads++;
    return {
      ok: true,
      channel: "local",
      operation: record.operation,
      accountSetId: record.accountSetId,
      op,
      path: segments,
      matched: collected.numbers.length,
      skipped: collected.skipped,
      nodes: collected.nodes,
      value,
      empty: value === null,
    };
  }

  /** 撤销引用（本机通道）：之后模型通道与本机通道都取不到。同样要求 channel + 账套 + operation。 */
  revokeLocalRef(ref, context) {
    this.#assertAlive();
    this.#channelRecord(context);
    this.#take(ref, this.#ctxOf(context));
    this.#drop(ref);
    return { revoked: true, ref };
  }

  /** 安全错误投影（实例便捷入口，供入口层在 catch 里调用）。 */
  toSafeError(error, options = {}) {
    return safeErrorProjection(error, options);
  }

  dispose() {
    this.#refs.clear();
    this.#nodes = 0;
    this.#bytes = 0;
    for (const record of this.#channels.values()) record.revoked = true;
    this.#channels.clear();
    this.#disposed = true;
  }

  // ------------------------------------------------------------ 内部
  #assertAlive() {
    if (this.#disposed) throw new OutputPolicyError("output_policy_disposed", "策略实例已释放");
  }

  #ctxOf(context) {
    return context !== null && typeof context === "object" ? context : EMPTY;
  }

  /** channel 必须是本机签发的能力对象；任何来自参数的 local=true / channel 字符串都拒绝。 */
  #channelRecord(context) {
    let record;
    let claimedChannel;
    let claimedLocal;
    try {
      const ctx = this.#ctxOf(context);
      claimedChannel = prop(ctx, "channel");
      claimedLocal = prop(ctx, "local");
      record = claimedChannel !== null && typeof claimedChannel === "object" ? this.#channels.get(claimedChannel) : undefined;
    } catch {
      record = undefined;
    }
    if (record) {
      if (record.revoked) throw new OutputPolicyError("output_policy_channel_revoked", "该本机通道已释放");
      return record;
    }
    // 模型参数伪装的本地声明：明确拒绝，不做静默降级。
    if (claimedLocal === true || claimedChannel !== undefined) {
      throw new OutputPolicyError("output_policy_channel_untrusted", "不接受调用参数里声明的 local / channel；必须使用本机签发的通道对象");
    }
    throw new OutputPolicyError("output_policy_channel_required", "本机读取必须显式传入本机签发的 channel");
  }

  /**
   * 所有引用调用统一绑定核验：`accountSetId` 与 `operation` 都必须显式给出并匹配。
   * 不存在“缺省账套”路径；真正全局的工具必须另设 scope 语义，
   * 不得用缺省账套或伪造绑定绕过。
   */
  #take(ref, ctx) {
    if (!isRef(ref)) {
      throw new OutputPolicyError("output_policy_ref_invalid", "引用格式非法");
    }
    const record = this.#refs.get(ref);
    if (!record) throw new OutputPolicyError("output_policy_ref_unknown", "引用不存在、已撤销或已过期");
    if (record.expiresAt <= this.#now()) {
      this.#drop(ref);
      throw new OutputPolicyError("output_policy_ref_expired", "引用已过期");
    }
    let setAccountSetId;
    let claimedOperation;
    try {
      setAccountSetId = normSetId(prop(ctx, "accountSetId"));
      claimedOperation = prop(ctx, "operation");
    } catch (error) {
      if (error instanceof OutputPolicyError) {
        throw new OutputPolicyError("output_policy_account_set_invalid", "必须显式提供正整数 accountSetId");
      }
      throw new OutputPolicyError("output_policy_ref_binding_mismatch", "引用调用上下文无法安全读取");
    }
    if (setAccountSetId !== record.accountSetId) {
      throw new OutputPolicyError("output_policy_ref_cross_account", "引用不属于该账套");
    }
    if (claimedOperation === undefined || claimedOperation === null) {
      throw new OutputPolicyError("output_policy_operation_required", "必须显式提供 operation");
    }
    if (typeof claimedOperation !== "string" || claimedOperation !== record.operation) {
      throw new OutputPolicyError("output_policy_ref_binding_mismatch", "引用与请求的工具/操作不匹配");
    }
    return record;
  }

  /** 形状 + 节点 + 字节预算检查（查询通道：失败即拒绝）。 */
  #inspect(value) {
    try {
      return inspectRawValue(value, this.#valueNodes, this.#valueBytes);
    } catch (error) {
      throw asSafeReadError(error);
    }
  }

  #writeEnvelope(operation, accountSetId, evidence, projection, dropped, stored) {
    const envelope = {
      ok: true,
      outputPolicy: OUTPUT_POLICY_VERSION,
      channel: "model",
      operation,
      operationCategory: "write",
      accountSetId,
      applied: evidence.applied,
      needsLocalReview: evidence.applied !== true || stored.reason === "value_invalid" || stored.reason === "summary_unavailable",
      projection,
      projectionDropped: dropped,
      localRef: stored.ref,
      refPersistence: stored.ref ? REF_PERSISTENCE : "none",
      rawValuesIncluded: false,
    };
    if (evidence.reason) envelope.appliedReason = evidence.reason;
    if (!stored.ref) envelope.refUnavailable = stored.reason || "value_limit";
    else envelope.refExpiresAt = stored.expiresAtIso;
    return envelope;
  }

  #store(operation, category, accountSetId, value, projection, inspection) {
    const { nodes, bytes } = inspection;
    this.#sweep();
    if (this.#refs.size >= this.#maxRefs) return { ref: null, expiresAtIso: null, reason: "capacity" };
    if (this.#nodes + nodes > this.#nodeBudget) return { ref: null, expiresAtIso: null, reason: "node_budget" };
    if (this.#bytes + bytes > this.#byteBudget) return { ref: null, expiresAtIso: null, reason: "byte_budget" };
    const createdAt = this.#now();
    const expiresAt = createdAt + this.#ttlMs;
    const ref = `finref_${randomBytes(24).toString("hex")}`;
    this.#refs.set(ref, {
      ref, operation, category, accountSetId, createdAt, expiresAt, nodes, bytes,
      value, projection, reads: 0,
    });
    this.#nodes += nodes;
    this.#bytes += bytes;
    return { ref, projection, expiresAtIso: new Date(expiresAt).toISOString() };
  }

  /** 统一的引用清理：容量 / 节点 / 字节预算 / 到期 / 撤销都走这里，保证计数一致。 */
  #drop(ref) {
    const record = this.#refs.get(ref);
    if (!record) return false;
    this.#refs.delete(ref);
    this.#nodes -= record.nodes;
    this.#bytes -= record.bytes;
    return true;
  }

  #sweep() {
    const now = this.#now();
    for (const [ref, record] of this.#refs) if (record.expiresAt <= now) this.#drop(ref);
  }
}

// ---------------------------------------------------------------- 本机算术（受控）
function normalizePath(path) {
  const raw = Array.isArray(path) ? path.slice(0, MAX_SEGMENTS + 1) : typeof path === "string" ? path.split(".") : null;
  if (!raw || raw.length === 0 || raw.length > MAX_SEGMENTS) {
    throw new OutputPolicyError("output_policy_path_invalid", `path 必须是 1-${MAX_SEGMENTS} 段`);
  }
  let arrays = 0;
  const segments = [];
  for (const segment of raw) {
    if (segment === "[]") {
      arrays++;
      if (arrays > 1) throw new OutputPolicyError("output_policy_path_invalid", "path 只允许一个数组展开段 []");
      segments.push("[]");
      continue;
    }
    if (typeof segment !== "string" || !PROJ_KEY_RE.test(segment) || BLOCKED_KEYS.has(segment)) {
      throw new OutputPolicyError("output_policy_path_invalid", "path 段必须是普通字段名");
    }
    segments.push(segment);
  }
  return segments;
}

function collectNumbers(root, segments) {
  const numbers = [];
  let nodes = 0, skipped = 0;
  const walk = (current, index) => {
    nodes++;
    if (nodes > MAX_COMPUTE_NODES) {
      throw new OutputPolicyError("output_policy_value_too_large", `本地计算节点数超过上限 ${MAX_COMPUTE_NODES}`);
    }
    if (index === segments.length) {
      if (typeof current === "number" && Number.isFinite(current) && Math.abs(current) <= MONEY_LIMIT) numbers.push(current);
      else if (current !== undefined) skipped++;
      return;
    }
    const segment = segments[index];
    if (segment === "[]") {
      if (!Array.isArray(current)) { skipped++; return; }
      const length = listLen(current);
      if (length > MAX_COMPUTE_ARRAY) {
        throw new OutputPolicyError("output_policy_value_too_large", `本地计算数组长度超过上限 ${MAX_COMPUTE_ARRAY}`);
      }
      for (let i = 0; i < length; i++) walk(prop(current, i), index + 1);
      return;
    }
    const next = prop(current, segment);
    if (next === undefined) { skipped++; return; }
    walk(next, index + 1);
  };
  walk(root, 0);
  return { numbers, nodes, skipped };
}

export default FinanceOutputPolicy;
