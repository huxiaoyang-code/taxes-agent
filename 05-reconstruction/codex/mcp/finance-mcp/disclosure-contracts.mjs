// Catalog → inspect → invoke, following Anthropic progressive tool discovery.
// Input definitions are shared with the executing Harness, not a second schema copy.
import {capabilityInputContract,CAPABILITY_DOMAINS} from '../../../../06-workbench/server/harness-input-contracts.mjs';
const failure=(code,details)=>{throw Object.assign(new Error(code),{code,details});};
export function capabilityGuide(capability,includeTrace=false){
 const contract=capabilityInputContract(capability.capabilityId);
 return {version:'finance-capability-guide/2',capabilityId:capability.capabilityId,contractAvailable:true,...contract,requestPlacement:'将 Agent 编写且有来源支持的请求登记为事实，再用 task.requestFactId 显式选择。将该事实及全部推导输入列入 task.factIds。未指定 requestFactId 的旧任务仍使用首个事实。',supportedPeriods:capability.supportedPeriods,necessaryFacts:capability.necessaryFacts,supportConditions:capability.supportConditions,recovery:capability.recovery??{action:'核实当前输入/来源版本后才可重新读取'},nativeDetails:'skills_read '+contract.wiki,codeDigest:capability.codeDigest,ruleVersion:capability.ruleVersion,...(includeTrace?{traceReferences:capability.traceReferences}:{traceCount:capability.traceReferences.length,traceDetails:{tool:'harness_discover',arguments:{capabilityId:capability.capabilityId,responseMode:'full'}}})};
}
export function discoverySummary(native,capabilityId,includeTrace=false,options={}){
 if(capabilityId){const cap=native.capabilities.find(c=>c.capabilityId===capabilityId);if(!cap)failure('harness_capability_unknown',{capabilityId,hint:'先按 domain 或 query 搜索，再检查实际返回的 capabilityId。'});return capabilityGuide(cap,includeTrace);}
 const {domain,query,offset=0,limit=8}=options;
 if(domain!==undefined&&!Object.hasOwn(CAPABILITY_DOMAINS,domain))failure('harness_discovery_domain_invalid',{domains:Object.keys(CAPABILITY_DOMAINS)});
 if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>16)failure('harness_discovery_page_invalid',{hint:'offset 为非负整数；limit 为 1..16。'});
 const domains=Object.entries(CAPABILITY_DOMAINS).map(([id,d])=>({domain:id,name:d.name,description:d.description,count:native.capabilities.filter(c=>c.capabilityId.startsWith(id+'.')).length,wiki:d.wiki,inspect:{tool:'harness_discover',arguments:{domain:id}}}));
 const result={version:'finance-harness-discovery/2',stateAxes:native.stateAxes,parsing:native.parsing,onlineTaxConnected:native.onlineTaxConnected,totalCapabilities:native.capabilities.length,selection:'仅为候选能力；Agent 需核实适用性、原始事实、授权及当前原生守卫。',domains};
 if(domain===undefined&&query===undefined)return {...result,capabilities:[],nextSteps:[{tool:'harness_discover',arguments:{domain:'agency'},purpose:'浏览相关领域；其他领域名称见上方目录。'},{tool:'harness_discover',arguments:{query:'service workpaper'},purpose:'搜索名称、描述和领域词，检查选中的 capabilityId。'}],nextStep:'选择 domain 或 query。此入口有意不加载全部能力合同。'};
 const terms=(query??'').normalize('NFKC').toLowerCase().trim().split(/\s+/).filter(Boolean);
 const matches=native.capabilities.filter(c=>!domain||c.capabilityId.startsWith(domain+'.')).map(c=>{const d=CAPABILITY_DOMAINS[c.capabilityId.split('.')[0]],text=(c.capabilityId+' '+c.description+' '+d.name+' '+d.description+' '+d.keywords).toLowerCase(),score=terms.reduce((n,t)=>n+(text.includes(t)?1:0),0);return {c,score};}).filter(x=>!terms.length||x.score>0).sort((a,b)=>b.score-a.score||a.c.capabilityId.localeCompare(b.c.capabilityId));
 const capabilities=matches.slice(offset,offset+limit).map(({c})=>({capabilityId:c.capabilityId,description:c.description.split('; internal input guide:')[0],availability:c.availability,effect:c.effect,supportedPeriods:c.supportedPeriods,contract:{tool:'harness_discover',arguments:{capabilityId:c.capabilityId}}}));
 const nextOffset=offset+capabilities.length<matches.length?offset+capabilities.length:null;
 return {...result,domain:domain??null,query:query??null,totalMatches:matches.length,offset,limit,nextOffset,capabilities,nextSteps:capabilities.map(c=>c.contract),...(nextOffset===null?{}:{nextPage:{tool:'harness_discover',arguments:{...(domain?{domain}:{}),...(query!==undefined?{query}:{}),offset:nextOffset,limit}}}),nextStep:matches.length?'检查选中的 capabilityId，读取完整可执行合同、示例、限制和恢复指引。':'未找到匹配。扩大 query 或选择目录中的领域；不能据此推断业务适用性。'};
}
