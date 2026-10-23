/**
 * tools.mjs — finance-mcp 的工具契约（名称、描述、参数 schema、真实可用状态）
 *
 * 这里同时承担两件事：
 *   1) 向 MCP 客户端公布工具清单与 JSON Schema；
 *   2) 对入参做最小运行时校验，避免把明显无效的调用转发给后端。
 *
 * 可用状态分三档：
 *   - available   ：本地后端已实现，可真实完成业务；
 *   - limited     ：可调用但行为受限（例如 update_plan 只回显、不持久化）；
 *   - unavailable ：本地未实现，调用必须返回 isError，绝不伪装成功。
 */
import { TAX_TOOLS } from "./tax-tools.mjs";

export class ToolCallError extends Error {
  constructor(code, message, details = null) {
    super(message || code);
    this.name = "ToolCallError";
    this.code = code;
    this.details = details;
  }
}

// ---------------------------------------------------------------- schema 片段
const ACCOUNT_SET_ID = { type: ["integer", "string"], description: "账套 ID（必填，不猜默认账套）" };
const PERIOD = { type: "string", description: "会计期间，格式 YYYY-MM" };
const ENTRIES = {
  type: "array",
  description: "分录数组，每项 { code, debit, credit, summary? }；借贷必须平衡",
  items: {
    type: "object",
    properties: {
      code: { type: "string", description: "科目编码" },
      debit: { type: "number" },
      credit: { type: "number" },
      summary: { type: "string" },
    },
    required: ["code"],
  },
};

const obj = (properties, required = []) => ({ type: "object", properties, required });

// ---------------------------------------------------------------- 工具清单
const available = (name, description, inputSchema, origin = "upstream") =>
  ({ name, description, inputSchema, status: "available", origin });
const limited = (name, description, inputSchema, origin = "upstream") =>
  ({ name, description, inputSchema, status: "limited", origin });
const unavailable = (name, description, origin = "upstream") =>
  ({ name, description, inputSchema: obj({}), status: "unavailable", origin });

