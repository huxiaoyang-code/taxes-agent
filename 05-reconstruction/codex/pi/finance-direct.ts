// Pi 原生 MCP 扩展；业务 Skill 自主选路，工具后台自动记录调用，不建立 Agent DAG。
import {fileURLToPath} from 'node:url';
import {dirname,resolve,join} from 'node:path';
import type {ExtensionAPI} from '@earendil-works/pi-coding-agent';

export default function financeDirect(pi:ExtensionAPI){
  const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
  pi.registerMcpServer('finance',{
    command:process.execPath,args:[join(root,'codex/mcp/finance-mcp/server.mjs')],cwd:resolve(root,'..'),
    env:{FINANCE_MCP_PROFILE:'direct'},exposure:'hidden',
    toolExposure:{finance_rules:'direct',skills_read:'direct','*':'deferred'},
    description:'中国财税业务工具。按目标选择 Skill，用 tool_search 按需取得具体工具合同；直接查询、核算和核对，不需要登记事实或任务计划。每次调用在本机自动保存输入、结果与来源引用。日常按账本金额、凭证/计算、规则依据展示，必要时展开工具调用和原件。哈希与引用不代表业务判断正确。',
    timeout:180,
  });
}
