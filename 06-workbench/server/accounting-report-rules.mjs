/**
 * accounting-report-rules.mjs — 按 profile 的报表行项目规则与纯计算（LOCAL-03a 阶段 A）。
 *
 * 边界：
 * - 纯规则 / 纯计算模块；不查库、不选期间、不筛 posted、不计提、不做货币字符串或浮点元解析。
 * - 阶段 B 负责从 LOCAL-02 金额函数与已验证查询生成输入：科目自身期末余额（借减贷有符号）或
 *   时间窗内排除结转的损益发生净额，均为安全整数分。
 * - legacy-small-coa-v1 不套用新规则：evaluate 返回 complete=false + legacy_engine_required，
 *   由阶段 B 旧报表兼容路径承接原值。
 *
 * 公开接口（阶段 A 契约）：
 * - getAccountingReportRules(profileId)
 * - resolveAccountingAccountRule(profileId, account)
 * - evaluateAccountingStatement(profileId, { kind, accounts, amounts })
 * - classifyAccountingCashCounterpart(profileId, account)
 */

import { getAccountingProfile, getAccountingRoles } from "./accounting-profiles.mjs";

const CATEGORIES = new Set(["资产", "负债", "权益", "成本", "损益"]);

// ---------------------------------------------------------------- 工具
function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return value;
}

function ruleError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

const z = (value) => (value === 0 ? 0 : value);

function safeAdd(a, b, context) {
  const sum = a + b;
  if (!Number.isSafeInteger(sum)) {
    throw ruleError("amount_overflow", `金额累计超出安全整数范围（${context}）`);
  }
  return sum;
}

// ---------------------------------------------------------------- 行项目构造
const t = (rowId) => ({ rowId, sign: 1 });
const m = (rowId) => ({ rowId, sign: -1 });
const accountsRow = (rowId, label, natural, roots) => ({
  rowId,
  label,
  kind: "accounts",
  natural,
  roots,
});
const subtotalRow = (rowId, label, terms) => ({
  rowId,
  label,
  kind: "subtotal",
  natural: null,
  terms,
});
const unclosedProfitRow = (rowId, label, roots) => ({
  rowId,
  label,
  kind: "unclosed-profit",
  natural: "credit",
  roots,
});

// ---------------------------------------------------------------- 资产负债表行
function smallBalanceSheetRows(plRoots) {
  return [
    accountsRow("cash", "货币资金", "debit", ["1001", "1002", "1012"]),
    accountsRow("short-term-investment", "短期投资", "debit", ["1101"]),
    accountsRow("notes-receivable", "应收票据", "debit", ["1121"]),
    accountsRow("accounts-receivable", "应收账款", "debit", ["1122"]),
    accountsRow("prepayments", "预付账款", "debit", ["1123"]),
    accountsRow("dividends-receivable", "应收股利", "debit", ["1131"]),
    accountsRow("interest-receivable", "应收利息", "debit", ["1132"]),
    accountsRow("other-receivables", "其他应收款", "debit", ["1221"]),
    // 小企口径：生产成本 4001 按存货列示。
    accountsRow("inventory", "存货", "debit", [
      "1401",
      "1402",
      "1403",
      "1405",
      "1408",
      "1411",
      "4001",
    ]),
    accountsRow("fixed-assets-cost", "固定资产原价", "debit", ["1601"]),
    accountsRow("accumulated-depreciation", "减：累计折旧", "debit", ["1602"]),
    subtotalRow("fixed-assets-net", "固定资产账面价值", [
      t("fixed-assets-cost"),
      t("accumulated-depreciation"),
    ]),
    accountsRow("construction-in-progress", "在建工程", "debit", ["1604"]),
    accountsRow("intangible-assets-cost", "无形资产原价", "debit", ["1701"]),
    accountsRow("accumulated-amortization", "减：累计摊销", "debit", ["1702"]),
    subtotalRow("intangible-assets-net", "无形资产账面价值", [
      t("intangible-assets-cost"),
      t("accumulated-amortization"),
    ]),
    accountsRow("long-term-deferred-expenses", "长期待摊费用", "debit", ["1801"]),
    // 原值 / 累计折旧摊销只作展示行，资产总计只取净值，避免重复计入。
    subtotalRow("total-assets", "资产总计", [
      t("cash"),
      t("short-term-investment"),
      t("notes-receivable"),
      t("accounts-receivable"),
      t("prepayments"),
      t("dividends-receivable"),
      t("interest-receivable"),
      t("other-receivables"),
      t("inventory"),
      t("fixed-assets-net"),
      t("construction-in-progress"),
      t("intangible-assets-net"),
      t("long-term-deferred-expenses"),
    ]),
    accountsRow("short-term-loans", "短期借款", "credit", ["2001"]),
    accountsRow("notes-payable", "应付票据", "credit", ["2201"]),
    accountsRow("accounts-payable", "应付账款", "credit", ["2202"]),
    accountsRow("advances-from-customers", "预收账款", "credit", ["2203"]),
    accountsRow("employee-benefits-payable", "应付职工薪酬", "credit", ["2211"]),
    accountsRow("taxes-payable", "应交税费", "credit", ["2221"]),
    accountsRow("interest-payable", "应付利息", "credit", ["2231"]),
    accountsRow("dividends-payable", "应付利润", "credit", ["2232"]),
    accountsRow("other-payables", "其他应付款", "credit", ["2241"]),
    accountsRow("long-term-loans", "长期借款", "credit", ["2501"]),
    accountsRow("long-term-payables", "长期应付款", "credit", ["2701"]),
    subtotalRow("total-liabilities", "负债合计", [
      t("short-term-loans"),
      t("notes-payable"),
      t("accounts-payable"),
      t("advances-from-customers"),
      t("employee-benefits-payable"),
      t("taxes-payable"),
      t("interest-payable"),
      t("dividends-payable"),
      t("other-payables"),
      t("long-term-loans"),
      t("long-term-payables"),
    ]),
    accountsRow("paid-in-capital", "实收资本", "credit", ["3001"]),
    accountsRow("capital-reserve", "资本公积", "credit", ["3002"]),
    accountsRow("surplus-reserve", "盈余公积", "credit", ["3101"]),
    accountsRow("profit-distribution", "利润分配", "credit", ["3104"]),
    accountsRow("current-year-profit", "本年利润", "credit", ["3103"]),
    unclosedProfitRow("unclosed-profit", "未结转损益", plRoots),
    subtotalRow("undistributed-profit", "未分配利润", [
      t("profit-distribution"),
      t("current-year-profit"),
      t("unclosed-profit"),
    ]),
    subtotalRow("total-equity", "所有者权益合计", [
      t("paid-in-capital"),
      t("capital-reserve"),
      t("surplus-reserve"),
      t("undistributed-profit"),
    ]),
    subtotalRow("total-liabilities-and-equity", "负债和所有者权益总计", [
      t("total-liabilities"),
      t("total-equity"),
    ]),
  ];
}

