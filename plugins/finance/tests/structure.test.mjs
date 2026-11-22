import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync,mkdtempSync,existsSync} from 'node:fs';
import {resolve,dirname,relative,join,isAbsolute,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
const finance=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const repo=resolve(finance,'../..'),skills=join(finance,'skills');
const read=p=>readFileSync(p,'utf8');
const walk=dir=>readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(join(dir,e.name)):[join(dir,e.name)]);
const skillFiles=walk(skills).filter(p=>p.endsWith(`${sep}SKILL.md`));
const markdown=walk(skills).filter(p=>p.endsWith('.md'));
const backend=repo;
const expected=['audit-support','close-management','company-baseline','financial-statements','internal-control-review','journal-entry','journal-entry-prep','prebook-review','reconciliation','tax-period','tax-review','variance-analysis'];
const localLinks=p=>[...read(p).matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].map(m=>m[1]).filter(x=>!/^https?:|^mailto:|^#/.test(x)).map(x=>resolve(dirname(p),x.split('#')[0]));

test('既有财税与整期入口可发现，名称匹配实际frontmatter',()=>{
 const names=skillFiles.map(p=>{const s=read(p),m=s.match(/^---\r?\n([\s\S]*?)\r?\n---/);assert.ok(m,`frontmatter ${p}`);const name=m[1].match(/^name:\s*(.+)$/m)?.[1];assert.equal(name,dirname(p).split(sep).at(-1));assert.ok(m[1].match(/^description:\s*\S.+$/m));assert.ok(s.includes('报告顺序')||s.includes('报告'));assert.ok(!/harness_(?:source_register|facts_register|plan|run|status)/.test(s));return name;});
 assert.deepEqual(names.sort(),expected);
 for(const name of ['audit-support','close-management','journal-entry-prep'])assert.match(read(join(skills,name,'SKILL.md')),/user-invocable: false/);
 assert.ok(!existsSync(join(skills,'sox-testing','SKILL.md')));
});

test('business references resolve inside MCP skills root; root attribution is human metadata only',()=>{
 for(const p of markdown)for(const target of localLinks(p)){
  assert.ok(existsSync(target),`${relative(finance,p)} -> ${target}`);
  const rel=relative(skills,target);
  assert.ok(!rel.startsWith('..')&&!isAbsolute(rel)||['SOURCES.md','LICENSE'].includes(relative(finance,target)),`business reference escapes skills root: ${p} -> ${target}`);
 }
 for(const name of ['journal-support','reconciliation-methods','financial-controls','variance-methods','control-testing-methods'])assert.ok(existsSync(join(skills,'shared','references',`${name}.md`)));
});

test('plugin configuration targets the real local direct server with explicit backend port and account/audit paths',()=>{
 const config=JSON.parse(read(join(finance,'.mcp.json'))),servers=Object.entries(config.mcpServers);assert.equal(servers.length,1);
 const [name,s]=servers[0];assert.equal(name,'finance');assert.equal(s.command,'node');assert.deepEqual(s.args,['${TAXES_AGENT_ROOT}/05-reconstruction/codex/mcp/finance-mcp/server.mjs']);
 assert.equal(s.env.FINANCE_MCP_PROFILE,'direct');assert.equal(Object.hasOwn(s.env,'FINANCE_SKILLS_DIR'),false);
 for(const key of ['FINANCE_API_BASE','FINANCE_DATABASE_PATH','FINANCE_AUDIT_DIR'])assert.equal(s.env[key],`\${${key}}`);
 assert.ok(!JSON.stringify(config).includes('"url":""'));
 const manifest=JSON.parse(read(join(finance,'.claude-plugin/plugin.json'))),market=JSON.parse(read(join(repo,'.claude-plugin/marketplace.json')));
 assert.equal(manifest.name,'finance');assert.notEqual(manifest.author.name,'Anthropic');assert.equal(market.name,'taxes-agent');assert.equal(market.plugins.length,1);assert.equal(market.owner.name,'huxiaoyang-code');assert.equal(market.plugins.find(p=>p.name==='finance').source,'./plugins/finance');
});

test('human reporting order and full deep evidence are both explicit',()=>{
 const text=read(join(skills,'shared','references','reporting.md'));
 const parts=['账本金额','凭证与计算结果','规则依据','工具调用','输入与原件'];
 const positions=parts.map(x=>text.indexOf(x));assert.ok(positions.every(x=>x>=0));assert.deepEqual([...positions].sort((a,b)=>a-b),positions);
 assert.match(text,/完整记录不可/);assert.match(text,/未知/);assert.match(text,/不等于|不能保证/);
 const close=read(join(skills,'close-management','SKILL.md'));assert.match(close,/T\+1/);assert.match(close,/T\+5/);assert.match(close,/不转化为运行时 DAG/);
 const internal=read(join(skills,'internal-control-review','SKILL.md'));assert.match(internal,/不将 SOX404/);
});

test('上游许可原文与迁入来源完整，普通clone无需旧仓库Git对象',()=>{
 const license=read(join(finance,'LICENSE')).replaceAll('\r\n','\n');
 assert.match(license,/Apache License/);
 assert.equal(createHash('sha256').update(license).digest('hex'),'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30');
 const sources=read(join(finance,'SOURCES.md'));
 for(const sha of ['2574e29377c7173d0cecffef29a6ecbd7f8ccb5d','de879f81f2963547b5d92fc6d4d9db1b4487ea08','f8b0ea50bf0aa9318d2efe8abfab16a1a330ae24'])assert.ok(sources.includes(sha));
 assert.ok(sources.includes('84d8efdb6e80e2b26898e5c3109d13eddde97761'));
 assert.match(sources,/2026-10-30修改/);assert.match(sources,/huxiaoyang-code\/taxes-agent/);
 const organizerLicense=read(join(finance,'LICENSE.knowledge-work-plugins')).replaceAll('\r\n','\n');
 assert.equal(createHash('sha256').update(organizerLicense).digest('hex'),'a6946284993aeec75c7d75906064b66210c46051e562077efb30eb6dcfe72e26');
 for(const sha of ['486da32be7ea606e30b6901134efacc62c1c3ed2','0e0fcacddcc892eb92a1b7873ff9d68159c47571'])assert.ok(sources.includes(sha));
 const migration=sources.slice(sources.indexOf('## 2026-11-21 三项工作流及文件归属'));
 for(const file of ['skills/portfolio-rebalance-review/SKILL.md','templates/drift-analysis.md','templates/rebalance-rationale-memo.md','agents/holdings-sanity.md','skills/alts-brief/SKILL.md','agents/source-extract.md','tax-season-organizer/SKILL.md','tax-prep/SKILL.md','reference/calculation-assumptions.md','reference/connector-queries.md','reference/output-formats.md','reference/gotchas.md','reference/examples/quarterly-estimate.md','reference/examples/year-end-1099.md']){
  const mapping=migration.split('\n').find(line=>line.startsWith('|')&&line.includes(file));
  assert.ok(mapping,'缺少上游文件归属 '+file);
  const destination=mapping.match(/\]\((skills\/[^)]+)\)/)?.[1];
  assert.ok(destination&&existsSync(join(finance,destination)),'缺少本地改编正文 '+file);
 }
});

