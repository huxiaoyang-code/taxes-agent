#!/usr/bin/env node
/**
 * finance-mcp — 财税工作台 MCP Server（stdio）
 *
 * 工具契约见 tools.mjs；默认 direct 工具面直接调用业务，自动记录每次调用：
 *   - skills_list / skills_read：本进程读取本机 Skill 资源；
 *   - finance_* 新业务工具：直接复用固定核算模块，输出模型受限摘要和本机人读底稿；
 *   - harness_*：仅显式 harness/legacy 兼容工具面保留旧执行和历史恢复；
 *   - 其他工具：经 backend.mjs 转发 HTTP，普通财务工具走模型摘要通道，税务/目录走既有通道。
 * 原则：工具描述与调用结果必须真实——未实现的工具返回 isError，绝不伪装成功。
 *
 * 运行：node server.mjs   （由 Codex config.toml 以 stdio 方式拉起）
 * 后端：FINANCE_API_BASE，默认 http://127.0.0.1:8787
 */
import { createInterface } from "node:readline";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve, sep } from "node:path";
import { callBackend, backendInfo, BackendError, ModelTransportError } from "./backend.mjs";
import { isModelEnvelope, validateModelEnvelope } from "./finance-model-transport.mjs";
import { TOOL_BY_NAME, validateArgs, ToolCallError } from "./tools.mjs";
import { HARNESS_TOOL_NAMES } from './tools.mjs';
import {validateFact} from '../../../../06-workbench/server/harness-contract.mjs';
import {factEvidenceError} from '../../../../06-workbench/server/harness-fact-evidence.mjs';
import {validateSchemaValue} from '../../../../06-workbench/server/harness-schema-validation.mjs';
import {discoverySummary} from './disclosure-contracts.mjs';
import {readHarnessReceipt,summarizeHarnessReceipt} from './receipt-presentation.mjs';
import {guardHarnessBoundary} from './manifest-evidence-guard.mjs';
import {toolsForProfile} from './tool-profile.mjs';
import {DIRECT_TOOL_NAMES} from './direct-tools.mjs';
import {callDirectFinanceTool} from '../../../../06-workbench/server/direct-finance.mjs';
import {validateDirectInput} from '../../../../06-workbench/server/direct-finance-contracts.mjs';
import {withFinanceCall,currentFinanceCall} from '../../../../06-workbench/server/finance-call-chain.mjs';

const ACTIVE_PROFILE = process.env.FINANCE_MCP_PROFILE ?? 'direct';
const EXPOSED_TOOLS = toolsForProfile(ACTIVE_PROFILE);
const EXPOSED_TOOL_NAMES = new Set(EXPOSED_TOOLS.map(t => t.name));

const __dirname = dirname(fileURLToPath(import.meta.url));
const RECON = join(__dirname, "..", "..", ".."); // 05-reconstruction/
const CATALOG = JSON.parse(readFileSync(join(RECON, "catalog.json"), "utf8"));
const SKILLS_DIR = process.env.FINANCE_SKILLS_DIR || join(RECON, "codex", "skills");

const SERVER = { name: "finance-mcp", version: "0.2.0" };
const PROTOCOL = "2025-06-18";

// ------------------------------------------------------------------ 资源读取
function listSkillFilesUnsafe(dir = SKILLS_DIR, base = SKILLS_DIR) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...listSkillFilesUnsafe(p, base));
    else if (ent.name.endsWith(".md")) out.push(relative(base, p).replaceAll("\\", "/"));
  }
  return out;
}

function listSkillFiles() {
  try { return listSkillFilesUnsafe(); }
  catch { throw new ToolCallError("skill_not_found", "skill_not_found"); }
}

