import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,existsSync,readFileSync} from 'node:fs';
import {tmpdir,homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('实际Pi CLI工具选项经SDK注册后，direct业务工具可按需激活且无模型请求',{timeout:45000},t=>{
  const candidates=[process.env.PI_SDK_ROOT,join(process.env.APPDATA??join(homedir(),'AppData/Roaming'),'npm/node_modules/@earendil-works/pi-coding-agent')].filter(Boolean);
  const sdkRoot=candidates.find(root=>existsSync(join(root,'dist/index.js')));
  if(!sdkRoot){t.skip('当前未安装Pi1.1.0，CI程序测试不能代替本机--check');return;}
  if(JSON.parse(readFileSync(join(sdkRoot,'package.json'))).version!=='1.1.0'){t.skip('未核实的Pi版本不能宣称真实接入通过');return;}
  const root=mkdtempSync(join(tmpdir(),'pi-direct-disclosure-')),repo=resolve(fileURLToPath(new URL('../..',import.meta.url)));
  const env={...process.env,FINANCE_MCP_PROFILE:'direct',FINANCE_AUDIT_DIR:join(root,'records'),FINANCE_DATABASE_PATH:join(root,'unused-data/workbench.db'),WORKBENCH_DATA_DIR:join(root,'unused-data'),FINANCE_API_BASE:'http://127.0.0.1:9',FINANCE_API_TOKEN:''};
  for(const key of ['ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','OPENAI_API_KEY','DEEPSEEK_API_KEY','GEMINI_API_KEY'])delete env[key];
  const child=spawnSync(process.execPath,[join(repo,'06-workbench/scripts/direct-pi-probe.mjs'),sdkRoot,'--agent-dir',join(root,'agent')],{cwd:repo,env,windowsHide:true,encoding:'utf8',timeout:40000,maxBuffer:2*1024*1024});
  assert.equal(child.status,0,child.stderr||child.error?.message);const result=JSON.parse(child.stdout.trim().split(/\r?\n/).at(-1));
  assert.equal(result.modelInvoked,false);assert.equal(result.agentTaskInvoked,false);assert.equal(result.deferredRegisteredBeforeSearch,true);assert.equal(result.deferredActivatedAfterSearch,true);
  assert.ok(result.cliTools.every(value=>value.startsWith('+')||value.startsWith('-')));assert.equal(result.initialActiveTools.includes('mcp__finance__finance_workpaper'),false);
});