test('账前合成资料经真实MCP完成问询、回复、补件重算与两类纳税人测算', {timeout:60000},async()=>{
 const {runPrebookDemo}=await import('../skills/prebook-review/scripts/demo.mjs');
 const scratch=mkdtempSync(join(tmpdir(),'finance-cn-prebook-demo-'));
 const {runs}=await runPrebookDemo(join(scratch,'synthetic-run'));
 assert.equal(runs.length,4);
 const [missing,statement,supplemented,small]=runs;
 assert.equal(missing.projection.status,'needs_inputs');
 assert.ok(missing.result.issues.some(issue=>issue.code==='purchase_invoice_missing'));
 assert.equal(statement.projection.responses.recorded,1);
 assert.equal(statement.projection.status,'needs_inputs','老板说明不能替代发票证据');
 assert.notEqual(supplemented.projection.inputDigest,missing.projection.inputDigest);
 assert.equal(supplemented.projection.responses.stale,1);
 assert.equal(supplemented.projection.status,'ready_for_bookkeeping_review');
 assert.equal(supplemented.projection.tax.status,'conditional_calculated');
 // 独立手算：销项1300－进项650－上期留抵100=550；期初10000+收11300－付5650=15650。
 assert.equal(supplemented.projection.tax.amounts.due,550);
 assert.equal(supplemented.result.funds[0].calculatedClosing,'15650.00');
 assert.equal(supplemented.result.funds[0].difference,'0.00');
 // 小规模合成普通销售40万元超过该季度阈值，已声明减征条件：40万×1%=4000。
 assert.equal(small.projection.status,'ready_for_bookkeeping_review');
 assert.equal(small.projection.tax.amounts.due,4000);
 assert.equal(small.projection.taxpayerType,'small');
 for(const run of runs){
  assert.equal(run.projection.review.posted,false);
  assert.equal(run.projection.review.submittable,false);
  const handoff=JSON.parse(read(join(run.directory,'handoff.json')));
  assert.equal(handoff.inputDigest,run.projection.inputDigest);
  assert.ok(handoff.sourceRefs.length>0);
  assert.ok(handoff.sourceRefs.some(ref=>ref.sourceType==='agent_observation'&&ref.locator?.row===2&&ref.locator?.column===3),'宿主提交实际中文CSV金额列及原物理行');
  const prepared=JSON.parse(read(run.inputPath));
  assert.ok(prepared.bindings.some(binding=>binding.locator?.column===2&&binding.valueMap?.收入==='inflow'),'原始中文枚举采用明确映射');
  assert.equal(prepared.bindings.some(binding=>/^\/bankTransactions\/\d+\/id$/.test(binding.inputPointer)),false,'内部ID不要求客户原件提供');
  assert.equal(existsSync(run.reviewPath),true);
  const projection=JSON.stringify(run.projection);
  for(const privateText of ['demo-supplier','demo-customer','合成演示老板','发票稍后补交'])assert.equal(projection.includes(privateText),false);
 }
 const contract=JSON.parse(read(join(scratch,'synthetic-run','实际输入合同.json')));
 assert.equal(contract.recordType,'prebook');
 assert.equal(contract.tool,'finance_prebook_review');
 assert.equal(existsSync(join(scratch,'synthetic-run','未打开账库.db')),false);
});

