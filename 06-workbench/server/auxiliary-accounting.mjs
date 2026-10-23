import { runDomainOperation,copyDomainRequest } from './local-audit-coordinator.mjs';
// Auxiliary tuples point to the real GL; no parallel journal or inferred party identities.
import { getAccountingProfile } from './accounting-profiles.mjs';
import { assertPeriodMutable } from './period-end-controls.mjs';
import { parseMoney, storedCents, centsToNumber } from './money.mjs';
import { assertAuxiliaryReady, auxError, auxTransaction, auxFingerprint } from './auxiliary-storage.mjs';
const fail=(bad,code)=>{if(bad)throw auxError(code);};
const dims=['project','department','party'];
function text(value,code,max=200) { fail(typeof value!=='string'||!value.trim()||value.length>max||/[\x00-\x1f]/.test(value),code); return value.trim(); }
function id(value) { fail(!Number.isSafeInteger(value)||value<1,'aux_id_invalid'); return value; }
function context(db,setId) { assertAuxiliaryReady(db); id(setId); const set=db.prepare('SELECT * FROM account_sets WHERE id=?').get(setId); fail(!set,'account_set_not_found'); getAccountingProfile(set.accounting_profile_id); return set; }
function mutable(db,setId,period) { fail(db.prepare("SELECT 1 FROM periods WHERE account_set_id=? AND period=? AND status='closed'").get(setId,period),'aux_period_closed'); assertPeriodMutable(db,setId,period,{operation:'auxiliary_edit'}); }
function amount(value) { const r=parseMoney(value); fail(!r.ok||r.subCent,'aux_amount_invalid'); return Number(r.cents); }
const cents=v=>BigInt(v);
const sourceFingerprint=row=>auxFingerprint({accountSetId:row.account_set_id,entryId:row.id??null,voucherId:row.voucher_id??null,lineNo:row.line_no??null,code:row.code,period:row.period??null,debit:row.debit,credit:row.credit});
function targetRow(db,setId,target) {
 if(target.entryId!==undefined) { id(target.entryId); const row=db.prepare('SELECT e.*,v.account_set_id,v.period,v.status FROM voucher_entries e JOIN vouchers v ON v.id=e.voucher_id WHERE e.id=? AND v.account_set_id=?').get(target.entryId,setId); fail(!row,'aux_entry_not_found'); return row; }
 const row=db.prepare('SELECT * FROM opening_balances WHERE account_set_id=? AND code=?').get(setId,text(target.openingCode,'aux_opening_code_required')); fail(!row,'aux_opening_not_found'); return row;
}
function allocationRows(db,setId,target) { return target.entryId!==undefined ? db.prepare('SELECT * FROM aux_allocations WHERE account_set_id=? AND entry_id=? ORDER BY id').all(setId,target.entryId) : db.prepare('SELECT * FROM aux_allocations WHERE account_set_id=? AND opening_code=? ORDER BY id').all(setId,target.openingCode); }
const tuple = row=>({projectId:row.project_id??null,departmentId:row.department_id??null,partyId:row.party_id??null,debitCents:row.debit_cents,creditCents:row.credit_cents});
const normalizedRows = rows=>rows.map(tuple).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
function writeOperation(db,setId,requestId,action,reason,before,after) { db.prepare('INSERT INTO aux_operations(account_set_id,request_id,action,reason,before_json,after_json,created_at) VALUES(?,?,?,?,?,?,?)').run(setId,requestId,action,reason,JSON.stringify(before),JSON.stringify(after),new Date().toISOString()); }
function createAuxiliaryEntityBody(db,{accountSetId,kind,code,name,requestId}={}) {
 return auxTransaction(db,()=>{context(db,accountSetId); fail(!dims.includes(kind),'aux_kind_invalid'); code=text(code,'aux_code_invalid'); name=text(name,'aux_name_invalid'); requestId=text(requestId,'aux_request_id_required');
 const data={kind,code,name}, fingerprint=auxFingerprint(data); const old=db.prepare('SELECT * FROM aux_receipts WHERE account_set_id=? AND request_id=?').get(accountSetId,requestId);
 if(old) { fail(old.fingerprint!==fingerprint,'aux_request_conflict'); const result=JSON.parse(old.result_json); const actual=db.prepare('SELECT * FROM aux_entities WHERE id=?').get(result.id); fail(!actual||actual.kind!==kind||actual.code!==code||actual.name!==name||actual.account_set_id!==accountSetId,'aux_replay_state_conflict'); return {...result,status:'replayed'}; }
 const result={id:Number(db.prepare('INSERT INTO aux_entities(account_set_id,kind,code,name) VALUES(?,?,?,?)').run(accountSetId,kind,code,name).lastInsertRowid),...data};
 db.prepare('INSERT INTO aux_receipts VALUES(?,?,1,?,?,?,?)').run(accountSetId,requestId,fingerprint,JSON.stringify({entityId:result.id}),JSON.stringify(result),new Date().toISOString()); writeOperation(db,accountSetId,requestId,'entity_create','create',null,result); return result;});
}
function updateAuxiliaryEntityBody(db,{accountSetId,entityId,name,active,reason}={}) {
 return auxTransaction(db,()=>{context(db,accountSetId); const before=db.prepare('SELECT * FROM aux_entities WHERE id=? AND account_set_id=?').get(id(entityId),accountSetId); fail(!before,'aux_entity_not_found'); reason=text(reason,'aux_reason_required');
 const periods=db.prepare('SELECT DISTINCT COALESCE(v.period,s.start_period) period FROM aux_allocations a JOIN account_sets s ON s.id=a.account_set_id LEFT JOIN voucher_entries e ON e.id=a.entry_id LEFT JOIN vouchers v ON v.id=e.voucher_id WHERE a.account_set_id=? AND (a.project_id=? OR a.department_id=? OR a.party_id=?)').all(accountSetId,entityId,entityId,entityId);
 for(const ref of periods)mutable(db,accountSetId,ref.period);
 if(name!==undefined)name=text(name,'aux_name_invalid'); if(active!==undefined) fail(typeof active!=='boolean','aux_active_invalid');
 db.prepare('UPDATE aux_entities SET name=?,active=? WHERE id=?').run(name??before.name,active===undefined?before.active:Number(active),entityId); const after=db.prepare('SELECT * FROM aux_entities WHERE id=?').get(entityId); writeOperation(db,accountSetId,'entity:'+entityId,'entity_update',reason,before,after); return after; });
}
export function listAuxiliaryEntities(db,{accountSetId,kind}={}) { context(db,accountSetId); fail(kind!==undefined&&!dims.includes(kind),'aux_kind_invalid'); return db.prepare('SELECT * FROM aux_entities WHERE account_set_id=? AND (? IS NULL OR kind=?) ORDER BY kind,code,id').all(accountSetId,kind??null,kind??null); }
export function listAuxiliaryEntries(db,{accountSetId,voucherId,period}={}) {
 context(db,accountSetId); return db.prepare(`SELECT e.id AS entryId,e.voucher_id AS voucherId,e.line_no AS lineNo,e.code,e.debit,e.credit,v.period,v.status,
 s.source_system AS sourceSystem,s.enterprise_key AS enterpriseKey,s.source_voucher_id AS sourceVoucherId FROM voucher_entries e JOIN vouchers v ON v.id=e.voucher_id LEFT JOIN import_voucher_sources s ON s.voucher_id=v.id
 WHERE v.account_set_id=? AND (? IS NULL OR v.id=?) AND (? IS NULL OR v.period=?) ORDER BY v.id,e.line_no,e.id`).all(accountSetId,voucherId??null,voucherId??null,period??null,period??null);
}
function replaceAuxiliaryAllocationsBody(db,{accountSetId,entryId,openingCode,allocations,requestId,reason}={}) {
 return auxTransaction(db,()=>{ const set=context(db,accountSetId); fail((entryId===undefined)===(openingCode===undefined),'aux_target_invalid');
 requestId=text(requestId,'aux_request_id_required'); reason=text(reason,'aux_reason_required'); fail(!Array.isArray(allocations)||allocations.length>1000,'aux_allocations_invalid');
 const target=entryId===undefined?{openingCode:text(openingCode,'aux_opening_code_required')}:{entryId:id(entryId)}; const row=targetRow(db,accountSetId,target);
 const seen=new Set(); const parts=allocations.map(a=>{ fail(!a||typeof a!=='object','aux_allocation_invalid'); const part={}; for(const dim of dims) { const value=a[dim+'Id']; part[dim+'Id']=value===undefined||value===null?null:id(value); }
 fail(dims.every(d=>part[d+'Id']===null),'aux_dimension_required'); const key=JSON.stringify(part); fail(seen.has(key),'aux_tuple_duplicate'); seen.add(key);
 part.debitCents=amount(a.debit); part.creditCents=amount(a.credit); fail((part.debitCents>0)===(part.creditCents>0),'aux_side_invalid'); return part; }).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
 const fingerprint=auxFingerprint({version:1,target,parts,reason}); const existing=db.prepare('SELECT * FROM aux_receipts WHERE account_set_id=? AND request_id=?').get(accountSetId,requestId); const before=allocationRows(db,accountSetId,target);
 if(existing) { fail(existing.fingerprint!==fingerprint,'aux_request_conflict'); const saved=JSON.parse(existing.result_json); fail(JSON.stringify(normalizedRows(before))!==JSON.stringify(parts)||saved.sourceFingerprint!==sourceFingerprint(row),'aux_replay_state_conflict'); return {...saved,status:'replayed'}; }
 mutable(db,accountSetId,row.period??set.start_period);
 // Auxiliary openings may have opposite-side customer balances: only their net plus the explicit remainder reconciles to GL.
 if(entryId!==undefined) { const d=parts.reduce((s,a)=>s+cents(a.debitCents),0n),c=parts.reduce((s,a)=>s+cents(a.creditCents),0n); fail(d>storedCents(row.debit)||c>storedCents(row.credit),'aux_allocation_exceeds_entry'); }
 for(const part of parts) for(const dim of dims) if(part[dim+'Id']!==null) { const entity=db.prepare('SELECT * FROM aux_entities WHERE id=?').get(part[dim+'Id']); fail(!entity||entity.account_set_id!==accountSetId||entity.kind!==dim||entity.active!==1,'aux_dimension_invalid'); }
 if(entryId!==undefined) db.prepare('DELETE FROM aux_allocations WHERE account_set_id=? AND entry_id=?').run(accountSetId,entryId); else db.prepare('DELETE FROM aux_allocations WHERE account_set_id=? AND opening_code=?').run(accountSetId,openingCode);
 const ins=db.prepare('INSERT INTO aux_allocations(account_set_id,code,entry_id,opening_code,project_id,department_id,party_id,debit_cents,credit_cents) VALUES(?,?,?,?,?,?,?,?,?)');
 for(const part of parts) ins.run(accountSetId,row.code,entryId??null,openingCode??null,part.projectId,part.departmentId,part.partyId,part.debitCents,part.creditCents);
 const result={status:'applied',version:1,target,sourceFingerprint:sourceFingerprint(row),allocations:parts};
 db.prepare('INSERT INTO aux_receipts VALUES(?,?,1,?,?,?,?)').run(accountSetId,requestId,fingerprint,JSON.stringify(target),JSON.stringify(result),new Date().toISOString()); writeOperation(db,accountSetId,requestId,'allocation_replace',reason,normalizedRows(before),parts); return result;
 });
}
export function entryPartyAllocation(db,{accountSetId,entryId}={}) {
 context(db,accountSetId); const row=targetRow(db,accountSetId,{entryId}); const parts=allocationRows(db,accountSetId,{entryId}); const ids=[...new Set(parts.map(r=>r.party_id).filter(v=>v!==null))];
 const assigned=parts.filter(r=>r.party_id!==null).reduce((s,r)=>s+cents(r.debit_cents)+cents(r.credit_cents),0n), total=storedCents(row.debit)+storedCents(row.credit);
 const inactivePartyIds=ids.filter(p=>db.prepare('SELECT active FROM aux_entities WHERE id=?').get(p).active===0);
 return {accountSetId,entryId,inactivePartyIds,partyActive:ids.length===1?inactivePartyIds.length===0:null,status:ids.length===0?'unknown':ids.length===1&&assigned===total?'confirmed':'ambiguous',partyId:ids.length===1&&assigned===total?ids[0]:null,unassigned:centsToNumber(total-assigned),allocations:parts.map(tuple)};
}
function facts(db,setId,through) {
 const result=[];
 for(const opening of db.prepare('SELECT * FROM opening_balances WHERE account_set_id=? ORDER BY code').all(setId)) {
  const parts=allocationRows(db,setId,{openingCode:opening.code}); let assigned=0n;
  for(const p of parts) { assigned+=cents(p.debit_cents)-cents(p.credit_cents); result.push({code:opening.code,period:null,source:{openingCode:opening.code},...tuple(p)}); }
  const remainder=storedCents(opening.debit)-storedCents(opening.credit)-assigned;
  if(remainder!==0n)result.push({code:opening.code,period:null,source:{openingCode:opening.code},projectId:null,departmentId:null,partyId:null,debitCents:remainder>0n?remainder:0n,creditCents:remainder<0n?-remainder:0n});
 }
 const entries=db.prepare(`SELECT e.*,v.period FROM voucher_entries e JOIN vouchers v ON v.id=e.voucher_id WHERE v.account_set_id=? AND v.status='posted' AND v.period<=? ORDER BY v.period,v.id,e.line_no,e.id`).all(setId,through);
 for(const e of entries) { const parts=allocationRows(db,setId,{entryId:e.id}); let d=storedCents(e.debit),c=storedCents(e.credit); for(const p of parts) {d-=cents(p.debit_cents);c-=cents(p.credit_cents); result.push({code:e.code,period:e.period,source:{entryId:e.id,voucherId:e.voucher_id,lineNo:e.line_no},...tuple(p)}); } fail(d<0n||c<0n,'aux_allocation_corrupt'); if(d!==0n||c!==0n) result.push({code:e.code,period:e.period,source:{entryId:e.id,voucherId:e.voucher_id,lineNo:e.line_no},projectId:null,departmentId:null,partyId:null,debitCents:d,creditCents:c}); }
 return result;
}
export function auxiliaryLedger(db,{accountSetId,period,code,groupBy=dims}={}) {
 const set=context(db,accountSetId); fail(typeof period!=='string'||!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)||period<set.start_period,'aux_period_invalid'); fail(!Array.isArray(groupBy)||new Set(groupBy).size!==groupBy.length||groupBy.some(d=>!dims.includes(d)),'aux_group_invalid');
 const rows=facts(db,accountSetId,period).filter(r=>code===undefined||r.code===code), grouped=new Map();
 for(const r of rows) { const keys=Object.fromEntries(groupBy.map(dim=>[dim+'Id',r[dim+'Id']])); const key=JSON.stringify([r.code,keys]); if(!grouped.has(key)) grouped.set(key,{code:r.code,...keys,opening:0n,debit:0n,credit:0n,closing:0n,sources:[]}); const g=grouped.get(key),d=cents(r.debitCents),c=cents(r.creditCents); if(r.period===null||r.period<period)g.opening+=d-c; else {g.debit+=d;g.credit+=c;} g.closing+=d-c; g.sources.push({...r.source,period:r.period,projectId:r.projectId,departmentId:r.departmentId,partyId:r.partyId,debit:centsToNumber(d),credit:centsToNumber(c)}); }
 const groups=[...grouped.values()].map(g=>({...g,opening:centsToNumber(g.opening),debit:centsToNumber(g.debit),credit:centsToNumber(g.credit),closing:centsToNumber(g.closing),debitBalance:centsToNumber(g.closing>0n?g.closing:0n),creditBalance:centsToNumber(g.closing<0n?-g.closing:0n)}));
 const sums=Object.fromEntries(['opening','debit','credit','closing','debitBalance','creditBalance'].map(k=>[k,centsToNumber(groups.reduce((s,g)=>s+storedCents(g[k]),0n))]));
 return {accountSetId,period,groupBy,groups,totals:sums};
}
function setAuxiliaryRequirementBody(db,{accountSetId,code,project=false,department=false,party=false,reason}={}) {
 return auxTransaction(db,()=>{const set=context(db,accountSetId); mutable(db,accountSetId,set.start_period); reason=text(reason,'aux_reason_required'); for(const value of [project,department,party]) fail(typeof value!=='boolean','aux_requirement_invalid'); fail(!db.prepare('SELECT 1 FROM accounts WHERE account_set_id=? AND code=?').get(accountSetId,code),'account_not_found'); const before=db.prepare('SELECT * FROM aux_requirements WHERE account_set_id=? AND code=?').get(accountSetId,code)??null; db.prepare('INSERT INTO aux_requirements VALUES(?,?,?,?,?) ON CONFLICT(account_set_id,code) DO UPDATE SET project=excluded.project,department=excluded.department,party=excluded.party').run(accountSetId,code,Number(project),Number(department),Number(party)); writeOperation(db,accountSetId,'requirement:'+code,'requirement_set',reason,before,{code,project,department,party}); return {code,project,department,party}; });
}

