import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {McpStdioClient} from '../../05-reconstruction/codex/mcp/finance-mcp/mcp-stdio-client.mjs';
import {validateModelEnvelope} from '../../05-reconstruction/codex/mcp/finance-mcp/finance-model-transport.mjs';
import {readFinanceCall} from '../server/finance-call-chain.mjs';
import {createSyntheticFixture,logicalSnapshot,startBackend,REPO_ROOT} from './helpers/business-memory-e2e-fixture.mjs';

test('真实只读账套按稳定凭证与科目索引逐笔核账，拒绝串用分页及更正委托',async t=>{
  const f = createSyntheticFixture();
  const period = '2026-10';
  const db = new DatabaseSync(f.dbPath);
  t.after(()=>db.close());
  // 制造金额和日期相同但往来不同的两笔、凭证编号缺口、隔壁账套重号。
  const addVoucher = (set,number,party) => {
    const id = Number(db.prepare(`INSERT INTO vouchers
      (account_set_id,period,voucher_date,word,number,summary,status,created_at)
      VALUES(?,?,'2026-10-28','记',?,?,'posted','2026-10-29')`).run(set,period,number,'收 '+party+' 对账单RK-42').lastInsertRowid);
    for(const [line,code,debit,credit] of [[1,'1122',777,0],[2,'500101',0,777]]) {
      db.prepare('INSERT INTO voucher_entries(voucher_id,line_no,code,summary,debit,credit) VALUES(?,?,?,?,?,?)').run(id,line,code,'货款',debit,credit);
    }
    return id;
  };
  const alpha = addVoucher(f.a,9,'合成甲方');
  const other = addVoucher(f.b,9,'合成甲方');
  const beta = addVoucher(f.a,45,'合成乙方');
  db.prepare("INSERT INTO accounts (account_set_id,code,name,category,direction) VALUES(?, '001-07','某项目甲方','资产','debit')").run(f.a);
  db.prepare("INSERT INTO accounts (account_set_id,code,name,category,direction) VALUES(?, '%','某项目甲方','资产','debit')").run(f.b);
  const {child,apiBase} = await startBackend(f);
  t.after(()=>child.kill());
  async function connect(scope) {
    const session = scope && join(f.root,'session-'+scope.accountSetId+'.json');
    if (scope) writeFileSync(session, JSON.stringify({version:'finance-business-session/1',scope,databasePath:f.dbPath}));
    const mcp = new McpStdioClient(join(REPO_ROOT,'05-reconstruction/codex/mcp/finance-mcp/server.mjs'),{
      cwd:f.root,env:{FINANCE_MCP_PROFILE:'direct',FINANCE_BUSINESS_SESSION:session??'',FINANCE_API_BASE:apiBase,
        FINANCE_DATABASE_PATH:f.dbPath, FINANCE_SOURCE_ROOT:f.sourceA,FINANCE_AUDIT_DIR:f.auditA,FINANCE_CORRECTION_SOURCE_DIGEST:'',
        WORKBENCH_DATABASE_MODE:'readonly'},
    }).start();
    t.after(()=>mcp.close());
    await mcp.initialize();
    return mcp;
  }
  const a = await connect(f.scopeA), b = await connect(f.scopeB), unbound = await connect(null);
  const query = (client,set,nodeId,params,p=period)=>client.call('finance_query',{accountSetId:set,nodeId,...(p!==null&&{period:p}),params});
  const ok = r => {assert.equal(r.isError,false,r.text);return r.data.projection;};
  const denied = (r,code) => {assert.equal(r.isError,true,r.text);assert.match(r.text,new RegExp(code));};
  const posted = (opts,p) => query(a,f.a,'voucher.generated.list',{view:'index',...opts},p);
  const index = async opts => ok(await posted(opts));
  const detail = (id,extra={},p=period) => query(a,f.a,'voucher.detail',{view:'check',voucherId:id,...extra},p);
  const before = logicalSnapshot(f.dbPath);

  const missing = await query(a,f.a,'voucher.detail',{});
  denied(missing,'voucherId_required');
  assert.equal(missing.data.recovery.nodeId,'voucher.generated.list');
  const first = await index({limit:1});
  assert.equal(first.totalCount,3);
  assert.deepEqual([first.pageCount,first.totalDebit,first.totalCredit,first.entryCount],[1,2331,2331,6]);
  assert.deepEqual(first.rows,[{voucherId:f.currentVoucher,number:1}]);
  const next = {limit:1,offset:first.nextOffset,snapshot:first.snapshot};
  const second = await index(next);
  assert.deepEqual(second,await index(next));
  assert.deepEqual(second.rows,[{voucherId:alpha,number:9}]);
  const third = await index({...next,offset:second.nextOffset});
  assert.equal(third.nextOffset,null);
  assert.deepEqual(third.rows,[{voucherId:beta,number:45}]);
  assert.deepEqual((await index({...next,offset:500})).rows,[]);
  const empty = ok(await posted({},'2026-07'));
  assert.deepEqual([empty.totalCount,empty.totalDebit,empty.pageCount,empty.nextOffset],[0,0,0,null]);
  denied(await posted({offset:1}),'query_snapshot_required');
  denied(await posted({limit:21}),'query_page_invalid');
  denied(await posted({nameContains:'ignored'}),'query_page_invalid');
  denied(await posted(next,'2026-09'),'query_snapshot_changed');
  denied(await query(b,f.b,'voucher.generated.list',{view:'index',...next}),'query_snapshot_changed');
  const oldAlias = ok(await query(a,f.a,'voucher.generated.summary',{view:'index',limit:1}));
  assert.deepEqual(oldAlias,first);

  const terms = {partyText:'合成甲方',basisText:'RK-42',limit:1};
  const checked = ok(await detail(second.rows[0].voucherId,terms));
  assert.deepEqual([checked.voucherDate,checked.totalDebit,checked.partyTextFound,checked.basisTextFound],['2026-10-28',777,true,true]);
  assert.deepEqual([checked.rows[0].code,checked.rows[0].debit,checked.rows[0].credit],['1122',777,0]);
  assert.equal(ok(await detail(beta,terms)).partyTextFound,false);
  assert.equal(ok(await detail(alpha,{...terms,offset:1,snapshot:checked.snapshot})).rows[0].credit,777);
  denied(await detail(alpha,{...terms,partyText:'合成乙方',offset:1,snapshot:checked.snapshot}),'query_snapshot_changed');
  assert(!JSON.stringify(checked).includes('合成甲方'));
  assert(!JSON.stringify(checked).includes('RK-42'));

  const directory = (client,set,opts)=>client.call('account_list',{accountSetId:set,view:'index',...opts});
  const accounts = ok(await directory(a,f.a,{nameContains:'某项目甲方'}));
  assert.equal(accounts.totalCount,1);
  assert.equal(accounts.rows[0].code,'001-07');
  assert.deepEqual(ok(await query(a,f.a,'enterprise_account.subject_system.all',{view:'index',nameContains:'某项目甲方'})),accounts);
  const otherAccount = ok(await directory(b,f.b,{nameContains:'某项目甲方'})).rows[0];
  assert.equal(otherAccount.code,null);
  assert.notEqual(accounts.rows[0].accountId,otherAccount.accountId);
  assert.equal(ok(await query(b,f.b,'ledger.general',{accountId:otherAccount.accountId})).itemCount,0);
  denied(await query(a,f.a,'ledger.general',{accountId:otherAccount.accountId}),'account_not_found');
  const needAccount = await query(a,f.a,'ledger.general',{});
  denied(needAccount,'code_required');
  assert.equal(needAccount.data.recovery.tool,'account_list');
  const rental = ok(await directory(a,f.a,{codePrefix:'500101'})).rows[0];
  const rentalLedger = ok(await query(a,f.a,'ledger.general',{accountId:rental.accountId}));
  assert.deepEqual([rentalLedger.openingCredit,rentalLedger.periodCredit,rentalLedger.closingBalance,rentalLedger.itemCount],[4500,2331,-6831,3]);
  assert.deepEqual(ok(await a.call('ledger_query',{accountSetId:f.a,period,code:'500101'})),rentalLedger);

  denied(await detail(other),'voucher_not_found');
  denied(await detail(f.futureVoucher,{},null),'voucher_not_found');
  denied(await query(a,f.a,'voucher.detail',{voucherId:f.futureVoucher},null),'voucher_not_found');
  denied(await detail(f.futureVoucher,{},'2026-11'),'finance_memory_session_conflict');
  assert.equal(ok(await detail(f.voucherA,{},'2026-09')).period,'2026-09');
  denied(await directory(a,f.b,{}),'finance_memory_session_conflict');
  denied(await a.call('voucher_correct',{action:'inspect',accountSetId:f.a,period,voucherId:alpha}),'finance_correction_delegation_required');
  denied(await directory(unbound,f.a,{}),'query_session_required');
  assert.equal(ok(await query(unbound,f.a,'voucher.detail',{voucherId:String(f.futureVoucher)},null)).period,'2026-11');
  assert.equal(logicalSnapshot(f.dbPath),before);

  const args={accountSetId:f.a,period,nodeId:'voucher.generated.list',params:{view:'index'}};
  const {result} = await a.rpc('tools/call',{name:'finance_query',arguments:args});
  assert.deepEqual(JSON.parse(result.content[0].text),result.structuredContent);
  const record = await readFinanceCall({auditDir:f.auditA,callId:result._meta.financeCall.callId});
  assert.deepEqual(record.output,result.structuredContent);
  assert.deepEqual(record.input,args);
  assert.equal(record.integrity,'verified');
  const forged=structuredClone(result.structuredContent);
  forged.projection.rows[0].name='不应返回';
  assert.equal(validateModelEnvelope(forged).ok,false);
  const recovery=structuredClone(missing.data);
  recovery.recovery.use='不应返回';
  assert.equal(validateModelEnvelope(recovery).ok,false);
  db.prepare("UPDATE vouchers SET summary='新来源线索' WHERE id=?").run(alpha);
  const changed = await posted(next);
  denied(changed,'query_snapshot_changed');
  assert.equal(changed.data.recovery.offset,0);
  assert.notEqual((await index({})).snapshot,first.snapshot);
});
