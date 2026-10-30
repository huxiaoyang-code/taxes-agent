import { TOOLS, HARNESS_TOOL_NAMES } from './tools.mjs';

// 这里只限制 MCP 工具暴露面，不授予文件系统或数据库权限。
export function toolsForProfile(profile) {
  if (profile === undefined) return TOOLS;
  if (profile !== 'harness') throw Object.assign(new Error('finance_mcp_profile_invalid'), {code:'finance_mcp_profile_invalid'});
  return TOOLS.filter(t => HARNESS_TOOL_NAMES.has(t.name) || ['skills_list', 'skills_read'].includes(t.name));
}