function enterpriseBalanceSheetRows(plRoots) {
  return [
    accountsRow("cash", "货币资金", "debit", ["1001", "1002", "1012"]),
    accountsRow("notes-receivable", "应收票据", "debit", ["1121"]),
    accountsRow("accounts-receivable", "应收账款", "debit", ["1122"]),
    accountsRow("prepayments", "预付款项", "debit", ["1123"]),
    // 企业口径：应收股利 / 应收利息 / 其他应收款按已核实范围汇总列示。
    accountsRow("other-receivables", "其他应收款", "debit", ["1131", "1132", "1221"]),
    // 企业口径：生产成本 5001 按存货列示；4001 是实收资本，绝不进存货。
    accountsRow("inventory", "存货", "debit", [
      "1401",
      "1402",
      "1403",
      "1405",
      "1408",
      "1411",
      "5001",
    ]),
    accountsRow("fixed-assets-cost", "固定资产原价", "debit", ["1601"]),
    accountsRow("accumulated-depreciation", "减：累计折旧", "debit", ["1602"]),
    subtotalRow("fixed-assets-net", "固定资产账面价值", [
      t("fixed-assets-cost"),
      t("accumulated-depreciation"),
    ]),
    accountsRow("construction-in-progress", "在建工程", "debit", ["1604"]),
    accountsRow("intangible-assets-cost", "无形资产原价", "debit", ["1701"]),
    accountsRow("accumulated-amortization", "减：累计摊销", "debit", ["1702"]),
    subtotalRow("intangible-assets-net", "无形资产账面价值", [
      t("intangible-assets-cost"),
      t("accumulated-amortization"),
    ]),
    accountsRow("long-term-deferred-expenses", "长期待摊费用", "debit", ["1801"]),
    subtotalRow("total-assets", "资产总计", [
      t("cash"),
      t("notes-receivable"),
      t("accounts-receivable"),
      t("prepayments"),
      t("other-receivables"),
      t("inventory"),
      t("fixed-assets-net"),
      t("construction-in-progress"),
      t("intangible-assets-net"),
      t("long-term-deferred-expenses"),
    ]),
    accountsRow("short-term-loans", "短期借款", "credit", ["2001"]),
    accountsRow("notes-payable", "应付票据", "credit", ["2201"]),
    accountsRow("accounts-payable", "应付账款", "credit", ["2202"]),
    accountsRow("advances-from-customers", "预收款项", "credit", ["2203"]),
    accountsRow("employee-benefits-payable", "应付职工薪酬", "credit", ["2211"]),
    accountsRow("taxes-payable", "应交税费", "credit", ["2221"]),
    accountsRow("interest-payable", "应付利息", "credit", ["2231"]),
    accountsRow("dividends-payable", "应付股利", "credit", ["2232"]),
    accountsRow("other-payables", "其他应付款", "credit", ["2241"]),
    accountsRow("long-term-loans", "长期借款", "credit", ["2501"]),
    accountsRow("long-term-payables", "长期应付款", "credit", ["2701"]),
    subtotalRow("total-liabilities", "负债合计", [
      t("short-term-loans"),
      t("notes-payable"),
      t("accounts-payable"),
      t("advances-from-customers"),
      t("employee-benefits-payable"),
      t("taxes-payable"),
      t("interest-payable"),
      t("dividends-payable"),
      t("other-payables"),
      t("long-term-loans"),
      t("long-term-payables"),
    ]),
    accountsRow("paid-in-capital", "实收资本", "credit", ["4001"]),
    accountsRow("capital-reserve", "资本公积", "credit", ["4002"]),
    accountsRow("surplus-reserve", "盈余公积", "credit", ["4101"]),
    accountsRow("profit-distribution", "利润分配", "credit", ["4104"]),
    accountsRow("current-year-profit", "本年利润", "credit", ["4103"]),
    unclosedProfitRow("unclosed-profit", "未结转损益", plRoots),
    subtotalRow("undistributed-profit", "未分配利润", [
      t("profit-distribution"),
      t("current-year-profit"),
      t("unclosed-profit"),
    ]),
    subtotalRow("total-equity", "所有者权益合计", [
      t("paid-in-capital"),
      t("capital-reserve"),
      t("surplus-reserve"),
      t("undistributed-profit"),
    ]),
    subtotalRow("total-liabilities-and-equity", "负债和所有者权益总计", [
      t("total-liabilities"),
      t("total-equity"),
    ]),
  ];
}

