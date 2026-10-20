// tax-api-catalog.mjs — 现成静态/观察材料的接口目录（纯数据 + 纯函数，不联网、不执行）。
//
// 边界：
//   - 只收录「已在本机现成分析报告里明确列举」的接口。报告没有逐条列出的模块（例如报告自称
//     认证平台有 200+ 端点）不在这里补猜，只按报告实际列名的条目登记，缺口单独计数。
//   - 只保存技术合同字段：稳定技术名、静态且不含动态标识的路径模板、参数键/类型/来源、
//     方法、模块、依赖、证据类别与报告行号。实例值、企业数据、凭据、运行时完整地址
//     一律不进源码，也不出现在任何返回值里。
//   - 目录「已管理」≠「线上调用已验证」。本模块不实现任何请求执行，也不接受任意 URL。
//   - 方法未知就写 unknown；参数未知就写 paramsEvidence="unknown" 并列出具体缺口，
//     绝不用空参数假装“无参数”。

/** 报告来源：只登记可核验的摘要，不复制原文。 */
export const CATALOG_SOURCE = Object.freeze({
  reportLabel: "etax_rea_work 接口分析报告（本机现成材料，未纳入版本控制）",
  reportSha256: "0d2f4b8f729b34014315507510bc9aa07d35f8f8d3c04af2fe6f961e87eb4a1c",
  reportLines: 153,
  reportChars: 8605,
  observedSection: "报告 4.x / 3 / 133（页面加载实际 XHR 与登录主流程）",
  staticSection: "报告 6.1 / 6.2 / 6.3（静态 JS 产物列举）",
  limitationsSection: "报告 8",
  copiedIntoRepository: false,
});

export const CATALOG_VERSION = 1;

/** 服务标识是符号，不是地址：真实主机与端口属于接入上下文，由适配器层持有。 */
export const SERVICES = Object.freeze({
  portal: { label: "门户/主站（同源门户中心与消息中心）", reportLines: [25] },
  identity: { label: "统一身份认证平台", reportLines: [26] },
  behavior: { label: "行为采集服务", reportLines: [27] },
  service_desk: { label: "智能交互客服（跨省共用平台）", reportLines: [28] },
});

/** 方法枚举；unknown 表示报告未载明，不推测。 */
export const METHODS = Object.freeze(["GET", "POST", "unknown"]);

/** 证据类别。 */
export const EVIDENCE = Object.freeze({
  observed: "报告观察（报告记载该请求在页面加载中实际发生）",
  static: "静态列举（报告从 JS 产物中列名，未实际触发）",
  inferred: "推断（报告未直接写出的字段/用途，按名称或上下文推断）",
  unknown: "unknown（报告既未观察也未列举）",
});

/** 参数结构证据：推断绝不能当 observed。 */
export const PARAMS_EVIDENCE = Object.freeze({
  observed: "报告直接载明参数键与观察形态",
  inferred: "按接口名/协议模式推断，报告未逐项确认",
  envelope_only: "只有共享传输信封已知，信封内业务字段未载明",
  unknown: "报告未载明参数结构",
});

/**
 * 契约完整度分层。full_contract 必须同时有路径、方法、已载明参数、已载明响应与
 * 已解析的前置条件（身份/企业/权限），且证据不是推断；不能因为“参数有记录”就称完整。
 */
export const COMPLETENESS_TIERS = Object.freeze({
  full_contract: "完整可调用契约（路径+方法+参数+响应+前置条件均有证据）",
  method_and_params_documented: "方法与参数结构已载明，但响应或前置条件仍缺失",
  method_and_response_documented: "方法、路径与响应已载明，但参数或前置条件仍缺失",
  method_documented: "仅方法已知，参数结构与响应未载明",
  params_documented: "仅参数结构已知，方法与响应未载明",
  path_only: "只有静态路径，方法与参数结构都未知",
  unknown: "连静态路径都没有（通配分组/未列名）",
});

const PARAM_SOURCES = Object.freeze(["report_observed", "report_inferred", "shared_envelope", "report_static"]);
const PARAM_LOCATIONS = Object.freeze(["query", "body", "header", "path", "unknown"]);
/** 凭据/会话/授权码类参数名：只登记依赖，绝不接受参数值。 */
const SENSITIVE_PARAM_NAME = /pass|pwd|secret|token|sign|cookie|authorization|credential|session|ticket|captcha|(^|_)code$|^state$|uuid|deviceid/i;

/** 操作风险：登录与写操作默认不可由 Agent 自动执行。 */
export const RISKS = Object.freeze({
  read_only: "只读",
  state_changing: "写/状态变更",
  authentication: "登录/认证提交",
  unknown: "未知",
});

/**
 * 共享传输信封（技术合同字段，不含任何密钥/实例值）。
 * 报告 5 节描述了认证平台的统一信封；主站请求无信封。
 */
export const ENVELOPES = Object.freeze({
  none: Object.freeze({
    id: "none",
    label: "无信封（普通 JSON）",
    fields: Object.freeze([]),
    notes: Object.freeze(["报告：主站请求为普通 JSON，附带时间戳查询参数，前端拦截器超时 5 秒"]),
    reportLines: Object.freeze([108, 109, 110]),
  }),
  tpass_envelope: Object.freeze({
    id: "tpass_envelope",
    label: "认证平台统一 JSON 信封",
    fields: Object.freeze([
      { name: "zipCode", type: "string", note: "压缩标志；观察值集合未在本目录保存实例值" },
      { name: "encryptCode", type: "string", note: "加密标志：明文 / SM4 两种" },
      { name: "datagram", type: "string", note: "业务 JSON 或 SM4 密文 hex；业务字段报告未载明" },
      { name: "timestamp", type: "string", note: "yyyyMMddHHmmss" },
      { name: "access_token", type: "string", note: "登录后携带" },
      { name: "signtype", type: "string", note: "报告观察到 HMacSHA256" },
      { name: "signature", type: "string", note: "签名 hex；签名串拼接顺序未 100% 还原（报告 8 节）" },
    ]),
    headers: Object.freeze([
      { name: "X-TEMP-INFO", note: "密钥协商临时标识（值不保存）" },
      { name: "X-SM4-INFO", note: "SM4 协商状态标志" },
      { name: "X-APP-CLIENTID", note: "客户端标识" },
      { name: "X-LANG-ID", note: "语言" },
      { name: "X-NATURE-IP", note: "网络性质" },
      { name: "X-TICKET-ID", note: "票据标识" },
      { name: "hUid", note: "报告仅列名，语义未载明" },
      { name: "deviceIdentyNo", note: "设备指纹（报告实例值已丢弃，不保存）" },
    ]),
    notes: Object.freeze([
      "响应结构同为信封 + 业务 code/msg，业务 datagram 需用同一会话密钥解密",
      "密钥协商顺序：取公钥 → 上报 SM4 密钥 → 之后请求带加密标志",
    ]),
    reportLines: Object.freeze([82, 94, 96, 97, 98, 99, 100, 101, 103, 104, 105, 106]),
  }),
});

/** 模块（按域/模块分组）。 */
export const MODULES = Object.freeze([
  { id: "behavior.config", service: "behavior", label: "行为采集-配置", reportLines: [48, 49, 50, 51] },
  { id: "behavior.upload", service: "behavior", label: "行为采集-上报", reportLines: [52, 53, 54, 55] },
  { id: "portal.mhzx.home", service: "portal", label: "门户中心-首页与会话", reportLines: [58, 62, 63, 34] },
  { id: "portal.mhzx.menu", service: "portal", label: "门户中心-功能导航菜单", reportLines: [59, 64] },
  { id: "portal.mhzx.reminder", service: "portal", label: "门户中心-申报提醒与功能展示", reportLines: [60] },
  { id: "portal.mhzx.favorite", service: "portal", label: "门户中心-我的收藏", reportLines: [61] },
  { id: "portal.mhzx.identity", service: "portal", label: "门户中心-办税人信息与身份切换", reportLines: [115] },
  { id: "portal.mhzx.todo", service: "portal", label: "门户中心-我的待办", reportLines: [115] },
  { id: "portal.mhzx.digital_account", service: "portal", label: "门户中心-数字账户", reportLines: [63, 115] },
  { id: "portal.mhzx.support", service: "portal", label: "门户中心-智能交互入口", reportLines: [65] },
  { id: "portal.mhzx.sso", service: "portal", label: "门户中心-单点登录桥接", reportLines: [35, 42] },
  { id: "portal.message.notice", service: "portal", label: "消息中心-纳税人消息", reportLines: [116] },
  { id: "portal.message.announcement", service: "portal", label: "消息中心-通知公告", reportLines: [116] },
  { id: "portal.message.task", service: "portal", label: "消息中心-待办任务", reportLines: [116] },
  { id: "portal.message.reminder", service: "portal", label: "消息中心-温馨提示", reportLines: [68, 116] },
  { id: "portal.message.system", service: "portal", label: "消息中心-系统消息", reportLines: [116] },
  { id: "portal.declaration", service: "portal", label: "申报与信息变更入口", reportLines: [117] },
  { id: "identity.oauth2", service: "identity", label: "统一认证-OAuth2 授权与票据", reportLines: [37, 71, 120] },
  { id: "identity.password", service: "identity", label: "统一认证-密码登录", reportLines: [121] },
  { id: "identity.sms", service: "identity", label: "统一认证-短信登录", reportLines: [122] },
  { id: "identity.qrcode", service: "identity", label: "统一认证-扫码登录", reportLines: [76, 77, 123] },
  { id: "identity.cert", service: "identity", label: "统一认证-CA 证书", reportLines: [124] },
  { id: "identity.face", service: "identity", label: "统一认证-人脸核验", reportLines: [125] },
  { id: "identity.captcha", service: "identity", label: "统一认证-验证码", reportLines: [126] },
  { id: "identity.quick", service: "identity", label: "统一认证-快捷登录/办税员（通配分组）", reportLines: [127] },
  { id: "identity.basic", service: "identity", label: "统一认证-基础数据", reportLines: [74, 75, 78, 128] },
  { id: "identity.white", service: "identity", label: "统一认证-白名单通道", reportLines: [72, 129] },
  { id: "identity.session", service: "identity", label: "统一认证-会话校验", reportLines: [130] },
  { id: "service_desk.entry", service: "service_desk", label: "智能客服-入口", reportLines: [133] },
]);

