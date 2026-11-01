// 将领域原生凭证证据接入季度复核；仅采纳实际提交且与当前快照一致的记录。
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync,lstatSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {createHash} from 'node:crypto';
const sha=b=>createHash('sha256').update(b).digest('hex');
function bytes(path){for(let p=path;;p=dirname(p)){if(lstatSync(p).isSymbolicLink())throw Error('posting_index_link');if(dirname(p)===p)break;}const s=lstatSync(path);if(!s.isFile()||s.nlink!==1||s.size>20*1024*1024)throw Error('posting_index_file');return readFileSync(path);}
export function committedPostingEvidence(dbPath,scope) {
 const root=join(dirname(dbPath),'posting-attempts');let names;try{if(lstatSync(root).isSymbolicLink())return [];names=readdirSync(root).filter(n=>/^[a-f0-9-]{36}$/.test(n));}catch{return [];}
 const db=new DatabaseSync(dbPath,{readOnly:true}),found=[];
 try{for(const id of names){try{
  const dir=join(root,id),end=JSON.parse(bytes(join(dir,'result.json'))),beginBytes=bytes(join(dir,'begin.json'));
  if(end.databaseInstanceId!==scope.databaseInstanceId||end.accountSetId!==scope.accountSetId||end.enterpriseKey!==scope.enterpriseKey||!end.operationId||!end.voucherId||end.beginDigest!==sha(beginBytes)||!/^validation-\d+\.json$/.test(end.validation?.file??''))continue;
  const validationBytes=bytes(join(dir,end.validation.file));if(sha(validationBytes)!==end.validation.sha256)continue;
  const begin=JSON.parse(beginBytes),validation=JSON.parse(validationBytes),evidence=validation.evidence;
  if(evidence?.version!=='business-evidence/1'||validation.issues.some(i=>i.severity==='error'))continue;
  const op=db.prepare("SELECT state FROM audit_operations WHERE database_instance_id=? AND operation_id=? AND attempt=?").get(scope.databaseInstanceId,end.operationId,end.operationAttempt??1);
  if(!['succeeded','no_change'].includes(op?.state))continue;
  const voucher=db.prepare('SELECT account_set_id FROM vouchers WHERE id=?').get(end.voucherId);if(voucher?.account_set_id!==scope.accountSetId)continue;
  const dependencies=(source,seen=new Set())=>{if(!source||typeof source!=='object'||seen.has(source))throw Error('posting_dependency_invalid');seen.add(source);const out=[source,...(source.dependencies??[]).flatMap(s=>dependencies(s,seen))];seen.delete(source);return out;};
  const sources=[...evidence.mappings,...evidence.cashFlowAllocations].flatMap(m=>m.sources).flatMap(s=>dependencies(s));
  let unchanged=false;try{unchanged=sources.every(s=>typeof s.path==='string'&&typeof s.sha256==='string'&&sha(bytes(s.path))===s.sha256);}catch{/* 保留历史证据，标记来源不可核。 */}
  found.push({attemptId:id,startedAt:begin.startedAt,operationId:end.operationId,voucherId:end.voucherId,content:validation.content,evidence,unchanged,recordPath:dir});
 }catch{/* 记录不完整、来源改变或目录不可读不能被默认为核验成功。 */}}
 }finally{db.close();}
 return found;
}
