# 工具与 A→B 交接

本技能可单独安装，但业务查询/计算/写入依赖同事自己的 taxes-agent 本机工作台与 finance MCP。不要把参考文件存在视为服务已连接。优先读取 MCP 静态工具合同和 `skills_list` / `skills_read`；没有 MCP 时，从操作者明确的 `repoRoot` 阅读 README、docs/CODE-INDEX 和相关源码/测试。不要猜本机路径、数据库、账套或服务端口。

## 按任务发现

| 目标 | 已有入口与使用限制 |
|---|---|
| 查使用说明 | `skills_read` 读取 `legacy-book-import/SKILL.md`、`harness/SKILL.md` 和其按需引用；这些是静态说明，不含客户原文 |
| 查数据能力 | `finance_query_catalog`，再用所选 `finance_query` 的实际 nodeId/合同；核对显式 accountSetId/period |
| 找 B 能力 | `harness_discover` 先目录，按 query/domain 或 capabilityId 取具体合同，不凭历史清单编参数 |
| 核对现有目标 | `harness_scope_discover` 读取明确现库；本机核实 enterpriseKey/accountSetId/databaseInstanceId，不能默认首个账套 |
| 登记来源、事实、补件 | `harness_source_register`、`harness_facts_register`、`harness_request_materials`；按实际合同，缺项/冲突不登记为 provided，补件只生成本机文本 |
| 执行、恢复、复核 | `harness_plan`、`harness_run`、`harness_status`、`harness_feedback`；具体阶段、恢复与版本以合同和当前回执为准 |

以上是能力导航，不是对真实数据直接调用的许可。先按主技能的数据边界检查该调用：普通财务工具有模型投影信封，业务原文由 `localRef` 留本机；Harness 来源、事实、任务和回执路径并非统一脱敏通道。完整回执/原文不能回传模型，含真实字段的请求也不能在模型上下文拼装。缺安全适配时由本机可信界面处理，Codex记录允许的状态/引用和剩余缺口。

## 迁入和更正

正常历史迁入优先 `book_import_incremental`，按实际合同使用企业/profile、稳定 `source.system` / `source.enterpriseKey`、`batchId` 和来源凭证身份。首次 create；已有同企业账套 append，并绑定真实 accountSetId。不先建空账再 create，同企业不能另造第二本正式账套。

先 `dryRun:true`，核对业务事实、覆盖和预检；按当前任务授权及要求的真实复核显式 `dryRun:false`。`book_import_batch` 查询原批次追踪并在本机核对目标、期初、凭证和账表。结果未知先查原身份，不换 batchId 盲重跑；输入变化遵守冲突/更正合同，不复用旧批次覆盖。兼容 `legacy_book_import` 不具备此增量批次恢复语义。

只有导入合同和实际证据支持的字段才进入正式账务；调查报告不是账套 payload。凭证、期初、库存成本、税务结转等相关验证未完成时保留依赖阻塞。禁止绕过受控入口直接 SQL 修改、删凭证历史或解锁封账。

## 交接与后续管理

在本机基线中关联：

- 正式 SQLite 账库、企业/账套/实例、接管截止日和下一期间，以及实际账务版本；
- 原件、转换代码/结果、核验和调查底稿，定位到文件版本及页表行字段；
- Harness Store 的 scope、来源/事实、任务依赖、执行回执和实际复核版本。

三类资产分别保存和备份，记录关联版本与恢复位置；数据库备份不自动包含外部原件和 Store。每家企业目录与账套隔离，同事从 GitHub 获取技能代码，各自配置本人凭据；不从仓库同步真实账库、token、验证码或会话。

已有账套核实后才 `harness_init` 绑定支持期间；已存在 Store 先检查恢复，不重复初始化。新任务使用实际 requestFactId 与完整 factIds，保留当前 valueDigest/factVersion；补件更新事实后，读取失效/阻塞、重绑受影响依赖再重算。`harness_plan` 替换完整 DAG，不能丢掉仍需保留的任务。人审绑定当前任务版本；可按真实人类的明确反馈如实登记，不能伪造人审或用 Agent 自评替代接受。

B 的分析入口是 `analysis.comprehensive`，实际合同见 `harness/references/analysis.md`；目前是月度 CNY、有限规划范围。调查、税费方案或现金底稿可以本机引用交接，但没有通用顾问报告写入/展示接口；不把它们硬塞进 analysis-context 字段。完成、复核、已申报及已缴款分别以真实回执证明。

发现历史问题后沿 [疑点复核](investigation.md) 回流。来源/规则/账务变化使旧结果和旧确认失效；不会因撤回新文件而自动复活。只能放行不依赖缺口的任务。目前没有统一接管包自动验收工具，不能以本技能报告宣布整企接管完成。
