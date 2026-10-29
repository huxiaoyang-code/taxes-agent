#!/usr/bin/env node
// Explicit source/dependency allowlist for the read-only Linux research mount.
import {mkdirSync,cpSync,existsSync,writeFileSync,lstatSync,readdirSync} from 'node:fs';
import {resolve,join,isAbsolute,dirname} from 'node:path';
import {treeDigest} from '../../05-reconstruction/codex/harness2/bridge.mjs';
const repo=resolve(import.meta.dirname,'../..'),out=process.argv[2];
if(!out||!isAbsolute(out)||existsSync(out))throw Error('harness2_stage_new_absolute_required');
mkdirSync(out);
const directories=['06-workbench/server','06-workbench/node_modules','05-reconstruction/codex/mcp','05-reconstruction/codex/pi','05-reconstruction/codex/hosts','05-reconstruction/codex/harness2','05-reconstruction/codex/skills'];
for(const name of directories){const source=join(repo,name);if(!existsSync(source))throw Error('harness2_stage_dependency_missing');cpSync(source,join(out,name),{recursive:true,errorOnExist:true,force:false,filter:path=>{const s=lstatSync(path);if(s.isSymbolicLink())throw Error('harness2_stage_symlink_forbidden');return !path.endsWith('__pycache__');}});}
const scripts=['harness2-run.mjs','harness2-bridge.mjs','harness2-seed.mjs','harness2-pi-probe.mjs','harness2-pi-task.mjs','harness2-capture.mjs','harness2-query.mjs','harness2-sandbox-supervisor.mjs','harness-pi-probe.mjs','accountant-review-q2.mjs','offline-period-plan.mjs','offline-vat-pair.mjs','offline-vat-q2.mjs'];
for(const name of ['06-workbench/package.json','06-workbench/package-lock.json','05-reconstruction/catalog.json',...scripts.map(name=>'06-workbench/scripts/'+name)]){mkdirSync(dirname(join(out,name)),{recursive:true});cpSync(join(repo,name),join(out,name),{errorOnExist:true,force:false});}
writeFileSync(join(out,'stage.json'),JSON.stringify({version:'finance-harness2-stage/1',sourceDigest:treeDigest(out),allowlist:directories,scripts,independentAssessmentIncluded:false,modelInvoked:false},null,2),{flag:'wx'});
console.log(JSON.stringify({status:'staged',modelInvoked:false}));
