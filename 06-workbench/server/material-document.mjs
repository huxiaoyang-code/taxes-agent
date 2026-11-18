// 原件通用只读入口：本机保留原值，模型只拿结构和可回到原件的位置。
import { readFileSync, lstatSync, realpathSync, openSync, fstatSync, closeSync, existsSync } from 'node:fs';
import { dirname, resolve, relative, isAbsolute, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { parseEvidenceCsv } from './business-evidence.mjs';

const VERSION = 'finance-material-document/1';
const ROOT = dirname(fileURLToPath(import.meta.url));
const MAX_BYTES = 5 * 1024 * 1024;
const FORMATS = ['json', 'csv', 'xls', 'xlsx', 'pdf', 'txt', 'md', 'docx', 'png', 'jpg', 'jpeg', 'tif', 'tiff', 'bmp', 'webp'];
const NATIVE_FORMATS = ['json', 'csv', 'txt', 'md'];
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const scalarType = value => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
const escaped = value => value.replaceAll('~', '~0').replaceAll('/', '~1');
const within = (root, path) => { const part = relative(resolve(root), resolve(path)); return !!part && !isAbsolute(part) && part !== '..' && !part.startsWith('../') && !part.startsWith('..\\'); };

function sourceBytes(path, sourceRoot) {
  if (typeof path !== 'string' || !isAbsolute(path) || typeof sourceRoot !== 'string' || !isAbsolute(sourceRoot) || !within(sourceRoot, path)) fail('material_document_source_forbidden');
  const full = resolve(path);
  for (let current = full; ; current = dirname(current)) {
    if (lstatSync(current).isSymbolicLink()) fail('material_document_source_forbidden');
    if (current === dirname(current)) break;
  }
  const before = lstatSync(full);
  if (!before.isFile() || before.nlink !== 1 || before.size > MAX_BYTES || realpathSync(full).toLowerCase() !== full.toLowerCase()) fail('material_document_source_forbidden');
  const handle = openSync(full, 'r');
  try {
    const started = fstatSync(handle), bytes = readFileSync(handle), ended = fstatSync(handle);
    if (started.ino !== before.ino || started.dev !== before.dev || started.nlink !== 1 || started.size !== ended.size || started.mtimeMs !== ended.mtimeMs || bytes.length !== started.size) fail('material_document_source_changed');
    return bytes;
  } finally { closeSync(handle); }
}

function runtimeOption(options, name) { return options?.[name] ?? options?.materialRuntime?.[name]; }

function environment(options = {}) {
  const env = { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };
  for (const name of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'PATH']) if (process.env[name]) env[name] = process.env[name];
  const packagePaths = runtimeOption(options, 'pythonPackagePaths'), userBase = runtimeOption(options, 'pythonUserBase');
  // 计算子进程仅接收父进程装配的包位置，不为导入依赖恢复整个用户环境。
  if (packagePaths !== undefined) {
    if (!Array.isArray(packagePaths) || packagePaths.length > 16 || packagePaths.some(path => typeof path !== 'string' || !isAbsolute(path) || path.includes(process.platform === 'win32' ? ';' : ':'))) fail('material_document_runtime_invalid');
    env.PYTHONPATH = packagePaths.join(process.platform === 'win32' ? ';' : ':');
  }
  if (userBase !== undefined) {
    if (typeof userBase !== 'string' || !isAbsolute(userBase)) fail('material_document_runtime_invalid');
    env.PYTHONUSERBASE = userBase;
  }
  // 普通宿主自动发现保留现有用户包定位；受信 descriptor 存在时不继承 APPDATA。
  if (packagePaths === undefined && userBase === undefined && process.env.APPDATA) env.APPDATA = process.env.APPDATA;
  return env;
}

