// tax-gateway.mjs — 全国电子税务局适配层（第一期：只预留接口，不联网、不接真实税局）
//
// 设计边界：
//   - 本模块只依赖 node 内置模块，不读数据库、不发网络请求；账套存在性校验由调用方注入
//     （agent-tools.mjs 注入 accounting.getAccountSet），因此可在纯本地测试里独立构造。
//   - 适配器（adapter）由代码显式注册，绝不通过环境变量/接口加载模块路径或执行任意代码。
//     默认注册表为空 —— 生产默认没有任何已接入地区，登录类调用一律返回结构化「未接入」错误。
//   - 适配器只负责「怎么和某一地区电子税务局说话」；状态机、会话绑定、脱敏与白名单在网关内。
//   - 网关不提供任何「跳过人工验证」的入口：challenge 必须由人工响应后交给适配器判定。
//   - 适配器方法允许同步返回，也允许返回 Promise（真实适配器必然是异步的）：网关一律 await。
//     所有适配器调用都在 try/catch 内 await，异步拒绝会被归一成结构化错误，不产生 unhandled rejection。
//
// 术语：
//   region     地区标识。`CN` 只是全国产品入口；税务服务地区是大陆 31 个省级行政区 + 5 个计划单列市。
//   adapterId  同一地区可有多个适配器（如不同登录通道），用 adapterId 区分。
//   capabilities 适配器自报的能力声明：支持的登录方式、可查询资源、可处理的验证动作。

import { randomBytes, createHash } from "node:crypto";

/** 网关结构化错误。server 侧会转成 ToolError，保留 code 供 MCP 客户端判断。 */
export class TaxError extends Error {
  constructor(code, message, details = null) {
    super(message || code);
    this.name = "TaxError";
    this.code = code;
    this.details = details;
  }
}

// ---------------------------------------------------------------- 常量：地区 / 资源 / 登录方式
/**
 * 全国入口标识：产品目标，不代表一个可登录的税务服务地区。
 * 适配器不得注册到 CN（`registerAdapter` 会拒绝），登录也不接受 CN。
 */
export const NATIONWIDE_REGION = "CN";

/**
 * 会话状态机（唯一合法取值）。
 *   requires_action 待人工验证   authenticated 已认证
 *   expired 已过期               failed 已失败
 *   logged_out 已退出
 */
export const TAX_STATES = ["requires_action", "authenticated", "expired", "failed", "logged_out"];

/** 信息资源契约：适配器按地区声明自己实际支持哪些，未声明的查询必须结构化失败。 */
export const TAX_RESOURCES = [
  { id: "identity", label: "当前身份", shape: "object", description: "当前登录办税人员身份与角色（证件号脱敏）" },
  { id: "authorized_enterprises", label: "授权企业", shape: "array", description: "当前身份被授权办理的企业清单" },
  { id: "enterprise_profile", label: "企业基础资料", shape: "object", description: "企业登记基础资料（纳税人识别号脱敏）" },
  { id: "tax_assessments", label: "税种核定", shape: "array", description: "税种核定信息（税种、申报期、有效期）" },
  { id: "declaration_status", label: "申报状态", shape: "array", description: "按期次的申报状态" },
];

/** 登录方式契约（抽象类型，不代表任何地区的真实可用性）。 */
export const TAX_LOGIN_METHODS = [
  { id: "password", label: "账号密码" },
  { id: "sms", label: "短信验证码" },
  { id: "qrcode", label: "扫码" },
  { id: "realname", label: "实名确认" },
  { id: "certificate", label: "数字证书（CA）" },
];

/**
 * 官方来源：12366 纳税服务平台的地区目录与「计划单列市直接选市税务局」的要求。
 * 网关只记录来源链接，不据此臆造任何登录网址、接口或已接入状态。
 */
export const REGION_SOURCES = [
  {
    label: "国家税务总局 12366 纳税服务平台 · 地区目录（31 省区市 + 大连/宁波/厦门/青岛/深圳）",
    url: "https://12366.chinatax.gov.cn/wap/pages/index.html",
  },
  {
    label: "12366 常见表单页 · 计划单列市应直接选择该市税务局，勿选所在省",
    url: "https://12366.chinatax.gov.cn/wap/pages/form_common.html",
  },
];

/**
 * 大陆税务服务地区：31 个省级行政区。这里只提供「标识与名称」，
 * 不含任何网址、接口或协议——各地区是否接入一律以注册表为准。
 */
const PROVINCE_ROWS = [
  ["110000", "北京市"], ["120000", "天津市"], ["130000", "河北省"], ["140000", "山西省"],
  ["150000", "内蒙古自治区"], ["210000", "辽宁省"], ["220000", "吉林省"], ["230000", "黑龙江省"],
  ["310000", "上海市"], ["320000", "江苏省"], ["330000", "浙江省"], ["340000", "安徽省"],
  ["350000", "福建省"], ["360000", "江西省"], ["370000", "山东省"], ["410000", "河南省"],
  ["420000", "湖北省"], ["430000", "湖南省"], ["440000", "广东省"], ["450000", "广西壮族自治区"],
  ["460000", "海南省"], ["500000", "重庆市"], ["510000", "四川省"], ["520000", "贵州省"],
  ["530000", "云南省"], ["540000", "西藏自治区"], ["610000", "陕西省"], ["620000", "甘肃省"],
  ["630000", "青海省"], ["640000", "宁夏回族自治区"], ["650000", "新疆维吾尔自治区"],
];

/**
 * 5 个计划单列市：12366 官方目录把它们与省级地区并列，并要求「直接选择该市税务局，
 * 不要选择所在省」。这里的码是本地路由键（GB/T 2260 区划码），**需实地联调确认**，
 * 网关不声明任何已接入状态。
 */
const SEPARATELY_PLANNED_CITY_ROWS = [
  ["210200", "大连市", "210000"],
  ["330200", "宁波市", "330000"],
  ["350200", "厦门市", "350000"],
  ["370200", "青岛市", "370000"],
  ["440300", "深圳市", "440000"],
];

const PROVINCE_REGIONS = PROVINCE_ROWS.map(([region, label]) => ({
  region, label, kind: "province", parentRegion: null, taxTarget: true,
}));
const CITY_REGIONS = SEPARATELY_PLANNED_CITY_ROWS.map(([region, label, parentRegion]) => ({
  region, label, kind: "separately_planned_city", parentRegion, taxTarget: true,
}));

/** 大陆税务服务地区目录（31 省区市 + 5 计划单列市），CN 不在其中。 */
export const MAINLAND_TAX_REGIONS = [...PROVINCE_REGIONS, ...CITY_REGIONS];

/**
 * 港澳台：属于不同税务管辖体系，**不是**本期同一税务系统的覆盖目标。
 * 仅作为地理标识保留，单独分组并标注 jurisdiction / out_of_scope，
 * 不得与 province 税务目标混在一起。
 */
const OUT_OF_SCOPE_REGIONS = [
  { region: "710000", label: "台湾省", jurisdiction: "TW" },
  { region: "810000", label: "香港特别行政区", jurisdiction: "HK" },
  { region: "820000", label: "澳门特别行政区", jurisdiction: "MO" },
];

const REGION_META = new Map(MAINLAND_TAX_REGIONS.map((r) => [r.region, r]));
const OUT_OF_SCOPE_META = new Map(OUT_OF_SCOPE_REGIONS.map((r) => [r.region, r]));
const REGION_LABELS = new Map([
  [NATIONWIDE_REGION, "全国"],
  ...MAINLAND_TAX_REGIONS.map((r) => [r.region, r.label]),
  ...OUT_OF_SCOPE_REGIONS.map((r) => [r.region, r.label]),
]);
const RESOURCE_IDS = new Set(TAX_RESOURCES.map((r) => r.id));
const LOGIN_METHOD_IDS = new Set(TAX_LOGIN_METHODS.map((m) => m.id));
const ADAPTER_ID_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const SAFE_CODE_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/i;

/** 请求里出现这些字段名，说明调用方想直接传明文凭据：一律拒绝，不落库也不转发。 */
const PLAINTEXT_CREDENTIAL_KEYS = new Set([
  "password", "passwd", "pwd", "pass", "secret", "account", "username", "user", "userid",
  "loginname", "login_name", "token", "cookie", "cookies", "otp", "smscode", "sms_code",
  "verifycode", "verify_code", "verificationcode", "verification_code", "credentials",
  "privatekey", "private_key", "apikey", "api_key", "authorization",
]);

/**
 * infoQuery 的 params **平面白名单**：只允许明确与资源本身有关的查询参数。
 * 会话/地区/账套/企业作用域一律只能来自会话上下文，不能通过 params 覆盖；
 * 且 params 只接受标量，不接受嵌套对象或数组——从设计上就不可能用嵌套结构绕过。
 */
