import {prepareQuarterWorkspace,parseQuarterOptions} from './quarter-host.mjs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
export function main(args=process.argv.slice(2)){const o=parseQuarterOptions(args,['--materials','--workspace','--plugin-root','--product-root','--product-head','--plugin-head','--maintenance-dir']);if(o.help){console.log('node quarter-workspace.mjs --materials <公开业务资料目录> --workspace <全新中性目录> --plugin-root <finance目录> --maintenance-dir <维护侧目录> [--product-head <sha> --plugin-head <sha>]');return;}const result=prepareQuarterWorkspace({materialsDir:o.materials,workspace:o.workspace,pluginRoot:o['plugin-root'],productRoot:o['product-root'],productHead:o['product-head'],pluginHead:o['plugin-head'],maintenanceDir:o['maintenance-dir']});console.log(JSON.stringify(result));return result;}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))try{main();}catch(error){console.error(error.message);process.exitCode=1;}
