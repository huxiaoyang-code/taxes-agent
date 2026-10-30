// 仅限本机的被动观察器。不输出原始 URL、脚本源码或业务数据。
import {pathToFileURL} from 'node:url';
import {TaxDownloadInvoiceObserver} from '../server/tax-download-invoice-observer.mjs';
export async function observeTaxInvoicePage(args,overrides={}){return new TaxDownloadInvoiceObserver(overrides).observe(args);}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){let result;
  try{if(process.argv.length!==6||process.argv[2]!=='--snapshot-ref'||process.argv[4]!=='--navigation-artifact-ref')throw Error('input');
    result=await observeTaxInvoicePage({snapshotRef:process.argv[3],navigationArtifactRef:process.argv[5]},{enabled:true,
      onArmed:async()=>process.stdout.write('{"status":"invoice_observer_armed","observationSeconds":120}\n')});}
  catch{result={status:'input_invalid'};}
  process.stdout.write(JSON.stringify(result)+'\n');if(result.status!=='invoice_observation_quarantined')process.exitCode=1;
}