// ------------------------------------------------------------------ 条目构造
const UNKNOWN_PARAMS_GAP = "报告未载明该接口的请求参数结构（不能当作“无参数”）";
// 报告正文对认证平台同时出现两种前缀（OAuth2 登录入口写作 /api/v1.0，其余列举写作 /sys-api/v1.0），
// 归属未核实；目录按报告原样登记，并在每条认证接口上标明该未决点。
const IDENTITY_PREFIX_NOTE = "认证平台前缀在报告中同时出现 /api/v1.0 与 /sys-api/v1.0 两种写法，归属未核实";

function normalizeParam(p) {
  if (!p || typeof p !== "object") throw new Error("tax_api_catalog_param_invalid");
  if (typeof p.name !== "string" || !p.name) throw new Error("tax_api_catalog_param_invalid");
  if (!PARAM_LOCATIONS.includes(p.location)) throw new Error(`tax_api_catalog_param_location_invalid:${p.name}`);
  if (typeof p.type !== "string" || !p.type) throw new Error(`tax_api_catalog_param_type_invalid:${p.name}`);
  if (![true, false, "unknown"].includes(p.required)) throw new Error(`tax_api_catalog_param_required_invalid:${p.name}`);
  if (!PARAM_SOURCES.includes(p.source)) throw new Error(`tax_api_catalog_param_source_invalid:${p.name}`);
  const sensitive = p.sensitive === true || SENSITIVE_PARAM_NAME.test(p.name);
  // 敏感参数的键/类型可以登记，但永不接受值提交校验：只允许本机安全引用在目录之外存在。
  return Object.freeze({ ...p, sensitive, valueAccepted: !sensitive });
}

function entry(id, moduleId, purpose, method, pathTemplate, risk, evidence, lines, extra = {}) {
  const mod = MODULES.find((m) => m.id === moduleId);
  if (!mod) throw new Error(`tax_api_catalog_module_unknown:${moduleId}`);
  if (!METHODS.includes(method)) throw new Error(`tax_api_catalog_method_invalid:${id}`);
  if (!Object.prototype.hasOwnProperty.call(RISKS, risk)) throw new Error(`tax_api_catalog_risk_invalid:${id}`);
  if (!Object.prototype.hasOwnProperty.call(EVIDENCE, evidence)) throw new Error(`tax_api_catalog_evidence_invalid:${id}`);
  const envelope = extra.envelope ?? (mod.service === "identity" ? "tpass_envelope" : "none");
  const params = (extra.params ?? []).map(normalizeParam);
  // 参数结构证据：报告直接载明 → observed；推断 → inferred；只知共享传输信封 → envelope_only；都没有 → unknown。
  const paramsEvidence = extra.paramsEvidence
    ?? (params.length
      ? (params.every((p) => p.source === "report_observed") ? "observed" : "inferred")
      : (envelope !== "none" ? "envelope_only" : "unknown"));
  if (!Object.prototype.hasOwnProperty.call(PARAMS_EVIDENCE, paramsEvidence)) {
    throw new Error(`tax_api_catalog_params_evidence_invalid:${id}`);
  }
  const gapBase = paramsEvidence === "observed"
    ? ["报告只给出字段名与观察形态，未载明取值域、校验规则与失败行为"]
    : paramsEvidence === "inferred"
      ? ["参数结构按协议模式推断，报告未逐项确认；不能作为已验证合同"]
      : [UNKNOWN_PARAMS_GAP,
        ...(envelope !== "none" ? ["仅有共享传输信封已知，信封内业务字段未载明"] : [])];
  const paramGaps = [...gapBase, ...(extra.paramGaps ?? [])];
  const notes = [...(extra.notes ?? [])];
  if (params.some((p) => p.sensitive)) {
    notes.push("含凭据/会话/授权码类参数：目录只登记依赖与类型，不接受也不返回任何参数值");
  }
  if (mod.service === "identity") notes.push(IDENTITY_PREFIX_NOTE);
  return Object.freeze({
    id,
    module: moduleId,
    moduleLabel: mod.label,
    service: mod.service,
    purpose,
    // 用途推断与接口观察证据分开：名称推断在 purpose 文本和此字段都可见。
    purposeEvidence: /推断/.test(purpose) ? "inferred_from_name" : "reported",
    method,
    pathTemplate: pathTemplate ?? null,
    pathKnown: typeof pathTemplate === "string" && pathTemplate.startsWith("/"),
    // 路径证据：默认报告直接写出；按命名推断的必须显式标 inferred_from_name。
    pathEvidence: extra.pathEvidence ?? (pathTemplate ? "reported" : "unknown"),
    risk,
    evidence,
    evidenceLabel: EVIDENCE[evidence],
    envelope,
    params: Object.freeze(params),
    paramsEvidence,
    paramsEvidenceLabel: PARAMS_EVIDENCE[paramsEvidence],
    paramGaps: Object.freeze(paramGaps),
    responseEvidence: extra.responseEvidence ?? "unknown",
    responseNotes: Object.freeze(extra.responseNotes ?? []),
    errorNotes: Object.freeze(extra.errorNotes ?? []),
    pagination: Object.freeze(extra.pagination ?? { supported: "unknown", note: "报告未载明分页语义" }),
    download: extra.download === true,
    identityDependency: extra.identityDependency ?? defaultIdentity(mod.service),
    enterpriseDependency: extra.enterpriseDependency ?? defaultEnterprise(mod.service),
    permissionDependency: extra.permissionDependency ?? defaultPermission(mod.service),
    notes: Object.freeze(notes),
    reportLines: Object.freeze(lines),
    autoExecutable: false,
  });
}

function defaultIdentity(service) {
  return service === "behavior" || service === "identity"
    ? { required: "unknown", note: "报告未载明该接口是否要求已登录会话" }
    : { required: true, note: "属门户/业务域接口，报告观察到的调用发生在登录会话建立后" };
}
function defaultEnterprise(service) {
  return service === "behavior" || service === "identity"
    ? { required: "unknown", note: "报告未载明企业上下文绑定方式" }
    : { required: "unknown", note: "报告未载明该接口与企业上下文的绑定方式" };
}
function defaultPermission() {
  return { required: "unknown", note: "报告未载明所需权限；目录事实不能证明任一企业可用" };
}

const observedParams = (params, gaps = []) => ({ params, paramsEvidence: "observed", paramGaps: gaps });
const inferredParams = (params, gaps = []) => ({ params, paramsEvidence: "inferred", paramGaps: gaps });
/** 报告只给出共享信封/或者什么都没给时的参数缺口声明。具体 paramsEvidence 由 entry() 按信封归属判定。 */
const sharedGaps = (gaps = [], extra = []) => ({
  params: [],
  paramGaps: [UNKNOWN_PARAMS_GAP, ...gaps, ...extra],
});

const q = (name, type, required, note, source = "report_observed") => ({ name, location: "query", type, required, source, note });
const body = (name, type, required, note, source = "report_observed") => ({ name, location: "body", type, required, source, note });

