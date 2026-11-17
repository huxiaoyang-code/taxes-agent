// 测试只循真实MCP材料合同续页，汇集安全投影；不读本机底稿来伪造模型侧事实或支持。
import {readBaselineMaterials} from '../../server/business-baseline.mjs';

export async function readBackendBaselinePages(args,options){
 let current=await readBaselineMaterials(args,options);const initial=current,sections=current.section==='structure'?['structure']:['overview','facts','tax'],out={fields:[],facts:[],principleSupport:[]},taxSummaries=[];
 for(const section of sections){
  let page=!current.sourceInventory&&current.section===section&&current.pagination.offset===0?current:await readBaselineMaterials({target:args.target,materialRefs:[{materialRef:current.materialRef,snapshotDigest:current.snapshotDigest}],section,limit:50},options);
  for(let i=0;;i++){
   if(i>1000)throw Error('synthetic_material_pagination_limit');current=page;
   for(const key of ['fields','facts','principleSupport'])out[key].push(...(page[key]??[]));
   if(page.taxBurden){if(section==='tax')taxSummaries.push(...page.taxBurden.summaries);out.taxBurden={...page.taxBurden,...(section==='tax'?{summaries:[...taxSummaries]}:{})};}
   if(!page.pagination.next)break;page=await readBaselineMaterials(page.pagination.next.arguments,options);
  }
 }
 return {...initial,...current,...out};
}
