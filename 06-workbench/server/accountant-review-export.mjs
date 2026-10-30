// 本机独占发布多个文件；只有最后写入完整 manifest 才标记成功。
import ExcelJS from 'exceljs';
import { mkdir, open, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { hash, requireValue } from './offline-material-adapters.mjs';
import { assertAccountantReviewCurrent } from './accountant-review.mjs';

const reference = p => /^(?:bundle|manifest)\.json#/.test(p) ? p : `bundle.json#${p}`;
const pointer = s => String(s).replaceAll('~', '~0').replaceAll('/', '~1');
const display = v => v === null ? 'NULL（未计算/未知）' : v === undefined ? '未提供' : typeof v === 'object' ? JSON.stringify(v) : String(v);
const minorText = n => { if (n === null || n === undefined) return null; const i = BigInt(n), a = i < 0n ? -i : i; return `${i < 0n ? '-' : ''}${a / 100n}.${String(a % 100n).padStart(2, '0')}`; };
function leaves(value, base, emit) {
  if (value === null || typeof value !== 'object') { emit(base, value, value === null ? 'null' : typeof value); return; }
  const entries = Object.entries(value);
  if (!entries.length) emit(base, Array.isArray(value) ? '[]' : '{}', Array.isArray(value) ? 'empty_array' : 'empty_object');
  for (const [key, child] of entries) leaves(child, `${base}/${pointer(key)}`, emit);
}
export async function buildAccountantReviewWorkbook(bundle, { inputSession } = {}) {
  const localFiles = await assertAccountantReviewCurrent(bundle, inputSession);
  const workbook = await renderAccountantReviewDiagnosticWorkbook(bundle, localFiles);
  await assertAccountantReviewCurrent(bundle, inputSession);
  return { ...workbook, localFiles };
}
// 仅供展示：接收公开数据和清单，不授予发布能力。
export async function renderAccountantReviewDiagnosticWorkbook(bundle, localFiles = []) {
  const book = new ExcelJS.Workbook(); book.creator = '本机会计复核草稿';
  const diagnostics = [];
  function sheet(name, headers, widths) {
    const ws = book.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = headers.map((h, i) => ({ header: h, width: widths?.[i] ?? 30 }));
    ws.getRow(1).font = { bold: true }; ws.autoFilter = { from: 'A1', to: { row: 1, column: headers.length } };
    return (values, paths = []) => {
      requireValue(ws.rowCount < 1048576, 'review_excel_row_limit');
      const safe = values.map((v, i) => {
        const text = display(v), p = paths[i];
        if (text.length > 32767 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(text)) {
          requireValue(typeof p === 'string' && p.length < 30000, 'review_excel_reference_missing');
          const reason = text.length > 32767 ? 'excel_cell_text_limit' : 'excel_xml_control_character';
          diagnostics.push({ reason, pointer: p, length: text.length, sheet: name, row: ws.rowCount + 1, column: i + 1 });
          return `[完整内容见 ${reference(p)}；${reason}；长度=${text.length}]`;
        }
        return text;
      });
      const row = ws.addRow(safe);
      row.eachCell(cell => { cell.numFmt = '@'; cell.alignment = { vertical: 'top', wrapText: true }; });
    };
  }
  const overview = sheet('概览', ['项目', '值', 'JSON 定位'], [34, 90, 55]);
  overview(['会计复核草稿', '未登录税局；未提交/缴款；未获会计确认；非整期完成', '/pending']);
  overview(['状态对照', 'provided_valid=结构有效；missing=缺失；unknown=未知；conflict=冲突；provided_invalid=无效；unsupported=不支持；not_applicable=不适用；computed=已算；blocked=阻断；not_computed=未算。原材料有效不代表会计确认。', '']);
  overview(['草稿标识的含义', 'contentDigest仅用于本机版本比对，非身份认证、会计确认或执行授权', '/contentDigest']);
  for (const key of ['version', 'kind', 'scope', 'status', 'accountantApproval', 'confirmationStatus', 'periodComplete', 'submittable', 'sourceAuthenticity', 'authorizesExecution', 'freshness', 'contentDigest', 'limitations']) overview([key, bundle[key], '/' + key], ['', '/' + key]);
  for (const key of ['version', 'inputHash', 'ruleVersion', 'ruleDigest', 'ledgerSnapshotDigest']) overview(['计算版本：' + key, bundle.computation[key], '/computation/' + key]);
  overview(['输入文件实际重验', localFiles.length ? '发布前重读原文件/store/账库；只代表该时点' : '仅调用者原始内存输入及私有账库；没有文件读取保证', '']);
  overview(['选定范围', bundle.reviewScopeDescription ?? '2026Q1新设首期季度小规模企业；普通境内服务；仅服务列1/2/3/15/16/20/21/22；其余未算；21/22累计不适用', '/computation/rules/engineeringScope']);
  const completeness = sheet('材料完整性', ['材料/资格项目', '原材料质量状态', '原因', '需补原始事实/可接受材料', '范围/依据', 'JSON 定位'], [48, 28, 65, 100, 90, 60]);
  function materialRequest(row, period = 'target') {
    const original = { requestedFields: row.requestedFields ?? [], acceptedMaterials: row.acceptedMaterials, alternativeEvidence: row.alternativeEvidence ?? [] };
    if (bundle.version !== 'offline-accountant-review-q2/1' || period !== 'target' || !['opening', 'history'].includes(row.id)) return original;
    const bridge = bundle.computation.historyBridge;
    const explained = bridge?.priorAccountingExplained === true && bridge.proof?.status === 'current' && bridge.proof?.relationship === 'same_held_readonly_source_same_capture';
    return explained ? { originalMaterialQualityStatus: row.status, actualDependencyStatus: 'actual_Q1_originals_and_ledger_explained', customerSupplementRequired: false, explanation: '本次Q1原件与账务已解释，不重复补交；不证明已结账/申报/缴款。原acceptedMaterials完整保留JSON。', historyBridgePointer: '/computation/historyBridge', originalRequestPointer: `/periodEvidence/target/materials/rows/${bundle.periodEvidence.target.materials.rows.findIndex(r => r.id === row.id)}` }
      : { ...original, actualDependencyStatus: 'not_explained', historyBridgeStatus: bridge?.status ?? 'unknown', explanation: '本次历史依赖未获实际解释，继续核对所列具体原始资料及异常；账库/工程问题由操作者处理，不要求客户预制账或税。', historyBridgePointer: '/computation/historyBridge' };
  }
  bundle.materials.rows.forEach((row, i) => { const p = `/materials/rows/${i}`; completeness([row.subject ?? row.id, row.status, row.reason, materialRequest(row), { id: row.id, expectedCoverage: row.expectedCoverage, inputs: row.inputs, evidenceLevel: row.evidenceLevel }, p], [p + '/subject', '', p + '/reason', p, p]); });
  for (const key of ['declaration', 'replayIssues']) leaves(bundle.materials[key], '/materials/' + key, (p, v) => completeness([p, key === 'declaration' ? '原始声明（待会计复核）' : '重放诊断', '', v, '', p], [p, '', '', p]));
  const fields = sheet('申报字段', ['行', '字段名称', '列', '期间', '状态', '金额（元，文本）', '整数分', '计算节点', '规则原文URL', '依据', 'JSON 定位'], [8, 38, 15, 18, 23, 24, 22, 25, 70, 55, 48]);
  bundle.computation.cells.forEach((c, i) => {
    const p = `/computation/cells/${i}`, rule = bundle.computation.rules.selectedRows[c.row];
    const urls = (c.ruleReferences?.sources ?? []).map(id => bundle.computation.rules.sources[id]?.url).filter(Boolean);
    if (c.ruleReferences?.url) urls.push(c.ruleReferences.url);
    fields([c.row, rule?.meaning ?? '本片未计算字段', c.column, c.period, c.status, c.status === 'not_applicable' ? '不适用（NA，官方横杠）' : c.value, c.status === 'not_applicable' ? '不适用（NA）' : c.minor, c.calculationNode, urls.join('\n'), c.basis, p], ['', '', '', '', '', p + '/value', p + '/minor', '', '', p + '/basis']);
  });
  const calculations = sheet('计算及调整', ['类别', '节点/业务', '金额（元，文本）', '整数分', '公式/依赖/证据', '规则URL', 'JSON 定位'], [24, 45, 26, 22, 100, 70, 65]);
  bundle.computation.calculationNodes.forEach((n, i) => { const p = `/computation/calculationNodes/${i}`; calculations(['计算节点', n.id, minorText(n.minor), n.minor, n, n.ruleSources.map(id => bundle.computation.rules.sources[id].url).join('\n'), p], ['', '', p + '/minor', p + '/minor', p]); });
  bundle.computation.sales.forEach((sale, i) => {
    for (const key of ['revenueNetMinor', 'initialLedgerVatMinor', 'taxableBaseMinor', 'adjustmentMinor']) { const p = `/computation/sales/${i}/${key}`; calculations([key, sale.businessKey, minorText(sale[key]), sale[key], { voucherId: sale.voucherId, entries: sale.entries.map(e => e.entryId), basis: sale.noAdjustmentBasis }, '', p], ['', '', p, p, `/computation/sales/${i}`]); }
  });
  const sources = sheet('原始来源及凭证索引', ['证据字段/来源', '类型', '原值/定位', 'JSON 定位'], [66, 20, 110, 80]);
  const evidence = { materialSources: bundle.materials.sources, materialRecords: bundle.materials.records, accountingFacts: bundle.materials.accountingFacts, taxFacts: bundle.materials.taxFacts, ledgerSnapshot: bundle.ledgerSnapshot, reconciledBusinesses: bundle.computation.reconciledBusinesses, sales: bundle.computation.sales, rules: bundle.computation.rules };
  const bases = { materialSources: '/materials/sources', materialRecords: '/materials/records', accountingFacts: '/materials/accountingFacts', taxFacts: '/materials/taxFacts', ledgerSnapshot: '/ledgerSnapshot', reconciledBusinesses: '/computation/reconciledBusinesses', sales: '/computation/sales', rules: '/computation/rules' };
  for (const [key, value] of Object.entries(evidence)) leaves(value, bases[key], (p, v, type) => sources([p, type, v, p], [p, '', p]));
  localFiles.forEach((f, i) => { const p = f.manifestPointer ? `manifest.json#${f.manifestPointer}` : `manifest.json#/inputFiles/${i}`; sources([f.sourceId ? `原始材料：${f.sourceId}` : '本机loader实际读取文件', f.kind ?? 'local_file', f, p], ['', '', p]); });
  const exceptions = sheet('异常', ['分类', '代码', '字段', '状态', '需补原始事实', 'JSON 定位'], [22, 50, 50, 22, 100, 50]);
  bundle.exceptions.forEach((e, i) => exceptions([e.classification, e.code, e.field, e.status, e.requestedFact, `/exceptions/${i}`], ['', '', `/exceptions/${i}/field`, '', `/exceptions/${i}/requestedFact`]));
  if (!bundle.exceptions.length) exceptions(['无已识别税算异常', '仍待会计复核', '', 'pending', '不证明原件真实性或整期完成', '/pending']);
  const pending = sheet('待确认', ['项目', '状态', '字段', '分类', '会计待办', 'JSON 定位'], [55, 20, 50, 20, 100, 50]);
  bundle.pending.forEach((v, i) => pending([v.code, v.state, v.field, v.classification, v.request, `/pending/${i}`], ['', '', `/pending/${i}/field`, '', `/pending/${i}/request`]));
  if (bundle.version === 'offline-accountant-review-q2/1') {
    overview(['Q2历史桥解释（原材料质量状态保持原值）', bundle.computation.historyBridge, '/computation/historyBridge'], ['', '/computation/historyBridge']);
    completeness(['原材料状态与实际历史解释并列', '原材料质量状态保持原值', '', bundle.historyBridgeResolution, '', '/historyBridgeResolution'], ['', '', '', '/historyBridgeResolution']);
    for (const [period, packet] of Object.entries(bundle.periodEvidence)) {
      packet.materials.rows.forEach((r, i) => { const p = `/periodEvidence/${period}/materials/rows/${i}`; completeness([`${period}:${r.subject ?? r.id}`, r.status, r.reason, materialRequest(r, period), period, p], [p, '', p, p]); });
      leaves(packet, `/periodEvidence/${period}`, (p, v, type) => sources([p, type, v, p], [p, '', p]));
    }
    bundle.priorComputation.cells.forEach((c, i) => {
      const p = `/priorComputation/cells/${i}`;
      const urls = (c.ruleReferences?.sources ?? []).map(id => bundle.priorComputation.rules.sources[id]?.url).filter(Boolean);
      if (c.ruleReferences?.url) urls.push(c.ruleReferences.url);
      fields([c.row, bundle.priorComputation.rules.selectedRows[c.row]?.meaning ?? '未计算字段', c.column, `Q1:${c.period}`, c.status, c.status === 'not_applicable' ? '不适用（NA）' : c.value, c.status === 'not_applicable' ? '不适用（NA）' : c.minor, c.calculationNode, urls.join('\n'), c.basis, p], ['', '', '', '', '', p + '/value', p + '/minor', '', '', p + '/basis']);
    });
    bundle.priorComputation.calculationNodes.forEach((n, i) => { const p = `/priorComputation/calculationNodes/${i}`; calculations(['Q1计算节点', n.id, minorText(n.minor), n.minor, n, n.ruleSources.map(id => bundle.priorComputation.rules.sources[id].url).join('\n'), p], ['', '', p, p, p]); });
    leaves(bundle.priorComputation, '/priorComputation', (p, v, type) => sources([p, type, v, p], [p, '', p]));
    leaves(bundle.computation.historyBridge, '/computation/historyBridge', (p, v, type) => completeness([p, '实际Q1历史桥解释；不改原材料质量状态', '', v, '', p], [p, '', '', p]));
  }
  for (const d of diagnostics) exceptions(['导出显示界限', d.reason, `${d.sheet}!R${d.row}C${d.column}`, 'see_json', `完整原文在 ${reference(d.pointer)}；长度=${d.length}`, d.pointer]);
  const bytes = Buffer.from(await book.xlsx.writeBuffer());
  return { bytes, diagnostics };
}
async function writeExclusive(path, bytes) {
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}
export async function exportAccountantReview(bundle, outputDirectory, { inputSession } = {}) {
  await assertAccountantReviewCurrent(bundle, inputSession);
  // 建目录前先渲染，防止渲染失败留下部分发布成果。
  const workbook = await buildAccountantReviewWorkbook(bundle, { inputSession });
  const directory = resolve(outputDirectory);
  await mkdir(directory, { mode: 0o700 }); // EEXIST 始终视为错误，即使现有目录为空。
  const json = Buffer.from(JSON.stringify(bundle, null, 2) + '\n', 'utf8');
  const files = [{ name: 'bundle.json', bytes: json }, { name: 'workpaper.xlsx', bytes: workbook.bytes }];
  for (const f of files) await writeExclusive(join(directory, f.name), f.bytes);
  const inputFiles = await assertAccountantReviewCurrent(bundle, inputSession);
  const manifest = { version: 'offline-accountant-review-manifest/1', status: 'complete_draft', accountantApproval: 'pending', submittable: false, authorizesExecution: false,
    bundleDigest: bundle.contentDigest, freshness: inputFiles.length ? 'actual_files_store_and_private_ledger_rechecked_before_publication' : 'in_memory_raw_input_and_private_ledger_only',
    files: files.map(f => ({ name: f.name, sha256: hash(f.bytes), bytes: f.bytes.length })), inputFiles, displayDiagnostics: workbook.diagnostics,
    meaning: 'local_file_completeness_only_not_authentication_or_accountant_approval' };
  // 写文件后发生错误时保留诊断目录，不留下成功标记。
  // manifest 写入、同步或关闭失败时，只移除本次自有文件，不删除既有文件。
  let owned = false;
  try {
    const handle = await open(join(directory, 'manifest.json'), 'wx', 0o600); owned = true;
    try { await handle.writeFile(JSON.stringify(manifest, null, 2) + '\n'); await handle.sync(); } finally { await handle.close(); }
  } catch (e) { if (owned) await unlink(join(directory, 'manifest.json')); throw e; }
  return manifest;
}
