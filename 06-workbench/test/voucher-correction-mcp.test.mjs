// 原始流水、错误抄录和预期账簿分别构造。仅使用合成数据，经过生成的宿主、真实 stdio 和 SQLite。
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {McpStdioClient} from '../../05-reconstruction/codex/mcp/finance-mcp/mcp-stdio-client.mjs';
import {REPO_ROOT, startBackend} from './helpers/business-memory-e2e-fixture.mjs';
import {syntheticVoucherEvidence} from './helpers/synthetic-posting-evidence.mjs';

const period = '2026-02';
const bank = '100201', alpha = '112201', beta = '112202', supplier = '220201';
const csv = [
  '日期,对方户名,收入,支出,余额,上笔余额',
  '2026-02-03,合成客户甲,300,,2300,2000',
  '2026-02-04,合成客户乙,700,,3000,2300',
  '2026-02-09,合成客户甲,35,,3035,3000',
  '2026-02-15,合成供应商丙,,500,2535,3035',
  '2026-02-19,合成客户甲,160,,2695,2535',
  '2026-02-19,合成客户乙,14,,2709,2695',
  '2026-02-20,合成税库,,10,2699,2709',
].join('\n');
const income = (amount, counter) => [{code:bank, debit:amount}, {code:counter, credit:amount}];
const payment = (amount, counter) => [{code:counter, debit:amount}, {code:bank, credit:amount}];
const entriesOf = (rows) => rows.map(({code,debit,credit}) => [code,debit,credit]);

async function connect(env) {
  const server = join(REPO_ROOT,'05-reconstruction/codex/mcp/finance-mcp/server.mjs');
  const client = new McpStdioClient(server,{env, cwd:REPO_ROOT, timeoutMs:20000}).start();
  await client.initialize('synthetic-bookkeeping-correction');
  return client;
}

async function success(client,name,args) {
  const reply = await client.call(name,args);
  assert.equal(reply.isError,false,reply.text);
  assert.notEqual(reply.data?.ok,false,reply.text);
  return reply.data;
}

async function rejected(client,args,expectedError) {
  const result = await client.call('voucher_correct',args);
  assert.ok(result.isError || result.data?.ok === false, '错误的更正竟然成功：'+result.text);
  assert.notEqual(result.data?.applied,true,result.text);
  if(expectedError) assert.match(result.text,expectedError);
  return result.structured;
}

function voucherSnapshot(db,id) {
  const row = db.prepare('SELECT voucher_date,status FROM vouchers WHERE id=?').get(id);
  return {date:row.voucher_date, status:row.status,
    entries:entriesOf(db.prepare('SELECT code,debit,credit FROM voucher_entries WHERE voucher_id=? ORDER BY line_no').all(id))};
}

function originalProof(path,lines) {
  return {kind:'bank_statement', path, sha256:createHash('sha256').update(csv).digest('hex'),
    columns:{date:'日期',party:'对方户名',inflow:'收入',outflow:'支出',balance:'余额',priorBalance:'上笔余额'},
    lines:lines.map(([row,counterCode])=>({row,bankCode:bank,counterCode}))};
}

function bankEvidence(path,row,dateFieldEntries) {
  const cell=(line,column)=>({path,row:line,column,headerRows:[1]});
  const mapping=(inputPointer,sources)=>({inputPointer,parameterLabel:'银行原件字段',
    transform:sources.length>1?'sum':'identity',sources});
  return {businessLabel:'合成银行逐笔核对',method:'按银行原始交易日和对方明细核对',
    mappings:[mapping('/voucher_date',[cell(row,'日期')]),...dateFieldEntries.map(([pointer,field,...lines])=>
      mapping(pointer,lines.map(line=>cell(line,field))))]};
}

function workspace(root,name,dbPath,source,apiBase,accountSetId,delegated) {
  const output=join(root,name);
  const run=(script,...args)=>execFileSync(process.execPath,[script,...args],{cwd:root,encoding:'utf8',windowsHide:true});
  run(join(REPO_ROOT,'06-workbench/scripts/finance-host-config.mjs'),'--host','claude-code','--node',process.execPath,
    '--api-base',apiBase,'--database',dbPath,'--source-root',source,'--out',output,
    ...(delegated?['--voucher-corrections','delegated','--correction-original',join(source,'银行原始明细.csv')]:[]));
  run(join(output,'start-business-session.mjs'),'--account-set-id',String(accountSetId),'--period',period,'--prepare-only');
  const read=(path)=>JSON.parse(readFileSync(join(output,path),'utf8'));
  const permissions=read('.claude/settings.json').permissions;
  assert.equal(permissions.allow.includes('mcp__finance__voucher_correct'),delegated);
  assert.equal(existsSync(join(output,'outputs')),delegated);
  for(const rule of ['Edit(/outputs/*.csv)','Edit(/outputs/*.md)']) assert.equal(permissions.allow.includes(rule),delegated);
  for(const guarded of ['voucher_unpost','voucher_delete']) assert.ok(permissions.ask.includes('mcp__finance__'+guarded));
  return read('.mcp.json').mcpServers.finance.env;
}

