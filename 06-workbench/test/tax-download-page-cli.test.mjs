import assert from 'node:assert/strict';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {DOWNLOAD_PAGE_USAGE,exploreTaxDownloadPageCommand} from '../scripts/explore-tax-download-page.mjs';
const PRIVATE='PRIVATE_CLI_TRIPWIRE',source='taxsource_'+'1'.repeat(48),artifact='taxdownloadpage_'+'2'.repeat(48);
const args=['--source-ref',source,'--target','financial_report'];
const safe=text=>assert.doesNotMatch(text,/PRIVATE_CLI|https?:|password|Bearer|profilePath|sourceRef/);
for(const help of ['--help','-h'])test('help is local and does not create an explorer '+help,async()=>{
  const lines=[],code=await exploreTaxDownloadPageCommand([help],{write:v=>lines.push(v),createExplorer(){throw Error(PRIVATE);}});
  assert.equal(code,0);assert.deepEqual(lines,[DOWNLOAD_PAGE_USAGE]);safe(lines.join(''));
});
for(const invalid of [[],null,{},['--source-ref'],['--source-ref','bad','--target','invoice'],['--source-ref',source,'--target','anything'],
  ['--source-ref',source,'--target','invoice','--url',PRIVATE],['--source-ref',source,'--body',PRIVATE],['--target','invoice','--source-ref',source],
  ['--source-ref',source,'--profile',PRIVATE],['--help',PRIVATE]])test('invalid command never opens explorer '+JSON.stringify(invalid),async()=>{
  const lines=[],code=await exploreTaxDownloadPageCommand(invalid,{write:v=>lines.push(v),createExplorer(){throw Error(PRIVATE);}});
  assert.equal(code,2);assert.deepEqual(lines,['{"status":"input_invalid"}']);safe(lines.join(''));
});
for(const status of ['page_observed','page_quarantined_unverified','page_exploration_failed'])test('command preserves safe result and exact helper input '+status,async()=>{
  const lines=[],expected={status,artifactRef:artifact,consumable:false,downloadPerformed:false,downstreamReady:false};let creates=0;
  const code=await exploreTaxDownloadPageCommand(args,{write:v=>lines.push(v),createExplorer(){creates++;return {async navigate(input){assert.deepEqual(input,{sourceRef:source,target:'financial_report'});return expected;}};}});
  assert.equal(creates,1);assert.equal(code,status==='page_exploration_failed'?1:0);assert.deepEqual(lines,[JSON.stringify(expected)]);safe(lines.join(''));
});
test('unexpected exception is fixed, without credentials/arguments/raw errors',async()=>{
  const lines=[],code=await exploreTaxDownloadPageCommand(args,{write:v=>lines.push(v),createExplorer(){throw Error(PRIVATE);}});
  assert.equal(code,1);assert.deepEqual(JSON.parse(lines[0]),{status:'page_exploration_failed',phase:'command',reason:'operation_unconfirmed'});safe(lines.join(''));
});
test('real CLI help and invalid-input subprocesses exit before any live setup',()=>{
  const script=fileURLToPath(new URL('../scripts/explore-tax-download-page.mjs',import.meta.url));
  const help=spawnSync(process.execPath,[script,'--help'],{encoding:'utf8',timeout:10000});assert.equal(help.status,0);assert.equal(help.stderr,'');assert.equal(help.stdout.trim(),DOWNLOAD_PAGE_USAGE);safe(help.stdout);
  const invalid=spawnSync(process.execPath,[script,'--source-ref',PRIVATE,'--target','invoice'],{encoding:'utf8',timeout:10000});assert.equal(invalid.status,2);assert.equal(invalid.stderr,'');assert.deepEqual(JSON.parse(invalid.stdout),{status:'input_invalid'});safe(invalid.stdout);
});
