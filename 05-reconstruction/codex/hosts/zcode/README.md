# 当前直接业务接入

本页当前入口采用中国化业务 Skill＋原生 MCP，使用 `FINANCE_MCP_PROFILE=direct`。Agent自主选择工具，后台完整自动记录；不要求来源/事实登记、Store或任务DAG。生成器固定使用同仓库 `plugins/finance/skills`，无需第二次 clone，不接受外部插件路径；用 `--audit-dir` 指定本机记录目录。

接入步骤以 [统一入口](../START-HERE.md) 为准；工具结果按账本金额→凭证/计算结果→规则依据→工具调用→输入与原件展示，日常前三项、异常再展开后两项。真实写入仍遵守现有工具约束；配置、无模型协议检查和实际模型业务验收分别记录。
当前生成 .zcode/config.json 与 AGENTS.md。打开生成目录或使用 zcode --cwd <生成目录> --mode build，核实finance实际连接来自本工作区；保持原生权限，不自动安装用户级解析角色。

已有账套按[账套记忆](../BUSINESS-MEMORY.md)绑定后，用 `node start-business-session.mjs -- --zcode-cli '<实际 exe 或 JS 入口>'` 启动。工作区 `AGENTS.md` 提示按绑定中的 `memoryPath` 用本机文件工具读取当期适用口径并在需要时编辑。

整期目标先读 `tax-period/SKILL.md`。共享短路由写入 ZCode 已支持的工作区 `AGENTS.md`，技能根保持同仓库目录；单项请求直接选相关技能。原生配置可解析及 MCP 可读不等于模型已读或业务通过。
