// 单一合成账套的纵向验收材料；预期、未来原件与人工答复均留在模型授权根之外。
import assert from 'node:assert/strict';
import {mkdirSync,readFileSync,writeFileSync,existsSync,readdirSync,copyFileSync} from 'node:fs';
import {join,resolve,isAbsolute,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {syntheticVoucherEvidence} from './synthetic-posting-evidence.mjs';
import {BASELINE_REPO_ROOT,BASELINE_WORKBENCH_ROOT,hashBaseline,readBaselineJson,writeBaselineJson} from './business-baseline-fixture.mjs';

export {BASELINE_REPO_ROOT,BASELINE_WORKBENCH_ROOT,hashBaseline,readBaselineJson,writeBaselineJson};
export const LONGITUDINAL_VERSION='synthetic-business-baseline-longitudinal/1';
export const LONGITUDINAL_HUMAN_REPLY='【合成人工回复，仅用于本机验收】首次库存发出计价自2026-10起采用先进先出法；9月未领用，其他已核租赁、维保口径继续沿用。本回复确认企业业务口径，不是正式凭证或申报审批。';

const oldAtoms=[
  {id:'K1',kind:'accounting_standard',value:'enterprise',when:'account_set',condition:'本账套采用企业会计准则'},
  {id:'K2',kind:'business_classification',value:'other_income',when:'lease',condition:'本企业闲置仓库经营出租收入'},
  {id:'K3',kind:'business_classification',value:'actual_use_expense',when:'maintenance',condition:'不形成资产的日常运维按实际管理用途归集'},
  {id:'K4',kind:'revenue_period',value:'service_period',when:'lease',allocationBasis:'monthly_equal',condition:'已交付、无免租变更、整月均匀提供使用权；终止后不继续确认'},
  {id:'K5',kind:'expense_period',value:'benefit_period',when:'maintenance',allocationBasis:'monthly_equal',equivalent:{kind:'cost_treatment',value:'allocate_benefit_period'},condition:'非资产、整月均匀受益的服务；不套用于其他服务'},
  {id:'K6',kind:'vat_output_period',value:'advance_invoice_period',when:'lease',condition:'同类租赁预收并提前全额开票；归原开票期，后续月不重复'},
  {id:'K7',kind:'vat_input_period',value:'confirmation_period',when:'maintenance',condition:'合规且具备抵扣条件，归用途确认期；分摊费用不重复抵扣'},
  {id:'K8',kind:'historical_vat_reference',condition:'7/8月减免后应纳、所属期、本期、可比不含税销售额加权2.00%；仅参考不倒挤'},
];
const fifoAtom={id:'K9',kind:'inventory_cost',value:'fifo',when:['account_set','inventory'],effectiveFrom:'2026-10',condition:'首次采用，10月起存货发出；不得回写9月或租赁/维保口径'};
const historyLease={key:'L7',start:'2026-07-01',end:'2026-09-30',net:30000};
const septemberLease={key:'L9',start:'2026-09-01',end:'2026-12-31',net:60000};
const octoberLease={key:'L10',start:'2026-10-01',end:'2027-03-31',net:120000};
export const LONGITUDINAL_EXPECTED={
  version:'longitudinal-independent-oracle/1',atoms:[...oldAtoms,fifoAtom],applicableAtoms:{'2026-09':oldAtoms.map(a=>a.id),'2026-10':[...oldAtoms.map(a=>a.id),'K9']},
  opportunities:{
    '2026-09':[{id:'class.lease',atom:'K2'},{id:'class.maintenance',atom:'K3'},{id:'revenue.L7',atom:'K4'},{id:'revenue.L9',atom:'K4'},{id:'expense.M7',atom:'K5'},{id:'vat.L7',atom:'K6'},{id:'vat.L9',atom:'K6'},{id:'input.M7',atom:'K7'}],
    '2026-10':[{id:'class.lease',atom:'K2'},{id:'class.maintenance',atom:'K3'},{id:'revenue.L7',atom:'K4'},{id:'revenue.L9',atom:'K4'},{id:'revenue.L10',atom:'K4'},{id:'expense.M7',atom:'K5'},{id:'vat.L7',atom:'K6'},{id:'vat.L9',atom:'K6'},{id:'vat.L10',atom:'K6'},{id:'input.M7',atom:'K7'},{id:'inventory.issue_and_closing',atom:'K9'}],
  },
  contextGates:['K1'],reportGates:['K8'],vatHistory:{periods:['2026-07','2026-08'],sales:[100000,200000],payable:[1800,4200],sumSales:300000,sumPayable:6000,weightedRatio:0.02,minimumRatio:0.018,maximumRatio:0.021,stage:'payable_after_relief',periodBasis:'attribution',measure:'payable',accumulation:'current'},
  contracts:[historyLease,septemberLease,octoberLease],
  months:{
    '2026-07':{leaseRevenue:10000,cumulativeLeaseRevenue:10000,unearnedLeaseBalance:20000,maintenanceExpense:1000,cumulativeMaintenanceExpense:1000,maintenancePrepayment:5000,leaseVatSales:30000,maintenanceInputVat:360},
    '2026-08':{leaseRevenue:10000,cumulativeLeaseRevenue:20000,unearnedLeaseBalance:10000,maintenanceExpense:1000,cumulativeMaintenanceExpense:2000,maintenancePrepayment:4000,leaseVatSales:0,maintenanceInputVat:0},
    '2026-09':{leaseRevenue:25000,cumulativeLeaseRevenue:45000,unearnedLeaseBalance:45000,maintenanceExpense:1000,cumulativeMaintenanceExpense:3000,maintenancePrepayment:3000,leaseVatSales:60000,maintenanceInputVat:0,inventory:{openingQuantity:0,openingAmount:0,receiptQuantity:10,receiptAmount:1000,issueQuantity:0,issueCost:0,closingQuantity:10,closingAmount:1000},contracts:{L7:{periodRevenue:10000,cumulativeRevenue:30000,remainingRevenue:0,periodVatSales:0},L9:{periodRevenue:15000,cumulativeRevenue:15000,remainingRevenue:45000,periodVatSales:60000}}},
    '2026-10':{leaseRevenue:35000,cumulativeLeaseRevenue:80000,unearnedLeaseBalance:130000,maintenanceExpense:1000,cumulativeMaintenanceExpense:4000,maintenancePrepayment:2000,leaseVatSales:120000,maintenanceInputVat:0,inventory:{openingQuantity:10,openingAmount:1000,receiptQuantity:10,receiptAmount:2000,issueQuantity:15,issueCost:2000,closingQuantity:5,closingAmount:1000},contracts:{L7:{periodRevenue:0,cumulativeRevenue:30000,remainingRevenue:0,periodVatSales:0},L9:{periodRevenue:15000,cumulativeRevenue:30000,remainingRevenue:30000,periodVatSales:0},L10:{periodRevenue:20000,cumulativeRevenue:20000,remainingRevenue:100000,periodVatSales:120000}}},
  },
  rules:{recallDenominators:{'2026-09':8,'2026-10':9},applicationDenominators:{'2026-09':8,'2026-10':11},expectedBaselineVersions:2,baselineMaximumUnicode:600,residentMaximumUnicode:1000,maximumPrincipleLines:8,maximumUnresolved:3,oldHistoryRelearningIsNotReuse:true,backendHashVerificationIsNotAgentReread:true,activeCrossPeriodContractDetailsAreAllowed:true,financialAmountsMustMatch:true,approval:'candidate_only_not_human_accounting_approval'},
};

function packets(owner){
  const lease=(id,start,end,amount,tax)=>({...owner,合同编号:id,业务类别:'租赁',说明:'闲置仓库房屋经营出租',提供方式:'均匀连续服务',服务开始日:start,服务结束日:end,净租金:amount,发票税额:tax,开票日:start,收款日:start,合同约定付款日:start,交付情况:'起始日已交付，整月连续均匀使用，无免租、变更、可变租金或额外履约条件',是否形成承租人资产:false});
  return {
    history:{'旧仓库租赁.json':lease('LONG-LEASE-JUL','2026-07-01','2026-09-30',30000,2700),'运维合同及确认记录.json':{...owner,合同编号:'LONG-MAINT-JUL',业务类别:'维保',说明:'软件系统日常运维',提供方式:'每月等量连续维护',服务开始日:'2026-07-01',服务结束日:'2026-12-31',净价:6000,发票税额:360,含税金额:6360,开票日:'2026-07-01',付款日:'2026-07-01',用途确认日:'2026-07-18',是否形成或改良资产:false,用途:'企业管理系统日常运维，不形成或改良资产；合规专票已按管理用途确认可抵扣'},'历史增值税申报导出.json':{...owner,说明:'全企业已申报口径，账库仅选本次代表性合同；不据局部分录重算全企业申报',行:[{税种:'增值税',税额口径:'应纳',税额阶段:'减免后应纳',期间口径:'所属期',累计口径:'本期',所属期起:'2026-07',所属期止:'2026-07',不含税应税销售额:100000,应纳税额:1800},{税种:'增值税',税额口径:'应纳',税额阶段:'减免后应纳',期间口径:'所属期',累计口径:'本期',所属期起:'2026-08',所属期止:'2026-08',不含税应税销售额:200000,应纳税额:4200}]}},
    september:{'九月新仓库租赁.json':lease('LONG-LEASE-SEP','2026-09-01','2026-12-31',60000,5400),'九月首次库存收发单.json':{...owner,业务类别:'inventory',说明:'首次购入的维修备件，本月未领用；企业尚未确定首次发出计价口径',所属期起:'2026-09',所属期止:'2026-09',期初数量:0,期初单价:0,本月购入数量:10,本月购入单价:100,本月领用数量:0}},
    confirmation:{'首次存货计价的人工确认.json':{...owner,业务类别:'inventory',既有计价设置:'先进先出法',有效开始日:'2026-10-01',说明:'首次采用，自10月起；9月未发生领用，其他已核租赁及维保口径保持。来自实际问询后标记的合成人工答复，不是正式凭证审批。'}},
    october:{'十月新仓库租赁.json':lease('LONG-LEASE-OCT','2026-10-01','2027-03-31',120000,10800),'十月库存收发单.json':{...owner,业务类别:'inventory',说明:'本月维修备件收发；本单不提供计价方法',所属期起:'2026-10',所属期止:'2026-10',期初数量:10,期初单价:100,本月购入数量:10,本月购入单价:200,本月领用数量:15}},
  };
}

export function createLongitudinalFixture(root){
  assert(isAbsolute(root)&&existsSync(root)&&readdirSync(root).length===0,'longitudinal_fixture_requires_new_absolute_empty_directory');
  const result=spawnSync(process.execPath,[fileURLToPath(import.meta.url),'--seed',root],{cwd:BASELINE_WORKBENCH_ROOT,encoding:'utf8',windowsHide:true,timeout:60000,env:{...process.env,NODE_NO_WARNINGS:'1',FINANCE_BUSINESS_SESSION:'',WORKBENCH_DATABASE_MODE:'readwrite'}});assert.equal(result.status,0,result.stderr+'\n'+result.stdout);return readBaselineJson(join(root,'fixture.json'));
}
async function seed(root){
  const data=join(root,'data'),sourceRoot=join(root,'originals'),auditDir=join(root,'finance-call-records'),reviewer=join(root,'reviewer-only'),driver=join(reviewer,'driver');for(const dir of [data,sourceRoot,driver])mkdirSync(dir,{recursive:true});
  const dbPath=join(data,'workbench.db');Object.assign(process.env,{WORKBENCH_DATA_DIR:data,FINANCE_DATABASE_PATH:dbPath,FINANCE_SOURCE_ROOT:sourceRoot,FINANCE_AUDIT_DIR:auditDir});delete process.env.FINANCE_BUSINESS_SESSION;delete process.env.WORKBENCH_DATABASE_MODE;
  const A=await import('../../server/accounting.mjs'),{db}=await import('../../server/db.mjs'),owner={enterpriseKey:'SYNTHETIC-LONGITUDINAL-2026',companyName:'LOCAL_ONLY_SYNTHETIC_纵向仓库出租及运维'};
  const a=A.createAccountSet({name:owner.companyName,taxpayer_type:'一般纳税人',profileId:'enterprise-2019-general-basic-v1',start_period:'2026-07',enterprise:{enterpriseKey:owner.enterpriseKey}}).id;
  const f={version:LONGITUDINAL_VERSION,root,data,dbPath,sourceRoot,auditDir,reviewer,driver,a,owner,originalPaths:[],packetPaths:{},historicalVoucherIds:[],modelInvoked:false};
  try{
    for(const [code,name,category,direction]of [['605101','闲置仓库经营出租收入','损益','credit'],['660201','管理系统运维费','损益','debit'],['112301','预付运维服务','资产','debit'],['222101','应交增值税销项税额','负债','credit'],['222102','应交增值税已确认进项','负债','credit']])A.addAccount(a,{code,name,category,direction});
    const packetRoot=join(driver,'packets');mkdirSync(packetRoot);for(const [stage,body]of Object.entries(packets(owner))){const path=join(packetRoot,stage+'.json');writeBaselineJson(path,body);f.packetPaths[stage]=path;}
    const history=readBaselineJson(f.packetPaths.history),historyDir=join(sourceRoot,'history');mkdirSync(historyDir);for(const [name,body]of Object.entries(history)){const path=join(historyDir,name);writeBaselineJson(path,body);f.originalPaths.push(path);}
    const leasePath=join(historyDir,'旧仓库租赁.json'),maintenancePath=join(historyDir,'运维合同及确认记录.json'),numbers=new Map();
    const voucher=(period,day,summary,entries,path,pointer)=>{const number=(numbers.get(period)??0)+1;numbers.set(period,number);const reference=readBaselineJson(path)[pointer.slice(1)];entries=entries.map(e=>({...e,summary:reference}));const input=syntheticVoucherEvidence({period,voucher_date:period+'-'+day,number,status:'posted',summary,entries},join(historyDir,'原生凭证依据'));for(let i=0;i<entries.length;i++)input.businessEvidence.mappings.push({inputPointer:'/entries/'+i+'/summary',parameterLabel:'历史分录真实合同编号',transform:'identity',sources:[{path,jsonPointer:pointer}]});for(const source of input.businessEvidence.mappings.flatMap(m=>m.sources))if(source.path&&!f.originalPaths.includes(source.path))f.originalPaths.push(source.path);f.historicalVoucherIds.push(A.createVoucher(a,input).id);};
    voucher('2026-07','01','仓库全额预收并开票',[{code:'1002',debit:32700},{code:'2203',credit:30000},{code:'222101',credit:2700}],leasePath,'/合同编号');
    voucher('2026-07','18','预付半年运维及一次用途确认进项',[{code:'112301',debit:6000},{code:'222102',debit:360},{code:'1002',credit:6360}],maintenancePath,'/合同编号');
    for(const period of ['2026-07','2026-08']){voucher(period,'28','整月均匀提供仓库使用权',[{code:'2203',debit:10000},{code:'605101',credit:10000}],leasePath,'/合同编号');voucher(period,'28','管理用途运维服务当月均匀受益',[{code:'660201',debit:1000},{code:'112301',credit:1000}],maintenancePath,'/合同编号');}
    db.prepare("UPDATE periods SET status='closed' WHERE account_set_id=? AND period IN ('2026-07','2026-08')").run(a);
    const names=new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r=>r.name));if(names.has('business_memory_versions'))assert.equal(db.prepare('SELECT COUNT(*) n FROM business_memory_versions').get().n,0);assert.equal(db.prepare('SELECT COUNT(*) n FROM account_sets').get().n,1);
    f.expectedPath=join(driver,'独立预期与分母.json');writeBaselineJson(f.expectedPath,LONGITUDINAL_EXPECTED);f.replyPath=join(driver,'合成人工答复.txt');writeFileSync(f.replyPath,LONGITUDINAL_HUMAN_REPLY+'\n');writeBaselineJson(join(root,'fixture.json'),f);return f;
  }finally{db.close();}
}