/** 后端已实现（含本轮正式注册的 4 个扩展工具与 11 个新增管理工具）。 */
const BACKEND_TOOLS = [
  available("account_context", "列出账套（可选带出某账套的期间）。本地不保存“当前账套”，不返回选中状态。",
    obj({
      accountSetId: { ...ACCOUNT_SET_ID, description: "可选：一并返回该账套的期间" },
      limit: { type: "integer", minimum: 1, maximum: 32, description: "可选：账套列表分页大小（默认 10，上限 32）" },
      offset: { type: "integer", minimum: 0, description: "可选：账套列表分页偏移（用于有界翻页后选择账套）" },
    })),
  available("finance_context_resolve", "account_context 的兼容别名：列出账套与可选期间。",
    obj({
      accountSetId: { ...ACCOUNT_SET_ID, description: "可选：一并返回该账套的期间" },
      limit: { type: "integer", minimum: 1, maximum: 32, description: "可选：账套列表分页大小（默认 10，上限 32）" },
      offset: { type: "integer", minimum: 0, description: "可选：账套列表分页偏移（用于有界翻页后选择账套）" },
    })),
  available("finance_query", "查询财务数据。必须显式提供 accountSetId；期间类能力必须显式提供 period。可用能力见 finance_query_catalog。",
    obj({
      nodeId: { type: "string", description: "查询能力 ID，例如 report.balance_sheet" },
      accountSetId: ACCOUNT_SET_ID,
      period: PERIOD,
      params: { type: "object", description: "附加参数，如 voucher.detail 的 { voucherId }、ledger.general 的 { code }" },
    }, ["nodeId", "accountSetId"])),

  available("voucher_check", "只校验凭证分录（借贷平衡、科目存在），不落库。",
    obj({ accountSetId: ACCOUNT_SET_ID, entries: ENTRIES }, ["accountSetId", "entries"])),
  available("voucher_create", "创建凭证：支持明确的 period / voucher_date / entries / status；status 缺省为 draft。",
    obj({
      accountSetId: ACCOUNT_SET_ID,
      period: PERIOD,
      voucher_date: { type: "string", description: "凭证日期 YYYY-MM-DD，缺省为期间首日" },
      summary: { type: "string" },
      word: { type: "string", description: "凭证字，缺省 记" },
      number: { type: "integer", description: "凭证号，缺省自动取号" },
      status: { type: "string", enum: ["draft", "posted"], description: "缺省 draft（草稿）" },
      entries: ENTRIES,
    }, ["accountSetId", "period", "entries"])),

  available("legacy_book_import", "导入旧账：账套 + 科目 + 期初 + 历史凭证。默认 dryRun=true 只预检，必须显式 dryRun=false 才落库。",
    obj({
      dryRun: { type: "boolean", description: "缺省 true=仅预检；显式 false=正式导入" },
      payload: { type: "object", description: "{account_set, accounts, opening_balances, vouchers}" },
      texts: { type: "object", description: "CSV 文本：{meta, accounts, openings, vouchers}" },
      paths: { type: "object", description: "本机 CSV 路径：{meta, accounts, openings, vouchers}" },
      files: { type: "object", description: "CSV base64：{meta, accounts, openings, vouchers}" },
      encoding: { type: "string", description: "files 解码编码，如 utf-8 / gbk" },
      meta: { type: "object", description: "覆盖账套信息：{name, taxpayer_type, accounting_standard, start_period}" },
    })),

  available("book_import_incremental",
    "增量导入：以稳定规范企业身份 + 批次 ID 首次建账或向已有账套追加。产品口径是一家企业只有一个账套：同一 enterpriseKey 即使来自另一个来源也必须追加到已有账套，不得新建第二本；同一账套也不得绑定另一家企业。同批重试幂等、同来源凭证按内容指纹去重、内容修订 / 来源凭证被反过账或被删除 / 身份不符 / 封账期间 / 期初覆盖返回结构化冲突（不静默覆盖）。默认 dryRun=true 只预检，必须显式 dryRun=false 才落库。",
    obj({
      dryRun: { type: "boolean", description: "缺省 true=仅预检（不写任何表）；显式 false=正式导入" },
      batchId: { type: "string", description: "调用方稳定批次 ID；同批重试不重复记账，内容变化拒绝" },
      source: obj({
        system: { type: "string", description: "来源系统标识，例如旧账来源名" },
        enterpriseKey: { type: "string", description: "稳定规范企业身份（如统一社会信用代码）；不得用可改的账套名称代替；一家企业一个账套" },
        enterpriseName: { type: "string", description: "企业名称（仅展示，不参与身份判定）" },
      }, ["system", "enterpriseKey"]),
      mode: { type: "string", enum: ["create", "append"], description: "create=首次建账（缺省，已有同企业账套时拒绝并引导追加）；append=向 accountSetId 追加" },
      accountSetId: { ...ACCOUNT_SET_ID, description: "append 必填：目标账套 ID（必须已属同一企业身份）" },
      confirmNewBinding: { type: "boolean", description: "append 时为本来源登记来源证据；企业身份必须与账套既有绑定一致" },
      payload: { type: "object", description: "{account_set, accounts, opening_balances, vouchers}；vouchers 项可带 sourceVoucherId" },
      texts: { type: "object", description: "CSV 文本：{meta, accounts, openings, vouchers}" },
      files: { type: "object", description: "CSV base64：{meta, accounts, openings, vouchers}" },
      encoding: { type: "string", description: "files 解码编码，如 utf-8 / gbk" },
      meta: { type: "object", description: "覆盖账套信息：{name, taxpayer_type, accounting_standard, start_period}" },
    }, ["batchId", "source"]), "local"),

  available("book_import_batch",
    "查询增量导入批次结果与逐张来源凭证追踪（只读；含当前凭证存在 / posted / 内容一致的核验状态；新建与去重命中的来源凭证都按批次留痕，含纯去重批次）。",
    obj({ batchId: { type: "string", description: "批次 ID" } }, ["batchId"]), "local"),

  // ---- 账套 / 科目 / 期初 / 期间 ----
  available("account_set_create", "新建账套并自动载入标准科目。",
    obj({
      name: { type: "string", description: "账套名称" },
      start_period: PERIOD,
      taxpayer_type: { type: "string", description: "缺省 小规模纳税人" },
      accounting_standard: { type: "string", description: "缺省 小企业会计准则" },
    }, ["name", "start_period"]), "local"),
  available("account_list", "列出账套下的科目。",
    obj({ accountSetId: ACCOUNT_SET_ID }, ["accountSetId"]), "local"),
  available("account_create", "新增明细科目。",
    obj({
      accountSetId: ACCOUNT_SET_ID,
      code: { type: "string" },
      name: { type: "string" },
      category: { type: "string", enum: ["资产", "负债", "权益", "成本", "损益"] },
      direction: { type: "string", enum: ["debit", "credit"] },
    }, ["accountSetId", "code", "name", "category", "direction"]), "local"),
  available("opening_balance_get", "查询期初余额。",
    obj({ accountSetId: ACCOUNT_SET_ID }, ["accountSetId"]), "local"),
  available("opening_balance_set", "保存期初余额（按科目覆盖写入）。",
    obj({
      accountSetId: ACCOUNT_SET_ID,
      items: {
        type: "array",
        description: "期初余额数组，每项 { code, debit, credit }",
        items: { type: "object", properties: { code: { type: "string" }, debit: { type: "number" }, credit: { type: "number" } }, required: ["code"] },
      },
    }, ["accountSetId", "items"]), "local"),
  available("period_list", "列出账套已登记的期间及状态。",
    obj({ accountSetId: ACCOUNT_SET_ID }, ["accountSetId"]), "local"),
  available("period_set_status", "结账/反结账：closed 会在原有“无草稿 + 试算平衡”之外校验应计提完整、卡片与总账核对、损益/年末结转与连续期间顺序（不适用项明确标 not_applicable）；open 重开或登记新期间；已有更晚期间封账时拒绝重开前期。",
    obj({
      accountSetId: ACCOUNT_SET_ID,
      period: PERIOD,
      status: { type: "string", enum: ["open", "closed"] },
    }, ["accountSetId", "period", "status"]), "local"),

  // ---- 凭证状态流转 ----
  available("voucher_post", "过账草稿凭证。",
    obj({ accountSetId: ACCOUNT_SET_ID, voucherId: { type: ["integer", "string"] } }, ["accountSetId", "voucherId"]), "local"),
  available("voucher_unpost", "反过账：把已过账凭证退回草稿。",
    obj({ accountSetId: ACCOUNT_SET_ID, voucherId: { type: ["integer", "string"] } }, ["accountSetId", "voucherId"]), "local"),
  available("voucher_delete", "删除凭证（仅草稿；已过账需先反过账）。",
    obj({ accountSetId: ACCOUNT_SET_ID, voucherId: { type: ["integer", "string"] } }, ["accountSetId", "voucherId"]), "local"),

  // ---- 查账 ----
  available("ledger_query", "查询某科目在指定期间的明细账（含期初、逐笔余额）。",
    obj({ accountSetId: ACCOUNT_SET_ID, code: { type: "string", description: "科目编码" }, period: PERIOD },
      ["accountSetId", "code", "period"]), "local"),

  // ---- 后端已有、本轮正式注册（本地扩展，非原站契约工具）----
  available("asset_list", "列出固定资产/无形资产卡片及已计提金额（含补项期初累计、可计提额、剩余额与未入账登记状态）。",
    obj({ accountSetId: ACCOUNT_SET_ID }, ["accountSetId"]), "local"),
  available("asset_create", "新增固定资产/无形资产卡片。可显式登记 acquired_period（取得/入账期间，不臆造日期）、opening_accumulated（历史期初累计）、ledger_status=pending_purchase_voucher + ledger_note（本机“尚未入固定资产账”显式登记）。新增卡片会改变受影响期间的核对 / 计提事实：已封账期间、或后续已过账普通损益结转时明确拒绝并给撤销顺序（asset_card_affects_closed_period / later_profit_carryforward_depends_on_period）。pending_purchase_voucher **不是**原值差异豁免：登记后仍要求总账原值一致，且不得计提。",
    obj({
      accountSetId: ACCOUNT_SET_ID,
      kind: { type: "string", enum: ["fixed", "intangible"], description: "缺省 fixed" },
      name: { type: "string" },
      original_cost: { type: "number", description: "原值（精确到分；超过 999999999999.99 拒绝）" },
      useful_life_months: { type: "integer", minimum: 1, maximum: 1200, description: "计提期数（1 ~ 1200 期）。这是技术输入边界，不冒充法定会计年限；非整数 / 0 / 超上限一律拒绝" },
      start_period: PERIOD,
      residual_rate: { type: "number", description: "残值率，固定资产缺省 0.05，无形资产缺省 0" },
      asset_account: { type: "string" },
      accum_account: { type: "string" },
      expense_account: { type: "string", description: "折旧/摊销费用科目，缺省 5602" },
      acquired_period: PERIOD,
      opening_accumulated: { type: "number", description: "补项期初累计（已入账的历史累计折旧/摊销）" },
      ledger_status: { type: "string", enum: ["booked", "pending_purchase_voucher"], description: "booked（缺省，参与卡片/总账核对）/ pending_purchase_voucher（显式登记未入固定资产账）" },
      ledger_note: { type: "string", description: "ledger_status 非 booked 时必须说明原因" },
    }, ["accountSetId", "name", "original_cost", "useful_life_months", "start_period"]), "local"),
  available("asset_update",
    "资产卡片维护 / 补项：修改名称、费用科目、取得期间、期初累计、未入账登记。按实际影响守卫：受影响期间已封账拒绝（asset_card_affects_closed_period）；已有已过账计提时禁改原值 / 残值率 / 寿命 / 计提开始期间 / 期初累计 / 科目 / 账簿状态（asset_card_locked_by_posted_runs）；会改变折旧金额且后续已有已过账普通结转时拒绝（later_profit_carryforward_depends_on_period）。名称 / 备注等纯显示信息不受影响。",
    obj({
      accountSetId: ACCOUNT_SET_ID,
      assetId: { type: ["integer", "string"] },
      patch: { type: "object", description: "待修改字段：{name?, expense_account?, acquired_period?, opening_accumulated?, ledger_status?, ledger_note?}" },
    }, ["accountSetId", "assetId"]), "local"),
  available("period_end_check",
    "期末检查（只读）：逐步返回草稿清零、试算平衡、应计提折旧/摊销完整、资产卡片与总账核对、损益结转、年末结转、连续期间顺序的状态与适用/不适用理由，以及阻塞项与明确缺项。连续期间不只按凭证判断：更早期间有应计提而零凭证同样阻塞（previous_period_depreciation_pending）。已过账计提仍按卡片当前定义重算，定义已变的旧计提报 depreciation_run_stale（不按“曾经过账”放行）。与封账前置共用同一规则，不连接税局。",
    obj({ accountSetId: ACCOUNT_SET_ID, period: PERIOD }, ["accountSetId", "period"]), "local"),
  available("depreciation_run", "对全部资产卡片按直线法计提指定期间折旧/摊销，生成一张凭证。同期不重复计提；累计舍入在应有寿命内恰好提足；未入固定资产账的卡片明确拒绝（asset_ledger_pending），全局累计会超出可计提额时明确拒绝（depreciation_global_over_depreciable）并给撤销顺序。旧定义下的已过账计提（寿命 / 原值 / 期间等已变）不会被当成已计提完成或静默补提，而是返回 depreciation_run_stale 并要求反过账 + 删除后重算。",
    obj({ accountSetId: ACCOUNT_SET_ID, period: PERIOD }, ["accountSetId", "period"]), "local"),
  available("carry_forward_profit", "结转本期损益到 3103；yearEnd=true 时再结转 3103→3104。普通结转读取截至本期的累计损益余额，因此更晚期间已有已过账结转时，前期写入会被拒绝（later_profit_carryforward_depends_on_period），需按倒序撤销后重做。",
    obj({ accountSetId: ACCOUNT_SET_ID, period: PERIOD, yearEnd: { type: "boolean" } }, ["accountSetId", "period"]), "local"),

  // ---- 兼容入口：行为受限，但不谎报 ----
  limited("update_plan", "更新处理计划。本地分支不持久化，模型通道只回状态与条数（不回显计划文本），返回 persisted=false。",
    obj({ plan: { type: "array", description: "计划步骤数组（只计条数，不回显内容）" } })),
];