function pythonCommand(options) {
  const configured = runtimeOption(options, 'pythonPath') ?? process.env.FINANCE_PYTHON_PATH;
  if (configured) {
    if (!isAbsolute(configured) || !existsSync(configured) || !lstatSync(configured).isFile()) return null;
    return { program: configured, prefix: [] };
  }
  // Windows Python 启动器只选择已安装运行时；不安装依赖或下载模型。
  const launcher = process.platform === 'win32' && process.env.SystemRoot ? join(process.env.SystemRoot, 'py.exe') : null;
  if (launcher && existsSync(launcher)) return { program: launcher, prefix: ['-3'] };
  for (const directory of (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')) {
    for (const name of process.platform === 'win32' ? ['python.exe'] : ['python3', 'python']) {
      const path = join(directory, name);
      if (isAbsolute(path) && existsSync(path) && lstatSync(path).isFile()) return { program: path, prefix: [] };
    }
  }
  return null;
}

function pythonRead(request, options) {
  const python = pythonCommand(options);
  if (!python) return { status: 'needs_runtime', error: 'material_document_python_required' };
  const execution = spawnSync(python.program, [...python.prefix, '-B', join(ROOT, 'material-document-reader.py')], {
    input: JSON.stringify(request), encoding: 'utf8', windowsHide: true, shell: false, env: environment(options), timeout: 30000, maxBuffer: 16 * 1024 * 1024,
  });
  if (execution.error || execution.status !== 0) return { status: 'needs_runtime', error: execution.error?.code === 'ETIMEDOUT' ? 'material_document_timeout' : 'material_document_python_unavailable' };
  try { return JSON.parse(execution.stdout); } catch { return { status: 'unsupported', error: 'material_document_reader_invalid' }; }
}

function windowsOcr(request) {
  if (process.platform !== 'win32' || !process.env.SystemRoot) return { status: 'needs_runtime', error: 'ocr_runtime_unavailable' };
  const program = join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  if (!existsSync(program)) return { status: 'needs_runtime', error: 'ocr_runtime_unavailable' };
  const script = readFileSync(join(ROOT, 'material-document-ocr.ps1'), 'utf8');
  const execution = spawnSync(program, ['-NoProfile', '-NonInteractive', '-Command', script], {
    input: JSON.stringify(request), encoding: 'utf8', windowsHide: true, shell: false, env: environment(), timeout: 20000, maxBuffer: 4 * 1024 * 1024,
  });
  if (execution.error || execution.status !== 0) return { status: 'needs_runtime', error: 'ocr_runtime_unavailable' };
  try { return JSON.parse(execution.stdout.replace(/^\uFEFF/, '').trim()); } catch { return { status: 'needs_runtime', error: 'ocr_runtime_unavailable' }; }
}

export function materialDocumentCapabilities(options = {}) {
  const python = pythonRead({ operation: 'capabilities' }, options), ocr = windowsOcr({ operation: 'capabilities' });
  const packages = python.packages ?? {};
  return {
    version: VERSION, python: { status: python.status, ...(python.executable ? { executable: python.executable, version: python.python } : { code: python.error }) },
    ocr: { status: ocr.status, id: 'windows-media-ocr', languages: ocr.languages ?? [], ...(ocr.error ? { code: ocr.error } : {}) },
    formats: Object.fromEntries(FORMATS.map(format => [format, NATIVE_FORMATS.includes(format) ? 'available' : ['png', 'jpg', 'jpeg', 'tif', 'tiff', 'bmp', 'webp'].includes(format) ? packages.images && ocr.status === 'available' ? 'available' : 'needs_runtime' : packages[format] ? 'available' : 'needs_runtime'])),
  };
}

function decodeText(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return { text: new TextDecoder('utf-16le', { fatal: true }).decode(bytes.subarray(2)), encoding: 'utf-16le' };
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return { text: new TextDecoder('utf-16be', { fatal: true }).decode(bytes.subarray(2)), encoding: 'utf-16be' };
  try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, ''), encoding: 'utf-8' }; }
  catch { return { text: new TextDecoder('gb18030', { fatal: true }).decode(bytes), encoding: 'gb18030' }; }
}

function fieldReference(source, locator) { return 'md:' + hash(JSON.stringify([source.sha256, locator])); }

function splitValueSpan(block) {
  const explicit = /^\s*([^:：\t]{1,80})\s*[:：\t]\s*(\S[\s\S]*)$/.exec(block.text);
  const split = explicit
    ?? /^\s*([\p{L}][\p{L}\s_（）()%％\/／-]{0,79}?)\s+([+\-]?[\d０-９][\d０-９\s.,．，/:：\-年月日%％]*)\s*$/u.exec(block.text);
  if (!split) return null;
  const label = structuralLabel(split[1]);
  if (!label) return null;
  const start = block.text.length - split[2].length;
  return { locator: { page: block.page, line: block.line, start, end: block.text.length }, label, explicit: !!explicit };
}

