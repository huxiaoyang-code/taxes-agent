import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
// 只准新建合成运行目录；评分资料位于业务工作区之外，受测宿主仅接收生成的工作区和原件。
const repo=fileURLToPath(new URL('../../../',import.meta.url));
if(!process.argv[2])throw Error('用法：node seed.mjs <新的合成运行目录> [--keep-backend]');
const root=resolve(process.argv[2]),control=join(root,'reviewer');
mkdirSync(root);mkdirSync(control);
const imp=p=>import(pathToFileURL(join(repo,p)).href);
const {startBackend}=await imp('06-workbench/test/helpers/business-memory-e2e-fixture.mjs');
const {McpStdioClient}=await imp('05-reconstruction/codex/mcp/finance-mcp/mcp-stdio-client.mjs');
const data=join(root,'账库'),source=join(root,'业务资料'),originals=join(source,'客户原件'),register=join(source,'收付登记'),audit=join(root,'业务记录'),host=join(root,'host');
const dbPath=join(data,'workbench.db'),period='2026-10',company='杭州澄禾展陈设计有限公司';
assert(!existsSync(dbPath),'需要全新的运行目录');
for(const dir of [data,originals,register,audit])mkdirSync(dir,{recursive:true});
const alpha='宁波沐川文化传播有限公司',beta='嘉兴予白空间设计有限公司',vendor='杭州枫桥图文制作有限公司';
const bank='100201',a='112201',b='112202',v='220201',tax='2221';
const bankFile=join(originals,'城商银行对公账户十月交易明细.csv'),receipt=join(originals,'电子缴税付款凭证.csv'),working=join(register,'十月收付款登记簿.csv');
const line=(...rows)=>rows.map(r=>r.join(',')).join('\r\n')+'\r\n';
const csv=line(['交易日期','对方户名','收入','支出','交易后余额','上笔余额','交易流水号','摘要'],
 ['2026-10-09',alpha,8150,'',38150,30000,'CS261009061','秋季陈列服务阶段款'],
 ['2026-10-12',beta,12850,'',51000,38150,'CS261012109','展厅深化设计尾款'],
 ['2026-10-14',vendor,'',3200,47800,51000,'CS261014086','支付展板制作款'],
 ['2026-10-20','国家金库杭州中心支库','',960,46840,47800,'CS261020307','电子缴税'],
 ['2026-10-26',alpha,2800,'',49640,46840,'CS261026123','陈列项目余款']);
writeFileSync(bankFile,csv);
writeFileSync(receipt,line(['付款人','税款所属期','税种','征收品目','缴款书编号','扣款时间','入库时间','完税凭证填发日期','实缴金额','收款国库','银行扣款流水'],
 [company,'2026-09','增值税','设计服务','ZJ202610210139','2026-10-20 16:48','2026-10-21 08:43','2026-10-21',960,'国家金库杭州中心支库','CS261020307']));
writeFileSync(join(originals,'十月初往来及货币资金交接表.csv'),line(['基准日','科目','科目名称','借方余额','贷方余额'],
 ['2026-09-30',bank,'城商银行基本户',30000,''],['2026-09-30',a,alpha,18000,''],['2026-09-30',b,beta,16000,''],
 ['2026-09-30',v,vendor,'',6000],['2026-09-30',tax,'应交税费','',960],['2026-09-30','3001','实收资本','',57040]));
