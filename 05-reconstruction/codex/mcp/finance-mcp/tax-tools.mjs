/**
 * tax-tools.mjs — 全国电子税务局适配层的 MCP 工具契约
 *
 * 第一期只预留接口：这些工具在后端注册表（06-workbench/server/agent-tools.mjs）里已经实现，
 * 但默认没有任何地区适配器被注册，因此登录类调用会返回结构化「未接入」错误，
 * 不会伪造会话或返回假数据。专用浏览器工具可打开官方登录窗口并发起固定只读请求，
 * 但只返回结构摘要，不代表已验证业务适配器。
 *
 * 契约状态用 available（本地已实现该接口），origin 用 local（本地扩展，不在原站 catalog 内）。
 * 「是否已接入某地区」由 tax_regions / tax_capabilities 的真实返回值表达，不写死在这里。
 */

const obj = (properties, required = []) => ({ type: "object", properties, required });

const SESSION_ID = { type: "string", description: "会话 ID（tax_login_start 返回；不可猜，进程内存态）" };
const ACCOUNT_SET_ID = { type: ["integer", "string"], description: "本地账套 ID（可选；提供时必须真实存在，会话会绑定该账套）" };
const REGION = {
  type: "string",
  description: '税务服务地区标识：大陆 31 个省级行政区六位码（如 "440000" 广东省）'
    + '，或 5 个计划单列市六位码（210200 大连 / 330200 宁波 / 350200 厦门 / 370200 青岛 / 440300 深圳）。'
    + '"CN"（全国）只是产品入口，不能作为登录目标；港澳台不在本期目录内。',
};

const available = (name, description, inputSchema) =>
  ({ name, description, inputSchema, status: "available", origin: "local" });

