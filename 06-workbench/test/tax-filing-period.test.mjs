// Synthetic local evidence and fake CDP only. Never opens a real registry,
// profile, account database, browser or tax endpoint.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,lstat,readFile,writeFile,rm} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {runInNewContext} from 'node:vm';
import {summarizeFilingPeriods,compareFilingPeriods} from '../server/tax-filing-period.mjs';
import {businessProjection,collectionShape,enterpriseBasicFieldCoverage,ENTERPRISE_BASIC_FIELDS} from '../server/tax-collection-shape.mjs';
import {validateCapture,validateEvidence} from '../server/tax-collection-contract.mjs';
import {TaxLiveCollection,compareProjections} from '../server/tax-live-collection.mjs';
import {TaxCollectionStore,collectionLock} from '../server/tax-collection-local.mjs';
import {FULL_FRAME_URL_SEMANTICS,frameUrlDigest,fullFrameUrl} from '../server/tax-frame-url.mjs';
const PRIVATE='PRIVATE_BUSINESS_PERIOD_TRIPWIRE';
const temporaryParent=fileURLToPath(new URL('../.agent-runs/filing-period-test-temporary/',import.meta.url));
const ref=(prefix,digit='1')=>prefix+'_'+digit.repeat(48);
const identityRecipe={path:'/mhzx/api/mh/mhsy/getUserInfo',method:'GET',body:null,queryTimestamp:true};
const filingRecipe={path:'/mhzx/api/mh/wddb/v1/wddbquerybbsmxx',method:'POST',body:{Csbz:''},queryTimestamp:true};
const frame={id:PRIVATE+'_FRAME',loaderId:PRIVATE+'_LOADER',url:'https://etax.fujian.chinatax.gov.cn:8443/loginb/',urlFragment:'#/synthetic'};
const identityBody=(suffix='A')=>({Response:{Data:{userinfo:{reg_number:PRIVATE+'_REG',company_name:PRIVATE+'_COMPANY',
  ...Object.fromEntries(ENTERPRISE_BASIC_FIELDS.map(key=>[key,PRIVATE+'_'+key+'_'+suffix])),
  full_name:PRIVATE+'_PERSON',id_card:PRIVATE+'_PERSON_ID',agencyName:PRIVATE+'_AGENCY',agencyCreditCode:PRIVATE+'_AGENCY_ID',token:PRIVATE}}}});
const row=(start='2024-02-01',end='2024-02-29')=>({sbb:PRIVATE+'_FORM',zt:'已申报',ztBm:'03',zsxmDm:'synthetic',
  skssqq:start,skssqz:end,skssqzqz:PRIVATE+'_DISPLAY',sbqx:PRIVATE+'_DEADLINE'});
const filingBody=rows=>({Response:{Data:{wsbxxGrid:rows}}});
const captures=(rows=[row()],suffix='A')=>({identity:{resource:'identity',recipe:identityRecipe,projection:businessProjection(identityBody(suffix),'identity')},
  filing:{resource:'current_filing',recipe:filingRecipe,projection:businessProjection(filingBody(rows),'current_filing')}});
const source=(projection=captures())=>({version:2,documentUrlSemantics:FULL_FRAME_URL_SEMANTICS,authorizedNavigation:true,
  handoffMode:'quarantined_reader_new_navigation',readerStoppedConfirmed:true,registrationRef:ref('taxr'),
  registrationRoot:join(temporaryParent,'.agent-runs','tax-browser-registry'),pageRef:ref('taxpage'),targetId:PRIVATE+'_TARGET',
  frameId:frame.id,loaderId:frame.loaderId,documentUrlDigest:frameUrlDigest(frame),browserKey:'a'.repeat(64),capturedAt:1,...projection});
const safe=value=>assert.doesNotMatch(JSON.stringify(value),/PRIVATE_BUSINESS|2024-02-01|2024-02-29|2024-03-31|targetId|frameId|loaderId|profilePath|registrationRoot/);
const security={testStorage:true,async secureDirectory(path){assert.ok((await lstat(path)).isDirectory())},
  async verifyDirectory(path){assert.ok((await lstat(path)).isDirectory())},async verifyFile(path){assert.ok((await lstat(path)).isFile())}};
