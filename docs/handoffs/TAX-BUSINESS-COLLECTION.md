# TAX-BUSINESS-COLLECTION · 当前交接

日期：2026-10-20。负责人：`huxiaoyang-code`。分支 `codex/huxiaoyang-code/tax-query-data`。必读：[任务](../tasks/TAX-BUSINESS-COLLECTION.md)、[契约](../TAX-COLLECTION-CONTRACT.md)、[章程](../PROJECT-CHARTER.md)。已合并基线 [PR #34](https://github.com/huxiaoyang-code/youshu-fork/pull/34) merge `1c12f98bafc38d257482f35f268e7f14d2dbd156`，head `3e16b3a48aaa12b8fa39b6f7d277e9a88d555c10`；本包当前代码 HEAD `c820b7778c903b3a9dac57f31a93545efa3c7564`（tree `39e78e5115b529da17741ff9dc343b27db23f12e`），未预填自身 PR / merge。

## 当前代码与实际阻塞

两个企业绑定 enum 已准确实现为 `literal_parameter` / `current_session`，空 query 增量验证、capture → run / run → run 投影覆盖比较已有代码。恢复 / guard 七文件及末两文件 surface 修复已独审；root 最终受影响 121 项（query 72 + retire 44 + MCP 5）通过，root 最终完整 npm test 29 / 29 套 exit 0（同一 c820 版本、无代码 delta）；最终独立 delta 44 项及先前 query 72 / MCP 5 通过；这些是代码验证，不是企业资料 MCP 实采成功。

query_context_refresh 退役实际 execute scope 校验失败：retirementCommitted true，lockRetired / realmDestructionProven / cleanupConfirmed false，resumeRequired true，prepare + commit 已存在。旧链已永久不可消费，锁未退休、没有 realm / finish 通过证据。新 source / context / run 均未建，三企业业务 / MCP 成功仍为 0。原标签已跳统一认证域，具体页面 / 是否需重新登录待用户确认；已异步请用户在现有窗口进入目标企业首页并告知 root。owner / browser 保留，不盲重启、不手删锁、不复用旧链或消费迟到结果。

| 真实阶段 | 已发生事实 | 覆盖与限制 |
|---|---|---|
| 早期参数预检 | 两 POST 捕获 djxh 空而 helper 非空，0 请求安全停止 | 已通过两模式实现 / 增量验证解决，不是当前锁原因 |
| 第一次 refresh | identity phase query_shape_invalid；attempted / performed / complete 各 1、unknown 0，无保留锁 | 未到 helper / 三业务 / context 发布；不是企业资料实采成功 |
| 第二次 refresh | 只增加同一身份响应的安全结构诊断；attempted 1，timeout / cleanup_unconfirmed，响应未确认，无 diagnosticAvailable 结果 | performed 0 不等于未发送；保留专用锁，host 已死且 quarantine，没有新 context / run |

不能从超时、身份响应形状失败、dead-host 或缺诊断断言登录过期、企业变化或请求终止。当前锁与下述门户 / 查询页捕获时的“无锁”属于不同运行阶段。

## 已有业务观察与边界

PR #34 门户期间 / 企业字段修复已合并，root 完整 26 套、独立原 54 + 增量 45 项通过。门户最终 MCP 两轮各 3 fresh / 3 complete / 6 行，企业 6 字段齐全、validPair 6 / distinctPeriodCount 3，source / run 与 run / run 投影和期间对 / 多重集相等，当时无锁。门户六行全部已申报，filingPeriodsVerified true 不能当当前待办；periodVerified / currentPendingPeriodVerified / businessScopeVerified / projectionComplete 仍 false，提醒失败不能当空集合，更正 / 作废 / 财报报送入口仍封锁。

企业资料实际捕获三个 API：GET DescribeNsrjbxx、POST DescribeNsrxxJcxx、POST DescribeQysdshdxx（完整 pathname / query / schema 见契约），均 Error null / Data 对象；income 该页 List 0 不推无义务。企业资料 document 为 `/szzh/zhcx/nsrxxcx`；中间出现的 `/szzh/zhcx/sbxx` 是另页 scope，不能等价成企业资料或真正申报查询页。

申报查询首遍正常导航和本机 90 项合成 / 独审批准诊断已完成：实际 document `/szzh/zhcx/sbxx/sbxxcx` 单 ruuid、无 hash，前后 3 个 identity 同企业，当时无锁。实际 POST `/szc/szzh/sjswszzh/zhcx/v1/DescribeSbmxcx2` 无 query / JSON body 9 个固定一级键；Error null、PageNumber 1 / PageSize 10 / Total 6 / List 6，13 个行字段齐全，validPair 6 / 起止 Midnight 各 6 / distinctPeriodCount 2，与门户六行 / 三期间的期间对及多重集均不等。仅 observed_request + schema，不能因都是六行当同集合；业务语义、当前待办、后端接入与 MCP 复采未验。不猜 gzlx / zfbz 意义，所有新 JS quarantine、safeAssetRefs []。

## 绑定语义与后续复采

企业资料两 POST 的原捕获 djxh 为空，捕获 helper 私有 djxh 非空，nsrsbh / shxydm 对 parent 企业匹配。保留原 query 顺序 / 值及 null body，不向空 query 填 helper 值，不改 t / page 参数。literal_parameter 继续 literal 匹配；current_session 以捕获 helper 的私有非空 djxh 和已确认四企业字段为基准，在 refresh / 前后 fresh helper 重复核验，两个 profile 自身 code / name 匹配。current_session 的 income 只能在守卫通过后 sessionEnterpriseBound true，parameterEnterpriseBound / responseEnterpriseBound / obligationVerified 均 false；尚无成功实采结果。

待现有 prepare + commit 明确 resume / finish、锁退休及实际恢复后，才继续独立 immutable context、capture / replay document 分离、不导航 / 不升级旧 portal source，以及项目 MCP 两轮 collect（每轮计划 7 fresh：三业务 + 前后 identity / getUserMsg 守卫 4）。比较代码已实现不等于真实投影相等或覆盖成功。报税选择字段只补行业、登记状态、增值税企业类型、会计制度、税务机关等已确认资料和具体事项缺口；人员、登录操作人、银行账号默认排除，除非明确报税需要，不无界恢复完整 profile / full business。

## 实际退役状态与下一步 resume

恢复 / guard 七文件和末两文件 surface 修复均已独审。root 实际 diagnose 确认 ownerDead / exactScope / cleanup true；它只是执行前诊断。实际 execute scope 校验失败，永久 retirementCommitted true、lockRetired / realmDestructionProven / cleanupConfirmed false、resumeRequired true，prepare + commit 已存在。旧链永久不可消费；尚无 realm / finish 通过证据，不能删除事务、另建 prepare / commit 或越过锁。

一次固定 loginb 正常导航出现多次 mainframe / clear / detach / within_document，未按成功处理，失败事件不追认为销毁证明。随后只读 inventory 只证明原标签已跳统一认证域：tpass_login 分类覆盖整个认证域，routeCode unknown；更窄诊断 knownOAuthPath / 已知尾 slash 路径均 false，fragmentPresent true、queryKeyCount 0、titleIndicatesLogin false。具体页面 / 是否需重新登录待用户确认，不推测 session 清除原因。已异步请用户在现有窗口进入目标企业首页并告知 root，此后未新增 fetch / 导航。

用户确认完成后，root 先只读确认精确已知 portal 与稳定 scope，再按**同一 prepare + commit 显式 resume**，用新一次已授权正常导航获取旧 realm 销毁及 cleanup / finish 证据；旧失败事件不可补记，redirect / hash / scope 守卫不放宽。unknown_abandoned / late session effects possible 始终保留；永久 commit、诊断 cleanup true、dead-owner 或未来清锁都不等于服务端请求终止。恢复和 finish 仍待验，owner / browser 不盲重启，旧链迟到结果永久不消费。

## 草稿交付与运行版本

等待用户输入期间准备当前代码 + 真实失败状态的草稿 PR，不 ready、不 merge，不宣告本轮已交付或专项完成。新版专用退役实际运行是独立本机 admin；现有纯采集 backend 未因磁盘 commit 自动重载，当前未重启，browser owner 保留。恢复无锁且精确 portal / scope 稳定后，实际 MCP 复采前只把纯采集 backend 更新到经审版本，绝不重启 browser owner；更新及实采均未预填成功。

root 独占真实会话与 Git；本轮文档 owner 仅现有六文档，不改代码 / ignored 诊断 / 旧任务 / 全局 Skill。用户授权 Codex subagent 实施，最终 reviewer 不参与实施、不继承实施上下文。恢复只由 root 本机查 worktree ignored checkpoint；实施者不读真实 CP / manifest / raw / evidence / 隔离 JS。真实 refs、nonce、PID、端口、URL / query 值、身份 / 业务原值和凭据不进模型 / Git / PR，安全 refs 也不入 Git。自动点击永久禁止，业务写及副作用不明操作禁止；专项未完成。