function documentValueSpans(document) {
  const candidates = document.blocks.map(block => ({ block, span: splitValueSpan(block) })).filter(item => item.span);
  const pageAnchors = new Map();
  for (const { block, span } of candidates) {
    if (!fieldLabel(span.label)) continue;
    if (!pageAnchors.has(block.page)) pageAnchors.set(block.page, new Set());
    pageAnchors.get(block.page).add(span.label);
  }
  // 多个字段式锚点证明同页键值表形；其余原始键名无需命中业务词表。
  return new Map(candidates.filter(({ block, span }) => fieldLabel(span.label) || span.explicit && (pageAnchors.get(block.page)?.size ?? 0) >= 2).map(({ block, span }) => [block, span]));
}

function attachLocations(document) {
  const locations = new Map();
  document.valueStates = new Map((document.cellStates ?? []).map(cell => [JSON.stringify([cell.sheetIndex, cell.row, cell.column]), cell.state]));
  const add = locator => { if (locations.size >= 100000) fail('material_document_limit'); locations.set(fieldReference(document.source, locator), locator); };
  const walk = (value, pointer = '', depth = 0) => {
    if (depth > 24 || locations.size > 100000) fail('material_document_limit');
    if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) walk(child, pointer + '/' + escaped(key), depth + 1);
    else add({ jsonPointer: pointer });
  };
  if (Object.hasOwn(document, 'data')) walk(document.data);
  for (const table of document.tables) for (const row of table.rows) row.cells.forEach((_, index) => add({ sheetIndex: table.sheetIndex, row: row.rowNumber, column: index + 1 }));
  const spans = documentValueSpans(document);
  for (const block of document.blocks) {
    add({ page: block.page, line: block.line });
    const span = spans.get(block);
    if (span) add(span.locator);
  }
  document.locations = locations;
  return document;
}

export function readMaterialDocument(options) {
  const bytes = sourceBytes(options.path, options.sourceRoot), sha256 = hash(bytes), format = extname(options.path).slice(1).toLowerCase();
  if (options.expectedSha256 && options.expectedSha256 !== sha256) fail('material_document_source_changed');
  const document = { version: VERSION, format, status: 'read', readState: 'read', source: { path: resolve(options.path), sha256, bytes: bytes.length, format }, extractor: { id: 'native-text', version: '1', mode: 'native' }, tables: [], blocks: [], cellStates: [], diagnostics: [] };
  if (!FORMATS.includes(format)) return attachLocations({ ...document, status: 'unsupported', readState: 'unsupported', diagnostics: [{ code: 'material_document_format_unsupported' }] });
  try {
    if (NATIVE_FORMATS.includes(format)) {
      const decoded = decodeText(bytes);
      document.extractor.encoding = decoded.encoding;
      if (decoded.text.length > 2_000_000) fail('material_document_limit');
      if (format === 'json') { document.data = JSON.parse(decoded.text); document.extractor.id = 'json'; }
      else if (format === 'csv') {
        const rows = parseEvidenceCsv(decoded.text);
        if (rows.length > 10000 || rows.some(row => row.length > 256) || rows.reduce((sum, row) => sum + row.length, 0) > 100000) fail('material_document_limit');
        document.tables = [{ sheetIndex: 0, name: 'csv', rows: rows.map((cells, index) => ({ rowNumber: index + 1, cells })) }];
        document.extractor.id = 'csv';
      } else {
        const lines = decoded.text.split(/\r?\n/);
        if (lines.length > 10000) fail('material_document_limit');
        document.blocks = lines.map((text, index) => ({ page: 1, line: index + 1, text })).filter(block => block.text.trim());
        document.pageKind = 'logical';
      }
    } else {
      const extracted = pythonRead({ format, data: bytes.toString('base64'), maxPages: options.maxPages ?? 40, pageOffset: options.pageOffset ?? 0, ocr: options.ocr !== false }, options);
      Object.assign(document, { status: extracted.status, readState: extracted.status, extractor: extracted.extractor ?? { id: 'python', version: 'unknown', mode: 'python' }, tables: extracted.tables ?? [], blocks: extracted.blocks ?? [], cellStates: extracted.cellStates ?? [], diagnostics: extracted.diagnostics ?? [] });
      if (extracted.error) document.diagnostics.push({ code: extracted.error });
      if (extracted.runtime) document.extractor.runtime = extracted.runtime;
      for (const key of ['pageCount', 'pageKind', 'nextPageOffset']) if (Object.hasOwn(extracted, key)) document[key] = extracted[key];
      for (const page of extracted.ocrPages ?? []) {
        if (options.ocr === false) { document.status = 'partial'; document.diagnostics.push({ code: 'ocr_required', page: page.page }); continue; }
        const recognized = windowsOcr({ data: page.data });
        if (recognized.status !== 'read') {
          document.status = document.blocks.length || document.tables.length ? 'partial' : 'needs_runtime';
          document.diagnostics.push({ code: recognized.error ?? 'ocr_runtime_unavailable', page: page.page });
          continue;
        }
        document.extractor.mode = 'ocr';
        document.extractor.ocr = { id: recognized.id, version: recognized.version, language: recognized.language };
        const lines = recognized.lines ?? [];
        if (!lines.length) { document.status = 'partial'; document.diagnostics.push({ code: 'ocr_no_text', page: page.page }); }
        lines.forEach((line, index) => document.blocks.push({ page: page.page, line: index + 1, text: line.text, bbox: line.bbox?.map(value => value / page.scale), origin: 'ocr', verification: 'ocr_extraction_unreviewed' }));
        document.diagnostics.push({ code: 'ocr_text_requires_review', page: page.page });
      }
    }
  } catch (error) {
    if (error.code?.startsWith('material_document_')) throw error;
    document.status = 'unsupported'; document.diagnostics.push({ code: 'material_document_parse_failed' });
  }
  if (hash(sourceBytes(options.path, options.sourceRoot)) !== sha256) fail('material_document_source_changed');
  document.readState = document.status;
  document.extractor.readerSha256 = hash(Buffer.concat(['material-document.mjs', 'material-document-reader.py', 'material-document-ocr.ps1'].map(name => readFileSync(join(ROOT, name)))));
  document.extractionSha256 = hash(JSON.stringify({ source: document.source.sha256, extractor: document.extractor, data: document.data, tables: document.tables, blocks: document.blocks, cellStates: document.cellStates, diagnostics: document.diagnostics }));
  return attachLocations(document);
}

