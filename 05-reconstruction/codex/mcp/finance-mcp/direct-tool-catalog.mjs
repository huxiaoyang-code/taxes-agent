import { TOOLS, MODEL_PLAIN_TOOL_NAMES } from './tools.mjs';
import { DIRECT_TOOL_NAMES } from './direct-tools.mjs';

const names = new Set([...MODEL_PLAIN_TOOL_NAMES, ...DIRECT_TOOL_NAMES, 'skills_list', 'skills_read', 'finance_query_catalog']);
export const directTools = Object.freeze(TOOLS.filter(tool => names.has(tool.name) && tool.status === 'available'));

// 已有会计方法仍可调用 ledger_query。新生成的工作区只列科目明细账的统一入口。
export function listDirectTools(queryDiscovery) {
  return queryDiscovery === 'canonical' ? directTools.filter(tool => tool.name !== 'ledger_query') : directTools;
}