// ---------------------------------------------------------------- 利润表行
function incomeStatementRows(codes) {
  return [
    accountsRow("operating-revenue", "营业收入", "credit", codes.revenue),
    accountsRow("operating-cost", "营业成本", "debit", codes.cost),
    accountsRow("taxes-and-surcharges", "税金及附加", "debit", [codes.taxes]),
    accountsRow("selling-expense", "销售费用", "debit", [codes.selling]),
    accountsRow("administrative-expense", "管理费用", "debit", [codes.admin]),
    accountsRow("finance-expense", "财务费用", "debit", [codes.finance]),
    accountsRow("investment-income", "投资收益", "credit", [codes.investment]),
    subtotalRow("operating-profit", "营业利润", [
      t("operating-revenue"),
      m("operating-cost"),
      m("taxes-and-surcharges"),
      m("selling-expense"),
      m("administrative-expense"),
      m("finance-expense"),
      t("investment-income"),
    ]),
    accountsRow("non-operating-income", "营业外收入", "credit", [codes.nonOperatingIncome]),
    accountsRow("non-operating-expense", "营业外支出", "debit", [codes.nonOperatingExpense]),
    subtotalRow("total-profit", "利润总额", [
      t("operating-profit"),
      t("non-operating-income"),
      m("non-operating-expense"),
    ]),
    accountsRow("income-tax-expense", "所得税费用", "debit", [codes.incomeTax]),
    subtotalRow("net-profit", "净利润", [t("total-profit"), m("income-tax-expense")]),
  ];
}

const SMALL_INCOME_CODES = {
  revenue: ["5001", "5051"],
  cost: ["5401", "5402"],
  taxes: "5403",
  selling: "5601",
  admin: "5602",
  finance: "5603",
  investment: "5111",
  nonOperatingIncome: "5301",
  nonOperatingExpense: "5711",
  incomeTax: "5801",
};

const ENTERPRISE_INCOME_CODES = {
  revenue: ["6001", "6051"],
  cost: ["6401", "6402"],
  taxes: "6403",
  selling: "6601",
  admin: "6602",
  finance: "6603",
  investment: "6111",
  nonOperatingIncome: "6301",
  nonOperatingExpense: "6711",
  incomeTax: "6801",
};

const BS_TOTALS = {
  assets: "total-assets",
  liabilities: "total-liabilities",
  equity: "total-equity",
  liabilitiesAndEquity: "total-liabilities-and-equity",
};

const IS_TOTALS = {
  operatingRevenue: "operating-revenue",
  operatingProfit: "operating-profit",
  totalProfit: "total-profit",
  netProfit: "net-profit",
};

