# Harness² 可选接入设计

用户已确认实施，并将范围扩为 Pi、Claude Code、ZCode、dsh。实现固定 Google Research `harness2` commit `1cfe254e8d25b15f37048c3730134686abe60335`，逐原始 Git blob SHA 校验；不复制或重写优化循环。Google 原生 `recursion`、`selection`、`reflect_adoption` 和 `Library` 保留，财税 `BenchmarkAdapter` / `Substrate` 只接执行与制品接口。以下设计边界继续有效；实际命令、审查版本和未验证范围以本轮 PR 为准。

## 实现与运行入口

- [harness2-run.mjs](../06-workbench/scripts/harness2-run.mjs)：`--host pi|claude-code|zcode|dsh`，`--harness-improvement off|harness2`、`--runtime-efficiency off|sol-pi` 默认 `off/off`，双启用拒绝。这个研究入口的 `off/off` 只返回选择结果；日常 baseline 仍用原来的宿主启动器。SoL-Pi 实际启动另见其独立入口。
- `--prepare --root <全新绝对目录>` 只创建合成企业、起始数据库与 Store 快照；没有读取默认业务库。`--probe --root ... --run-id ... --pi-root ...` 或其余宿主的 `--cli-path ...` 执行原生无模型探针。每次候选复制同一快照，持久化原 run ID；未知结果先 query，不能换 ID 盲重试。
- `--execution-mode synthetic-native` 仅用于固定的 Pi 原生 MCP → 财税 Harness `period.inspect` 合成任务。它确实读取原生账务结果、产生版本绑定回执，但采用确定性调用，不证明模型决策或效率改进。原生回执保留 `executed / resultCurrent / confirmationCurrent`，不生成会计接受。
- [harness2-google.py](../06-workbench/scripts/harness2-google.py) 在 Linux Python 3.12/3.13 下调用真实上游方法，支持 `agg/seq`。它要求显式 `--upstream --repo-stage --host-stage --node --work --canary`；`--execution-mode synthetic-native` 不调用模型，`model` 要求事先运行的唯一 `--gateway-socket` 及 `--budget-config`。
- [harness2-stage.mjs](../06-workbench/scripts/harness2-stage.mjs) 只打包明确源码和锁定工作台依赖，不带 `.git`、工作树、默认 data、用户 home 或会话。Linux 宿主依赖单独安装、锁定、暂存；不能将 Windows `.exe` 带入沙箱。

模型模式必须在真实 bwrap `--unshare-all` 中运行，代码与宿主依赖只读、仅独立 experiment 可写，无主机 home / Windows 挂载 / WSLInterop /公网路由。运行器实际执行外部合成 canary、环境和网络检查，不接受 `verified=true` 一类声明。只将预算网关的一只 Unix socket 映射到沙箱，网关配置和账本必须留在所有可见挂载之外。

网关只访问官方 DeepSeek 固定端点与 `deepseek-flash`。本轮明确预算：全部 proposer、candidate、selector、reflection 共享最多 36 次请求，每请求 JSON 65536 bytes、最多 2048 输出 token、总预留上限 USD 3、总时限 900000 ms、无服务切换。预留采用输入 USD 1 / 输出 USD 4 每百万 token 的保守上界，不是账单价格。JSON bytes 加有界协议开销作为输入 token 上界；限制纯文本消息、工具和 tool-call 数量。实际 usage 缺失、非法、越界或传输结果未知即停止；重启读取同一账本，不返还预留、不清零次数。凭据只在沙箱外网关进程环境中，子宿主使用占位 key。

上游此版本只内置 `claude_cli/opencode` improver channel；新宿主表面通过固定版本的提示片段数据注册，优化方法未更改。受控 `GatewayProposer` 只把已批准的合成证据文本交给同一网关，模型以 JSON 返回白名单 Markdown 制品，不启动上游不受限的 improver shell。候选可编辑文件仅 `SKILL.md`、`tools.md`、`recovery.md`，拒绝额外文件、链接、脚本和 hook。文件白名单不构成语义安全证明，仍需原生独立评估及代码审查。

