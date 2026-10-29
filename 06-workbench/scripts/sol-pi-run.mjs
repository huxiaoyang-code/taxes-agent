#!/usr/bin/env node
import {readFileSync,mkdirSync} from 'node:fs';
import {dirname,isAbsolute,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {parseArgs,buildLaunchSpec} from '../../05-reconstruction/codex/hosts/pi/launcher.mjs';
import {resolveSolPi,loadSolPi,launchSolPi} from '../../05-reconstruction/codex/sol-pi/runtime.mjs';

export async function run(args){
  const special={},baseline=[],names={'--config':'config','--host':'host','--runtime-efficiency':'runtimeEfficiency','--harness-improvement':'harnessImprovement','--tool-root':'toolRoot','--archive-root':'archiveRoot','--account-set-id':'accountSetId'};
  for(let i=0;i<args.length;i++){
    if(names[args[i]]){const key=names[args[i]];if(special[key]!==undefined||!args[i+1]||args[i+1].startsWith('--'))throw Error('sol_pi_arguments_invalid');special[key]=args[++i];}
    else baseline.push(args[i]);
  }
  if(baseline.includes('--help')){console.log('node sol-pi-run.mjs --config <absolute generated pi-host.json> [--host pi] [--runtime-efficiency off|sol-pi] [--harness-improvement off] --pi-root <absolute package> [--check | --task-file <absolute task>]\nsol-pi additionally requires --tool-root <locked isolated tools> --archive-root <local archive> --account-set-id <stable local id>. No dependency installation or model call occurs during --check.');return;}
  const selection=resolveSolPi({host:special.host??'pi',...special});
  if(selection.host!=='pi')throw Error('sol_pi_runner_requires_pi_host');
  if(selection.harnessImprovement!=='off')throw Error('sol_pi_runner_harness2_not_supported');
  if(!isAbsolute(special.config??''))throw Error('sol_pi_generated_host_config_required');
  const options=parseArgs(baseline),config=JSON.parse(readFileSync(special.config,'utf8')),cwd=dirname(special.config),spec=buildLaunchSpec(config,cwd,options);
  if(!selection.enabled){
    if(!options['--check'])mkdirSync(spec.env.PI_CODING_AGENT_DIR,{recursive:true});
    return execute(spec);
  }
  const checked=loadSolPi(selection,{probe:options['--check']});
  if(checked.piRoot.replaceAll('\\','/').toLowerCase()!==options['--pi-root'].replaceAll('\\','/').replace(/\/$/,'').toLowerCase())throw Error('sol_pi_launch_pi_root_mismatch');
  if(options['--check'])return execute({command:config.nodePath,args:[join(config.repoRoot,'06-workbench/scripts/sol-pi-probe.mjs'),'--tool-root',selection.toolRoot,'--archive-root',selection.archiveRoot,'--account-set-id',selection.accountSetId],cwd,env:spec.env});
  mkdirSync(spec.env.PI_CODING_AGENT_DIR,{recursive:true});
  const result=await launchSolPi(checked,spec);console.error(JSON.stringify({solPiArchive:result.archiveDirectory,retention:'manual; do not delete before evidence review and recall-dependent work complete'}));return result.code;
}
async function execute(spec){const child=spawn(spec.command,spec.args,{cwd:spec.cwd,env:spec.env,shell:false,windowsHide:true,stdio:'inherit'});return new Promise((ok,no)=>{child.once('error',no);child.once('close',(code,signal)=>ok(signal?1:code??1));});}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)process.exitCode=await run(process.argv.slice(2));
