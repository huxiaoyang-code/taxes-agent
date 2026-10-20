# TAX-BUSINESS-COLLECTION · 报税资料与当前待办核实

日期：2026-10-20。负责人：`huxiaoyang-code`。Refs #20 / #13 / #14 / #17，不关闭总任务。当前分支 `codex/huxiaoyang-code/tax-query-data`；已合并基线 [PR #34](https://github.com/huxiaoyang-code/youshu-fork/pull/34) merge `1c12f98bafc38d257482f35f268e7f14d2dbd156`、head `3e16b3a48aaa12b8fa39b6f7d277e9a88d555c10`。当前代码 HEAD `c820b7778c903b3a9dac57f31a93545efa3c7564`（tree `39e78e5115b529da17741ff9dc343b27db23f12e`）已实现两种绑定模式；恢复 / guard 七文件及末两文件 surface 修复已独审；root 最终受影响 121 项（query 72 + retire 44 + MCP 5）通过，root 最终完整 npm test 29 / 29 套 exit 0（同一 c820 版本、无代码 delta）；最终独立 delta 44 项及先前 query 72 / MCP 5 通过。实际退役已永久 commit，execute scope 校验失败，锁未退休、resumeRequired true；原标签已跳统一认证域，具体页面 / 是否需重新登录待用户确认；已异步请用户在现有窗口进入目标企业首页并告知 root。新 source / context / run 均未建，三企业业务 / MCP 成功仍为 0，总任务未完成。

必读：[章程](../PROJECT-CHARTER.md)、[STATE](../handoffs/STATE.md)、[采集契约](../TAX-COLLECTION-CONTRACT.md)、[本包交接](../handoffs/TAX-BUSINESS-COLLECTION.md)。历史退役语义查[前包交接](../handoffs/TAX-READONLY-ABANDON.md)，不能代替本次已 commit 但待 resume / finish 的专用退役，不恢复旧 source / 窗口引用。

## 目标与当前阻塞

在用户本机当前企业作用域中取得报税必要企业资料、当前待办及其所属期，再经项目 Agent / MCP → HTTP → 后端两轮实际请求并核对覆盖。按已确认事项补最小材料，不无界扩大“完整 profile / full business”，不先恢复全部旧探索。

当前 query_context_refresh 退役的 prepare + commit 已存在，retirementCommitted true，但 execute scope 校验失败，lockRetired / realmDestructionProven / cleanupConfirmed 均 false、resumeRequired true。旧链永久不可消费，当前锁未退休，也没有 realm / finish 通过证据。原标签已跳统一认证域，具体页面 / 是否需重新登录待用户确认；已异步请用户在现有窗口进入目标企业首页并告知 root，等待用户确认；不推测 session 清除原因，不盲重启 owner / browser，不放开 redirect / hash 守卫。

## 已完成证据及覆盖边界

- PR #34 门户期间 / 基础企业扩展已合并：root 完整 26 套、独立原 54 + 增量 45 项通过。门户最终 MCP 两轮各 3 fresh / 3 complete、各 6 行，6 个企业扩展字段齐全，validPair 6 / distinctPeriodCount 3；source / run 与 run / run 投影、期间对及多重集相等。当时无保留锁。
- 门户 6 行全部已申报，门户 `filingPeriodsVerified = true` 不代表当前待办。`periodVerified`、`currentPendingPeriodVerified`、`businessScopeVerified`、`projectionComplete` 仍 false。旧白名单漏保留 `skssqq` / `skssqz` / `skssqzqz`，旧 period missing 不是接口没返回；提醒失败不能当空集合，更正 / 作废 / 财报报送入口持续封锁。
- 企业资料页面实际观察了 `GET /szc/szzh/sjswszzh/sy/v1/DescribeNsrjbxx`、`POST /szc/szzh/sjswszzh/zhcx/nsrxx/v1/DescribeNsrxxJcxx`、`POST /szc/szzh/sjswszzh/zhcx/nsrxx/v1/DescribeQysdshdxx`，均 Error null / Data 对象。income 该页 List 0 不推无义务。42 项 ignored 只读诊断及独审、本机诊断不代替后端复采。
- 申报查询已正常导航、首遍被动捕获及 90 项合成 / 独审批准的本机诊断：`POST /szc/szzh/sjswszzh/zhcx/v1/DescribeSbmxcx2`，无 query，JSON body 为 9 个固定一级键（详见契约）；PageNumber 1 / PageSize 10 / Total 6 / List 6，13 个固定行字段齐全，validPair 6 / 起止 Midnight 各 6 / distinctPeriodCount 2。与门户六行 / 三个期间的期间对及多重集均不等，不能按相同行数合并记录。仅 observed_request + schema，业务语义 / 当前待办 / 新 source / active / 后端 MCP 复采未验，不猜 `gzlx` / `zfbz` 含义。

## 导航与企业绑定

已确认唯一菜单目标分别为 `/szc/szzh/sjswszzh/spHandler?cdlj=/szzh/zhcx/nsrxxcx` 和 `/szc/szzh/sjswszzh/spHandler?cdlj=/szzh/zhcx/sbxx/sbxxcx`。企业资料捕获 document 为 `/szzh/zhcx/nsrxxcx`，之后一度出现的 `/szzh/zhcx/sbxx` 是另页 scope；随后真正申报查询 document 已确认 `/szzh/zhcx/sbxx/sbxxcx`，单 `ruuid`、无 hash、前后 3 个 identity 同企业、当时无保留锁。`ruuid` 仅各自私有 full URL scope，不是 API 参数来源；query 值和页面引用不进文档。所有新 JS 均 quarantine，`safeAssetRefs = []`。

