#!/usr/bin/env node
// 固定的本机管理员 CLI；导入模块或请求帮助均不会打开浏览器。
import {pathToFileURL} from 'node:url';
import {TaxDownloadPage} from '../server/tax-download-page.mjs';

export const DOWNLOAD_PAGE_USAGE='Usage: node scripts/explore-tax-download-page.mjs --source-ref <local-source-ref> --target invoice|financial_report';

export async function exploreTaxDownloadPageCommand(argv,{createExplorer=()=>new TaxDownloadPage({enabled:true}),write=console.log}={}){
  if(Array.isArray(argv)&&argv.length===1&&['--help','-h'].includes(argv[0])){write(DOWNLOAD_PAGE_USAGE);return 0;}
  if(!Array.isArray(argv)||argv.length!==4||argv[0]!=='--source-ref'||typeof argv[1]!=='string'||!/^taxsource_[a-f0-9]{48}$/.test(argv[1])
    ||argv[2]!=='--target'||!['invoice','financial_report'].includes(argv[3])){write(JSON.stringify({status:'input_invalid'}));return 2;}
  try{
    const result=await createExplorer().navigate({sourceRef:argv[1],target:argv[3]});
    write(JSON.stringify(result));return ['page_observed','page_quarantined_unverified'].includes(result?.status)?0:1;
  }catch{write(JSON.stringify({status:'page_exploration_failed',phase:'command',reason:'operation_unconfirmed'}));return 1;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)process.exitCode=await exploreTaxDownloadPageCommand(process.argv.slice(2));
