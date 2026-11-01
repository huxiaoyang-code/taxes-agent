import {parseImportAmount} from './import-amount.mjs';
// 正式入账的薄兜底：记录事实与未核声明，不替 Agent 编排业务。
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { types } from 'node:util';
import { mkdirSync, lstatSync, openSync, writeFileSync, fsyncSync, closeSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseMoney, formatCents } from './money.mjs';
import { captureBusinessEvidence } from './business-evidence.mjs';
import { currentRequestMetadata, currentDomainOperationMetadata, operationErrorEvidence, markOperationOutcomeUnknown } from './local-audit-coordinator.mjs';

const active = new AsyncLocalStorage(), failures = new WeakMap(), databaseFiles = new WeakMap();
export function registerPostingDatabase(db){if(!databaseFiles.has(db))databaseFiles.set(db,db.prepare('PRAGMA database_list').all().find(r=>r.name==='main')?.file);}
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const issue = (code, field, message, severity='review') => ({code, field:/^\/(?:voucher_date|period|businessEvidence|correctionOf|entries(?:\/\d+(?:\/(?:debit|credit|code))?)?)$/.test(field)?field:'/businessEvidence', message, severity});
const HARD_SOURCE_ERRORS=new Set(['finance_details_source_invalid','finance_details_scope_conflict','finance_details_reference_untrusted','finance_evidence_invalid','finance_evidence_pointer_invalid','finance_evidence_path_forbidden','finance_evidence_transform_invalid','finance_evidence_numeric_required','finance_evidence_selection_reason_required','finance_evidence_header_order','finance_evidence_encoding_invalid','finance_evidence_json_invalid','finance_evidence_csv_invalid']);
// 不执行 getter/toJSON，非有限数保留类型；原始输入不能被序列化为 null/0。
export function postingSnapshot(value, seen=new Set()) {
  if(value===undefined)return {$type:'undefined'};
  if(typeof value==='number'&&!Number.isFinite(value))return {$type:'number',value:String(value)};
  if(value===null||['string','number','boolean'].includes(typeof value))return value;
  if(typeof value!=='object')return {$type:typeof value};
  if(types.isProxy(value))return {$type:'proxy'};
  if(seen.has(value))return {$type:'circular'};
  seen.add(value);const out=Array.isArray(value)?[]:{};
  for(const [key,d] of Object.entries(Object.getOwnPropertyDescriptors(value))){if(key==='length'&&Array.isArray(value))continue;Object.defineProperty(out,key,{enumerable:true,value:/(?:password|authorization|api[_-]?key|token|credential|secret|cookie)/i.test(key)?'[credential redacted]':'value'in d?postingSnapshot(d.value,seen):{$type:'accessor'}});}
  seen.delete(value);return out;
}
function scope(db,setId) {
  registerPostingDatabase(db);const file=databaseFiles.get(db);
  if(!file)throw Error('posting_record_unavailable');
  const instance=db.prepare('SELECT instance_id FROM audit_database_instances WHERE is_active=1').get()?.instance_id;
  if(!instance)throw Error('posting_record_unavailable');
  const enterpriseKey=db.prepare('SELECT enterprise_key FROM import_enterprise_account_sets WHERE account_set_id=?').get(setId)?.enterprise_key??null;
  return {root:join(dirname(file),'posting-attempts'),databaseInstanceId:instance,accountSetId:setId,enterpriseKey};
}
function checkPath(path) {
  for(let current=path;;current=dirname(current)){try{if(lstatSync(current).isSymbolicLink())throw Error('posting_record_path_forbidden');}catch(e){if(e.code!=='ENOENT')throw e;}if(dirname(current)===current)break;}
}
function secureDirectory(path) {checkPath(path);mkdirSync(path,{recursive:true,mode:0o700});checkPath(path);}
function save(path,value) {
  const text=JSON.stringify(value,null,2)+'\n';if(Buffer.byteLength(text)>20*1024*1024)throw Error('posting_record_too_large');
  let fd;try{fd=openSync(path,'wx',0o600);writeFileSync(fd,text);fsyncSync(fd);}finally{if(fd!==undefined)closeSync(fd);}
  return createHash('sha256').update(text).digest('hex');
}
function load(path){checkPath(path);const st=lstatSync(path);if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size>20*1024*1024)throw Error('posting_record_invalid');return JSON.parse(readFileSync(path,'utf8'));}
function recordFailure(error, state, issues, attempt) {
  attempt.issues=issues;
  const details={status:state,nextAction:state==='correction_required'?'correct_input':'human_review',attemptId:attempt.id,issues,claimsMeaning:'采用理由是调用方声明，不等同原件事实或人工批准。'};
  error.code??=error.message==='voucher_invalid'?'voucher_invalid':state==='correction_required'?'posting_correction_required':'posting_needs_review';
  error.details={...(error.details??{}),postingGuard:details};failures.set(error,details);return error;
}
export function postingFailureProjection(error) {
  if(error?.code==='posting_record_finish_failed')return {applied:'unknown',needsLocalReview:true,nextAction:'query_original_operation'};
  const detail=failures.get(error);if(!detail)return null;
  const audit=operationErrorEvidence(error);if(audit?.applied==='unknown'||audit?.applied===true)return null;
  const guidance=detail.issues.some(i=>i.code==='source_configuration_missing')?'后台未配置受信审计目录，请先核对工具配置；这不代表企业缺少原件。':detail.issues.some(i=>i.code==='source_version_changed')?'计算结果或其原始资料版本已经变化，请重新核验来源后再提交。':detail.issues.some(i=>i.code==='calculation_source_unavailable')?'尚不能定位可信的已签发计算结果，请核对计算引用与后台配置。':detail.status==='correction_required'?'请依据原件更正所列字段；不要自行修改日期或金额来通过校验。':'候选已保留，需补充可核依据或由本机操作者复核。';
  return {applied:false,needsLocalReview:detail.status==='needs_review',postingGuard:{guidance,status:detail.status,nextAction:detail.nextAction,attemptId:detail.attemptId,issues:detail.issues.map(({code,field,severity})=>({code,field,severity}))},nextAction:detail.nextAction};
}
export function voucherDateIssues(date,period) {
  if(date===undefined||date===null||date==='')return [issue('voucher_date_missing','/voucher_date','未提供凭证日期；不得猜测为月初或自动入账。')];
  if(typeof date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(date))return [issue('voucher_date_invalid','/voucher_date','日期须为真实的 YYYY-MM-DD。','error')];
  const [y,m,d]=date.split('-').map(Number),leap=y%4===0&&(y%100!==0||y%400===0),days=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31];
  if(y<1||m<1||m>12||d<1||d>days[m-1])return [issue('voucher_date_invalid','/voucher_date','日期不存在；请查原件，不得自动调整日期。','error')];
  if(date.slice(0,7)!==period)return [issue('voucher_date_period_mismatch','/voucher_date','凭证日期与入账期间不一致；请核对归属及原件。','error')];
  return [];
}
function amountKey(value){const p=parseMoney(value??0,{allowNegative:true});return p.ok?formatCents(p.cents):postingSnapshot(value);}
function candidate(v) {return {period:v.period,voucher_date:v.voucher_date??'',word:v.word??'记',summary:v.summary??'',kind:v.kind??'normal',entries:(v.entries??[]).map(e=>({code:String(e.code),summary:e.summary||v.summary||'',debit:amountKey(e.debit),credit:amountKey(e.credit)}))};}
function restoredInput(value){if(value&&typeof value==='object'){if(value.$type==='undefined'&&Object.keys(value).length===1)return undefined;if(Array.isArray(value))return value.map(restoredInput);return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,restoredInput(v)]));}return value;}
function priorEvidence(db,attempt,voucherId,contentDigest) {
  const candidates=[];
  for(const name of readdirSync(attempt.root).filter(n=>/^[a-f0-9-]{36}$/.test(n))) {
    const dir=join(attempt.root,name);let end;
    try{end=load(join(dir,'result.json'));}catch{continue;}
    if(end.databaseInstanceId===attempt.databaseInstanceId&&end.accountSetId===attempt.accountSetId&&end.enterpriseKey===attempt.enterpriseKey&&end.voucherId===voucherId&&end.contentDigest===contentDigest){const op=end.operationId?db.prepare('SELECT state FROM audit_operations WHERE database_instance_id=? AND operation_id=? AND attempt=?').get(attempt.databaseInstanceId,end.operationId,end.operationAttempt??1):null;if(['succeeded','no_change'].includes(op?.state)){const begin=load(join(dir,'begin.json'));if(Array.isArray(begin.input?.entries))candidates.push({...end,rawInput:restoredInput(begin.input)});}}
  }
  return candidates.sort((a,b)=>b.finishedAt.localeCompare(a.finishedAt))[0];
}
function priorDerived(db,attempt,voucherId,contentDigest) {
  for(const name of readdirSync(attempt.root).filter(n=>/^[a-f0-9-]{36}$/.test(n))){let end;try{end=load(join(attempt.root,name,'result.json'));}catch{continue;}
    if(end.databaseInstanceId!==attempt.databaseInstanceId||end.accountSetId!==attempt.accountSetId||end.enterpriseKey!==attempt.enterpriseKey||end.voucherId!==voucherId||end.contentDigest!==contentDigest||!end.derived||!end.operationId)continue;
    const op=db.prepare('SELECT state FROM audit_operations WHERE database_instance_id=? AND operation_id=? AND attempt=?').get(attempt.databaseInstanceId,end.operationId,end.operationAttempt??1);
    if(['succeeded','no_change'].includes(op?.state))return end.derived;
  }
  return null;
}
function reviewRecords(s) {
  const dir=join(s.root,'reviews');try{checkPath(dir);if(!lstatSync(dir).isDirectory())throw Error('posting_record_invalid');}catch(e){if(e.code==='ENOENT')return [];throw e;}
  return readdirSync(dir).filter(n=>/^[a-f0-9-]{36}\.json$/.test(n)).map(n=>load(join(dir,n)));
}
function operationIntent(db,attempt) {
  const op=attempt.operation;if(!op?.operationId)return null;
  const row=db.prepare('SELECT action,request_digest,scope_kind,scope_token FROM audit_operations WHERE database_instance_id=? AND operation_id=? AND attempt=?').get(attempt.databaseInstanceId,op.operationId,op.attempt??1);
  if(!row)return null;
  const value={databaseInstanceId:attempt.databaseInstanceId,enterpriseKey:attempt.enterpriseKey,accountSetId:attempt.accountSetId,action:row.action,requestDigest:row.request_digest,scopeKind:row.scope_kind,scopeToken:row.scope_token};
  return {...value,digest:hash(value)};
}
function groupState(db,s,r){return db.prepare('SELECT state FROM audit_operations WHERE database_instance_id=? AND operation_id=? AND attempt=1').get(s.databaseInstanceId,r.approvedOperationId)?.state??'not_started';}
function accepted(db,attempt,binding) {
  const operationId=currentRequestMetadata()?.operationId;
  if(!operationId||!attempt.executionIntent||(attempt.operation?.attempt??1)!==1)return null;
  const related=reviewRecords(attempt).filter(r=>r.executionIntent?.digest===attempt.executionIntent.digest&&r.databaseInstanceId===attempt.databaseInstanceId&&r.accountSetId===attempt.accountSetId);
  // 同意图的其他执行已经开始/成功/未知时，不允许用另一审批组重复执行。
  if(related.some(r=>r.approvedOperationId!==operationId&&!['not_started','failed','rejected'].includes(groupState(db,attempt,r))))return null;
  const r=related.find(r=>r.decision==='accept'&&r.approvedOperationId===operationId&&r.members?.some(m=>m.binding===binding));
  return r?{reviewId:r.reviewId,reviewedAt:r.reviewedAt,approvedOperationId:r.approvedOperationId}:null;
}
export function inspectPosting(db,setId,v,{formal=false,voucherId,derived=null}={}) {
  const attempt=active.getStore();if(!attempt)throw Error('posting_attempt_required');
  attempt.operation=currentDomainOperationMetadata(db);
  attempt.executionIntent=operationIntent(db,attempt);
  const content=candidate(v),contentDigest=hash(content);attempt.contentDigest=contentDigest;attempt.voucherId=voucherId??null;
  let issues=voucherDateIssues(v.voucher_date,v.period),captured=null;
  const prior=voucherId?priorEvidence(db,attempt,voucherId,contentDigest):null;
  const evidenceInput=v.businessEvidence??prior?.evidenceInput;
  const rawCandidate=v.businessEvidence==null?(prior?.rawInput??v):v;
  const captureInput=rawCandidate.amountInputEntries?{...rawCandidate,entries:rawCandidate.amountInputEntries}:rawCandidate;
  const normalizationInput=rawCandidate.amountInputEntries&&Array.isArray(captureInput.entries)?{...captureInput,entries:captureInput.entries.map(e=>({...e,debit:parseImportAmount(e.debit),credit:parseImportAmount(e.credit)})).map(e=>({...e,debit:e.debit.ok?e.debit.value:{$type:'invalid_import_amount'},credit:e.credit.ok?e.credit.value:{$type:'invalid_import_amount'}}))}:captureInput;
  if(!Array.isArray(normalizationInput.entries)||hash(candidate(normalizationInput))!==contentDigest)issues.push(issue('normalization_input_mismatch','/entries','舍入前参数与实际凭证不等价，不能沿用来源。','error'));
  attempt.evidenceInput=evidenceInput??null;
  if(!derived&&voucherId)derived=priorDerived(db,attempt,voucherId,contentDigest);
  attempt.derived=derived;
  if(derived){captured={origin:'internal_engine',rule:derived,period:v.period,date:v.voucher_date,contentDigest};}
  else if(evidenceInput){
    try{captured=captureBusinessEvidence({...captureInput,accountSetId:setId,target:{accountSetId:setId,period:v.period}},evidenceInput,{calculationContext:{dbPath:databaseFiles.get(db)}});
      for(const m of captured.mappings)if(m.valueMatched===false)issues.push(issue('source_value_mismatch',m.inputPointer,'原件值或明确转换结果与实际参数不一致。','error'));
      const required=['/voucher_date',...(v.entries??[]).flatMap((e,i)=>['debit','credit'].filter(k=>Number(e[k]??0)!==0).map(k=>`/entries/${i}/${k}`))];
      for(const field of required){const matches=captured.mappings.filter(m=>m.inputPointer===field);if(matches.length!==1)issues.push(issue('source_binding_missing',field,'缺少唯一的原件字段映射；需补证或人工核对。'));else if(matches[0].valueMatched===null)issues.push(issue('source_selection_unverified',field,'该参数由业务判断选取，转换未证明其事实；需补证或人工核对。'));}
    }catch(error){issues.push(issue(error.code==='finance_details_audit_root_required'?'source_configuration_missing':['finance_details_artifact_changed','finance_details_record_changed','finance_details_source_changed'].includes(error.code)?'source_version_changed':error.code==='finance_details_reference_expired'?'calculation_source_unavailable':HARD_SOURCE_ERRORS.has(error.code)?'source_definition_invalid':'source_unavailable','/businessEvidence',error.code==='finance_details_audit_root_required'?'后台缺少受信审计目录配置，无法核验计算来源。':['finance_details_artifact_changed','finance_details_record_changed','finance_details_source_changed'].includes(error.code)?'计算结果或其原始资料版本已变化，需重新核验。':error.code==='finance_details_reference_expired'?'无法定位可信签发的计算引用，需核对引用和后台配置。':'原件字段无法核对；请补充可读取的原件及映射。',HARD_SOURCE_ERRORS.has(error.code)?'error':'review'));captured={captureError:error.code??'source_unavailable'};}
  }else issues.push(issue('source_evidence_missing','/businessEvidence','没有日期与金额的原件映射；保留草稿待补证或人工核对。'));
  attempt.captured=captured;attempt.issues=issues;
  // capturedAt 是采集时间，不属于审批所绑定的事实版本。
  const evidenceVersion=captured?{...captured,capturedAt:undefined}:null;
  attempt.binding=hash({databaseInstanceId:attempt.databaseInstanceId,accountSetId:setId,enterpriseKey:attempt.enterpriseKey,executionIntent:attempt.executionIntent?.digest??null,contentDigest,voucherId:voucherId??null,number:v.number??null,evidenceInput:postingSnapshot(evidenceInput),evidence:evidenceVersion,issues});
  attempt.validationFile=`validation-${attempt.validationCount++}.json`;
  attempt.validationDigest=save(join(attempt.dir,attempt.validationFile),{content,contentDigest,amountNormalization:{unit:'分',rounding:'ROUND_HALF_UP',syntax:rawCandidate.amountInputEntries?'import-amount/1：按既有币符、千分位和正负号语法解析，再按分舍入':'money/1：严格十进制',originalEntries:postingSnapshot(captureInput.entries),adoptedEntries:content.entries,captureInput:prior?'原始创建参数，已验证按分归一化后与当前凭证一致':'本次提交参数',meaning:'输入金额保留在begin及来源采集中；此处为实际落库的有符号分金额。'},evidence:captured,issues,executionIntent:attempt.executionIntent,binding:attempt.binding,claimsMeaning:'规则与采用理由是调用方声明；值匹配不证明业务含义相同。'});
  if(issues.some(i=>i.severity==='error'))throw recordFailure(Error('posting_correction_required'),'correction_required',issues,attempt);
  // 日期未给出不能由人工接受变成真实日期。
  const approval=formal&&!issues.some(i=>i.code==='voucher_date_missing')?accepted(db,attempt,attempt.binding):null;
  attempt.approval=approval;
  if(formal&&issues.length&&!approval)throw recordFailure(Error('posting_needs_review'),'needs_review',issues,attempt);
  return {status:issues.length&&!approval?'needs_review':'checked',attemptId:attempt.id,issues,...(approval?{approval}:{})};
}
export function withPostingAttempt(db,setId,action,input,fn) {
  if(active.getStore())return fn();
  let attempt;
  try{const s=scope(db,setId);secureDirectory(s.root);const id=randomUUID(),dir=join(s.root,id);secureDirectory(dir);attempt={...s,id,dir,validationCount:0};attempt.beginDigest=save(join(dir,'begin.json'),{version:'posting-attempt/1',attemptId:id,...s,action,startedAt:new Date().toISOString(),operation:currentDomainOperationMetadata(db),input:postingSnapshot(input),claimsMeaning:'输入及理由是提交声明，不是已核实事实。'});}
  catch(cause){throw Object.assign(Error('posting_record_unavailable'),{code:'posting_record_unavailable',cause});}
  let result,error;
  try{result=active.run(attempt,()=>{
    const source=input&&typeof input==='object'&&!types.isProxy(input)?input:null;
    const options=source?Object.getOwnPropertyDescriptor(source,'options')?.value:null;
    const correction=source?Object.getOwnPropertyDescriptor(source,'correctionOf')?.value??(options&&typeof options==='object'&&!types.isProxy(options)?Object.getOwnPropertyDescriptor(options,'correctionOf')?.value:undefined):undefined;
    if(correction!==undefined){
      let previous;try{if(typeof correction!=='string'||!/^[a-f0-9-]{36}$/.test(correction))throw Error('bad_ref');previous=load(join(attempt.root,correction,'begin.json'));if(previous.databaseInstanceId!==attempt.databaseInstanceId||previous.accountSetId!==setId||previous.enterpriseKey!==attempt.enterpriseKey)throw Error('bad_scope');}
      catch{throw recordFailure(Error('posting_correction_required'),'correction_required',[issue('correction_scope_invalid','/correctionOf','前次尝试不存在或不属于当前账库、企业和账套。','error')],attempt);}
      attempt.correction={attemptId:correction,operationId:previous.operation?.operationId??null,verification:'scope_matched'};
    }
    return fn();
  });}catch(e){error=e;
    if(!failures.has(e)&&e.message==='voucher_invalid')recordFailure(e,'correction_required',(e.details?.errors??['voucher_invalid']).map(message=>{const line=/^第(\d+)行(借方|贷方)?/.exec(message);const field=line?'/entries/'+(Number(line[1])-1)+(line[2]?(line[2]==='借方'?'/debit':'/credit'):''):'/entries';return issue('voucher_invalid',field,message.split(/[：:]/)[0],'error');}),attempt);
  }
  const audit=error?operationErrorEvidence(error):null;
  const state=error?(failures.get(error)?.status??(audit?.applied==='unknown'?'unknown':'rejected')):result?.status==='posted'?(db.isTransaction?'staged':'posted'):'draft';
  try{save(join(attempt.dir,'result.json'),{version:'posting-attempt/1',attemptId:attempt.id,databaseInstanceId:attempt.databaseInstanceId,accountSetId:setId,enterpriseKey:attempt.enterpriseKey,finishedAt:new Date().toISOString(),state,executionIntent:attempt.executionIntent??null,beginDigest:attempt.beginDigest,validation:attempt.validationFile?{file:attempt.validationFile,sha256:attempt.validationDigest}:null,operationId:attempt.operation?.operationId??currentDomainOperationMetadata(db)?.operationId??null,operationAttempt:attempt.operation?.attempt??currentDomainOperationMetadata(db)?.attempt??1,parentOperationId:attempt.operation?.parentOperationId??null,parentAttempt:attempt.operation?.parentAttempt??null,derived:attempt.derived??null,output:error?null:result,voucherId:result?.id??attempt.voucherId??null,contentDigest:attempt.contentDigest??null,evidenceInput:attempt.evidenceInput??null,binding:attempt.binding??null,issues:attempt.issues??[],approval:attempt.approval??null,error:error?{code:error.code??error.message,details:postingSnapshot(error.details),audit}:null,correctionOf:attempt.correction??null});}
  catch{const failure=Object.assign(Error('posting_record_finish_failed'),{code:'posting_record_finish_failed',nextAction:'query_original_operation',applied:'unknown',retryable:false});markOperationOutcomeUnknown(failure,attempt.operation??currentDomainOperationMetadata(db));throw failure;}
  if(error)throw error;
  return result;
}
// 本机 CLI 可读取/签署；不注册为 MCP、HTTP 或 Agent 工具。
export function readPostingReview(db,setId,attemptId) {
  if(!/^[a-f0-9-]{36}$/.test(attemptId))throw Error('posting_attempt_invalid');
  const s=scope(db,setId),dir=join(s.root,attemptId),begin=load(join(dir,'begin.json')),end=load(join(dir,'result.json'));
  if(begin.databaseInstanceId!==s.databaseInstanceId||begin.accountSetId!==setId||(s.enterpriseKey!==null&&begin.enterpriseKey!==s.enterpriseKey)||end.state!=='needs_review'||!end.binding)throw Error('posting_review_scope_invalid');
  const files=readdirSync(dir).filter(n=>/^validation-\d+\.json$/.test(n));return {begin,end,validation:load(join(dir,files.at(-1)))};
}
function reviewNotOverridable(issues){return issues.some(i=>i.severity==='error'||['voucher_date_missing','source_configuration_missing','source_version_changed','calculation_source_unavailable'].includes(i.code));}
export function postingReviewPlan(db,setId,attemptId) {
  const current=readPostingReview(db,setId,attemptId),s=scope(db,setId),intent=current.end.executionIntent;
  if(!intent?.digest||reviewNotOverridable(current.validation.issues))throw Error('posting_review_not_overridable');
  const prior=reviewRecords(s).filter(r=>r.executionIntent?.digest===intent.digest&&r.decision==='accept');
  const existing=[...prior].sort((a,b)=>b.reviewedAt.localeCompare(a.reviewedAt)).find(r=>r.members?.some(m=>m.binding===current.end.binding));
  if(existing&&!['failed','rejected'].includes(groupState(db,s,existing)))return {current,executionIntent:intent,members:existing.members,existing,planDigest:hash({intent:intent.digest,existing:existing.reviewId})};
  // 只沿用已明确失败且事务无效果的旧审批；未执行、未知或成功都不能转签。
  for(const r of prior)if(!['failed','rejected'].includes(groupState(db,s,r)))throw Error('posting_review_prior_execution_unresolved');
  const members=new Map();
  for(const r of prior)for(const member of r.members??[])if(!members.has(member.binding)){
    const old=readPostingReview(db,setId,member.attemptId);
    if(old.end.executionIntent?.digest!==intent.digest||old.end.binding!==member.binding)throw Error('posting_review_group_invalid');
    members.set(member.binding,{...member,content:old.validation.content,issues:old.validation.issues,priorReviewId:r.reviewId,priorOperator:r.operatorClaim,priorReason:r.reasonClaim,priorReviewedAt:r.reviewedAt});
  }
  members.set(current.end.binding,{...members.get(current.end.binding),attemptId,binding:current.end.binding,content:current.validation.content,issues:current.validation.issues,priorReviewId:members.get(current.end.binding)?.priorReviewId??null});
  const list=[...members.values()];return {current,executionIntent:intent,members:list,existing:null,planDigest:hash({intent:intent.digest,members:list})};
}
export function savePostingReview(db,setId,attemptId,{operator,reason},confirmation,{expectedPlanDigest}={}) {
  if(confirmation!==`确认 ${attemptId}`||!operator?.trim()||!reason?.trim())throw Error('posting_review_confirmation_required');
  const plan=postingReviewPlan(db,setId,attemptId);
  if(expectedPlanDigest!==undefined&&expectedPlanDigest!==plan.planDigest)throw Error('posting_review_plan_changed');
  if(plan.existing)return plan.existing;
  const s=scope(db,setId),dir=join(s.root,'reviews');secureDirectory(dir);const reviewId=randomUUID();
  const result={version:'posting-review/2',reviewId,databaseInstanceId:s.databaseInstanceId,accountSetId:setId,attemptId,binding:plan.current.end.binding,executionIntent:plan.executionIntent,members:plan.members,decision:'accept',approvedOperationId:'posting-reviewed-'+randomUUID(),operatorClaim:operator.trim(),reasonClaim:reason.trim(),reviewedAt:new Date().toISOString(),identityMeaning:'本机操作者声明，不是远程身份认证。'};save(join(dir,`${reviewId}.json`),result);return result;
}

// 重启后恢复原操作返回；协调器仍须核对该返回与不可变审计 resultDigest 完全一致。
export function restorePostingResult(db,setId,voucherId,fallback) {
  const operationId=currentRequestMetadata()?.operationId;if(!operationId)return fallback();
  const s=scope(db,setId);checkPath(s.root);
  for(const name of readdirSync(s.root).filter(n=>/^[a-f0-9-]{36}$/.test(n))){let end;try{end=load(join(s.root,name,'result.json'));}catch{continue;}
    if(end.databaseInstanceId===s.databaseInstanceId&&end.accountSetId===setId&&end.enterpriseKey===s.enterpriseKey&&end.operationId===operationId&&end.voucherId===voucherId&&end.output)return end.output;
  }
  return fallback();
}