const ALLOWED_QUERY_PARAM_KEYS = new Set([
  "period", "startPeriod", "endPeriod", "taxType", "declarationType", "status", "page", "pageSize",
]);

/** params 里出现这些名字（大小写不敏感的子串）即视为想覆盖作用域，直接拒绝。 */
const RESERVED_SCOPE_PARAM_RE =
  /account_?set|region|enterprise|taxpayer|tax_?no|taxid|session|credential|token|password|secret|user|tenant|company|org/i;

// ---------------------------------------------------------------- 脱敏
/** 命中即视为敏感字段名（用于抹掉 `key=value` 形式的凭据）。 */
const SENSITIVE_KEY_RE =
  /pass(word|wd)?|pwd|secret|token|cookie|session|otp|sms_?code|verif(y|ication)_?code|credential|authori[sz]ation|api_?key|private_?key|signature|access_?key/i;

/**
 * 已知明文（人工验证响应、credentialRef）参与替换的最小长度。
 * 短于此长度的值不参与替换——否则单个字符会把所有正常文本打碎；
 * 取 3 是为了让**短验证码/短引用**也被覆盖，而不是只挡长字符串。
 */
const MIN_SECRET_LEN = 3;

/**
 * 全网关已知明文登记条数上限。会话正常终结（logout / 过期）时会清理该会话登记的明文，
 * 这里只是兜底：保证这份「内存脱敏暂存」不会随调用次数无界增长（超出即淘汰最早的）。
 */
export const MAX_SECRETS = 500;

/**
 * 单个会话登记的明文条数上限（同样淘汰最早的）。正常重试只需要最近提交的那一个响应，
 * 但一个长期存活的会话可能反复提交，这里给每个会话也加上界。
 */
export const MAX_SESSION_SECRETS = 50;

/**
 * 文本脱敏：先抹掉调用方登记过的已知明文（验证码响应、credentialRef 等），
 * 再按模式抹掉 Bearer/JWT/`key=value` 形式的凭据。
 * 适配器抛出的异常文本、challenge 提示、DTO 字符串都必须先过这里，
 * 绝不允许原始凭据或人工验证响应出现在接口响应中。
 * **务必先脱敏再截断**：反过来会让跨边界的那一段秘密原样漏出。
 */
export function redactText(input, secrets = []) {
  let s = String(input ?? "");
  if (!s) return s;
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length >= MIN_SECRET_LEN) s = s.split(secret).join("***");
  }
  s = s.replace(/\bBearer\s+[^\s,;'"]+/gi, "Bearer ***");
  s = s.replace(/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]*/g, "***");
  s = s.replace(
    /(["']?)([A-Za-z_][A-Za-z0-9_.-]{0,40})\1\s*[:=]\s*(["']?)([^\s,;"'}\]]+)\3/g,
    (match, _q1, key) => (SENSITIVE_KEY_RE.test(key) ? `${key}=***` : match)
  );
  return s;
}

const MASKERS = {
  // 身份证：留前 6 后 4
  id: (s) => maskKeep(s, 6, 4),
  // 纳税人识别号/统一社会信用代码：留前 4 后 4
  tax: (s) => maskKeep(s, 4, 4),
  // 姓名：只留首字
  name: (s) => maskKeep(s, 1, 0),
  phone: (s) => maskKeep(s, 3, 4),
};

function maskKeep(raw, head, tail) {
  const s = String(raw ?? "");
  if (!s) return s;
  if (s.length <= head + tail) return "*".repeat(s.length);
  return s.slice(0, head) + "*".repeat(Math.max(2, s.length - head - tail)) + (tail ? s.slice(-tail) : "");
}

/**
 * 输出 DTO 白名单：只保留这里列出的字段，其余（cookies / token / password 等）一律丢弃。
 * 适配器即使返回原始凭据或嵌套对象，也不可能透传到接口响应。
 */
const DTO_SPEC = {
  identity: {
    kind: "object",
    fields: {
      subjectId: "string", name: { mask: "name" }, idType: "string", idNumber: { mask: "id" },
      phone: { mask: "phone" }, roles: "stringArray", region: "string", authenticatedAt: "string",
    },
  },
  enterprise_profile: {
    kind: "object",
    fields: {
      enterpriseId: "string", name: "string", taxpayerId: { mask: "tax" }, taxpayerType: "string",
      industry: "string", registeredAddress: "string", legalRepresentative: { mask: "name" },
      registrationStatus: "string", region: "string",
    },
  },
  authorized_enterprises: {
    kind: "array",
    item: {
      enterpriseId: "string", name: "string", taxpayerId: { mask: "tax" }, role: "string",
      status: "string", region: "string", authorizedAt: "string",
    },
  },
  tax_assessments: {
    kind: "array",
    item: {
      taxType: "string", taxTypeName: "string", periodicity: "string", status: "string",
      effectiveFrom: "string", region: "string",
    },
  },
  declaration_status: {
    kind: "array",
    item: {
      period: "string", taxType: "string", status: "string", submittedAt: "string", region: "string",
    },
  },
};

const REQUIRED_READ_FIELDS = {
  identity: ["subjectId"], authorized_enterprises: ["enterpriseId"],
  enterprise_profile: ["enterpriseId"], tax_assessments: ["taxType"],
  declaration_status: ["period", "taxType", "status"],
};

function pickFields(src, spec, secrets = []) {
  if (!src || typeof src !== "object" || Array.isArray(src)) return null;
  const out = {};
  for (const [key, rule] of Object.entries(spec)) {
    if (!Object.prototype.hasOwnProperty.call(src, key)) continue;
    const value = src[key];
    if (value === undefined || value === null) continue;
    if (rule === "stringArray") {
      if (Array.isArray(value)) {
        out[key] = value
          .filter((x) => typeof x === "string" || typeof x === "number")
          // 先脱敏再截断：截断在前会把跨边界的响应片段原样漏出。
          .map((x) => redactText(String(x), secrets).slice(0, 60));
      }
      continue;
    }
    // 只接受标量：嵌套对象/数组直接丢弃，避免把适配器的内部结构透传出去。
    if (typeof value === "object") continue;
    const mask = typeof rule === "object" ? rule.mask : null;
    if (typeof value === "number" || typeof value === "boolean") {
      // 数字/布尔同样可能是验证响应（如数字型验证码）：命中已知明文就整体抹掉。
      const text = String(value);
      out[key] = redactText(text, secrets) === text ? value : "***";
      continue;
    }
    let safe = String(value);
    if (mask && MASKERS[mask]) safe = MASKERS[mask](safe);
    // 字段名再「安全」（hint/prompt/roles/name…）也不能成为包装秘密的容器：
    // 统一过一遍已知明文脱敏，再截断。
    out[key] = redactText(safe, secrets).slice(0, 200);
  }
  return out;
}

/**
 * 按资源类型套用 DTO 白名单，并对输出文本做已知明文脱敏。返回结构固定，适配器返回 null 时也如实说明。
 * `secrets` 可选：不传时只做白名单裁剪与身份掩码（保持既有导出调用兼容）。
 */
export function sanitizeResource(resource, value, secrets = []) {
  const spec = DTO_SPEC[resource];
  if (!spec) return { item: null, items: [], note: `未定义 DTO 白名单的资源类型：${resource}` };
  if (spec.kind === "array") {
    if (!Array.isArray(value)) return { items: [], note: "适配器未返回数组数据" };
    if (value.length > 500) throw new TaxError("tax_result_limit_exceeded", "资源超过 500 条，必须通过已验证的分页接口采集；未返回截断结果");
    return { items: value.map((x) => pickFields(x, spec.item, secrets)).filter((x) => x !== null) };
  }
  const item = pickFields(value, spec.fields, secrets);
  return item ? { item } : { item: null, note: "适配器未返回该资源数据" };
}

// ---------------------------------------------------------------- 地区工具函数
const str = (v) => (v === undefined || v === null ? "" : String(v).trim());

function normalizeRegion(raw) {
  const s = str(raw).toUpperCase();
  return s || "";
}

/** 地区标识分类。 */
function classifyRegion(raw) {
  const code = normalizeRegion(raw);
  if (!code) return { code, kind: "missing" };
  if (code === NATIONWIDE_REGION) return { code, kind: "nationwide" };
  const meta = REGION_META.get(code);
  if (meta) return { code, kind: meta.kind, meta };
  const scoped = OUT_OF_SCOPE_META.get(code);
  if (scoped) return { code, kind: "out_of_scope", meta: scoped };
  return { code, kind: "unknown" };
}

