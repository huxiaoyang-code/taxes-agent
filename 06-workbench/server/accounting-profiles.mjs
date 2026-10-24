/**
 * accounting-profiles.mjs — 版本化会计 profile 定义（LOCAL-03a 阶段 A 纯模块）。
 *
 * 边界：
 * - 纯定义模块；不读写数据库、文件、网络、环境变量，也不启动任何服务，import 无副作用。
 * - 只提供 profile 的科目表 / 角色 / 来源 / 支持范围；不创建、更新或迁移账套，
 *   不推断企业身份，不做金额计算（金额规则见 accounting-report-rules.mjs）。
 * - legacy-small-coa-v1 是派工基线 coa.mjs 的逐项静态快照，用于旧账套兼容读取；
 *   它不代表新企业模板，也不通过运行时引用可变 COA 数组，避免未来静默漂移。
 *
 * 公开接口（阶段 A 契约，阶段 B 沿用同一含义）：
 * - listAccountingProfiles()
 * - getAccountingProfile(profileId)
 * - resolveNewAccountingProfile({ accounting_standard, profileId })
 * - getAccountingRoles(profileId)
 */

const BASELINE_COMMIT = "98977e04bd24aa293074021802191814f8c2a1d2";
const LEGACY_COA_SOURCE_FILE = "06-workbench/server/coa.mjs";
const LEGACY_COA_SOURCE_SHA256 =
  "cc49061c56eb2574d52b33708cf5b52564dad9ef30b88a669c596467989d8f2e";

const CHECKED_AT = "2026-10-22";

// ---------------------------------------------------------------- 工具
function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return value;
}

function profileError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// ---------------------------------------------------------------- 权威来源
// 只记录 sourceId / 标题 / 文号 / URL / 适用范围 / 核查日期；规则定义引用 sourceId，
// 不复制长篇法规原文。legacy 快照来源用仓库基线提交 + 文件 + SHA256 表达。
const SOURCE_SMALL_STANDARD = {
  sourceId: "mof-2011-17",
  title: "小企业会计准则（正文）",
  documentNumber: "财会〔2011〕17号",
  url: "https://kjs.mof.gov.cn/zhengcefabu/201111/P020111118325852319878.pdf",
  applicableScope: "小企业会计准则适用范围、报表基本要求",
  checkedAt: CHECKED_AT,
};

const SOURCE_SMALL_APPENDIX = {
  sourceId: "mof-2011-17-appendix",
  title: "小企业会计准则附录：会计科目、主要账务处理和财务报表",
  documentNumber: "财会〔2011〕17号",
  url: "https://kjs.mof.gov.cn/zhengcefabu/201111/P020111118325852734144.pdf",
  pageCount: 85,
  applicableScope:
    "小企业基础科目条目与内部报表行项目基础（附录共85页：第69页(4)应收账款贷方余额列预收账款、第70页(5)预付账款贷方余额列应付账款、第72页(25)(26)应付账款借方列预付账款与预收账款借方列应收账款、第73页(28)应交税费借方余额以负号填列、第80-82页现金流量表分类说明（第81页3.(2)⑤明确购建长期资产现金不包括资本化借款费用与在建工程人员薪酬））；科目编号为参考编号",
  checkedAt: CHECKED_AT,
};

const SOURCE_ENTERPRISE_APPENDIX = {
  sourceId: "mof-2006-18-appendix",
  title: "企业会计准则应用指南附录：会计科目和主要账务处理（商务部政府法规库转录）",
  documentNumber: "财会〔2006〕18号",
  url: "https://policy.mofcom.gov.cn/claw/clawContent.shtml?id=13655",
  applicableScope:
    "只取已核实的基础科目条目编号与名称；编号为参考编号，不整篇视为 2026 现行口径",
  checkedAt: CHECKED_AT,
};

const SOURCE_CAS_SUBSEQUENT_GUIDES = {
  sourceId: "mof-2023-01-cas-guide-reply",
  title: "财政部会计司答复：企业会计准则科目需结合 2014 年以来应用指南",
  documentNumber: null,
  url: "https://www.mof.gov.cn/bd/mhwzzxly/hjs/202301/t20230104_3861971.htm",
  applicableScope: "说明 2006 附录不是唯一现行科目依据，沿用前必须结合后续指南",
  checkedAt: CHECKED_AT,
};

const SOURCE_REPORT_2019 = {
  sourceId: "mof-2019-06-appendix-2",
  title: "一般企业财务报表格式（适用于已执行新金融准则、新收入准则和新租赁准则的企业，附件2）",
  documentNumber: "财会〔2019〕6号",
  url: "https://www.mof.gov.cn/gkml/caizhengwengao/wg201901/wg201905/201909/P020190912379331344319.pdf",
  pageCount: 18,
  applicableScope:
    "企业内部一般报表行项目的已核实基础（附件2共18页：资产负债表第2-3页、项目说明第4-8页含第5页在建工程与第6-7页应付账款含预付账款贷方、第8页合同资产/合同负债，现金流量表第15-16页含购建长期资产与分配股利利润或偿付利息）；不是法定完整财务报表，也不是税局上传文件",
  checkedAt: CHECKED_AT,
};

const SOURCE_REVENUE_2017 = {
  sourceId: "mof-2017-22",
  title: "企业会计准则第14号——收入",
  documentNumber: "财会〔2017〕22号",
  url: "https://m.mof.gov.cn/zcfb/201707/t20170719_2653110.htm",
  applicableScope:
    "新收入准则替代旧收入 / 建造合同处理；本包未实现复杂合同、履约成本、退货等业务",
  checkedAt: CHECKED_AT,
};

