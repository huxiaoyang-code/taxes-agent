// Explicit local admin only. Never imported by HTTP/Agent/MCP.
import {TaxQueryCollection} from '../server/tax-query-collection.mjs';
const args=process.argv.slice(2);
if(args.length!==1||!/^taxquery_[a-f0-9]{48}$/.test(args[0]||'')){
  process.stdout.write(JSON.stringify({status:'input_invalid'})+'\n');process.exitCode=1;
}else{
  const result=await new TaxQueryCollection({enabled:true}).refresh({artifactRef:args[0]});
  process.stdout.write(JSON.stringify(result)+'\n');if(result.status!=='query_context_refreshed')process.exitCode=1;
}
