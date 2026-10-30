// 合成实际账簿、原始代账底稿及真实 stdio Harness。
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { prepareAnnualScenario } from './annual-close-harness.test.mjs';
import { McpStdioClient } from '../../05-reconstruction/codex/mcp/finance-mcp/mcp-stdio-client.mjs';
import { capabilityInputContract, validateCapabilityRequest } from '../server/harness-input-contracts.mjs';
import { ANALYSIS_CONTEXT_SCHEMA } from '../server/comprehensive-analysis.mjs';
import { validateSchemaValue } from '../server/harness-schema-validation.mjs';

const file = fileURLToPath(import.meta.url), repo = resolve(dirname(file), '../..');
const json = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2));
async function alter(f, mode) {
  process.env.WORKBENCH_DATA_DIR = dirname(f.target.dbPath);
  const A = await import('../server/accounting.mjs'), { db } = await import('../server/db.mjs');
  const post = (id, period, entries) => A.createVoucher(id, { period, voucher_date: period + '-15', status: 'posted', entries });
  try {
    if (mode === 'setup') {
      const origin = post(f.scope.accountSetId, '2026-01', [{ code: '1122', debit: 202 }, { code: '5001', credit: 200 }, { code: '2221', credit: 2 }]);
      post(f.scope.accountSetId, '2026-01', [{ code: '2221', debit: 2 }, { code: '5301', credit: 2 }]);
      const plannedOrigin = post(f.scope.accountSetId, '2026-01', [{ code: '1122', debit: 300 }, { code: '5001', credit: 300 }]);
      const receipt = post(f.scope.accountSetId, '2026-02', [{ code: '1002', debit: 202 }, { code: '1122', credit: 202 }]);
      post(f.scope.accountSetId, '2026-02', [{ code: '1002', debit: 50 }, { code: '5001', credit: 50 }]);
      post(f.scope.accountSetId, '2026-02', [{ code: '5602', debit: 10 }, { code: '1002', credit: 10 }]);
      post(f.otherId, '2026-02', [{ code: '1002', debit: 999 }, { code: '5001', credit: 999 }]);
      return { originId: origin.id, receiptId: receipt.id, plannedOriginId: plannedOrigin.id };
    }
    if (mode === 'unmapped') {
      A.addAccount(f.scope.accountSetId, { code: '9999', name: 'SYNTHETIC 未映射科目', category: '损益', direction: 'debit' });
      post(f.scope.accountSetId, '2026-02', [{ code: '9999', debit: 1 }, { code: '1002', credit: 1 }]);
      return { changed: mode };
    }
    post(mode === 'other' ? f.otherId : f.scope.accountSetId, mode === 'future' ? '2026-03' : '2026-02', [{ code: '5602', debit: 7 }, { code: '1002', credit: 7 }]);
    return { changed: mode };
  } finally { db.close(); }
}
function child(f, mode) {
  const p = spawnSync(process.execPath, [file, '--alter', join(f.root, 'scenario.json'), mode], { encoding: 'utf8', windowsHide: true, env: { ...process.env, NODE_NO_WARNINGS: '1' } });
  assert.equal(p.status, 0, p.stderr || p.stdout); return JSON.parse(p.stdout);
}
function databaseState(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({ name }) => [name, db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()]); }
  finally { db.close(); }
}