function readSkill(resource) {
  const normalized = String(resource || "").replaceAll("\\", "/").split(/[?#]/)[0];
  const root = resolve(SKILLS_DIR);
  const full = resolve(root, normalized);
  // Windows 下环境变量常用正斜杠，join 会输出反斜杠，直接用 startsWith 会误判；用 resolve + 分隔符比较。
  // 失败信息只回固定常量：不四显请求路径，也不带原始异常。
  if (full !== root && !full.startsWith(root + sep)) {
    throw new ToolCallError("skill_not_found", "skill_not_found");
  }
  if (!existsSync(full)) throw new ToolCallError("skill_not_found", "skill_not_found");
  try { return readFileSync(full, "utf8"); }
  catch { throw new ToolCallError("skill_not_found", "skill_not_found"); }
}

// ------------------------------------------------------------------ 工具实现
/** 读取 legacy_book_import 的本机 CSV 路径（与 Codex 同机时免 base64）。 */
function readPathTexts(args) {
  const texts = { ...(args.texts || {}) };
  const encoding = args.encoding || "utf-8";
  for (const key of ["meta", "accounts", "openings", "vouchers"]) {
    const p = args.paths[key];
    if (!p) continue;
    texts[key] = new TextDecoder(encoding).decode(readFileSync(String(p)));
  }
  return texts;
}

async function callTool(name, args = {}) {
  const spec = TOOL_BY_NAME.get(name);
  if (!spec) throw new ToolCallError("unknown_tool", "unknown_tool");
  if (!EXPOSED_TOOL_NAMES.has(name)) throw new ToolCallError('tool_not_available', 'tool_not_available');

  // schema 前置拒绝：只回字段名 / 枚举常量，不四显调用参数值。
  const problems = validateArgs(spec.inputSchema, args);
  if(HARNESS_TOOL_NAMES.has(name)&&args&&typeof args==='object'&&Object.keys(args).some(k=>!Object.hasOwn(spec.inputSchema.properties,k)))problems.push('harness_unknown_argument');
  if (problems.length) {
    throw new ToolCallError("invalid_arguments", "invalid_arguments", { tool: spec.name, problems: name==='finance_tax_summary_calculate'?['finance_summary_arguments_invalid']:problems });
  }
  if (spec.status === "unavailable") {
    throw new ToolCallError("not_implemented", "not_implemented", { tool: spec.name });
  }
  if (DIRECT_TOOL_NAMES.has(name)) {
    try { validateDirectInput(spec.inputSchema,args); return await callDirectFinanceTool(name,args); }
    catch(error) { throw new ToolCallError(/^(finance|agency)_[a-z0-9_]+$/.test(error?.code)?error.code:'finance_direct_call_failed','finance_direct_call_failed',name!=='finance_tax_summary_calculate'&&error?.code==='finance_input_invalid'?error.details:undefined); }
  }

  // ---- 纯本地资源工具（只读本机 skill 文件；不是业务原文通道）----
  if (name === "skills_list") return { files: listSkillFiles(), labels: CATALOG.skill_files };
  if (name === "skills_read") return { resource: args.resource, markdown: readSkill(args.resource) };
  if (HARNESS_TOOL_NAMES.has(name)) {
    try {
      const { callHarnessTool } = await import('../../../../06-workbench/server/harness-runtime.mjs');
      const {responseMode,capabilityId,factEvidencePolicy,domain,query,offset,limit,...nativeArgs}=args;
      const schemaProblems=validateSchemaValue(spec.inputSchema,args);
      if(schemaProblems.length){
        // 保留已有的字段级诊断，期间不读取业务输入。
        if(['harness_source_register','harness_request_materials'].includes(name))await guardHarnessBoundary(name,args);
        if(name==='harness_facts_register'&&Array.isArray(args.facts))for(const fact of args.facts)try{validateFact(fact);}catch(e){throw factEvidenceError(e,fact,{field:'fact'});}
        throw new ToolCallError('harness_tool_input_invalid','harness_tool_input_invalid',{tool:name,problems:schemaProblems,errorInventory:{total:schemaProblems.length,shown:schemaProblems.length,omitted:0}});
      }
      if(name==='harness_receipt_read')return await readHarnessReceipt(args);
      const evidenceIssues=await guardHarnessBoundary(name,args);
      const result=await callHarnessTool(name,nativeArgs);
      if(evidenceIssues.some(i=>i.layer!=='input_contract'))result.evidenceIssues=evidenceIssues.filter(i=>i.layer!=='input_contract');
      if(evidenceIssues.some(i=>i.layer==='input_contract'))result.contractIssues=evidenceIssues.filter(i=>i.layer==='input_contract');
      if(name==='harness_discover')return responseMode==='full'&&!capabilityId&&domain===undefined&&query===undefined&&offset===undefined&&limit===undefined?result:discoverySummary(result,capabilityId,responseMode==='full',{domain,query,offset,limit});
      if(!args.storePath||responseMode==='full')return result;
      try{return await summarizeHarnessReceipt(args.storePath,name,result);}
      catch(e){return {status:'unknown',code:'harness_receipt_persistence_failed',nativeStatus:result?.status??null,operationState:result?.operationState??result?.receipt?.executionState??null,resultCurrent:result?.resultCurrent??null,confirmationCurrent:result?.confirmationCurrent??null,operationId:result?.receipt?.operationId??null,taskId:args.taskId??null,outcome:'native_call_may_have_completed',retryBlockedBy:'query_original_operation',nextSteps:[{tool:args.taskId?'harness_run':'harness_status',...(args.taskId?{phase:'query',taskId:args.taskId}:{})}],details:{nativeJournalPreserved:true,presentationError:e.code??'receipt_storage_unavailable'}};}
    } catch(e) {throw new ToolCallError(/^harness_[a-z0-9_]+$/.test(e?.code)?e.code:'harness_operation_failed','harness_operation_failed',e.details);}
  }

  // ---- legacy_book_import：本机路径读盘 + 默认预检 ----
  const payload = { ...args };
  if (name === "legacy_book_import" || name === "book_import_incremental") {
    if (args.paths && typeof args.paths === "object") {
      try {
        payload.texts = readPathTexts(args);
      } catch {
        // 不回显路径、文件名或原始异常。
        throw new ToolCallError("path_read_failed", "path_read_failed");
      }
    }
    // 默认预检；只有显式 dryRun=false 才落库。
    payload.dryRun = args.dryRun === false ? false : true;
  }

  // 普通财务工具 → 固定模型通道（返回已校验信封）；税务 / 目录 → 既有原始通道。
  const result = await callBackend(name, payload, CATALOG);
  // 后端明确回报未实现时，同样升级为工具错误，避免“成功返回 not_implemented”。
  if (result && typeof result === "object" && result.not_implemented === true) {
    throw new ToolCallError("not_implemented", "not_implemented", { tool: spec.name });
  }
  return result;
}

// ------------------------------------------------------------------ 协议传输
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const ok = (id, result) => send({ jsonrpc: "2.0", id, result });
const err = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

/** 失败统一返回结构化内容 + isError: true。 */
function errorResult(e) {
  const payload = { error: e?.code || "tool_error", message: typeof e?.message === "string" && e.message ? e.message : "tool_error" };
  if (e?.tool) payload.tool = e.tool;
  if (e?.details !== undefined && e?.details !== null) payload.details = e.details;
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], structuredContent: payload, isError: true };
}
async function harnessErrorResult(e,name,args){
  if(!HARNESS_TOOL_NAMES.has(name)||!args?.storePath||!e?.details||args.responseMode==='full')return errorResult(e);
  const native={status:'failed',code:e.code??'harness_operation_failed',blockers:e.details.evidenceIssues??e.details.problems??e.details.blockers??[],details:e.details,...(e.details.contractIssues?{contractIssues:e.details.contractIssues}:{}),nextSteps:e.details.contract?[{action:'inspect_selected_contract_and_repair_indicated_fields',...e.details.contract,hint:e.details.hint}]:[{action:e.code==='harness_phase_unsupported'?'choose_supported_phase':'resolve_indicated_facts_or_evidence',tool:e.code==='harness_phase_unsupported'?'harness_discover':'harness_facts_register',...(e.details.capabilityId?{capabilityId:e.details.capabilityId}:{}),hint:e.details.hint??'Resolve the specific field/source problems above; preserve unknown original writes and use query before retry.'}]};
  try{const payload=await summarizeHarnessReceipt(args.storePath,name,native);return {content:[{type:'text',text:JSON.stringify(payload)}],structuredContent:payload,isError:true};}
  catch{return errorResult(new ToolCallError(e.code??'harness_operation_failed','harness_operation_failed',{fullErrorPersistenceFailed:true,errorCount:native.blockers.length,nextStep:'Inspect local native journal and resolve the original error; do not blindly repeat a write.'}));}
}

