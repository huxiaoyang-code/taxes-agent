// Source-checked engineering rules, not accountant-approved production policy.
import { getAccountingProfile, getAccountingRoles } from './accounting-profiles.mjs';
import { requireValue } from './offline-material-adapters.mjs';

export const BOOKKEEPING_RULE_VERSION = 'offline-voucher-rules/1';
const deepFreeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); } return value; };
const productDates = { productSupportedFrom: '2026-01-01', productSupportedThrough: '2026-12-31', productDateMeaning: 'candidate_recognition_date_engineering_scope_not_legal_expiry' };
const standardEffective = { from: '2013-01-01', locator: '小企业会计准则第90条' };
const vatAccountingEffective = { from: null, note: '财会〔2016〕22号通知日期2016-12-03；本目录未单独核定生效条款，不据此开放历史规则' };
export const RULE_CATALOG = deepFreeze({
  service_sale: { id: 'small-service-sale/1', checkedOn: '2026-10-24', ...productDates, legalSourceEffective: { smallEnterpriseStandard: standardEffective, vatLaw: { from: '2026-01-01', locator: '增值税法第38条' }, vatAccountingProvision: vatAccountingEffective }, application: '仅small-2011；同本期开始完成，开票/完成/取得收款权利同日，派生同日VAT触发；小规模非零票税初始确认', accountingApproval: 'pending', sources: [
    { url: 'https://kjs.mof.gov.cn/zhengcefabu/201111/P020111118325852319878.pdf', locator: '第63条，印刷第21页；同一会计年度开始并完成劳务' },
    { url: 'https://kjs.mof.gov.cn/zhengcefabu/201111/P020111118325852734144.pdf', locator: '1122，应收账款，印刷第7—8页' },
    { url: 'https://www.mof.gov.cn/gkml/caizhengwengao/2017wg/wg201703/201707/t20170707_2641107.htm', locator: '财会〔2016〕22号，二（二）1；小规模初始确认' },
    { url: 'https://www.mof.gov.cn/bd/mhwzzxly/hjs/202401/t20240123_3926932.htm', locator: '2024-01-23会计司回复；事前已知1%可直接初始确认，不确认2%收益' },
    { url: 'https://shanghai.chinatax.gov.cn/zcfw/zcfgk/zzs/202412/t474694.html', locator: '中华人民共和国增值税法，2026-01-01施行，第28条（一）；索款凭据日，先开票为开票日' },
  ] },
  administrative_service: { id: 'small-admin-service/1', checkedOn: '2026-10-24', ...productDates, legalSourceEffective: { smallEnterpriseStandard: standardEffective, vatAccountingProvision: vatAccountingEffective }, application: '仅当月完成并全部受益的组织行政日常服务；未付；小规模进项不可抵扣', accountingApproval: 'pending', sources: [
    { url: 'https://kjs.mof.gov.cn/zhengcefabu/201111/P020111118325852734144.pdf', locator: '2202，应付账款，印刷第37页；5602，管理费用，印刷第64—65页' },
    { url: 'https://www.mof.gov.cn/gkml/caizhengwengao/2017wg/wg201703/201707/t20170707_2641107.htm', locator: '财会〔2016〕22号，二（一）5；小规模购进进项计入成本费用' },
  ] },
  service_prepayment: { id: 'small-future-service-prepayment/1', checkedOn: '2026-10-24', ...productDates, legalSourceEffective: { smallEnterpriseStandard: standardEffective }, application: '单笔普通短期服务合同预付；期末未履约无退款；未来12个月内服务', accountingApproval: 'pending', sources: [
    { url: 'https://kjs.mof.gov.cn/zhengcefabu/201111/P020111118325852319878.pdf', locator: '第7条；一年内耗用的流动资产' },
    { url: 'https://kjs.mof.gov.cn/zhengcefabu/201111/P020111118325852734144.pdf', locator: '1123，预付账款，印刷第8—9页；1002，银行存款' },
  ] },
});

export function candidateAccounts(profileId) {
  requireValue(profileId === 'small-2011-basic-v1', 'profile_unsupported');
  const profile = getAccountingProfile(profileId), roles = getAccountingRoles(profileId);
  // These fixed mappings belong only to these rules; no name matching or suffix inference.
  const accounts = { receivable: '1122', payable: '2202', prepayment: '1123', bank: '1002', vat: '2221', revenue: roles.mainRevenue, admin: roles.adminExpense };
  for (const code of Object.values(accounts)) requireValue(profile.coa.some(a => a.code === code), 'profile_account_missing');
  return { accounts, provenance: { profileId: profile.id, coaVersion: profile.coaVersion, roles: { mainRevenue: roles.mainRevenue, adminExpense: roles.adminExpense }, fixedRuleMappings: { receivable: '1122', payable: '2202', prepayment: '1123', bank: '1002', vat: '2221' }, sources: profile.sources } };
}

export function createEntries(kind, data, accounts, refs) {
  const line = (role, debit, credit, sourceFields, detail = null) => ({ accountCode: accounts[role], role, debit, credit, detail, sourceFields: sourceFields.map(field => ({ ...refs.amountSource, field, location: refs.amountSource.location.fields[field] })), ruleId: RULE_CATALOG[kind].id });
  if (kind === 'service_sale') return [line('receivable', data.gross, '0.00', ['gross']), line('revenue', '0.00', data.net, ['net']), line('vat', '0.00', data.tax, ['tax'], '应交增值税')];
  if (kind === 'administrative_service') return [line('admin', data.gross, '0.00', ['gross']), line('payable', '0.00', data.gross, ['gross'])];
  return [line('prepayment', data.amount, '0.00', ['amount']), line('bank', '0.00', data.amount, ['amount'])];
}