const SOURCE_INTERPRETATION_20 = {
  sourceId: "mof-2026-07-interpretation-20",
  title: "企业会计准则解释第20号",
  documentNumber: "财会〔2026〕7号",
  url: "https://kjs.mof.gov.cn/zhengcefabu/202606/t20260615_3991686.htm",
  applicableScope:
    "含金融资产合同现金流量特征与货币缺乏可兑换性；本包不实现其分类计量、汇率估计与追溯调整",
  checkedAt: CHECKED_AT,
};

const SOURCE_REPO_BASELINE = {
  sourceId: "repo-coa-baseline",
  title: "派工基线 06-workbench/server/coa.mjs 小企业科目表逐项快照",
  documentNumber: null,
  url: null,
  applicableScope:
    "仅用于 legacy 账套兼容读取，证明旧账套原科目配置未被重解释；不是新企业模板依据",
  checkedAt: CHECKED_AT,
  baselineCommit: BASELINE_COMMIT,
  sourceFile: LEGACY_COA_SOURCE_FILE,
  sourceSha256: LEGACY_COA_SOURCE_SHA256,
};

// ---------------------------------------------------------------- legacy 快照
// 严格逐项复制派工基线 coa.mjs 的 COA：顺序、code / name / category / direction 与
// contra 的有无和值全部保留；不纠错旧名称、不增科目、不合并、不排序。
const LEGACY_COA = [
  // ---------------- 资产 ----------------
  { code: "1001", name: "库存现金", direction: "debit", category: "资产" },
  { code: "1002", name: "银行存款", direction: "debit", category: "资产" },
  { code: "1012", name: "其他货币资金", direction: "debit", category: "资产" },
  { code: "1101", name: "短期投资", direction: "debit", category: "资产" },
  { code: "1121", name: "应收票据", direction: "debit", category: "资产" },
  { code: "1122", name: "应收账款", direction: "debit", category: "资产" },
  { code: "1123", name: "预付账款", direction: "debit", category: "资产" },
  { code: "1131", name: "应收股利", direction: "debit", category: "资产" },
  { code: "1132", name: "应收利息", direction: "debit", category: "资产" },
  { code: "1221", name: "其他应收款", direction: "debit", category: "资产" },
  { code: "1401", name: "材料采购", direction: "debit", category: "资产" },
  { code: "1402", name: "在途物资", direction: "debit", category: "资产" },
  { code: "1403", name: "原材料", direction: "debit", category: "资产" },
  { code: "1405", name: "库存商品", direction: "debit", category: "资产" },
  { code: "1408", name: "委托加工物资", direction: "debit", category: "资产" },
  { code: "1411", name: "周转材料", direction: "debit", category: "资产" },
  { code: "1601", name: "固定资产", direction: "debit", category: "资产" },
  { code: "1602", name: "累计折旧", direction: "credit", category: "资产", contra: true },
  { code: "1604", name: "在建工程", direction: "debit", category: "资产" },
  { code: "1606", name: "固定资产清理", direction: "debit", category: "资产" },
  { code: "1701", name: "无形资产", direction: "debit", category: "资产" },
  { code: "1702", name: "累计摊销", direction: "credit", category: "资产", contra: true },
  { code: "1801", name: "长期待摊费用", direction: "debit", category: "资产" },
  { code: "1901", name: "待处理财产损溢", direction: "debit", category: "资产" },

  // ---------------- 负债 ----------------
  { code: "2001", name: "短期借款", direction: "credit", category: "负债" },
  { code: "2201", name: "应付票据", direction: "credit", category: "负债" },
  { code: "2202", name: "应付账款", direction: "credit", category: "负债" },
  { code: "2203", name: "预收账款", direction: "credit", category: "负债" },
  { code: "2211", name: "应付职工薪酬", direction: "credit", category: "负债" },
  { code: "2221", name: "应交税费", direction: "credit", category: "负债" },
  { code: "2231", name: "应付利息", direction: "credit", category: "负债" },
  { code: "2232", name: "应付利润", direction: "credit", category: "负债" },
  { code: "2241", name: "其他应付款", direction: "credit", category: "负债" },
  { code: "2401", name: "递延收益", direction: "credit", category: "负债" },
  { code: "2501", name: "长期借款", direction: "credit", category: "负债" },
  { code: "2701", name: "长期应付款", direction: "credit", category: "负债" },

  // ---------------- 所有者权益 ----------------
  { code: "3001", name: "实收资本", direction: "credit", category: "权益" },
  { code: "3002", name: "资本公积", direction: "credit", category: "权益" },
  { code: "3101", name: "盈余公积", direction: "credit", category: "权益" },
  { code: "3103", name: "本年利润", direction: "credit", category: "权益" },
  { code: "3104", name: "利润分配", direction: "credit", category: "权益" },

  // ---------------- 成本 ----------------
  { code: "4001", name: "生产成本", direction: "debit", category: "成本" },
  { code: "4101", name: "制造费用", direction: "debit", category: "成本" },
  { code: "4301", name: "研发支出", direction: "debit", category: "成本" },
  { code: "4401", name: "工程施工", direction: "debit", category: "成本" },

  // ---------------- 损益 ----------------
  { code: "5001", name: "主营业务收入", direction: "credit", category: "损益" },
  { code: "5051", name: "其他业务收入", direction: "credit", category: "损益" },
  { code: "5111", name: "投资收益", direction: "credit", category: "损益" },
  { code: "5301", name: "营业外收入", direction: "credit", category: "损益" },
  { code: "5401", name: "主营业务成本", direction: "debit", category: "损益" },
  { code: "5402", name: "其他业务成本", direction: "debit", category: "损益" },
  { code: "5403", name: "税金及附加", direction: "debit", category: "损益" },
  { code: "5601", name: "销售费用", direction: "debit", category: "损益" },
  { code: "5602", name: "管理费用", direction: "debit", category: "损益" },
  { code: "5603", name: "财务费用", direction: "debit", category: "损益" },
  { code: "5711", name: "营业外支出", direction: "debit", category: "损益" },
  { code: "5801", name: "所得税费用", direction: "debit", category: "损益" },
];

