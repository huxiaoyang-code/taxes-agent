import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {openRegisteredBrowserDiagnostic} from '../server/tax-browser-diagnostic.mjs';
test('diagnostic rejects invalid ref before touching registry',async()=>{
  let touched=false;
  await assert.rejects(openRegisteredBrowserDiagnostic({registrationRef:'invalid'}, {verifyDirectory:async()=>{touched=true}}));
  assert.equal(touched,false);
});
async function diagnosticFixture(modeArgs){
  const root=await mkdtemp(join(tmpdir(),'tax-diagnostic-synthetic-'));
  const base=join(root,'runs'),registry=join(base,'tax-browser-registry'),profile=join(root,'youshu-tax-edge-synthetic');
  await mkdir(registry,{recursive:true});await mkdir(profile);
  const registrationRef='taxr_'+'1'.repeat(48),endpoint='ws://127.0.0.1:12345/devtools/browser/synthetic';
  const owner={pid:101,createdAt:'2026-01-01T00:00:00Z',exePath:'C:\\synthetic\\node.exe'};
  const browser={pid:102,createdAt:'2026-01-01T00:00:01Z',parentPid:101,exePath:'C:\\synthetic\\msedge.exe'};
  const verified={owner,browser,profilePath:resolve(profile),endpoint};
  const key=createHash('sha256').update(JSON.stringify(browser)).digest('hex');
  const record={version:1,registrationRef,state:'quarantined',key,verified};
  const recordFile=join(registry,registrationRef+'.json'),leaseFile=join(profile,'YoushuReadonlyLease.json');
  await writeFile(recordFile,JSON.stringify(record));await writeFile(join(registry,key+'.claim.json'),JSON.stringify({registrationRef}));
  await writeFile(leaseFile,'synthetic-existing-lease');await writeFile(join(profile,'DevToolsActivePort'),'12345\n/devtools/browser/synthetic');
  const checked=[],snapshot={owner,browser:{...browser,args:[
    '--remote-debugging-address=127.0.0.1','--remote-debugging-port=0',...modeArgs,'--new-window',
    '--edge-skip-compat-layer-relaunch','--user-data-dir='+profile,'https://etax.fujian.chinatax.gov.cn:8443/loginb/']},browserExeVerified:true};
  return {root,base,registry,profile,registrationRef,endpoint,record,recordFile,leaseFile,checked,snapshot};
}
function diagnosticDependencies(f){return{
  registrationBase:f.base,tempRoot:async()=>f.root,verifyDirectory:async p=>f.checked.push(p),verifyFile:async p=>f.checked.push(p),
  inspectProcesses:async()=>f.snapshot,inspectListener:async()=>[{pid:102,address:'127.0.0.1'}],
  connectBrowser:async p=>{assert.equal(p,f.endpoint);return{close(){}}},
};}
test('diagnostic validates owner/profile/port while retaining quarantined record and lease exactly',async()=>{
  const f=await diagnosticFixture(['--inprivate']);
  try{
    let closed=false;
    const transport=await openRegisteredBrowserDiagnostic({registrationRef:f.registrationRef,registrationRoot:f.registry},{
      ...diagnosticDependencies(f),
      connectBrowser:async p=>{assert.equal(p,f.endpoint);return{close(){closed=true}}},
    });
    assert.equal(f.checked.includes(f.profile),true);assert.equal(f.checked.includes(f.recordFile),true);
    assert.equal(await readFile(f.recordFile,'utf8'),JSON.stringify(f.record));assert.equal(await readFile(f.leaseFile,'utf8'),'synthetic-existing-lease');
    transport.close();assert.equal(closed,true);
  }finally{await rm(f.root,{recursive:true,force:true})}
});
test('diagnostic accepts a current normal-mode dedicated browser',async()=>{
  const f=await diagnosticFixture([]);
  try{
    let closed=false;
    const transport=await openRegisteredBrowserDiagnostic({registrationRef:f.registrationRef,registrationRoot:f.registry},{
      ...diagnosticDependencies(f),
      connectBrowser:async p=>{assert.equal(p,f.endpoint);return{close(){closed=true}}},
    });
    assert.equal(f.checked.includes(f.profile),true);assert.equal(f.checked.includes(f.recordFile),true);
    transport.close();assert.equal(closed,true);
  }finally{await rm(f.root,{recursive:true,force:true})}
});
for(const bad of [['--inprivate','--inprivate'],['--inprivate=true']]) test(`diagnostic rejects malformed InPrivate ${JSON.stringify(bad)}`,async()=>{
  const f=await diagnosticFixture(bad);
  try{
    await assert.rejects(()=>openRegisteredBrowserDiagnostic({registrationRef:f.registrationRef,registrationRoot:f.registry},diagnosticDependencies(f)));
    assert.equal(f.checked.includes(f.recordFile),true);
  }finally{await rm(f.root,{recursive:true,force:true})}
});
