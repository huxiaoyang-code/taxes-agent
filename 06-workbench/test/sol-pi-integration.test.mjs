import assert from 'node:assert/strict';
import {mkdtempSync,readdirSync,rmSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {resolveSolPi,loadSolPi,launchSolPi} from '../../05-reconstruction/codex/sol-pi/runtime.mjs';

const root=mkdtempSync(join(tmpdir(),'finance-sol-pi-contract-'));
try{
  for(const host of ['pi','claude-code','dsh','zcode']){
    const selection=resolveSolPi({host,toolRoot:join(root,'does-not-exist'),archiveRoot:join(root,'archive')});
    assert.equal(selection.enabled,false);assert.deepEqual(loadSolPi(selection),selection);
  }
  assert.deepEqual(readdirSync(root),[],'off must not create artifacts or inspect missing dependencies');
  assert.throws(()=>resolveSolPi({host:'unknown'}),/host_invalid/);
  assert.throws(()=>resolveSolPi({host:'pi',runtimeEfficiency:'on'}),/mode_invalid/);
  assert.throws(()=>resolveSolPi({host:'pi',harnessImprovement:'unknown'}),/mode_invalid/);
  for(const host of ['claude-code','dsh','zcode'])assert.throws(()=>resolveSolPi({host,runtimeEfficiency:'sol-pi'}),new RegExp(`host_unsupported:${host}`));
  assert.throws(()=>resolveSolPi({host:'pi',runtimeEfficiency:'sol-pi',harnessImprovement:'harness2'}),/combination_unsupported/);
  assert.throws(()=>resolveSolPi({host:'pi',runtimeEfficiency:'sol-pi'}),/explicit_tool_root/);
  const input={host:'pi',runtimeEfficiency:'sol-pi',toolRoot:join(root,'tools'),archiveRoot:join(root,'archive'),accountSetId:'synthetic_account'};
  for(const accountSetId of ['../escape','a/b','中文公司',''])assert.throws(()=>resolveSolPi({...input,accountSetId}),/account_id_required/);
  const selection=resolveSolPi(input);assert.notEqual(selection.sessionId,resolveSolPi(input).sessionId);
  assert.throws(()=>loadSolPi(selection),/locked_dependency_directory_required/);
  mkdirSync(input.toolRoot);writeFileSync(join(input.toolRoot,'package-lock.json'),'{}');
  assert.throws(()=>loadSolPi(selection),/locked_dependency_digest_mismatch/);
  await assert.rejects(()=>launchSolPi(resolveSolPi({host:'pi'})),/requires_explicit_selection/);
  assert.deepEqual(readdirSync(root),['tools'],'all invalid selections fail before archive allocation/model launch');
  console.log('sol-pi integration contracts passed: default off, host/mode/combination, missing dependency, path isolation, no launch');
}finally{rmSync(root,{recursive:true,force:true});}
