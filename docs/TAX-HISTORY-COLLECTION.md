# 已申报历史固定查询取数子包

日期：2026-10-20。负责人：`huxiaoyang-code`。Refs #20 / #13 / #14 / #17。对应[任务单](tasks/TAX-HISTORY-COLLECTION.md)、[交接](handoffs/TAX-HISTORY-COLLECTION.md)和[月度链路](TAX-MONTHLY-DATA-CHAIN.md)。

本包实现并真实验证一个已观察申报查询的只读取回与私有结果账册，是 **M1 的受限查询子包**。完整 M1 的项目确认、稳定记录身份 / 版本与表单依赖仍未完成；M2–M5 仍待办。当前代码提交 `d0fdbce47b48164d67584c8cfa34abcdcd6c17d3`，基线 `ad09ccd9`；本包 PR 尚未创建 / 合并，不声明已进入 main。

## 已实现的固定契约

生产 collector 只重放实际捕获并通过验证的固定同源 `POST DescribeSbmxcx2` JSON 查询。请求 body 恰好为 `gzlx`、`pageNum`、`pageSize`、`sbrqq`、`sbrqz`、`skssqq`、`skssqz`、`zfbz`、`yzpzzlDm` 九键；不接受 query 参数、其他路径或模型提供的参数值。请求模板和首次捕获原值仅在本机受限存储。

响应须满足 `Response.Error === null`，`Data.PageNumber`、`PageSize` 须匹配捕获请求；`Total`、`List` 做合法性、页内计数及覆盖检查。响应内容是否与首遍捕获相等由 compare 单独报告，不作为请求匹配条件。私有投影逐行保留以下十三字段：`zsxmDmArray`、`nssbrq`、`skssqq`、`skssqz`、`ybtse`、`gzlxDm`、`gzlx`、`zfbz`、`zfrq`、`sbuuid`、`yzpzzlDm`、`yzpzzlMc`、`pzxh`。每个行实例及重复次数均保留，未知额外字段不进入投影。当前 schema 要求 `zsxmDmArray` 为 null、`ybtse` 为有限数值，其余为字符串；所属期起止为合法日期的严格零时格式且顺序正确。字段存在不证明其业务含义已核实，`sbuuid`、`pzxh` 或内容 hash 均未定义为稳定业务键。

每次采集执行 fresh 身份核验 → 固定历史业务查询 → fresh 身份核验；管理员 refresh 只执行前后两次 fresh 身份核验。通过原生 `fetch`、同源凭据、禁缓存、手动重定向和有界响应读取完成只读请求；不导航、不点击、不执行申报、更正、作废或缴款。

前后守卫核实际企业身份投影、专用注册、活动父 source、完整文档地址及其 digest、target / frame / loader、运行代次与 context 有效期。完整地址及动态值只在可信层核验，不进入模型 / Git。会话企业绑定成立不等于请求参数或响应字段已提供企业绑定证据：`parameterEnterpriseBound`、`responseEnterpriseBound` 仍为 false。

## 使用契约与存储

功能默认关闭，可信本机运行环境显式设置 `TAX_HISTORY_COLLECTION_ENABLED=1` 后启用。管理员脚本 [refresh-tax-history-context.mjs](../06-workbench/scripts/refresh-tax-history-context.mjs) 只接已核捕获的 `artifactRef`，生成独立 template / context，context 有效期 30 分钟。refresh 不注册为 Agent 或 MCP 工具；MCP 无法指定 artifact、路径、企业值、URL 或 body 来创建作用域。

| 入口 | 唯一允许输入 | 返回与限制 |
|---|---|---|
| 本机管理员 refresh | `artifactRef` | 固定摘要与随机 `contextRef`；2 次身份请求，不采业务行 |
| `tax_history_collect` | `contextRef` | 固定状态、计数、核验布尔值与随机 `runRef`；成功仍 `downstreamReady=false` |
| `tax_history_compare` | `leftRef`、`rightRef` | 两个不同 run 的安全比较摘要；须来自同 context / template，操作与请求证据独立 |