/** 模型通道运输失败：只回固定常量，不带响应片段 / 地址 / 原始异常。 */
function transportFailureResult(failure) {
  const payload = {
    error: failure.error.code,
    messageKey: failure.error.messageKey,
    retriable: failure.retriable,
    outcome: failure.outcome,
  };
  if (failure.writeOutcome) payload.writeOutcome = failure.writeOutcome;
  if (failure.retryBlockedBy) payload.retryBlockedBy = failure.retryBlockedBy;
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], structuredContent: payload, isError: true };
}

/** 模型信封结果：text 与 structuredContent 都只包含已校验的信封；ok=false → isError。 */
function envelopeResult(envelope) {
  const result = {
    content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }],
    structuredContent: envelope,
  };
  if (envelope.ok === false) result.isError = true;
  return result;
}

rl.on("line", async (line) => {
  const text = line.trim();
  if (!text) return;
  let msg;
  try { msg = JSON.parse(text); } catch { return; }
  if (!msg || typeof msg !== "object" || Array.isArray(msg) || typeof msg.method !== "string") {
    return err(msg && typeof msg === "object" && ["string", "number"].includes(typeof msg.id) ? msg.id : null,
      -32600, "invalid_request");
  }
  const { id, method, params } = msg;

  if (method === "initialize") {
    return ok(id, {
      protocolVersion: PROTOCOL,
      capabilities: { tools: {}, resources: {} },
      serverInfo: SERVER
    });
  }
  if (method === "notifications/initialized" || method?.startsWith("notifications/")) return;
  if (method === "ping") return ok(id, {});
  if (method === "tools/list") return ok(id, { tools: EXPOSED_TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema,...(t.annotations?{annotations:t.annotations}:{}) })) });
  if (method === "tools/call") {
    let callReference;
    const withReference=result=>callReference?{...result,_meta:{...(result?._meta??{}),financeCall:{callId:callReference.callId}}}:result;
    try {
      const result = await withFinanceCall({tool:params?.name??'unknown',args:params?.arguments??{}},async()=>{callReference=currentFinanceCall();return await callTool(params?.name,params?.arguments??{});});
      if (isModelEnvelope(result)) {
        // 防御性重校：只把不过的固定失败码交给模型，绝不透传未校验对象。
        const checked = validateModelEnvelope(result);
        if (!checked.ok) {
          const failure = checked.failure;
          // 信封校验失败本身无法证明写未发生：按写场景保守处理。
          const conservative = transportFailureResult({
            ...failure, retriable: false, writeOutcome: "unknown", retryBlockedBy: "write_outcome_unknown",
          });
          return ok(id, withReference(conservative));
        }
        return ok(id, withReference(envelopeResult(checked.envelope)));
      }
      return ok(id, withReference({ content: [{ type: "text", text: HARNESS_TOOL_NAMES.has(params?.name)?JSON.stringify(result):JSON.stringify(result, null, 2) }],...((HARNESS_TOOL_NAMES.has(params?.name)||DIRECT_TOOL_NAMES.has(params?.name))?{structuredContent:result,...(['failed','unknown'].includes(result?.status)?{isError:true}:{})}:{}) }));
    } catch (e) {
      if (e instanceof ModelTransportError) return ok(id, withReference(transportFailureResult(e.failure)));
      if(e?.code==='finance_call_recording_failed')return ok(id,withReference({isError:true,content:[{type:'text',text:JSON.stringify({code:e.code,writeOutcome:'unknown',retryable:false,executionCompleted:e.executionCompleted===true})}]}));
      if (e instanceof BackendError || e instanceof ToolCallError) return ok(id, withReference(await harnessErrorResult(e,params?.name,params?.arguments)));
      return ok(id, withReference(errorResult(new ToolCallError("tool_error", "tool_error"))));
    }
  }
  if (method === "resources/list") {
    try {
      return ok(id, { resources: listSkillFiles().map((uri) => ({
        uri: `skill://${uri}`, name: uri, mimeType: "text/markdown"
      })) });
    } catch { return err(id, -32002, "skill_not_found"); }
  }
  if (method === "resources/read") {
    const uri = String(params?.uri || "").replace(/^skill:\/\//, "");
    // 失败只回固定文案：不四显请求路径或原始异常。
    try { return ok(id, { contents: [{ uri: params?.uri, mimeType: "text/markdown", text: readSkill(uri) }] }); }
    catch { return err(id, -32002, "skill_not_found"); }
  }
  if (method === "prompts/list") return ok(id, { prompts: [] });
  if (id !== undefined) return err(id, -32601, "method_not_found");
});

if (process.env.FINANCE_MCP_DEBUG) {
  console.error("finance-mcp backend:", JSON.stringify(backendInfo()));
}
