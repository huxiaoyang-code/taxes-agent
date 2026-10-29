# ZCode 接入

本适配为智谱官方 ZCode 生成原生工作区配置，复用同一个财税 stdio MCP 和中文 Harness Skill。它不加载 Pi 扩展，不提供新的税务或记账算法，也不配置模型、账号或密钥。

由仓库的共享宿主配置生成器选择 `zcode`，显式提供 Node、财税后端、账库和全新输出目录。输出包括 `.zcode/config.json`、工作区 `AGENTS.md` 和 `manual-user/agents/finance-parser.md`。生成器不会修改用户级配置、已有工作区、账套或会话；不要将生成内容直接覆盖已有配置。

在仓库根目录运行，替换下列明确路径与后端实际端口；输出父目录须已存在，输出目录须全新：

```powershell
node 06-workbench/scripts/finance-host-config.mjs --host zcode --node 'D:/node.exe' --api-base 'http://127.0.0.1:<实际端口>' --database 'D:/财税工作区/本企业/workbench.db' --out 'D:/财税工作区/zcode-finance-new'
```

确认后端已按显式临时目录或获授权账套启动，再由用户打开生成目录。ZCode 工作区 MCP 会自动连接；同名用户级 `finance` 服务可能优先于项目配置，需核对实际连接来源。原生配置使用 `mcp.servers.finance`、`type:stdio`，显式设置 `FINANCE_MCP_PROFILE=harness`、后端地址、数据库路径和技能目录。该 profile 在服务端限制工具清单与直接调用；它包含可写的 Harness 能力，不是只读模式，不取代业务授权或宿主的权限提示。

`skills.roots` 指向现有仓库技能目录，`AGENTS.md` 也要求先通过 `skills_read` 读取 `harness/SKILL.md`。保持仓库路径有效，使用实际宿主的技能清单核对加载。旧宿主构建的配置和路径可能不同，不把生成成功当作宿主已读取。

保留默认变更前确认，配置中的 `permission.mode` 为 `build`。若使用非交互 CLI，显式指定模式：`zcode --cwd <生成目录> --mode build`；不要使用 `yolo`、完全访问或绕过审批来证明适配成功。某些业务写入在无审批客户端时会拒绝，这应报告为未执行。

解析角色模板不会自动安装。当前官方自定义子智能体仅支持用户级目录 `~/.zcode/agents/`；需要时先审阅模板，再由用户将其安装为 `finance-parser.md` 并新建会话。模板继承当前模型，工具白名单没有 MCP 或 Agent/Task；它允许写解析文件和运行解析代码，不拥有账库工作。不要把默认全权限 general-purpose 角色当作受限解析器。白名单和提示词不构成操作系统沙箱。

无模型验收应依次核对：原生配置能解析；财税服务 `tools/list` 仅返回约定 profile 工具；猜名直调其他工具被拒绝；实际 `harness_discover`、来源与事实登记返回真实回执；错误、超时与未完成项得到保留。后续业务验收只用合成资料、临时账库，并单独记录宿主版本、实际工具和回执。

官方 DeepSeek 接入单独使用 ZCode 原生个人 provider 配置：`api.type` 为 `openai-chat-completions`，`api.baseUrl` 为 `https://api.deepseek.com/v1`，`personalModelIds` 包含 `deepseek-flash`。凭据由操作者配置，不写进本适配生成文件。模型选择的 `options` 只设置 `reasoningLevel: "low"`，不要把 `maxOutputTokens` 放进该对象。输出限制应配置在 `modelConfigRules.providerModelRules` 对应 provider/model 的 `config.optionSpecs` 中：

```json
{
  "maxOutputTokens": {
    "max": 2048,
    "map": "{\"max_tokens\":maxOutputTokens}"
  }
}
```

2026-10-29 已用官方应用自带 CLI **0.16.9** 实测：通过 `node <应用安装目录>/resources/glm/zcode.cjs app-server --stdio --cwd <隔离工作区>` 启动原生宿主，隔离 HOME、模型配置、会话、日志和账库；`session/create` 保持 `mode: "build"`，仅将 `harness_discover`、`harness_init`、`harness_source_register`、`harness_facts_register`、`harness_status` 五种工具纳入该次会话的原生 `toolAllowlist`。该版本还需传 `thoughtLevel: "low"`，不能仅依赖 `model.options.reasoningLevel`。实际审批请求为 0；授权来自上述有限白名单，未使用 `yolo` 或全权限模式。

本次经有调用预算的本机网关连接官方 DeepSeek `deepseek-flash`，7 次请求均 HTTP 200，原生宿主耗时 26.579 秒、退出码 0。原生请求全部已为 `max_tokens: 2048`，没有 `max_completion_tokens`，不依赖网关改写字段。完成 Store 初始化、合成原件登记、金额事实 `146.28` 的原件行列绑定及状态查询；原件 SHA-256 与保存来源一致，临时账库凭证数仍为 0。

实际共 6 次工具调用：发现、初始化、来源登记、两次事实登记、状态查询。第一次事实登记误将原件位置当作 `valuePath`，服务返回 `harness_evidence_value_unbound`；模型按回执修正为绑定整个标量值的空路径后登记成功。宿主外层 `result.success: true` 也可能包着 MCP 业务失败，验收须读取内层 `status`、错误码及原生 journal，不能只看宿主退出码或模型自述。本次仅验证有限元数据流程与一次错误修正，未验证完整月账、申报、支付或解析子智能体的模型执行能力，不能据此计算整账准确率。

依据核对于 2026-10-29：官方仓库 `zai-org/ZCode` 提交 `3c5b227649371507ddc4eb46ac5133afe6db1cab`（README 对应应用 v3.16.2；CLI workspace 根包标记 v0.17.0）；实际验收版本来自本机官方安装产物的 `--version` 输出 0.16.9，不将源码包版本当作运行版本。

- [官方 MCP 使用及作用域](https://zcode.z.ai/cn/docs/mcp-services)
- [官方 CLI MCP 配置](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/apps/zcode-cli/docs/usage/07-mcp.md)
- [官方配置 schema](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/apps/zcode-cli/packages/adapters/src/config/schema.ts)
- [官方技能目录与技能清单](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/apps/zcode-cli/docs/usage/08-skills.md)
- [官方 AGENTS 指令装配](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/apps/zcode-cli/docs/usage/11-memory.md)
- [官方子智能体与用户级限制](https://zcode.z.ai/cn/docs/subagents)
- [官方 CLI 权限语义](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/apps/zcode-cli/docs/usage/05-permissions.md)
- [官方个人 provider 配置读写结构](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/apps/zcode-cli/packages/provider-node/src/provider-config-file-codec.ts)
- [官方模型选择选项结构](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/apps/zcode-cli/packages/shared/src/model-selection.ts)