企业资料 fixed replay 保留 immutable 捕获 query 的原顺序 / 值及 null body。两 POST 的捕获 `djxh` 均为空形状，捕获 helper 的 `djxh` 非空且其 `nsrsbh` / `shxydm` 与 parent 企业匹配；不能把 helper 值填进空 query。实现准确 enum 为 `literal_parameter` / `current_session`：前者 literal 核对，后者以捕获 helper 私有非空 djxh 及已确认四企业字段为基准，在 refresh / 前后 fresh helper 重复核验，并核两个 profile 自身 code / name。income 的 current_session 模式不得称参数企业绑定：parameterEnterpriseBound false，守卫通过后才可 sessionEnterpriseBound true，responseEnterpriseBound / obligationVerified 均 false。此为已实现约束，尚无成功实采结果。

## 真实 refresh 结果与下一步

1. 两 POST 空 query 的早期 0 请求预检缺口已由两模式实现 / 增量验证解决，不是当前锁原因。随后第一次真实 refresh 在 identity phase `query_shape_invalid`，attempted / performed / complete 各 1、unknown 0、无保留锁；未到 helper、三个业务请求或 context 发布。
2. 第二次只为同一身份响应增加安全结构诊断，attempted 1，timeout / `cleanup_unconfirmed`，响应未确认、无 diagnosticAvailable 结果；performed 0 不能写成未发送。host 已死、quarantine、保留 `query_context_refresh` 专用锁，没有新 context / run 或企业资料 MCP 成功。
3. 恢复实现与 guard / surface 修复已独审；root 实际 diagnose 确认 ownerDead / exactScope / cleanup true，但 execute scope 校验失败，永久 retirementCommitted true、lockRetired / realmDestructionProven / cleanupConfirmed false、resumeRequired true，prepare + commit 已存在。一次固定 loginb 正常导航出现多次 mainframe / clear / detach / within_document，未按成功处理；随后只读确认原标签已跳统一认证域，具体页面 / 是否需重新登录待用户确认；已异步请用户在现有窗口进入目标企业首页并告知 root。诊断 cleanup true 不等于执行 cleanup 成功，失败事件不追认 realm / finish 证明。
4. 用户确认现有窗口已进入目标企业首页后，root 先只读确认精确已知 portal / 稳定 scope，再按同一 prepare + commit 显式 resume，以新一次授权正常导航取得 realm 销毁与 cleanup / finish 证据；不新开事务、不放松 redirect / hash 守卫。unknown_abandoned / late session effects possible 始终保留，旧链永久不消费。真实恢复后才继续新 immutable context 和三资源两轮复采（完整 collect 计划每轮 7 fresh：3 业务 + 前后 identity / getUserMsg 守卫 4）。capture → run / run → run 投影覆盖比较已有代码，未有真实复采结果。申报查询另核只读语义及后端接入，当前待办 / 所属期仍须独立成功证据。

本轮等待用户确认现有窗口时，只准备当前代码与真实失败状态的草稿 PR，不 ready、不 merge、不宣布交付或专项完成。新版专用退役由独立本机 admin 实际运行；现有纯采集 backend 不因磁盘 commit 自动重载、当前未重启，browser owner 保留。恢复无锁并通过稳定 scope 核验后，实际 MCP 复采前仅更新纯采集 backend 到经审版本，绝不重启 browser owner。

## 本轮实施提示词与所有权

> 先读本任务、契约、交接和必要源码，不读真实 CP / checkpoint / source / run / manifest / raw / evidence / 隔离 JS。沿当前 HEAD 及两种准确 enum 继续，不再重做空 query 模式；恢复实现及 surface 已独审，当前已永久 commit 而未 finish，等待用户确认现有窗口已进入目标企业首页，具体页面 / 是否需重登由用户确认。root 只读确认精确已知 portal / 稳定 scope 后，按现有 prepare + commit 显式 resume，新一次正常导航证明旧 realm 销毁并核清理 / finish；不追认失败事件、不新开事务、不绕锁、不盲重启 owner / browser。退役成功也只能 unknown_abandoned / late session effects possible；不得从 performed 0 推未发送，从 timeout 推登录过期或企业变化。恢复后才新建独立 immutable context、两轮项目 MCP 实采并分别核参数 / 会话 / 响应企业绑定及投影覆盖，不预填成功。仅补报税最小字段与具体事项缺口；人员、登录操作人、银行账号默认不采，除非明确报税需要。不自动点击、不猜接口、不业务写，不 Git 或操作真实会话。

root 独占真实会话与 Git / PR；文档 owner 仅本任务、交接、契约、STATE / NEXT-SESSION / 任务 README 顶部六文档。用户明确授权本轮 Codex subagent 实施与独立审查，覆盖本轮 pi-only 限制；最终 reviewer 不参与实施、不继承实施上下文，不冒充 GitHub 第二账号批准。

恢复只由 root 在本机查本 worktree ignored checkpoint；文档不写真实 refs、nonce、PID、端口、运行时 URL / query 值、身份 / 业务原值或凭据。用户正常页面跳转授权有效，自动点击永久禁止；业务写及副作用不明操作禁止。owner / browser 保留、不盲重启。仅在当前企业、当前待办期间、必要资料与事项材料均有首遍成功、后端独立复采及覆盖证据后才可宣布专项完成。
