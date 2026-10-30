import test from 'node:test';
import assert from 'node:assert/strict';
import {
  listTaxReportTemplates, assessTaxReportReadiness, buildTaxReportExport, validateReferenceReport,
} from '../server/tax-report-format.mjs';

const VERSION = '2011-17-original';
const BS = 'cn-small-enterprise-2011-balance-sheet';
const PL = 'cn-small-enterprise-2011-income-statement';
const CF = 'cn-small-enterprise-2011-cash-flow';
// 合成数据、显式行覆盖及独立手算预期。
// 不从生产公式定义生成预期合计。
function report(count, columns, entries, periodType = 'monthly') {
  return {
    templateVersion: VERSION, periodType, period: periodType === 'annual' ? '2026' : '2026-02',
    currency: 'CNY', unit: '元', columns,
    rows: Array.from({ length: count }, (_, i) => ({ line: i + 1,
      amounts: Object.fromEntries(columns.map((column, j) => [column, entries[i + 1]?.[j] ?? '0.00'])),
    })),
  };
}
function balance() {
  // 资产 2,050.03 = 负债 450.02 + 权益 1,600.01。
  return report(53, ['end', 'beginning'], {
    1: ['1000.01', '500.00'], 4: ['200.02', '0.00'], 9: ['400.00', '0.00'],
    10: ['100.00', '0.00'], 11: ['50.00', '0.00'], 12: ['200.00', '0.00'], 13: ['50.00', '0.00'],
    15: ['1600.03', '500.00'], 18: ['500.00', '0.00'], 19: ['50.00', '0.00'],
    20: ['450.00', '0.00'], 29: ['450.00', '0.00'], 30: ['2050.03', '500.00'],
    31: ['300.00', '0.00'], 33: ['150.02', '0.00'], 41: ['450.02', '0.00'],
    47: ['450.02', '0.00'], 48: ['1000.00', '500.00'], 51: ['600.01', '0.00'],
    52: ['1600.01', '500.00'], 53: ['2050.03', '500.00'],
  });
}
function income(periodType = 'monthly') {
  return report(32, periodType === 'annual' ? ['currentYear', 'previousYear'] : ['yearToDate', 'currentMonth'], {
    1: ['1000.00', '0.00'], 2: ['600.00', '10.00'], 3: ['30.00', '0.00'], 4: ['5.00', '0.00'],
    6: ['15.00', '0.00'], 10: ['10.00', '0.00'], 11: ['40.00', '0.00'], 12: ['10.00', '0.00'],
    13: ['20.00', '0.00'], 14: ['50.00', '0.00'], 15: ['10.00', '0.00'],
    16: ['20.00', '0.00'], 17: ['20.00', '0.00'], 18: ['10.00', '0.00'], 19: ['5.00', '0.00'],
    20: ['-20.00', '0.00'], 21: ['250.00', '-10.00'], 22: ['15.00', '0.00'], 23: ['10.00', '0.00'],
    24: ['5.00', '0.00'], 25: ['5.00', '0.00'], 30: ['260.00', '-10.00'],
    31: ['65.00', '0.00'], 32: ['195.00', '-10.00'],
  }, periodType);
}
function cash() {
  return report(22, ['yearToDate', 'currentMonth'], {
    1: ['100.00', '0.00'], 2: ['20.00', '0.00'], 3: ['50.00', '10.00'],
    4: ['20.00', '0.00'], 5: ['5.00', '0.00'], 6: ['10.00', '0.00'], 7: ['35.00', '-10.00'],
    8: ['20.00', '0.00'], 9: ['2.00', '0.00'], 10: ['8.00', '0.00'],
    11: ['15.00', '0.00'], 12: ['30.00', '0.00'], 13: ['-15.00', '0.00'],
    14: ['40.00', '0.00'], 15: ['10.00', '0.00'], 16: ['20.00', '0.00'],
    17: ['2.00', '0.00'], 18: ['3.00', '0.00'], 19: ['25.00', '0.00'],
    20: ['45.00', '-10.00'], 21: ['100.00', '155.00'], 22: ['145.00', '145.00'],
  });
}
const codes = result => result.errors.map(error => error.code);
const hasError = (id, value, code) => assert.ok(codes(validateReferenceReport(id, value)).includes(code), code);
const options = () => ({ period: '2026-02', region: 'CN-FJ', accountingStandard: '小企业会计准则',
  templateId: BS, templateVersion: VERSION, format: 'xlsx' });