test('Chinese obligation guide matches all current native tax tools and limits',async()=>{
 const {DIRECT_TOOLS}=await import(pathToFileURL(join(backend,'05-reconstruction/codex/mcp/finance-mcp/direct-tools.mjs')));
 const ids=DIRECT_TOOLS.find(t=>t.name==='finance_tax_calculate').inputSchema.properties.obligationIds.items.enum;
 const doc=read(join(skills,'tax-review','references','supported-obligations.md'));
 const documented=[...doc.matchAll(/^\| ([a-z_]+) \|/gm)].map(m=>m[1]);assert.deepEqual(documented,ids);assert.equal(ids.length,29);
 assert.match(doc,/有限固定分支/);assert.match(doc,/不能自动用于福建漳州/);
 const {TOOLS}=await import(pathToFileURL(join(backend,'05-reconstruction/codex/mcp/finance-mcp/tools.mjs')));
 const known=new Set(TOOLS.map(t=>t.name));
 for(const p of markdown)for(const m of read(p).matchAll(/`(finance_[a-z_]+|account_context|ledger_query|voucher_check|voucher_create|asset_create|depreciation_run|book_import_incremental|book_import_batch)`/g))assert.ok(known.has(m[1]),`${p} references unknown tool ${m[1]}`);
});

test('documented fixed-card example is accepted by the discoverable optional MCP contract',async()=>{
 const {DIRECT_TOOLS}=await import(pathToFileURL(join(backend,'05-reconstruction/codex/mcp/finance-mcp/direct-tools.mjs')));
 const {validateSchemaValue}=await import(pathToFileURL(join(backend,'06-workbench/server/harness-schema-validation.mjs')));
 const schema=DIRECT_TOOLS.find(t=>t.name==='finance_calculation_run').inputSchema;
 const reference=read(join(skills,'shared','references','connectors.md'));
 const example=JSON.parse(reference.match(/```json\s*([\s\S]*?)```/)[1]);
 assert.ok(schema.properties.reviewCard,'the optional output contract must be discoverable through direct MCP');
 assert.ok(!schema.required.includes('reviewCard'),'fixed presentation must not become a prerequisite for calculation');
 assert.deepEqual(validateSchemaValue(schema.properties.reviewCard,example.reviewCard),[],'the exact documented example must match the backend');
 for(const field of ['bankSourceIndex','findingsSourceIndex','cashSourceIndex'])assert.deepEqual(validateSchemaValue(schema.properties.reviewCard,{...example.reviewCard,[field]:2}),[],field);
});

