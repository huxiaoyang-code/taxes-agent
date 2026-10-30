// 原始执行绝不读取预期结果，也不在 03B 之外创建分录。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, cpSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { DatabaseSync } from 'node:sqlite';

export const json = p => JSON.parse(readFileSync(p, 'utf8'));
export const writeJson = (p, x) => writeFileSync(p, JSON.stringify(x, null, 2) + '\n');
export const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export const minor = x => { assert.match(x, /^\d+\.\d{2}$/); return BigInt(x.replace('.', '')); };
const money = x => { assert.equal(typeof x, 'number'); assert.ok(Number.isFinite(x)); const text = x.toFixed(2); assert.equal(Number(text), x, 'actual money must already have exact cent precision'); return text; };
export const row = (p, n, period = 'current') => p.cells.find(c => c.row === n && c.column === 'services' && c.period === period);
export function inspect(dbPath, work) { const db = new DatabaseSync(dbPath, { readOnly: true }); try { return work(db); } finally { db.close(); } }
export const databaseState = dbPath => inspect(dbPath, db => db.prepare("SELECT name,type,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all().map(s => ({ ...s, rows: s.type === 'table' ? db.prepare('SELECT * FROM "' + s.name + '"').all() : [] })));

function observeProductProcesses() {
  const sync = childProcess.spawnSync, asyncSpawn = childProcess.spawn, records = [];
  childProcess.spawnSync = (...args) => { const r = sync(...args); records.push({ kind: 'sync', status: r.status, signal: r.signal, error: r.error?.code ?? null }); return r; };
  childProcess.spawn = (...args) => {
    const c = asyncSpawn(...args), r = { kind: 'async', exitObserved: false, closeObserved: false }; records.push(r);
    c.once('exit', (status, signal) => Object.assign(r, { exitObserved: true, status, signal }));
    c.once('close', () => { r.closeObserved = true; }); return c;
  };
  syncBuiltinESMExports();
  return { records, close() { childProcess.spawnSync = sync; childProcess.spawn = asyncSpawn; syncBuiltinESMExports(); } };
}

function assertExited(records, syncCount) {
  assert.equal(records.filter(r => r.kind === 'sync').length, syncCount);
  assert.equal(records.filter(r => r.kind === 'async').length, 1);
  for (const r of records) { assert.equal(r.status, 0); assert.equal(r.signal, null); if (r.kind === 'async') { assert.equal(r.exitObserved, true); assert.equal(r.closeObserved, true); } else assert.equal(r.error, null); }
}

export function child(mode, directory, rawDirectory) {
  const c = spawnSync(process.execPath, [fileURLToPath(import.meta.url), mode, resolve(directory), ...(rawDirectory ? [resolve(rawDirectory)] : [])], {
    encoding: 'utf8', timeout: 120000, windowsHide: true, maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, NODE_NO_WARNINGS: '1', WORKBENCH_DATA_DIR: join(resolve(directory), 'forbidden-default'), TEMP: resolve(directory), TMP: resolve(directory) }
  });
  assert.equal(c.status, 0, c.stderr + c.stdout); assert.equal(c.signal, null); assert.equal(c.stderr, '');
  return { ...JSON.parse(c.stdout), actualProcessExit: c.status };
}

export async function plansFor(directory) {
  const { openOfflineActionInput } = await import('../../server/offline-action-input.mjs');
  const { buildOfflineActionPlanFromFiles } = await import('../../server/offline-action-plan.mjs');
  const result = [];
  for (const q of ['q1', 'q2']) {
    const actionPath = join(directory, 'raw', q, 'action.json'), s = await openOfflineActionInput(actionPath);
    try { result.push({ q, actionPath, plan: await buildOfflineActionPlanFromFiles(s), records: s.rawInput.reports.flatMap(r => r.records) }); }
    finally { s.close(); }
  }
  return result;
}

async function executeRaw(directory, rawDirectory) {
  mkdirSync(directory, { recursive: true }); cpSync(rawDirectory, join(directory, 'raw'), { recursive: true });
  // 在加载任何核心/默认数据库模块之前设置隔离。
  process.env.WORKBENCH_DATA_DIR = join(directory, 'data'); process.env.TEMP = directory; process.env.TMP = directory;
  mkdirSync(process.env.WORKBENCH_DATA_DIR);
  const { db } = await import('../../server/db.mjs');
  const A = await import('../../server/accounting.mjs');
  let result, source;
  const processes = observeProductProcesses();
  try {
    const config = json(join(directory, 'raw/q1/action.json'));
    const initialCount = db.prepare('SELECT COUNT(*) n FROM vouchers').get().n; assert.equal(initialCount, 0);
    const set = A.createAccountSet({ name: config.scope.enterpriseKey, start_period: '2026-01', profileId: config.profileId, enterprise: { enterpriseKey: config.scope.enterpriseKey } });
    assert.equal(String(set.id), config.scope.accountSetId);
    for (const p of ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06']) A.ensurePeriod(set.id, p);
    const initialTrial = A.trialBalance(set.id, '2026-01');
    const instanceId = db.prepare('SELECT instance_id FROM audit_database_instances WHERE is_active=1').get().instance_id;
    const dbPath = join(directory, 'data/workbench.db'), target = { dbPath, databaseInstanceId: instanceId, accountSetId: set.id, enterpriseKey: config.scope.enterpriseKey };
    const { runOfflinePosting } = await import('../../server/offline-posting.mjs');
    const plans = await plansFor(directory), requests = [], postings = [];
    for (const p of plans) {
      const tasks = p.plan.tasks.filter(t => t.operation === 'prepare_candidate' && t.kind === 'service_sale');
      assert.equal(tasks.length, 3, JSON.stringify(p.plan));
      for (const t of tasks) {
        const request = { version: 'offline-posting-input/1', command: 'prepare', inputPath: p.actionPath, target, selected: { taskId: t.taskId, businessKey: t.businessKey } };
        const prepared = runOfflinePosting(request); assert.equal(prepared.status, 'prepared', JSON.stringify(prepared));
        const execution = { ...request, command: 'execute', confirmation: { operationId: prepared.operationId, dependencyDigest: prepared.dependencyDigest, policyDigest: prepared.policyDigest, confirmNewSourceBinding: true } };
        const applied = runOfflinePosting(execution); assert.equal(applied.status, 'applied', JSON.stringify(applied));
        requests.push(execution); postings.push({ prepared, applied });
      }
    }
    const trials = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06'].map(p => A.trialBalance(set.id, p));
    const { openReadonlyLedgerSource, captureLedgerSnapshot } = await import('../../server/offline-ledger-snapshot.mjs');
    source = openReadonlyLedgerSource(dbPath);
    const snapshot = captureLedgerSnapshot(source, { enterpriseKey: target.enterpriseKey, accountSetId: set.id, fromPeriod: '2026-01', toPeriod: '2026-06' });
    source.close(); source = undefined;
    const request = { version: 'offline-vat-q2-request/1', priorInputPath: join(directory, 'raw/q1/input.json'), targetInputPath: join(directory, 'raw/q2/input.json'), target };
    writeJson(join(directory, 'runtime.json'), { request, requests });
    const { runOfflineVatQ2 } = await import('../../server/offline-vat-q2.mjs');
    const before = databaseState(dbPath), d = await runOfflineVatQ2(request);
    assert.deepEqual(databaseState(dbPath), before, 'read-only VAT must not change any schema/table');
    assertExited(processes.records, 12);
    result = { request, requests, initialCount, initialTrial, plans, postings, trials, snapshot, diagnostic: d, productProcesses: processes.records, readOnlySchemaAndTablesUnchanged: true };
  } finally { source?.close(); db.close(); processes.close(); }
  return { ...result, defaultDatabaseActuallyClosed: true, actionSessionsActuallyClosed: true, ledgerSourceActuallyClosed: true };
}

export function assertQuarterlyOutput(actual, expected, rawDirectory) {
  assert.equal(expected.accountantApproval, 'pending'); assert.equal(expected.sourceAuthenticity, 'synthetic');
  assert.equal(actual.actualProcessExit, 0); assert.equal(actual.defaultDatabaseActuallyClosed, true); assert.equal(actual.ledgerSourceActuallyClosed, true); assert.equal(actual.actionSessionsActuallyClosed, true);
  for (const r of expected.sourceRefs) assert.equal(sha(readFileSync(join(rawDirectory, r.path))), r.sha256, r.path);
  assert.equal(actual.initialCount, 0);
  for (const v of Object.values(actual.initialTrial.totals)) if (typeof v === 'number') assert.equal(v, 0);
  const baselineCodes = actual.initialTrial.lines.map(l => l.code).sort();
  assert.ok(baselineCodes.every(code => typeof code === 'string' && code.length));
  assert.equal(new Set(baselineCodes).size, baselineCodes.length);
  for (const code of ['1122', '5001', '2221']) assert.ok(baselineCodes.includes(code));
  for (const line of actual.initialTrial.lines) for (const kind of ['opening', 'period', 'closing']) for (const side of ['debit', 'credit']) assert.equal(money(line[kind + '_' + side]), '0.00');
  const candidates = actual.plans.flatMap(p => p.plan.tasks.filter(t => t.operation === 'prepare_candidate').map(t => t.candidate));
  assert.equal(actual.trials.length, 6); assert.equal(new Set(actual.trials.map(t => t.period)).size, 6);
  assert.deepEqual(actual.trials.map(t => t.period), expected.movements.map(m => m.period));
  assert.equal(candidates.length, expected.wholeCase.vouchers); assert.equal(actual.snapshot.vouchers.length, 6);
  assert.equal(actual.snapshot.vouchers.reduce((n, v) => n + v.entries.length, 0), 18);
  assert.equal(actual.snapshot.counts.draft, 0); assert.ok(actual.snapshot.sources.checks.every(c => c.status === 'matches_persisted_content'));
  assert.equal(actual.snapshot.periods.length, 6); assert.ok(actual.snapshot.periods.every(p => p.status === 'open'));
  assert.equal(actual.snapshot.sources.batches.length, 6);
  for (const m of expected.movements) {
    const p = actual.plans.find(p => p.q === (m.period <= '2026-03' ? 'q1' : 'q2'));
    const record = p.records.find(r => r.data?.number === m.invoiceNumber); assert.ok(record, m.invoiceNumber);
    assert.deepEqual({ sellerKey: record.data.sellerKey, code: record.data.code, number: record.data.number }, m.identity);
    const c = candidates.find(c => c.date === m.date); assert.ok(c);
    assert.equal(c.rule.id, m.expectedRuleId);
    assert.deepEqual(c.entries.map(e => ({ accountCode: e.accountCode, debit: e.debit, credit: e.credit })), m.expectedEntries);
    assert.equal(m.expectedEntries.reduce((n, e) => n + minor(e.debit) - minor(e.credit), 0n), 0n);
    const ref = c.evidence.materials.find(r => r.docId === record.docId && r.sourceId === 'sales'); assert.ok(ref);
    assert.equal(ref.fileSha256, m.sourceRef.sha256);
    // 冻结的定位信息是物理 CSV 行/XLSX 行（表头为第 1 行）。
    // CSV 适配器的 row 是从 1 开始的数据记录序号；line 表示物理行。
    assert.equal(ref.location.row, m.sourceRef.sheet ? m.sourceRef.row : m.sourceRef.row - 1);
    if (m.sourceRef.sheet) assert.equal(ref.location.sheet, m.sourceRef.sheet); else assert.equal(ref.location.line, m.sourceRef.line);
    assert.ok(c.evidence.businessFacts.some(f => f.fileSha256 === m.accountingFactRef.sha256 && f.pointer === m.accountingFactRef.pointer));
    assert.ok(c.evidence.materials.some(f => f.sourceId === 'business' && f.fileSha256 === m.businessFactRef.sha256 && f.location.pointer === m.businessFactRef.pointer));
    for (const e of c.entries) { assert.equal(e.ruleId, m.expectedRuleId); assert.ok(e.ruleSources.every(s => s.url.startsWith('https://') && s.locator)); }
    for (const e of c.entries) for (const f of e.sourceFields) {
      assert.equal(f.fileSha256, m.sourceRef.sha256); assert.equal(f.location.column, m.sourceRef.fields[f.field].column);
      if (m.sourceRef.sheet) assert.equal(f.location.cell, m.sourceRef.fields[f.field].cell);
    }
    const storedSource = actual.snapshot.sources.voucherSources.find(s => s.source_voucher_id === c.businessKey); assert.ok(storedSource);
    const v = actual.snapshot.vouchers.find(v => v.id === storedSource.voucher_id); assert.ok(v); assert.equal(v.status, 'posted'); assert.equal(v.period, m.period); assert.equal(v.voucher_date, m.date);
    assert.deepEqual(v.entries.map(e => ({ accountCode: e.code, debit: money(e.debit), credit: money(e.credit) })), m.expectedEntries);
    assert.ok(v.entries.every(e => Number.isInteger(e.id)));
    assert.ok(actual.snapshot.sources.batchVouchers.some(b => b.voucher_id === v.id && b.batch_id === storedSource.batch_id && b.action === 'created'));
    const trial = actual.trials.find(t => t.period === m.period), prev = actual.trials[actual.trials.indexOf(trial) - 1];
    const codes = trial.lines.map(l => l.code).sort();
    assert.equal(new Set(codes).size, codes.length, 'each monthly account code must occur exactly once');
    assert.deepEqual(codes, baselineCodes, 'each monthly trial must cover the complete initial account inventory');
    for (const code of ['1122', '5001', '2221']) assert.equal(trial.lines.filter(l => l.code === code).length, 1);
    const allowed = new Map([['1122', ['debit', m.unclosedAsOf['1122debit']]], ['5001', ['credit', m.unclosedAsOf['5001credit']]], ['2221', ['credit', m.unclosedAsOf['2221credit']]]]);
    for (const line of trial.lines) {
      const selected = allowed.get(line.code);
      for (const side of ['debit', 'credit']) {
        assert.equal(money(line['opening_' + side]), '0.00');
        const cumulative = selected && selected[0] === side ? selected[1] : '0.00';
        assert.equal(money(line['period_' + side]), cumulative); assert.equal(money(line['closing_' + side]), cumulative);
        const old = prev?.lines.find(x => x.code === line.code)?.['period_' + side] ?? 0;
        const literal = m.expectedEntries.find(e => e.accountCode === line.code)?.[side] ?? '0.00';
        assert.equal(minor(money(line['period_' + side])) - minor(money(old)), minor(literal));
      }
    }
    for (const side of ['debit', 'credit']) for (const kind of ['opening', 'period', 'closing']) {
      const field = kind + '_' + side, literal = kind === 'opening' ? '0.00' : m.unclosedAsOf.totalDebitAndCreditEach;
      const independentLineSum = trial.lines.reduce((sum, line) => sum + minor(money(line[field])), 0n);
      assert.equal(independentLineSum, minor(literal), m.period + '/' + field + '/literal line sum');
      assert.equal(minor(money(trial.totals[field])), independentLineSum, m.period + '/' + field + '/reported total');
      assert.equal(money(trial.totals[field]), literal);
    }
  }
  const d = actual.diagnostic; assert.equal(d.status, 'q2_selected_fields_calculated', JSON.stringify(d)); assert.equal(d.q2CalculationReady, true);
  assert.equal(d.binding.relationship, 'same_held_readonly_source_same_capture');
  const rowNodes = { 1: 'taxable_base', 2: 'ordinary_only', 3: 'taxable_base', 15: 'standard_vat', 16: 'relief', 20: 'payable', 21: 'prepaid', 22: 'due' };
  const nodeDefinitions = {
    taxable_base: { formula: 'sum(reconciled_invoice_net)', row: 1, sales: true },
    initial_book_vat: { formula: 'sum(reconciled_posted_initial_vat)', originalVat: true, sales: true },
    no_adjustment: { formula: 'each_original_tax=net/100=actual_posted_vat', minor: '0', dependencies: ['taxable_base', 'initial_book_vat'] },
    standard_vat: { formula: 'taxable_base*3/100', row: 15, dependencies: ['taxable_base'] },
    relief: { formula: 'taxable_base*2/100', row: 16, dependencies: ['taxable_base'] },
    payable: { formula: 'standard_vat-relief', row: 20, dependencies: ['standard_vat', 'relief', 'no_adjustment'] },
    prepaid: { formula: 'evidenced_no_prepayments', row: 21, dependencies: [] },
    due: { formula: 'payable-prepaid', row: 22, dependencies: ['payable', 'prepaid'] },
    ordinary_only: { formula: 'all_sales_individually_confirmed_ordinary', row: 2, sales: true }
  };
  for (const [quarter, product] of [['2026-Q1', d.priorComputation], ['2026-Q2', d.computation]]) {
    assert.equal(product.scope.period, quarter);
    const cellKeys = product.cells.map(c => `${c.row}/${c.column}/${c.period}`);
    const requiredCellKeys = Array.from({ length: 25 }, (_, i) => i + 1).flatMap(n => ['goods', 'services'].flatMap(column => ['current', 'yearToDate'].map(period => `${n}/${column}/${period}`)));
    assert.equal(cellKeys.length, 100); assert.equal(new Set(cellKeys).size, 100, 'tax cells must have globally unique keys');
    assert.deepEqual([...cellKeys].sort(), requiredCellKeys.sort(), 'all 100 supported output cells must exist exactly once');
    assert.equal(product.ruleVersion, quarter.endsWith('1') ? 'offline-vat-selected/1' : 'offline-vat-selected-q2/1'); assert.deepEqual(product.issues, []);
    assert.equal(product.accountantApproval, 'pending'); assert.equal(product.sourceAuthenticity, 'unverified');
    assert.equal(product.rules.checkedOn, '2026-10-24'); assert.equal(product.rules.sources.law.effectiveFrom, '2026-01-01');
    assert.equal(product.rules.sources.relief.effectiveFrom, '2026-01-01'); assert.equal(product.rules.sources.relief.effectiveThrough, '2027-12-31');
    assert.equal(product.rules.sources.transition.effectiveFrom, '2026-02-01');
    const frozenFormulas = { 1: 'sum(reconciled_taxable_invoice_net)', 2: 'evidenced_no_special_invoices', 3: 'sum(reconciled_ordinary_invoice_net)', 15: 'row1*3/100', 16: 'row1*2/100', 20: 'row15-row16', 21: 'evidenced_no_prepayments', 22: 'row20-row21' };
    for (const [n, formula] of Object.entries(frozenFormulas)) assert.equal(product.rules.selectedRows[n].formula, formula);
    const nodeIds = product.calculationNodes.map(n => n.id);
    const requiredNodeIds = [...Object.keys(nodeDefinitions), ...(quarter === '2026-Q2' ? [1, 2, 3, 15, 16, 20].map(n => `ytd_${n}`).concat(Object.keys(nodeDefinitions).map(n => 'Q1:' + n)) : [])];
    assert.equal(new Set(nodeIds).size, nodeIds.length, 'calculation node IDs must be globally unique');
    assert.deepEqual([...nodeIds].sort(), requiredNodeIds.sort(), 'calculation graph must contain every required node exactly once');
    for (const [id, definition] of Object.entries(nodeDefinitions)) {
      const node = product.calculationNodes.find(n => n.id === id); assert.equal(node.formula, definition.formula);
      const literalMinor = definition.originalVat ? expected.movements.filter(m => (m.period <= '2026-03' ? '2026-Q1' : '2026-Q2') === quarter).reduce((sum, m) => sum + minor(m.invoiceVAT), 0n) : definition.row ? minor(expected.quarters[quarter].current[definition.row]) : BigInt(definition.minor);
      assert.equal(node.minor, String(literalMinor));
      if (definition.sales) assert.deepEqual([...node.dependencies].sort(), product.sales.map(s => s.businessKey).sort());
      else assert.deepEqual(node.dependencies, definition.dependencies);
    }
    for (const flag of ['periodComplete', 'submittable', 'authorizesExecution']) assert.equal(product[flag], false);
    for (const [period, values] of Object.entries(expected.quarters[quarter])) for (const [n, value] of Object.entries(values)) {
      const c = row(product, Number(n), period); assert.equal(c.value, value, quarter + '/' + period + '/' + n);
      assert.equal(c.column, 'services');
      if (value !== null) {
        assert.equal(c.status, 'computed'); const node = product.calculationNodes.find(node => node.id === c.calculationNode); assert.ok(node);
        assert.equal(c.calculationNode, quarter === '2026-Q2' && period === 'yearToDate' ? `ytd_${n}` : rowNodes[n]);
        assert.equal(node.minor, String(minor(value))); assert.ok(node.ruleSources.length);
        for (const key of node.ruleSources) assert.ok(product.rules.sources[key].url.startsWith('https://'));
        assert.deepEqual(c.ruleReferences, product.rules.selectedRows[n]);
      } else { assert.equal(c.status, 'not_applicable'); assert.equal(c.basis, 'official_blank_form_year_to_date_dash'); assert.equal(c.calculationNode, null); }
    }
    for (const c of product.cells) if (c.column === 'goods' || ![1, 2, 3, 15, 16, 20, 21, 22].includes(c.row)) assert.equal(c.value, null);
    assert.equal(product.sales.length, 3);
    const identityKey = x => JSON.stringify([x.sellerKey, x.code, x.number]);
    const quarterMovements = expected.movements.filter(m => (m.period <= '2026-03' ? '2026-Q1' : '2026-Q2') === quarter);
    const identities = product.sales.map(s => identityKey(s.invoice.data));
    assert.equal(new Set(identities).size, 3); assert.deepEqual([...identities].sort(), quarterMovements.map(m => identityKey(m.identity)).sort());
    assert.equal(new Set(product.sales.map(s => s.businessKey)).size, 3); assert.equal(new Set(product.sales.map(s => s.voucherId)).size, 3);
    const quarterCandidates = candidates.filter(c => c.scope.period === quarter);
    assert.deepEqual(product.sales.map(s => s.businessKey).sort(), quarterCandidates.map(c => c.businessKey).sort());
    assert.equal(product.reconciledBusinesses.length, 3); assert.equal(new Set(product.reconciledBusinesses.map(s => s.businessKey)).size, 3); assert.equal(new Set(product.reconciledBusinesses.map(s => s.voucherId)).size, 3);
    assert.deepEqual(product.reconciledBusinesses.map(s => s.businessKey).sort(), quarterCandidates.map(c => c.businessKey).sort());
    assert.deepEqual(product.reconciledBusinesses.map(s => s.voucherId).sort(), product.sales.map(s => s.voucherId).sort());
    for (const reconciled of product.reconciledBusinesses) {
      const sale = product.sales.find(s => s.businessKey === reconciled.businessKey); assert.ok(sale);
      for (const [key, value] of Object.entries(reconciled)) assert.deepEqual(sale[key], value);
    }
    for (const sale of product.sales) {
      const m = expected.movements.find(m => m.invoiceNumber === sale.invoice.data.number); assert.ok(m);
      const candidate = quarterCandidates.find(c => c.date === m.date); assert.ok(candidate); assert.equal(sale.businessKey, candidate.businessKey);
      assert.deepEqual({ sellerKey: sale.invoice.data.sellerKey, code: sale.invoice.data.code, number: sale.invoice.data.number }, m.identity);
      assert.equal(sale.sourceCheck.status, 'matches_persisted_content'); assert.equal(sale.revenueNetMinor, String(minor(m.net))); assert.equal(sale.initialLedgerVatMinor, String(minor(m.invoiceVAT)));
      assert.equal(sale.taxFactSource.fileSha256, m.taxFactRef.sha256); assert.equal(sale.taxFactSource.pointer, m.taxFactRef.pointer);
      assert.ok(sale.entries.every(e => Number.isInteger(e.entryId) && e.candidateSources.sourceFields.length));
      const v = actual.snapshot.vouchers.find(v => v.id === sale.voucherId); assert.ok(v);
      assert.equal(sale.sourceAssociation.voucher_id, v.id); assert.equal(sale.sourceBatch.batch_id, sale.sourceAssociation.batch_id);
      assert.deepEqual(sale.entries.map(e => e.entryId), v.entries.map(e => e.id));
      for (const nodeId of ['taxable_base', 'initial_book_vat', 'ordinary_only']) assert.ok(product.calculationNodes.find(n => n.id === nodeId).dependencies.includes(sale.businessKey));
    }
  }
  assert.equal(d.computation.historyBridge.status, 'same_capture_Q1_history_explained');
  assert.deepEqual([...d.computation.historyBridge.priorVoucherIds].sort(), actual.snapshot.vouchers.filter(v => v.period <= '2026-03').map(v => v.id).sort());
  for (const n of [1, 2, 3, 15, 16, 20]) {
    const priorCell = row(d.priorComputation, n), currentCell = row(d.computation, n), cumulativeCell = row(d.computation, n, 'yearToDate');
    const cumulativeNode = d.computation.calculationNodes.find(node => node.id === cumulativeCell.calculationNode);
    assert.deepEqual(cumulativeNode.dependencies, [`Q1:${priorCell.calculationNode}`, currentCell.calculationNode]);
    assert.equal(cumulativeNode.formula, 'actual_recomputed_Q1_current+actual_Q2_current');
    const priorNode = d.computation.calculationNodes.find(node => node.id === cumulativeNode.dependencies[0]), currentNode = d.computation.calculationNodes.find(node => node.id === cumulativeNode.dependencies[1]);
    assert.ok(priorNode); assert.ok(currentNode);
    assert.equal(priorNode.minor, String(minor(expected.quarters['2026-Q1'].current[n])));
    assert.equal(currentNode.minor, String(minor(expected.quarters['2026-Q2'].current[n])));
    assert.equal(cumulativeNode.minor, String(BigInt(priorNode.minor) + BigInt(currentNode.minor)));
    assert.equal(cumulativeNode.minor, String(minor(expected.quarters['2026-Q2'].yearToDate[n])));
    assert.match(cumulativeNode.engineeringInference, /pending_accountant_review/); assert.equal(cumulativeNode.accountantApproval, 'pending');
  }
  for (const priorNode of d.priorComputation.calculationNodes) {
    const copied = d.computation.calculationNodes.find(node => node.id === 'Q1:' + priorNode.id); assert.ok(copied);
    assert.deepEqual(copied, { ...priorNode, id: 'Q1:' + priorNode.id, dependencies: priorNode.dependencies.map(id => 'Q1:' + id), provenance: { scope: d.priorComputation.scope, contentDigest: d.priorComputation.contentDigest } });
  }
  assert.equal(actual.readOnlySchemaAndTablesUnchanged, true);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, directory, rawDirectory] = process.argv.slice(2);
  if (mode === 'execute') process.stdout.write(JSON.stringify(await executeRaw(directory, rawDirectory)));
  else if (mode === 'reopen') {
    const { request, requests } = json(join(directory, 'runtime.json'));
    const { runOfflinePosting } = await import('../../server/offline-posting.mjs');
    const { runOfflineVatQ2 } = await import('../../server/offline-vat-q2.mjs');
    const processes = observeProductProcesses();
    try {
      const before = databaseState(request.target.dbPath), replay = requests.map(r => runOfflinePosting(r));
      assert.ok(replay.every(r => r.status === 'recovered'), JSON.stringify(replay));
      const diagnostic = await runOfflineVatQ2(request); assert.deepEqual(databaseState(request.target.dbPath), before); assertExited(processes.records, 6);
      process.stdout.write(JSON.stringify({ diagnostic, replay, productProcesses: processes.records, readOnlySchemaAndTablesUnchanged: true }));
    } finally { processes.close(); }
  } else throw new Error('unknown quarterly test helper mode');
}
