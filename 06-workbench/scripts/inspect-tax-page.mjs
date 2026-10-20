// Inspect one explicitly selected official page. No requests or page operations.
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openRegisteredBrowserDiagnostic } from '../server/tax-browser-diagnostic.mjs';
import { OBSERVED_ROUTES, classifyObservedUrl, pageReference } from './inventory-tax-browser.mjs';
import {PASSIVE_RECIPES} from '../server/tax-collection-shape.mjs';

export const PAGE_INSPECTION_SCRIPT = `(() => {
  const routes = ${JSON.stringify(OBSERVED_ROUTES)};
  const origin = 'https://etax.fujian.chinatax.gov.cn:8443';
  const counts = Object.fromEntries(Object.values(routes).map(code => [code, 0]));
  let resourceCount = 0, scriptCount = 0;
  for (const entry of performance.getEntriesByType('resource').slice(0, 10000)) {
    resourceCount++;
    if (entry.initiatorType === 'script') scriptCount++;
    try { const u = new URL(entry.name, location.href);
      if (!u.username && !u.password && u.origin === origin && Object.hasOwn(routes, u.pathname)) counts[routes[u.pathname]]++;
    } catch {}
  }
  return { readyState: document.readyState,
    fetchNative: Function.prototype.toString.call(window.fetch).includes('[native code]'),
    timerNative: Function.prototype.toString.call(window.setTimeout).includes('[native code]'),
    resourceCount, scriptCount, observedResources: Object.entries(counts).map(([routeCode,count]) => ({routeCode,count})) };
})()`;