async function fixture(callback){
  await mkdir(temporaryParent,{recursive:true});const directory=await mkdtemp(join(temporaryParent,'tax-filing-period-'));
  try{await callback(directory)}finally{assert.equal(dirname(resolve(directory)),resolve(temporaryParent));
    assert.match(directory.split(/[\\/]/).at(-1),/^tax-filing-period-/);await rm(directory,{recursive:true,force:true})}
}

for(const [name,start,end,category] of [
  ['dashed leap day','2024-02-29','2024-02-29','validPairCount'],
  ['compact leap day','20000229','20000301','validPairCount'],
  ['mixed explicit formats','20240201','2024-02-29','validPairCount'],
  ['midnight leap day','2024-02-29 00:00:00','2024-02-29 00:00:00','validPairCount'],
  ['midnight century leap','2000-02-29 00:00:00','2000-03-01 00:00:00','validPairCount'],
  ['compact with midnight','20240201','2024-02-29 00:00:00','validPairCount'],
  ['midnight with dashed','2024-02-01 00:00:00','2024-02-29','validPairCount'],
  ['midnight century non-leap','1900-02-29 00:00:00','1900-03-01 00:00:00','invalidCalendarPairCount'],
  ['midnight ordinary non-leap','2023-02-29 00:00:00','2023-03-01 00:00:00','invalidCalendarPairCount'],
  ['midnight day overflow','2024-04-31 00:00:00','2024-05-01 00:00:00','invalidCalendarPairCount'],
  ['midnight month overflow','2024-13-01 00:00:00','2024-12-31 00:00:00','invalidCalendarPairCount'],
  ['midnight zero year','0000-01-01 00:00:00','0000-01-02 00:00:00','invalidCalendarPairCount'],
  ['midnight reversed mixed pair','2024-03-01 00:00:00','20240229','reversedPairCount'],
  ['nonzero hour','2024-02-01 01:00:00','2024-02-29','unsupportedFormatPairCount'],
  ['nonzero minute','2024-02-01 00:01:00','2024-02-29','unsupportedFormatPairCount'],
  ['nonzero second','2024-02-01 00:00:01','2024-02-29','unsupportedFormatPairCount'],
  ['midnight offset','2024-02-01 00:00:00+08:00','2024-02-29','unsupportedFormatPairCount'],
  ['midnight UTC suffix','2024-02-01 00:00:00Z','2024-02-29','unsupportedFormatPairCount'],
  ['midnight milliseconds','2024-02-01 00:00:00.000','2024-02-29','unsupportedFormatPairCount'],
  ['midnight trailing space','2024-02-01 00:00:00 ','2024-02-29','unsupportedFormatPairCount'],
  ['midnight leading space',' 2024-02-01 00:00:00','2024-02-29','unsupportedFormatPairCount'],
  ['midnight trailing newline','2024-02-01 00:00:00\n','2024-02-29','unsupportedFormatPairCount'],
  ['midnight tab separator','2024-02-01\t00:00:00','2024-02-29','unsupportedFormatPairCount'],
  ['century non-leap','1900-02-29','1900-03-01','invalidCalendarPairCount'],
  ['ordinary non-leap','2023-02-29','2023-03-01','invalidCalendarPairCount'],
  ['month overflow','2024-13-01','2024-12-31','invalidCalendarPairCount'],
  ['day overflow','2024-04-31','2024-05-01','invalidCalendarPairCount'],
  ['zero year','0000-01-01','0000-01-02','invalidCalendarPairCount'],
  ['reversed pair','2024-03-01','2024-02-29','reversedPairCount'],
  ['non-padded date','2024-2-01','2024-02-29','unsupportedFormatPairCount'],
  ['timestamp suffix','2024-02-01T00:00:00','2024-02-29','unsupportedFormatPairCount'],
  ['trailing newline','2024-02-01\n','2024-02-29','unsupportedFormatPairCount'],
  ['leading space',' 2024-02-01','2024-02-29','unsupportedFormatPairCount'],
  ['numeric field',20240201,'2024-02-29','invalidTypePairCount'],
  ['missing field',undefined,'2024-02-29','missingPairCount'],
  ['empty field','','2024-02-29','missingPairCount'],
])test('strict filing period: '+name,()=>{
  const value=row(start,end);if(start===undefined)delete value.skssqq;if(end===undefined)delete value.skssqz;
  const output=summarizeFilingPeriods([value]);safe(output);
  assert.equal(output.filingPeriodCoverage[category],1);assert.equal(output.filingPeriodsVerified,category==='validPairCount');
});

