# Harness² 可选接入设计

本文提出外层优化实验方案，供用户确认后再开实现 PR；不代表插件、适配器或启动参数已经可用。本轮规划 PR 在用户确认前保持 Draft；确认后按已确认范围及既有独立审查／Git 规则实施和整合，包括范围内的依赖安装与接线，不新增逐阶段或逐候选审批。用户确认前不合并、不安装依赖、不调用模型。需求、所有权、当前状态与实际验收证据留在对应 PR。

## 1. 定位与现有边界

产品保持本机单用户工作台，一名操作者处理多家企业、每家企业独立账套。Harness² 用于探索如何改进 Agent 的使用指引，不替换本仓库财税 Harness、Store、固定业务能力或账税规则，也不扩展账户权限平台。

现有合同是 [harness-contract.mjs](../06-workbench/server/harness-contract.mjs)，执行与恢复在 [harness-runtime.mjs](../06-workbench/server/harness-runtime.mjs)，事实、版本和证据生命周期在 [harness-store.mjs](../06-workbench/server/harness-store.mjs)。业务调用仍由 [harness-adapters.mjs](../06-workbench/server/harness-adapters.mjs) 的固定注册解析；入口数量、目录命中或模型声明不证明业务已实现。

拟议边界为：用户目标 → pi 候选执行环境 → 既有 MCP／本机财税 Harness → 固定业务能力与独立临时账套；Harness² 在外层生成候选指引、安排合成重放和比较证据。候选只能产生待审查制品，不能自行激活到日常账务环境。

