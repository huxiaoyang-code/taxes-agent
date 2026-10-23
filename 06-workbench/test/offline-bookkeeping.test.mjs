import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { preflightMaterials } from '../server/offline-materials.mjs';
import { buildOfflineCandidates } from '../server/offline-bookkeeping.mjs';
import { stable } from '../server/offline-material-adapters.mjs';

const sha = x => createHash('sha256').update(x).digest('hex'), clone = structuredClone;
const scope = { enterpriseKey: 'SYNTHETIC-OFFLINE', accountSetId: 'synthetic-book', period: '2026-Q1', currency: 'CNY', unit: 'yuan' };
const invoiceMap = role => ({ format: 'invoice-summary-csv-v1', role, dateFormat: 'YYYY-MM-DD', redSign: 'signed_negative', statusLabels: { blue: ['blue'], red: ['red'] }, columns: { number: 'number', date: 'date', sellerKey: 'seller', buyerKey: 'buyer', net: 'net', tax: 'tax', gross: 'gross', status: 'status', originalNumber: 'original', originalSourceVersion: 'version' } });
const bankMap = { format: 'bank-csv-v1', ownerEnterpriseKey: scope.enterpriseKey, bankAccountId: 'bank-A', dateFormat: 'YYYY-MM-DD', amountMode: 'amount_direction', currency: 'CNY', negativeAmount: 'reject', directionLabels: { inflow: ['in'], outflow: ['out'] }, columns: { date: 'date', amount: 'amount', direction: 'direction', refId: 'ref', summary: 'summary' } };
const source = (sourceId, kind, text, mapping) => ({ sourceId, kind, text, mapping, fileSha256: sha(text), scope: clone(scope) });
function invoice(role, patch = {}) {
  const r = { number: role === 'sales' ? '1001' : '2001', date: role === 'sales' ? '2026-03-12' : '2026-03-15', sellerKey: role === 'sales' ? scope.enterpriseKey : 'SUPPLIER-ADMIN', buyerKey: role === 'sales' ? 'CUSTOMER-A' : scope.enterpriseKey, net: role === 'sales' ? '1763.00' : '437.68', tax: role === 'sales' ? '17.63' : '13.13', gross: role === 'sales' ? '1780.63' : '450.81', status: 'blue', originalNumber: '', originalSourceVersion: '', ...patch };
  const m = invoiceMap(role); return source(role, 'invoice_csv', Object.values(m.columns).join(',') + '\n' + Object.keys(m.columns).map(k => r[k]).join(','), m);
}
function basicFacts(patchSale = {}, patchAdmin = {}) {
  const fact = (role, patch) => ({ factId: `basic-${role}`, date: role === 'sales' ? '2026-03-12' : '2026-03-15', nature: 'service', performance: 'completed', settlement: 'unpaid', purpose: 'unknown', benefitPeriod: { state: 'unknown', from: null, to: null }, invoiceRef: { sellerKey: role === 'sales' ? scope.enterpriseKey : 'SUPPLIER-ADMIN', code: '', number: role === 'sales' ? '1001' : '2001' }, ...patch });
  return source('basics', 'business_json', JSON.stringify({ version: 'business-facts/1', scope, facts: [fact('sales', patchSale), fact('purchase', patchAdmin)] }), { format: 'business-facts-json-v1' });
}
const bank = (ref = 'BANK-PREPAY-1', amount = '286.47') => source('bank', 'bank_csv', `date,amount,direction,ref,summary\n2026-03-20,${amount},out,${ref},SENSITIVE银行摘要不作会计依据`, clone(bankMap));
const sources = () => [invoice('sales'), invoice('purchase'), basicFacts(), bank()];
function report(s = sources()) { const r = preflightMaterials({ scope, sources: s }); assert.notEqual(r.status, 'rejected'); return r; }
const evidence = (id, role) => ({ evidenceId: id, kind: 'customer_declaration', scope: clone(scope), confirmedBy: { name: 'SENSITIVE-CONFIRMER', role }, basis: '合成登记与原始业务记录' });
const declaration = () => ({ version: 'offline-declaration/1', scope: clone(scope), profile: 'small-2011', businessScope: 'service-company', evidence: [evidence('owner', 'owner'), evidence('tax', 'accountant')], enterpriseEvidenceIds: ['owner'], bankAccounts: { accountIds: ['bank-A'], evidenceIds: ['owner'] },
  coverage: ['sales', 'purchase', 'bank'].map(kind => ({ kind, accountId: kind === 'bank' ? 'bank-A' : null, from: '2026-01', to: '2026-03', state: 'complete', sourceIds: [kind], evidenceIds: ['owner'] })),
  tax: { vatStatus: 'small_scale', filingFrequency: 'quarterly', evidenceIds: ['tax'] }, applicability: [{ area: 'payroll', present: false, evidenceIds: ['owner'] }, { area: 'assets', present: false, evidenceIds: ['owner'] }], opening: { state: 'new_zero', evidenceIds: ['owner'] }, history: { state: 'first_period', evidenceIds: ['owner'] }, bankFacts: [{ bankAccountId: 'bank-A', refId: 'BANK-PREPAY-1', nature: 'operating_payment', evidenceIds: ['owner'] }] });