/** 原站契约内、本地未实现的工具：保留名称，调用返回 isError。 */
const PLACEHOLDER_TOOLS = [
  ["invoice_collect", "采集发票（未实现：需对接发票数据源）"],
  ["invoice_file", "获取发票原件（未实现：需对接发票数据源）"],
  ["invoice_issue", "开具发票（未实现：无开票服务通道）"],
  ["invoice_issue_result", "查询开票结果（未实现：无开票服务通道）"],
  ["invoice_precheck", "开票预检（未实现：无开票服务通道）"],
  ["invoice_red_apply", "申请红字信息表（未实现：无开票服务通道）"],
  ["invoice_red_issue", "开具红字发票（未实现：无开票服务通道）"],
  ["invoice_red_status", "查询红字状态（未实现：无开票服务通道）"],
  ["invoice_tax_code", "筛选税收分类编码（未实现：编码库未接入）"],
  ["declaration_query", "查询申报状态（未实现：无税局通道）"],
  ["tax_declaration_query", "查询申报状态（未实现：无税局通道）"],
  ["exec", "运行命令（未实现：finance 后端无执行分支，与 Codex 命令工具无关）"],
  ["finance_task_status", "查询财税任务状态（未实现：本地无异步任务系统，不能返回 completed）"],
].map(([name, description]) => unavailable(name, description));