const LEGACY_ROLES = {
  cashRoots: ["1001", "1002", "1012"],
  capital: "3001",
  capitalReserve: "3002",
  surplusReserve: "3101",
  currentYearProfit: "3103",
  profitDistribution: "3104",
  productionCost: "4001",
  mainRevenue: "5001",
  otherRevenue: "5051",
  mainCost: "5401",
  otherCost: "5402",
  adminExpense: "5602",
  defaultDepreciationExpense: "5602",
  fixedAsset: "1601",
  accumulatedDepreciation: "1602",
  intangibleAsset: "1701",
  accumulatedAmortization: "1702",
};

// ---------------------------------------------------------------- 新 profile 科目表
// scope.status 三态：
// - mapped          已核实并可直接进入内部报表行项目
// - requires_detail 需要持有 / 分配 / 处置等明细资料才能归类，非零余额不得静默计入合计
// - unsupported     本包未实现对应业务，非零余额必须给出不完整诊断
const MAPPED = { status: "mapped" };
const scope = (status, reason) => (reason ? { status, reason } : { status });
// 每个预置科目记录来源 sourceId；legacy 快照必须保持与基线逐项一致，不加字段。
const stampSource = (items, sourceId) => items.map((item) => ({ ...item, sourceId: item.sourceId ?? sourceId }));

const SMALL_COA = [
  { code: "1001", name: "库存现金", category: "资产", direction: "debit", scope: MAPPED },
  { code: "1002", name: "银行存款", category: "资产", direction: "debit", scope: MAPPED },
  { code: "1012", name: "其他货币资金", category: "资产", direction: "debit", scope: MAPPED },
  { code: "1101", name: "短期投资", category: "资产", direction: "debit", scope: MAPPED },
  { code: "1121", name: "应收票据", category: "资产", direction: "debit", scope: MAPPED },
  { code: "1122", name: "应收账款", category: "资产", direction: "debit", scope: MAPPED },
  { code: "1123", name: "预付账款", category: "资产", direction: "debit", scope: MAPPED },
  { code: "1131", name: "应收股利", category: "资产", direction: "debit", scope: MAPPED },
  { code: "1132", name: "应收利息", category: "资产", direction: "debit", scope: MAPPED },
  { code: "1221", name: "其他应收款", category: "资产", direction: "debit", scope: MAPPED },
  { code: "1401", name: "材料采购", category: "资产", direction: "debit", scope: MAPPED },
  { code: "1402", name: "在途物资", category: "资产", direction: "debit", scope: MAPPED },
  { code: "1403", name: "原材料", category: "资产", direction: "debit", scope: MAPPED },
  { code: "1405", name: "库存商品", category: "资产", direction: "debit", scope: MAPPED },
  { code: "1408", name: "委托加工物资", category: "资产", direction: "debit", scope: MAPPED },
  { code: "1411", name: "周转材料", category: "资产", direction: "debit", scope: MAPPED },
  { code: "1601", name: "固定资产", category: "资产", direction: "debit", scope: MAPPED },
  {
    code: "1602",
    name: "累计折旧",
    category: "资产",
    direction: "credit",
    contra: true,
    scope: MAPPED,
  },
  { code: "1604", name: "在建工程", category: "资产", direction: "debit", scope: MAPPED },
  {
    code: "1606",
    name: "固定资产清理",
    category: "资产",
    direction: "debit",
    scope: scope("requires_detail", "disposal-in-progress-requires-detail"),
  },
  { code: "1701", name: "无形资产", category: "资产", direction: "debit", scope: MAPPED },
  {
    code: "1702",
    name: "累计摊销",
    category: "资产",
    direction: "credit",
    contra: true,
    scope: MAPPED,
  },
  { code: "1801", name: "长期待摊费用", category: "资产", direction: "debit", scope: MAPPED },
  {
    code: "1901",
    name: "待处理财产损溢",
    category: "资产",
    direction: "debit",
    scope: scope("requires_detail", "asset-surplus-deficit-requires-disposition-detail"),
  },
  { code: "2001", name: "短期借款", category: "负债", direction: "credit", scope: MAPPED },
  { code: "2201", name: "应付票据", category: "负债", direction: "credit", scope: MAPPED },
  { code: "2202", name: "应付账款", category: "负债", direction: "credit", scope: MAPPED },
  { code: "2203", name: "预收账款", category: "负债", direction: "credit", scope: MAPPED },
  { code: "2211", name: "应付职工薪酬", category: "负债", direction: "credit", scope: MAPPED },
  { code: "2221", name: "应交税费", category: "负债", direction: "credit", scope: MAPPED },
  { code: "2231", name: "应付利息", category: "负债", direction: "credit", scope: MAPPED },
  { code: "2232", name: "应付利润", category: "负债", direction: "credit", scope: MAPPED },
  { code: "2241", name: "其他应付款", category: "负债", direction: "credit", scope: MAPPED },
  {
    code: "2401",
    name: "递延收益",
    category: "负债",
    direction: "credit",
    scope: scope("requires_detail", "deferred-income-recognition-requires-detail"),
  },
  { code: "2501", name: "长期借款", category: "负债", direction: "credit", scope: MAPPED },
  { code: "2701", name: "长期应付款", category: "负债", direction: "credit", scope: MAPPED },
  { code: "3001", name: "实收资本", category: "权益", direction: "credit", scope: MAPPED },
  { code: "3002", name: "资本公积", category: "权益", direction: "credit", scope: MAPPED },
  { code: "3101", name: "盈余公积", category: "权益", direction: "credit", scope: MAPPED },
  { code: "3103", name: "本年利润", category: "权益", direction: "credit", scope: MAPPED },
  { code: "3104", name: "利润分配", category: "权益", direction: "credit", scope: MAPPED },
  { code: "4001", name: "生产成本", category: "成本", direction: "debit", scope: MAPPED },
  {
    code: "4101",
    name: "制造费用",
    category: "成本",
    direction: "debit",
    scope: scope("requires_detail", "manufacturing-overhead-allocation-required"),
  },
  {
    code: "4301",
    name: "研发支出",
    category: "成本",
    direction: "debit",
    scope: scope("requires_detail", "r-and-d-capitalization-requires-detail"),
  },
  {
    code: "4401",
    name: "工程施工",
    category: "成本",
    direction: "debit",
    scope: scope("unsupported", "construction-contract-rules-not-implemented"),
  },
  { code: "5001", name: "主营业务收入", category: "损益", direction: "credit", scope: MAPPED },
  { code: "5051", name: "其他业务收入", category: "损益", direction: "credit", scope: MAPPED },
  { code: "5111", name: "投资收益", category: "损益", direction: "credit", scope: MAPPED },
  { code: "5301", name: "营业外收入", category: "损益", direction: "credit", scope: MAPPED },
  { code: "5401", name: "主营业务成本", category: "损益", direction: "debit", scope: MAPPED },
  { code: "5402", name: "其他业务成本", category: "损益", direction: "debit", scope: MAPPED },
  { code: "5403", name: "税金及附加", category: "损益", direction: "debit", scope: MAPPED },
  { code: "5601", name: "销售费用", category: "损益", direction: "debit", scope: MAPPED },
  { code: "5602", name: "管理费用", category: "损益", direction: "debit", scope: MAPPED },
  { code: "5603", name: "财务费用", category: "损益", direction: "debit", scope: MAPPED },
  { code: "5711", name: "营业外支出", category: "损益", direction: "debit", scope: MAPPED },
  { code: "5801", name: "所得税费用", category: "损益", direction: "debit", scope: MAPPED },
];

