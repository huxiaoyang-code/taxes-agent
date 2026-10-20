import { createRequire } from 'node:module';

// Offline, syntactic candidates only. No source evaluation, I/O, network, or replay.
// Local dependency: Node's bundled Acorn, exposed explicitly with
// `node --expose-internals ...`. No flag => fixed parser_unavailable result.
let parse;
try {
  ({ parse } = createRequire(import.meta.url)('internal/deps/acorn/acorn/dist/acorn'));
} catch { /* Fail closed; never substitute a regex parser. */ }

const LIMITS = Object.freeze({ sourceCharacters: 4_000_000, astNodes: 160_000, entries: 200, arguments: 12, keys: 32 });
// Deliberately finite vocabulary: arbitrary ASCII names can themselves be secrets.
// Add names/segments only after a human has verified their technical meaning.
const NAMES = new Set(`fetch axios request get post put delete head options GET POST HEAD OPTIONS method url path params query data body headers responseType response blob arrayBuffer text json then catch finally saveAs createObjectURL revokeObjectURL Blob URL document createElement appendChild removeChild click download href target rel router push replace resolve route routes name component children meta title label onClick handler methods mounted created setup exports export default window location open Object assign keys values map forEach filter find reduce length status statusCode success Response Error Data List Total PageNumber PageSize gzlx pageNum pageSize sbrqq sbrqz skssqq skssqz zfbz yzpzzlDm zsxmDmArray nssbrq ybtse gzlxDm zfrq sbuuid yzpzzlMc pzxh row record item detail details invoice invoices file files downloadFile exportFile exportExcel exportPdf getDetail getDetails queryDetail queryList list print report reports financial accounting DescribeSbmxcx2 cwbbsb cwbbsbDetail cwbb cx xz dc sbmxcx fpxx fpdm fphm kprqq kprqz response dataType contentType type filename fileName fileType fileId id sbzlDm sbzlmc sbuuid sbxh sbmxxh nsrsbh nsrmc skssq yzpzzl page current limit size result code message content disposition dispatch commit apply call bind addEventListener preventDefault stopPropagation navigateTo toString formData FormData set getAll submit form action`.split(/\s+/));
const LABELS = new Set(['下载', '导出', '发票', '发票下载', '发票查询', '财务报表', '申报查询', '详情', '查看详情', '打印']);
const ROOTS = new Set(['szzh', 'szc', 'kpfw', 'dppt']);
const SEGMENTS = new Set(`api v1 v2 v3 szzh szc kpfw dppt invoice invoices download export file files report reports financial accounting query list detail details print sbmxcx cwbbsb cwbb fpxx cx xz dc get post DescribeSbmxcx2 getDetail getDetails queryDetail queryList downloadFile exportFile exportExcel exportPdf`.split(/\s+/));
const METHODS = new Set(['GET', 'POST', 'HEAD', 'OPTIONS', 'PUT', 'PATCH', 'DELETE']);
// Verified public technical names/route segments supplied by the root reviewer.
// This expands discovery only; it never permits a request.
for (const name of `zhcx sjswszzh sbxx sbxxcx sbbdxz cwbbsbxxcx cwbbxxcxDetail nsrxxcx DescribeSbmxxqInit DescribeSbmxxqcx DescribeSbmxxqzfbTree DescribeFpCx DescribeFpqk DescribeNsrfpxx DescribeNsrsbxx`.split(' ')) {
  NAMES.add(name); SEGMENTS.add(name);
}
// Actual request metadata confirmed these technical tails and body keys only.
// No unobserved prefix or value is inferred, and discovery grants no API access.
for (const name of ['getCwbbzlList', 'queryZlbscjb', 'DescribeNsrjbxx']) {
  NAMES.add(name); SEGMENTS.add(name);
}
for (const name of ['Skssqq', 'Skssqz', 'PageNum', 'PageSize']) NAMES.add(name);
const FUNCTIONS = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
const LOC = n => ({ start: n.start, end: n.end, line: n.loc.start.line, column: n.loc.start.column });
const stringValue = n => n?.type === 'Literal' && typeof n.value === 'string' ? n.value : null;
const nameOf = n => n?.type === 'Identifier' ? n.name : stringValue(n);
const safeName = value => NAMES.has(value) || LABELS.has(value) ? value : null;
const propertyName = n => n?.computed && n.property?.type !== 'Literal' ? null : nameOf(n?.property ?? n?.key);
const safeMethod = value => typeof value === 'string' && value.length <= 7 && METHODS.has(value.toUpperCase()) ? value.toUpperCase() : null;

