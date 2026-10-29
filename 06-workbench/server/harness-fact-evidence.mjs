// Evidence binding validates precise locations and declared derivation inputs.
// It cannot prove that an Agent understood a document or a policy correctly.
import {readLocalFile} from './offline-material-store.mjs';
import {createHash} from 'node:crypto';
const fail=c=>{throw Object.assign(new Error(c),{code:c});};
const check=(v,c)=>{if(!v)fail(c);};
const stable=v=>Array.isArray(v)?`[${v.map(stable)}]`:v&&typeof v==='object'?`{${Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+stable(v[k]))}}`:JSON.stringify(v);
export const factValueDigest=value=>createHash('sha256').update(stable(value)).digest('hex');
export function factEvidenceError(error,f,context={}){
 if(error?.details?.problems)return error;
 const code=/^harness_[a-z0-9_]+$/.test(error?.code)?error.code:'harness_fact_evidence_invalid',json=context.locatorKind==='json_pointer';
 const invalidSourceRefs=code==='harness_fact_invalid'&&f&&typeof f==='object'&&(!Array.isArray(f.sourceRefs)||f.sourceRefs.some(ref=>typeof ref!=='string'));
 if(invalidSourceRefs){const index=Array.isArray(f.sourceRefs)?f.sourceRefs.findIndex(ref=>typeof ref!=='string'):-1;context={...context,field:index<0?'sourceRefs':`sourceRefs[${index}]`,hint:'sourceRefs 须为已登记 sourceId 字符串数组，例如 ["main"]。不要在这里放 {sourceId,locator} 对象。精确值位置放入 evidence.bindings:[{sourceId:"main",valuePath:"",locator:{startLine:2,endLine:3},quote:"..."}]。'};}
 const hints={harness_evidence_quote_mismatch:json?'JSON pointer 证据可省略 binding.quote，或使用 JSON.stringify(选中的原件值)。quote 与 locator 同级，绝不能放入 locator 内。':'将 quote 直接放在 binding 上，与 locator 同级。它须与选中的原件行/列完全一致；绝不能放入 locator 内。',harness_evidence_locator_invalid:'JSON 使用 locator:{jsonPointer:"/field"}，文本使用 locator:{startLine:1,endLine:1,startColumn?:1,endColumn?:3}。文本 quote 是 binding 上与 locator 同级的字段。行/列从 1 开始；列按 Unicode 码点计数。',harness_evidence_value_mismatch:'valuePath 选择 fact.value 中的声明值。它须与选中的原件值完全匹配（decimal 格式仅规范化金额表示）。无支持的推断保留为 missing/unknown/judgment；不得修改原件。',harness_evidence_value_unbound:'使用 binding 的 valuePath 覆盖 fact.value 的每个叶字段。空 valuePath 绑定整个声明值。',harness_derived_input_invalid:'inputs 须引用有证据支持的 provided 事实及其当前 valueDigest（稳定 JSON 的 SHA256：对象键排序，数组保序，无空白）。刷新已变化输入并重新计算推导请求。',harness_derived_sources_unbound:'推导事实的 sourceRefs 须包含每个输入事实的全部 sourceRefs。',harness_derived_validation_required:'validationRefs 须指向已登记、已解析且有已保存解析代码和验证文件的来源，并同时列入本事实的 sourceRefs。',harness_judgment_cannot_be_provided:'判断或假设不能标为 provided。在获得支持前保留 unknown/conflict/missing，或登记经过复核的推导。',harness_evidence_source_changed:'已登记原件的字节发生变化。先调查并登记新来源版本，再重新绑定事实。'};
 const safeId=id=>typeof id==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(id)?id:null;
 const problem={code,factId:safeId(f?.factId),sourceId:safeId(context.sourceId),valuePath:typeof context.valuePath==='string'&&context.valuePath.length<=2048&&!/[\0\r\n]/.test(context.valuePath)?context.valuePath:null,bindingIndex:context.bindingIndex??null,inputFactId:safeId(context.inputFactId),locatorKind:context.locatorKind??'not_applicable',field:context.field??'evidence',hint:context.hint??hints[code]??'阅读 harness/references/materials.md 的 evidence/1 字段说明。保留原件值和验证检查，仅修复声明的证据结构。'};
 return Object.assign(new Error(code),{code,details:{problems:[problem]}});
}
export function evidencePointer(value,pointer){check(typeof pointer==='string'&&(pointer===''||pointer.startsWith('/')),'harness_evidence_locator_invalid');for(const part of pointer===''?[]:pointer.slice(1).split('/')){const key=part.replaceAll('~1','/').replaceAll('~0','~');check(value&&typeof value==='object'&&Object.hasOwn(value,key)&&!['__proto__','prototype','constructor'].includes(key),'harness_evidence_locator_invalid');value=value[key];}return value;}
export function validateFactEvidenceShape(e){
 check(e&&e.version==='harness-fact-evidence/1'&&['original','derived','judgment'].includes(e.kind),'harness_fact_evidence_invalid');
 check(Object.keys(e).every(k=>['version','kind','bindings','inputs','method','validationRefs'].includes(k)),'harness_fact_evidence_invalid');
 if(e.kind==='original')check(Array.isArray(e.bindings)&&e.bindings.length>0&&e.bindings.length<=1000,'harness_fact_evidence_invalid');
 if(e.kind==='derived')check(Array.isArray(e.inputs)&&e.inputs.length>0&&e.inputs.length<=1000&&typeof e.method==='string'&&e.method.trim().length>0&&e.method.length<=8192&&Array.isArray(e.validationRefs)&&e.validationRefs.length>0,'harness_fact_evidence_invalid');
 return e;
}
export async function locatedBinding(bytes,binding,claimed){
 const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes).replace(/^\uFEFF/,'');
 const loc=binding.locator;check(loc&&typeof loc==='object','harness_evidence_locator_invalid');let actual;
 if(typeof loc.jsonPointer==='string'){actual=evidencePointer(JSON.parse(text),loc.jsonPointer);if(binding.quote!==undefined)check(binding.quote===JSON.stringify(actual),'harness_evidence_quote_mismatch');}
 else {check(Number.isSafeInteger(loc.startLine)&&loc.startLine>0&&Number.isSafeInteger(loc.endLine)&&loc.endLine>=loc.startLine,'harness_evidence_locator_invalid');const lines=text.split(/\r?\n/);check(loc.endLine<=lines.length,'harness_evidence_locator_invalid');let quote=lines.slice(loc.startLine-1,loc.endLine).join('\n');if(loc.startColumn!==undefined||loc.endColumn!==undefined){const points=[...quote];check(loc.startLine===loc.endLine&&Number.isSafeInteger(loc.startColumn)&&Number.isSafeInteger(loc.endColumn)&&loc.startColumn>0&&loc.endColumn>=loc.startColumn&&loc.endColumn<=points.length,'harness_evidence_locator_invalid');quote=points.slice(loc.startColumn-1,loc.endColumn).join('');}check(typeof binding.quote==='string'&&binding.quote===quote,'harness_evidence_quote_mismatch');actual=binding.format==='json'?JSON.parse(quote):quote;}
 if(binding.transform!==undefined){const maps={'tax-location-classification-v1':{'市区':'city','县城':'county_town','镇':'county_town','县城镇':'county_town','其他地区':'other',city:'city',county_town:'county_town',other:'other'},'tax-payment-document-kind-v1':{'税收完税证明':'tax_payment','银行税款扣缴回单':'tax_payment','税款缴款回单':'tax_payment',tax_payment:'tax_payment'},'tax-obligation-id-v1':{'企业所得税':'corporate_income','增值税':'vat',corporate_income:'corporate_income',vat:'vat'}};check(Object.hasOwn(maps,binding.transform),'harness_evidence_transform_invalid');const map=maps[binding.transform];check(Object.hasOwn(map,actual),'harness_evidence_value_mismatch');actual=map[actual];}
 // Decimal text can vary only by harmless representation, never by amount.
 if(binding.format==='decimal'){const decimal=v=>{check(typeof v==='string'||typeof v==='number','harness_evidence_value_mismatch');const s=String(v);check(/^-?\d+(?:\.\d{1,2})?$/.test(s),'harness_evidence_value_mismatch');const neg=s.startsWith('-'),parts=s.replace(/^-/,'').split('.');return (neg?-1n:1n)*(BigInt(parts[0])*100n+BigInt((parts[1]??'').padEnd(2,'0')));};check(decimal(actual)===decimal(claimed),'harness_evidence_value_mismatch');}
 else check(stable(actual)===stable(claimed),'harness_evidence_value_mismatch');
 return true;
}
async function validateRegisteredFactEvidenceValue(f,sources,facts){
 if(!f.evidence)return {verified:false,kind:'legacy_unverified'};
 const e=validateFactEvidenceShape(f.evidence);check(!(f.state==='provided'&&e.kind==='judgment'),'harness_judgment_cannot_be_provided');
 if(f.state!=='provided')return {verified:false,kind:e.kind};
 if(e.kind==='original'){
  const leaves=(v,p='')=>v&&typeof v==='object'&&Object.keys(v).length?Object.entries(v).flatMap(([k,x])=>leaves(x,p+'/'+k.replaceAll('~','~0').replaceAll('/','~1'))):[p];
  for(const path of leaves(f.value))if(!e.bindings.some(b=>typeof b?.valuePath==='string'&&(b.valuePath===''||path===b.valuePath||path.startsWith(b.valuePath+'/'))))throw factEvidenceError({code:'harness_evidence_value_unbound'},f,{valuePath:path,field:'evidence.bindings.valuePath'});
  for(const [bindingIndex,b]of e.bindings.entries())try{check(b&&typeof b.sourceId==='string'&&f.sourceRefs.includes(b.sourceId)&&sources.has(b.sourceId)&&typeof b.valuePath==='string','harness_fact_evidence_invalid');const source=sources.get(b.sourceId);check(source.originals.length===1,'harness_fact_evidence_invalid');const file=await readLocalFile(source.originals[0].path,64*1024*1024);check(createHash('sha256').update(file.bytes).digest('hex')===source.originals[0].digest,'harness_evidence_source_changed');await locatedBinding(file.bytes,b,evidencePointer(f.value,b.valuePath));}catch(error){throw factEvidenceError(error,f,{sourceId:b?.sourceId,valuePath:b?.valuePath,bindingIndex,locatorKind:typeof b?.locator?.jsonPointer==='string'?'json_pointer':b?.locator?'text_lines':'missing',field:`evidence.bindings[${bindingIndex}].${error.code==='harness_evidence_quote_mismatch'?b?.locator&&Object.hasOwn(b.locator,'quote')&&!Object.hasOwn(b,'quote')?'locator.quote':'quote':error.code==='harness_evidence_value_mismatch'?'valuePath':error.code==='harness_evidence_locator_invalid'?'locator':'sourceId'}`});}
 }
 if(e.kind==='derived'){
  const walk=(id,seen=new Set())=>{check(!seen.has(id),'harness_derived_input_cycle');const next=facts.get(id);if(next?.evidence?.kind==='derived'){const copy=new Set([...seen,id]);next.evidence.inputs.forEach(i=>walk(i.factId,copy));}};walk(f.factId);
  for(const [inputIndex,input]of e.inputs.entries())try{const prior=facts.get(input.factId);check(prior&&prior.factId!==f.factId&&prior.state==='provided'&&prior.evidence&&prior.evidence.kind!=='judgment'&&factValueDigest(prior.value)===input.valueDigest,'harness_derived_input_invalid');check(prior.sourceRefs.every(id=>f.sourceRefs.includes(id)),'harness_derived_sources_unbound');}catch(error){throw factEvidenceError(error,f,{inputFactId:input?.factId,field:`evidence.inputs[${inputIndex}].${error.code==='harness_derived_input_invalid'?'valueDigest':'sourceRefs'}`});}
  check(e.validationRefs.every(id=>f.sourceRefs.includes(id)&&sources.get(id)?.parsed&&sources.get(id).code.length&&sources.get(id).validation.length),'harness_derived_validation_required');
 }
 return {verified:true,kind:e.kind,limitation:e.kind==='derived'?'输入/值绑定及已保存验证均存在；计算方法与语义含义仍须复核。':'选中的精确值与定位到的原件字节匹配；语义含义仍须复核。'};
}
export async function validateRegisteredFactEvidence(f,sources,facts){try{return await validateRegisteredFactEvidenceValue(f,sources,facts);}catch(error){throw factEvidenceError(error,f);}}
