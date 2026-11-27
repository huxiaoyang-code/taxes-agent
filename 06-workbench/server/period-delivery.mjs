// 复核工作区内的交付物；完整版本与角色返工记录保留在本机，不随摘要进入模型。
import {DatabaseSync,backup} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {existsSync,lstatSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,realpathSync,rmSync,statSync,writeFileSync} from 'node:fs';
import {basename,dirname,join,relative,resolve,sep} from 'node:path';
import {loadBoundBusinessSession,sessionPath} from '../../05-reconstruction/codex/hosts/shared/business-session.mjs';
import {annotateFinanceCall} from './finance-call-chain.mjs';
import {readDeliveryBooks} from './delivery-books-review.mjs';
import {reviewInventory} from './delivery-stock-review.mjs';
import {reviewDeliveryVat} from './delivery-vat-review.mjs';
import {publishReviewedDelivery,validateDeliveryScope,verifyReviewedDelivery} from './delivery-release.mjs';

const digest=value=>createHash('sha256').update(value).digest('hex');
const encode=value=>JSON.stringify(value,(_k,v)=>typeof v==='bigint'?v.toString():v);
const fail=code=>{throw Object.assign(Error(code),{code});};
const ruleFiles=['period-delivery.mjs','delivery-stock-review.mjs','delivery-books-review.mjs','delivery-vat-review.mjs',
  'delivery-vat-pdf.py','delivery-workbook.mjs','offline-invoice-xlsx.mjs','accounting-report-rules.mjs',
  'delivery-release.mjs','delivery-stock-invoices.mjs','delivery-stock-expense-proof.mjs','delivery-trial-review.mjs','finance-delivery-check.mjs',
  'accounting-profiles.mjs','period-end-controls.mjs','csv-rows.mjs','money.mjs'];
const rules=digest(encode(ruleFiles.map(f=>digest(readFileSync(new URL(f,import.meta.url))))));
const roleAction={
  bookkeeper:'按证据修正新版交付；涉及凭证时沿用已委托的更正入口，然后重新提交。',
  product:'修正共用规则或读取器，按适用范围重新生成受影响交付，再提交新版。',
  accountant:'核对来源与口径，补入可定位依据后重新提交。',
};
const verifiedChecks=['资产负债表','进销存与正式库存总账','增值税本期和期末'];
const PAGE=4,DETAIL=3;

