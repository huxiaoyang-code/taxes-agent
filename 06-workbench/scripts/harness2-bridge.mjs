#!/usr/bin/env node
import {readFileSync} from 'node:fs';
import {dispatch} from '../../05-reconstruction/codex/harness2/bridge.mjs';
try{if(process.argv.length!==3)throw Error('harness2_request_file_required');const request=JSON.parse(readFileSync(process.argv[2],'utf8'));console.log(JSON.stringify(await dispatch(request)));}
catch(e){console.log(JSON.stringify({status:'blocked',code:/^[a-z0-9_]+$/.test(e.code??e.message)?e.code??e.message:'harness2_bridge_failed',modelInvoked:false}));process.exitCode=1;}