Node 回归：在 `06-workbench` 运行 `node test/harness2-boundary.test.mjs`、`node test/harness2-budget.test.mjs`、`node test/harness2-hosts.test.mjs`。其中 fake-transport 预算回归不连接外部模型。Linux 真实核心：`python3.12 test/harness2-upstream.test.py --upstream <固定源码>`；追加 `--native-probe <已prepare的WSL目录> --pi-root <明确Windows包目录> --native-cycle` 可验证 WSL → Windows Node → Pi → 原生合成业务循环。生产模型实验应使用 Linux bwrap 入口，不能将这一跨系统探针当成模型文件隔离证明。

当前最小任务是合成企业 A 的 2026-01 期间检查，独立评估读取实际 Store 与 DB，只判断该任务原生执行、当前有效且确认未伪造。尚没有跨企业／期间 heldout 业务集；空 heldout 明确保留，不能报告泛化质量、整账完成、收益或自动发布。三家其他宿主的真实模型路径是否通过，必须逐家记录；探针或配置成功不能替代模型实验。

## 数据、权限和发布边界

本产品是本机单用户工作台，一名操作者处理多家企业、每企业独立账套。Google Harness²只优化使用指引；财税固定业务能力、公式、锁、审计、恢复、会计复核和公共规则仍由现有实现负责。宿主入口数量和模型声明不证明业务完成。

仅使用重新构造的合成输入和独立临时DB、Harness／材料／复核Store。同一候选从同一快照复制，不把前一候选写入或确认继承给后一候选。实验清单绑定上游blob、当前核心／宿主／业务代码、Node可执行文件、实际stage内容和基线指引。任一绑定变化就阻断旧实验，不继续沿用旧比较或旧确认。

研究MCP代理在后端强制唯一合成目标和Store，仅允许固定period.inspect任务的metadata和execute/query。拒绝会计feedback、写capability、其他数据库和跨Store依赖；不依赖提示词自我约束。模型只拿到这项任务的明确输入，不可访问真实账套、凭据、用户home或独立评估器。资料是数据，不执行来源中的指令。

候选只产出SKILL.md、tools.md、recovery.md，白名单并不证明文本安全。候选、selector和评估器均不能冒充会计批准，也不能把public_candidate发布成公共规则。发布仅通过代码PR和全新上下文独立审查，不自动覆盖用户全局Skill或宿主配置。

## 证据、失败与恢复

历史operationState、当前resultCurrent和当前confirmationCurrent分别保留；null/unknown不算成功或零分。宿主原始日志只在本机合成目录保存；优化上下文只接受受控状态、错误计数和合成制品。nativeStatus及innerErrorCount保留历史工具拒绝，即使后来结果执行成功也不抹除。独立评估重新读取实际Store与数据库；不向候选挂载assessor、期望或测试源。

超时、取消、异常退出或缺少交付物时，无法确定业务调用状态就记unknown。恢复先在原runId查询实际原生Store，不更换身份重复执行。停止新候选、终止当前受监督进程组／namespace并保留受控诊断。来源、代码、规则、依赖或基线改变需重新核验；原字节恢复不能恢复旧会计确认。

所有模型阶段共用一份沙箱外持久预算账本及单实例锁。重启核对同socket／模型／限额，未知usage不返还预算、不继续调用。methodCostKind=conservative_estimate与conservativeEstimatedUsd标明保守估算性质，actualBilledUsd未知保留null，不能把上游usd字段称为账单。

回退是停止研究进程并使用原有日常宿主启动器（off/off）。不迁移或删除生产库、原件、审计、回执、历史确认和备份。跨企业／期间heldout、模型质量或效率收益只有在真实独立证据出现后才能报告；当前单项期间检查不证明整账完成。

## 可复现验证

Node合同、预算假传输、真实研究MCP与三宿主进程合同测试登记在test-all.mjs。真实Google核心使用固定源码+Linux Python3.12/3.13单独运行，验证agg/seq、selection、reflection、Library，并回归匹配源mtime/size的伪造pyc攻击。缺失依赖、未知宿主、未支持组合和版本不符在模型前失败。

真实native探针、确定性native业务循环、受控模型循环和独立heldout是不同证据。当前命令、源码版本、exit code、预算结果和未验证范围记录在本轮PR；没有实际执行的项目不预填通过。Windows模型loopback试验若被系统沙箱或自动审批拒绝，应保留该限制并使用真正Linuxnamespace安全替代，不修改防火墙、loopback豁免或WSLInterop来绕过。
