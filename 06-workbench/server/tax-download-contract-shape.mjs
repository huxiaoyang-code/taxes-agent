import { createRequire } from 'node:module';

// Pure local syntax inspection: no evaluation, I/O, requests or source excerpts.
let parse;
try { ({ parse } = createRequire(import.meta.url)('internal/deps/acorn/acorn/dist/acorn')); }
catch { /* An unavailable parser cannot be replaced by a regex approximation. */ }

const LIMITS = Object.freeze({ sourceCharacters: 4_000_000, astNodes: 160_000,
  outputs: 32, objectKeys: 32, queryFields: 16, keyCharacters: 40, routeCharacters: 240, routeSegments: 10, segmentCharacters: 40 });
const FUNCTIONS = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
const CREDENTIAL = /(?:password|passwd|pwd|secret|token|authorization|credential|cookie|session|bearer|privatekey|accesskey|apikey)/i;
const ACTION = /(?:submit|delete|remove|update|insert|create|save|commit|pay|payment|cancel|revoke|withdraw|logout|login|signin|sso|tpass|auth|declare|filing|申报|缴款)/i;
const ID_SHAPE = /(?:[0-9]{6,}|[a-f0-9]{16,}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i;
const placeholders = () => Array.from({ length: 7 }, (_, i) => ({ name: `field_${i + 1}`, observedBodyKeyBound: false }));
// Exactly 32 fixed diagnostic scalar leaves. Nothing is named from the source.
const diagnostics = () => ({ body: { intersectionHistogram: Array(8).fill(0),
  maximumIntersection: 0, maximumCandidateCount: 0, keyCountMin: 0, keyCountMax: 0, exactCaseIntersectionMax: 0,
  rejectedAtMaximum: { spread: false, computed: false, methodOrAccessor: false,
    unsafeKey: false, caseCollision: false, over32: false, keySetMismatch: false } },
  resolve: { ownerKinds: { router_identifier: 0, this_router: 0, identifier_alias: 0,
    router_member_alias: 0, computed: 0, other: 0 }, rejected: { notExactOwner: 0,
    argumentShape: 0, objectShape: 0, pathNotLiteral: 0, pathRejected: 0, queryShape: 0 } } });
const base = status => ({ schemaVersion: 1, status, analysis: 'static_syntax_candidates_only',
  requestAuthorized: false, enterpriseBinding: false, consumable: false, readOnlyVerified: false,
  limits: { ...LIMITS }, bodyFields: placeholders(), bodyShapeBound: false,
  bodyCandidateCount: 0, observedBodyFields: [], routerCandidates: [], truncated: false, diagnostics: diagnostics() });
const keySafe = key => typeof key === 'string' && key.length <= LIMITS.keyCharacters
  && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) && !CREDENTIAL.test(key) && !ID_SHAPE.test(key);
const literal = node => node?.type === 'Literal' && typeof node.value === 'string' ? node.value : null;

function objectKeys(node) {
  if (node?.type !== 'ObjectExpression' || node.properties.length > LIMITS.objectKeys) return null;
  const keys = [], normalized = new Set();
  for (const property of node.properties) {
    if (property.type !== 'Property' || property.computed || property.method || property.kind !== 'init') return null;
    const key = property.key.type === 'Identifier' ? property.key.name : literal(property.key);
    if (!keySafe(key) || normalized.has(key.toLowerCase())) return null;
    normalized.add(key.toLowerCase()); keys.push(key);
  }
  return keys;
}

