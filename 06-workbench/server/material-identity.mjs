// 原件主体只与账库已有登记比对；购销双方各自保留角色，不把交易对手当作主体冲突。
const identity = value => typeof value === 'string' ? value.normalize('NFKC').replace(/\s/g, '').toUpperCase() : '';
export function registeredMaterialIdentity(db, scope) {
  const row = db.prepare('SELECT * FROM account_sets WHERE id=?').get(scope.accountSetId);
  const registered = db.prepare('SELECT enterprise_key,enterprise_name FROM import_enterprise_account_sets UNION SELECT enterprise_key,enterprise_name FROM import_source_bindings').all();
  // 当前标准账套没有税号列。只使用实际存在且有值的登记列，绝不把 enterpriseKey 猜成税号。
  const taxIds = ['taxpayer_id','taxpayer_number','taxpayer_no','credit_code','tax_id'].flatMap(key => typeof row?.[key] === 'string' && row[key].trim() ? [row[key]] : []);
  return {...row, registeredNames:[...new Set(registered.filter(r => r.enterprise_key === scope.enterpriseKey && r.enterprise_name).map(r => r.enterprise_name))], conflictingNames:[...new Set(registered.filter(r => r.enterprise_key !== scope.enterpriseKey && r.enterprise_name).map(r => r.enterprise_name))], registeredTaxIds:taxIds};
}
export function matchMaterialParty(party, registered) {
  const ids=(registered.registeredTaxIds??[]).map(identity), names=(registered.registeredNames??[]).map(identity), conflicting=(registered.conflictingNames??[]).map(identity), name=identity(party.name), taxId=identity(party.taxId);
  const byTaxId=ids.length>0&&!!taxId, conflict=!byTaxId&&!!name&&names.includes(name)&&conflicting.includes(name);
  const matched=!conflict&&(byTaxId?ids.includes(taxId):!!name&&names.includes(name));
  return {matched:!!matched,...(conflict?{conflict:true}:{}),role:party.role,basis:byTaxId?'registered_tax_id':'registered_name',taxIdAvailability:ids.length?'registered':'not_registered',...(matched&&party.role==='buyer'?{invoiceDirection:'purchase'}:matched&&party.role==='seller'?{invoiceDirection:'sale'}:{})};
}
