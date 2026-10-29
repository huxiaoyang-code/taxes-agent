#!/usr/bin/env node
// The operator starts this outside bwrap, with their own key already in env.
// No key is written to argv, config, ledger, console or the candidate namespace.
import {readFileSync} from 'node:fs';
import {createBudgetGateway} from '../../05-reconstruction/codex/harness2/budget-gateway.mjs';
const config=JSON.parse(readFileSync(process.argv[2],'utf8'));
const gateway=createBudgetGateway({...config,apiKey:process.env.DEEPSEEK_API_KEY});
await gateway.listen();console.log(JSON.stringify({status:'executor_relay_ready',role:'executor',mode:gateway.ledger.mode,model:'deepseek-flash',credentialsDisclosed:false}));
for(const event of ['SIGTERM','SIGINT'])process.once(event,async()=>{await gateway.close();process.exit(0);});
