// 原始 2011 年法定表式只作参考，不是电子税务局上传格式。
// 纯函数：不访问数据库、凭据、网络，不登记或提交。
const VERSION = '2011-17-original';
const SOURCE = {
  title: '财政部关于印发《小企业会计准则》的通知及附录',
  documentNumber: '财会〔2011〕17号',
  url: 'https://policy.mofcom.gov.cn/claw/clawContent.shtml?id=2909',
  publisher: '财政部（商务部法规库转载）',
  publishedAt: '2011-10-18', effectiveFrom: '2013-01-01', retrievedAt: '2026-10-15',
};
const STANDARD = '小企业会计准则';
const SUM = (...lines) => lines.map(line => [line, 1]);
const equation = (line, terms) => ({ line, operator: '=', terms });
const BS_NAMES = [
  '货币资金', '短期投资', '应收票据', '应收账款', '预付账款', '应收股利', '应收利息', '其他应收款',
  '存货', '其中：原材料', '在产品', '库存商品', '周转材料', '其他流动资产', '流动资产合计',
  '长期债券投资', '长期股权投资', '固定资产原价', '减：累计折旧', '固定资产账面价值', '在建工程',
  '工程物资', '固定资产清理', '生产性生物资产', '无形资产', '开发支出', '长期待摊费用',
  '其他非流动资产', '非流动资产合计', '资产总计', '短期借款', '应付票据', '应付账款', '预收账款',
  '应付职工薪酬', '应交税费', '应付利息', '应付利润', '其他应付款', '其他流动负债', '流动负债合计',
  '长期借款', '长期应付款', '递延收益', '其他非流动负债', '非流动负债合计', '负债合计',
  '实收资本（或股本）', '资本公积', '盈余公积', '未分配利润', '所有者权益（或股东权益）合计',
  '负债和所有者权益（或股东权益）总计',
];
const PL_NAMES = [
  '一、营业收入', '减：营业成本', '营业税金及附加', '其中：消费税', '营业税', '城市维护建设税',
  '资源税', '土地增值税', '城镇土地使用税、房产税、车船税、印花税', '教育费附加、矿产资源补偿费、排污费',
  '销售费用', '其中：商品维修费', '广告费和业务宣传费', '管理费用', '其中：开办费', '业务招待费',
  '研究费用', '财务费用', '其中：利息费用（收入以“-”号填列）', '加：投资收益（损失以“-”号填列）',
  '二、营业利润（亏损以“-”号填列）', '加：营业外收入', '其中：政府补助', '减：营业外支出',
  '其中：坏账损失', '无法收回的长期债券投资损失', '无法收回的长期股权投资损失',
  '自然灾害等不可抗力因素造成的损失', '税收滞纳金', '三、利润总额（亏损总额以“-”号填列）',
  '减：所得税费用', '四、净利润（净亏损以“-”号填列）',
];
const CF_NAMES = [
  '销售产成品、商品、提供劳务收到的现金', '收到其他与经营活动有关的现金',
  '购买原材料、商品、接受劳务支付的现金', '支付的职工薪酬', '支付的税费', '支付其他与经营活动有关的现金',
  '经营活动产生的现金流量净额', '收回短期投资、长期债券投资和长期股权投资收到的现金',
  '取得投资收益收到的现金', '处置固定资产、无形资产和其他非流动资产收回的现金净额',
  '短期投资、长期债券投资和长期股权投资支付的现金', '购建固定资产、无形资产和其他非流动资产支付的现金',
  '投资活动产生的现金流量净额', '取得借款收到的现金', '吸收投资者投资收到的现金',
  '偿还借款本金支付的现金', '偿还借款利息支付的现金', '分配利润支付的现金', '筹资活动产生的现金流量净额',
  '四、现金净增加额', '加：期初现金余额', '五、期末现金余额',
];
const FLOW_COLUMNS = {
  monthly: [{ id: 'yearToDate', label: '本年累计金额' }, { id: 'currentMonth', label: '本月金额' }],
  annual: [{ id: 'currentYear', label: '本年累计金额' }, { id: 'previousYear', label: '上年金额' }],
};
const BALANCE_COLUMNS = [{ id: 'end', label: '期末余额' }, { id: 'beginning', label: '年初余额' }];
function reference(id, name, formNumber, names, columns, formulas) {
  return {
    id, name, formNumber, version: VERSION, kind: 'statutory_reference', accountingStandard: STANDARD,
    jurisdiction: 'CN', source: SOURCE, currency: 'CNY', unit: '元', amountScale: 2,
    // 此限制属于应用校验限制，不声称是税局网站限制。
    maximumAbsoluteAmount: '999999999999.99', amountLimitScope: 'application',
    columns, rows: names.map((label, i) => ({ line: i + 1, label })), formulas,
    uploadCompatibility: 'unverified', uploadFormats: [], accountMapping: 'incomplete',
    scope: '2011年原始附录；仅校验显式提供的完整行号金额，不证明现行税局兼容或账务口径正确',
    limitations: [
      '目标企业适用准则须另行核实；不能由企业规模或调用参数证明',
      '福建电子税务局官方导入文件、版本和实际兼容性未核实',
      '未核实后续修订及现行字段；利润表保留2011年营业税等原始名称',
      '不支持增列项目（例如中外合作经营已归还投资）、季度报表或跨表校验',
      '仅检查加减等式；未核实冲回及有符号明细适用条件，不强制其中项与合计的大小关系',
      '金额精度及上限为本应用契约，不是福建上传格式证据',
    ],
  };
}
const TEMPLATES = [
  reference('cn-small-enterprise-2011-balance-sheet', '资产负债表', '会小企01表', BS_NAMES,
    { monthly: BALANCE_COLUMNS, annual: BALANCE_COLUMNS }, [
      equation(15, SUM(1, 2, 3, 4, 5, 6, 7, 8, 9, 14)),
      equation(20, [[18, 1], [19, -1]]), equation(29, SUM(16, 17, 20, 21, 22, 23, 24, 25, 26, 27, 28)),
      equation(30, SUM(15, 29)), equation(41, SUM(31, 32, 33, 34, 35, 36, 37, 38, 39, 40)),
      equation(46, SUM(42, 43, 44, 45)), equation(47, SUM(41, 46)), equation(52, SUM(48, 49, 50, 51)),
      equation(53, SUM(47, 52)), equation(53, SUM(30)),
    ]),
  reference('cn-small-enterprise-2011-income-statement', '利润表', '会小企02表', PL_NAMES, FLOW_COLUMNS, [
    equation(21, [[1, 1], [2, -1], [3, -1], [11, -1], [14, -1], [18, -1], [20, 1]]),
    equation(30, [[21, 1], [22, 1], [24, -1]]), equation(32, [[30, 1], [31, -1]]),
  ]),
  reference('cn-small-enterprise-2011-cash-flow', '现金流量表', '会小企03表', CF_NAMES, FLOW_COLUMNS, [
    equation(7, [[1, 1], [2, 1], [3, -1], [4, -1], [5, -1], [6, -1]]),
    equation(13, [[8, 1], [9, 1], [10, 1], [11, -1], [12, -1]]),
    equation(19, [[14, 1], [15, 1], [16, -1], [17, -1], [18, -1]]),
    equation(20, SUM(7, 13, 19)), equation(22, SUM(20, 21)),
  ]),
];
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}
deepFreeze(TEMPLATES);
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const issue = (code, message, context = {}) => ({ code, message, ...context });
const findTemplate = id => TEMPLATES.find(template => template.id === id);

