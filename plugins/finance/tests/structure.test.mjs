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
const expected=['audit-support','close-management','financial-statements','internal-control-review','journal-entry','journal-entry-prep','reconciliation','tax-review','variance-analysis'];
const localLinks=p=>[...read(p).matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].map(m=>m[1]).filter(x=>!/^https?:|^mailto:|^#/.test(x)).map(x=>resolve(dirname(p),x.split('#')[0]));

test('all upstream finance roles and Chinese tax review remain discoverable with matching frontmatter',()=>{
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
 assert.match(sources,/2026-10-30修改/);assert.match(sources,/huxiaoyang-code\/taxes-agent/);
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

test('every business document is actually readable through restricted MCP skills_read', {timeout:30000},async()=>{
 const {McpStdioClient}=await import(pathToFileURL(join(backend,'05-reconstruction/codex/mcp/finance-mcp/mcp-stdio-client.mjs')));
 const scratch=mkdtempSync(join(tmpdir(),'finance-cn-skills-'));
 const client=new McpStdioClient(join(backend,'05-reconstruction/codex/mcp/finance-mcp/server.mjs'),{cwd:backend,env:{FINANCE_MCP_PROFILE:'direct',FINANCE_SKILLS_DIR:undefined,FINANCE_AUDIT_DIR:join(scratch,'audit'),FINANCE_DATABASE_PATH:join(scratch,'not-opened.db'),FINANCE_API_BASE:'http://127.0.0.1:1'},timeoutMs:10000}).start();
 try{
  await client.initialize('finance-cn-skill-reference-test');
  const listed=await client.call('skills_list',{});assert.deepEqual(listed.data.files.sort(),markdown.map(p=>relative(skills,p).replaceAll('\\','/')).sort());assert.deepEqual(Object.keys(listed.data.labels).sort(),listed.data.files);
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
 try{await client.initialize('finance-cn-legacy-reference-test');for(const p of docs){const resource=relative(root,p).replaceAll('\\','/'),r=await client.call('skills_read',{resource});assert.equal(r.isError,false,`${resource}: ${r.text}`);assert.equal(r.data?.markdown,read(p));}}
 finally{await client.close();}
});
