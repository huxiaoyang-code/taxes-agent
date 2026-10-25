// A real stdio-MCP/native-Harness integration, never a model/Agent acceptance.
// `prepare <new absolute directory>` only creates synthetic originals, existing
// ledger, native input manifests and an explicit target. It calls no Harness.
import assert from 'node:assert/strict';
import { mkdirSync, existsSync, writeFileSync, readFileSync, mkdtempSync, appendFileSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { McpStdioClient } from '../../05-reconstruction/codex/mcp/finance-mcp/mcp-stdio-client.mjs';
import { OBLIGATION_IDS } from '../server/agency-tax-rules.mjs';

const thisFile = fileURLToPath(import.meta.url), repo = resolve(dirname(thisFile), '../..');
const json = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2));
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const nativeRecord = (key, id, type, period, extra = {}) => ({ id, type, date: period + '-10', enterpriseKey: key,
  taxJurisdiction: 'domestic', specialVatTreatment: 'ordinary', businessIdentity: { issuerKey: key, documentNumber: id, event: type },
  originalRefs: [{ originalId: period, locator: 'whole monthly original schedule', extractionReason: 'Synthetic independently authored original business and registration facts' }], ...extra });

function seed(root) {
  process.env.WORKBENCH_DATA_DIR = join(root, 'data'); process.env.TMP = root; process.env.TEMP = root;
  return import('../server/accounting.mjs').then(async A => {
    const { db } = await import('../server/db.mjs');
    try {
      const key = 'SYNTHETIC-ANNUAL-HARNESS-A';
      const id = A.createAccountSet({ name: '合成年度核对公司', start_period: '2025-12', profileId: 'small-2011-basic-v1', enterprise: { enterpriseKey: key } }).id;
      const post = (accountSetId, period, entries) => A.createVoucher(accountSetId, { period, voucher_date: period + '-15', status: 'posted', entries });
      A.setOpeningBalances(id, [{ code: '1002', debit: 1000 }, { code: '3001', credit: 1000 }]);
      post(id, '2025-12', [{ code: '1002', debit: 200 }, { code: '5001', credit: 200 }]);
      post(id, '2025-12', [{ code: '5602', debit: 40 }, { code: '1002', credit: 40 }]);
      A.carryForwardProfit(id, '2025-12', { yearEnd: true });
      for (let m = 1; m <= 12; m++) A.ensurePeriod(id, `2026-${String(m).padStart(2, '0')}`);
      // Pre-existing synthetic ledger, not an action performed by the Agent.
      post(id, '2026-01', [{ code: '1122', debit: 202 }, { code: '5001', credit: 200 }, { code: '2221', credit: 2 }]);
      post(id, '2026-01', [{ code: '2221', debit: 2 }, { code: '5301', credit: 2 }]);
      A.ensurePeriod(id, '2027-01');
      const otherId = A.createAccountSet({ name: '另一合成企业', start_period: '2026-01', profileId: 'small-2011-basic-v1', enterprise: { enterpriseKey: 'SYNTHETIC-ANNUAL-HARNESS-B' } }).id;
      post(otherId, '2026-12', [{ code: '1122', debit: 7 }, { code: '5001', credit: 7 }]);
      return { target: { dbPath: join(root, 'data', 'workbench.db'), databaseInstanceId: db.prepare('SELECT instance_id FROM audit_database_instances WHERE is_active=1').get().instance_id, enterpriseKey: key, accountSetId: id }, otherId };
    } finally { db.close(); }
  });
}

