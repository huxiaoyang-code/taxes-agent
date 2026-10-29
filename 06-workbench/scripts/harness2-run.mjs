#!/usr/bin/env node
import {prepare,dispatch} from '../../05-reconstruction/codex/harness2/bridge.mjs';
import {resolveModes,fail} from '../../05-reconstruction/codex/harness2/surface.mjs';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
export function parseArgs(args){
  const names={'--host':'host','--harness-improvement':'harnessImprovement','--runtime-efficiency':'runtimeEfficiency','--execution-mode':'executionMode','--root':'root','--pi-root':'packageRoot','--cli-path':'cliPath','--run-id':'runId','--candidate':'candidateDir','--timeout-ms':'timeoutMs','--config':'config','--tool-root':'toolRoot','--archive-root':'archiveRoot','--account-set-id':'accountSetId','--task-file':'taskFile','--tools':'tools'},o={};
  for(let i=0;i<args.length;i++){
    const arg=args[i];if(['--help','--prepare','--probe','--query','--check','--json'].includes(arg)){if(o[arg])fail('harness2_arguments_invalid');o[arg]=true;continue;}
    const [key,inline]=arg.split('=',2);if(!names[key]||o[names[key]]!==undefined)fail('harness2_arguments_invalid');const value=inline??args[++i];if(!value||value.startsWith('--'))fail('harness2_arguments_invalid');o[names[key]]=value;
  }
  if(o.timeoutMs!==undefined)o.timeoutMs=Number(o.timeoutMs);if(['--prepare','--probe','--query'].filter(key=>o[key]).length>1)fail('harness2_arguments_invalid');return o;
}
export async function main(args){
  const o=parseArgs(args);if(o['--help'])return {usage:'harness2-run.mjs --host pi|claude-code|zcode|dsh --harness-improvement off|harness2 --runtime-efficiency off|sol-pi [--prepare --root NEW_ABSOLUTE_DIR | --probe --root DIR --run-id ID --pi-root PACKAGE | --query ...]',modelInvoked:false};
  const modes=resolveModes(o);
  if(modes.runtimeEfficiency==='sol-pi'){
    const moduleUrl=new URL('./sol-pi-run.mjs',import.meta.url);if(!existsSync(fileURLToPath(moduleUrl)))fail('optional_dependency_missing_sol_pi');
    const solArgs=['--runtime-efficiency','sol-pi'];
    for(const [flag,key] of Object.entries({'--config':'config','--pi-root':'packageRoot','--tool-root':'toolRoot','--archive-root':'archiveRoot','--account-set-id':'accountSetId','--task-file':'taskFile','--tools':'tools'}))if(o[key]!==undefined)solArgs.push(flag,o[key]);
    for(const flag of ['--check','--json'])if(o[flag])solArgs.push(flag);
    const {run}=await import(moduleUrl.href);return run(solArgs);
  }
  if(modes.harnessImprovement==='off')return {...modes,status:'baseline',optionalDependenciesLoaded:false,modelInvoked:false};
  if(o['--prepare'])return prepare(o);
  return dispatch({...o,...modes,version:'finance-harness2-request/1',action:o['--query']?'query':o['--probe']?'probe':'execute'});
}
if(process.argv[1]&&import.meta.url===(await import('node:url')).pathToFileURL(process.argv[1]).href){try{const result=await main(process.argv.slice(2));if(typeof result==='number'){if(!Number.isInteger(result)||result<0||result>255)fail('harness2_child_exit_code_invalid');process.exitCode=result;}else if(result!==undefined)console.log(JSON.stringify(result,null,2));}catch(e){console.log(JSON.stringify({status:'blocked',code:/^[a-z0-9_]+$/.test(e.code??e.message)?e.code??e.message:'harness2_launcher_failed',modelInvoked:false}));process.exitCode=1;}}