// ------------------------------------------------------------------ 条目
const ENTRIES = [
  // ---- 行为采集（报告 4.1，观察证据）----
  entry("behavior.config.query", "behavior.config", "读取行为采集功能开关配置（页面每 5 分钟刷新一次）", "POST",
    "/xwcjsjjs/api/xwcjsjjs/api/v1.0/extend/queryGgpz", "read_only", "observed", [48, 49, 50, 51],
    {
      ...observedParams([
        q("t", "number|string", "unknown", "报告写作 ?t=<ts>，取值来源为前端时间戳"),
        body("sjbbh", "string|null", false, "报告观察值为 null"),
        body("gnbbh", "string|null", false, "报告观察值为 null"),
        body("sffhClientid", "string", "unknown", "报告观察值形态为单字符标志"),
      ], ["业务字段语义与取值域未在报告中说明"]),
      responseEvidence: "observed",
      responseNotes: ["响应用于本地缓存功能开关配置，并下发客户端标识"],
      notes: ["配置与客户端标识会被前端持久化到 localStorage；本目录不保存任何实例值"],
    }),
  entry("behavior.upload.accept", "behavior.upload", "批量上报前端行为事件", "POST",
    "/xwcjsjjs/api/xwcjsjjs/api/v1.0/extend/accept", "state_changing", "observed", [52, 53, 54, 55],
    {
      ...observedParams([
        q("t", "number|string", "unknown", "报告写作 ?t=<ts>"),
        body("data_list", "string", true, "固定为表单编码字段：URL 编码后的 base64(JSON 字符串)"),
      ]),
      responseEvidence: "unknown",
      responseNotes: ["报告未载明响应结构"],
      notes: ["Content-Type 为 application/x-www-form-urlencoded"],
      errorNotes: ["报告未载明错误约定"],
    }),

  // ---- 门户中心 mhzx ----
  entry("portal.mhzx.home.get_user_info", "portal.mhzx.home", "读取当前登录用户信息", "GET",
    "/mhzx/api/mh/mhsy/getUserInfo", "read_only", "observed", [58],
    {
      ...sharedGaps(["报告只给出 GET 与响应为“未登录时空”这一观察"]),
      responseEvidence: "observed",
      responseNotes: ["未登录时响应为空"],
      notes: ["同包其他任务的现场记录显示返回过仅含业务码/消息的 Data；本目录不据此推断登录失效或权限缺失"],
    }),
  entry("portal.mhzx.home.index", "portal.mhzx.home", "门户入口（登录流程第 2 步）", "GET",
    "/mhzx/api/mh/mhsy/index", "read_only", "observed", [34],
    { ...sharedGaps(["报告仅记录该请求以 302 跳转"], ["302 响应体不可读（报告 8 节局限）"]), responseEvidence: "observed",
      responseNotes: ["302 重定向；响应体不可读"] }),
  entry("portal.mhzx.home.logout", "portal.mhzx.home", "门户侧退出登录", "unknown",
    "/mhzx/api/mh/mhsy/logout", "state_changing", "static", [115],
    { ...sharedGaps(["报告仅列名，方法、参数与语义均未载明"]), notes: ["报告的静态列举未标注方法"] }),
  entry("portal.mhzx.home.check_token", "portal.mhzx.home", "校验门户令牌有效性", "unknown",
    "/mhzx/api/mh/mhsy/checkToken", "read_only", "static", [115],
    { ...sharedGaps(["报告仅列名"]) }),
  entry("portal.mhzx.home.get_ycxpj", "portal.mhzx.home", "获取门户票据类数据（用途按名称推断）", "unknown",
    "/mhzx/api/mh/mhsy/getYcxpj", "read_only", "static", [115],
    { ...sharedGaps(["报告仅列名，用途与参数均未说明"]), notes: ["用途为按接口名推断，报告未说明"] }),
  entry("portal.mhzx.home.get_zhzx_url", "portal.mhzx.home", "获取综合中心跳转地址", "unknown",
    "/mhzx/api/mh/mhsy/getZhzxUrl", "read_only", "static", [115],
    { ...sharedGaps(["报告仅列名；返回地址属运行时值，本目录不保存"]), notes: ["用途按名称推断"] }),
  entry("portal.mhzx.home.get_dlqysfqh_url", "portal.mhzx.home", "获取登录区域税费切换地址（用途按名称推断）", "unknown",
    "/mhzx/api/mh/mhsy/getDlqysfqhUrl", "read_only", "static", [115],
    { ...sharedGaps(["报告仅列名；返回地址属运行时值"]), notes: ["用途按名称推断"] }),

  entry("portal.mhzx.menu.hdrymd", "portal.mhzx.menu", "功能导航菜单（首页菜单树）", "POST",
    "/mhzx/api/mh/gncdgsrd/v1/hdrymd", "read_only", "observed", [59],
    { ...sharedGaps(["报告仅记录 302 跳转与菜单语义"], ["302 响应体不可读"]), responseEvidence: "observed",
      responseNotes: ["302 重定向"] }),
  entry("portal.mhzx.menu.login_back_query_menu", "portal.mhzx.menu", "登录后回查功能菜单", "POST",
    "/mhzx/api/mh/gncdgsrd/v1/loginbackquerygncd", "read_only", "observed", [64],
    { ...sharedGaps(["报告仅记录 302 跳转"]), responseEvidence: "observed", responseNotes: ["302 重定向"] }),
  entry("portal.mhzx.menu.login_back_query_zwzmh_menu", "portal.mhzx.menu", "登录后回查政务门户功能菜单", "unknown",
    "/mhzx/api/mh/gncdgsrd/v1/loginbackqueryzwzmhgncd", "read_only", "static", [115],
    { ...sharedGaps(["报告仅列名"]) }),
  entry("portal.mhzx.menu.login_back_search_zwzj_menu", "portal.mhzx.menu", "登录后检索政务证件功能菜单（用途按名称推断）", "unknown",
    "/mhzx/api/mh/gncdgsrd/v1/loginbacksearchzwzjhgns", "read_only", "static", [115],
    { ...sharedGaps(["报告仅列名；检索参数未载明"]) }),
  entry("portal.mhzx.menu.login_forward_search_menu", "portal.mhzx.menu", "登录后前向检索功能菜单（用途按名称推断）", "unknown",
    "/mhzx/api/mh/gncdgsrd/v1/loginforwardsearchgns", "read_only", "static", [115],
    { ...sharedGaps(["报告仅列名；检索参数未载明"]) }),
  entry("portal.mhzx.menu.login_forward_search_menu_sdk", "portal.mhzx.menu", "登录后前向检索功能菜单（SDK 通道，用途按名称推断）", "unknown",
    "/mhzx/api/mh/gncdgsrd/v1/loginforwardsearchgnssdk", "read_only", "static", [115],
    { ...sharedGaps(["报告仅列名"]) }),
  entry("portal.mhzx.menu.login_back_search_menu_v2", "portal.mhzx.menu", "登录后检索功能菜单（v2，用途按名称推断）", "unknown",
    "/mhzx/api/mh/gncdgsrd/v2/loginbacksearchgns", "read_only", "static", [115],
    { ...sharedGaps(["报告仅列名；v1/v2 差异未载明"]) }),

  entry("portal.mhzx.reminder.js_sbqx_mhsy", "portal.mhzx.reminder", "首页功能展示-申报提醒（mhsy 版本）", "unknown",
    "/mhzx/api/mh/mhsygnzs/v1/jsSbqx", "read_only", "static", [115],
    { ...sharedGaps(["报告仅列名；mhsy 版本未观察到实际调用"]) }),
  entry("portal.mhzx.reminder.mc_qh", "portal.mhzx.reminder", "首页功能展示-名称切换（用途按名称推断）", "unknown",
    "/mhzx/api/mh/mhsygnzs/v1/mcQh", "read_only", "static", [115],
    { ...sharedGaps(["报告仅列名"]) }),
  entry("portal.mhzx.reminder.js_sbqx_nsryhsy", "portal.mhzx.reminder", "首页功能展示-申报提醒（纳税人银行首页版本）", "POST",
    "/mhzx/api/mh/nsryhsygnzs/v1/jsSbqx", "read_only", "observed", [60],
    { ...sharedGaps(["报告仅记录 302 跳转"]), responseEvidence: "observed", responseNotes: ["302 重定向"] }),

  entry("portal.mhzx.favorite.init_view", "portal.mhzx.favorite", "我的收藏-初始化视图", "POST",
    "/mhzx/api/mh/wdsc/v1/initView", "read_only", "observed", [61],
    { ...sharedGaps(["报告仅记录 302 跳转"]), responseEvidence: "observed", responseNotes: ["302 重定向"] }),
  entry("portal.mhzx.favorite.insert", "portal.mhzx.favorite", "新增收藏项", "unknown",
    "/mhzx/api/mh/wdsc/v1/insertWdsc", "state_changing", "static", [115],
    { ...sharedGaps(["报告仅列名；写入字段未载明"]), notes: ["写接口：目录层默认不可由 Agent 自动执行"] }),
  entry("portal.mhzx.favorite.batch_cancel", "portal.mhzx.favorite", "批量取消收藏", "unknown",
    "/mhzx/api/mh/wdsc/v1/plqxSc", "state_changing", "static", [115],
    { ...sharedGaps(["报告仅列名"]), notes: ["写接口：目录层默认不可由 Agent 自动执行"] }),
  entry("portal.mhzx.favorite.function_menu", "portal.mhzx.favorite", "我的收藏-功能菜单（用途按名称推断）", "unknown",
    "/mhzx/api/mh/wdsc/v1/dlhGncdzs", "read_only", "static", [115],
    { ...sharedGaps(["报告仅列名"]) }),

  entry("portal.mhzx.identity.change_identity", "portal.mhzx.identity", "切换当前办税人身份", "unknown",
    "/mhzx/api/mh/mhuser/v1/changeIdentity", "state_changing", "static", [115],
    { ...sharedGaps(["报告仅列名"]), notes: ["影响当前会话身份，属高风险写操作"] }),
  entry("portal.mhzx.identity.change_status", "portal.mhzx.identity", "变更办税人状态（用途按名称推断）", "unknown",
    "/mhzx/api/mh/mhuser/v1/changeStatus", "state_changing", "static", [115],
    { ...sharedGaps(["报告仅列名"]) }),
  entry("portal.mhzx.identity.nsrjbxx_query", "portal.mhzx.identity", "查询纳税人基本信息", "unknown",
    "/mhzx/api/mh/nsrjbxx/v1/query", "read_only", "static", [115],
    { ...sharedGaps(["报告仅列名；返回字段未载明"]) }),
  entry("portal.mhzx.identity.nsrjbxx_query_dljg", "portal.mhzx.identity", "查询纳税人登记结果信息（用途按名称推断）", "unknown",
    "/mhzx/api/mh/nsrjbxx/v1/queryDljgXyjb", "read_only", "static", [115],
    { ...sharedGaps(["报告仅列名"]) }),
  entry("portal.mhzx.identity.bqxx", "portal.mhzx.identity", "首页待办标签信息", "GET",
    "/mhzx/api/mh/bqxx/getMhsydbBqxx", "read_only", "observed", [62],
    { ...sharedGaps(["报告仅给出 GET 与“标签信息”语义"]), responseEvidence: "observed" }),

  entry("portal.mhzx.todo.query_bbsmxx", "portal.mhzx.todo", "我的待办-查询待办申报事项", "unknown",
    "/mhzx/api/mh/wddb/v1/wddbquerybbsmxx", "read_only", "static", [115],
    { ...sharedGaps(["报告仅列名；该接口的方法与请求体未在本报告中载明"]),
      notes: ["同包其他现场记录使用了该路径，但本目录只按本报告取证，不引入报告外参数"] }),

  entry("portal.mhzx.digital_account.get_url", "portal.mhzx.digital_account", "获取数字账户入口地址", "GET",
    "/mhzx/api/mh/szzh/getSzzhUrl", "read_only", "observed", [63],
    { ...sharedGaps(["报告仅记录返回地址语义"]), responseEvidence: "observed",
      responseNotes: ["返回地址属运行时值，不保存"] }),

  entry("portal.mhzx.support.get_znhd_fwdz", "portal.mhzx.support", "获取智能交互服务地址", "GET",
    "/mhzx/api/mh/znhd/v1/getznhdfwdz", "read_only", "observed", [65],
    { ...sharedGaps(["报告仅记录 302 与“服务地址”语义"]), responseEvidence: "observed", responseNotes: ["302 重定向"] }),

  entry("portal.mhzx.sso.sso_login", "portal.mhzx.sso", "单点登录桥接：按业务路径重新走统一认证", "GET",
    "/mhzx/api/mh/tpass/ssoLogin", "authentication", "observed", [35, 36],
    {
      ...observedParams([q("requestPath", "string", true, "业务路径；页面为每个待办/通知业务各触发一次")]),
      responseEvidence: "observed", responseNotes: ["302 跳转到统一认证平台"],
      notes: ["登录类接口：目录层永不自动执行"],
    }),
  entry("portal.mhzx.sso.code_callback", "portal.mhzx.sso", "统一认证回调换取门户会话", "GET",
    "/mhzx/api/mh/tpass/code", "authentication", "observed", [38, 42],
    {
      ...inferredParams([q("code", "string", "unknown",
        "OAuth2 授权码；报告未明确列出回调参数名，按授权码模式推断，不能当已观察合同", "report_inferred")],
        ["回调查询参数集合未在报告中逐项确认"]),
      responseEvidence: "inferred",
      responseNotes: ["按授权码模式推断为“凭授权码换取门户会话”，报告未逐项确认"],
      notes: ["登录类接口：目录层永不自动执行；授权码属敏感值，绝不作为参数值提交校验或经 MCP 返回；如需登记请使用本机安全引用，不在目录/工具中传递凭据值"],
    }),

  // ---- 消息中心 xxzx ----
  entry("portal.message.notice.get", "portal.message.notice", "查看纳税人消息内容", "unknown",
    "/xxzx/api/nsrxxzx/nsrxxtx/v1/getNsrxxtxNr", "read_only", "static", [116],
    { ...sharedGaps(["报告仅列名；消息标识参数未载明"]) }),
  entry("portal.message.notice.list_xdj", "portal.message.notice", "查看限定端（消息中心）纳税人消息内容（用途按名称推断）", "unknown",
    "/xxzx/api/nsrxxzx/nsrxxtx/v1/getXdjNsrxxtxNr", "read_only", "static", [116],
    { ...sharedGaps(["报告仅列名"]) }),
  entry("portal.message.notice.list_mh_todo", "portal.message.notice", "门户待办列表（消息通道）", "unknown",
    "/xxzx/api/nsrxxzx/nsrxxtx/v1/listMhWddb", "read_only", "static", [116],
    { ...sharedGaps(["报告仅列名"]) }),
  entry("portal.message.notice.list", "portal.message.notice", "纳税人消息列表", "unknown",
    "/xxzx/api/nsrxxzx/nsrxxtx/v1/listNsrxxtx", "read_only", "static", [116],
    { ...sharedGaps(["报告仅列名；分页语义未载明"]),
      pagination: { supported: "unknown", note: "列表接口，报告未载明分页参数与 total 语义" } }),
  entry("portal.message.notice.list_xdj_all", "portal.message.notice", "纳税人消息列表（限定端版本）", "unknown",
    "/xxzx/api/nsrxxzx/nsrxxtx/v1/listXdjNsrxxtx", "read_only", "static", [116],
    { ...sharedGaps(["报告仅列名"]) }),
  entry("portal.message.notice.update_todo_status", "portal.message.notice", "更新待办消息阅读状态", "unknown",
    "/xxzx/api/nsrxxzx/nsrxxtx/v1/updateWddbSxzt", "state_changing", "static", [116],
    { ...sharedGaps(["报告仅列名"]), notes: ["写接口：目录层默认不可自动执行"] }),
  entry("portal.message.announcement.get", "portal.message.announcement", "查看通知公告内容", "unknown",
    "/xxzx/api/nsrxxzx/txyfk/tzgg/v1/getTzggNr", "read_only", "static", [116],
    { ...sharedGaps(["报告仅列名"]) }),
  entry("portal.message.announcement.list_mh", "portal.message.announcement", "门户通知公告列表", "unknown",
    "/xxzx/api/nsrxxzx/txyfk/tzgg/v1/listMhTzgg", "read_only", "static", [116],
    { ...sharedGaps(["报告仅列名"]) }),
  entry("portal.message.task.get_tstx", "portal.message.task", "获取待办任务提醒（用途按名称推断）", "unknown",
    "/xxzx/api/nsrxxzx/txzx/dbrw/v1/getDbrwtstx", "read_only", "static", [116],
    { ...sharedGaps(["报告仅列名"]) }),
  entry("portal.message.task.list_nsr", "portal.message.task", "纳税人待办列表", "unknown",
    "/xxzx/api/nsrxxzx/txzx/dbrw/v1/listNsrDbxx", "read_only", "static", [116],
    { ...sharedGaps(["报告仅列名"]) }),
  entry("portal.message.task.list_zrr", "portal.message.task", "自然人待办列表", "unknown",
    "/xxzx/api/nsrxxzx/txzx/dbrw/v1/listZrrDbxx", "read_only", "static", [116],
    { ...sharedGaps(["报告仅列名"]) }),
  entry("portal.message.reminder.download_tjxx", "portal.message.reminder", "下载提醒事项附件（用途按名称推断）", "unknown",
    "/xxzx/api/nsrxxzx/txzx/wntj/v1/downloadTjxx", "read_only", "static", [116],
    { ...sharedGaps(["报告仅列名；下载参数与文件类型未载明"]), download: true,
      notes: ["下载类接口：报告未载明文件格式与断点/鉴权要求"] }),
  entry("portal.message.reminder.list_wntj", "portal.message.reminder", "温馨提示列表", "POST",
    "/xxzx/api/nsrxxzx/txzx/wntj/v1/listWntj", "read_only", "observed", [68],
    { ...sharedGaps(["报告仅记录 302 跳转与“温馨提示列表”语义"]), responseEvidence: "observed",
      responseNotes: ["302 重定向；响应体不可读"],
      pagination: { supported: "unknown", note: "列表接口，报告未载明分页参数" } }),
  entry("portal.message.reminder.query_tjxxmx", "portal.message.reminder", "查询提醒事项明细", "unknown",
    "/xxzx/api/nsrxxzx/txzx/wntj/v1/queryTjxxmx", "read_only", "static", [116],
    { ...sharedGaps(["报告仅列名"]) }),
  entry("portal.message.reminder.query_wntj_list", "portal.message.reminder", "查询温馨提示列表（第二入口，用途按名称推断）", "unknown",
    "/xxzx/api/nsrxxzx/txzx/wntj/v1/queryWntjList", "read_only", "static", [116],
    { ...sharedGaps(["报告仅列名"]) }),
  entry("portal.message.system.get_details", "portal.message.system", "查看系统消息详情", "unknown",
    "/xxzx/api/nsrxxzx/txzx/xtxxfb/v1/getXtxxDetails", "read_only", "static", [116],
    { ...sharedGaps(["报告仅列名"]) }),
  entry("portal.message.system.list_nsr", "portal.message.system", "纳税人系统消息列表", "unknown",
    "/xxzx/api/nsrxxzx/txzx/xtxxfb/v1/listNsrXtxx", "read_only", "static", [116],
    { ...sharedGaps(["报告仅列名"]) }),
  entry("portal.message.system.list_zrr", "portal.message.system", "自然人系统消息列表", "unknown",
    "/xxzx/api/nsrxxzx/txzx/xtxxfb/v1/listZrrXtxx", "read_only", "static", [116],
    { ...sharedGaps(["报告仅列名"]) }),
  entry("portal.message.system.update_read_status", "portal.message.system", "更新系统消息阅读状态", "unknown",
    "/xxzx/api/nsrxxzx/txzx/xtxxfb/v1/updateXtxxYdzt", "state_changing", "static", [116],
    { ...sharedGaps(["报告仅列名"]), notes: ["写接口：目录层默认不可自动执行"] }),

  // ---- 申报 / 信息变更 ----
  entry("portal.declaration.jyqrssb_status", "portal.declaration", "读取简易确认式申报的纳税人可用状态（用途按名称推断）", "unknown",
    "/sbzx/api/ggsfsb/jyqrssb/v1/sfJyqrssbNsr", "read_only", "static", [117],
    { ...sharedGaps(["报告仅列名"]), notes: ["申报中心接口：报告未载明方法、参数与权限"] }),
  entry("portal.declaration.mhtj", "portal.declaration", "综合受理服务门户提交（用途按名称推断）", "unknown",
    "/xxbg/api/zhsffw/zhglssb/v1/mhtj", "unknown", "static", [117],
    { ...sharedGaps(["报告仅列名；语义未说明"]), notes: ["语义未知：不排除是提交类接口，目录层默认不可自动执行"] }),
  entry("portal.declaration.update_xxurl_status", "portal.declaration", "更新消息跳转状态（消息中心 + 智能交互联动，用途按名称推断）", "unknown",
    "/xxzx/api/nsrxxzx/nsrxxtx/v1/updateXxurlStatusXdjAndZnhd", "state_changing", "static", [117],
    { ...sharedGaps(["报告仅列名；报告示例路径中出现相邻双斜杠，静态形态未统一"]),
      notes: ["写接口：目录层默认不可自动执行"] }),

  // ---- 统一认证平台 tpass ----
  entry("identity.oauth2.login", "identity.oauth2", "OAuth2 授权码模式登录入口", "GET",
    "/api/v1.0/auth/oauth2/login", "authentication", "observed", [37, 38, 39, 40],
    {
      ...observedParams([
        q("redirect_uri", "string", true, "回调地址（运行时完整地址不保存）"),
        q("client_id", "string", true, "客户端标识（报告中的实例值已丢弃，不保存）"),
        q("response_type", "string", true, "报告观察为授权码模式"),
        q("state", "string", true, "报告观察为 32 位 hex 随机串，属敏感值"),
      ]),
      envelope: "none",
      responseEvidence: "observed", responseNotes: ["302 跳转到登录页"],
      notes: ["登录类接口：目录层永不自动执行"],
    }),
  ...["getPublicKey", "checkRedirectUrl", "checkRedirectUrlByClientId", "getTicket", "verifyTicket", "getCrossTicket",
    "verifyCrossTicket", "getHideCode", "verifyCode", "verifyGovCode", "verifyHideCodeLogin", "userinfo", "logout",
    "revokeToken", "changeStatus", "changeUser", "changeToNatural", "getSessionList", "selectLogin", "selectRegNumber",
    "getDpUrl", "getDpLogoutUrl"].map((name) => oauth2Entry(name)),

  // 密码登录
  ...passwordEntries(),
  // 短信登录
  ...smsEntries(),
  // 扫码登录
  ...qrcodeEntries(),
  // CA 证书
  ...simpleEntries("identity.cert", "/sys-api/v1.0/auth/cert/", [
    ["login_server_hello", "loginServerHello", "认证-登录侧服务端握手（用途按名称推断）", "authentication"],
    ["server_hello", "serverHello", "认证-服务端握手（用途按名称推断）", "authentication"],
    ["server_auth", "serverAuth", "认证-服务端证书认证（用途按名称推断）", "authentication"],
    ["server_auth_random", "serverAuthRandom", "认证-服务端随机数认证（用途按名称推断）", "authentication"],
    ["server_auth_ca", "serverAuthCA", "认证-服务端 CA 认证（用途按名称推断）", "authentication"],
  ], [124]),
  // 人脸核验
  entry("identity.face.verify_qrcode", "identity.face", "人脸核验二维码校验（用途按名称推断）", "unknown",
    "/sys-api/v1.0/auth/faceCheck/verifyQRCode", "authentication", "static", [125],
    { ...sharedGaps(["报告仅列名"]), notes: ["登录类接口：目录层永不自动执行"] }),
  entry("identity.face.login_verify_qrcode", "identity.face", "人脸核验-登录场景二维码校验（用途按名称推断）", "unknown",
    "/sys-api/v1.0/auth/faceCheck/login/verifyQRCode", "authentication", "static", [125],
    { ...sharedGaps(["报告仅列名"]), notes: ["登录类接口：目录层永不自动执行"] }),
  // 验证码
  entry("identity.captcha.get", "identity.captcha", "获取图形验证码", "unknown",
    "/sys-api/v1.0/auth/captcha/getCaptcha", "read_only", "static", [126],
    { ...sharedGaps(["报告仅列名"]), responseNotes: ["验证码图像属敏感内容，不保存"] }),
  entry("identity.captcha.verify", "identity.captcha", "校验图形验证码", "unknown",
    "/sys-api/v1.0/auth/captcha/verifyCaptcha", "authentication", "static", [126],
    { ...sharedGaps(["报告仅列名"]), notes: ["认证类接口：必须人工输入，目录层永不自动执行"] }),
  entry("identity.captcha.wh_generate", "identity.captcha", "白名单通道生成验证码（用途按名称推断）", "unknown",
    "/sys-api/v1.0/auth/wh/captcha/generate", "read_only", "static", [126],
    { ...sharedGaps(["报告仅列名"]) }),
  entry("identity.captcha.wh_check", "identity.captcha", "白名单通道校验验证码（用途按名称推断）", "unknown",
    "/sys-api/v1.0/auth/wh/captcha/check", "authentication", "static", [126],
    { ...sharedGaps(["报告仅列名"]), notes: ["认证类接口：目录层永不自动执行"] }),
  entry("identity.captcha.message_image", "identity.captcha", "短信场景验证码图片（用途按名称推断）", "unknown",
    "/sys-api/v1.0/auth/message/captchaImage", "read_only", "static", [126],
    { ...sharedGaps(["报告仅列名"]) }),
  // 快捷登录通配分组
  entry("identity.quick.entrance_wildcard", "identity.quick", "快捷登录入口分组（报告仅给通配前缀，成员未列全）", "unknown",
    null, "authentication", "static", [127],
    { ...sharedGaps(["报告只给出通配分组 /auth/entrance/*，具体端点与参数未列出"]),
      notes: ["通配分组：成员数量与语义均为 unknown，不能当作已完整登记"], autoExecutable: false }),
  entry("identity.quick.general_wildcard", "identity.quick", "通用登录分组（报告仅给通配前缀，成员未列全）", "unknown",
    null, "authentication", "static", [127],
    { ...sharedGaps(["报告只给出通配分组 /auth/general/*"]), notes: ["通配分组：成员未知"] }),
  entry("identity.quick.agency_quick_wildcard", "identity.quick", "涉税服务机构快捷登录分组（报告仅给通配前缀，成员未列全）", "unknown",
    null, "authentication", "static", [127],
    { ...sharedGaps(["报告只给出通配分组 /auth/agency/quick/*"]), notes: ["通配分组：成员未知"] }),
  // 基础数据
  entry("identity.basic.dict_query", "identity.basic", "数据字典查询", "POST",
    "/sys-api/v1.0/basic/dict/query", "read_only", "observed", [75],
    { ...sharedGaps(["报告只记录该请求实际发生与“数据字典”语义"]), responseEvidence: "observed" }),
  entry("identity.basic.dict_query_sfzjlx", "identity.basic", "数据字典-身份证件类型", "unknown",
    "/sys-api/v1.0/basic/dict/query/sfzjlx", "read_only", "static", [128],
    { ...sharedGaps(["报告仅列名"]) }),
  entry("identity.basic.dict_query_xzqh", "identity.basic", "数据字典-行政区划", "unknown",
    "/sys-api/v1.0/basic/dict/query/xzqh", "read_only", "static", [128],
    { ...sharedGaps(["报告仅列名"]) }),
  entry("identity.basic.login_config_area", "identity.basic", "登录页区域配置", "POST",
    "/sys-api/v1.0/acl/login/config/area", "read_only", "observed", [74],
    { ...sharedGaps(["报告只记录该请求实际发生"]), responseEvidence: "observed" }),
  entry("identity.basic.relation_type_idcard", "identity.basic", "证件类型关系查询", "POST",
    "/sys-api/v1.0/acl/app/relationType/getIdCardtype", "read_only", "observed", [78],
    { ...sharedGaps(["报告只记录该请求实际发生"]), responseEvidence: "observed" }),
  entry("identity.basic.relation_type_useful", "identity.basic", "可用关系类型查询（用途按名称推断）", "unknown",
    "/sys-api/v1.0/acl/app/relationType/getUseful", "read_only", "static", [128],
    { ...sharedGaps(["报告仅列名"]) }),
  // 白名单通道
  entry("identity.white.send_sm4", "identity.white", "上报协商密钥（公钥加密的对称密钥）", "POST",
    "/sys-api/v1.0/auth/white/sendSm4", "authentication", "observed", [72, 98, 99],
    {
      ...observedParams([
        body("uuid", "string", true, "密钥协商临时标识，与请求头一致（值不保存）"),
        body("secret", "string", true, "对称密钥密文 hex（敏感，不保存）"),
      ]),
      responseEvidence: "observed", responseNotes: ["服务端接受后，后续请求进入加密模式"],
      notes: ["密钥类接口：目录层永不自动执行；本目录不保存任何密钥材料"],
    }),
  entry("identity.white.get_are_code", "identity.white", "获取区域码（用途按名称推断）", "unknown",
    "/sys-api/v1.0/auth/white/getAreCode", "read_only", "static", [129],
    { ...sharedGaps(["报告仅列名"]) }),
  entry("identity.white.get_second_auth_info", "identity.white", "获取二次认证信息（用途按名称推断）", "unknown",
    "/sys-api/v1.0/auth/white/getSecondAuthInfo", "authentication", "static", [129],
    { ...sharedGaps(["报告仅列名"]), notes: ["认证类接口：目录层永不自动执行"] }),
  // 会话校验
  entry("identity.session.check_login", "identity.session", "检查登录状态", "unknown",
    "/sys-api/v1.0/auth/user/checklogin", "read_only", "static", [130],
    { ...sharedGaps(["报告仅列名"]) }),
  entry("identity.session.verify_login", "identity.session", "校验登录凭证（用途按名称推断）", "unknown",
    "/sys-api/v1.0/auth/user/verifyLogin", "read_only", "static", [130],
    { ...sharedGaps(["报告仅列名"]) }),
  entry("identity.session.logout", "identity.session", "退出登录会话", "unknown",
    "/sys-api/v1.0/auth/user/logout", "state_changing", "static", [130],
    { ...sharedGaps(["报告仅列名"]), notes: ["写接口：目录层默认不可自动执行"] }),

  // ---- 智能客服 ----
  entry("service_desk.entry.sp_handler", "service_desk.entry", "打开智能交互客服入口", "GET",
    "/hdjl/spHandler", "read_only", "observed", [133],
    {
      ...observedParams([
        q("cdlj", "string", "unknown", "报告观察值形如单斜杠路径"),
        q("showHeader", "boolean", "unknown", "布尔标志"),
        q("token", "string", "unknown", "报告观察为空值；令牌属敏感值，不保存"),
        q("channel", "string", "unknown", "渠道编号"),
        q("business", "string", "unknown", "业务名称（中文文本）"),
        q("businessId", "string", "unknown", "业务标识"),
        q("anonymousLogin", "boolean", "unknown", "是否匿名登录"),
      ], ["各参数取值域与必填性未在报告中说明"]),
      envelope: "none",
      responseEvidence: "unknown",
      notes: ["跨省共用客服平台：报告指出与门户不同域，属第三方接入上下文"],
    }),
];

