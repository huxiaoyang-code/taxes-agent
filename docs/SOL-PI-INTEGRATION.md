# SoL-Pi 接入与使用范围设计

本文定义本机单用户财税工作台拟议的运行效率扩展合同。**尚未实现接入、安装依赖、运行模型或验证收益；以下新增参数和流程均为设计，不能作为当前可用命令。** 本规划及 Harness² 规划在用户确认前分别保持 Draft PR，不自动合并；用户确认后，范围内的依赖准备、接线、验证、审查及整合沿既有授权执行，超出已确认范围再沟通。当次付费模型测试与真实业务保持现有明确的数据及授权边界；本轮不实际安装或启动。

本地核对基线为 `639d55f4d75ea450d7f00beb4020d1b3309f33bb`；上游链接为 2026-10-29 查阅的 `main`，不是已锁定的交付依赖。实施前必须锁定并复核实际 commit，不能直接沿用移动分支的兼容结论。

## 定位与现有边界

SoL-Pi 官方交付的是四个默认关闭、逐项启用的 Pi 效率扩展；研究中发现这些机制，不代表公开插件能自动完成本项目的财税改进闭环。它不提供财税业务规则、人审批准、账套权限或数据库事务。Harness² 的改进研究与 SoL-Pi 的运行效率分别选择、独立发布、可独立关闭。[上游 README](https://github.com/NVlabs/SoL-Pi/blob/main/README.md)

本设计依据本项目以下实际接线，不按入口数量推断能力或业务完成：

- [Pi 接入说明](../05-reconstruction/codex/pi/README.md)和[扩展](../05-reconstruction/codex/pi/finance-harness.ts)：按 Pi 1.1.0 验证，注册原生财税 MCP，并提供禁止递归的资料解析子进程。
- [无模型探针](../06-workbench/scripts/harness-pi-probe.mjs)：断言 Pi 1.1.0，通过实际加载器、原生 MCP 和 tool_search 验证延迟工具发现与调用。
- [披露验收 runner](../06-workbench/scripts/harness-disclosure-acceptance.mjs)：固定现有 Pi / 官方模型条件，显式加载扩展、禁止委派，记录源码与资料哈希及返回体积；prepare 与 run 分离，prepare 不调用模型。
- [原生运行时](../06-workbench/server/harness-runtime.mjs)、[回执呈现](../05-reconstruction/codex/mcp/finance-mcp/receipt-presentation.mjs)、[披露测试](../06-workbench/test/harness-disclosure.test.mjs)和[批次部分效果测试](../06-workbench/test/harness-batch-partial-effects.test.mjs)：业务操作、当前结果与确认状态需要分别判断；摘要和完整回执互相可追溯。

现有入口以 `--no-extensions` 关闭默认扩展，再显式 `-e builtin:mcp`、`-e builtin:tool-search`、`-e finance-harness.ts`，不能因安装 SoL-Pi 就假定已加载。Windows 父 runner 使用 `powershell`；解析子进程使用 `--no-session --no-extensions --no-mcp` 和受限工具集合，Windows 同样选择 `powershell`。这些角色约束不是操作系统沙箱。

多宿主工作与 [PR #132](https://github.com/huxiaoyang-code/taxes-agent/pull/132)协调。SoL-Pi 本设计只覆盖 Pi；选定 Claude Code、dsh、ZCode 等其他宿主时，请求 SoL-Pi 必须明确报不支持，不能悄悄改由 Pi 执行。上游跨宿主 Skill 示例不属于本期接入。

## 拟议启动选择合同

未来启动器采用两条独立选择轴；以下是**未实现的参数格式**：

| 参数 | 拟议枚举 | 默认 |
|---|---|---|
| `--harness-improvement` | `off`、`harness2` | `off` |
| `--runtime-efficiency` | `off`、`sol-pi` | `off` |

| 改进选择 / 效率选择 | 允许范围 |
|---|---|
| `off` / `off` | 保持现有 baseline；不加载两项研究/效率依赖，不生成它们的运行产物。 |
| `harness2` / `off` | 仅 Harness² 的合成隔离研究，须满足其独立设计与验收。 |
| `off` / `sol-pi` | 本设计兼容验收通过后，才允许在已确认的 Pi 配置中显式启用。 |
| `harness2` / `sol-pi` | 初期明确拒绝；独立组合验收通过后才另行支持。 |

未知参数、未知枚举、缺依赖、不支持版本、无效配置和不支持组合必须在启动模型/业务操作前明确失败，报告所选宿主与失败条件。不得静默降级、自动下载/安装/升级、自动扩大工具集合或写用户全局配置。`sol-pi` 也不意味着开启四项机制：首期配置只允许 ObservationPack，其余保持关闭。

共享启动器及参数解析由一个后续实施 PR 统一所有权；本设计不指定新文件或修改其他规划 PR 的入口。实施者须先协调 #132 的宿主选择合同和 Harness² 的选择轴，保留现有入口的 baseline 行为与原生 MCP 接线。

## 依赖与加载合同

上游兼容文档列出的测试版本是 Pi 0.84.2、1.0.4、1.3.0，**不含本项目 1.1.0**。上游还指出较早 1.x 的内部包 caret 范围可能使新安装混入 1.3.0 而启动失败；不能把“本机现有版本能运行”等同于可重装复现，不能自动升级现有 Pi。[兼容说明](https://github.com/NVlabs/SoL-Pi/blob/main/docs/compatibility.md)

后续实施须使用独立工具目录，固定 Pi、内部包、SoL-Pi 完整版本/commit 与 lockfile，记录实际解析版本及来源；上游 peer 范围不作为本项目支持声明。Node 同时满足项目资格检查与上游最低要求；引入代码/分发物保留 [MIT 版权与许可](https://github.com/NVlabs/SoL-Pi/blob/main/LICENSE)。不修改全局 Pi 或复制他人配置、凭据。

先无模型验证原生 MCP、tool_search、财税扩展和 Windows 工具，再判断是保持完整锁定的 1.1.0、窄适配，还是另提升级。上游兼容脚本只检查其自身 API 假设，不能代替本项目的 MCP/恢复合同；现有探针也硬编码 1.1.0，升级需要同步评估探针与 runner，不能仅删断言宣称兼容。

有效配置必须可审计地固定为本次选择，不能受既有全局/受信任项目配置意外启用其他机制。上游配置有项目信任和整文件替换规则；只采用真实支持的键并在模型启动前校验，不能虚构环境变量或过滤键。[配置说明](https://github.com/NVlabs/SoL-Pi/blob/main/docs/configuration.md)

## 四项机制的业务适用边界

### ObservationPack：首期唯一试验候选

上游目前只包装大于 10 KiB 的成功纯文本工具结果，前两次 provider 请求保留全文，此后在上下文投影层替换为稳定占位与分页召回；错误或混合内容不是同一候选。它不改已存会话历史，`obs_recall` 使用字节偏移读取本机归档。[observation.ts](https://github.com/NVlabs/SoL-Pi/blob/main/src/sol-pi/extensions/observation-pack/observation.ts)、[index.ts](https://github.com/NVlabs/SoL-Pi/blob/main/src/sol-pi/extensions/observation-pack/index.ts)

适合先比较合成解析/验证的长文本结果重复回放成本。它不理解业务三态、事实版本、金额、税款口径或恢复身份；不能替换原生 Harness Store。现有 `harness_receipt_read` 已按 `receiptRef` / JSON pointer / nextOffset 读取完整原生回执；额外 `obs_recall` 是另一层文本召回，不是原生回执恢复证明。

实施前须核查 Pi `content`、Pi `structuredContent` 包装与原生 MCP `structuredContent` 的实际传播，防止只缩 text 却重复发送结构体，或占位后失去结构化身份。原生分页的 offset 是 UTF-16 code units、按码点边界推进，不能与 `obs_recall` 字节偏移互换。

首期优先不包装 MCP 财税回执通道。上游已查配置没有按工具排除键；若实现需要排除，应采用经审查的窄适配/选择性注册通道，而不能在文档中发明现成配置。若不能证明排除或双层召回无损，保留该通道原生呈现并限制试验范围。

### Action Fusion：首期关闭

它替换 `edit` / `write`，以可选 `then_run` 把文件修改与后续命令合在一次调用；命令失败仍保留修改。可研究合成解析代码“写入后验证”，但不是数据库事务，也不提供失败回滚。[实现](https://github.com/NVlabs/SoL-Pi/blob/main/src/sol-pi/extensions/action-fusion/index.ts)

不能把业务 prepare、人类授权和 execute 融合成自动执行，不能用 shell/HTTP/SQL 绕开原生 MCP、人审或防重复约束。融合只能覆盖本来就已授权的文件修改及验证，不新增业务权限。

`then_run.command` 仍是 Bash 命令，不能把 `powershell.exe` 当 Bash 路径。Windows 的 Git Bash、路径解析、shell 参数和失败证据需要单独验证；子解析器当前禁扩展，不能为了融合偷偷放开。是否另设隔离解析试验由用户后续确认。

### Evidence-Preserving Reducer：首期关闭

当前候选识别针对 `bash` 结果或融合 `edit` / `write` 的 `then_run` 日志，不是通用 MCP 财税回执压缩器，也不自动覆盖 Windows `powershell`。[candidate.ts](https://github.com/NVlabs/SoL-Pi/blob/main/src/sol-pi/extensions/evidence-preserving-reducer/candidate.ts)

后续最多研究合成诊断日志；匹配原文的引文不证明业务结论正确。失败应保留原结果与本机原始日志，模型压缩不能删去错误、未识别内容或恢复线索。远程日志归约与其模型路由、费用、授权不在本期范围；不得因主模型获准就推导嵌套模型调用获准。

### Online Context Compact：首期关闭

它依赖模型维护任务计划，通过 Pi 原生压缩继续会话；计划与压缩状态进入原生会话日志。模型的计划摘要不能作为持久业务状态，原生 Harness DAG / Store 继续决定事实、依赖、执行和复核是否当前。[配置与运行行为](https://github.com/NVlabs/SoL-Pi/blob/main/docs/configuration.md)

与现有 `--no-session`、新进程恢复、压缩后自动继续和取消/异常路径必须单独验收；不得把“压缩后继续”当成业务恢复已完成，也不能跳过重新查询 Store。缺件、冲突、未支持、unknown、已执行但结果/确认失效的分支必须继续可见。

## 数据、证据与回退合同

SoL-Pi 与 Pi 共用文件、进程、网络及凭据权限，不是沙箱；默认不启用远程 reducer。真实账套库、税务凭据、会话、验证码和原件留在本机可信界面，不进入模型服务、日志、Git 或 PR。自动验证只使用合成数据和临时目录，禁止复制真实业务库作为 fixture。[安全说明](https://github.com/NVlabs/SoL-Pi/blob/main/SECURITY.md)

`--no-session` 不代表没有本机残留：上游在没有会话目录时仍创建临时归档，并保留供父 worker 读取。实施须明确每次运行的企业/账套/会话隔离、归档位置、访问权限、保留期、清理时点与召回失效提示；Windows ACL 须实际验证，不能只根据 POSIX mode 宣称隔离。[runtime-paths.ts](https://github.com/NVlabs/SoL-Pi/blob/main/src/sol-pi/runtime-paths.ts)

原始回执、解析证据和审计记录先保全，再按经确认的保留策略清理效率归档；关闭扩展或回退不能删除业务证据。崩溃、存储失败或召回缺失必须显式记录并停止依赖该结果的业务推进。上游包装失败可能保留全文继续；这不等于本项目允许启动校验失败时静默回到 baseline，运行中保留全文也须进入验收记录。

回退通过独立工具依赖和下一次进程选择 `off` 完成，保留原生 Store / operation 身份和历史回执。unknown 写操作先按原身份 query，再决定是否继续；不能换 Store、改企业、换 operationId 或重跑全部业务来掩盖不确定结果。SoL-Pi 与 Harness² 的关闭和依赖回退互不捆绑。

## 实施前验收合同

以下均是未来准入条件，**不是本规划已通过的测试**。实施者自测后，由未参与实现、使用全新上下文的独立审查者阅读实际 diff、运行必要验证；PR 记录实际命令、结果、已审查版本及未验证范围。

| 验收面 | 必须取得的证据 |
|---|---|
| 无模型加载 | 固定完整依赖；真实扩展加载器与原生 MCP/tool_search 调用成功；记录实际 Windows shell、扩展清单和工具暴露。无模型探针不调用付费模型。 |
| 默认与错误 | 双 off 保持 baseline，无额外加载/归档/网络副作用；未知参数/枚举、坏配置、缺依赖、不支持版本/宿主在模型前明确失败；初期双启用明确拒绝。 |
| ObservationPack | 阈值两侧、前两次全文与后续占位、错误/混合内容、中文/emoji/超长行、分页边界、完整哈希、缺失/损坏/不可写归档；召回后逐字重建，失败不丢原结果。 |
| 回执传播 | 实测 text / Pi structured 包装 / MCP structuredContent；原生 receiptRef、JSON pointer、税款口径、错误及 unknown 信息不丢失；原回执恢复与双层召回正确，体积统计不重复计数。 |
| 业务恢复 | 中断后先 query 原 unknown 写；防重复、部分效果、operationState/resultCurrent/confirmationCurrent 和跨企业隔离不变；更正/补件仅使应受影响分支失效。 |
| 进程边界 | 父/子进程扩展范围符合原合同；不能意外放宽解析子进程的 no-extensions/no-mcp、凭据或账簿访问范围；归档权限与保留清理实际可核。 |
| 业务正确性 | 独立预期验证实际账务/税款/期间、原件事实与会计反馈门槛；缺件、冲突和未支持仍未完成，无自动制造人审接受或缴款事实。 |

只有无模型与恢复合同验证后，才在获得当次授权时开展 ObservationPack 合成 A/B。固定相同源码、资料哈希、模型/provider、思考参数、工具/扩展及预算；baseline 为双 off，实验仅切换 ObservationPack。使用独立 held-out 场景，Agent 不读测试黄金值；旧调用次数不能充当同条件 baseline。

同时记录业务正确完成数、失败与中断、人工介入、重试、召回、延迟、输入/输出/cache token、原始与实际发送体积、实际费用。按“成功且业务正确的任务”统计单位费用，分子包含失败、召回、压缩和 reducer 等全部实际调用成本；未知价格/计费用量保留 `unknown`，不估填节省比例。扩展显示的 token 估计或 cache 比率不是账单。

实际账务正确、证据完整、会计反馈和恢复门槛优先于 token 或调用次数。不能通过提前停止、隐藏失败、跳过验证或缩减任务范围获得“节省”。若效率无收益但业务正确，也如实记录，不能扩大启用范围补数字。

## 用户确认与后续阶段

本规划建议先确认两条选择轴、首期 ObservationPack-only、Pi 专属边界、隔离工具依赖与合成 A/B 范围；共享入口仍由一个实施 PR 负责。范围内的版本保留/升级、MCP 通道窄适配与归档保留策略依据兼容证据形成审查记录；扩展至另外三项机制等超出已确认范围的研究再沟通。

设计确认后，后续阶段依次为：独立依赖与无模型兼容、ObservationPack 合成 A/B、业务/恢复独立审查、再决定是否允许显式选择。Harness² 组合和其他机制各有独立准入，不因单项通过自动开放。实施分工、依赖、未完项和实际验收证据保留在对应 Issue / PR，不在本文维护任务状态表。