本期仅设计 pi 候选实验，不承诺所有 Agent 宿主通用。[PR #132](https://github.com/huxiaoyang-code/taxes-agent/pull/132) 涉及多宿主入口；后续共享 launcher 的参数解析和接线必须先协调文件所有权，只由一方实现，本文不修改其配置或入口。

## 2. 上游事实与环境限制

以下依据为 2026-10-29 核查的官方源码；实现前须固定完整上游 commit 并重新核对，不以本节代替兼容验收。

- [官方 README](https://github.com/google-research/harness2/blob/main/README.md) 描述任务级 Propose–Probe–Compose 和跨任务经验积累；候选比较不依赖真值反馈，原生执行器为 OpenCode 与 Codex，pi 需要新增适配。
- [SETUP](https://github.com/google-research/harness2/blob/main/docs/SETUP.md) 要求实验使用 Linux、Python 3.12；[pyproject.toml](https://github.com/google-research/harness2/blob/main/pyproject.toml) 的 Python 范围为 `>=3.12,<3.14`、系统分类为 POSIX。这不构成 Windows 原生支持声明。
- [BenchmarkAdapter](https://github.com/google-research/harness2/blob/main/harness2/core/spec.py) 提供任务、领域、输入、执行、轨迹、产物、基线、树验证和后置评分；[Substrate](https://github.com/google-research/harness2/blob/main/harness2/substrate/base.py) 负责可编辑表面、临时安装、执行、轨迹转换和调用模型前的 preflight。
- [实验说明](https://github.com/google-research/harness2/blob/main/docs/EXPERIMENTS.md) 明示默认网络不受限、Codex 沙箱关闭。不得照搬这些权限到财税环境；只读文档或通过上游 preflight 也不能证明本项目的数据隔离有效。

拟议优先在专用 Linux 研究环境中运行合成全栈。若采用 WSL、容器或独立主机，Windows 的 `127.0.0.1` 不应被假定为研究环境可达的同一个后端；Windows 路径、文件摘要、子进程、退出信号、stdio 和临时目录也须实测。不得为打通连接开放生产端口、挂载真实账套、读取主机凭据或放宽沙箱。

## 3. 启动选择与适用范围

共同拟议参数为 `--harness-improvement=off|harness2` 与 `--runtime-efficiency=off|sol-pi`，两个默认均为 `off`。它们是未来接口名称，当前不可作为可运行命令；现有无参数启动继续保持 baseline。另一份规划文件名为 `docs/SOL-PI-INTEGRATION.md`，两份设计须使用相同枚举和组合政策。

| harness-improvement | runtime-efficiency | 拟议行为 |
|---|---|---|
| `off` | `off` | baseline，沿用现有行为，不加载可选包 |
| `harness2` | `off` | 仅进入显式指定的合成、隔离研究环境 |
| `off` | `sol-pi` | 另一个实现 PR 完成 pi 兼容验收后才开放 |
| `harness2` | `sol-pi` | 第一阶段明确拒绝；组合单独验收后才可支持 |

未知参数值、缺少可选依赖、错误宿主、不支持的环境／组合，均须在启动业务进程和模型调用前明确失败。不得静默回落、自动下载、修改全局 pi／模型配置或把研究模式接到默认业务库。选择仅作用于当前显式启动；具体 launcher 接线另行实现和验收。

## 4. 可编辑表面与适配合同（均为拟议）

允许优化 Skill 组织、工具使用说明、资料解析与验证的指引、计划与恢复指引。解析器／校验器的新实现、缺失业务能力和计算修复须走正常代码 PR，不由优化器临时补写后直接发布。

禁止候选修改账套隔离、授权、幂等、锁、审计、备份恢复、人审门槛、账税公式或公共规则；也不得增加任意路径执行、网络外传、自动委派或自动批准权限。上游可编辑组件的范围不等于本项目授权范围，树验证须限制文件白名单并校验不可变边界，不能只检查格式。

| 拟议适配点 | 本项目合同 |
|---|---|
| `BenchmarkAdapter.tasks/domain_of` | 固定顺序的合成任务集；训练与 heldout 按企业、期间隔离，领域不能把企业明细混成公共经验 |
| `task_prompt/task_files` | 只交付已批准合成输入，不带期望答案、评分规则、生产目录或可还原真实企业的内容 |
| `execute` | `harness_dir=None` 为原始基线；每候选从同一合成快照初始化独立临时 DB、Harness／材料／复核 Store；`run_id` 重入不得再次产生业务写入 |
| `trajectory/deliverable_*` | 轨迹转换保留工具动作、错误、阻塞与人工动作；模型可见内容只来自合成环境的批准输出，不直通原始本机轨迹 |
| `base_harness/validate_tree` | 固定基线及哈希；校验候选文件白名单、链接、指引合同及禁止变更项，违规候选拒绝执行 |
| `score` | 仅作为独立评估接口；上游选择提交后才调用评分，并不等于本项目已有安全发布门槛 |
| `Substrate.surface/materialise` | 新增 pi 专属表面；每次临时安装到专用目录，输出源树指纹，不写用户 home 或全局插件配置 |
| `Substrate.execute/read_trajectory` | 显式绑定 pi、模型、provider、任务目录、MCP 和临时目标；定义退出、取消、超时与捕获格式，不能假定已有 OpenCode/Codex 适配可直接复用 |
| `Substrate.preflight` | 不调用模型；核对固定版本、可选依赖、允许目录、网络出口、合成目标身份、预算和组合；失败不启动后续链路 |

preflight 还须证明研究进程看不到生产 DB／Store／会话和税务凭据；只允许连接指定的合成后端与用户批准的模型服务。生产后端与研究进程的端口、实例、路径映射未证明时，停止该方案，不凭连接成功推断目标正确。凭据由操作者在研究环境独立配置，不复制他人的 token 或主机模型配置。

## 5. 采证与数据边界

真实业务采证留在可信本机界面，由操作者核查原件、原生账务结果与会计反馈。外层优化实验只接收批准的最小安全元数据与重新构造的合成样本；不得发送真实账套、凭证／发票明细、人员／企业身份、凭据、验证码、原始轨迹、原件路径或可回连本机原件的引用到外部模型、Git 或 PR。哈希不是匿名化证明，源文件哈希也不能默认外发。

最小采证拟限能力标识、故障层／错误码、合成用例标识、阻塞类别、人工动作类别、版本绑定、耗时与调用计数；需使用受控枚举，不直接收集自由文本错误、提示词或日志。来源和详细证据仅通过本机引用留存，经验外发前须核查是否包含企业特例。合成数据也须检查不能重建真实明细。

必须分别记录历史执行 `operationState`、当前适用 `resultCurrent`、当前确认 `confirmationCurrent`；`null` 表示暂不可核验，不能算成功或直接算业务失败。另保留 execution/review/rule 状态，不把“运行过”“结果当前”“会计确认”“公共规则发布”合并为一个完成标记。

[现有反馈合同](../06-workbench/server/accountant-review-feedback.mjs) 是结构化本机声明，不是身份认证；[Harness 反馈](../06-workbench/server/harness-store.mjs) 的版本约束也不赋予模型会计身份。候选、selector、评分器均不得伪造 reviewer、生成真实接受材料、自动会计批准或把 `public_candidate` 升级为公共规则。合成反馈必须标明测试用途，不得移植成真实授权。

企业经验只在本企业边界内适用；抽象成通用指引前须去除明细并经跨企业 heldout 和独立复核。经验库按实验版本／数据划分隔离，不共享企业原始记忆，不将 heldout、未来期间或评分答案反哺候选。

## 6. 实验与发布门槛

上游的无真值对比、自我选择和历史经验积累只产生候选，不能直接发布。评估须增加独立的业务门槛：用本机原生账务结果／回执与人工复核检查业务语义；合成期望由独立预期提供，放在执行器不可访问的位置。训练企业和期间之外的 heldout 不得进入优化上下文。

每次比较固定相同输入、起始快照、模型、provider、工具合同和预算；baseline 与候选各有独立临时库和全部相关 Store，不能让前一候选的写入、确认或经验污染后一候选。多次重启也不复用真实库。baseline 改变须按影响重验，不能继续沿用旧比较或旧会计确认。

业务门槛优先于效率指标：金额与原生账表／分录一致、账套期间隔离、不重复写入、审计与来源完整、历史与当前确认不混淆、人审与恢复约束不退化。指标同时报告资料完整性、未识别内容、缺件／冲突、人工动作与复核负担、失败／unknown／超时、重试、调用、耗时和实际 token／cost，不能只展示完成率或省 token。

运行 manifest 拟记录：

- 仓库与上游源码 commit、Skill 与候选树 hash、工具合同、pi／插件版本、依赖锁定和环境／路径／网络策略摘要。
- 合成输入及起始 DB／Store hash、任务划分与随机种子、独立期望版本、baseline 和候选身份、模型完整 ID／版本及 provider、实际参数。
- 全链路预算：单次与总超时、最大候选／调用／重试次数、token／金额上限、失败预算与停止条件；计数应包含 proposer、probe、selector、反思与评估。
- 实际调用、token、耗时、cost 与计量来源；未返回的值保留 `unknown`，估算另列假设，不能伪造账单或将未知记为零。实际用量无法测量时不得声称满足硬 token／成本上限，须按预先确认的停止策略退出。

禁止自动切换模型、provider 或服务以凑成功率；重试有上限，恢复不隐式追加无限预算。效率收益须连同质量、人工负担、失败率和未知用量报告。独立业务复核不通过即不发布，即使 selector 或后置 score 更优。

## 7. 失败、恢复与退出

运行前配置／隔离／预算检查失败即退出。运行中发生越界访问、不可验证目标、边界变更、预算耗尽、异常退出或取消，停止调度新候选，保留受控 manifest 和本机诊断；日志不得复制凭据与真实材料。未完成评估记未完成，`unknown` 不记零分或成功。

业务写结果 `unknown` 时先按原 operationId／意图执行 query，不换 ID 盲重试。重启后先核对目标、输入、代码和依赖版本；无法证明一致就保留阻塞。查询只证明历史时不能宣称当前恢复；历史拒绝走更正流程，不靠换候选或重启消除。

来源、代码、规则、依赖或基线改变后必须重新核验，旧确认留作历史。恢复必须遵循[既有恢复合同](../05-reconstruction/codex/skills/harness/references/recovery.md)，不得因原字节恢复就复活会计确认，也不得由实验脚本改写回执。

回退方式是停止研究进程、移除专用可选包／当前启动配置并使用默认 `off/off`。此接入不设计生产 DB 迁移；不删除业务原件、审计、回执、历史确认或备份。候选从研究环境进入日常使用须经单独代码 PR、独立审查，并遵守已确认的发布范围和授权，不原地覆盖已发布 Skill；实质扩大范围、引入新服务或真实业务，以及当次付费模型测试，按用户原有明确边界再沟通。

## 8. 分阶段验收方向与待确认取舍

先确认本文与 SOL-Pi 的范围、默认关闭及组合拒绝政策。实现阶段再以独立 PR 固定版本、落实 pi 适配与无模型 preflight，用合成临时目标验证配置拒绝、隔离、重启恢复和回退；之后才在用户批准的模型／数据／预算内开展受限 baseline 对比。最后经跨企业／期间 heldout、原生业务门槛与全新上下文的独立审查，决定是否发布候选。两个插件的组合另行验收，不由单项通过推导组合可用。

后续验证应覆盖 [Harness 生命周期测试](../06-workbench/test/harness-lifecycle.test.mjs)、[反馈失效测试](../06-workbench/test/accountant-review-feedback.test.mjs) 和实际 pi／MCP 端到端运行；现有测试源码说明应保留的边界，不代表此接入已经通过。实现 PR 记录实际命令、已审查版本、结果与未验证范围，脚本通过不能代替业务人审。

用户需确认的方案取舍：

1. 是否接受先采用专用 Linux 合成全栈、只做 pi 候选适配；Windows 联接方式在证明进程／路径／loopback 隔离后再决定。
2. 是否接受两个开关默认关闭、第一阶段拒绝组合，以及候选只经代码 PR 和独立业务门槛发布。
3. 首个合成业务范围、训练与跨企业／期间 heldout 划分；真实业务只本机采证，外部实验只用批准的安全元数据和合成输入。
4. 模型与 provider、递归模式、候选与失败预算、token／金额／超时上限、用量未知时的停止策略，以及谁在本机完成业务复核。

这些选择未确认前不进入安装、模型实验或接线实现；预算数值和可用性不由本文推定。