const records=[
 ['2026-10-09','收沐川文化秋季陈列服务阶段款',bank,a,6600],
 ['2026-10-12','收予白空间展厅深化设计尾款',bank,b,14400],
 ['2026-10-16','付枫桥图文展板制作款',v,bank,3200],
 ['2026-10-21','依电子缴税付款凭证结清九月增值税',tax,bank,960],
 ['2026-10-26','收沐川文化陈列项目余款',bank,a,2800],
];
writeFileSync(working,line(['记账日期','摘要','借方科目','贷方科目','收付金额'],...records));
const {child,apiBase}=await startBackend({data,dbPath,sourceB:source,auditB:audit});
const sessions=[];
const save=(name,val)=>writeFileSync(join(control,name),JSON.stringify(val,null,2));
const open=async(env)=>{
 const c=new McpStdioClient(join(repo,'05-reconstruction/codex/mcp/finance-mcp/server.mjs'),{cwd:data,env:{...env,WORKBENCH_DATA_DIR:data},timeoutMs:30000}).start();
 sessions.push(c);await c.initialize('bookkeeping-operations');return c;
};
const call=async(c,name,args)=>{const reply=await c.call(name,args);assert(!reply.isError && reply.data?.ok!==false,name+' '+reply.text);return reply.data};
const close=async()=>{await Promise.all(sessions.splice(0).map(c=>c.close()));};
try {
 const setup=await open({FINANCE_MCP_PROFILE:'direct',FINANCE_DATABASE_PATH:dbPath,FINANCE_SOURCE_ROOT:source,FINANCE_AUDIT_DIR:audit,FINANCE_BUSINESS_SESSION:'',FINANCE_API_BASE:apiBase});
 const {accountSetId}=await call(setup,'account_set_create',{enterprise:{enterpriseKey:'CHENHE-DISPLAY-LEDGER'},name:company,start_period:period,accounting_standard:'小企业会计准则'});
 for(const [code,name,category,direction] of [[bank,'城商银行基本户','资产','debit'],[a,alpha,'资产','debit'],[b,beta,'资产','debit'],[v,vendor,'负债','credit']]){
  await call(setup,'account_create',{accountSetId,code,name,category,direction});
 }
 await call(setup,'opening_balance_set',{accountSetId,items:[{code:bank,debit:30000},{code:a,debit:18000},{code:b,debit:16000},{code:v,credit:6000},{code:tax,credit:960},{code:'3001',credit:57040}]});
 const run=(script,...args)=>execFileSync(process.execPath,[script,...args],{cwd:data,encoding:'utf8',windowsHide:true,env:{...process.env,WORKBENCH_DATA_DIR:data}});
 run(join(repo,'06-workbench/scripts/finance-host-config.mjs'),'--host','claude-code','--node',process.execPath,'--api-base',apiBase,'--database',dbPath,'--audit-dir',audit,'--source-root',source,'--out',host,'--voucher-corrections','delegated','--correction-original',bankFile,'--correction-original',receipt);
 run(join(host,'start-business-session.mjs'),'--account-set-id',String(accountSetId),'--period',period,'--prepare-only');
 const formal=await open(JSON.parse(readFileSync(join(host,'.mcp.json'))).mcpServers.finance.env);
 const ids=[];
 for(const [i,[voucher_date,summary,debit,credit,amount]] of records.entries()){
  const mapping=(inputPointer,column)=>({inputPointer,parameterLabel:column,transform:'identity',sources:[{path:working,row:i+2,column,headerRows:[1]}]});
  const businessEvidence={businessLabel:'月度收付登记',method:'按收付款登记簿日期、业务摘要及借贷明细录入',mappings:[mapping('/voucher_date','记账日期'),mapping('/entries/0/debit','收付金额'),mapping('/entries/1/credit','收付金额')]};
  const result=await call(formal,'voucher_create',{accountSetId,period,voucher_date,summary,entries:[{code:debit,debit:amount},{code:credit,credit:amount}],status:'posted',operationId:randomUUID(),businessEvidence});
  assert.equal(result.projection.status,'posted');ids.push(result.projection.voucherId);
 }
 const ledger={};
 for(const code of [bank,a,b,v,tax])ledger[code]=(await call(formal,'ledger_query',{accountSetId,period,code})).projection;
 assert.equal(ledger[bank].closingBalance,49640);assert.equal(ledger[a].closingBalance,8600);assert.equal(ledger[b].closingBalance,1600);
 const db=new DatabaseSync(dbPath,{readOnly:true});
 const vouchers=db.prepare('SELECT * FROM vouchers WHERE account_set_id=? ORDER BY id').all(accountSetId);
 const entries=db.prepare('SELECT e.* FROM voucher_entries e JOIN vouchers v ON v.id=e.voucher_id WHERE v.account_set_id=? ORDER BY voucher_id,line_no').all(accountSetId);
 save('baseline.json',{accountSetId,vouchers,entries,ledger});
 await db.close();
 save('gold.json',{accountSetId,period,ids,handoffReferences:[{id:'CS261020307',disposition:'explained'}],expected:records.map(([date,summary,debit,credit,amount],i)=>({id:ids[i],date:i===2?'2026-10-14':date,summary,debit,credit,amount:[8150,12850,3200,960,2800][i],correct:i<3})),closing:{[bank]:49640,[a]:7050,[b]:3150,[v]:2800,[tax]:0},originalSHA256:createHash('sha256').update(csv).digest('hex')});
 await close();
 const ready={pid:child.pid,controllerPid:process.pid,apiBase,accountSetId,company,period,host,source,originals,dbPath,audit,ids,stopSignal:join(control,'stop-backend.flag')};
 save('fixture-ready.json',ready);console.log(JSON.stringify(ready));
 if(process.argv.includes('--keep-backend')){
 const timer=setInterval(()=>{if(existsSync(ready.stopSignal))child.kill();},750);
 await new Promise(resolve=>child.once('exit',resolve));clearInterval(timer);
 }
} finally {await close();child.kill();}
