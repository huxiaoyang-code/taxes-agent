// tax-api-catalog-readiness.mjs — 调用准备层（纯校验，不连接税局、不实现代理）。
//
// 职责：
//   - 校验「当前账号/企业上下文引用 + 参数来源 + 权限声明」是否满足目录合同；
//   - 明确返回 not_ready 与具体缺项，绝不因为目录里有条目就声称某企业可用；
//   - 登录/写接口一律判为不可由 Agent 自动执行（要求显式人工确认）；
//   - 保留未来适配器接入口：状态里只有 adapterBinding: "missing"，没有真实请求实现。
//
// 目录事实不是授权事实：本模块不读取 cookie、不读凭据、不读账套库；
// 账套存在性由调用方注入 resolver（生产注入 accounting.getAccountSet）。
import { catalogError, contractCompleteness as contractCompletenessOf, getCatalogEntry, riskRank, validateParams } from "./tax-api-catalog.mjs";
import { retryPolicyFor, timeoutFor } from "./tax-api-catalog-classify.mjs";

export const PREPARE_STATES = Object.freeze({
  not_ready: "未就绪（存在明确缺项，不能发起调用）",
  blocked_by_policy: "策略阻断（登录/写接口或风险未知，不允许 Agent 自动执行）",
  contract_ready_adapter_missing: "合同齐备但适配器缺失（可用于人工准备，仍非线上已验证）",
});

const CONTEXT_KEYS = Object.freeze(["accountSetId", "enterpriseRef", "period", "permissions", "loginSessionRef", "operatorConfirmed"]);
const ENTERPRISE_REF = /^ent_[a-f0-9]{16,64}$/;
const LOGIN_REF = /^loginsession_[a-f0-9]{16,64}$/;
const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;
const PERMISSION = /^[a-z][a-z0-9_.]{1,63}$/;
const MAX_ACCOUNT_SET_ID = 2 ** 31 - 1;

/**
 * accountSetId 必须是严格正整数：只接受 number 安全整数或纯十进制数字串。
 * `Number(value)` 会把 true 变成 1、把 "1e3" 变成 1000，一律拒绝。
 */
function strictPositiveInt(value) {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 && value <= MAX_ACCOUNT_SET_ID ? value : null;
  }
  if (typeof value === "string") {
    if (!/^[1-9][0-9]{0,9}$/.test(value)) return null;
    const n = Number(value);
    return Number.isSafeInteger(n) && n > 0 && n <= MAX_ACCOUNT_SET_ID ? n : null;
  }
  return null;
}

function gap(code, message) {
  return { code, message };
}

/** 上下文引用与权限声明一律只做格式校验，明确标记未核实。 */
const UNVERIFIED_NOTE = "仅做格式校验：本层不核实企业归属、登录会话有效性或权限授予";