function safePath(value) {
  if (typeof value !== 'string' || value.length > 220 || !/^\/[A-Za-z][A-Za-z0-9]*(?:\/[A-Za-z][A-Za-z0-9]*)*\/?$/.test(value)) return false;
  const parts = value.split('/').filter(Boolean);
  return parts.length >= 2 && parts.length <= 10 && ROOTS.has(parts[0]) && parts.every(p => SEGMENTS.has(p));
}

function base(status) {
  return {
    schemaVersion: 1, status, analysis: 'static_candidates_only', requestAuthorized: false,
    parser: 'acorn', selection: 'technical_priority', limits: { ...LIMITS }, truncated: false,
    functions: [], calls: [], paths: [], properties: [], labels: [], links: [],
    unknown: { names: 0, paths: 0, dynamicProperties: 0, dynamicArguments: 0, objectKeys: 0, unresolvedCalls: 0, omittedEntries: 0 },
    counts: { astNodes: 0, functions: 0, calls: 0 },
  };
}

/** Inspect only trusted, local source strings. Output contains no source excerpts,
 * arbitrary literals/names, parameter values, error messages, or source digest.
 * Links describe lexical syntax, not runtime reachability, authorization, or a
 * complete call graph. Dynamic aliases/member dispatch are deliberately unknown.
 */
export function inspectDownloadSource(source) {
  try { return inspectSource(source); }
  catch { return base('analysis_error'); }
}

