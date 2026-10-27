// Durable local orchestration metadata, never a ledger. Business writes belong
// exclusively to fixed adapters and their existing audited domain operations.
import { mkdir, open, readdir, rename, unlink, lstat } from 'node:fs/promises';
import { resolve, dirname, join, isAbsolute } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { checkedPath, readLocalFile } from './offline-material-store.mjs';
import { validateHarnessScope, validateFact, validatePlanGraph, validateFeedback, validateHarnessTaskState, capabilitySupportsScope, idPattern, requestFactIdForTask } from './harness-contract.mjs';
import {validateRegisteredFactEvidence,factEvidenceError,factValueDigest} from './harness-fact-evidence.mjs';

export const VERSION = 'finance-harness-store/1';
export const stable = v => Array.isArray(v) ? `[${v.map(stable).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}` : JSON.stringify(v);
export const hash = v => createHash('sha256').update(typeof v === 'string' || Buffer.isBuffer(v) ? v : stable(v)).digest('hex');
export const requireValue = (v, code = 'harness_input_invalid') => { if (!v) throw Object.assign(new Error(code), { code }); };
export const sameBusinessRequest = (capabilityId,left,right) => {
  if(capabilityId!=='agency.posting'||!left||!right)return stable(left)===stable(right);
  const business=({batchId,evidenceDir,feedbackPath,...facts})=>facts;
  return stable(business(left))===stable(business(right));
};
const jsonFile = async p => JSON.parse((await readLocalFile(p, 16 * 1024 * 1024)).bytes.toString('utf8'));
const identity = s => `${s.dev}:${s.ino}:${s.birthtimeMs}`;
async function writeNew(path, bytes) { const f = await open(path, 'wx', 0o600); try { await f.writeFile(bytes); await f.sync(); } finally { await f.close(); } }
async function rootInfo(path) { const root = await checkedPath(path, true); return { root, identity: identity(await lstat(root)) }; }
const assertRoot = async info => requireValue((await rootInfo(info.root)).identity === info.identity, 'harness_path_changed');

