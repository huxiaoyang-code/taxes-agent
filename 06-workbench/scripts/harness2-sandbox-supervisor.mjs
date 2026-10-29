// Runs INSIDE bwrap. The only network reachable is this loopback relay to the
// experiment's one Unix budget socket. No credential is present in this process.
import {createServer,request as httpRequest} from 'node:http';
import {readFileSync,existsSync,lstatSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {dispatch} from '../../05-reconstruction/codex/harness2/bridge.mjs';
export const createSandboxRelay=socket=>createServer((req,res)=>{
  const upstream=httpRequest({socketPath:socket,path:req.url,method:req.method,headers:{'content-type':'application/json'}},r=>{res.writeHead(r.statusCode,r.headers);r.pipe(res);});
  res.once('close',()=>{if(!res.writableEnded)upstream.destroy();});
  upstream.on('error',()=>{if(res.destroyed||res.writableEnded)return;if(!res.headersSent)res.writeHead(502);res.end();});req.pipe(upstream);
});
async function main(){
const socket='/run/finance-gateway.sock';
if(process.platform!=='linux'||!lstatSync(socket).isSocket()||existsSync('/mnt/d')||existsSync('/home')||existsSync('/proc/sys/fs/binfmt_misc/WSLInterop')||readFileSync('/proc/net/route','utf8').trim().split('\n').length>1)throw Error('harness2_namespace_evidence_failed');
const relay=createSandboxRelay(socket);
await new Promise(ok=>relay.listen(0,'127.0.0.1',ok));
process.env.FINANCE_HARNESS2_RELAY_BASE=`http://127.0.0.1:${relay.address().port}/v1`;
process.env.DEEPSEEK_API_KEY='sandbox-budget-relay';
const request=JSON.parse(readFileSync(process.argv[2],'utf8'));
try{console.log(JSON.stringify(await dispatch(request)));}
catch(e){try{writeFileSync(join(request.root,'local-diagnostic-'+request.runId+'.txt'),String(e.stack??e),{flag:'wx'});}catch{}console.log(JSON.stringify({status:'blocked',code:/^[a-z0-9_]+$/.test(e.code??e.message)?e.code??e.message:'harness2_sandbox_execution_failed'}));process.exitCode=1;}
finally{await new Promise(ok=>relay.close(ok));}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
