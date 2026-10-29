# SoL-Pi 显式接入

本机财税主 Agent 可通过独立入口显式选择 Pi 的 ObservationPack。默认 `off`；另外三项机制、其他宿主和 Harness² 组合均未开放。接入使用 NVIDIA 官方公开 factory，不是重写的压缩器。模型 A/B、费用收益、完整业务恢复与独立审查结论以对应 Issue / PR 为准，不能从无模型探针推断业务验收通过。

## 固定依赖与来源

- 上游：`NVlabs/SoL-Pi`，commit `219568034fa54ed121ede80961655e33dfb9d0e3`，版本 `0.1.1`。目录 [upstream](../05-reconstruction/codex/sol-pi/upstream/) 保留官方原始 ObservationPack、runtime-paths、TUI 及 MIT 许可；逐文件 SHA-256 在 [upstream-manifest.json](../05-reconstruction/codex/sol-pi/upstream-manifest.json)。没有改动这些上游文件。
- 已验证工具链：Node `24.15.0`、Pi `1.1.0`；`chord`、`pi-agent-core`、`pi-ai`、`pi-codemode`、`pi-mcp`、`pi-telemetry`、`pi-tui` 同为 `1.1.0`，typebox `1.3.27`。Windows 归档权限检查需要 PATH 中有 PowerShell 7 的 `pwsh.exe`。
- [toolchain-package.json](../05-reconstruction/codex/sol-pi/toolchain-package.json) 与 [toolchain-package-lock.json](../05-reconstruction/codex/sol-pi/toolchain-package-lock.json) 固定完整依赖树。不能只锁四个 Pi 包：实际安装时其余内部包的 caret 范围会漂移并造成缺失导出。不得删除版本断言、自动升级全局 Pi，或从 peer 范围推断支持。

先由操作者明确准备全新的专用工具目录，复制上述两个文件为 `package.json` / `package-lock.json`，再在该目录运行 `npm ci --ignore-scripts`。启动器不联网安装、不读取或复制用户认证、配置、会话或账库。工具目录与运行归档均不入 Git。

## 选择和入口

| 选择 | 行为 |
|---|---|
| `--runtime-efficiency off`（默认） | 使用已有 Pi baseline；不读取 SoL 依赖或创建 SoL 归档。 |
| `--runtime-efficiency sol-pi` | 仅 Pi；固定 ObservationPack，模型前验证完整锁、上游文件、适配器与无模型证据。 |
| `--harness-improvement harness2` + `sol-pi` | 明确拒绝；无隐式组合。 |
| Claude Code / dsh / ZCode + `sol-pi` | 明确拒绝；不切换宿主。 |

独立 [sol-pi-run.mjs](../06-workbench/scripts/sol-pi-run.mjs) 复用既有 Pi `buildLaunchSpec`。该独立入口只启动 Pi，Harness² 研究使用其自己的入口。既有生成器与 `start-pi.mjs` 保持原合同；生成器仍生成全新工作区和明确账库的 `pi-host.json`。

在仓库根目录运行，所有占位路径换为本机真实绝对路径：

```powershell
node 06-workbench/scripts/sol-pi-run.mjs --config D:/synthetic-workspace/pi-host.json --pi-root D:/tools/finance-sol-pi/node_modules/@earendil-works/pi-coding-agent --runtime-efficiency sol-pi --tool-root D:/tools/finance-sol-pi --archive-root D:/synthetic-workspace/sol-pi-archives --account-set-id synthetic_account --check
```

`--check` 不调用模型。它在三个独立进程中使用真实 Pi 加载器、原生 MCP、tool_search、财税扩展、Windows shell 和官方 ObservationPack，分别验证归档缺失、损坏与日志路径不可写。结果写入工具目录 `sol-pi-verified.json`；三例都通过且依赖、源码及 Node 指纹仍匹配时，模型启动检查才放行。改变源码或完整锁后必须重跑。失败没有 baseline 降级。

业务/模型试验需具备当次授权；将 `--check` 换为既有 `--task-file <绝对合成任务文件> [--json]` 即使用相同显式接线。交互模式保留本人进程环境中的模型凭据。没有模型实测证据时，不宣称节省 token、费用或已完成业务验收。

程序接口在 [runtime.mjs](../05-reconstruction/codex/sol-pi/runtime.mjs)：`resolveSolPi(options)` 为纯选择；`loadSolPi(selection)` 读取并核验；`launchSolPi(selection, spec)` 在核验后分配归档并启动既有父进程。`loadSolPi(selection,{probe:true})` 只用于无模型探针。共享入口可调用这些接口；不能把探针绕过选项用于模型运行。

## 窄适配与业务边界

