// 显式账套ID到现库真实身份的只读绑定；不发现默认企业、不建库、不建立业务会话。
import {DatabaseSync} from 'node:sqlite';
import {isAbsolute,resolve} from 'node:path';
import {lstatSync,realpathSync} from 'node:fs';
const fail=code=>{throw Object.assign(new Error(code),{code});};
export function resolveDirectFinanceTarget(target,dbPath=process.env.FINANCE_DATABASE_PATH){
 if(!target||!Number.isSafeInteger(target.accountSetId)||target.accountSetId<=0||!/^202[67]-(0[1-9]|1[0-2])$/.test(target.period??''))fail('finance_target_invalid');
 if(typeof dbPath!=='string'||!isAbsolute(dbPath))fail('finance_target_database_required');
 const path=resolve(dbPath);let stat;try{stat=lstatSync(path);}catch{fail('finance_target_database_missing');}
 if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||realpathSync(path).toLowerCase()!==path.toLowerCase())fail('finance_target_database_invalid');
 let db;try{db=new DatabaseSync(path,{readOnly:true});
  const instances=db.prepare('SELECT instance_id FROM audit_database_instances WHERE is_active=1').all();if(instances.length!==1)fail('finance_target_instance_ambiguous');
  const rows=db.prepare('SELECT a.id,b.enterprise_key FROM account_sets a LEFT JOIN import_enterprise_account_sets b ON b.account_set_id=a.id WHERE a.id=?').all(target.accountSetId);
  if(rows.length!==1)fail('finance_target_account_set_missing');if(typeof rows[0].enterprise_key!=='string'||!rows[0].enterprise_key.trim())fail('finance_target_enterprise_binding_missing');
  return {dbPath:path,scope:{enterpriseKey:rows[0].enterprise_key,accountSetId:rows[0].id,databaseInstanceId:instances[0].instance_id,period:target.period,currency:'CNY'},bindingOrigin:'existing_database_identity'};
 }catch(error){if(error.code?.startsWith('finance_target_'))throw error;fail('finance_target_unavailable');}finally{db?.close();}
}

// HTTP 配置地址本身不证明后端账库身份；写凭证须能在所观察账库找到本次真实操作回执。
export function nativeVoucherObservation(binding,{operationId,voucherId,startedAt}={}){
 if(typeof operationId!=='string'||!Number.isSafeInteger(voucherId)||typeof startedAt!=='string')return false;
 let db;try{db=new DatabaseSync(binding.dbPath,{readOnly:true});const row=db.prepare("SELECT action,targets_json,receipt_json,prepared_at FROM audit_operations WHERE database_instance_id=? AND operation_id=? AND state='succeeded' ORDER BY attempt DESC LIMIT 1").get(binding.scope.databaseInstanceId,operationId);
  if(!row||!['voucher.create','voucher.create_posted'].includes(row.action)||row.prepared_at<startedAt)return false;
  const targets=JSON.parse(row.targets_json),receipt=JSON.parse(row.receipt_json),actual=db.prepare('SELECT account_set_id,period FROM vouchers WHERE id=?').get(voucherId);
  return targets.accountSetId===binding.scope.accountSetId&&receipt.databaseInstanceId===binding.scope.databaseInstanceId&&receipt.resultRefs?.some(ref=>ref.type==='voucher'&&ref.id===voucherId)&&actual?.account_set_id===binding.scope.accountSetId&&actual.period===binding.scope.period;
 }catch{return false;}finally{db?.close();}
}
