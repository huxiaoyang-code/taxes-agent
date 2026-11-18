// 独立冷启动夹具：只装配既有账、合同、发票、成本底稿及申报导出，不生成基线、方法或计算脚本。
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,existsSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,isAbsolute,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {McpStdioClient} from '../../../05-reconstruction/codex/mcp/finance-mcp/mcp-stdio-client.mjs';
import {syntheticVoucherEvidence} from './synthetic-posting-evidence.mjs';

export const BASELINE_REPO_ROOT=fileURLToPath(new URL('../../../',import.meta.url));
export const BASELINE_WORKBENCH_ROOT=join(BASELINE_REPO_ROOT,'06-workbench');
export const BASELINE_FIXTURE_VERSION='synthetic-business-baseline-cold-start/1';
export const hashBaseline=bytes=>createHash('sha256').update(bytes).digest('hex');
export const readBaselineJson=path=>JSON.parse(readFileSync(path,'utf8'));
export const writeBaselineJson=(path,value)=>writeFileSync(path,JSON.stringify(value,null,2)+'\n');
export const baselineTarget=(f,name='a',period='2026-07')=>({accountSetId:f[name],period});
export const baselineOptions=f=>({dbPath:f.dbPath,sourceRoot:f.sourceRoot,auditDir:f.auditDir,sessionPath:''});

// 预期不由被测模块、模型或输出反推；仅写入sourceRoot外的验收者目录，绝不拼入模型任务。
export const INDEPENDENT_BASELINE_EXPECTATIONS=Object.freeze({
  accountingStandards:{a:'企业会计准则',b:'小企业会计准则'},
  inventoryMethods:{a:'periodic_weighted_average',b:'fifo'},
  vat:{periods:['2026-04','2026-05','2026-06'],sales:[100000,120000,80000],payable:[1800,2400,1760],rates:[0.018,0.02,0.022],sumSales:300000,sumPayable:5960,weightedRatio:5960/300000,displayPercent:'1.99%',rangePercent:['1.80%','2.20%'],arithmeticMeanPercent:'2.00%'},
  cit:{through:'2026-06',cumulativeRevenue:600000,cumulativePayableAfterReductions:3000,cumulativePaid:2500,ratio:0.005,displayPercent:'0.50%'},
  july:{a:{oldLeaseRevenue:10000,newLeaseRevenue:20000,totalLeaseRevenue:30000,newLeaseVatSales:120000,oldLeaseAdditionalVatSales:0,maintenanceExpense:1000,maintenanceAdditionalInputVat:0},b:{completedRepairRevenue:40000,unacceptedRepairRevenue:0,inventoryIssueCost:10400}},
  meaning:'历史应纳/可比收入指标，不是法定税率、以后目标、资格结论或实缴比例；程序人工保存不等于模型自主生成。',
});

export function baselineLogicalSnapshot(dbPath){
  const db=new DatabaseSync(dbPath,{readOnly:true});
  try{
    db.exec('PRAGMA query_only=ON');
    const schema=db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
    return JSON.stringify({schema,tables:schema.filter(s=>s.type==='table').map(s=>[s.name,db.prepare('SELECT * FROM "'+s.name.replaceAll('"','""')+'" ORDER BY rowid').all()])});
  }finally{db.close();}
}