export function readMaterialValue(document, requested) {
  if (!requested || typeof requested !== 'object' || Array.isArray(requested)) fail('material_document_locator_missing');
  if (document.status === 'needs_runtime' || document.readState === 'needs_runtime') {
    const reason = document.diagnostics.find(item => /^(?:material_document_|ocr_)/.test(item.code ?? ''))?.code;
    fail(reason ?? 'material_document_runtime_unavailable');
  }
  const locator = requested.fieldRef ? document.locations.get(requested.fieldRef) : requested;
  if (!locator || typeof locator !== 'object') fail('material_document_locator_missing');
  if (Object.hasOwn(locator, 'jsonPointer')) {
    if (!Object.hasOwn(document, 'data') || typeof locator.jsonPointer !== 'string' || locator.jsonPointer !== '' && !locator.jsonPointer.startsWith('/') || /~[^01]/.test(locator.jsonPointer)) fail('material_document_locator_missing');
    let value = document.data;
    const contexts = [value];
    for (const part of locator.jsonPointer === '' ? [] : locator.jsonPointer.slice(1).split('/')) {
      const key = part.replaceAll('~1', '/').replaceAll('~0', '~');
      if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) fail('material_document_locator_missing');
      value = value[key]; if (value && typeof value === 'object') contexts.push(value);
    }
    return { value, contexts, locator: { jsonPointer: locator.jsonPointer } };
  }
  if (Object.hasOwn(locator, 'row')) {
    const table = typeof locator.sheet === 'string' ? document.tables.find(table => table.name === locator.sheet) : document.tables.find(table => table.sheetIndex === (locator.sheetIndex ?? 0));
    const row = table?.rows.find(row => row.rowNumber === locator.row), headerRows = locator.headerRows ?? [1], headers = table?.rows.find(row => row.rowNumber === headerRows.at(-1));
    const column = typeof locator.column === 'number' ? locator.column - 1 : headers?.cells.findIndex(cell => cell === locator.column);
    if (!row || !Number.isInteger(column) || column < 0 || column >= row.cells.length) fail('material_document_locator_missing');
    return { value: row.cells[column], valueState: document.valueStates?.get(JSON.stringify([table.sheetIndex, row.rowNumber, column + 1])) ?? 'source_extracted', contexts: headers ? [Object.fromEntries(headers.cells.map((key, index) => [String(key ?? ''), row.cells[index]]))] : [], locator: { sheetIndex: table.sheetIndex, row: row.rowNumber, column: column + 1, headerRows } };
  }
  const block = document.blocks.find(block => block.page === locator.page && block.line === locator.line);
  if (!block) fail('material_document_locator_missing');
  let value = block.text;
  const actualLocator = { page: block.page, line: block.line };
  if (Object.hasOwn(locator, 'start') || Object.hasOwn(locator, 'end')) {
    if (!Number.isInteger(locator.start) || !Number.isInteger(locator.end) || locator.start < 0 || locator.end <= locator.start || locator.end > block.text.length) fail('material_document_locator_missing');
    value = block.text.slice(locator.start, locator.end);
    Object.assign(actualLocator, { start: locator.start, end: locator.end });
  }
  return { value, contexts: [{ page: block.page, line: block.line, text: block.text }], locator: actualLocator };
}

