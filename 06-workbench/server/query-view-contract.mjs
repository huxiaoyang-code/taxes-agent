// MCP 和账库投影共用的封闭字段合同。业务文字只在本机参与筛选和比对。
export const PAGE_LIMIT = 20;
const yearMonth = /^\d{4}-(0[1-9]|1[0-2])$/;
const date = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
export const snapshotPattern = /^[a-f0-9]{64}$/;
const count = n => Number.isSafeInteger(n) && n >= 0;
const id = n => count(n) && n > 0;
const amount = n => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 1e12;
const bool = n => typeof n === 'boolean';
export const visibleAccountCode = code => typeof code === 'string' && /^\d{1,16}([.-]\d{1,8}){0,2}$/.test(code) ? code : null;
const conventionalCode = code => code === visibleAccountCode(code);
const modes = new Map([
  ['finance_query:voucher.generated.list', 'voucher_index'],
  ['finance_query:voucher.generated.summary', 'voucher_index'],
  ['finance_query:enterprise_account.subject_system.all', 'account_index'],
  ['account_list', 'account_index'],
  ['finance_query:voucher.detail', 'voucher_check'],
]);

export function needsBoundQuery(name, args) {
  return name === 'account_list' ? args.view !== undefined
    : name === 'finance_query' && (args.params?.view !== undefined || args.params?.accountId !== undefined);
}

function exact(record, required, optional = []) {
  if (!record || ![Object.prototype, null].includes(Object.getPrototypeOf(record))) return false;
  const keys = Object.getOwnPropertyNames(record);
  return !Object.getOwnPropertySymbols(record).length && required.every(k => Object.hasOwn(record, k))
    && keys.every(k => (required.includes(k) || optional.includes(k)) && Object.hasOwn(Object.getOwnPropertyDescriptor(record,k),'value'));
}
const header = ['view','offset','limit','totalCount','pageCount','nextOffset','snapshot','rows'];
const totals = ['totalDebit','totalCredit'];
const lines = ['lineNo','accountId','code','debit','credit'];
const matches = ['partyTextFound','basisTextFound'];

export function validQueryView(operation, p) {
  const view = modes.get(operation);
  if (!view) return false;
  const voucherList = view === 'voucher_index', accountList = view === 'account_index';
  const extra = voucherList ? ['period','entryCount',...totals] : accountList ? [] : ['period','voucherDate','voucherId','number','status',...totals];
  if (!exact(p, [...header,...extra], view === 'voucher_check' ? matches : []) || p.view !== view) return false;
  if (!count(p.offset) || !id(p.limit) || p.limit > PAGE_LIMIT || !count(p.totalCount)
    || p.pageCount !== Math.min(p.limit, Math.max(0, p.totalCount - p.offset))
    || p.nextOffset !== (p.offset + p.pageCount < p.totalCount ? p.offset + p.pageCount : null)
    || typeof p.snapshot !== 'string' || !snapshotPattern.test(p.snapshot) || !Array.isArray(p.rows)
    || p.rows.length !== p.pageCount || Reflect.ownKeys(p.rows).length !== p.pageCount + 1) return false;
  if (!accountList && (typeof p.period !== 'string' || !yearMonth.test(p.period) || !totals.every(k => amount(p[k])))) return false;
  if (voucherList && !count(p.entryCount)) return false;
  if (view === 'voucher_check' && (!id(p.voucherId) || !id(p.number) || !['posted','draft'].includes(p.status)
    || typeof p.voucherDate !== 'string' || !date.test(p.voucherDate) || !p.voucherDate.startsWith(p.period+'-')
    || !matches.every(k => !Object.hasOwn(p,k) || bool(p[k])))) return false;
  for (let i = 0; i < p.pageCount; i++) {
    const row = Object.getOwnPropertyDescriptor(p.rows,String(i))?.value;
    if (voucherList) {
      if (!exact(row,['voucherId','number']) || !id(row.voucherId) || !id(row.number)) return false;
    } else if (accountList) {
      if (!exact(row,['accountId','code','leaf','direction']) || !id(row.accountId) || !conventionalCode(row.code)
        || !bool(row.leaf) || !['debit','credit'].includes(row.direction)) return false;
    } else if (!exact(row,lines) || !id(row.lineNo) || !id(row.accountId) || !conventionalCode(row.code)
      || !amount(row.debit) || !amount(row.credit)) return false;
  }
  return true;
}

export function matchesRequestedQuery(name, args, response) {
  const view = response.projection;
  const options = name === 'account_list' ? args : args.params;
  if (!response.ok) return true;
  if (options?.view === undefined && view?.view === undefined && args.nodeId !== 'voucher.detail'
    && !(args.nodeId === 'ledger.general' && options?.accountId !== undefined)) return true;
  if (name !== 'finance_query' && name !== 'account_list') return false;
  if (response.tool !== name || response.accountSetId !== Number(args.accountSetId) || response.nodeId !== args.nodeId) return false;
  if (options?.view === undefined && view?.view === undefined) {
    if (args.nodeId === 'voucher.detail' && view.voucherId !== Number(args.voucherId ?? args.voucher_id ?? options?.voucherId)) return false;
    return args.period === undefined || view.period === args.period;
  }
  const mode = modes.get(response.operation);
  if (!mode || mode !== view?.view || (mode === 'voucher_check' ? 'check' : 'index') !== options?.view) return false;
  return (view.period === undefined || args.period === view.period)
    && (view.voucherId === undefined || view.voucherId === Number(args.voucherId ?? args.voucher_id ?? options.voucherId))
    && view.offset === (options.offset ?? 0) && view.limit === (options.limit ?? 10)
    && (options.snapshot === undefined || view.snapshot === options.snapshot)
    && Object.hasOwn(view,'partyTextFound') === (options.partyText !== undefined)
    && Object.hasOwn(view,'basisTextFound') === (options.basisText !== undefined);
}

export function queryRecovery(operation, code) {
  if (operation === 'finance_query:voucher.detail' && ['voucherId_required','voucher_not_found'].includes(code))
    return {tool:'finance_query', nodeId:'voucher.generated.list', params:{view:'index'}, required:['accountSetId','period'], use:'rows[].voucherId'};
  if (operation === 'finance_query:ledger.general' && ['code_required','account_not_found'].includes(code))
    return {tool:'account_list', view:'index', required:['accountSetId'], use:'rows[].accountId -> params.accountId'};
  if (modes.has(operation) && ['query_snapshot_changed','query_snapshot_required'].includes(code))
    return {action:'restart_same_query', offset:0, omit:['snapshot']};
  if (modes.has(operation) && code === 'query_page_invalid')
    return {action:'check_view_and_paging', offset:0, limit:PAGE_LIMIT};
  return undefined;
}