const ENTERPRISE_COA = [
  { code: "1151", name: "合同资产", category: "资产", direction: "debit", scope: MAPPED, sourceId: "mof-2017-22" },
  { code: "1621", name: "使用权资产", category: "资产", direction: "debit", scope: MAPPED, sourceId: "mof-2018-35" },
  { code: "1622", name: "使用权资产累计折旧", category: "资产", direction: "credit", contra: true, scope: MAPPED, sourceId: "mof-2018-35" },
  { code: "2801", name: "租赁负债（非流动）", category: "负债", direction: "credit", scope: MAPPED, sourceId: "mof-2018-35" },
  { code: "2802", name: "一年内到期的租赁负债", category: "负债", direction: "credit", scope: MAPPED, sourceId: "mof-2018-35" },
  { code: "1001", name: "库存现金", category: "资产", direction: "debit", scope: MAPPED },
  { code: "1002", name: "银行存款", category: "资产", direction: "debit", scope: MAPPED },
  { code: "1012", name: "其他货币资金", category: "资产", direction: "debit", scope: MAPPED },
  {
    code: "1101",
    name: "交易性金融资产",
    category: "资产",
    direction: "debit",
    scope: scope("unsupported", "financial-instrument-measurement-not-implemented"),
  },
  { code: "1121", name: "应收票据", category: "资产", direction: "debit", scope: MAPPED },
  { code: "1122", name: "应收账款", category: "资产", direction: "debit", scope: MAPPED },
  { code: "1123", name: "预付账款", category: "资产", direction: "debit", scope: MAPPED },
  { code: "1131", name: "应收股利", category: "资产", direction: "debit", scope: MAPPED },
  { code: "1132", name: "应收利息", category: "资产", direction: "debit", scope: MAPPED },
  { code: "1221", name: "其他应收款", category: "资产", direction: "debit", scope: MAPPED },
  { code: "1401", name: "材料采购", category: "资产", direction: "debit", scope: MAPPED },
  { code: "1402", name: "在途物资", category: "资产", direction: "debit", scope: MAPPED },
  { code: "1403", name: "原材料", category: "资产", direction: "debit", scope: MAPPED },
  { code: "1405", name: "库存商品", category: "资产", direction: "debit", scope: MAPPED },
  { code: "1408", name: "委托加工物资", category: "资产", direction: "debit", scope: MAPPED },
  { code: "1411", name: "周转材料", category: "资产", direction: "debit", scope: MAPPED },
  {
    code: "1471",
    name: "存货跌价准备",
    category: "资产",
    direction: "credit",
    contra: true,
    scope: scope("unsupported", "impairment-not-implemented"),
  },
  {
    code: "1511",
    name: "长期股权投资",
    category: "资产",
    direction: "debit",
    scope: scope("unsupported", "long-term-equity-investment-not-implemented"),
  },
  { code: "1601", name: "固定资产", category: "资产", direction: "debit", scope: MAPPED },
  {
    code: "1602",
    name: "累计折旧",
    category: "资产",
    direction: "credit",
    contra: true,
    scope: MAPPED,
  },
  { code: "1604", name: "在建工程", category: "资产", direction: "debit", scope: MAPPED },
  {
    code: "1606",
    name: "固定资产清理",
    category: "资产",
    direction: "debit",
    scope: scope("requires_detail", "disposal-in-progress-requires-detail"),
  },
  { code: "1701", name: "无形资产", category: "资产", direction: "debit", scope: MAPPED },
  {
    code: "1702",
    name: "累计摊销",
    category: "资产",
    direction: "credit",
    contra: true,
    scope: MAPPED,
  },
  { code: "1801", name: "长期待摊费用", category: "资产", direction: "debit", scope: MAPPED },
  {
    code: "1901",
    name: "待处理财产损溢",
    category: "资产",
    direction: "debit",
    scope: scope("requires_detail", "asset-surplus-deficit-requires-disposition-detail"),
  },
  { code: "2001", name: "短期借款", category: "负债", direction: "credit", scope: MAPPED },
  { code: "2201", name: "应付票据", category: "负债", direction: "credit", scope: MAPPED },
  { code: "2202", name: "应付账款", category: "负债", direction: "credit", scope: MAPPED },
  { code: "2203", name: "预收账款", category: "负债", direction: "credit", scope: MAPPED },
  { code: "2211", name: "应付职工薪酬", category: "负债", direction: "credit", scope: MAPPED },
  { code: "2221", name: "应交税费", category: "负债", direction: "credit", scope: MAPPED },
  { code: "2231", name: "应付利息", category: "负债", direction: "credit", scope: MAPPED },
  { code: "2232", name: "应付股利", category: "负债", direction: "credit", scope: MAPPED },
  { code: "2241", name: "其他应付款", category: "负债", direction: "credit", scope: MAPPED },
  {
    code: "2401",
    name: "递延收益",
    category: "负债",
    direction: "credit",
    scope: scope("requires_detail", "deferred-income-recognition-requires-detail"),
  },
  { code: "2501", name: "长期借款", category: "负债", direction: "credit", scope: MAPPED },
  { code: "2701", name: "长期应付款", category: "负债", direction: "credit", scope: MAPPED },
  { code: "4001", name: "实收资本", category: "权益", direction: "credit", scope: MAPPED },
  { code: "4002", name: "资本公积", category: "权益", direction: "credit", scope: MAPPED },
  { code: "4101", name: "盈余公积", category: "权益", direction: "credit", scope: MAPPED },
  { code: "4103", name: "本年利润", category: "权益", direction: "credit", scope: MAPPED },
  { code: "4104", name: "利润分配", category: "权益", direction: "credit", scope: MAPPED },
  { code: "5001", name: "生产成本", category: "成本", direction: "debit", scope: MAPPED },
  {
    code: "5101",
    name: "制造费用",
    category: "成本",
    direction: "debit",
    scope: scope("requires_detail", "manufacturing-overhead-allocation-required"),
  },
  {
    code: "5201",
    name: "劳务成本",
    category: "成本",
    direction: "debit",
    scope: scope("requires_detail", "labor-cost-allocation-required"),
  },
  {
    code: "5301",
    name: "研发支出",
    category: "成本",
    direction: "debit",
    scope: scope("requires_detail", "r-and-d-capitalization-requires-detail"),
  },
  { code: "6001", name: "主营业务收入", category: "损益", direction: "credit", scope: MAPPED },
  { code: "6051", name: "其他业务收入", category: "损益", direction: "credit", scope: MAPPED },
  { code: "6111", name: "投资收益", category: "损益", direction: "credit", scope: MAPPED },
  { code: "6117", name: "其他收益", category: "损益", direction: "credit", scope: MAPPED, sourceId: "enterprise-vat-relief-2020" },
  { code: "6301", name: "营业外收入", category: "损益", direction: "credit", scope: MAPPED },
  { code: "6401", name: "主营业务成本", category: "损益", direction: "debit", scope: MAPPED },
  { code: "6402", name: "其他业务成本", category: "损益", direction: "debit", scope: MAPPED },
  { code: "6403", name: "税金及附加", category: "损益", direction: "debit", scope: MAPPED },
  { code: "6601", name: "销售费用", category: "损益", direction: "debit", scope: MAPPED },
  { code: "6602", name: "管理费用", category: "损益", direction: "debit", scope: MAPPED },
  { code: "6603", name: "财务费用", category: "损益", direction: "debit", scope: MAPPED },
  {
    code: "6701",
    name: "资产减值损失",
    category: "损益",
    direction: "debit",
    scope: scope("unsupported", "impairment-not-implemented"),
  },
  { code: "6711", name: "营业外支出", category: "损益", direction: "debit", scope: MAPPED },
  { code: "6801", name: "所得税费用", category: "损益", direction: "debit", scope: MAPPED },
];

