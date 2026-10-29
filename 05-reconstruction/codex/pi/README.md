# pi 接入

本入口按 `@earendil-works/pi-coding-agent` 1.1.0 验证，使用原生 `registerMcpServer`；安装 pi 不代表已加载本扩展或具备子 Agent。以下命令从仓库根目录运行，Node 需满足工作台资格检查。不要改用户全局配置。

已有本机 pi 可直接使用；需要项目局部安装时，在项目外明确的工具目录运行 `npm install --prefix <工具目录> @earendil-works/pi-coding-agent@1.1.0`，再用 `node <工具目录>/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js` 代替下面的 `pi`。

先做不调用模型的加载和真实 MCP 验证（将路径替换为实际 npm 包目录）：

```powershell
node 06-workbench/scripts/harness-pi-probe.mjs '<pi包的绝对目录>'
```

此探针使用实际 pi 扩展加载器和原生 MCP 连接，只读能力目录及 Skill；不读取用户 auth/config/session、不调用模型、不冒充子 Agent 演示。其他 MCP 宿主直接以 stdio 启动 `node 05-reconstruction/codex/mcp/finance-mcp/server.mjs`，读取 `harness/SKILL.md` 即可。

真实业务先启动明确目录的本机后端。Windows 从 `06-workbench` 使用 `scripts/windows-start.ps1 -NodePath <node.exe绝对路径> -DataDir <明确目录> -Port 0`，采用返回的实际监听地址。MCP 所在进程显式设置同一目标：

```powershell
$env:FINANCE_DATABASE_PATH = '<明确目录>\workbench.db'
$env:FINANCE_API_BASE = 'http://127.0.0.1:<实际端口>'
pi --no-session --no-context-files --no-extensions -e builtin:mcp -e builtin:tool-search -e ./05-reconstruction/codex/pi/finance-harness.ts --skill ./05-reconstruction/codex/skills/harness/SKILL.md --provider deepseek --model deepseek-flash
```

使用现有本人 DeepSeek 官方 provider 凭据或本人已配置的 `DEEPSEEK_API_KEY` 环境变量，官方地址为 `https://api.deepseek.com`；不要复制他人密钥、写进仓库、日志或证据包。需新增模型配置时使用独立临时 Agent 目录/项目配置，先核实 pi 的真实模型ID和当前官方合同，不把其他中转服务的同名 alias 当官方接口。父子 Agent 继承本轮实际模型，无自动跨服务回退。

`--no-extensions` 同时关闭默认内置扩展，因此必须显式保留 `builtin:mcp` 与 `builtin:tool-search`。无模型探针使用完全相同的三个显式扩展路径和 noExtensions 选择，实际验证延迟工具经原生 tool_search 激活并调用 MCP，不仅检查登记表。

付费模型测试须先取得当次用户授权。获准后一次集中运行：先 `node 06-workbench/scripts/harness-demo.mjs prepare <全新合成目录>`，再让真实 pi 读取生成的 goal.txt；不要把内部黄金分录/已算税额交给 Agent。第一阶段后用 `supplement <目录>` 只生成原始补件和第二阶段 goal-supplement.txt，再用新 pi 会话从原 Harness Store 接续，只处理受影响分支。生成器仅预建空账套以验证已有目标接入，不证明任意新企业 bootstrap。记录实际 pi 版本、模型/provider、扩展、原生 MCP 调用、解析子 Agent 轨迹、代码与验证文件、业务回执和未完分支；最后 `assess <目录>` 只核查实际账务，不能代替 Agent 演示。

扩展只将发现与入口 Skill 直接披露，其他 Harness 和既有 context/create 工具按需发现；不开放在线登录、采集、申报或缴款。`finance_delegate_parser` 启动全新 pi 进程，显式关闭其他扩展、MCP、上下文文件和递归委派，Windows 使用 PowerShell。它能写解析代码并运行验证；这些是角色和工具限制，**不是操作系统沙箱**。真实资料需在用户授权、可信本机环境中处理；公共演示只用合成/脱敏数据。

本仓库维护的扩展提示词、Harness 工具说明、发现导航与事实证据诊断使用中文；工具名称、JSON 字段、枚举、错误码和协议版本保持不变。Pi 上游通用提示词及原生能力合同中的其他说明不在本次翻译范围；中文化不新增业务能力或证据校验。

能力入口 `harness_discover()` 只返回领域目录；以 `harness_discover({domain:"agency"})` 或 `{query:"service workpaper",limit:8}` 找候选，按 nextOffset 翻页，再以 `{capabilityId}` 读同一运行合同、最小示例、阶段语义、限制与 Wiki。搜索不证明适用。新任务以 requestFactId 显式选择已登记业务请求事实，不依赖 factIds 排序；仍包含全部推导输入，事实登记/status 的 factBindings 提供 valueDigest/factVersion。旧首事实任务及显式 full 目录保留兼容。MCP 默认 text/structuredContent 同步摘要，完整原生回执在Store保存，由 `harness_receipt_read` 按引用/JSON pointer/nextOffset读回；旧客户端可显式 responseMode=full。新的事实证据请用 factEvidencePolicy=require，精确定位/推导输入方法见 materials 指引。sourceRefs-only旧调用保持兼容但明确未验证，不保证直接原生API或语义理解。

本轮披露验收可用 `node 06-workbench/scripts/harness-disclosure-acceptance.mjs prepare <全新目录>` 生成陌生合成原件；经当次授权再以 `run <目录> <pi包目录> initial` 启动实际pi/官方DeepSeek。此runner禁止再次委派，允许父Agent运行自己的解析验证代码，保存真实MCP返回体积、源码/Skill/资料哈希和调用参数；supplement/correct/recover只生成后续原件与目标。人工介入及无效源码搜索必须据实际日志评审，原601次调用不是同条件基线。

设计与版本依据：[pi v1.1.0 上游子 Agent 示例](https://github.com/earendil-works/pi/tree/v1.1.0/packages/coding-agent/examples/extensions/subagent)、[MIT 许可证](https://github.com/earendil-works/pi/blob/v1.1.0/LICENSE)、[MCP 2025-06-18 Tools 契约](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)。本扩展复用原生 MCP 并参考上游新进程/独立上下文设计；未复制上游示例实现。