test('基线生成与本期计算示例符合真实合同，入口可由业务技能发现',async()=>{
 const {DIRECT_TOOLS}=await import(pathToFileURL(join(backend,'05-reconstruction/codex/mcp/finance-mcp/direct-tools.mjs')));
 const {validateSchemaValue}=await import(pathToFileURL(join(backend,'06-workbench/server/harness-schema-validation.mjs')));
 const reference=read(join(skills,'company-baseline/references/materials-and-save.md'));
 const examples=[...reference.matchAll(/```json\s*([\s\S]*?)```/g)].map(match=>JSON.parse(match[1]));
 const schema=DIRECT_TOOLS.find(t=>t.name==='finance_baseline_materials')?.inputSchema;
 assert.ok(schema,'真实材料工具须可发现，不能只写生成说明');
 assert(examples.some(example=>typeof example.inputPath==='string'&&(example.section??'overview')==='overview'),'首次生成须提交实际宿主整理件');
 assert(examples.some(example=>example.section==='calculation'),'已有基线须有安全计算结构入口');
 for(const example of examples)assert.deepEqual(validateSchemaValue(schema,example),[]);
 for(const name of ['tax-period','journal-entry','tax-review'])assert.ok(localLinks(join(skills,name,'SKILL.md')).includes(join(skills,'company-baseline','SKILL.md')),name+'缺少真实生成入口');
});

test('every business document is actually readable through restricted MCP skills_read', {timeout:30000},async()=>{
 const {McpStdioClient}=await import(pathToFileURL(join(backend,'05-reconstruction/codex/mcp/finance-mcp/mcp-stdio-client.mjs')));
 const scratch=mkdtempSync(join(tmpdir(),'finance-cn-skills-'));
 const client=new McpStdioClient(join(backend,'05-reconstruction/codex/mcp/finance-mcp/server.mjs'),{cwd:backend,env:{FINANCE_MCP_PROFILE:'direct',FINANCE_SKILLS_DIR:undefined,FINANCE_AUDIT_DIR:join(scratch,'audit'),FINANCE_DATABASE_PATH:join(scratch,'not-opened.db'),FINANCE_API_BASE:'http://127.0.0.1:1'},timeoutMs:10000}).start();
 try{
  await client.initialize('finance-cn-skill-reference-test');
  const listed=await client.call('skills_list',{});assert.deepEqual(listed.data.files.sort(),markdown.map(p=>relative(skills,p).replaceAll('\\','/')).sort());assert.deepEqual(Object.keys(listed.data.labels).sort(),listed.data.files);
  assert.deepEqual(listed.data.entries.map(e=>e.resource).sort(),expected.map(name=>name+'/SKILL.md').sort());
  for(const entry of listed.data.entries){
   const content=read(join(skills,entry.resource)),frontmatter=content.match(/^---\r?\n([\s\S]*?)\r?\n---/)[1];
   assert.equal(entry.metadataState,'valid');assert.equal(entry.name,frontmatter.match(/^name:\s*(.+)$/m)[1]);assert.equal(entry.description,frontmatter.match(/^description:\s*(.+)$/m)[1]);
  }
  const entries = new Map(listed.data.entries.map(entry => [entry.name, entry]));
  const main = listed.data.entries.filter(entry => entry.role === 'primary');
  assert.equal(main.length, 9);
  for (const [task, support] of [
   ['journal-entry', 'journal-entry-prep'], ['internal-control-review', 'audit-support'], ['tax-period', 'close-management'],
  ]) {
   const entry = entries.get(task), ref = entries.get(support);
   assert.equal(entry.role, 'primary');
   assert.equal(ref.role, 'reference');
   assert.ok(entry.description.includes(support));
   const page = (await client.call('skills_read', {resource:entry.resource})).data.markdown;
   assert.ok(page.includes('](../' + ref.resource + ')'));
  }
  const reconcile = entries.get('reconciliation');
  assert.match(reconcile.description, /原件.*逐笔对账/);
  assert.match(reconcile.description, /导入银行 CSV.*匹配流水/);
  const guide = (await client.call('skills_read', {resource:reconcile.resource})).data.markdown;
  const tools = (await client.rpc('tools/list')).result.tools;
  for (const name of ['bank_import_preview','bank_import','bank_candidates','bank_confirm','bank_reconcile']) {
   assert.ok(guide.includes('`' + name + '`'));
   assert.deepEqual(tools.find(tool => tool.name === name).inputSchema.required, ['accountSetId','draftRef']);
  }
  const period=listed.data.entries.find(entry=>entry.name==='tax-period');
  assert.match(period.description,/做完本月账/);
  const workflows=['vat-planning','tax-cash-brief','tax-organizer'];
  for(const entry of ['tax-period','tax-review','prebook-review']){
   const page=(await client.call('skills_read',{resource:entry+'/SKILL.md'})).data.markdown;
   for(const workflow of workflows)assert.ok(page.includes('references/'+workflow+'.md'),entry+'缺少 '+workflow+' 的正常入口');
  }
  assert.equal(Object.keys(listed.data.labels).some(p=>p.startsWith('harness/')),false);
  for(const p of markdown){const resource=relative(skills,p).replaceAll('\\','/'),r=await client.call('skills_read',{resource});assert.equal(r.isError,false,`${resource}: ${r.text}`);assert.equal(r.data?.markdown,read(p),`${resource} did not return actual document`);}
  const blocked=await client.call('skills_read',{resource:'../../finance/.mcp.json'});assert.equal(blocked.isError,true,'file boundary must remain restricted');
 }finally{await client.close();}
});