MCP collect / compare 经现有 stdio → HTTP → Agent → 生产 collector 接线；额外输入字段、非法引用与同一 run 自比被拒绝。引用不从原值派生，实际随机引用也不写 Git / PR。

template 保存不可变捕获契约，context 保存新鲜身份与重放文档范围，run 保存十三字段私有行投影及请求证明。生产 store 固定使用仓库忽略目录，拒绝任意目录重定向、软链接 / junction 别名、硬链接文件及 schema 篡改。创建目录限制为当前用户与 SYSTEM ACL；写入经暂存、同步、权限 / schema 复核后原子发布，发布或清理不能确认时不返回可用引用。超时 / 请求是否完成未知时保留锁并报告 unknown；不得将尝试数当成功发送数。

## 完整度和比较的准确含义

本包只请求捕获的单页，不猜页码、筛选参数或追溯年份。只有页号为 1 且返回总数等于该页行数时，`capturedQueryCoverageComplete=true`、状态为 `history_query_observed`；否则为 `history_query_partial`，`consumable=false`。前者只证明**固定捕获查询范围**内计数闭合，不能证明所有历史、项目需求或筛选语义完整。`consumable` 仅表示该受限查询账册可比较，不解除准备引擎阻断。

比较分别报告行顺序投影、保留重复次数的内容 multiset、分页元信息、期间 multiset。相等证明两次该投影一致，不证明稳定身份、更正关系或版本语义。门户旧六行 / 三期间与本查询六行 / 两期间属于不同集合，不能因行数相同合并。

`verificationTarget=completed_period`。`filingPeriodsVerified=true` 仅指十三字段内所属期格式与起止顺序校验通过；`periodVerified=false` 仍表示未确认目标业务月份，不能转成当前待办验证。

## 验证结果

代码验证锚为上述完整代码提交（11 文件；tree `9714bb0ac58dea9a41443b97c7dcda8cf97c11f6`）。管理者报告全量 `npm test` 28 / 28 套通过；history 合成 34 / 34 项通过，其中 30 项定向单元 / 合成测试，4 项经过真实 MCP stdio → 合成 HTTP → Agent → 生产 collector / store。合成 HTTP 不计为税局真实取数。独立代码审查已批准该准确代码 head 及真实运行权限；本包文档及最终 PR 仍须独立审查。

root 在用户明确登录完成后，从当前有效企业建立新 source 与 query capture，实际执行以下验证；实施者未读取真实原值或私有证据。

| 验证 | 实际结果 |
|---|---|
| 管理员 refresh | 2 fresh，performed 2，complete 2，unknown 0，无保留锁 |
| MCP 第一轮 collect | `history_query_observed`；3 fresh（身份前 / 历史业务 / 身份后），performed 3，complete 3，unknown 0，无保留锁 |
| MCP 第二轮 collect | 同上，独立请求及独立 run |
| 两轮各自查询范围 | rowCount 6、totalCount 6、pageCount 1、distinctPeriodCount 2，`capturedQueryCoverageComplete=true` |
| 每轮作用域 | `sessionEnterpriseBound`、`documentScopeVerified`、`identityProjectionMatched` 均 true |
| 首遍 capture / 各轮 | 行投影、内容 multiset、分页、期间 multiset 均相等 |
| run / run | `history_runs_compared`；`independentRequests`、`enterpriseEqual`、行投影 / 内容 multiset / 分页 / 期间 multiset 比较均 true |

真实运行后仍为 false：`allHistoryVerified`、`paginationSupported`、`requestFilterSemanticsVerified`、`recordIdentityVerified`、`versionSemanticsVerified`、`correctionRelationsVerified`、`parameterEnterpriseBound`、`responseEnterpriseBound`、`downstreamReady`、`obligationVerified`、`periodVerified`、`currentPendingPeriodVerified`、`projectionComplete`。单轮结果仍保守列 `real_two_run_verification` 未核项；两轮已验事实由独立 compare 与本安全交接佐证，不改写单轮结构。

