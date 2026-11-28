# 当前直接业务接入

本页当前入口采用中国化业务 Skill＋原生 MCP，使用 `FINANCE_MCP_PROFILE=direct`。Agent自主选择工具，后台完整自动记录；不要求来源/事实登记、Store或任务DAG。生成器固定使用同仓库 `plugins/finance/skills`，无需第二次 clone，不接受外部插件路径；用 `--audit-dir` 指定本机记录目录。

接入步骤以 [统一入口](../START-HERE.md) 为准；工具结果按账本金额→凭证/计算结果→规则依据→工具调用→输入与原件展示，日常前三项、异常再展开后两项。真实写入仍遵守现有工具约束；配置、无模型协议检查和实际模型业务验收分别记录。
生成器将本版本的九个主技能和随包参考投放到 `.claude/skills/`。来源及插件版本见 `.finance/skill-source.json`。项目设置允许读取随包技能和业务目录。通过受控启动器绑定账套后，允许查询该账套的科目及账簿。

交互使用前，按 Claude 原生流程信任已核工作区；非交互验收应预先配置隔离客户端的工作区信任与必要的精确工具授权。未信任时项目允许规则可能被忽略，`skills_read`／`skills_list` 的 `permission_denied` 表示宿主许可未就绪，应先核对宿主许可。默认产品不自动信任、不改用户全局配置、不授予财务审批；沿用用户已明确授权的同一业务范围，不重复询问。CLI 的第三方模型提示本身不等于服务失败，须核实际官方服务来源及调用结果。

已有账套按[账套记忆](../BUSINESS-MEMORY.md)绑定，再运行 `node start-claude.mjs --claude-cli '<实际 exe 或 JS 入口绝对路径>'`。启动器通过原生 `--settings` 指定本账套的 `autoMemoryDirectory`，由 Claude Code 加载和维护 `MEMORY.md`。恢复只接受本工作区已绑定的 `--resume <UUID>`。 [Claude Code 官方记忆文档](https://code.claude.com/docs/en/memory#storage-location)

在生成目录通过受控启动器使用账套记忆。配置及参数检查可核对目标目录，具体原生加载按使用的 CLI 版本和实际会话验证。

尚未建账时，在新生成的未绑定工作区运行 `claude --strict-mcp-config --mcp-config .mcp.json --settings .claude/settings.json`，直接发起账前核对。该启动方式保持 Auto Memory 关闭。

整期委托选择项目原生技能 `tax-period`，单独安装 marketplace 时对应命令为 `/finance:tax-period`。生成工作区使用 `.mcp.json` 中绑定的服务，并在项目设置中停用同源插件。原生技能不可用时，可通过 `skills_list` 和 `skills_read` 查阅同版本正文。
