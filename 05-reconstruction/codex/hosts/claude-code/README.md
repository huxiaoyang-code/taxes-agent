# 当前直接业务接入

本页当前入口采用中国化业务 Skill＋原生 MCP，默认 `FINANCE_MCP_PROFILE=direct`。Agent自主选择工具，后台完整自动记录；不要求来源/事实登记、Store或任务DAG。生成器可用 `--plugin-root <中国化fork的finance绝对目录>` 加载官方格式插件，用 `--audit-dir` 指定本机记录目录。

接入步骤以 [统一入口](../START-HERE.md) 为准；工具结果按账本金额→凭证/计算结果→规则依据→工具调用→输入与原件展示，日常前三项、异常再展开后两项。真实写入仍遵守现有工具约束；配置、无模型协议检查和实际模型业务验收分别记录。
当前生成 .mcp.json、.claude/settings.json、CLAUDE.md；以 claude --strict-mcp-config --mcp-config .mcp.json --settings .claude/settings.json 显式加载。只读工具建议自动允许，其余保留宿主审批；不安装额外角色。

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