/**
 * 接口目录（现成材料整理）。只做检索/校验/准备/分类，不发请求、不接受任意 URL，
 * 不执行登录或写操作。catalogManaged=true 永远伴随 liveCallVerified=false：
 * 目录已管理 ≠ 线上调用已验证。
 */
const CATALOG_TOOLS = [
  available("tax_api_catalog_modules",
    "列出已整理的税局接口目录模块与覆盖计数（模块数/条目数/方法/参数/响应/前置条件缺口计数/证据分布）。"
    + "可传 moduleId 查看单模块条目。目录只收录现成分析报告明确列举的接口：29 模块 / 131 条，不代表全国/全站完整，也不代表报告自称的 200+ 端点已实现。",
    obj({ moduleId: { type: "string", description: "可选：返回该模块的条目摘要列表" } }), "local"),
  available("tax_api_catalog_search",
    "分页检索接口目录（固定结构条件：module/service/method/risk/evidence/completeness/text + page/pageSize）。"
    + "不接受任意 URL、源码或正则；结果始终标记 catalogManaged 与 liveCallVerified。",
    obj({
      module: { type: "string", description: "模块 id，见 tax_api_catalog_modules" },
      service: { type: "string", enum: ["portal", "identity", "behavior", "service_desk"] },
      method: { type: "string", enum: ["GET", "POST", "unknown"] },
      risk: { type: "string", enum: ["read_only", "state_changing", "authentication", "unknown"] },
      evidence: { type: "string", enum: ["observed", "static", "inferred", "unknown"] },
      completeness: { type: "string", enum: ["full_contract", "method_and_params_documented", "method_and_response_documented",
        "method_documented", "params_documented", "path_only", "unknown"],
        description: "契约完整度：full_contract 需路径+方法+参数+响应+前置条件均有证据，当前目录为 0 条" },
      text: { type: "string", description: "1..64 字符关键词（id/用途/路径/模块名子串，不接受 URL）" },
      page: { type: "integer", description: "1..1000，缺省 1" },
      pageSize: { type: "integer", description: "1..50，缺省 20" },
    }), "local"),
  available("tax_api_catalog_entry",
    "读取单个接口的合同详情：方法、静态路径模板、参数（键/类型/必填/来源）、身份/企业/权限依赖、"
    + "响应与错误约定、分页/下载依赖、操作风险、证据类别与报告行号。未载明的字段明确标 unknown。",
    obj({ id: { type: "string", description: "目录接口 id（tax_api_catalog_search 返回）" } }, ["id"]), "local"),
  available("tax_api_catalog_validate",
    "只校验准备发送的参数是否落在目录已载明的合同内（必填/类型/未知字段/凭据与运行时地址拒绝）。"
    + "含凭据/会话/授权码类参数只登记依赖，不接受参数值；字段位置不回显任意键名。"
    + "通过校验不代表该企业可用或调用会成功；contractVerified=false 时“无问题”仅表示没有可对照合同。",
    obj({
      id: { type: "string" },
      params: { type: "object", description: "待校验参数（键值不可含凭据、令牌或运行时完整地址）" },
    }, ["id"]), "local"),
  available("tax_api_catalog_prepare",
    "调用准备检查：校验参数、账号/企业/期间引用与权限声明，返回 not_ready / blocked_by_policy / "
    + "contract_ready_adapter_missing 与具体缺项。不连接税局、不实现代理、不伪造请求；登录与写接口一律阻断。"
    + "引用与权限只做格式校验：不核实企业归属、会话有效性或权限授予（unverified）。",
    obj({
      id: { type: "string" },
      params: { type: "object" },
      context: {
        type: "object",
        description: "接入上下文引用（仅格式校验、均未核实）：{accountSetId?(严格正整数), enterpriseRef?, loginSessionRef?, period?, permissions?, operatorConfirmed?}",
      },
    }, ["id"]), "local"),
  available("tax_api_catalog_classify",
    "按证据分类一次调用的结果：未发出 / 传输超时 / 传输失败 / 已收待解析 / 认证要求 / 明确无权限 / "
    + "业务空结果 / 成功 / 结构不识别 / 业务错误。只接受安全观察摘要（布尔/计数/枚举，严格校验类型与范围，"
    + "矛盾元数据判 structure_unrecognized），不接受也不返回响应体或错误原文。本工具不推断全局登录状态（恒为 unknown），"
    + "真实全局会话校验使用既有 tax_session_verify。timeoutMs 为本地策略默认值，不是税局 SLA。",
    obj({
      risk: { type: "string", enum: ["read_only", "state_changing", "authentication", "unknown"], description: "来自目录条目的操作风险，决定超时阈值与重试能力" },
      observation: { type: "object", description: "安全观察摘要；未知字段会被拒绝" },
      results: { type: "array", description: "可选：多个已分类结果的汇总（只计数，不出全局会话结论）" },
    }), "local"),
  available("tax_api_catalog_outcomes",
    "列出结果分类枚举与分类规则（供 Agent 解释结论口径）。", obj({}), "local"),
];

