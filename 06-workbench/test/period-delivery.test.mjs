import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFileSync,mkdirSync,mkdtempSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import ExcelJS from 'exceljs';
import {syntheticVoucherEvidence} from './helpers/synthetic-posting-evidence.mjs';
import {join} from 'node:path';
import {createContext,writeBundle} from '../../05-reconstruction/codex/hosts/shared/config.mjs';
import {buildConfig} from '../../05-reconstruction/codex/hosts/dsh/adapter.mjs';
import {prepareBoundBusinessSession} from '../../05-reconstruction/codex/hosts/shared/business-session.mjs';
import {McpStdioClient} from '../../05-reconstruction/codex/mcp/finance-mcp/mcp-stdio-client.mjs';
import {createSyntheticFixture} from './helpers/business-memory-e2e-fixture.mjs';

test('独立 stdio 按版本、角色和页复核；大量相同问题仍只交一次摘要',async()=>{
  const stage=mkdtempSync(join(tmpdir(),'period-delivery-mcp-'));
  const f=createSyntheticFixture(stage,{includeNegativeHistory:false}), workspace=join(stage,'review-host');
  const ctx=createContext({nodePath:process.execPath,apiBase:'http://127.0.0.1:1',databasePath:f.dbPath,sourceRoot:f.sourceA,outputDir:workspace});
  writeBundle(ctx,buildConfig(ctx));
  await prepareBoundBusinessSession(workspace,{accountSetId:f.a,period:'2026-09'});
  const out=join(workspace,'outputs');
  writeFileSync(join(out,'税费.csv'),'税种,申报应纳,账载期末\n'+'增值税,10,19\n'.repeat(180));
  const maker=new McpStdioClient(ctx.serverPath,{cwd:workspace,env:ctx.mcpEnv}).start();
  let client;
  try{
    await maker.initialize();
    client=new McpStdioClient(ctx.serverPath,{cwd:workspace,env:{...ctx.mcpEnv,FINANCE_DIRECT_ROLE:'delivery_reviewer'}}).start();
    await client.initialize();
    const list=(await client.rpc('tools/list',{})).result.tools;
    assert.equal(list.length,3);
    assert(!list.some(t=>t.name==='voucher_correct'));
    assert((await client.call('voucher_correct',{})).isError);
    const empty=await client.call('finance_period_review',{delivery:{}});
    assert.equal(empty.data.error,'finance_delivery_submission_required');
    const submit=async delivery=>{
      const caller=Object.keys(delivery).length?client:maker;
      const r=await caller.call('finance_period_review',{delivery});
      assert(!r.isError,JSON.stringify(r.data));return r.data;
    };
    const a=await submit({});
    assert.equal(a.status,'blocked');
    assert(!existsSync(join(workspace,'reviewed',a.version)));
    assert(Buffer.byteLength(JSON.stringify(a))<2400);
    const issue='vat_field_binding_mismatch';
    const first=await submit({version:a.version,issue});
    assert.equal(first.count,180);
    assert.equal(first.evidence.length,3);
    assert.equal(first.nextOffset,3);
    const frozen=await submit({version:a.version,evidence:true});
    assert.equal(frozen.evidenceDirectory,'review-evidence/'+a.version);
    assert(existsSync(join(workspace,frozen.evidenceDirectory,'outputs','税费.csv')));
    const originals=receipt=>JSON.parse(readFileSync(join(workspace,receipt.evidenceDirectory,'manifest.json'),'utf8')).sources;
    assert.deepEqual(originals(frozen),[]);
    assert.equal((await submit({version:a.version,issue:'delivery_original_scope_unverified'})).role,'accountant');
    assert(!existsSync(join(workspace,'reviewed',a.version)));
    assert((await client.call('finance_period_review',{delivery:{version:a.version,issue,role:'product'}})).isError);
    assert((await client.call('finance_period_review',{delivery:{version:'0'.repeat(32)}})).isError);
    const same=await submit({});
    assert.equal(same.version,a.version);assert.equal(same.changed,0);
    writeFileSync(join(out,'版本说明.txt'),'修订一');
    const b=await submit({});
    writeFileSync(join(out,'版本说明.txt'),'修订二');
    const c=await submit({});
    assert.notEqual(a.version,b.version);assert.notEqual(b.version,c.version);
    assert((await submit({version:c.version,issue})).decision);
    assert.equal((await submit({version:a.version,issue})).currentVersion,false);
    const oldPage=await submit({reviewVersion:a.version,issue,offset:3});
    assert.equal(oldPage.version,a.version);
    assert.equal(oldPage.currentVersion,false);
    assert.equal(oldPage.nextOffset,6);
    assert.equal(oldPage.evidence.length,3);
    assert.match(oldPage.evidence[0].location,/增值税第5行/);
    assert(!existsSync(join(workspace,'reviewed',a.version)));
    const partition=join(f.sourceA,'SYNTHETIC-E2E-LEASE-A');
    mkdirSync(partition);
    copyFileSync(f.originalA,join(partition,'甲原件.json'));
    const scoped=await submit({});
    const own=await submit({version:scoped.version,evidence:true});
    assert.deepEqual(originals(own).map(s=>s.path),['sources/甲原件.json']);
    assert.deepEqual(originals(await submit({version:a.version,evidence:true})),[]);
    const denied=await maker.call('finance_period_review',{delivery:{reviewVersion:scoped.version}});
    assert.equal(denied.data.error,'finance_delivery_reviewer_required');
    const stale=await client.call('finance_period_review',{delivery:{reviewVersion:a.version}});
    assert.equal(stale.data.error,'finance_delivery_submission_changed');
    assert.equal((await submit({reviewVersion:scoped.version})).status,'blocked');
    writeFileSync(join(out,'版本说明.txt'),'送审后另有改动');
    const drift=await client.call('finance_period_review',{delivery:{reviewVersion:scoped.version}});
    assert.equal(drift.data.error,'finance_delivery_submission_changed');
    assert(!existsSync(join(workspace,'reviewed',scoped.version)));
  }finally{await Promise.all([client?.close(),maker.close()]);}
});

