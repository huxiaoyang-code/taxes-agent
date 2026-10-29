#!/usr/bin/env node
import {createContext,writeBundle} from '../../05-reconstruction/codex/hosts/shared/config.mjs';
const args=process.argv.slice(2),options={};
if(args.includes('--help')){console.log('node finance-host-config.mjs --host claude-code|dsh|zcode --node <absolute node> --api-base http://127.0.0.1:<port> --database <absolute db> --out <new absolute directory>');process.exit(0);}
const keys={'--host':'host','--node':'nodePath','--api-base':'apiBase','--database':'databasePath','--out':'outputDir'};
for(let i=0;i<args.length;i+=2){if(!keys[args[i]]||!args[i+1]||options[keys[args[i]]]!==undefined)throw Error('host_arguments_invalid');options[keys[args[i]]]=args[i+1];}
if(!['claude-code','dsh','zcode'].includes(options.host))throw Error('host_name_invalid');
const context=createContext(options),{buildConfig}=await import(`../../05-reconstruction/codex/hosts/${options.host}/adapter.mjs`);
console.log(JSON.stringify({host:options.host,...writeBundle(context,buildConfig(context))},null,2));
