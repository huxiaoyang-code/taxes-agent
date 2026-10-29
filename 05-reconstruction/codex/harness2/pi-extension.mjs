import {join} from 'node:path';
export default function researchFinance(pi){
  pi.registerMcpServer('finance',{command:process.execPath,args:[join(import.meta.dirname,'restricted-mcp.mjs')],cwd:process.cwd(),exposure:'hidden',toolExposure:{'harness_*':'direct',skills_read:'direct',skills_list:'direct'},description:'Synthetic research only: one explicit target, period.inspect, no feedback or write capability.',timeout:120});
}
