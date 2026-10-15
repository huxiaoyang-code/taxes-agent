# 阶段状态

更新时间：2026-10-14（本机批量方向修订；追加 IMPORT-STRICT 两轮返工待复审）。恢复时先核对 Git、PR 和进程；本文件是交接索引，不是实时进程监控。新对话最小入口见 [NEXT-SESSION](NEXT-SESSION.md)。

## 方向（不可漂移）

- 本机**单用户**财税工作台，可对多个企业 / 账套做批量处理；**不做多租户 / SaaS / 租户权限平台 / 对外服务**。
- 保留账套数据隔离、操作日志 / 审计留痕、备份恢复、凭据安全等本机实际需要。
- 全国电子税务局仍是产品目标；当前真实接入数 0，预留接口不等于已接入。

## 已完成

| 部分 | 结果 | PR | main 合并提交（短 SHA） | 管理者验证 |
|---|---|---|---|---|
| BASE | 旧账导入、逆向证据和能力盘点形成共同基线 | [#1](https://github.com/huxiaoyang-code/youshu-fork/pull/1) | 1fd8cc6 | 原有 28 项测试、语法和差异检查 |
| MCP | 38 个工具入口，补齐账务接口与真实可用状态 | [#2](https://github.com/huxiaoyang-code/youshu-fork/pull/2) | e168b4a | 原有 28 + MCP 44 项 |
| CORE-A | 封账、期初保护与期间登记 | [#3](https://github.com/huxiaoyang-code/youshu-fork/pull/3) | 3873bf1 | 保护回归 23 + 原有 28 + MCP 44 项 |
| GOVERNANCE | 章程、协作入口和阶段重置交接机制 | [#4](https://github.com/huxiaoyang-code/youshu-fork/pull/4) | bb71a2c | 文档差异、链接与授权核对 |
| CORE-B | 明细报表、零利润/年末结转与折旧一致性 | [#5](https://github.com/huxiaoyang-code/youshu-fork/pull/5) | 91b623a | 派生 31 + 保护 23 + 原有 28 + MCP 44 项；见 [交接](CORE-B.md) |
| TAX | 全国税务接口、异步会话和地区目录，真实接入数 0 | [#6](https://github.com/huxiaoyang-code/youshu-fork/pull/6) | f4d9f82 | 税务 59 + MCP 44 + 原有 28；见 [交接](TAX.md) |
| FLOW | 记账/导入规则、MCP 闭环与统一测试入口 | [#7](https://github.com/huxiaoyang-code/youshu-fork/pull/7) | 03eba00 | 6 套 208 项全部通过；见 [交接](FLOW.md) |
| ACCEPT | 管理者 main 验收与交付文档 | [#8](https://github.com/huxiaoyang-code/youshu-fork/pull/8) | 9783420（PR #8 合并提交；业务验收提交 03eba00） | 在业务提交 `03eba00` 运行 npm test：208/208；技能格式验证通过 |

上表 PR #1–#8 各部分的员工会话在各自验收与合并后已结束（此为**历史阶段**事实，不代表全仓已无未提交的本地工作，见下文「未完成现场」）。后续部分采用全新会话，读取当前代码和任务包。

## 本期收尾与恢复

- 就上表第一阶段（PR #1–#8）而言，实现均已通过审查并合并，相关员工会话已结束；pi FLOW 与 Claude TAX 最后进程退出码均为 0。该结论**只限定上述历史阶段**，不覆盖下文「未完成现场」中未提交、未经管理者审查的本地实现。保留各 worktree 供追溯，不复用旧聊天。
- 管理者最终验证的 main 完整 SHA：`03eba00c4fefd065d30f021d19f17f02d48d5d65`。工作目录 `D:/有数云fork/06-workbench`，命令 `npm test`，6 套共 208 项通过、exit 0。PR #8 只同步文档和期间工具说明，不改业务算法。
- 本地复核日志 `.agent-runs/main-final-acceptance.log`；任务日志 `pi-flow-review.jsonl` / `claude-tax-review2.jsonl`。原始日志不作为新会话默认上下文。
- 实际工具目录 45 个入口：31 标 available（其中 7 个是税务预留接口）、1 个 limited、13 个 unavailable。入口数量不等于真实税务连接数。

上述临时任务包和日志被 Git 忽略，只在本机存在；跨机器恢复以 PR、源码和本文件中的阻塞说明为准。

## 未完成现场（未提交，待独立审查）

管理者现场发现一处既有未提交实现，**保留原地**、不重置 / 不删除 / 不覆盖 / 不重做，本轮也不把它纳入文档 PR：

- worktree：`D:/有数云fork/.worktrees/tax-browser`
- 分支 / 基线：`codex/tax-browser-import`，基线 main `9783420a84dae2fe8a4c4b3021c07947b66fec00`
- 状态：**未提交、未 PR、未合并**；内容为福建漳州浏览器登录后读取企业、批量新建或绑定账套的本地草稿，只覆盖该地区，**不能代表全国接入**
- 员工交接：`D:/有数云fork/.worktrees/tax-browser/docs/handoffs/TAX-BROWSER.md`
- 证据边界：员工交接**自报** 7 套 272 项通过、真实税局未验收；管理者**未独立复跑**该套件，**真实登录未验收**
- 进程日志：`D:/有数云fork/.agent-runs/pi-tax-browser.jsonl`；**尚未核实退出码，不能声称 exit 0**，也不要整读该日志

新会话派工前先核对上述现场，避免重复派工或误报已完成。`IMPORT-STRICT` 已实现并二次返工自测，列为**待管理者复审**（未合并）；`TAX-BROWSER` 列为**独立待审队列**（本段不重排既定顺序，也不虚构用户未做的排序决定）。

## 本轮 LOCAL-BATCH-HANDOFF（文档 / Skill，已核验）

本轮为纯文档 / Skill 变更：本机单用户批量方向、工作范式、权威技能 `team-skills/local-agent-first/` 以及 NEXT-SESSION / STATE 交接。**未改业务代码或算法，未重跑 208 项业务测试。**

- 已验证事实（管理者本机核对）：仓库权威技能已安装到本机 Codex 技能目录 `C:/Users/35007/.codex/skills/local-agent-first/`；本机两处文件 SHA256 与仓库副本一致；`quick_validate.py` 对仓库副本与全局版本均通过；新增 27 个本地 Markdown 链接检查通过；`git diff --check` 通过。安装前的原技能备份在 Git 忽略目录 `.agent-runs/local-agent-first-before-20261014-150009.md`。
- 本轮 pi 初稿 / 返工 / 最后修订 / 未完成现场补充、Claude 独立情境审查均已实际退出、退出码 0；本轮新进程退出码由管理者在该进程结束后核对。tax-browser 历史会话退出码仍**未核实**，不归于本轮。
- **PR 状态（已核实）**：LOCAL-BATCH-HANDOFF 已由管理者创建并合并为 PR [#9](https://github.com/huxiaoyang-code/youshu-fork/pull/9)，main 合并提交 `8279477ad3e49ef1e37cd965db3bb12d719674c9`（`docs: 固化本地执行工作范式与单机批量交接 (#9)`）。恢复时仍以分支、`git log`、远端与 PR 平台**实际状态**为准。
- 安装路径与全局技能校验均为**本机信息**，不承诺其他电脑已安装；换机器需按章程与交接重新核对授权与安装。

## 本轮 IMPORT-STRICT（导入严格校验，管理者首审不通过、二次返工自测完成待复审）

- worktree：`D:/有数云fork/.worktrees/import-strict`，分支 `codex/import-strict`，基线 main `8279477ad3e49ef1e37cd965db3bb12d719674c9`。
- 状态：**管理者首审不通过（7 项阻塞），员工两轮返工自测完成、待管理者复审**；**未提交、未 PR、未合并**；员工交接见 [IMPORT-STRICT](IMPORT-STRICT.md)。本段不预报复审通过。
- 内容：旧账导入严格校验——拒绝非法金额文本（垃圾/部分可解析/`NaN`/`Infinity`/超界/极小负值），负数与超界在舍入前判定；预检与正式写入共用 `normalizeImportPayload` 同一套约束，失败不落库；覆盖金额类型、日期逐行与不一致、凭证号、形状/meta 类型、重复期初、科目/期初/凭证会计约束；保留原始文本后再归一化，不再把非法输入按 0 吞掉。
- 返工要点：完整内容快照断言不污染既有账套；HTTP/Agent 真实入口非法 CSV/JSON 集成回归；共享 `sumMoney` 统一合计；重复期初预检拒绝；金额数组/对象/布尔拒绝；meta 对象不被 String 成垃圾写入；CSV 辅助字段 `dates`/`numberRaw` 不得绕过 `date`/`number`（各自严格类型与语法、两者一致），补 CSV parse→JSON 往返正例；测试用 `PORT=0` 从子进程 stdout 读取实际端口并等子进程退出后清理，避免端口碰撞误连真实后端。
- 员工二次返工自测（临时数据目录，员工报告，**管理者未独立复跑**）：`import-strict` 54 项；`npm test` 7 套 262/262（guards 23 + derived 31 + import-strict 54 + smoke 28 + contract 44 + workflow 23 + tax 59）、`npm run test:smoke` 28/28，均退出码 0；`git diff --check` 通过。
- 不改：幂等 / 批次去重（留给 IMPORT-IDEMPOTENCY）、批量队列、UI、税局适配、多租户。


## 后续可执行任务表（依赖顺序）

只明确第一个可派任务，其余保持接口开放，具体契约由管理者派工时写进任务单。任务状态以代码、可重复测试和联调证据为准，**不承诺未实现的批量能力**。

| 顺序 | 任务 ID | 目标 | 依赖 | 备注 |
|---|---|---|---|---|
| 1 | IMPORT-STRICT | 拒绝非法金额文本；预检与正式写入使用同一套约束，失败不落库 | 无（当前 main） | 管理者首审不通过、员工二次返工自测完成待复审（见 [IMPORT-STRICT](IMPORT-STRICT.md)）；**未合并** |
| 2 | IMPORT-IDEMPOTENCY | 重复导入同一批次不重复建账 / 过账，可安全重试 | IMPORT-STRICT | 需要批次标识 / 去重键 |
| 3 | BATCH-QUEUE | 本机持久任务队列与作业项：并发上限、同账套串行、跨账套允许并行、重启恢复、可取消未开始项、失败继续且只重试失败项、幂等、防重复过账，状态明确区分已成功 / 待处理 / 失败 / 取消 | IMPORT-IDEMPOTENCY | 本机单用户；不引入多租户 |
| 4 | BATCH-MANAGEMENT | 本机批量任务查询 / 状态 / 结果汇总与可操作错误、进度 / 日志 | BATCH-QUEUE | MCP 与本地 UI 是否分两 PR 可由管理者建议 |
| 5 | TAX 真实适配 | 逐地区接入真实电子税务局：凭据生命周期、人工验证、企业授权验证、会话回收 | 获授权的地区与联调资料 | 全国为长期目标；当前 0 接入，不能缩水为单省 |

并行说明：IMPORT-STRICT 与 TAX 前置资料准备互不依赖；BATCH-QUEUE 必须等导入幂等，否则重启重试会重复过账。派工前写清基线完整 SHA、文件所有权、接口契约、验收命令与数据边界。

## 恢复与会话

下一部分重新启动本地员工会话，仅传章程、STATE / NEXT-SESSION、相关交接、基线 SHA、文件范围和验收条件；不续用旧会话。每部分「验收 + PR 合并 + 交接」后关闭员工会话，下一部分用新进程、新会话（`--no-session` / `--no-session-persistence`，不使用 resume）。Codex 管理者当前对话不能由仓库强制清空，也无法声称已清空。

全国真实电子税务局适配尚未实现；当前无真实省份连接或登录承诺。现有运行后端和 Codex MCP 进程不会因 Git 合并自动重载，新代码验收使用临时进程。
