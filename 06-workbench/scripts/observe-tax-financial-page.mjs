// Local-only CLI: two opaque references, no URLs, bodies, targets or endpoints.
import {pathToFileURL} from 'node:url';
import {TaxDownloadFinancialPassive} from '../server/tax-download-financial-passive.mjs';
export async function observeTaxFinancialPage(args,overrides={}){return new TaxDownloadFinancialPassive(overrides).capture(args);}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){let result;
  try{if(process.argv.length!==6||process.argv[2]!=='--snapshot-ref'||process.argv[4]!=='--navigation-artifact-ref')throw Error('input');
    result=await observeTaxFinancialPage({snapshotRef:process.argv[3],navigationArtifactRef:process.argv[5]},{enabled:true});}
  catch{result={status:'input_invalid'};}
  process.stdout.write(JSON.stringify(result)+'\n');if(result.status!=='financial_passive_quarantined')process.exitCode=1;
}
