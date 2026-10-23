import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { hash, stable } from '../server/offline-material-adapters.mjs';
import { openOfflineActionInput } from '../server/offline-action-input.mjs';
import { buildOfflineActionPlan, buildOfflineActionPlanFromFiles } from '../server/offline-action-plan.mjs';
import { initMaterialStore, receiveMaterials } from '../server/offline-material-store.mjs';
import ExcelJS from 'exceljs';

mkdirSync('.agent-runs', { recursive: true });
const root = mkdtempSync(resolve('.agent-runs/action-plan-synthetic-'));
let index = 0;
const scope = { enterpriseKey: 'SYNTHETIC-ACTION', accountSetId: 'action-book', period: '2026-Q1', currency: 'CNY', unit: 'yuan' };
const clone = structuredClone;
const confirm = { confirmedBy: { name: 'PRIVATE-OPERATOR', role: 'business_operator' }, basis: '合成合同验收登记' };
const invMap = role => ({ format: 'invoice-summary-csv-v1', role, dateFormat: 'YYYY-MM-DD', redSign: 'signed_negative', statusLabels: { blue: ['blue'], red: ['red'] }, columns: { number: 'number', date: 'date', sellerKey: 'seller', buyerKey: 'buyer', net: 'net', tax: 'tax', gross: 'gross', status: 'status' } });
const bankMap = { format: 'bank-csv-v1', ownerEnterpriseKey: scope.enterpriseKey, bankAccountId: 'bank-A', dateFormat: 'YYYY-MM-DD', amountMode: 'amount_direction', currency: 'CNY', negativeAmount: 'reject', directionLabels: { inflow: ['in'], outflow: ['out'] }, columns: { date: 'date', amount: 'amount', direction: 'direction', refId: 'ref', summary: 'summary' } };
function fixture() {
  const dir = join(root, `case-${++index}`); mkdirSync(dir);
  const ref = (sellerKey, number) => ({ sellerKey, code: '', number });
  const saleRef = ref(scope.enterpriseKey, '7001'), adminRef = ref('ADMIN-VENDOR', '8001');
  const evidence = (id, role) => ({ evidenceId: id, kind: 'customer_declaration', scope: clone(scope), confirmedBy: { name: 'PRIVATE-DECLARANT', role }, basis: `${id}合成登记依据` });
  const declaration = { version: 'offline-declaration/1', scope: clone(scope), profile: 'small-2011', businessScope: 'service-company', evidence: [evidence('owner', 'owner'), evidence('tax', 'accountant')], enterpriseEvidenceIds: ['owner'], bankAccounts: { accountIds: ['bank-A'], evidenceIds: ['owner'] },
    coverage: ['sales', 'purchase', 'bank'].map(kind => ({ kind, accountId: kind === 'bank' ? 'bank-A' : null, from: '2026-01', to: '2026-03', state: 'complete', sourceIds: [kind], evidenceIds: ['owner'] })), tax: { vatStatus: 'small_scale', filingFrequency: 'quarterly', evidenceIds: ['tax'] }, applicability: ['payroll', 'assets'].map(area => ({ area, present: false, evidenceIds: ['owner'] })), opening: { state: 'new_zero', evidenceIds: ['owner'] }, history: { state: 'first_period', evidenceIds: ['owner'] }, bankFacts: [] };
  const facts = { version: 'offline-accounting-facts/1', scope: clone(scope), facts: [
    { factId: 'sale', kind: 'service_sale', ...clone(confirm), invoiceRef: saleRef, contractId: 'SALE-CONTRACT', serviceStartDate: '2026-03-01', completionDate: '2026-03-12', collectionRightDate: '2026-03-12', mainService: true, ordinaryService: true },
    { factId: 'admin', kind: 'administrative_service', ...clone(confirm), invoiceRef: adminRef, contractId: 'ADMIN-CONTRACT', completionDate: '2026-03-15', purpose: 'organizational_administration', nonAsset: true, nonProjectCost: true, benefitFrom: '2026-03-01', benefitTo: '2026-03-31', benefitBasis: '全部在3月组织行政日常受益' },
    { factId: 'prepay', kind: 'service_prepayment', ...clone(confirm), bankRef: { bankAccountId: 'bank-A', refId: 'PAY-1' }, contractId: 'FUTURE-CONTRACT', supplierKey: 'FUTURE-VENDOR', serviceStartDate: '2026-04-01', serviceEndDate: '2026-06-30', ordinaryService: true, performanceThroughPeriodEnd: 'not_started', refundThroughPeriodEnd: 'none', paymentCount: 1, otherRecognitionInProvidedMaterials: 'none', relatedInvoiceRefs: [] },
  ] };
  const basic = { version: 'business-facts/1', scope: clone(scope), facts: [saleRef, adminRef].map((invoiceRef, i) => ({ factId: `basic-${i}`, date: i ? '2026-03-15' : '2026-03-12', nature: 'service', performance: 'completed', settlement: 'unpaid', purpose: 'unknown', benefitPeriod: { state: 'unknown', from: null, to: null }, invoiceRef })) };
  const texts = { sales: 'number,date,seller,buyer,net,tax,gross,status\n7001,2026-03-12,SYNTHETIC-ACTION,CUSTOMER,2917.00,29.17,2946.17,blue', purchase: 'number,date,seller,buyer,net,tax,gross,status\n8001,2026-03-15,ADMIN-VENDOR,SYNTHETIC-ACTION,573.00,17.19,590.19,blue', bank: 'date,amount,direction,ref,summary\n2026-03-20,337.83,out,PAY-1,PRIVATE-SUMMARY' };
  const materials = { scope: clone(scope), sources: [ ['sales', 'invoice_csv', invMap('sales')], ['purchase', 'invoice_csv', invMap('purchase')], ['bank', 'bank_csv', bankMap], ['basic', 'business_json', { format: 'business-facts-json-v1' }] ].map(([sourceId, kind, mapping]) => ({ sourceId, kind, scope: clone(scope), path: `${sourceId}.${kind === 'business_json' ? 'json' : 'csv'}`, mapping: clone(mapping) })) };
  const config = { version: 'offline-action-input/1', scope: clone(scope), profileId: 'small-2011-basic-v1', declaration: 'declaration.json', accountingFacts: 'facts.json', materialsInput: 'materials.json' };
  const save = () => { for (const [id, text] of Object.entries(texts)) writeFileSync(join(dir, `${id}.csv`), text); for (const [name, value] of Object.entries({ basic, facts, declaration, materials, config })) writeFileSync(join(dir, `${name}.json`), JSON.stringify(value)); };
  save();
  const plan = async previous => { save(); if (previous) { writeFileSync(join(dir, 'previous.json'), JSON.stringify(previous)); config.previousPlan = 'previous.json'; save(); } const session = await openOfflineActionInput(join(dir, 'config.json')); try { return await buildOfflineActionPlanFromFiles(session); } finally { session.close(); } };
  return { dir, declaration, facts, basic, texts, materials, config, save, plan, saleRef, adminRef };
}
const task = (p, kind) => p.tasks.find(t => t.kind === kind);
const transactionIds = p => p.tasks.filter(t => t.operation === 'prepare_candidate').map(t => t.taskId);
const unchangedOther = (p, previous, kind) => {
  for (const t of previous.tasks.filter(t => t.kind && t.kind !== kind)) { assert.equal(p.tasks.find(x => x.taskId === t.taskId).dependencyDigest, t.dependencyDigest); assert.ok(p.changes.unchanged.includes(t.taskId)); }
};

