import {PERIOD_TASK_ROUTING} from '../shared/task-routing.mjs';
import {listedToolsForProfile} from '../../mcp/finance-mcp/tool-profile.mjs';
import {BUSINESS_MEMORY_ROUTING} from '../shared/business-session.mjs';
import {projectSkillFiles} from './project-skills.mjs';
import {claudeBusinessHooks} from './business-memory-hook.mjs';
import {isAbsolute, join, relative, sep} from 'node:path';
import {pathToFileURL} from 'node:url';

// Claude 的绝对文件规则以 // 起始，Windows 盘符按 /c/... 归一，目录名按字面匹配。
function readPathPattern(path) {
  const normalized = sep === '\\'
    ? path.replaceAll('\\', '/').replace(/^([a-z]):/i, (_, drive) => '/' + drive.toLowerCase())
    : path;
  return '/' + normalized.replace(/[\\*?[\]]/g, '\\$&');
}

export function buildConfig(c){
  const {command,args,env}=c.mcp,tools=listedToolsForProfile('direct',env.FINANCE_QUERY_DISCOVERY);
  // 部分既有只读合同缺少 MCP readOnlyHint。正式委托需能读取依据和账簿、验收更正。
  const correctionTools=new Set(['skills_list','skills_read','account_context','finance_query_catalog',
    'finance_query','ledger_query','account_list','period_list','period_end_check','voucher_correct']);
  const discoveryTools=new Set(['skills_list','skills_read','finance_query_catalog']);
  const allowed=t=>discoveryTools.has(t.name)||t.annotations?.readOnlyHint===true||(env.FINANCE_CORRECTION_SOURCE_DIGEST&&correctionTools.has(t.name));
  const allow=tools.filter(allowed).map(t=>'mcp__finance__'+t.name);
  const delivery=c.correctionManifest?[
    '交付会计的核对表和结果说明写入本工作区 outputs/ 下的 CSV 或 Markdown 文件。交付前读回文件，向会计给出实际路径。',
    '逐项复核要求客户处理的事项。回到相应原件，核对行标、交易标识和原值，再与账簿、核对表及报告正文中的处理结果交叉核对。行号无法核实时用可查的业务标识定位。已有依据的合理时点差列入已解释事项，只有仍需客户补证或处理的具体差异才列为客户待办。'
  ].join('\n\n'):'';
  const deny=[];
  if(delivery) {
    const sourceRoot=env.FINANCE_SOURCE_ROOT, source=readPathPattern(sourceRoot);
    allow.push('Read('+source+')','Read('+source+'/**)','Edit(/outputs/*.csv)','Edit(/outputs/*.md)');
    // 账库混放在原件目录时，只能通过受控账务工具读取。原件的读许可不会把目录加入可编辑工作区。
    const dbRelative=relative(sourceRoot,c.databasePath);
    if(dbRelative!=='..' && !dbRelative.startsWith('..'+sep) && !isAbsolute(dbRelative)){
      const db=readPathPattern(c.databasePath);
      for(const suffix of ['', '-wal', '-shm', '-journal']) deny.push('Read('+db+suffix+')');
    }
  }
  // 未绑定时使用原生默认询问；受控启动器只在会话绑定核验成功后批准这两项读取。
  const ask=tools.filter(t=>!allowed(t)&&!['account_list','finance_query'].includes(t.name)).map(t=>'mcp__finance__'+t.name);
  return {host:'claude-code',files:[
    ...projectSkillFiles(c.skillsDir),
    {path:'.mcp.json',content:JSON.stringify({mcpServers:{finance:{command,args,env}}},null,2)+'\n'},
    {path:'.claude/settings.json',content:JSON.stringify({enabledPlugins:{'finance@taxes-agent':false},autoMemoryEnabled:false,hooks:claudeBusinessHooks(c.nodePath,c.outputDir),permissions:{defaultMode:'default',allow,ask,...(deny.length?{deny}:{})}},null,2)+'\n'},
    {path:'start-claude.mjs',content:`#!/usr/bin/env node\nimport {runClaude} from ${JSON.stringify(pathToFileURL(join(c.repoRoot,'05-reconstruction/codex/hosts/claude-code/launcher.mjs')).href)};\nawait runClaude(new URL('.',import.meta.url),process.argv.slice(2));\n`},
    {path:'CLAUDE.md',content:`# 中国财税工作区\n\n${PERIOD_TASK_ROUTING}\n\n${BUSINESS_MEMORY_ROUTING}\n\n${delivery}\n\n模型可自主选Python、JavaScript、表格或既有计算器；需自动记录脚本执行时使用finance_calculation_run，独立派生账表可直接交付。记录器不调用记账接口；脚本按当前用户权限执行，非安全沙箱，不授予改原件、账库或读凭据权限。计算记录索引不是业务报告，中文业务账表与规则说明由脚本或表格另行生成。\n\n从本项目 .claude/skills 的原生 Skill 按要交付的业务结果选择；原生入口不可用时，用 skills_list 查入口、skills_read 读正文。技能版本见 .finance/skill-source.json。使用本项目绑定的 finance MCP。后端 ${c.apiBase}，明确账库 ${c.databasePath}。先核实企业、账套和期间，不猜默认身份。\n\n不要求来源登记、事实登记、DAG或Harness Store。来源、输入、结果和操作身份由工具在会话绑定中的 auditDir 自动保存。未绑定时使用 ${c.auditDir}。实际写入仍遵守工具的人审、期间和防重复约束，状态未知时核查原操作。\n\n交付顺序：账本金额→凭证/计算结果→规则依据→工具调用→输入与原件。日常展示前三项，严重或多项错误时按需展开后两项；完整后台记录始终保留。未知不填零，不将引用/哈希或模型解释当真人复核与业务正确证明。真实资料只按当前明确授权披露，凭据不进模型或日志。\n`},
  ],notes:['本工作区使用原生MCP配置与中国化业务Skill；配置不授予账务写入或资料外发权限。','只读工具可自动允许，其他工具保留宿主审批；不自动启用旧Harness。']};
}
