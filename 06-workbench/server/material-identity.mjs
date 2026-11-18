// 原件主体只与账库已有登记比对；购销双方各自保留角色，不把交易对手当作主体冲突。
const identity = value => typeof value === 'string' ? value.normalize('NFKC').replace(/\s/g, '').toUpperCase() : '';
export function registeredMaterialIdentity(db, scope) {
  const row = db.prepare('SELECT * FROM account_sets WHERE id=?').get(scope.accountSetId);
  const registered = db.prepare('SELECT enterprise_key,enterprise_name FROM import_enterprise_account_sets UNION SELECT enterprise_key,enterprise_name FROM import_source_bindings').all();
  // 当前标准账套没有税号列。只使用实际存在且有值的登记列，绝不把 enterpriseKey 猜成税号。
  const taxIds = ['taxpayer_id','taxpayer_number','taxpayer_no','credit_code','tax_id'].flatMap(key => typeof row?.[key] === 'string' && row[key].trim() ? [row[key]] : []);
  return {...row, registeredNames:[...new Set(registered.filter(r => r.enterprise_key === scope.enterpriseKey && r.enterprise_name).map(r => r.enterprise_name))], conflictingNames:[...new Set(registered.filter(r => r.enterprise_key !== scope.enterpriseKey && r.enterprise_name).map(r => r.enterprise_name))], registeredTaxIds:taxIds};
}
const partyKeys = {
  enterprise:{name:['企业名称','公司名称','纳税人名称','companyName','company_name'],taxId:['纳税人识别号','统一社会信用代码','taxpayer_id','creditCode']},
  buyer:{name:['购买方名称','购方名称','购买方','买方名称'],taxId:['购买方纳税人识别号','购买方识别号','购方纳税人识别号','购方识别号']},
  seller:{name:['销售方名称','销方名称','销售方','卖方名称'],taxId:['销售方纳税人识别号','销售方识别号','销方纳税人识别号','销方识别号']},
};
export function matchMaterialParty(party, registered) {
  const ids=(registered.registeredTaxIds??[]).map(identity), names=(registered.registeredNames??[]).map(identity), conflicting=(registered.conflictingNames??[]).map(identity), name=identity(party.name), taxId=identity(party.taxId);
  const byTaxId=ids.length>0&&!!taxId, conflict=!byTaxId&&!!name&&names.includes(name)&&conflicting.includes(name);
  const matched=!conflict&&(byTaxId?ids.includes(taxId):!!name&&names.includes(name));
  return {matched:!!matched,...(conflict?{conflict:true}:{}),role:party.role,basis:byTaxId?'registered_tax_id':'registered_name',taxIdAvailability:ids.length?'registered':'not_registered',...(matched&&party.role==='buyer'?{invoiceDirection:'purchase'}:matched&&party.role==='seller'?{invoiceDirection:'sale'}:{})};
}
export function materialPartyContext(contexts, registered) {
  const parties=[];
  for(const context of contexts) {
    if(!context||typeof context!=='object'||Array.isArray(context))continue;
    for(const [role,keys] of Object.entries(partyKeys)) {
      const nameKey=keys.name.find(k=>typeof context[k]==='string'&&context[k].trim()), taxKey=keys.taxId.find(k=>typeof context[k]==='string'&&context[k].trim());
      if(nameKey||taxKey)parties.push({...matchMaterialParty({role,name:context[nameKey],taxId:context[taxKey]},registered),hasIdentity:true});
    }
  }
  const invoice=parties.filter(p=>['buyer','seller'].includes(p.role));
  const matched=parties.filter(p=>p.matched);
  if(parties.some(p=>p.conflict))return {matched:false,conflict:true,taxIdAvailability:(registered.registeredTaxIds??[]).length?'registered':'not_registered'};
  if(new Set(matched.filter(p=>['buyer','seller'].includes(p.role)).map(p=>p.role)).size>1)return {matched:false,conflict:true,taxIdAvailability:(registered.registeredTaxIds??[]).length?'registered':'not_registered'};
  if(matched.length)return {...matched.find(p=>['buyer','seller'].includes(p.role))??matched[0],hasIdentity:true};
  return {matched:false,hasIdentity:parties.length>0,invoiceParties:invoice.length,taxIdAvailability:(registered.registeredTaxIds??[]).length?'registered':'not_registered'};
}