// ---------------------------------------------------------------- 现金流对方科目分类
// 只覆盖“单一对方科目、可解释”的基础交易；复杂复合凭证分摊、现金等价物 / 受限资金
// 判定与完整现金流量表归阶段 B / LOCAL-05b。
const CASH_FLOW_RULES = {
  "small-2011-basic-v1": {
    operatingRoots: [
      "1121",
      "1122",
      "1123",
      "1131",
      "1132",
      "1221",
      "1401",
      "1402",
      "1403",
      "1405",
      "1408",
      "1411",
      "2201",
      "2202",
      "2203",
      "2211",
      "2221",
      "2241",
      "4001",
      "5001",
      "5051",
      "5301",
      "5401",
      "5402",
      "5403",
      "5601",
      "5602",
      "5603",
      "5711",
      "5801",
    ],
    investingRoots: ["1101", "1601", "1602", "1604", "1701", "1702", "1801", "5111"],
    financingRoots: ["2001", "2232", "2501", "2701", "3001", "3002", "3101", "3103", "3104"],
    ambiguousRoots: [
      { root: "2231", reason: "interest-payment-classification-ambiguous" },
    ],
  },
  "enterprise-2019-general-basic-v1": {
    operatingRoots: [
      "1121",
      "1122",
      "1123",
      "1131",
      "1132",
      "1221",
      "1401",
      "1402",
      "1403",
      "1405",
      "1408",
      "1411",
      "2201",
      "2202",
      "2203",
      "2211",
      "2221",
      "2241",
      "5001",
      "6001",
      "6051",
      "6301",
      "6401",
      "6402",
      "6403",
      "6601",
      "6602",
      "6603",
      "6711",
      "6801",
    ],
    investingRoots: ["1601", "1602", "1604", "1701", "1702", "1801", "6111"],
    financingRoots: ["2001", "2232", "2501", "2701", "4001", "4002", "4101", "4103", "4104"],
    ambiguousRoots: [
      { root: "2231", reason: "interest-payment-classification-ambiguous" },
    ],
  },
};

const CASH_FLOW_UNSUPPORTED = [
  "proportional-allocation-of-multi-counterpart-vouchers",
  "cash-equivalents-and-restricted-cash-judgement",
  "complete-cash-flow-statement-engine",
  "indirect-method-reconciliation",
];

// ---------------------------------------------------------------- 规则装配
const RULES_CACHE = new Map();

function rootsUsedBy(statementRows) {
  const used = new Set();
  for (const row of statementRows) for (const root of row.roots || []) used.add(root);
  return used;
}

function buildRules(profile) {
  if (profile.legacy) {
    const legacyNotes = [
      "legacy profile 不使用新报表规则；阶段 B 必须走旧报表兼容路径并验证原值。",
      "不把新 profile 的行项目套到旧账套，避免历史被重新解释。",
    ];
    const rules = {
      profileId: profile.id,
      reportMappingVersion: profile.reportMappingVersion,
      engineMode: "legacy-compatibility",
      delegatedTo: "legacy-report-path",
      statementKinds: [],
      balanceSheet: {
        engineMode: "legacy-compatibility",
        rows: [],
        totals: {},
        unsupported: [],
        requiredDetails: [],
      },
      incomeStatement: {
        engineMode: "legacy-compatibility",
        rows: [],
        totals: {},
        unsupported: [],
        requiredDetails: [],
      },
      cashFlow: {
        engineMode: "legacy-compatibility",
        scope: "legacy-report-path",
        operatingRoots: [],
        investingRoots: [],
        financingRoots: [],
        ambiguousRoots: [],
        unsupported: CASH_FLOW_UNSUPPORTED,
      },
      unsupported: [
        {
          code: "legacy_engine_required",
          name: "legacy 兼容报表",
          reason: "legacy-engine-must-use-old-report-path",
        },
      ],
      requiredDetails: [],
      notes: legacyNotes,
    };
    return {
      rules: deepFreeze(rules),
      balanceSheetIndex: new Map(),
      incomeStatementIndex: new Map(),
      roles: profile.roles,
    };
  }

  const plRoots = profile.coa
    .filter((a) => a.category === "损益" && a.scope.status === "mapped")
    .map((a) => a.code);

  const balanceSheetRows =
    profile.id === "small-2011-basic-v1"
      ? smallBalanceSheetRows(plRoots)
      : enterpriseBalanceSheetRows(plRoots);
  const incomeRows = incomeStatementRows(
    profile.id === "small-2011-basic-v1" ? SMALL_INCOME_CODES : ENTERPRISE_INCOME_CODES
  );

  const notMapped = profile.coa
    .filter((a) => a.scope.status !== "mapped")
    .map((a) => ({
      code: a.code,
      name: a.name,
      category: a.category,
      status: a.scope.status,
      reason: a.scope.reason,
    }));

  const requiredDetails = notMapped.filter((a) => a.status === "requires_detail");
  const unsupportedAccounts = notMapped.filter((a) => a.status === "unsupported");

  const usedRoots = new Set([
    ...rootsUsedBy(balanceSheetRows),
    ...rootsUsedBy(incomeRows),
  ]);
  const coaRoots = new Set(profile.coa.map((a) => a.code));
  // 规则引用的每个根科目必须真的存在于 profile COA（防止跨 profile 混用编码）。
  for (const root of usedRoots) {
    if (!coaRoots.has(root)) {
      throw ruleError(
        "report_rule_root_unknown",
        `profile ${profile.id} 的报表规则引用了不存在的科目 ${root}`
      );
    }
  }

  const cashFlow = CASH_FLOW_RULES[profile.id];
  const rules = {
    profileId: profile.id,
    reportMappingVersion: profile.reportMappingVersion,
    engineMode: "profile-rules",
    delegatedTo: null,
    statementKinds: ["balance-sheet", "income-statement"],
    balanceSheet: {
      engineMode: "profile-rules",
      rows: balanceSheetRows,
      totals: BS_TOTALS,
      unsupported: unsupportedAccounts,
      requiredDetails,
    },
    incomeStatement: {
      engineMode: "profile-rules",
      rows: incomeRows,
      totals: IS_TOTALS,
      unsupported: unsupportedAccounts,
      requiredDetails,
    },
    cashFlow: {
      engineMode: "counterpart-classification-only",
      scope: "single-counterpart-simple-vouchers-only",
      operatingRoots: cashFlow.operatingRoots,
      investingRoots: cashFlow.investingRoots,
      financingRoots: cashFlow.financingRoots,
      ambiguousRoots: cashFlow.ambiguousRoots,
      unsupported: CASH_FLOW_UNSUPPORTED,
    },
    unsupported: [...unsupportedAccounts, ...requiredDetails],
    requiredDetails,
    notes: [
      "内部简化行项目，不是法定完整财务报表，也不是税局上传文件。",
      "报表金额必须由阶段 B 的已验证查询 / 金额函数生成；本模块不判断期间、posted 或结转。",
      "税费 / 财务费用只汇总已记录分录，不等于自动算税。",
    ],
  };

  const balanceSheetIndex = new Map();
  for (const row of balanceSheetRows) {
    for (const root of row.roots || []) {
      balanceSheetIndex.set(
        root,
        row.kind === "unclosed-profit"
          ? { rowId: row.rowId, via: "undistributed-profit" }
          : { rowId: row.rowId, via: "row" }
      );
    }
  }
  const incomeStatementIndex = new Map();
  for (const row of incomeRows) {
    for (const root of row.roots || []) {
      incomeStatementIndex.set(root, { rowId: row.rowId, via: "row" });
    }
  }

  return {
    rules: deepFreeze(rules),
    balanceSheetIndex,
    incomeStatementIndex,
    roles: profile.roles,
  };
}

