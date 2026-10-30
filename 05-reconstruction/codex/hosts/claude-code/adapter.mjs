import {toolsForProfile} from '../../mcp/finance-mcp/tool-profile.mjs';
export function buildConfig(c){
  const {command,args,env}=c.mcp,tools=toolsForProfile('direct');
  const allow=tools.filter(t=>t.annotations?.readOnlyHint===true).map(t=>'mcp__finance__'+t.name);
  const ask=tools.filter(t=>t.annotations?.readOnlyHint!==true).map(t=>'mcp__finance__'+t.name);
  return {files:[
    {path:'.mcp.json',content:JSON.stringify({mcpServers:{finance:{command,args,env}}},null,2)+'\n'},
    {path:'.claude/settings.json',content:JSON.stringify({permissions:{defaultMode:'default',allow,ask}},null,2)+'\n'},
    {path:'CLAUDE.md',content:`# 中国财税工作区\n\n按目标自主选择 ${c.skillsDir} 的业务 Skill，必要时通过 skills_read 读取；直接使用 finance MCP 的业务工具。后端 ${c.apiBase}，明确账库 ${c.databasePath}。先核实企业、账套和期间，不猜默认身份。\n\n不要求来源登记、事实登记、DAG或Harness Store。来源、输入、结果和操作身份由工具在本机自动记录到 ${c.auditDir}。实际写入仍遵守工具的人审、期间和防重复约束，状态未知时核查原操作。\n\n交付顺序：账本金额→凭证/计算结果→规则依据→工具调用→输入与原件。日常展示前三项，严重或多项错误时按需展开后两项；完整后台记录始终保留。未知不填零，不将引用/哈希或模型解释当真人复核与业务正确证明。真实资料只按当前明确授权披露，凭据不进模型或日志。\n`},
  ],notes:['本工作区使用原生MCP配置与中国化业务Skill；配置不授予账务写入或资料外发权限。','只读工具可自动允许，其他工具保留宿主审批；不自动启用旧Harness。']};
}
