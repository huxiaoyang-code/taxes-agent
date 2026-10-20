// Administrator CLI only; no arbitrary requests, browser actions or API route.
import {pathToFileURL} from 'node:url';
import {abandonReadonlyOperation,READONLY_AUDIT_VERSION} from '../server/tax-readonly-abandon.mjs';
export function parseAbandonArguments(a){
  if(a[0]!=='--source-ref'||!/^taxsource_[a-f0-9]{48}$/.test(a[1]||''))throw Error('invalid');
  const flags=a.slice(2);
  if(new Set(flags).size!==flags.length||flags.some(f=>!['--execute','--resume',`--confirm-audit=${READONLY_AUDIT_VERSION}`].includes(f)))throw Error('invalid');
  const execute=flags.includes('--execute'),resume=flags.includes('--resume');
  if(resume&&!execute)throw Error('invalid');
  return{sourceRef:a[1],execute,resume,...(flags.includes(`--confirm-audit=${READONLY_AUDIT_VERSION}`)?{auditVersion:READONLY_AUDIT_VERSION}:{})};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{const result=await abandonReadonlyOperation(parseAbandonArguments(process.argv.slice(2)));
    console.log(JSON.stringify(result));if(!['diagnosed','abandoned_readonly'].includes(result.status))process.exitCode=1;
  }catch{console.error('tax_readonly_abandon_input_invalid');process.exitCode=1;}
}