function oauth2Entry(name) {
  const meta = {
    getPublicKey: ["oauth2.get_public_key", "获取加密公钥（密钥协商第 1 步）", "read_only", "observed", [71, 97]],
    checkRedirectUrl: ["oauth2.check_redirect_url", "校验回调地址", "read_only", "static", [120]],
    checkRedirectUrlByClientId: ["oauth2.check_redirect_url_by_client_id", "按客户端标识校验回调地址", "read_only", "observed", [73], "/sys-api/v1.0/auth/wh/oauth2/checkRedirectUrlByClientId"],
    getTicket: ["oauth2.get_ticket", "获取票据", "authentication", "static", [120]],
    verifyTicket: ["oauth2.verify_ticket", "校验票据", "authentication", "static", [120]],
    getCrossTicket: ["oauth2.get_cross_ticket", "获取跨域票据", "authentication", "static", [120]],
    verifyCrossTicket: ["oauth2.verify_cross_ticket", "校验跨域票据", "authentication", "static", [120]],
    getHideCode: ["oauth2.get_hide_code", "获取隐藏式授权码（用途按名称推断）", "authentication", "static", [120]],
    verifyCode: ["oauth2.verify_code", "校验授权码", "authentication", "static", [120]],
    verifyGovCode: ["oauth2.verify_gov_code", "校验政务授权码（用途按名称推断）", "authentication", "static", [120]],
    verifyHideCodeLogin: ["oauth2.verify_hide_code_login", "隐藏式授权码登录（用途按名称推断）", "authentication", "static", [120]],
    userinfo: ["oauth2.userinfo", "读取令牌对应的用户信息", "read_only", "static", [120]],
    logout: ["oauth2.logout", "退出 OAuth2 会话", "state_changing", "static", [120]],
    revokeToken: ["oauth2.revoke_token", "撤销令牌", "state_changing", "static", [120]],
    changeStatus: ["oauth2.change_status", "变更会话/账号状态（用途按名称推断）", "state_changing", "static", [120]],
    changeUser: ["oauth2.change_user", "切换用户", "authentication", "static", [120]],
    changeToNatural: ["oauth2.change_to_natural", "切换为自然人身份", "authentication", "static", [120]],
    getSessionList: ["oauth2.get_session_list", "获取会话列表", "read_only", "static", [120]],
    selectLogin: ["oauth2.select_login", "选择登录身份/方式（用途按名称推断）", "authentication", "static", [120]],
    selectRegNumber: ["oauth2.select_reg_number", "选择登记序号（企业选择，用途按名称推断）", "authentication", "static", [120]],
    getDpUrl: ["oauth2.get_dp_url", "获取数据平台地址（用途按名称推断）", "read_only", "static", [120]],
    getDpLogoutUrl: ["oauth2.get_dp_logout_url", "获取数据平台登出地址（用途按名称推断）", "read_only", "static", [120]],
  }[name];
  if (!meta) throw new Error(`tax_api_catalog_oauth2_unknown:${name}`);
  const [suffix, purpose, risk, evidence, lines, observedPath] = meta;
  const extra = evidence === "observed"
    ? { ...sharedGaps([`报告只确认该请求实际发生，${name} 的业务字段未载明`]), responseEvidence: "observed" }
    : sharedGaps(["报告仅在静态清单中列名"]);
  if (name === "getPublicKey") {
    extra.responseEvidence = "observed";
    extra.responseNotes = ["返回临时标识与公钥材料（公钥与标识不保存）", "报告确认为非压缩椭圆曲线公钥形态"];
  }
  return entry(`identity.${suffix}`, "identity.oauth2", purpose, evidence === "observed" ? "POST" : "unknown",
    observedPath ?? `/sys-api/v1.0/auth/oauth2/${name}`, risk, evidence, lines, extra);
}

