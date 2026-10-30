export function buildConfig(context){
  const {mcp,skillsDir,databasePath,apiBase}=context;
  const config={features:{mcp:true,skill:true},permission:{mode:'build'},skills:{enabled:true,roots:[skillsDir]},
    mcp:{servers:{finance:{type:'stdio',...mcp,enabled:true,timeoutMs:180000}}},ui:{locale:'zh-CN'}};
  return {files:[
    {path:'.zcode/config.json',content:JSON.stringify(config,null,2)+'\n'},
    {path:'AGENTS.md',content:`# 中国财税工作区\n\n按目标从 ${skillsDir} 选用业务Skill，直接调用finance MCP；后端 ${apiBase}，明确账库 ${databasePath}。核实企业、账套与期间，不维护Harness来源/事实登记、Store或DAG。Agent负责业务判断，固定工具负责计算和受控写入。\n\n后台在 ${context.auditDir} 自动保存每次调用的输入、结果与来源，完整记录留本机。按账本金额→凭证/计算结果→规则依据→工具调用→输入与原件展示，日常前三项，异常再展开后两项。未知和缺件明确，不能以引用/哈希代替业务正确、人审、真实申报或付款。不得把凭据与未经授权原值放入模型、日志或Git。\n`},
  ],notes:['打开生成目录使用原生ZCode工作区配置；不修改用户全局配置。','MCP工具面不代替操作系统隔离、业务授权或真人复核。']};
}