const confirmation = () => ({ confirmedBy: { name: 'SENSITIVE-OPERATOR', role: 'business_operator' }, basis: '合成合同、验收和业务登记的核对依据' });
const facts = () => ({ version: 'offline-accounting-facts/1', scope: clone(scope), facts: [
  { factId: 'sale-1', kind: 'service_sale', ...confirmation(), invoiceRef: { sellerKey: scope.enterpriseKey, code: '', number: '1001' }, contractId: 'CONTRACT-SALE', serviceStartDate: '2026-03-01', completionDate: '2026-03-12', collectionRightDate: '2026-03-12', mainService: true, ordinaryService: true },
  { factId: 'admin-1', kind: 'administrative_service', ...confirmation(), invoiceRef: { sellerKey: 'SUPPLIER-ADMIN', code: '', number: '2001' }, contractId: 'CONTRACT-ADMIN', completionDate: '2026-03-15', purpose: 'organizational_administration', nonAsset: true, nonProjectCost: true, benefitFrom: '2026-03-01', benefitTo: '2026-03-31', benefitBasis: '本月行政人员日常服务，3月全部消耗' },
  { factId: 'prepay-1', kind: 'service_prepayment', ...confirmation(), bankRef: { bankAccountId: 'bank-A', refId: 'BANK-PREPAY-1' }, contractId: 'CONTRACT-FUTURE', supplierKey: 'SUPPLIER-FUTURE', serviceStartDate: '2026-04-01', serviceEndDate: '2026-06-30', ordinaryService: true, performanceThroughPeriodEnd: 'not_started', refundThroughPeriodEnd: 'none', paymentCount: 1, otherRecognitionInProvidedMaterials: 'none', relatedInvoiceRefs: [] },
] });
const wrap = f => { const text = JSON.stringify(f); return { text, fileSha256: sha(text) }; };
const input = (s = sources(), f = facts(), d = declaration()) => ({ scope: clone(scope), reports: [report(s)], declaration: d, profileId: 'small-2011-basic-v1', accountingFacts: wrap(f) });
const candidate = (p, kind) => p.candidates.find(c => c.kind === kind);
const decision = (p, kind) => p.decisions.find(c => c.kind === kind);
const run = (f = facts(), s = sources(), d = declaration()) => buildOfflineCandidates(input(s, f, d));
const independentCents = value => { const [w, f] = value.split('.'); return BigInt(w) * 100n + BigInt(f); };