function passwordEntries() {
  const single = [
    ["account_login", "accountLogin", "账号密码登录", "authentication"],
    ["user_name_psw_login", "userNamePswLogin", "用户名+密码登录", "authentication"],
    ["id_card_psw_login", "idCardPswLogin", "证件号+密码登录", "authentication"],
    ["email_psw_login", "emailPswLogin", "邮箱+密码登录", "authentication"],
  ].map(([id, name, purpose, risk]) => entry(`identity.password.single_${id}`, "identity.password", purpose, "unknown",
    `/sys-api/v1.0/auth/user/single/${name}`, risk, "static", [121],
    { ...sharedGaps(["报告仅列名；未实际触发登录提交（报告 8 节）"]), notes: ["登录类接口：目录层永不自动执行；凭据不入目录"] }));
  const enterprise = [
    ["enterprise_password_login", "passwordLogin", "企业密码登录", "authentication"],
  ].map(([id, name, purpose, risk]) => entry(`identity.password.${id}`, "identity.password", purpose, "unknown",
    `/sys-api/v1.0/auth/enterprise/${name}`, risk, "static", [121],
    { ...sharedGaps(["报告只写出 passwordLogin(ForUser) 分组形态，具体路径取同组列名，未逐字出现在报告中"]),
      notes: ["登录类接口：目录层永不自动执行"] }));
  // 报告 121 行只写 "passwordLogin(ForUser)" 分组形态：全文无末段字面匹配，不补造具体路径。
  const enterpriseForUser = entry("identity.password.enterprise_password_login_for_user", "identity.password",
    "企业密码登录（代办用户场景，用途按名称推断）", "unknown", null, "authentication", "static", [121],
    { ...sharedGaps(["报告只以 passwordLogin(ForUser) 分组列出，未给出独立路径或参数；不补造具体路径",
      `推断候选路径（未采用）：与 passwordLogin 同组，形态按命名推断，均未在报告中逐字出现`]),
      pathEvidence: "unknown",
      notes: ["登录类接口：目录层永不自动执行；凭据不入目录",
        "可能与 passwordLogin 为同一端点的参数变体，登记为独立条目仅为标注缺口，路径未知"] });
  // 合成目录断言：报告只给分组形态时，pathTemplate 必须为空、不能凭空补出具体路径。
  if (enterpriseForUser.pathTemplate !== null || enterpriseForUser.pathKnown || enterpriseForUser.pathEvidence !== "unknown") {
    throw new Error("tax_api_catalog_inferred_path_recorded");
  }
  const agency = entry("identity.password.agency_password_login", "identity.password", "涉税服务机构密码登录", "unknown",
    "/sys-api/v1.0/auth/agency/passwordLogin", "authentication", "static", [121],
    { ...sharedGaps(["报告仅列名"]), notes: ["登录类接口：目录层永不自动执行"] });
  const specific = entry("identity.password.specific_account_login", "identity.password", "特定通道账号登录（用途按名称推断）", "unknown",
    "/sys-api/v1.0/auth/specific/accountLogin", "authentication", "static", [121],
    { ...sharedGaps(["报告仅列名"]), notes: ["登录类接口：目录层永不自动执行"] });
  return [...single, ...enterprise, enterpriseForUser, agency, specific];
}