/** 纯本地工具（不经后端）。 */
const LOCAL_TOOLS = [
  available("finance_query_catalog", "列出财务查询能力的安全静态目录：可用 / 未实现 / 本地扩展 nodeId 与计数（代码常量，无业务数据）。", obj({}), "local"),
  available("skills_list", "查找可用财税业务规则(Skill)文件。", obj({}), "local"),
  available("skills_read", "读取业务规则(Skill) Markdown 正文。",
    obj({ resource: { type: "string", description: "Skill 相对路径，例如 bookkeeping/SKILL.md" } }, ["resource"]), "local"),
];

/**
 * LOCAL-08：普通财务工具固定走模型投影通道（`POST /agent/model-tools/<name>`）。
 * 这里是与 `06-workbench/server/finance-model-adapter.mjs` 交叉核对的 MCP 侧登记表；
 * 税务 / 目录工具与 skills 资源工具**不在**此列，仍走既有 `/agent/tools/*` 或本地资源读取。
 */
export const MODEL_PLAIN_TOOL_NAMES = Object.freeze([
  "finance_query_catalog", "update_plan",
  "account_context", "finance_context_resolve", "finance_query",
  "voucher_check", "account_list", "opening_balance_get", "period_list",
  "ledger_query", "asset_list", "period_end_check", "book_import_batch",
  "voucher_create", "voucher_post", "voucher_unpost", "voucher_delete",
  "period_set_status", "opening_balance_set", "account_create",
  "asset_create", "asset_update", "depreciation_run", "carry_forward_profit",
  "account_set_create", "legacy_book_import", "book_import_incremental",
]);