const SMALL_ROLES = {
  cashRoots: ["1001", "1002", "1012"],
  capital: "3001",
  capitalReserve: "3002",
  surplusReserve: "3101",
  currentYearProfit: "3103",
  profitDistribution: "3104",
  productionCost: "4001",
  mainRevenue: "5001",
  otherRevenue: "5051",
  mainCost: "5401",
  otherCost: "5402",
  adminExpense: "5602",
  defaultDepreciationExpense: "5602",
  fixedAsset: "1601",
  accumulatedDepreciation: "1602",
  intangibleAsset: "1701",
  accumulatedAmortization: "1702",
};

const ENTERPRISE_ROLES = {
  cashRoots: ["1001", "1002", "1012"],
  capital: "4001",
  capitalReserve: "4002",
  surplusReserve: "4101",
  currentYearProfit: "4103",
  profitDistribution: "4104",
  productionCost: "5001",
  mainRevenue: "6001",
  otherRevenue: "6051",
  mainCost: "6401",
  otherCost: "6402",
  adminExpense: "6602",
  defaultDepreciationExpense: "6602",
  fixedAsset: "1601",
  accumulatedDepreciation: "1602",
  intangibleAsset: "1701",
  accumulatedAmortization: "1702",
};

const COMMON_SCOPE_NOTES = Object.freeze([
  "财务 / 税费科目的已记录分录汇总不等于自动算税；本模块不计算税额，也不生成申报数据。",
  "内部报表是本机已核实的简化行项目，不是法定完整财务报表，也不是税局上传文件。",
  "未实现：金融工具分类计量、租赁、递延所得税、减值计算、合并报表、外币折算、行业专用业务。",
]);