function smsEntries() {
  const rows = [
    ["identity.sms.single_account_send", "/sys-api/v1.0/auth/user/single/accountSendSmsCode", "账号登录-发送短信验证码", "authentication"],
    ["identity.sms.single_account_verify", "/sys-api/v1.0/auth/user/single/verifySMSCode", "账号登录-校验短信验证码", "authentication"],
    ["identity.sms.message_send", "/sys-api/v1.0/auth/message/sendSmsCode", "发送短信验证码", "authentication"],
    ["identity.sms.enterprise_send", "/sys-api/v1.0/auth/enterprise/sendSmsCode", "企业场景发送短信验证码", "authentication"],
    ["identity.sms.entrance_send", "/sys-api/v1.0/auth/entrance/second/sendSmsCode", "入口二级场景发送短信验证码（用途按名称推断）", "authentication"],
    ["identity.sms.entrance_login", "/sys-api/v1.0/auth/entrance/second/smsCodeLogin", "入口二级场景短信登录（用途按名称推断）", "authentication"],
    ["identity.sms.user_second_send", "/sys-api/v1.0/auth/user/second/sendSmsCodeByUuid", "按临时标识发送短信验证码（用途按名称推断）", "authentication"],
    ["identity.sms.user_second_login", "/sys-api/v1.0/auth/user/second/smsCodeLogin", "短信验证码登录", "authentication"],
  ];
  return rows.map(([id, path, purpose, risk]) => entry(id, "identity.sms", purpose, "unknown", path, risk, "static", [122],
    { ...sharedGaps(["报告仅列名"]), notes: ["登录类接口：目录层永不自动执行；验证码必须人工输入"] }));
}

function qrcodeEntries() {
  return [
    entry("identity.qrcode.create", "identity.qrcode", "生成扫码登录二维码", "POST",
      "/sys-api/v1.0/auth/qrcodeLogin/createQRCode", "authentication", "observed", [76],
      { ...sharedGaps(["报告只记录该请求实际发生"]), responseEvidence: "observed",
        notes: ["登录类接口：目录层永不自动执行；二维码内容属敏感值，不保存"] }),
    entry("identity.qrcode.verify", "identity.qrcode", "轮询扫码登录状态（报告观察约 2 秒一次）", "POST",
      "/sys-api/v1.0/auth/qrcodeLogin/verifyQRCode", "authentication", "observed", [77, 123],
      { ...sharedGaps(["报告只记录轮询间隔与实际发生"]), responseEvidence: "observed",
        notes: ["登录类接口：目录层永不自动执行；轮询不是重试策略，需人工扫码"] }),
    entry("identity.qrcode.verify_its", "identity.qrcode", "校验自有客户端二维码（用途按名称推断）", "unknown",
      "/sys-api/v1.0/auth/qrcodeLogin/verifyItsQRCode", "authentication", "static", [123],
      { ...sharedGaps(["报告仅列名"]), notes: ["登录类接口：目录层永不自动执行"] }),
    entry("identity.qrcode.auth_register", "identity.qrcode", "扫码授权-注册二维码（用途按名称推断）", "unknown",
      "/sys-api/v1.0/auth/qrcodeAuth/registerQRCode", "authentication", "static", [123],
      { ...sharedGaps(["报告在通配分组中列出该名，同组还有未列出的成员"]), notes: ["该分组含未列出的成员（报告以省略号结尾）"] }),
    entry("identity.qrcode.auth_find_by_uid", "identity.qrcode", "扫码授权-按临时标识查二维码（用途按名称推断）", "unknown",
      "/sys-api/v1.0/auth/qrcodeAuth/findQRCodeByUid", "read_only", "static", [123],
      { ...sharedGaps(["报告在通配分组中列出该名"]) }),
    entry("identity.qrcode.auth_change", "identity.qrcode", "扫码授权-变更二维码状态（用途按名称推断）", "unknown",
      "/sys-api/v1.0/auth/qrcodeAuth/changeQRCode", "authentication", "static", [123],
      { ...sharedGaps(["报告在通配分组中列出该名"]) }),
    entry("identity.qrcode.licence_user_login", "identity.qrcode", "执照通道-用户扫码登录（用途按名称推断）", "unknown",
      "/sys-api/v1.0/auth/wh/qrcodeAuth/licence/userLogin", "authentication", "static", [123],
      { ...sharedGaps(["报告在 licence 通配分组中列出该名"]), notes: ["登录类接口：目录层永不自动执行"] }),
    entry("identity.qrcode.licence_zrr_login", "identity.qrcode", "执照通道-自然人扫码登录（用途按名称推断）", "unknown",
      "/sys-api/v1.0/auth/wh/qrcodeAuth/licence/zrrLogin", "authentication", "static", [123],
      { ...sharedGaps(["报告在 licence 通配分组中列出该名"]), notes: ["登录类接口：目录层永不自动执行"] }),
    entry("identity.qrcode.licence_check_result", "identity.qrcode", "执照通道-检查扫码结果（用途按名称推断）", "unknown",
      "/sys-api/v1.0/auth/wh/qrcodeAuth/licence/checkQRCodeResult", "authentication", "static", [123],
      { ...sharedGaps(["报告在 licence 通配分组中列出该名"]) }),
  ];
}

function simpleEntries(moduleId, prefix, rows, lines) {
  return rows.map(([id, name, purpose, risk]) => entry(`identity.${id}`, moduleId, purpose, "unknown", prefix + name, risk,
    "static", lines, { ...sharedGaps(["报告仅列名，协议细节未载明"]), notes: ["认证类接口：目录层永不自动执行"] }));
}

export const CATALOG = Object.freeze(ENTRIES.map((e) => Object.freeze(e)));

const BY_ID = new Map(CATALOG.map((e) => [e.id, e]));
const MODULE_BY_ID = new Map(MODULES.map((m) => [m.id, m]));

export const CATALOG_IDS = Object.freeze(CATALOG.map((e) => e.id));

/** 只接受目录内固定 id；不接受任意 URL、文件路径或任何执行入口。 */
export function getCatalogEntry(id) {
  if (typeof id !== "string" || !id) throw catalogError("catalog_id_required", "必须提供目录接口 id");
  if (!BY_ID.has(id)) throw catalogError("catalog_id_unknown", "该 id 不在已管理目录内");
  return BY_ID.get(id);
}

