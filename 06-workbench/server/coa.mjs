// coa.mjs — 旧账套兼容的基线科目表（LOCAL-03a 阶段 B 起为兼容默认）
// direction: 'debit' 借增 / 'credit' 贷增
// category : 资产 | 负债 | 权益 | 成本 | 损益
//
// 重要（LOCAL-03a）：本数组是**派工基线的 legacy 兼容默认**，只用于旧账套读取 / 兼容路径。
// 新建账套必须按持久 accounting profile 取科目表（见 accounting-profiles.mjs 的 getAccountingProfile），
// 不得再把这个单一数组无差别当成所有准则的科目表，也不得用它实现准则转换。
import { getAccountingProfile } from "./accounting-profiles.mjs";

export const STANDARDS = ["小企业会计准则", "企业会计准则"];

/** legacy 兼容 profile ID（旧账套迁移后的持久值）。 */
export const LEGACY_PROFILE_ID = "legacy-small-coa-v1";

export const COA = [
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

/** 叶子科目：没有任何其他科目以它为父级（本表为平铺，故全部是叶子）。 */
export const LEAF_CODES = new Set(COA.map((a) => a.code));

/**
 * 按 profile 取科目表（新建账套 / 严格导入使用）。
 * 返回 `{ code, name, category, direction, contra }` 数组；legacy profile 与上面的兼容默认逐项一致。
 * 未知 profile 抛 accounting_profile_unknown，绝不 fallback 到本文件的 COA。
 */
export function coaForProfile(profileId) {
  return getAccountingProfile(profileId).coa.map((account) => ({
    code: account.code,
    name: account.name,
    category: account.category,
    direction: account.direction,
    contra: account.contra === true,
  }));
}
