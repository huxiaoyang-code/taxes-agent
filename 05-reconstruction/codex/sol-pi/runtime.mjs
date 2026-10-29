import {readFileSync,existsSync,mkdirSync,writeFileSync,realpathSync,lstatSync} from 'node:fs';
import {resolve,join,dirname,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {spawn as nodeSpawn,execFileSync} from 'node:child_process';

const here=dirname(fileURLToPath(import.meta.url));
export const UPSTREAM_COMMIT='219568034fa54ed121ede80961655e33dfb9d0e3';
export const SUPPORTED_PI='1.1.0';
const json=path=>JSON.parse(readFileSync(path,'utf8'));
const hash=value=>createHash('sha256').update(value).digest('hex');
const requiredAbsolute=(value,code)=>{if(typeof value!=='string'||!isAbsolute(value))throw Error(code);return resolve(value);};

// Selecting off is deliberately pure: no dependency imports, reads, mkdirs or installs.
export function resolveSolPi(options={}){
  const {host,runtimeEfficiency='off',harnessImprovement='off'}=options;
  if(!['pi','claude-code','dsh','zcode'].includes(host))throw Error('sol_pi_host_invalid');
  if(!['off','sol-pi'].includes(runtimeEfficiency)||!['off','harness2'].includes(harnessImprovement))throw Error('sol_pi_mode_invalid');
  if(runtimeEfficiency==='off')return {enabled:false,host,runtimeEfficiency,harnessImprovement};
  if(host!=='pi')throw Error(`sol_pi_host_unsupported:${host}`);
  if(harnessImprovement!=='off')throw Error('sol_pi_harness2_combination_unsupported');
  const toolRoot=requiredAbsolute(options.toolRoot,'sol_pi_explicit_tool_root_required');
  const archiveRoot=requiredAbsolute(options.archiveRoot,'sol_pi_explicit_archive_root_required');
  // IDs name local archive scopes; never accept a path or an enterprise name here.
  if(!/^[A-Za-z0-9_-]{1,80}$/.test(options.accountSetId??''))throw Error('sol_pi_archive_account_id_required');
  return {enabled:true,host,runtimeEfficiency,harnessImprovement,toolRoot,archiveRoot,accountSetId:options.accountSetId,sessionId:randomUUID()};
}

export function inspectToolchain(selection){
  if(!selection.enabled)return selection;
  if(selection.host!=='pi'||selection.runtimeEfficiency!=='sol-pi'||selection.harnessImprovement!=='off')throw Error('sol_pi_selection_invalid');
  if(process.versions.node!=='24.15.0')throw Error('sol_pi_verified_node_24_15_0_required');
  const root=selection.toolRoot,lockPath=join(root,'package-lock.json'),piRoot=join(root,'node_modules/@earendil-works/pi-coding-agent');
  if(!existsSync(lockPath))throw Error('sol_pi_locked_dependency_directory_required');
  if(hash(readFileSync(lockPath))!==hash(readFileSync(join(here,'toolchain-package-lock.json'))))throw Error('sol_pi_locked_dependency_digest_mismatch');
  const lock=json(lockPath),packages=lock.packages??{},versions={};
  for(const name of ['chord','pi-coding-agent','pi-agent-core','pi-ai','pi-tui','pi-codemode','pi-mcp','pi-telemetry']){
    const key=`@earendil-works/${name}`,version=json(join(root,'node_modules',key,'package.json')).version;
    if(version!==SUPPORTED_PI||packages[`node_modules/${key}`]?.version!==version)throw Error(`sol_pi_unverified_package:${key}`);
    versions[key]=version;
  }
  const typebox=json(join(root,'node_modules/typebox/package.json')).version;
  if(typebox!=='1.3.27'||packages['node_modules/typebox']?.version!==typebox)throw Error('sol_pi_typebox_unverified');
  const source=json(join(here,'upstream-manifest.json'));
  if(source.commit!==UPSTREAM_COMMIT)throw Error('sol_pi_upstream_pin_invalid');
  for(const [path,digest] of Object.entries(source.files))if(hash(readFileSync(join(here,'upstream',path)))!==digest)throw Error(`sol_pi_upstream_integrity_failed:${path}`);
  const adapterHash=hash(readFileSync(join(here,'extension.ts'))),probeHash=hash(readFileSync(join(here,'../../../06-workbench/scripts/sol-pi-probe.mjs'))),runtimeHash=hash(readFileSync(fileURLToPath(import.meta.url))),launcherHash=hash(readFileSync(join(here,'../hosts/pi/launcher.mjs')));
  const fingerprint=hash(JSON.stringify({lock:hash(readFileSync(lockPath)),versions,typebox,source,adapterHash,probeHash,runtimeHash,launcherHash,node:process.versions.node}));
  return {...selection,piRoot,versions,typebox,fingerprint,extensionPath:join(here,'extension.ts')};
}

export function loadSolPi(selection,{probe=false}={}){
  const checked=inspectToolchain(selection);if(!checked.enabled)return checked;
  if(!probe){
    const evidence=json(join(checked.toolRoot,'sol-pi-verified.json'));
    if(evidence.version!=='sol-pi-model-free/1'||evidence.fingerprint!==checked.fingerprint||evidence.status!=='passed')throw Error('sol_pi_model_free_verification_required');
  }
  return checked;
}

export function prepareArchive(selection){
  const runDirectory=join(selection.archiveRoot,selection.accountSetId,selection.sessionId);
  const noLinks=path=>{for(let current=resolve(path);;current=dirname(current)){if(existsSync(current)&&lstatSync(current).isSymbolicLink())throw Error('sol_pi_archive_reparse_point_refused');if(dirname(current)===current)break;}};
  noLinks(runDirectory);mkdirSync(dirname(runDirectory),{recursive:true,mode:0o700});mkdirSync(runDirectory,{mode:0o700});noLinks(runDirectory);
  // Windows ignores POSIX mode. Restrict and verify a dedicated per-run directory.
  if(process.platform==='win32'){
    const script='$ErrorActionPreference="Stop"; $p=$args[0]; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $acl=Get-Acl -LiteralPath $p; $acl.SetAccessRuleProtection($true,$false); $rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,"FullControl","ContainerInherit,ObjectInherit","None","Allow"); $acl.AddAccessRule($rule); Set-Acl -LiteralPath $p -AclObject $acl; $check=Get-Acl -LiteralPath $p; if(-not $check.AreAccessRulesProtected){throw "archive_acl_not_protected"}; foreach($r in $check.Access){if($r.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value -or $r.AccessControlType -ne "Allow"){throw "archive_acl_unexpected_principal"}}';
    const encoded=Buffer.from(`$args=@('${runDirectory.replaceAll("'","''")}'); ${script}`,'utf16le').toString('base64');
    execFileSync('pwsh.exe',['-NoProfile','-NonInteractive','-EncodedCommand',encoded],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  }
  writeFileSync(join(runDirectory,'retention.json'),JSON.stringify({version:'sol-pi-archive/1',accountSetId:selection.accountSetId,sessionId:selection.sessionId,createdAt:new Date().toISOString(),retention:'manual; retain until evidence review and all recall-dependent work are complete; no automatic deletion'},null,2),{flag:'wx',mode:0o600});
  return realpathSync(runDirectory);
}

export async function launchSolPi(selection,{command,args,cwd,env=process.env,spawn=nodeSpawn}={}){
  if(!selection.enabled)throw Error('sol_pi_launch_requires_explicit_selection');
  const checked=loadSolPi(selection);
  if(!isAbsolute(command??'')||!Array.isArray(args)||!isAbsolute(cwd??''))throw Error('sol_pi_explicit_launch_spec_required');
  if(execFileSync(command,['--version'],{windowsHide:true,encoding:'utf8'}).trim()!=='v24.15.0')throw Error('sol_pi_verified_node_24_15_0_required');
  if(!args.includes('--no-extensions')||!args.includes('builtin:mcp')||!args.includes('builtin:tool-search')||args.includes('--no-mcp'))throw Error('sol_pi_native_parent_extensions_required');
  if(realpathSync(args[0])!==realpathSync(join(checked.piRoot,'dist/bundle/cli.js')))throw Error('sol_pi_launch_pi_root_mismatch');
  const launchArgs=[...args],toolIndex=launchArgs.indexOf('--tools');
  if(toolIndex<0||!launchArgs[toolIndex+1])throw Error('sol_pi_explicit_parent_tools_required');
  const tools=launchArgs[toolIndex+1].split(',');if(!tools.includes('obs_recall'))tools.push('obs_recall');launchArgs[toolIndex+1]=tools.join(',');
  const archiveDirectory=prepareArchive(checked),child=spawn(command,[...launchArgs,'-e',checked.extensionPath],{cwd,env:{...env,FINANCE_SOL_PI_ARCHIVE:archiveDirectory,FINANCE_SOL_PI_FINGERPRINT:checked.fingerprint},shell:false,windowsHide:true,stdio:'inherit'});
  const code=await new Promise((ok,no)=>{child.once('error',no);child.once('close',(code,signal)=>ok(signal?1:code??1));});
  return {code,archiveDirectory,fingerprint:checked.fingerprint};
}
