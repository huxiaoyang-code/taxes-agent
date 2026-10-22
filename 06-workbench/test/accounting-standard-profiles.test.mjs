#!/usr/bin/env node
/**
 * LOCAL-03a 阶段 A：纯会计 profile / 报表规则回归测试。
 *
 * 边界：
 * - 不导入 db / accounting，不建库、不建账套、不起服务、不发请求、不读环境变量；
 * - 只读导入现状 coa.mjs 作 legacy 等值对照；
 * - 金额全部是内联的合成整数分快照，预期值为手算字面量，不由 profile / 规则 / 聚合 helper 反算。
 * - 本套件只证明纯规则；迁移、真实建账 / 导入 / 结转 / HTTP / Agent / MCP / 导出接线属阶段 B。
 *
 * 运行：node test/accounting-standard-profiles.test.mjs（cwd = 06-workbench）
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { COA } from "../server/coa.mjs";
import {
  listAccountingProfiles,
  getAccountingProfile,
  resolveNewAccountingProfile,
  getAccountingRoles,
} from "../server/accounting-profiles.mjs";
import {
  getAccountingReportRules,
  resolveAccountingAccountRule,
  evaluateAccountingStatement,
  classifyAccountingCashCounterpart,
} from "../server/accounting-report-rules.mjs";

const LEGACY = "legacy-small-coa-v1";
const SMALL = "small-2011-basic-v1";
const ENTERPRISE = "enterprise-2019-general-basic-v1";

const ROLE_KEYS = [
  "cashRoots",
  "capital",
  "capitalReserve",
  "surplusReserve",
  "currentYearProfit",
  "profitDistribution",
  "productionCost",
  "mainRevenue",
  "otherRevenue",
  "mainCost",
  "otherCost",
  "adminExpense",
  "defaultDepreciationExpense",
  "fixedAsset",
  "accumulatedDepreciation",
  "intangibleAsset",
  "accumulatedAmortization",
];

const results = [];
const test = (name, fn) => {
  try {
    fn();
    results.push([true, name]);
    console.log(`  ✓ ${name}`);
  } catch (error) {
    results.push([false, name]);
    console.log(`  ✗ ${name}\n    ${error?.message ?? error}`);
  }
};

// ---------------------------------------------------------------- 工具
const A = (code, category, direction, contra) => {
  const account = { code, category, direction };
  if (contra !== undefined) account.contra = contra;
  return account;
};
const money = (pairs) => pairs.map(([code, netMinor]) => ({ code, netMinor }));
const catalogOf = (profileId) =>
  getAccountingProfile(profileId).coa.map((item) => ({
    code: item.code,
    category: item.category,
    direction: item.direction,
    ...(item.contra ? { contra: true } : {}),
  }));
const bs = (profileId, accounts, amounts) =>
  evaluateAccountingStatement(profileId, { kind: "balance-sheet", accounts, amounts });
const is = (profileId, accounts, amounts) =>
  evaluateAccountingStatement(profileId, { kind: "income-statement", accounts, amounts });
const rowValue = (result, rowId) => {
  const found = result.rows.find((row) => row.id === rowId);
  assert.ok(found, `结果缺少行项目 ${rowId}`);
  return found.valueMinor;
};
const diagnosticCodes = (result) => result.diagnostics.map((item) => item.code);
const errorCode = (fn) => {
  try {
    fn();
  } catch (error) {
    return error.code ?? null;
  }
  return assert.fail("预期抛出结构化错误，但未抛出");
};
const assertDeepFrozen = (value, label) => {
  if (value === null || typeof value !== "object") return;
  assert.ok(Object.isFrozen(value), `${label} 应被冻结`);
  for (const [key, child] of Object.entries(value)) assertDeepFrozen(child, `${label}.${key}`);
};

console.log("\nLOCAL-03a 阶段 A 纯 profile / 报表规则\n");

// ================================================================ 1. legacy COA 快照
test("legacy COA 与基线 coa.mjs 完整逐项等值（顺序 / 字段 / contra 有无）", () => {
  const legacy = getAccountingProfile(LEGACY);
  assert.equal(legacy.coa.length, COA.length, "legacy 科目数必须与基线一致");
  assert.deepStrictEqual(legacy.coa, COA);
  assert.deepStrictEqual(
    legacy.coa.map((item) => item.code),
    COA.map((item) => item.code),
    "编码顺序必须与基线一致"
  );
  COA.forEach((item, index) => {
    const snapshot = legacy.coa[index];
    assert.equal(
      Object.prototype.hasOwnProperty.call(snapshot, "contra"),
      Object.prototype.hasOwnProperty.call(item, "contra"),
      `${item.code} 的 contra 有无必须与基线一致`
    );
    assert.deepStrictEqual(Object.keys(snapshot).sort(), Object.keys(item).sort());
  });
  assert.deepStrictEqual(
    legacy.coa.filter((item) => item.contra).map((item) => item.code),
    ["1602", "1702"],
    "备抵科目集合必须与基线一致"
  );
  const source = legacy.sources.find((item) => item.sourceId === "repo-coa-baseline");
  assert.ok(source, "legacy 必须记录快照来源");
  assert.equal(source.baselineCommit, "98977e04bd24aa293074021802191814f8c2a1d2");
  assert.equal(source.sourceFile, "06-workbench/server/coa.mjs");
  assert.equal(
    source.sourceSha256,
    "cc49061c56eb2574d52b33708cf5b52564dad9ef30b88a669c596467989d8f2e"
  );
});

test("profile / COA / roles / 来源全部深冻结且可序列化，返回对象不可被污染", () => {
  for (const profileId of [LEGACY, SMALL, ENTERPRISE]) {
    const profile = getAccountingProfile(profileId);
    assertDeepFrozen(profile, profileId);
    const roundTrip = JSON.parse(JSON.stringify(profile));
    assert.deepStrictEqual(roundTrip.coa, profile.coa);
    assert.deepStrictEqual(roundTrip.roles, profile.roles);
    assert.throws(() => {
      profile.coa.push({ code: "9999" });
    }, TypeError);
    assert.throws(() => {
      profile.roles.capital = "9999";
    }, TypeError);
    assert.throws(() => {
      profile.coa[0].name = "被改写";
    }, TypeError);
    assert.equal(profile.coa[0].name, getAccountingProfile(profileId).coa[0].name);
    // 不暴露数据库 ID / 本机路径。
    const text = JSON.stringify(profile);
    assert.ok(!text.includes("account_set_id"), "描述不得含数据库字段名");
    assert.ok(!text.includes("有数云fork"), "描述不得含本机路径");
  }
});

test("listAccountingProfiles 摘要字段完整，legacy 不可新建且不是第三种法定准则", () => {
  const list = listAccountingProfiles();
  assert.deepStrictEqual(
    list.map((item) => item.id),
    [LEGACY, SMALL, ENTERPRISE]
  );
  for (const item of list) {
    for (const key of [
      "id",
      "declaredStandard",
      "creationAllowed",
      "legacy",
      "coaVersion",
      "reportMappingVersion",
      "scope",
      "sources",
    ]) {
      assert.ok(key in item, `${item.id} 缺少摘要字段 ${key}`);
    }
    assert.ok(Array.isArray(item.sources) && item.sources.length > 0, `${item.id} 必须记录来源`);
    assert.ok(item.sources.every((source) => typeof source.sourceId === "string"));
  }
  assert.equal(list[0].legacy, true);
  assert.equal(list[0].creationAllowed, false);
  assert.equal(list[0].declaredStandard, null, "legacy 不是第三种法定准则");
  assert.equal(list[1].declaredStandard, "小企业会计准则");
  assert.equal(list[2].declaredStandard, "企业会计准则");
  assert.ok(Object.isFrozen(list) && Object.isFrozen(list[1].scope));
});

test("getAccountingProfile 精确查找，未知 / 空 / 非字符串 ID 一律拒绝且不 fallback", () => {
  for (const bad of ["", "   ", "nope", "small-2011-basic-v2", null, 2011, {}]) {
    assert.equal(errorCode(() => getAccountingProfile(bad)), "accounting_profile_unknown");
  }
  assert.equal(getAccountingProfile(SMALL).id, SMALL);
  assert.equal(getAccountingProfile(ENTERPRISE).id, ENTERPRISE);
  assert.equal(getAccountingProfile(LEGACY).id, LEGACY);
});

test("resolveNewAccountingProfile：省略准则默认小企，显式选择须精确匹配", () => {
  assert.equal(resolveNewAccountingProfile().id, SMALL);
  assert.equal(resolveNewAccountingProfile(undefined).id, SMALL);
  assert.equal(resolveNewAccountingProfile({}).id, SMALL);
  assert.equal(resolveNewAccountingProfile({ profileId: undefined }).id, SMALL);
  assert.equal(resolveNewAccountingProfile({ accounting_standard: "小企业会计准则" }).id, SMALL);
  assert.equal(resolveNewAccountingProfile({ accounting_standard: "企业会计准则" }).id, ENTERPRISE);
  assert.equal(resolveNewAccountingProfile({ profileId: SMALL }).id, SMALL);
  assert.equal(
    resolveNewAccountingProfile({ accounting_standard: "企业会计准则", profileId: ENTERPRISE }).id,
    ENTERPRISE
  );
  assert.equal(
    resolveNewAccountingProfile({ accounting_standard: "小企业会计准则", profileId: SMALL }).id,
    SMALL
  );
  assert.strictEqual(resolveNewAccountingProfile(), getAccountingProfile(SMALL));
  assert.ok(Object.isFrozen(resolveNewAccountingProfile()));
});

test("resolveNewAccountingProfile：非法准则 / 错配 / legacy / 非法参数结构化拒绝", () => {
  assert.equal(
    errorCode(() => resolveNewAccountingProfile({ profileId: LEGACY })),
    "accounting_profile_legacy_not_creatable"
  );
  assert.equal(
    errorCode(() =>
      resolveNewAccountingProfile({ accounting_standard: "企业会计准则", profileId: SMALL })
    ),
    "accounting_profile_standard_mismatch"
  );
  assert.equal(
    errorCode(() =>
      resolveNewAccountingProfile({ accounting_standard: "小企业会计准则", profileId: LEGACY })
    ),
    "accounting_profile_legacy_not_creatable"
  );
  for (const bad of [
    "小企业会计准则 ",
    " 小企业会计准则",
    "小企业会计制度",
    "企业会计制度",
    "   ",
    "",
    2011,
    null,
    true,
    ["小企业会计准则"],
  ]) {
    assert.equal(
      errorCode(() => resolveNewAccountingProfile({ accounting_standard: bad })),
      "accounting_standard_invalid",
      `准则 ${JSON.stringify(bad)} 应被拒绝`
    );
  }
  for (const bad of [null, [], "小企业会计准则", 2011]) {
    assert.equal(
      errorCode(() => resolveNewAccountingProfile(bad)),
      "accounting_standard_invalid"
    );
  }
  assert.equal(
    errorCode(() => resolveNewAccountingProfile({ profileId: "" })),
    "accounting_profile_unknown"
  );
  assert.equal(
    errorCode(() => resolveNewAccountingProfile({ profileId: "enterprise-2019-general-v1" })),
    "accounting_profile_unknown"
  );
});

test("getAccountingRoles 角色键完整，两新 profile 角色按各自科目解析", () => {
  for (const profileId of [LEGACY, SMALL, ENTERPRISE]) {
    const roles = getAccountingRoles(profileId);
    assert.deepStrictEqual(Object.keys(roles).sort(), [...ROLE_KEYS].sort());
    assert.ok(Object.isFrozen(roles));
  }
  const small = getAccountingRoles(SMALL);
  const enterprise = getAccountingRoles(ENTERPRISE);
  assert.deepStrictEqual(small.cashRoots, ["1001", "1002", "1012"]);
  assert.equal(small.capital, "3001");
  assert.equal(small.capitalReserve, "3002");
  assert.equal(small.surplusReserve, "3101");
  assert.equal(small.currentYearProfit, "3103");
  assert.equal(small.profitDistribution, "3104");
  assert.equal(small.productionCost, "4001");
  assert.equal(small.mainRevenue, "5001");
  assert.equal(small.mainCost, "5401");
  assert.equal(small.adminExpense, "5602");
  assert.equal(small.defaultDepreciationExpense, "5602");
  assert.equal(enterprise.capital, "4001");
  assert.equal(enterprise.capitalReserve, "4002");
  assert.equal(enterprise.surplusReserve, "4101");
  assert.equal(enterprise.currentYearProfit, "4103");
  assert.equal(enterprise.profitDistribution, "4104");
  assert.equal(enterprise.productionCost, "5001");
  assert.equal(enterprise.mainRevenue, "6001");
  assert.equal(enterprise.mainCost, "6401");
  assert.equal(enterprise.adminExpense, "6602");
  assert.equal(enterprise.defaultDepreciationExpense, "6602");
  assert.equal(getAccountingRoles(LEGACY).productionCost, "4001");
  assert.equal(getAccountingRoles(LEGACY).currentYearProfit, "3103");
});

// ================================================================ 2. 两套 COA 差异与科目解析
test("两新 profile COA 实际不同，同码 4001 / 5001 / 5301 含义冲突", () => {
  const smallCoa = getAccountingProfile(SMALL).coa;
  const enterpriseCoa = getAccountingProfile(ENTERPRISE).coa;
  const smallCodes = smallCoa.map((item) => item.code);
  const enterpriseCodes = enterpriseCoa.map((item) => item.code);
  assert.notDeepStrictEqual(smallCodes, enterpriseCodes);
  assert.ok(smallCodes.includes("3001") && !enterpriseCodes.includes("3001"));
  assert.ok(enterpriseCodes.includes("4001") && !smallCodes.includes("6001"));
  const pick = (coa, code) => coa.find((item) => item.code === code);
  assert.deepStrictEqual(
    [
      [pick(smallCoa, "4001").name, pick(smallCoa, "4001").category, pick(smallCoa, "4001").direction],
      [pick(enterpriseCoa, "4001").name, pick(enterpriseCoa, "4001").category, pick(enterpriseCoa, "4001").direction],
    ],
    [
      ["生产成本", "成本", "debit"],
      ["实收资本", "权益", "credit"],
    ]
  );
  assert.deepStrictEqual(
    [
      [pick(smallCoa, "5001").name, pick(smallCoa, "5001").category, pick(smallCoa, "5001").direction],
      [pick(enterpriseCoa, "5001").name, pick(enterpriseCoa, "5001").category, pick(enterpriseCoa, "5001").direction],
    ],
    [
      ["主营业务收入", "损益", "credit"],
      ["生产成本", "成本", "debit"],
    ]
  );
  assert.deepStrictEqual(
    [
      [pick(smallCoa, "5301").name, pick(smallCoa, "5301").category],
      [pick(enterpriseCoa, "5301").name, pick(enterpriseCoa, "5301").category],
    ],
    [
      ["营业外收入", "损益"],
      ["研发支出", "成本"],
    ]
  );
  assert.equal(pick(enterpriseCoa, "4101").name, "盈余公积");
  assert.equal(pick(smallCoa, "4101").name, "制造费用");
});

test("企业 5001 不列收入、企业 4001 不进存货；小企相反", () => {
  const enterpriseRules = getAccountingReportRules(ENTERPRISE);
  const smallRules = getAccountingReportRules(SMALL);
  const rootsOf = (rules, statement, rowId) => {
    const row = rules[statement].rows.find((item) => item.rowId === rowId);
    assert.ok(row, `缺少 ${statement}.${rowId}`);
    return row.roots;
  };
  const enterpriseRevenue = rootsOf(enterpriseRules, "incomeStatement", "operating-revenue");
  assert.ok(enterpriseRevenue.includes("6001"));
  assert.ok(!enterpriseRevenue.includes("5001"), "企业 5001 不得列为收入");
  const enterpriseInventory = rootsOf(enterpriseRules, "balanceSheet", "inventory");
  assert.ok(enterpriseInventory.includes("5001"));
  assert.ok(!enterpriseInventory.includes("4001"), "企业 4001 不得列入存货");
  const smallRevenue = rootsOf(smallRules, "incomeStatement", "operating-revenue");
  assert.ok(smallRevenue.includes("5001") && !smallRevenue.includes("6001"));
  const smallInventory = rootsOf(smallRules, "balanceSheet", "inventory");
  assert.ok(smallInventory.includes("4001") && !smallInventory.includes("5001"));
  // 默认折旧费用角色必须取各自管理费用，不改变旧卡片指定科目。
  const smallExpense = resolveAccountingAccountRule(SMALL, A("5602", "损益", "debit"));
  const enterpriseExpense = resolveAccountingAccountRule(ENTERPRISE, A("6602", "损益", "debit"));
  assert.ok(smallExpense.roles.includes("adminExpense"));
  assert.ok(smallExpense.roles.includes("defaultDepreciationExpense"));
  assert.ok(enterpriseExpense.roles.includes("adminExpense"));
  assert.ok(enterpriseExpense.roles.includes("defaultDepreciationExpense"));
});

test("科目解析：根科目 / 纯数字明细 / 名称只作展示不影响分类", () => {
  const root = resolveAccountingAccountRule(SMALL, A("5001", "损益", "credit"));
  assert.equal(root.matchedRoot, "5001");
  assert.equal(root.isDetail, false);
  assert.deepStrictEqual(root.roles, ["mainRevenue"]);
  assert.deepStrictEqual(root.statements.incomeStatement, { rowId: "operating-revenue", via: "row" });
  assert.deepStrictEqual(root.statements.balanceSheet, {
    rowId: "unclosed-profit",
    via: "undistributed-profit",
  });
  assert.deepStrictEqual(root.diagnostics, []);
  assert.equal(root.compatible, true);

  const detail = resolveAccountingAccountRule(SMALL, A("500101", "损益", "credit"));
  assert.equal(detail.matchedRoot, "5001");
  assert.equal(detail.isDetail, true);
  assert.deepStrictEqual(detail.statements.incomeStatement, {
    rowId: "operating-revenue",
    via: "row",
  });

  const wrongName = resolveAccountingAccountRule(SMALL, {
    code: "5001",
    name: "主营业务成本",
    category: "损益",
    direction: "credit",
  });
  assert.equal(wrongName.accountName, "主营业务成本");
  assert.equal(wrongName.matchedRoot, "5001");
  assert.deepStrictEqual(wrongName.roles, ["mainRevenue"]);
  assert.deepStrictEqual(wrongName.statements.incomeStatement.rowId, "operating-revenue");

  const profitInBs = resolveAccountingAccountRule(SMALL, A("5602", "损益", "debit"));
  assert.deepStrictEqual(profitInBs.statements.balanceSheet, {
    rowId: "unclosed-profit",
    via: "undistributed-profit",
  });
  const productionCost = resolveAccountingAccountRule(SMALL, A("4001", "成本", "debit"));
  assert.deepStrictEqual(productionCost.statements.balanceSheet, { rowId: "inventory", via: "row" });
  assert.equal(productionCost.statements.incomeStatement, null);
  assert.deepStrictEqual(productionCost.roles, ["productionCost"]);
});

test("科目解析：非法编码 / 非数字后缀 / 其他前缀不被 startsWith 猜测", () => {
  for (const bad of ["500", "5001x", "5001 ", "x5001", "", 5001, null]) {
    assert.equal(
      errorCode(() => resolveAccountingAccountRule(SMALL, { code: bad, category: "损益", direction: "credit" })),
      "account_code_invalid"
    );
  }
  // 9001 / 15001 不匹配任何已验证根科目；不得因为含 "5001" 子串被当成收入。
  for (const code of ["9001", "15001", "5002"]) {
    const resolved = resolveAccountingAccountRule(SMALL, A(code, "损益", "credit"));
    assert.equal(resolved.matchedRoot, null);
    assert.equal(resolved.compatible, false);
    assert.deepStrictEqual(diagnosticCodes(resolved), ["account_unmapped"]);
    assert.equal(resolved.statements.incomeStatement, null);
  }
  // 同一编码在不同 profile 下解析到不同根含义，不能靠名称纠正。
  const enterprise5001 = resolveAccountingAccountRule(ENTERPRISE, {
    code: "5001",
    name: "主营业务收入",
    category: "成本",
    direction: "debit",
  });
  assert.equal(enterprise5001.matchedRoot, "5001");
  assert.deepStrictEqual(enterprise5001.roles, ["productionCost"]);
  assert.deepStrictEqual(enterprise5001.statements.incomeStatement, null);
  assert.deepStrictEqual(enterprise5001.statements.balanceSheet, {
    rowId: "inventory",
    via: "row",
  });
});

test("科目解析：类别 / 方向 / 备抵矛盾产生诊断，备抵语义可继承", () => {
  const categoryConflict = resolveAccountingAccountRule(ENTERPRISE, A("5001", "损益", "credit"));
  assert.equal(categoryConflict.compatible, false);
  assert.ok(diagnosticCodes(categoryConflict).includes("account_category_conflict"));
  assert.ok(diagnosticCodes(categoryConflict).includes("account_direction_conflict"));

  const directionConflict = resolveAccountingAccountRule(SMALL, A("5401", "损益", "credit"));
  assert.equal(directionConflict.compatible, false);
  assert.deepStrictEqual(diagnosticCodes(directionConflict), ["account_direction_conflict"]);

  const contraConflict = resolveAccountingAccountRule(SMALL, A("1601", "资产", "debit", true));
  assert.equal(contraConflict.compatible, false);
  assert.deepStrictEqual(diagnosticCodes(contraConflict), ["account_contra_conflict"]);

  const inherited = resolveAccountingAccountRule(SMALL, A("1602", "资产", "credit"));
  assert.equal(inherited.compatible, true);
  assert.equal(inherited.effective.contra, true);
  assert.ok(inherited.roles.includes("accumulatedDepreciation"));

  const detailContra = resolveAccountingAccountRule(ENTERPRISE, A("160201", "资产", "credit"));
  assert.equal(detailContra.compatible, true);
  assert.equal(detailContra.isDetail, true);
  assert.equal(detailContra.effective.contra, true);

  for (const [account, code] of [
    [null, "account_shape_invalid"],
    [[], "account_shape_invalid"],
    [{ code: "1002", category: "现金", direction: "debit" }, "account_category_invalid"],
    [{ code: "1002", category: "资产", direction: "借" }, "account_direction_invalid"],
    [{ code: "1002", category: "资产", direction: "debit", contra: "yes" }, "account_contra_invalid"],
  ]) {
    assert.equal(errorCode(() => resolveAccountingAccountRule(SMALL, account)), code);
  }
});

test("每个预置科目都有可说明 scope 状态，未映射项进入规则清单", () => {
  for (const profileId of [SMALL, ENTERPRISE]) {
    const profile = getAccountingProfile(profileId);
    const rules = getAccountingReportRules(profileId);
    const listed = new Set(rules.unsupported.map((item) => item.code));
    const sourceIds = new Set(profile.sources.map((source) => source.sourceId));
    for (const item of profile.coa) {
      assert.ok(
        typeof item.sourceId === "string" && sourceIds.has(item.sourceId),
        `${profileId} ${item.code} 缺少可核实来源 sourceId`
      );
    }
    for (const item of profile.coa) {
      assert.ok(
        ["mapped", "requires_detail", "unsupported"].includes(item.scope.status),
        `${profileId} ${item.code} 缺少合法 scope 状态`
      );
      if (item.scope.status === "mapped") {
        assert.ok(!listed.has(item.code), `${item.code} 已映射但出现在未覆盖清单`);
      } else {
        assert.ok(typeof item.scope.reason === "string" && item.scope.reason.length > 0);
        assert.ok(listed.has(item.code), `${item.code} 未覆盖但未出现在规则清单`);
      }
    }
    for (const statement of ["balanceSheet", "incomeStatement"]) {
      const unsupportedCodes = new Set(rules[statement].unsupported.map((item) => item.code));
      for (const item of profile.coa) {
        if (item.scope.status === "unsupported") {
          assert.ok(unsupportedCodes.has(item.code), `${statement} 缺少 ${item.code} 的未支持诊断项`);
        }
      }
      const requiredCodes = new Set(rules[statement].requiredDetails.map((item) => item.code));
      for (const item of profile.coa) {
        if (item.scope.status === "requires_detail") {
          assert.ok(requiredCodes.has(item.code), `${statement} 缺少 ${item.code} 的待明细项`);
        }
      }
    }
  }
  const smallRules = getAccountingReportRules(SMALL);
  assert.ok(
    smallRules.unsupported.some(
      (item) => item.code === "4401" && item.reason === "construction-contract-rules-not-implemented"
    )
  );
  const enterpriseRules = getAccountingReportRules(ENTERPRISE);
  assert.ok(
    enterpriseRules.unsupported.some(
      (item) => item.code === "1101" && item.status === "unsupported"
    )
  );
});

// ================================================================ 3. 报表快照（手算字面量）
test("小企三期资产负债表快照：2025-11 / 2025-12 / 2026-01", () => {
  const smallAccounts = catalogOf(SMALL);

  const nov = bs(
    SMALL,
    smallAccounts,
    money([
      ["1002", 1280000],
      ["1405", 80000],
      ["3001", -1200000],
      ["5001", -300000],
      ["5401", 120000],
      ["5602", 20000],
    ])
  );
  assert.equal(nov.complete, true);
  assert.deepStrictEqual(nov.diagnostics, []);
  assert.equal(nov.totals.assets, 1360000);
  assert.equal(nov.totals.liabilities, 0);
  assert.equal(nov.totals.equity, 1360000);
  assert.equal(nov.totals.liabilitiesAndEquity, 1360000);
  assert.equal(rowValue(nov, "cash"), 1280000);
  assert.equal(rowValue(nov, "inventory"), 80000);
  assert.equal(rowValue(nov, "paid-in-capital"), 1200000);
  assert.equal(rowValue(nov, "undistributed-profit"), 160000);

  const dec = bs(
    SMALL,
    smallAccounts,
    money([
      ["1002", 1370000],
      ["1122", 50000],
      ["1405", 20000],
      ["3001", -1200000],
      ["5001", -450000],
      ["5401", 180000],
      ["5602", 30000],
    ])
  );
  assert.equal(dec.complete, true);
  assert.equal(dec.totals.assets, 1440000);
  assert.equal(dec.totals.equity, 1440000);
  assert.equal(rowValue(dec, "accounts-receivable"), 50000);
  assert.equal(rowValue(dec, "inventory"), 20000);
  assert.equal(rowValue(dec, "undistributed-profit"), 240000);

  const jan = bs(
    SMALL,
    smallAccounts,
    money([
      ["1002", 1450000],
      ["1122", 0],
      ["1405", 50000],
      ["3001", -1200000],
      ["3104", -240000],
      ["3103", -60000],
    ])
  );
  assert.equal(jan.complete, true);
  assert.equal(jan.totals.assets, 1500000);
  assert.equal(jan.totals.equity, 1500000);
  assert.equal(rowValue(jan, "current-year-profit"), 60000);
  assert.equal(rowValue(jan, "profit-distribution"), 240000);
  assert.equal(rowValue(jan, "unclosed-profit"), 0);
  assert.equal(rowValue(jan, "undistributed-profit"), 300000);
});

test("小企利润表快照：本期窗口 / 2025 累计 / 2026-01，负号与累计口径正确", () => {
  const smallAccounts = catalogOf(SMALL);

  const nov = is(
    SMALL,
    smallAccounts,
    money([
      ["5001", -300000],
      ["5401", 120000],
      ["5602", 20000],
    ])
  );
  assert.equal(nov.complete, true);
  assert.equal(nov.totals.operatingRevenue, 300000);
  assert.equal(nov.totals.operatingProfit, 160000);
  assert.equal(nov.totals.totalProfit, 160000);
  assert.equal(nov.totals.netProfit, 160000);

  const dec = is(
    SMALL,
    smallAccounts,
    money([
      ["5001", -150000],
      ["5401", 60000],
      ["5602", 10000],
    ])
  );
  assert.equal(dec.complete, true);
  assert.equal(dec.totals.netProfit, 80000);

  const ytd2025 = is(
    SMALL,
    smallAccounts,
    money([
      ["5001", -450000],
      ["5401", 180000],
      ["5602", 30000],
    ])
  );
  assert.equal(ytd2025.totals.operatingRevenue, 450000);
  assert.equal(ytd2025.totals.netProfit, 240000);

  const jan2026 = is(
    SMALL,
    smallAccounts,
    money([
      ["5001", -120000],
      ["5401", 50000],
      ["5602", 10000],
    ])
  );
  assert.equal(jan2026.totals.operatingRevenue, 120000);
  assert.equal(jan2026.totals.netProfit, 60000);
});

test("企业三期资产负债表快照：生产成本 5001 计入存货且不混入 4001", () => {
  const enterpriseAccounts = catalogOf(ENTERPRISE);

  const nov = bs(
    ENTERPRISE,
    enterpriseAccounts,
    money([
      ["1002", 2450000],
      ["1405", 100000],
      ["5001", 100000],
      ["4001", -2400000],
      ["6001", -500000],
      ["6401", 200000],
      ["6602", 50000],
    ])
  );
  assert.equal(nov.complete, true);
  assert.deepStrictEqual(nov.diagnostics, []);
  assert.equal(nov.totals.assets, 2650000);
  assert.equal(nov.totals.equity, 2650000);
  assert.equal(rowValue(nov, "cash"), 2450000);
  assert.equal(rowValue(nov, "inventory"), 200000);
  assert.equal(rowValue(nov, "paid-in-capital"), 2400000);
  assert.equal(rowValue(nov, "undistributed-profit"), 250000);

  const dec = bs(
    ENTERPRISE,
    enterpriseAccounts,
    money([
      ["1002", 2590000],
      ["1122", 80000],
      ["1405", 10000],
      ["5001", 100000],
      ["4001", -2400000],
      ["6001", -740000],
      ["6401", 290000],
      ["6602", 70000],
    ])
  );
  assert.equal(dec.complete, true);
  assert.equal(dec.totals.assets, 2780000);
  assert.equal(dec.totals.equity, 2780000);
  assert.equal(rowValue(dec, "inventory"), 110000);
  assert.equal(rowValue(dec, "accounts-receivable"), 80000);
  assert.equal(rowValue(dec, "undistributed-profit"), 380000);

  const jan = bs(
    ENTERPRISE,
    enterpriseAccounts,
    money([
      ["1002", 2690000],
      ["1405", 60000],
      ["5001", 100000],
      ["4001", -2400000],
      ["4104", -380000],
      ["4103", -70000],
    ])
  );
  assert.equal(jan.complete, true);
  assert.equal(jan.totals.assets, 2850000);
  assert.equal(jan.totals.equity, 2850000);
  assert.equal(rowValue(jan, "inventory"), 160000);
  assert.equal(rowValue(jan, "current-year-profit"), 70000);
  assert.equal(rowValue(jan, "profit-distribution"), 380000);
  assert.equal(rowValue(jan, "undistributed-profit"), 450000);
});

test("企业利润表快照：本期窗口 / 2025 累计 / 2026-01", () => {
  const enterpriseAccounts = catalogOf(ENTERPRISE);

  const nov = is(
    ENTERPRISE,
    enterpriseAccounts,
    money([
      ["6001", -500000],
      ["6401", 200000],
      ["6602", 50000],
    ])
  );
  assert.equal(nov.complete, true);
  assert.equal(nov.totals.operatingRevenue, 500000);
  assert.equal(nov.totals.netProfit, 250000);

  const dec = is(
    ENTERPRISE,
    enterpriseAccounts,
    money([
      ["6001", -240000],
      ["6401", 90000],
      ["6602", 20000],
    ])
  );
  assert.equal(dec.totals.netProfit, 130000);

  const ytd2025 = is(
    ENTERPRISE,
    enterpriseAccounts,
    money([
      ["6001", -740000],
      ["6401", 290000],
      ["6602", 70000],
    ])
  );
  assert.equal(ytd2025.totals.operatingRevenue, 740000);
  assert.equal(ytd2025.totals.netProfit, 380000);

  const jan2026 = is(
    ENTERPRISE,
    enterpriseAccounts,
    money([
      ["6001", -200000],
      ["6401", 100000],
      ["6602", 30000],
    ])
  );
  assert.equal(jan2026.totals.operatingRevenue, 200000);
  assert.equal(jan2026.totals.netProfit, 70000);
});

test("结转前后净资产一致（小企 2025-12 → 年末结转快照）", () => {
  const smallAccounts = catalogOf(SMALL);
  const before = bs(
    SMALL,
    smallAccounts,
    money([
      ["1002", 1370000],
      ["1122", 50000],
      ["1405", 20000],
      ["3001", -1200000],
      ["3103", 0],
      ["5001", -450000],
      ["5401", 180000],
      ["5602", 30000],
    ])
  );
  const after = bs(
    SMALL,
    smallAccounts,
    money([
      ["1002", 1370000],
      ["1122", 50000],
      ["1405", 20000],
      ["3001", -1200000],
      ["3103", 0],
      ["3104", -240000],
    ])
  );
  assert.equal(before.complete, true);
  assert.equal(after.complete, true);
  assert.equal(before.totals.assets, 1440000);
  assert.equal(after.totals.assets, 1440000);
  assert.equal(before.totals.equity, 1440000);
  assert.equal(after.totals.equity, 1440000);
  assert.equal(rowValue(before, "undistributed-profit"), 240000);
  assert.equal(rowValue(after, "undistributed-profit"), 240000);
  assert.equal(rowValue(after, "unclosed-profit"), 0);
});

test("结转前后净资产一致（企业：本年利润结入 4103，5001 在产品不结转）", () => {
  const enterpriseAccounts = catalogOf(ENTERPRISE);
  const before = bs(
    ENTERPRISE,
    enterpriseAccounts,
    money([
      ["1002", 2590000],
      ["1122", 80000],
      ["1405", 10000],
      ["5001", 100000],
      ["4001", -2400000],
      ["6001", -740000],
      ["6401", 290000],
      ["6602", 70000],
    ])
  );
  const after = bs(
    ENTERPRISE,
    enterpriseAccounts,
    money([
      ["1002", 2590000],
      ["1122", 80000],
      ["1405", 10000],
      ["5001", 100000],
      ["4001", -2400000],
      ["4103", 0],
      ["4104", -380000],
    ])
  );
  assert.equal(before.complete, true);
  assert.equal(after.complete, true);
  assert.equal(before.totals.equity, 2780000);
  assert.equal(after.totals.equity, 2780000);
  assert.equal(rowValue(after, "inventory"), 110000);
  assert.equal(rowValue(after, "unclosed-profit"), 0);
  assert.equal(rowValue(after, "undistributed-profit"), 380000);
});

test("小企应收股利 / 应收利息 / 其他应收款分别列示，企业按核实范围汇总", () => {
  const amounts = money([
    ["1131", 10000],
    ["1132", 20000],
    ["1221", 30000],
  ]);
  const small = bs(SMALL, catalogOf(SMALL), amounts);
  assert.equal(small.complete, true);
  assert.equal(rowValue(small, "dividends-receivable"), 10000);
  assert.equal(rowValue(small, "interest-receivable"), 20000);
  assert.equal(rowValue(small, "other-receivables"), 30000);
  assert.equal(small.totals.assets, 60000);

  const enterprise = bs(ENTERPRISE, catalogOf(ENTERPRISE), amounts);
  assert.equal(enterprise.complete, true);
  assert.equal(enterprise.rows.some((row) => row.id === "dividends-receivable"), false);
  assert.equal(enterprise.rows.some((row) => row.id === "interest-receivable"), false);
  assert.equal(rowValue(enterprise, "other-receivables"), 60000);
  assert.equal(enterprise.totals.assets, 60000);
});

test("备抵科目按有符号金额处理：原值 / 累计 / 净值不重复计入资产总计", () => {
  const result = bs(
    SMALL,
    catalogOf(SMALL),
    money([
      ["1601", 1000000],
      ["1602", -600000],
      ["1701", 300000],
      ["1702", -100000],
    ])
  );
  assert.equal(result.complete, true);
  assert.equal(rowValue(result, "fixed-assets-cost"), 1000000);
  assert.equal(rowValue(result, "accumulated-depreciation"), -600000);
  assert.equal(rowValue(result, "fixed-assets-net"), 400000);
  assert.equal(rowValue(result, "intangible-assets-cost"), 300000);
  assert.equal(rowValue(result, "accumulated-amortization"), -100000);
  assert.equal(rowValue(result, "intangible-assets-net"), 200000);
  assert.equal(result.totals.assets, 600000);
});

test("亏损与红冲：收入贷方净额、费用借方净额，允许负利润与负数收入", () => {
  const smallAccounts = catalogOf(SMALL);
  const loss = is(
    SMALL,
    smallAccounts,
    money([
      ["5001", -100000],
      ["5401", 300000],
    ])
  );
  assert.equal(loss.complete, true);
  assert.equal(loss.totals.operatingRevenue, 100000);
  assert.equal(loss.totals.netProfit, -200000);

  const lossBs = bs(
    SMALL,
    smallAccounts,
    money([
      ["1002", 300000],
      ["3001", -500000],
      ["5001", -100000],
      ["5401", 300000],
    ])
  );
  assert.equal(lossBs.complete, true);
  assert.equal(rowValue(lossBs, "undistributed-profit"), -200000);
  assert.equal(lossBs.totals.equity, 300000);
  assert.equal(lossBs.totals.assets, 300000);

  // 红冲：收入出现借方净额（负收入），不是隐式归零。
  const reversal = is(
    SMALL,
    smallAccounts,
    money([
      ["5001", 50000],
      ["5401", 10000],
    ])
  );
  assert.equal(reversal.complete, true);
  assert.equal(reversal.totals.operatingRevenue, -50000);
  assert.equal(reversal.totals.netProfit, -60000);
});

test("父子科目各有自身金额时分别且仅计一次，不重复汇总", () => {
  const accounts = [
    A("5602", "损益", "debit"),
    A("560201", "损益", "debit"),
    A("1405", "资产", "debit"),
    A("140501", "资产", "debit"),
  ];
  const profit = is(
    SMALL,
    accounts,
    money([
      ["5602", 10000],
      ["560201", 5000],
    ])
  );
  assert.equal(profit.complete, true);
  assert.equal(rowValue(profit, "administrative-expense"), 15000);
  assert.equal(profit.totals.netProfit, -15000);

  const inventory = bs(
    SMALL,
    accounts,
    money([
      ["1405", 10000],
      ["140501", 5000],
    ])
  );
  assert.equal(inventory.complete, true);
  assert.equal(rowValue(inventory, "inventory"), 15000);
  assert.equal(inventory.totals.assets, 15000);
});

// ================================================================ 4. 反例与失败路径
test("非零未映射 / 待明细 / 未支持科目：complete=false 且不伪报完整", () => {
  const enterpriseAccounts = catalogOf(ENTERPRISE);
  const unsupported = bs(
    ENTERPRISE,
    enterpriseAccounts,
    money([
      ["1002", 100000],
      ["1101", 900000],
    ])
  );
  assert.equal(unsupported.complete, false);
  assert.ok(diagnosticCodes(unsupported).includes("account_scope_unsupported"));
  const financialDiagnostic = unsupported.diagnostics.find(
    (item) => item.code === "account_scope_unsupported"
  );
  assert.equal(financialDiagnostic.accountCode, "1101");
  assert.equal(financialDiagnostic.reason, "financial-instrument-measurement-not-implemented");
  assert.equal(unsupported.totals.assets, 100000, "未支持科目不得计入资产总计");

  const requiresDetail = bs(
    ENTERPRISE,
    enterpriseAccounts,
    money([["2401", 50000]])
  );
  assert.equal(requiresDetail.complete, false);
  assert.ok(diagnosticCodes(requiresDetail).includes("account_requires_detail"));
  assert.equal(requiresDetail.totals.liabilities, 0);

  const unmapped = bs(SMALL, [A("9001", "资产", "debit")], money([["9001", 1000]]));
  assert.equal(unmapped.complete, false);
  assert.deepStrictEqual(diagnosticCodes(unmapped), ["account_unmapped"]);
  assert.equal(unmapped.totals.assets, 0);

  const construction = bs(SMALL, catalogOf(SMALL), money([["4401", 1000]]));
  assert.equal(construction.complete, false);
  assert.ok(
    construction.diagnostics.some(
      (item) =>
        item.code === "account_scope_unsupported" &&
        item.accountCode === "4401" &&
        item.reason === "construction-contract-rules-not-implemented"
    )
  );

  const outOfStatement = is(SMALL, catalogOf(SMALL), money([["1601", 1000]]));
  assert.equal(outOfStatement.complete, false);
  assert.deepStrictEqual(diagnosticCodes(outOfStatement), ["account_out_of_statement"]);

  // 企业 5001 是在产品（成本），不得进入利润表按收入 / 费用处理。
  const enterpriseCostInProfit = is(
    ENTERPRISE,
    catalogOf(ENTERPRISE),
    money([["5001", 100000]])
  );
  assert.equal(enterpriseCostInProfit.complete, false);
  assert.deepStrictEqual(diagnosticCodes(enterpriseCostInProfit), ["account_out_of_statement"]);
  assert.equal(enterpriseCostInProfit.totals.netProfit, 0);

  const conflict = bs(ENTERPRISE, [A("5001", "损益", "credit")], money([["5001", 1000]]));
  assert.equal(conflict.complete, false);
  const conflictCodes = diagnosticCodes(conflict);
  assert.ok(conflictCodes.includes("account_category_conflict"));
  assert.equal(conflict.totals.assets, 0);
});

test("零余额的未使用复杂科目不阻断正常基础样例", () => {
  const small = bs(
    SMALL,
    catalogOf(SMALL),
    money([
      ["1002", 1280000],
      ["1405", 80000],
      ["3001", -1200000],
      ["1606", 0],
      ["1901", 0],
      ["2401", 0],
      ["4101", 0],
      ["4301", 0],
      ["4401", 0],
      ["5001", -300000],
      ["5401", 120000],
      ["5602", 20000],
    ])
  );
  assert.equal(small.complete, true);
  assert.deepStrictEqual(small.diagnostics, []);
  assert.equal(small.totals.equity, 1360000);

  const enterprise = bs(
    ENTERPRISE,
    catalogOf(ENTERPRISE),
    money([
      ["1002", 2450000],
      ["5001", 100000],
      ["4001", -2400000],
      ["1101", 0],
      ["1471", 0],
      ["1511", 0],
      ["1606", 0],
      ["1901", 0],
      ["2401", 0],
      ["5101", 0],
      ["6001", -500000],
      ["6401", 200000],
      ["6602", 50000],
    ])
  );
  assert.equal(enterprise.complete, true);
  assert.deepStrictEqual(enterprise.diagnostics, []);
  assert.equal(enterprise.totals.equity, 2650000);
});

test("非法金额 / 重复 code / 缺科目 / 溢出 / 非整数一律明确拒绝", () => {
  const accounts = catalogOf(SMALL);
  for (const bad of ["100", "abc", NaN, Infinity, -Infinity, 1.5, null, undefined, true, {}]) {
    assert.equal(
      errorCode(() => bs(SMALL, accounts, [{ code: "1002", netMinor: bad }])),
      "amount_invalid",
      `金额 ${String(bad)} 必须被拒绝`
    );
  }
  assert.equal(
    errorCode(() =>
      bs(SMALL, accounts, [
        { code: "1002", netMinor: 1 },
        { code: "1002", netMinor: 2 },
      ])
    ),
    "amount_code_duplicate"
  );
  assert.equal(
    errorCode(() => bs(SMALL, accounts, [{ code: "8888", netMinor: 1 }])),
    "amount_account_missing"
  );
  assert.equal(
    errorCode(() => bs(SMALL, [A("1002", "资产", "debit"), A("1002", "资产", "debit")], [])),
    "account_code_duplicate"
  );
  assert.equal(
    errorCode(() =>
      bs(SMALL, accounts, [
        { code: "1001", netMinor: Number.MAX_SAFE_INTEGER },
        { code: "1002", netMinor: Number.MAX_SAFE_INTEGER },
      ])
    ),
    "amount_overflow"
  );
  assert.equal(errorCode(() => bs(SMALL, "not-array", [])), "statement_accounts_invalid");
  assert.equal(errorCode(() => bs(SMALL, accounts, "not-array")), "statement_amounts_invalid");
  assert.equal(
    errorCode(() => evaluateAccountingStatement(SMALL, { kind: "cash-flow", accounts, amounts: [] })),
    "statement_kind_invalid"
  );
  assert.equal(
    errorCode(() => evaluateAccountingStatement(SMALL, null)),
    "statement_input_invalid"
  );
  assert.equal(
    errorCode(() => bs("unknown-profile", accounts, [])),
    "accounting_profile_unknown"
  );
});

test("同一输入重复调用结果一致、输入不被修改、返回值冻结", () => {
  const accounts = catalogOf(SMALL);
  const amounts = money([
    ["1002", 1280000],
    ["1405", 80000],
    ["3001", -1200000],
    ["5001", -300000],
    ["5401", 120000],
    ["5602", 20000],
  ]);
  const before = JSON.stringify({ accounts, amounts });
  const first = bs(SMALL, accounts, amounts);
  const second = bs(SMALL, accounts, amounts);
  assert.deepStrictEqual(first, second);
  assert.equal(JSON.stringify({ accounts, amounts }), before, "输入不得被修改");
  assertDeepFrozen(first, "statement");
  assert.throws(() => {
    first.rows.push({ id: "x", label: "x", valueMinor: 0 });
  }, TypeError);
  assert.throws(() => {
    first.totals.assets = 0;
  }, TypeError);
  const rules = getAccountingReportRules(SMALL);
  assert.strictEqual(getAccountingReportRules(SMALL), rules, "规则描述应复用同一冻结对象");
  assertDeepFrozen(rules, "rules");
});

// ================================================================ 5. legacy 分支与现金流分类
test("legacy evaluate 不使用新规则，返回 legacy_engine_required 且不给假装完整的金额", () => {
  for (const kind of ["balance-sheet", "income-statement"]) {
    const result = evaluateAccountingStatement(LEGACY, {
      kind,
      accounts: catalogOf(LEGACY),
      amounts: money([
        ["1002", 1000],
        ["3001", -1000],
      ]),
    });
    assert.equal(result.complete, false);
    assert.equal(result.engineMode, "legacy-compatibility");
    assert.deepStrictEqual(result.rows, []);
    assert.deepStrictEqual(result.totals, {});
    assert.deepStrictEqual(diagnosticCodes(result), ["legacy_engine_required"]);
    assert.ok(Object.isFrozen(result));
  }
  const legacyRules = getAccountingReportRules(LEGACY);
  assert.equal(legacyRules.engineMode, "legacy-compatibility");
  assert.deepStrictEqual(legacyRules.balanceSheet.rows, []);
  assert.deepStrictEqual(legacyRules.incomeStatement.rows, []);
  assert.deepStrictEqual(legacyRules.balanceSheet.totals, {});
  const resolved = resolveAccountingAccountRule(LEGACY, A("5001", "损益", "credit"));
  assert.equal(resolved.matchedRoot, "5001");
  assert.equal(resolved.compatible, false);
  assert.ok(diagnosticCodes(resolved).includes("legacy_engine_required"));
  const counterpart = classifyAccountingCashCounterpart(LEGACY, A("1002", "资产", "debit"));
  assert.equal(counterpart.category, "unknown");
  assert.equal(counterpart.reason, "legacy_engine_required");
});

test("现金流对方分类：资本 financing、生产成本 operating、固定资产 investing、未知明确 unknown", () => {
  const cases = [
    [SMALL, A("3001", "权益", "credit"), "financing"],
    [ENTERPRISE, A("4001", "权益", "credit"), "financing"],
    [SMALL, A("4001", "成本", "debit"), "operating"],
    [ENTERPRISE, A("5001", "成本", "debit"), "operating"],
    [SMALL, A("5001", "损益", "credit"), "operating"],
    [ENTERPRISE, A("6001", "损益", "credit"), "operating"],
    [SMALL, A("1601", "资产", "debit"), "investing"],
    [ENTERPRISE, A("1601", "资产", "debit"), "investing"],
    [ENTERPRISE, A("1701", "资产", "debit"), "investing"],
  ];
  for (const [profileId, account, expected] of cases) {
    const result = classifyAccountingCashCounterpart(profileId, account);
    assert.equal(result.category, expected, `${profileId} ${account.code} 应为 ${expected}`);
    assert.equal(result.matchedRoot, account.code);
    assert.equal(result.reason, null);
    assert.ok(Object.isFrozen(result));
  }
  // 同码不同含义不能互串：企业 4001 是资本（financing），不是生产成本。
  assert.equal(classifyAccountingCashCounterpart(ENTERPRISE, A("4001", "权益", "credit")).category, "financing");
  assert.equal(
    classifyAccountingCashCounterpart(ENTERPRISE, A("4001", "成本", "debit")).category,
    "unknown"
  );

  const unmapped = classifyAccountingCashCounterpart(SMALL, A("9001", "资产", "debit"));
  assert.equal(unmapped.category, "unknown");
  assert.equal(unmapped.reason, "counterpart_unmapped");

  const cash = classifyAccountingCashCounterpart(SMALL, A("1002", "资产", "debit"));
  assert.equal(cash.category, "unknown");
  assert.equal(cash.reason, "counterpart_is_cash");

  const interest = classifyAccountingCashCounterpart(ENTERPRISE, A("2231", "负债", "credit"));
  assert.equal(interest.category, "unknown");
  assert.equal(interest.reason, "interest-payment-classification-ambiguous");

  const unsupported = classifyAccountingCashCounterpart(ENTERPRISE, A("1101", "资产", "debit"));
  assert.equal(unsupported.category, "unknown");
  assert.equal(unsupported.reason, "counterpart_scope_unsupported");

  const conflict = classifyAccountingCashCounterpart(ENTERPRISE, A("5001", "损益", "credit"));
  assert.equal(conflict.category, "unknown");
  assert.equal(conflict.reason, "account_category_conflict");
});

test("规则描述可序列化、行项目与合计依赖闭合，现金流规则按 profile 区分", () => {
  for (const profileId of [SMALL, ENTERPRISE]) {
    const rules = getAccountingReportRules(profileId);
    assert.equal(rules.engineMode, "profile-rules");
    assert.deepStrictEqual(rules.statementKinds, ["balance-sheet", "income-statement"]);
    assert.equal(rules.profileId, profileId);
    assert.equal(rules.reportMappingVersion, getAccountingProfile(profileId).reportMappingVersion);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(rules)), rules);

    for (const statement of ["balanceSheet", "incomeStatement"]) {
      const rows = rules[statement].rows;
      assert.ok(rows.length > 0);
      const seen = new Set();
      for (const row of rows) {
        assert.ok(typeof row.rowId === "string" && typeof row.label === "string");
        assert.ok(["accounts", "subtotal", "unclosed-profit"].includes(row.kind));
        if (row.kind === "accounts") {
          assert.ok(Array.isArray(row.roots) && row.roots.length > 0);
          assert.ok(["debit", "credit"].includes(row.natural));
        } else if (row.kind === "subtotal") {
          assert.ok(Array.isArray(row.terms) && row.terms.length > 0);
          for (const term of row.terms) {
            assert.ok(seen.has(term.rowId), `${row.rowId} 依赖后定义的行 ${term.rowId}`);
            assert.ok([1, -1].includes(term.sign));
          }
        } else {
          assert.ok(Array.isArray(row.roots) && row.roots.length > 0);
        }
        seen.add(row.rowId);
      }
      for (const rowId of Object.values(rules[statement].totals)) {
        assert.ok(seen.has(rowId), `合计引用了不存在的行 ${rowId}`);
      }
    }
    assert.deepStrictEqual(Object.keys(rules.balanceSheet.totals).sort(), [
      "assets",
      "equity",
      "liabilities",
      "liabilitiesAndEquity",
    ]);
    assert.ok(Object.prototype.hasOwnProperty.call(rules.incomeStatement.totals, "netProfit"));
  }

  const smallCashFlow = getAccountingReportRules(SMALL).cashFlow;
  const enterpriseCashFlow = getAccountingReportRules(ENTERPRISE).cashFlow;
  assert.ok(smallCashFlow.financingRoots.includes("3001"));
  assert.ok(!smallCashFlow.financingRoots.includes("4001"));
  assert.ok(smallCashFlow.operatingRoots.includes("4001"));
  assert.ok(enterpriseCashFlow.financingRoots.includes("4001"));
  assert.ok(!enterpriseCashFlow.financingRoots.includes("5001"));
  assert.ok(enterpriseCashFlow.operatingRoots.includes("5001"));
  assert.ok(enterpriseCashFlow.investingRoots.includes("1601"));
  assert.equal(smallCashFlow.engineMode, "counterpart-classification-only");
  assert.ok(
    smallCashFlow.unsupported.includes("proportional-allocation-of-multi-counterpart-vouchers"),
    "复合凭证比例分摊必须显式列为未实现"
  );
});

test("生产模块 import 图纯净：只互相依赖，无数据库 / 文件 / 网络 / 环境变量副作用", () => {
  const profilePath = new URL("../server/accounting-profiles.mjs", import.meta.url);
  const rulesPath = new URL("../server/accounting-report-rules.mjs", import.meta.url);
  const profileSource = readFileSync(profilePath, "utf8");
  const rulesSource = readFileSync(rulesPath, "utf8");

  assert.equal(
    [...profileSource.matchAll(/^\s*import\s[^\n]*$/gm)].length,
    0,
    "profiles 模块不应导入任何东西"
  );
  assert.deepStrictEqual(
    [...rulesSource.matchAll(/^\s*import\s[^\n]*$/gm)].map((match) => match[0].trim()),
    ['import { getAccountingProfile, getAccountingRoles } from "./accounting-profiles.mjs";'],
    "rules 模块只应依赖 profiles 纯模块"
  );
  const forbidden = [
    "node:fs",
    "node:net",
    "node:http",
    "node:sqlite",
    "child_process",
    "process.env",
    "./db.mjs",
    "./accounting.mjs",
    "./coa.mjs",
    "server.mjs",
    "agent-tools",
  ];
  for (const source of [profileSource, rulesSource]) {
    for (const token of forbidden) {
      assert.ok(!source.includes(token), `生产模块不得引用 ${token}`);
    }
  }
});

// ---------------------------------------------------------------- 汇总
const failed = results.filter(([ok]) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} 通过\n`);
process.exitCode = failed ? 1 : 0;
