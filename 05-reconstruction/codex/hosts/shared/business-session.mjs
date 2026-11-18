// 宿主绑定与短业务基线装配。目录准备不等于生成基线；读取不猜账套、不改业务库/索引/原件，另记录安全观察。
import {existsSync,lstatSync,realpathSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {isAbsolute,resolve,dirname,join} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {resolveDirectFinanceTarget} from '../../../../06-workbench/server/direct-finance-target.mjs';

export const SESSION_VERSION='finance-business-session/1';
export const HOST_VERSION='finance-business-host/1';
export const BUSINESS_MEMORY_ROUTING='先调 finance_baseline_read 核短基线，同条件沿用。生成或修订读 company-baseline/SKILL.md，本期取数读其 references/materials-and-save.md。按 .finance/business-session.json 或 .finance/host.json 核原件根及审计根。用已获准的宿主文件或脚本能力读原件，把结果写入审计根 agent-materials，再提交给财税工具。保存后回读，口径存账库。';
const REPO_ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'../../../..');
const fail=code=>{throw Object.assign(new Error(code),{code});};
const samePath=(a,b)=>typeof a==='string'&&typeof b==='string'&&resolve(a).toLowerCase()===resolve(b).toLowerCase();
export const sessionPath=workspace=>join(resolve(workspace),'.finance/business-session.json');
export function readHostJson(path){
 let st;try{st=lstatSync(path);}catch{fail('host_business_file_missing');}
 if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size>1024*1024)fail('host_business_file_invalid');
 try{return JSON.parse(readFileSync(path,'utf8'));}catch{fail('host_business_json_invalid');}
}
export function loadBusinessHost(workspace){
 const config=readHostJson(join(resolve(workspace),'.finance/host.json'));
 if(config.version!==HOST_VERSION||!['pi','claude-code','dsh','zcode'].includes(config.host)||!samePath(config.repoRoot,REPO_ROOT)||!samePath(realpathSync(config.workspace),realpathSync(workspace))||config.mcpEnv?.FINANCE_MCP_PROFILE!=='direct')fail('host_business_config_invalid');
 for(const path of [config.nodePath,config.databasePath,config.auditDir])if(typeof path!=='string'||!isAbsolute(path)||/[\0\r\n]/.test(path))fail('host_business_config_invalid');
 if(!samePath(config.mcpEnv.FINANCE_DATABASE_PATH,config.databasePath)||!samePath(config.mcpEnv.FINANCE_AUDIT_DIR,config.auditDir)||!samePath(config.mcpEnv.FINANCE_BUSINESS_SESSION,sessionPath(workspace)))fail('host_business_config_invalid');
 return config;
}
const actualOptions=config=>({dbPath:config.databasePath,auditDir:config.auditDir,sessionPath:sessionPath(config.workspace),...(config.mcpEnv.FINANCE_SOURCE_ROOT?{sourceRoot:config.mcpEnv.FINANCE_SOURCE_ROOT}:{})});
export function assertSameScope(expected,actual){
 if(!expected||!actual||['enterpriseKey','databaseInstanceId','accountSetId','period','currency'].some(key=>expected[key]!==actual[key]))fail('host_business_scope_mismatch');
}
export function loadBoundBusinessSession(workspace){
 const config=loadBusinessHost(workspace),path=sessionPath(workspace);
 if(!existsSync(path))fail('host_business_binding_required');
 const session=readHostJson(path);
 if(session.version!==SESSION_VERSION||session.host!==config.host||!samePath(session.workspace,realpathSync(workspace))||!samePath(session.databasePath,config.databasePath)||!samePath(session.auditDir,config.auditDir)||(session.sourceRoot??null)!==(config.mcpEnv.FINANCE_SOURCE_ROOT??null))fail('host_business_binding_mismatch');
 const target={accountSetId:session.scope?.accountSetId,period:session.scope?.period};
 const binding=resolveDirectFinanceTarget(target,config.databasePath);assertSameScope(session.scope,binding.scope);
 return {config,session,path,target,options:actualOptions(config)};
}
export async function readBoundBusinessContext(workspace){
 const bound=loadBoundBusinessSession(workspace),{readBusinessBaseline}=await import('../../../../06-workbench/server/business-baseline.mjs');
 const context=await readBusinessBaseline({target:bound.target},bound.options);
 return {...bound,context};
}
export async function prepareBoundBusinessSession(workspace,target){
 const config=loadBusinessHost(workspace),path=sessionPath(workspace);let bound;
 if(existsSync(path)){
  bound=loadBoundBusinessSession(workspace);
  if(target&&(target.accountSetId!==bound.target.accountSetId||target.period!==bound.target.period))fail('host_business_binding_immutable');
 }else{
  if(!target)fail('host_business_binding_required');
  const binding=resolveDirectFinanceTarget(target,config.databasePath);
  bound={config,path,target,options:actualOptions(config),session:{version:SESSION_VERSION,host:config.host,workspace:realpathSync(workspace),databasePath:binding.dbPath,scope:binding.scope,sourceRoot:config.mcpEnv.FINANCE_SOURCE_ROOT??null,auditDir:config.auditDir}};
 }
 const {prepareBusinessMemory}=await import('../../../../06-workbench/server/business-memory.mjs');
 const prepared=await prepareBusinessMemory({target:bound.target},bound.options);
 // 模型投影不披露企业原值；准备完成后重新核实际DB，而不是依赖摘要回传scope。
 assertSameScope(bound.session.scope,resolveDirectFinanceTarget(bound.target,config.databasePath).scope);
 if(!existsSync(path))writeFileSync(path,JSON.stringify(bound.session,null,2)+'\n',{encoding:'utf8',flag:'wx',mode:0o600});
 return {...await readBoundBusinessContext(workspace),prepared};
}
export function renderBusinessContext(context){
 const states={needs_generation:'待生成',ready:'可按适用条件沿用',needs_review:'待核相关原则',stale:'来源失效，待核相关原则',outside_effective_period:'超出有效期，待核适用范围'};
 if(context?.version!=='finance-business-baseline/1'||!Object.hasOwn(states,context.status)||typeof context.shortText!=='string'||Array.from(context.shortText).length>600||!Array.isArray(context.unresolved)||context.unresolved.length>3)fail('host_business_baseline_projection_invalid');
 const gaps={materials_missing:'资料待补',owner_unverified:'材料主体待核',historical_conflict:'历史口径冲突',policy_unverified:'政策适用待核',tax_history_missing:'历史税费资料待补',tax_basis_incomplete:'税负口径待核',source_changed:'来源已修改',source_missing:'来源缺失',source_unavailable:'来源当前不可访问',outside_effective_period:'有效期待核',scope_conflict:'适用范围冲突',unsupported_material:'材料格式或语义待核',historical_evidence_missing:'历史依据待补'};
 const kinds={accounting_standard:'准则',enterprise_class:'企业分类',business_classification:'业务归类',inventory_cost:'存货计价',revenue_period:'收入',expense_period:'费用',vat_output_period:'销项',vat_input_period:'进项',income_tax_period:'所得税期间',cost_treatment:'费用与资产',tax_choice:'税务选择'};
 const label=(map,key)=>Object.hasOwn(map,key)?map[key]:undefined;
 const pending=context.unresolved.map(item=>(label(gaps,item?.code)??'事项待核')+(label(kinds,item?.kind)?'（'+label(kinds,item.kind)+'）':'')).join('；')||'无';
 // 只装配后端固定短正文；不序列化方法目录、证据明细、自由说明或历史版本。
 const text='企业短业务基线（只读）：'+states[context.status]+'\n'+(context.shortText||'尚无可用短原则；先按company-baseline/SKILL.md核资料，不把未知清单当完成。')+'\n重要待核：'+pending+'。基线不证明本期完成。';
 // 静态加载规则与动态正文合计限长；Claude项目规则、Pi/dsh提示均只装配一次该规则。
 if(Array.from(text+'\n\n'+BUSINESS_MEMORY_ROUTING).length>1000)fail('host_business_baseline_context_too_large');
 return text;
}
export function businessSessionFiles(context){
 const runtime=pathToFileURL(join(context.repoRoot,'05-reconstruction/codex/hosts/shared/business-session.mjs')).href;
 const config={version:HOST_VERSION,host:context.host,workspace:context.outputDir,repoRoot:context.repoRoot,nodePath:context.nodePath,databasePath:context.databasePath,auditDir:context.auditDir,mcpEnv:context.mcpEnv};
 return [
  {path:'.finance/host.json',content:JSON.stringify(config,null,2)+'\n'},
  {path:'start-business-session.mjs',content:`#!/usr/bin/env node\nimport {runBusinessSession} from ${JSON.stringify(runtime)};\nawait runBusinessSession(new URL('.',import.meta.url),process.argv.slice(2));\n`},
  {path:'business-memory-context.mjs',content:`#!/usr/bin/env node\nimport {runBusinessContext} from ${JSON.stringify(runtime)};\nawait runBusinessContext(new URL('.',import.meta.url),process.argv.slice(2));\n`},
 ];
}
export function parseBusinessArgs(args){
 const out={hostArgs:[]};let rest=false;
 for(let i=0;i<args.length;i++){
  const name=args[i];if(rest){out.hostArgs.push(name);continue;}if(name==='--'){rest=true;continue;}
  if(['--help','--check','--prepare-only'].includes(name)){if(out[name])fail('host_business_arguments_invalid');out[name]=true;}
  else if(['--account-set-id','--period'].includes(name)){if(out[name]!==undefined||!args[i+1]||args[i+1].startsWith('--'))fail('host_business_arguments_invalid');out[name]=args[++i];}
  else fail('host_business_arguments_invalid');
 }
 if(out['--help'])return out;
 if(Boolean(out['--account-set-id'])!==Boolean(out['--period']))fail('host_business_explicit_target_required');
 if(out['--account-set-id']!==undefined){const id=Number(out['--account-set-id']);if(!/^[1-9]\d*$/.test(out['--account-set-id'])||!Number.isSafeInteger(id)||!/^202[67]-(0[1-9]|1[0-2])$/.test(out['--period']))fail('host_business_target_invalid');out.target={accountSetId:id,period:out['--period']};}
 if((out['--check']&&out['--prepare-only'])||((out['--check']||out['--prepare-only'])&&out.hostArgs.length))fail('host_business_check_cannot_launch');
 if(out.hostArgs.includes('--check'))fail('host_business_use_top_level_check');
 return out;
}
export async function runBusinessSession(workspaceUrl,args){
 const options=parseBusinessArgs(args),workspace=fileURLToPath(workspaceUrl);
 if(options['--help']){console.log('node start-business-session.mjs [--account-set-id <实际账套ID> --period YYYY-MM] [--prepare-only | --check | -- <宿主启动参数>]\n--prepare-only 显式绑定并更新历史目录，不生成业务基线、不启动模型；--check 仅只读检查已有绑定和短基线；正常启动自动准备目录，再由Agent按company-baseline技能生成所缺基线。一个工作区固定一家账套及本期，换企业/期间生成新工作区。');return;}
 if(options['--check']){
  const bound=await readBoundBusinessContext(workspace);
  if(options.target&&(options.target.accountSetId!==bound.target.accountSetId||options.target.period!==bound.target.period))fail('host_business_binding_mismatch');
  console.log(JSON.stringify({status:'checked',scope:bound.session.scope,baselineStatus:bound.context.status,context:bound.context,modelInvoked:false,readOnly:true},null,2));return;
 }
 const hostName=loadBusinessHost(workspace).host;
 if(!options['--prepare-only']&&hostName==='claude-code'){
  const {parseClaudeArgs,buildClaudeLaunchSpec}=await import('../claude-code/launcher.mjs'),nativeOptions=parseClaudeArgs(options.hostArgs);
  if(nativeOptions['--check'])fail('host_business_use_top_level_check');
  if(nativeOptions['--resume'])buildClaudeLaunchSpec(workspace,nativeOptions);
 }
 const bound=await prepareBoundBusinessSession(workspace,options.target);
 if(options['--prepare-only']){console.log(JSON.stringify({status:'prepared',scope:bound.session.scope,baselineStatus:bound.context.status,prepared:bound.prepared,context:bound.context,modelInvoked:false,readOnly:false},null,2));return;}
 const host=bound.config.host;
 if(host==='pi'){const {runPi}=await import('../pi/launcher.mjs');await runPi(pathToFileURL(join(workspace,'pi-host.json')),options.hostArgs,bound);}
 else if(host==='dsh'){const {runDsh}=await import('../dsh/launcher.mjs');await runDsh(bound.config.nodePath,workspaceUrl,options.hostArgs,bound);}
 else if(host==='claude-code'){const {runClaude}=await import('../claude-code/launcher.mjs');await runClaude(workspaceUrl,options.hostArgs,bound);}
 else {const {runZcode}=await import('../zcode/launcher.mjs');await runZcode(workspaceUrl,options.hostArgs,bound);}
}
export async function runBusinessContext(workspaceUrl,args){
 const workspace=fileURLToPath(workspaceUrl);
 if(args.length===1&&args[0]==='--check'){
  const {session,context}=await readBoundBusinessContext(workspace);console.log(JSON.stringify({status:'checked',scope:session.scope,context,readOnly:true,modelInvoked:false},null,2));return;
 }
 if(args.length===1&&['--claude-hook','--claude-guard'].includes(args[0])){
  const {runClaudeHook}=await import('../claude-code/business-memory-hook.mjs');await runClaudeHook(workspace,args[0]);return;
 }
 fail('host_business_context_arguments_invalid');
}