test('整期委托自动更正五张流水凭证，保留正常清算时差，核验余额相同但客户明细有差异的账簿',async t=>{
  const root=mkdtempSync(join(tmpdir(),'voucher-correction-')), dbPath=join(root,'workbench.db');
  const source=join(root,'originals'), auditDir=join(root,'audit');
  mkdirSync(source); mkdirSync(auditDir);
  const statement=join(source,'银行原始明细.csv');writeFileSync(statement,csv);
  const {child,apiBase}=await startBackend({data:root,dbPath,sourceB:source,auditB:auditDir});
  t.after(()=>child.kill());
  const clients=[];
  async function open(env){const client=await connect(env);clients.push(client);return client;}
  t.after(async()=>{await Promise.all(clients.map(client=>client.close()));});
  const setup=await open({FINANCE_MCP_PROFILE:'direct',FINANCE_DATABASE_PATH:dbPath,FINANCE_SOURCE_ROOT:source,
    FINANCE_AUDIT_DIR:auditDir,FINANCE_BUSINESS_SESSION:'',FINANCE_API_BASE:apiBase});
  const {accountSetId}=await success(setup,'account_set_create',{enterprise:{enterpriseKey:'SYNTH-CORRECTION'},
    name:'合成收付企业',start_period:'2026-01'});
  const other=await success(setup,'account_set_create',{enterprise:{enterpriseKey:'SYNTH-CORRECTION-OTHER'},
    name:'其他合成企业',start_period:'2026-01'});
  for(const [code,name,category,direction] of [[bank,'合成银行','资产','debit'],[alpha,'合成客户甲','资产','debit'],
    [beta,'合成客户乙','资产','debit'],[supplier,'合成供应商丙','负债','credit']]){
    await success(setup,'account_create',{accountSetId,code,name,category,direction});
  }
  // 各期合并余额原已相等，错误只在单笔日期、分户明细和预收分类上。
  const wrong=[
    ['03',income(260,alpha)], ['04',income(740,beta)], ['10',income(35,alpha)], ['14',payment(500,supplier)],
    ['19',[{code:bank,debit:174},{code:alpha,credit:140},{code:beta,credit:14},{code:'2203',credit:20}]],
    ['21',payment(10,'2221')],
  ].map(([day,entries])=>syntheticVoucherEvidence({accountSetId,period,voucher_date:period+'-'+day,
    summary:'合成记账凭证',entries,status:'posted',operationId:randomUUID()},source));
  const delegatedEnv=workspace(root,'bookkeeping',dbPath,source,apiBase,accountSetId,true);
  const formal=await open(delegatedEnv);
  const preview=await open(workspace(root,'preview',dbPath,source,apiBase,accountSetId,false));
  const ids=[];
  for(const args of wrong){const posted=await success(formal,'voucher_create',args);assert.equal(posted.projection.status,'posted');ids.push(posted.projection.voucherId);}
  const db=new DatabaseSync(dbPath);t.after(()=>db.close());
  const drafts=db.prepare("SELECT count(*) n FROM vouchers WHERE account_set_id=? AND status='draft'");
  const ledger=db.prepare("SELECT round(sum(debit-credit),2) net FROM voucher_entries e JOIN vouchers v ON e.voucher_id=v.id WHERE account_set_id=? AND period=? AND status='posted' AND e.code=?");
  const net=(code)=>ledger.get(accountSetId,period,code).net??0;
  const tax=voucherSnapshot(db,ids[5]);
  assert.equal(net(bank),699); assert.deepEqual([net(alpha),net(beta),net('2203')],[-435,-754,-20]);

  const single=(index,day,amount,code,row,outgoing=false)=>{
    const field=outgoing?'支出':'收入';
    return {index,day,entries:outgoing?payment(amount,code):income(amount,code),
      lines:[[row,code]],evidence:bankEvidence(statement,row,[['/entries/0/debit',field,row],['/entries/1/credit',field,row]])};
  };
  const changes=[
    single(0,'03',300,alpha,2),single(1,'04',700,beta,3),single(2,'09',35,alpha,4),single(3,'15',500,supplier,5,true),
    {index:4,day:'19',entries:[{code:bank,debit:174},{code:alpha,credit:160},{code:beta,credit:14}],
      lines:[[6,alpha],[7,beta]],evidence:bankEvidence(statement,6,[
        ['/entries/0/debit','收入',6,7],['/entries/1/credit','收入',6],['/entries/2/credit','收入',7]])},
  ];
  const target=(index)=>({accountSetId,period,voucherId:ids[index]});
  async function request(change) {
    const scope=target(change.index);
    const inspection=await success(formal,'voucher_correct',{...scope,action:'inspect'});
    const fingerprint=(inspection.projection??inspection).fingerprint;
    assert.match(fingerprint,/^[0-9a-f]{64}$/);
    return {...scope,action:'apply',expectedFingerprint:fingerprint,operationId:randomUUID(),
      voucher_date:period+'-'+change.day,summary:'逐笔核实合成流水',entries:change.entries,
      businessEvidence:change.evidence,proof:originalProof(statement,change.lines)};
  }
  const plan=await Promise.all(changes.map(request));

  await t.test('原件金额映射指错行时给出普通入账核对步骤，保留原分录',async()=>{
    const before=voucherSnapshot(db,ids[0]);
    const args=structuredClone(plan[0]);
    args.operationId=randomUUID();
    args.businessEvidence.mappings[1].sources[0].row=3;
    const {error,details}=await rejected(formal,args);
    assert.equal(error,'finance_correction_posting_correction_required');
    assert.deepEqual(details.nextSteps.map(step=>step.code),['verify_correction_posting_evidence']);
    assert.match(details.nextSteps[0].hint,/businessEvidence/);
    assert.deepEqual(voucherSnapshot(db,ids[0]),before);
  });

  await t.test('未委托、跨账套、跨期间、篡改来源或转用另一方收款行不写账',async()=>{
    const args=plan[0],before=voucherSnapshot(db,ids[0]);
    const denied=await rejected(preview,args);
    assert.equal(denied.details?.nextSteps,undefined);
    await rejected(formal,{...args,accountSetId:other.accountSetId});
    await rejected(formal,{...args,period:'2026-01'});
    await rejected(formal,{...args,operationId:randomUUID(),proof:{...args.proof,sha256:'0'.repeat(64)}});
    await rejected(formal,{...args,operationId:randomUUID(),proof:originalProof(statement,[[3,alpha]])});
    const transcript=join(source,'后来取得的抄录.csv');
    writeFileSync(transcript,csv);
    await rejected(formal,{...args,operationId:randomUUID(),proof:originalProof(transcript,[[2,alpha]])});
    assert.deepEqual(voucherSnapshot(db,ids[0]),before);
  });
  await t.test('不能接管本机操作员从普通账本 API 创建的已过账凭证',async()=>{
    const input=syntheticVoucherEvidence({period,voucher_date:period+'-12',summary:'合成操作员原账',
      status:'posted',entries:[{code:'1001',debit:20},{code:'5001',credit:20}]},source);
    const response=await fetch(apiBase+'/api/account-sets/'+accountSetId+'/vouchers',{
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});
    const human=await response.json();
    assert.equal(response.status,201,JSON.stringify(human));assert.equal(human.status,'posted');
    await rejected(formal,{accountSetId,period,voucherId:human.id,action:'inspect'},/voucher_correction_not_agent_owned/);
    assert.equal(voucherSnapshot(db,human.id).status,'posted');
  });
  await t.test('单张写入中段失败时原凭证、明细、正式账和草稿计数均原样保留',async()=>{
    const before=voucherSnapshot(db,ids[0]);
    db.exec("CREATE TRIGGER synthetic_correction_failure BEFORE INSERT ON voucher_entries WHEN NEW.code='112201' AND NEW.credit=300 BEGIN SELECT RAISE(ABORT,'synthetic_mid_write_failure'); END");
    try{await rejected(formal,{...plan[0],operationId:randomUUID()});}
    finally{db.exec('DROP TRIGGER synthetic_correction_failure');}
    assert.deepEqual(voucherSnapshot(db,ids[0]),before);assert.equal(net(alpha),-435);assert.equal(drafts.get(accountSetId).n,0);
  });
  await t.test('跨进程重试返回同一操作回执，旧指纹和同号异参拒绝',async()=>{
    const applied=await success(formal,'voucher_correct',plan[0]);
    const receipt=applied.projection??applied;
    assert.equal(receipt.voucherId,ids[0]);assert.notEqual(receipt.afterFingerprint,plan[0].expectedFingerprint);
    const resumed=await open(delegatedEnv);
    const replay=await success(resumed,'voucher_correct',plan[0]);
    assert.equal((replay.projection??replay).afterFingerprint,receipt.afterFingerprint);
    await rejected(resumed,{...plan[0],operationId:randomUUID()});
    await rejected(resumed,{...plan[0],voucher_date:period+'-04'});
    assert.equal(net(alpha),-475);
  });
  for(const args of plan.slice(1))await success(formal,'voucher_correct',args);
  const taxChange=await request(single(5,'20',10,'2221',8,true));
  const refusedTax=await rejected(formal,taxChange);
  assert.equal(refusedTax.error,'finance_correction_correction_tax_receipt_required');
  const [next]=refusedTax.details.nextSteps;
  assert.equal(next.code,'reconcile_tax_receipt_and_bank_dates');
  assert.equal(next.tool,'skills_read');
  assert.equal((await formal.call(next.tool,next.arguments)).isError,false);
  assert.match(next.hint,/完税凭据.*扣款日.*入库日.*保留原凭证/);
  assert.deepEqual(voucherSnapshot(db,ids[5]),tax);
  assert.deepEqual([net(bank),net(alpha),net(beta),net(supplier),net('2203')],[699,-495,-714,500,0]);
  for(const change of changes) assert.deepEqual(voucherSnapshot(db,ids[change.index]),{
    date:period+'-'+change.day,status:'posted', entries:change.entries.map(e=>[e.code,e.debit??0,e.credit??0])});
  await t.test('会计从实际明细账读到逐户发生额、期末余额和正式报表',async()=>{
    for(const [code,periodDebit,periodCredit,closingBalance] of [
      [bank,1209,510,699],[alpha,0,495,-495],[beta,0,714,-714],[supplier,500,0,500],['2203',0,0,0],
    ]){
      const {projection:p}=await success(formal,'ledger_query',{accountSetId,period,code});
      assert.deepEqual([p.periodDebit,p.periodCredit,p.closingBalance],[periodDebit,periodCredit,closingBalance],code);
    }
    const tb=await success(formal,'finance_query',{accountSetId,period,nodeId:'report.trial_balance'});
    assert.deepEqual([tb.projection.closingDebit,tb.projection.closingCredit,tb.projection.balanced],[1229,1229,true]);
    assert.equal(drafts.get(accountSetId).n,0);
  });
  await t.test('同号账套的另一真实后端不能用于验收本机更正',async()=>{
    const alternate=join(root,'alternate');mkdirSync(alternate);
    const otherPath=join(alternate,'workbench.db');
    const remote=await startBackend({data:alternate,dbPath:otherPath,sourceB:source,auditB:auditDir});
    t.after(()=>remote.child.kill());
    const unbound=await open({FINANCE_MCP_PROFILE:'direct',FINANCE_DATABASE_PATH:otherPath,
      FINANCE_SOURCE_ROOT:source,FINANCE_BUSINESS_SESSION:'',FINANCE_API_BASE:remote.apiBase});
    const shadow=await success(unbound,'account_set_create',{enterprise:{enterpriseKey:'SYNTH-CORRECTION'},
      name:'同号合成企业',start_period:'2026-01'});
    assert.equal(shadow.accountSetId,accountSetId);
    await success(unbound,'ledger_query',{accountSetId,period,code:'1002'});
    const crossed=await open({...delegatedEnv,FINANCE_API_BASE:remote.apiBase});
    for(const [tool,args] of [['ledger_query',{code:'1002'}],['finance_query',{nodeId:'report.trial_balance'}]]){
      const reply=await crossed.call(tool,{accountSetId,period,...args});
      assert.equal(reply.isError,true);
      assert.match(reply.text,/backend_http_error/);
    }
  });
  await t.test('后续人工反过账后重放原更正保留原回执并返回当前草稿状态',async()=>{
    const req=plan[0];
    const original=await success(formal,'voucher_correct',req);
    // 通过另一普通入口显式执行后续操作，证明旧的纠错请求无法撤销它。
    const unposted=await success(setup,'voucher_unpost',{accountSetId,voucherId:req.voucherId,operationId:randomUUID()});
    assert.equal(unposted.projection.status,'draft');
    const snapshot=voucherSnapshot(db,req.voucherId);
    const beforeReplay=[net(bank),net(alpha),drafts.get(accountSetId).n];
    const resumed=await open(delegatedEnv);
    const replay=await success(resumed,'voucher_correct',req);
    const old=original.projection??original,now=replay.projection??replay;
    assert.deepEqual([now.before,now.after,now.operationId,now.afterFingerprint],
      [old.before,old.after,old.operationId,old.afterFingerprint]);
    assert.equal(now.currentVoucherStatus,'draft');
    assert.equal(now.readbackStatus,'no_longer_eligible');
    assert.deepEqual(voucherSnapshot(db,req.voucherId),snapshot);
    assert.deepEqual([net(bank),net(alpha),drafts.get(accountSetId).n],beforeReplay);
  });
});