function getEntry(profileId) {
  const profile = getAccountingProfile(profileId);
  let entry = RULES_CACHE.get(profile.id);
  if (!entry) {
    entry = buildRules(profile);
    RULES_CACHE.set(profile.id, entry);
  }
  return entry;
}

// ---------------------------------------------------------------- 输入规范化
function normalizeAccount(account) {
  if (account === null || typeof account !== "object" || Array.isArray(account)) {
    throw ruleError("account_shape_invalid", "account 必须是对象");
  }
  const code = account.code;
  if (typeof code !== "string" || !/^\d{4,}$/.test(code)) {
    throw ruleError("account_code_invalid", "account.code 必须是以 4 位以上数字组成的字符串");
  }
  if (!CATEGORIES.has(account.category)) {
    throw ruleError("account_category_invalid", "account.category 必须是 资产/负债/权益/成本/损益");
  }
  if (account.direction !== "debit" && account.direction !== "credit") {
    throw ruleError("account_direction_invalid", "account.direction 必须是 debit 或 credit");
  }
  const rawContra = account.contra;
  let contra = false;
  if (rawContra !== undefined && rawContra !== null) {
    if (typeof rawContra !== "boolean") {
      throw ruleError("account_contra_invalid", "account.contra 必须是布尔值或省略");
    }
    contra = rawContra;
  }
  return {
    code,
    category: account.category,
    direction: account.direction,
    contra,
    name: typeof account.name === "string" ? account.name : null,
  };
}

function normalizeAccounts(accounts) {
  if (!Array.isArray(accounts)) {
    throw ruleError("statement_accounts_invalid", "accounts 必须是科目数组");
  }
  const map = new Map();
  for (const raw of accounts) {
    const account = normalizeAccount(raw);
    if (map.has(account.code)) {
      throw ruleError("account_code_duplicate", `accounts 中 code 重复：${account.code}`);
    }
    map.set(account.code, account);
  }
  return map;
}