test('empty lists, deadlines and display text never manufacture filing periods',()=>{
  assert.equal(summarizeFilingPeriods([]).filingPeriodsVerified,false);
  const value=summarizeFilingPeriods([{sbqx:'2024-02-29',sbb:'2024-02',skssqzqz:'2024-02-01 / 2024-02-29',zt:'已申报'}]);safe(value);
  assert.equal(value.filingPeriodsVerified,false);assert.equal(value.filingPeriodCoverage.missingPairCount,1);
  assert.equal(value.filingPeriodCoverage.displayFieldPresentCount,1);assert.equal(value.filingPeriodCoverage.alreadyFiledCount,1);
});

test('coverage counts valid/invalid/partial pairs without calling reported rows pending obligations',()=>{
  const output=summarizeFilingPeriods([row(),row('20240201','20240229'),row('2024-04-31','2024-05-01'),{zt:'已申报'}]);safe(output);
  assert.equal(output.filingPeriodsVerified,false);assert.equal(output.filingPeriodCoverage.validPairCount,2);
  assert.equal(output.filingPeriodCoverage.distinctPeriodCount,1);assert.equal(output.filingPeriodCoverage.invalidCalendarPairCount,1);
  assert.equal(output.filingPeriodCoverage.missingPairCount,1);assert.equal(output.filingPeriodCoverage.alreadyFiledCount,4);
  assert.equal(output.filingPeriodCoverage.alreadyFiledWithValidPeriodCount,2);assert.equal(Object.hasOwn(output,'periodVerified'),false);
});

test('period comparisons normalize only the three exact formats and preserve duplicates/order distinctions',()=>{
  const same=compareFilingPeriods([row()],[row('20240201','20240229')]);safe(same);
  assert.equal(same.filingPeriodsComparable,true);assert.equal(same.filingPeriodPairsEqual,true);
  const swapped=compareFilingPeriods([row(),row('2024-03-01','2024-03-31')],[row('20240301','20240331'),row('20240201','20240229')]);safe(swapped);
  assert.equal(swapped.filingPeriodPairsEqual,false);assert.equal(swapped.filingPeriodMultisetEqual,true);
  const duplicate=compareFilingPeriods([row(),row()],[row()]);assert.equal(duplicate.filingPeriodMultisetEqual,false);
  for(const [left,right] of [[[],[]],[[{}],[{}]],[[{}],[row()]],[[row('bad','bad')],[row()]]]){
    const value=compareFilingPeriods(left,right);safe(value);assert.equal(value.filingPeriodsComparable,false);
    assert.equal(value.filingPeriodPairsEqual,false);assert.equal(value.filingPeriodMultisetEqual,false);
  }
});

test('midnight format has separate counters even for invalid dates and never counts as other text',()=>{
  const output=summarizeFilingPeriods([row('2024-02-01 00:00:00','2024-02-29 00:00:00'),
    row('2023-02-29 00:00:00','2023-03-01 00:00:00')]);safe(output);
  const counts=output.filingPeriodCoverage;
  assert.equal(counts.startMidnightCount,2);assert.equal(counts.endMidnightCount,2);
  assert.equal(counts.startOtherStringCount,0);assert.equal(counts.endOtherStringCount,0);
  assert.equal(counts.startDashedCount,0);assert.equal(counts.endDashedCount,0);
  assert.equal(counts.validPairCount,1);assert.equal(counts.invalidCalendarPairCount,1);
  assert.equal(output.filingPeriodsVerified,false);
});

