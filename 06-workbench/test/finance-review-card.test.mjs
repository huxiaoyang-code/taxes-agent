// 固定交付层使用小额独立合成账务验证；不调用模型或真实账库。
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
import {buildFinanceReviewCard,renderFinanceReviewCard} from '../server/finance-review-card.mjs';
import {runFinanceCalculation} from '../server/finance-calculation.mjs';

function fixture(){
 const accounts=[{code:'1002',name:'银行存款'},{code:'4001',name:'实收资本'},{code:'6001',name:'主营业务收入'}];
 const opening={'1002':{debit:100,credit:0},'4001':{debit:0,credit:100},'6001':{debit:0,credit:0}};
 const closing={'1002':{debit:120,credit:0},'4001':{debit:0,credit:100},'6001':{debit:0,credit:20}};
 const balances=Object.fromEntries([1,2,3].map(m=>[m,{dr:{'1002':m===1?20:0,'4001':0,'6001':0},cr:{'1002':0,'4001':0,'6001':m===1?20:0},closing}]));
 return {meta:{company:'合成卡片公司',period:'2027-01-01 至 2027-03-31'},accounts,opening,balances,vouchers:[{no:'记-1',date:'2027-01-15',summary:'销售收款',sources:['合同'],lines:[{code:'1002',debit:20,credit:0},{code:'6001',debit:0,credit:20}]}],income:[{item:'营业收入',jan:20,feb:0,mar:0,total:20}],balance_sheet:[{item:'资产总计',begin:100,end:120}],cashflow:[{item:'现金净增加',amount:20}],tax_rows:[{name:'税费测试',code:'6001',opening:0,accrued:5,paid:1,closing:4,basis:'期末余额依据'}]};
}
const bank='2027年1月1日期初余额100.00元。\n| 交易日期 | 回单号 | 对方户名 | 用途摘要 | 收入 | 支出 | 交易后余额 | 关联单据 |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n| 2027-01-15 | A1 | 客户 | 收款 | 20.00 | 0.00 | 120.00 | 合同 |\n| 2027-04-01 | A2 | 客户 | 次季收款 | 9.00 | 0.00 | 129.00 | 合同 |';
const context={dataSource:{path:'ledger.json',sha256:'sample'},runId:'run-1',callId:'call-1',generatedAt:'2026-11-01T00:00:00Z',bankSource:{text:bank,reference:{sha256:'bankhash'}}};