export function listModules() {
  return MODULES.map((m) => ({
    id: m.id,
    label: m.label,
    service: m.service,
    entryCount: CATALOG.filter((e) => e.module === m.id).length,
    reportLines: [...m.reportLines],
  }));
}

export function catalogError(code, message) {
  const error = new Error(message || code);
  error.code = code;
  return error;
}

// ------------------------------------------------------------------ 契约完整度
const RISK_ORDER = ["read_only", "unknown", "state_changing", "authentication"];

/** 前置条件是否已解析（不要求“需要”，只要求不是 unknown）。 */
function preconditionsResolved(e) {
  return [e.identityDependency?.required, e.enterpriseDependency?.required, e.permissionDependency?.required]
    .every((v) => v !== "unknown");
}

/**
 * 契约完整度（只看目录事实，不代表可调用成功）。
 *
 * full_contract 很严：静态路径 + 方法 + 已载明参数 + 已载明响应 + 身份/企业/权限前置条件
 * 全部有证据，且条目本身不是推断证据。缺任一项就不能叫“完整可调用契约”。
 */
export function contractCompleteness(e) {
  if (!e.pathKnown) return "unknown";
  const methodKnown = e.method !== "unknown";
  const paramsKnown = e.paramsEvidence === "observed";
  const responseKnown = e.responseEvidence === "observed";
  const preconditions = preconditionsResolved(e);
  const evidenceVerified = (e.evidence === "observed" || e.evidence === "static") && e.pathEvidence === "reported";
  if (methodKnown && paramsKnown && responseKnown && preconditions && evidenceVerified) return "full_contract";
  if (methodKnown && paramsKnown) return "method_and_params_documented";
  if (paramsKnown) return "params_documented";
  if (methodKnown && responseKnown && preconditions) return "method_and_response_documented";
  if (methodKnown) return "method_documented";
  return "path_only";
}

/** 完整度缺项明细（供统计与文档引用，不夸大）。 */
export function completenessGaps(e) {
  const gaps = [];
  if (!e.pathKnown) gaps.push("path");
  else if (e.pathEvidence !== "reported") gaps.push("path_inferred");
  if (e.method === "unknown") gaps.push("method");
  if (e.paramsEvidence !== "observed") gaps.push(`params_${e.paramsEvidence}`);
  if (e.responseEvidence !== "observed") gaps.push("response");
  if (e.identityDependency?.required === "unknown") gaps.push("identity_precondition");
  if (e.enterpriseDependency?.required === "unknown") gaps.push("enterprise_precondition");
  if (e.permissionDependency?.required === "unknown") gaps.push("permission_precondition");
  if (e.evidence === "inferred" || e.evidence === "unknown") gaps.push("evidence");
  return gaps;
}

export function entrySummary(e) {
  return {
    id: e.id,
    module: e.module,
    moduleLabel: e.moduleLabel,
    service: e.service,
    purpose: e.purpose,
    purposeEvidence: e.purposeEvidence,
    method: e.method,
    pathTemplate: e.pathTemplate,
    pathEvidence: e.pathEvidence,
    risk: e.risk,
    riskLabel: RISKS[e.risk],
    evidence: e.evidence,
    evidenceLabel: e.evidenceLabel,
    contractCompleteness: contractCompleteness(e),
    completenessGaps: completenessGaps(e),
    paramsEvidence: e.paramsEvidence,
    paramsKnown: e.paramsEvidence === "observed",
    paramsInferred: e.paramsEvidence === "inferred",
    paramCount: e.params.length,
    reportLines: [...e.reportLines],
    catalogManaged: true,
    liveCallVerified: false,
  };
}

export function entryDetail(e) {
  return {
    ...entrySummary(e),
    envelope: e.envelope,
    envelopeContract: ENVELOPES[e.envelope]
      ? { id: e.envelope, label: ENVELOPES[e.envelope].label, fields: [...ENVELOPES[e.envelope].fields],
        headers: [...(ENVELOPES[e.envelope].headers || [])], notes: [...ENVELOPES[e.envelope].notes],
        reportLines: [...ENVELOPES[e.envelope].reportLines] }
      : null,
    params: e.params.map((p) => ({ ...p })),
    paramsEvidenceLabel: e.paramsEvidenceLabel,
    paramGaps: [...e.paramGaps],
    responseEvidence: e.responseEvidence,
    responseNotes: [...e.responseNotes],
    errorNotes: [...e.errorNotes],
    pagination: { ...e.pagination },
    download: e.download,
    identityDependency: { ...e.identityDependency },
    enterpriseDependency: { ...e.enterpriseDependency },
    permissionDependency: { ...e.permissionDependency },
    notes: [...e.notes],
    autoExecutable: e.autoExecutable,
    catalogManaged: true,
    liveCallVerified: false,
  };
}

// ------------------------------------------------------------------ 检索（固定结构条件 + 分页）
const SEARCH_KEYS = Object.freeze(["module", "service", "method", "risk", "evidence", "completeness", "text", "page", "pageSize"]);
export const SEARCH_LIMITS = Object.freeze({ page: [1, 1000], pageSize: [1, 50], text: 64 });
export const SEARCH_COMPLETENESS_VALUES = Object.freeze(Object.keys(COMPLETENESS_TIERS));

/** 错误消息不回显未知键名（键名同样可能携带任意输入）。 */
function rejectUnknownKeys(args, allowed) {
  const unknownCount = Object.keys(args).filter((k) => !allowed.includes(k)).length;
  if (unknownCount) throw catalogError("catalog_filter_invalid", `不接受未登记的检索条件（${unknownCount} 项）`);
}

/** 只回显经过校验的枚举/数值类条件，不回显调用方自由文本或输入对象。 */
function normalizedFilters(values) {
  const out = {};
  for (const key of ["module", "service", "method", "risk", "evidence", "completeness"]) {
    if (values[key] !== undefined) out[key] = values[key];
  }
  // 只回显“是否用过文本检索”和长度，绝不回显文本本身。
  out.textProvided = values.textProvided === true;
  out.textLength = Number.isInteger(values.textLength) ? values.textLength : 0;
  out.textApplied = values.textApplied === true;
  out.page = values.page;
  out.pageSize = values.pageSize;
  return out;
}

export function searchCatalog(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw catalogError("catalog_filter_invalid", "检索条件必须是 JSON 对象");
  }
  rejectUnknownKeys(input, SEARCH_KEYS);
  const page = input.page === undefined ? 1 : input.page;
  const pageSize = input.pageSize === undefined ? 20 : input.pageSize;
  if (!Number.isInteger(page) || page < SEARCH_LIMITS.page[0] || page > SEARCH_LIMITS.page[1]) {
    throw catalogError("catalog_filter_invalid", "page 必须是 1..1000 的整数");
  }
  if (!Number.isInteger(pageSize) || pageSize < SEARCH_LIMITS.pageSize[0] || pageSize > SEARCH_LIMITS.pageSize[1]) {
    throw catalogError("catalog_filter_invalid", "pageSize 必须是 1..50 的整数");
  }
  for (const [key, allowed] of [["method", METHODS], ["risk", Object.keys(RISKS)], ["evidence", Object.keys(EVIDENCE)],
    ["completeness", SEARCH_COMPLETENESS_VALUES]]) {
    if (input[key] !== undefined && (typeof input[key] !== "string" || !allowed.includes(input[key]))) {
      throw catalogError("catalog_filter_invalid", `${key} 只能是：${allowed.join(" / ")}`);
    }
  }
  // 模块/服务条件必须命中已知值，否则 0 结果会被误读为“该模块没有接口”。
  if (input.module !== undefined && (typeof input.module !== "string" || !MODULE_BY_ID.has(input.module))) {
    throw catalogError("catalog_module_unknown", "未知模块 id；先用 tax_api_catalog_modules 查看");
  }
  if (input.service !== undefined
      && (typeof input.service !== "string" || !Object.prototype.hasOwnProperty.call(SERVICES, input.service))) {
    throw catalogError("catalog_filter_invalid", `service 只能是：${Object.keys(SERVICES).join(" / ")}`);
  }
  let text;
  if (input.text !== undefined) {
    if (typeof input.text !== "string" || !input.text.trim() || input.text.length > SEARCH_LIMITS.text) {
      throw catalogError("catalog_filter_invalid", `text 必须是 1..${SEARCH_LIMITS.text} 字符的非空字符串`);
    }
    if (/[:/\\@]|https?/i.test(input.text)) {
      throw catalogError("catalog_arbitrary_input_rejected", "不接受 URL / 路径 / 主机类检索串；请用目录 id 或模块条件");
    }
    text = input.text.trim().toLowerCase();
  }
  const rows = CATALOG.filter((e) => {
    if (input.module !== undefined && e.module !== input.module) return false;
    if (input.service !== undefined && e.service !== input.service) return false;
    if (input.method !== undefined && e.method !== input.method) return false;
    if (input.risk !== undefined && e.risk !== input.risk) return false;
    if (input.evidence !== undefined && e.evidence !== input.evidence) return false;
    if (input.completeness !== undefined && contractCompleteness(e) !== input.completeness) return false;
    if (text && !(`${e.id} ${e.purpose} ${e.pathTemplate ?? ""} ${e.moduleLabel}`.toLowerCase().includes(text))) return false;
    return true;
  });
  const total = rows.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const start = (page - 1) * pageSize;
  const items = start >= total ? [] : rows.slice(start, start + pageSize).map(entrySummary);
  return {
    items,
    page,
    pageSize,
    total,
    pageCount,
    hasMore: start + items.length < total,
    filters: normalizedFilters({
      module: input.module,
      service: input.service,
      method: input.method,
      risk: input.risk,
      evidence: input.evidence,
      completeness: input.completeness,
      textProvided: input.text !== undefined,
      textLength: text ? input.text.trim().length : 0,
      textApplied: text !== undefined,
      page,
      pageSize,
    }),
    catalogManaged: true,
    liveCallVerified: false,
    note: "目录已管理 ≠ 线上调用已验证：本目录只登记静态/观察证据，不做任何请求",
  };
}

// ------------------------------------------------------------------ 参数校验（纯校验，不发请求）
const SENSITIVE_PARAM = /pass|pwd|secret|token|signature|cookie|authorization|credential|privatekey|sess|ticket|captcha|(^|_)code$|^state$/i;
const URL_LIKE = /^(?:[a-z][a-z0-9+.-]*:\/\/|wss?:\/\/|https?:)/i;

