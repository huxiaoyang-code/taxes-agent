// Read-only, deliberately limited analysis over existing native books and workpapers.
// No tax formula, accounting write, independent review store or workflow engine.
import { readLocalFile } from './offline-material-store.mjs';
import { statSync } from 'node:fs';
import { openReadonlyLedgerSource, captureLedgerSnapshot, validateLedgerSnapshot } from './offline-ledger-snapshot.mjs';
import { loadAgencyMaterials, buildAgencyWorkpaper } from './agency-business.mjs';
import { readAgencySession, assertAgencyEvidenceCurrent } from './agency-business-evidence.mjs';
import { validateSchemaValue } from './harness-schema-validation.mjs';
import { ANALYSIS_CONTEXT_SCHEMA } from './harness-input-contracts.mjs';
export { ANALYSIS_CONTEXT_SCHEMA } from './harness-input-contracts.mjs';
import { hash } from './harness-store.mjs';
import { parseMoney, centsToNumber } from './money.mjs';

export const ANALYSIS_VERSION = 'comprehensive-analysis/1';
const check = (value, code) => { if (!value) throw Object.assign(new Error(code), { code }); };
const minor = value => { const v = parseMoney(value, { allowNegative: true }); check(v.ok && !v.subCent, 'analysis_money_invalid'); return v.cents; };
const money = value => { check(value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER), 'analysis_money_overflow'); return centsToNumber(value); };
const sum = values => values.reduce((n, value) => n + value, 0n);
const sameScope = (a, b) => ['enterpriseKey', 'accountSetId', 'databaseInstanceId', 'currency'].every(k => a?.[k] === b[k]);
const errorCode = error => /^[a-z][a-z0-9_]+$/.test(error?.code ?? '') ? error.code : 'analysis_native_material_unavailable';