test('actual independent amounts generate three candidates; old provided use/nature requests disappear', async () => {
  const f = fixture(), p = await f.plan(); assert.equal(p.candidates.length, 3); assert.equal(p.customerRequest.requests.length, 0);
  assert.deepEqual(task(p, 'service_sale').candidate.entries.map(e => [e.accountCode, e.debit, e.credit]), [['1122', '2946.17', '0.00'], ['5001', '0.00', '2917.00'], ['2221', '0.00', '29.17']]);
  assert.deepEqual(task(p, 'administrative_service').candidate.entries.map(e => [e.accountCode, e.debit, e.credit]), [['5602', '590.19', '0.00'], ['2202', '0.00', '590.19']]);
  assert.deepEqual(task(p, 'service_prepayment').candidate.entries.map(e => [e.accountCode, e.debit, e.credit]), [['1123', '337.83', '0.00'], ['1002', '0.00', '337.83']]);
  assert.equal(p.authorizesExecution, false); assert.equal(p.periodComplete, false); assert.equal(p.authenticity, 'unverified');
  for (const t of p.tasks) { assert.equal(t.completed, false); assert.equal(t.authorizesExecution, false); assert.equal(t.periodComplete, false); }
  for (const id of ['post', 'close', 'compute_tax', 'review', 'period']) assert.equal(p.tasks.find(t => t.taskId === id).status, 'blocked_not_implemented');
  assert.ok(task(p, 'administrative_service').trace.accountingFacts[0].source.fields.benefitBasis.pointer);
});
for (const [kind, i, field, chinese] of [['administrative_service', 1, 'benefitBasis', '仅当月受益的业务依据'], ['service_prepayment', 2, 'refundThroughPeriodEnd', '截至期末是否退款']]) test(`remove/re-add ${field} requests only actual missing fact and reopens local descendants`, async () => {
  const f = fixture(), full = await f.plan(), saved = f.facts.facts[i][field]; delete f.facts.facts[i][field]; const missing = await f.plan(full);
  assert.equal(missing.candidates.length, 2); assert.equal(task(missing, kind).status, 'missing'); assert.match(missing.customerRequest.forwardableText, new RegExp(chinese)); assert.ok(!missing.customerRequest.forwardableText.includes('实际用途、服务对象（办公日常或具体项目）'));
  assert.equal(missing.customerRequest.requests.length, 1); assert.equal(missing.customerRequest.requests[0].affectedTaskIds.filter(id => id === task(missing, kind).taskId).length, 1);
  unchangedOther(missing, full, kind); assert.ok(missing.changes.invalidated.includes(task(full, kind).taskId)); assert.ok(missing.changes.invalidated.includes('post'));
  f.facts.facts[i][field] = saved; const restored = await f.plan(missing); assert.equal(restored.candidates.length, 3); assert.equal(restored.customerRequest.requests.length, 0); unchangedOther(restored, missing, kind);
});
test('same facts JSON one change and row reorder keep independent semantic digests stable while full trace updates', async () => {
  const f = fixture(), a = await f.plan(); f.facts.facts[1].benefitBasis = '更正的3月完整受益核对依据'; const b = await f.plan(a); unchangedOther(b, a, 'administrative_service'); assert.notEqual(b.planVersion, a.planVersion);
  f.facts.facts.reverse(); const c = await f.plan(b); for (const id of transactionIds(b)) assert.ok(c.changes.unchanged.includes(id));
  assert.notEqual(c.planVersion, b.planVersion); assert.notEqual(task(c, 'service_sale').candidate.contentVersion, task(b, 'service_sale').candidate.contentVersion);
});
test('same invoice CSV changed invoice invalidates only its business; reordered rows preserve both', async () => {
  const f = fixture(); f.texts.sales += '\n7002,2026-03-12,SYNTHETIC-ACTION,CUSTOMER,400.00,4.00,404.00,blue';
  f.basic.facts.push({ ...clone(f.basic.facts[0]), factId: 'basic-2', invoiceRef: { ...f.saleRef, number: '7002' } }); f.facts.facts.push({ ...clone(f.facts.facts[0]), factId: 'sale-2', contractId: 'SALE-CONTRACT-2', invoiceRef: { ...f.saleRef, number: '7002' } });
  const a = await f.plan(); assert.equal(a.candidates.length, 4); f.texts.sales = f.texts.sales.replace('400.00,4.00,404.00', '500.00,5.00,505.00'); const b = await f.plan(a);
  for (const t of a.tasks.filter(t => t.kind && !t.subject.includes('7002'))) assert.ok(b.changes.unchanged.includes(t.taskId));
  const lines = f.texts.sales.split('\n'); f.texts.sales = [lines[0], lines[2], lines[1]].join('\n'); const c = await f.plan(b); for (const id of transactionIds(b)) assert.ok(c.changes.unchanged.includes(id));
});
test('new and removed stable invoice identities produce added/removed while existing business digests persist', async () => {
  const f = fixture(), a = await f.plan(); f.texts.sales += '\n7002,2026-03-12,SYNTHETIC-ACTION,CUSTOMER,400.00,4.00,404.00,blue';
  f.basic.facts.push({ ...clone(f.basic.facts[0]), factId: 'basic-2', invoiceRef: { ...f.saleRef, number: '7002' } }); f.facts.facts.push({ ...clone(f.facts.facts[0]), factId: 'sale-2', contractId: 'SALE-CONTRACT-2', invoiceRef: { ...f.saleRef, number: '7002' } });
  const b = await f.plan(a); const added = b.tasks.find(t => t.subject?.includes('7002')); assert.deepEqual(b.changes.added, [added.taskId]); for (const id of transactionIds(a)) assert.ok(b.changes.unchanged.includes(id));
  f.texts.sales = f.texts.sales.split('\n').slice(0, 2).join('\n'); f.basic.facts.pop(); f.facts.facts.pop(); const c = await f.plan(b); assert.deepEqual(c.changes.removed, [added.taskId]); for (const id of transactionIds(a)) assert.ok(c.changes.unchanged.includes(id));
});
test('actual XLSX file reads keep binary SHA, sheet/cell trace and private file inventory', async () => {
  const f = fixture(), book = new ExcelJS.Workbook(), sheet = book.addWorksheet('原始发票'); sheet.addRow(Object.values(invMap('sales').columns)); sheet.addRow(['7001', '2026-03-12', scope.enterpriseKey, 'CUSTOMER', '2917.00', '29.17', '2946.17', 'blue']);
  const bytes = Buffer.from(await book.xlsx.writeBuffer()); writeFileSync(join(f.dir, 'sales.xlsx'), bytes); const s = f.materials.sources[0]; s.kind = 'invoice_xlsx'; s.path = 'sales.xlsx'; s.mapping = { ...s.mapping, format: 'invoice-summary-xlsx-v1', sheet: '原始发票', headerRow: 1 }; f.save();
  const session = await openOfflineActionInput(join(f.dir, 'config.json'));
  try {
    session.inventory.splice(0); const p = await buildOfflineActionPlanFromFiles(session); assert.equal(p.candidates.length, 3); assert.equal(p.provenance.mode, 'explicit_local_files_revalidated_at_call');
    const trace = task(p, 'service_sale').trace.materials.find(r => r.kind === 'invoice'); assert.equal(trace.fileSha256, hash(bytes)); assert.equal(trace.location.fields.net.cell, 'E2'); assert.equal(trace.location.sheet, '原始发票');
    const file = p.provenance.fileEvidence.origins.find(x => x.sourceId === 'sales'); assert.equal(file.path, join(f.dir, 'sales.xlsx')); assert.equal(file.fileSha256, hash(bytes)); assert.ok(p.provenance.fileEvidence.files.some(x => x.path === join(f.dir, 'config.json')));
    assert.equal(buildOfflineActionPlan(clone(session.rawInput)).provenance.mode, 'supplied_bytes_replayed_not_live_files');
    const roundtrip = JSON.parse(JSON.stringify(p)); session.close(); const next = await f.plan(roundtrip); assert.ok(next.changes.unchanged.includes(task(p, 'service_sale').taskId));
  } finally { session.close(); }
});
test('related original service facts and referenced declaration evidence affect only related transactions', async () => {
  const f = fixture(), a = await f.plan(); f.basic.facts[1].purpose = 'asset_related'; const b = await f.plan(a); unchangedOther(b, a, 'administrative_service'); assert.equal(task(b, 'administrative_service').status, 'conflict');
  f.basic.facts[1].purpose = 'unknown'; f.declaration.evidence.push({ ...clone(f.declaration.evidence[0]), evidenceId: 'unused', basis: '仅登记无引用依据' }); const c = await f.plan(a); for (const id of transactionIds(a)) assert.ok(c.changes.unchanged.includes(id));
  f.declaration.evidence.find(e => e.evidenceId === 'tax').basis = '更新税务身份登记依据'; const d = await f.plan(c); assert.ok(d.changes.unchanged.includes(task(c, 'service_prepayment').taskId)); assert.ok(d.changes.invalidated.includes(task(c, 'service_sale').taskId));
});
test('missing tax attributes blocks invoice branches only; coverage/history/opening remain independent gates', async () => {
  const f = fixture(), a = await f.plan(); delete f.declaration.tax; delete f.declaration.coverage; delete f.declaration.history; delete f.declaration.opening; const b = await f.plan(a);
  assert.deepEqual(b.candidates.map(c => c.kind), ['service_prepayment']); assert.ok(b.changes.unchanged.includes(task(a, 'service_prepayment').taskId)); assert.ok(b.matrix.some(r => r.id.startsWith('coverage:') && r.status === 'missing')); assert.ok(b.customerRequest.requests.some(r => r.requestId === 'history'));
  f.declaration.tax = { vatStatus: 'small_scale', filingFrequency: 'quarterly', evidenceIds: ['tax'] }; assert.equal((await f.plan()).candidates.length, 3);
});
test('shared missing or unknown VAT identity is requested once with all affected invoice tasks', async () => {
  for (const mode of ['missing', 'unknown']) {
    const f = fixture(); if (mode === 'missing') delete f.declaration.tax; else f.declaration.tax.vatStatus = 'unknown'; const p = await f.plan(); assert.deepEqual(p.candidates.map(c => c.kind), ['service_prepayment']);
    assert.equal(p.customerRequest.requests.length, 1); const r = p.customerRequest.requests[0]; assert.equal(r.requestId, 'tax'); assert.ok(r.reasonCodes.includes('small_scale_required')); for (const kind of ['service_sale', 'administrative_service']) assert.ok(r.affectedTaskIds.includes(task(p, kind).taskId)); assert.ok(!r.affectedTaskIds.includes(task(p, 'service_prepayment').taskId)); assert.doesNotMatch(p.customerRequest.forwardableText, /确认本期小规模身份/);
  }
  const f = fixture(); f.declaration.tax.vatStatus = 'general'; const p = await f.plan(); assert.equal(task(p, 'service_sale').status, 'unsupported'); assert.equal(task(p, 'administrative_service').status, 'unsupported'); assert.match(p.customerRequest.forwardableText, /一般纳税人身份不适用/);
});
test('missing profile/declaration/facts produce useful requests without defaults or candidates', async () => {
  const f = fixture(); delete f.config.profileId; f.config.declaration = null; f.config.accountingFacts = null; const p = await f.plan(); assert.equal(p.candidates.length, 0); assert.ok(p.customerRequest.requests.some(r => r.requestId === 'profile')); assert.ok(p.customerRequest.requests.some(r => r.requestId === 'enterprise')); assert.ok(p.tasks.some(t => t.operation === 'prepare_candidate'));
});
test('shared missing profile creates one actual scheme request, not repeated per business', async () => {
  const f = fixture(); f.config.profileId = null; const p = await f.plan(); assert.equal(p.candidates.length, 0); assert.equal(p.customerRequest.requests.length, 1); const r = p.customerRequest.requests[0]; assert.equal(r.requestId, 'profile'); for (const id of transactionIds(p)) assert.ok(r.affectedTaskIds.includes(id));
});
test('ready tasks have no blocked parents; independent context checks do not depend on missing enterprise scheme', async () => {
  for (const mode of ['full', 'missing-profile', 'missing-tax', 'missing-enterprise', 'missing-history']) {
    const f = fixture(); if (mode === 'missing-profile') delete f.config.profileId; if (mode === 'missing-tax') delete f.declaration.tax; if (mode === 'missing-enterprise') delete f.declaration.businessScope; if (mode === 'missing-history') delete f.declaration.history; const p = await f.plan();
    for (const t of p.tasks.filter(t => t.status === 'candidate_preparation_ready')) { assert.deepEqual(t.blockedByTasks, []); for (const id of t.deps) assert.ok(['candidate_preparation_ready', 'not_applicable'].includes(p.tasks.find(x => x.taskId === id).status)); }
    if (mode === 'missing-profile') { assert.deepEqual(p.tasks.find(t => t.taskId === 'tax').deps, []); assert.deepEqual(p.tasks.find(t => t.taskId === 'bank-accounts').deps, []); assert.equal(p.customerRequest.requests.length, 1); }
  }
});
test('known false/known non-supported values are unsupported; unknown stays unknown and never asks changing true', async () => {
  const f = fixture(); f.facts.facts[1].nonAsset = false; f.facts.facts[2].ordinaryService = false; const p = await f.plan(); assert.equal(task(p, 'administrative_service').status, 'unsupported'); assert.equal(task(p, 'service_prepayment').status, 'unsupported'); assert.match(p.customerRequest.forwardableText, /请保留实际业务事实/);
  f.facts.facts[2].ordinaryService = true; f.facts.facts[2].refundThroughPeriodEnd = 'unknown'; assert.equal(task(await f.plan(), 'service_prepayment').status, 'unknown');
});
test('same-contract second payment blocks prepayment and preserves independent transactions', async () => {
  const f = fixture(), a = await f.plan(); f.texts.bank += '\n2026-03-21,41.29,out,PAY-2,SECOND'; f.facts.facts.push({ ...clone(f.facts.facts[2]), factId: 'prepay-2', bankRef: { bankAccountId: 'bank-A', refId: 'PAY-2' } }); const b = await f.plan(a); unchangedOther(b, a, 'service_prepayment'); assert.equal(b.candidates.length, 2); assert.equal(b.tasks.filter(t => t.kind === 'service_prepayment' && t.status === 'conflict').length, 2);
});
test('reverse related invoice conflict propagates to both sides while sale stays unchanged', async () => {
  const f = fixture(), a = await f.plan(); f.facts.facts[2].relatedInvoiceRefs = [clone(f.adminRef)]; const b = await f.plan(a); assert.ok(b.changes.unchanged.includes(task(a, 'service_sale').taskId)); assert.equal(b.candidates.length, 1); assert.equal(task(b, 'related_purchase_evidence').status, 'conflict'); assert.equal(task(b, 'service_prepayment').status, 'conflict');
});
test('a supported not-completed associated purchase is evidence rather than another administrative fee request', async () => {
  const f = fixture(); f.texts.purchase = f.texts.purchase.replace('ADMIN-VENDOR', 'FUTURE-VENDOR'); f.basic.facts[1].invoiceRef.sellerKey = 'FUTURE-VENDOR'; f.basic.facts[1].performance = 'not_completed'; f.facts.facts.splice(1, 1); f.facts.facts[1].relatedInvoiceRefs = [{ sellerKey: 'FUTURE-VENDOR', code: '', number: '8001' }]; const p = await f.plan();
  assert.equal(p.candidates.length, 2); assert.equal(task(p, 'related_purchase_evidence').candidate, null); assert.equal(task(p, 'related_purchase_evidence').status, 'candidate_preparation_ready'); assert.equal(p.customerRequest.requests.length, 0);
});
test('related future-service invoice missing refund fact asks payment fact once, never administrative completion', async () => {
  const f = fixture(); f.texts.purchase = f.texts.purchase.replace('ADMIN-VENDOR', 'FUTURE-VENDOR'); f.basic.facts[1].invoiceRef.sellerKey = 'FUTURE-VENDOR'; f.basic.facts[1].performance = 'not_completed'; f.facts.facts.splice(1, 1); f.facts.facts[1].relatedInvoiceRefs = [{ sellerKey: 'FUTURE-VENDOR', code: '', number: '8001' }]; delete f.facts.facts[1].refundThroughPeriodEnd;
  const p = await f.plan(); assert.equal(p.candidates.length, 1); assert.equal(task(p, 'related_purchase_evidence').status, 'missing'); assert.equal(p.customerRequest.requests.length, 1); assert.match(p.customerRequest.forwardableText, /截至期末是否退款/); assert.doesNotMatch(p.customerRequest.forwardableText, /实际完成日|行政日常用途|对应发票的原始服务日期/);
  const r = p.customerRequest.requests[0]; assert.ok(r.affectedTaskIds.includes(task(p, 'related_purchase_evidence').taskId)); assert.ok(r.affectedTaskIds.includes(task(p, 'service_prepayment').taskId));
});
test('known payroll/asset bank facts block only related prepayment; account/no-activity contradictions propagate', async () => {
  for (const nature of ['payroll', 'asset']) { const f = fixture(), a = await f.plan(); f.declaration.bankFacts = [{ bankAccountId: 'bank-A', refId: 'PAY-1', nature, evidenceIds: ['owner'] }]; const b = await f.plan(a); unchangedOther(b, a, 'service_prepayment'); assert.equal(task(b, 'service_prepayment').status, 'conflict'); }
  for (const mode of ['account', 'no_activity']) { const f = fixture(); if (mode === 'account') f.declaration.bankAccounts.accountIds = []; else f.declaration.coverage[2].state = 'no_activity'; const p = await f.plan(); assert.equal(task(p, 'service_prepayment').status, 'conflict'); }
});
test('same factId conflicting assignment propagates to affected branches only', async () => {
  const f = fixture(), a = await f.plan(); f.facts.facts[1].factId = f.facts.facts[0].factId; const b = await f.plan(a); assert.equal(b.candidates.length, 1); assert.equal(task(b, 'service_sale').status, 'conflict'); assert.equal(task(b, 'administrative_service').status, 'conflict'); assert.ok(b.changes.unchanged.includes(task(a, 'service_prepayment').taskId));
});
test('one invalid original/mapping/source scope preserves other independent sources and records diagnostics', async () => {
  for (const mode of ['amount', 'mapping', 'scope', 'read']) {
    const f = fixture(); if (mode === 'amount') f.texts.sales = f.texts.sales.replace('2946.17', '2946.18'); if (mode === 'mapping') f.materials.sources[0].mapping.columns.net = 'absent'; if (mode === 'scope') f.materials.sources[0].scope.enterpriseKey = 'OTHER'; if (mode === 'read') f.materials.sources[0].path = 'missing.csv'; const p = await f.plan(); assert.equal(p.candidates.length, 2); assert.ok(p.diagnostics.some(d => d.sourceId === 'sales')); assert.ok(p.tasks.some(t => t.kind === 'service_sale' && t.status !== 'candidate_preparation_ready'));
  }
});
test('invalid accounting facts cannot retain old ready or remove actual materials from the plan', async () => {
  const f = fixture(), a = await f.plan(); f.facts.scope.enterpriseKey = 'OTHER'; const b = await f.plan(a); assert.equal(b.candidates.length, 0); assert.ok(b.diagnostics.some(d => d.reason === 'accounting_facts_invalid')); assert.equal(b.tasks.filter(t => t.operation === 'prepare_candidate').length, 3);
});
test('file private guards reject changed payload and originals even when public assertCurrent is replaced', async () => {
  const f = fixture(); let s = await openOfflineActionInput(join(f.dir, 'config.json'));
  try { s.assertCurrent = async () => {}; s.inventory.splice(0); s.rawInput.reports[0].sources[0].rawContent += '\n'; s.rawInput.reports[0].sources[0].fileSha256 = hash(s.rawInput.reports[0].sources[0].rawContent); assert.throws(() => buildOfflineActionPlan(s.rawInput), /action_payload_changed/); await assert.rejects(buildOfflineActionPlanFromFiles(s), /action_payload_changed/); } finally { s.close(); }
  s = await openOfflineActionInput(join(f.dir, 'config.json')); try { s.assertCurrent = async () => {}; writeFileSync(join(f.dir, 'sales.csv'), f.texts.sales + '\n'); await assert.rejects(buildOfflineActionPlanFromFiles(s), /action_input_changed/); } finally { s.close(); }
});
test('public session payload replacement with cloned or cross-enterprise raw input is rejected', async () => {
  for (const changeScope of [false, true]) {
    const f = fixture(), s = await openOfflineActionInput(join(f.dir, 'config.json'));
    try { s.rawInput = clone(s.rawInput); if (changeScope) s.rawInput.scope.enterpriseKey = 'FORGED-ENTERPRISE'; s.assertCurrent = async () => {}; await assert.rejects(buildOfflineActionPlanFromFiles(s), /action_session_untrusted/); } finally { s.close(); }
  }
});
test('alternating public rawInput getter cannot replace the payload between private guards', async () => {
  const f = fixture(), s = await openOfflineActionInput(join(f.dir, 'config.json')), original = s.rawInput, forged = clone(original); forged.scope.enterpriseKey = 'GETTER-FORGED'; let reads = 0;
  try { Object.defineProperty(s, 'rawInput', { configurable: true, get() { return ++reads % 2 ? original : forged; } }); await assert.rejects(buildOfflineActionPlanFromFiles(s), /action_session_untrusted/); assert.equal(reads, 0); } finally { s.close(); }
});
test('negative file observations reject new missing declaration/source or repaired rejected read until new session', async () => {
  for (const which of ['declaration', 'source', 'invalid-json']) {
    const f = fixture();
    if (which === 'declaration') f.config.declaration = 'new-declaration.json';
    if (which === 'source') f.materials.sources[0].path = 'new-sales.csv';
    f.save(); if (which === 'invalid-json') writeFileSync(join(f.dir, 'declaration.json'), '{');
    const s = await openOfflineActionInput(join(f.dir, 'config.json'));
    try {
      const before = await buildOfflineActionPlanFromFiles(s); assert.ok(before.customerRequest.requests.length);
      writeFileSync(join(f.dir, which === 'declaration' ? 'new-declaration.json' : which === 'source' ? 'new-sales.csv' : 'declaration.json'), which === 'source' ? f.texts.sales : JSON.stringify(f.declaration));
      await assert.rejects(buildOfflineActionPlanFromFiles(s), /action_input_changed/);
    } finally { s.close(); }
    const reopened = await openOfflineActionInput(join(f.dir, 'config.json')); try { assert.equal((await buildOfflineActionPlanFromFiles(reopened)).candidates.length, 3); } finally { reopened.close(); }
  }
});
test('initially invalid/missing receipt store becoming valid rejects old file session', async () => {
  const f = fixture(); delete f.config.materialsInput; f.config.materialStore = 'new-receipts'; f.save(); const s = await openOfflineActionInput(join(f.dir, 'config.json'));
  try { assert.ok((await buildOfflineActionPlanFromFiles(s)).diagnostics.some(x => x.reason === 'receipt_store_invalid')); const store = join(f.dir, 'new-receipts'); await initMaterialStore(store, scope); await receiveMaterials(store, join(f.dir, 'materials.json')); await assert.rejects(buildOfflineActionPlanFromFiles(s), /action_store_changed/); } finally { s.close(); }
});
test('raw unknown core facts stay unknown, explicit unsupported settlement stays unsupported', async () => {
  for (const field of ['nature', 'performance', 'settlement']) {
    const f = fixture(); f.basic.facts[0][field] = 'unknown'; const p = await f.plan(); assert.equal(task(p, 'service_sale').status, 'unknown'); assert.ok(task(p, 'service_sale').reasons.filter(x => ['planning_unknown', 'complex_performance_or_settlement'].includes(x.code)).every(x => x.classification === 'unknown'));
  }
  const f = fixture(); f.basic.facts[0].settlement = 'received'; assert.equal(task(await f.plan(), 'service_sale').status, 'unsupported');
});
test('related purchase readiness cannot clear known invalid same-source versions or linked bank faults', async () => {
  for (const badSource of ['purchase', 'bank']) {
    const f = fixture(); f.texts.purchase = f.texts.purchase.replace('ADMIN-VENDOR', 'FUTURE-VENDOR'); f.basic.facts[1].invoiceRef.sellerKey = 'FUTURE-VENDOR'; f.basic.facts[1].performance = 'not_completed'; f.facts.facts.splice(1, 1); f.facts.facts[1].relatedInvoiceRefs = [{ sellerKey: 'FUTURE-VENDOR', code: '', number: '8001' }]; const a = await f.plan(); assert.equal(a.candidates.length, 2);
    const entry = clone(f.materials.sources.find(x => x.sourceId === badSource)); entry.path = `${badSource}-invalid.csv`; f.materials.sources.push(entry); f.save(); writeFileSync(join(f.dir, entry.path), badSource === 'purchase' ? f.texts.purchase.replace('590.19', '590.20') : f.texts.bank.replace('337.83', 'invalid'));
    const b = await f.plan(a); assert.deepEqual(b.candidates.map(c => c.kind), ['service_sale']); assert.notEqual(task(b, 'related_purchase_evidence').status, 'candidate_preparation_ready'); assert.equal(task(b, 'service_prepayment').status, 'provided_invalid'); assert.ok(b.changes.unchanged.includes(task(a, 'service_sale').taskId));
    assert.equal(b.customerRequest.requests.length, 1); assert.doesNotMatch(b.customerRequest.forwardableText, /实际完成日|行政日常用途|对应发票的原始服务日期/);
  }
});
test('previous plan statuses and execution receipts cannot authorize current preparation', async () => {
  const f = fixture(), a = await f.plan(); const fake = clone(a); fake.tasks[2].status = 'completed'; fake.authorizesExecution = true;
  await assert.rejects(f.plan(fake), /previous_action_plan_invalid/);
  delete f.config.previousPlan; const missing = clone(a); missing.executionReceipt = { success: true }; await assert.rejects(f.plan(missing), /previous_action_plan_invalid/);
});
test('actual receipt store stale branch survives as invalid diagnostic task and valid sources stay usable', async () => {
  const f = fixture(), store = join(f.dir, 'receipts'); await initMaterialStore(store, scope); await receiveMaterials(store, join(f.dir, 'materials.json')); delete f.config.materialsInput; f.config.materialStore = 'receipts'; const a = await f.plan(); assert.equal(a.candidates.length, 3);
  f.texts.sales += '\n'; const b = await f.plan(a); assert.equal(b.candidates.length, 2); assert.ok(b.diagnostics.some(d => d.reason === 'receipt_original_stale')); assert.equal(task(b, 'service_sale').status, 'provided_invalid'); assert.ok(b.changes.unchanged.includes(task(a, 'service_prepayment').taskId));
});
test('locked receipt store never reuses ready; invalid store is useful planning diagnostic', async () => {
  const f = fixture(), store = join(f.dir, 'receipts'); await initMaterialStore(store, scope); await receiveMaterials(store, join(f.dir, 'materials.json')); delete f.config.materialsInput; f.config.materialStore = 'receipts'; const a = await f.plan(); writeFileSync(join(store, 'lock.json'), '{}'); const b = await f.plan(a); assert.equal(b.candidates.length, 0); assert.ok(b.diagnostics.some(d => d.reason === 'receipt_store_locked')); assert.ok(!b.customerRequest.forwardableText.includes('已有锁')); assert.equal(b.customerRequest.requests.length, 0);
  writeFileSync(join(store, 'store.json'), '{}'); const c = await f.plan(); assert.equal(c.candidates.length, 0); assert.ok(c.diagnostics.some(d => d.reason === 'receipt_store_invalid'));
});
test('CLI actual raw files, wx, fixed stdout/stderr, original/old output byte preservation and no DB modules', async () => {
  const f = fixture(), output = join(f.dir, 'new-plan.json'), args = ['scripts/offline-action-plan.mjs', '--input', join(f.dir, 'config.json'), '--output', output];
  let r = spawnSync(process.execPath, args, { encoding: 'utf8' }); assert.equal(r.status, 0, r.stdout + r.stderr); assert.equal(r.signal, null); assert.equal(r.stderr, ''); assert.match(r.stdout, /^OFFLINE_ACTION_PLAN_WRITTEN candidates=3 tasks=\d+ requests=0\r?\n$/); const saved = readFileSync(output); r = spawnSync(process.execPath, args, { encoding: 'utf8' }); assert.equal(r.status, 4); assert.equal(r.stderr, ''); assert.deepEqual(readFileSync(output), saved);
  const original = readFileSync(join(f.dir, 'sales.csv')); args[4] = join(f.dir, 'sales.csv'); r = spawnSync(process.execPath, args, { encoding: 'utf8' }); assert.equal(r.status, 4); assert.deepEqual(readFileSync(join(f.dir, 'sales.csv')), original); assert.equal(r.stderr, '');
  for (const file of ['server/offline-action-input.mjs', 'server/offline-action-plan.mjs', 'scripts/offline-action-plan.mjs']) assert.doesNotMatch(readFileSync(file, 'utf8'), /from ['"].*(?:db\.mjs|offline-ledger|offline-vat-input|accountant-review)/);
  assert.ok(!readdirSync(f.dir).some(name => /\.db(?:-wal|-shm)?$/.test(name))); assert.ok(existsSync(output));
});