test('catalog has exact statutory line counts, original labels, source and unverified status', () => {
  const templates = listTaxReportTemplates();
  assert.deepEqual(templates.map(t => t.rows.length), [53, 32, 22]);
  assert.deepEqual(templates.map(t => t.formNumber), ['会小企01表', '会小企02表', '会小企03表']);
  assert.equal(templates[1].rows[4].label, '营业税');
  for (const template of templates) {
    assert.match(template.source.url, /^https:\/\/policy\.mofcom\.gov\.cn\//);
    assert.equal(template.version, VERSION);
    assert.equal(template.uploadCompatibility, 'unverified');
    assert.deepEqual(template.uploadFormats, []);
    assert.equal(JSON.parse(JSON.stringify(template)).rows.length, template.rows.length);
  }
});
test('catalog mutation cannot alter validator or upload gating', () => {
  const template = listTaxReportTemplates()[0];
  template.uploadCompatibility = 'verified'; template.uploadFormats.push('xlsx');
  template.formulas.length = 0; template.rows.length = 0; template.columns.monthly[0].id = 'injected';
  assert.equal(listTaxReportTemplates()[0].rows.length, 53);
  assert.equal(validateReferenceReport(BS, balance()).valid, true);
  assert.equal(assessTaxReportReadiness(1, options()).ready, false);
});
test('balance sheet independently reconciles every subtotal and both columns', () => {
  assert.equal(validateReferenceReport(BS, balance()).valid, true);
});
test('income statement supports explicit losses and annual comparison columns', () => {
  assert.equal(validateReferenceReport(PL, income()).valid, true);
  assert.equal(validateReferenceReport(PL, income('annual')).valid, true);
});
test('cash flow separates operating/investing/financing and exact closing cash', () => {
  assert.equal(validateReferenceReport(CF, cash()).valid, true);
});
test('one cent error is rejected even when both sides of balance are changed together', () => {
  const input = balance(); input.rows[29].amounts.end = '2050.04'; input.rows[52].amounts.end = '2050.04';
  hasError(BS, input, 'formula_mismatch');
});
test('formula checks include comparative column', () => {
  const input = income('annual'); input.rows[31].amounts.previousYear = '0.00';
  const result = validateReferenceReport(PL, input);
  assert.ok(result.errors.some(error => error.code === 'formula_mismatch' && error.column === 'previousYear'));
});
test('cash flow failure is not concealed by a matching final cash balance', () => {
  const input = cash(); input.rows[6].amounts.yearToDate = '36.00';
  hasError(CF, input, 'formula_mismatch');
});
test('included detail comparisons are deferred without sign and reversal semantics', () => {
  const input = balance(); input.rows[9].amounts.end = '401.00';
  assert.equal(validateReferenceReport(BS, input).valid, true);
  assert.ok(listTaxReportTemplates().every(template => template.formulas.every(formula => formula.operator === '=')));
});
test('negative finance expense may be lower than included negative interest expense', () => {
  const input = report(32, ['yearToDate', 'currentMonth'], {
    18: ['-150.00', '-150.00'], 19: ['-100.00', '-100.00'],
    21: ['150.00', '150.00'], 30: ['150.00', '150.00'], 32: ['150.00', '150.00'],
  });
  assert.equal(validateReferenceReport(PL, input).valid, true);
  input.rows[20].amounts.currentMonth = '149.99';
  hasError(PL, input, 'formula_mismatch');
});
test('signed subtotals retain additive checks without assuming unsigned remainder', () => {
  const input = report(32, ['yearToDate', 'currentMonth'], {
    3: ['-20.00', '0.00'], 4: ['-10.00', '0.00'],
    11: ['-30.00', '0.00'], 12: ['-10.00', '0.00'],
    14: ['-40.00', '0.00'], 15: ['-10.00', '0.00'],
    21: ['90.00', '0.00'], 22: ['-50.00', '0.00'], 23: ['-10.00', '0.00'],
    24: ['-60.00', '0.00'], 25: ['-10.00', '0.00'],
    30: ['100.00', '0.00'], 32: ['100.00', '0.00'],
  });
  assert.equal(validateReferenceReport(PL, input).valid, true);
});
test('missing rows are never silently replaced with zero', () => {
  const input = balance(); input.rows.splice(1, 1);
  const result = validateReferenceReport(BS, input);
  assert.ok(result.errors.some(error => error.code === 'line_missing' && error.line === 2));
});
test('duplicate, noninteger, unknown and excessive rows are rejected', () => {
  const duplicate = balance(); duplicate.rows[1].line = 1; hasError(BS, duplicate, 'line_duplicate');
  for (const line of ['2', 2.5, 0, 54]) {
    const input = balance(); input.rows[1].line = line; hasError(BS, input, 'line_invalid');
  }
  const excessive = balance(); excessive.rows.push({ line: 54, amounts: { end: 0, beginning: 0 } });
  hasError(BS, excessive, 'row_count_invalid');
});
test('each row requires exact columns; zero must be explicitly supplied', () => {
  const missing = balance(); delete missing.rows[0].amounts.beginning; hasError(BS, missing, 'row_columns_invalid');
  const extra = balance(); extra.rows[0].amounts.extra = 1; hasError(BS, extra, 'row_columns_invalid');
  const wrongOrder = balance(); wrongOrder.columns.reverse(); hasError(BS, wrongOrder, 'columns_invalid');
});
test('reject nonfinite, coerced, malformed, overprecise and oversized amounts', () => {
  for (const value of [NaN, Infinity, -Infinity, null, undefined, true, [], {}, '', ' ', '1x', '1e2',
    '1,000.00', '01.00', '+1.00', ' 1.00', 0.001, '0.001', '-0.001', '1000000000000.00', 1e15]) {
    const input = balance(); input.rows[0].amounts.end = value; hasError(BS, input, 'amount_invalid');
  }
});
test('exact decimal cents and numeric cents both work without tolerance', () => {
  const input = report(53, ['end', 'beginning'], { 1: [0.1, 0], 2: ['0.20', 0], 15: ['0.30', 0],
    30: ['0.30', 0], 48: ['0.30', 0], 52: ['0.30', 0], 53: ['0.30', 0] });
  assert.equal(validateReferenceReport(BS, input).valid, true);
  input.rows[0].amounts.end = 0.1 + 0.2; hasError(BS, input, 'amount_invalid');
});
test('reject wrong or missing template versions and unknown templates', () => {
  for (const templateVersion of [undefined, '', 'latest', '2026']) hasError(BS, { ...balance(), templateVersion }, 'template_version_unsupported');
  hasError('unknown', balance(), 'template_unsupported');
});
test('period type, actual month, year, currency and unit are explicit', () => {
  for (const period of ['2026-00', '2026-13', '26-01', '2026-1', '2026', '2026-01-31', null]) {
    hasError(BS, { ...balance(), period }, 'period_invalid');
  }
  for (const periodType of ['quarterly', undefined, '__proto__', 'constructor']) hasError(BS, { ...balance(), periodType }, 'period_type_unsupported');
  hasError(BS, { ...balance(), currency: 'USD' }, 'currency_unsupported');
  hasError(BS, { ...balance(), unit: '万元' }, 'unit_unsupported');
});
test('annual report cannot reuse monthly flow column names', () => {
  hasError(PL, { ...income(), periodType: 'annual', period: '2026' }, 'columns_invalid');
});
test('malformed report shapes fail structurally', () => {
  for (const value of [null, [], 'text']) hasError(BS, value, 'report_invalid');
  hasError(BS, { ...balance(), rows: null }, 'rows_invalid');
  const input = balance(); input.rows[0] = null; hasError(BS, input, 'line_invalid');
});
test('readiness always identifies absent official upload and mapping evidence', () => {
  const result = assessTaxReportReadiness(1, options());
  assert.equal(result.ready, false); assert.equal(result.checkedAccountData, false);
  assert.deepEqual(result.blockers.map(b => b.code), ['tax_template_unverified', 'tax_format_unsupported', 'account_mapping_incomplete']);
});
test('readiness validates IDs, region, standard, version, template and period without data access', () => {
  const result = assessTaxReportReadiness('1', { ...options(), region: 'CN-BJ', accountingStandard: '企业会计准则',
    templateId: 'custom', templateVersion: '2026', period: '2026-13' });
  for (const code of ['account_set_id_invalid', 'region_unsupported', 'accounting_standard_unsupported',
    'template_unsupported', 'template_version_unsupported', 'period_invalid']) assert.ok(result.blockers.some(b => b.code === code));
  assert.equal(assessTaxReportReadiness(1, null).ready, false);
});
test('client verification flags, custom adapter and format cannot bypass export gate', () => {
  for (const format of ['csv', 'xlsx', 'xml', 'json', undefined]) {
    assert.throws(() => buildTaxReportExport(1, { ...options(), format, verified: true, uploadCompatibility: 'verified',
      template: { verified: true }, adapter: () => 'forged' }), error => {
      assert.equal(error.code, 'tax_template_unverified'); assert.equal(error.statusCode, 422);
      assert.equal(error.details.ready, false); return true;
    });
  }
});
test('diagnostics do not echo supplied amounts, credentials or custom options', () => {
  const input = balance(); input.rows[0].amounts.end = 'sensitive-invalid-text';
  const diagnostics = validateReferenceReport(BS, input);
  assert.ok(!JSON.stringify(diagnostics).includes('sensitive-invalid-text'));
  const result = assessTaxReportReadiness(1, { ...options(), token: 'secret-sentinel', region: 'secret-sentinel' });
  assert.ok(!JSON.stringify(result).includes('secret-sentinel'));
});
