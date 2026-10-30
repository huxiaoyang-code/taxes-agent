import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

export function buildConfig(context){
  const config={version:'finance-pi-host/1',repoRoot:context.repoRoot,nodePath:context.nodePath,mcpEnv:context.mcpEnv,skillsDir:context.skillsDir,
    extensionPath:join(context.repoRoot,'05-reconstruction/codex/pi/finance-direct.ts'),onboardingPath:join(context.repoRoot,'05-reconstruction/codex/hosts/START-HERE.md'),
    provider:'deepseek',model:'deepseek-flash'};
  const runtime=pathToFileURL(join(context.repoRoot,'05-reconstruction/codex/hosts/pi/launcher.mjs')).href;
  return {files:[
    {path:'pi-host.json',content:JSON.stringify(config,null,2)+'\n'},
    {path:'start-pi.mjs',content:`#!/usr/bin/env node\nimport {runPi} from ${JSON.stringify(runtime)};\nawait runPi(new URL('./pi-host.json',import.meta.url),process.argv.slice(2));\n`},
    {path:'AGENTS.md',content:`# 中国财税主 Agent\n\n业务技能位于 ${context.skillsDir}。按目标自主选择相关Skill和finance业务工具，不要求Harness来源/事实登记或任务编排。明确企业、账套、期间和币种，工具自动保存本机调用链。\n\n交付顺序：账本金额→凭证/计算结果→规则依据→工具调用→输入与原件；日常前三项，异常按需深查，完整后台记录保留。凭据不进入记录或模型；未核事实与工具不支持应明确。使用 start-pi.mjs --pi-root <官方Pi包目录>；--check仅做程序加载和MCP检查，不调用模型。\n`},
  ],notes:['先使用 start-pi.mjs --pi-root <官方包绝对目录> --check；业务会话默认官方 deepseek/deepseek-flash。','生成器不调用模型、不安装 Pi、不读取或复制 auth/config/session；本机财税后端须先启动。']};
}
