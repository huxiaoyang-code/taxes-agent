import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { preflightMaterials } from '../server/offline-materials.mjs';
import { planOffline } from '../server/offline-task-planner.mjs';
import { validateDeclaration } from '../server/material-completeness.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const clone = structuredClone;
const scope = { enterpriseKey: 'SYNTHETIC-PLAN', accountSetId: 'synthetic-plan-book', period: '2026-Q3', currency: 'CNY', unit: 'yuan' };
const invoiceMap = { format: 'invoice-summary-csv-v1', role: 'sales', dateFormat: 'YYYY-MM-DD', redSign: 'signed_negative', statusLabels: { blue: ['blue'], red: ['red'] }, columns: { number: 'number', date: 'date', sellerKey: 'seller', buyerKey: 'buyer', net: 'net', tax: 'tax', gross: 'gross', status: 'status', originalNumber: 'original', originalSourceVersion: 'version' } };
const bankMap = { format: 'bank-csv-v1', ownerEnterpriseKey: scope.enterpriseKey, bankAccountId: 'bank-A', dateFormat: 'YYYY-MM-DD', amountMode: 'amount_direction', currency: 'CNY', negativeAmount: 'reject', directionLabels: { inflow: ['in'], outflow: ['out'] }, columns: { date: 'date', amount: 'amount', direction: 'direction', summary: 'summary', refId: 'ref' } };
const source = (sourceId, kind, text, mapping) => ({ sourceId, kind, text, mapping: clone(mapping), scope: clone(scope), fileSha256: sha(text) });
const invoice = (patch = {}) => {
  const row = { number: '9001', date: '2026-08-12', sellerKey: scope.enterpriseKey, buyerKey: 'BUYER-PLAN', net: '317.29', tax: '9.52', gross: '326.81', status: 'blue', originalNumber: '', originalSourceVersion: '', ...patch };
  return source('invoice-A', 'invoice_csv', Object.values(invoiceMap.columns).join(',') + '\n' + Object.keys(invoiceMap.columns).map(k => row[k]).join(','), invoiceMap);
};
const fact = (patch = {}) => ({ factId: 'fact-A', date: '2026-08-14', nature: 'service', performance: 'completed', settlement: 'unpaid', purpose: 'unknown', benefitPeriod: { state: 'unknown', from: null, to: null }, invoiceRef: { sellerKey: scope.enterpriseKey, code: '', number: '9001' }, ...patch });
const facts = (values = [fact()]) => source('facts-A', 'business_json', JSON.stringify({ version: 'business-facts/1', scope, facts: values }), { format: 'business-facts-json-v1' });
const bank = (tail = 'bank-001', amount = '83.47', direction = 'out') => source('bank-source', 'bank_csv', `date,amount,direction,summary,ref\n2026-08-15,${amount},${direction},SENSITIVE工资资产,${tail}`, bankMap);
const report = (sources = [invoice(), facts(), bank()]) => {
  const r = preflightMaterials({ scope, sources }); assert.notEqual(r.status, 'rejected'); return r;
};
const evidence = (id, role = 'owner') => ({ evidenceId: id, kind: 'customer_declaration', scope: clone(scope), confirmedBy: { name: 'SYNTHETIC-DECLARER', role }, basis: '本期原始业务登记及负责人确认，仅合成测试' });
const declaration = () => ({ version: 'offline-declaration/1', scope: clone(scope), profile: 'small-2011', businessScope: 'service-company', enterpriseEvidenceIds: ['owner'], evidence: [evidence('owner'), evidence('tax-confirmation', 'accountant')],
  applicability: [{ area: 'payroll', present: false, evidenceIds: ['owner'] }, { area: 'assets', present: false, evidenceIds: ['owner'] }],
  bankAccounts: { accountIds: ['bank-A'], evidenceIds: ['owner'] },
  coverage: [ { kind: 'sales', accountId: null, from: '2026-07', to: '2026-09', state: 'complete', sourceIds: ['invoice-A'], evidenceIds: ['owner'] }, { kind: 'purchase', accountId: null, from: '2026-07', to: '2026-09', state: 'no_activity', sourceIds: [], evidenceIds: ['owner'] }, { kind: 'bank', accountId: 'bank-A', from: '2026-07', to: '2026-09', state: 'complete', sourceIds: ['bank-source'], evidenceIds: ['owner'] } ],
  tax: { vatStatus: 'small_scale', filingFrequency: 'quarterly', evidenceIds: ['tax-confirmation'] }, opening: { state: 'new_zero', evidenceIds: ['owner'] }, history: { state: 'first_period', evidenceIds: ['owner'] },
  bankFacts: [{ bankAccountId: 'bank-A', refId: 'bank-001', nature: 'operating_payment', evidenceIds: ['owner'] }], materials: [] });