// 表头保留不同软件的原始名称；姓名、主体、税号、数值和长自由文本不作为表头泄露。
function safeLabel(value) {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!text || text.length > 80 || /[0-9０-９]|@|https?:|[￥¥$]|private|secret|redacted|(?:有限|股份|责任)公司|合作社|商行|集团|\b(?:Ltd|LLC|Inc)\b/i.test(text)) return undefined;
  if (!/^[\p{L}\s_（）()【】\[\]\/／%％:：—-]+$/u.test(text)) return undefined;
  return text;
}

function semanticText(text) {
  // 只列不含值的语义锚点；原文行由不透明引用在本机读取。
  return [...new Set(String(text).match(/(?:购买方|销售方|纳税人识别号|统一社会信用代码|企业名称|公司名称|开票日期|税款所属期|所属期|不含税金额|含税金额|税额|价税合计|税种|本期|累计|应纳|实缴|预缴|收款|付款|租赁|租金|维保|服务|合同|受益期|按月|等额|分期|一次性|先进先出|加权平均|管理费用|销售费用|主营业务收入|其他业务收入|会计准则)/g) ?? [])];
}

function fieldLabel(value) {
  const text = safeLabel(value);
  if (!text) return undefined;
  // 标题按字段语法识别，不把两个任意字符串当成表头；无需业务字段别名命中。
  // 中文姓名/主体值等自由文本不因位置靠前而取得展示资格。
  const chineseField = /(?:名称|姓名|抬头|税号|号码|编号|代码|标识|日期|时间|起算|届满|开始|结束|起始|截止|期间|区间|月份|年月|年度|金额|净额|总额|税额|余额|数量|单价|税率|比率|比例|类别|类型|分类|性质|用途|单位|币种|方式|方法|口径|状态|条件|范围|说明|备注|信息|项目|明细|地址|账户|账号|开户行|科目|期限|年限|设置|选择|依据|起点|终点|字段|列名|标题|值)$/u.test(text)
    || /^[\p{L}\s_（）()【】\[\]\/／—-]{2,}(?:日|号|码|数)$/u.test(text);
  const words = text.replace(/([a-z])([A-Z])/g, '$1 $2').split(/[\s_（）()【】\[\]\/／:：—-]+/).filter(Boolean);
  const englishField = /^(?:name|number|id|code|date|time|period|month|year|start|end|begin|through|amount|net|gross|tax|balance|quantity|price|rate|ratio|type|kind|category|method|basis|status|unit|currency|description|note|address|account|field|column|value|setting|choice|from|to|party|reference|scope|duration|term|window)$/i.test(words.at(-1) ?? '');
  return chineseField || englishField || semanticText(text).includes(text) ? text : undefined;
}

function structuralLabel(value) {
  const text = safeLabel(value);
  if (!text) return undefined;
  if (fieldLabel(text)) return text;
  const compact = text.replace(/\s/g, '');
  // 结构可以证明这里是键，但短姓名形态、地址及长自由文本仍不自动披露。
  if (/^[\p{Script=Han}]{1,3}$/u.test(compact) || /(?:省|市|区|县|镇|乡|村|路|街|巷|弄|楼|室)$/u.test(compact)) return undefined;
  if (/[\p{Script=Han}]/u.test(compact) ? compact.length > 16 : text.split(/\s+/).length > 5) return undefined;
  return text;
}

