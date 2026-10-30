// 先检查实际 Pi 加载器、MCP 和 tool-search，再证明实时合成数据库绑定。
await import('./harness-pi-probe.mjs');
const {pathToFileURL}=await import('node:url'),{join,dirname}=await import('node:path');
const {readFileSync}=await import('node:fs'),{default:assert}=await import('node:assert/strict');
const db=process.env.FINANCE_DATABASE_PATH,synthetic=JSON.parse(readFileSync(join(dirname(dirname(db)),'synthetic.json'),'utf8'));
assert.equal(synthetic.version,'finance-harness2-synthetic/1');
const {McpServerConnection,createDefaultTransport}=await import(pathToFileURL(join(process.argv[2],'dist/extensions/mcp/runtime.js')).href);
const connection=new McpServerConnection({entry:{name:'finance',config:{command:process.execPath,args:[join(import.meta.dirname,'../../05-reconstruction/codex/mcp/finance-mcp/server.mjs')],env:{FINANCE_DATABASE_PATH:db,FINANCE_API_BASE:process.env.FINANCE_API_BASE,FINANCE_MCP_PROFILE:'harness'}},source:import.meta.filename,scope:'extension'},cwd:import.meta.dirname,createTransport:createDefaultTransport,onTools:()=>{}});
try{await connection.getClient();const result=await connection.callTool('harness_scope_discover',{},{});assert.notEqual(result.isError,true);const target=result.structuredContent;assert.equal(target.databaseInstanceId,synthetic.scope.databaseInstanceId);assert.equal(target.accountSets.length,1);assert.equal(target.accountSets[0].enterpriseKey,synthetic.scope.enterpriseKey);assert.equal(target.accountSets[0].accountSetId,synthetic.scope.accountSetId);console.log(JSON.stringify({status:'synthetic_binding_verified',host:'pi',modelInvoked:false}));}
finally{await connection.close();}