export const TAX_TOOLS = [
  available("tax_history_collect", "按本机管理员绑定的contextRef取回固定已观察历史申报查询，仅返回安全引用和覆盖摘要。默认关闭；不推断待办、稳定业务身份或全历史。",
    {...obj({contextRef:{type:"string",pattern:"^taxhistorycontext_[a-f0-9]{48}$"}},["contextRef"]),additionalProperties:false}),
  available("tax_history_compare", "比较同一上下文两个独立取回的私有历史查询白名单投影和内容多重集，仅返回计数和布尔，不认定业务身份或更正关系。",
    {...obj({leftRef:{type:"string",pattern:"^taxhistoryrun_[a-f0-9]{48}$"},rightRef:{type:"string",pattern:"^taxhistoryrun_[a-f0-9]{48}$"}},["leftRef","rightRef"]),additionalProperties:false}),
  available("tax_live_collect", "按本机管理员新导航形成的sourceRef重复只读采集当前企业上下文与当前申报清单，仅返回安全引用、企业一致性与部分覆盖。默认关闭；期间仍待核实。",
    {...obj({sourceRef:{type:"string",pattern:"^taxsource_[a-f0-9]{48}$"}},["sourceRef"]),additionalProperties:false}),
  available("tax_live_compare", "本机比较两次只读采集的白名单投影，只返回企业相等、清单相等及覆盖状态，不返回业务原值。",
    {...obj({leftRef:{type:"string",pattern:"^tax(?:source|run)_[a-f0-9]{48}$"},rightRef:{type:"string",pattern:"^tax(?:source|run)_[a-f0-9]{48}$"}},["leftRef","rightRef"]),additionalProperties:false}),
  available("tax_browser_open", "打开本机专用 Edge 官方窗口，需操作者人工登录。使用独立临时目录，不复制已有登录态；仅返回连接引用，不创建已认证税务会话。",
    { ...obj({ region: { type: "string", enum: ["350000"] } }, ["region"]), additionalProperties: false }),
  available("tax_browser_probe", "检查专用窗口并对已观察的福建身份读取路径发起一次实际只读请求。仅返回安全结构与状态，schema_unverified 不代表登录或业务成功。",
    { ...obj({ connectionId: { type: "string", pattern: "^taxb_[a-f0-9]{48}$" } }, ["connectionId"]), additionalProperties: false }),
  available("tax_browser_close", "关闭本工具自己启动的专用浏览器并清理本次临时目录；不等于税局服务端退出，不关闭其他浏览器。",
    { ...obj({ connectionId: { type: "string", pattern: "^taxb_[a-f0-9]{48}$" } }, ["connectionId"]), additionalProperties: false }),
  available("tax_session_verify", "实际验证当前会话企业与授权范围；只返回安全引用。无已验证适配器则明确拒绝。",
    { ...obj({ sessionId: SESSION_ID }, ["sessionId"]), additionalProperties: false }),
  available("tax_resource_collect", "按已验证只读契约重新采集指定期间资源，只返回覆盖摘要与来源引用。无真实适配器时不伪造成功。",
    { ...obj({ sessionId: SESSION_ID, resource: { type: "string" }, period: { type: "string", pattern: "^\\d{4}-(0[1-9]|1[0-2])$" } }, ["sessionId", "resource", "period"]), additionalProperties: false }),
  available("tax_resource_coverage", "查询当前企业期间的资源覆盖、未取得和不支持状态，不返回企业身份或金额。",
    { ...obj({ sessionId: SESSION_ID, period: { type: "string" } }, ["sessionId", "period"]), additionalProperties: false }),
  available("tax_account_set_link", "关联操作者明确指定的已有本地账套；仅内存引用，不建账、不导入，不声称自动核对企业身份。",
    { ...obj({ sessionId: SESSION_ID, accountSetId: ACCOUNT_SET_ID }, ["sessionId", "accountSetId"]), additionalProperties: false }),
  available("tax_preparation_build", "读取关联账套可得性并生成申报准备缺项和校验摘要。规则与表单尚未验证时严格阻断，永不执行申报或缴款。",
    { ...obj({ sessionId: SESSION_ID, period: { type: "string" } }, ["sessionId", "period"]), additionalProperties: false }),
  available("tax_regions",
    "查询税务接口契约与区域接入状态。大陆税务服务目录 = 31 个省级行政区 + 5 个计划单列市；"
    + "全国（CN）只是产品入口、不是税务目标；港澳台单列为 out_of_scope（不同税务管辖体系）。"
    + "configured=false 表示当前进程未注册该地区适配器，绝不代表已接入真实电子税务局。",
    obj({})),

  available("tax_capabilities",
    "查询某地区/适配器的能力声明（支持的登录方式、可查询资源、可处理的验证动作）。"
    + "未接入地区同样返回，但 configured=false，adapters 为空。",
    obj({ region: REGION, adapterId: { type: "string", description: "可选：该地区下指定适配器" } }, ["region"])),

  available("tax_login_start",
    "发起办税员登录。默认未接入任何地区，未配置时直接返回结构化错误，不创建会话、不伪造已认证。"
    + "生产凭据只接受 credentialRef 引用；传明文账号/密码会被拒绝。",
    obj({
      region: REGION,
      adapterId: { type: "string", description: "可选：该地区有多个适配器时必须显式指定" },
      loginMethod: { type: "string", description: "可选：登录方式，取值须在该适配器声明内（如 sms / qrcode / realname）" },
      accountSetId: ACCOUNT_SET_ID,
      enterprise: { type: "object", description: "可选：绑定企业 { enterpriseId?, name? }（纳税人识别号等敏感字段不接收）" },
      credentialRef: { type: "string", description: "可选：凭据引用（不是明文）；网关只存内存引用，不回显" },
    }, ["region"])),

  available("tax_login_status",
    "查询登录会话状态：requires_action / authenticated / expired / failed / logged_out。"
    + "requires_action 时返回适配器定义的 challenge（人工验证动作），网关不会代为完成验证。",
    obj({ sessionId: SESSION_ID }, ["sessionId"])),

  available("tax_login_challenge",
    "提交人工验证响应（验证码/扫码确认/实名确认等，动作由适配器定义）。"
    + "response 仅交给适配器判定，不持久化、不回显；网关没有任何跳过人工验证的分支。",
    obj({
      sessionId: SESSION_ID,
      action: { type: "string", description: "待处理验证动作，须与 tax_login_status 返回的 challenge.action 一致" },
      response: { type: ["string", "number", "boolean", "object"], description: "人工验证结果（敏感，仅透传适配器）" },
    }, ["sessionId", "action", "response"])),

  available("tax_logout",
    "退出登录会话。退出后该会话不能再查询任何资源；重复退出返回 logged_out 且不报错。",
    obj({ sessionId: SESSION_ID }, ["sessionId"])),

  available("tax_info_query",
    "按会话查询税局信息资源（identity / authorized_enterprises / enterprise_profile / "
    + "tax_assessments / declaration_status）。必须已认证，且严格按会话绑定的地区、账套与企业查询，"
    + "跨地区/跨账套一律拒绝；未认证、资源不支持、适配器未接入都返回结构化错误。"
    + "params 只接受与资源本身有关的标量参数（period / startPeriod / endPeriod / taxType / "
    + "declarationType / status / page / pageSize）；账套、地区、企业标识只能来自会话上下文，"
    + "通过 params 覆盖会被拒绝。",
    obj({
      sessionId: SESSION_ID,
      resource: { type: "string", description: "资源类型；可用取值见 tax_regions.contract.resources" },
      params: {
        type: "object",
        description: "可选：资源查询附加参数（平面白名单，仅标量；period / taxType 等。"
          + "禁止传账套/地区/企业等作用域字段，被绑定企业标识只来自会话上下文）",
      },
      region: { type: "string", description: "可选：仅用于与会话绑定地区做一致性校验，不能用来切换地区" },
      accountSetId: ACCOUNT_SET_ID,
    }, ["sessionId", "resource"])),
];

export const TAX_TOOL_NAMES = TAX_TOOLS.map((t) => t.name);
