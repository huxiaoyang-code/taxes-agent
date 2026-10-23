// Restricted OOXML reader. ZIP/XML grammar belongs to pinned libraries, never regex parsers.
import { unzipSync, Unzip, UnzipInflate } from 'fflate';
import { SaxesParser } from 'saxes';

const MAX_FILE = 5 * 1024 * 1024, MAX_ENTRY = 4 * 1024 * 1024, MAX_TOTAL = 16 * 1024 * 1024;
const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const DOCREL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const fail = code => { throw Object.assign(new Error(code), { code }); };
const check = (ok, code = 'xlsx_structure_unsupported') => { if (!ok) fail(code); };
const utf8 = bytes => new TextDecoder('utf-8', { fatal: true }).decode(bytes);

function unpack(bytes) {
  check(bytes.length > 0 && bytes.length <= MAX_FILE, 'xlsx_limit');
  const central = new Map(); let declared = 0;
  // No inflate here: enumerate central metadata with the library, including duplicates.
  unzipSync(bytes, { filter: f => {
    check(central.size < 100 && !central.has(f.name), 'xlsx_zip_invalid');
    check(typeof f.name === 'string' && f.name.length <= 240 && !f.name.startsWith('/') && !f.name.includes('\\') && !f.name.replace(/\/$/, '').split('/').some(x => x === '..' || x === '.' || x === ''), 'xlsx_zip_invalid');
    check([0, 8].includes(f.compression) && Number.isSafeInteger(f.originalSize) && f.originalSize >= 0 && f.originalSize <= MAX_ENTRY && Number.isSafeInteger(f.size) && f.size >= 0 && f.size <= MAX_FILE, 'xlsx_limit');
    check(!f.name.endsWith('/') || f.originalSize === 0, 'xlsx_zip_invalid');
    declared += f.originalSize; check(declared <= MAX_TOTAL, 'xlsx_limit'); central.set(f.name, f.originalSize); return false;
  } });
  const entries = new Map(), started = new Set(), finished = new Set(); let actual = 0;
  const stream = new Unzip(file => {
    check(central.has(file.name) && !started.has(file.name), 'xlsx_zip_invalid'); started.add(file.name);
    const chunks = []; let size = 0;
    file.ondata = (error, data, final) => {
      if (error) fail('xlsx_zip_invalid');
      size += data.length; actual += data.length;
      check(size <= MAX_ENTRY && actual <= MAX_TOTAL, 'xlsx_limit');
      check(size <= central.get(file.name), 'xlsx_zip_invalid'); chunks.push(data);
      if (final) { check(size === central.get(file.name), 'xlsx_zip_invalid'); finished.add(file.name); entries.set(file.name, Buffer.concat(chunks)); }
    };
    file.start();
  });
  stream.register(UnzipInflate);
  for (let i = 0; i < bytes.length; i += 1024) stream.push(bytes.subarray(i, i + 1024), i + 1024 >= bytes.length);
  check(central.size > 0 && started.size === central.size && finished.size === central.size && actual === declared, 'xlsx_zip_invalid');
  return entries;
}
function xml(bytes) {
  check(bytes, 'xlsx_part_missing');
  const parser = new SaxesParser({ xmlns: true }); const stack = []; let root, nodes = 0;
  parser.on('error', () => fail('xlsx_xml_invalid'));
  parser.on('doctype', () => fail('xlsx_structure_unsupported'));
  parser.on('processinginstruction', () => fail('xlsx_structure_unsupported'));
  parser.on('opentag', tag => {
    check(++nodes <= 100000 && stack.length < 32, 'xlsx_limit');
    const n = { name: tag.local, uri: tag.uri, attrs: {}, children: [], text: '' };
    for (const a of Object.values(tag.attributes)) if (a.prefix !== 'xmlns' && a.name !== 'xmlns') n.attrs[a.uri ? `{${a.uri}}${a.local}` : a.local] = a.value;
    if (stack.length) stack.at(-1).children.push(n); else { check(!root, 'xlsx_xml_invalid'); root = n; } stack.push(n);
  });
  const text = s => { if (stack.length) { stack.at(-1).text += s; check(stack.at(-1).text.length <= MAX_ENTRY, 'xlsx_limit'); } };
  parser.on('text', text); parser.on('cdata', () => fail('xlsx_structure_unsupported'));
  parser.on('closetag', () => stack.pop()); parser.write(utf8(bytes)).close(); check(root && stack.length === 0, 'xlsx_xml_invalid'); return root;
}
const children = (n, name) => n.children.filter(c => c.name === name);
function one(n, name, required = true) { const a = children(n, name); check(a.length <= 1 && (!required || a.length === 1)); return a[0]; }
const PARENTS = {
  Relationships: ['Relationship'], Types: ['Default', 'Override'],
  workbook: ['fileVersion', 'workbookPr', 'bookViews', 'sheets', 'calcPr'], bookViews: ['workbookView'], sheets: ['sheet'],
  sst: ['si'], si: ['t'], is: ['t'],
  styleSheet: ['numFmts', 'fonts', 'fills', 'borders', 'cellStyleXfs', 'cellXfs', 'cellStyles', 'dxfs', 'tableStyles'],
  numFmts: ['numFmt'], fonts: ['font'], font: ['sz', 'color', 'name', 'family', 'scheme', 'b', 'i', 'u', 'strike', 'vertAlign', 'charset'],
  fills: ['fill'], fill: ['patternFill'], patternFill: ['fgColor', 'bgColor'], borders: ['border'], border: ['left', 'right', 'top', 'bottom', 'diagonal', 'start', 'end'],
  left: ['color'], right: ['color'], top: ['color'], bottom: ['color'], diagonal: ['color'], start: ['color'], end: ['color'],
  cellStyleXfs: ['xf'], cellXfs: ['xf'], xf: ['alignment', 'protection'], cellStyles: ['cellStyle'],
  worksheet: ['sheetPr', 'dimension', 'sheetViews', 'sheetFormatPr', 'cols', 'sheetData', 'pageMargins', 'pageSetup', 'printOptions', 'headerFooter'],
  sheetPr: ['outlinePr', 'pageSetUpPr'], sheetViews: ['sheetView'], sheetView: ['selection', 'pane'], cols: ['col'], sheetData: ['row'], row: ['c'], c: ['v', 'is', 'f'],
  headerFooter: ['oddHeader', 'oddFooter', 'evenHeader', 'evenFooter', 'firstHeader', 'firstFooter'],
};
const REPEATED = new Set(['Relationship', 'Default', 'Override', 'workbookView', 'sheet', 'si', 'numFmt', 'font', 'fill', 'border', 'xf', 'cellStyle', 'sheetView', 'selection', 'col', 'row', 'c']);
function tree(n, uri, allowed) {
  check(n.uri === uri && allowed.includes(n.name));
  if (!['t', 'v', 'f'].includes(n.name)) check(n.text.trim() === '');
  const seen = new Set();
  for (const c of n.children) {
    check((PARENTS[n.name] ?? []).includes(c.name) && (!seen.has(c.name) || REPEATED.has(c.name))); seen.add(c.name); tree(c, uri, allowed);
  }
}
function relations(bytes, base) {
  const n = xml(bytes); tree(n, REL, ['Relationships', 'Relationship']); check(n.name === 'Relationships'); const out = new Map();
  for (const r of n.children) {
    check(r.name === 'Relationship' && r.children.length === 0 && !out.has(r.attrs.Id));
    check(Object.keys(r.attrs).every(k => ['Id', 'Type', 'Target', 'TargetMode'].includes(k)) && r.attrs.Id && r.attrs.Type && r.attrs.Target);
    check(!r.attrs.TargetMode || r.attrs.TargetMode === 'Internal', 'xlsx_external_link_unsupported');
    const path = r.attrs.Target.startsWith('/') ? r.attrs.Target.slice(1) : base + r.attrs.Target;
    check(!path.includes('\\') && !path.includes(':') && !path.includes('?') && !path.includes('#') && !path.split('/').some(p => p === '..' || p === '.' || p === ''), 'xlsx_external_link_unsupported');
    check(!/externalLink|hyperlink|oleObject/i.test(r.attrs.Type), 'xlsx_external_link_unsupported');
    const allowedTypes = [DOCREL + '/officeDocument', DOCREL + '/worksheet', DOCREL + '/styles', DOCREL + '/sharedStrings', DOCREL + '/theme', DOCREL + '/extended-properties', REL + '/metadata/core-properties'];
    check(allowedTypes.includes(r.attrs.Type), 'xlsx_structure_unsupported');
    out.set(r.attrs.Id, { type: r.attrs.Type, path });
  }
  return out;
}
const cellPosition = a => {
  const m = /^([A-Z]{1,3})([1-9]\d{0,4})$/.exec(a ?? ''); check(m, 'xlsx_cell_invalid');
  const column = [...m[1]].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0), row = Number(m[2]);
  check(column <= 256 && row <= 10000, 'xlsx_limit'); return { column, row };
};
const a1 = column => { let s = ''; for (let n = column; n; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s; return s; };
const simpleString = n => { check(n && n.children.every(c => c.name === 't') && n.children.length === 1); const t = n.children[0]; check(!t.children.length && t.text.length <= 4096, 'xlsx_limit'); check(!/_x[0-9A-Fa-f]{4}_/.test(t.text), 'xlsx_string_escape_unsupported'); return t.text; };

function readMappedXlsx(bytes, mapping, numericKeys, strictNumericLexical = false) {
  try {
    const entries = unpack(bytes);
    for (const [name, content] of entries) if (name.endsWith('.rels')) {
      const links = relations(content, name === '_rels/.rels' ? '' : name.slice(0, name.lastIndexOf('/_rels/') + 1));
      for (const link of links.values()) check(entries.has(link.path) && !link.path.endsWith('/'), 'xlsx_part_missing');
    }
    check(![...entries.keys()].some(n => /(?:externalLinks|vbaProject|embeddings)\//i.test(n) || /vbaProject\.bin$/i.test(n)), 'xlsx_external_link_unsupported');
    const rootRels = relations(entries.get('_rels/.rels'), '');
    const office = [...rootRels.values()].filter(r => r.type === DOCREL + '/officeDocument'); check(office.length === 1 && office[0].path === 'xl/workbook.xml');
    const types = xml(entries.get('[Content_Types].xml'));
    tree(types, 'http://schemas.openxmlformats.org/package/2006/content-types', ['Types', 'Default', 'Override']);
    check(types.name === 'Types' && types.children.some(n => n.name === 'Override' && n.attrs.PartName === '/xl/workbook.xml' && n.attrs.ContentType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml'));
    const allowedContentTypes = ['application/xml', 'application/vnd.openxmlformats-package.relationships+xml', 'application/vnd.openxmlformats-package.core-properties+xml', ...['spreadsheetml.sheet.main', 'spreadsheetml.worksheet', 'spreadsheetml.styles', 'spreadsheetml.sharedStrings', 'theme', 'extended-properties'].map(t => 'application/vnd.openxmlformats-officedocument.' + t + '+xml')];
    const contentKeys = new Set();
    for (const n of types.children) {
      check(allowedContentTypes.includes(n.attrs.ContentType) || n.name === 'Default' && n.attrs.Extension === 'vml' && n.attrs.ContentType === 'application/vnd.openxmlformats-officedocument.vmlDrawing' && ![...entries.keys()].some(name => name.endsWith('.vml')), 'xlsx_structure_unsupported');
      check(Object.keys(n.attrs).every(k => ['ContentType', n.name === 'Override' ? 'PartName' : 'Extension'].includes(k)));
      if (n.name === 'Override') check(n.attrs.PartName?.startsWith('/') && entries.has(n.attrs.PartName.slice(1)), 'xlsx_part_missing');
      const key = n.name === 'Override' ? n.attrs.PartName : n.attrs.Extension;
      check(key && !contentKeys.has(n.name + ':' + key)); contentKeys.add(n.name + ':' + key);
    }
    check([...entries.keys()].every(name => name.endsWith('/') || ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/sharedStrings.xml', 'docProps/core.xml', 'docProps/app.xml'].includes(name) || /^xl\/(?:worksheets\/sheet\d+|theme\/theme\d+)\.xml$/.test(name)), 'xlsx_structure_unsupported');
    const wb = xml(entries.get('xl/workbook.xml'));
    tree(wb, MAIN, ['workbook', 'fileVersion', 'workbookPr', 'bookViews', 'workbookView', 'sheets', 'sheet', 'calcPr']); check(wb.name === 'workbook');
    const rels = relations(entries.get('xl/_rels/workbook.xml.rels'), 'xl/');
    const sheets = one(wb, 'sheets').children; check(sheets.every(s => s.name === 'sheet') && new Set(sheets.map(s => s.attrs.name)).size === sheets.length && new Set(sheets.map(s => s.attrs.sheetId)).size === sheets.length && new Set(sheets.map(s => s.attrs[`{${DOCREL}}id`])).size === sheets.length);
    const matches = sheets.filter(s => s.attrs.name === mapping.sheet); check(matches.length === 1, 'xlsx_sheet_missing');
    const selected = matches[0]; check(!selected.attrs.state || selected.attrs.state === 'visible', 'xlsx_structure_unsupported');
    const sheetRel = rels.get(selected.attrs[`{${DOCREL}}id`]); check(sheetRel?.type === DOCREL + '/worksheet');
    const related = type => { const found = [...rels.values()].filter(r => r.type === DOCREL + '/' + type); check(found.length <= 1); return found[0] && entries.get(found[0].path); };
    const shared = related('sharedStrings'); let strings = [];
    if (shared) { const n = xml(shared); tree(n, MAIN, ['sst', 'si', 't']); check(n.name === 'sst' && n.children.every(c => c.name === 'si')); strings = n.children.map(simpleString); }
    const styles = related('styles'); let formats = ['0'];
    if (styles) {
      const n = xml(styles);
      const ext = one(n, 'extLst', false);
      if (ext) {
        check(ext.uri === MAIN && ext.text.trim() === '' && ext.children.length <= 2);
        const uris = new Set();
        for (const e of ext.children) {
          check(e.name === 'ext' && e.uri === MAIN && e.text.trim() === '' && e.children.length === 1);
          const child = e.children[0];
          const known = child.name === 'slicerStyles' && child.uri === 'http://schemas.microsoft.com/office/spreadsheetml/2009/9/main' && e.attrs.uri === '{EB79DEF2-80B8-43e5-95BD-54CBDDF9020C}'
            || child.name === 'timelineStyles' && child.uri === 'http://schemas.microsoft.com/office/spreadsheetml/2010/11/main' && e.attrs.uri === '{9260A510-F301-46a8-8635-F512D64BE5F5}';
          check(known && !uris.has(e.attrs.uri) && !child.children.length && child.text.trim() === ''); uris.add(e.attrs.uri);
        }
        n.children = n.children.filter(c => c !== ext);
      }
      tree(n, MAIN, ['styleSheet', 'numFmts', 'numFmt', 'fonts', 'font', 'sz', 'color', 'name', 'family', 'scheme', 'b', 'i', 'u', 'strike', 'vertAlign', 'charset', 'fills', 'fill', 'patternFill', 'fgColor', 'bgColor', 'borders', 'border', 'left', 'right', 'top', 'bottom', 'diagonal', 'start', 'end', 'cellStyleXfs', 'cellXfs', 'xf', 'alignment', 'protection', 'cellStyles', 'cellStyle', 'dxfs', 'tableStyles']);
      check(n.name === 'styleSheet'); const xfs = one(n, 'cellXfs'); check(xfs.children.every(c => c.name === 'xf')); formats = xfs.children.map(x => x.attrs.numFmtId ?? '0');
    }
    const sheet = xml(entries.get(sheetRel.path));
    tree(sheet, MAIN, ['worksheet', 'sheetPr', 'outlinePr', 'pageSetUpPr', 'dimension', 'sheetViews', 'sheetView', 'selection', 'pane', 'sheetFormatPr', 'cols', 'col', 'sheetData', 'row', 'c', 'v', 'is', 't', 'f', 'pageMargins', 'pageSetup', 'printOptions', 'headerFooter', 'oddHeader', 'oddFooter', 'evenHeader', 'evenFooter', 'firstHeader', 'firstFooter']);
    check(sheet.name === 'worksheet'); const rows = one(sheet, 'sheetData').children; const seenRows = new Set(), records = [];
    for (const row of rows) {
      check(row.name === 'row' && /^[1-9]\d{0,4}$/.test(row.attrs.r ?? ''), 'xlsx_cell_invalid'); const rowNumber = Number(row.attrs.r);
      check(rowNumber <= 10000 && !seenRows.has(rowNumber), 'xlsx_limit'); seenRows.add(rowNumber);
      const cells = [], types = [], seenCells = new Set();
      for (const c of row.children) {
        check(c.name === 'c' && Object.keys(c.attrs).every(k => ['r', 's', 't'].includes(k)), 'xlsx_cell_invalid');
        const pos = cellPosition(c.attrs.r); check(pos.row === rowNumber && !seenCells.has(pos.column), 'xlsx_cell_invalid'); seenCells.add(pos.column);
        check(!c.children.some(n => n.name === 'f'), 'xlsx_formula_unsupported');
        const type = c.attrs.t ?? 'n'; check(['s', 'inlineStr', 'n'].includes(type), 'xlsx_cell_type_unsupported');
        check(c.children.every(n => n.name === 'v' || n.name === 'is'), 'xlsx_cell_invalid');
        const v = one(c, 'v', false), inline = one(c, 'is', false); let value;
        if (type === 'inlineStr') { check(inline && !v); value = simpleString(inline); }
        else {
          check(!inline); const raw = v?.text ?? ''; check(!v?.children.length && raw.length <= 4096, 'xlsx_cell_invalid');
          if (type === 's') { check(/^(0|[1-9]\d*)$/.test(raw) && Number(raw) < strings.length, 'xlsx_cell_invalid'); value = strings[Number(raw)]; }
          else value = raw;
        }
        const style = c.attrs.s ?? '0'; check(/^(0|[1-9]\d*)$/.test(style) && Number(style) < formats.length, 'xlsx_cell_invalid');
        cells[pos.column - 1] = value; types[pos.column - 1] = { type, format: formats[Number(style)] };
      }
      records.push({ rowNumber, cells: Array.from({ length: cells.length }, (_, i) => cells[i] ?? ''), types });
    }
    const header = records.find(r => r.rowNumber === mapping.headerRow); check(header, 'xlsx_header_missing');
    const index = new Map();
    for (const [key, label] of Object.entries(mapping.columns)) {
      const found = header.cells.flatMap((v, i) => v === label ? [i] : []); check(found.length === 1, 'xlsx_header_ambiguous');
      check(['s', 'inlineStr'].includes(header.types[found[0]]?.type), 'xlsx_cell_type_unsupported'); index.set(key, found[0]);
    }
    const data = records.filter(r => r.rowNumber > mapping.headerRow).sort((a, b) => a.rowNumber - b.rowNumber); check(data.length > 0, 'xlsx_rows_missing');
    for (const r of data) for (const [key, col] of index) {
      const type = r.types[col]; if (!type && r.cells[col] === undefined) continue; // Missing values reach the existing material adapter validation.
      check(type, 'xlsx_cell_invalid');
      if (numericKeys.includes(key)) {
        check(type.type !== 'n' || ['0', '1', '2'].includes(type.format), 'xlsx_numeric_format_unsupported');
        // Bank text-format options must never reinterpret an OOXML numeric cell.
        if (strictNumericLexical && type.type === 'n') {
          const raw = r.cells[col];
          check(raw.trim() === raw && /^-?(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(raw), 'xlsx_cell_invalid');
        }
      }
      else check(['s', 'inlineStr'].includes(type.type), 'xlsx_text_required');
    }
    return { headers: header.cells, index, rows: data.map(r => ({ ...r, lineNumber: undefined, location: { sheet: mapping.sheet, row: r.rowNumber, fields: Object.fromEntries([...index].map(([key, col]) => [key, { sheet: mapping.sheet, row: r.rowNumber, column: col + 1, cell: `${a1(col + 1)}${r.rowNumber}`, header: mapping.columns[key] }])) } })) };
  } catch (error) {
    if (typeof error?.code === 'string' && error.code.startsWith('xlsx_')) throw error;
    fail('xlsx_zip_or_xml_invalid');
  }
}

// Numeric permissions belong to these fixed adapters, never to caller-controlled mapping.
export const readInvoiceXlsx = (bytes, mapping) => readMappedXlsx(bytes, mapping, ['net', 'tax', 'gross']);
export const readBankXlsx = (bytes, mapping) => readMappedXlsx(bytes, mapping, ['amount', 'balance'], true);