function checkContext(context = {}, { accountSetExists = null } = {}) {
  const gaps = [];
  if (context === null || typeof context !== "object" || Array.isArray(context)) {
    return { gaps: [gap("context_invalid", "context 必须是对象")], normalized: {}, verification: unverifiedVerification() };
  }
  const unknownCount = Object.keys(context).filter((key) => !CONTEXT_KEYS.includes(key)).length;
  if (unknownCount) {
    // 不回显任何未知键名（键名本身也可能是任意输入）。
    gaps.push(gap("context_field_rejected", `存在不接受的上下文引用字段（${unknownCount} 项，未回显键名）`));
  }
  const normalized = {};
  let accountSetChecked = false;
  if (context.accountSetId !== undefined) {
    const id = strictPositiveInt(context.accountSetId);
    if (id === null) {
      gaps.push(gap("account_set_ref_invalid", "accountSetId 必须是严格正整数（不接受布尔、浮点、科学计数法或非数字串）"));
    } else if (typeof accountSetExists === "function") {
      let exists;
      try {
        exists = accountSetExists(id);
      } catch {
        exists = false;
      }
      // 约定：resolver 必须同步返回布尔。返回 false 视为本地账套不存在；返回非布尔视为解析失败。
      if (exists === true) {
        normalized.accountSetId = id;
        accountSetChecked = true;
      } else if (exists === false) {
        gaps.push(gap("account_set_not_found", "本地账套不存在（resolver 返回 false）"));
      } else {
        gaps.push(gap("account_set_unverified", "账套校验器未返回布尔结果，账套引用未核实"));
      }
    } else {
      normalized.accountSetId = id;
      gaps.push(gap("account_set_unverified", "未注入账套校验器，账套引用未核实"));
    }
  }
  if (context.enterpriseRef !== undefined) {
    if (typeof context.enterpriseRef !== "string" || !ENTERPRISE_REF.test(context.enterpriseRef)) {
      gaps.push(gap("enterprise_ref_invalid", "enterpriseRef 必须是安全的引用串，不接受企业名称/识别号等业务原值"));
    } else {
      normalized.enterpriseRef = context.enterpriseRef;
    }
  }
  if (context.loginSessionRef !== undefined) {
    if (typeof context.loginSessionRef !== "string" || !LOGIN_REF.test(context.loginSessionRef)) {
      gaps.push(gap("login_session_ref_invalid", "loginSessionRef 必须是安全的引用串，不接受令牌或 cookie"));
    } else {
      normalized.loginSessionRef = context.loginSessionRef;
    }
  }
  if (context.period !== undefined) {
    if (typeof context.period !== "string" || !PERIOD.test(context.period)) {
      gaps.push(gap("period_invalid", "period 格式应为 YYYY-MM"));
    } else {
      normalized.period = context.period;
    }
  }
  if (context.permissions !== undefined) {
    if (!Array.isArray(context.permissions) || context.permissions.length > 64
        || !context.permissions.every((p) => typeof p === "string" && PERMISSION.test(p))) {
      gaps.push(gap("permissions_invalid", "permissions 必须是安全标识串数组"));
    } else {
      normalized.permissions = [...context.permissions];
    }
  }
  if (context.operatorConfirmed !== undefined && typeof context.operatorConfirmed !== "boolean") {
    gaps.push(gap("operator_confirmed_invalid", "operatorConfirmed 必须是布尔"));
  } else if (context.operatorConfirmed !== undefined) {
    normalized.operatorConfirmed = context.operatorConfirmed;
  }
  return { gaps, normalized, verification: unverifiedVerification(accountSetChecked) };
}

function unverifiedVerification(accountSetChecked = false) {
  return {
    accountSetExistsChecked: accountSetChecked,
    enterpriseOwnershipChecked: false,
    loginSessionValidityChecked: false,
    permissionGrantChecked: false,
    userDeclaredRefsFormatOnly: true,
    userDeclaredPermissionsFormatOnly: true,
    note: UNVERIFIED_NOTE,
  };
}

/**
 * 生成调用准备结论。
 * @param {{id:string, params?:object, context?:object}} input
 * @param {{accountSetExists?:(id:number)=>unknown}} options 账套存在性校验器（生产注入 accounting）
 */