// ---------------------------------------------------------------- profile 定义
const PROFILES = new Map();

function defineProfile(profile) {
  const frozen = deepFreeze(profile);
  PROFILES.set(frozen.id, frozen);
  return frozen;
}

defineProfile({
  id: "legacy-small-coa-v1",
  declaredStandard: null,
  creationAllowed: false,
  legacy: true,
  coaVersion: "legacy-small-coa-baseline-v1",
  reportMappingVersion: "legacy-small-coa-report-compat-v1",
  scope: {
    supported: Object.freeze([
      "旧账套原科目配置的只读兼容读取（legacy）",
      "阶段 B 旧报表兼容路径按旧口径继续出数",
    ]),
    unsupported: Object.freeze([
      "不用于新建账套；不能把新企业模板规则套到旧账套上",
      "不自动纠正旧科目名称、编号或历史标签，也不提供准则转换",
    ]),
    notes: Object.freeze([
      "legacy 不是第三种法定准则；declaredStandard 为 null，旧账套 original accounting_standard 标签由阶段 B 账套记录保留。",
      "legacy COA 是派工基线 coa.mjs 的逐项静态快照，独立冻结，不运行时引用可变数组。",
      ...COMMON_SCOPE_NOTES,
    ]),
  },
  sources: [SOURCE_REPO_BASELINE, SOURCE_SMALL_STANDARD, SOURCE_SMALL_APPENDIX],
  coa: LEGACY_COA,
  roles: LEGACY_ROLES,
});

defineProfile({
  id: "small-2011-basic-v1",
  declaredStandard: "小企业会计准则",
  creationAllowed: true,
  legacy: false,
  coaVersion: "small-2011-coa-basic-v1",
  reportMappingVersion: "small-2011-report-basic-v1",
  scope: {
    supported: Object.freeze([
      "现金 / 银行 / 其他货币资金",
      "应收应付、预收预付、其他应收应付；往来反向余额按明细方向列示（应收账款贷方列预收账款、应付账款借方列预付账款、预付账款贷方列应付账款、预收账款借方列应收账款）",
      "商品 / 原材料 / 周转材料 / 生产成本（生产成本按小企口径纳入存货）",
      "实收资本、资本公积、盈余公积、本年利润、利润分配",
      "常规收入、成本、税金及附加、三项费用、营业外收支、所得税费用（按已记录分录汇总）",
      "固定资产与无形资产的原值 / 累计折旧摊销 / 净值展示",
    ]),
    unsupported: Object.freeze([
      "建造合同 / 工程施工规则（旧处理已被新收入准则替代，本包不实现）",
      "减值、租赁、递延所得税、外币、合并报表、金融工具计量",
      "自动算税、税局申报文件与任何税局上传格式",
    ]),
    notes: Object.freeze([
      "新建账套时省略准则默认本 profile；未登记准则的旧账套应迁为 legacy，不是本 profile。",
      "科目编号为参考编号，规则按 profile 角色解析，不依赖名称或编码尾号。",
      "往来反向余额按官方附录按明细科目方向列示，不先把同一行明细净额相加；未定义列示行的相反余额给 incomplete，不冒充完整，也不等同于流动 / 非流动期限重分类。",
      "小企应交税费 2221 期末借方余额按附录第73页(28)以负号列示，属已核实的合法负列示；不把该规则扩张到未核实科目或其他 profile。",
      "在建工程 1604 的现金流用途不明时（可能是购建支出、资本化借款利息或工程人员薪酬）返回 unknown，不统一列为投资活动。",
      ...COMMON_SCOPE_NOTES,
    ]),
  },
  sources: [
    SOURCE_SMALL_STANDARD,
    SOURCE_SMALL_APPENDIX,
    SOURCE_REPORT_2019,
    SOURCE_REVENUE_2017,
  ],
  coa: stampSource(SMALL_COA, "mof-2011-17-appendix"),
  roles: SMALL_ROLES,
});

