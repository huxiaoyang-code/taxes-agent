#!/usr/bin/env node
// 操作者在 bwrap 外启动此服务，本人密钥预先放在环境变量中。
// 密钥不写入 argv、配置、账本、控制台或候选命名空间。
import {readFileSync} from 'node:fs';
import {createBudgetGateway} from '../../05-reconstruction/codex/harness2/budget-gateway.mjs';
const config=JSON.parse(readFileSync(process.argv[2],'utf8'));
const gateway=createBudgetGateway({...config,apiKey:process.env.DEEPSEEK_API_KEY});
await gateway.listen();console.log(JSON.stringify({status:'executor_relay_ready',role:'executor',mode:gateway.ledger.mode,model:'deepseek-flash',credentialsDisclosed:false}));
for(const event of ['SIGTERM','SIGINT'])process.once(event,async()=>{await gateway.close();process.exit(0);});
