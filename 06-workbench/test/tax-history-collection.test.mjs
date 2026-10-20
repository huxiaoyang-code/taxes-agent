import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir,writeFile,link,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {fixture,recipe,row,response,ref,safe,PRIVATE} from './tax-history-fixture.mjs';
import {historyRecipeValid,historyProjection,historySummary,historyDocumentValid,buildHistoryTemplate,compareHistory,validateHistoryRecord} from '../server/tax-history-contract.mjs';
import {TaxHistoryCollection} from '../server/tax-history-collection.mjs';
import {TaxHistoryStore} from '../server/tax-history-store.mjs';
test('fixed recipe admits exactly nine observed JSON body fields and no query/alternate URL',()=>{
  assert.ok(historyRecipeValid(recipe()));
  for(const mutate of [r=>r.path+='x',r=>r.method='GET',r=>r.query.push({key:'t',value:'1'}),r=>r.body.enterprise=PRIVATE,
    r=>delete r.body.skssqq,r=>r.body.gzlx.push('c'),r=>r.body.pageSize='10',r=>r.body.pageNum=1.5]){
    const r=recipe();mutate(r);assert.equal(historyRecipeValid(r),false);
  }
});
test('whitelist preserves every duplicate row instance, rejects invalid dates/schema and omits unknown fields',()=>{
  const body=response();body.Response.Data.List[0][PRIVATE]=PRIVATE;
  const p=historyProjection(body,recipe());assert.equal(p.rows.length,2);assert.equal(Object.keys(p.rows[0]).length,13);assert.equal(p.rows[0][PRIVATE],undefined);
  for(const value of ['2026-02-30 00:00:00','2026-09-01','20260901','2026-09-01 01:00:00','0000-01-01 00:00:00','']){
    const b=response();b.Response.Data.List[0].skssqq=value;assert.throws(()=>historyProjection(b,recipe()),/history_period_invalid/);
  }
  const missing=response();delete missing.Response.Data.List[0].skssqq;assert.throws(()=>historyProjection(missing,recipe()),/history_shape_invalid/);
  const inverted=response();inverted.Response.Data.List[0].skssqq='2026-10-01 00:00:00';assert.throws(()=>historyProjection(inverted,recipe()),/history_period_invalid/);
  const error=response();error.Response.Error={Message:PRIVATE};assert.throws(()=>historyProjection(error,recipe()),/^Error: history_business_failed$/);
  assert.equal(historySummary(p).capturedQueryCoverageComplete,true);assert.equal(historySummary(p).allHistoryVerified,false);
  assert.equal(historySummary(historyProjection(response([row()],12),recipe())).capturedQueryCoverageComplete,false);
});
for(const [responseField,bodyField] of [['PageNumber','pageNum'],['PageSize','pageSize']]){
  test('captured and active response must match fixed request '+bodyField,async()=>{
    await fixture(async f=>{
      const mismatched=structuredClone(f.manifest);mismatched.requests[0].body[bodyField]=2;
      assert.throws(()=>buildHistoryTemplate(mismatched,f.parent,f.artifactRef),/^Error: history_shape_invalid$/);
      const refreshed=await f.collector.refresh({artifactRef:f.artifactRef});assert.equal(refreshed.status,'history_context_refreshed');
      const initial=(await readdir(f.store.root)).length,openDiagnostic=f.collector.d.openDiagnostic;
      f.collector.d.openDiagnostic=async(...args)=>{
        const transport=await openDiagnostic(...args),send=transport.cdp.send.bind(transport.cdp);
        transport.cdp.send=async(method,...params)=>{
          const reply=await send(method,...params),data=reply?.result?.value?.body?.Response?.Data;
          if(method==='Runtime.evaluate'&&Array.isArray(data?.List))data[responseField]=responseField==='PageNumber'?2:20;
          return reply;
        };return transport;
      };
      const result=await f.collector.collect({contextRef:refreshed.contextRef});safe(result);
      assert.equal(result.status,'history_collection_failed');assert.equal(result.reason,'history_shape_invalid');
      assert.equal(result.runRef,undefined);assert.notEqual(result.capturedQueryCoverageComplete,true);
      assert.equal((await readdir(f.store.root)).length,initial);assert.equal(result.lockRetained,false);
    });
  });
}
test('full document restriction and immutable captured template do not rewrite parent or permit other routes',async()=>{
  await fixture(async f=>{
    const before=JSON.stringify(f.parent),t=buildHistoryTemplate(f.manifest,f.parent,f.artifactRef);assert.equal(JSON.stringify(f.parent),before);
    assert.ok(historyDocumentValid(t.captureDocument));
    for(const ending of ['#','#/a','&ruuid=x','&token=x']){
      const d={...t.captureDocument,fullUrl:t.captureDocument.fullUrl+ending};d.documentUrlDigest=createHash('sha256').update(d.fullUrl).digest('hex');
      assert.equal(historyDocumentValid(d),false);
    }
    for(const mutate of [m=>m.target='taxpayer_profile',m=>m.requests[0].url+='?t=1',m=>m.document.loaderId=f.parent.loaderId,
      m=>m.identityProjection.userinfo.taxpayer_id+='different',m=>m.requests.push(m.requests[0])]){
      const m=structuredClone(f.manifest);mutate(m);assert.throws(()=>buildHistoryTemplate(m,f.parent,f.artifactRef));
    }
  });
});
test('two actual synthetic VM fetch runs and private ledgers compare content without inventing identity',async()=>{
  await fixture(async f=>{
    const refreshed=await f.collector.refresh({artifactRef:f.artifactRef});safe(refreshed);assert.equal(refreshed.status,'history_context_refreshed');
    assert.equal(refreshed.requestPerformedCount,2);assert.equal(refreshed.sessionEnterpriseBound,true);
    const context=await f.store.load(refreshed.contextRef),template=await f.store.load(context.templateRef);
    assert.equal(template.captureDocument.fullUrl,f.manifest.document.url);
    const first=await f.collector.collect({contextRef:refreshed.contextRef}),second=await f.collector.collect({contextRef:refreshed.contextRef});safe(first);safe(second);
    assert.equal(first.status,'history_query_observed');assert.equal(first.requestAttemptedCount,3);assert.equal(first.requestPerformedCount,3);
    assert.equal(first.responseCompleteCount,3);assert.equal(first.lockRetained,false);assert.equal(first.recordIdentityVerified,false);
    assert.equal(first.parameterEnterpriseBound,false);assert.equal(first.responseEnterpriseBound,false);assert.equal(first.rowCount,2);
    assert.notEqual(first.runRef,second.runRef);assert.equal((await f.store.load(first.runRef)).projection.rows.length,2);
    const comparison=await f.collector.compare({leftRef:first.runRef,rightRef:second.runRef});safe(comparison);
    assert.equal(comparison.status,'history_runs_compared');assert.equal(comparison.contentMultisetEqual,true);assert.equal(comparison.independentRequests,true);
    f.state.mode='changed';const third=await f.collector.collect({contextRef:refreshed.contextRef});
    assert.equal((await f.collector.compare({leftRef:first.runRef,rightRef:third.runRef})).contentMultisetEqual,false);
    assert.equal((await f.collector.compare({leftRef:first.runRef,rightRef:first.runRef})).status,'not_comparable');
    assert.equal(f.state.requests.length,11);assert.deepEqual(await readdir(f.profile),[]);
  });
});
test('same row count with different periods differs; multiplicity differs and row ordering is independent',()=>{
  const a=historyProjection(response([row('a'),row('b')]),recipe()),b=structuredClone(a);b.rows.reverse();
  assert.equal(compareHistory(a,b).contentMultisetEqual,true);assert.equal(compareHistory(a,b).rowProjectionEqual,false);
  b.rows[0].skssqq='2026-08-01 00:00:00';b.rows[0].skssqz='2026-08-31 00:00:00';assert.equal(compareHistory(a,b).periodMultisetEqual,false);
  assert.equal(compareHistory(a,{...a,rows:[row('a'),row('a')]}).contentMultisetEqual,false);
});
for(const mode of ['partial','extra_field','period_invalid','enterprise_changed','business_error','aba','registry_changed','scope_before_dispatch','wrong_proof','fetch_unknown','cdp_timeout','detach_failure','close_failure','off_failure','http_error']){
  test('active safety boundary: '+mode,async()=>{
    await fixture(async f=>{
      const refresh=await f.collector.refresh({artifactRef:f.artifactRef});assert.equal(refresh.status,'history_context_refreshed');
      const initial=(await readdir(f.store.root)).length;f.state.mode=mode;
      const output=await f.collector.collect({contextRef:refresh.contextRef});safe(output);
      if(mode==='partial'){assert.equal(output.status,'history_query_partial');assert.equal(output.consumable,false);assert.equal(output.paginationSupported,false);assert.match(output.runRef,/^taxhistoryrun_/);}
      else if(mode==='extra_field'){assert.equal(output.status,'history_query_observed');const r=await f.store.load(output.runRef);assert.equal(r.projection.rows[0][PRIVATE],undefined);}
      else{assert.equal(output.status,'history_collection_failed');assert.equal(output.runRef,undefined);assert.equal((await readdir(f.store.root)).length,initial);}
      if(['fetch_unknown','cdp_timeout','wrong_proof','detach_failure','close_failure','off_failure'].includes(mode))assert.equal(output.lockRetained,true);
      if(mode==='cdp_timeout'){assert.equal(output.requestAttemptedCount,1);assert.equal(output.requestPerformedUnknownCount,1);assert.equal(output.responseCompleteUnknownCount,1);}
      if(mode==='scope_before_dispatch'){assert.equal(output.requestAttemptedCount,1);assert.equal(output.requestPerformedCount,0);assert.equal(output.requestNotPerformedCount,1);assert.equal(output.lockRetained,false);}
    });
  });
}
test('expired contexts, document changes and permanent parent tombstones block reads and comparisons',async()=>{
  await fixture(async f=>{
    const refresh=await f.collector.refresh({artifactRef:f.artifactRef}),a=await f.collector.collect({contextRef:refresh.contextRef}),b=await f.collector.collect({contextRef:refresh.contextRef});
    f.state.now+=1800000;const expired=await f.collector.collect({contextRef:refresh.contextRef});assert.equal(expired.reason,'history_context_expired');
    f.state.now=1002;f.frame.loaderId+='other';const changed=await f.collector.collect({contextRef:refresh.contextRef});assert.equal(changed.reason,'history_scope_changed');
    await writeFile(join(f.parentStore.root,'abandon_'+f.sourceRef+'.commit.json'),'damaged tombstone');
    const blocked=await f.collector.collect({contextRef:refresh.contextRef});assert.equal(blocked.runRef,undefined);
    assert.equal((await f.collector.compare({leftRef:a.runRef,rightRef:b.runRef})).status,'history_compare_failed');
    assert.equal((await f.collector.refresh({artifactRef:f.artifactRef})).contextRef,undefined);
  });
});
test('publication failures return no context or run reference and preserve bounded unknown publication state',async()=>{
  await fixture(async f=>{
    const original=f.store.save.bind(f.store);f.store.save=async(kind,...args)=>{if(kind==='context'){const e=Error(PRIVATE);e.code='history_publication_unknown';throw e;}return original(kind,...args);};
    const output=await f.collector.refresh({artifactRef:f.artifactRef});safe(output);assert.equal(output.contextRef,undefined);assert.equal(output.contextPublished,null);assert.equal(output.templatePublished,true);
  });
});
test('late tombstone after durable publication withholds ref and accurately reports an existing context',async()=>{
  await fixture(async f=>{
    const original=f.store.save.bind(f.store);f.store.save=async(kind,...args)=>{const saved=await original(kind,...args);
      if(kind==='context')await writeFile(join(f.parentStore.root,'abandon_'+f.sourceRef+'.commit.json'),'committed');return saved;};
    const output=await f.collector.refresh({artifactRef:f.artifactRef});safe(output);assert.equal(output.contextRef,undefined);
    assert.equal(output.status,'history_refresh_failed');assert.equal(output.contextPublished,true);assert.equal(output.lockRetained,false);
  });
});
test('staging ACL verification failure leaves no published template/context or staging file',async()=>{
  await fixture(async f=>{
    const original=f.store.security.verifyFile;f.store.security.verifyFile=async path=>{if(path.endsWith('.tmp'))throw Error(PRIVATE);return original(path);};
    const output=await f.collector.refresh({artifactRef:f.artifactRef});safe(output);assert.equal(output.contextRef,undefined);assert.deepEqual(await readdir(f.store.root),[]);
  });
});
test('overall deadline stops before any dispatch and production storage cannot be redirected',async()=>{
  await fixture(async f=>{
    f.state.mode='deadline';const output=await f.collector.refresh({artifactRef:f.artifactRef});safe(output);
    assert.equal(output.reason,'history_deadline');assert.equal(output.requestAttemptedCount,0);assert.equal(output.contextRef,undefined);
    await assert.rejects(new TaxHistoryStore({root:f.store.root,captureRoot:f.store.captureRoot}).ready(),/history_storage_invalid/);
  });
});
test('legacy portal source cannot be upgraded into an active history context',async()=>{
  await fixture(async f=>{
    const legacy={...f.parent,version:1};delete legacy.documentUrlSemantics;await writeFile(join(f.parentStore.root,f.sourceRef+'.json'),JSON.stringify(legacy));
    const output=await f.collector.refresh({artifactRef:f.artifactRef});safe(output);assert.equal(output.contextRef,undefined);assert.equal(f.state.opens,0);
  });
});
test('private store detects hardlinks and immutable schema tampering rather than reading an alias',async()=>{
  await fixture(async f=>{
    const refresh=await f.collector.refresh({artifactRef:f.artifactRef}),file=join(f.store.root,refresh.contextRef+'.json'),alias=join(f.store.root,'alias.json');
    await link(file,alias);await assert.rejects(f.store.load(refresh.contextRef),/history_storage_invalid/);await unlink(alias);
    const context=JSON.parse(await readFile(file,'utf8'));context.enterprise.extra=PRIVATE;await writeFile(file,JSON.stringify(context));
    await assert.rejects(f.store.load(refresh.contextRef),/history_record_invalid/);
  });
});
test('feature disabled and arbitrary inputs never open a diagnostic',async()=>{
  let opens=0;const c=new TaxHistoryCollection({enabled:false,async openDiagnostic(){opens++;throw 0;}});
  const old=process.env.TAX_HISTORY_COLLECTION_ENABLED;delete process.env.TAX_HISTORY_COLLECTION_ENABLED;
  try{assert.equal((await c.collect({contextRef:ref('taxhistorycontext')})).status,'not_enabled');
    assert.equal((await c.collect({contextRef:ref('taxhistorycontext'),body:recipe().body})).status,'input_invalid');
    assert.equal((await c.refresh({artifactRef:ref('taxquery'),path:PRIVATE})).status,'input_invalid');assert.equal(opens,0);
  }finally{if(old!==undefined)process.env.TAX_HISTORY_COLLECTION_ENABLED=old;}
});