function normalizeAmounts(amounts, accountMap) {
  if (!Array.isArray(amounts)) {
    throw ruleError("statement_amounts_invalid", "amounts 必须是 { code, netMinor } 数组");
  }
  const seen = new Set();
  const out = [];
  for (const raw of amounts) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw ruleError("amount_invalid", "amounts 每项必须是对象");
    }
    const code = raw.code;
    if (typeof code !== "string" || code.trim() === "") {
      throw ruleError("amount_invalid", "amounts[].code 必须是非空字符串");
    }
    if (seen.has(code)) {
      throw ruleError("amount_code_duplicate", `amounts 中 code 重复：${code}`);
    }
    seen.add(code);
    if (!accountMap.has(code)) {
      throw ruleError("amount_account_missing", `amounts 引用了 accounts 中不存在的科目：${code}`);
    }
    const netMinor = raw.netMinor;
    if (typeof netMinor !== "number" || !Number.isSafeInteger(netMinor)) {
      throw ruleError(
        "amount_invalid",
        `amounts[].netMinor 必须是安全整数分：${code}（不接受字符串、NaN、Infinity、小数或隐式归零）`
      );
    }
    out.push({ code, netMinor: z(netMinor) });
  }
  return out;
}

// ---------------------------------------------------------------- 科目解析
function matchRoot(profile, code) {
  const byCode = new Map();
  for (const item of profile.coa) byCode.set(item.code, item);
  if (byCode.has(code)) return { root: byCode.get(code), isDetail: false };
  for (let len = code.length - 1; len >= 4; len -= 1) {
    const head = code.slice(0, len);
    const root = byCode.get(head);
    if (!root) continue;
    const suffix = code.slice(len);
    // 只接受纯数字后缀；"5001x" 之类的字符串不得被当成明细科目。
    if (/^\d+$/.test(suffix)) return { root, isDetail: true };
  }
  return { root: null, isDetail: false };
}

function rolesForRoot(roles, rootCode) {
  const matched = [];
  for (const [role, value] of Object.entries(roles)) {
    if (Array.isArray(value) ? value.includes(rootCode) : value === rootCode) matched.push(role);
  }
  return matched.sort();
}

function resolveAccount(profile, entry, account) {
  const diagnostics = [];
  const match = matchRoot(profile, account.code);
  if (!match.root) {
    diagnostics.push({
      code: "account_unmapped",
      message: `科目 ${account.code} 不在 profile ${profile.id} 已验证的根科目 / 数字明细范围内`,
      accountCode: account.code,
    });
    return {
      accountCode: account.code,
      accountName: account.name,
      matchedRoot: null,
      isDetail: false,
      roles: [],
      effective: {
        category: account.category,
        direction: account.direction,
        contra: account.contra,
      },
      scope: { status: "unmapped" },
      statements: { balanceSheet: null, incomeStatement: null },
      compatible: false,
      diagnostics,
    };
  }

  const root = match.root;
  const rootScope = root.scope || { status: "legacy" };
  if (root.category !== account.category) {
    diagnostics.push({
      code: "account_category_conflict",
      message: `科目 ${account.code} 类别 ${account.category} 与 profile 根科目 ${root.code}（${root.category}）冲突`,
      accountCode: account.code,
      matchedRoot: root.code,
    });
  }
  if (root.direction !== account.direction) {
    diagnostics.push({
      code: "account_direction_conflict",
      message: `科目 ${account.code} 方向 ${account.direction} 与 profile 根科目 ${root.code}（${root.direction}）冲突`,
      accountCode: account.code,
      matchedRoot: root.code,
    });
  }
  if (account.contra && !root.contra) {
    diagnostics.push({
      code: "account_contra_conflict",
      message: `科目 ${account.code} 声明为备抵，但 profile 根科目 ${root.code} 不是备抵科目`,
      accountCode: account.code,
      matchedRoot: root.code,
    });
  }
  // 备抵语义对明细科目可继承；非备抵根科目下不得自行声明备抵（上方已诊断）。
  const effectiveContra = Boolean(root.contra) || account.contra;

  return {
    accountCode: account.code,
    accountName: account.name,
    matchedRoot: root.code,
    isDetail: match.isDetail,
    roles: rolesForRoot(entry.roles, root.code),
    effective: {
      category: root.category,
      direction: root.direction,
      contra: effectiveContra,
    },
    scope: rootScope.reason
      ? { status: rootScope.status, reason: rootScope.reason }
      : { status: rootScope.status },
    statements: {
      balanceSheet: entry.balanceSheetIndex.get(root.code) || null,
      incomeStatement: entry.incomeStatementIndex.get(root.code) || null,
    },
    compatible: diagnostics.length === 0,
    diagnostics,
  };
}

// ---------------------------------------------------------------- 公开接口
/** 返回该 profile 冻结、可序列化的报表规则描述。 */
export function getAccountingReportRules(profileId) {
  return getEntry(profileId).rules;
}

/**
 * 解析单个科目在本 profile 下的规则。
 * 名称只作展示，不参与分类；编码必须匹配已验证根科目或纯数字明细后缀。
 */