export function assertColdBaselineFixture(f){
  assert.equal(f.version,BASELINE_FIXTURE_VERSION,'必须使用当前母夹具，旧阳性现场不可冒充本轮');
  const db=new DatabaseSync(f.dbPath,{readOnly:true});
  try{
    const names=new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r=>r.name));
    if(names.has('business_memory_versions'))assert.equal(db.prepare('SELECT COUNT(*) n FROM business_memory_versions').get().n,0,'冷启动不得预置任何企业方法或基线版本');
    for(const table of [...names].filter(name=>/^business_baseline/.test(name)))assert.equal(db.prepare('SELECT COUNT(*) n FROM "'+table+'"').get().n,0,'冷启动不得预置业务基线');
  }finally{db.close();}
  assert(!existsSync(join(f.auditDir,'calculations')),'冷启动不预置计算脚本或结果');
  for(const path of f.originalPaths){
    const text=readFileSync(path,'utf8');
    assert(!/recognition_method|rentalDefinition|methodRef|baselineRef|"principles"|"shortText"/.test(text),'原件不能包含预写企业基线或方法答案：'+relative(f.sourceRoot,path));
    assert(!/"script"\s*:|"execution"\s*:/.test(text),'原件不能包含已选计算脚本');
  }
  assert(relative(f.sourceRoot,f.expectedPath).startsWith('..'),'独立预期必须在模型原件根之外');
  return {status:'cold_raw_materials_only',baselinePrewritten:false,methodPreselected:false,scriptPrewritten:false,modelInvoked:false};
}