function inspectSource(source) {
  if (typeof source !== 'string') return base('invalid_source');
  if (source.length > LIMITS.sourceCharacters) return base('source_limit');
  if (!parse) return base('parser_unavailable');
  let ast;
  try {
    ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module', locations: true, allowHashBang: true });
  } catch {
    try { ast = parse(source, { ecmaVersion: 'latest', sourceType: 'script', locations: true, allowHashBang: true }); }
    catch { return base('parse_error'); }
  }
  const out = base('inspected');
  // Internal candidates are bounded by astNodes. Select only after traversal so
  // generic/minified bundle preambles cannot crowd out later download evidence.
  const add = (array, value) => { array.push(value); };
  const seenNames = new WeakSet();
  function checkedName(node, value) {
    const name = safeName(value);
    if (!name && node && !seenNames.has(node)) { seenNames.add(node); out.unknown.names++; }
    return name;
  }
  const rootScope = { parent: null, bindings: new Map(), functionScope: true };
  const records = [], functionIds = new WeakMap();
  const stack = [{ node: ast, scope: rootScope, owner: null, parent: null }];
  function bindPattern(pattern, scope, targetNode = null) {
    const patterns = [pattern];
    while (patterns.length) {
      const p = patterns.pop();
      if (!p) continue;
      if (p.type === 'Identifier') scope.bindings.set(p.name, { targetNode: p === pattern ? targetNode : null, invalid: false });
      else if (p.type === 'RestElement') patterns.push(p.argument);
      else if (p.type === 'AssignmentPattern') patterns.push(p.left);
      else if (p.type === 'ObjectPattern') for (const x of p.properties) patterns.push(x.type === 'RestElement' ? x.argument : x.value);
      else if (p.type === 'ArrayPattern') for (const x of p.elements) patterns.push(x);
    }
  }
  // Two passes allow forward lexical references without conflating shadowed names.
  while (stack.length) {
    const frame = stack.pop(), { node, parent } = frame;
    if (++out.counts.astNodes > LIMITS.astNodes) {
      // Incomplete traversal cannot safely resolve bindings. Discard all findings.
      const closed = base('ast_limit'); closed.truncated = true; return closed;
    }
    let { scope, owner } = frame;
    if (FUNCTIONS.has(node.type)) {
      const id = `f${++out.counts.functions}`;
      functionIds.set(node, id);
      const rawName = node.id?.name ?? (parent?.type === 'VariableDeclarator' ? nameOf(parent.id) : parent?.type === 'Property' || parent?.type === 'MethodDefinition' ? nameOf(parent.key) : null);
      add(out.functions, { id, name: rawName === null ? null : checkedName(node, rawName), kind: node.type, location: LOC(node) });
      if (node.type === 'FunctionDeclaration' && node.id) scope.bindings.set(node.id.name, { target: id, invalid: false });
      scope = { parent: scope, bindings: new Map(), functionScope: true };
      if (node.id) scope.bindings.set(node.id.name, { target: id, invalid: false });
      for (const p of node.params) bindPattern(p, scope);
      owner = id;
    } else if (node.type === 'BlockStatement' || node.type === 'CatchClause' || node.type === 'ForStatement' || node.type === 'ForInStatement' || node.type === 'ForOfStatement' || node.type === 'SwitchStatement') {
      scope = { parent: scope, bindings: new Map(), functionScope: false };
      if (node.type === 'CatchClause') bindPattern(node.param, scope);
    }
    if (node.type === 'VariableDeclarator') {
      let targetScope = scope;
      if (parent?.kind === 'var') while (!targetScope.functionScope) targetScope = targetScope.parent;
      bindPattern(node.id, targetScope, FUNCTIONS.has(node.init?.type) ? node.init : null);
    }
    if (node.type === 'ImportDeclaration') for (const spec of node.specifiers) scope.bindings.set(spec.local.name, { target: null, invalid: false });
    if (node.type === 'ClassDeclaration' && node.id) scope.bindings.set(node.id.name, { target: null, invalid: false });
    records.push({ node, scope, owner });
    const children = [];
    for (const [key, value] of Object.entries(node)) {
      if (key === 'loc' || key === 'start' || key === 'end') continue;
      if (Array.isArray(value)) {
        for (const child of value) if (child?.type) children.push(child);
      } else if (value?.type) children.push(value);
    }
    for (let i = children.length - 1; i >= 0; i--) stack.push({ node: children[i], scope, owner, parent: node });
  }
  function lookup(scope, name) {
    for (let s = scope; s; s = s.parent) if (s.bindings.has(name)) return s.bindings.get(name);
    return null;
  }
  function invalidate(pattern, scope) {
    const patterns = [pattern];
    while (patterns.length) {
      const p = patterns.pop();
      if (!p) continue;
      if (p.type === 'Identifier') { const b = lookup(scope, p.name); if (b) b.invalid = true; }
      else if (p.type === 'RestElement') patterns.push(p.argument);
      else if (p.type === 'AssignmentPattern') patterns.push(p.left);
      else if (p.type === 'ArrayPattern') for (const x of p.elements) patterns.push(x);
      else if (p.type === 'ObjectPattern') for (const x of p.properties) patterns.push(x.type === 'RestElement' ? x.argument : x.value);
    }
  }
  for (const { node, scope } of records) {
    if (node.type === 'AssignmentExpression') invalidate(node.left, scope);
    if (node.type === 'UpdateExpression') invalidate(node.argument, scope);
  }
  function calleeNames(n) {
    const parts = [];
    for (let depth = 0; n && depth < 7; depth++) {
      if (n.type === 'ChainExpression') { n = n.expression; continue; }
      if (n.type === 'Identifier') {
        const name = checkedName(n, n.name);
        return name && parts.length < 6 ? [name, ...parts.reverse()] : null;
      }
      if (n.type === 'ThisExpression') return parts.length < 6 ? ['this', ...parts.reverse()] : null;
      if (n.type !== 'MemberExpression') return null;
      const raw = propertyName(n), name = raw === null ? null : checkedName(n.property, raw);
      if (!name) return null;
      parts.push(name); n = n.object;
    }
    return null;
  }
  function objectShape(node) {
    const keys = []; let unknownKeys = 0;
    for (const p of node.properties) {
      const raw = p.type === 'Property' && (!p.computed || p.key.type === 'Literal') ? nameOf(p.key) : null;
      const name = raw === null ? null : checkedName(p.key, raw);
      if (name && keys.length < LIMITS.keys) keys.push(name);
      else { unknownKeys++; out.unknown.objectKeys++; }
    }
    return { keys, unknownKeys };
  }
  for (const { node, owner, scope } of records) {
    if (node.type === 'Literal' && typeof node.value === 'string') {
      if (node.value.startsWith('/')) {
        if (safePath(node.value)) add(out.paths, { path: node.value, functionId: owner, location: LOC(node) });
        else out.unknown.paths++;
      }
      if (LABELS.has(node.value)) add(out.labels, { label: node.value, functionId: owner, location: LOC(node) });
    }
    if (node.type === 'MemberExpression' || node.type === 'Property') {
      const raw = node.type === 'MemberExpression' ? propertyName(node) : !node.computed || node.key.type === 'Literal' ? nameOf(node.key) : null;
      if (raw === null) out.unknown.dynamicProperties++;
      else {
        const name = checkedName(node.type === 'Property' ? node.key : node.property, raw);
        if (name) add(out.properties, { name, functionId: owner, location: LOC(node) });
      }
    }
    if (node.type !== 'CallExpression' && node.type !== 'NewExpression') continue;
    const id = `c${++out.counts.calls}`, callee = calleeNames(node.callee), args = [], signals = new Set();
    const tail = node.callee.type === 'MemberExpression' ? propertyName(node.callee) : nameOf(node.callee);
    const fixedTail = safeName(tail);
    if (fixedTail && /invoice|^fp|kprq|^DescribeFp|^DescribeNsrfp/i.test(fixedTail)) signals.add('invoice');
    if (['download', 'downloadFile', 'exportFile', 'exportExcel', 'exportPdf', 'saveAs', 'click'].includes(fixedTail)) signals.add('download');
    if (['blob', 'arrayBuffer', 'Blob', 'createObjectURL', 'revokeObjectURL'].includes(fixedTail)) signals.add('binary');
    if (['push', 'replace', 'resolve', 'navigateTo'].includes(fixedTail)) signals.add('routing');
    if (['detail', 'details', 'getDetail', 'getDetails', 'queryDetail', 'cwbbsbDetail', 'cwbbxxcxDetail', 'DescribeSbmxxqInit', 'DescribeSbmxxqcx', 'DescribeSbmxxqzfbTree'].includes(fixedTail)) signals.add('detail');
    if (fixedTail === 'DescribeSbmxcx2') signals.add('history_query');
    for (let i = 0; i < node.arguments.length; i++) {
      const arg = node.arguments[i];
      if (i >= LIMITS.arguments) { out.unknown.dynamicArguments++; out.truncated = true; continue; }
      let shape = { index: i, kind: 'unknown' };
      const value = stringValue(arg);
      if (safePath(value)) {
        shape = { index: i, kind: 'static_path', path: value };
        if (value.split('/').includes('DescribeSbmxcx2')) signals.add('history_query');
        if (value.split('/').some(p => ['detail', 'details', 'getDetail', 'getDetails', 'queryDetail', 'cwbbxxcxDetail', 'DescribeSbmxxqInit', 'DescribeSbmxxqcx', 'DescribeSbmxxqzfbTree'].includes(p))) signals.add('detail');
        if (value.split('/').some(p => ['invoice', 'invoices', 'fpxx', 'DescribeFpCx', 'DescribeFpqk', 'DescribeNsrfpxx'].includes(p))) signals.add('invoice');
      }
      else if (safeMethod(value)) shape = { index: i, kind: 'method', method: safeMethod(value) };
      else if (value === 'content-disposition' || value === 'Content-Disposition') { shape = { index: i, kind: 'known_header_name' }; signals.add('content_disposition'); }
      else if (arg.type === 'ObjectExpression') {
        shape = { index: i, kind: 'object', ...objectShape(arg) };
        // One level of request body/query keys, never their values.
        shape.objects = []; shape.methods = []; shape.paths = [];
        for (const p of arg.properties) {
          if (p.type !== 'Property' || (p.computed && p.key.type !== 'Literal')) continue;
          const key = safeName(nameOf(p.key));
          if (['url', 'path'].includes(key) && safePath(stringValue(p.value))) {
            if (shape.paths.length < LIMITS.keys) shape.paths.push({ key, path: stringValue(p.value) });
            else { out.truncated = true; out.unknown.omittedEntries++; }
          }
          if (['body', 'data', 'params', 'query'].includes(key) && p.value.type === 'ObjectExpression') {
            if (shape.objects.length < LIMITS.keys) shape.objects.push({ key, ...objectShape(p.value) });
            else { out.truncated = true; out.unknown.omittedEntries++; }
          }
          if (key === 'method' && safeMethod(stringValue(p.value))) {
            if (shape.methods.length < LIMITS.keys) shape.methods.push(safeMethod(stringValue(p.value)));
            else { out.truncated = true; out.unknown.omittedEntries++; }
          }
        }
      } else if (FUNCTIONS.has(arg.type)) {
        shape = { index: i, kind: 'callback', functionId: functionIds.get(arg) };
        add(out.links, { kind: 'callback_syntax_candidate', fromFunctionId: owner, toFunctionId: functionIds.get(arg), callId: id });
      } else if (arg.type === 'Identifier') {
        const name = checkedName(arg, arg.name);
        if (name) shape = { index: i, kind: 'field_reference', name };
      }
      if (shape.kind === 'unknown') out.unknown.dynamicArguments++;
      args.push(shape);
    }
    const binding = node.callee.type === 'Identifier' ? lookup(scope, node.callee.name) : null;
    const target = binding && !binding.invalid ? binding.target ?? functionIds.get(binding.targetNode) : null;
    if (target) add(out.links, { kind: 'lexical_binding_candidate', fromFunctionId: owner, toFunctionId: target, callId: id });
    else out.unknown.unresolvedCalls++;
    add(out.calls, { id, functionId: owner, kind: node.type, callee, technicalTail: fixedTail, arguments: args, signals: [...signals], location: LOC(node) });
  }
  const evidence = c => c.signals.length > 0 || c.arguments.some(a => a.kind === 'static_path' || a.paths?.length);
  const relevant = new Set(out.calls.filter(evidence).map(c => c.functionId).filter(Boolean));
  for (const p of out.paths) if (p.functionId) relevant.add(p.functionId);
  // Bounded syntactic neighborhood, never an assertion of runtime reachability.
  for (let pass = 0; pass < 8; pass++) {
    let changed = false;
    for (const l of out.links) {
      if (!l.fromFunctionId) continue;
      if (relevant.has(l.fromFunctionId) || relevant.has(l.toFunctionId)) {
        for (const id of [l.fromFunctionId, l.toFunctionId]) if (!relevant.has(id)) { relevant.add(id); changed = true; }
      }
    }
    if (!changed) break;
  }
  const targetByCall = new Map(out.links.filter(l => l.kind === 'lexical_binding_candidate').map(l => [l.callId, l.toFunctionId]));
  const requestTails = new Set(['request', 'fetch', 'get', 'post', 'axios']);
  const callRank = c => evidence(c) ? 3 : relevant.has(c.functionId) || relevant.has(targetByCall.get(c.id)) ? 2 :
    requestTails.has(c.technicalTail) || c.arguments.some(a => a.methods?.length || a.objects?.length) ? 1 : 0;
  function select(array, rank = () => 0) {
    array.sort((a, b) => rank(b) - rank(a) || a.location?.start - b.location?.start || 0);
    if (array.length > LIMITS.entries) {
      out.truncated = true; out.unknown.omittedEntries += array.length - LIMITS.entries;
      array.length = LIMITS.entries;
    }
    return array;
  }
  select(out.calls, callRank);
  const callIds = new Set(out.calls.map(c => c.id));
  const owners = new Set(out.calls.map(c => c.functionId).filter(Boolean));
  const targets = new Set(out.links.filter(l => callIds.has(l.callId)).map(l => l.toFunctionId));
  select(out.functions, f => owners.has(f.id) ? 3 : targets.has(f.id) ? 2 : relevant.has(f.id) ? 1 : 0);
  const functionIdsEmitted = new Set(out.functions.map(f => f.id));
  const previousLinks = out.links.length;
  out.links = out.links.filter(l => callIds.has(l.callId) && (!l.fromFunctionId || functionIdsEmitted.has(l.fromFunctionId)) && functionIdsEmitted.has(l.toFunctionId));
  if (out.links.length !== previousLinks) { out.truncated = true; out.unknown.omittedEntries += previousLinks - out.links.length; }
  select(out.links);
  for (const c of out.calls) for (let i = 0; i < c.arguments.length; i++) {
    const a = c.arguments[i];
    if (a.kind === 'callback' && !functionIdsEmitted.has(a.functionId)) {
      c.arguments[i] = { index: a.index, kind: 'unknown' }; out.unknown.dynamicArguments++;
    }
  }
  const technicalProperty = new Set(['url', 'path', 'params', 'query', 'body', 'data', 'method', 'blob', 'download', 'saveAs', 'router', 'sbuuid', 'DescribeSbmxcx2']);
  select(out.properties, p => relevant.has(p.functionId) ? 2 : technicalProperty.has(p.name) ? 1 : 0);
  select(out.paths, p => relevant.has(p.functionId) ? 1 : 0);
  select(out.labels, p => relevant.has(p.functionId) ? 1 : 0);
  for (const list of [out.properties, out.paths, out.labels]) for (const item of list) {
    if (item.functionId && !functionIdsEmitted.has(item.functionId)) { item.functionId = null; item.functionOmitted = true; }
  }
  return out;
}