defineProfile({
  id: "enterprise-2019-general-basic-v1",
  declaredStandard: "企业会计准则",
  creationAllowed: true,
  legacy: false,
  coaVersion: "enterprise-2019-general-coa-business-v2",
  reportMappingVersion: "enterprise-2019-general-report-business-v2",
  scope: {
    supported: Object.freeze([
      "现金 / 银行 / 其他货币资金",
      "应收应付、预收预付、应收股利 / 利息与其他应收款按核实范围汇总列示；应付账款借方→预付款项、预付账款贷方→应付账款按明细方向列示",
      "商品 / 原材料 / 周转材料 / 生产成本 5001（按企业口径纳入存货）",
      "实收资本 4001、资本公积 4002、盈余公积 4101、本年利润 4103、利润分配 4104",
      "常规收入 6001 / 6051、成本 6401 / 6402、税金及附加、三项费用、营业外收支、所得税费用",
      "固定资产与无形资产的原值 / 累计折旧摊销 / 净值展示",
      "内部一般报表行项目以财会〔2019〕6号附件2 已核实基础为准",
    ]),
    unsupported: Object.freeze([
      "交易性金融资产等金融工具分类计量（含解释第20号相关衔接）、长期股权投资",
      "存货跌价准备等减值、租赁变更/可变租金/减值等复杂情形、递延所得税、外币、合并报表",
      "agency业务模块已核范围以外的新收入准则复杂合同、履约成本归属与退货条件",
      "自动算税、税局申报文件与任何税局上传格式",
    ]),
    notes: Object.freeze([
      "企业 5001 是生产成本，不是营业收入；企业 4001 是实收资本，不是存货或成本。",
      "同一编码在小企 / 企业 profile 中含义可能不同（4001 / 5001 / 5301），禁止跨 profile 混用。",
      "企业应收账款贷方 / 预收账款借方涉及预收款项与合同负债 / 合同资产的合同细类，基础科目无法确定时不自动列示，给 incomplete 诊断，不冒充完整。",
      "企业现金流分类依据财会〔2019〕6号附件2 现金流量表第15-16页；在建工程 1604 的用途不明时返回 unknown，不统一列为投资活动。",
      "企科目基础取自财会〔2006〕18号附录已核实条目，并声明需结合 2014 年以来指南，不称 2006 全篇为 2026 现行。",
      ...COMMON_SCOPE_NOTES,
    ]),
  },
  sources: [
    SOURCE_ENTERPRISE_APPENDIX,
    SOURCE_CAS_SUBSEQUENT_GUIDES,
    { sourceId: "enterprise-vat-relief-2020", title: "财政部企业会计准则实施问答：直接减免增值税计入其他收益", url: "https://kjs.mof.gov.cn/zt/kjzzss/sswd/qtwd/202012/t20201211_3634038.htm", applicableScope: "按CAS确认其他收益；6117为本工作台工程参考编号，不宣称法定统一编号", checkedAt: "2026-10-25" },
    SOURCE_REPORT_2019,
    SOURCE_REVENUE_2017,
    SOURCE_INTERPRETATION_20,
    { sourceId: "mof-2018-35", title: "企业会计准则第21号——租赁（2018修订）", url: "https://kjs.mof.gov.cn/zt/kjzzss/kuaijizhunzeshishi/201910/t20191028_3411190.htm", applicableScope: "承租人使用权资产/租赁负债及当期/非流动列示；新增编号为工程参考编号", checkedAt: "2026-10-25" },
  ],
  coa: stampSource(ENTERPRISE_COA, "mof-2006-18-appendix"),
  roles: ENTERPRISE_ROLES,
});