/** 校验地区标识合法（CN 产品入口、大陆 31+5；港澳台判为域外；其余未知）。 */
function requireRegion(raw, field = "region") {
  const info = classifyRegion(raw);
  if (info.kind === "missing") {
    throw new TaxError("tax_region_required", `必须显式提供 ${field}（"${NATIONWIDE_REGION}" 表示全国入口，或六位行政区划码）`);
  }
  if (info.kind === "unknown") {
    throw new TaxError("tax_region_unknown", `未知地区标识：${info.code}；可用地区见 tax_regions`, { region: info.code });
  }
  if (info.kind === "out_of_scope") {
    throw new TaxError(
      "tax_region_out_of_scope",
      `${info.code}（${info.meta.label}）属于 ${info.meta.jurisdiction} 税务管辖体系，不是本期大陆税务服务目录内的地区，不能作为税务目标`,
      { region: info.code, jurisdiction: info.meta.jurisdiction, outOfScope: true }
    );
  }
  return info.code;
}

/** 税务服务地区：必须是大陆 31+5 之一；CN 只是产品入口，不是税务目标。 */
function requireTaxRegion(raw, field = "region") {
  const code = requireRegion(raw, field);
  if (code === NATIONWIDE_REGION) {
    throw new TaxError(
      "tax_region_not_a_tax_target",
      `"${NATIONWIDE_REGION}"（全国）是产品入口标识，不是税务服务地区；请使用 31 个省级行政区或 5 个计划单列市的六位码`,
      { region: code }
    );
  }
  return code;
}

function adapterKey(region, adapterId) {
  return `${region}::${adapterId}`;
}

/** 请求体里出现明文凭据字段即拒绝：生产只接受 credentialRef 引用。 */
function assertNoPlaintextCredentials(args = {}) {
  const found = [];
  const scan = (obj, path = "") => {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return;
    for (const key of Object.keys(obj)) {
      const lower = key.toLowerCase();
      if (PLAINTEXT_CREDENTIAL_KEYS.has(lower) && lower !== "credentials") found.push(path + key);
      else if (lower === "credentials" || lower === "credential" || lower === "auth") scan(obj[key], `${path}${key}.`);
    }
  };
  scan(args);
  if (found.length) {
    throw new TaxError(
      "tax_plaintext_credential_rejected",
      `不接受明文账号/密码等凭据字段（${found.join("、")}）；生产调用只能传 credentialRef 引用，未接入地区不保存任何明文凭据`,
      { fields: found }
    );
  }
}

/**
 * 适配器给出的错误码：既要形态安全，也不能用来回显已知明文。
 * 命中任何一条就退回通用码 `tax_adapter_error`，绝不把秘密塞进「安全键名」里带出去。
 */
function adapterErrorCode(raw, secrets = []) {
  const s = str(raw);
  if (!s || !SAFE_CODE_RE.test(s)) return "tax_adapter_error";
  if (redactText(s, secrets) !== s) return "tax_adapter_error";
  return s;
}

/** 适配器异常 / {code,message} -> 结构化失败信息（脱敏在截断之前，绝不带堆栈）。 */
function adapterFailure(error, secrets) {
  const raw = error instanceof Error
    ? error.message
    : (error && typeof error === "object" ? error.message : error);
  const message = redactText(str(raw) || "适配器未提供错误信息", secrets).slice(0, 300);
  return { code: adapterErrorCode(error?.code, secrets), message };
}

function iso(value) {
  return value ? new Date(value).toISOString() : null;
}

function asEpoch(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const t = Date.parse(String(value));
  return Number.isFinite(t) ? t : fallback;
}