export function prepareAnnualScenario(directory) {
  assert.ok(isAbsolute(directory), 'prepare requires an absolute path');
  const root = resolve(directory); assert.equal(existsSync(root), false, 'prepare never overwrites a directory'); mkdirSync(root, { recursive: true });
  const child = spawnSync(process.execPath, [thisFile, '--seed', root], { encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1' }, windowsHide: true });
  assert.equal(child.status, 0, child.stderr || child.stdout); const seeded = JSON.parse(child.stdout);
  const { target } = seeded, scope = { enterpriseKey: target.enterpriseKey, accountSetId: target.accountSetId, databaseInstanceId: target.databaseInstanceId, period: '2026', currency: 'CNY' };
  const dir = join(root, 'customer-originals'); mkdirSync(dir);
  const entity = { kind: 'company', industry: 'service', profileId: 'small-2011-basic-v1', businessStartDate: '2025-01-01', vatStatus: 'small', vatPeriod: 'monthly', vatReliefWaived: false,
    incomeLevyMethod: 'actual_accounts', bookkeepingMethod: 'double_entry', region: 'synthetic-no-unverified-regional-assumption' };
  const sources = [], originals = [], manifestPaths = [];
  const prior = join(dir, 'prior-year.original');
  writeFileSync(prior, '合成历史资料：2025年1月成立，2025年12月启用本账。建账银行1000元、实收资本1000元；12月营业收入收款200元、行政费用支付40元，净利160元已结转。2026年期初银行1160元、资本1000元、留存收益160元；无以前年度未弥补亏损。本历史说明仍需会计逐项核实。');
  for (let m = 1; m <= 12; m++) {
    const period = `2026-${String(m).padStart(2, '0')}`, original = join(dir, period + '.original'), facts = join(dir, period + '.facts.json');
    writeFileSync(original, `合成${period}基础原件和覆盖清单：全部合同、未开票业务、银行及往来清单已提供，银行本月无收付，无工资、资产购置、存货或其他地方税费活动；季度人数0、资产总额1362元。${m === 1 ? '境内普通主营咨询服务已完成验收并取得索款权，2小时，每小时100.00元不含税，普通发票，税率登记1%，未收款。全年适用小企业会计准则、小规模月报、查账实际利润预缴；非限制行业、无往年亏损，其他年度调整资料完整。' : '本月无新增业务。'}此为客户基础资料，不是会计确认或年度完成声明。`);
    const record = (id, type, extra) => nativeRecord(target.enterpriseKey, id, type, period, extra);
    const records = [record('coverage-' + period, 'period_coverage', { date: period + '-28', period, complete: true, accountsCovered: true, unbilledSalesCovered: true, bankCovered: true }),
      record('profile-' + period, 'quarter_profile', { date: period + '-28', asOfDate: period + '-28', quarter: `2026-Q${Math.ceil(m / 3)}`, startStaff: 0, endStaff: 0, startAssets: '1362.00', endAssets: '1362.00' })];
    if (m === 1) records.unshift(record('entity', 'entity', { date: period + '-01', entity }),
      record('activities', 'obligation_inventory', { activities: Object.fromEntries(OBLIGATION_IDS.map(id => [id, { present: false, reason: 'Synthetic complete original contract/asset/workforce inventory records no such activity' }])) }),
      record('income', 'income_evidence', { date: period + '-01', lossCarryforwardVerified: true, noPriorLosses: true, otherAdjustmentsComplete: true, restrictedIndustry: false, citFilingFrequency: 'monthly', citPrepaymentMethod: 'actual_profit', prepaymentAdjustmentsComplete: true }),
      record('location', 'tax_location', { date: period + '-01', classification: 'city' }),
      record('consulting-service', 'service_complete', { accepted: true, collectionRight: true, work: [{ units: '2', unitPrice: '100.00', priceIncludesVat: false }], invoiceKind: 'ordinary', settlement: 'unpaid' }));
    json(facts, { version: 'agency-raw-facts/1', scope: { ...scope, period }, records });
    sources.push({ path: facts }); originals.push({ id: period, path: original });
    const manifest = join(dir, period + '.manifest.json'); json(manifest, { version: 'agency-business-materials/1', scope: { ...scope, period }, sources: [...sources], originals: [...originals] }); manifestPaths.push(manifest);
  }
  const scenario = { version: 'annual-harness-synthetic/1', root, target, scope, otherId: seeded.otherId, manifestPaths, priorOriginal: prior,
    sourcePath: join(dir, '2026-01.original'), annualStore: join(root, 'annual-store'), calculationStore: join(root, 'calculation-store'), nextStore: join(root, 'next-year-store'), modelInvoked: false, harnessInvoked: false };
  json(join(root, 'scenario.json'), scenario);
  writeFileSync(join(root, 'independent-expectations.txt'), '仅供验收者；不是工具输入。手算：历史1000+200-40=1160银行，留存收益160。2026年未收服务2×100=200，不含税，税2；适用小规模免税收入转入收益2，因此原有账簿年利润202、应收202、银行1160。已发布年度计算应税利润202；小型微利适用范围内5%计算值10.10（仍待会计审定，不代替适用资格调查）。次年期初银行1160、应收202。同企业额外年度费用50后原业务利润152、手算字段7.60；只改原件不改账时年度税算与账簿必须暴露差异，不能声称已更正。另一企业利润7必须隔离。');
  writeFileSync(join(root, 'goal.txt'), `全部为合成验收。读取年度和Harness Skill、发现真实MCP能力。目标已有历史及全年合成账簿；通过annual.inspect核对真实年报，再通过独立agency.annual-calculation任务重放全年原件。自行组织事实、补件与依赖；复核包引用两种真实结果的数字/原件/政策/计算版本，保留年度调整、跨年台账及人类会计未审定事项。源码测试已做的调用不是Agent验收；本次须保存真实逐步MCP调用及判断。不得伪造人类反馈；需要确认的阶段向当前验收者报告。\n范围：${JSON.stringify(scope)}\n目标：${JSON.stringify(target)}\n合成资料及12个manifestPaths：${join(root, 'scenario.json')}\n客户原件：${dir}\nprepare未初始化任何Harness或调用模型，所有Harness目录须由本次Agent按实际返回建立。independent-expectations.txt为验收者手算，不作业务输入。\n`);
  return scenario;
}

function databaseState(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const schema = db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all();
    const tables = Object.fromEntries(schema.filter(r => r.type === 'table').map(({ name }) => [name,
      db.prepare('SELECT * FROM "' + name.replaceAll('"', '""') + '"').all().map(row => JSON.stringify(row)).sort()]));
    return { schema, tables };
  } finally { db.close(); }
}

function readonlyModeChecks(f, directory) {
  const dbModule = new URL('../server/db.mjs', import.meta.url).href;
  const probe = (dataDir, script) => spawnSync(process.execPath, ['--input-type=module', '-e', `import {db,importSchema} from ${JSON.stringify(dbModule)};try{${script}}finally{db.close()}`], {
    encoding: 'utf8', windowsHide: true, env: { ...process.env, NODE_NO_WARNINGS: '1', WORKBENCH_DATABASE_MODE: 'readonly', WORKBENCH_DATA_DIR: dataDir },
  });
  const before = databaseState(f.target.dbPath);
  const safe = probe(dirname(f.target.dbPath), `db.exec('PRAGMA query_only=OFF');const queryOnly=db.prepare('PRAGMA query_only').get().query_only;if(queryOnly!==0)throw Error('query_only_not_disabled_for_constructor_probe');let refused=0;for(const sql of ['UPDATE accounts SET name=name WHERE 0','CREATE TABLE forbidden_read_test(id)']){try{db.exec(sql)}catch(e){if(/readonly|read.only/i.test(e.message))refused++;else throw e}}if(refused!==2)throw Error('sqlite_connection_not_readonly');console.log(JSON.stringify({queryOnly,refused,changes:db.prepare('SELECT total_changes() n').get().n,to:importSchema.to,version:importSchema.version}))`);
  assert.equal(safe.status, 0, safe.stderr); assert.deepEqual(JSON.parse(safe.stdout), { queryOnly: 0, refused: 2, changes: 0, to: 5, version: 5 });
  assert.deepEqual(databaseState(f.target.dbPath), before);
  const missing = join(directory, 'missing-target'), noTarget = probe(missing, ''); assert.notEqual(noTarget.status, 0); assert.equal(existsSync(missing), false);
  const invalidTargets = [];
  const renamedColumns = {
    'missing-column': ['accounts', 'category'], 'missing-account-set-name': ['account_sets', 'name'],
    'missing-accounting-standard': ['account_sets', 'accounting_standard'], 'missing-contra': ['accounts', 'contra'],
    'missing-voucher-word': ['vouchers', 'word'], 'missing-depreciation-run-id': ['asset_depreciation_runs', 'id'],
    'missing-asset-residual-rate': ['asset_cards', 'residual_rate'], 'missing-asset-opening-accumulated': ['asset_cards', 'opening_accumulated'],
    'missing-asset-ledger-status': ['asset_cards', 'ledger_status'],
  };
  for (const kind of ['missing-batch', 'missing-schema-migrations', ...Object.keys(renamedColumns), 'non-wal']) {
    const dir = join(directory, kind); mkdirSync(dir); const path = join(dir, 'workbench.db'); copyFileSync(f.target.dbPath, path);
    const db = new DatabaseSync(path);
    try {
      if (kind === 'missing-batch') db.exec('DROP TABLE local_batch_component');
      else if (kind === 'missing-schema-migrations') db.exec('DROP TABLE schema_migrations');
      else if (renamedColumns[kind]) { const [table, column] = renamedColumns[kind]; db.exec(`ALTER TABLE ${table} RENAME COLUMN ${column} TO unsupported_${column}`); }
      else db.exec('PRAGMA journal_mode=DELETE');
    } finally { db.close(); }
    const state = databaseState(path), result = probe(dir, ''); assert.notEqual(result.status, 0, kind + ' must refuse without migration');
    assert.match(result.stderr, kind === 'non-wal' ? /readonly_database_wal_required/ : /readonly_database_not_ready/);
    assert.deepEqual(databaseState(path), state);
    invalidTargets.push({ kind, path });
  }
  console.log('PASS read-only mode: enforced from connection construction, zero DML/DDL, no missing target creation, no incomplete-schema installation or WAL conversion.');
  return invalidTargets;
}

async function integration() {
  const parent = join(repo, '.agent-runs'); mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, 'annual-native-parent-')), f = prepareAnnualScenario(join(directory, 'scenario'));
  const invalidTargets = readonlyModeChecks(f, directory);
  const server = join(repo, '05-reconstruction/codex/mcp/finance-mcp/server.mjs'), trace = join(directory, 'mcp-calls.jsonl');
  let client;
  const start = async () => { client = new McpStdioClient(server, { cwd: repo, timeoutMs: 120000,
    env: { NODE_NO_WARNINGS: '1', FINANCE_API_BASE: 'http://127.0.0.1:1', WORKBENCH_DATA_DIR: join(directory, 'forbidden-default') } }).start(); await client.initialize('annual-native-script-test'); };
  const call = async (name, args = {}, error = false) => {
    const result = await client.call(name, args); appendFileSync(trace, JSON.stringify({ name, args, result }) + '\n');
    assert.equal(result.isError, error, result.text); return result.structured ?? result.data;
  };
  const fact = (factId, value, sourceRefs = ['original']) => ({ factId, state: 'provided', reason: 'Synthetic host request derived from actual original paths and target discovery', sourceRefs, value });
  const task = (taskId, capabilityId, factIds, externalDependencies) => ({ taskId, capabilityId, factIds, dependsOn: [], goal: 'Synthetic annual integration of actual published capability', ...(externalDependencies ? { externalDependencies } : {}) });
  const status = storePath => call('harness_status', { storePath });
  const run = async (storePath, taskId, error = false) => { const t = (await status(storePath)).tasks.find(t => t.taskId === taskId); return call('harness_run', { storePath, taskId, dependencyDigest: t.dependencyDigest }, error); };
  const setup = async (storePath, scope = f.scope) => {
    await call('harness_init', { storePath, scope });
    await call('harness_source_register', { storePath, source: { sourceId: 'original', path: f.sourcePath, locator: 'synthetic original business schedule, all native consumed originals additionally revalidated by the business entrypoint', parsed: false, unrecognized: [], classification: 'provided' } });
  };
  const reference = (storePath, t, period = '2026') => ({ storePath, taskId: t.taskId, period, targetVersion: t.receipt.targetVersion, dependencyDigest: t.dependencyDigest });
  try {
    await start();
    const listed = (await client.rpc('tools/list')).result.tools; assert.equal(listed.filter(t => t.name.startsWith('harness_')).length, 12);
    const discovery = await call('harness_discover'); const cap = discovery.capabilities.find(c => c.capabilityId === 'annual.inspect');
    assert.ok(cap); assert.equal(cap.effect, 'read'); assert.deepEqual(cap.supportedPeriods, ['year']);
    assert.ok(discovery.capabilities.some(c => c.capabilityId === 'agency.annual-calculation'));
    const found = await call('harness_scope_discover', { dbPath: f.target.dbPath }); assert.equal(found.databaseInstanceId, f.scope.databaseInstanceId);
    assert.equal(found.accountSets.find(s => s.accountSetId === f.target.accountSetId).enterpriseKey, f.scope.enterpriseKey);
    await call('skills_read', { resource: 'annual-close/SKILL.md' });
    await setup(f.annualStore); await setup(f.calculationStore);
    await call('harness_facts_register', { storePath: f.annualStore, facts: [fact('request', { target: f.target }), { factId: 'coverage', state: 'missing', reason: 'December original and historical carryover investigation pending', sourceRefs: [] }] });
    await call('harness_plan', { storePath: f.annualStore, tasks: [task('review', 'annual.inspect', ['request', 'coverage'])] });
    assert.ok((await status(f.annualStore)).tasks[0].blockers.some(b => b.state === 'missing'));
    await call('harness_run', { storePath: f.annualStore, taskId: 'review' }, true);
    const supplement = await call('harness_request_materials', { storePath: f.annualStore, request: { taskIds: ['review'], text: '请补12月完整合同/未开票/银行及历史期初依据；未补齐不得全年完成。' } });
    assert.equal(supplement.sent, false);
    await call('harness_facts_register', { storePath: f.calculationStore, facts: [fact('calculate', { target: f.target, manifestPaths: f.manifestPaths.slice(0, 11) })] });
    await call('harness_plan', { storePath: f.calculationStore, tasks: [task('tax', 'agency.annual-calculation', ['calculate'])] });
    const gap = await run(f.calculationStore, 'tax', true); assert.equal(gap.status, 'failed'); assert.equal(gap.receipt.actualImpact.code, 'agency_annual_period_gap');
    await call('harness_facts_register', { storePath: f.calculationStore, facts: [fact('calculate', { target: f.target, manifestPaths: f.manifestPaths })] });
    const calculation = await run(f.calculationStore, 'tax'); assert.equal(calculation.status, 'executed', JSON.stringify(calculation));
    const tax = calculation.receipt.actualImpact.domain;
    assert.equal(tax.scope.period, '2026-12'); assert.equal(tax.accounting.yearProfitBeforeTax, '202.00');
    assert.equal(tax.obligations.find(o => o.obligationId === 'corporate_income').due, '10.10');
    assert.ok(tax.dependencies.filter(d => d.sourceRefs).length === 12); assert.equal(tax.periodComplete, false);
    const calculationTask = (await status(f.calculationStore)).tasks[0];
    await call('harness_facts_register', { storePath: f.annualStore, facts: [fact('coverage', { originalPaths: f.manifestPaths, historyOriginal: f.priorOriginal, assessment: 'available_for_investigation_not_accountant_approved' })] });
    let reviewPlan = task('review', 'annual.inspect', ['request', 'coverage'], [reference(f.calculationStore, calculationTask)]);
    await call('harness_plan', { storePath: f.annualStore, tasks: [reviewPlan] });
    const beforeRead = databaseState(f.target.dbPath), reviewed = await run(f.annualStore, 'review');
    assert.equal(reviewed.status, 'executed', JSON.stringify(reviewed));
    const draft = reviewed.receipt.actualImpact.domain;
    assert.equal(draft.annualNumbers.incomeStatementYtd['净利润'], 202);
    assert.equal(draft.annualNumbers.cashFlowYtd.cash.begin, 1160); assert.equal(draft.annualNumbers.cashFlowYtd.cash.end, 1160);
    assert.equal(draft.nextYear.lines.find(r => r.code === '1122').opening.debit, 202);
    assert.ok(draft.ledgerEvidence.priorVoucherCount > 0); assert.equal(draft.annualComplete, false); assert.equal(draft.accountantApproval, 'pending');
    assert.deepEqual(databaseState(f.target.dbPath), beforeRead, 'read-only capability leaves every business/schema/audit/journal table unchanged');
    const reviewTask = (await status(f.annualStore)).tasks[0], feedback = { taskId: 'review', targetVersion: reviewTask.receipt.targetVersion, dependencyDigest: reviewTask.dependencyDigest,
      decision: 'accept', reason: 'Explicit synthetic human review of the numeric read draft only; unresolved annual business remains incomplete', reviewer: 'SYNTHETIC-HUMAN-ACCOUNTANT', evidenceRefs: [] };
    await call('harness_feedback', { storePath: f.annualStore, feedback }); assert.equal((await status(f.annualStore)).tasks[0].reviewState, 'accepted');
    assert.equal((await run(f.annualStore, 'review')).status, 'replayed');
    await setup(f.nextStore, { ...f.scope, period: '2027' });
    await call('harness_facts_register', { storePath: f.nextStore, facts: [fact('request', { target: f.target })] });
    await call('harness_plan', { storePath: f.nextStore, tasks: [task('next', 'annual.inspect', ['request'], [reference(f.annualStore, (await status(f.annualStore)).tasks[0])])] });
    assert.equal((await run(f.nextStore, 'next')).status, 'executed');
    await client.close(); await start();
    assert.equal((await status(f.annualStore)).tasks[0].reviewState, 'accepted'); assert.equal((await run(f.annualStore, 'review')).status, 'replayed');
    assert.deepEqual(databaseState(f.target.dbPath), beforeRead, 'MCP restart and replay do not post again or change audit/metadata');
    // Change actual December originals/facts. Native tax reads the new cost,
    // but the ledger has not been corrected: the review must expose this gap.
    const dec = join(f.root, 'customer-originals', '2026-12.facts.json'), doc = read(dec);
    doc.records.push(nativeRecord(f.scope.enterpriseKey, 'dec-cost', 'expense', '2026-12', { use: 'admin', gross: '50.00', net: '50.00', invoiceTax: '0.00', inputVatTreatment: 'non_deductible', settlement: 'unpaid', benefitPeriod: '2026-12', taxNature: 'ordinary' }));
    json(dec, doc); appendFileSync(join(f.root, 'customer-originals', '2026-12.original'), '\n合成补件：12月已验收行政服务50元、无税额、未付款，仅受益12月，尚待账务更正和会计复核。');
    const stale = (await status(f.annualStore)).tasks[0]; assert.equal(stale.executionState, 'stale'); assert.equal(stale.reviewState, 'stale');
    assert.ok((await status(f.nextStore)).tasks[0].blockers.length > 0); await call('harness_feedback', { storePath: f.annualStore, feedback }, true);
    const recalculated = await run(f.calculationStore, 'tax'); assert.equal(recalculated.status, 'executed'); assert.equal(recalculated.receipt.actualImpact.domain.accounting.yearProfitBeforeTax, '152.00');
    assert.equal(recalculated.receipt.actualImpact.domain.obligations.find(o => o.obligationId === 'corporate_income').due, '7.60');
    assert.ok((await status(f.annualStore)).tasks[0].blockers.some(b => b.reason === 'harness_external_version_changed'));
    reviewPlan = { ...reviewPlan, externalDependencies: [reference(f.calculationStore, (await status(f.calculationStore)).tasks[0])] };
    await call('harness_plan', { storePath: f.annualStore, tasks: [reviewPlan] });
    const refreshed = await run(f.annualStore, 'review'); assert.equal(refreshed.status, 'executed');
    assert.equal(refreshed.receipt.actualImpact.domain.annualNumbers.incomeStatementYtd['净利润'], 202, 'unposted correction cannot silently change ledger reports');
    assert.equal((await status(f.annualStore)).tasks[0].reviewState, 'pending'); assert.deepEqual(databaseState(f.target.dbPath), beforeRead);
    await call('harness_facts_register', { storePath: f.annualStore, facts: [fact('wrong', { target: { ...f.target, accountSetId: f.otherId } })] });
    await call('harness_plan', { storePath: f.annualStore, tasks: [reviewPlan, task('cross', 'annual.inspect', ['wrong'])] });
    const cross = await run(f.annualStore, 'cross', true); assert.equal(cross.status, 'failed'); assert.equal(cross.receipt.actualImpact.code, 'harness_target_mismatch');
    for (const invalid of invalidTargets) {
      const storePath = join(directory, 'blocked-' + invalid.kind), before = databaseState(invalid.path);
      await setup(storePath); await call('harness_facts_register', { storePath, facts: [fact('target', { target: { ...f.target, dbPath: invalid.path } })] });
      await call('harness_plan', { storePath, tasks: [task('blocked', 'annual.inspect', ['target'])] });
      const refused = await run(storePath, 'blocked', true); assert.equal(refused.status, 'failed'); assert.equal(refused.receipt.executionState, 'failed');
      assert.match(refused.receipt.actualImpact.code, /^(?:harness_annual_|readonly_database_).*(?:not_ready|wal_required)$/);
      assert.match(refused.receipt.actualImpact.handlingPath, /首次接入.*升级/); assert.equal(refused.receipt.actualImpact.initializationPerformed, false);
      assert.deepEqual(databaseState(invalid.path), before);
    }
    const missingDir = join(directory, 'missing-mcp-target'), missingStore = join(directory, 'blocked-missing-target');
    assert.equal(existsSync(missingDir), false); await setup(missingStore);
    await call('harness_facts_register', { storePath: missingStore, facts: [fact('target', { target: { ...f.target, dbPath: join(missingDir, 'workbench.db') } })] });
    await call('harness_plan', { storePath: missingStore, tasks: [task('missing', 'annual.inspect', ['target'])] });
    const missingRead = await run(missingStore, 'missing', true); assert.equal(missingRead.status, 'failed');
    assert.equal(missingRead.receipt.actualImpact.code, 'harness_annual_target_unavailable');
    assert.match(missingRead.receipt.actualImpact.handlingPath, /首次接入.*升级/); assert.equal(missingRead.receipt.actualImpact.initializationPerformed, false);
    assert.equal(existsSync(missingDir), false); assert.equal(existsSync(join(directory, 'forbidden-default')), false);
    json(join(directory, 'review-package.json'), { scope: f.scope, annualRead: refreshed.receipt, originalCalculation: calculation.receipt, recalculation: recalculated.receipt,
      sourcesAndPolicies: recalculated.receipt.actualImpact.domain, priorYearRelationship: draft.nextYear, unresolved: ['December expense 50 is not posted; ledger profit 202 differs from raw annual calculation 152', 'Accountant has not reviewed the refreshed version', 'Annual adjustments, statutory filing and cross-year auxiliary/tax schedules are not completed'], annualComplete: false, scriptIsNotAgentAcceptance: true });
    console.log('PASS annual native stdio MCP: discovery, missing evidence/supplement, actual annual calculation and ledger draft, external versions, explicit synthetic review, source correction, stale confirmation, restart/replay, next-year invalidation and cross-enterprise refusal.');
    console.log('Synthetic reproduction directory: ' + directory);
  } finally { await client?.close(); }
}

if (process.argv[2] === '--seed') process.stdout.write(JSON.stringify(await seed(resolve(process.argv[3]))));
else if (process.argv[2] === 'prepare') console.log(JSON.stringify(prepareAnnualScenario(process.argv[3]), null, 2));
else if (resolve(process.argv[1] ?? '') === thisFile) {
  await integration();
}