// Independent semantic chart. Numbers are engineering references, not a claim
// that the complete 1997 appendix or its original official numbering was found.
defineProfile({
  id: "individual-bookkeeping-semantic-v1", declaredStandard: "个体工商户会计制度", creationAllowed: true, legacy: false,
  coaVersion: "individual-semantic-coa-v1", reportMappingVersion: "individual-official-form-workpaper-v1",
  scope: { supported: ["个体复式语义账簿、存货成本及官方表式已核项目内部会计核对底稿", "收支与权责发生差异分别保留，经营所得税不作营业费用"], unsupported: ["1997完整科目附件未经官方原件全量核实", "法定完整财务报表与税局上传格式", "复杂金融/融资租赁/合并/外币业务"], notes: ["科目编号为本程序工程参考编号，不冒充官方1997编号或小企业会计准则。", "个人所得税依现行35号令与2018个税法计算，不沿用1997旧税率/费用限额。"] },
  sources: [
    { sourceId: "individual-bookkeeping-order-17", title: "个体工商户建账管理暂行办法（2018修订）", url: "https://fgk.chinatax.gov.cn/zcfgk/c100011/c5195238/content.html", applicableScope: "第9条复式/简易账簿区分", checkedAt: "2026-10-25" },
    { sourceId: "individual-form-A06534", title: "资产负债表（适用执行个体工商户会计制度的单位）及说明", url: "https://xinjiang.chinatax.gov.cn/nsfw/xzzx/biaodan/3/202411/P020241102467717457590.pdf", applicableScope: "官方表式与填表说明已列科目语义；不证明1997完整附录已核", checkedAt: "2026-10-25" },
    { sourceId: "individual-income-order-35", title: "个体工商户个人所得税计税办法（2018修订）", url: "https://fgk.chinatax.gov.cn/zcfgk/c100011/c5196330/content.html", applicableScope: "第5至7、15至29条权责发生及税会差异", checkedAt: "2026-10-25" },
    { sourceId: "individual-owner-guide-2022", title: "山西示范区税务局个体业务课件", url: "https://shanxi.chinatax.gov.cn/upload/file/20221108/1667877825082028731.pdf", applicableScope: "仅第33页业主投入/提款/个人支出列业主投资、第34/37页税后留存利润语义；不沿用课件旧税率，不证明1997全附件", checkedAt: "2026-10-25" },
  ],
  coa: SMALL_COA.filter(a => ["1001", "1002", "1122", "1123", "1221", "1403", "1405", "1601", "1602", "1604", "1606", "1701", "1801", "1901", "2001", "2202", "2203", "2211", "2221", "2241", "3001", "3103", "3104", "4001", "5001", "5051", "5301", "5401", "5402", "5403", "5601", "5602", "5603", "5711"].includes(a.code)).map(a => ({ ...a, name: ({ "1001": "现金", "1122": "应收款项", "1123": "应付款项—预付明细", "1403": "存货—材料", "1405": "存货—商品", "2001": "借入款项", "2202": "应付款项", "2203": "应收款项—预收明细", "2211": "应付工资", "2221": "应交税金", "2241": "应付款项—其他明细", "3001": "业主投资", "3103": "本年经营所得", "3104": "留存利润", "4001": "存货—生产成本", "5001": "营业收入", "5602": "营业费用" })[a.code] ?? a.name, sourceId: "individual-form-A06534", category: a.code === "1123" ? "负债" : a.code === "2203" ? "资产" : a.category, direction: a.code === "1123" ? "credit" : a.code === "2203" ? "debit" : a.direction, scope: ["1606", "1901"].includes(a.code) ? scope("requires_detail", "individual-disposition-evidence-required") : MAPPED })),
  roles: { ...SMALL_ROLES, cashRoots: ["1001", "1002"], capitalReserve: null, surplusReserve: null, accumulatedAmortization: null },
});

const STANDARD_TO_PROFILE = deepFreeze({
  小企业会计准则: "small-2011-basic-v1",
  企业会计准则: "enterprise-2019-general-basic-v1",
  个体工商户会计制度: "individual-bookkeeping-semantic-v1",
});

const PROFILE_LIST = deepFreeze(
  [...PROFILES.values()].map((p) => ({
      id: p.id,
      declaredStandard: p.declaredStandard,
      creationAllowed: p.creationAllowed,
      legacy: p.legacy,
      coaVersion: p.coaVersion,
      reportMappingVersion: p.reportMappingVersion,
    scope: p.scope,
    sources: p.sources,
  }))
);

// ---------------------------------------------------------------- 公开接口
/** 返回 profile 摘要列表（含 legacy；冻结、可序列化）。 */
export function listAccountingProfiles() {
  return PROFILE_LIST;
}

/** 精确查找 profile 描述；未知 ID 抛错（code=accounting_profile_unknown），不 fallback。 */
export function getAccountingProfile(profileId) {
  if (typeof profileId !== "string" || profileId.trim() === "") {
    throw profileError("accounting_profile_unknown", "profileId 必须是非空字符串");
  }
  const profile = PROFILES.get(profileId);
  if (!profile) {
    throw profileError("accounting_profile_unknown", `未知会计 profile：${profileId}`);
  }
  return profile;
}

/**
 * 选择“新建账套”可用 profile。省略准则时默认小企业准则；不做任何写入。
 * 错误：accounting_standard_invalid / accounting_profile_unknown /
 *       accounting_profile_standard_mismatch / accounting_profile_legacy_not_creatable
 */
export function resolveNewAccountingProfile(options = {}) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw profileError(
      "accounting_standard_invalid",
      "参数必须是对象，例如 { accounting_standard, profileId }"
    );
  }

  const rawStandard = options.accounting_standard;
  let standard = null;
  if (rawStandard !== undefined) {
    if (typeof rawStandard !== "string" || rawStandard.trim() === "") {
      throw profileError("accounting_standard_invalid", "accounting_standard 必须是非空字符串");
    }
    if (!Object.prototype.hasOwnProperty.call(STANDARD_TO_PROFILE, rawStandard)) {
      throw profileError(
        "accounting_standard_invalid",
        `不支持的会计准则：${rawStandard}（仅接受精确的“小企业会计准则”或“企业会计准则”）`
      );
    }
    standard = rawStandard;
  }

  const rawProfileId = options.profileId;
  if (rawProfileId !== undefined) {
    const profile = getAccountingProfile(rawProfileId);
    if (profile.legacy) {
      throw profileError(
        "accounting_profile_legacy_not_creatable",
        `${profile.id} 只能用于旧账套兼容读取，不能用于新建账套`
      );
    }
    if (standard && profile.declaredStandard !== standard) {
      throw profileError(
        "accounting_profile_standard_mismatch",
        `${profile.id} 登记的准则（${profile.declaredStandard}）与请求的 ${standard} 不一致`
      );
    }
    return profile;
  }

  const selectedId = standard ? STANDARD_TO_PROFILE[standard] : STANDARD_TO_PROFILE["小企业会计准则"];
  return PROFILES.get(selectedId);
}

/** 返回冻结的角色表；角色按 profile 解析，不依赖科目名称或编码尾号。 */
export function getAccountingRoles(profileId) {
  return getAccountingProfile(profileId).roles;
}