[extension.ts](../05-reconstruction/codex/sol-pi/extension.ts) 只调用官方 `createObservationPackExtension()`，不加载官方总入口或配置模块。因此全局/受信任项目 `sol-pi.json` 不参与本次选择，不能意外打开 Action Fusion、Reducer 或 Compact；不提供自定义配置文件参数，不杜撰按工具排除键。

适配层仅向官方 context handler 传入成功的 `read` / `bash` / `powershell` 纯文本结果，带 `details` 或 `structuredContent` 的结果也保留原样。`mcp__finance__*`、`finance_delegate_parser` 以及所有其他工具均排除。实际原生 MCP 返回是 `content`、`structuredContent` 与 `details` 并存；固定 Pi 的 DeepSeek OpenAI Completions 转换实测只发送 text，没有重复发送结构体。这里只声明该固定 provider 转换的结果，不推断所有 provider 相同。

原生回执继续通过 `receiptRef`、JSON pointer 和 `harness_receipt_read` 读取；三轴 `operationState` / `resultCurrent` / `confirmationCurrent`、unknown 恢复、税款口径和会计反馈门槛不交给效率层处理。SoL 不增加财税权限，不绕过 MCP，不自动接受会计反馈或制造申报缴款事实。

父进程保留 `--no-extensions` 并显式加载 `builtin:mcp`、`builtin:tool-search`、既有 `finance-harness.ts` 和本适配器；父工具白名单仅增加 `obs_recall`。解析子进程仍由既有实现使用 `--no-session --no-extensions --no-mcp`，不为它打开 SoL 或递归委派。此角色限制不是操作系统沙箱。

## 归档、召回与失败

官方 ObservationPack 对大于 10 KiB 的成功纯文本结果，前两次 provider 投影保留全文，此后使用稳定占位；`obs_recall` 按字节分页，中文与 emoji 边界与原生回执的 UTF-16 offset 不可互换。适配器保留原始 Pi 历史对象，只修改 Pi 交给 context handler 的克隆。

每次运行显式指定 `archive-root` 和稳定本地 `account-set-id`，再由程序生成随机 run UUID；官方 session 归档位于 `<archive-root>/<account-set-id>/<run UUID>/sol-pi/<Pi session id>/`。即使 `--no-session` 仍写该目录。企业标识不作为真实企业名称写入目录；调用者负责核实实际账套与该本地 ID 的映射。路径祖先的 symlink / junction 被拒绝。

Windows 创建后禁用 ACL 继承，删除继承规则，仅授权当前 Windows SID，并读取 ACL 验证；失败即拒绝启动。POSIX 使用目录 `0700` / 文件 `0600`，本期未声明 Linux 实测。归档不是数据库隔离或沙箱，具有本机进程权限的人仍按系统权限访问。

`retention.json` 记录本次路径及保留政策：不自动删除；原生业务证据、审计和回执先保全，完成复核且没有依赖召回的在途工作后，由操作者明确清理该次运行目录。失败目录也保留诊断。关闭 SoL 或下次选择 off 不删除历史归档/业务证据。

相较上游的 fail-open，适配器在投影前验证存储、投影后检查官方 ledger 写入；召回前再次校验完整 SHA-256，并拒绝非普通文件与分裂 UTF-8 码点的偏移。归档缺失/损坏/不可写时保留原始结果，写本地 `adapter-failures.jsonl`、触发 Pi abort 并使该次适配器保持失败；依赖该结果的业务不得继续。恢复应开启新进程并先查询原生 Store / 原 operation 身份，不可换账套或重跑写操作掩盖 unknown。

## 验证范围

合成验证入口：

```powershell
node 06-workbench/test/sol-pi-integration.test.mjs
node 06-workbench/scripts/sol-pi-probe.mjs --tool-root D:/tools/finance-sol-pi --archive-root D:/synthetic/sol-pi-archives --account-set-id synthetic_account
```

探针确实加载官方代码和 Pi 运行时；覆盖阈值、前两请求、逐字哈希召回、中文/emoji/超长行、错误/混合内容、财税通道排除、原生 MCP/tool_search、实际 shell 失败和 abort 报告、归档故障。它不调用 provider，不把 fixture 或脚本当作 Agent 业务演示。

Windows 沙箱中原生 shell abort 已返回 `Command aborted`，但子树快速终止尚不能由该结果推出；探针明确记录 `cancellationTerminationVerified:false` 和实际耗时，需另行核验进程清理。模型 A/B、独立 held-out 业务正确性、真实恢复与费用统计仍须当次授权和独立证据。模型预算、人工介入、失败与全部召回成本都要计入，未知计费保持 unknown。

Action Fusion、Evidence-Preserving Reducer、Online Context Compact、远程 reducer、Harness² 组合与其他宿主 SoL 均保持关闭。今后扩大范围须另作兼容/业务/恢复验收；既有三轴、跨企业隔离、审计、备份和人审门槛优先于效率结果。