const input = (reports = [report()], d = declaration()) => ({ scope: clone(scope), reports, declaration: d });
const row = (p, id) => p.matrix.find(r => r.id === id);
const sale = p => p.tasks.find(t => t.operation === 'prepare_service_sale_materials');
const bankTask = p => p.tasks.find(t => t.operation === 'prepare_bank_activity');
const byTask = (p, id) => p.tasks.find(t => t.taskId === id);
const cli = fileURLToPath(new URL('../scripts/offline-plan.mjs', import.meta.url));
function disk(fn, data = input()) {
  const dir = mkdtempSync(join(tmpdir(), 'offline-plan-synthetic-'));
  try {
    const config = { version: 'offline-planning-input/1', scope: data.scope, reports: data.reports.map((r, i) => { const path = `SENSITIVE-report-${i}.json`; writeFileSync(join(dir, path), JSON.stringify(r)); return path; }), declaration: data.declaration === null ? null : 'SENSITIVE-declaration.json' };
    if (config.declaration) writeFileSync(join(dir, config.declaration), JSON.stringify(data.declaration));
    const configPath = join(dir, 'SENSITIVE-input.json');
    const save = () => writeFileSync(configPath, JSON.stringify(config)); save();
    const run = (output = 'plan.json', args) => {
      const child = spawnSync(process.execPath, [cli, ...(args ?? ['--input', configPath, '--output', join(dir, output)])], { encoding: 'utf8', timeout: 15000, cwd: dir });
      assert.equal(child.error, undefined); assert.equal(child.signal, null); assert.equal(child.stderr, '');
      assert.doesNotMatch(child.stdout, /SENSITIVE|SYNTHETIC|317|83\.47|工资|\.json|[A-Z]:\\/);
      assert.match(child.stdout, /^OFFLINE_PLAN_(?:WRITTEN sources=\d+ records=\d+ ready=\d+ requests=\d+|INPUT_OR_OUTPUT_REJECTED|USAGE_ERROR)\n$/);
      return child;
    };
    fn({ dir, config, configPath, save, run, read: name => JSON.parse(readFileSync(join(dir, name), 'utf8')) });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('independent full service evidence branch ready, final never completed or authorized', () => {
  const p = planOffline(input());
  assert.equal(sale(p).status, 'ready'); assert.equal(sale(p).artifact.kind, 'business_evidence_packet'); assert.equal(sale(p).artifact.produced, false); assert.equal(sale(p).accountingEligibility, 'not_assessed');
  assert.equal(row(p, 'tax').status, 'provided_valid'); assert.equal(row(p, 'opening').status, 'not_applicable'); assert.equal(byTask(p, 'period').status, 'blocked_unknown');
  assert.equal(p.authorizesExecution, false); assert.ok(p.tasks.every(t => t.authorizesExecution === false && t.status !== 'completed' && t.status !== 'ready_for_review'));
  assert.ok(sale(p).inputs.some(r => r.docId)); assert.ok(sale(p).requirements.includes('tax')); assert.ok(sale(p).risks.includes('collection_right_main_or_other_business_and_vat_trigger_not_assessed'));
});
test('only invoices: business facts missing, no file-count completeness shortcut', () => {
  const p = planOffline(input([report([invoice()])], null)); assert.equal(sale(p).status, 'blocked_missing_data');
  assert.ok(p.matrix.some(r => r.id.startsWith('business:') && r.status === 'missing')); assert.equal(row(p, 'enterprise').status, 'missing'); assert.equal(row(p, 'tax').status, 'missing');
});
test('only bank: never infers payroll or assets from summary', () => {
  const d = declaration(); d.bankFacts = []; const p = planOffline(input([report([bank()])], d));
  assert.equal(bankTask(p).status, 'blocked_unknown'); assert.equal(row(p, 'payroll').status, 'not_applicable'); assert.equal(row(p, 'assets').status, 'not_applicable'); assert.equal(sale(p), undefined);
});
test('null declaration generates foundational requests in actual CLI', () => disk(({ run, read }) => {
  assert.equal(run().status, 0); const p = read('plan.json'); assert.equal(row(p, 'enterprise').status, 'missing'); assert.ok(p.customerRequest.requests.some(r => r.requestId === 'tax'));
}, input([report([invoice()])], null)));
test('cross-factId same invoice contradictory performance and date are conflict', () => {
  for (const patch of [{ performance: 'not_completed' }, { settlement: 'received' }, { date: '2026-08-13' }]) {
    const p = planOffline(input([report([invoice(), facts([fact(), fact({ factId: 'fact-B', ...patch })])])]));
    assert.equal(sale(p).status, 'blocked_conflict');
  }
});
test('two stable invoice contents across reports conflict, no overwrite', () => {
  const other = invoice({ net: '317.30', gross: '326.82' }); other.sourceId = 'invoice-B';
  const p = planOffline(input([report([invoice(), facts()]), report([other])])); assert.equal(sale(p).status, 'blocked_conflict');
});
test('received service and incomplete performance require explicit clarification', () => {
  for (const patch of [{ settlement: 'received' }, { performance: 'not_completed' }]) {
    const p = planOffline(input([report([invoice(), facts([fact(patch)])])])); assert.equal(sale(p).status, 'blocked_unknown'); assert.ok(p.customerRequest.requests.some(r => r.requestId.startsWith('business:')));
  }
});
test('purchase operating_service never chooses expense versus direct cost', () => {
  const i = invoice({ sellerKey: 'SELLER-PLAN', buyerKey: scope.enterpriseKey }); i.mapping.role = 'purchase';
  const f = facts([fact({ purpose: 'operating_service', invoiceRef: { sellerKey: 'SELLER-PLAN', code: '', number: '9001' }, benefitPeriod: { state: 'known', from: '2026-08-01', to: '2026-08-31' } })]);
  const d = declaration(); d.coverage[1].state = 'complete'; d.coverage[1].sourceIds = ['invoice-A'];
  const p = planOffline(input([report([i, f])], d)); assert.equal(p.tasks.find(t => t.operation === 'clarify_purchase_use').status, 'blocked_unknown'); assert.match(p.customerRequest.forwardableText, /实际用途、服务对象/);
});
test('raw red reference never proves original invoice or existing posting', () => {
  const i = invoice({ status: 'red', net: '-317.29', tax: '-9.52', gross: '-326.81', originalNumber: '8999', originalSourceVersion: 'f'.repeat(64) });
  const p = planOffline(input([report([i, facts()])])); assert.ok(p.matrix.some(r => r.id.startsWith('red:') && r.status === 'unknown')); assert.equal(sale(p).status, 'blocked_unknown');
});
test('bank missing stable ID and suspected duplicate remain unknown', () => {
  const b = bank(''); b.text += '\n' + b.text.split('\n')[1]; b.fileSha256 = sha(b.text);
  const p = planOffline(input([report([b])])); assert.equal(bankTask(p).status, 'blocked_unknown'); assert.equal(p.matrix.find(r => r.id.startsWith('bank:')).reason, 'bank_stable_id_missing_possible_duplicate');
});
test('declared payroll and asset payments require actual detailed material', () => {
  for (const [nature, area] of [['payroll', 'payroll'], ['asset', 'assets']]) {
    const d = declaration(); d.applicability = d.applicability.filter(a => a.area !== area); d.bankFacts[0].nature = nature;
    const p = planOffline(input(undefined, d)); assert.equal(row(p, area).status, 'missing'); assert.equal(bankTask(p).status, 'blocked_missing_data');
    d.applicability.push({ area, present: false, evidenceIds: ['owner'] }); assert.equal(row(planOffline(input(undefined, d)), area).status, 'conflict');
  }
});
test('absence of opening history tax never defaults to zeros or small scale', () => {
  const d = declaration(); delete d.opening; delete d.history; delete d.tax; const p = planOffline(input(undefined, d));
  for (const id of ['opening', 'history', 'tax']) { assert.equal(row(p, id).status, 'missing'); assert.ok(p.customerRequest.requests.some(r => r.requestId === id)); }
  assert.equal(sale(p).status, 'blocked_missing_data');
});
test('supported no-activity declarations require same scope, role and basis', () => {
  const d = declaration(); assert.equal(row(planOffline(input(undefined, d)), 'payroll').status, 'not_applicable');
  d.applicability[0].evidenceIds = []; assert.equal(row(planOffline(input(undefined, d)), 'payroll').status, 'unknown');
  d.evidence[0].basis = ''; assert.throws(() => validateDeclaration(d, scope)); assert.equal(row(planOffline(input(undefined, d)), 'enterprise').status, 'provided_invalid');
});
test('customer tax assertions cannot become accountant confirmed attributes', () => {
  const d = declaration(); d.tax.evidenceIds = ['owner']; assert.equal(row(planOffline(input(undefined, d)), 'tax').status, 'unknown');
  d.tax.evidenceIds = ['tax-confirmation']; d.evidence[1].kind = 'registration_reference'; assert.equal(row(planOffline(input(undefined, d)), 'tax').status, 'provided_valid');
});
test('unparsed payroll and historical attachments are unsupported, never verified', () => {
  const d = declaration(); d.applicability[0].present = true; d.opening.state = 'balances_required'; d.history.state = 'prior_required';
  d.materials = ['payroll', 'opening', 'history'].map(area => ({ area, format: 'xlsx', evidenceIds: ['owner'] }));
  const p = planOffline(input(undefined, d)); for (const id of ['payroll', 'opening', 'history']) assert.equal(row(p, id).status, 'unsupported'); assert.match(p.declarationProvenance.verification, /unverified/);
});
test('business and accounting profiles outside first package explicitly unsupported', () => {
  for (const [key, value] of [['profile', 'enterprise-2006'], ['businessScope', 'manufacturing']]) { const d = declaration(); d[key] = value; assert.equal(row(planOffline(input(undefined, d)), 'enterprise').status, 'unsupported'); }
});
test('rows cannot stand in for period or account coverage', () => {
  const d = declaration(); d.coverage = []; let p = planOffline(input(undefined, d)); assert.equal(row(p, 'coverage:sales:all').status, 'missing'); assert.equal(sale(p).status, 'ready');
  d.coverage = declaration().coverage; d.coverage[2].sourceIds = ['invoice-A']; p = planOffline(input(undefined, d)); assert.equal(row(p, 'coverage:bank:bank-A').status, 'provided_invalid');
  d.coverage[2] = declaration().coverage[2]; d.coverage[2].to = '2026-08'; assert.equal(row(planOffline(input(undefined, d)), 'coverage:bank:bank-A').status, 'provided_invalid');
});
test('undeclared bank account conflicts with the claimed account inventory', () => {
  const d = declaration(); d.bankAccounts.accountIds = []; assert.equal(row(planOffline(input(undefined, d)), 'coverage:bank:bank-A').status, 'conflict');
});
test('no-activity invoice declaration conflicts with supplied invoice rows', () => {
  const d = declaration(); d.coverage[0].state = 'no_activity'; assert.equal(row(planOffline(input(undefined, d)), 'coverage:sales:all').status, 'conflict');
});
test('damaged source and one-cent imbalance preserve independent bank source', () => {
  const r = report(); r.sources[0].rawContent = r.sources[0].rawContent.replace('326.81', '326.82'); r.sources[0].fileSha256 = sha(r.sources[0].rawContent);
  const p = planOffline(input([r])); assert.equal(p.normalization.sources, 2); assert.equal(bankTask(p).status, 'ready'); assert.ok(p.matrix.some(r => r.status === 'provided_invalid')); assert.equal(sale(p), undefined);
});
test('report statuses records and supplied sourceVersion are never trusted', () => {
  const r = report(); const clean = planOffline(input([r])); r.ok = false; r.status = 'completed'; r.records = [{ status: 'completed', amount: '999.99' }]; r.sources[0].sourceVersion = 'f'.repeat(64);
  assert.deepEqual(planOffline(input([r])), clean);
  r.sources[0].rawContent += '\n'; const p = planOffline(input([r])); assert.ok(p.matrix.some(r => r.status === 'provided_invalid')); assert.equal(sale(p), undefined);
});
test('fabricated report with no raw sources cannot yield ready invoice task', () => {
  const p = planOffline(input([{ version: 'offline-materials/1', scope, ok: true, records: report().records }])); assert.equal(sale(p), undefined); assert.ok(p.matrix.some(r => r.status === 'provided_invalid'));
});
test('cross enterprise account and period source or declaration isolated, never merged', () => {
  for (const [key, value] of [['enterpriseKey', 'OTHER-OWNER'], ['accountSetId', 'other-book'], ['period', '2026-Q2'], ['currency', 'USD']]) {
    const r = report(); r.sources[0].scope[key] = value; const p = planOffline(input([r])); assert.equal(sale(p), undefined); assert.ok(p.matrix.some(r => r.status === 'provided_invalid'));
    const d = declaration(); d.scope[key] = value; assert.equal(row(planOffline(input(undefined, d)), 'enterprise').status, 'provided_invalid');
  }
});
test('unknown keys, completed claims and invalid fact references cannot smuggle authorization', () => {
  const x = input(); x.completed = true; assert.throws(() => planOffline(x));
  const d = declaration(); d.executionReceipt = {}; assert.equal(row(planOffline(input(undefined, d)), 'enterprise').status, 'provided_invalid');
  const y = input(); y.declaration.tax.evidenceIds = ['nonexistent']; assert.equal(row(planOffline(y), 'enterprise').status, 'provided_invalid');
});
test('repeated reports produce no duplicate requests or tasks and no accounting writes', () => {
  const r = report(); const a = planOffline(input([r])), b = planOffline(input([r, clone(r)])); assert.deepEqual(a, b);
  assert.equal(new Set(b.customerRequest.requests.map(r => r.requestId)).size, b.customerRequest.requests.length); assert.equal(new Set(b.tasks.map(t => t.taskId)).size, b.tasks.length);
});
test('provided evidence not requested again, shared missing tax request merges task impacts', () => {
  let p = planOffline(input()); assert.equal(p.customerRequest.requests.length, 0);
  const d = declaration(); delete d.tax; p = planOffline(input(undefined, d)); const requests = p.customerRequest.requests.filter(r => r.requestId === 'tax'); assert.equal(requests.length, 1); assert.ok(requests[0].affectedTaskIds.includes(sale(p).taskId)); assert.ok(requests[0].affectedTaskIds.includes('tax')); assert.ok(requests[0].affectedTaskIds.includes('period'));
});
test('supplement actually unblocks sale while unchanged independent bank retains identity digest', () => {
  const before = planOffline(input([report([invoice(), bank()])])); const after = planOffline({ ...input(), previousPlan: before });
  assert.equal(sale(before).status, 'blocked_missing_data'); assert.equal(sale(after).status, 'ready'); assert.equal(sale(before).taskId, sale(after).taskId);
  assert.equal(bankTask(before).inputDigest, bankTask(after).inputDigest); assert.ok(after.changes.invalidated.some(t => t.taskId === sale(after).taskId)); assert.ok(after.changes.invalidated.some(t => t.taskId === 'period')); assert.ok(after.changes.unchanged.some(t => t.taskId === bankTask(after).taskId));
});
test('source version change invalidates only affected source tasks and downstream period', () => {
  const a = planOffline(input()); const b = planOffline({ ...input([report([invoice(), facts(), bank('bank-001', '83.48')])]), previousPlan: a });
  assert.equal(sale(a).inputDigest, sale(b).inputDigest); assert.equal(bankTask(a).taskId, bankTask(b).taskId); assert.notEqual(bankTask(a).inputDigest, bankTask(b).inputDigest); assert.notEqual(byTask(a, 'period').inputDigest, byTask(b, 'period').inputDigest);
});
test('tax declaration and scoped rule updates invalidate affected successors only', () => {
  const a = planOffline(input()); const d = declaration(); d.tax.filingFrequency = 'monthly'; const b = planOffline({ ...input(undefined, d), previousPlan: a });
  assert.notEqual(sale(a).inputDigest, sale(b).inputDigest); assert.equal(bankTask(a).inputDigest, bankTask(b).inputDigest);
  const c = planOffline({ ...input(), previousPlan: a }, { ruleVersions: { sales: '2' } }); assert.notEqual(sale(a).inputDigest, sale(c).inputDigest); assert.equal(bankTask(a).inputDigest, bankTask(c).inputDigest);
});
test('added and removed record task identities reported explicitly', () => {
  const a = planOffline(input()); const b = planOffline({ ...input([report([bank()])]), previousPlan: a }); assert.ok(b.changes.removed.some(t => t.taskId === sale(a).taskId));
  const c = planOffline({ ...input(), previousPlan: b }); assert.ok(c.changes.added.some(t => t.taskId === sale(a).taskId));
});
test('previous completed status, receipt or mismatching digest rejected, no completion reuse', () => {
  for (const mutate of [p => { p.tasks[0].status = 'completed'; }, p => { p.executionReceipt = {}; }, p => { p.tasks[0].inputDigest = 'a'.repeat(64); }]) { const p = planOffline(input()); mutate(p); assert.throws(() => planOffline({ ...input(), previousPlan: p })); }
  const a = planOffline(input()); const b = planOffline({ ...input(), previousPlan: a }); assert.equal(b.changes.invalidated.length, 0); assert.equal(b.changes.unchanged.length, b.tasks.length); assert.equal(byTask(b, 'period').status, 'blocked_unknown');
});
test('actual CLI writes explicit new output safely with local request text', () => disk(({ run, read, dir }) => {
  assert.equal(run().status, 0); const p = read('plan.json'); assert.equal(sale(p).status, 'ready'); assert.match(p.customerRequest.forwardableText, /不需要先制作会计分录/); assert.equal(p.customerRequest.delivery, 'local_only_not_sent');
  const before = readFileSync(join(dir, 'plan.json')); assert.equal(run().status, 4); assert.deepEqual(readFileSync(join(dir, 'plan.json')), before);
  const original = readFileSync(join(dir, 'SENSITIVE-report-0.json')); assert.equal(run('SENSITIVE-report-0.json').status, 4); assert.deepEqual(readFileSync(join(dir, 'SENSITIVE-report-0.json')), original);
}));
test('actual CLI damaged report file preserves independent report and declaration', () => disk(({ config, save, run, read, dir }) => {
  writeFileSync(join(dir, 'damaged.json'), '{bad'); config.reports.push('damaged.json'); save(); assert.equal(run().status, 0); const p = read('plan.json'); assert.equal(sale(p).status, 'ready'); assert.ok(p.matrix.some(r => r.status === 'provided_invalid'));
}));
test('actual CLI supplement and repeat comparison use newly written snapshot only', () => disk(({ config, save, run, read, dir }) => {
  const initial = report([invoice(), bank()]); writeFileSync(join(dir, config.reports[0]), JSON.stringify(initial)); assert.equal(run('first.json').status, 0); assert.equal(sale(read('first.json')).status, 'blocked_missing_data');
  writeFileSync(join(dir, 'supplement.json'), JSON.stringify(report([facts()]))); config.reports.push('supplement.json'); config.previousPlan = 'first.json'; save(); assert.equal(run('second.json').status, 0); assert.equal(sale(read('second.json')).status, 'ready');
  config.previousPlan = 'second.json'; save(); assert.equal(run('third.json').status, 0); const p = read('third.json'); assert.equal(p.changes.invalidated.length, 0); assert.equal(p.changes.added.length, 0);
}));
test('actual CLI rejects bogus previous completed plan and unexpected command args', () => disk(({ config, save, run, dir }) => {
  const p = planOffline(input()); p.tasks[0].status = 'completed'; writeFileSync(join(dir, 'forged.json'), JSON.stringify(p)); config.previousPlan = 'forged.json'; save(); assert.equal(run().status, 4); assert.equal(existsSync(join(dir, 'plan.json')), false); assert.equal(run('none.json', ['--wrong']).status, 2);
}));
test('pure input is immutable and no accessors or cycles execute', () => {
  const x = input(), before = JSON.stringify(x); planOffline(x); assert.equal(JSON.stringify(x), before);
  let calls = 0; const a = input(); Object.defineProperty(a, 'reports', { get() { calls++; return []; }, enumerable: true }); assert.throws(() => planOffline(a)); assert.equal(calls, 0);
  const b = input(); b.self = b; assert.throws(() => planOffline(b));
});

test('account inventory contradiction blocks that bank branch without blocking independent sale', () => {
  const before = planOffline(input()), d = declaration(); d.bankAccounts.accountIds = [];
  const p = planOffline({ ...input(undefined, d), previousPlan: before });
  assert.equal(bankTask(p).status, 'blocked_conflict'); assert.equal(sale(p).status, 'ready');
  assert.notEqual(bankTask(p).inputDigest, bankTask(before).inputDigest); assert.equal(sale(p).inputDigest, sale(before).inputDigest);
  assert.match(p.customerRequest.forwardableText, /银行账户bank-A、流水bank-001/); assert.match(p.customerRequest.forwardableText, /未列入全部银行账户清单/);
});

test('explicit no-activity contradictions block only corresponding invoice or bank preparation', () => {
  for (const index of [0, 2]) {
    const d = declaration(); d.coverage[index].state = 'no_activity'; const p = planOffline(input(undefined, d));
    assert.equal(index === 0 ? sale(p).status : bankTask(p).status, 'blocked_conflict');
    assert.equal(index === 0 ? bankTask(p).status : sale(p).status, 'ready');
  }
  const i = invoice({ sellerKey: 'SELLER-PLAN', buyerKey: scope.enterpriseKey }); i.mapping.role = 'purchase';
  const p = planOffline(input([report([i])])); assert.equal(p.tasks.find(t => t.operation === 'clarify_purchase_use').status, 'blocked_conflict');
  const d = declaration(); d.coverage.forEach(c => { c.state = 'partial'; });
  const partial = planOffline(input(undefined, d)); assert.equal(sale(partial).status, 'ready'); assert.equal(bankTask(partial).status, 'ready');
});

test('conflicting source versions cannot be hidden by an independent copy of one invoice', () => {
  const changed = invoice({ net: '317.30', gross: '326.82' }), independent = invoice(); independent.sourceId = 'independent-same-invoice';
  const p = planOffline(input([report(), report([changed]), report([independent])]));
  assert.equal(sale(p).status, 'blocked_conflict'); assert.equal(bankTask(p).status, 'ready');
  const changedFact = facts([fact({ factId: 'fact-different', performance: 'not_completed' })]);
  const q = planOffline(input([report(), report([changedFact])])); assert.equal(sale(q).status, 'blocked_conflict'); assert.equal(bankTask(q).status, 'ready');
});

test('all conflicting bank versions affect digest while unrelated account stays unchanged', () => {
  const other = bank('bank-001', '83.48'); other.sourceId = 'bank-B';
  const independent = bank('independent-1', '51.23'); independent.sourceId = 'independent-bank'; independent.mapping.bankAccountId = 'bank-independent';
  const d = declaration(); d.bankAccounts.accountIds.push('bank-independent'); d.bankFacts.push({ bankAccountId: 'bank-independent', refId: 'independent-1', nature: 'operating_payment', evidenceIds: ['owner'] });
  const p = planOffline(input([report([invoice(), facts(), bank(), other, independent])], d));
  const q = planOffline({ ...input([report([invoice(), facts(), bank('bank-001', '83.49'), other, independent])], d), previousPlan: p });
  const taskFor = (p, marker) => p.tasks.find(t => t.operation === 'prepare_bank_activity' && t.inputs.some(i => i.sourceId === marker));
  assert.equal(taskFor(p, 'bank-source').status, 'blocked_conflict'); assert.equal(taskFor(q, 'bank-source').status, 'blocked_conflict');
  assert.notEqual(taskFor(p, 'bank-source').inputDigest, taskFor(q, 'bank-source').inputDigest);
  assert.equal(taskFor(p, 'independent-bank').inputDigest, taskFor(q, 'independent-bank').inputDigest); assert.equal(sale(p).inputDigest, sale(q).inputDigest);
  assert.ok(q.changes.invalidated.some(t => t.taskId === taskFor(q, 'bank-source').taskId));
});

test('forwardable text names concrete gaps and Chinese task goals without machine reasons or hashes', () => {
  const d = declaration(); d.tax.filingFrequency = 'unknown';
  const p = planOffline(input([report([invoice(), bank()])], d));
  const business = p.customerRequest.requests.find(r => r.requestId.startsWith('business:'));
  assert.match(business.missingFactOrMaterial, /发票9001/); assert.ok(business.reason); assert.match(business.reasonText, /实际业务日期/);
  assert.ok(business.acceptedMaterials.length && business.alternativeEvidence.length); assert.ok(business.affectedTasks.some(t => t.goal === sale(p).goal));
  const tax = p.customerRequest.requests.find(r => r.requestId === 'tax'); assert.deepEqual(tax.requestedFields, ['申报周期']);
  assert.match(p.customerRequest.forwardableText, /登记替代依据/); assert.match(p.customerRequest.forwardableText, /整理已履约未结算服务销售资料包/);
  for (const r of p.customerRequest.requests) assert.ok(!p.customerRequest.forwardableText.includes(r.reason));
  assert.doesNotMatch(p.customerRequest.forwardableText, /[a-f0-9]{64}/);
});

test('post close tax computation and review are separate unimplemented dependent stages', () => {
  const p = planOffline(input());
  for (const id of ['post', 'close', 'compute_tax', 'review']) { const t = byTask(p, id); assert.equal(t.implementationStatus, 'not_implemented'); assert.equal(t.status, 'blocked_unknown'); assert.equal(t.artifact.produced, false); assert.equal(t.authorizesExecution, false); assert.ok(t.missing.some(m => m.requirementId === `implementation:${id}`)); }
  assert.ok(byTask(p, 'close').deps.includes('post')); assert.ok(byTask(p, 'compute_tax').deps.includes('post')); assert.deepEqual(byTask(p, 'review').deps, ['close', 'compute_tax']); assert.ok(byTask(p, 'period').deps.includes('review'));
});

test('independent nonzero amount evidence remains a preparation packet only', () => {
  const r = report([invoice({ net: '1234.57', tax: '37.04', gross: '1271.61' }), facts()]);
  assert.equal(r.records.find(r => r.kind === 'invoice').data.gross, '1271.61');
  const p = planOffline(input([r])); assert.equal(sale(p).status, 'ready'); assert.equal(sale(p).accountingEligibility, 'not_assessed'); assert.equal(byTask(p, 'post').implementationStatus, 'not_implemented');
});

test('no-activity evidence version changes invalidate corresponding branch only', () => {
  for (const index of [0, 2]) {
    const d = declaration(); d.coverage[index].state = 'no_activity';
    d.evidence.push(evidence('coverage-owner')); d.coverage[index].evidenceIds = ['coverage-owner'];
    const p = planOffline(input(undefined, d)); d.evidence.at(-1).basis = '更新后的本期无业务声明依据，仍待核对矛盾';
    const q = planOffline({ ...input(undefined, d), previousPlan: p });
    assert.notEqual((index === 0 ? sale(p) : bankTask(p)).inputDigest, (index === 0 ? sale(q) : bankTask(q)).inputDigest);
    assert.equal((index === 0 ? bankTask(p) : sale(p)).inputDigest, (index === 0 ? bankTask(q) : sale(q)).inputDigest);
  }
});

test('actual CLI retains independent work while inventory and source-version conflicts block affected tasks', () => {
  const d = declaration(); d.bankAccounts.accountIds = [];
  disk(({ run, read }) => { assert.equal(run().status, 0); const p = read('plan.json'); assert.equal(bankTask(p).status, 'blocked_conflict'); assert.equal(sale(p).status, 'ready'); }, input(undefined, d));
  const changed = invoice({ net: '317.30', gross: '326.82' }), independent = invoice(); independent.sourceId = 'independent-invoice';
  disk(({ run, read }) => { assert.equal(run().status, 0); const p = read('plan.json'); assert.equal(sale(p).status, 'blocked_conflict'); assert.equal(bankTask(p).status, 'ready'); assert.ok(byTask(p, 'post').blockedByTasks.some(t => t.taskId === sale(p).taskId)); }, input([report(), report([changed]), report([independent])]));
});
