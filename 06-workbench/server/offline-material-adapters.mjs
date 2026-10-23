// Pure material normalization. No filesystem, database, golden expectations or execution.
import { readInvoiceXlsx } from './offline-invoice-xlsx.mjs';
import { createHash } from 'node:crypto';
import { canonicalEnterpriseKey } from './enterprise-identity.mjs';
import { offlineMoneyToCents } from './offline-contracts.mjs';
import { parseBankCsv, parseDateByFormat, normalizeMapping, normalizeBankRow, formatCents } from './bank-import.mjs';

export const MATERIAL_VERSION = 'offline-materials/1';
export const hash = value => createHash('sha256').update(value).digest('hex');
export const stable = value => Array.isArray(value) ? `[${value.map(stable).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}` : JSON.stringify(value);
export const requireValue = (ok, code = 'material_invalid') => { if (!ok) throw Object.assign(new Error(code), { code }); };
const ERROR_CODES = new Set(['xlsx_string_escape_unsupported', 'xlsx_limit', 'xlsx_zip_invalid', 'xlsx_zip_or_xml_invalid', 'xlsx_xml_invalid', 'xlsx_structure_unsupported', 'xlsx_part_missing', 'xlsx_external_link_unsupported', 'xlsx_cell_invalid', 'xlsx_cell_type_unsupported', 'xlsx_numeric_format_unsupported', 'xlsx_text_required', 'xlsx_sheet_missing', 'xlsx_header_missing', 'xlsx_header_ambiguous', 'xlsx_rows_missing', 'xlsx_formula_unsupported', 'material_invalid', 'fields_invalid', 'identifier_invalid', 'mapping_invalid', 'enterprise_invalid', 'currency_invalid', 'period_invalid', 'date_invalid', 'date_outside_scope', 'amount_invalid', 'offline_amount_invalid', 'csv_invalid_or_empty', 'mapped_column_missing', 'invoice_id_invalid', 'enterprise_mismatch', 'invoice_status_unsupported', 'invoice_total_mismatch', 'correction_reference_required', 'correction_reference_invalid', 'red_sign_invalid', 'blue_sign_invalid', 'bank_owner_or_currency_mismatch', 'bank_mapping_unsupported', 'bank_mapping_invalid', 'bank_row_invalid', 'business_version_invalid', 'scope_mismatch', 'business_facts_empty_or_invalid', 'business_fact_invalid', 'benefit_period_invalid', 'source_digest_invalid', 'material_kind_unsupported', 'sources_invalid', 'source_id_conflict', 'business_invoice_reference_missing']);
export function safeMaterialError(error, sourceIndex) {
  const result = { code: ERROR_CODES.has(error?.code) ? error.code : 'material_preflight_rejected' };
  if (Number.isSafeInteger(sourceIndex) && sourceIndex >= 0) result.sourceIndex = sourceIndex;
  for (const key of ['row', 'line']) if (Number.isSafeInteger(error?.position?.[key]) && error.position[key] > 0) result[key] = error.position[key];
  if (['net', 'tax', 'gross', 'date'].includes(error?.materialField)) result.field = error.materialField;
  return result;
}
function located(work, position) {
  try { return work(); } catch (error) { error.position = position; throw error; }
}
function atField(field, work) {
  try { return work(); } catch (error) { error.materialField = field; throw error; }
}
export function fields(value, required, optional = []) {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype, 'fields_invalid');
  requireValue(required.every(k => Object.hasOwn(value, k)) && Object.keys(value).every(k => [...required, ...optional].includes(k)), 'fields_invalid');
}
export function requirePlainJson(value) {
  const active = new Set(); let nodes = 0;
  function visit(v, depth) {
    requireValue(++nodes <= 100000 && depth <= 32, 'fields_invalid');
    if (v === null || ['string', 'boolean'].includes(typeof v)) return;
    if (typeof v === 'number') { requireValue(Number.isFinite(v), 'fields_invalid'); return; }
    requireValue(v && typeof v === 'object' && !active.has(v), 'fields_invalid');
    const array = Array.isArray(v);
    requireValue(Object.getPrototypeOf(v) === (array ? Array.prototype : Object.prototype), 'fields_invalid');
    const descriptors = Object.getOwnPropertyDescriptors(v);
    const keys = Reflect.ownKeys(descriptors);
    requireValue(keys.every(k => typeof k === 'string' && Object.hasOwn(descriptors[k], 'value')), 'fields_invalid');
    if (array) requireValue(keys.length === v.length + 1 && keys.every(k => k === 'length' || /^(0|[1-9]\d*)$/.test(k) && Number(k) < v.length), 'fields_invalid');
    active.add(v);
    for (const key of keys) if (!(array && key === 'length')) visit(descriptors[key].value, depth + 1);
    active.delete(v);
  }
  visit(value, 0);
}
export const identifier = v => requireValue(typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v), 'identifier_invalid');
const label = v => requireValue(typeof v === 'string' && v.length > 0 && v.length <= 200 && v.trim() === v && !/[\u0000-\u001f\u007f]/.test(v), 'mapping_invalid');
const enterprise = v => requireValue(typeof v === 'string' && v.length > 0 && v.length <= 128 && !/[\u0000-\u001f\u007f]/.test(v) && canonicalEnterpriseKey(v) === v, 'enterprise_invalid');
export function validateScope(scope) {
  fields(scope, ['enterpriseKey', 'accountSetId', 'period', 'currency', 'unit']);
  enterprise(scope.enterpriseKey); identifier(scope.accountSetId);
  requireValue(scope.currency === 'CNY' && scope.unit === 'yuan', 'currency_invalid');
  const p = scope.period;
  if (typeof p === 'string') {
    requireValue(/^20\d{2}-Q[1-4]$/.test(p), 'period_invalid');
    const q = Number(p.at(-1));
    return { from: `${p.slice(0, 4)}-${String(q * 3 - 2).padStart(2, '0')}`, to: `${p.slice(0, 4)}-${String(q * 3).padStart(2, '0')}` };
  }
  fields(p, ['from', 'to']);
  requireValue([p.from, p.to].every(v => typeof v === 'string' && /^20\d{2}-(0[1-9]|1[0-2])$/.test(v)) && p.from <= p.to, 'period_invalid');
  return p;
}
function date(raw, format, scope) {
  const parsed = parseDateByFormat(raw, format);
  requireValue(parsed.ok, 'date_invalid');
  const { from, to } = validateScope(scope);
  requireValue(parsed.date.slice(0, 7) >= from && parsed.date.slice(0, 7) <= to, 'date_outside_scope');
  return parsed.date;
}
function money(raw) {
  // CSV whole yuan and single decimal are accepted; normalized contract is exactly 2 decimals.
  requireValue(typeof raw === 'string' && /^-?(?:0|[1-9]\d{0,12})(?:\.\d{1,2})?$/.test(raw), 'amount_invalid');
  const [whole, fraction = ''] = raw.split('.');
  const normalized = `${whole}.${fraction.padEnd(2, '0')}`;
  return offlineMoneyToCents(normalized);
}
function columnMap(columns, required, optional) {
  fields(columns, required, optional);
  Object.values(columns).forEach(label);
  requireValue(new Set(Object.values(columns)).size === Object.keys(columns).length, 'mapping_invalid');
}
function csv(text, columns) {
  const parsed = parseBankCsv(text, { ignoreBlankRows: false });
  requireValue(parsed.ok && parsed.rows.length > 0, 'csv_invalid_or_empty');
  const index = new Map(Object.entries(columns).map(([key, header]) => [key, parsed.headers.indexOf(header)]));
  requireValue([...index.values()].every(i => i >= 0), 'mapped_column_missing');
  return { ...parsed, index };
}
function location(row, columns, index) {
  return { row: row.rowNumber, line: row.lineNumber, fields: Object.fromEntries(Object.entries(columns).map(([key, header]) => [key, { header, column: index.get(key) + 1 }])) };
}
function invoice(text, mapping, scope, parsedInput) {
  fields(mapping, ['format', 'role', 'dateFormat', 'columns', 'statusLabels', 'redSign']);
  requireValue(mapping.format === 'invoice-summary-csv-v1' && ['sales', 'purchase'].includes(mapping.role), 'mapping_invalid');
  requireValue(['signed_negative', 'unsigned_positive'].includes(mapping.redSign), 'mapping_invalid');
  fields(mapping.statusLabels, ['blue', 'red']);
  for (const labels of Object.values(mapping.statusLabels)) {
    requireValue(Array.isArray(labels) && labels.length > 0 && labels.length <= 20, 'mapping_invalid'); labels.forEach(label);
  }
  const labels = [...mapping.statusLabels.blue, ...mapping.statusLabels.red];
  requireValue(new Set(labels).size === labels.length, 'mapping_invalid');
  columnMap(mapping.columns, ['number', 'date', 'sellerKey', 'buyerKey', 'net', 'tax', 'gross', 'status'], ['code', 'originalNumber', 'originalCode', 'originalSourceVersion']);
  const parsed = parsedInput ?? csv(text, mapping.columns);
  return parsed.rows.map(row => located(() => {
    const get = k => row.cells[parsed.index.get(k)] ?? '';
    const number = get('number'), code = get('code');
    requireValue(/^\d{1,30}$/.test(number) && (code === '' || /^\d{1,30}$/.test(code)), 'invoice_id_invalid');
    enterprise(get('sellerKey')); enterprise(get('buyerKey'));
    requireValue(get(mapping.role === 'sales' ? 'sellerKey' : 'buyerKey') === scope.enterpriseKey, 'enterprise_mismatch');
    const status = get('status');
    const isRed = mapping.statusLabels.red.includes(status);
    requireValue(isRed || mapping.statusLabels.blue.includes(status), 'invoice_status_unsupported');
    let net = atField('net', () => money(get('net'))), tax = atField('tax', () => money(get('tax'))), gross = atField('gross', () => money(get('gross')));
    requireValue(net + tax === gross, 'invoice_total_mismatch');
    let correctionOf = null;
    if (isRed) {
      const originalNumber = get('originalNumber'), originalCode = get('originalCode'), sourceVersion = get('originalSourceVersion');
      requireValue(/^\d{1,30}$/.test(originalNumber) && (originalCode === '' || /^\d{1,30}$/.test(originalCode)), 'correction_reference_required');
      requireValue(/^[a-f0-9]{64}$/.test(sourceVersion), 'correction_reference_required');
      requireValue(originalNumber !== number || originalCode !== code, 'correction_reference_invalid');
      if (mapping.redSign === 'signed_negative') requireValue(net <= 0n && tax <= 0n && gross < 0n, 'red_sign_invalid');
      else { requireValue(net >= 0n && tax >= 0n && gross > 0n, 'red_sign_invalid'); net = -net; tax = -tax; gross = -gross; }
      correctionOf = { number: originalNumber, code: originalCode, sourceVersion, verification: 'not_verified' };
    } else {
      requireValue(net >= 0n && tax >= 0n && gross > 0n, 'blue_sign_invalid');
      requireValue(['originalNumber', 'originalCode', 'originalSourceVersion'].every(k => get(k) === ''), 'correction_reference_invalid');
    }
    return { kind: 'invoice', semantic: { role: mapping.role, number, code, date: atField('date', () => date(get('date'), mapping.dateFormat, scope)), sellerKey: get('sellerKey'), buyerKey: get('buyerKey'), net: formatCents(net), tax: formatCents(tax), gross: formatCents(gross), status: isRed ? 'red' : 'blue', correctionOf },
      identity: stable([get('sellerKey'), code, number]), reliability: 'stable', location: row.location ?? location(row, mapping.columns, parsed.index), raw: row.cells };
  }, { row: row.rowNumber, line: row.lineNumber }));
}
function bank(text, mapping, scope) {
  fields(mapping, ['format', 'ownerEnterpriseKey', 'bankAccountId', 'columns', 'dateFormat', 'amountMode', 'currency', 'negativeAmount'], ['directionLabels', 'thousandsSeparator', 'allowCurrencySymbol']);
  requireValue(mapping.format === 'bank-csv-v1' && mapping.ownerEnterpriseKey === scope.enterpriseKey && mapping.currency === 'CNY', 'bank_owner_or_currency_mismatch');
  identifier(mapping.bankAccountId);
  // Deliberately narrow to explicit amount + enterprise-perspective direction.
  requireValue(mapping.amountMode === 'amount_direction', 'bank_mapping_unsupported');
  columnMap(mapping.columns, ['date', 'amount', 'direction'], ['summary', 'refId', 'balance', 'currency']);
  fields(mapping.directionLabels, ['inflow', 'outflow']);
  if (Object.hasOwn(mapping, 'allowCurrencySymbol')) requireValue(typeof mapping.allowCurrencySymbol === 'boolean', 'mapping_invalid');
  const normalized = normalizeMapping(mapping); requireValue(normalized.ok, 'bank_mapping_invalid');
  const parsed = csv(text, mapping.columns);
  return parsed.rows.map(row => located(() => {
    const actualDate = date(row.cells[parsed.index.get('date')], mapping.dateFormat, scope);
    const result = normalizeBankRow({ cells: row.cells, headerIndex: parsed.index, mapping: normalized.mapping, period: actualDate.slice(0, 7), rowNumber: row.rowNumber, lineNumber: row.lineNumber });
    requireValue(result.ok, 'bank_row_invalid');
    const r = result.row;
    const semantic = { bankAccountId: mapping.bankAccountId, date: r.date, refId: r.refId, direction: r.direction, amount: formatCents(r.amountCents), balance: r.balanceCents === null ? null : formatCents(r.balanceCents), summary: r.summary, accountingMeaning: 'unclassified_bank_activity' };
    return { kind: 'bank_activity', semantic, identity: r.refId ? stable([mapping.bankAccountId, r.refId]) : hash(stable(semantic)), reliability: r.refId ? 'stable' : 'suspected_only', location: location(row, mapping.columns, parsed.index), raw: row.cells };
  }, { row: row.rowNumber, line: row.lineNumber }));
}
function business(text, mapping, scope) {
  fields(mapping, ['format']); requireValue(mapping.format === 'business-facts-json-v1', 'mapping_invalid');
  const document = JSON.parse(text.replace(/^\uFEFF/, ''));
  fields(document, ['version', 'scope', 'facts']);
  requireValue(document.version === 'business-facts/1', 'business_version_invalid');
  validateScope(document.scope); requireValue(stable(document.scope) === stable(scope), 'scope_mismatch');
  requireValue(Array.isArray(document.facts) && document.facts.length > 0 && document.facts.length <= 1000, 'business_facts_empty_or_invalid');
  return document.facts.map((fact, i) => located(() => {
    fields(fact, ['factId', 'date', 'nature', 'performance', 'settlement', 'purpose', 'benefitPeriod', 'invoiceRef']);
    identifier(fact.factId);
    requireValue(['service', 'goods', 'unknown'].includes(fact.nature) && ['completed', 'not_completed', 'unknown'].includes(fact.performance) && ['received', 'paid', 'unpaid', 'unknown'].includes(fact.settlement), 'business_fact_invalid');
    requireValue(['operating_service', 'asset_related', 'inventory_related', 'personal', 'unknown'].includes(fact.purpose), 'business_fact_invalid');
    fields(fact.benefitPeriod, ['state', 'from', 'to']);
    if (fact.benefitPeriod.state === 'known') {
      const { from, to } = fact.benefitPeriod;
      requireValue(typeof from === 'string' && typeof to === 'string' && /^20\d{2}-\d{2}-\d{2}$/.test(from) && /^20\d{2}-\d{2}-\d{2}$/.test(to) && parseDateByFormat(from, 'YYYY-MM-DD').ok && parseDateByFormat(to, 'YYYY-MM-DD').ok && from <= to, 'benefit_period_invalid');
    } else requireValue(fact.benefitPeriod.state === 'unknown' && fact.benefitPeriod.from === null && fact.benefitPeriod.to === null, 'benefit_period_invalid');
    fields(fact.invoiceRef, ['sellerKey', 'code', 'number']); enterprise(fact.invoiceRef.sellerKey);
    requireValue(typeof fact.invoiceRef.number === 'string' && typeof fact.invoiceRef.code === 'string' && /^\d{1,30}$/.test(fact.invoiceRef.number) && (fact.invoiceRef.code === '' || /^\d{1,30}$/.test(fact.invoiceRef.code)), 'invoice_id_invalid');
    requireValue(typeof fact.date === 'string' && /^20\d{2}-\d{2}-\d{2}$/.test(fact.date) && date(fact.date, 'YYYY-MM-DD', scope) === fact.date, 'date_invalid');
    return { kind: 'business_fact', semantic: fact, identity: fact.factId, reliability: 'stable', location: { row: i + 1, pointer: `/facts/${i}`, fields: Object.fromEntries(Object.keys(fact).map(k => [k, { pointer: `/facts/${i}/${k}` }])) }, raw: fact };
  }, { row: i + 1 }));
}
// Binary sources use canonical base64 ONLY as JSON transport. Hash raw bytes, never base64.
export function sourceBytes(kind, text) {
  requireValue(typeof text === 'string', 'source_digest_invalid');
  if (kind !== 'invoice_xlsx') {
    requireValue(Buffer.byteLength(text, 'utf8') <= 5 * 1024 * 1024, 'source_digest_invalid');
    return Buffer.from(text, 'utf8');
  }
  requireValue(text.length <= 4 * Math.ceil(5 * 1024 * 1024 / 3) && text.length % 4 === 0 && /^[A-Za-z0-9+/=]*$/.test(text), 'source_digest_invalid');
  const bytes = Buffer.from(text, 'base64');
  requireValue(bytes.length > 0 && bytes.length <= 5 * 1024 * 1024 && bytes.toString('base64') === text, 'source_digest_invalid');
  return bytes;
}
export function sourceText(kind, bytes) {
  return kind === 'invoice_xlsx' ? Buffer.from(bytes).toString('base64') : new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
}
// Every replay reparses the actual original bytes; scope/ownership remain assertions.
export function normalizeMaterial(input) {
  requirePlainJson(input);
  fields(input, ['kind', 'text', 'mapping', 'scope', 'fileSha256'], ['sourceId']);
  if (Object.hasOwn(input, 'sourceId')) identifier(input.sourceId);
  const { kind, text, mapping, scope, fileSha256 } = input;
  validateScope(scope);
  requireValue(['invoice_csv', 'invoice_xlsx', 'bank_csv', 'business_json'].includes(kind), 'material_kind_unsupported');
  const bytes = sourceBytes(kind, text);
  requireValue(hash(bytes) === fileSha256, 'source_digest_invalid');
  if (kind === 'invoice_xlsx') {
    fields(mapping, ['format', 'sheet', 'headerRow', 'role', 'dateFormat', 'columns', 'statusLabels', 'redSign']);
    requireValue(mapping.format === 'invoice-summary-xlsx-v1' && typeof mapping.sheet === 'string' && mapping.sheet.length > 0 && mapping.sheet.length <= 31 && Number.isSafeInteger(mapping.headerRow) && mapping.headerRow > 0 && mapping.headerRow < 10000, 'mapping_invalid');
    columnMap(mapping.columns, ['number', 'date', 'sellerKey', 'buyerKey', 'net', 'tax', 'gross', 'status'], ['code', 'originalNumber', 'originalCode', 'originalSourceVersion']);
    const parsed = readInvoiceXlsx(bytes, mapping);
    const { sheet, headerRow, ...csvMapping } = mapping;
    return invoice('', { ...csvMapping, format: 'invoice-summary-csv-v1' }, scope, parsed);
  }
  return ({ invoice_csv: invoice, bank_csv: bank, business_json: business })[kind](text, mapping, scope);
}