/** 可序列化的独立快照；调用者不能改变可信注册表状态。 */
export function listTaxReportTemplates() { return structuredClone(TEMPLATES); }

function validPeriod(periodType, period) {
  if (typeof period !== 'string') return false;
  if (periodType === 'annual') return /^[1-9]\d{3}$/.test(period);
  return periodType === 'monthly' && /^[1-9]\d{3}-(0[1-9]|1[0-2])$/.test(period);
}

/** 精确解析带符号分金额，不舍入，也不用浮点公式计算。 */
function cents(value) {
  if (!['number', 'string'].includes(typeof value)) return null;
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  const text = String(value);
  if (!/^-?(0|[1-9]\d{0,11})(\.\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ''] = text.replace(/^-/, '').split('.');
  const result = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (result > 99999999999999n) return null;
  return text.startsWith('-') ? -result : result;
}

/** 仅校验调用者提供的完整参考数据，不读取账套。rows: [{line: 1, amounts: {end: '12.34', beginning: '0.00'}}]；columns 为 template.columns[periodType] 中有序 ID，必须提供 templateVersion。 */
export function validateReferenceReport(templateId, report) {
  const errors = [];
  const result = () => ({ valid: errors.length === 0, templateId: typeof templateId === 'string' ? templateId : null,
    templateVersion: VERSION, scope: 'reference_structure_only', uploadCompatibility: 'unverified', errors });
  const template = findTemplate(templateId);
  if (!template) { errors.push(issue('template_unsupported', '未知参考模板')); return result(); }
  if (!isRecord(report)) { errors.push(issue('report_invalid', '报表必须是对象')); return result(); }
  if (report.templateVersion !== VERSION) errors.push(issue('template_version_unsupported', '必须指定目录中的原始模板版本'));
  const expectedColumns = template.columns[report.periodType];
  if (!Object.hasOwn(template.columns, report.periodType) || !Array.isArray(expectedColumns)) {
    errors.push(issue('period_type_unsupported', '仅支持 monthly 或 annual'));
    return result();
  }
  if (!validPeriod(report.periodType, report.period)) errors.push(issue('period_invalid', '期间应为有效的 YYYY-MM（月报）或 YYYY（年报）'));
  if (report.currency !== 'CNY') errors.push(issue('currency_unsupported', '参考校验仅支持 CNY'));
  if (report.unit !== '元') errors.push(issue('unit_unsupported', '金额单位必须明确为元'));
  const columnIds = expectedColumns.map(column => column.id);
  if (!Array.isArray(report.columns) || report.columns.length !== columnIds.length ||
      columnIds.some((id, i) => report.columns[i] !== id)) {
    errors.push(issue('columns_invalid', '金额列须按该期间类型的完整顺序提供'));
  }
  if (!Array.isArray(report.rows)) { errors.push(issue('rows_invalid', '必须显式提供全部行')); return result(); }
  // 对畸形请求设置边界；参考表不包含可选行或扩展行。
  if (report.rows.length > template.rows.length) errors.push(issue('row_count_invalid', '行数超过该参考表范围'));
  const seen = new Set();
  const amounts = new Map();
  for (const row of report.rows.slice(0, template.rows.length + 1)) {
    if (!isRecord(row) || !Number.isInteger(row.line) || row.line < 1 || row.line > template.rows.length) {
      errors.push(issue('line_invalid', '行次必须是参考表范围内的整数')); continue;
    }
    const line = row.line;
    if (seen.has(line)) { errors.push(issue('line_duplicate', '行次重复', { line })); continue; }
    seen.add(line);
    if (!isRecord(row.amounts) || Object.keys(row.amounts).length !== columnIds.length ||
        columnIds.some(id => !Object.hasOwn(row.amounts, id))) {
      errors.push(issue('row_columns_invalid', '每行必须完整提供且仅提供指定金额列', { line })); continue;
    }
    const parsed = {};
    for (const column of columnIds) {
      parsed[column] = cents(row.amounts[column]);
      if (parsed[column] === null) errors.push(issue('amount_invalid', '金额必须是有限数值或十进制文本，至多两位小数且不超应用上限', { line, column }));
    }
    if (Object.values(parsed).every(value => value !== null)) amounts.set(line, parsed);
  }
  for (const row of template.rows) {
    if (!seen.has(row.line)) errors.push(issue('line_missing', '缺少必填行；不以零代替', { line: row.line }));
  }
  if (errors.length) return result();
  for (const formula of template.formulas) {
    for (const column of columnIds) {
      const actual = amounts.get(formula.line)[column];
      const expected = formula.terms.reduce((total, [line, sign]) => total + amounts.get(line)[column] * BigInt(sign), 0n);
      if (actual !== expected) {
        errors.push(issue('formula_mismatch', '参考表行次勾稽不成立', { line: formula.line, column, operator: formula.operator }));
      }
    }
  }
  return result();
}

/** 就绪检查仅基于配置，不证明账套或映射实际存在。 */
export function assessTaxReportReadiness(setId, options = {}) {
  const blockers = [];
  const add = (code, message) => blockers.push(issue(code, message));
  const input = isRecord(options) ? options : {};
  if (!isRecord(options)) add('options_invalid', '参数必须是对象');
  if (!Number.isSafeInteger(setId) || setId <= 0) add('account_set_id_invalid', '账套编号须为正整数');
  if (input.region !== 'CN-FJ') add('region_unsupported', '当前仅记录福建 CN-FJ 的待核实状态，未适配其他地区');
  if (input.accountingStandard !== STANDARD) add('accounting_standard_unsupported', '必须明确选择小企业会计准则参考；其他准则未适配');
  const template = findTemplate(input.templateId);
  if (!template) add('template_unsupported', '必须选择已登记的参考模板');
  if (input.templateVersion !== VERSION) add('template_version_unsupported', '必须明确指定目录版本');
  if (!validPeriod('monthly', input.period) && !validPeriod('annual', input.period)) add('period_invalid', '期间必须是有效 YYYY-MM 或 YYYY');
  add('tax_template_unverified', '福建官方上传模板、文件格式及版本尚未核实；参考结构不能替代上传模板');
  add('tax_format_unsupported', '当前没有经过验证的税局上传文件格式');
  add('account_mapping_incomplete', '本地账套至完整官方行次的映射及独立金额验收尚未完成');
  return {
    ready: false, scope: 'configuration_only', uploadCompatibility: 'unverified',
    templateId: template?.id ?? null, templateVersion: template?.version ?? null,
    region: input.region === 'CN-FJ' ? 'CN-FJ' : null,
    checkedAccountData: false, supportedUploadFormats: [], blockers,
  };
}

/** 调用者的任何标志或模板都不能解锁尚不存在的适配器。 */
export function buildTaxReportExport(setId, options = {}) {
  const details = assessTaxReportReadiness(setId, options);
  const error = new Error('tax_template_unverified: 尚无经过核实的税局上传模板及完整账套映射');
  error.code = 'tax_template_unverified';
  error.statusCode = 422;
  error.details = details;
  throw error;
}