export function resolveAccountingAccountRule(profileId, account) {
  const profile = getAccountingProfile(profileId);
  const entry = getEntry(profile.id);
  const normalized = normalizeAccount(account);
  const resolved = resolveAccount(profile, entry, normalized);
  if (profile.legacy) {
    resolved.diagnostics = [
      ...resolved.diagnostics,
      {
        code: "legacy_engine_required",
        message: "legacy profile 必须走阶段 B 旧报表兼容路径，新报表规则不适用",
        accountCode: normalized.code,
      },
    ];
    resolved.compatible = false;
  }
  return deepFreeze(resolved);
}

/**
 * 纯计算入口。accounts：账套科目形状数组（code 唯一）；
 * amounts：[{ code, netMinor }]，netMinor 为安全整数分、借减贷、各科目自身金额。
 * 资产负债表输入“截至期间的期末余额”，利润表输入“时间窗内排除结转的损益发生净额”。
 */
export function evaluateAccountingStatement(profileId, options = {}) {
  const profile = getAccountingProfile(profileId);
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw ruleError("statement_input_invalid", "evaluate 参数必须是对象");
  }
  const { kind, accounts, amounts } = options;
  if (kind !== "balance-sheet" && kind !== "income-statement") {
    throw ruleError("statement_kind_invalid", "kind 只能是 balance-sheet 或 income-statement");
  }

  if (profile.legacy) {
    // 不套用新规则、不伪造完整金额：阶段 B 必须接旧兼容路径。
    return deepFreeze({
      profileId: profile.id,
      reportMappingVersion: profile.reportMappingVersion,
      engineMode: "legacy-compatibility",
      kind,
      complete: false,
      rows: [],
      totals: {},
      diagnostics: [
        {
          code: "legacy_engine_required",
          severity: "error",
          message:
            "legacy 账套必须由阶段 B 旧报表兼容路径出数；本函数不提供新规则计算结果，也不返回假装完整的金额",
        },
      ],
    });
  }

  const entry = getEntry(profile.id);
  const accountMap = normalizeAccounts(accounts);
  const amountList = normalizeAmounts(amounts, accountMap);
  const isBalanceSheet = kind === "balance-sheet";
  const statement = isBalanceSheet ? entry.rules.balanceSheet : entry.rules.incomeStatement;

  const rowSums = new Map();
  const diagnostics = [];
  let unclosedSum = 0;

  for (const item of amountList) {
    if (item.netMinor === 0) continue;
    const account = accountMap.get(item.code);
    const resolved = resolveAccount(profile, entry, account);

    if (!resolved.matchedRoot) {
      diagnostics.push({
        code: "account_unmapped",
        severity: "error",
        message: `非零金额科目 ${item.code} 未映射到 profile ${profile.id} 的已验证科目`,
        accountCode: item.code,
        amountMinor: item.netMinor,
      });
      continue;
    }
    if (!resolved.compatible) {
      for (const diagnostic of resolved.diagnostics) {
        diagnostics.push({
          ...diagnostic,
          severity: "error",
          amountMinor: item.netMinor,
        });
      }
      continue;
    }
    const status = resolved.scope.status;
    if (status === "requires_detail") {
      diagnostics.push({
        code: "account_requires_detail",
        severity: "error",
        message: `非零金额科目 ${item.code}（${resolved.accountName ?? ""}）需要明细资料才能归类`,
        accountCode: item.code,
        matchedRoot: resolved.matchedRoot,
        reason: resolved.scope.reason,
        amountMinor: item.netMinor,
      });
      continue;
    }
    if (status === "unsupported") {
      diagnostics.push({
        code: "account_scope_unsupported",
        severity: "error",
        message: `非零金额科目 ${item.code}（${resolved.accountName ?? ""}）对应业务本包未实现`,
        accountCode: item.code,
        matchedRoot: resolved.matchedRoot,
        reason: resolved.scope.reason,
        amountMinor: item.netMinor,
      });
      continue;
    }
    if (status !== "mapped") {
      diagnostics.push({
        code: "account_scope_unknown",
        severity: "error",
        message: `科目 ${item.code} 的 profile 支持状态不明确（${status}）`,
        accountCode: item.code,
        matchedRoot: resolved.matchedRoot,
        amountMinor: item.netMinor,
      });
      continue;
    }

    if (isBalanceSheet) {
      const usage = resolved.statements.balanceSheet;
      if (!usage) {
        diagnostics.push({
          code: "account_out_of_statement",
          severity: "error",
          message: `科目 ${item.code}（${resolved.accountName ?? ""}）不进入资产负债表规则`,
          accountCode: item.code,
          matchedRoot: resolved.matchedRoot,
          amountMinor: item.netMinor,
        });
        continue;
      }
      if (usage.via === "undistributed-profit") {
        unclosedSum = safeAdd(unclosedSum, item.netMinor, `未结转损益 ${item.code}`);
        continue;
      }
      const current = rowSums.get(usage.rowId) || 0;
      rowSums.set(
        usage.rowId,
        safeAdd(current, item.netMinor, `行项目 ${usage.rowId} / ${item.code}`)
      );
      continue;
    }

    const usage = resolved.statements.incomeStatement;
    if (!usage) {
      diagnostics.push({
        code: "account_out_of_statement",
        severity: "error",
        message: `科目 ${item.code}（${resolved.accountName ?? ""}）不进入利润表规则`,
        accountCode: item.code,
        matchedRoot: resolved.matchedRoot,
        amountMinor: item.netMinor,
      });
      continue;
    }
    const current = rowSums.get(usage.rowId) || 0;
    rowSums.set(usage.rowId, safeAdd(current, item.netMinor, `行项目 ${usage.rowId} / ${item.code}`));
  }

  const rowValues = new Map();
  for (const row of statement.rows) {
    if (row.kind === "accounts") {
      const signed = rowSums.get(row.rowId) || 0;
      rowValues.set(row.rowId, row.natural === "credit" ? -signed : signed);
    } else if (row.kind === "unclosed-profit") {
      rowValues.set(row.rowId, -unclosedSum);
    } else {
      let value = 0;
      for (const term of row.terms) {
        const operand = rowValues.get(term.rowId);
        if (operand === undefined) {
          throw ruleError(
            "report_rule_invalid",
            `行项目 ${row.rowId} 依赖未先定义的行 ${term.rowId}`
          );
        }
        value = safeAdd(value, term.sign * operand, `行项目 ${row.rowId}`);
      }
      rowValues.set(row.rowId, value);
    }
  }

  const rows = statement.rows.map((row) => ({
    id: row.rowId,
    label: row.label,
    valueMinor: z(rowValues.get(row.rowId) ?? 0),
  }));

  const totals = {};
  for (const [name, rowId] of Object.entries(statement.totals)) {
    const value = rowValues.get(rowId);
    if (value === undefined) {
      throw ruleError("report_rule_invalid", `合计 ${name} 引用了不存在的行 ${rowId}`);
    }
    totals[name] = z(value);
  }

  return deepFreeze({
    profileId: profile.id,
    reportMappingVersion: profile.reportMappingVersion,
    engineMode: "profile-rules",
    kind,
    complete: diagnostics.length === 0,
    rows,
    totals,
    diagnostics,
  });
}