function routeSafe(path) {
  if (typeof path !== 'string' || path.length > LIMITS.routeCharacters || !path.startsWith('/')
    || path.startsWith('//') || /[?#:%\\.\s]/.test(path)) return false;
  const segments = path.slice(1).split('/');
  return segments.length <= LIMITS.routeSegments && segments.every(segment =>
    segment.length > 0 && segment.length <= LIMITS.segmentCharacters
    && /^[A-Za-z][A-Za-z0-9_-]*$/.test(segment)
    && !ID_SHAPE.test(segment) && !CREDENTIAL.test(segment) && !ACTION.test(segment));
}

function routerResolve(node) {
  if (node?.type !== 'CallExpression' || node.optional || node.arguments.length !== 1) return false;
  const callee = node.callee;
  if (callee?.type !== 'MemberExpression' || callee.computed || callee.optional
    || callee.property.type !== 'Identifier' || callee.property.name !== 'resolve') return false;
  const owner = callee.object;
  return owner?.type === 'Identifier' && owner.name === 'router'
    || owner?.type === 'MemberExpression' && !owner.computed && !owner.optional
      && owner.object?.type === 'ThisExpression' && owner.property.type === 'Identifier' && owner.property.name === '$router';
}

const emptyQuerySchema = () => ({ fields: [], complete: false, schemaOnly: true,
  evidence: 'static_candidate', readOnlyVerified: false, navigationTemplateAuthorized: false });

function queryFieldSchema(node, context) {
  const out = emptyQuerySchema();
  if (node?.type !== 'ObjectExpression' || node.properties.length > LIMITS.queryFields) return out;
  const names = new Set();
  for (const property of node.properties) {
    if (property.type !== 'Property' || property.computed || property.method || property.kind !== 'init') return out;
    const name = property.key.type === 'Identifier' ? property.key.name : literal(property.key);
    if (!(name === 'token' || keySafe(name)) || names.has(name.toLowerCase())) return out;
    names.add(name.toLowerCase());
  }
  const fields = [];
  for (const property of node.properties) {
    const name = property.key.type === 'Identifier' ? property.key.name : literal(property.key), value = property.value;
    const field = { name, credentialField: name === 'token', sourceKind: 'dynamic_unknown' };
    if (value.type === 'Literal' && !value.regex) field.sourceKind = 'static_literal';
    else if (value.type === 'MemberExpression' && !value.computed && !value.optional
      && value.object.type === 'Identifier' && value.property.type === 'Identifier'
      && context && !context.ambiguous && context.parameters.has(value.object.name)
      && !context.blocked.has(value.object.name) && keySafe(value.property.name)) {
      field.sourceKind = 'parameter_property'; field.sourceProperty = value.property.name;
    }
    fields.push(field);
  }
  out.fields = fields; out.complete = true; return out;
}

function blockBindings(pattern, context) {
  if (!context || !pattern) return;
  const stack = [pattern];
  while (stack.length) {
    const node = stack.pop(); if (!node) continue;
    if (node.type === 'Identifier') context.blocked.add(node.name);
    else if (node.type === 'RestElement') stack.push(node.argument);
    else if (node.type === 'AssignmentPattern') stack.push(node.left);
    else if (node.type === 'ArrayPattern') stack.push(...node.elements);
    else if (node.type === 'ObjectPattern') for (const property of node.properties)
      stack.push(property.type === 'RestElement' ? property.argument : property.value);
  }
}

function bodyDiagnostic(node, observed, exact, output) {
  const direct = new Set(), folded = new Set(), rejected = { spread: false, computed: false,
    methodOrAccessor: false, unsafeKey: false, caseCollision: false,
    over32: node.properties.length > LIMITS.objectKeys, keySetMismatch: false };
  for (const property of node.properties) {
    if (property.type !== 'Property') { rejected.spread = true; continue; }
    if (property.computed) { rejected.computed = true; continue; }
    if (property.method || property.kind !== 'init') rejected.methodOrAccessor = true;
    const key = property.key.type === 'Identifier' ? property.key.name : literal(property.key);
    if (typeof key !== 'string') { rejected.unsafeKey = true; continue; }
    if (!keySafe(key)) rejected.unsafeKey = true;
    if (folded.has(key.toLowerCase())) rejected.caseCollision = true;
    direct.add(key); folded.add(key.toLowerCase());
  }
  const intersection = [...observed].filter(key => folded.has(key)).length;
  const exactIntersection = [...exact].filter(key => direct.has(key)).length;
  rejected.keySetMismatch = node.properties.length !== 7 || folded.size !== 7 || intersection !== 7;
  output.intersectionHistogram[intersection]++;
  if (output.maximumCandidateCount && intersection < output.maximumIntersection) return;
  const count = Math.min(node.properties.length, LIMITS.objectKeys + 1);
  if (!output.maximumCandidateCount || intersection > output.maximumIntersection) {
    output.maximumIntersection = intersection; output.maximumCandidateCount = 0;
    output.keyCountMin = count; output.keyCountMax = count; output.exactCaseIntersectionMax = 0;
    for (const key of Object.keys(output.rejectedAtMaximum)) output.rejectedAtMaximum[key] = false;
  }
  output.maximumCandidateCount++; output.keyCountMin = Math.min(output.keyCountMin, count);
  output.keyCountMax = Math.max(output.keyCountMax, count);
  output.exactCaseIntersectionMax = Math.max(output.exactCaseIntersectionMax, exactIntersection);
  for (const key of Object.keys(rejected)) output.rejectedAtMaximum[key] ||= rejected[key];
}

function resolveDiagnostic(node, output) {
  if (node.type !== 'CallExpression') return;
  const callee = node.callee;
  const tail = callee?.type === 'Identifier' ? callee.name : callee?.type === 'MemberExpression'
    ? callee.property?.type === 'Identifier' && !callee.computed ? callee.property.name : literal(callee.property) : null;
  if (tail !== 'resolve') return;
  const owner = callee.type === 'MemberExpression' ? callee.object : null;
  let kind = 'other';
  if (callee.computed || owner?.computed) kind = 'computed';
  else if (owner?.type === 'Identifier') kind = owner.name === 'router' ? 'router_identifier' : 'identifier_alias';
  else if (owner?.type === 'MemberExpression' && owner.property?.type === 'Identifier' && owner.property.name === '$router')
    kind = owner.object?.type === 'ThisExpression' ? 'this_router' : 'router_member_alias';
  output.ownerKinds[kind]++;
  const rejected = output.rejected;
  if (!['router_identifier', 'this_router'].includes(kind) || callee.type !== 'MemberExpression'
    || callee.optional || node.optional) rejected.notExactOwner++;
  if (node.arguments.length !== 1 || node.arguments[0]?.type !== 'ObjectExpression') { rejected.argumentShape++; return; }
  const object = node.arguments[0], keys = objectKeys(object);
  if (keys?.length !== 2 || !keys.includes('path') || !keys.includes('query')) { rejected.objectShape++; return; }
  const properties = new Map(object.properties.map(property => [property.key.type === 'Identifier'
    ? property.key.name : literal(property.key), property.value]));
  const path = literal(properties.get('path'));
  if (path === null) rejected.pathNotLiteral++;
  else if (!routeSafe(path)) rejected.pathRejected++;
  if (!objectKeys(properties.get('query'))) rejected.queryShape++;
}

/** Caller supplies an already localized component string and the seven actual
 * observed body KEY NAMES, never values. Names are emitted only after complete,
 * case-insensitive bijection with a unique direct object shape. Router findings
 * are limited syntax candidates, never live routes or authorized operations. */
export function inspectDownloadContractShape(source, observedBodyKeys) {
  try {
    // Observation provenance is supplied by the trusted local caller. Safe DTO
    // key metadata is independent of whether this component binds the DTO.
    if (!Array.isArray(observedBodyKeys) || observedBodyKeys.length !== 7) return base('invalid_observed_keys');
    const normalized = new Set();
    for (const key of observedBodyKeys) {
      if (!keySafe(key) || normalized.has(key.toLowerCase())) return base('invalid_observed_keys');
      normalized.add(key.toLowerCase());
    }
    const out = inspect(source, observedBodyKeys);
    out.observedBodyFields = observedBodyKeys.map(name => ({ name, evidence: 'observed_request_metadata', schemaOnly: true }));
    return out;
  }
  catch { return base('analysis_error'); }
}

function inspect(source, observedBodyKeys) {
  if (typeof source !== 'string') return base('invalid_source');
  if (source.length > LIMITS.sourceCharacters) return base('source_limit');
  const observed = new Set(observedBodyKeys.map(key => key.toLowerCase()));
  if (!parse) return base('parser_unavailable');
  let ast;
  try { ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' }); }
  catch {
    try { ast = parse(source, { ecmaVersion: 'latest', sourceType: 'script' }); }
    catch { return base('parse_error'); }
  }
  const out = base('inspected'), stack = [{ node: ast, context: null }], matches = [], routes = [], exact = new Set(observedBodyKeys);
  let nodes = 0;
  while (stack.length) {
    const frame = stack.pop(), node = frame.node;
    let context = frame.context;
    if (++nodes > LIMITS.astNodes) { const closed = base('ast_limit'); closed.truncated = true; return closed; }
    if (FUNCTIONS.has(node.type)) {
      if (node.type === 'FunctionDeclaration') blockBindings(node.id, context);
      context = { parameters: new Set(node.params.filter(parameter => parameter.type === 'Identifier').map(parameter => parameter.name)),
        blocked: new Set(), ambiguous: false };
      blockBindings(node.id, context);
    } else if (context) {
      if (node.type === 'VariableDeclarator') blockBindings(node.id, context);
      if (node.type === 'CatchClause') blockBindings(node.param, context);
      if (node.type === 'ClassDeclaration') blockBindings(node.id, context);
      if (node.type === 'AssignmentExpression') blockBindings(node.left, context);
      if (node.type === 'UpdateExpression') blockBindings(node.argument, context);
      if (node.type === 'WithStatement' || node.type === 'CallExpression' && node.callee?.type === 'Identifier'
        && node.callee.name === 'eval') context.ambiguous = true;
    }
    if (node.type === 'ObjectExpression') {
      bodyDiagnostic(node, observed, exact, out.diagnostics.body);
      const keys = objectKeys(node);
      if (keys?.length === 7 && keys.every(key => observed.has(key.toLowerCase()))) {
        // Keep only enough matches to prove ambiguity, not arbitrary source data.
        out.bodyCandidateCount++; if (matches.length < 2) matches.push(keys);
      }
    }
    resolveDiagnostic(node, out.diagnostics.resolve);
    if (routerResolve(node)) {
      const object = node.arguments[0], keys = objectKeys(object);
      if (keys?.length === 2 && keys.includes('path') && keys.includes('query')) {
        const properties = new Map(object.properties.map(property => [property.key.type === 'Identifier'
          ? property.key.name : literal(property.key), property.value]));
        const path = literal(properties.get('path')), queryKeys = objectKeys(properties.get('query'));
        if (routeSafe(path)) {
          // A safe literal syntax candidate does not authorize navigation. The
          // independently incomplete query schema must not hide that candidate
          // or leak any query names/values from a rejected object shape.
          if (routes.length < LIMITS.outputs) routes.push({ candidate: { path, queryKeys: queryKeys ?? [],
            staticQueryObjectBound: queryKeys !== null, querySchemaComplete: queryKeys !== null,
            navigationTemplateAuthorized: false }, queryNode: properties.get('query'), context });
          else out.truncated = true;
        }
      }
    }
    const children = [];
    for (const [key, value] of Object.entries(node)) {
      if (key === 'start' || key === 'end') continue;
      if (Array.isArray(value)) { for (const child of value) if (child?.type) children.push(child); }
      else if (value?.type) children.push(value);
    }
    for (let i = children.length - 1; i >= 0; i--) stack.push({ node: children[i], context });
  }
  if (matches.length === 1) {
    out.bodyFields = matches[0].map(name => ({ name, observedBodyKeyBound: true }));
    out.bodyShapeBound = true;
  }
  // At most 32 field/key/path names altogether, including observed DTO metadata
  // and fixed placeholders. Diagnostic scalars have their separate fixed shape.
  let remaining = LIMITS.outputs - out.bodyFields.length - observedBodyKeys.length;
  const selected = [];
  for (const internal of routes) {
    const route = internal.candidate;
    const cost = 1 + route.queryKeys.length;
    if (cost > remaining) { out.truncated = true; continue; }
    out.routerCandidates.push(route); selected.push(internal); remaining -= cost;
  }
  let fieldBudget = LIMITS.queryFields;
  for (const internal of selected) {
    const schema = queryFieldSchema(internal.queryNode, internal.context);
    const cost = schema.fields.reduce((sum, field) => sum + 1 + (field.sourceProperty ? 1 : 0), 0);
    if (cost > remaining || schema.fields.length > fieldBudget) {
      internal.candidate.queryFieldSchema = emptyQuerySchema(); out.truncated = true;
    } else {
      internal.candidate.queryFieldSchema = schema; remaining -= cost; fieldBudget -= schema.fields.length;
    }
  }
  return out;
}