test('仓库内专用技能在显式legacy工具面可读，仍引用现有业务合同', {timeout:30000},async()=>{
 const root=join(backend,'05-reconstruction/codex/skills'),docs=walk(root).filter(p=>p.endsWith('.md'));
 const entry=docs.filter(p=>p.endsWith(`${sep}SKILL.md`));assert.equal(entry.length,8);
 for(const p of docs){
  assert.ok(!/`harness_(?:source_register|facts_register|plan|run|status|init|feedback|receipt_read)/.test(read(p)),`legacy orchestration instruction: ${p}`);
  assert.ok(!read(p).includes('TODO：补全规则正文'),`unfinished historical rule: ${p}`);
  for(const target of localLinks(p))assert.ok(existsSync(target),`${p} -> ${target}`);
 }
 const {McpStdioClient}=await import(pathToFileURL(join(backend,'05-reconstruction/codex/mcp/finance-mcp/mcp-stdio-client.mjs')));
 const scratch=mkdtempSync(join(tmpdir(),'finance-cn-legacy-skills-'));
 const client=new McpStdioClient(join(backend,'05-reconstruction/codex/mcp/finance-mcp/server.mjs'),{cwd:backend,env:{FINANCE_MCP_PROFILE:'legacy',FINANCE_SKILLS_DIR:undefined,FINANCE_AUDIT_DIR:join(scratch,'audit'),FINANCE_DATABASE_PATH:join(scratch,'not-opened.db'),FINANCE_API_BASE:'http://127.0.0.1:1'},timeoutMs:10000}).start();
 const sharedResources={
  'taxes-company-advisor/references/planning-cash.md':'tax-review/references/planning-cash.md',
  'tax-filing/references/summary-calculation.md':'tax-review/references/summary-calculation.md',
  'tax-filing/references/supported-obligations.md':'tax-review/references/supported-obligations.md'
 };
 try{
  await client.initialize('finance-cn-legacy-reference-test');
  const listed = (await client.call('skills_list', {})).data;
  assert.deepEqual(listed.entries.map(item => item.resource).sort(), entry.map(p => relative(root,p).replaceAll('\\','/')).sort());
  assert.ok(listed.entries.every(item => !Object.hasOwn(item,'role')));
  for(const p of docs){
   const resource=relative(root,p).replaceAll('\\','/'),r=await client.call('skills_read',{resource});
   assert.equal(r.isError,false,`${resource}: ${r.text}`);
   assert.equal(r.data?.markdown,read(sharedResources[resource]?join(skills,sharedResources[resource]):p),resource);
  }
 }
 finally{await client.close();}
});