function checkedDir(path){
  for(let p=resolve(path);;p=dirname(p)){
    const st=lstatSync(p);
    if(st.isSymbolicLink()||!st.isDirectory())fail('finance_delivery_directory_invalid');
    if(p===dirname(p))break;
  }
}
function ensureDir(parent,name){
  const path=join(parent,name);
  checkedDir(parent);
  try{mkdirSync(path,{mode:0o700});}catch(err){if(err.code!=='EEXIST')throw err;}
  checkedDir(path);
  return path;
}
function listTree(root,excluded=[]){
  if(!root)return [];
  checkedDir(root);
  const scan={list:[],total:0,entries:0};
  function walk(dir,depth){
    if(depth>16)fail('finance_delivery_volume_limit');
    for(const e of readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name,'en'))){
      if(++scan.entries>20000)fail('finance_delivery_volume_limit');
      const path=join(dir,e.name);
      if(excluded.includes(path)||e.name.startsWith('.')||e.name.startsWith('~$'))continue;
      if(e.isSymbolicLink())fail('finance_delivery_file_invalid');
      if(e.isDirectory()){walk(path,depth+1);continue;}
      if(!e.isFile())fail('finance_delivery_file_invalid');
      const st=lstatSync(path,{bigint:true});
      if(st.nlink!==1n||st.size>32n*1024n*1024n||scan.list.length>=6000)fail('finance_delivery_volume_limit');
      scan.total+=Number(st.size);
      if(scan.total>192*1024*1024)fail('finance_delivery_volume_limit');
      scan.list.push({name:relative(root,path).split(sep).join('/'),stamp:[st.size,st.mtimeNs,st.ino].join('/')});
    }
  }
  walk(root,0);
  return scan.list;
}
function capture(root,excluded,read){
  const listed=listTree(root,excluded);
  return {root,excluded,listed,files:listed.map(({name})=>{
    const bytes=read(join(root,name),32*1024*1024);
    return {name,bytes,sha256:digest(bytes)};
  })};
}
function originalPartition(snapshot,root,scope){
  const db=new DatabaseSync(snapshot,{readOnly:true});
  let single;
  try{single=validateDeliveryScope(db,scope);}finally{db.close();}
  if(!root||single)return {root,mode:single?'single-account':'unverified'};
  const key=scope.enterpriseKey;
  if(!/^[^\\/:<>"|?*\u0000-\u001f]+$/u.test(key)||/[. ]$/.test(key)||/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(key))return {root:null,mode:'unverified'};
  checkedDir(root);
  const partition=basename(resolve(root))===key?root:join(root,key);
  if(!lstatSync(partition,{throwIfNoEntry:false}))return {root:null,mode:'unverified'};
  checkedDir(partition);
  return {root:partition,mode:'enterprise-key'};
}
function indexed(store,version){
  const row=store.prepare('SELECT report,checksum,manifest FROM versions WHERE version=?').get(version);
  if(!row)fail('finance_delivery_version_unknown');
  if(digest(row.report)!==row.checksum)fail('finance_delivery_version_damaged');
  const report=JSON.parse(row.report);
  if(digest(encode([JSON.parse(row.manifest),report.coverage,report.groups])).slice(0,32)!==version)fail('finance_delivery_version_damaged');
  return report;
}
function evidenceDirectory(store,history,workspace,version){
  const manifest=JSON.parse(store.prepare('SELECT manifest FROM versions WHERE version=?').get(version).manifest);
  const select=store.prepare('SELECT bytes FROM objects WHERE sha=?');
  function bytes(sha){
    const row=select.get(sha);
    if(!row||digest(row.bytes)!==sha)fail('finance_delivery_version_damaged');
    return Buffer.from(row.bytes);
  }
  const files=list=>list.map(f=>({...f,bytes:bytes(f.sha256)}));
  const dir=mkdtempSync(join(history,'evidence-')),snapshotPath=join(dir,'books.sqlite');
  try{
    writeFileSync(snapshotPath,bytes(manifest.book),{mode:0o600,flag:'wx'});
    // 旧版本没有冻结原件的企业归属，重新按当前入口送审后可打开原件。
    const sources=['single-account','enterprise-key'].includes(manifest.sourceScope)?files(manifest.sources):[];
    return publishReviewedDelivery({workspace,version,files:files(manifest.outputs),snapshotPath,
      scope:manifest.scope,evidenceSources:sources});
  }finally{rmSync(dir,{recursive:true,force:true});}
}
function groupIssues(domains){
  const groups=new Map();
  for(const {issues} of domains)for(const instance of issues){
    const {code,owner}=instance;
    if(!/^[a-z][a-z0-9_]{0,119}$/.test(code)||!Object.hasOwn(roleAction,owner))fail('finance_delivery_invalid_finding');
    const g=groups.get(code)??{code,owner,items:[]};
    if(g.owner!==owner)fail('finance_delivery_invalid_finding');
    g.items.push(instance);groups.set(code,g);
  }
  return [...groups.values()].sort((a,b)=>a.code.localeCompare(b.code));
}
const compact=(s,max=140)=>String(s??'').replace(/[\u0000-\u001f]/g,' ').slice(0,max);
function instanceView(row){
  const location=typeof row.location==='string'?row.location:Object.entries(row.location??{}).map(([k,v])=>k+'='+compact(v,90)).join(' ');
  return Object.fromEntries(Object.entries({location:compact(location,200),actual:row.actual,expected:row.expected,differenceMinor:row.differenceMinor,note:row.note})
    .filter(([,v])=>v!=null).map(([k,v])=>[k,compact(v,k==='location'?200:120)]));
}
function present(report,request,previous,current){
  const {version,groups}=report;
  let visible=groups.filter(g=>!request.role||request.role===g.owner);
  const totalForRole=visible.length;
  const offset=request.offset??0;
  const released=report.reviewedBy==='delivery_reviewer' && Boolean(report.package);
  const result={version,status:groups.length?'blocked':released?'ready_for_accountant':'awaiting_independent_review',currentVersion:current===version,
    outstanding:groups.length};
  if(request.issue){
    const g=visible.find(g=>g.code===request.issue);
    if(!g)fail('finance_delivery_issue_unknown');
    return {...result,issue:g.code,role:g.owner,count:g.items.length,action:roleAction[g.owner],
      ...(report.stalled?.includes(g.code)?{decision:'同一问题连续两次返工仍无新依据，停止自动重试并转负责人。'}:{}),
      evidence:g.items.slice(offset,offset+DETAIL).map(instanceView),...(offset+DETAIL<g.items.length?{nextOffset:offset+DETAIL}:{})};
  }
  if(!groups.length){
    if(previous)result.resolved=previous.groups.length;
    result.checked=verifiedChecks;
    if(released){result.package=report.package;result.next='复核已结束，将本版交会计。';}
    else if(result.currentVersion)result.handoff={role:'delivery_reviewer',delivery:{reviewVersion:version}};
    if(report.coverage.inventory.explained?.length)result.explained=report.coverage.inventory.explained.slice(0,2);
    return result;
  }
  if(previous){
    const old=new Map(previous.groups.map(g=>[g.code,digest(encode(g.items))]));
    const removed=previous.groups.filter(g=>!groups.some(n=>n.code===g.code));
    result.resolved=removed.length;
    if(removed.length)result.resolvedIssues=removed.slice(0,PAGE).map(g=>g.code);
    if(removed.length>PAGE){result.otherResolved=removed.length-PAGE;result.previousVersion=previous.version;}
    visible=visible.filter(g=>old.get(g.code)!==digest(encode(g.items))||
      (report.stalled?.includes(g.code)&&!previous.stalled?.includes(g.code)));
    result.changed=visible.length;
  }
  result.queue=visible.slice(offset,offset+PAGE).map(g=>({issue:g.code,role:g.owner,count:g.items.length,
    ...(report.stalled?.includes(g.code)?{stopRetry:true}:{}),
    action:compact(g.items[0].note||roleAction[g.owner],96)}));
  // 差异和完整队列共享前缀时可直接翻页；稀疏差异绑定两个版本后继续相同筛选。
  if(offset+PAGE<visible.length){
    result.more={version,offset:offset+PAGE};
    if(previous&&visible.length!==totalForRole)result.more.since=previous.version;
    if(request.role)result.more.role=request.role;
  }
  if(!visible.length&&!request.role)result.roles=[...new Set(groups.map(g=>g.owner))];
  return result;
}
function openStore(path,readOnly){
  const st=lstatSync(path,{throwIfNoEntry:false});
  if(st&&(!st.isFile()||st.isSymbolicLink()||st.nlink!==1))fail('finance_delivery_history_invalid');
  if(readOnly&&!st)fail('finance_delivery_version_unknown');
  const store=new DatabaseSync(path,{readOnly});
  store.exec('PRAGMA busy_timeout=5000');
  if(!readOnly)store.exec('CREATE TABLE IF NOT EXISTS objects(sha TEXT PRIMARY KEY,bytes BLOB NOT NULL);'+
    'CREATE TABLE IF NOT EXISTS versions(version TEXT PRIMARY KEY,report TEXT NOT NULL,checksum TEXT NOT NULL,manifest TEXT NOT NULL);'+
    'CREATE TABLE IF NOT EXISTS submissions(id INTEGER PRIMARY KEY,version TEXT NOT NULL REFERENCES versions(version))');
  return store;
}
const head=store=>store.prepare('SELECT id,version FROM submissions ORDER BY id DESC LIMIT 1').get();
function stalledGroups(store,report){
  // 只计相继提交的不同版本；原样重查不会消耗返工轮次。
  const prior=store.prepare('SELECT version FROM submissions ORDER BY id DESC LIMIT 3').all();
  if(prior[0]?.version===report.version)prior.shift();
  if(prior.length<2)return [];
  const old=prior.slice(0,2).map(({version})=>indexed(store,version));
  return report.groups.filter(g=>old.every(p=>p.sourceDigest===report.sourceDigest &&
    p.groups.some(o=>o.code===g.code&&encode(o.items)===encode(g.items)))).map(g=>g.code);
}
function storeSubmission(store,report,manifest,objects,observed,publish){
  store.exec('BEGIN IMMEDIATE');
  try{
    const latest=head(store);
    if(latest?.id!==observed?.id&&latest?.version!==report.version)fail('finance_delivery_concurrent_submission');
    const exists=store.prepare('SELECT 1 FROM versions WHERE version=?').get(report.version);
    const stored=exists?indexed(store,report.version):null;
    if(stored?.reviewedBy==='delivery_reviewer'){
      Object.assign(report,{reviewedBy:stored.reviewedBy,package:stored.package,manifestSha256:stored.manifestSha256});
    }else if(publish)Object.assign(report,publish(),{reviewedBy:'delivery_reviewer'});
    if(!exists){
      const put=store.prepare('INSERT OR IGNORE INTO objects(sha,bytes) VALUES(?,?)');
      for(const o of objects)put.run(o.sha256,o.bytes);
      const json=encode(report);
      store.prepare('INSERT INTO versions VALUES(?,?,?,?)').run(report.version,json,digest(json),encode(manifest));
    }else if(publish && stored.reviewedBy!=='delivery_reviewer'){
      // 输入、复算结果及版本保持冻结，只追加独立复核的出版回执。
      const json=encode({...stored,reviewedBy:report.reviewedBy,package:report.package,manifestSha256:report.manifestSha256});
      store.prepare('UPDATE versions SET report=?,checksum=? WHERE version=?').run(json,digest(json),report.version);
    }
    if(latest?.version!==report.version)store.prepare('INSERT INTO submissions(version) VALUES(?)').run(report.version);
    store.exec('COMMIT');
  }catch(e){store.exec('ROLLBACK');throw e;}
}
async function submit(store,history,bound,workspace,request,read){
  const observed=head(store);
  const reviewer=process.env.FINANCE_DIRECT_ROLE==='delivery_reviewer';
  if(request.reviewVersion && !reviewer)fail('finance_delivery_reviewer_required');
  if(reviewer && !observed)fail('finance_delivery_submission_required');
  if(request.reviewVersion && observed?.version!==request.reviewVersion)fail('finance_delivery_submission_changed');
  const previous=request.since?indexed(store,request.since):observed?indexed(store,observed.version):null;
  const expectedVersion=reviewer?observed.version:null;
  const {session,config}=bound, original=session.sourceRoot,outputs=join(workspace,'outputs');
  if(original&&(resolve(original)===resolve(outputs)||resolve(original).startsWith(resolve(outputs)+sep)))fail('finance_delivery_source_overlap');
  const excluded=[outputs,join(workspace,'reviewed'),join(workspace,'review-evidence'),join(workspace,'.finance'),config.databasePath,config.databasePath+'-wal',config.databasePath+'-shm',session.auditDir,history];
  const files=capture(outputs,[],read);
  const temp=mkdtempSync(join(history,'snapshot-')),path=join(temp,'books.sqlite');
  let db;
  try{
    db=new DatabaseSync(config.databasePath,{readOnly:true});
    const generation=()=>db.prepare('PRAGMA data_version').get().data_version;
    const initial=generation();
    await backup(db,path);
    if(statSync(path).size>512*1024*1024)fail('finance_delivery_database_limit');
    const partition=originalPartition(path,original,session.scope);
    const sources=capture(partition.root,excluded,read);
    const binding={scope:session.scope,dbPath:path};
    const books=readDeliveryBooks(binding,files.files);
    const inventory=reviewInventory({files:files.files,sources:sources.files,period:session.scope.period,inventoryMinor:books.inventoryLedger??books.inventoryMinor});
    const vat=reviewDeliveryVat({files:files.files,sources:sources.files,vatLedger:books.vatLedger,
      period:session.scope.period,enterpriseName:books.enterpriseName,enterpriseKey:session.scope.enterpriseKey,taxpayerId:books.taxpayerId});
    const sourceIssues=partition.mode==='unverified'?[{code:'delivery_original_scope_unverified',owner:'accountant',
      location:'原件目录',expected:session.scope.enterpriseKey,note:'共用账库需将本企业原件归入以企业标识命名的目录，再提交复验。'}]:[];
    const groups=groupIssues([{issues:sourceIssues},books,inventory,vat]);
    for(const tree of [files,sources])if(encode(listTree(tree.root,tree.excluded))!==encode(tree.listed))fail('finance_delivery_inputs_changed');
    if(generation()!==initial)fail('finance_delivery_inputs_changed');
    const dbBytes=readFileSync(path),book={name:'books.sqlite',bytes:dbBytes,sha256:digest(dbBytes)};
    const metadata=arr=>arr.map(({name,sha256})=>({name,sha256}));
    const manifest={scope:session.scope,rules,book:book.sha256,sourceScope:partition.mode,outputs:metadata(files.files),sources:metadata(sources.files)};
    const coverage={books:books.coverage,inventory:inventory.coverage,vat:vat.coverage};
    const version=digest(encode([manifest,coverage,groups])).slice(0,32);
    if(expectedVersion && version!==expectedVersion)fail('finance_delivery_submission_changed');
    const report={version,coverage,groups,sourceDigest:digest(encode(manifest.sources))};
    report.stalled=stalledGroups(store,report);
    let publish;
    if(reviewer&&!groups.length){
      publish=()=>{
        const directory=publishReviewedDelivery({workspace,version,files:files.files,snapshotPath:path,scope:session.scope});
        return {package:directory,manifestSha256:digest(read(join(workspace,directory,'manifest.json')))};
      };
    }
    storeSubmission(store,report,manifest,[book,...files.files,...sources.files],observed,publish);
    if(report.package)verifyReviewedDelivery({workspace,version,manifestSha256:report.manifestSha256});
    let comparison=previous;
    if(expectedVersion && !request.since){
      const prior=store.prepare('SELECT version FROM submissions WHERE id<? ORDER BY id DESC LIMIT 1').get(observed.id);
      comparison=prior?indexed(store,prior.version):null;
    }
    return present(report,request,comparison,version);
  }finally{
    db?.close();
    rmSync(temp,{recursive:true,force:true});
  }
}
export async function reviewBoundDelivery(request,read){
  // 在同一版号上继续翻页、筛选或取证时，只读封存记录。
  if(request.reviewVersion&&(request.offset!==undefined||request.issue||request.evidence||request.role)){
    const {reviewVersion,...query}=request;
    request={...query,version:reviewVersion};
  }
  const env=process.env.FINANCE_BUSINESS_SESSION;
  if(!env)fail('finance_delivery_session_required');
  const workspace=dirname(dirname(resolve(env)));
  if(sessionPath(workspace)!==resolve(env))fail('finance_delivery_session_required');
  const bound=loadBoundBusinessSession(workspace);
  if(resolve(process.env.FINANCE_DATABASE_PATH??'')!==resolve(bound.config.databasePath))fail('finance_delivery_scope_conflict');
  annotateFinanceCall({scope:bound.session.scope});
  // 整库快照只留在原账库所在的本机信任域，模型只能按本账套的版本读取复核投影。
  const parent=dirname(bound.config.databasePath),namespace=digest(encode([bound.session.scope,realpathSync(workspace)])).slice(0,32);
  const readOnly=Boolean(request.version||request.role);
  if(request.role&&request.since&&!request.version)fail('finance_period_review_input_invalid');
  let history=join(parent,'.finance-delivery',namespace);
  if(readOnly){if(!existsSync(history))fail('finance_delivery_version_unknown');checkedDir(history);}
  else history=ensureDir(ensureDir(parent,'.finance-delivery'),namespace);
  const store=openStore(join(history,'history.sqlite'),readOnly);
  try{
    if(!readOnly)return await submit(store,history,bound,workspace,request,read);
    const latest=head(store)?.version;
    const report=indexed(store,request.version??latest??'');
    if(report.package)verifyReviewedDelivery({workspace,version:report.version,manifestSha256:report.manifestSha256});
    const result=present(report,request,request.since?indexed(store,request.since):null,latest);
    if(request.evidence)result.evidenceDirectory=evidenceDirectory(store,history,workspace,report.version);
    return result;
  }finally{store.close();}
}