test('three actual candidates have independently specified amounts, profile roles and balance', () => {
  const p = run(); assert.equal(p.candidates.length, 3);
  const expected = {
    service_sale: [['1122', '1780.63', '0.00'], ['5001', '0.00', '1763.00'], ['2221', '0.00', '17.63']],
    administrative_service: [['5602', '450.81', '0.00'], ['2202', '0.00', '450.81']],
    service_prepayment: [['1123', '286.47', '0.00'], ['1002', '0.00', '286.47']],
  };
  let debits = 0n, credits = 0n;
  for (const [kind, lines] of Object.entries(expected)) {
    const c = candidate(p, kind); assert.deepEqual(c.entries.map(e => [e.accountCode, e.debit, e.credit]), lines);
    const dr = c.entries.reduce((sum, e) => sum + independentCents(e.debit), 0n), cr = c.entries.reduce((sum, e) => sum + independentCents(e.credit), 0n); assert.equal(dr, cr); debits += dr; credits += cr;
    assert.equal(c.authorizesExecution, false); assert.equal(c.recognition.existingLedgerVerified, false); assert.equal(c.rule.accountingApproval, 'pending');
  }
  assert.equal(debits, 251791n); assert.equal(credits, 251791n);
  assert.equal(candidate(p, 'service_sale').entries[2].detail, '应交增值税');
  assert.equal(candidate(p, 'service_sale').recognition.vatTriggerDate, '2026-03-12');
  assert.equal(candidate(p, 'service_prepayment').recognition.expenseRecognition, 'none_period_end_prepayment_asset');
  assert.equal(p.plan.tasks.find(t => t.taskId === 'post').implementationStatus, 'not_implemented'); assert.equal(p.authorizesExecution, false);
});
test('administrative service invoice earlier in the same month recognizes on actual completion date', () => {
  const f = facts(); f.facts[1].completionDate = '2026-03-20';
  const p = run(f, [invoice('sales'), invoice('purchase', { date: '2026-03-10' }), basicFacts({}, { date: '2026-03-20' }), bank()]);
  assert.equal(p.candidates.length, 3); const c = candidate(p, 'administrative_service');
  assert.equal(c.date, '2026-03-20'); assert.notEqual(c.date, '2026-03-10');
  assert.deepEqual(c.entries.map(e => [e.accountCode, e.debit, e.credit]), [['5602', '450.81', '0.00'], ['2202', '0.00', '450.81']]);
  assert.equal(c.recognition.dateSource.field, 'completionDate');
  assert.equal(c.recognition.dateSource.references[0].pointer, '/facts/1/completionDate');
  assert.equal(c.recognition.dateSource.references[0].fileSha256, sha(wrap(f).text));
  assert.equal(candidate(p, 'service_sale').date, '2026-03-12'); assert.equal(candidate(p, 'service_prepayment').date, '2026-03-20');
  assert.ok(!decision(p, 'administrative_service').requirements.some(r => r.code === 'unsupported_rule_date'));
});
test('independent engineering trial arithmetic is not runtime ledger input', () => {
  const p = run(), sums = new Map([['1002', 100000n], ['3001', -100000n]]);
  for (const c of p.candidates) for (const e of c.entries) sums.set(e.accountCode, (sums.get(e.accountCode) ?? 0n) + independentCents(e.debit) - independentCents(e.credit));
  assert.equal(sums.get('1002'), 71353n); assert.equal([...sums.values()].filter(n => n > 0n).reduce((a, b) => a + b, 0n), 323144n); assert.equal([...sums.values()].reduce((a, b) => a + b, 0n), 0n);
  assert.ok(!('openingLedger' in p));
});
test('every entry traces actual amount fields, business JSON pointer/hash, declaration and rule', () => {
  const x = input(), p = buildOfflineCandidates(x);
  for (const c of p.candidates) for (const e of c.entries) {
    assert.ok(e.ruleId && e.ruleSources.length && e.factSources.length);
    for (const ref of e.sourceFields) { const raw = p.sources.materials.find(s => s.sourceId === ref.sourceId); assert.equal(ref.fileSha256, sha(raw.rawContent)); assert.ok(ref.location.column > 0); assert.equal(ref.sourceVersion, raw.sourceVersion); }
    for (const ref of e.factSources) { assert.equal(ref.fileSha256, sha(x.accountingFacts.text)); assert.match(ref.pointer, /^\/facts\/\d+$/); const fact = JSON.parse(x.accountingFacts.text).facts[Number(ref.pointer.split('/').at(-1))]; assert.equal(ref.fields.basis.pointer, ref.pointer + '/basis'); assert.ok(fact.basis); }
    assert.match(e.declaration.digest, /^[a-f0-9]{64}$/);
  }
});
for (const [kind, index, field, reason] of [ ['service_sale', 0, 'collectionRightDate', 'missing_collection_right'], ['service_sale', 0, 'serviceStartDate', 'missing_service_start'], ['administrative_service', 1, 'purpose', 'missing_administrative_use'], ['administrative_service', 1, 'benefitBasis', 'missing_benefit_period'], ['service_prepayment', 2, 'contractId', 'missing_contract'], ['service_prepayment', 2, 'refundThroughPeriodEnd', 'refund_review'] ]) {
  test(`missing ${field} requests specific raw facts and preserves independent candidates`, () => {
    const f = facts(); delete f.facts[index][field]; const p = run(f); assert.equal(candidate(p, kind), undefined); assert.equal(p.candidates.length, 2); assert.ok(decision(p, kind).requirements.some(r => r.code === reason && r.requestedFact.length > 0));
  });
}
test('tax missing blocks only invoice candidates; prepayment needs no unrelated VAT identity', () => {
  const d = declaration(); delete d.tax; const p = run(facts(), sources(), d); assert.deepEqual(p.candidates.map(c => c.kind), ['service_prepayment']);
  assert.ok(decision(p, 'service_sale').requirements.some(r => r.field === 'tax'));
  for (const vatStatus of ['general', 'unknown']) { const d = declaration(); d.tax.vatStatus = vatStatus; const p = run(facts(), sources(), d); assert.deepEqual(p.candidates.map(c => c.kind), ['service_prepayment']); }
});
test('tax must have accountant evidence; owner assertion is not a tax confirmation', () => {
  const d = declaration(); d.tax.evidenceIds = ['owner']; const p = run(facts(), sources(), d); assert.equal(candidate(p, 'service_sale'), undefined); assert.equal(candidate(p, 'administrative_service'), undefined); assert.ok(candidate(p, 'service_prepayment'));
});
test('complete new contract facts resolve only unknown bank nature, never payroll or asset contradictions', () => {
  for (const nature of [null, 'unknown']) { const d = declaration(); if (nature) d.bankFacts[0].nature = nature; else d.bankFacts = []; assert.ok(candidate(run(facts(), sources(), d), 'service_prepayment')); }
  for (const nature of ['payroll', 'asset']) { const d = declaration(); d.bankFacts[0].nature = nature; const p = run(facts(), sources(), d); assert.equal(candidate(p, 'service_prepayment'), undefined); assert.equal(decision(p, 'service_prepayment').status, 'conflict'); }
});
test('new purchase facts resolve actual unknown use, never known contradictory purpose or benefit period', () => {
  for (const purpose of ['asset_related', 'personal', 'inventory_related']) { const p = run(facts(), [invoice('sales'), invoice('purchase'), basicFacts({}, { purpose }), bank()]); assert.equal(candidate(p, 'administrative_service'), undefined); assert.equal(decision(p, 'administrative_service').status, 'conflict'); }
  const p = run(facts(), [invoice('sales'), invoice('purchase'), basicFacts({}, { benefitPeriod: { state: 'known', from: '2026-03-01', to: '2026-04-30' } }), bank()]); assert.equal(decision(p, 'administrative_service').status, 'conflict');
});
test('cross month, partial, nonadministrative and asset/project costs do not produce expense entries', () => {
  for (const patch of [{ benefitTo: '2026-04-01' }, { purpose: 'project' }, { nonAsset: false }, { nonProjectCost: false }]) { const f = facts(); Object.assign(f.facts[1], patch); const p = run(f); assert.equal(candidate(p, 'administrative_service'), undefined); assert.equal(p.candidates.length, 2); }
});
test('service starts outside scope/year or differs from completion/right/invoice needs review', () => {
  for (const patch of [{ serviceStartDate: '2025-12-31' }, { serviceStartDate: '2026-03-13' }, { completionDate: '2026-03-13' }, { collectionRightDate: '2026-03-14' }, { mainService: false }]) { const f = facts(); Object.assign(f.facts[0], patch); assert.equal(candidate(run(f), 'service_sale'), undefined); }
});
test('an explicit scope spanning year-end cannot bypass same-accounting-year service restriction', () => {
  const yearScope = { ...clone(scope), period: { from: '2025-12', to: '2026-03' } }, ss = sources();
  for (const s of ss) { s.scope = clone(yearScope); if (s.kind === 'business_json') { const b = JSON.parse(s.text); b.scope = clone(yearScope); s.text = JSON.stringify(b); s.fileSha256 = sha(s.text); } }
  const f = facts(); f.scope = clone(yearScope); f.facts[0].serviceStartDate = '2025-12-31'; const d = declaration(); d.scope = clone(yearScope); d.evidence.forEach(e => { e.scope = clone(yearScope); }); d.coverage.forEach(c => { c.from = '2025-12'; });
  const p = buildOfflineCandidates({ scope: yearScope, reports: [preflightMaterials({ scope: yearScope, sources: ss })], declaration: d, profileId: 'small-2011-basic-v1', accountingFacts: wrap(f) });
  assert.equal(candidate(p, 'service_sale'), undefined); assert.ok(decision(p, 'service_sale').requirements.some(r => r.code === 'unsupported_service_span')); assert.ok(candidate(p, 'service_prepayment'));
});
test('all three rules enforce 2026 engineering date bounds separately from source legal effective dates', () => {
  const at = day => {
    const year = day.slice(0, 4), month = day.slice(0, 7), ms = { ...clone(scope), period: { from: month, to: month } }, ss = sources();
    for (const s of ss) {
      s.scope = clone(ms);
      if (s.kind === 'business_json') { const b = JSON.parse(s.text); b.scope = clone(ms); b.facts.forEach(f => { f.date = day; }); s.text = JSON.stringify(b); }
      else s.text = s.text.replace(/2026-03-(?:12|15|20)/g, day);
      s.fileSha256 = sha(s.text);
    }
    const f = facts(); f.scope = clone(ms); Object.assign(f.facts[0], { serviceStartDate: day, completionDate: day, collectionRightDate: day }); Object.assign(f.facts[1], { completionDate: day, benefitFrom: day, benefitTo: day });
    const nextYear = Number(year) + 1; f.facts[2].serviceStartDate = `${nextYear}-01-01`; f.facts[2].serviceEndDate = `${nextYear}-01-02`;
    if (day.endsWith('01-01')) { f.facts[2].serviceStartDate = `${year}-02-01`; f.facts[2].serviceEndDate = `${year}-02-02`; }
    const d = declaration(); d.scope = clone(ms); d.evidence.forEach(e => { e.scope = clone(ms); }); d.coverage.forEach(c => { c.from = month; c.to = month; });
    return buildOfflineCandidates({ scope: ms, reports: [preflightMaterials({ scope: ms, sources: ss })], declaration: d, profileId: 'small-2011-basic-v1', accountingFacts: wrap(f) });
  };
  for (const date of ['2010-12-31', '2025-12-31', '2027-01-01']) { const p = at(date); assert.equal(p.candidates.length, 0); for (const kind of ['service_sale', 'administrative_service', 'service_prepayment']) assert.ok(decision(p, kind).requirements.some(r => r.code === 'unsupported_rule_date')); }
  for (const date of ['2026-01-01', '2026-12-31']) { const p = at(date); assert.equal(p.candidates.length, 3); for (const c of p.candidates) { assert.equal(c.rule.productSupportedThrough, '2026-12-31'); assert.equal(c.rule.legalSourceEffective.smallEnterpriseStandard.from, '2013-01-01'); } }
});
test('paid, partial and unknown performance/settlement are never bypassed by completed supplement', () => {
  for (const patch of [{ performance: 'not_completed' }, { performance: 'unknown' }, { settlement: 'received' }, { settlement: 'unknown' }]) { const p = run(facts(), [invoice('sales'), invoice('purchase'), basicFacts(patch), bank()]); assert.equal(candidate(p, 'service_sale'), undefined); }
  for (const patch of [{ settlement: 'paid' }, { nature: 'unknown' }, { performance: 'not_completed' }]) { const p = run(facts(), [invoice('sales'), invoice('purchase'), basicFacts({}, patch), bank()]); assert.equal(candidate(p, 'administrative_service'), undefined); }
});
test('zero tax invoice gets concrete review; no exemption or two-percent income inference', () => {
  const p = run(facts(), [invoice('sales', { tax: '0.00', gross: '1763.00' }), invoice('purchase'), basicFacts(), bank()]); assert.equal(candidate(p, 'service_sale'), undefined); assert.ok(decision(p, 'service_sale').requirements.some(r => r.code === 'zero_tax_or_net_review'));
});
test('raw invoice invalid amounts stay rejected and cannot be replaced by prepared report entries', () => {
  for (const bad of ['1780.64', '1.234', '-1780.63']) {
    const x = input(); x.reports[0].sources[0].rawContent = x.reports[0].sources[0].rawContent.replace('1780.63', bad); x.reports[0].sources[0].fileSha256 = sha(x.reports[0].sources[0].rawContent);
    x.reports[0].records = [{ ready: true, entries: [{ debit: '1780.63' }] }]; x.reports[0].status = 'completed'; const p = buildOfflineCandidates(x); assert.equal(candidate(p, 'service_sale'), undefined); assert.equal(p.candidates.length, 2);
  }
});
test('red invoice has no automatic reversal or initial recognition', () => {
  const sale = invoice('sales', { net: '-1763.00', tax: '-17.63', gross: '-1780.63', status: 'red', originalNumber: '999', originalSourceVersion: 'a'.repeat(64) }); const p = run(facts(), [sale, invoice('purchase'), basicFacts(), bank()]); assert.equal(candidate(p, 'service_sale'), undefined); assert.ok(decision(p, 'service_sale').requirements.some(r => r.code === 'red_invoice_review'));
});
test('future service must be entirely unperformed, not refunded and within twelve months', () => {
  for (const patch of [{ serviceStartDate: '2026-03-31' }, { serviceEndDate: '2027-04-01' }, { performanceThroughPeriodEnd: 'partial' }, { refundThroughPeriodEnd: 'unknown' }, { refundThroughPeriodEnd: 'refunded' }, { paymentCount: 2 }, { otherRecognitionInProvidedMaterials: 'exists' }]) { const f = facts(); Object.assign(f.facts[2], patch); assert.equal(candidate(run(f), 'service_prepayment'), undefined); }
});
test('multiple stable bank payments to same supplier contract are all blocked', () => {
  const b2 = bank('BANK-PREPAY-2', '31.23'); b2.sourceId = 'bank-2'; const x = input([...sources(), b2]), f = facts(); f.facts.push({ ...clone(f.facts[2]), factId: 'prepay-2', bankRef: { bankAccountId: 'bank-A', refId: 'BANK-PREPAY-2' } }); x.accountingFacts = wrap(f);
  const p = buildOfflineCandidates(x); assert.equal(candidate(p, 'service_prepayment'), undefined); const ds = p.decisions.filter(d => d.kind === 'service_prepayment'); assert.equal(new Set(ds.map(d => d.businessKey)).size, 2); assert.ok(ds.every(d => d.status === 'conflict'));
});
test('same contract or explicit invoice/payment relation cannot produce duplicate expense and prepayment', () => {
  for (const explicitRef of [true, false]) { const f = facts(); if (explicitRef) f.facts[2].relatedInvoiceRefs = [clone(f.facts[1].invoiceRef)]; else { f.facts[2].supplierKey = 'SUPPLIER-ADMIN'; f.facts[2].contractId = f.facts[1].contractId; } const p = run(f); assert.equal(candidate(p, 'administrative_service'), undefined); assert.equal(candidate(p, 'service_prepayment'), undefined); assert.equal(decision(p, 'administrative_service').status, 'conflict'); }
});
test('prepayment related invoices must be purchases from that supplier with consistent service purpose and dates', () => {
  const linked = (role = 'purchase', basicPatch = {}) => {
    const f = facts(); f.facts = [f.facts[2]];
    const inv = invoice(role), sellerKey = role === 'purchase' ? 'SUPPLIER-ADMIN' : scope.enterpriseKey;
    f.facts[0].supplierKey = sellerKey; f.facts[0].relatedInvoiceRefs = [{ sellerKey, code: '', number: role === 'purchase' ? '2001' : '1001' }];
    const raw = basicFacts(role === 'sales' ? { performance: 'not_completed', ...basicPatch } : {}, role === 'purchase' ? { performance: 'not_completed', settlement: 'paid', purpose: 'operating_service', ...basicPatch } : {});
    return { f, s: [inv, raw, bank()] };
  };
  const valid = linked(); assert.ok(candidate(run(valid.f, valid.s), 'service_prepayment'));
  const sales = linked('sales'); assert.equal(decision(run(sales.f, sales.s), 'service_prepayment').status, 'conflict');
  const supplier = linked(); supplier.f.facts[0].supplierKey = 'OTHER-SUPPLIER'; assert.equal(decision(run(supplier.f, supplier.s), 'service_prepayment').status, 'conflict');
  for (const patch of [{ nature: 'goods' }, { purpose: 'asset_related' }, { purpose: 'inventory_related' }, { purpose: 'personal' }, { benefitPeriod: { state: 'known', from: '2026-04-01', to: '2026-07-31' } }]) {
    const x = linked('purchase', patch), p = run(x.f, x.s); assert.equal(candidate(p, 'service_prepayment'), undefined); assert.equal(decision(p, 'service_prepayment').status, 'conflict');
  }
  const unknown = linked('purchase', { nature: 'unknown' }); assert.equal(decision(run(unknown.f, unknown.s), 'service_prepayment').status, 'needs_review');
  const consistent = linked('purchase', { benefitPeriod: { state: 'known', from: '2026-04-01', to: '2026-06-30' } }); assert.ok(candidate(run(consistent.f, consistent.s), 'service_prepayment'));
});
test('duplicate reports, duplicate raw materials and repeated fact identity produce one candidate each', () => {
  const x = input(), f = facts(); f.facts.push(clone(f.facts[0])); x.accountingFacts = wrap(f); x.reports.push(clone(x.reports[0])); const p = buildOfflineCandidates(x); assert.equal(p.candidates.length, 3); assert.equal(new Set(p.candidates.map(c => c.businessKey)).size, 3);
});
test('conflicting same invoice/source/fact identity cannot be hidden by independent copy', () => {
  const x = input(), changed = invoice('sales', { net: '1763.01', gross: '1780.64' }), copy = invoice('sales'); copy.sourceId = 'independent'; x.reports.push(report([changed]), report([copy])); assert.equal(candidate(buildOfflineCandidates(x), 'service_sale'), undefined);
  const f = facts(); f.facts.push({ ...clone(f.facts[0]), collectionRightDate: '2026-03-14' }); assert.equal(decision(run(f), 'service_sale').status, 'conflict');
});
test('bank account inventory/no-activity contradiction cannot be bypassed', () => {
  for (const mutate of [d => { d.bankAccounts.accountIds = []; }, d => { d.coverage[2].state = 'no_activity'; }]) { const d = declaration(); mutate(d); const p = run(facts(), sources(), d); assert.equal(candidate(p, 'service_prepayment'), undefined); assert.equal(decision(p, 'service_prepayment').status, 'conflict'); assert.ok(candidate(p, 'service_sale')); }
});
test('cross-enterprise/account/period/currency and invalid schema never yield cross-scope candidates', () => {
  for (const [k, v] of [['enterpriseKey', 'OTHER'], ['accountSetId', 'other'], ['period', '2026-Q2'], ['currency', 'USD']]) {
    const f = facts(); f.scope[k] = v; assert.throws(() => run(f)); const d = declaration(); d.scope[k] = v; assert.equal(run(facts(), sources(), d).candidates.length, 0);
  }
});
test('strict raw-fact schema rejects prepared entries, account codes, ready, completed and final taxes', () => {
  for (const key of ['entries', 'accountCode', 'debit', 'credit', 'ready', 'completed', 'finalTax', 'vatObligationDate']) { const f = facts(); f.facts[0][key] = true; assert.throws(() => run(f)); }
  const x = input(); x.plan = { ready: true }; assert.throws(() => buildOfflineCandidates(x));
  for (const profileId of [undefined, 'enterprise-2019-general-basic-v1', 'legacy']) { const x = input(); x.profileId = profileId; assert.throws(() => buildOfflineCandidates(x)); }
});
test('present invalid invoice or bank references are rejected rather than treated as missing', () => {
  for (const value of [null, false, 0]) for (const [index, field] of [[0, 'invoiceRef'], [2, 'bankRef']]) {
    const f = facts(); f.facts[index][field] = value; assert.throws(() => run(f));
  }
  const f = facts(); delete f.facts[0].invoiceRef; delete f.facts[2].bankRef; const p = run(f); assert.ok(p.decisions.some(d => d.requirements.some(r => r.code === 'referenced_material_missing_or_rejected'))); assert.ok(!candidate(p, 'service_sale')); assert.ok(!candidate(p, 'service_prepayment'));
});
test('replay ignores fabricated ready/completed report fields and changed raw hash fails closed', () => {
  const x = input(), a = buildOfflineCandidates(x); x.reports[0].status = 'completed'; x.reports[0].records = [{ ready: true }]; assert.deepEqual(buildOfflineCandidates(x), a);
  x.reports[0].sources[0].rawContent += '\n'; assert.equal(candidate(buildOfflineCandidates(x), 'service_sale'), undefined);
  const y = input(); y.accountingFacts.text += ' '; assert.throws(() => buildOfflineCandidates(y));
});
test('business key survives amount or rule change; content changes explicitly report newVersion', () => {
  const x = input(), a = buildOfflineCandidates(x); const next = input([invoice('sales', { net: '1763.01', gross: '1780.64' }), invoice('purchase'), basicFacts(), bank()]); next.previousCandidates = a;
  const b = buildOfflineCandidates(next); assert.equal(candidate(a, 'service_sale').businessKey, candidate(b, 'service_sale').businessKey); assert.notEqual(candidate(a, 'service_sale').contentVersion, candidate(b, 'service_sale').contentVersion); assert.equal(b.changes.find(c => c.businessKey === candidate(b, 'service_sale').businessKey).state, 'newVersion');
  const older = clone(a); older.candidates[0].rule.id = 'older-rule/0'; const { contentVersion, ...rest } = older.candidates[0]; older.candidates[0].contentVersion = sha(stable(rest)); const { documentDigest, ...doc } = older; older.documentDigest = sha(stable(doc));
  assert.equal(buildOfflineCandidates({ ...input(), previousCandidates: older }).changes[0].state, 'newVersion');
  const same = buildOfflineCandidates({ ...input(), previousCandidates: a }); assert.ok(same.changes.every(c => c.state === 'unchanged'));
});
test('conflict replacing a former candidate is explicit; no completion/receipt reuse', () => {
  const x = input(), a = buildOfflineCandidates(x); x.reports.push(report([invoice('sales', { net: '1763.01', gross: '1780.64' })])); x.previousCandidates = a;
  const p = buildOfflineCandidates(x); assert.equal(p.changes.find(c => c.businessKey === a.candidates[0].businessKey).state, 'conflict');
  for (const change of [p => { p.status = 'completed'; }, p => { p.executionReceipt = {}; }, p => { p.candidates[0].status = 'completed'; }]) { const old = clone(a); change(old); assert.throws(() => buildOfflineCandidates({ ...input(), previousCandidates: old })); }
});
test('correcting contract or supplier preserves original stable bank business key and reports newVersion', () => {
  const a = run();
  for (const patch of [{ contractId: 'CONTRACT-CORRECTED' }, { supplierKey: 'SUPPLIER-CORRECTED' }]) {
    const f = facts(); Object.assign(f.facts[2], patch); const b = buildOfflineCandidates({ ...input(sources(), f), previousCandidates: a });
    assert.equal(candidate(b, 'service_prepayment').businessKey, candidate(a, 'service_prepayment').businessKey);
    assert.notEqual(candidate(b, 'service_prepayment').contentVersion, candidate(a, 'service_prepayment').contentVersion);
    assert.equal(b.changes.find(c => c.businessKey === candidate(a, 'service_prepayment').businessKey).state, 'newVersion');
    assert.ok(!b.changes.some(c => c.state === 'withdrawn'));
  }
});
test('pure inputs immutable; accessors and cycles rejected without executing getters', () => {
  const x = input(), before = JSON.stringify(x); buildOfflineCandidates(x); assert.equal(JSON.stringify(x), before);
  let calls = 0; const y = input(); Object.defineProperty(y, 'reports', { get() { calls++; return []; }, enumerable: true }); assert.throws(() => buildOfflineCandidates(y)); assert.equal(calls, 0);
  const z = input(); z.self = z; assert.throws(() => buildOfflineCandidates(z));
});
test('changing a returned rule or source cannot poison later candidate rule provenance or digest', () => {
  const first = run(), expected = run(); first.candidates[0].rule.id = 'tampered/1'; first.candidates[0].rule.sources[0].url = 'https://invalid.example'; first.candidates[0].entries[0].ruleSources[0].url = 'https://invalid.example/entry';
  const after = run(); assert.deepEqual(after, expected); assert.notEqual(after.candidates[0].rule.id, first.candidates[0].rule.id); assert.equal(after.documentDigest, expected.documentDigest);
});