## 单项目所需数据对照表：安全结构与当前技术状态

下表保留[月度链路规定的全部栏目](TAX-MONTHLY-DATA-CHAIN.md)。当前仅能交付已观察查询的技术状态；具体项目确认、账套关联、表单版本及字段需求待核，不能称已形成完整单项目需求。真实行、项目值、日期和本机资料引用只留可信层，表内不填企业实例，也不按税种名称猜资料。

| 项目及企业 / 账套归属 | 表单 / 模板版本及依据 | 字段或资料类别 | 本期发生 / 累计 / 结转 / 比较口径与用途 | 所需历史窗口 | 税局已观察入口及技术证据 | 本机已有来源 | 获取状态 | 缺口归属 | 负责人及阻断 |
|---|---|---|---|---|---|---|---|---|---|
| 当前会话企业已绑定；具体项目确认 / 账套关联待核 | 未核实际表单及适用版本 | 十三字段历史查询行实例；不代表表内字段 | 查询行的具体业务用途待核，不能当本期发生额或累计起点 | 捕获固定查询范围；需求窗口与筛选语义未核 | 固定 POST `DescribeSbmxcx2`；九键 body / 十三字段契约、两轮 fresh 与 compare 通过 | 私有 capture / template / context / run 已保存；账套 / 既有文件核对未实施 | 固定范围单页 6 行闭合；全历史未证实 | 内部技术 / 业务待核 | `huxiaoyang-code`：核项目、稳定身份 / 版本、窗口与字段依赖；阻断下游准备 |
| 与同一项目 / 期间关联方式待核 | 官方详情 / 表单版本待核 | 详情、原始表单、附件、回执 | 用途与字段依赖待核 | 必要往期由实际表字段决定 | 未核详情 / 下载契约，不猜入口 | 既有文件是否可用待本机核对 | 未实现 / 未验证；不能记官网不提供 | M2 内部技术待办 | `huxiaoyang-code`：有效入口 / 文件支持实证后取回；阻断资料完整性 |
| 依赖已核项目、账套与表字段 | 表版本依赖未核 | 本地账务资料与需补资料 | 本期、期初 / 结转、累计、比较分别待核 | requested / covered 窗口待核 | 当前查询不能证明其他资料缺失 | 本机已有资料未完成核对 | preparation 桥接未实现 | M3 / M4 内部技术待办；暂无经证实企业补充项 | `huxiaoyang-code`：核必要性与现有资料；阻断完整缺口清单 |

项目确认、表版本、字段依赖、稳定版本尚未核，均进入内部待办。只有**网站有效范围查询证实缺失 / 不提供 + 本机既有来源不足 + 业务字段必需**三项证据齐全，才生成企业补充。技术失败、未实现和 unknown 不生成企业补充；目前不能据本子包要求企业补资料。

## 后续与历史隔离

继续核 M1 的项目 / 期间、稳定身份 / 版本 / 更正语义及字段依赖，同时可沿已观察资产和列表行消费者开展 M2 详情来源发现；详情证据也可反向补项目 / 版本。稳定身份 / 版本研究全部完成不是入口发现的硬前置；真正消费或合并详情时须具备必要企业、期间、项目与版本绑定，未核继续阻断，不猜接口、不自动点击，原值留本机。M3 桥接私有证据到 acquisition / preparation 并分流缺口，M4 确认适用事项与工作月计划，M5 扩项目 / 连续期间。当前没有详情、表单原件、下载或回执，也没有 preparation 接线。

PR #35 仍为独立 Draft、未合并；已追加旧链 `target_absent` 退役提交 `ebd018c2ce7b0f9abb18ecd236d07def10cadc98`，不把其企业三 API 宣称为已复采。本机旧链已按 target_absent 审计退役，旧结果永久禁用，server 侧请求是否终止仍 unknown；owner / browser 未关闭、未重启。这是 root 报告的本机恢复事实，退役实现不属于本代码包，不构成本包实现依赖。不要恢复旧结果或以清锁代替安全核验。