/** 值级别的凭据形态（只判断形状，不记录值）：Bearer/Basic 前缀与 JWT 三段式。 */
const CREDENTIAL_VALUE = /^(?:bearer|basic)\s+\S|^eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\./i;

/** 报告未载明参数结构时，不能把“无问题”读成“参数合法”。 */
export function contractGapForParams(e) {
  if (e.paramsEvidence === "unknown") {
    return { code: "parameter_contract_unknown", field: null, message: "报告未载明该接口的参数结构，无法校验任何字段" };
  }
  if (e.paramsEvidence === "envelope_only") {
    return { code: "parameter_contract_envelope_only", field: null, message: "只有共享传输信封已知，信封内业务字段未载明" };
  }
  if (e.paramsEvidence === "inferred") {
    return { code: "parameter_contract_inferred", field: null, message: "参数结构为推断，报告未逐项确认；不能当已验证合同" };
  }
  return null;
}

function typeMatches(value, declared) {
  const types = declared.split("|").map((t) => t.trim());
  return types.some((t) => {
    if (t === "string") return typeof value === "string";
    if (t === "number") return typeof value === "number" && Number.isFinite(value);
    if (t === "boolean") return typeof value === "boolean";
    if (t === "null") return value === null;
    if (t === "object") return !!value && typeof value === "object" && !Array.isArray(value);
    if (t === "array") return Array.isArray(value);
    return false;
  });
}

/**
 * 校验「准备发送的参数」是否落在目录已载明的合同内。
 * 只返回问题码与位置；field 只可能取目录内已载明的参数名或 null，
 * 调用方传入的任意键名 / 任意值一律不回显。
 */
export function validateParams(id, params = {}) {
  const e = getCatalogEntry(id);
  const problems = [];
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    return {
      id: e.id, valid: false, paramsKnown: false, paramsInferred: false,
      problems: [{ code: "params_not_object", field: null, message: "params 必须是对象" }],
      catalogManaged: true, liveCallVerified: false,
    };
  }
  const known = new Map(e.params.map((p) => [p.name, p]));
  const contractGap = contractGapForParams(e);
  if (contractGap) problems.push(contractGap);
  for (const [key, value] of Object.entries(params)) {
    const declared = known.get(key);
    // 只有“目录内已载明的参数名”才允许出现在 field 中；其余一律 field=null。
    const field = declared ? declared.name : null;
    if (declared?.valueAccepted === false) {
      problems.push({ code: "sensitive_parameter_value_rejected", field,
        message: "该参数属凭据/会话/授权码类，只登记依赖，不接受参数值（请在本机安全引用中处理）" });
      continue;
    }
    if (!declared && SENSITIVE_PARAM.test(key)) {
      problems.push({ code: "credential_or_session_field_rejected", field: null,
        message: "不接受凭据/会话/签名类字段（未回显键名）" });
      continue;
    }
    if (typeof value === "string" && URL_LIKE.test(value)) {
      problems.push({ code: "runtime_url_rejected", field, message: "不接受运行时完整地址" });
      continue;
    }
    if (typeof value === "string" && value.length > 512) {
      problems.push({ code: "value_too_long", field, message: "单个参数值超过 512 字符" });
      continue;
    }
    if (typeof value === "string" && CREDENTIAL_VALUE.test(value)) {
      problems.push({ code: "credential_value_rejected", field, message: "不接受凭据形态的参数值" });
      continue;
    }
    if (!declared) {
      problems.push(e.paramsEvidence === "unknown" || e.paramsEvidence === "envelope_only"
        ? { code: "parameter_contract_unknown", field: null, message: "该接口参数结构在报告中未载明，无法校验此字段（未回显键名）" }
        : { code: "parameter_not_in_contract", field: null, message: "该字段不在报告已载明的参数内（未回显键名）" });
      continue;
    }
    if (!typeMatches(value, declared.type)) {
      problems.push({ code: "parameter_type_mismatch", field, message: `该字段类型应为 ${declared.type}` });
    }
  }
  for (const p of e.params) {
    if (p.required === true && !(p.name in params)) {
      problems.push({ code: "required_parameter_missing", field: p.name, message: "报告载明的必填参数缺失" });
    }
  }
  const contractVerified = e.paramsEvidence === "observed";
  return {
    id: e.id,
    valid: problems.length === 0 && contractVerified,
    problemsOnly: problems.length === 0,
    contractVerified,
    paramsEvidence: e.paramsEvidence,
    paramsEvidenceLabel: e.paramsEvidenceLabel,
    declaredParamCount: e.params.length,
    declaredSensitiveParamCount: e.params.filter((p) => p.sensitive).length,
    providedParamCount: Object.keys(params).length,
    problems,
    paramGaps: [...e.paramGaps],
    catalogManaged: true,
    liveCallVerified: false,
    note: "参数校验只比对目录合同；通过校验不代表该企业可用或线上调用会成功；contractVerified=false 时“无问题”仅表示没有可对照的合同",
  };
}

// ------------------------------------------------------------------ 覆盖统计
export function catalogStats() {
  const by = (fn) => CATALOG.reduce((acc, e) => {
    const key = fn(e);
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const completeness = by((e) => contractCompleteness(e));
  const params = by((e) => e.paramsEvidence);
  const count = (fn) => CATALOG.filter(fn).length;
  const modules = listModules();
  const byCompleteness = {};
  for (const tier of Object.keys(COMPLETENESS_TIERS)) byCompleteness[tier] = completeness[tier] || 0;
  return {
    catalogVersion: CATALOG_VERSION,
    // —— 范围：报告明确列举的数量 = 目录登记数（不是“报告自称 200+”的宣称）
    moduleCount: modules.length,
    entryCount: CATALOG.length,
    reportListedEntries: CATALOG.length,
    reportListedModules: modules.length,
    entriesNotListedByReport: 0,
    // —— 路径 / 方法 / 参数 / 响应 / 前置条件缺项（互斥计数可相加核对）
    entriesWithStaticPath: count((e) => e.pathKnown),
    entriesWithoutStaticPath: count((e) => !e.pathKnown),
    entriesWithReportedPath: count((e) => e.pathKnown && e.pathEvidence === "reported"),
    entriesWithInferredPath: count((e) => e.pathKnown && e.pathEvidence === "inferred_from_name"),
    entriesWithKnownMethod: count((e) => e.method !== "unknown"),
    entriesWithUnknownMethod: count((e) => e.method === "unknown"),
    entriesWithDocumentedParams: count((e) => e.paramsEvidence === "observed"),
    entriesWithInferredParams: count((e) => e.paramsEvidence === "inferred"),
    entriesWithSharedEnvelopeOnly: count((e) => e.paramsEvidence === "envelope_only"),
    entriesWithUnknownParams: count((e) => e.paramsEvidence === "unknown"),
    entriesWithoutDocumentedParamContract: count((e) => e.paramsEvidence !== "observed"),
    entriesWithDocumentedResponse: count((e) => e.responseEvidence === "observed"),
    entriesWithUnknownResponse: count((e) => e.responseEvidence !== "observed"),
    entriesWithResolvedIdentityRequirement: count((e) => e.identityDependency?.required !== "unknown"),
    entriesWithUnknownIdentityRequirement: count((e) => e.identityDependency?.required === "unknown"),
    entriesWithResolvedEnterpriseRequirement: count((e) => e.enterpriseDependency?.required !== "unknown"),
    entriesWithUnknownEnterpriseRequirement: count((e) => e.enterpriseDependency?.required === "unknown"),
    entriesWithResolvedPermissionRequirement: count((e) => e.permissionDependency?.required !== "unknown"),
    entriesWithUnknownPermissionRequirement: count((e) => e.permissionDependency?.required === "unknown"),
    // 参数计数分开：只有 paramsEvidence=observed 的才叫“已载明”，推断不得计入。
    documentedParamCount: CATALOG.filter((e) => e.paramsEvidence === "observed")
      .reduce((n, e) => n + e.params.length, 0),
    inferredParamCount: CATALOG.filter((e) => e.paramsEvidence === "inferred")
      .reduce((n, e) => n + e.params.length, 0),
    declaredParamCount: CATALOG.reduce((n, e) => n + e.params.length, 0),
    documentedSensitiveParamCount: CATALOG.filter((e) => e.paramsEvidence === "observed")
      .reduce((n, e) => n + e.params.filter((p) => p.sensitive).length, 0),
    inferredSensitiveParamCount: CATALOG.filter((e) => e.paramsEvidence === "inferred")
      .reduce((n, e) => n + e.params.filter((p) => p.sensitive).length, 0),
    byEvidence: by((e) => e.evidence),
    byPurposeEvidence: by((e) => e.purposeEvidence),
    byMethod: by((e) => e.method),
    byRisk: by((e) => e.risk),
    byCompleteness,
    byParamsEvidence: {
      observed: params.observed || 0,
      inferred: params.inferred || 0,
      envelope_only: params.envelope_only || 0,
      unknown: params.unknown || 0,
    },
    autoExecutableCount: count((e) => e.autoExecutable),
    catalogManagedCount: CATALOG.length,
    liveCallVerifiedCount: 0,
    reportClaimedIdentityEndpoints: 200,
    reportClaimedIdentityEndpointsCatalogued: count((e) => e.service === "identity"),
    reportClaimIsNotCoverage: true,
    coverageScopeNote: "登记数 = 报告明确列出的接口数（29 模块 / 131 条）；参数计数区分 observed / inferred / declared；不宣称已实现全站 200+ 端点或全部业务模块",
    timeoutNote: "timeoutMs 为本地策略默认值（只读 15s / 其他 30s），不是税局 SLA 或官方时限",
    note: "报告自称认证平台 200+ 端点，但只分类列举了其中一部分；本目录不把未列名的端点当作已登记",
  };
}

export function moduleStats(moduleId) {
  if (!MODULE_BY_ID.has(moduleId)) throw catalogError("catalog_module_unknown", "未知模块 id");
  return { module: MODULE_BY_ID.get(moduleId), entries: CATALOG.filter((e) => e.module === moduleId).map(entrySummary) };
}

/** 风险排序：登录/写操作永远排在最后，便于调用方一眼看出「不可自动执行」。 */
export function riskRank(risk) {
  const i = RISK_ORDER.indexOf(risk);
  return i < 0 ? RISK_ORDER.length : i;
}
