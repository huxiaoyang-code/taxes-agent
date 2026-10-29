import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

export function buildConfig(context){
  const config={version:'finance-pi-host/1',repoRoot:context.repoRoot,nodePath:context.nodePath,mcpEnv:context.mcpEnv,skillsDir:context.skillsDir,
    extensionPath:join(context.repoRoot,'05-reconstruction/codex/pi/finance-harness.ts'),onboardingPath:join(context.repoRoot,'05-reconstruction/codex/hosts/START-HERE.md'),
    provider:'deepseek',model:'deepseek-flash'};
  const runtime=pathToFileURL(join(context.repoRoot,'05-reconstruction/codex/hosts/pi/launcher.mjs')).href;
  return {files:[
    {path:'pi-host.json',content:JSON.stringify(config,null,2)+'\n'},
    {path:'start-pi.mjs',content:`#!/usr/bin/env node\nimport {runPi} from ${JSON.stringify(runtime)};\nawait runPi(new URL('./pi-host.json',import.meta.url),process.argv.slice(2));\n`},
    {path:'AGENTS.md',content:`# 财税主 Agent 入口\n\n先读 ${config.onboardingPath} 和 ${join(context.skillsDir,'harness/SKILL.md')}。以实际账套身份、原件、事实、任务和原生回执为准；不编造会计确认。\n\n使用 start-pi.mjs 并显式提供 --pi-root 官方 Pi 包绝对目录；--check 只验证真实加载，不调用模型。主 Agent 复用既有 finance-harness.ts，保留全套 Harness 生命周期及 finance_delegate_parser。解析委派的工具限制不是操作系统沙箱。本人模型凭据仅来自当前进程环境，不复制其他人的配置、会话或账套。\n`},
  ],notes:['先使用 start-pi.mjs --pi-root <官方包绝对目录> --check；业务会话默认官方 deepseek/deepseek-flash。','生成器不调用模型、不安装 Pi、不读取或复制 auth/config/session；本机财税后端须先启动。']};
}