function projectedHeaderRows(table) {
  const early = table.rows.filter(row => row.rowNumber <= 8);
  const candidate = early.find(row => {
    const cells = row.cells.filter(value => value !== null && value !== '');
    if (cells.length < 2 || !cells.every(value => safeLabel(value))) return false;
    const titled = cells.filter(value => fieldLabel(value)).length;
    if (!titled) return false;
    const following = table.rows.filter(item => item.rowNumber > row.rowNumber).slice(0, 3);
    const dataShape = following.some(item => item.cells.some(value => typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string' && /\d/.test(value)));
    // 陌生标题不再使整行失效；数据类型变化提供结构依据，逐列仍只展示字段式标签。
    return titled === cells.length || cells.length >= 3 && dataShape;
  });
  return new Set(candidate ? [candidate.rowNumber] : []);
}

function keyValueRows(table) {
  const populated = table.rows.filter(row => row.cells.some(value => value !== null && value !== ''));
  const pairs = populated.filter(row => row.cells.length === 2);
  if (pairs.length < 2 || pairs.length < populated.length * 0.8) return new Set();
  const labelled = pairs.filter(row => structuralLabel(row.cells[0]));
  const anchors = new Set(pairs.map(row => fieldLabel(row.cells[0])).filter(Boolean));
  // 余额名单也可能是两列；必须有多个字段锚点和稳定表形，不能以右值有数字认作表单。
  if (anchors.size < 2 || labelled.length < pairs.length * 0.8) return new Set();
  return new Set(labelled.map(row => row.rowNumber));
}

export function projectMaterialDocument(document, { offset = 0, limit = 100 } = {}) {
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 400) fail('material_document_page_invalid');
  const items = [];
  if (Object.hasOwn(document, 'data')) {
    let index = 0;
    for (const [fieldRef, locator] of document.locations) {
      const captured = readMaterialValue(document, locator), key = locator.jsonPointer.split('/').at(-1)?.replaceAll('~1', '/').replaceAll('~0', '~');
      // JSON 路径可包含客户姓名、税号等动态键；路径与原始键始终只留本机。
      items.push({ fieldRef, locator: { fieldRef }, position: { index: index++, depth: locator.jsonPointer === '' ? 0 : locator.jsonPointer.split('/').length - 1 }, type: scalarType(captured.value), semanticLabels: semanticText(key) });
    }
  }
  for (const table of document.tables) {
    const keys = keyValueRows(table), headers = keys.size ? new Set() : projectedHeaderRows(table);
    for (const row of table.rows) for (let index = 0; index < row.cells.length; index++) {
      const locator = { sheetIndex: table.sheetIndex, row: row.rowNumber, column: index + 1 };
      const keyValueLabel = index === 0 && keys.has(row.rowNumber);
      const isLabel = headers.has(row.rowNumber) || keyValueLabel, label = isLabel ? structuralLabel(row.cells[index]) : undefined;
      const valueState = document.valueStates?.get(JSON.stringify([table.sheetIndex, row.rowNumber, index + 1]));
      const fieldRef = fieldReference(document.source, locator);
      items.push({ fieldRef, locator: { fieldRef }, position: locator, type: scalarType(row.cells[index]), ...(valueState ? { valueState } : {}), ...(label ? { label } : {}), semanticLabels: isLabel ? semanticText(row.cells[index]) : [] });
    }
  }
  const spans = documentValueSpans(document);
  for (const block of document.blocks) {
    const locator = { page: block.page, line: block.line };
    const fieldRef = fieldReference(document.source, locator);
    items.push({ fieldRef, locator: { fieldRef }, position: locator, type: 'string', semanticLabels: semanticText(block.text), ...(block.origin ? { origin: block.origin } : {}) });
    const span = spans.get(block);
    if (span) {
      const spanRef = fieldReference(document.source, span.locator);
      items.push({ fieldRef: spanRef, locator: { fieldRef: spanRef }, position: span.locator, type: 'string', label: span.label, semanticLabels: semanticText(span.label), ...(block.origin ? { origin: block.origin } : {}) });
    }
  }
  return {
    version: VERSION, format: document.format, status: document.status, readState: document.readState,
    source: { sha256: document.source.sha256, bytes: document.source.bytes, format: document.format },
    extractor: { id: document.extractor.id, version: document.extractor.version, mode: document.extractor.mode, readerSha256: document.extractor.readerSha256, ...(document.extractor.ocr ? { ocr: document.extractor.ocr } : {}) },
    tables: document.tables.map(table => ({ sheetIndex: table.sheetIndex, rowCount: table.rows.length })),
    ...(document.pageCount !== undefined ? { pageCount: document.pageCount } : {}), ...(document.pageKind ? { pageKind: document.pageKind } : {}),
    diagnostics: document.diagnostics, items: items.slice(offset, offset + limit), pagination: { offset, limit, total: items.length, nextOffset: offset + limit < items.length ? offset + limit : null },
  };
}