export async function initHarness(path, scope) {
  validateHarnessScope(scope); requireValue(isAbsolute(path), 'harness_path_invalid');
  const root = resolve(path); await checkedPath(dirname(root), true);
  await mkdir(root, { mode: 0o700 }); await mkdir(join(root, 'events'), { mode: 0o700 });
  await writeNew(join(root, 'store.json'), stable({ version: VERSION, storeId: randomUUID(), scope }) + '\n');
  return { version: VERSION, status: 'initialized', scope };
}
export async function loadHarness(path) {
  const info = await rootInfo(path), meta = await jsonFile(join(info.root, 'store.json'));
  requireValue(meta.version === VERSION && typeof meta.storeId === 'string', 'harness_store_invalid'); validateHarnessScope(meta.scope);
  const state = { info, meta, head: hash(meta), events: [], sources: new Map(), invalidatedSources:new Set(), invalidatedResults:new Set(), capabilityEpochs:new Map(), factEpochs:new Map(), facts: new Map(), tasks: [], attempts: [], feedbacks: [], requests: [], treatments: [] };
  const files = (await readdir(join(info.root, 'events'))).sort(); requireValue(files.length <= 10000, 'harness_store_limit');
  for (const name of files) {
    // Uncommitted temporary files have no authority; retain them for diagnosis.
    if (/^pending-[a-f0-9-]+\.json$/.test(name)) continue;
    requireValue(/^\d{8}\.json$/.test(name), 'harness_journal_invalid');
    const e = await jsonFile(join(info.root, 'events', name)), { digest, ...body } = e;
    requireValue(e.sequence === state.events.length + 1 && name === `${String(e.sequence).padStart(8, '0')}.json` && e.previous === state.head && digest === hash(body), 'harness_journal_invalid');
    state.events.push(e); state.head = digest; apply(state, e);
  }
  await assertRoot(info); return state;
}
function apply(s, e) {
  const d = e.data;
  if (e.kind === 'source') {s.sources.set(d.sourceId, d);s.invalidatedSources.delete(d.sourceId);}
  else if (e.kind === 'invalidate_source') s.invalidatedSources.add(d.sourceId);
  else if (e.kind === 'invalidate_result') s.invalidatedResults.add(d.targetVersion);
  else if (e.kind === 'capabilities') d.forEach(c=>s.capabilityEpochs.set(c.capabilityId,{codeDigest:c.codeDigest,...(c.codeTraceDigest?{codeTraceDigest:c.codeTraceDigest}:{}),epoch:e.digest}));
  else if (e.kind === 'facts') d.forEach(f => {s.facts.set(f.factId, f);s.factEpochs.set(f.factId,e.digest);});
  else if (e.kind === 'plan') s.tasks = d;
  else if (e.kind === 'intent') s.attempts.push({ ...d, intentDigest: e.digest, result: null });
  else if (e.kind === 'result' || e.kind === 'reconcile') { const a = s.attempts.find(a => a.intentDigest === d.intentDigest); requireValue(a && (e.kind==='reconcile'||!a.result), 'harness_journal_invalid'); a.result = d.receipt; }
  else if (e.kind === 'feedback') s.feedbacks.push(d);
  else if (e.kind === 'request') s.requests.push(d);
  else if (e.kind === 'treatment') s.treatments.push(d);
  else requireValue(false, 'harness_journal_invalid');
}
async function locked(path, fn) {
  const info = await rootInfo(path), file = join(info.root, 'writer.lock'), lock = stable({ version: VERSION, pid: process.pid, token: randomUUID() });
  const noRecovery=async()=>{try{await lstat(join(info.root,'recovery.guard'));requireValue(false,'harness_recovery_blocked');}catch(e){if(e.code!=='ENOENT')throw e;}};
  await noRecovery();
  try { await writeNew(file, lock); } catch (e) { if (e.code === 'EEXIST') throw Object.assign(new Error('harness_locked'),{code:'harness_locked',retryable:true}); throw e; }
  try {await noRecovery(); const s = await loadHarness(info.root); await assertRoot(info); return await fn(s); }
  finally { await assertRoot(info); requireValue((await readLocalFile(file)).bytes.toString() === lock, 'harness_lock_changed'); await unlink(file); }
}
export async function appendHarness(s, kind, data) {
  await assertRoot(s.info); const current = await loadHarness(s.info.root); requireValue(current.head === s.head, 'harness_cas_mismatch');
  const body = { sequence: s.events.length + 1, previous: s.head, kind, data, recordedAt: new Date().toISOString() }, e = { ...body, digest: hash(body) };
  const file = join(s.info.root, 'events', `${String(e.sequence).padStart(8, '0')}.json`), pending = join(s.info.root, 'events', `pending-${randomUUID()}.json`);
  await writeNew(pending, stable(e) + '\n'); await assertRoot(s.info); await rename(pending, file);
  s.events.push(e); s.head = e.digest; apply(s, e); return e;
}
export const withHarness = locked;

// A dependency/code change must not hide an accountant rejection of the same
// native operation. Read the retained receipt events, not only its latest view.
export function operationWasRejected(s, operationId) {
  const versions=new Set(s.events.filter(e=>['result','reconcile'].includes(e.kind)&&e.data.receipt.operationId===operationId).map(e=>e.data.receipt.targetVersion));
  return s.feedbacks.some(f=>f.decision==='reject'&&versions.has(f.targetVersion));
}

