import { TOOLS, HARNESS_TOOL_NAMES } from './tools.mjs';

// This restricts the MCP tool surface, not filesystem/database permissions.
export function toolsForProfile(profile) {
  if (profile === undefined) return TOOLS;
  if (profile !== 'harness') throw Object.assign(new Error('finance_mcp_profile_invalid'), {code:'finance_mcp_profile_invalid'});
  return TOOLS.filter(t => HARNESS_TOOL_NAMES.has(t.name) || ['skills_list', 'skills_read'].includes(t.name));
}
