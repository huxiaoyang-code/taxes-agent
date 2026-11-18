// 混合原件综合夹具：账库只装准则/科目，历史分录、合同和申报数字均来自原始格式文件。
import assert from 'node:assert/strict';
import {copyFileSync,existsSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {join,resolve,isAbsolute,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {McpStdioClient} from '../../../05-reconstruction/codex/mcp/finance-mcp/mcp-stdio-client.mjs';
import {createContext,writeBundle} from '../../../05-reconstruction/codex/hosts/shared/config.mjs';
import {buildConfig} from '../../../05-reconstruction/codex/hosts/zcode/adapter.mjs';
import {prepareBoundBusinessSession} from '../../../05-reconstruction/codex/hosts/shared/business-session.mjs';
import {BASELINE_REPO_ROOT,BASELINE_WORKBENCH_ROOT,hashBaseline,readBaselineJson,writeBaselineJson} from './business-baseline-fixture.mjs';

export const MATERIAL_INTAKE_VERSION='synthetic-material-intake/3';
export const MATERIAL_HUMAN_REPLY='【合成人工确认，仅用于程序验收】首次库存发出计价自2026-10采用先进先出法，9月没有领用。其他历史租赁、维保口径继续沿用。本回复不是会计审批或申报授权。';
export const MATERIAL_INTAKE_EXPECTED=Object.freeze({
  historicalVat:{weightedRatio:0.02,minimumRatio:0.018,maximumRatio:0.021},
  september:{leaseRevenue:25000,cumulativeLeaseRevenue:45000,remainingLeaseRevenue:45000,vatSales:60000,maintenanceExpense:1000,maintenanceCumulative:3000,maintenanceRemaining:3000,inputVat:0,stockOpening:0,stockReceipt:10,stockIssue:0,stockClosing:10,stockClosingAmount:1000},
  october:{leaseRevenue:35000,cumulativeLeaseRevenue:80000,remainingLeaseRevenue:130000,vatSales:120000,maintenanceExpense:1000,maintenanceCumulative:4000,maintenanceRemaining:2000,inputVat:0,stockOpening:10,stockReceipt:10,stockIssue:15,stockIssueCost:2000,stockClosing:5,stockClosingAmount:1000},
});

export function materialTestPython(){
  const candidates=[process.env.FINANCE_TEST_PYTHON_PATH,process.env.FINANCE_PYTHON_PATH,'C:/Python314/python.exe','python'].filter(Boolean);
  for(const program of candidates){const result=spawnSync(program,['-c','import sys,xlrd,xlwt,openpyxl,fitz,docx,PIL;print(sys.executable)'],{encoding:'utf8',windowsHide:true,timeout:15000});if(result.status===0&&isAbsolute(result.stdout.trim()))return result.stdout.trim();}
  throw Error('material_intake_test_requires_python_xlrd_xlwt_openpyxl_fitz_docx_pillow');
}

export function createMaterialIntakeFixture(requestedRoot){
  const root=requestedRoot??mkdtempSync(join(tmpdir(),'material-intake-e2e-'));
  assert(isAbsolute(root)&&existsSync(root)&&readdirSync(root).length===0,'需要全新合成目录');
  const seeded=spawnSync(process.execPath,[fileURLToPath(import.meta.url),'--seed',root],{cwd:BASELINE_WORKBENCH_ROOT,encoding:'utf8',windowsHide:true,timeout:60000,env:{...process.env,NODE_NO_WARNINGS:'1',FINANCE_BUSINESS_SESSION:'',WORKBENCH_DATABASE_MODE:'readwrite'}});
  assert.equal(seeded.status,0,seeded.stderr+'\n'+seeded.stdout);
  const f=readBaselineJson(join(root,'fixture.json'));f.pythonPath=materialTestPython();
  const requestPath=join(f.reviewer,'generation-request.json');writeBaselineJson(requestPath,{root,owner:f.owner});
  const made=spawnSync(f.pythonPath,[fileURLToPath(new URL('./material-intake-files.py',import.meta.url)),requestPath],{cwd:BASELINE_WORKBENCH_ROOT,encoding:'utf8',windowsHide:true,timeout:60000});assert.equal(made.status,0,made.stderr+'\n'+made.stdout);
  const generated=readBaselineJson(join(f.reviewer,'mixed-files.json'));f.files=generated.files;f.historicalRowCount=generated.historicalRowCount;f.relevantHistoricalRows=generated.relevantHistoricalRows;
  f.originalHashes=Object.fromEntries(Object.entries(f.files).map(([key,path])=>[key,hashBaseline(readFileSync(path))]));
  f.published=['history'];f.expectedPath=join(f.reviewer,'独立预期.json');writeBaselineJson(f.expectedPath,MATERIAL_INTAKE_EXPECTED);
  f.humanReplyPath=join(f.reviewer,'合成人工答复.txt');writeFileSync(f.humanReplyPath,MATERIAL_HUMAN_REPLY+'\n');
  writeBaselineJson(join(root,'fixture.json'),f);return f;
}

export function publishMaterialIntakePacket(f,stage){
  assert(['recovery','september','confirmation','october','auxiliary'].includes(stage));assert(!f.published.includes(stage));
  const from=join(f.reviewer,'packets',stage),to=join(f.sourceRoot,stage);assert(existsSync(from)&&!existsSync(to));mkdirSync(to);
  for(const path of readdirSync(from)){const source=join(from,path),target=join(to,path);copyFileSync(source,target);for(const[key,current]of Object.entries(f.files))if(resolve(current)===resolve(source)){assert.equal(hashBaseline(readFileSync(target)),f.originalHashes[key]);f.files[key]=target;}}
  f.published.push(stage);writeBaselineJson(join(f.root,'fixture.json'),f);return to;
}

export async function prepareMaterialIntakeSession(f,period='2026-09'){
  const workspace=join(f.root,'workspace-'+period);
  if(!existsSync(workspace)){const context=createContext({nodePath:process.execPath,apiBase:'http://127.0.0.1:1',databasePath:f.dbPath,sourceRoot:f.sourceRoot,auditDir:f.auditDir,pythonPath:f.pythonPath,outputDir:workspace});writeBundle(context,buildConfig(context));}
  const bound=await prepareBoundBusinessSession(workspace,{accountSetId:f.accountSetId,period});assert.equal(bound.session.scope.accountSetId,f.accountSetId);assert.equal(bound.session.scope.period,period);return bound.path;
}

export async function startMaterialIntakeMcp(f,{sourceRoot=f.sourceRoot,readOnly=false,bound=false,period='2026-09'}={}){
  const sessionPath=bound?await prepareMaterialIntakeSession(f,period):'';
  const client=new McpStdioClient(join(BASELINE_REPO_ROOT,'05-reconstruction/codex/mcp/finance-mcp/server.mjs'),{cwd:BASELINE_WORKBENCH_ROOT,timeoutMs:60000,env:{WORKBENCH_DATA_DIR:f.data,FINANCE_DATABASE_PATH:f.dbPath,FINANCE_SOURCE_ROOT:sourceRoot,FINANCE_AUDIT_DIR:f.auditDir,FINANCE_BUSINESS_SESSION:sessionPath,WORKBENCH_DATABASE_MODE:readOnly?'readonly':'readwrite',FINANCE_MCP_PROFILE:'direct',FINANCE_PYTHON_PATH:f.pythonPath,FINANCE_API_BASE:'http://127.0.0.1:1',NODE_NO_WARNINGS:'1'}}).start();
  await client.initialize('synthetic-material-intake-acceptance');return client;
}

// 独立试用只授权合同、税表及失败导出；原BIFF参照、脚本和预期均在授权根之外。
export async function prepareMaterialRecoveryTrial(requestedRoot){
  const reference=createMaterialIntakeFixture(),root=requestedRoot??mkdtempSync(join(tmpdir(),'material-recovery-trial-'));assert(isAbsolute(root)&&existsSync(root)&&readdirSync(root).length===0,'独立试用需要全新合成目录');
  const seeded=spawnSync(process.execPath,[fileURLToPath(import.meta.url),'--seed',root],{cwd:BASELINE_WORKBENCH_ROOT,encoding:'utf8',windowsHide:true,timeout:60000,env:{...process.env,NODE_NO_WARNINGS:'1',FINANCE_BUSINESS_SESSION:'',WORKBENCH_DATABASE_MODE:'readwrite'}});assert.equal(seeded.status,0,seeded.stderr+'\n'+seeded.stdout);
  const f=readBaselineJson(join(root,'fixture.json'));f.pythonPath=reference.pythonPath;
  for(const key of['oldLease','maintenance','tax','fallbackHistory']){const target=join(f.sourceRoot,basename(reference.files[key]));copyFileSync(reference.files[key],target);assert.equal(hashBaseline(readFileSync(target)),reference.originalHashes[key]);}
  const sessionPath=await prepareMaterialIntakeSession(f),descriptor={version:'material-recovery-trial/1',serverPath:join(BASELINE_REPO_ROOT,'05-reconstruction/codex/mcp/finance-mcp/server.mjs'),cwd:BASELINE_WORKBENCH_ROOT,target:materialTarget(f),environment:{WORKBENCH_DATA_DIR:f.data,FINANCE_DATABASE_PATH:f.dbPath,FINANCE_SOURCE_ROOT:f.sourceRoot,FINANCE_AUDIT_DIR:f.auditDir,FINANCE_BUSINESS_SESSION:sessionPath,FINANCE_PYTHON_PATH:f.pythonPath,FINANCE_MCP_PROFILE:'direct',WORKBENCH_DATABASE_MODE:'readwrite',FINANCE_API_BASE:'http://127.0.0.1:1',NODE_NO_WARNINGS:'1'},modelInvoked:false,businessToolsInvoked:false,containsMappingOrOracle:false};
  const connectionPath=join(f.root,'recovery-connection.json');writeBaselineJson(connectionPath,descriptor);return{connectionPath,...descriptor,privateOraclePath:reference.expectedPath};
}

const cell=(row,column,sheetIndex=0)=>({sheetIndex,row,column,headerRows:[1]});
const line=(page,line,after)=>({page,line,valueSlice:{after}});
const identity=(locator,role='enterprise',taxId)=>({role,name:locator,...(taxId?{taxId}:{})});
export const materialTarget=(f,period='2026-09')=>({accountSetId:f.accountSetId,period});
export const materialReference=m=>({materialRef:m.materialRef,snapshotDigest:m.snapshotDigest});

// 测试方显式适配，只证明接口可从原件取值；不冒称模型自主识别或企业人工确认。
export function historicalMaterialRequest(f){
  const originals=[
    {id:'lease_history',path:f.files.oldLease,ownerIdentity:identity(line(1,1,'Entity: '))},
    {id:'maintenance_history',path:f.files.maintenance,ownerIdentity:identity(line(1,1,'Entity: '))},
    {id:'journal',path:f.files.historicalEntries,ownerIdentity:identity(cell(2,1))},
    {id:'tax',path:f.files.tax,ownerIdentity:identity(cell(2,1))},
  ];
  const selections=[...contractSelections('lease_history','lease'),...contractSelections('maintenance_history','maintenance')];
  for(const row of[2,3])for(const[field,column]of Object.entries({tax_type:2,tax_measure:3,tax_stage:4,period_basis:5,accumulation:6,period_start:7,period_end:8,sales_ex_vat:9,tax_amount:10}))selections.push({id:'tax_'+row+'_'+field,originalId:'tax',field,locator:cell(row,column),ownerIdentity:identity(cell(row,1))});
  // 整份历史导出按原行观察；未映射科目不能阻塞其他已核分录，也不能冒充已知归集。
  const historicalRows=Array.from({length:f.historicalRowCount},(_,index)=>index+2).map(row=>({id:'history_'+row,originalId:'journal',period:cell(row,2),date:cell(row,3),businessReference:cell(row,4),code:cell(row,5),accountName:cell(row,6),debit:cell(row,7),credit:cell(row,8),ownerIdentity:identity(cell(row,1))}));
  return{target:materialTarget(f),originals,selections,historicalRows,section:'overview',limit:50};
}

function contractSelections(originalId,kind,page=1){
  const maintenance=kind==='maintenance',fields=maintenance?{business_reference:[2,'Contract: '],business_kind:[3,'Activity: '],service_pattern:[4,'Pattern: '],service_start:[5,'Service From: '],service_end:[6,'Service Through: '],amount_net:[7,'Net Fee: '],amount_tax:[8,'Tax: '],amount_gross:[9,'Gross Fee: '],invoice_date:[10,'Invoice On: '],payment_date:[11,'Paid On: '],confirmation_date:[12,'Input Confirmed On: '],creates_asset:[13,'Asset Creation: ']}:{business_reference:[2,'Contract: '],business_kind:[3,'Activity: '],service_pattern:[4,'Pattern: '],service_start:[5,'Service From: '],service_end:[6,'Service Through: '],amount_net:[7,'Net Rent: '],amount_tax:[8,'Tax: '],invoice_date:[9,'Invoice On: '],receipt_date:[10,'Cash On: '],contract_due_date:[11,'Due On: '],creates_asset:[12,'Asset Creation: ']};
  return Object.entries(fields).map(([field,[row,after]])=>({id:originalId+'_'+kind+'_'+field,originalId,field,locator:line(page,row,after),...(['business_kind','service_pattern','creates_asset'].includes(field)?{interpretation:{value:field==='business_kind'?kind:field==='creates_asset'?false:'even_service',reason:field==='business_kind'?'将原件英文业务描述映射到对应受限业务类型':field==='creates_asset'?'原件明确No，不形成资产':'原件明确每个日历月均匀提供'}}:{})}));
}

export function currentMaterialRequest(f,period){
  const october=period==='2026-10',originals=[{id:'lease_sep',path:f.files.newLeaseSeptember,ownerIdentity:identity(line(1,1,'Entity: '))},{id:'stock',path:f.files[october?'stockOctober':'stockSeptember'],ownerIdentity:identity(cell(2,1))}],selections=[...contractSelections('lease_sep','lease')];
  if(october){originals.push({id:'lease_oct',path:f.files.newLeaseOctober,ownerIdentity:identity(line(1,1,'Entity: '))});selections.push(...contractSelections('lease_oct','lease'));}
  for(const[field,column]of Object.entries({business_kind:2,period_start:3,period_end:4,opening_quantity:5,opening_unit_price:6,receipt_quantity:7,receipt_unit_price:8,issue_quantity:9}))selections.push({id:'stock_'+field,originalId:'stock',field,locator:cell(2,column),...(field==='business_kind'?{interpretation:{value:'inventory',reason:'原件描述维修备件库存，属于存货收发'}}:{})});
  return{target:materialTarget(f,period),originals,selections,section:'overview',limit:50};
}

export function choiceMaterialRequest(f){return{target:materialTarget(f),originals:[{id:'choice',path:f.files.inventoryChoice,ownerIdentity:identity(cell(2,1))}],selections:[{id:'choice_kind',originalId:'choice',field:'business_kind',locator:cell(2,2),interpretation:{value:'inventory',reason:'合成人工回复明确针对维修备件首次计价'}},{id:'choice_method',originalId:'choice',field:'inventory_cost',locator:cell(2,3)},{id:'choice_from',originalId:'choice',field:'choice_valid_from',locator:cell(2,4)}],section:'overview',limit:50};}

export function invoiceMaterialRequests(f){return[
  {target:materialTarget(f),originals:[{id:'sale_invoice',path:f.files.saleInvoice,ownerIdentity:identity(cell(2,1),'seller',cell(2,2))}],selections:[['amount_net',7],['amount_tax',8],['amount_gross',9],['invoice_date',6],['business_reference',10]].map(([field,column])=>({id:'sale_'+field,originalId:'sale_invoice',field,locator:cell(2,column)})),section:'overview',limit:50},
  {target:materialTarget(f),originals:[{id:'purchase_invoice',path:f.files.purchaseInvoice,ownerIdentity:identity({row:3,column:2,sheetIndex:0},'buyer',{row:4,column:2,sheetIndex:0})}],selections:[['amount_net',7],['amount_tax',8],['amount_gross',9],['invoice_date',6],['business_reference',5]].map(([field,row])=>({id:'purchase_'+field,originalId:'purchase_invoice',field,locator:{row,column:2,sheetIndex:0}})),section:'overview',limit:50},
];}

async function seed(root){
  const data=join(root,'data'),sourceRoot=join(root,'originals'),reviewer=join(root,'reviewer-only'),auditDir=join(root,'finance-call-records');for(const path of[data,sourceRoot,reviewer])mkdirSync(path,{recursive:true});
  const dbPath=join(data,'workbench.db');Object.assign(process.env,{WORKBENCH_DATA_DIR:data,FINANCE_DATABASE_PATH:dbPath,FINANCE_SOURCE_ROOT:sourceRoot,FINANCE_AUDIT_DIR:auditDir});delete process.env.FINANCE_BUSINESS_SESSION;
  const A=await import('../../server/accounting.mjs'),{db}=await import('../../server/db.mjs');
  const owner={enterpriseKey:'SYNTHETIC-MATERIAL-2026',companyName:'SYNTHETIC_MATERIAL_LEASE_COMPANY'};
  try{
    const accountSetId=A.createAccountSet({name:owner.companyName,taxpayer_type:'一般纳税人',profileId:'enterprise-2019-general-basic-v1',start_period:'2026-07',enterprise:{enterpriseKey:owner.enterpriseKey,enterpriseName:owner.companyName}}).id;
    assert.equal(db.prepare('SELECT enterprise_name FROM import_enterprise_account_sets WHERE enterprise_key=? AND account_set_id=?').get(owner.enterpriseKey,accountSetId).enterprise_name,owner.companyName,'合成账套须完成真实登记，不能拿显示名称冒充受信企业名');
    for(const[code,name,category,direction]of[['605101','闲置仓库经营出租收入','损益','credit'],['660201','管理系统运维费','损益','debit'],['112301','预付运维服务','资产','debit'],['222101','应交增值税销项税额','负债','credit'],['222102','应交增值税已确认进项','负债','credit']])A.addAccount(accountSetId,{code,name,category,direction});
    assert.equal(db.prepare('SELECT COUNT(*) n FROM vouchers').get().n,0,'历史观察必须来自混合原件，不能预置历史凭证');
    const f={version:MATERIAL_INTAKE_VERSION,root,data,sourceRoot,reviewer,auditDir,dbPath,accountSetId,owner,modelInvoked:false,formalPostingInvoked:false};writeBaselineJson(join(root,'fixture.json'),f);
  }finally{db.close();}
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv[2]==='--seed')await seed(process.argv[3]);
  else if(process.argv[2]==='--prepare'){const f=createMaterialIntakeFixture(process.argv[3]);console.log(JSON.stringify({root:f.root,dbPath:f.dbPath,sourceRoot:f.sourceRoot,auditDir:f.auditDir,accountSetId:f.accountSetId,pythonPath:f.pythonPath,modelInvoked:false,oracleInsideSourceRoot:false}));}
  else if(process.argv[2]==='--prepare-recovery'){const{privateOraclePath,...connection}=await prepareMaterialRecoveryTrial(process.argv[3]);console.log(JSON.stringify(connection,null,2));}
}