test('取数保持原值，独立流水排除期后收款，现金未知不补零',()=>{
 const d=fixture();d.bank_month=[{statement:999}];const spec=buildFinanceReviewCard(d,context);
 assert.deepEqual(spec.totals,[100,100,20,20,120,120]);assert.equal(spec.bank.statement,120);assert.equal(spec.bank.inflow,20);assert.equal(spec.bank.excludedRows,1);assert.equal(spec.bank.difference,0);assert.equal(spec.cash.closing,null);assert.equal(spec.cash.count,null);assert.equal(spec.findings,null);
 const mismatch=buildFinanceReviewCard(d,{...context,bankSource:{text:bank.replace('120.00','121.00'),reference:{}}});assert.equal(mismatch.bank.difference,-1);assert.deepEqual(mismatch.bank.mismatches,[4]);
 const unknown=buildFinanceReviewCard(d,{...context,bankSource:{text:bank.replace('2027年1月1日期初余额100.00元。','期初资料缺失'),reference:{}}});assert.equal(unknown.bank.opening,null);
 const shortDate=buildFinanceReviewCard(d,{...context,bankSource:{text:bank.replace('2027-01-15','2027-1-15'),reference:{}}});assert.equal(shortDate.bank.rows[0].date,'2027-01-15');assert.equal(shortDate.bank.rows[0].originalDate,'2027-1-15');assert.equal(shortDate.bank.statement,120);
 assert.throws(()=>buildFinanceReviewCard(d,{...context,bankSource:{text:bank.replace('2027-01-15','日期待补'),reference:{}}}),/交易日期无法识别/);
 assert.equal(spec.bank.months.length,3);assert.equal(spec.bank.months[1].statement,null);assert.deepEqual(spec.taxTotals,[0,5,1,4]);
});
test('上级目录不重复合计，拒绝预汇总与异常金额，缺数如实保留',()=>{
 const d=fixture();d.accounts.push({code:'6001.01',name:'商品'});d.opening['6001.01']={debit:0,credit:0};
 for(const m of ['1','2','3']){d.balances[m].dr['6001.01']=0;d.balances[m].cr['6001.01']=d.balances[m].cr['6001'];d.balances[m].cr['6001']=0;d.balances[m].closing['6001.01']={debit:0,credit:20};d.balances[m].closing['6001']={debit:0,credit:0};}
 d.vouchers[0].lines[1].code='6001.01';const spec=buildFinanceReviewCard(d,context);assert.deepEqual(spec.totals,[100,100,20,20,120,120]);assert.equal(spec.accounts.find(a=>a.code==='6001').values[5],20);
 d.balances['1'].cr['6001']=20;assert.throws(()=>buildFinanceReviewCard(d,context),/无法确定是否重复汇总/);
 const bad=fixture();bad.opening['1002'].debit='100';assert.throws(()=>buildFinanceReviewCard(bad,context),/有限数值/);bad.opening['1002'].debit=Infinity;assert.throws(()=>buildFinanceReviewCard(bad,context),/有限数值/);
 delete bad.opening['1002'];const missing=buildFinanceReviewCard(bad,context);assert.equal(missing.totals[0],null);assert.equal(missing.checks[0].difference,null);
});
test('第二季度月份动态取数，现金独立盘点及内部矛盾进入核对项',()=>{
 const d=fixture();d.meta.period='2027-04-01 至 2027-06-30';d.balances={'4':d.balances['1'],'5':d.balances['2'],'6':d.balances['3']};d.income=[{item:'营业收入',byMonth:{'4':12,'5':8,'6':0},total:20}];
 d.accounts.push({code:'1001',name:'库存现金'});d.opening['1001']={debit:5,credit:0};for(const m of ['4','5','6']){d.balances[m].dr['1001']=0;d.balances[m].cr['1001']=0;d.balances[m].closing['1001']={debit:5,credit:0};}
 d.vouchers[0].date='2027-4-15';const spec=buildFinanceReviewCard(d,{...context,bankSource:null,cashSource:{reference:{sha256:'cashhash'},value:{periodEnd:'2027-06-30',countedAmount:4}}});
 assert.deepEqual(spec.months,['4','5','6']);assert.deepEqual(spec.reports.income[0].values,[12,8,0,20]);assert.equal(spec.cash.difference,1);assert.equal(spec.checks.find(c=>c.name==='库存现金账面与盘点输入').difference,1);
 d.balances['4'].dr['1002']=21;d.tax_rows[0].closing=3;const bad=buildFinanceReviewCard(d,{...context,bankSource:null});assert.equal(bad.checks.find(c=>c.name==='1002 凭证借方与科目发生').difference,-1);assert.equal(bad.checks.find(c=>c.name==='税费测试 税费余额滚算').difference,1);
 assert.throws(()=>buildFinanceReviewCard(d,{...context,bankSource:null,cashSource:{reference:{},value:{periodEnd:'2027-03-31',countedAmount:4}}}),/期间/);
 d.income=fixture().income;assert.throws(()=>buildFinanceReviewCard(d,{...context,bankSource:null}),/非一季度/);
});
test('多层空目录只汇总末级，季度外和无效日期不伪作本期凭证',()=>{
 const d=fixture();d.accounts.push({code:'6001.01',name:'商品目录'},{code:'6001.01.01',name:'商品销售'});d.opening['6001']={debit:null,credit:null};d.opening['6001.01']={debit:null,credit:null};d.opening['6001.01.01']={debit:0,credit:0};
 for(const m of ['1','2','3']){for(const c of ['6001','6001.01']){d.balances[m].dr[c]=null;d.balances[m].cr[c]=null;d.balances[m].closing[c]={debit:null,credit:null};}d.balances[m].dr['6001.01.01']=0;d.balances[m].cr['6001.01.01']=m==='1'?20:0;d.balances[m].closing['6001.01.01']={debit:0,credit:20};}
 d.vouchers[0].lines[1].code='6001.01.01';let spec=buildFinanceReviewCard(d,context);assert.equal(spec.accounts.find(a=>a.code==='6001').values[5],20);assert.equal(spec.accounts.find(a=>a.code==='6001.01').values[5],20);assert.deepEqual(spec.totals,[100,100,20,20,120,120]);
 d.vouchers[0].date='2027-4-1';spec=buildFinanceReviewCard(d,context);assert.equal(spec.vouchers[0].periodState,'outside');assert.equal(spec.checks.find(c=>c.name==='1002 凭证借方与科目发生').difference,-20);assert(spec.checks.some(c=>c.name.includes('不在本季度')&&c.status==='mismatch'));
 d.vouchers[0].date='2027-2-31';spec=buildFinanceReviewCard(d,context);assert.equal(spec.vouchers[0].periodState,'invalid');assert.equal(spec.vouchers[0].date,'2027-2-31');
});
test('父科目任一月非零不能被其余月份缺失掩盖',()=>{
 const d=fixture();d.accounts.push({code:'1002.01',name:'银行明细'});d.opening['1002']={debit:0,credit:0};d.opening['1002.01']={debit:100,credit:0};
 for(const m of ['1','2','3']){d.balances[m].closing['1002']={debit:0,credit:0};d.balances[m].closing['1002.01']={debit:120,credit:0};d.balances[m].dr['1002.01']=0;d.balances[m].cr['1002.01']=0;delete d.balances[m].dr['1002'];delete d.balances[m].cr['1002'];}
 d.balances['1'].dr['1002']=20;
 assert.throws(()=>buildFinanceReviewCard(d,context),/上级科目包含非零原始值/);
 delete d.balances['1'].dr['1002'];d.balances['2'].cr['1002']=20;
 assert.throws(()=>buildFinanceReviewCard(d,context),/上级科目包含非零原始值/);
 delete d.balances['2'].cr['1002'];d.balances['1'].closing['1002'].debit=20;
 assert.throws(()=>buildFinanceReviewCard(d,context),/上级科目包含非零原始值/);
});
test('固定模板转义危险文本、税费展开精确保留净数，打印保留待核和金额',()=>{
 const d=fixture();d.meta.company='</script><img src=x onerror=alert(1)>';const spec=buildFinanceReviewCard(d,{...context,findingsSource:{reference:{},value:{findings:[{severity:'待核',finding:'<script>不执行</script>'}]}}});const html=renderFinanceReviewCard(spec);
 assert(!html.includes('</script><img'));assert.match(html,/\\u003c\/script>/);assert.equal((html.match(/<script>/g)||[]).length,1);
 const code=html.match(/<script>([\s\S]*)<\/script>/)[1],nodes=new Map(),events={};
 const node=id=>{if(!nodes.has(id))nodes.set(id,{textContent:'',innerHTML:'',value:id==='level'?'main':'',dataset:{},classList:{add(){},remove(){}},addEventListener(){},showModal(){},close(){},open:false});return nodes.get(id);};
 vm.runInNewContext(code,{document:{getElementById:node,querySelectorAll:()=>[],addEventListener:(n,f)=>events[n]=f},window:{addEventListener:(n,f)=>events[n]=f},console});
 events.click({target:{closest:()=>({dataset:{kind:'tax',index:'0',field:'1'}})}});assert.match(node('detailBody').innerHTML,/本期计提 \/ 代扣：5\.00/);assert.match(node('detailBody').innerHTML,/并非|不意味着/);
 events.beforeprint();assert.equal(node('issues').open,true);events.afterprint();assert.equal(node('issues').open,false);assert.match(html,/@media print[\s\S]*\.money\{display:inline/);
});

test('真实计算后自动生成版本化卡片；失败独立留证，不能越界读文件',{timeout:30000},async()=>{
 const root=mkdtempSync(join(tmpdir(),'finance-card-')),dataPath=join(root,'ledger.json'),bankPath=join(root,'bank.md');writeFileSync(dataPath,JSON.stringify(fixture()));writeFileSync(bankPath,bank);
 const old={audit:process.env.FINANCE_AUDIT_DIR,source:process.env.FINANCE_SOURCE_ROOT};process.env.FINANCE_AUDIT_DIR=join(root,'audit');process.env.FINANCE_SOURCE_ROOT=root;
 const args={title:'固定卡片合成核对',engine:'javascript',sources:[{path:dataPath},{path:bankPath}],script:"import fs from 'node:fs';const i=JSON.parse(fs.readFileSync(process.argv[2]));fs.copyFileSync(i.sources[0].snapshotPath,i.outputDir+'/ledger.json');",reviewCard:{format:'quarter-ledger/v1',dataPath:'ledger.json',bankSourceIndex:1}};
 try{
  const result=await runFinanceCalculation(args);assert.equal(result.status,'executed');assert.equal(result.reviewCard.status,'generated');assert.equal(result.reviewPath,result.reviewCard.html.path);assert.equal(result.businessStatus,'unreviewed');
  const record=JSON.parse(readFileSync(result.recordPath)),spec=JSON.parse(readFileSync(result.reviewCard.spec.path));assert.equal(spec.runId,result.runId);assert.equal(spec.provenance.data.sha256,createHash('sha256').update(readFileSync(dataPath)).digest('hex'));assert.equal(record.reviewCard.html.sha256,createHash('sha256').update(readFileSync(result.reviewPath)).digest('hex'));assert.equal(spec.bank.statement,120);
  const rerun=await runFinanceCalculation({...args,rerunOf:result.runId});assert.notEqual(rerun.runId,result.runId);assert.equal(rerun.reviewCard.status,'generated');
  const bad=await runFinanceCalculation({...args,reviewCard:{...args.reviewCard,dataPath:'../request.json'}});assert.equal(bad.status,'executed');assert.equal(bad.reviewCard.status,'failed');assert.equal(bad.reviewCard.error.code,'finance_review_card_path_invalid');assert.match(bad.reviewPath,/review.html$/);
  const absent=await runFinanceCalculation({...args,reviewCard:{...args.reviewCard,bankSourceIndex:9}});assert.equal(absent.reviewCard.error.code,'finance_review_card_source_missing');assert.equal(JSON.parse(readFileSync(absent.recordPath)).reviewCard.status,'failed');
  const malformed=await runFinanceCalculation({...args,script:"import fs from 'node:fs';const i=JSON.parse(fs.readFileSync(process.argv[2]));fs.writeFileSync(i.outputDir+'/ledger.json','{}');"});assert.equal(malformed.status,'executed');assert.equal(malformed.reviewCard.status,'failed');assert.equal(malformed.reviewCard.error.code,'finance_review_card_data_invalid');
 }finally{if(old.audit===undefined)delete process.env.FINANCE_AUDIT_DIR;else process.env.FINANCE_AUDIT_DIR=old.audit;if(old.source===undefined)delete process.env.FINANCE_SOURCE_ROOT;else process.env.FINANCE_SOURCE_ROOT=old.source;}
});
