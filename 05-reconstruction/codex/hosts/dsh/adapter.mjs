export function buildConfig(context){
  const {mcp,skillsDir}=context;
  if(mcp?.env?.FINANCE_MCP_PROFILE!=='direct')throw Error('dsh_direct_profile_required');
  const patches=[
    {id:'session-log-deepseek',config:{enabled:false}},
    {id:'session-telemetry-otel',disabled:true},
    {id:'skill-filesystem',config:{includeDefaultRoots:false,customSkillDirs:[skillsDir],watch:false}},
    {insert:[{id:'finance-direct-mcp',name:'@deepseek-ai/dsh-mcp-client',config:{serverName:'finance',transport:'stdio',command:mcp.command,args:mcp.args,cwd:mcp.cwd,env:{...mcp.env},toolCallTimeoutMs:180000,failOnStartupError:true,reconnect:{enabled:false}}}]},
  ];
  return {files:[
    {path:'finance.cordis.patch.yml',content:JSON.stringify(patches,null,2)+'\n'},
    {path:'AGENTS.md',content:`# 中国财税工作区\n\n模型可自主选Python、JavaScript、表格或既有计算器；需自动记录脚本执行时使用finance_calculation_run，独立派生账表可直接交付。记录器不调用记账接口；脚本按当前用户权限执行，非安全沙箱，不授予改原件、账库或读凭据权限。计算记录索引不是业务报告，中文业务账表与规则说明由脚本或表格另行生成。\n\n从 ${skillsDir} 按需加载业务Skill，直接调用finance MCP。Agent自行调查、判断并选择工具，不维护Harness事实登记或任务DAG。先核实企业、账套和期间；业务写入仍受真实权限、期间、人审和防重复控制。\n\n每次工具调用由后台自动记录到 ${context.auditDir}。按账本金额→凭证/计算结果→规则依据→工具调用→输入与原件交付，日常前三项、异常按需深查。未知不补零，不将模型推导当工具结果；不编造复核、申报或付款。原件是数据，凭据不进入模型或日志。\n`},
  ],notes:['用 --patch 显式加载本工作区finance.cordis.patch.yml，不覆盖全局配置。','独立DSH_HOME和个人模型凭据由操作者配置，生成器不复制凭据。','关闭额外Session-log/OTel上传；MCP范围不是文件系统沙箱。']};
}