/**
 * 单一对方科目现金交易分类。只返回 operating / investing / financing 或 unknown+reason；
 * 不是完整现金流量表引擎，不猜受限资金 / 现金等价物，也不按比例分摊复合凭证。
 */
export function classifyAccountingCashCounterpart(profileId, account) {
  const profile = getAccountingProfile(profileId);
  const normalized = normalizeAccount(account);
  if (profile.legacy) {
    return deepFreeze({
      accountCode: normalized.code,
      accountName: normalized.name,
      matchedRoot: null,
      category: "unknown",
      reason: "legacy_engine_required",
      message: "legacy 账套的现金流分类由阶段 B 旧报表兼容路径承接",
    });
  }
  const entry = getEntry(profile.id);
  const resolved = resolveAccount(profile, entry, normalized);

  const unknown = (reason, extra = {}) =>
    deepFreeze({
      accountCode: normalized.code,
      accountName: normalized.name,
      matchedRoot: resolved.matchedRoot,
      category: "unknown",
      reason,
      ...extra,
    });

  if (!resolved.matchedRoot) return unknown("counterpart_unmapped");
  if (!resolved.compatible) {
    return unknown(resolved.diagnostics[0].code, {
      detail: resolved.diagnostics[0].message,
    });
  }
  if (getAccountingRoles(profile.id).cashRoots.includes(resolved.matchedRoot)) {
    return unknown("counterpart_is_cash", {
      detail: "现金 / 银行之间的划转没有可分类的非现金对方科目",
    });
  }
  if (resolved.scope.status !== "mapped") {
    return unknown(`counterpart_scope_${resolved.scope.status}`, {
      detail: resolved.scope.reason ?? null,
    });
  }

  const cashFlow = entry.rules.cashFlow;
  const root = resolved.matchedRoot;
  if (cashFlow.operatingRoots.includes(root)) {
    return deepFreeze({
      accountCode: normalized.code,
      accountName: normalized.name,
      matchedRoot: root,
      category: "operating",
      reason: null,
    });
  }
  if (cashFlow.investingRoots.includes(root)) {
    return deepFreeze({
      accountCode: normalized.code,
      accountName: normalized.name,
      matchedRoot: root,
      category: "investing",
      reason: null,
    });
  }
  if (cashFlow.financingRoots.includes(root)) {
    return deepFreeze({
      accountCode: normalized.code,
      accountName: normalized.name,
      matchedRoot: root,
      category: "financing",
      reason: null,
    });
  }
  const ambiguous = cashFlow.ambiguousRoots.find((item) => item.root === root);
  if (ambiguous) return unknown(ambiguous.reason);
  return unknown("classification_not_verified");
}
