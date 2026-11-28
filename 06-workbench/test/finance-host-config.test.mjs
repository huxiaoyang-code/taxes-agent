import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {PLUGIN_SKILL_FILES} from '../server/finance-skill-assets.mjs';
import {createContext,writeBundle,repoRoot} from '../../05-reconstruction/codex/hosts/shared/config.mjs';
import {buildConfig} from '../../05-reconstruction/codex/hosts/claude-code/adapter.mjs';
import {directTools} from '../../05-reconstruction/codex/mcp/finance-mcp/direct-tool-catalog.mjs';
import {McpStdioClient} from '../../05-reconstruction/codex/mcp/finance-mcp/mcp-stdio-client.mjs';
import {parseArgs as parsePiArgs,buildLaunchSpec,MAIN_TOOLS,DEFAULT_TOOL_MODIFIERS} from '../../05-reconstruction/codex/hosts/pi/launcher.mjs';
import {PERIOD_TASK_ROUTING, FINANCE_MCP_DISCOVERY} from '../../05-reconstruction/codex/hosts/shared/task-routing.mjs';
import {BUSINESS_MEMORY_ROUTING} from '../../05-reconstruction/codex/hosts/shared/business-session.mjs';
import financeDirect from '../../05-reconstruction/codex/pi/finance-direct.ts';
const root=mkdtempSync(join(tmpdir(),'finance-hosts-')),options={nodePath:process.execPath,apiBase:'http://127.0.0.1:8787',databasePath:join(root,'synthetic.db'),outputDir:join(root,'claude')};
const c=createContext(options);assert.equal(c.repoRoot,repoRoot);assert.equal(Object.hasOwn(c,'pluginRoot'),false);assert.equal(c.skillsDir,join(repoRoot,'plugins/finance/skills'));assert.equal(Object.hasOwn(c.mcpEnv,'FINANCE_SKILLS_DIR'),false);assert.equal(c.mcp.env.FINANCE_MCP_PROFILE,'direct');
for(const change of [{nodePath:'node'},{databasePath:'relative.db'},{outputDir:root},{apiBase:'https://example.com'},{apiBase:'http://127.0.0.1:8787/private'},{apiBase:'http://user:pass@localhost:8787'},{pluginRoot:root},{auditDir:'relative'}])assert.throws(()=>createContext({...options,...change}));
assert.throws(()=>writeBundle(c,{files:[{path:'../escape',content:'x'}]}),/host_file_invalid/);assert.equal(existsSync(c.outputDir),false);
const bundle=buildConfig(c);writeBundle(c,bundle);const config=JSON.parse(readFileSync(join(c.outputDir,'.mcp.json'),'utf8'));assert.deepEqual(config.mcpServers.finance,{command:c.nodePath,args:[c.serverPath],env:c.mcpEnv});
assert.throws(()=>writeBundle(c,bundle),/EEXIST/);assert.equal(existsSync(join(root,'escape')),false);
const permissions=JSON.parse(readFileSync(join(c.outputDir,'.claude/settings.json'),'utf8')).permissions;
assert.ok(readFileSync(join(c.outputDir,'CLAUDE.md'),'utf8').includes(PERIOD_TASK_ROUTING));
// 运行扩展注册函数核查实际曝光合同，不把生成提示词等同模型已阅读。
const registrations=[];financeDirect({registerMcpServer:(name,config)=>registrations.push({name,config})});
assert.equal(registrations.length,1);assert.equal(registrations[0].name,'finance');
assert.equal(registrations[0].config.toolExposure.skills_read,'direct');assert.equal(registrations[0].config.toolExposure.finance_rules,'direct');assert.equal(registrations[0].config.toolExposure['*'],'deferred');
assert.ok(registrations[0].config.description.includes(FINANCE_MCP_DISCOVERY));
assert.ok(!permissions.allow.includes('mcp__finance__*'));assert.equal([...permissions.allow,...permissions.ask].some(x=>x.startsWith('mcp__finance__harness_')),false);
const generatedTools=directTools.filter(t=>t.name!=='ledger_query');
const boundReads=['account_list','finance_query'].map(name=>'mcp__finance__'+name);
const discovery=['skills_list','skills_read','finance_query_catalog'].map(name=>'mcp__finance__'+name);
assert.deepEqual(new Set([...permissions.allow,...permissions.ask,...boundReads]),new Set(generatedTools.map(t=>'mcp__finance__'+t.name)));
assert.ok(boundReads.every(name=>!permissions.allow.includes(name)&&!permissions.ask.includes(name)));
assert.ok(discovery.every(name=>permissions.allow.includes(name)));
for(const tool of generatedTools.filter(t=>t.annotations?.readOnlyHint!==true)){
 const rule='mcp__finance__'+tool.name;
 assert.ok([...boundReads,...discovery].includes(rule)||permissions.ask.includes(rule));
}
// 读取范围由正式委托的原件目录确定。只选一份校验证明时仍需读取目录内的辅助登记簿。
const sourceRoot=join(root,'甲公司 原件 (一)[01]');
mkdirSync(sourceRoot);
const proof=join(sourceRoot,'回单.json');
writeFileSync(proof,'{}');
writeFileSync(join(sourceRoot,'交接.md'),'合成交接');
function sourcePermissions(changes) {
  const context=createContext({...options,outputDir:join(root,'source-config'),sourceRoot,...changes});
  const settings=buildConfig(context).files.find(file=>file.path==='.claude/settings.json');
  return JSON.parse(settings.content).permissions;
}
const delegated={voucherCorrections:'delegated',correctionOriginals:[proof]};
const scoped=sourcePermissions(delegated);
const rootPattern='/'+root.replaceAll('\\','/').replace(/^([a-z]):/i,(_,drive)=>'/'+drive.toLowerCase());
const sourcePattern=rootPattern+'/甲公司 原件 (一)\\[01\\]';
assert.deepEqual(scoped.allow.filter(rule=>rule.startsWith('Read(')),['Read('+sourcePattern+')','Read('+sourcePattern+'/**)']);
assert.deepEqual(scoped.allow.filter(rule=>rule.startsWith('Edit(')),['Edit(/outputs/*.csv)','Edit(/outputs/*.md)']);
assert.equal(scoped.defaultMode,'default');
assert.equal(scoped.additionalDirectories,undefined);
assert.equal(scoped.deny,undefined);
const mixed=sourcePermissions({...delegated,databasePath:join(sourceRoot,'账套.db')});
assert.deepEqual(mixed.deny,['','-wal','-shm','-journal'].map(suffix=>'Read('+sourcePattern+'/账套.db'+suffix+')'));
assert.deepEqual(sourcePermissions({}).allow,permissions.allow);
assert.equal(bundle.files.some(f=>f.path.startsWith('.claude/agents/')),false);
// 四宿主真实CLI均固定同仓库技能，旧外部参数明确拒绝。
for(const host of ['pi','claude-code','dsh','zcode']){
 const out=join(root,'cli-'+host),expected=join(repoRoot,'plugins/finance/skills');
 const args=[join(repoRoot,'06-workbench/scripts/finance-host-config.mjs'),'--host',host,'--node',process.execPath,'--api-base',options.apiBase,'--database',options.databasePath,'--out',out];
 const run=spawnSync(process.execPath,args,{encoding:'utf8',windowsHide:true,timeout:15000});assert.equal(run.status,0,run.stderr);
 const file=host==='pi'?'pi-host.json':host==='claude-code'?'.mcp.json':host==='dsh'?'finance.cordis.patch.yml':'.zcode/config.json';
 const config=JSON.parse(readFileSync(join(out,file),'utf8'));
 const server=host==='pi'?{env:config.mcpEnv}:host==='claude-code'?config.mcpServers.finance:host==='dsh'?config.flatMap(p=>p.insert??[]).find(p=>p.id==='finance-direct-mcp').config:config.mcp.servers.finance;
 assert.equal(Object.hasOwn(server.env,'FINANCE_SKILLS_DIR'),false);
 assert.equal(server.env.FINANCE_QUERY_DISCOVERY,'canonical',host);
 assert.equal(server.env.FINANCE_SKILL_DISCOVERY,'focused',host);
 const client=new McpStdioClient(c.serverPath,{env:server.env}).start();
 try {
   await client.initialize();
   const {result:{tools}}=await client.rpc('tools/list');
   assert.deepEqual(tools.map(t=>t.name),generatedTools.map(t=>t.name),host);
   const query=tools.find(t=>t.name==='finance_query');
   assert.match(query.description,/科目明细账.*ledger\.general.*params\.code/);
   const catalog=await client.call('skills_list',{});
   assert.deepEqual(Object.keys(catalog.data),['entries']);
   assert.equal(catalog.data.entries.length,9);
   const skill=await client.call('skills_read',{resource:'reconciliation/SKILL.md'});
   assert.match(skill.data.markdown,/finance_query.*ledger\.general.*params\.code/);
 } finally { await client.close(); }
 if(host==='pi')assert.equal(config.skillsDir,expected);
 if(host==='claude-code'){
   assert.match(readFileSync(join(out,'CLAUDE.md'),'utf8'),/\.claude\/skills.*原生 Skill/);
   const source=JSON.parse(readFileSync(join(out,'.finance/skill-source.json'),'utf8'));
   assert.equal(source.source,'project');
   assert.equal(source.version,JSON.parse(readFileSync(join(repoRoot,'plugins/finance/.claude-plugin/plugin.json'),'utf8')).version);
   assert.deepEqual(source.skills,PLUGIN_SKILL_FILES.filter(file=>file.endsWith('/SKILL.md')).map(file=>file.split('/')[0]));
   for(const file of PLUGIN_SKILL_FILES.filter(file=>file.endsWith('.md'))){
     assert.ok(readFileSync(join(out,'.claude/skills',file)).equals(readFileSync(join(expected,file))),file);
   }
   for(const file of ['SOURCES.md','LICENSE','LICENSE.knowledge-work-plugins','CONNECTORS.md']){
     assert.ok(readFileSync(join(out,'.claude',file)).equals(readFileSync(join(repoRoot,'plugins/finance',file))),file);
   }
   const demo=spawnSync(process.execPath,[join(out,'.claude/skills/prebook-review/scripts/demo.mjs'),join(out,'synthetic-demo')],{encoding:'utf8',windowsHide:true,timeout:30000});
   assert.equal(demo.status,0,demo.stderr);
   assert.equal(JSON.parse(demo.stdout).runs.length,4);
 }
 if(host==='dsh')assert.deepEqual(config.find(p=>p.id==='skill-filesystem').config.customSkillDirs,[expected]);
 if(host==='zcode')assert.deepEqual(config.skills.roots,[expected]);
 const rejected=spawnSync(process.execPath,[...args,'--plugin-root',root],{encoding:'utf8',windowsHide:true,timeout:15000});assert.notEqual(rejected.status,0);assert.match(rejected.stderr,/host_arguments_invalid/);
 assert.equal(existsSync(options.databasePath),false);
}
for(const host of ['pi','dsh','zcode']){
  const {buildConfig:build}=await import(`../../05-reconstruction/codex/hosts/${host}/adapter.mjs`);
  const context=createContext({...options,outputDir:join(root,host)}),output=writeBundle(context,build(context));assert.ok(output.files.length>0);
  const native=JSON.parse(readFileSync(join(context.outputDir,host==='pi'?'pi-host.json':host==='dsh'?'finance.cordis.patch.yml':'.zcode/config.json'),'utf8'));
  assert.ok(JSON.stringify(native).includes('FINANCE_MCP_PROFILE'));assert.ok(JSON.stringify(native).includes('direct'));
  const instructions=readFileSync(join(context.outputDir,'AGENTS.md'),'utf8');assert.ok(instructions.includes('账本金额→凭证/计算结果→规则依据→工具调用→输入与原件'));assert.ok(instructions.includes(PERIOD_TASK_ROUTING));
  if(host==='pi'){
    assert.equal(native.model,'deepseek-flash');assert.equal(native.provider,'deepseek');assert.equal(native.extensionPath,join(repoRoot,'05-reconstruction/codex/pi/finance-direct.ts'));
    assert.ok(MAIN_TOOLS.includes('tool_search'));assert.ok(!MAIN_TOOLS.some(tool=>tool.includes('harness_')));assert.ok(!MAIN_TOOLS.includes('finance_delegate_parser'));
    const launcher=join(context.outputDir,'start-pi.mjs');
    const help=spawnSync(process.execPath,[launcher,'--help'],{encoding:'utf8',windowsHide:true,timeout:15000});assert.equal(help.status,0,help.stderr);assert.match(help.stdout,/--pi-root/);
    const missing=spawnSync(process.execPath,[launcher,'--check'],{encoding:'utf8',windowsHide:true,timeout:15000});assert.notEqual(missing.status,0);assert.match(missing.stderr,/explicit_pi_package_root_required/);
    assert.throws(()=>buildLaunchSpec(native,context.outputDir,parsePiArgs(['--pi-root',join(root,'not-installed'),'--check'])),/ENOENT/);
    const packageRoot=join(root,'synthetic-pi-package');mkdirSync(join(packageRoot,'dist/bundle'),{recursive:true});writeFileSync(join(packageRoot,'package.json'),JSON.stringify({name:'@earendil-works/pi-coding-agent',version:'1.1.0'}));writeFileSync(join(packageRoot,'dist/bundle/cli.js'),'throw Error("must not run synthetic CLI");');
    const spec=buildLaunchSpec(native,context.outputDir,parsePiArgs(['--pi-root',packageRoot]));assert.equal(spec.env.FINANCE_MCP_PROFILE,'direct');assert.equal(spec.env.FINANCE_DATABASE_PATH,context.databasePath);assert.equal(spec.cwd,context.outputDir);assert.ok(spec.args.includes('builtin:mcp'));assert.ok(spec.args.includes('builtin:tool-search'));assert.ok(spec.args.includes(native.extensionPath));assert.equal(spec.args[spec.args.indexOf('--model')+1],'deepseek-flash');assert.equal(spec.args[spec.args.indexOf('--skill')+1],context.skillsDir);assert.ok(!spec.args.includes('--print'));
    assert.equal(spec.args[spec.args.indexOf('--tools')+1],DEFAULT_TOOL_MODIFIERS.join(','));assert.ok(DEFAULT_TOOL_MODIFIERS.every(value=>value.startsWith('+')||value.startsWith('-')));
    assert.ok(spec.args[spec.args.indexOf('--append-system-prompt')+1].includes(PERIOD_TASK_ROUTING));
    const memoryPath=join(root,'MEMORY.md');writeFileSync(memoryPath,'PRIVATE-SYNTHETIC-MEMORY');
    const boundSpec=buildLaunchSpec(native,context.outputDir,parsePiArgs(['--pi-root',packageRoot]),memoryPath),system=boundSpec.args[boundSpec.args.indexOf('--append-system-prompt')+1];
    assert(system.includes(memoryPath));assert.equal(system.split(BUSINESS_MEMORY_ROUTING).length-1,1);assert(!system.includes('PRIVATE-SYNTHETIC-MEMORY'),'Pi 只传文件路径，由宿主按需读取正文');
    const task=join(root,'synthetic-task.txt');writeFileSync(task,'Synthetic no-model task');const subset=buildLaunchSpec(native,context.outputDir,parsePiArgs(['--pi-root',packageRoot,'--task-file',task,'--tools','read,mcp__finance__finance_rules']));assert.equal(subset.args[subset.args.indexOf('--tools')+1],'read,mcp__finance__finance_rules');
    const check=buildLaunchSpec(native,context.outputDir,parsePiArgs(['--pi-root',packageRoot,'--check']));assert.ok(check.args[0].endsWith('direct-pi-probe.mjs'));assert.equal(check.modelInvoked,false);assert.equal(existsSync(check.env.PI_CODING_AGENT_DIR),false);
  }
}
for(const args of [[],['--pi-root','relative'],['--pi-root',root,'--check','--json'],['--pi-root',root,'--tools','read'],['--pi-root',root,'--task-file','relative.txt'],['--pi-root',root,'--task-file',join(root,'goal.txt'),'--tools','mcp__other__write'],['--pi-root',root,'--task-file',join(root,'goal.txt'),'--tools','mcp__finance__harness_run'],['--pi-root',root,'--bypass']])assert.throws(()=>parsePiArgs(args));
assert.equal(parsePiArgs(['--help'])['--help'],true);
const server=join(repoRoot,'05-reconstruction/codex/mcp/finance-mcp/server.mjs');
for (const profile of [undefined, 'direct']) {
  const client = new McpStdioClient(server, {env: {FINANCE_MCP_PROFILE: profile, FINANCE_QUERY_DISCOVERY: undefined,
    FINANCE_SKILL_DISCOVERY: undefined, FINANCE_SKILLS_DIR: undefined, FINANCE_AUDIT_DIR: join(root, 'records-'+(profile??'default'))}, timeoutMs: 30000}).start();
  try {
    const {result: handshake} = await client.initialize();
    assert.equal(handshake.instructions, FINANCE_MCP_DISCOVERY);
    assert.doesNotMatch(handshake.instructions, /bank_import_preview|voucher_correct/);
    const names = (await client.rpc('tools/list')).result.tools.map(tool => tool.name);
    assert.deepEqual(new Set(names), new Set(directTools.map(tool => tool.name)));
    assert.ok(names.includes('ledger_query'));
    assert.equal(names.some(name => name.startsWith('harness_')), false);
    for (const name of ['harness_discover', 'harness_run', 'synthetic_unknown_tool']) {
      assert.equal((await client.call(name)).isError, true);
    }
    assert.equal((await client.call('finance_rules', {})).isError, false);
    const listed = await client.call('skills_list', {});
    assert.equal(listed.isError, false);
    assert.deepEqual(Object.keys(listed.data.labels).sort(), [...listed.data.files].sort());
    assert.equal(listed.data.files.includes('harness/SKILL.md'), false);
    for (const name of ['tax-period', 'company-baseline']) {
      const resource = `${name}/SKILL.md`;
      const entry = listed.data.entries.find(item => item.resource === resource);
      assert.equal(entry.name, name);
      assert.equal(entry.metadataState, 'valid');
      assert.equal((await client.call('skills_read', {resource})).isError, false);
      assert.ok((await client.rpc('resources/list')).result.resources.some(item => item.uri === 'skill://'+resource));
    }
  } finally { await client.close(); }
}
// 环境变量只能断言同一内置根，不能选用外部、相对或越界目录。
for(const value of [root,'plugins/finance/skills',join(repoRoot,'plugins/finance/../other/skills')]){
 const rejected=spawnSync(process.execPath,[server],{env:{...process.env,FINANCE_MCP_PROFILE:'direct',FINANCE_SKILLS_DIR:value},encoding:'utf8',windowsHide:true,timeout:30000});assert.notEqual(rejected.status,0);assert.match(rejected.stderr,/finance_external_skills_not_supported/);
}
const sameRootClient=new McpStdioClient(server,{env:{FINANCE_MCP_PROFILE:'direct',FINANCE_SKILLS_DIR:join(repoRoot,'plugins/finance/skills'),FINANCE_AUDIT_DIR:join(root,'same-root-records')},timeoutMs:30000}).start();
try{await sameRootClient.initialize();assert.equal((await sameRootClient.call('skills_read',{resource:'tax-review/SKILL.md'})).isError,false);}finally{await sameRootClient.close();}
for (const profile of ['harness', 'legacy', '', 'bad']) {
  const invalid = spawnSync(process.execPath, [server], {env: {...process.env, FINANCE_MCP_PROFILE: profile},
    encoding: 'utf8', timeout: 30000, windowsHide: true});
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /finance_mcp_profile_invalid/);
  assert.equal(invalid.stdout, '');
}
console.log(JSON.stringify({status:'passed',root,modelInvoked:false,checks:['four direct host configurations','native lazy MCP tools and no workflow orchestration','single repository skills and rejected external roots','Claude read-only permissions','retired profiles refused','real stdio business rules and errors','no ledger created']}));
