# 当前直接业务接入

本页当前入口采用中国化业务 Skill＋原生 MCP，默认 `FINANCE_MCP_PROFILE=direct`。Agent自主选择工具，后台完整自动记录；不要求来源/事实登记、Store或任务DAG。生成器固定使用同仓库 `plugins/finance/skills`，无需第二次 clone，不接受外部插件路径；用 `--audit-dir` 指定本机记录目录。

接入步骤以 [统一入口](../START-HERE.md) 为准；工具结果按账本金额→凭证/计算结果→规则依据→工具调用→输入与原件展示，日常前三项、异常再展开后两项。真实写入仍遵守现有工具约束；配置、无模型协议检查和实际模型业务验收分别记录。
生成器将本版本的九个主技能和随包参考投放到 `.claude/skills/`。来源及插件版本见 `.finance/skill-source.json`。项目设置允许读取随包技能和业务目录。通过受控启动器绑定账套后，允许查询该账套的科目及账簿。

交互使用前，按 Claude 原生流程信任已核工作区；非交互验收应预先配置隔离客户端的工作区信任与必要的精确工具授权。未信任时项目允许规则可能被忽略，`skills_read`／`skills_list` 的 `permission_denied` 表示宿主许可未就绪，应先核对宿主许可。默认产品不自动信任、不改用户全局配置、不授予财务审批；沿用用户已明确授权的同一业务范围，不重复询问。CLI 的第三方模型提示本身不等于服务失败，须核实际官方服务来源及调用结果。

已有账套按[账套记忆](../BUSINESS-MEMORY.md)绑定，再运行 `node start-claude.mjs --claude-cli '<实际 exe 或 JS 入口绝对路径>'`。启动器通过原生 `--settings` 指定本账套的 `autoMemoryDirectory`，由 Claude Code 加载和维护 `MEMORY.md`。恢复只接受本工作区已绑定的 `--resume <UUID>`。 [Claude Code 官方记忆文档](https://code.claude.com/docs/en/memory#storage-location)

在生成目录通过受控启动器使用账套记忆。配置及参数检查可核对目标目录，具体原生加载按使用的 CLI 版本和实际会话验证。

尚未建账时，在新生成的未绑定工作区运行 `claude --strict-mcp-config --mcp-config .mcp.json --settings .claude/settings.json`，直接发起账前核对。该启动方式保持 Auto Memory 关闭。

整期委托选择项目原生技能 `tax-period`，单独安装 marketplace 时对应命令为 `/finance:tax-period`。生成工作区使用 `.mcp.json` 中绑定的服务，并在项目设置中停用同源插件。原生技能不可用时，可通过 `skills_list` 和 `skills_read` 查阅同版本正文。

<details>
<summary>改造前接入说明与历史实测（非当前默认流程）</summary>

# Claude Code 接入

本适配生成本机 stdio MCP 配置、中文 `CLAUDE.md`、权限建议和 `finance-parser` 子 Agent。复用 [Harness Skill](../../skills/harness/SKILL.md) 与原生财税模块；不加载 Pi 扩展。配置生成不调用模型，也不读取或安装模型凭据。

先按[多宿主入口](../README.md)生成全新工作区，并启动显式数据目录的财税后端。进入生成目录后使用已安装的 Claude Code：

```powershell
claude --strict-mcp-config --mcp-config .mcp.json --settings .claude/settings.json
```

该命令会开始交互会话；只有操作者明确开始业务后才调用模型。先在 `/mcp` 检查 finance，再读取 `harness/SKILL.md`。既有用户/组织策略可能限制工具；不要使用绕过权限选项。`permissions.allow` 仅含发现、回执和 Skill 查询；元数据修改、状态核验、执行和反馈明确列入 ask，不自动授权正式入账。`harness_status` 的既有合同不是 readOnlyHint，因此也保留审批。

解析子 Agent 使用宿主原生机制，继承当前模型，只有本地文件/解析工具，没有 MCP 或再次委派工具。其文件和 shell 权限仍由宿主/操作系统决定，不构成账库隔离沙箱；给它的原件与输出目录须明确。换宿主不会自动搬入 Pi 会话；沿原 Store、账套身份及原操作查询恢复。

## 使用官方 DeepSeek

[DeepSeek 官方 Claude Code 接入指引](https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code/)提供 Anthropic 兼容接口。在专用终端设置以下临时环境；`DEEPSEEK_API_KEY` 须由操作者通过本机可信方式提供，不把密钥写入生成配置、命令文本或仓库：

```powershell
$env:ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic'
$env:ANTHROPIC_AUTH_TOKEN = $env:DEEPSEEK_API_KEY
$env:ANTHROPIC_MODEL = 'deepseek-flash'
$env:ANTHROPIC_DEFAULT_OPUS_MODEL = 'deepseek-flash'
$env:ANTHROPIC_DEFAULT_SONNET_MODEL = 'deepseek-flash'
$env:ANTHROPIC_DEFAULT_HAIKU_MODEL = 'deepseek-flash'
$env:ANTHROPIC_SMALL_FAST_MODEL = 'deepseek-flash'
$env:CLAUDE_CODE_SUBAGENT_MODEL = 'deepseek-flash'
$env:CLAUDE_CODE_EFFORT_LEVEL = 'low'
claude --model deepseek-flash --strict-mcp-config --mcp-config .mcp.json --settings .claude/settings.json
```

本例锁定主模型及默认模型槽位；配置中不添加备用提供商或模型。官方文档说明 `claude-opus*` 会映射至 DeepSeek Pro，因此只改主模型、留下默认 Opus 别名会影响费用预期。环境变量仅影响当前终端及其子进程，结束后关闭专用终端；它们不是网络白名单或预算控制器。本次实测另经本机有限预算网关，只接受精确模型 `deepseek-flash`，不允许模型回退。

## 已验证范围

2026-10-29 使用实际 Claude Code `2.1.309`、官方 DeepSeek Flash 和独立合成账库完成一次元数据短流程：读取能力合同、新建 Store、登记原件、登记原件第 2 行金额字符串 `363.47`，最后查询状态。7 次上游请求、6 次工具调用，约 18.3 秒，进程正常结束；Store scope 与合成账库身份一致，原件 SHA-256 与 journal 登记一致，事实证据为 `original`。首次事实调用把标量绑定路径写为 `value`，被 `harness_evidence_value_unbound` 拒绝，随后改为根路径空串成功；原失败回执保留，未修改工具返回或隐藏重试。

该测试只开放 6 个元数据工具并关闭内置文件、shell、委派和联网工具，未使用跳过权限选项；正常交互配置仍按上文保留审批。Store 中任务与业务执行尝试均为 0。此次验证不覆盖解析子 Agent 的模型运行、凭证/期末/报税完整流程或准确率评估；原始执行与审查证据见 PR。

依据：[官方 MCP](https://code.claude.com/docs/en/mcp)、[子 Agent 工具限制](https://code.claude.com/docs/en/sub-agents)、[设置](https://code.claude.com/docs/en/settings)。本机安装版本和实际运行范围在 PR 验证记录中列示；连接、配置解析和业务模型验收分别报告，不能由配置存在推断完整业务可用。

</details>
