import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadQuarterWorkspace,openQuarterHost,parseQuarterOptions,secureFile} from './quarter-host.mjs';
export async function main(args=process.argv.slice(2)){const o=parseQuarterOptions(args,['--workspace','--tool','--arguments-file']);if(o.help){console.log('node quarter-call.mjs --workspace <业务目录> --tool <正常工具名> [--arguments-file <业务目录内JSON>]；连续业务与派生结果请用quarter-session.mjs。');return;}const config=loadQuarterWorkspace(o.workspace),value=o['arguments-file']?JSON.parse(secureFile(o['arguments-file'],{root:config.workspace})):{};const host=await openQuarterHost(config);try{const result=await host.call(o.tool,value);console.log(JSON.stringify(result));return result;}finally{await host.close();}}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error.message);process.exitCode=1;});
