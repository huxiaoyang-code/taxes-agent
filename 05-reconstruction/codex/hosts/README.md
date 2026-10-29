# 多宿主接入

支持为 [Claude Code](claude-code/README.md)、[DeepSeek Harness / dsh](dsh/README.md) 和[智谱 ZCode](zcode/README.md)生成接入配置。三者连接同一个本机财税 stdio MCP，复用[中文 Harness Skill](../skills/harness/SKILL.md)、账套、来源、任务与原生回执，不依赖 Pi 的 TypeScript 扩展。

“支持接入”表示提供原生配置、入口指令及工具范围约束；实际宿主连接、模型执行和完整财税业务验收是不同层次。已安装宿主可以做无模型连接检查；未安装宿主只能验证生成配置及其所指 MCP 服务，不能声称其真实会话已运行。具体版本、命令与未验证范围记录于 PR。

## 生成配置

先按[Windows 启动指引](../../../docs/CODE-INDEX.md#windows)启动显式数据目录的本机后端，记录实际监听端口与账库路径。仓库根运行：

```powershell
node 06-workbench/scripts/finance-host-config.mjs --host claude-code --node 'D:\node.exe' --api-base 'http://127.0.0.1:8787' --database 'D:\明确数据目录\workbench.db' --out 'D:\已存在父目录\全新财税工作区'
```

将 `--host` 替换为 `dsh` 或 `zcode`。所有路径均须为操作者明确选择的绝对路径；Node 文件须存在，后端必须是带端口的本机 HTTP 地址。输出的父目录须已存在，输出目录必须全新；生成器拒绝覆盖或合并任何已有配置。示例路径不是默认账套。生成不会创建/修改数据库、启动后端或宿主，也不读取模型凭据。

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