export function createAuxiliaryEntity(db,options={}) {options=copyDomainRequest(options);return runDomainOperation(db,{action:'aux.entity.create',scope:{kind:'account_set',value:options.accountSetId},request:options,refs:v=>[{type:'aux_entity',id:v.id}]},()=>createAuxiliaryEntityBody(db,options));}

export function updateAuxiliaryEntity(db,options={}) {options=copyDomainRequest(options);return runDomainOperation(db,{action:'aux.entity.update',scope:{kind:'account_set',value:options.accountSetId},request:options,refs:v=>[{type:'aux_entity',id:v.id}]},()=>updateAuxiliaryEntityBody(db,options));}

export function replaceAuxiliaryAllocations(db,options={}) {options=copyDomainRequest(options);return runDomainOperation(db,{action:'aux.allocations.replace',scope:{kind:'account_set',value:options.accountSetId},request:options,refs:()=>options.entryId?[{type:'voucher_entry',id:options.entryId}]:[]},()=>replaceAuxiliaryAllocationsBody(db,options));}

export function setAuxiliaryRequirement(db,options={}) {options=copyDomainRequest(options);return runDomainOperation(db,{action:'aux.requirement.set',scope:{kind:'account_set',value:options.accountSetId},request:options,refs:()=>options.entryId?[{type:'voucher_entry',id:options.entryId}]:[]},()=>setAuxiliaryRequirementBody(db,options));}
