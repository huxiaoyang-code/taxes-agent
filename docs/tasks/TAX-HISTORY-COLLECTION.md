# TAX-HISTORY-COLLECTION · M1 固定历史查询子包

日期：2026-10-20。负责人：`huxiaoyang-code`。Refs #20 / #13 / #14 / #17，均不关闭。分支 `codex/huxiaoyang-code/tax-history-collection`，基线 `ad09ccd9`；代码提交 `d0fdbce47b48164d67584c8cfa34abcdcd6c17d3`。状态：代码、文档与两轮真实验证已通过，已独立审查并随 [PR #38](https://github.com/huxiaoyang-code/youshu-fork/pull/38) 合并；不标完整 M1 完成。

必读：[章程](../PROJECT-CHARTER.md)、[STATE](../handoffs/STATE.md)、[本包使用契约](../TAX-HISTORY-COLLECTION.md)、[本包交接](../handoffs/TAX-HISTORY-COLLECTION.md)、[月度任务](TAX-MONTHLY-DATA-CHAIN.md)。

## 目标、范围和授权

将已观察的固定 `POST DescribeSbmxcx2` 九键 JSON 请求，接到现有 MCP → HTTP → Agent → 生产 collector，保留十三字段私有行实例和可比较的持久 run。仅固定捕获查询范围，不猜分页、筛选参数、稳定业务键、版本或详情接口，不执行任何业务写。

用户已明确登录完成，root 独占真实会话与私有原值。本专项有用户明确 Codex subagent 实施 / 独审授权，覆盖本专项 pi-only 旧限制，不推导为永久取消章程。实施 / 审查只用代码、合成材料和 root 安全摘要，不读取真实 checkpoint、evidence、profile、参数、随机引用或业务值；root 执行 Git / PR / 合并。自动点击仍禁用。

## 已实现与验收边界

- 管理员 refresh 非 MCP：两次 fresh 身份核验后生成不可变模板和 30 分钟 context；MCP collect / compare 只接 opaque refs，默认关闭。
- native fetch 固定只读请求，前后真实身份与完整文档 / 代次守卫，父 source 永久退役时停止；私有 ACL、固定忽略存储、原子发布及失败时不泄露引用。
- 响应业务成功 / schema / 分页匹配 / 所属期严格检查；完整保留十三字段行实例及重复次数。单页未覆盖总数时 partial，不自动翻页。
- 两轮独立请求比较行投影、内容 multiset、分页与期间 multiset；不把相等当稳定身份、版本或全历史已验证。
- `verificationTarget=completed_period`；义务、目标月份、当前待办、完整投影及 preparation readiness 保持 false。

代码范围为 `06-workbench/server/tax-history-{contract,store,collection}.mjs`、管理员 refresh 脚本、Agent 与现有 MCP backend / tax-tools 接线、test-all 接线及合成测试 / fixture；实际 11 文件清单以代码提交为准。交付文档为本任务、主文档和交接，加月度 / STATE / NEXT / 看板顶部当前入口；不覆写历史原文。

## 验证记录与完成门槛

管理者已核代码 tree `9714bb0ac58dea9a41443b97c7dcda8cf97c11f6`，全量 `npm test` 28 / 28 套通过，history 合成 34 / 34（30 定向 + 4 实际 stdio → 合成 HTTP → Agent → 生产 collector / store）通过，独立代码审查批准准确 head 与真实运行权限。详细命令和真实安全结果见[交接](../handoffs/TAX-HISTORY-COLLECTION.md)。

root 已在新有效 source / query capture 上实际完成 refresh 2 / 2、MCP 两轮各 3 fresh / 3 complete / unknown 0 / 无保留锁；各轮 6 行 / 总数 6 / 单页 / 2 期间，捕获范围闭合，capture / run 及 run / run 四项比较均相等。上述结果只验固定查询子包。完整安全资料对照表及仍 false 的标志见[使用契约](../TAX-HISTORY-COLLECTION.md)。

收尾事实：文档链接、diff / 敏感信息检查与最终文档 / PR 正文独审通过，管理者按准确 head 完成 [PR #38](https://github.com/huxiaoyang-code/youshu-fork/pull/38) 合并，并核对签名 merge / tree 与已审一致。准确提交、时间见[交接](../handoffs/TAX-HISTORY-COLLECTION.md)；本次仅补录 PR #38 合并事实，交接 PR 状态以 GitHub 为准。

## 未完成任务

| 工作项 | 状态与负责人 | 阻断 |
|---|---|---|
| M1 项目确认、账套归属与目标期间 | 待核，`huxiaoyang-code` | 查询所属期格式正确不足以证明目标业务月份 |
| M1 稳定记录身份 / 版本 / 更正关系及筛选语义 | 待核，`huxiaoyang-code`；不猜 id / hash 语义 | 不能跨集合去重或声称全历史 |
| M1 单项目表版本、字段依赖与必要历史窗口 | 待核，`huxiaoyang-code`；主文档已交安全结构 / 技术状态 | 需求完整度及下游 readiness 仍 false |
| M2 详情、原始表单、官网确有文件 / 回执 | 待实施 / 验证，`huxiaoyang-code` | 未观察契约不猜；本机派生文件不能替原件 |
| M2a 入口候选静态追踪 | 待实施，`huxiaoyang-code`：沿当前实际资产、路由消费者和列表行消费者本机追踪；静态函数仅候选，不能直接执行 | 当前十三字段无详情 URL / 文件字段；若仅按钮处理器且需人工交互，记技术待核，不称官网不支持 |
| M3 私有证据桥接准备引擎及缺口分流 | 待实施，`huxiaoyang-code` | 当前没有 preparation 接线，不生成企业补充 |
| M4 适用事项与工作月计划；M5 扩项目 / 连续期间 | 待实施 / 验收，`huxiaoyang-code` | 单查询成功不推全量义务、全国或连续期间完成 |

企业补充须有效网站缺失 / 不提供、本机来源不足、字段业务必需三证齐全；未知和技术缺口留内部待办。PR #35 独立 Draft 保留，不把企业三 API 及其旧链退役实现整包并入本任务。

M3 接线须另核 acquisition 的 Map、`identityMatched=false`、`fields=[]` 及 gateway metadata only 边界；history 摘要不能当 preparation success，泛用 `source:user_material` 也不能直接生成企业补充清单。

root 已完成本机静态安全索引，存在详情 / 下载相关路由、列表消费者与 marker 候选；未核 body、关联关系、只读或下载业务证据，详情 / 下载 contract 仍 false，新增请求 0。候选可作为 M2a 起点，不是可调用或官网支持证明。
