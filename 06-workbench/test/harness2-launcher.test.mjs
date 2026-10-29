import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {stopChild} from '../../05-reconstruction/codex/harness2/bridge.mjs';
mkdirSync(resolve('.agent-runs'),{recursive:true});const root=mkdtempSync(resolve('.agent-runs/harness2-launcher-'));
const repo=resolve(import.meta.dirname,'../..'),launcher=join(root,'harness2-run.mjs');
let source=readFileSync(join(repo,'06-workbench/scripts/harness2-run.mjs'),'utf8');
for(const name of ['bridge.mjs','surface.mjs'])source=source.replace('../../05-reconstruction/codex/harness2/'+name,pathToFileURL(join(repo,'05-reconstruction/codex/harness2',name)).href);
writeFileSync(launcher,source);
for(const code of [7,0]){
  writeFileSync(join(root,'sol-pi-run.mjs'),`export async function run(args){if(!args.includes('--check'))throw Error('synthetic_check_required');return ${code};}`);
  const child=spawnSync(process.execPath,[launcher,'--host','pi','--runtime-efficiency','sol-pi','--check'],{cwd:root,encoding:'utf8',windowsHide:true,shell:false});
  assert.equal(child.status,code,child.stderr);assert.equal(child.stdout.trim(),'','numeric native exit code is not a success report');
}
const owned=spawn(process.execPath,['-e','setInterval(()=>{},100)'],{cwd:root,stdio:['ignore','pipe','pipe'],windowsHide:true,shell:false});
await new Promise((ok,no)=>{owned.once('spawn',ok);owned.once('error',no);});let attempts=0;
await stopChild(owned,{platform:'win32',taskkill:()=>{attempts++;return {status:null,error:Object.assign(new Error('synthetic sandbox denial'),{code:'EACCES'})};}});
assert.equal(attempts,1);assert.ok(owned.exitCode!==null||owned.signalCode!==null,'owned direct child must be observed stopped');
console.log('harness2-launcher: SoL native numeric exit7/0 propagate; denied tree cleanup falls back to observed direct-child termination without claiming full-tree proof');
