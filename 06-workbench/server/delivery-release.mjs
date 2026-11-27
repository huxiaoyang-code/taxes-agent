// 通过复核后，原样交付文件与同版账簿一次发布；已有版本逐文件复核后复用。
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {closeSync,copyFileSync,constants,lstatSync,mkdirSync,mkdtempSync,openSync,readFileSync,readSync,readdirSync,renameSync,rmSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';

const fail=code=>{throw Object.assign(Error(code),{code});};
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const requiredDirectory=path=>{
  for(let p=resolve(path);;p=dirname(p)){
    const stat=lstatSync(p);
    if(!stat.isDirectory()||stat.isSymbolicLink())fail('finance_delivery_package_directory_invalid');
    if(p===dirname(p))break;
  }
};
function safeFile(path){
  const stat=lstatSync(path);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)fail('finance_delivery_package_file_invalid');
  return stat;
}
function hashFile(path){
  safeFile(path);
  const fd=openSync(path,'r'),hash=createHash('sha256'),buf=Buffer.allocUnsafe(1024*1024);
  try{
    for(let read;(read=readSync(fd,buf,0,buf.length,null))!==0;)hash.update(buf.subarray(0,read));
    return hash.digest('hex');
  }finally{closeSync(fd);}
}
function validName(name){
  if(typeof name!=='string'||!name||name.length>2048||/[\\:\x00-\x1f<>"|?*]/.test(name))return false;
  return name.split('/').every(p=>p.length>0&&p.length<=255&&p!=='.'&&p!=='..'&&!/[. ]$/.test(p)&&!/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(p));
}
function scopedRows(db,sql,args){return db.prepare(sql).all(...args);}
export function validateDeliveryScope(db,scope){
  const {accountSetId,enterpriseKey,databaseInstanceId,period}=scope;
  if(!Number.isSafeInteger(accountSetId)||accountSetId<1||!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(period))fail('finance_delivery_package_scope_conflict');
  const sets=scopedRows(db,'SELECT id FROM account_sets ORDER BY id',[]);
  const ids=scopedRows(db,'SELECT instance_id FROM audit_database_instances WHERE is_active=1',[]);
  const owners=scopedRows(db,'SELECT account_set_id,enterprise_key FROM import_enterprise_account_sets',[]);
  if(!sets.some(s=>s.id===accountSetId)||ids.length!==1||ids[0].instance_id!==databaseInstanceId||
    owners.filter(o=>o.account_set_id===accountSetId).length!==1||!owners.some(o=>o.account_set_id===accountSetId&&o.enterprise_key===enterpriseKey)||
    !db.prepare('SELECT 1 FROM periods WHERE account_set_id=? AND period=?').get(accountSetId,period))fail('finance_delivery_package_scope_conflict');
  return sets.length===1 && owners.length===1;
}

// 多账套新建数据库，仅复制核对所需原始会计行。全库复制后删除会留下其它企业的自由页。
function writeScopedDatabase(source,file,scope) {
  const {accountSetId:id,enterpriseKey,period}=scope;
  const dest=new DatabaseSync(file);
  const setWhere='account_set_id=?';
  const table=(name,cols,where,args,order)=>{
    const allowed=cols.split(' '),declared=source.prepare('PRAGMA table_info('+name+')').all();
    const columns=allowed.filter(column=>declared.some(c=>c.name===column));
    if(!columns.length)fail('finance_delivery_package_schema_invalid');
    // 只复制列值，不复制触发器、默认值、外部库的 SQL 或其他租户记录。
    const names=columns.join(',');
    dest.exec('CREATE TABLE '+name+' ('+columns.map(column=>{
      const t=declared.find(c=>c.name===column).type.toUpperCase();
      return column+' '+(['INTEGER','REAL','BLOB','TEXT','NUMERIC'].includes(t)?t:'');
    }).join(',')+')');
    const insert=dest.prepare('INSERT INTO '+name+' ('+names+') VALUES ('+columns.map(()=>'?').join(',')+')');
    const select=source.prepare('SELECT '+names+' FROM '+name+' WHERE '+where+' ORDER BY '+order);
    for(const row of select.iterate(...args))insert.run(...columns.map(k=>row[k]));
  };
  try{
    dest.exec('BEGIN');
    table('account_sets','id name taxpayer_type accounting_standard accounting_profile_id start_period created_at taxpayer_id taxpayer_number taxpayer_no credit_code tax_id','id=?',[id],'id');
    table('audit_database_instances','instance_id is_active','is_active=1',[],'instance_id');
    table('import_enterprise_account_sets','account_set_id enterprise_key enterprise_name','account_set_id=? AND enterprise_key=?',[id,enterpriseKey],'account_set_id');
    table('accounts','id account_set_id code name category direction contra is_leaf',setWhere,[id],'code');
    table('opening_balances','account_set_id code debit credit',setWhere,[id],'code');
    table('periods','account_set_id period status',setWhere+' AND period<=?',[id,period],'period');
    table('vouchers','id account_set_id period voucher_date word number summary status created_at kind',setWhere+' AND period<=?',[id,period],'id');
    table('voucher_entries','id voucher_id line_no code summary debit credit','voucher_id IN (SELECT id FROM vouchers WHERE account_set_id=? AND period<=?)',[id,period],'voucher_id,line_no');
    dest.exec('COMMIT');
  }finally{dest.close();}
}
function saveBooks(snapshot,file,scope) {
  safeFile(snapshot);
  requiredDirectory(dirname(snapshot));
  const db=new DatabaseSync(snapshot,{readOnly:true});
  try{
    db.exec('BEGIN');
    const single=validateDeliveryScope(db,scope);
    if(single){
      const wal=lstatSync(snapshot+'-wal',{throwIfNoEntry:false});
      if(wal&&wal.size>0)fail('finance_delivery_package_snapshot_incomplete');
      copyFileSync(snapshot,file,constants.COPYFILE_EXCL);
      return 'single-account-snapshot';
    }
    writeScopedDatabase(db,file,scope);
    return 'account-period-ledger';
  }finally{db.close();}
}

function verify(root,expected) {
  requiredDirectory(root);
  const expectedDirs=new Set();
  for(const name of expected.keys()){
    let prefix='';
    for(const part of name.split('/').slice(0,-1)){prefix=prefix?prefix+'/'+part:part;expectedDirs.add(prefix);}
  }
  const seen=new Set();
  function walk(path,parent=''){
    for(const e of readdirSync(path,{withFileTypes:true})){
      const name=parent?parent+'/'+e.name:e.name;
      if(e.isSymbolicLink())fail('finance_delivery_package_damaged');
      const child=join(path,e.name);
      if(e.isDirectory()){
        if(!expectedDirs.has(name))fail('finance_delivery_package_damaged');
        walk(child,name);
      }else{
        if(!expected.has(name)||!e.isFile()||hashFile(child)!==expected.get(name))fail('finance_delivery_package_damaged');
        seen.add(name);
      }
    }
  }
  walk(root);
  if(seen.size!==expected.size)fail('finance_delivery_package_damaged');
}

export function verifyReviewedDelivery({workspace,version,manifestSha256}){
  if(!/^[a-f0-9]{32}$/.test(version)||!/^[a-f0-9]{64}$/.test(manifestSha256))fail('finance_delivery_package_damaged');
  const dir=join(resolve(workspace),'reviewed',version),path=join(dir,'manifest.json');
  try{
    requiredDirectory(dir);
    if(safeFile(path).size>16*1024*1024)fail('finance_delivery_package_damaged');
    const bytes=readFileSync(path);
    if(digest(bytes)!==manifestSha256)fail('finance_delivery_package_damaged');
    const manifest=JSON.parse(bytes);
    if(manifest.format!=='finance-reviewed-delivery/1'||manifest.version!==version||manifest.ledger?.path!=='books.sqlite'||
      !['single-account-snapshot','account-period-ledger'].includes(manifest.ledger.mode)||!Array.isArray(manifest.outputs)||!manifest.outputs.length)fail('finance_delivery_package_damaged');
    const expected=new Map([['manifest.json',manifestSha256]]);
    for(const item of [manifest.ledger,...manifest.outputs]){
      if(!validName(item.path)||(!item.path.startsWith('outputs/')&&item!==manifest.ledger)||expected.has(item.path)||
        !/^[a-f0-9]{64}$/.test(item.sha256)||!Number.isSafeInteger(item.bytes)||item.bytes<0)fail('finance_delivery_package_damaged');
      const file=join(dir,item.path);
      requiredDirectory(dirname(file));
      if(safeFile(file).size!==item.bytes)fail('finance_delivery_package_damaged');
      expected.set(item.path,item.sha256);
    }
    verify(dir,expected);
  }catch{fail('finance_delivery_package_damaged');}
  return 'reviewed/'+version;
}

export function publishReviewedDelivery({workspace,version,files,evidenceSources,snapshotPath,scope}){
  if(!/^[a-f0-9]{32}$/.test(version))fail('finance_delivery_package_version_invalid');
  const evidence=evidenceSources!==undefined;
  if(!Array.isArray(files)||evidence&&!Array.isArray(evidenceSources))fail('finance_delivery_package_file_invalid');
  const directory=evidence?'review-evidence':'reviewed';
  requiredDirectory(workspace);
  const root=join(resolve(workspace),directory);
  try{mkdirSync(root,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}
  requiredDirectory(root);
  const target=join(root,version),stage=mkdtempSync(join(root,'.publishing-'));
  try{
    const expected=new Map();
    function saveFiles(prefix,list){
      const seenPaths=new Map(),manifestFiles=[];
      for(const f of list) {
        if(!validName(f.name)||!Buffer.isBuffer(f.bytes))fail('finance_delivery_package_file_invalid');
        const parts=f.name.split('/');
        for(let i=0;i<parts.length;i++){
          const path=parts.slice(0,i+1).join('/'),key=path.normalize('NFC').toLowerCase(),type=i===parts.length-1?'file':'directory';
          const previous=seenPaths.get(key);
          if(previous && (previous.path!==path||previous.type!==type||type==='file'))fail('finance_delivery_package_file_invalid');
          seenPaths.set(key,{path,type});
        }
        const hash=digest(f.bytes);
        if(f.sha256!=null&&hash!==f.sha256)fail('finance_delivery_package_file_changed');
        const name=prefix+'/'+f.name,path=join(stage,name);
        mkdirSync(dirname(path),{recursive:true,mode:0o700});
        writeFileSync(path,f.bytes,{flag:'wx',mode:0o600});
        expected.set(name,hash);
        manifestFiles.push({path:name,bytes:f.bytes.length,sha256:hash});
      }
      return manifestFiles.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
    }
    const outputs=saveFiles('outputs',files);
    const sources=evidence?saveFiles('sources',evidenceSources):undefined;
    if(!evidence&&!outputs.length)fail('finance_delivery_package_empty');
    const bookName='books.sqlite',bookPath=join(stage,bookName);
    const mode=saveBooks(snapshotPath,bookPath,scope),hash=hashFile(bookPath);
    expected.set(bookName,hash);
    const manifest=Buffer.from(JSON.stringify({format:evidence?'finance-local-review-evidence/1':'finance-reviewed-delivery/1',version,
      ...(evidence?{purpose:'本机复核取证，非正式交付包',sources}:{}),
      scope:{accountSetId:scope.accountSetId,period:scope.period,databaseInstanceId:scope.databaseInstanceId,enterpriseKey:scope.enterpriseKey},
      ledger:{path:bookName,mode,sha256:hash,bytes:safeFile(bookPath).size},outputs},null,2)+'\n');
    writeFileSync(join(stage,'manifest.json'),manifest,{flag:'wx',mode:0o600});
    expected.set('manifest.json',digest(manifest));
    verify(stage,expected);
    if(!lstatSync(target,{throwIfNoEntry:false})){
      try{renameSync(stage,target);}catch(e){if(!lstatSync(target,{throwIfNoEntry:false}))throw e;}
    }
    // 并发提交可复用赢家的完整版本；不覆盖损坏或部分存在的历史。
    verify(target,expected);
    return directory+'/'+version;
  }finally{
    if(dirname(stage)===root&&lstatSync(stage,{throwIfNoEntry:false})){
      requiredDirectory(stage);
      rmSync(stage,{recursive:true,force:true});
    }
  }
}