/** 写动作子集：运输失败必须保守给 writeOutcome:unknown（不自动重试）。 */
export const MODEL_WRITE_TOOL_NAMES = Object.freeze([
  "voucher_create", "voucher_post", "voucher_unpost", "voucher_delete",
  "period_set_status", "opening_balance_set", "account_create",
  "asset_create", "asset_update", "depreciation_run", "carry_forward_profit",
  "account_set_create", "legacy_book_import", "book_import_incremental",
]);

const MODEL_OUTPUT_NOTE = "（模型通道：结果只返回白名单摘要信封 projection + localRef；"
  + "企业名 / 科目名与编码 / 凭证摘要 / 往来 / 人员 / 资产名 / 路径 / 批次与来源 ID 等原值不在模型输出中，"
  + "需要原文时走本机引用接口。）";
const MODEL_PLAIN_TOOL_SET = new Set(MODEL_PLAIN_TOOL_NAMES);
const withModelNote = (tool) => (MODEL_PLAIN_TOOL_SET.has(tool.name)
  ? { ...tool, description: `${tool.description}${MODEL_OUTPUT_NOTE}`, modelOutput: "summary_envelope" }
  : tool);

export const TOOLS = [...LOCAL_TOOLS, ...CATALOG_TOOLS, ...BACKEND_TOOLS, ...TAX_TOOLS, ...PLACEHOLDER_TOOLS]
  .map(withModelNote);
