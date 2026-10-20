// Local administrator only. No refresh/admin endpoint is registered with Agent or MCP.
import {pathToFileURL} from 'node:url';
import {TaxHistoryCollection} from '../server/tax-history-collection.mjs';
export const refreshTaxHistoryContext=(args,overrides)=>new TaxHistoryCollection(overrides).refresh(args);
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const args=process.argv.slice(2);
  const result=args.length===2&&args[0]==='--artifact-ref'?await refreshTaxHistoryContext({artifactRef:args[1]}):{status:'input_invalid'};
  console.log(JSON.stringify(result));if(result.status!=='history_context_refreshed')process.exitCode=1;
}
