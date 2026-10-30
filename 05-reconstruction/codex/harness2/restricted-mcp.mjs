// 仅供实验的协议边界；产品财税 MCP 保持原有实现。
import {spawn} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {join,resolve,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
const TOOLS=new Set(['harness_discover','harness_scope_discover','harness_source_register','harness_facts_register','harness_plan','harness_status','harness_run','harness_receipt_read','skills_list','skills_read']);
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export function validateResearchCall(name,args,{root,scope}){
  if(!TOOLS.has(name)||!args||typeof args!=='object')return false;
  const dbPath=join(root,'data/workbench.db'),target={dbPath,databaseInstanceId:scope.databaseInstanceId,enterpriseKey:scope.enterpriseKey,accountSetId:scope.accountSetId};
  const targetSame=value=>value&&Object.keys(value).length===4&&Object.keys(target).every(key=>value[key]===target[key]);
  if(name==='harness_discover')return args.capabilityId===undefined||args.capabilityId==='period.inspect';
  if(name==='harness_scope_discover')return args.dbPath===undefined||resolve(args.dbPath)===resolve(dbPath);
  if(name==='skills_list')return true;
  if(name==='skills_read')return typeof args.resource==='string'&&args.resource.startsWith('harness/')&&!args.resource.includes('..');
  if(args.storePath!==join(root,'harness-store'))return false;
  if(name==='harness_source_register')return args.source?.sourceId==='synthetic-request'&&args.source.path===join(root,'period-request.json')&&args.source.parsed!==true&&!(args.source.codePaths?.length)&&!(args.source.validationPaths?.length);
  if(name==='harness_facts_register')return Array.isArray(args.facts)&&args.facts.length===1&&args.facts[0].factId==='request'&&args.facts[0].state==='provided'&&same(args.facts[0].sourceRefs,['synthetic-request'])&&Object.keys(args.facts[0].value??{}).length===1&&targetSame(args.facts[0].value?.target);
  if(name==='harness_plan')return Array.isArray(args.tasks)&&args.tasks.length===1&&args.tasks[0].taskId==='inspect-period'&&args.tasks[0].capabilityId==='period.inspect'&&same(args.tasks[0].factIds,['request'])&&same(args.tasks[0].dependsOn,[])&&!args.tasks[0].externalDependencies?.length;
  if(name==='harness_run')return args.taskId==='inspect-period'&&['execute','query'].includes(args.phase??'execute')&&args.treatmentId===undefined;
  return ['harness_status','harness_receipt_read'].includes(name);
}
export async function serveResearchMcp(){
  const root=process.env.FINANCE_HARNESS2_SYNTHETIC_ROOT;if(!root||!isAbsolute(root))throw Error('harness2_explicit_synthetic_root_required');
  const {scope,version}=JSON.parse(readFileSync(join(root,'synthetic.json'),'utf8'));if(version!=='finance-harness2-synthetic/1'||scope.enterpriseKey!=='SYNTHETIC-HARNESS2-A')throw Error('harness2_synthetic_identity_required');
  const server=join(import.meta.dirname,'../mcp/finance-mcp/server.mjs');
  const child=spawn(process.execPath,[server],{cwd:root,env:process.env,stdio:['pipe','pipe','pipe'],windowsHide:true,shell:false});
  const lists=new Set();let input='',output='';
  const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
  process.stdin.setEncoding('utf8');process.stdin.on('data',text=>{
    input+=text;if(Buffer.byteLength(input)>262144){child.kill();process.exitCode=1;process.stdin.destroy();return;}
    for(;;){const i=input.indexOf('\n');if(i<0)break;const line=input.slice(0,i);input=input.slice(i+1);let message;try{message=JSON.parse(line);}catch{continue;}
      let allowed=['initialize','notifications/initialized','ping','tools/list','prompts/list'].includes(message.method);
      if(message.method==='tools/list')lists.add(message.id);
      if(message.method==='tools/call'){
        allowed=validateResearchCall(message.params?.name,message.params?.arguments??{},{root,scope});
        if(allowed&&message.params.name==='harness_discover')message.params.arguments={capabilityId:'period.inspect'};
      }
      if(message.method==='resources/list')allowed=true;
      if(message.method==='resources/read')allowed=/^skill:\/\/harness\//.test(message.params?.uri??'')&&!message.params.uri.includes('..');
      if(!allowed){if(message.id!==undefined)send({jsonrpc:'2.0',id:message.id,result:{isError:true,content:[{type:'text',text:'{"code":"harness2_research_tool_forbidden"}'}],structuredContent:{status:'rejected',code:'harness2_research_tool_forbidden'}}});continue;}
      child.stdin.write(JSON.stringify(message)+'\n');
    }
  });
  child.stdout.setEncoding('utf8');child.stdout.on('data',text=>{output+=text;if(Buffer.byteLength(output)>4*1024*1024){child.kill();return;}for(;;){const i=output.indexOf('\n');if(i<0)break;const line=output.slice(0,i);output=output.slice(i+1);let message;try{message=JSON.parse(line);}catch{continue;}if(lists.delete(message.id)&&Array.isArray(message.result?.tools))message.result.tools=message.result.tools.filter(tool=>TOOLS.has(tool.name));send(message);}});
  child.stderr.resume();process.stdin.once('end',()=>child.stdin.end());
  for(const event of ['SIGINT','SIGTERM'])process.once(event,()=>child.kill());
  await new Promise((ok,no)=>{child.once('error',no);child.once('close',code=>{process.exitCode=code??1;ok();});});
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1]))await serveResearchMcp();