async function test() {
  mkdirSync(join(repo, '.agent-runs'), { recursive: true });
  const root = mkdtempSync(join(repo, '.agent-runs/comprehensive-analysis-'));
  const f = prepareAnnualScenario(join(root, 'fixture'), { empty: true }), ids = child(f, 'setup');
  const scope = { ...f.scope, period: '2026-02' }, storePath = join(root, 'store');
  const original = join(root, 'owner-and-settlement.original.txt');
  writeFileSync(original, 'SYNTHETIC ONLY: January receivable 202.00 collected in February. Another January 300.00 remains unpaid. Owner proposes March collection 100.00 or 200.00, principal only; no new sale, discount, interest, reversal or FX. Deadline requires accountant confirmation.');
  const contextPath = join(root, 'context.json'), sourceRefs = [{ path: original, locator: 'line 1; original owner proposals and January receivable settlement instruction' }];
  const context = { version: 'analysis-context/1', scope,
    collectionMappings: [{ receiptVoucherId: ids.receiptId, originVoucherId: ids.originId, amount: '202.00', reason: 'SYNTHETIC customer settlement instruction', sourceRefs }],
    reminders: [{ kind: 'deadline', content: '合成待核期限', period: scope.period, dueDate: '2026-03-10', requestedEvidence: '由会计核实实际期限与适用条件' }],
    ownerPlan: { providedBy: 'owner', owner: 'SYNTHETIC OWNER', futurePeriod: '2026-03', sourceRefs,
      assumptions: ['仅回收已确认应收本金，无新销售、折扣、利息、坏账转回或汇兑'],
      scenarios: [{ name: '回收100', collections: [{ originVoucherId: ids.plannedOriginId, amount: '100.00' }] }, { name: '回收200', collections: [{ originVoucherId: ids.plannedOriginId, amount: '200.00' }] }] } };
  json(contextPath, context); assert.deepEqual(validateSchemaValue(ANALYSIS_CONTEXT_SCHEMA, context), []);
  const request = { target: f.target, historyPeriods: ['2026-01'], manifestPaths: f.manifestPaths.slice(0, 2), contextPath };
  validateCapabilityRequest('analysis.comprehensive', request);
  assert.throws(() => validateCapabilityRequest('analysis.comprehensive', { ...request, reports: {} }), /harness_capability_input_invalid/);
  const client = new McpStdioClient(join(repo, '05-reconstruction/codex/mcp/finance-mcp/server.mjs'), { cwd: repo, env: { NODE_NO_WARNINGS: '1' }, timeoutMs: 120000 }).start();
  const call = async (name, args, isError = false) => { const r = await client.call(name, args); assert.equal(r.isError, isError, r.text); return r.structured ?? r.data; };
  const fact = (factId, value) => ({ factId, state: 'provided', reason: 'SYNTHETIC explicit request; originals and native ledger separately verified', sourceRefs: ['request-original'], value });
  const task = (taskId, factId) => ({ taskId, capabilityId: 'analysis.comprehensive', requestFactId: factId, factIds: [factId], dependsOn: [], goal: 'Read-only reviewable comprehensive analysis' });
  let tasks = [], sequence = 0;
  const run = async (value = request, failed = false, retainPrevious = false) => {
    const id = 'analysis-' + ++sequence;
    await call('harness_facts_register', { storePath, facts: [fact(id, value)] }); tasks = [...(retainPrevious ? tasks : []), task(id, id)];
    await call('harness_plan', { storePath, tasks });
    return { id, result: await call('harness_run', { storePath, taskId: id, responseMode: 'full' }, failed) };
  };
  try {
    await client.initialize();
    const discover = await call('harness_discover', { capabilityId: 'analysis.comprehensive' });
    assert.equal(discover.contractAvailable, true); assert.deepEqual(discover.requestSchema, capabilityInputContract('analysis.comprehensive').requestSchema); assert.deepEqual(discover.phases, ['execute']);
    assert.deepEqual(discover.supportingFileSchemas.contextPath, ANALYSIS_CONTEXT_SCHEMA);
    const domain = await call('harness_discover', { query: '综合' }); assert.ok(domain.capabilities.some(c => c.capabilityId === 'analysis.comprehensive'));
    await call('harness_init', { storePath, scope });
    await call('harness_source_register', { storePath, source: { sourceId: 'request-original', path: original, locator: 'line 1', parsed: false, classification: 'provided', unrecognized: [] } });
    const before = databaseState(f.target.dbPath), first = await run(), analysis = first.result.receipt.actualImpact;
    assert.equal(first.result.status, 'executed'); assert.equal(analysis.status, 'analysis_draft');
    assert.deepEqual(analysis.selectedPeriods, ['2026-01', '2026-02']);
    assert.deepEqual(analysis.metrics.map(m => m.income?.营业收入), [500, 50]);
    const receipt = analysis.findings.find(v => v.id === 'book-receipts');
    assert.equal(receipt.facts.grossBankBookReceipts, 252); assert.equal(receipt.facts.currentRevenue, 50);
    assert.equal(receipt.facts.sourceMappedHistoricalCollections, 202); assert.equal(receipt.facts.unallocatedArCollectionCandidates, 0); assert.equal(receipt.facts.otherBookReceipts, 50);
    assert.match(receipt.content, /不得仅因/); assert.ok(receipt.responseOptions.existingBasis.length);
    const difference = analysis.findings.find(v => v.id === 'profit-difference-2026-02');
    assert.ok(difference); assert.equal(difference.facts.unexplainedDifference, -340); // 重放结果 202，对比账簿 502+50-10=542。
    assert.ok(difference.evidenceRefs.some(r => r.locator.includes('native-workpaper'))); assert.ok(difference.responseOptions.requestedEvidence.length);
    assert.ok(analysis.findings.some(v => v.id === 'tax-2026-02')); assert.ok(analysis.findings.some(v => v.id === 'invoice-2026-02'));
    const plan = analysis.findings.find(v => v.id === 'owner-collection-plan');
    assert.deepEqual(plan.facts.scenarios.map(s => s.incrementalCashInflow), [100, 200]);
    assert.ok(plan.facts.scenarios.every(s => s.incrementalAccrualProfitBeforeTax === 0 && s.taxImpact.status === 'unsupported' && s.taxImpact.amount === null && s.cashAfterTax === null));
    assert.ok(plan.missingOrUncertain.length > 1);
    for (const finding of analysis.findings) { assert.deepEqual(finding.scope.accountSetId, scope.accountSetId); assert.equal(finding.scope.enterpriseKey, scope.enterpriseKey); assert.equal(finding.scope.databaseInstanceId, scope.databaseInstanceId); assert.ok(finding.content && finding.evidenceRefs.length && Array.isArray(finding.missingOrUncertain) && finding.suggestedActions.length); assert.equal(finding.review.status, 'pending'); }
    assert.deepEqual(databaseState(f.target.dbPath), before, 'analysis performs no database writes or migrations');
    let status = await call('harness_status', { storePath, responseMode: 'full' }); assert.equal(status.tasks[0].resultCurrent, true);
    await call('harness_feedback', { storePath, feedback: { taskId: first.id, targetVersion: first.result.receipt.targetVersion, dependencyDigest: first.result.receipt.dependencyDigest, decision: 'accept', reason: 'SYNTHETIC TEST ONLY accountant review', reviewer: 'SYNTHETIC TEST ONLY', evidenceRefs: [] } });
    child(f, 'other'); status = await call('harness_status', { storePath, responseMode: 'full' }); assert.equal(status.tasks[0].resultCurrent, true); assert.equal(status.tasks[0].confirmationCurrent, true);
    const bookOnly = await run({ target: f.target, historyPeriods: ['2026-01'] }, false, true);
    child(f, 'future'); status = await call('harness_status', { storePath, responseMode: 'full' });
    assert.equal(status.tasks[0].resultCurrent, false, 'native agency asset target digest conservatively covers the enterprise book');
    assert.equal(status.tasks[0].confirmationCurrent, false);
    assert.equal(status.tasks.find(t => t.taskId === bookOnly.id).resultCurrent, true, 'book-only snapshot excludes future-period vouchers');
    assert.ok(bookOnly.result.receipt.actualImpact.metrics.every(m => m.period <= scope.period));
    const summary = await call('harness_run', { storePath, taskId: first.id }); assert.ok(summary.presentation.details.receiptRef);
    const detail = await call('harness_receipt_read', { storePath, receiptRef: summary.presentation.details.receiptRef, pointer: '/receipt/actualImpact/findings/0' }); assert.ok(detail.fragment.includes('ledger-coverage'));
    const reviewed = await run();
    await call('harness_feedback', { storePath, feedback: { taskId: reviewed.id, targetVersion: reviewed.result.receipt.targetVersion, dependencyDigest: reviewed.result.receipt.dependencyDigest, decision: 'accept', reason: 'SYNTHETIC TEST ONLY current review', reviewer: 'SYNTHETIC TEST ONLY', evidenceRefs: [] } });
    // 已知原件更正即使格式错误，也会永久使旧批准失效。
    const rawPath = join(dirname(f.manifestPaths[1]), '2026-02.facts.json'), saved = readFileSync(rawPath);
    writeFileSync(rawPath, '{ malformed corrected source');
    status = await call('harness_status', { storePath, responseMode: 'full' }); assert.equal(status.tasks.find(t => t.taskId === reviewed.id).resultCurrent, false); assert.equal(status.tasks.find(t => t.taskId === reviewed.id).confirmationCurrent, false);
    writeFileSync(rawPath, saved); status = await call('harness_status', { storePath, responseMode: 'full' }); assert.equal(status.tasks.find(t => t.taskId === reviewed.id).resultCurrent, false);
    const regenerated = await run(); assert.equal(regenerated.result.status, 'executed');
    child(f, 'current'); status = await call('harness_status', { storePath, responseMode: 'full' }); assert.equal(status.tasks.find(t => t.taskId === regenerated.id).resultCurrent, false);
    const missing = await run({ target: f.target, historyPeriods: ['2026-01'] });
    const gaps = missing.result.receipt.actualImpact; assert.ok(gaps.findings.some(v => v.id === 'tax-invoice-gap' && v.state === 'missing')); assert.ok(gaps.findings.some(v => v.id === 'owner-plan-gap'));
    assert.equal(gaps.findings.find(v => v.id === 'book-receipts').facts.unallocatedArCollectionCandidates, 202);
    const conflictContextPath = join(root, 'conflict.json'), conflict = structuredClone(context); conflict.collectionMappings[0].amount = '203.00'; json(conflictContextPath, conflict);
    const conflicted = (await run({ ...request, contextPath: conflictContextPath })).result.receipt.actualImpact;
    assert.ok(conflicted.findings.some(v => v.id === 'collection-conflict' && v.state === 'conflict')); assert.equal(conflicted.findings.find(v => v.id === 'book-receipts').facts.sourceMappedHistoricalCollections, 0);
    const wrong = await run({ ...request, target: { ...f.target, accountSetId: f.otherId } }, true); assert.equal(wrong.result.receipt.executionState, 'failed');
    const future = await run({ ...request, historyPeriods: ['2026-03'] }, true); assert.equal(future.result.receipt.executionState, 'failed');
    const wrongContextPath = join(root, 'other-period.json'); json(wrongContextPath, { ...context, scope: { ...scope, period: '2026-01' } });
    const wrongContext = await run({ ...request, contextPath: wrongContextPath }, true); assert.equal(wrongContext.result.receipt.executionState, 'failed');
    const malformedPath = join(root, 'malformed-context.json'), malformedContext = structuredClone(context); delete malformedContext.ownerPlan.sourceRefs; json(malformedPath, malformedContext);
    const malformed = await run({ ...request, contextPath: malformedPath }, true);
    assert.equal(malformed.result.receipt.actualImpact.code, 'analysis_context_invalid');
    assert.ok(malformed.result.receipt.actualImpact.details.problems.some(p => p.inputPointer === '/ownerPlan/sourceRefs'));
    const missingFile = await run({ ...request, contextPath: join(root, 'does-not-exist.json') }, true); assert.equal(missingFile.result.receipt.executionState, 'failed');
    const badContext = structuredClone(context); badContext.ownerPlan.scenarios[0].collections[0].originVoucherId = 999999; json(conflictContextPath, badContext);
    const badPlan = (await run({ ...request, contextPath: conflictContextPath })).result.receipt.actualImpact.findings.find(v => v.id === 'owner-collection-plan'); assert.equal(badPlan.facts.scenarios[0].incrementalCashInflow, null);
    // 覆盖范围可声明完整，但某项具体业务事实仍可能无法
    // 重放。原生映射得到的部分合计不得当作完整差额。
    const januaryPath = join(dirname(f.manifestPaths[0]), '2026-01.facts.json'), januaryBytes = readFileSync(januaryPath);
    const incompleteRaw = JSON.parse(januaryBytes.toString('utf8')); incompleteRaw.records.find(r => r.type === 'service_complete').accepted = false; json(januaryPath, incompleteRaw);
    try {
      const partial = (await run()).result.receipt.actualImpact;
      assert.ok(!partial.findings.some(v => v.id.startsWith('profit-difference-')));
      assert.ok(partial.findings.some(v => v.id === 'comparison-gap-2026-02' && v.state === 'missing' && v.facts.rawAccountingStatus === 'incomplete'));
    } finally { writeFileSync(januaryPath, januaryBytes); }
    child(f, 'unmapped');
    const unsupported = (await run({ target: f.target, historyPeriods: ['2026-01'] })).result.receipt.actualImpact;
    assert.equal(unsupported.metrics.find(m => m.period === scope.period).income, null);
    assert.ok(unsupported.findings.some(v => v.id === 'report-2026-02' && v.state === 'unsupported'));
    console.log(JSON.stringify({ status: 'passed', modelInvoked: false, root, checks: ['native multi-period reports and raw workpapers', 'historical AR versus current revenue', 'actual raw-ledger difference with evidence and unresolved part', 'missing/conflict/unsupported never filled as zero', 'owner plan conditional cash/profit and unsupported tax', 'original/ledger invalidation, approval never revived', 'enterprise/account/period isolation and read-only database', 'real stdio discovery/run/feedback/receipt details'] }));
  } finally { await client.close(); }
}
if (process.argv[2] === '--alter') console.log(JSON.stringify(await alter(JSON.parse(readFileSync(process.argv[3], 'utf8')), process.argv[4])));
else await test();
