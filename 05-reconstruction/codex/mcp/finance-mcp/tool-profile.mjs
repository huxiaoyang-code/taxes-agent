import { TOOLS, HARNESS_TOOL_NAMES, MODEL_PLAIN_TOOL_NAMES } from './tools.mjs';
import { DIRECT_TOOL_NAMES } from './direct-tools.mjs';
const directNames=new Set([...MODEL_PLAIN_TOOL_NAMES,...DIRECT_TOOL_NAMES,'skills_list','skills_read','finance_query_catalog']);

// 这里只限制 MCP 工具暴露面，不授予文件系统或数据库权限。
export function toolsForProfile(profile) {
  // 日常业务默认直接调用；legacy 明确保留旧客户端全量工具面。
  if (profile === 'legacy') return TOOLS;
  if (profile === undefined || profile === 'direct') return TOOLS.filter(t => directNames.has(t.name) && t.status === 'available');
  if (profile !== 'harness') throw Object.assign(new Error('finance_mcp_profile_invalid'), {code:'finance_mcp_profile_invalid'});
  return TOOLS.filter(t => HARNESS_TOOL_NAMES.has(t.name) || ['skills_list', 'skills_read'].includes(t.name));
}