// ---------------------------------------------------------------- 网关
export class TaxGateway {
  /**
   * @param {object}   options
   * @param {Function} options.accountSetExists  (id) => boolean，校验本地账套是否存在。
   *        不注入时任何带 accountSetId 的登录都会被拒绝——宁可拒绝，也不假装账套存在。
   * @param {number}   options.defaultSessionTtlMs 适配器未给 expiresAt 时的默认有效期。
   * @param {Function} options.now             取当前时间的函数（测试可注入）。
   */
  constructor({ accountSetExists = null, defaultSessionTtlMs = 30 * 60 * 1000, requestTimeoutMs = 5000, now = () => Date.now() } = {}) {
    this.accountSetExists = accountSetExists;
    this.defaultSessionTtlMs = defaultSessionTtlMs;
    this.now = now;
    if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 30000) {
      throw new TaxError("tax_timeout_invalid", "请求时限必须为 1 至 30000 毫秒");
    }
    this.requestTimeoutMs = requestTimeoutMs;
    /** @type {Map<string, object>} 已注册适配器，键为 `${region}::${adapterId}` */
    this.adapters = new Map();
    /** @type {Map<string, object>} 登录会话，进程内内存态，不落库 */
    this.sessions = new Map();
    /** @type {Set<string>} 已知明文（验证码响应 / credentialRef），仅用于脱敏，不作为业务数据。
     *  有上限、且随会话终结清理——见 #rememberSecrets / #forgetSecrets。 */
    this.secrets = new Set();
  }

  // -------------------------------------------------------- 适配器注册表
  /**
   * 注册地区适配器。第一期没有任何调用方注册，默认注册表为空。
   * 只接受代码内显式注册，避免通过配置/接口注入任意模块。
   * 适配器方法可以同步返回，也可以返回 Promise：调用侧一律 await。
   */
  registerAdapter(adapter) {
    if (!adapter || typeof adapter !== "object") {
      throw new TaxError("tax_adapter_invalid", "适配器必须是对象");
    }
    const adapterId = str(adapter.adapterId);
    if (!ADAPTER_ID_RE.test(adapterId)) {
      throw new TaxError("tax_adapter_invalid", `adapterId 需匹配 ${ADAPTER_ID_RE}，收到：${adapterId || "(空)"}`);
    }
    const region = requireTaxRegion(adapter.region, "adapter.region");
    const caps = adapter.capabilities || {};
    const resources = Array.isArray(caps.resources) ? caps.resources.map(str) : [];
    const loginMethods = Array.isArray(caps.loginMethods) ? caps.loginMethods.map(str) : [];
    const challengeActions = Array.isArray(caps.challengeActions) ? caps.challengeActions.map(str) : [];
    for (const r of resources) {
      if (!RESOURCE_IDS.has(r)) throw new TaxError("tax_adapter_invalid", `适配器声明了未定义的资源类型：${r}`);
    }
    for (const m of loginMethods) {
      if (!LOGIN_METHOD_IDS.has(m)) throw new TaxError("tax_adapter_invalid", `适配器声明了未定义的登录方式：${m}`);
    }
    for (const a of challengeActions) {
      if (!SAFE_CODE_RE.test(a)) throw new TaxError("tax_adapter_invalid", `验证动作标识非法：${a}`);
    }
    const normalized = {
      adapterId,
      region,
      label: str(adapter.label) || adapterId,
      version: str(adapter.version) || "0",
      capabilities: {
        resources: [...new Set(resources)],
        loginMethods: [...new Set(loginMethods)],
        challengeActions: [...new Set(challengeActions)],
      },
      startLogin: typeof adapter.startLogin === "function" ? adapter.startLogin.bind(adapter) : null,
      getStatus: typeof adapter.getStatus === "function" ? adapter.getStatus.bind(adapter) : null,
      submitChallenge: typeof adapter.submitChallenge === "function" ? adapter.submitChallenge.bind(adapter) : null,
      logout: typeof adapter.logout === "function" ? adapter.logout.bind(adapter) : null,
      query: typeof adapter.query === "function" ? adapter.query.bind(adapter) : null,
      verifyScope: typeof adapter.verifyScope === "function" ? adapter.verifyScope.bind(adapter) : null,
      queryPage: typeof adapter.queryPage === "function" ? adapter.queryPage.bind(adapter) : null,
      readonlyEvidence: structuredClone(adapter.readonlyEvidence || {}),
    };
    this.adapters.set(adapterKey(region, adapterId), normalized);
    return describeAdapter(normalized);
  }

  /** 已注册适配器数量（默认 0）。 */
  adapterCount() {
    return this.adapters.size;
  }

  listAdapters(region) {
    const want = region ? normalizeRegion(region) : "";
    return [...this.adapters.values()]
      .filter((a) => !want || a.region === want)
      .map(describeAdapter);
  }

  // -------------------------------------------------------- 目录查询
  /** 接口契约 + 区域接入状态。产品目标（全国）与已接入地区清单分开表达。 */
  listRegions() {
    const byRegion = new Map();
    for (const adapter of this.adapters.values()) {
      if (!byRegion.has(adapter.region)) byRegion.set(adapter.region, []);
      byRegion.get(adapter.region).push(adapter.adapterId);
    }
    const regionRow = (meta) => {
      const adapters = byRegion.get(meta.region) || [];
      const row = {
        region: meta.region,
        label: meta.label,
        kind: meta.kind,
        parentRegion: meta.parentRegion ?? null,
        taxTarget: true,
        jurisdiction: "CN-MAINLAND",
        configured: adapters.length > 0,
        status: adapters.length > 0 ? "configured" : "not_configured",
        adapters,
      };
      if (meta.kind === "separately_planned_city") {
        row.note = "计划单列市：官方目录要求直接选择该市税务局、勿选所在省；区划码为本地路由键，需实地联调确认。";
      }
      return row;
    };
    const regions = MAINLAND_TAX_REGIONS.map(regionRow);
    const outOfScope = OUT_OF_SCOPE_REGIONS.map((meta) => ({
      region: meta.region,
      label: meta.label,
      kind: "out_of_scope",
      parentRegion: null,
      taxTarget: false,
      outOfScope: true,
      jurisdiction: meta.jurisdiction,
      configured: false,
      status: "out_of_scope",
      adapters: [],
      note: "属于不同税务管辖体系，不是本期大陆税务服务目录的覆盖目标；此处仅保留地理标识，不表示已覆盖或可接入。",
    }));
    const configuredRegions = regions.filter((r) => r.configured).map((r) => r.region);
    const nationwideAdapters = byRegion.get(NATIONWIDE_REGION) || [];

    return {
      nationwide: {
        region: NATIONWIDE_REGION,
        label: "全国",
        kind: "nationwide",
        productTarget: true,
        taxTarget: false,
        configured: nationwideAdapters.length > 0,
        status: nationwideAdapters.length > 0 ? "configured" : "not_configured",
        adapters: nationwideAdapters,
        note: "全国是产品入口与目标：接口按地区适配设计；它不是税务服务地区，不能作为登录目标，未接入地区一律返回结构化未接入错误。",
      },
      regions,
      outOfScope,
      configuredRegions,
      contract: {
        resources: TAX_RESOURCES.map((r) => ({ ...r })),
        loginMethods: TAX_LOGIN_METHODS.map((m) => ({ ...m })),
        states: [...TAX_STATES],
        note: "challenge 动作类型由适配器自行定义并在 tax_capabilities 中公布；网关不预设、不代替人工验证。",
      },
      sources: REGION_SOURCES.map((s) => ({ ...s })),
      summary: {
        regionsTotal: regions.length,
        regionsConfigured: configuredRegions.length,
        adaptersTotal: this.adapters.size,
        nationwideConfigured: nationwideAdapters.length > 0,
        outOfScopeTotal: outOfScope.length,
      },
      note: "大陆税务服务目录为 31 个省级行政区 + 5 个计划单列市；configured=false 表示当前进程未注册该地区适配器，不代表该地区无法办理业务，也不代表已接入。",
    };
  }

  /** 某地区（或指定适配器）的能力声明。未接入同样成功返回，但明确 configured=false。 */
  listCapabilities({ region, adapterId } = {}) {
    const reg = requireRegion(region);
    const wanted = adapterId ? str(adapterId) : "";
    const adapters = [...this.adapters.values()]
      .filter((a) => a.region === reg && (!wanted || a.adapterId === wanted))
      .map(describeAdapter);
    if (wanted && adapters.length === 0) {
      throw new TaxError("tax_adapter_not_found", `地区 ${reg} 未注册适配器 ${wanted}`, { region: reg, adapterId: wanted });
    }
    const meta = REGION_META.get(reg) || null;
    return {
      region: reg,
      label: REGION_LABELS.get(reg),
      kind: reg === NATIONWIDE_REGION ? "nationwide" : (meta?.kind ?? "unknown"),
      parentRegion: meta?.parentRegion ?? null,
      taxTarget: reg !== NATIONWIDE_REGION,
      configured: adapters.length > 0,
      status: adapters.length > 0 ? "configured" : "not_configured",
      adapters,
      contract: {
        resources: TAX_RESOURCES.map((r) => ({ ...r })),
        loginMethods: TAX_LOGIN_METHODS.map((m) => ({ ...m })),
        states: [...TAX_STATES],
      },
      note: adapters.length
        ? "上列能力来自已注册适配器自报；具体可用性以该适配器实现为准。"
        : "该地区当前没有已注册适配器；contract 只是接口契约，不代表可用能力，更不代表已接入真实电子税务局。",
    };
  }

  // -------------------------------------------------------- 登录会话
  /**
   * 发起登录。未接入地区直接结构化失败，不会创建任何会话，更不会伪造 authenticated。
   * 适配器方法会被 await，因此同步实现与返回 Promise 的异步实现都支持。
   */
  async startLogin(args = {}) {
    assertNoPlaintextCredentials(args);
    const region = requireTaxRegion(args.region);
    const adapter = this.#pickAdapter(region, args.adapterId);
    const loginMethod = str(args.loginMethod || args.login_method);
    if (loginMethod && !adapter.capabilities.loginMethods.includes(loginMethod)) {
      throw new TaxError("tax_login_method_unsupported", `适配器 ${adapter.adapterId} 不支持登录方式：${loginMethod}`, {
        region, adapterId: adapter.adapterId, supported: adapter.capabilities.loginMethods,
      });
    }
    const accountSetId = this.#resolveAccountSetId(args.accountSetId ?? args.account_set_id);
    const enterprise = normalizeEnterprise(args.enterprise);
    const credentialRef = str(args.credentialRef ?? args.credential_ref);

    const sessionId = `taxs_${randomBytes(24).toString("base64url")}`;
    const nowMs = this.now();
    const session = {
      sessionId,
      scopeRef: `scope_${randomBytes(18).toString("hex")}`,
      region,
      adapterId: adapter.adapterId,
      accountSetId,
      enterprise,
      credentialRef: credentialRef || null,
      status: "requires_action",
      challenge: null,
      failure: null,
      createdAt: nowMs,
      updatedAt: nowMs,
      expiresAt: nowMs + this.defaultSessionTtlMs,
      // 本会话登记过的明文（只用于脱敏），会话终结时清理，避免全网关集合无界增长。
      secretKeys: new Set(),
    };
    this.sessions.set(sessionId, session);
    if (credentialRef) this.#rememberSecrets(session, credentialRef);

    if (!adapter.startLogin) {
      session.status = "failed";
      session.failure = { code: "tax_adapter_unsupported", message: `适配器 ${adapter.adapterId} 未实现 startLogin` };
      session.updatedAt = nowMs;
      throw new TaxError("tax_login_unsupported", session.failure.message, this.#failureDetails(session));
    }

    let result;
    try {
      result = await adapter.startLogin(this.#context(session));
    } catch (error) {
      // 异步拒绝同样在这里被捕获：结构化返回，不留 unhandled rejection。
      session.status = "failed";
      session.failure = adapterFailure(error, this.secrets);
      session.challenge = null;
      session.updatedAt = this.now();
      throw new TaxError("tax_login_failed", `适配器 ${adapter.adapterId} 发起登录失败：${session.failure.message}`, this.#failureDetails(session));
    }
    // 迟到结果保护：适配器若比会话 TTL 还慢，await 期间会话已经到期——
    // 先核验终态（含过期刷新），迟到的 authenticated 一律不采纳。
    if (this.#guardTerminal(session)) throw this.#terminalError(session);
    this.#applyAdapterState(session, result, { from: "startLogin" });
    // 适配器自己给出的 expiresAt 若已经过期，同样不能返回 authenticated。
    if (session.status === "expired") {
      throw new TaxError("tax_session_expired", "登录结果已过期，不予采纳，请重新发起登录", this.#failureDetails(session));
    }
    return this.#view(session);
  }

  /**
   * 查询会话状态。适配器实现了 getStatus 时会先向适配器刷新一次。
   * 约定：getStatus 允许返回 null / undefined / {} 表示「无变更」；其余情况必须给出合法 status。
   * 等待期间会话若已进入终态（退出/过期/失败），迟到结果一律不得复活它。
   */
  async getStatus(args = {}) {
    const session = this.#requireSession(args.sessionId ?? args.session_id);
    this.#refreshExpiry(session);
    if (this.#isTerminal(session.status)) return this.#view(session);

    const adapter = this.adapters.get(adapterKey(session.region, session.adapterId));
    if (adapter?.getStatus) {
      let result;
      try {
        result = await adapter.getStatus(this.#context(session));
      } catch (error) {
        if (this.#guardTerminal(session)) return this.#view(session);
        session.status = "failed";
        session.challenge = null;
        session.failure = adapterFailure(error, this.secrets);
        session.updatedAt = this.now();
        return this.#view(session);
      }
      // 迟到的查询结果不能把已退出/已过期的会话拉回来。
      if (this.#guardTerminal(session)) return this.#view(session);
      try {
        this.#applyAdapterState(session, result, { from: "getStatus" });
      } catch {
        // #applyAdapterState 已把会话置为 failed 并写明原因；状态查询本身不抛错。
      }
    }
    this.#refreshExpiry(session);
    return this.#view(session);
  }

  /**
   * 提交人工验证响应（验证码/扫码确认/实名确认等）。
   * response 只交给适配器判定，不落库、不回显；网关另把它登记为「已知明文」留在内存里，
   * 用于抹掉适配器后续任何输出中的同一个值（会话终结时清理）。
   * 网关没有任何跳过人工验证的分支。
   */
  async submitChallenge(args = {}) {
    const session = this.#requireSession(args.sessionId ?? args.session_id);
    this.#refreshExpiry(session);
    if (session.status === "logged_out") throw new TaxError("tax_session_logged_out", "会话已退出，不能提交验证响应", this.#failureDetails(session));
    if (session.status === "expired") throw new TaxError("tax_session_expired", "会话已过期，请重新发起登录", this.#failureDetails(session));
    if (session.status === "failed") throw new TaxError("tax_session_failed", "会话已失败，请重新发起登录", this.#failureDetails(session));
    if (session.status === "authenticated") throw new TaxError("tax_session_already_authenticated", "会话已认证，无需再次提交验证响应", this.#failureDetails(session));
    if (session.status !== "requires_action" || !session.challenge) {
      throw new TaxError("tax_challenge_not_expected", "当前会话没有待处理的验证动作", this.#failureDetails(session));
    }

    const action = str(args.action);
    if (!action) throw new TaxError("tax_challenge_action_required", "必须提供 action（由 tax_login_status 返回的 challenge.action）", this.#failureDetails(session));
    if (action !== session.challenge.action) {
      throw new TaxError("tax_challenge_action_mismatch", `验证动作不匹配：当前待处理 ${session.challenge.action}，收到 ${this.#safeText(action, 60)}`, {
        ...this.#failureDetails(session), expected: session.challenge.action,
      });
    }
    if (args.response === undefined || args.response === null || args.response === "") {
      throw new TaxError("tax_challenge_response_required", "必须提供 response（人工验证结果）", this.#failureDetails(session));
    }
    // 登记明文响应用于脱敏；只进内存，随会话终结清理，绝不写盘、绝不回显。
    this.#rememberSecrets(session, args.response);

    const adapter = this.adapters.get(adapterKey(session.region, session.adapterId));
    if (!adapter?.submitChallenge) {
      throw new TaxError("tax_challenge_unsupported", `适配器 ${session.adapterId} 未实现 submitChallenge`, this.#failureDetails(session));
    }
    let result;
    try {
      result = await adapter.submitChallenge(this.#context(session), { action, response: args.response });
    } catch (error) {
      if (this.#guardTerminal(session)) throw this.#terminalError(session);
      session.status = "failed";
      session.challenge = null;
      session.failure = adapterFailure(error, this.secrets);
      session.updatedAt = this.now();
      throw new TaxError("tax_challenge_failed", `验证失败：${session.failure.message}`, this.#failureDetails(session));
    }
    // 等待期间被 logout / 过期：会话终态优先，验证结果不得把会话复活。
    if (this.#guardTerminal(session)) throw this.#terminalError(session);
    this.#applyAdapterState(session, result, { from: "submitChallenge" });
    // 适配器可能带一个「已经过期」的 expiresAt 回来：认证结果不成立，即时过期。
    if (session.status === "expired") {
      throw new TaxError("tax_session_expired", "验证成功但会话已过期，结果不予采纳，请重新发起登录", this.#failureDetails(session));
    }
    return this.#view(session);
  }

  /**
   * 退出会话。退出后该会话不能再查询任何资源。
   * **先本地终结、再通知适配器**：logout 一返回，会话就不可用，
   * 适配器调用（可能异步且慢/失败）不会推迟这一效果，也不会改变终态。
   */
  async logout(args = {}) {
    const session = this.#requireSession(args.sessionId ?? args.session_id);
    if (session.status === "logged_out") return { ...this.#view(session), loggedOut: true, idempotent: true };

    this.#refreshExpiry(session);
    const adapter = this.adapters.get(adapterKey(session.region, session.adapterId));
    const shouldNotify = !!adapter?.logout && session.status !== "failed" && session.status !== "expired";
    const ctx = this.#context(session);

    // 立即终结本地会话：此后任何 getStatus / challenge / query 都不得复活它。
    session.status = "logged_out";
    session.challenge = null;
    session.failure = null;
    session.credentialRef = null;
    session.updatedAt = this.now();

    let warning = null;
    if (shouldNotify) {
      try {
        await adapter.logout(ctx);
      } catch (error) {
        // 退出失败也要在本地终止会话：宁可让适配器多留一份远端态，也不留下可用会话。
        warning = adapterFailure(error, this.secrets);
      }
    }
    // 会话已终结：清掉它登记的明文（迟到输出仍由终态保护拦在前面），避免暂存无界累积。
    this.#forgetSecrets(session);
    return { ...this.#view(session), loggedOut: true, warning };
  }

  /**
   * 按会话查询信息资源。严格绑定 region + accountSetId：
   * 传入与会话不一致的地区或账套一律拒绝，避免跨账套/跨地区读取。
   * `params` 只接受与资源本身有关的标量参数（平面白名单）；企业/账套/地区标识只能来自会话上下文。
   * 查询等待期间会话若退出/过期，结果一律丢弃并返回结构化错误。
   */
  async infoQuery(args = {}) {
    const session = this.#requireSession(args.sessionId ?? args.session_id);
    this.#refreshExpiry(session);
    if (session.status === "logged_out") throw new TaxError("tax_session_logged_out", "会话已退出，不能查询信息", this.#failureDetails(session));
    if (session.status === "expired") throw new TaxError("tax_session_expired", "会话已过期，请重新发起登录", this.#failureDetails(session));
    if (session.status === "failed") throw new TaxError("tax_session_failed", "会话已失败，请重新发起登录", this.#failureDetails(session));
    if (session.status !== "authenticated") {
      throw new TaxError("tax_session_not_authenticated", "会话尚未完成人工验证，不能查询信息", this.#failureDetails(session));
    }

    if (args.region !== undefined && args.region !== null && str(args.region) !== "") {
      const asked = requireRegion(args.region);
      if (asked !== session.region) {
        throw new TaxError("tax_region_mismatch", `会话绑定地区 ${session.region}，拒绝按 ${asked} 查询`, {
          ...this.#failureDetails(session), requestedRegion: asked,
        });
      }
    }
    const askedSetId = args.accountSetId ?? args.account_set_id;
    if (askedSetId !== undefined && askedSetId !== null && str(askedSetId) !== "") {
      const id = Number(askedSetId);
      if (!Number.isInteger(id) || id <= 0) throw new TaxError("accountSetId_invalid", `accountSetId 必须是正整数，收到：${askedSetId}`);
      if (session.accountSetId === null || id !== session.accountSetId) {
        throw new TaxError("tax_account_set_mismatch", `会话绑定账套 ${session.accountSetId ?? "(未绑定)"}，拒绝按账套 ${id} 查询`, {
          ...this.#failureDetails(session), requestedAccountSetId: id,
        });
      }
    }
    // 企业标识只能来自会话上下文：params 里出现 enterpriseId/taxpayerId 等一律拒绝。
    const params = sanitizeQueryParams(args.params);

    const resource = str(args.resource);
    if (!resource) throw new TaxError("tax_resource_required", "必须提供 resource；可用资源见 tax_regions.contract.resources");
    if (!RESOURCE_IDS.has(resource)) {
      throw new TaxError("tax_resource_unknown", `未定义的信息资源：${resource}`, { resource });
    }
    const adapter = this.adapters.get(adapterKey(session.region, session.adapterId));
    if (adapter?.queryPage) throw new TaxError("tax_summary_tool_required", "只读采集适配器仅通过安全摘要工具返回结果");
    if (!adapter || !adapter.capabilities.resources.includes(resource)) {
      throw new TaxError("tax_resource_unsupported", `地区 ${session.region} 的适配器 ${session.adapterId} 未声明支持资源：${resource}`, {
        ...this.#failureDetails(session), resource, supported: adapter?.capabilities.resources ?? [],
      });
    }
    if (!adapter.query) {
      throw new TaxError("tax_query_unsupported", `适配器 ${session.adapterId} 未实现 query`, { ...this.#failureDetails(session), resource });
    }

    let raw;
    const scope = this.#scopeStamp(session);
    try {
      raw = await adapter.query(this.#context(session), { resource, params });
    } catch (error) {
      if (this.#guardTerminal(session)) throw this.#terminalError(session);
      const failure = adapterFailure(error, this.secrets);
      throw new TaxError("tax_query_failed", `查询 ${resource} 失败：${failure.message}`, {
        ...this.#failureDetails(session), resource, adapterCode: failure.code,
      });
    }
    // 迟到结果保护：查询期间会话退出/过期，绝不输出任何数据。
    if (this.#guardTerminal(session)) throw this.#terminalError(session);

    this.#assertScope(session, scope);

    const sanitized = sanitizeResource(resource, raw, this.secrets);
    return {
      sessionId: session.sessionId,
      region: session.region,
      accountSetId: session.accountSetId,
      adapterId: session.adapterId,
      resource,
      fetchedAt: iso(this.now()),
      data: sanitized,
      coverage: { complete: false, status: "unverified", evidenceLevel: "unverified" },
      note: "字段按网关 DTO 白名单输出；适配器原始 cookies/token 等一律不透传。",
    };
  }

  // A verified read requires business success, authority and exact enterprise scope.
  // This contract is code registered only. No browser/network implementation is enabled by default.
  async verifyScope({ sessionId } = {}) {
    const session = this.#authenticatedSession(sessionId);
    const stamp = this.#scopeStamp(session);
    const adapter = this.adapters.get(adapterKey(session.region, session.adapterId));
    if (session.verifiedStamp && session.verifiedStamp !== stamp) {
      throw new TaxError("tax_scope_changed", "已验证会话的企业范围变化，须创建新会话");
    }
    if (!session.enterprise?.enterpriseId || !adapter?.verifyScope) {
      throw new TaxError("tax_scope_unsupported", "尚无经过验证的企业作用域读取能力");
    }
    let result;
    try { result = await this.#read((signal) => adapter.verifyScope(this.#context(session), { signal })); }
    catch (error) {
      if (error instanceof TaxError && error.code === "tax_request_timeout") throw error;
      throw new TaxError("tax_scope_verification_failed", "企业作用域验证失败；原始错误未回显");
    }
    this.#assertScope(session, stamp);
    this.#businessResult(session, result);
    if (result.authorized !== true || result.enterpriseId !== session.enterprise.enterpriseId) {
      throw new TaxError("tax_scope_mismatch", "当前企业或授权范围未验证");
    }
    if (typeof result.scopeRevision !== "string" || !result.scopeRevision || result.scopeRevision.length > 256) {
      throw new TaxError("tax_response_invalid", "适配器未提供会话与授权代际");
    }
    const revision = createHash("sha256").update(result.scopeRevision).digest("hex");
    if (session.verifiedRevision && session.verifiedRevision !== revision) {
      session.status = "expired";
      this.#forgetSecrets(session);
      throw new TaxError("tax_scope_changed", "会话身份或授权代际变化，旧引用失效");
    }
    session.verifiedRevision = revision;
    session.verifiedStamp = stamp;
    const supportedResources = adapter.queryPage ? adapter.capabilities.resources.filter((resource) => {
      const evidence = adapter.readonlyEvidence[resource];
      return evidence?.sideEffectFree === true && ["synthetic", "observed", "repeated"].includes(evidence.evidenceLevel)
        && /^[a-zA-Z0-9._-]{1,64}$/.test(evidence.contractVersion || "");
    }) : [];
    return { sessionId, scopeRef: session.scopeRef, region: session.region, status: "verified",
      boundAccountSetId: session.accountSetId, supportedResources };
  }

  async collectResource({ sessionId, resource, period } = {}) {
    if (typeof period !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) {
      throw new TaxError("tax_period_invalid", "必须提供合法 YYYY-MM 期间");
    }
    const session = this.#authenticatedSession(sessionId);
    const stamp = this.#scopeStamp(session);
    const adapter = this.adapters.get(adapterKey(session.region, session.adapterId));
    const evidence = adapter?.readonlyEvidence?.[resource];
    if (!RESOURCE_IDS.has(resource) || !adapter?.capabilities.resources.includes(resource)
        || !adapter.queryPage || evidence?.sideEffectFree !== true
        || !["synthetic", "observed", "repeated"].includes(evidence.evidenceLevel)
        || !/^[a-zA-Z0-9._-]{1,64}$/.test(evidence.contractVersion || "")) {
      throw new TaxError("tax_resource_unsupported", "该资源没有已验证的只读采集契约");
    }
    const scope = await this.verifyScope({ sessionId });
    this.#assertScope(session, stamp);
    const sourceRef = `read_${randomBytes(18).toString("hex")}`;
    let count = 0, total = null, pages = 0;
    const seen = new Set();
    const pageSize = 500;
    for (let page = 1; page <= 20; page++) {
      let result;
      for (let attempt = 0; attempt < 2; attempt++) {
        this.#assertScope(session, stamp);
        try { result = await this.#read((signal) => adapter.queryPage(this.#context(session), { resource, period, page, pageSize, signal })); }
        catch (error) {
          if (error instanceof TaxError && error.code === "tax_request_timeout") throw error;
          throw new TaxError("tax_query_failed", "采集请求失败；原始错误未回显");
        }
        this.#assertScope(session, stamp);
        if (!(result?.businessOk === false && result.errorCode === "transient" && attempt === 0)) break;
      }
      this.#businessResult(session, result);
      if (result.enterpriseId !== session.enterprise.enterpriseId || result.period !== period
          || typeof result.scopeRevision !== "string"
          || createHash("sha256").update(result.scopeRevision).digest("hex") !== session.verifiedRevision) {
        throw new TaxError("tax_scope_mismatch", "采集结果企业或期间不一致");
      }
      const pagination = result.pagination;
      if (!pagination || pagination.page !== page || pagination.pageSize !== pageSize
          || !Number.isSafeInteger(pagination.total) || pagination.total < 0
          || typeof pagination.hasMore !== "boolean" || (total !== null && total !== pagination.total)) {
        throw new TaxError("tax_pagination_invalid", "分页元信息缺失或不一致");
      }
      const spec = DTO_SPEC[resource];
      const data = result.data;
      if ((spec.kind === "array" && (!Array.isArray(data) || data.length > pageSize))
          || (spec.kind === "object" && (!data || typeof data !== "object" || Array.isArray(data)))) {
        throw new TaxError("tax_response_invalid", "资源结构不匹配");
      }
      const rows = spec.kind === "array" ? data : [data];
      for (const row of rows) {
        const fields = spec.item || spec.fields;
        if (!row || typeof row !== "object" || Array.isArray(row)
            || REQUIRED_READ_FIELDS[resource].some((key) => typeof row[key] !== "string" || !row[key].trim())
            || Object.entries(fields).some(([key, kind]) => Object.hasOwn(row, key) && row[key] !== null
              && (kind === "stringArray" ? !Array.isArray(row[key]) || row[key].some((value) => typeof value !== "string")
                : typeof row[key] !== "string"))) {
          throw new TaxError("tax_response_invalid", "记录缺少资源字段");
        }
        if ((resource === "enterprise_profile" && row.enterpriseId !== session.enterprise.enterpriseId)
            || (resource === "declaration_status" && row.period !== period)) {
          throw new TaxError("tax_scope_mismatch", "记录企业或期间不一致");
        }
        // Only a digest is retained during this call; records never enter the tool result.
        const canonical = Object.keys(fields).sort().map((key) => [key, row[key] ?? null]);
        const key = createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
        if (seen.has(key)) throw new TaxError("tax_pagination_duplicate", "分页记录重复，覆盖完整性未证实");
        seen.add(key);
      }
      count += rows.length;
      pages++;
      total = pagination.total;
      if (count > total || (pagination.hasMore && (rows.length === 0 || count >= total))
          || (!pagination.hasMore && count !== total) || (spec.kind === "object" && pagination.hasMore)) {
        throw new TaxError("tax_pagination_incomplete", "记录数量与分页声明不一致");
      }
      if (!pagination.hasMore) {
        this.#assertScope(session, stamp);
        return { scopeRef: scope.scopeRef, companyRef: scope.scopeRef, resource, period, status: count ? "success" : "no_records",
          complete: true, count, pages, evidenceLevel: evidence.evidenceLevel,
          contractVersion: evidence.contractVersion, sourceRef, fetchedAt: iso(this.now()),
          metadataOnly: true, evidencePersisted: false };
      }
    }
    throw new TaxError("tax_pagination_limit", "超过受控分页上限，未宣称完整采集");
  }

  #authenticatedSession(id) {
    const session = this.#requireSession(id);
    if (this.#guardTerminal(session)) throw this.#terminalError(session);
    if (session.status !== "authenticated") throw new TaxError("tax_session_not_authenticated", "会话尚未认证");
    return session;
  }

  async #read(operation) {
    const controller = new AbortController();
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(() => operation(controller.signal)),
        new Promise((_, reject) => { timer = setTimeout(() => {
          controller.abort();
          reject(new TaxError("tax_request_timeout", "只读请求超时，未采纳迟到结果"));
        }, this.requestTimeoutMs); }),
      ]);
    } finally { clearTimeout(timer); }
  }

  #scopeStamp(session) {
    return JSON.stringify([session.region, session.adapterId, session.accountSetId, session.enterprise, session.scopeRef]);
  }

  #assertScope(session, stamp) {
    this.#authenticatedSession(session.sessionId);
    if (this.sessions.get(session.sessionId) !== session || this.#scopeStamp(session) !== stamp) {
      throw new TaxError("tax_scope_changed", "会话作用域已变化，丢弃迟到结果");
    }
  }

  #businessResult(session, result) {
    if (result?.businessOk === false && result.errorCode === "session_expired") {
      session.status = "expired";
      this.#forgetSecrets(session);
      throw new TaxError("tax_session_expired", "税局会话已过期，请在本机重新登录");
    }
    if (result?.businessOk !== true || result.errorCode || result.error || result.errors) {
      throw new TaxError(result?.errorCode === "permission_denied" ? "tax_permission_denied" : "tax_business_error",
        "业务成功条件未满足；未采用响应数据");
    }
    if (!Number.isInteger(result.httpStatus) || result.httpStatus < 200 || result.httpStatus >= 300
        || result.schemaValidated !== true || result.businessCodeValidated !== true) {
      throw new TaxError("tax_response_invalid", "传输、业务码或结构验证合同未满足");
    }
  }

  // -------------------------------------------------------- 内部
  #pickAdapter(region, adapterIdRaw) {
    const wanted = str(adapterIdRaw);
    const candidates = [...this.adapters.values()].filter((a) => a.region === region);
    if (candidates.length === 0) {
      throw new TaxError("tax_region_not_configured", `地区 ${region}（${REGION_LABELS.get(region) || region}）当前没有已接入适配器：不发起真实登录、不创建会话`, { region });
    }
    if (wanted) {
      const hit = candidates.find((a) => a.adapterId === wanted);
      if (!hit) throw new TaxError("tax_adapter_not_found", `地区 ${region} 未注册适配器 ${wanted}`, { region, adapterId: wanted });
      return hit;
    }
    if (candidates.length > 1) {
      throw new TaxError("tax_adapter_required", `地区 ${region} 有多个适配器，必须显式指定 adapterId`, {
        region, adapters: candidates.map((a) => a.adapterId),
      });
    }
    return candidates[0];
  }

  /**
   * 该值（或其字符串形式）是否命中已知明文。
   * 用于 expiresAt 这类**非文本**字段：它们不能整段脱敏（会破坏时间语义），
   * 但适配器同样不能用它们来包装验证响应——命中即视为无效值丢弃。
   */
  #isKnownSecret(value) {
    if (value === undefined || value === null) return false;
    const s = str(value);
    return !!s && redactText(s, this.secrets) !== s;
  }

  /**
   * 适配器可输出文本的统一出口：先脱敏（已知明文 + 凭据模式），再截断。
   * 顺序不能反：先截断会把跨边界的验证响应片段原样漏出。
   */
  #safeText(value, max) {
    const s = str(value);
    if (!s) return "";
    return redactText(s, this.secrets).slice(0, max);
  }

  /**
   * 登记已知明文用于脱敏，并记在会话名下（会话终结时按名清理）。
   * 只进内存、绝不写盘；全局与每会话两层都有条数上限兜底，不会无界增长。
   */
  #rememberSecrets(session, value) {
    for (const key of collectSecrets(value)) {
      this.secrets.add(key);
      if (session?.secretKeys) session.secretKeys.add(key);
    }
    capSet(this.secrets, MAX_SECRETS);
    if (session?.secretKeys) capSet(session.secretKeys, MAX_SESSION_SECRETS);
  }

  /**
   * 清理某会话登记的明文。只有当没有任何**其它**会话仍在用同一个值时才会真正删掉，
   * 避免误伤并发会话的脱敏。调用点都在会话进入终态之后——迟到输出已被终态保护拦下。
   */
  #forgetSecrets(session) {
    if (!session?.secretKeys?.size) return;
    for (const key of session.secretKeys) {
      let usedElsewhere = false;
      for (const other of this.sessions.values()) {
        if (other !== session && other.secretKeys?.has(key)) { usedElsewhere = true; break; }
      }
      if (!usedElsewhere) this.secrets.delete(key);
    }
    session.secretKeys.clear();
  }

  #resolveAccountSetId(raw) {
    if (raw === undefined || raw === null || str(raw) === "") return null;
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0) throw new TaxError("accountSetId_invalid", `accountSetId 必须是正整数，收到：${raw}`);
    if (typeof this.accountSetExists !== "function") {
      throw new TaxError("tax_account_set_verification_unavailable", "当前网关未接入账套校验，不能绑定账套", { accountSetId: id });
    }
    let exists = false;
    try {
      exists = !!this.accountSetExists(id);
    } catch {
      exists = false;
    }
    if (!exists) throw new TaxError("account_set_not_found", `本地账套不存在：${id}`, { accountSetId: id });
    return id;
  }

  #requireSession(raw) {
    const sessionId = str(raw);
    if (!sessionId) throw new TaxError("tax_session_id_required", "必须提供 sessionId（由 tax_login_start 返回）");
    const session = this.sessions.get(sessionId);
    if (!session) throw new TaxError("tax_session_not_found", `未知或已清理的会话：${sessionId}`, { sessionId: sessionId.slice(0, 12) });
    return session;
  }

  #context(session) {
    return {
      sessionId: session.sessionId,
      region: session.region,
      adapterId: session.adapterId,
      accountSetId: session.accountSetId,
      enterprise: session.enterprise ? Object.freeze({ ...session.enterprise }) : null,
      credentialRef: session.credentialRef,
      status: session.status,
    };
  }

  #failureDetails(session) {
    return { sessionId: session.sessionId, region: session.region, adapterId: session.adapterId, status: session.status };
  }

  #isTerminal(status) {
    return status === "logged_out" || status === "failed" || status === "expired";
  }

  #refreshExpiry(session) {
    if (this.#isTerminal(session.status)) return;
    if (session.expiresAt && this.now() >= session.expiresAt) {
      session.status = "expired";
      session.challenge = null;
      session.updatedAt = this.now();
      // 死掉的会话不再需要保留它登记的明文；迟到输出由终态保护拦下，不会漏。
      this.#forgetSecrets(session);
    }
  }

  /** await 之后调用：刷新过期并判断会话是否已进入终态（终态不可被迟到结果复活）。 */
  #guardTerminal(session) {
    this.#refreshExpiry(session);
    return this.#isTerminal(session.status);
  }

  /** 会话已处于终态时，给出与之匹配的结构化错误。 */
  #terminalError(session) {
    if (session.status === "logged_out") return new TaxError("tax_session_logged_out", "会话已退出，本次操作未生效", this.#failureDetails(session));
    if (session.status === "expired") return new TaxError("tax_session_expired", "会话已过期，请重新发起登录", this.#failureDetails(session));
    return new TaxError("tax_session_failed", "会话已失败，请重新发起登录", this.#failureDetails(session));
  }

  /** 把会话置为 failed 并抛出协议错误（适配器返回了网关无法采纳的结果）。 */
  #protocolError(session, message) {
    session.status = "failed";
    session.challenge = null;
    // 协议错误信息里可能嵌着适配器给的值（如非法 status）：先脱敏再截断。
    session.failure = { code: "tax_adapter_protocol_error", message: this.#safeText(message, 300) };
    session.updatedAt = this.now();
    throw new TaxError("tax_adapter_protocol_error", session.failure.message, this.#failureDetails(session));
  }

  /**
   * 采纳适配器返回的状态。协议约束（违反即 `tax_adapter_protocol_error`，会话置 failed）：
   *   - startLogin / submitChallenge：必须返回对象且显式给出合法 status；
   *     status=requires_action 时必须带合法 challenge（本轮返回的，或本会话已存在的）。
   *   - getStatus：唯一允许「无变更」的调用——返回 null / undefined / {}，或只带 expiresAt 等局部字段，
   *     均表示状态不变；一旦给出 status，则同样必须合法，requires_action 也必须能对上 challenge。
   *   - 任何调用都不允许返回非法 status，或返回 requires_action 却没有任何 challenge（否则就是无限等待）。
   * 关键约束：适配器返回什么状态就是什么状态；网关不会因为「没报错」就默认置为 authenticated，
   * 也不会在 expiresAt 已经过去时仍然停留在 authenticated。
   * 适配器可输出的文本（challenge.prompt/hint/action、非法 status 等）一律先脱敏再截断。
   */
  #applyAdapterState(session, result, { from }) {
    this.#adoptAdapterState(session, result, { from });
    // 采纳适配器给出的 expiresAt 之后再复核一次：若此刻已经到期，会话即时过期，
    // 绝不允许出现「authenticated 但 expiresAt 已过去」的僵尸认证态。
    this.#refreshExpiry(session);
  }

  #adoptAdapterState(session, result, { from }) {
    const nowMs = this.now();
    session.updatedAt = nowMs;
    const noChangeAllowed = from === "getStatus";

    if (result === null || result === undefined) {
      if (noChangeAllowed) return; // 约定：getStatus 返回 null/undefined = 无变更
      this.#protocolError(session, `适配器 ${session.adapterId} 的 ${from} 未返回结构化结果`);
    }
    if (typeof result !== "object" || Array.isArray(result)) {
      this.#protocolError(session, `适配器 ${session.adapterId} 的 ${from} 返回值不是对象`);
    }
    if (Object.keys(result).length === 0) {
      if (noChangeAllowed) return; // 约定：getStatus 返回 {} = 无变更
      this.#protocolError(session, `适配器 ${session.adapterId} 的 ${from} 返回空对象：必须显式给出 status`);
    }

    // expiresAt 只当时间戳用，不能整段脱敏；但适配器若拿已知明文来填，视为无效并保留原值。
    if (result.expiresAt !== undefined && !this.#isKnownSecret(result.expiresAt)) {
      session.expiresAt = asEpoch(result.expiresAt, session.expiresAt);
    }

    let status = result.status;
    if (status === undefined) {
      if (result.challenge) status = "requires_action";
      else if (noChangeAllowed) return; // 只刷新了局部字段（如 expiresAt），状态保持不变
      else this.#protocolError(session, `适配器 ${session.adapterId} 的 ${from} 未给出 status`);
    }
    if (typeof status !== "string" || !TAX_STATES.includes(status)) {
      // 非法 status 也是适配器可输出值：交给 #safeText 先脱敏再截断（不要在这里先 slice）。
      this.#protocolError(session, `适配器返回了非法状态：${this.#safeText(status, 40) || "(空)"}`);
    }

    let challenge = null;
    if (result.challenge !== undefined && result.challenge !== null) {
      const action = str(result.challenge?.action);
      if (!action) this.#protocolError(session, "适配器返回的 challenge 缺少 action");
      // 只保留可回显的元信息；适配器塞进 challenge 的其它字段（如内部票据）一律丢弃。
      // action / prompt / hint 都是适配器可输出字段，同样先脱敏再截断——
      // 不能因为键名「安全」就让适配器把验证响应包在 hint 里回显。
      challenge = {
        action: this.#safeText(action, 60),
        prompt: this.#safeText(result.challenge.prompt, 300) || null,
        hint: this.#safeText(result.challenge.hint, 300) || null,
        manual: true,
        expiresAt: this.#isKnownSecret(result.challenge.expiresAt) ? null : iso(asEpoch(result.challenge.expiresAt, null)),
      };
    }
    if (status === "requires_action" && !challenge && !session.challenge) {
      this.#protocolError(session, `适配器把会话置为 requires_action 但没有给出任何 challenge：不允许让调用方无限等待`);
    }

    session.status = status;
    if (challenge) session.challenge = challenge;

    if (session.status === "authenticated") {
      session.challenge = null;
      session.failure = null;
    } else if (this.#isTerminal(session.status)) {
      session.challenge = null;
      if (session.status === "failed") {
        session.failure = result.failure
          ? adapterFailure(result.failure, this.secrets)
          : (session.failure || { code: "tax_adapter_error", message: `适配器 ${session.adapterId} 报告登录失败` });
      }
    } else if (result.failure && session.status !== "requires_action") {
      session.failure = adapterFailure(result.failure, this.secrets);
    }
  }

  /** 对外会话视图：绝不包含 credentialRef 明文值、适配器原始票据或验证响应。 */
  #view(session) {
    const adapter = this.adapters.get(adapterKey(session.region, session.adapterId));
    return {
      sessionId: session.sessionId,
      region: session.region,
      regionLabel: REGION_LABELS.get(session.region) || session.region,
      adapterId: session.adapterId,
      accountSetId: session.accountSetId,
      enterprise: session.enterprise,
      status: session.status,
      authenticated: session.status === "authenticated",
      requiresAction: session.status === "requires_action",
      challenge: session.challenge ? { ...session.challenge } : null,
      failure: session.failure ? { ...session.failure } : null,
      hasCredentialRef: !!session.credentialRef,
      createdAt: iso(session.createdAt),
      updatedAt: iso(session.updatedAt),
      expiresAt: iso(session.expiresAt),
      capabilities: adapter ? describeAdapter(adapter) : null,
      note: "会话仅存在于进程内存，进程重启即失效；challenge 的人工响应不落库、不回显，但在会话存活期间会以「已知明文」形式留在内存里用于脱敏（会话终结时清理）。",
    };
  }
}

// ---------------------------------------------------------------- 辅助
/**
 * infoQuery 的 params 平面白名单校验：
 *   - 只接受扁平对象，且键必须在 ALLOWED_QUERY_PARAM_KEYS 内；
 *   - 值只接受标量（string / finite number / boolean），嵌套对象或数组一律拒绝；
 *   - 命中作用域保留名（企业、账套、地区、会话、凭据……）直接拒绝。
 * 这样被绑定的企业/账套/地区标识只可能来自会话上下文，从设计上不会串企业。
 */
function sanitizeQueryParams(raw) {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new TaxError("tax_query_params_invalid", "params 必须是扁平对象，只允许与资源本身有关的标量查询参数");
  }
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    const k = str(key);
    if (RESERVED_SCOPE_PARAM_RE.test(k)) {
      throw new TaxError(
        "tax_query_param_reserved",
        `params.${k} 属于企业/账套/地区/会话作用域字段，只能由会话上下文提供，禁止通过 params 覆盖`,
        { param: k }
      );
    }
    if (!ALLOWED_QUERY_PARAM_KEYS.has(k)) {
      throw new TaxError(
        "tax_query_param_unknown",
        `不支持的查询参数：${k}；只允许 ${[...ALLOWED_QUERY_PARAM_KEYS].join(" / ")}`,
        { param: k, allowed: [...ALLOWED_QUERY_PARAM_KEYS] }
      );
    }
    if (value === undefined || value === null) continue;
    const t = typeof value;
    if (t === "string") {
      if (value.length > 64) throw new TaxError("tax_query_param_invalid", `params.${k} 过长（上限 64 字符）`, { param: k });
      out[k] = value;
    } else if (t === "number") {
      if (!Number.isFinite(value)) throw new TaxError("tax_query_param_invalid", `params.${k} 必须是有限数字`, { param: k });
      out[k] = value;
    } else if (t === "boolean") {
      out[k] = value;
    } else {
      throw new TaxError("tax_query_param_invalid", `params.${k} 必须是标量（字符串/数字/布尔），不接受嵌套对象或数组`, { param: k });
    }
  }
  return out;
}

function normalizeEnterprise(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const enterpriseId = str(raw.enterpriseId ?? raw.enterprise_id).slice(0, 64);
  const name = str(raw.name).slice(0, 120);
  if (!enterpriseId && !name) return null;
  // 只留标识性字段：纳税人识别号等敏感字段既不接收也不保存。
  return { enterpriseId: enterpriseId || null, name: name || null };
}

function describeAdapter(adapter) {
  return {
    adapterId: adapter.adapterId,
    label: adapter.label,
    version: adapter.version,
    region: adapter.region,
    regionLabel: REGION_LABELS.get(adapter.region) || adapter.region,
    resources: [...adapter.capabilities.resources],
    loginMethods: [...adapter.capabilities.loginMethods],
    challengeActions: [...adapter.capabilities.challengeActions],
    implemented: {
      startLogin: !!adapter.startLogin,
      getStatus: !!adapter.getStatus,
      submitChallenge: !!adapter.submitChallenge,
      logout: !!adapter.logout,
      query: !!adapter.query,
      verifyScope: !!adapter.verifyScope,
      queryPage: !!adapter.queryPage,
    },
  };
}

/**
 * 从人工验证响应 / credentialRef 里收集需要登记为「已知明文」的标量。
 *   - 字符串与**数字**都登记（数字型验证码同样要覆盖）；布尔不登记（"true"/"false" 会误伤正常文本）。
 *   - 长度下限 MIN_SECRET_LEN：过短的值替换起来会把正常文本打碎。
 *   - 数组/对象递归取值；其它类型忽略。
 */
/** Set 版的「先进先出」上限：超出即淘汰最早登记的值。 */
function capSet(set, max) {
  while (set.size > max) set.delete(set.values().next().value);
}

function collectSecrets(value, out = new Set()) {
  if (value === null || value === undefined) return out;
  const type = typeof value;
  if (type === "string") {
    if (value.length >= MIN_SECRET_LEN) out.add(value);
    return out;
  }
  if (type === "number") {
    const s = String(value);
    if (s.length >= MIN_SECRET_LEN) out.add(s);
    return out;
  }
  if (type !== "object") return out; // 布尔/函数/symbol 不登记
  if (Array.isArray(value)) {
    for (const v of value) collectSecrets(v, out);
    return out;
  }
  for (const v of Object.values(value)) collectSecrets(v, out);
  return out;
}