const cli = fileURLToPath(new URL('../scripts/offline-bookkeeping.mjs', import.meta.url));
const materialCli = fileURLToPath(new URL('../scripts/offline-materials.mjs', import.meta.url));
function disk(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'offline-bookkeeping-synthetic-'));
  try {
    const save = (name, data) => writeFileSync(join(dir, name), typeof data === 'string' ? data : JSON.stringify(data));
    const ms = sources(), config = { scope, sources: ms.map((s, i) => { const path = `raw-${i}.${s.kind === 'business_json' ? 'json' : 'csv'}`; save(path, s.text); const { text, fileSha256, ...rest } = s; return { ...rest, path }; }) }; save('material-config.json', config);
    const prep = spawnSync(process.execPath, [materialCli, '--config', join(dir, 'material-config.json'), '--output', join(dir, 'report.json')], { encoding: 'utf8', timeout: 15000 }); assert.equal(prep.status, 0); assert.equal(prep.signal, null); assert.equal(prep.stderr, '');
    save('declaration.json', declaration()); save('facts.json', facts()); save('planning.json', { version: 'offline-planning-input/1', scope, reports: ['report.json'], declaration: 'declaration.json' });
    const c = { version: 'offline-bookkeeping-input/1', planningInput: 'planning.json', accountingFacts: 'facts.json', profileId: 'small-2011-basic-v1' }; save('input.json', c);
    const execute = (output = 'candidates.json', args) => {
      const child = spawnSync(process.execPath, [cli, ...(args ?? ['--input', join(dir, 'input.json'), '--output', join(dir, output)])], { encoding: 'utf8', cwd: dir, timeout: 15000 });
      assert.equal(child.error, undefined); assert.equal(child.signal, null); assert.equal(child.stderr, ''); assert.match(child.stdout, /^OFFLINE_BOOKKEEPING_(?:WRITTEN candidates=\d+ review=\d+ conflicts=\d+|INPUT_OR_OUTPUT_REJECTED|USAGE_ERROR)\n$/); assert.doesNotMatch(child.stdout, /SENSITIVE|SYNTHETIC|1763|286|450|银行|\.json|[A-Z]:\\/); return child;
    };
    fn({ dir, save, config: c, execute, read: name => JSON.parse(readFileSync(join(dir, name), 'utf8')) });
  } finally { if (process.env.KEEP_FIXTURES !== '1' && process.env.WORKBENCH_TEST_KEEP_FIXTURES !== '1') rmSync(dir, { recursive: true, force: true }); }
}
test('actual raw CSV/JSON to #78 CLI to bookkeeping CLI generates the three amounts without DB', () => disk(({ dir, execute, read }) => {
  const before = readdirSync(dir); assert.equal(execute().status, 0); const p = read('candidates.json'); assert.equal(p.candidates.length, 3); assert.equal(candidate(p, 'service_sale').entries[0].debit, '1780.63'); assert.equal(candidate(p, 'administrative_service').entries[0].debit, '450.81'); assert.equal(candidate(p, 'service_prepayment').entries[0].debit, '286.47'); assert.deepEqual(readdirSync(dir).filter(n => !before.includes(n)), ['candidates.json']);
  const bytes = readFileSync(join(dir, 'candidates.json')); assert.equal(execute().status, 4); assert.deepEqual(readFileSync(join(dir, 'candidates.json')), bytes);
  const raw = readFileSync(join(dir, 'facts.json')); assert.equal(execute('facts.json').status, 4); assert.deepEqual(readFileSync(join(dir, 'facts.json')), raw);
}));
test('actual CLI missing tax and business facts yields concrete requests, preserves prepay', () => disk(({ save, execute, read }) => {
  const d = declaration(); delete d.tax; save('declaration.json', d); const f = facts(); delete f.facts[0].collectionRightDate; delete f.facts[1].purpose; save('facts.json', f); assert.equal(execute().status, 0); const p = read('candidates.json'); assert.deepEqual(p.candidates.map(c => c.kind), ['service_prepayment']); assert.ok(decision(p, 'service_sale').requirements.some(r => r.field === 'collectionRightDate'));
}));
test('actual CLI BOM hash is actual bytes; relative planning paths and previous compare work', () => disk(({ save, config, execute, read, dir }) => {
  save('facts.json', '\uFEFF' + JSON.stringify(facts())); assert.equal(execute('first.json').status, 0); const a = read('first.json'); assert.equal(a.sources.accountingFacts.fileSha256, sha(readFileSync(join(dir, 'facts.json')))); config.previousCandidates = 'first.json'; save('input.json', config); assert.equal(execute('second.json').status, 0); assert.ok(read('second.json').changes.every(c => c.state === 'unchanged'));
}));
test('actual CLI strict malformed/derived inputs, invalid UTF8 and wrong args have fixed safe errors', () => disk(({ save, execute, dir }) => {
  const f = facts(); f.facts[0].entries = []; save('facts.json', f); assert.equal(execute().status, 4); assert.equal(existsSync(join(dir, 'candidates.json')), false);
  writeFileSync(join(dir, 'facts.json'), Buffer.from([0xff])); assert.equal(execute().status, 4); assert.equal(execute('unused.json', ['--wrong']).status, 2);
}));
test('actual CLI never reads or trusts uploaded previousPlan ready/completed', () => disk(({ save, execute, read }) => {
  save('planning.json', { version: 'offline-planning-input/1', scope, reports: ['report.json'], declaration: 'declaration.json', previousPlan: 'does-not-exist-ready.json' }); assert.equal(execute().status, 0); assert.equal(read('candidates.json').candidates.length, 3); assert.equal(read('candidates.json').plan.tasks.find(t => t.taskId === 'post').implementationStatus, 'not_implemented');
}));
