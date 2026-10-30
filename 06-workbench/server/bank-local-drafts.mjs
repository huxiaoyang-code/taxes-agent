import { withRequestMetadata,currentRequestMetadata } from './local-audit-coordinator.mjs';
import { isTechId } from './local-audit.mjs';
// 进程内输入保险库；不访问数据库、文件系统或网络。
import { randomBytes, createHash, randomUUID } from "node:crypto";
import { types } from "node:util";

export const BANK_ACTION_TO_TOOL = Object.freeze(Object.assign(Object.create(null), {
  accounts:"bank_accounts", "account-register":"bank_account_register", "import-preview":"bank_import_preview", import:"bank_import",
  batches:"bank_batches", transactions:"bank_transactions", ambiguities:"bank_ambiguities", "ambiguity-resolve":"bank_ambiguity_resolve",
  candidates:"bank_candidates", confirm:"bank_confirm", cancel:"bank_cancel", matches:"bank_matches", reconcile:"bank_reconcile", status:"bank_status", audit:"bank_audit",
}));
export const BANK_WRITE_TOOLS = Object.freeze(["bank_account_register","bank_import","bank_ambiguity_resolve","bank_confirm","bank_cancel","bank_reconcile"]);
export const BANK_TOOLS = Object.freeze(Object.values(BANK_ACTION_TO_TOOL));
export const BANK_DRAFT_PATTERN = /^bankdraft_[a-f0-9]{48}$/;
const FIELDS = Object.freeze({
  bank_accounts:[], bank_account_register:["bankAccountId","sourceId","glAccountCode","currency","displayName","bankAccountNo"],
  bank_import_preview:["bankAccountId","sourceId","batchId","period","csvText","mapping"], bank_import:["bankAccountId","sourceId","batchId","period","csvText","mapping"],
  bank_batches:["bankAccountId","limit"], bank_transactions:["bankAccountId","from","to","status","limit"], bank_ambiguities:["bankAccountId","status","limit"],
  bank_ambiguity_resolve:["bankAccountId","ambiguityId","decision","transactionId","reason"], bank_candidates:["bankAccountId","transactionId","dateToleranceDays","from","to","period"],
  bank_confirm:["bankAccountId","transactionId","voucherId","entryId","reason","dateToleranceDays"], bank_cancel:["bankAccountId","matchId","reason"],
  bank_matches:["bankAccountId","status","limit"], bank_reconcile:["bankAccountId","period","asOf","coverageFrom","coverageTo","statementSource","statementOpenCents","statementCloseCents","currency","note"],
  bank_status:["bankAccountId","batchLimit"], bank_audit:["bankAccountId","limit"],
});
export class BankDraftError extends Error { constructor(code) { super(code); this.code=code; } }
const fail=code=>{ throw new BankDraftError(code); };
function data(value, depth=0, budget={nodes:0}) {
  if (++budget.nodes>50000 || depth>16) fail("bank_draft_input_invalid");
  if (value===null || typeof value==="string" || typeof value==="boolean") return value;
  if (typeof value==="number" && Number.isFinite(value)) return value;
  if (!value || typeof value!=="object" || types.isProxy(value)) fail("bank_draft_input_invalid");
  const array=Array.isArray(value), proto=Object.getPrototypeOf(value);
  if (array ? proto!==Array.prototype : proto!==Object.prototype && proto!==null) fail("bank_draft_input_invalid");
  if (Object.getOwnPropertySymbols(value).length) fail("bank_draft_input_invalid");
  const keys=Object.getOwnPropertyNames(value).filter(k=>!(array&&k==="length"));
  if (array && (keys.length!==value.length || value.length>10000)) fail("bank_draft_input_invalid");
  const out=array?[]:Object.create(null);
  for (const key of keys) {
    const d=Object.getOwnPropertyDescriptor(value,key);
    if (!d || !("value" in d) || ["__proto__","prototype","constructor"].includes(key) || array&&!/^(0|[1-9][0-9]*)$/.test(key)) fail("bank_draft_input_invalid");
    out[key]=data(d.value,depth+1,budget);
  }
  return Object.freeze(out);
}
const hash=v=>createHash("sha256").update(JSON.stringify(v)).digest("hex");
const scope=id=>{if (!Number.isSafeInteger(id)||id<=0) fail("bank_draft_scope_invalid"); return id;};
export function bankCallArgs(raw) {
  const a=data(raw);
  if (!a||Array.isArray(a)||Object.keys(a).some(k=>!["accountSetId","draftRef"].includes(k))) fail("bank_draft_input_invalid");
  scope(a.accountSetId);
  if (typeof a.draftRef!=="string"||!BANK_DRAFT_PATTERN.test(a.draftRef)) fail("bank_draft_ref_invalid");
  return a;
}
export class BankLocalDrafts {
  #records=new Map(); #bytes=0; #clock;
  constructor({clock=Date.now}={}) {this.#clock=clock;}
  #sweep() {for(const [ref,r] of this.#records) if(r.expiresAt<=this.#clock()&&r.state!=="executing") {this.#records.delete(ref);this.#bytes-=r.bytes;}}
  #get(id,ref,tool) {
    scope(id);this.#sweep();
    if(typeof ref!=="string"||!BANK_DRAFT_PATTERN.test(ref)) fail("bank_draft_ref_invalid");
    const r=this.#records.get(ref);
    if(!r) fail("bank_draft_unavailable");
    if(r.accountSetId!==id||tool&&r.tool!==tool) fail("bank_draft_scope_mismatch");
    if(r.expiresAt<=this.#clock()) fail("bank_draft_unavailable");
    if(hash(r.payload)!==r.hash) fail("bank_draft_input_invalid");
    if(r.revoked) fail("bank_draft_revoked");
    return r;
  }
  prepare(accountSetId, raw, internal=false) {
    scope(accountSetId);const b=data(raw);
    if(!b||Array.isArray(b)||Object.keys(b).some(k=>!["tool","payload","confirm","accountSetId","operationId"].includes(k))) fail("bank_draft_input_invalid");
    if(b.accountSetId!==undefined&&b.accountSetId!==accountSetId) fail("bank_draft_scope_mismatch");
    if(!BANK_TOOLS.includes(b.tool)||b.tool==="bank_import"&&!internal) fail("bank_draft_tool_invalid");
    const operationId=b.operationId??randomUUID();if(!isTechId(operationId))fail('audit_operation_invalid');
    const payload=b.payload;
    if(!payload||Array.isArray(payload)||typeof payload!=="object"||Object.keys(payload).some(k=>!FIELDS[b.tool].includes(k))) fail("bank_draft_input_invalid");
    if(BANK_WRITE_TOOLS.includes(b.tool)&&b.confirm!==true) fail("bank_draft_confirmation_required");
    const required={bank_accounts:[],bank_account_register:["bankAccountId","sourceId","glAccountCode"],bank_import_preview:["bankAccountId","sourceId","batchId","period","csvText","mapping"],bank_import:["bankAccountId","sourceId","batchId","period","csvText","mapping"],bank_ambiguity_resolve:["bankAccountId","ambiguityId","decision","reason"],bank_candidates:["bankAccountId","transactionId"],bank_confirm:["bankAccountId","transactionId","voucherId","entryId","reason"],bank_cancel:["bankAccountId","matchId","reason"],bank_reconcile:["bankAccountId","period","asOf","coverageFrom","coverageTo","statementSource","statementOpenCents","statementCloseCents"]}[b.tool]??["bankAccountId"];
    if(required.some(k=>payload[k]===undefined||payload[k]===null||typeof payload[k]==="string"&&payload[k].trim()==="")) fail("bank_draft_input_invalid");
    for(const k of ["bankAccountId","sourceId","batchId","period","csvText","reason","statementSource"])if(payload[k]!==undefined&&typeof payload[k]!=="string")fail("bank_draft_input_invalid");
    for(const k of ["transactionId","ambiguityId","voucherId","entryId","matchId"])if(payload[k]!==undefined&&(!Number.isSafeInteger(payload[k])||payload[k]<=0))fail("bank_draft_input_invalid");
    if(payload.mapping) {
      if(Array.isArray(payload.mapping)||typeof payload.mapping!=="object"||Object.keys(payload.mapping).some(k=>!["columns","dateFormat","amountMode","directionLabels","currency","negativeAmount","thousandsSeparator","allowCurrencySymbol","ignoreBlankRows","summaryMaxChars","refIdMaxChars"].includes(k))) fail("bank_draft_input_invalid");
      for(const [key,allowed] of [["columns",["date","amount","debit","credit","direction","summary","refId","balance","currency"]],["directionLabels",["inflow","outflow"]]]) {
        const v=payload.mapping[key];if(v&&(typeof v!=="object"||Array.isArray(v)||Object.keys(v).some(k=>!allowed.includes(k)))) fail("bank_draft_input_invalid");
      }
    }
    const bytes=Buffer.byteLength(JSON.stringify(payload));
    if(bytes>2*1024*1024) fail("bank_draft_payload_too_large");
    this.#sweep();if(this.#records.size>=32||this.#bytes+bytes>16*1024*1024) fail("bank_draft_capacity");
    const draftRef="bankdraft_"+randomBytes(24).toString("hex"), expiresAt=this.#clock()+600000;
    this.#records.set(draftRef,{accountSetId,operationId,tool:b.tool,payload,hash:hash(payload),bytes,expiresAt,state:"prepared",previewOK:false,revoked:false});this.#bytes+=bytes;
    return {accountSetId,draftRef,operationId,tool:b.tool,expiresAt:new Date(expiresAt).toISOString()};
  }
  approveImport(accountSetId,raw) {
    const b=data(raw);if(!b||Array.isArray(b)||Object.keys(b).length!==1||typeof b.previewRef!=="string") fail("bank_draft_input_invalid");
    const r=this.#get(accountSetId,b.previewRef,"bank_import_preview");
    if(!r.previewOK) fail("bank_draft_preview_required");
    return this.prepare(accountSetId,{tool:"bank_import",payload:r.payload,confirm:true},true);
  }
  revoke(accountSetId,raw) {
    const b=data(raw);if(!b||Array.isArray(b)||Object.keys(b).length!==1||typeof b.draftRef!=="string") fail("bank_draft_input_invalid");
    const r=this.#get(accountSetId,b.draftRef);r.revoked=true;if(r.state!=="executing"){this.#records.delete(b.draftRef);this.#bytes-=r.bytes;}return {accountSetId,revoked:true};
  }
  operationIdFor(accountSetId,draftRef,tool) {return this.#get(accountSetId,draftRef,tool).operationId;}
  async execute(tool,raw,execute) {
    const a=bankCallArgs(raw),r=this.#get(a.accountSetId,a.draftRef,tool),write=BANK_WRITE_TOOLS.includes(tool);
    const requested=currentRequestMetadata();if(requested?.explicit===true&&requested.operationId!==r.operationId)fail('audit_operation_conflict');
    if(r.state==="unknown") fail("bank_draft_outcome_unknown");
    if(r.state==="executing") fail("bank_draft_busy");
    if(write&&r.state==="completed"&&!r.value) fail("bank_draft_result_unavailable");
    if(write&&r.state==="completed") return {...structuredClone(r.value),evidence:{durability:"committed",performed:false,replayed:true}};
    if(write) r.state="executing";
    try {
      const current=currentRequestMetadata();
      const value=await withRequestMetadata({operationId:r.operationId,actor:current?.actor??'agent',explicit:true},()=>execute({...r.payload,accountSetId:r.accountSetId}));
      if(tool==="bank_import_preview") r.previewOK=value?.result?.preview?.ok===true;
      if(write) {
        // 缓存不能使保险库超过总内存预算；无法缓存时，
        // 第一次成功结果仍须携带提交证据。
        r.value=null;r.state="completed";
        try {const bytes=Buffer.byteLength(JSON.stringify(value));if(this.#bytes+bytes<=16*1024*1024){r.value=structuredClone(value);r.bytes+=bytes;this.#bytes+=bytes;}}catch{/* 绝不重复执行已成功的写入 */}
        if(r.revoked){this.#records.delete(a.draftRef);this.#bytes-=r.bytes;}
      }
      return value;
    } catch(e) {if(write) r.state="unknown";if(tool==="bank_import_preview")r.previewOK=false;throw e;}
  }
}
export const bankLocalDrafts=new BankLocalDrafts();
