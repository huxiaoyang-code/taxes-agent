// 仅在真实 direct 分派结束后复用原有模型可见投影；不重新挑字段，也不接收模型自报的“安全结果”。
// 进程内对象身份绑定工具及当时快照，JSON 声明/重新构造同形对象不能取得此标记。
const directVersions=Object.freeze({
 finance_workpaper:'finance-business-result/1',
 finance_tax_calculate:'finance-business-result/1',
 finance_tax_summary_calculate:'finance-tax-summary-result/1',
 finance_quarter_review:'chinese-quarter-review-result/1',
});
const projections=new WeakMap();
const fail=()=>{throw Object.assign(Error('finance_memory_native_result_unconfirmed'),{code:'finance_memory_native_result_unconfirmed'});};
export function retainDirectMethodProjection(tool,result){
 if(!Object.hasOwn(directVersions,tool)||!result||typeof result!=='object'||Array.isArray(result)||result.version!==directVersions[tool])fail();
 let snapshot;try{snapshot=structuredClone(result);}catch{fail();}
 projections.set(result,{tool,snapshot});return result;
}
export function readDirectMethodProjection(tool,result){
 if(!result||typeof result!=='object')return null;
 const saved=projections.get(result);return saved?.tool===tool?structuredClone(saved.snapshot):null;
}
