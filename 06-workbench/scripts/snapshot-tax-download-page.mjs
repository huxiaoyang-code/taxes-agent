// Local CLI only. Raw script contents and URLs never enter stdout/stderr.
import {pathToFileURL} from 'node:url';
import {TaxDownloadSnapshot} from '../server/tax-download-snapshot.mjs';
export async function snapshotTaxDownloadPage(args,overrides={}){return new TaxDownloadSnapshot(overrides).capture(args);}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  let result;try{
    if(process.argv.length!==4||process.argv[2]!=='--artifact-ref')throw Error('input');
    result=await snapshotTaxDownloadPage({artifactRef:process.argv[3]},{enabled:true});
  }catch{result={status:'input_invalid'};}
  process.stdout.write(JSON.stringify(result)+'\n');
  if(result.status!=='snapshot_quarantined')process.exitCode=1;
}
