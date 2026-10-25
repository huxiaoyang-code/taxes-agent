#!/usr/bin/env node
// Local fixed entry; never online filing. Customer files are retained in place.
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { loadAgencyMaterials, buildAgencyWorkpaper, prepareAgencyPosting, executeAgencyPosting, queryAgencyPosting,matchAgencyRules } from '../server/agency-business.mjs';
import { listAgencyRules,getAgencyRuleDetail,getAgencyPolicyObservationSources,validateAgencyPolicyCandidate,registerAgencyPolicyCandidate,listAgencyPolicyCandidates,assessAgencyPolicyImpact,renderAgencyRuleWiki } from '../server/agency-rule-catalog.mjs';

const [command, ...args] = process.argv.slice(2);
const usage = 'node scripts/agency-business.mjs workpaper|match-rules <manifest> [workbench.db] | prepare <manifest> <workbench.db> <batchId> <evidenceDir> [posting-options.json] | execute <manifest> <workbench.db> <batchId> <evidenceDir> <accountant-feedback.json> [posting-options.json] | query <identity.json> | rules|policy-sources [filters.json] | rule <ruleId> [revision] | policy-validate <candidate.json> | policy-register <absolute-name.agency-policy.jsonl> <candidate.json> | policy-list <absolute-name.agency-policy.jsonl> [filters.json] | policy-impact <candidate.json> [enterpriseKey] | wiki';
const readData=path=>{const bytes=readFileSync(resolve(path));if(bytes.length>256*1024)throw Object.assign(new Error('agency_cli_input_too_large'),{code:'agency_cli_input_too_large'});return JSON.parse(bytes.toString('utf8'));};
try {
  let result;
  if (command === 'workpaper' && [1,2].includes(args.length)) result = buildAgencyWorkpaper(loadAgencyMaterials(resolve(args[0])),args[1]?{dbPath:resolve(args[1])}:{});
  else if(command==='match-rules'&&[1,2].includes(args.length))result=matchAgencyRules(loadAgencyMaterials(resolve(args[0])),args[1]?{dbPath:resolve(args[1])}:{});
  else if(command==='rules'&&args.length<=1)result=listAgencyRules(args.length?readData(args[0]):{});
  else if(command==='rule'&&[1,2].includes(args.length))result=getAgencyRuleDetail(args[0],args[1]);
  else if(command==='policy-sources'&&args.length<=1)result=getAgencyPolicyObservationSources(args.length?readData(args[0]):{});
  else if(command==='policy-validate'&&args.length===1)result=validateAgencyPolicyCandidate(readData(args[0]));
  else if(command==='policy-register'&&args.length===2)result=registerAgencyPolicyCandidate(args[0],readData(args[1]));
  else if(command==='policy-list'&&[1,2].includes(args.length))result=listAgencyPolicyCandidates(args[0],args[1]?readData(args[1]):{});
  else if(command==='policy-impact'&&[1,2].includes(args.length))result=assessAgencyPolicyImpact(readData(args[0]),args[1]?{enterpriseKey:args[1]}:{});
  else if(command==='wiki'&&args.length===0){process.stdout.write(renderAgencyRuleWiki());process.exit(0);}
  else if (['prepare', 'execute'].includes(command) && [command==='prepare'?4:5,command==='prepare'?5:6].includes(args.length)) {
    const session = loadAgencyMaterials(resolve(args[0])), dbPath = resolve(args[1]); process.env.WORKBENCH_DATA_DIR = dirname(dbPath);
    const optionsPath=args[command==='prepare'?4:5],options=optionsPath?JSON.parse(readFileSync(resolve(optionsPath),'utf8')):{};
    if(!options||Array.isArray(options)||typeof options!=='object'||Object.keys(options).some(k=>!['correction','ledgerReconciliation'].includes(k)))throw Object.assign(new Error(usage),{code:'agency_cli_usage'});
    const proposal = await prepareAgencyPosting(session, { ...options,dbPath, batchId: args[2], evidenceDir: resolve(args[3]) });
    if (command === 'prepare') result = proposal;
    else { const feedback = JSON.parse(readFileSync(resolve(args[4]), 'utf8')); result = await executeAgencyPosting(session, { ...feedback, proposal }); }
  } else if (command === 'query' && args.length === 1) { const id = JSON.parse(readFileSync(resolve(args[0]), 'utf8')); process.env.WORKBENCH_DATA_DIR = dirname(id.dbPath); result = await queryAgencyPosting(id); }
  else throw Object.assign(new Error(usage), { code: 'agency_cli_usage' });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} catch (error) { process.stderr.write(JSON.stringify({ code: error.code ?? 'agency_business_failed', ...(error.code === 'agency_cli_usage' ? { usage } : {}) }) + '\n'); process.exitCode = 1; }
