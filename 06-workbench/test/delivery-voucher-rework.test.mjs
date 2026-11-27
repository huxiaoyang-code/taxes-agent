// 一张实际已过账的采购凭证记错科目。独立复核必须等总账和原交付文件都修好才能签出。
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import ExcelJS from 'exceljs';
import {startBackend} from './helpers/business-memory-e2e-fixture.mjs';
import {createContext,writeBundle} from '../../05-reconstruction/codex/hosts/shared/config.mjs';
import {buildConfig} from '../../05-reconstruction/codex/hosts/dsh/adapter.mjs';
import {prepareBoundBusinessSession} from '../../05-reconstruction/codex/hosts/shared/business-session.mjs';
import {McpStdioClient} from '../../05-reconstruction/codex/mcp/finance-mcp/mcp-stdio-client.mjs';

test('原件更正已过账凭证后，只有从新账重出报表才可独立签发',async t=>{
  const root=mkdtempSync(join(tmpdir(),'stock-voucher-rework-'));
  const data=join(root,'data'),originals=join(root,'originals'),host=join(root,'host'),dbPath=join(data,'workbench.db');
  mkdirSync(data);mkdirSync(originals);
  Object.assign(process.env,{WORKBENCH_DATA_DIR:data,FINANCE_DATABASE_PATH:dbPath,FINANCE_SOURCE_ROOT:originals});
  const A=await import('../server/accounting.mjs');
  const {db}=await import('../server/db.mjs');
  const {buildReportExport}=await import('../server/report-export.mjs');
  t.after(()=>db.close());
  const period='2026-10',name='合成采购返工企业',date=period+'-08',summary='购入合成零件';
  const {id:accountSetId}=A.createAccountSet({name,start_period:period,profileId:'small-2011-basic-v1',enterprise:{enterpriseKey:'TEST-STOCK-CORRECTION'}});
  A.addAccount(accountSetId,{code:'222101',name:'应交增值税',direction:'credit',category:'负债'});
  A.setOpeningBalances(accountSetId,[{code:'1405',debit:100},{code:'3001',credit:100}]);
  const path=join(originals,'采购记账依据.csv');
  writeFileSync(path,'凭证日期,摘要,借方科目编码,借方金额,贷方科目编码,贷方金额\n'+[date,summary,'1405',60,'2202',60].join(','));
  const sourceHash=createHash('sha256').update(readFileSync(path)).digest('hex');
  writeFileSync(join(originals,'2026-10期初库存.csv'),'商品编码,品名,规格,单位,期初数量,期初金额\nA,合成零件,S,件,10,100');
  writeFileSync(join(originals,'2026-10仓库收发单.csv'),'单据号,业务类型,商品编码,品名,规格,单位,数量,金额\nP01,采购入库,A,合成零件,S,件,6,60');
  const taxRows=[[24,'本期应纳'],[25,'期初未缴'],[26,'出口退税'],[27,'本期已缴'],[32,'期末未缴']];
  writeFileSync(join(originals,'申报原表.csv'),['纳税人名称,所属期,栏次,项目,一般项目本月数',...taxRows.map(([n,label])=>[name,period,n,label,0].join(','))].join('\n'));
  const backend=await startBackend({data,dbPath,sourceB:originals,auditB:join(root,'audit')});
  t.after(()=>backend.child.kill());
  const ctx=createContext({nodePath:process.execPath,apiBase:backend.apiBase,databasePath:dbPath,sourceRoot:originals,outputDir:host,
    voucherCorrections:'delegated',correctionOriginals:[path]});
  writeBundle(ctx,buildConfig(ctx));await prepareBoundBusinessSession(host,{accountSetId,period});
  const out=join(host,'outputs'),stock=new ExcelJS.Workbook();
  stock.addWorksheet('库存').addRows([
    ['商品编码','品名','规格','单位','期初数量','期初金额','购入数量','购入金额','销售数量','销售成本金额','期末数量','期末金额'],
    ['A','合成零件','S','件',10,100,6,60,0,0,16,160]]);
  await stock.xlsx.writeFile(join(out,'商品进销存.xlsx'));
  writeFileSync(join(out,'税费核对.csv'),['税种,核对项目,申报栏次,申报金额,账载项目,账载金额',
    ...taxRows.filter(([n])=>n!==26).map(([n,label])=>['增值税',label,n,0,label,0].join(','))].join('\n'));
  function regenerate(){
    for(const kind of ['balance-sheet','trial-balance']){
      const file=buildReportExport(accountSetId,{kind,period});
      writeFileSync(join(out,file.filename),file.body);
    }
  }
  async function call(client,tool,input){
    const r=await client.call(tool,input);
    assert(!r.isError&&r.data?.ok!==false,r.text);return r.data;
  }
  const send=(client,delivery)=>call(client,'finance_period_review',{delivery});
  const maker=new McpStdioClient(ctx.serverPath,{cwd:host,env:ctx.mcpEnv}).start();
  let reviewer;
  try{
    await maker.initialize();
    reviewer=new McpStdioClient(ctx.serverPath,{cwd:host,env:{...ctx.mcpEnv,FINANCE_DIRECT_ROLE:'delivery_reviewer'}}).start();
    await reviewer.initialize();
    const mapping=(inputPointer,column)=>({inputPointer,parameterLabel:column,transform:'identity',sources:[{path,row:2,column}]});
    const base=[mapping('/voucher_date','凭证日期'),mapping('/entries/0/debit','借方金额'),mapping('/entries/1/credit','贷方金额')];
    const businessEvidence=mappings=>({businessLabel:'采购入库',method:'核采购记账依据与实际入库单',mappings});
    const target={accountSetId,period};
    const posted=await call(maker,'voucher_create',{...target,operationId:randomUUID(),status:'posted',voucher_date:date,
      summary,entries:[{code:'1403',debit:60},{code:'2202',credit:60}],businessEvidence:businessEvidence(base)});
    const voucherId=posted.projection.voucherId;
    regenerate();
    const bad=await send(maker,{});
    assert.equal((await send(reviewer,{reviewVersion:bad.version})).status,'blocked');
    const detail=await send(reviewer,{version:bad.version,issue:'inventory_ledger_mismatch'});
    assert(detail.evidence.some(line=>line.actual==='160'&&line.expected==='100'));
    const inspected=await call(maker,'voucher_correct',{...target,voucherId,action:'inspect'});
    const fingerprint=inspected.projection?.fingerprint??inspected.fingerprint;
    const correction={...target,voucherId,action:'apply',operationId:randomUUID(),expectedFingerprint:fingerprint,
      voucher_date:date,summary,entries:[{code:'1405',debit:60},{code:'2202',credit:60}],
      businessEvidence:businessEvidence([...base,mapping('/entries/0/code','借方科目编码'),mapping('/entries/1/code','贷方科目编码')]),
      proof:{kind:'document',path,sha256:sourceHash}};
    await call(maker,'voucher_correct',correction);
    const stale=await send(maker,{});
    assert.equal((await send(reviewer,{reviewVersion:stale.version})).status,'blocked');
    assert(!existsSync(join(host,'reviewed',stale.version)));
    regenerate();
    const fixed=await send(maker,{});
    assert.equal(fixed.status,'awaiting_independent_review',JSON.stringify(fixed));
    const approved=await send(reviewer,{reviewVersion:fixed.version});
    assert.equal(approved.status,'ready_for_accountant',JSON.stringify(approved));
    const signed=new DatabaseSync(join(host,approved.package,'books.sqlite'),{readOnly:true});
    try{
      const entries=signed.prepare('SELECT code,debit,credit FROM voucher_entries WHERE voucher_id=? ORDER BY line_no').all(voucherId);
      assert.deepEqual(entries.map(e=>[e.code,e.debit,e.credit]),[['1405',60,0],['2202',0,60]]);
      assert.equal(signed.prepare('SELECT count(*) AS n FROM vouchers WHERE account_set_id=? AND period=?').get(accountSetId,period).n,1);
    }finally{signed.close();}
    assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'),sourceHash);
    assert.equal((await send(reviewer,{version:bad.version})).status,'blocked');
  }finally{await Promise.all([maker.close(),reviewer?.close()]);}
});