export function prepareCatalogCall(input = {}, options = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw catalogError("catalog_prepare_input_invalid", "输入必须是对象");
  }
  const unknownInputCount = Object.keys(input).filter((key) => !["id", "params", "context"].includes(key)).length;
  if (unknownInputCount) {
    // 不回显未知键名。
    throw catalogError("catalog_prepare_input_invalid", `不接受未登记的输入字段（${unknownInputCount} 项，未回显键名）`);
  }
  const entry = getCatalogEntry(input.id);
  const gaps = [];

  // 1) 目录自身合同
  if (!entry.pathKnown) gaps.push(gap("path_template_unknown", "报告未给出静态路径模板（通配分组或未列名）"));
  if (entry.method === "unknown") gaps.push(gap("method_unknown", "报告未载明请求方法"));
  if (entry.paramsEvidence !== "observed") {
    gaps.push(entry.paramsEvidence === "envelope_only"
      ? gap("parameter_contract_envelope_only", "只有共享传输信封已知，业务字段未载明")
      : entry.paramsEvidence === "inferred"
        ? gap("parameter_contract_inferred", "参数结构为推断，报告未逐项确认")
        : gap("parameter_contract_unknown", "报告未载明参数结构"));
  }
  if (entry.responseEvidence !== "observed") {
    gaps.push(gap("response_contract_unknown", "报告未载明该接口的响应结构"));
  }
  if (entry.evidence === "static") {
    gaps.push(gap("not_observed_live", "该接口仅静态列举，报告未观察过实际调用"));
  }

  // 2) 参数校验（不回显参数值与任意键名）；合同级缺口已在上面统一记录，不重复累加
  const params = input.params ?? {};
  const validation = validateParams(entry.id, params);
  const contractCodes = new Set(["parameter_contract_unknown", "parameter_contract_envelope_only", "parameter_contract_inferred"]);
  for (const problem of validation.problems) {
    if (contractCodes.has(problem.code)) continue;
    gaps.push(gap(`param_${problem.code}`, problem.message));
  }

  // 3) 上下文引用与依赖
  const { gaps: contextGaps, normalized, verification } = checkContext(input.context ?? {}, options);
  gaps.push(...contextGaps);

  const identityRequired = entry.identityDependency?.required;
  if (identityRequired === true && !normalized.loginSessionRef) {
    gaps.push(gap("identity_context_missing", "该接口属登录后门户/业务域，需提供 loginSessionRef 引用"));
  }
  if (identityRequired === "unknown") {
    gaps.push(gap("identity_requirement_unknown", "报告未载明是否需要已登录会话"));
  }
  if (entry.enterpriseDependency?.required === "unknown") {
    gaps.push(gap("enterprise_requirement_unknown", "报告未载明企业上下文绑定方式；目录事实不能证明任一企业可用"));
  } else if (entry.enterpriseDependency?.required === true && !normalized.enterpriseRef) {
    gaps.push(gap("enterprise_context_missing", "该接口需企业上下文引用 enterpriseRef"));
  }
  if (entry.permissionDependency?.required === "unknown") {
    gaps.push(gap("permission_requirement_unknown", "报告未载明所需权限"));
  } else if (entry.permissionDependency?.required === true && !(normalized.permissions || []).length) {
    gaps.push(gap("permission_missing", "该接口需显式权限声明，当前上下文未提供"));
  }

  // 4) 策略：登录/写/未知风险不可自动执行
  const policyBlocked = entry.risk === "authentication" || entry.risk === "state_changing" || entry.risk === "unknown";
  if (policyBlocked) {
    gaps.push(gap(`policy_${entry.risk}_blocked`,
      entry.risk === "authentication"
        ? "登录/认证接口不得由 Agent 自动执行，须人工在官方页面完成"
        : entry.risk === "state_changing"
          ? "写接口不得由 Agent 自动执行，须操作员显式确认后人工执行"
          : "风险未知，按最严格策略阻断自动执行"));
  }

  // 5) 结论（contract_ready_adapter_missing 也不等于线上可调，且恒有 missing 适配器）
  const contractGaps = gaps.filter((g) => ["path_template_unknown", "method_unknown", "parameter_contract_unknown",
    "parameter_contract_envelope_only", "parameter_contract_inferred", "response_contract_unknown",
    "not_observed_live"].includes(g.code));
  let state;
  if (policyBlocked) state = "blocked_by_policy";
  else if (gaps.length) state = "not_ready";
  else state = "contract_ready_adapter_missing";

  return {
    id: entry.id,
    module: entry.module,
    purpose: entry.purpose,
    risk: entry.risk,
    state,
    stateLabel: PREPARE_STATES[state],
    readyToInvoke: false,
    adapterBinding: "missing",
    adapterNote: "本层只做参数与上下文校验；没有任何真实适配器，也不会发出请求",
    notReadyReasons: gaps,
    contractGaps,
    contractCompleteness: contractCompletenessOf(entry),
    contextRefs: {
      accountSetId: normalized.accountSetId ?? null,
      enterpriseRef: normalized.enterpriseRef ?? null,
      loginSessionRef: normalized.loginSessionRef ?? null,
      period: normalized.period ?? null,
      permissionCount: (normalized.permissions || []).length,
    },
    contextVerification: verification,
    paramValidation: {
      valid: validation.valid,
      contractVerified: validation.contractVerified,
      declaredParamCount: validation.declaredParamCount,
      providedParamCount: validation.providedParamCount,
      problems: validation.problems,
    },
    transport: {
      timeoutMs: timeoutFor(entry.risk),
      timeoutPolicy: "local_policy_default_not_tax_sla",
      // 静态能力与本次建议分开：本层未发请求，所以本次重试建议恒为 false。
      retryCapability: retryPolicyFor(entry.risk),
      retryAdvice: { allowed: false, reason: "本层未发出请求，不产生重试建议" },
      autoRetryForLoginOrWrite: false,
    },
    riskRank: riskRank(entry.risk),
    catalogManaged: true,
    liveCallVerified: false,
    note: "not_ready / blocked_by_policy 都不是“接口不存在”；contract_ready_adapter_missing 也不等于线上调用已验证",
  };
}
