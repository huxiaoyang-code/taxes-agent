# Claude Code 接入

本适配生成本机 stdio MCP 配置、中文 `CLAUDE.md`、权限建议和 `finance-parser` 子 Agent。复用 [Harness Skill](../../skills/harness/SKILL.md) 与原生财税模块；不加载 Pi 扩展。配置生成不调用模型，也不读取或安装模型凭据。

先按[多宿主入口](../README.md)生成全新工作区，并启动显式数据目录的财税后端。进入生成目录后使用已安装的 Claude Code：

```powershell
claude --strict-mcp-config --mcp-config .mcp.json --settings .claude/settings.json
```

该命令会开始交互会话；只有操作者明确开始业务后才调用模型。先在 `/mcp` 检查 finance，再读取 `harness/SKILL.md`。既有用户/组织策略可能限制工具；不要使用绕过权限选项。`permissions.allow` 仅含发现、回执和 Skill 查询；元数据修改、状态核验、执行和反馈明确列入 ask，不自动授权正式入账。`harness_status` 的既有合同不是 readOnlyHint，因此也保留审批。

解析子 Agent 使用宿主原生机制，继承当前模型，只有本地文件/解析工具，没有 MCP 或再次委派工具。其文件和 shell 权限仍由宿主/操作系统决定，不构成账库隔离沙箱；给它的原件与输出目录须明确。换宿主不会自动搬入 Pi 会话；沿原 Store、账套身份及原操作查询恢复。

依据：[官方 MCP](https://code.claude.com/docs/en/mcp)、[子 Agent 工具限制](https://code.claude.com/docs/en/sub-agents)、[设置](https://code.claude.com/docs/en/settings)。本机安装版本和实际运行范围在 PR 验证记录中列示；连接、配置解析和业务模型验收分别报告，不能由配置存在推断完整业务可用。