async function seedBaseline(root,{collisionOnly=false,combinedVoucher=false}={}){
  const data=join(root,'data'),sourceRoot=join(root,'originals'),auditDir=join(root,'finance-call-records'),reviewer=join(root,'reviewer-only');
  for(const path of [data,sourceRoot,reviewer])mkdirSync(path,{recursive:true});
  const dbPath=join(data,'workbench.db');
  Object.assign(process.env,{WORKBENCH_DATA_DIR:data,FINANCE_DATABASE_PATH:dbPath,FINANCE_SOURCE_ROOT:sourceRoot,FINANCE_AUDIT_DIR:auditDir});
  delete process.env.FINANCE_BUSINESS_SESSION;delete process.env.WORKBENCH_DATABASE_MODE;
  const A=await import('../../server/accounting.mjs'),{db}=await import('../../server/db.mjs');
  const {resolveDirectFinanceTarget}=await import('../../server/direct-finance-target.mjs');
  const f={version:BASELINE_FIXTURE_VERSION,root,data,dbPath,sourceRoot,auditDir,reviewer,originalPaths:[],files:{a:{},b:{}},historicalVouchers:{a:[],b:[]},fixtureVariant:combinedVoucher?'combined_voucher_unrelated_lines':collisionOnly?'unrelated_history_collisions':'positive_raw_history',currentMonthExecuted:false,modelInvoked:false,humanApproval:false,negativeCasesRun:false};
  const owners={a:{enterpriseKey:'SYNTHETIC-BASELINE-REPAIR-A',companyName:'LOCAL_ONLY_SYNTHETIC_甲维修及出租'},b:{enterpriseKey:'SYNTHETIC-BASELINE-REPAIR-B',companyName:'LOCAL_ONLY_SYNTHETIC_乙维修服务'}};
  const original=(name,key,title,value)=>{const dir=join(sourceRoot,name);mkdirSync(dir,{recursive:true});const path=join(dir,title+'.json');writeBaselineJson(path,{...owners[name],...value});f.files[name][key]=path;f.originalPaths.push(path);return path;};
  const addAccounts=(id,rows)=>{for(const row of rows)A.addAccount(id,row);};
  const account=(code,name,category='损益',direction='credit')=>({code,name,category,direction});
  const numbers=new Map();
  const voucher=(name,period,day,summary,entries,reference)=>{
    const key=name+period,number=(numbers.get(key)??0)+1;numbers.set(key,number);
    if(reference)entries=entries.map(e=>({...e,summary:reference.value}));
    const input=syntheticVoucherEvidence({period,voucher_date:period+'-'+day,number,status:'posted',summary,entries},join(sourceRoot,name,'历史凭证原件'));
    if(reference)entries.forEach((_,i)=>input.businessEvidence.mappings.push({inputPointer:'/entries/'+i+'/summary',parameterLabel:'该行历史业务合同或工单编号',transform:'identity',reason:'该分录明确关联该原始合同或工单；不以同凭证其他分录或金额相同代替关联',sources:[{path:reference.path,jsonPointer:reference.pointer??'/合同编号'}]}));
    for(const source of input.businessEvidence.mappings.flatMap(m=>m.sources))if(source.path&&!f.originalPaths.includes(source.path))f.originalPaths.push(source.path);
    const made=A.createVoucher(f[name],input);
    f.historicalVouchers[name].push({id:made.id,period,summary});return made.id;
  };
  try{
    f.a=A.createAccountSet({name:owners.a.companyName,taxpayer_type:'一般纳税人',profileId:'enterprise-2019-general-basic-v1',start_period:'2026-01',enterprise:{enterpriseKey:owners.a.enterpriseKey}}).id;
    f.b=A.createAccountSet({name:owners.b.companyName,taxpayer_type:'小规模纳税人',profileId:'small-2011-basic-v1',start_period:'2026-01',enterprise:{enterpriseKey:owners.b.enterpriseKey}}).id;
    addAccounts(f.a,[account('600101','维修收入'),account('605101','闲置仓库经营出租收入'),account('660201','年度设备维保费','损益','debit'),account('660202','日常修理费','损益','debit'),account('112301','预付年度维保','资产','debit'),account('222101','应交增值税销项税额','负债'),account('222102','应交增值税已确认进项','负债')]);
    addAccounts(f.b,[account('500101','完工维修收入'),account('560201','日常维修费用','损益','debit')]);
    original('a','lease','4月签署的闲置仓库出租合同',{合同编号:'A-LEASE-APR',业务性质:'闲置房屋仓库经营出租',业务类别:'租赁',提供方式:'均匀连续服务',租赁标的:'已交付可独立使用的闲置仓库房屋',服务开始日:'2026-04-01',服务结束日:'2026-09-30',净租金:60000,发票税额:5400,收款日:'2026-04-01',开票日:'2026-04-01',合同约定付款日:'2026-04-01',交付情况:'4月1日一次交付，租期内连续均匀提供使用权，无免租、变更或可变租金',是否形成承租人资产:false});
    original('a','maintenance','年度维保服务合同与发票',{合同编号:'A-MAINT-APR',业务性质:'年度维保',业务类别:'维保',提供方式:'每月等量连续维护',服务开始日:'2026-04-01',服务结束日:'2027-03-31',净价:12000,发票税额:720,含税金额:12720,开票日:'2026-04-01',付款日:'2026-04-01',用途确认日:'2026-04-18',服务安排:'每月相同次数的日常检查、清洁和保养，全年连续均匀受益',是否形成或改良资产:false,发票使用范围:'一般计税维修经营，合规专用发票，未用于不得抵扣项目',确认记录编号:'A-INPUT-APR-720'});
    original('a','cost','4至6月备件成本核算底稿',{存货:'维修备件',既有计价设置:'月末一次加权平均法',行:[{期间:'2026-04',期初数量:100,期初成本:10000,本期购入数量:100,本期购入成本:12000,本期领用数量:80,领用成本:8800,期末数量:120,期末成本:13200},{期间:'2026-05',期初数量:120,期初成本:13200,本期购入数量:80,本期购入成本:10800,本期领用数量:100,领用成本:12000,期末数量:100,期末成本:12000},{期间:'2026-06',期初数量:100,期初成本:12000,本期购入数量:100,本期购入成本:14000,本期领用数量:90,领用成本:11700,期末数量:110,期末成本:14300}]});
    original('a','asset','5月新购独立设备验收单',{采购编号:'A-ASSET-MAY',业务性质:'独立设备采购',业务类别:'固定资产',设备用途:'维修生产设备，非日常保养',不含税购置价:24000,验收可用日:'2026-05-30',投入使用日:'2026-06-01',预计使用月数:24,预计残值:0,是否形成或改良资产:true});
    original('a','daily','6月日常修理劳务验收单',{业务编号:'A-DAILY-JUN',业务类别:'维修',提供方式:'一次完工',劳务日期:'2026-06-28',净价:500,是否形成或改良资产:false,工作内容:'已完成更换耗损小零件的日常修理；不新增功能或延长整机寿命'});
    original('a','repairs','4至6月维修工单及验收发票',{行:[{工单:'A-APR-REPAIR',业务类别:'维修',提供方式:'一次完工',完工验收日:'2026-04-28',净价:40000,发票税额:5200},{工单:'A-MAY-REPAIR',业务类别:'维修',提供方式:'一次完工',完工验收日:'2026-05-28',净价:120000,发票税额:15600},{工单:'A-JUN-REPAIR',业务类别:'维修',提供方式:'一次完工',完工验收日:'2026-06-28',净价:80000,发票税额:10400}]});
    original('a','taxChoice','现有税务核算设置导出',{导出所属期:'2026-06',业务类别:'租赁',纳税身份:'一般纳税人',租赁税务计税选择:'一般计税',有效开始日:'2026-01-01',有效终止日:'2026-12-31',所得税租金口径:'合同约定应付期',所得税收入处理:'按合同约定应付租金日确认；未选择将跨年度租金分期计入，原租赁不跨年',适用业务:'现有闲置房屋仓库经营出租',资格材料:'仅本合成设置所列有效选择，不由历史税负推断优惠资格'});
    original('a','vat','4至6月增值税申报表导出',{导出性质:'已申报历史数据的合成副本',行:[
      {税种:'增值税',税额口径:'应纳',税额阶段:'减免后应纳',期间口径:'所属期',累计口径:'本期',所属期起:'2026-04',所属期止:'2026-04',不含税应税销售额:100000,应纳税额:1800,实缴税额:1700,缴款日:'2026-05-15',租赁销售额:60000,租赁销项税额:5400,维保已抵扣进项税额:720},
      {税种:'增值税',税额口径:'应纳',税额阶段:'减免后应纳',期间口径:'所属期',累计口径:'本期',所属期起:'2026-05',所属期止:'2026-05',不含税应税销售额:120000,应纳税额:2400,实缴税额:2200,缴款日:'2026-06-15',租赁销售额:0,租赁销项税额:0,维保已抵扣进项税额:0},
      {税种:'增值税',税额口径:'应纳',税额阶段:'减免后应纳',期间口径:'所属期',累计口径:'本期',所属期起:'2026-06',所属期止:'2026-06',不含税应税销售额:80000,应纳税额:1760,实缴税额:1600,缴款日:'2026-07-15',租赁销售额:0,租赁销项税额:0,维保已抵扣进项税额:0},
    ]});
    original('a','cit','截至6月企业所得税预缴申报导出',{税种:'企业所得税',税额口径:'应纳',税额阶段:'减免后应纳',期间口径:'所属期',累计口径:'累计',所属期起:'2026-01',所属期止:'2026-06',累计营业收入:600000,减免后累计应纳税额:3000,累计实际已预缴:2500,申报日期:'2026-07-14',说明:'仅比较已申报累计应纳与累计收入；不得视为法定税率或优惠资格'});
    original('a','newLease','7月新仓库房屋出租合同及发票',{合同编号:'A-LEASE-JUL',业务性质:'闲置房屋仓库经营出租',业务类别:'租赁',提供方式:'均匀连续服务',租赁标的:'另一处已交付可独立使用的闲置仓库房屋',服务开始日:'2026-07-01',服务结束日:'2026-12-31',净租金:120000,发票税额:10800,含税金额:130800,开票日:'2026-07-01',收款日:'2026-07-01',合同约定付款日:'2026-07-01',交付情况:'7月1日交付，租期连续均匀，无免租、变更或可变租金',是否形成承租人资产:false});
    original('b','cost','4至6月配件收发成本底稿',{存货:'维修配件',既有计价设置:'先进先出法',行:[{期间:'2026-04',期初数量:100,期初单价:100,入库数量:100,入库单价:120,领用数量:120,领用成本:12400,期末数量:80,期末成本:9600},{期间:'2026-05',期初数量:80,期初单价:120,入库数量:100,入库单价:140,领用数量:100,领用成本:12400,期末数量:80,期末成本:11200},{期间:'2026-06',期初数量:80,期初单价:140,入库数量:100,入库单价:160,领用数量:100,领用成本:14400,期末数量:80,期末成本:12800}]});
    original('b','repairs','4至6月维修合同与客户验收',{业务性质:'一次性设备维修',业务类别:'维修',提供方式:'一次完工',服务安排:'每单在客户签收验收前不交付成果；不提供持续租赁或持续维保',行:[{工单:'B-APR',完工验收日:'2026-04-28',净价:30000,收款日:'2026-04-30'},{工单:'B-MAY',完工验收日:'2026-05-27',净价:36000,收款日:'2026-05-30'},{工单:'B-JUN',完工验收日:'2026-06-29',净价:32000,收款日:'2026-06-30'}]});
    original('b','vat','4至6月增值税申报表导出',{行:[{税种:'增值税',税额口径:'应纳',税额阶段:'减免后应纳',期间口径:'所属期',累计口径:'本期',所属期起:'2026-04',所属期止:'2026-04',不含税应税销售额:30000,应纳税额:300},{税种:'增值税',税额口径:'应纳',税额阶段:'减免后应纳',期间口径:'所属期',累计口径:'本期',所属期起:'2026-05',所属期止:'2026-05',不含税应税销售额:36000,应纳税额:360},{税种:'增值税',税额口径:'应纳',税额阶段:'减免后应纳',期间口径:'所属期',累计口径:'本期',所属期起:'2026-06',所属期止:'2026-06',不含税应税销售额:32000,应纳税额:320}]});
    original('b','newRepairs','7月维修工单及验收记录',{业务性质:'一次性设备维修',业务类别:'维修',提供方式:'一次完工',工单:[{工单:'B-JUL-COMPLETE',客户签收验收日:'2026-07-25',净价:40000,付款日:'2026-08-05'},{工单:'B-JUL-WIP',客户签收验收日:null,预计验收日:'2026-08-04',预收日:'2026-07-26',净价:60000}],配件领用:{所属期起:'2026-07',所属期止:'2026-07',期初数量:80,期初单价:160,本月购入数量:100,本月购入单价:180,本月领用数量:65}});
    voucher('a','2026-03','31','1至3月已交付维修业务汇总',[{code:'1122',debit:330000},{code:'600101',credit:330000}]);
    voucher('a','2026-04','01','原租赁全额收款开票，净额先收未到期租金',[{code:'1002',debit:65400},{code:'2203',credit:60000},{code:'222101',credit:5400}],{path:f.files.a.lease,value:'A-LEASE-APR'});
    voucher('a','2026-04','01','年度维保款及合规进项',[{code:'112301',debit:12000},{code:'222102',debit:720},{code:'1002',credit:12720}],{path:f.files.a.maintenance,value:'A-MAINT-APR'});
    if(collisionOnly)original('a','unrelated','其他客户维修与办公劳务原件',{业务编号:'A-UNRELATED',业务类别:'维修',说明:'其他客户的一次完工维修及办公劳务；与A-LEASE-APR及A-MAINT-APR无关联'});
    for(const [i,[period,revenue,vat,cost]]of [['2026-04',40000,5200,8800],['2026-05',120000,15600,12000],['2026-06',80000,10400,11700]].entries()){
      voucher('a',period,'28','本月已交付维修收入',[{code:'1122',debit:revenue+vat},{code:'600101',credit:revenue},{code:'222101',credit:vat}],{path:f.files.a.repairs,pointer:'/行/'+i+'/工单',value:['A-APR-REPAIR','A-MAY-REPAIR','A-JUN-REPAIR'][i]});
      if(!collisionOnly){
        voucher('a',period,'28','A-LEASE-APR 本月已提供仓库房屋使用',[{code:'2203',debit:10000},{code:'605101',credit:10000}],{path:f.files.a.lease,value:'A-LEASE-APR'});
        voucher('a',period,'28','A-MAINT-APR 本月维保受益',[{code:'660201',debit:1000},{code:'112301',credit:1000}],{path:f.files.a.maintenance,value:'A-MAINT-APR'});
      }else{
        const ref={path:f.files.a.unrelated,pointer:'/业务编号',value:'A-UNRELATED'};
        voucher('a',period,'28','其他客户一次完工维修的同额收入',[{code:'1122',debit:10000},{code:'600101',credit:10000}],ref);
        voucher('a',period,'28','与年度维保无关的同额办公劳务',[{code:'660202',debit:1000},{code:'1002',credit:1000}],ref);
      }
      voucher('a',period,'28','备件按月末已核成本领用',[{code:'6401',debit:cost},{code:'1403',credit:cost}]);
      voucher('a',period,'28','已完成的日常修理劳务',[{code:'660202',debit:500},{code:'1002',credit:500}],period==='2026-06'?{path:f.files.a.daily,pointer:'/业务编号',value:'A-DAILY-JUN'}:undefined);
    }
    voucher('a','2026-05','30','购入可独立使用的维修设备并验收',[{code:'1601',debit:24000},{code:'222102',debit:3120},{code:'1002',credit:27120}],{path:f.files.a.asset,pointer:'/采购编号',value:'A-ASSET-MAY'});
    f.asset=A.addAssetCard(f.a,{name:'LOCAL_ONLY_SYNTHETIC_独立维修设备',kind:'fixed',original_cost:24000,residual_rate:0,useful_life_months:24,start_period:'2026-06',acquired_period:'2026-05',ledger_status:'booked',expense_account:'6602'}).id;
    A.generateDepreciation(f.a,'2026-06');
    for(const [i,[period,revenue,cost]]of [['2026-04',30000,12400],['2026-05',36000,12400],['2026-06',32000,14400]].entries()){
      voucher('b',period,'28','工单完成客户验收的维修服务',[{code:'1122',debit:revenue},{code:'500101',credit:revenue}],{path:f.files.b.repairs,pointer:'/行/'+i+'/工单',value:['B-APR','B-MAY','B-JUN'][i]});
      voucher('b',period,'28','本月配件先进先出领用',[{code:'5401',debit:cost},{code:'1403',credit:cost}]);
      voucher('b',period,'28','当月已完成日常维修劳务',[{code:'560201',debit:800},{code:'1002',credit:800}]);
    }
    if(combinedVoucher){
      original('a','unearnedLease','仅预收尚未确认收入的另一仓库租约',{合同编号:'LEASE-NOT-EARNED',业务类别:'租赁',提供方式:'均匀连续服务',服务开始日:'2026-04-01',服务结束日:'2026-09-30',净租金:60000});
      original('a','combinedOther','合并凭证的无关维修工单',{业务编号:'COMBINED-UNRELATED-REPAIR',业务类别:'维修'});
      f.combined={voucherIds:[],targetBusinessReference:'LEASE-NOT-EARNED',actualTargetIncome:0,targetPrepaymentPerVoucher:1,unrelatedRepairIncomePerVoucher:10000};
      for(const period of ['2026-04','2026-05']){
        const key='a'+period,number=(numbers.get(key)??0)+1;numbers.set(key,number);
        const input=syntheticVoucherEvidence({period,voucher_date:period+'-28',number,status:'posted',summary:'合并收款：无关维修收入与另一租赁预收',entries:[{code:'1002',debit:10001},{code:'600101',credit:10000,summary:'COMBINED-UNRELATED-REPAIR'},{code:'2203',credit:1,summary:'LEASE-NOT-EARNED'}]},join(sourceRoot,'a','合并凭证原件'));
        input.businessEvidence.mappings.push({inputPointer:'/entries/1/summary',parameterLabel:'无关维修行的业务编号',transform:'identity',sources:[{path:f.files.a.combinedOther,jsonPointer:'/业务编号'}]},{inputPointer:'/entries/2/summary',parameterLabel:'目标租赁仅预收行的合同编号',transform:'identity',sources:[{path:f.files.a.unearnedLease,jsonPointer:'/合同编号'}]});
        for(const source of input.businessEvidence.mappings.flatMap(m=>m.sources))if(source.path&&!f.originalPaths.includes(source.path))f.originalPaths.push(source.path);
        const made=A.createVoucher(f.a,input);f.combined.voucherIds.push(made.id);f.historicalVouchers.a.push({id:made.id,period,summary:'合并凭证：目标租赁无收入，仅另一维修收入10000和目标预收1'});
      }
    }
    // 装配既有封账状态；这不是对封账功能的业务验收，不调用任何记忆prepare。
    db.prepare("UPDATE periods SET status='closed' WHERE account_set_id IN (?,?) AND period<='2026-06'").run(f.a,f.b);
    for(const name of ['a','b'])f['scope'+name.toUpperCase()]=resolveDirectFinanceTarget(baselineTarget(f,name),dbPath).scope;
    f.expectedPath=join(reviewer,'独立预期.json');writeBaselineJson(f.expectedPath,INDEPENDENT_BASELINE_EXPECTATIONS);
    writeBaselineJson(join(root,'fixture.json'),f);assertColdBaselineFixture(f);return f;
  }finally{db.close();}
}