export async function recoverHarnessLock(path) {
  const info=await rootInfo(path),guard=join(info.root,'recovery.guard'),guardBytes=stable({version:VERSION,pid:process.pid,token:randomUUID()});
  try{await writeNew(guard,guardBytes);}catch(e){if(e.code==='EEXIST')requireValue(false,'harness_recovery_blocked');throw e;}
  try{
  const s = await loadHarness(path), file = join(s.info.root, 'writer.lock'), bytes = (await readLocalFile(file)).bytes, lock = JSON.parse(bytes.toString());
  requireValue(lock.version === VERSION && Number.isSafeInteger(lock.pid) && lock.pid > 0 && typeof lock.token === 'string', 'harness_recovery_blocked');
  let absent = false; try { process.kill(lock.pid, 0); } catch (e) { absent = e.code === 'ESRCH'; }
  requireValue(absent, 'harness_recovery_blocked'); await assertRoot(s.info);
  requireValue((await readLocalFile(file)).bytes.equals(bytes), 'harness_lock_changed'); await unlink(file);
  return { status: 'lock_recovered', outcome: 'query_pending_writes_before_execute' };
  }finally{await assertRoot(info);requireValue((await readLocalFile(guard)).bytes.toString()===guardBytes,'harness_lock_changed');await unlink(guard);}
}
const checkedFiles = async paths => {
  requireValue(Array.isArray(paths) && paths.length <= 1000, 'harness_evidence_invalid');
  const out = []; for (const path of paths) { requireValue(isAbsolute(path), 'harness_evidence_invalid'); const f = await readLocalFile(path, 64 * 1024 * 1024); out.push({ path: f.canonicalPath, digest: hash(f.bytes) }); } return out;
};
export async function registerHarnessSource(path, source, currentView) {
  requireValue(source && idPattern.test(source.sourceId) && typeof source.locator === 'string' && source.locator.length > 0 && Array.isArray(source.unrecognized) && typeof source.classification === 'string', 'harness_source_invalid');
  // Any file extension/layout is accepted. The host investigates and produces
  // parser code and validation artifacts; this module does not execute that code.
  const originals = await checkedFiles([source.path]), code = await checkedFiles(source.codePaths ?? []), validation = await checkedFiles(source.validationPaths ?? []);
  requireValue(!source.parsed || code.length > 0 && validation.length > 0, 'harness_parser_proof_required');
  const data = { sourceId: source.sourceId, locator: source.locator, originals, code, validation, parsed: source.parsed === true, unrecognized: source.unrecognized, classification: source.classification };
  data.contentDigest = hash(data);
  return locked(path, async s => { const old = s.sources.get(data.sourceId),same=old?.contentDigest===data.contentDigest&&!s.invalidatedSources.has(data.sourceId);data.revision=(old?.revision??0)+(same?0:1);data.sourceVersion=hash(data);if(!same)await appendHarness(s,'source',data);return {status:same?'replayed':'registered',sourceId:data.sourceId,sourceVersion:same?old.sourceVersion:data.sourceVersion,...(currentView?continuation(await currentView(s),same?[]:s.tasks.filter(t=>t.factIds.some(id=>s.facts.get(id)?.sourceRefs.includes(data.sourceId))).map(t=>t.taskId)):{} )}; });
}
export async function registerHarnessFacts(path, facts, currentView) {
  requireValue(Array.isArray(facts) && facts.length > 0 && facts.length <= 10000, 'harness_facts_invalid'); facts.forEach(f=>{try{validateFact(f);}catch(error){throw factEvidenceError(error,f,{field:'fact'});}});
  requireValue(new Set(facts.map(f => f.factId)).size === facts.length, 'harness_facts_invalid');
  return locked(path, async s => {
    for (const f of facts) requireValue(f.sourceRefs.every(ref => s.sources.has(ref)), 'harness_source_missing');
    const combinedFacts=new Map([...s.facts,...facts.map(f=>[f.factId,f])]);
    for(const f of facts)await validateRegisteredFactEvidence(f,s.sources,combinedFacts);
    const changed = facts.filter(f => stable(f) !== stable(s.facts.get(f.factId)));
    if (changed.length) await appendHarness(s, 'facts', changed); return { status: changed.length ? 'registered' : 'replayed', changedFactIds: changed.map(f => f.factId),factBindings:facts.map(f=>({factId:f.factId,state:f.state,factVersion:s.factEpochs.get(f.factId),...(f.state==='provided'?{valueDigest:factValueDigest(f.value)}:{})})),legacyEvidence:{factIds:facts.filter(f=>f.state==='provided'&&!f.evidence).map(f=>f.factId),verified:false,limitation:'Compatibility facts with sourceRefs alone have no checked support for their values.'},...(currentView?continuation(await currentView(s),s.tasks.filter(t=>t.factIds.some(id=>changed.some(f=>f.factId===id))).map(t=>t.taskId)):{} ) };
  });
}
export async function saveHarnessPlan(path, tasks, capabilities) {
  validatePlanGraph(tasks);
  tasks = await Promise.all(tasks.map(async t => {
    if (!t.externalDependencies) return t;
    const refs = [];
    for (const ref of t.externalDependencies) {
      requireValue(isAbsolute(ref.storePath), 'harness_external_path_invalid');
      refs.push({...ref, storePath:await checkedPath(ref.storePath,true)});
    }
    return {...t, externalDependencies:refs};
  }));
  validatePlanGraph(tasks);
  return locked(path, async s => {
    for (const t of tasks) requireValue(capabilities.has(t.capabilityId) && t.factIds.every(f => s.facts.has(f)), 'harness_plan_reference_invalid');
    if (stable(tasks) !== stable(s.tasks)) await appendHarness(s, 'plan', tasks);
    return { status: 'saved', taskIds: tasks.map(t => t.taskId), journalHead: s.head };
  });
}
export async function sourceFreshness(s) {
  const out = new Map();
  for (const source of s.sources.values()) {
    let fresh = true;
    for (const file of [...source.originals, ...source.code, ...source.validation]) {
      try { if (hash((await readLocalFile(file.path, 64 * 1024 * 1024)).bytes) !== file.digest) fresh = false; } catch { if(fresh!==false)fresh=null; }
    }
    out.set(source.sourceId, fresh);
  }
  return out;
}
export async function harnessView(s, capabilities, externalByTask = new Map(), proofObservations = new Map()) {
  const fresh = await sourceFreshness(s), byId = new Map(s.tasks.map(t => [t.taskId, t])), views = new Map();
  for(const [sourceId,current] of fresh)if(current===false&&!s.invalidatedSources.has(sourceId))await appendHarness(s,'invalidate_source',{sourceId});
  // Old events without codeTraceDigest remain readable and conservatively gain
  // one new epoch. An observed bridge change/restore never revives old review.
  const currentCaps=[...capabilities.values()].map(c=>({capabilityId:c.capabilityId,codeDigest:c.codeDigest,codeTraceDigest:hash(c.traceReferences.filter(r=>r.kind==='code'))}));
  const changedCaps=currentCaps.filter(c=>{const prior=s.capabilityEpochs.get(c.capabilityId);return prior?.codeDigest!==c.codeDigest||prior?.codeTraceDigest!==c.codeTraceDigest;});
  if(changedCaps.length)await appendHarness(s,'capabilities',changedCaps);
  const treatmentCurrent=new Map();
  for(const treatment of s.treatments)treatmentCurrent.set(treatment.treatmentId,s.sources.get(treatment.draftSourceId)?.sourceVersion===treatment.draftSourceVersion&&fresh.get(treatment.draftSourceId)!==false&&!s.invalidatedSources.has(treatment.draftSourceId));
  const visit = t => {
    if (views.has(t.taskId)) return views.get(t.taskId);
    const cap = capabilities.get(t.capabilityId), parents = t.dependsOn.map(id => visit(byId.get(id))), facts = t.factIds.map(id => s.facts.get(id));
    const treatmentId=s.facts.get(requestFactIdForTask(t))?.value?.treatmentId,treatment=treatmentId?s.treatments.find(x=>x.treatmentId===treatmentId):null;
    const external = externalByTask.get(t.taskId) ?? (t.externalDependencies ?? []).map(ref=>({...ref,current:false,reason:'harness_external_dependency_unchecked'}));
    const sourceIds = [...new Set([...facts.flatMap(f => f.sourceRefs),...(treatment?[treatment.draftSourceId]:[])])];
    // Availability observations are blockers, never new business versions.
    // A verified change still advances the durable invalidation/epoch markers.
    const dependencyDigest = hash({ scope: s.meta.scope, task: t, capability: cap, capabilityEpoch:s.capabilityEpochs.get(t.capabilityId)?.epoch,facts:facts.map(f=>[f,s.factEpochs.get(f.factId)]),treatment:treatment?[treatment,treatmentCurrent.get(treatmentId)]:null,sources: sourceIds.map(id => [id, s.sources.get(id)?.sourceVersion, fresh.get(id)!==false,s.invalidatedSources.has(id)]), parents: parents.map(p => [p.taskId, p.dependencyDigest, p.receipt?.targetVersion ?? null, p.executionState, p.reviewState]),...(external.length?{external:external.map(({storePath,taskId,period,targetVersion,dependencyDigest,current,retryable})=>({storePath,taskId,period,targetVersion,dependencyDigest,current:retryable?true:current}))}:{} ) });
    const attempts = s.attempts.filter(a => a.taskId === t.taskId), last = attempts.at(-1), matching = attempts.filter(a => a.dependencyDigest === dependencyDigest).at(-1);
    const receipt = matching?.result ?? null;
    const feedbacks = receipt ? s.feedbacks.filter(f => f.taskId === t.taskId && f.targetVersion === receipt.targetVersion && f.dependencyDigest === dependencyDigest) : [];
    const reviewed = feedbacks.filter(f => ['accept', 'reject'].includes(f.decision)).at(-1);
    let executionState = matching ? receipt?.executionState ?? 'unknown' : last ? 'stale' : 'not_started';
    if(receipt&&s.invalidatedResults.has(receipt.targetVersion))executionState='stale';
    let reviewState = executionState === 'stale' ? 'stale' : reviewed ? reviewed.decision === 'accept' ? 'accepted' : 'rejected' : receipt?.reviewState ?? 'pending';
    const blockers = facts.filter(f => !['provided', 'not_applicable'].includes(f.state)).map(f => ({ factId: f.factId, state: f.state, reason: f.reason }));
    external.filter(ref=>!ref.current).forEach(ref=>blockers.push({state:ref.retryable?'unverified':ref.executionState==='unknown'?'unknown':'dependency_blocked',reason:ref.reason,storePath:ref.storePath,taskId:ref.taskId,period:ref.period,targetVersion:ref.targetVersion,...(ref.retryable?{retryable:true}:{})}));
    if(treatmentId&&(!treatment||!treatmentCurrent.get(treatmentId)))blockers.push({state:'conflict',reason:treatment?'treatment_policy_code_draft_or_validation_changed':'treatment_missing',treatmentId});
    sourceIds.filter(id => fresh.get(id)===false||s.invalidatedSources.has(id)).forEach(id => blockers.push({ sourceId: id, state: 'conflict', reason: 'source_code_or_validation_changed' }));
    sourceIds.filter(id=>fresh.get(id)===null).forEach(sourceId=>blockers.push({sourceId,state:'unverified',reason:'source_temporarily_unverifiable',retryable:true}));
    if(proofObservations.has(t.taskId))blockers.push(proofObservations.get(t.taskId));
    sourceIds.filter(id=>['unknown','missing','conflict','unsupported'].includes(s.sources.get(id)?.classification)).forEach(id=>blockers.push({sourceId:id,state:s.sources.get(id).classification,reason:'source_investigation_unresolved',layer:'parser',reproductionRefs:s.sources.get(id).validation.map(f=>f.path),handlingPath:'Investigate saved parser/validation report, retain unrecognized items, supplement evidence and register a resolved source version'}));
    const correction=s.facts.get(requestFactIdForTask(t))?.value?.correctionOf;
    parents.filter(p => !(correction?.taskId===p.taskId&&correction.targetVersion===p.receipt?.targetVersion&&s.attempts.some(a=>a.taskId===p.taskId&&a.result?.targetVersion===correction.targetVersion&&a.result.executionState==='executed'))&&(p.executionState !== 'executed' || p.reviewState === 'rejected' || p.blockers.length)).forEach(p => blockers.push({ taskId: p.taskId, state: 'dependency_blocked', reason: p.executionState,...(p.blockers.length&&p.blockers.every(b=>b.retryable)?{retryable:true}:{}) }));
    if (cap.availability === 'unavailable') blockers.push({ state: 'unsupported', reason: 'capability_unavailable' });
    if (!capabilitySupportsScope(cap,s.meta.scope)) blockers.push({state:'unsupported',reason:'harness_capability_period_unsupported',period:s.meta.scope.period});
    // An older interrupted write remains unresolved even if facts or rules changed.
    const sameRequest=s.attempts.filter(a=>a.effect==='write'&&a.capabilityId===t.capabilityId&&sameBusinessRequest(t.capabilityId,a.request,s.facts.get(requestFactIdForTask(t))?.value));
    const unresolved = [...attempts,...sameRequest].find(a => a.effect === 'write' && (!a.result || a.result.executionState === 'unknown'));
    if (unresolved) blockers.push({ state: 'unknown', reason: 'write_outcome_unknown', intentDigest: unresolved.intentDigest,originalTaskId:unresolved.taskId });
    const latestWrite=sameRequest.filter(a=>a.effect==='write').at(-1);
    if(latestWrite?.result?.executionState==='executed'&&(s.invalidatedResults.has(latestWrite.result.targetVersion)||latestWrite.codeDigest!==cap.codeDigest||latestWrite.ruleVersion!==cap.ruleVersion))blockers.push({state:'conflict',reason:'existing_write_requires_review_before_new_execution'});
    if(sameRequest.some(a=>operationWasRejected(s,a.operationId)))blockers.push({state:'correction_required',reason:'native_operation_previously_rejected'});
    if (reviewState === 'rejected') blockers.push({ state: 'correction_required', reason: 'accountant_rejected_execution' });
    const executed=attempts.filter(a=>a.result?.executionState==='executed').at(-1);
    const resultCurrent=executionState==='executed'?(blockers.length&&blockers.every(b=>b.retryable)?null:!blockers.length):false;
    const v = { ...t, dependencyDigest, executionState, reviewState, operationState:executed?'executed':unresolved?'unknown':last?.result?.executionState??'not_started',resultCurrent,confirmationCurrent:reviewState==='accepted'?resultCurrent:false,historicalReceipt:executed?.result??null,ruleState: feedbacks.some(f => f.decision === 'propose_public_rule') ? 'public_candidate' : feedbacks.some(f => f.decision === 'retain_enterprise_exception') ? 'enterprise_exception' : receipt?.ruleState ?? 'uncovered', receipt, blockers, unresolvedIntent: unresolved?.intentDigest ?? null };
    validateHarnessTaskState(v);
    if(external.length)v.externalDependencyStates=external;
    views.set(t.taskId, v); return v;
  };
  s.tasks.forEach(visit);
  const view = { version: VERSION, storePath:s.info.root, scope: s.meta.scope, journalHead: s.head, sources: [...s.sources.values()].map(x => ({ ...x, current: fresh.get(x.sourceId) })), facts: [...s.facts.values()], factBindings:[...s.facts.values()].map(f=>({factId:f.factId,state:f.state,factVersion:s.factEpochs.get(f.factId),...(f.state==='provided'?{valueDigest:factValueDigest(f.value)}:{})})), tasks: s.tasks.map(t => views.get(t.taskId)), feedbacks: s.feedbacks, requests: s.requests, treatments: s.treatments, history: s.attempts, periodComplete: false, submittable: false };
  view.nextSteps=continuation(view,view.tasks.map(t=>t.taskId)).nextSteps;return view;
}
export async function recordHarnessFeedback(path, feedback, capabilities, currentView = s=>harnessView(s,capabilities)) {
  validateFeedback(feedback);
  return locked(path, async s => {
    const view = await currentView(s), task = view.tasks.find(t => t.taskId === feedback.taskId);
    requireValue(task?.receipt && task.receipt.targetVersion === feedback.targetVersion && task.dependencyDigest === feedback.dependencyDigest && !task.blockers.some(b => b.reason !== 'accountant_rejected_execution') && task.executionState === 'executed', 'harness_feedback_stale');
    if (!s.feedbacks.some(f => stable(f) === stable(feedback))) await appendHarness(s, 'feedback', feedback);
    return { status: 'recorded', decision: feedback.decision, correctWithExistingBusinessTools: feedback.decision === 'reject', publicRulePromoted: false,...continuation(await currentView(s),[feedback.taskId]) };
  });
}
// Project the existing DAG; this is advice for the host, never an execution or
// approval. Changed upstream bindings do not silently retarget external Stores.
export function continuation(view, roots) {
  const affected=new Set(roots);let size;
  do{size=affected.size;for(const t of view.tasks)if(t.dependsOn.some(id=>affected.has(id)))affected.add(t.taskId);}while(size!==affected.size);
  const tasks=view.tasks.filter(t=>affected.has(t.taskId));
  return {affectedTasks:tasks.map(t=>t.taskId),invalidatedResults:tasks.filter(t=>t.historicalReceipt&&t.executionState==='stale').map(t=>({taskId:t.taskId,targetVersion:t.historicalReceipt.targetVersion})),blockers:tasks.flatMap(t=>t.blockers.map(b=>({taskId:t.taskId,...b}))),nextSteps:tasks.map(t=>{
    const base={taskId:t.taskId,requestFactId:requestFactIdForTask(t),dependencyDigest:t.dependencyDigest};
    if(t.unresolvedIntent)return {...base,action:'query_original_operation',tool:'harness_run',phase:'query',intentDigest:t.unresolvedIntent};
    if(t.blockers.some(b=>b.retryable))return {...base,action:'retry_verification',tool:'harness_status'};
    if(t.reviewState==='rejected'||t.blockers.some(b=>['native_operation_previously_rejected','accountant_rejected_execution'].includes(b.reason)))return {...base,action:'correct_with_existing_business_tools',originalReceipt:t.historicalReceipt?.targetVersion??t.receipt?.targetVersion,requiresNewPreparationAndConfirmation:true};
    if(t.blockers.length)return {...base,action:'resolve_blockers',tool:'harness_facts_register',requestFactId:requestFactIdForTask(t),requiredFacts:t.blockers.filter(b=>b.factId).map(({factId,state})=>({factId,state})),contract:{tool:'harness_discover',arguments:{capabilityId:t.capabilityId}},handlingPath:'Supplement or reconcile the indicated facts/sources, register the supported version and refresh the request fact. Independent branches can continue.'};
    if(t.executionState==='executed')return {...base,action:t.reviewState==='accepted'?'continue_dependents':'review_current_result',...(t.reviewState==='accepted'?{}:{tool:'harness_feedback',targetVersion:t.receipt.targetVersion})};
    if(t.historicalReceipt&&['agency.posting','offline.posting','voucher.create','voucher.post','voucher.unpost'].includes(t.capabilityId))return {...base,action:'query_original_operation',tool:'harness_run',phase:'query',originalOperationId:t.historicalReceipt.operationId,requiresCorrectionForChangedBusiness:true,requiresNewPreparationAndConfirmation:true};
    if(t.capabilityId==='agency.posting')return {...base,action:'prepare_current_proposal',tool:'harness_run',phase:'prepare',requiresAccountantConfirmation:true};
    return {...base,action:'recompute_task',tool:'harness_run',phase:'execute'};
  }).map(step=>step.tool==='harness_run'?{...step,arguments:{storePath:view.storePath,taskId:step.taskId,phase:step.phase??'execute',...(step.phase==='query'?{}:{dependencyDigest:step.dependencyDigest})}}:step),periodComplete:false,submittable:false};
}
export async function requestHarnessMaterials(path, request) {
  requireValue(request && typeof request.text === 'string' && request.text.trim().length > 0 && Array.isArray(request.taskIds), 'harness_request_invalid');
  return locked(path, async s => { requireValue(request.taskIds.every(id => s.tasks.some(t => t.taskId === id)), 'harness_request_invalid'); const data = { ...request, scope: s.meta.scope, requestId: hash(request) }; if (!s.requests.some(r => r.requestId === data.requestId)) await appendHarness(s, 'request', data); return { status: 'local_text_only', text: data.text, requestId: data.requestId, sent: false }; });
}
export async function registerHarnessTreatment(path, treatment) {
  requireValue(treatment && idPattern.test(treatment.treatmentId) && Array.isArray(treatment.traceReferences) && treatment.traceReferences.length > 0 && typeof treatment.reason === 'string' && treatment.reason.trim() && typeof treatment.draftSourceId === 'string' && Array.isArray(treatment.applicability) && treatment.applicability.length > 0, 'harness_treatment_invalid');
  const { validateTraceReference } = await import('./harness-contract.mjs'); treatment.traceReferences.forEach(validateTraceReference);
  const kinds=new Set(treatment.traceReferences.map(r=>r.kind));requireValue((kinds.has('policy')||kinds.has('rule'))&&kinds.has('code')&&kinds.has('validation'),'harness_treatment_evidence_required');
  return locked(path, async s => {
    const source=s.sources.get(treatment.draftSourceId);requireValue(source?.parsed&&source.code.length>0&&source.validation.length>0,'harness_treatment_draft_proof_required');
    requireValue((await sourceFreshness(s)).get(treatment.draftSourceId)&&!s.invalidatedSources.has(treatment.draftSourceId),'harness_treatment_evidence_changed');
    // Reuse the registered local evidence inventory. This checks binding and
    // freshness only; it is not a policy interpretation or validation engine.
    const inventory=[...source.originals,...source.code,...source.validation];
    requireValue(treatment.traceReferences.every(ref=>inventory.some(f=>f.path===ref.locator&&f.digest===ref.digest)),'harness_treatment_unregistered_evidence');
    const data={...treatment,draftSourceVersion:source.sourceVersion,scope:s.meta.scope,publicRuleState:'uncovered'};data.treatmentVersion=hash(data);
    const old=s.treatments.find(t=>t.treatmentId===data.treatmentId);requireValue(!old||old.treatmentVersion===data.treatmentVersion,'harness_treatment_id_conflict');
    if(!old)await appendHarness(s,'treatment',data);return {status:old?'replayed':'recorded',treatmentId:data.treatmentId,treatmentVersion:data.treatmentVersion,publicRulePromoted:false};
  });
}