test('正常 Direct 制单人提交 15B、复核人按同版签出；原表错栏修正后只投影关闭数量',async t=>{
  const stage=mkdtempSync(join(tmpdir(),'period-delivery-release-'));
  const data=join(stage,'data'),dbPath=join(data,'workbench.db');
  const sources=join(stage,'sources'),workspace=join(stage,'host');
  for(const dir of [data,sources])mkdirSync(dir);
  const env={WORKBENCH_DATA_DIR:data,FINANCE_DATABASE_PATH:dbPath,FINANCE_SOURCE_ROOT:sources,FINANCE_AUDIT_DIR:join(stage,'audit')};
  const before=Object.fromEntries(Object.keys(env).map(k=>[k,process.env[k]]));
  Object.assign(process.env,env);
  t.after(()=>{for(const [k,v] of Object.entries(before))if(v===undefined)delete process.env[k];else process.env[k]=v;});
  const A=await import('../server/accounting.mjs');
  const {db}=await import('../server/db.mjs');
  t.after(()=>db.close());
  const {buildReportExport}=await import('../server/report-export.mjs');
  const {buildOfficeExport}=await import('../server/report-office-export.mjs');
  const period='2026-09', name='合成送审企业',enterpriseKey='SYNTHETIC-RELEASE-15B';
  const set=A.createAccountSet({name,profileId:'small-2011-basic-v1',start_period:period,enterprise:{enterpriseKey}});
  A.addAccount(set.id,{code:'222101',name:'应交增值税',direction:'credit',category:'负债'});
  A.setOpeningBalances(set.id,[{code:'1405',debit:100},{code:'222101',credit:3},{code:'3001',credit:97}]);
  A.createVoucher(set.id,syntheticVoucherEvidence({period,voucher_date:'2026-09-05',number:1,status:'posted',
    summary:'合成服务收入',entries:[{code:'1122',debit:105},{code:'5001',credit:100},{code:'222101',credit:5}]},sources));
  const ctx=createContext({nodePath:process.execPath,apiBase:'http://127.0.0.1:1',databasePath:dbPath,sourceRoot:sources,outputDir:workspace});
  writeBundle(ctx,buildConfig(ctx));
  await prepareBoundBusinessSession(workspace,{accountSetId:set.id,period});
  const out=join(workspace,'outputs');
  const reportName='15B_资产负债表.xlsx';
  const native=await buildOfficeExport(set.id,{kind:'balance-sheet',period,format:'xlsx'});
  writeFileSync(join(out,reportName),native.body);
  const trial=buildReportExport(set.id,{kind:'trial-balance',period});
  writeFileSync(join(out,trial.filename),trial.body);
  const stock=new ExcelJS.Workbook();
  stock.addWorksheet('库存').addRows([
    ['商品编码','品名','规格','单位','期初数量','期初金额','购入数量','购入金额','销售数量','销售成本金额','期末数量','期末金额'],
    ['S-1','合成配件','甲型','件',10,100,0,0,0,0,10,100]]);
  writeFileSync(join(out,'进销存.xlsx'),Buffer.from(await stock.xlsx.writeBuffer()));
  writeFileSync(join(sources,'2026-09期初库存.csv'),'商品编码,品名,规格,单位,期初数量,期初金额\nS-1,合成配件,甲型,件,10,100');
  const original=join(sources,'增值税申报原表.csv');
  const fields=[[24,'本期应纳',5],[25,'期初未缴',3],[26,'出口退税',0],[27,'本期已缴',0],[32,'期末未缴',8]];
  const sourceBody=['纳税人名称,所属期,栏次,项目,一般项目本月数',...fields.map(row=>[name,period,...row].join(','))].join('\n');
  writeFileSync(original,sourceBody.replace('24,本期应纳','24,期末未缴'));
  const taxName='账税核对.csv';
  writeFileSync(join(out,taxName),['税种,核对项目,申报栏次,申报金额,账载项目,账载金额',
    ...fields.filter(([line])=>line!==26).map(([line,label,value])=>['增值税',label,line,value,label,value].join(','))].join('\n'));

  async function review(client,delivery){
    const reply=await client.call('finance_period_review',{delivery});
    assert(!reply.isError,JSON.stringify(reply.data));
    return reply.data;
  }
  const maker=new McpStdioClient(ctx.serverPath,{cwd:workspace,env:ctx.mcpEnv}).start();
  let verifier;
  try{
    await maker.initialize();
    verifier=new McpStdioClient(ctx.serverPath,{cwd:workspace,env:{...ctx.mcpEnv,FINANCE_DIRECT_ROLE:'delivery_reviewer'}}).start();
    await verifier.initialize();
    const bad=await review(maker,{});
    assert.equal(bad.status,'blocked');
    const rejected=await review(verifier,{reviewVersion:bad.version});
    assert.equal(rejected.status,'blocked');
    assert.equal(rejected.version,bad.version);
    const detail=await review(verifier,{reviewVersion:bad.version,issue:'vat_form_field_unverified'});
    assert.equal(detail.role,'accountant');
    assert.match(detail.evidence[0].location,/增值税申报原表\.csv.*24栏/);
    assert(!existsSync(join(workspace,'reviewed',bad.version)));

    writeFileSync(original,sourceBody);
    const fixed=await review(maker,{since:bad.version});
    assert.notEqual(fixed.version,bad.version);
    assert.equal(fixed.status,'awaiting_independent_review',JSON.stringify(fixed));
    assert.deepEqual(fixed.handoff,{role:'delivery_reviewer',delivery:{reviewVersion:fixed.version}});
    assert.equal(fixed.outstanding,0);
    assert.equal(fixed.resolved,bad.outstanding);
    assert(!existsSync(join(workspace,'reviewed',fixed.version)));
    const signed=await review(verifier,fixed.handoff.delivery);
    assert.equal(signed.status,'ready_for_accountant');
    assert.equal(signed.version,fixed.version);
    assert.equal(signed.package,'reviewed/'+fixed.version);
    assert.equal(signed.resolved,bad.outstanding);
    for(const receipt of [fixed,signed]){
      assert.equal(receipt.outstanding,0);
      for(const key of ['queue','resolvedIssues','more','evidence'])assert(!Object.hasOwn(receipt,key));
      assert(!JSON.stringify(receipt).includes('vat_form_field_unverified'));
    }
    const published=join(workspace,signed.package);
    const manifest=JSON.parse(readFileSync(join(published,'manifest.json'),'utf8'));
    assert.equal(manifest.version,fixed.version);
    assert.deepEqual(manifest.outputs.map(f=>f.path).sort(),[reportName,trial.filename,'进销存.xlsx',taxName].map(n=>'outputs/'+n).sort());
    assert.equal(readFileSync(join(published,manifest.ledger.path)).subarray(0,15).toString(),'SQLite format 3');
    for(const output of manifest.outputs){
      const artifact=readFileSync(join(published,output.path));
      assert.equal(createHash('sha256').update(artifact).digest('hex'),output.sha256);
      assert.deepEqual(artifact,readFileSync(join(workspace,output.path)));
    }
  }finally{await Promise.all([verifier?.close(),maker.close()]);}
});
