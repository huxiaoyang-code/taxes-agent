// 混合原件综合夹具：账库只装准则/科目，历史分录、合同和申报数字均来自原始格式文件。
import assert from 'node:assert/strict';
import {copyFileSync,existsSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {join,resolve,isAbsolute,relative} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {McpStdioClient} from '../../../05-reconstruction/codex/mcp/finance-mcp/mcp-stdio-client.mjs';
import {createContext,writeBundle} from '../../../05-reconstruction/codex/hosts/shared/config.mjs';
import {buildConfig} from '../../../05-reconstruction/codex/hosts/zcode/adapter.mjs';
import {prepareBoundBusinessSession} from '../../../05-reconstruction/codex/hosts/shared/business-session.mjs';
import {BASELINE_REPO_ROOT,BASELINE_WORKBENCH_ROOT,hashBaseline,readBaselineJson,writeBaselineJson} from './business-baseline-fixture.mjs';

export const MATERIAL_INTAKE_VERSION='synthetic-material-intake/4';
export const MATERIAL_HUMAN_REPLY='【合成人工确认，仅用于程序验收】首次库存发出计价自2026-10采用先进先出法，9月没有领用。其他历史租赁、维保口径继续沿用。本回复不是会计审批或申报授权。';
export const MATERIAL_INTAKE_EXPECTED=Object.freeze({
  historicalVat:{weightedRatio:0.02,minimumRatio:0.018,maximumRatio:0.021},
  september:{leaseRevenue:25000,cumulativeLeaseRevenue:45000,remainingLeaseRevenue:45000,vatSales:60000,maintenanceExpense:1000,maintenanceCumulative:3000,maintenanceRemaining:3000,inputVat:0,stockOpening:0,stockReceipt:10,stockIssue:0,stockClosing:10,stockClosingAmount:1000},
  october:{leaseRevenue:35000,cumulativeLeaseRevenue:80000,remainingLeaseRevenue:130000,vatSales:120000,maintenanceExpense:1000,maintenanceCumulative:4000,maintenanceRemaining:2000,inputVat:0,stockOpening:10,stockReceipt:10,stockIssue:15,stockIssueCost:2000,stockClosing:5,stockClosingAmount:1000},
});

export function materialTestPython(){
  const candidates=[process.env.FINANCE_TEST_PYTHON_PATH,process.env.FINANCE_PYTHON_PATH,'C:/Python314/python.exe','python'].filter(Boolean);
  for(const program of candidates){const result=spawnSync(program,['-c','import sys,xlrd,openpyxl,fitz;print(sys.executable)'],{encoding:'utf8',windowsHide:true,timeout:15000});if(result.status===0&&isAbsolute(result.stdout.trim()))return result.stdout.trim();}
  throw Error('material_intake_test_requires_host_python_xlrd_openpyxl_fitz');
}

export function createMaterialIntakeFixture(requestedRoot){
  const root=requestedRoot??mkdtempSync(join(tmpdir(),'material-intake-e2e-'));
  assert(isAbsolute(root)&&existsSync(root)&&readdirSync(root).length===0,'需要全新合成目录');
  const seeded=spawnSync(process.execPath,[fileURLToPath(import.meta.url),'--seed',root],{cwd:BASELINE_WORKBENCH_ROOT,encoding:'utf8',windowsHide:true,timeout:60000,env:{...process.env,NODE_NO_WARNINGS:'1',FINANCE_BUSINESS_SESSION:'',WORKBENCH_DATABASE_MODE:'readwrite'}});
  assert.equal(seeded.status,0,seeded.stderr+'\n'+seeded.stdout);
  const f=readBaselineJson(join(root,'fixture.json'));f.pythonPath=materialTestPython();
  const requestPath=join(f.reviewer,'generation-request.json');writeBaselineJson(requestPath,{root,owner:f.owner});
  const made=spawnSync(f.pythonPath,[fileURLToPath(new URL('./material-intake-files.py',import.meta.url)),requestPath],{cwd:BASELINE_WORKBENCH_ROOT,encoding:'utf8',windowsHide:true,timeout:60000});assert.equal(made.status,0,made.stderr+'\n'+made.stdout);
  const generated=readBaselineJson(join(f.reviewer,'mixed-files.json'));f.files=generated.files;f.historicalRowCount=generated.historicalRowCount;
  f.originalHashes=Object.fromEntries(Object.entries(f.files).map(([key,path])=>[key,hashBaseline(readFileSync(path))]));
  f.published=['history'];f.expectedPath=join(f.reviewer,'独立预期.json');writeBaselineJson(f.expectedPath,MATERIAL_INTAKE_EXPECTED);
  f.humanReplyPath=join(f.reviewer,'合成人工答复.txt');writeFileSync(f.humanReplyPath,MATERIAL_HUMAN_REPLY+'\n');
  writeBaselineJson(join(root,'fixture.json'),f);return f;
}

export function publishMaterialIntakePacket(f,stage){
  assert(['september','confirmation','october'].includes(stage));assert(!f.published.includes(stage));
  const from=join(f.reviewer,'packets',stage),to=join(f.sourceRoot,stage);assert(existsSync(from)&&!existsSync(to));mkdirSync(to);
  for(const path of readdirSync(from)){const source=join(from,path),target=join(to,path);copyFileSync(source,target);for(const[key,current]of Object.entries(f.files))if(resolve(current)===resolve(source)){assert.equal(hashBaseline(readFileSync(target)),f.originalHashes[key]);f.files[key]=target;}}
  f.published.push(stage);writeBaselineJson(join(f.root,'fixture.json'),f);return to;
}

export async function prepareMaterialIntakeSession(f,period='2026-09'){
  const workspace=join(f.root,'workspace-'+period);
  if(!existsSync(workspace)){const context=createContext({nodePath:process.execPath,apiBase:'http://127.0.0.1:1',databasePath:f.dbPath,sourceRoot:f.sourceRoot,auditDir:f.auditDir,outputDir:workspace});writeBundle(context,buildConfig(context));}
  const bound=await prepareBoundBusinessSession(workspace,{accountSetId:f.accountSetId,period});assert.equal(bound.session.scope.accountSetId,f.accountSetId);assert.equal(bound.session.scope.period,period);return bound.path;
}

export async function startMaterialIntakeMcp(f,{sourceRoot=f.sourceRoot,readOnly=false,bound=false,period='2026-09'}={}){
  const sessionPath=bound?await prepareMaterialIntakeSession(f,period):'';
  const client=new McpStdioClient(join(BASELINE_REPO_ROOT,'05-reconstruction/codex/mcp/finance-mcp/server.mjs'),{cwd:BASELINE_WORKBENCH_ROOT,timeoutMs:60000,env:{WORKBENCH_DATA_DIR:f.data,FINANCE_DATABASE_PATH:f.dbPath,FINANCE_SOURCE_ROOT:sourceRoot,FINANCE_AUDIT_DIR:f.auditDir,FINANCE_BUSINESS_SESSION:sessionPath,WORKBENCH_DATABASE_MODE:readOnly?'readonly':'readwrite',FINANCE_MCP_PROFILE:'direct',FINANCE_PYTHON_PATH:join(f.root,'unavailable-backend-python.exe'),FINANCE_API_BASE:'http://127.0.0.1:1',NODE_NO_WARNINGS:'1'}}).start();
  await client.initialize('synthetic-material-intake-acceptance');return client;
}

const stageFiles={
  history:['historyJuly','historyAugust','oldAssets','oldLease','maintenance','tax'],
  september:['newLeaseSeptember','stockSeptember'],
  confirmation:['inventoryChoice'],
  october:['newLeaseSeptember','newLeaseOctober','stockOctober'],
  invoices:['saleInvoice','purchaseInvoice'],
};

export function prepareMaterialObservations(f,stage,period='2026-09'){
  assert.equal(f.version,MATERIAL_INTAKE_VERSION);
  const files=Object.fromEntries(stageFiles[stage].map(key=>[key,f.files[key]]));
  for(const path of Object.values(files)){
    const part=relative(f.sourceRoot,path);
    assert(part&&!isAbsolute(part)&&part!=='..'&&!/^\.\.[\\/]/.test(part),'只给测试宿主获准的合成原件');
  }
  const artifactDir=join(f.auditDir,'agent-materials',stage);
  mkdirSync(artifactDir,{recursive:true});
  const requestPath=join(f.reviewer,stage+'-host-read-request.json');
  writeBaselineJson(requestPath,{version:'synthetic-material-host-read/1',stage,sourceRoot:f.sourceRoot,files,artifactDir,
    target:materialTarget(f,period),enterpriseKey:f.owner.enterpriseKey});
  const extracted=spawnSync(f.pythonPath,['-B','-X','utf8',fileURLToPath(new URL('./material-intake-local.py',import.meta.url)),requestPath],
    {cwd:f.root,encoding:'utf8',windowsHide:true,timeout:60000});
  assert.equal(extracted.status,0,extracted.stderr+'\n'+extracted.stdout);
  const report=JSON.parse(extracted.stdout.trim());
  assert.equal(report.hostProcess,true);
  for(const [key,path]of Object.entries(files))assert.equal(hashBaseline(readFileSync(path)),f.originalHashes[key],'宿主提取须保留原件');
  return report;
}

export const materialTarget=(f,period='2026-09')=>({accountSetId:f.accountSetId,period});
export const materialReference=m=>({materialRef:m.materialRef,snapshotDigest:m.snapshotDigest});

async function describeHostTrial(root){
  const f=createMaterialIntakeFixture(root),sessionPath=await prepareMaterialIntakeSession(f);
  const connection={root:f.root,dbPath:f.dbPath,sourceRoot:f.sourceRoot,auditDir:f.auditDir,pythonPath:f.pythonPath,
    serverPath:join(BASELINE_REPO_ROOT,'05-reconstruction/codex/mcp/finance-mcp/server.mjs'),
    env:{FINANCE_DATABASE_PATH:f.dbPath,FINANCE_SOURCE_ROOT:f.sourceRoot,FINANCE_AUDIT_DIR:f.auditDir,
      FINANCE_BUSINESS_SESSION:sessionPath,FINANCE_MCP_PROFILE:'direct',FINANCE_API_BASE:'http://127.0.0.1:1',
      FINANCE_PYTHON_PATH:join(f.root,'unavailable-backend-python.exe')},
    target:materialTarget(f),modelInvoked:false,oracleInsideSourceRoot:false};
  console.log(JSON.stringify(connection));
}

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
  else if(process.argv[2]==='--prepare-host-read')await describeHostTrial(process.argv[3]);
}