export const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/** 本地自己处理、不转发后端的工具（仅资源类；普通财务工具已固定走模型通道）。 */
export const LOCAL_ONLY = new Set(["skills_list", "skills_read"]);

/** 目录工具必须走后端（server/agent-tools.mjs 的执行层），这里显式登记以禁止本地伪实现。 */
export const CATALOG_TOOL_NAMES = CATALOG_TOOLS.map((t) => t.name);

// ---------------------------------------------------------------- 查询能力可用性
/**
 * 原站 21 项查询能力的本地真实状态。
 * 未列出的 nodeId（且不在 LOCAL_QUERY 中）一律视为“未知能力”，报错而不是静默。
 */
const UNIMPLEMENTED_QUERIES = {
  "enterprise_account.bank": "银行账户数据源未接入",
  "enterprise_account.business": "工商信息数据源未接入",
  "enterprise_account.personnel": "人员数据源未接入",
  "enterprise_account.tax_assessment": "税种核定数据源未接入",
  "enterprise_account.tax": "税务信息数据源未接入",
  "enterprise_account.auxiliary_accounting.all": "辅助核算未实现",
  "fund.unbooked.list": "银行流水未接入",
  "fund.unbooked.summary": "银行流水未接入",
  "invoice.detail": "发票数据源未接入",
  "invoice.unbooked.list": "发票数据源未接入",
  "invoice.unbooked.summary": "发票数据源未接入",
};
const IMPLEMENTED_QUERIES = {
  "enterprise_account.account_set": { requiresPeriod: false },
  "enterprise_account.subject_system.all": { requiresPeriod: false },
  "voucher.generated.list": { requiresPeriod: true },
  "voucher.generated.summary": { requiresPeriod: true, note: "当前与 voucher.generated.list 相同，返回凭证列表而非独立汇总" },
  "voucher.draft.summary": { requiresPeriod: true },
  "voucher.detail": { requiresPeriod: false, requiresVoucherId: true },
  "report.balance_sheet": { requiresPeriod: true },
  "report.income_statement": { requiresPeriod: true },
  "report.cash_flow_statement": { requiresPeriod: true },
  "period_end.summary": { requiresPeriod: true },
};
/** 本地扩展的查询能力：单列，不混入原站证据。 */
export const LOCAL_QUERIES = {
  "report.trial_balance": { label: "查询试算平衡", requiresPeriod: true },
  "ledger.general": { label: "查询科目明细账", requiresPeriod: true, requiresCode: true },
};

