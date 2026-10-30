// 已核查来源的选定字段工程规则，绝不是在线申报适配器。
const freeze = v => { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); } return v; };
export const VAT_RULE_VERSION = 'offline-vat-selected/1';
export const VAT_RULE_REGISTRY = freeze({
  version: VAT_RULE_VERSION, checkedOn: '2026-10-24', accountantApproval: 'pending',
  formVersion: 'small-scale-vat-2026-6', formApplication: 'offline_workpaper_after_Q1_end_2026-03-31_not_transaction_date_filter',
  engineeringScope: { period: '2026-Q1', enterprise: 'new_enterprise_not_individual', opening: 'new_zero', history: 'first_period', invoices: 'ordinary_domestic_main_services_whole_yuan_net_exact_one_percent', thresholdYuan: '300000', thresholdComparison: 'greater_than_or_equal', rounding: 'none_exact_integer_minor_units_only', ledger: 'all_candidates_posted_no_carryforward_or_unknown_vouchers' },
  sources: {
    law: { url: 'https://shanghai.chinatax.gov.cn/zcfw/zcfgk/zzs/202412/t474694.html', title: '中华人民共和国增值税法', effectiveFrom: '2026-01-01', effectiveThrough: null, locators: ['第7、11、14、17条：不含税销售额、3%简易计税', '第23条：未达到起征点免征，达到全额', '第28条（一）：收款/索款凭据、先开票时点', '第30条：计税期间由主管税务机关核定', '第38条：施行日'] },
    relief: { url: 'https://shanghai.chinatax.gov.cn/zzzb/zcwj/202602/t479283.html', officialMirrorUrl: 'https://liaoning.chinatax.gov.cn/art/2026/1/30/art_5869_7749.html', title: '财政部 税务总局公告2026年第10号', issuedOn: '2026-01-30', effectiveFrom: '2026-01-01', effectiveThrough: '2027-12-31', locators: ['一（一）：按季申报起征点30万元', '三（三）6：3%减按1%，不含销售/出租不动产、转让土地使用权'], crossReferenceUrl: 'https://neimenggu.chinatax.gov.cn/nmgzzqswj/msxxgkml_19393/hlbesswj/202608/t20260818_896731.html' },
    transition: { url: 'https://fgk.chinatax.gov.cn/zcfgk/c100012/c5247507/content.html', title: '国家税务总局公告2026年第6号', effectiveFrom: '2026-02-01', effectiveThrough: null, locators: ['一、二、三及附件2：暂用既有申报表，按调整说明填写'] },
    instructions: { url: 'https://shanghai.chinatax.gov.cn/tax/bsfw/xzzx/bgxz/sbzsl/202107/t459066.html', title: '小规模申报表填写说明及2026调整', updatedOn: '2026-02-09', locators: ['2026调整一（三）：1%销售额填1行', '2026调整一（六）：销售额2%减征填16行', '原说明二（五）（六）（十八）（二十三）：2、3、15、21行'] },
    blankForm: { url: 'https://12366.chinatax.gov.cn/bzds/003/003.html', title: '官方小规模申报空表', locators: ['金额单位元，列至角分', '20=15-16；22=20-21', '21、22本年累计横杠，不是零'] },
  },
  selectedRows: {
    1: { meaning: '应征增值税不含税销售额（3%征收率）', formula: 'sum(reconciled_taxable_invoice_net)', sources: ['law', 'relief', 'instructions'] },
    2: { meaning: '增值税专用发票不含税销售额', formula: 'evidenced_no_special_invoices', sources: ['instructions'] },
    3: { meaning: '其他增值税发票不含税销售额', formula: 'sum(reconciled_ordinary_invoice_net)', sources: ['instructions'] },
    15: { meaning: '本期应纳税额', formula: 'row1*3/100', sources: ['law', 'instructions'] },
    16: { meaning: '本期应纳税额减征额', formula: 'row1*2/100', sources: ['relief', 'instructions'] },
    20: { meaning: '应纳税额合计', formula: 'row15-row16', sources: ['blankForm'] },
    21: { meaning: '本期预缴税额', formula: 'evidenced_no_prepayments', sources: ['instructions', 'blankForm'] },
    22: { meaning: '本期应补（退）税额', formula: 'row20-row21', sources: ['blankForm'] },
  },
});
export const getVatRules = () => structuredClone(VAT_RULE_REGISTRY);

// 独立政策分支，不改变 v1 注册表或其 Q1 合同。
export const VAT_Q2_RULE_VERSION = 'offline-vat-selected-q2/1';
export const VAT_Q2_RULE_REGISTRY = freeze({
  ...getVatRules(), version: VAT_Q2_RULE_VERSION,
  formApplication: 'offline_Q2_workpaper_2026_04_01_through_2026_06_30',
  engineeringScope: { ...getVatRules().engineeringScope, period: '2026-Q2', establishment: 'January_2026_only', opening: 'January_zero_initial_ledger_proven_from_same_capture', history: 'entire_Q1_recomputed_and_each_prior_voucher_and_source_explained', rounding: 'whole_yuan_net_engineering_restriction_not_official_rounding_policy' },
  yearToDate: { rows: [1, 2, 3, 15, 16, 20], formula: 'actual_recomputed_Q1_current+actual_Q2_current', inference: 'engineering_inference_from_official_year_to_date_column_meaning_pending_accountant_review', directOfficialQ2AccumulationFAQFound: false, officialDashRows: [21, 22], priorPaymentIsTargetPrepayment: false },
});
export const getVatQ2Rules = () => structuredClone(VAT_Q2_RULE_REGISTRY);