test('midnight dates compare equal to compact and dashed dates only after complete pair validation',()=>{
  const midnight=row('2024-02-01 00:00:00','2024-02-29 00:00:00');
  for(const other of [row(),row('20240201','20240229'),row('20240201','2024-02-29 00:00:00')]){
    const output=compareFilingPeriods([midnight],[other]);safe(output);
    assert.equal(output.filingPeriodsComparable,true);assert.equal(output.filingPeriodPairsEqual,true);
    assert.equal(output.filingPeriodMultisetEqual,true);
  }
  for(const invalid of [row('2024-02-01 00:00:01','2024-02-29 00:00:00'),
    row('2024-02-29 00:00:00','20240201'),row('2023-02-29 00:00:00','20230301')]){
    const output=compareFilingPeriods([invalid],[invalid]);safe(output);
    assert.equal(output.filingPeriodsComparable,false);assert.equal(output.filingPeriodPairsEqual,false);
    assert.equal(output.filingPeriodMultisetEqual,false);
  }
});

test('private projections retain the nine confirmed business fields and exclude personal/auth/navigation data',()=>{
  const data=captures(),identity=data.identity.projection.userinfo,filing=data.filing.projection;
  for(const key of ENTERPRISE_BASIC_FIELDS)assert.equal(identity[key],PRIVATE+'_'+key+'_A');
  for(const key of ['full_name','id_card','agencyName','agencyCreditCode','token'])assert.equal(Object.hasOwn(identity,key),false);
  assert.equal(filing.wsbxxGrid[0].skssqq,'2024-02-01');assert.equal(filing.wsbxxGrid[0].skssqz,'2024-02-29');
  assert.equal(filing.wsbxxGrid[0].skssqzqz,PRIVATE+'_DISPLAY');assert.equal(filing.periodVerified,false);
  assert.deepEqual(Object.keys(filing).sort(),['navigation','periodVerified','projectionComplete','rowCount','wsbxxGrid'].sort());
  assert.equal(validateCapture(data.identity,'identity'),true);assert.equal(validateCapture(data.filing,'current_filing'),true);
  const basic=enterpriseBasicFieldCoverage(identity);safe(basic);assert.equal(basic.presentCount,6);assert.equal(basic.nonemptyStringCount,6);
  const shape=collectionShape(identityBody());safe(shape);
  for(const key of ['creditCode','competent_tax_bureau_name'])assert.ok(shape.schema.some(entry=>entry.path.endsWith('.'+key)));
  for(const key of ['full_name','id_card','token'])assert.equal(shape.schema.some(entry=>entry.path.endsWith('.'+key)),false);
});

test('expanded contract still rejects unauthorized keys, non-string fields and forged completeness',()=>{
  for(const change of [v=>v.identity.projection.userinfo.token=PRIVATE,v=>v.identity.projection.userinfo.agencyName=PRIVATE,
    v=>v.identity.projection.userinfo.creditCode=42,v=>v.filing.projection.wsbxxGrid[0].skssqq=42,
    v=>v.filing.projection.filingPeriodsVerified=true,v=>v.filing.projection.periodVerified=true]){
    const value=source();change(value);assert.throws(()=>validateEvidence('source',value),/^Error: tax_collection_evidence_invalid$/);
  }
});

test('legacy private evidence loads and compares without inserting missing business fields',async()=>fixture(async directory=>{
  const store=new TaxCollectionStore({root:join(directory,'evidence'),security});
  const legacyCaptures=captures([{sbb:PRIVATE+'_FORM',zt:'已申报'}]);
  for(const key of ENTERPRISE_BASIC_FIELDS)delete legacyCaptures.identity.projection.userinfo[key];
  const current=source(legacyCaptures),sourceRef=await store.save('source',current),file=join(store.root,sourceRef+'.json');
  const legacy={...current,version:1};delete legacy.documentUrlSemantics;const original=JSON.stringify(legacy);
  await writeFile(file,original);const loaded=await store.load(sourceRef);assert.deepEqual(loaded,legacy);
  const before=JSON.stringify(loaded),comparison=compareProjections(loaded,source());safe(comparison);
  assert.equal(comparison.filingPeriodsComparable,false);assert.equal(comparison.filingPeriodPairsEqual,false);
  assert.equal(comparison.leftEnterpriseBasicFieldCoverage.presentCount,0);assert.equal(comparison.rightEnterpriseBasicFieldCoverage.presentCount,6);
  assert.equal(comparison.identityProjectionEqual,false);assert.equal(comparison.filingProjectionEqual,false);
  assert.equal(JSON.stringify(loaded),before);assert.equal(await readFile(file,'utf8'),original);
  const oldRun={version:1,sourceRef,capturedAt:2,...legacyCaptures,operationRef:ref('taxop'),
    requestProof:['1','2','3'].map((digit,index)=>({requestRef:ref('taxreq',digit),resource:index===1?'current_filing':'identity',requestPerformed:true,responseComplete:true}))};
  const runRef=await store.save('run',oldRun);assert.deepEqual(await store.load(runRef),oldRun);
  assert.equal(compareProjections(loaded,oldRun).filingProjectionEqual,true);assert.equal(compareProjections(loaded,oldRun).filingPeriodsComparable,false);
}));