/** Functions and the database are supplied only by the fixed local worker. */
export async function buildComprehensiveAnalysis({ db, incomeStatement, cashFlowStatement, scope, request, priorResult }) {
  check(/^20\d\d-(0[1-9]|1[0-2])$/.test(scope.period) && scope.currency === 'CNY', 'harness_period_mismatch');
  check(['enterpriseKey', 'accountSetId', 'databaseInstanceId'].every(k => request.target?.[k] === scope[k]), 'harness_target_mismatch');
  // Compare known bytes before parsing: malformed corrected material is a
  // proven change, not a transient failure that could revive an old approval.
  for (const binding of priorResult?.evidenceBindings ?? []) {
    if (hash((await readLocalFile(binding.path, 64 * 1024 * 1024)).bytes) !== binding.digest) return { status: 'analysis_dependencies_changed', businessProofCurrent: false, scope, periodComplete: false, submittable: false };
  }
  const periods = [...new Set([...(request.historyPeriods ?? []), scope.period])].sort();
  check(new Set(request.historyPeriods ?? []).size === (request.historyPeriods ?? []).length && periods.length <= 25 && periods.every(p => p <= scope.period && /^20\d\d-(0[1-9]|1[0-2])$/.test(p)), 'harness_period_mismatch');
  const source = openReadonlyLedgerSource(request.target.dbPath);
  try {
    const snapshot = captureLedgerSnapshot(source, { accountSetId: scope.accountSetId, enterpriseKey: scope.enterpriseKey, fromPeriod: periods[0], toPeriod: scope.period });
    const physical = statSync(request.target.dbPath, { bigint: true });
    const databaseIdentityDigest = hash([String(physical.dev), String(physical.ino), String(physical.birthtimeNs)]);
    check(snapshot.instance.instanceId === scope.databaseInstanceId, 'harness_instance_mismatch');
    check(periods.every(p => p >= snapshot.accountSet.start_period), 'harness_period_mismatch');
    const ledgerRef = { kind: 'source', locator: `${request.target.dbPath}#accountSet=${scope.accountSetId};through=${scope.period}`, digest: snapshot.contentDigest };
    const refs = [ledgerRef], findings = [], evidenceBindings = [], nativeWorkpapers = [], sessions = [], suppliedRefs = new Map();
    const saveBinding = binding => { if (!evidenceBindings.some(b => b.path === binding.path)) evidenceBindings.push(binding); };
    const add = (id, category, state, content, facts, evidenceRefs, uncertainties, suggestedActions, period = scope.period) => findings.push({
      id, category, state, scope: { ...scope, period }, content, facts, evidenceRefs,
      missingOrUncertain: uncertainties, suggestedActions,
      review: { status: 'pending', authority: 'current version-bound Harness task feedback; this embedded draft is immutable history' },
    });
    const reportEvidence = (period, kind, report) => ({ kind: 'artifact', locator: `native:${kind}:accountSet=${scope.accountSetId}:period=${period}`, digest: hash(report) });
    add('ledger-coverage', 'reminder', 'missing', '原生账簿可计算不证明业务资料完整、期初可靠或历史已核实。', { completeness: snapshot.completeness }, [ledgerRef], ['账外业务、期初及历史原件真实性尚待核实'], ['复用既有接手、材料与复核任务核实覆盖，登记所有相关任务依赖']);
    const sourceConflicts = snapshot.sources.checks.filter(c => !['matches_persisted_content', 'unverified'].includes(c.status) || c.batchAssociation !== 'registered');
    if (sourceConflicts.length || snapshot.completeness.moneyIssues.length || snapshot.completeness.unknownStatuses.length) add('ledger-conflicts', 'reminder', 'conflict', '原生账簿存在来源关联、金额或凭证状态疑点，相关分析仅供受限调查。',
      { sourceChecks: sourceConflicts, moneyIssues: snapshot.completeness.moneyIssues, unknownStatuses: snapshot.completeness.unknownStatuses }, [ledgerRef], ['有冲突部分未核实，不能以可计算报表消除冲突'], ['按原生来源/审计记录核实差异，补件或关联更正后重算']);
    const metrics = [];
    for (const period of periods) {
      if (!snapshot.periods.some(p => p.period === period)) {
        metrics.push({ period, status: 'missing', income: null, cashFlow: null });
        add(`period-${period}`, 'reminder', 'missing', '所选期间尚无原生期间记录，不能把缺期当作零业务。', { period }, [ledgerRef], ['缺该期间账务及资料覆盖'], ['核实启用及期间、补齐资料后重算'], period); continue;
      }
      const income = incomeStatement(scope.accountSetId, period), cashFlow = cashFlowStatement(scope.accountSetId, period);
      const ir = reportEvidence(period, 'incomeStatement', income), cr = reportEvidence(period, 'cashFlowStatement', cashFlow); refs.push(ir, cr);
      const complete = income.reportStatus?.complete === true;
      metrics.push({ period, status: complete ? 'available' : 'incomplete', income: complete ? income.current : null, cashFlow,
        reportStatus: income.reportStatus, unresolvedAmounts: income.unresolvedAmounts, evidenceRefs: [ir, cr] });
      if (!complete) add(`report-${period}`, 'reminder', 'unsupported', '原生利润表存在未映射、冲突或未支持金额，相关利润指标保持未知。', { reportStatus: income.reportStatus, unresolvedAmounts: income.unresolvedAmounts }, [ledgerRef, ir], ['不可用局部合计冒充完整利润'], ['查看原生诊断，核实科目口径及资料后重算'], period);
      const drafts = snapshot.vouchers.filter(v => v.period === period && v.status === 'draft');
      if (drafts.length) add(`drafts-${period}`, 'reminder', 'missing', '账内仍有未过账凭证，分析仅含已过账账务。', { voucherIds: drafts.map(v => v.id) }, [ledgerRef], ['未过账业务可能影响收入、成本、税费及现金'], ['复核草稿并通过既有凭证流程处理'], period);
      if (cashFlow.reportStatus?.complete !== true) add(`cash-${period}`, 'reminder', 'unsupported', '原生现金流分类不完整，未分类部分不能归零。', { diagnostics: cashFlow.diagnostics, unknown: cashFlow.unknown }, [ledgerRef, cr], ['现金流分类或复合凭证配对待核'], ['读取原生现金流详情并补充分配依据'], period);
    }
    const current = metrics.find(m => m.period === scope.period);
    const previous = metrics.filter(m => m.period < scope.period && m.status === 'available').at(-1);
    if (previous && current?.status === 'available') {
      const keys = ['营业收入', '营业成本', '利润总额', '净利润', '税金及附加', '所得税费用'];
      add('multi-period-change', 'risk_anomaly', 'observation', '多期账面变化需结合业务量、截止、税会口径和原件核实；变化本身不认定违法。',
        { comparisonPeriod: previous.period, changes: keys.map(key => ({ metric: key, previous: previous.income[key], current: current.income[key], difference: money(minor(current.income[key]) - minor(previous.income[key])) })) },
        [...previous.evidenceRefs, ...current.evidenceRefs, ledgerRef], ['仅比较已选且原生映射完整的月份；非完整年度或季节性判断', '账簿资料覆盖、原件真实性与来源冲突另见ledger-coverage/ledger-conflicts，不因此视为已核实完整业务'], ['调查较大变动的业务原因、跨期归属及支持原件']);
    } else add('history-gap', 'reminder', 'missing', '缺可比较的历史或当期完整利润表，多期趋势结论未形成。', { selectedPeriods: periods }, [ledgerRef], ['历史资料或报表支持不足'], ['补齐相关历史期间，或保留受限当期草稿']);

    let context = null, contextFile = null;
    if (request.contextPath) {
      contextFile = await readLocalFile(request.contextPath, 4 * 1024 * 1024); context = JSON.parse(contextFile.bytes.toString('utf8'));
      const problems = validateSchemaValue(ANALYSIS_CONTEXT_SCHEMA, context, { field: 'context' });
      if (problems.length) throw Object.assign(new Error('analysis_context_invalid'), { code: 'analysis_context_invalid', details: { problems } });
      check(sameScope(context.scope, scope) && context.scope.period === scope.period, 'harness_target_mismatch');
      saveBinding({ path: contextFile.canonicalPath, digest: hash(contextFile.bytes) });
      for (const [key, descriptors] of [...(context.collectionMappings ?? []).map((m, i) => [`collectionMappings/${i}`, m.sourceRefs]), ...(context.ownerPlan ? [['ownerPlan', context.ownerPlan.sourceRefs]] : [])]) {
        const originals = [];
        for (const descriptor of descriptors) {
          const file = await readLocalFile(descriptor.path, 64 * 1024 * 1024);
          check(file.canonicalPath !== contextFile.canonicalPath, 'analysis_context_original_required');
          const digest = hash(file.bytes); saveBinding({ path: file.canonicalPath, digest });
          originals.push({ kind: 'source', locator: `${file.canonicalPath}#${descriptor.locator}`, digest });
        }
        suppliedRefs.set(key, originals); refs.push(...originals);
      }
    }
    const contextRef = pointer => ({ kind: 'source', locator: `${contextFile.canonicalPath}#${pointer}`, digest: hash(contextFile.bytes) });
    // Only a simple, balanced bank debit/AR credit pair can be attributed here.
    // Mixed vouchers remain unexplained; no proportional or priority allocation.
    const posted = snapshot.vouchers.filter(v => v.status === 'posted' && v.kind !== 'carryforward');
    const bankDebit = v => sum(v.entries.filter(e => e.code.startsWith('1002')).map(e => minor(e.debit)));
    const arDebit = v => sum(v.entries.filter(e => e.code.startsWith('1122')).map(e => minor(e.debit)));
    const arCredit = v => sum(v.entries.filter(e => e.code.startsWith('1122')).map(e => minor(e.credit)));
    const isSimpleCollection = v => v.entries.length === 2 && bankDebit(v) > 0n && arCredit(v) === bankDebit(v) && v.entries.every(e => e.code.startsWith('1002') ? minor(e.credit) === 0n : e.code.startsWith('1122') && minor(e.debit) === 0n);
    const mappings = context?.collectionMappings ?? [], validMappings = [], invalidMappings = [];
    const assignedReceipt = new Map(), assignedOrigin = new Map();
    mappings.forEach((m, index) => {
      const receipt = posted.find(v => v.id === m.receiptVoucherId && v.period <= scope.period), origin = posted.find(v => v.id === m.originVoucherId && v.period < receipt?.period);
      const value = minor(m.amount), receiptSum = (assignedReceipt.get(m.receiptVoucherId) ?? 0n) + value, originSum = (assignedOrigin.get(m.originVoucherId) ?? 0n) + value;
      const valid = !!receipt && !!origin && isSimpleCollection(receipt) && value > 0n && receiptSum <= bankDebit(receipt) && originSum <= arDebit(origin);
      assignedReceipt.set(m.receiptVoucherId, receiptSum); assignedOrigin.set(m.originVoucherId, originSum);
      (valid ? validMappings : invalidMappings).push({ ...m, index, value, originPeriod: origin?.period ?? null });
    });
    if (invalidMappings.length) add('collection-conflict', 'reminder', 'conflict', '回款归属说明与实际凭证不符或重复超额，冲突金额不作为已解释历史回款。', { mappingIndexes: invalidMappings.map(m => m.index) }, [ledgerRef, ...invalidMappings.map(m => contextRef(`/collectionMappings/${m.index}`))], ['原始应收、回款金额、期间或配对有冲突'], ['补原始合同、发票、往来核销表及银行回单，逐笔核实']);
    // A conflicting group is excluded in full; no first-claim wins behavior.
    const conflictReceipts = new Set(invalidMappings.map(m => m.receiptVoucherId)), conflictOrigins = new Set(invalidMappings.map(m => m.originVoucherId));
    const acceptedMappings = validMappings.filter(m => !conflictReceipts.has(m.receiptVoucherId) && !conflictOrigins.has(m.originVoucherId));
    const currentReceipts = posted.filter(v => v.period === scope.period && bankDebit(v) > 0n);
    const grossBankBookReceipts = sum(currentReceipts.map(bankDebit));
    const mapped = acceptedMappings.filter(m => currentReceipts.some(v => v.id === m.receiptVoucherId));
    const historical = sum(mapped.map(m => m.value));
    const candidateAr = sum(currentReceipts.filter(isSimpleCollection).map(bankDebit)) - historical;
    const voucherRef = id => ({ kind: 'source', locator: `${request.target.dbPath}#vouchers/${id}/entries`, digest: hash(snapshot.vouchers.find(v => v.id === id)) });
    add('book-receipts', 'risk_anomaly', 'investigate', '账面银行收款不等于当期收入；历史应收回收、含税结算及其他资金往来须分别核实。不得仅因收款高于当期收入认定漏报。',
      { grossBankBookReceipts: money(grossBankBookReceipts), currentRevenue: current?.income?.营业收入 ?? null, sourceMappedHistoricalCollections: money(historical), unallocatedArCollectionCandidates: money(candidateAr), otherBookReceipts: money(grossBankBookReceipts - historical - candidateAr), mappings: mapped.map(({ value, ...m }) => m) },
      [ledgerRef, ...currentReceipts.map(v => voucherRef(v.id)), ...mapped.flatMap(m => [voucherRef(m.originVoucherId), contextRef(`/collectionMappings/${m.index}`), ...(suppliedRefs.get(`collectionMappings/${m.index}`) ?? [])])],
      ['映射仅证明所提供核销说明与账面金额相容；原件语义、真实性及银行对账仍待复核', '未分配应收候选及其他收款尚未解释，不按收款减收入推算漏报'], ['逐笔核对历史应收、含税金额、预收、借款及内部划转；未解释金额形成补件任务']);
    add('bank-coverage', 'reminder', 'missing', '本步骤资金分析读取账面凭证，银行账户全集、真实流水与对账完整性尚未核实。', { source: 'posted ledger entries only' }, [ledgerRef], ['未读取或验证原生银行对账、账户完整性'], ['复用既有银行对账工具核实真实资金；将相关当前任务纳入依赖']);

    for (const manifestPath of request.manifestPaths ?? []) {
      let session;
      try { session = loadAgencyMaterials(manifestPath); }
      catch (error) { return { status: 'blocked', applied: false, code: errorCode(error), periodComplete: false, submittable: false }; }
      check(sameScope(session.scope, scope) && periods.includes(session.scope.period), 'harness_target_mismatch');
      check(!nativeWorkpapers.some(w => w.scope.period === session.scope.period), 'harness_period_mismatch');
      sessions.push(session);
      for (const ref of session.sourceRefs) saveBinding({ path: ref.locator, digest: ref.digest });
      const workpaper = buildAgencyWorkpaper(session, { dbPath: request.target.dbPath }), document = readAgencySession(session);
      nativeWorkpapers.push(workpaper);
      const wr = { kind: 'artifact', locator: `${manifestPath}#native-workpaper`, digest: workpaper.contentDigest };
      refs.push(wr, ...workpaper.sourceRefs);
      add(`tax-${session.scope.period}`, 'risk_anomaly', 'observation', '原生税费底稿按义务保留应纳、计提、实缴及未支持状态；计算底稿不等于已申报或已缴。',
        { obligations: workpaper.obligations, ruleVersion: workpaper.ruleVersion, ruleCatalogDigest: workpaper.ruleCatalogDigest }, [wr, ...workpaper.sourceRefs], ['适用资格、地区条件及未完成义务以原生状态和具体issues为准'], ['读取相关义务依据与原生缺项，核实政策条件；正式处理走既有流程'], session.scope.period);
      for (const [index, issue] of workpaper.issues.entries()) add(`native-issue-${session.scope.period}-${index}`, 'reminder', /conflict|mismatch/.test(issue.code) ? 'conflict' : /unsupported|uncovered/.test(issue.code) ? 'unsupported' : 'missing', '原生核算或税费底稿保留未决问题。', { issue }, [wr, ...workpaper.sourceRefs], [issue.reason ?? issue.code ?? '原生资料或规则未支持'], ['根据原生问题补件、核验条件，重算受影响分支'], session.scope.period);
      const actual = metrics.find(m => m.period === session.scope.period);
      const expected = workpaper.accounting.reports.incomeStatement;
      const actualReport = actual?.status === 'available' ? incomeStatement(scope.accountSetId, session.scope.period) : null;
      const ytdStart = snapshot.accountSet.start_period > `${session.scope.period.slice(0, 4)}-01` ? snapshot.accountSet.start_period : `${session.scope.period.slice(0, 4)}-01`;
      const comparisonReady = workpaper.coverageVerified && workpaper.accounting.status === 'draft' && !(workpaper.accounting.unresolvedTaxDependencies?.length) && workpaper.accounting.replayFrom === ytdStart && expected.complete && actualReport?.reportStatus.complete;
      if (comparisonReady) {
        const expectedMinor = expected.rows.find(r => r.id === 'total-profit')?.valueMinor, actualMinor = actualReport.rows.ytd.find(r => r.id === 'total-profit')?.valueMinor;
        if (Number.isSafeInteger(expectedMinor) && Number.isSafeInteger(actualMinor) && expectedMinor !== actualMinor) add(`profit-difference-${session.scope.period}`, 'anomaly_response', 'investigate', '原件重放利润与已过账账簿同期累计利润存在真实金额差异，需调查归属和漏记/重复/未入账方案。',
          { rawReplayProfitBeforeTax: money(BigInt(expectedMinor)), ledgerYearToDateProfitBeforeTax: money(BigInt(actualMinor)), unexplainedDifference: money(BigInt(expectedMinor) - BigInt(actualMinor)), replayFrom: workpaper.accounting.replayFrom },
          [wr, ledgerRef, ...workpaper.sourceRefs], ['差额原因尚未证明；原件覆盖声明仍需人工核实；会计调整和申报更正分开'], ['核对原件与凭证逐笔映射', '补充未匹配合同、履约、票据及调整记录', '可选：补件重算；经复核准备关联更正；保留争议金额，不自动写账'], session.scope.period);
      } else add(`comparison-gap-${session.scope.period}`, 'reminder', 'missing', '原件重放或账簿存在未决金额、覆盖或口径缺项，完整利润差额未形成。',
        { rawAccountingStatus: workpaper.accounting.status, rawCoverageVerified: workpaper.coverageVerified, unresolvedTaxDependencies: workpaper.accounting.unresolvedTaxDependencies ?? null, replayFrom: workpaper.accounting.replayFrom, ledgerYearToDateStart: ytdStart, rawReportComplete: expected.complete, ledgerReportStatus: actualReport?.reportStatus ?? null, unexplainedDifference: null },
        [wr, ledgerRef, ...workpaper.sourceRefs], ['不能用原件局部合计或缺项零值冒充完整差额'], ['先解决原生核算/税费依赖、覆盖及同口径问题，再比较完整差额'], session.scope.period);
      const invoiceRecords = document.records.filter(r => r.date.slice(0, 7) === session.scope.period && (r.invoiceKind !== undefined || r.invoiceNumber !== undefined));
      add(`invoice-${session.scope.period}`, 'risk_anomaly', 'observation', '发票及跨期线索按原始业务事实与原生合同状态展示；开票不自动等于履约或当期收入。',
        { invoiceRelatedFactIds: invoiceRecords.map(r => r.id), contractState: workpaper.accounting.contractState, crossPeriodSourceVoucherIds: workpaper.accounting.historicalVouchers.map(v => ({ sourceVoucherId: v.sourceVoucherId, period: v.period })) },
        [wr, ...invoiceRecords.flatMap(r => r.sourceRefs), ...workpaper.sourceRefs], ['仅覆盖已提供原件及现有规则；未实现全国发票真伪查验或全部票账匹配'], ['核对履约、开票、收款时点，调查未开票及跨期事项'], session.scope.period);
    }
    if (!nativeWorkpapers.some(w => w.scope.period === scope.period)) add('tax-invoice-gap', 'reminder', 'missing', '未提供当期可重放原件底稿，发票、税费及业务跨期资料无法完整分析。', { supportedInput: 'existing agency-business-materials/1 manifests' }, [ledgerRef], ['缺原件覆盖、发票事实、历史申报缴款及适用政策条件'], ['复用现有原件/税费能力补齐底稿；其他未支持行业税种明确保留unsupported']);
    (context?.reminders ?? []).forEach((reminder, i) => {
      check(periods.includes(reminder.period), 'harness_period_mismatch');
      add(`supplied-reminder-${i}`, 'reminder', reminder.kind, reminder.content, { dueDate: reminder.dueDate ?? null, suppliedStatement: true }, [contextRef(`/reminders/${i}`)], ['所提供事项及截止日尚待会计核实；不自动推定现行政策'], [reminder.requestedEvidence], reminder.period);
    });

    if (context?.ownerPlan) {
      const plan = context.ownerPlan; check(plan.futurePeriod > scope.period, 'harness_period_mismatch');
      const scenarioResults = plan.scenarios.map((scenario, index) => {
        const byOrigin = new Map(); scenario.collections.forEach(c => byOrigin.set(c.originVoucherId, (byOrigin.get(c.originVoucherId) ?? 0n) + minor(c.amount)));
        const lines = [...byOrigin].map(([id, wanted]) => {
          const origin = posted.find(v => v.id === id && v.period <= scope.period);
          const mappedCollections = sum(acceptedMappings.filter(m => m.originVoucherId === id).map(m => m.value));
          const available = origin ? arDebit(origin) - mappedCollections : null;
          // No unallocated AR credit may be silently assumed to settle another
          // debt. A remaining unallocated credit blocks this narrow projection.
          const unallocatedCredits = sum(posted.filter(v => v.period <= scope.period).map(arCredit)) - sum(acceptedMappings.map(m => m.value));
          const usable = !!origin && wanted > 0n && available !== null && wanted <= available && unallocatedCredits === 0n && !conflictOrigins.has(id);
          return { originVoucherId: id, requestedCollection: money(wanted), availableBookClaim: available === null ? null : money(available), status: usable ? 'conditional' : 'conflict_or_missing', evidenceRefs: origin ? [voucherRef(id)] : [] };
        });
        const ready = lines.every(l => l.status === 'conditional');
        return { name: scenario.name, status: ready ? 'conditional' : 'conflict_or_missing', lines,
          incrementalCashInflow: ready ? money(sum([...byOrigin.values()])) : null,
          incrementalAccrualRevenue: ready ? 0 : null, incrementalAccrualProfitBeforeTax: ready ? 0 : null,
          taxImpact: { status: 'unsupported', amount: null, reason: 'Receipt timing, original tax point, exemptions and prior declaration/payment evidence are not validated by this collection-only model.' },
          cashAfterTax: null, evidenceRefs: [contextRef(`/ownerPlan/scenarios/${index}`), ...lines.flatMap(l => l.evidenceRefs)] };
      });
      add('owner-collection-plan', 'operating_plan', scenarioResults.every(s => s.status === 'conditional') ? 'conditional' : 'conflict', '比较老板提出的已有应收回收方案：仅计算约定回款现金流与权责发生口径增量，税费影响未支持。',
        { providedBy: plan.providedBy, owner: plan.owner, futurePeriod: plan.futurePeriod, assumptions: plan.assumptions, scenarios: scenarioResults },
        [contextRef('/ownerPlan'), ...(suppliedRefs.get('ownerPlan') ?? []), ledgerRef, ...scenarioResults.flatMap(s => s.evidenceRefs)],
        ['providedBy及原文引用不证明真实老板授权或语义正确，原始计划及提取仍需人工核实', '仅适用于已确认应收本金回收，假设无折扣、坏账转回、利息、外汇及新增履约；这些适用条件须核实', '不预测其他未来业务；税费、税后现金和完整经营预算未支持'],
        ['核实合同回款承诺及客户信用、未收余额', '按现金需求选择可实现方案；确认实际税点与历史申报后另走现有税费核算', '不得为目标税负虚构业务或倒推账目']);
    } else add('owner-plan-gap', 'reminder', 'missing', '尚无老板提供的未来方案与明确假设，不生成经营规划结论。', { required: 'ownerPlan with explicit future period, assumptions and at least two actual proposed collection scenarios' }, [ledgerRef], ['缺老板计划；其他类型经营/税务规划一期未支持'], ['在老板提供真实计划后比较可分析部分']);
    // Material response suggestions are tied to each finding, not a blanket
    // declaration of wrongdoing or a fabricated final treatment decision.
    for (const finding of findings.filter(f => f.state === 'investigate')) finding.responseOptions = {
      existingBasis: finding.evidenceRefs, unresolvedQuestions: finding.missingOrUncertain,
      requestedEvidence: ['相关合同/履约、票据、银行回单和往来核销明细'], optionalSteps: finding.suggestedActions,
    };
    check(validateLedgerSnapshot(source, snapshot).status === 'current', 'analysis_ledger_changed_during_read');
    for (const session of sessions) assertAgencyEvidenceCurrent(session);
    for (const binding of evidenceBindings) check(hash((await readLocalFile(binding.path, 64 * 1024 * 1024)).bytes) === binding.digest, 'analysis_source_changed_during_read');
    const dependencyBinding = { ledgerDigest: snapshot.contentDigest, databaseIdentityDigest, evidenceBindings, workpapers: nativeWorkpapers.map(w => ({ scope: w.scope, dependencyDigest: w.dependencyDigest, contentDigest: w.contentDigest, ruleVersion: w.ruleVersion, ruleCatalogDigest: w.ruleCatalogDigest })) };
    return { status: 'analysis_draft', version: ANALYSIS_VERSION, scope, selectedPeriods: periods, metrics, findings,
      evidenceRefs: refs, evidenceBindings, dependencyBinding, dependencyDigest: hash(dependencyBinding),
      coverage: { accounting: 'posted native mapped reports only', cash: 'book entries; real bank reconciliation unverified', invoicesAndTaxes: nativeWorkpapers.length ? 'provided existing agency workpapers only' : 'missing', planning: context?.ownerPlan ? 'conditional existing receivable collection only; tax impact unsupported' : 'missing', completeness: snapshot.completeness },
      reviewState: 'pending', periodComplete: false, submittable: false, formalActionsPerformed: false };
  } finally { source.close(); }
}