export function createBaselineFixture(requestedRoot,{collisionOnly=false,combinedVoucher=false}={}){
  if(collisionOnly&&combinedVoucher)throw Error('baseline_fixture_variants_are_exclusive');
  const root=requestedRoot??mkdtempSync(join(tmpdir(),'business-baseline-cold-'));
  if(!isAbsolute(root)||!existsSync(root)||readdirSync(root).length)throw Error('baseline_fixture_root_must_be_absolute_existing_empty');
  const made=spawnSync(process.execPath,[fileURLToPath(import.meta.url),'--seed',root,...(collisionOnly?['--collision-only']:combinedVoucher?['--combined-voucher']:[])],{cwd:BASELINE_WORKBENCH_ROOT,encoding:'utf8',windowsHide:true,timeout:60000,env:{...process.env,NODE_NO_WARNINGS:'1',FINANCE_BUSINESS_SESSION:'',WORKBENCH_DATABASE_MODE:'readwrite'}});
  assert.equal(made.status,0,made.stderr+'\n'+made.stdout);return readBaselineJson(join(root,'fixture.json'));
}

export async function startBaselineMcp(f,{sourceRoot=f.sourceRoot,auditDir=f.auditDir,sessionPath='',dbPath=f.dbPath,readOnly=false}={}){
  const client=new McpStdioClient(join(BASELINE_REPO_ROOT,'05-reconstruction/codex/mcp/finance-mcp/server.mjs'),{cwd:BASELINE_WORKBENCH_ROOT,timeoutMs:30000,env:{WORKBENCH_DATA_DIR:f.data,FINANCE_DATABASE_PATH:dbPath,FINANCE_SOURCE_ROOT:sourceRoot,FINANCE_AUDIT_DIR:auditDir,FINANCE_BUSINESS_SESSION:sessionPath,WORKBENCH_DATABASE_MODE:readOnly?'readonly':'readwrite',FINANCE_MCP_PROFILE:'direct',FINANCE_API_BASE:'http://127.0.0.1:1',NODE_NO_WARNINGS:'1'}}).start();
  await client.initialize('independent-business-baseline-cold-start');return client;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)&&process.argv[2]==='--seed'){
  const root=process.argv[3];if(!root||!isAbsolute(root))throw Error('baseline_fixture_absolute_root_required');await seedBaseline(root,{collisionOnly:process.argv[4]==='--collision-only',combinedVoucher:process.argv[4]==='--combined-voucher'});console.log(JSON.stringify({status:'cold_raw_fixture_created',root,modelInvoked:false,baselinePrewritten:false,methodPreselected:false,scriptPrewritten:false}));
}
