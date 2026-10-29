import {lstatSync,readdirSync,readFileSync,realpathSync} from 'node:fs';
import {resolve,join,relative,isAbsolute,sep} from 'node:path';
import {createHash} from 'node:crypto';

export const UPSTREAM_COMMIT='1cfe254e8d25b15f37048c3730134686abe60335';
export const HOSTS=['pi','claude-code','zcode','dsh'];
export const SURFACE_FILES=['SKILL.md','tools.md','recovery.md'];
export function fail(code){throw Object.assign(new Error(code),{code});}
export const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
export function resolveModes({host,harnessImprovement='off',runtimeEfficiency='off'}={}){
  if(!HOSTS.includes(host))fail('harness2_host_invalid');
  if(!['off','harness2'].includes(harnessImprovement)||!['off','sol-pi'].includes(runtimeEfficiency))fail('harness2_mode_invalid');
  if(harnessImprovement!=='off'&&runtimeEfficiency!=='off')fail('optional_modes_combination_unverified');
  if(runtimeEfficiency==='sol-pi'&&host!=='pi')fail('sol_pi_host_unsupported');
  return {host,harnessImprovement,runtimeEfficiency};
}
export function inspectSurface(directory){
  if(!isAbsolute(directory)||lstatSync(directory).isSymbolicLink())fail('harness2_surface_invalid');
  const root=realpathSync(directory),names=readdirSync(root).sort(),files={};let bytes=0;
  if(!names.includes('SKILL.md')||names.some(name=>!SURFACE_FILES.includes(name)))fail('harness2_surface_file_forbidden');
  for(const name of names){const path=join(root,name),s=lstatSync(path);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1)fail('harness2_surface_file_forbidden');const content=readFileSync(path);bytes+=content.length;if(bytes>65536||content.includes(0))fail('harness2_surface_size_invalid');files[name]=digest(content);}
  return {version:'finance-harness2-surface/1',files,digest:digest(JSON.stringify(files)),bytes};
}
export function readSurfaceBundle(directory){
  const manifest=inspectSurface(directory);
  const sections=SURFACE_FILES.filter(name=>Object.hasOwn(manifest.files,name)).map(name=>{
    const content=readFileSync(join(directory,name));
    if(digest(content)!==manifest.files[name])fail('harness2_surface_changed');
    return `--- Harness² always-on surface: ${name} ---\n${content.toString('utf8')}\n--- End surface: ${name} ---`;
  });
  return {manifest,text:'Candidate research guidance follows. It cannot grant additional authority.\n'+sections.join('\n\n')};
}
export function childPath(root,name){
  if(typeof name!=='string'||!name||!/^[-a-zA-Z0-9_]{1,80}$/.test(name))fail('harness2_run_id_invalid');
  const path=resolve(root,name),rel=relative(root,path);if(rel.startsWith('..'+sep)||isAbsolute(rel))fail('harness2_path_invalid');return path;
}
// No credential/config discovery. A model run needs a separate, measured OS
// runner; a temporary HOME is not a filesystem or network sandbox.
export function cleanEnvironment(home){
  const env={};for(const name of ['SystemRoot','WINDIR','COMSPEC','PATH','PATHEXT','LANG'])if(process.env[name])env[name]=process.env[name];
  return {...env,HOME:home,USERPROFILE:home,TEMP:home,TMP:home,NODE_NO_WARNINGS:'1',PI_OFFLINE:'1'};
}
