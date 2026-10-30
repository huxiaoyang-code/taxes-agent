// 只做显式本机范围发现；不导入默认数据库，也不写数据库结构。
import { DatabaseSync } from 'node:sqlite';
import { checkedPath } from './offline-material-store.mjs';
import { requireValue } from './harness-store.mjs';
export async function discoverHarnessTarget(dbPath=process.env.FINANCE_DATABASE_PATH) {
 requireValue(typeof dbPath==='string'&&dbPath.length>0,'harness_database_path_required');const path=await checkedPath(dbPath);
 const db=new DatabaseSync(path,{readOnly:true});try{
  const instance=db.prepare('SELECT instance_id FROM audit_database_instances WHERE is_active=1').all();requireValue(instance.length===1,'harness_instance_unavailable');
  const sets=db.prepare('SELECT a.id,a.name,a.start_period,a.accounting_profile_id,b.enterprise_key FROM account_sets a LEFT JOIN import_enterprise_account_sets b ON b.account_set_id=a.id ORDER BY a.id').all();
  return {status:'discovered',dbPath:path,databaseInstanceId:instance[0].instance_id,accountSets:sets.map(s=>({accountSetId:s.id,enterpriseKey:s.enterprise_key??null,name:s.name,startPeriod:s.start_period,profileId:s.accounting_profile_id,periods:db.prepare('SELECT period,status FROM periods WHERE account_set_id=? ORDER BY period').all(s.id)})),selection:'Explicitly select the company/account set and requested period; never infer a default',creation:'For a new company use existing deferred account_set_create against the same explicitly configured local backend, then rediscover the actual binding'};
 }finally{db.close();}
}
