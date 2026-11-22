// Pi 原生 MCP 扩展；业务 Skill 自主选路，工具后台自动记录调用，不建立 Agent DAG。
import {fileURLToPath} from 'node:url';
import {FINANCE_MCP_DISCOVERY} from '../hosts/shared/task-routing.mjs';
import {dirname,resolve,join} from 'node:path';
import type {ExtensionAPI} from '@earendil-works/pi-coding-agent';

export default function financeDirect(pi:ExtensionAPI){
  const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
  pi.registerMcpServer('finance',{
    command:process.execPath,args:[join(root,'codex/mcp/finance-mcp/server.mjs')],cwd:resolve(root,'..'),
    env:{FINANCE_MCP_PROFILE:'direct'},exposure:'hidden',
    toolExposure:{finance_rules:'direct',skills_read:'direct','*':'deferred'},
    description:FINANCE_MCP_DISCOVERY+'使用 tool_search 搜索相关业务工具；已知工具名时可按精确名称搜索。',
    timeout:180,
  });
}
