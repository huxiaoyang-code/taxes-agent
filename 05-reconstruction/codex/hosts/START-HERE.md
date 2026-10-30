# 主 Agent 接入

默认使用中国化业务 Skill 与 `direct` 财税 MCP。Agent 自主调查、选路和核对；工具后台自动记录调用，不要求先登记来源、事实、Store 或任务 DAG。

## 准备明确的本机后端

在 `06-workbench` 安装依赖并按 [Windows 运行说明](../../../docs/CODE-INDEX.md#windows)启动明确数据目录。记录实际端口、Node 路径和 `workbench.db` 路径；新空库不代表已完成企业建账。凭据留在本人可信环境，不写到配置或任务文本。

## 生成一个新宿主工作区

在仓库根运行，替换全部占位值：

```powershell
node 06-workbench/scripts/finance-host-config.mjs --host pi --node '<Node绝对路径>' --api-base 'http://127.0.0.1:<实际端口>' --database '<明确账库绝对路径>' --plugin-root '<中国化fork/finance绝对路径>' --audit-dir '<本机调用记录绝对目录>' --out '<已存在父目录/全新工作区>'
```

`--host` 为 `pi | claude-code | dsh | zcode`。`--plugin-root` 可省略，届时使用本仓库已迁移的业务 Skill；提供时校验真实插件清单和 skills 目录。`--audit-dir` 可省略，默认工作区的 `finance-call-records`。生成不启动模型、不建账、不覆盖旧目录或全局配置。

| 宿主 | 生成文件 | 在新工作区启动 |
|---|---|---|
| Pi | `start-pi.mjs`、`pi-host.json`、`AGENTS.md` | `node start-pi.mjs --pi-root '<官方Pi 1.1.0包目录>'` |
| Claude Code | `.mcp.json`、`.claude/settings.json`、`CLAUDE.md` | `claude --strict-mcp-config --mcp-config .mcp.json --settings .claude/settings.json` |
| dsh | `finance.cordis.patch.yml`、`AGENTS.md` | 使用本人模型 overlay，运行 `dsh --profile headless --patch ./finance.cordis.patch.yml --patch ./model.cordis.patch.yml '<明确任务>'` |
| ZCode | `.zcode/config.json`、`AGENTS.md` | `zcode --cwd '<生成目录>' --mode build` |

模型配置见各宿主 README。配置或协议检查通过不等于实际模型业务已验收。Pi `--check` 只加载真实扩展并核对 MCP 工具，不调用模型。

## 开展业务

按目标加载相关 Skill，从真实账库核实企业、账套、期间和币种，选择直接工具；按需用 `finance_rules` 查规则与出处、`finance_record_contract` 查具体字段。原件解释及适用判断由 Agent 完成，确定性计算由既有业务模块执行。未知、冲突、缺件和不支持均保留，不能编造内部字段消除问题。

正常输出顺序：**账本金额→凭证/计算结果→规则依据→工具调用→输入与原件**。日常前三项，异常再展开后两项，后台自动记录始终完整。实际写入遵守现有原生权限、人审、期间和防重复控制；结果未知先查询原操作，不换身份重复写账。真实申报、开票和缴款仍以实际工具能力为准。

## 自动记录与恢复

每次调用获得 `_meta.financeCall.callId`，本机记录保存在 `FINANCE_AUDIT_DIR`；完整底稿位于本机结果索引，不要求模型反复读取 JSON 指针。记录不完整、来源变化、业务失败和模型自行推导分别报告；哈希匹配不代表业务正确。

旧 Harness 只在明确历史兼容任务中选择 `FINANCE_MCP_PROFILE=harness`，不会被新工作区自动加载。详细调用链与记录语义见[架构说明](../../../docs/AGENT-ARCHITECTURE.md)。
