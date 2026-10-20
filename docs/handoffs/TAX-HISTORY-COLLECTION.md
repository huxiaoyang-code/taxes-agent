# TAX-HISTORY-COLLECTION · 交接与下一任务入口

日期：2026-10-20。负责人：`huxiaoyang-code`。Refs #20 / #13 / #14 / #17，均保留。先读[章程](../PROJECT-CHARTER.md)、[STATE](STATE.md)、[使用契约与安全资料对照表](../TAX-HISTORY-COLLECTION.md)、[任务单](../tasks/TAX-HISTORY-COLLECTION.md)、[月度链路](../TAX-MONTHLY-DATA-CHAIN.md)。

## 当前可恢复事实

用户本期已报且已明确登录完成。root 已从当前有效企业建立新 source / query capture，固定历史查询生产链已验两轮。此为 **M1 受限查询子包**，完整 M1 的项目确认、稳定身份 / 版本、字段依赖仍待核，M2–M5 仍待办；没有详情、原始表单 / 下载 / 回执和 preparation 接线。

分支 `codex/huxiaoyang-code/tax-history-collection`，起点 `ad09ccd9`。代码提交 `d0fdbce47b48164d67584c8cfa34abcdcd6c17d3`，11 文件，tree `9714bb0ac58dea9a41443b97c7dcda8cf97c11f6`。本包已独立审查并随 [PR #38](https://github.com/huxiaoyang-code/youshu-fork/pull/38) 合并：最终 head `6d4caf0adbf7b9394057e12f5888dba872887dc9`，tree `2122e9cbb8a03f14fe9132309299524cd728a787`；merge `1628ca6a9055a5be696d8d550901a0aec59b36c5`，合并时间 UTC `2026-10-20T13:21:30Z`（北京时间 2026-10-20 21:21:30）。独立审查批准准确最终 head 与 PR 正文，管理者核对签名 merge / tree 与已审一致并导入本隔离工作区，主工作区未改。当前交接分支 `codex/huxiaoyang-code/tax-history-handoff` 基于该 merge，本次仅补录 PR #38 合并事实，交接 PR 状态以 GitHub 为准。

实现为固定 `POST DescribeSbmxcx2` 九键 body / 十三行字段白名单，native fetch 只读，fresh 身份前后核验、完整文档与代次守卫、固定私有 ACL store 和原子持久化。管理员 refresh 不注册 MCP；MCP `tax_history_collect` 只接 contextRef，`tax_history_compare` 只接两个 runRef。功能默认关，可信运行环境显式开启；原值、运行参数和实际随机引用不入模型 / Git / PR。使用、失败和完整度语义见主文档。

## 代码验证与真实摘要

以下为管理者在准确代码 head 上报告的验证，不由文档实施者读取私有材料推断：

| 工作目录（仓库相对） | 命令 / 通道 | 结果 |
|---|---|---|
| `06-workbench` | `node test/tax-history-collection.test.mjs` | 30 / 30 定向合成项通过 |
| `05-reconstruction/codex/mcp/finance-mcp` | `node tax-history-test.mjs` | 4 / 4，通过实际 stdio → 合成 HTTP → Agent → 生产 collector / store；不计税局真实请求 |
| `06-workbench` | `npm test` | 28 / 28 套通过 |
| 独立代码审查 | 上述完整代码 head / tree，真实运行权限 | 已批准；独立于实施，不冒充 GitHub 第二账号批准 |
| root 实际管理员 refresh | 当前已登录企业的新 source / query capture | 2 fresh / performed 2 / complete 2 / unknown 0 / lockRetained false |
| root 实际既有 MCP，两轮 | stdio → HTTP → Agent → 生产 collector | 每轮 `history_query_observed`；身份前 / 业务 / 身份后共 3 fresh，performed 3 / complete 3 / unknown 0 / lockRetained false |

每轮 rowCount 6、totalCount 6、pageCount 1、distinctPeriodCount 2，`capturedQueryCoverageComplete=true`。每轮 `sessionEnterpriseBound`、`documentScopeVerified`、`identityProjectionMatched` true；与首遍 capture 的行投影、内容 multiset、分页、期间 multiset 均相等。run / run 状态 `history_runs_compared`，`independentRequests`、`enterpriseEqual` 及四项比较均 true。

仍 false：`allHistoryVerified`、`paginationSupported`、`requestFilterSemanticsVerified`、`recordIdentityVerified`、`versionSemanticsVerified`、`correctionRelationsVerified`、`parameterEnterpriseBound`、`responseEnterpriseBound`、`downstreamReady`、`obligationVerified`、`periodVerified`、`currentPendingPeriodVerified`、`projectionComplete`。`filingPeriodsVerified=true` 只验证行内所属期格式 / 顺序；`verificationTarget=completed_period`，未确认目标业务月份。受限单页计数闭合不证明全历史或完整资料需求。

门户旧 6 行 / 3 期间与新查询 6 行 / 2 期间不能混为一套。未知稳定键、版本、更正关系和筛选含义继续保留 unknown，不由行数相等或 content hash 定义业务身份。

## 本机会话与独立 Draft 边界

root 独占真实会话。owner / browser 未关闭、未重启；旧链已按 `target_absent` 本机审计退役，旧结果永久禁用，server 侧请求是否终止仍 unknown。该退役实现位于独立 [PR #35](https://github.com/huxiaoyang-code/youshu-fork/pull/35) 的提交 `ebd018c2ce7b0f9abb18ecd236d07def10cadc98`，PR 仍 Draft 未合并；这里只记录恢复事实，本代码包不依赖或整包引入该实现。PR #35 企业三 API 未因此获得两轮成功复采证明。旧文档 head `379a413` 仅 PR #36 时点记录。

新上下文先由 root 本机核 Git / PR 与现存进程，不盲重启、不重复建 source、不恢复旧结果或清锁。真实 refs、业务值、完整地址 query、参数、凭据、端口 / PID 和本机私有路径不写版本文档。实施 / 审查不读取任何真实 checkpoint、profile、raw 或 evidence；仅 root 在本机可信层恢复。自动点击与副作用不明动作仍禁止。

## 下一步与收尾

本子包已随 [PR #38](https://github.com/huxiaoyang-code/youshu-fork/pull/38) 独审合并，本次仅补录 PR #38 合并事实，交接 PR 状态以 GitHub 为准。之后独立开任务核 M1 项目 / 账套 / 目标期间、稳定身份 / 版本与表单字段依赖，同时沿已观察资产和列表行消费者并行核 M2 详情来源，详情可反向补项目 / 版本证据；全部稳定身份 / 版本研究不是入口发现前置。真正消费或合并详情时须满足必要绑定，未核继续阻断。必要时同步准备 M3 合成接口，但未桥接前不得改 readiness。单项目安全对照表已在主文档保留全部栏目，实例原值只留可信层；需求未核不能说资料齐全。

M2a 已有 root 本机静态索引的详情 / 下载路由、列表消费者及 marker 候选，未核实际 body、关联、只读与下载证据，新增请求 0；沿当前实际资产与消费者继续追踪，静态函数不能直接执行。十三行投影不含详情 URL / 文件字段；如只能依赖按钮且需人工交互，记技术待核，不称官网不支持。

技术待办与企业补充严格分开：只有有效网站证实缺失 / 不提供、本机既有资料不足、具体表字段必需三项证据均有，才列企业补充。M2、M3、M4、M5 均待办，不因本次查询成功标完成。各完整部分验收 / PR 合并 / 交接后结束其实施会话，下一部分使用新会话，未完成证据和授权不丢失。

## 可复制的下一任务提示词

> 先读 docs/PROJECT-CHARTER.md、docs/handoffs/STATE.md、docs/TAX-HISTORY-COLLECTION.md、docs/tasks/TAX-HISTORY-COLLECTION.md、本交接和月度链路主 / 任务。核最新 main、已合并 PR38 与 PR35 Draft；PR38 merge为1628ca6a9055a5be696d8d550901a0aec59b36c5，代码d0fdbce仅代码验证锚，不把旧基线当最新已合并版本。用户已登录完成，root 已建新 source / query capture；固定 DescribeSbmxcx2 九键 / 十三字段查询经现有 MCP 两轮各3 fresh / 3complete，无unknown / 保留锁，各6行2期间、固定捕获范围闭合及比较一致。完整M1仍缺项目/账套/目标月份、稳定身份/版本/更正/筛选语义与实际表单字段依赖；核这些时可沿已观察资产和行消费者并行发现M2详情来源，详情可反向补项目/版本，全部稳定身份/版本研究不是入口发现前置；真正消费/合并详情须必要绑定，未核继续阻断，不猜分页/参数/接口。门户旧6行3期间不混新查询6行2期间。completed_period与当前待办分开，downstreamReady和完整度标志仍false，没有preparation接线。旧链target_absent已本机审计退役、结果永久禁用，server请求终止unknown，owner/browser保留；PR35退役代码是独立未合实现，不整包当依赖。root独占真实会话，实施/审查只用合成材料和安全摘要，不读真实私有材料，不点击、不业务写，原值/参数/随机refs/私有路径不进Git。单项目表按项目、表版本、字段资料、口径、历史窗口、税局入口证据、本机来源、状态、缺口、负责人阻断逐项核；未核列内部待办，企业补充须网站有效缺失+本机不足+业务必需三证。按当时有效实施授权推进，管理者独立审查、验证、Git/PR/合并与交接，不预写完成。