export function queryStatus(nodeId) {
  if (Object.prototype.hasOwnProperty.call(IMPLEMENTED_QUERIES, nodeId)) {
    return { status: "available", origin: "upstream", ...IMPLEMENTED_QUERIES[nodeId] };
  }
  if (Object.prototype.hasOwnProperty.call(UNIMPLEMENTED_QUERIES, nodeId)) {
    return { status: "unavailable", origin: "upstream", note: UNIMPLEMENTED_QUERIES[nodeId] };
  }
  if (Object.prototype.hasOwnProperty.call(LOCAL_QUERIES, nodeId)) {
    return { status: "available", origin: "local", ...LOCAL_QUERIES[nodeId] };
  }
  return null; // 未知能力
}

// ---------------------------------------------------------------- 参数校验
function typeOk(v, t) {
  for (const ty of [].concat(t)) {
    if (ty === "string" && typeof v === "string") return true;
    if (ty === "integer" && Number.isInteger(v)) return true;
    if (ty === "number" && typeof v === "number" && Number.isFinite(v)) return true;
    if (ty === "boolean" && typeof v === "boolean") return true;
    if (ty === "object" && v && typeof v === "object" && !Array.isArray(v)) return true;
    if (ty === "array" && Array.isArray(v)) return true;
  }
  return false;
}

/** 最小运行时校验：必填、类型、枚举、数值上下限。返回问题字符串数组，空数组表示通过。 */
export function validateArgs(schema, args) {
  const problems = [];
  if (!schema || schema.type !== "object") return problems;
  if (args === null || typeof args !== "object" || Array.isArray(args)) return ["arguments 必须是 JSON 对象"];
  for (const key of schema.required || []) {
    const v = args[key];
    if (v === undefined || v === null || v === "") problems.push(`缺少必填参数：${key}`);
  }
  for (const [key, prop] of Object.entries(schema.properties || {})) {
    const v = args[key];
    if (v === undefined || v === null) continue;
    if (prop.type && !typeOk(v, prop.type)) {
      problems.push(`参数 ${key} 类型应为 ${[].concat(prop.type).join(" | ")}`);
      continue;
    }
    if (prop.enum && !prop.enum.includes(v)) problems.push(`参数 ${key} 只能是：${prop.enum.join(" / ")}`);
    // 数值上下限（目前用于 useful_life_months 这类**技术输入边界**）：越界不交给后端落库后再报错。
    if (typeof v === "number") {
      if (typeof prop.minimum === "number" && v < prop.minimum) problems.push(`参数 ${key} 不能小于 ${prop.minimum}`);
      if (typeof prop.maximum === "number" && v > prop.maximum) problems.push(`参数 ${key} 不能大于 ${prop.maximum}`);
    }
  }
  return problems;
}
