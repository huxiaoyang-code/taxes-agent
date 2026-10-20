// Local admin only. No arbitrary paths, URLs, browser actions or request input.
import {pathToFileURL} from 'node:url';
import {retireQueryReadonly,QUERY_RETIREMENT_AUDIT_VERSION} from '../server/tax-query-readonly-retirement.mjs';
export function parseQueryRetirementArguments(a){
  if(!Array.isArray(a)||a.length<2||a[0]!=='--artifact-ref'||!/^taxquery_[a-f0-9]{48}$/.test(a[1]))throw Error('input_invalid');
  const rest=a.slice(2);if(new Set(rest).size!==rest.length||rest.some(x=>!['--execute','--resume','--attest-identity-only'].includes(x))
    ||rest.includes('--resume')&&!rest.includes('--execute')||rest.includes('--execute')!==rest.includes('--attest-identity-only'))throw Error('input_invalid');
  return{artifactRef:a[1],execute:rest.includes('--execute'),resume:rest.includes('--resume'),
    ...(rest.includes('--attest-identity-only')?{auditVersion:QUERY_RETIREMENT_AUDIT_VERSION}:{})};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{const result=await retireQueryReadonly(parseQueryRetirementArguments(process.argv.slice(2)));console.log(JSON.stringify(result));
    if(!['diagnosed','retired_readonly','historical_retirement_confirmed'].includes(result.status))process.exitCode=1;
  }catch{console.error('query_retirement_input_invalid');process.exitCode=1;}
}