test('real store/lock/generated requests collect expanded fields on two independent three-request runs',async()=>fixture(async directory=>{
  const store=new TaxCollectionStore({root:join(directory,'evidence'),security}),sourceRef=await store.save('source',source());
  const profile=join(directory,'profile');await mkdir(profile);let fetchCount=0;
  const collector=new TaxLiveCollection({enabled:true,store,now:()=>3,
    acquireLock:(path,options)=>collectionLock(path,{...options,security}),
    async openDiagnostic(){return {localScope:{profilePath:profile,browserKey:'a'.repeat(64),registrationState:'quarantined',
      currentRegistrationState:async()=> 'quarantined'},close(){},cdp:{on(){return()=>{}},async send(method,params){
        if(method==='Target.getTargetInfo')return {targetInfo:{type:'page'}};
        if(method==='Target.attachToTarget')return {sessionId:'synthetic-session'};
        if(method==='Page.getFrameTree')return {frameTree:{frame:{...frame}}};
        if(method==='Runtime.evaluate'){
          const value=await runInNewContext(params.expression,{location:{href:fullFrameUrl(frame)},URL,AbortController,TextDecoder,
            window:{fetch:Array.prototype.push,setTimeout:Array.prototype.push},setTimeout:()=>0,clearTimeout:()=>{},
            async fetch(){const ordinal=fetchCount++,secondRun=ordinal>=3;
              return new Response(JSON.stringify(ordinal%3===1?filingBody([row('2024-02-01',secondRun?'2024-03-31':'2024-02-29')]):identityBody(secondRun?'B':'A')),{status:200});}});
          return {result:{value}};
        }
        if(['Page.enable','Runtime.enable','Page.disable','Runtime.disable','Target.detachFromTarget'].includes(method))return {};
        throw Error('synthetic_unexpected_method');
      }}}},
  });
  const first=await collector.collect({sourceRef}),second=await collector.collect({sourceRef});safe(first);safe(second);
  assert.equal(fetchCount,6);assert.notEqual(first.runRef,second.runRef);
  for(const output of [first,second]){
    assert.equal(output.status,'partial_observed');assert.equal(output.requestPerformedCount,3);assert.equal(output.periodVerified,false);
    assert.equal(output.currentPendingPeriodVerified,false);assert.ok(output.missing.includes('business_period'));
    assert.equal(output.filingPeriodsVerified,true);assert.equal(output.filingPeriodCoverage.alreadyFiledWithValidPeriodCount,1);
    assert.equal(output.enterpriseBasicFieldCoverage.nonemptyStringCount,6);assert.equal(output.businessScopeVerified,false);
  }
  const comparison=await collector.compare({leftRef:first.runRef,rightRef:second.runRef});safe(comparison);
  assert.equal(comparison.independentRequests,true);assert.equal(comparison.filingPeriodsComparable,true);
  assert.equal(comparison.currentPendingPeriodVerified,false);assert.equal(comparison.periodVerified,false);
  assert.equal(comparison.filingPeriodPairsEqual,false);assert.equal(comparison.filingProjectionEqual,false);assert.equal(comparison.identityProjectionEqual,false);
  const saved=await store.load(second.runRef);assert.equal(saved.filing.projection.wsbxxGrid[0].skssqz,'2024-03-31');
  assert.equal(saved.identity.projection.userinfo.creditCode,PRIVATE+'_creditCode_B');assert.equal(saved.filing.projection.periodVerified,false);
}));