export async function inspectRegisteredPage({registrationRef, registrationRoot, pageRef, loadedSourceMatch=false} = {}, overrides = {}) {
  let transport, attached;
  try {
    if (!/^taxr_[a-f0-9]{48}$/.test(registrationRef || '') || !/^taxpage_[a-f0-9]{48}$/.test(pageRef || '')
      ||typeof loadedSourceMatch!=='boolean') throw new Error('input');
    const options = registrationRoot ? {registrationBase: dirname(resolve(registrationRoot))} : {};
    transport = await (overrides.openDiagnostic || openRegisteredBrowserDiagnostic)({registrationRef, registrationRoot}, options);
    const list = await transport.cdp.send('Target.getTargets', {}, {timeoutMs:5000});
    if (!Array.isArray(list?.targetInfos) || list.targetInfos.length > 10000) throw new Error('targets');
    const targets = list.targetInfos.filter(t => t.type === 'page' && typeof t.targetId === 'string'
      && classifyObservedUrl(t.url)?.pageClass !== 'tpass_login' && classifyObservedUrl(t.url)
      && pageReference(registrationRef,t.targetId) === pageRef);
    if (targets.length !== 1) return {status:'page_unavailable', leaseChanged:false};
    attached = await transport.cdp.send('Target.attachToTarget',{targetId:targets[0].targetId,flatten:true},{timeoutMs:5000});
    if (typeof attached?.sessionId !== 'string') throw new Error('attach');
    const result = await transport.cdp.send('Runtime.evaluate',{expression:PAGE_INSPECTION_SCRIPT,returnByValue:true,timeout:5000},
      {sessionId:attached.sessionId,timeoutMs:5000});
    const value = result?.result?.value;
    const codes = [...new Set(Object.values(OBSERVED_ROUTES))];
    const count = n => Number.isSafeInteger(n) && n >= 0 && n <= 10000;
    if (result?.exceptionDetails || !['loading','interactive','complete'].includes(value?.readyState)
      || typeof value.fetchNative !== 'boolean' || typeof value.timerNative !== 'boolean'
      || !count(value.resourceCount) || !count(value.scriptCount) || !Array.isArray(value.observedResources)
      || value.observedResources.length !== codes.length) throw new Error('projection');
    const observedResources = codes.map(routeCode => {
      const items = value.observedResources.filter(item => item?.routeCode === routeCode);
      if(items.length !== 1 || !count(items[0].count)) throw new Error('projection');
      return {routeCode,count:items[0].count};
    });
    let loadedSources;
    if(loadedSourceMatch) {
      const opts={sessionId:attached.sessionId,timeoutMs:5000};
      const tree=await transport.cdp.send('Page.getResourceTree',{},opts);
      const current=new URL(targets[0].url),sources=[],codes=Object.values(PASSIVE_RECIPES).map(r=>({resource:r.resource,sourceCount:0}));
      const visit=(node,depth)=>{
        if(!node||depth>8||sources.length>=40)return;
        for(const resource of Array.isArray(node.resources)?node.resources:[]) {
          if(sources.length>=40)break;
          try {const url=new URL(resource.url);
            if(resource.type==='Script'&&url.origin===current.origin&&!url.username&&!url.password&&!url.search&&!url.hash
              &&typeof node.frame?.id==='string'&&!sources.some(s=>s.url===resource.url)) sources.push({url:resource.url,frameId:node.frame.id});
          }catch{}
        }
        for(const child of Array.isArray(node.childFrames)?node.childFrames:[])visit(child,depth+1);
      };
      visit(tree?.frameTree,0);
      let examinedCount=0,unavailableCount=0,totalBytes=0,currentPathLiteralSourceCount=0;
      const sourceDeadline=Date.now()+12000;
      for(const source of sources) {
        if(totalBytes>=4194304||Date.now()>=sourceDeadline)break;
        try {
          const result=await transport.cdp.send('Page.getResourceContent',source,
            {...opts,timeoutMs:Math.max(1,Math.min(5000,sourceDeadline-Date.now()))});
          if(typeof result.content!=='string'||result.content.length>2097152)throw new Error('size');
          const content=result.base64Encoded?Buffer.from(result.content,'base64').toString('utf8'):result.content;
          const bytes=Buffer.byteLength(content);if(bytes>1048576)throw new Error('size');
          totalBytes+=bytes;if(totalBytes>4194304)break;
          examinedCount++;
          // Only a count leaves this process. A match is static-source evidence,
          // never route authorization, and no unknown pathname is emitted.
          if(current.pathname!=='/'&&["'",'"','`'].some(q=>content.includes(q+current.pathname+q)))currentPathLiteralSourceCount++;
          for(const [path,recipe] of Object.entries(PASSIVE_RECIPES))
            if(["'",'"','`'].some(q=>content.includes(q+path+q)))codes.find(c=>c.resource===recipe.resource).sourceCount++;
        }catch{unavailableCount++}
      }
      loadedSources={provenance:'loaded_source_literal',examinedCount,unavailableCount,currentPathLiteralSourceCount,
        truncated:examinedCount+unavailableCount<sources.length,
        candidateResources:codes,executionAuthorized:false};
    }
    const after = await transport.cdp.send('Target.getTargetInfo',{targetId:targets[0].targetId},{timeoutMs:5000});
    if (after?.targetInfo?.url !== targets[0].url) return {status:'page_changed',leaseChanged:false};
    return {status:'observed', pageRef, ...classifyObservedUrl(targets[0].url), readyState:value.readyState,
      fetchNative:value.fetchNative,timerNative:value.timerNative,resourceCount:value.resourceCount,
      scriptCount:value.scriptCount,observedResources,...(loadedSources?{loadedSources}:{}),leaseChanged:false};
  } catch { return {status:'inspection_failed',leaseChanged:false}; }
  finally {
    if(attached?.sessionId) try {await transport.cdp.send('Target.detachFromTarget',{sessionId:attached.sessionId},{timeoutMs:5000});} catch {}
    try {transport?.close();} catch {}
  }
}
if(process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const a=process.argv.slice(2);
  if(![6,7].includes(a.length) || a[0] !== '--registration-ref' || a[2] !== '--registration-root' || a[4] !== '--page-ref'
    ||a.length===7&&a[6]!=='--loaded-source-match') {
    console.error('usage: node scripts/inspect-tax-page.mjs --registration-ref <local-ref> --registration-root <local-directory> --page-ref <safe-ref>'); process.exitCode=1;
  } else { const result=await inspectRegisteredPage({registrationRef:a[1],registrationRoot:a[3],pageRef:a[5],loadedSourceMatch:a.length===7});
    console.log(JSON.stringify(result)); if(result.status !== 'observed') process.exitCode=1; }
}
