// 只读投影已有批处理检查点与原始 Harness 回执。
// 此处不解决操作结果、不授权重试，也不改变任务或复核状态。
const identityKeys=['storePath','taskId','capabilityId','dependencyDigest','period'];
const sameIdentity=(identity,expected)=>identity&&expected&&identityKeys.every(key=>typeof identity[key]==='string'&&identity[key]===expected[key]);
const receiptMatches=(receipt,identity)=>receipt&&['taskId','capabilityId','dependencyDigest'].every(key=>typeof identity?.[key]==='string'&&receipt[key]===identity[key]);
const receipts=bridge=>[bridge?.historicalReceipt,bridge?.observation?.originalReceipt,bridge?.observation?.receipt];
export function committedBridgeObservation(bridge,expected=bridge?.taskIdentity,depth=0){
 if(!bridge||depth>4||!sameIdentity(bridge.taskIdentity,expected))return null;
 // operationState 属于任务历史，未必对应当前 manifest 的请求；
 // 只有绑定精确任务及输入版本的回执，才能证明该请求的效果。
 if(receipts(bridge).some(receipt=>receiptMatches(receipt,expected)&&receipt.executionState==='executed'))return Object.fromEntries(['taskIdentity','operationId','operationState','historicalReceipt','observation'].filter(key=>bridge[key]!==undefined).map(key=>[key,bridge[key]]));
 return committedBridgeObservation(bridge.priorCommittedObservation,expected,depth+1);
}
function stageEffect(stage){
 const bridge=stage.evidence?.bridge;
 if(committedBridgeObservation(bridge)||!bridge&&stage.status==='succeeded')return true;
 if(stage.status==='running'||bridge?.operationState==='unknown'||bridge?.observation?.observation?.applied==='unknown')return null;
 if(bridge?.operationState==='not_started'&&sameIdentity(bridge.taskIdentity,bridge.taskIdentity))return false;
 if(bridge?.observation?.observation?.status==='not_executed'&&bridge.observation.observation.applied===false&&receipts(bridge).some(receipt=>receiptMatches(receipt,bridge.taskIdentity)))return false;
 if(stage.status==='not_applicable'||stage.attempt===0&&['pending','blocked_dependency','cancelled'].includes(stage.status))return false;
 return null;
}
export const PARTIAL_EFFECTS_MEANING='For an incomplete/unverified batch: true means a persisted stage or original Harness receipt bound to this manifest task/input version proves an effect already occurred; false means all stages are proven unexecuted/not applicable; null means effects cannot yet be established. A wholly succeeded batch retains partialEffects=false with applied=true. Historical effects do not establish current results or accountant confirmation.';
export function batchPartialEffects(report,{complete=report?.status==='succeeded'}={}){
 if(complete)return false;
 if(!report||!Array.isArray(report.items))return null;
 const effects=report.items.flatMap(item=>item.stages??[]).map(stageEffect);
 return effects.includes(true)?true:effects.includes(null)?null:false;
}