// 发布只追加新文件；原历史依据不移动、不改SHA。未来包与预期永远不在sourceRoot。
export function publishLongitudinalPacket(f,stage){
  assert(['september','confirmation','october'].includes(stage));const packet=readBaselineJson(f.packetPaths[stage]),dir=join(f.sourceRoot,stage);assert(!existsSync(dir),'longitudinal_packet_already_published');mkdirSync(dir);const files=[];
  for(const [name,body]of Object.entries(packet)){assert(!name.includes('/')&&!name.includes('\\'));const path=join(dir,name);writeBaselineJson(path,body);files.push({path,sha256:hashBaseline(readFileSync(path))});}return files;
}
export function assertLongitudinalCold(f){
  const db=new DatabaseSync(f.dbPath,{readOnly:true});try{const tables=new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r=>r.name));if(tables.has('business_memory_versions'))assert.equal(db.prepare('SELECT COUNT(*) n FROM business_memory_versions').get().n,0);assert.equal(db.prepare('SELECT COUNT(*) n FROM account_sets').get().n,1);}finally{db.close();}
  for(const path of f.originalPaths)assert(!/recognition_method|rentalDefinition|methodRef|baselineRef|"principles"|"shortText"|既有计价设置/.test(readFileSync(path,'utf8')),'历史原件不得预置基线/库存方法');for(const stage of ['september','confirmation','october'])assert(!existsSync(join(f.sourceRoot,stage)));return {baselinePrewritten:false,inventoryPolicyPrewritten:false,futureDataReleased:false};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)&&process.argv[2]==='--seed'){await seed(process.argv[3]);console.log(JSON.stringify({status:'longitudinal_raw_history_seeded',modelInvoked:false}));}
