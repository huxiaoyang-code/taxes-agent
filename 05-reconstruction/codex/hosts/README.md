# 多宿主接入

先读[主 Agent 从这里开始](START-HERE.md)：从安装、明确账库、四宿主配置和官方模型设置，到首次合成检验与失败恢复。

支持为 [Pi](pi/README.md)、[Claude Code](claude-code/README.md)、[DeepSeek Harness / dsh](dsh/README.md) 和[智谱 ZCode](zcode/README.md)生成主 Agent 入口。四者复用[中文 Harness Skill](../skills/harness/SKILL.md)、账套、来源、任务与原生回执。Pi 使用原生 SDK 与财税扩展，其他三者使用本机财税 stdio MCP，可独立作为主体，不依赖 Pi 作为后台 worker；可选解析角色按宿主单独验证。

“支持接入”表示提供原生配置、入口指令及工具范围约束；实际宿主连接、模型执行和完整财税业务验收是不同层次。已安装宿主可以做无模型连接检查；未安装宿主只能验证生成配置及其所指 MCP 服务，不能声称其真实会话已运行。具体版本、命令与未验证范围记录于 PR。

## 生成配置

先按[Windows 启动指引](../../../docs/CODE-INDEX.md#windows)启动显式数据目录的本机后端，记录实际监听端口与账库路径。仓库根运行：

```powershell
node 06-workbench/scripts/finance-host-config.mjs --host claude-code --node 'D:\node.exe' --api-base 'http://127.0.0.1:8787' --database 'D:\明确数据目录\workbench.db' --out 'D:\已存在父目录\全新财税工作区'
```

`--host` 可选 `pi | claude-code | dsh | zcode`。所有路径均须为操作者明确选择的绝对路径；Node 文件须存在，后端必须是带端口的本机 HTTP 地址。输出的父目录须已存在，输出目录必须全新；生成器拒绝覆盖或合并任何已有配置。示例路径不是默认账套。生成不会创建/修改数据库、启动后端或宿主，也不读取模型凭据。

每个宿主的文件位置与启动命令见各自 README。不要将生成内容直接复制覆盖已有工作区；先审阅并按宿主原生规则显式加载。ZCode 打开配置所在工作区后可能自动连接 MCP；dsh 使用显式 overlay；Claude Code 使用会话级 `--mcp-config`。

## 工具与状态边界

生成的环境明确设置 `FINANCE_MCP_PROFILE=harness`、`FINANCE_API_BASE`、`FINANCE_DATABASE_PATH`、`FINANCE_SKILLS_DIR`。`harness` profile 的 `tools/list` 只公布 Harness 生命周期工具与 `skills_list`/`skills_read`；猜名字直接调用其他工具也会在业务处理前被拒绝。未设置 profile 的既有客户端保持原工具面，未知 profile 拒绝启动。

该 profile 仍包含可修改元数据及执行业务的 Harness 工具，不是只读权限或会计批准。宿主保留自身审批；不使用跳过权限选项，不自动允许全部 `harness_*`。首次创建/导入账套不在此工具面中，应经已授权的现有导入流程完成后再核实持续核算目标。

工具清单不是文件系统或网络沙箱；宿主的 shell、文件工具、其他 MCP 服务仍可能有自己的权限。解析子 Agent 的工具与模型继承规则按各宿主单独配置，不能把 Pi 的 `finance_delegate_parser` 名称当成已迁移。真实账套、税务凭据和会话仅按明确授权处理，不进模型、日志、Git 或公开测试。

切换宿主时保留同一账套身份、原件路径、Harness Store 和原操作身份。先查实际状态，未知写结果先 query，再处理未完成或受影响分支；Pi/其他宿主的对话日志不会自动转换为财税执行回执。一次只由当前负责宿主接续同一工作，不能靠重建 Store 或换 operationId 掩盖历史。

## 无模型验证

```powershell
node 06-workbench/test/finance-host-config.test.mjs
node 06-workbench/test/host-dsh.test.mjs
node 06-workbench/test/host-zcode.test.mjs
```

这些测试使用合成材料与临时目录，验证配置生成、真实 stdio 工具面及拒绝、来源与事实等有限路径；不是模型准确率或正式申报验收。付费模型运行须有当次明确授权，并单独记录宿主版本、模型、工具、实际回执和未完成项。

## 官方 DeepSeek 实测

2026-10-29 经用户当次授权，四个实际宿主均使用官方 `deepseek-flash` 完成一次有限元数据流程：发现能力合同、新建独立 Store、登记合成原件、登记有 `original` 证据的金额字符串、查询状态。成功以原生 journal、账套 scope、原件 SHA-256 及事实绑定核对，不只依据宿主退出码或模型自述。

| 实际宿主 | 官方 DeepSeek 协议 | 上游请求数 | 执行耗时 | 元数据结果与证据范围 |
|---|---|---:|---:|---|
| [Pi 1.1.0](pi/README.md) | OpenAI Chat Completions `/chat/completions` | 6 | 13.024 秒 | 通过；新生成入口启动原生 CLI，含 `tool_search` 共 6 次工具调用；原件金额 `452.19`，预先明确正确标量绑定合同 |
| [Claude Code 2.1.309](claude-code/README.md) | Anthropic Messages `/anthropic/v1/messages` | 7 | 18.308 秒 | 通过；原件金额 `363.47`，首次标量绑定错误被拒绝后修正成功 |
| [dsh 0.2.1-rc.2](dsh/README.md) | 原生 `deepseek-official` Messages `/anthropic/v1/messages` | 7 | 18.105 秒 | 通过；原件金额 `314.27`，首次标量绑定错误被拒绝后修正成功 |
| [ZCode CLI 0.16.9](zcode/README.md) | OpenAI Chat Completions `/chat/completions` | 7 | 26.579 秒 | 通过；原生 `build` 模式与 app-server 有限工具授权，原件金额 `146.28`；原生输出限额 `max_tokens=2048` |

四次运行合计使用共享上限 36 次中的 27 次上游请求：Pi 6 次，其余各 7 次；这是请求计数，不是费用估算。各宿主运行在独立临时配置与合成账库中，只授权本次元数据工具，未创建凭证、执行期末核算、税局申报或付款。前三宿主的事实绑定错误及修正保留原始回执；Pi 任务预先明确了正确空字符串 `valuePath` 合同，因此不能用次数、耗时或首次成功对四者作横向准确率排名。

本次临时网关限制模型、请求数、请求体、输出与超时，不自动成为配置生成器的产品能力。该短流程证明实际宿主、官方模型与财税 MCP 能协作完成所述元数据目标，不代表完整财税效果、通用准确率或解析子 Agent 的模型验收。具体配置、审批差异及未验证范围见各宿主 README；原始执行和独立审查记录见 PR。
