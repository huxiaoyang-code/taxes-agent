# TAX-BUSINESS-COLLECTION · 当前交接

日期：2026-10-20。负责人：`huxiaoyang-code`。分支 `codex/huxiaoyang-code/tax-business-collection`。必读：[任务](../tasks/TAX-BUSINESS-COLLECTION.md)、[契约](../TAX-COLLECTION-CONTRACT.md)、[章程](../PROJECT-CHARTER.md)。期间字段修复独立验证与最终两轮真实 MCP 已完成，root 待锁 head / PR 交付；已进入纳税人信息查询页，业务数据捕获不足，不能宣布整体采集完成。

## 基线与现场

基线 [PR #33](https://github.com/huxiaoyang-code/youshu-fork/pull/33) merge `f05c7a1a6a9412ab873f4b282a76ee773baff2f7`，head `9a9191f968548cbf2f5010e20f46df035f566bd6` 已独审、完整 25 套验证并合并。旧只读操作退役 `unknown_abandoned`、迟到结果永久禁用等历史见[前包交接](TAX-READONLY-ABANDON.md)，无需重做，不沿用旧 source / 窗口引用。本包自身 head / PR / merge 未知，不预填。

用户关闭整个旧浏览器，明确要求再启动后端浏览器并已登录。root 已以既有后端 open 和登记接口绑定全新专用窗口，新 v2 source 4 passive + 1 active identity 成功。期间格式修复后，现有 MCP stdio → HTTP → Agent → 新纯采集后端最终两轮各 3 fresh / 3 complete、各 6 行，身份 / 企业 / filing 投影相等，run / run 独立，无保留锁。当前登录 owner 后端 / 浏览器保留，只重启不拥有浏览器的独立 collector 加载格式补丁。

## 新发现与状态解释

| 已核实事实 | 可以说明 | 不能推出 |
|---|---|---|
| userinfo 21 字段；filing 行最多 32、合计 34 个技术字段 | 本机已看见实际 schema | 全字段已私有持久化 / 已全部授权投影 |
| `skssqq`、`skssqz`、`skssqzqz` 在 6 行均为 string，旧白名单漏保留 | 旧 period missing 是未采入 / 未核实 | 接口未返回期间，或字段存在即日期与当前待办归属已验证 |
| 6 行 `zt` 均已申报，入口为更正 / 作废 / 财报报送 | 行入口继续封锁 | 无待办、可沿这些入口采业务或允许写动作 |
| 独立 `listNsrDbxx` 业务失败 | 待办集合未验 | 已验证空列表 |
| `queryDj` 静态消费者仅信用等级 | 信用字段候选 | 完整企业档案 |

官方字段语义旁证为[广西税务局公开文件 PDF 第 100 页](https://guangxi.chinatax.gov.cn/xxgk/zfxxgk_22500/fdzdgknr/zfcg_22570/zbgg_22623/202303/P020230313613088224248.pdf#page=100)，其 `skssqq` / `skssqz` 为所属期起 / 止；这不证明本门户日期格式或当前事项归属，`skssqzqz` 仍不能凭名称推断。

已扩静态私有 `FILING_FIELDS` 期间 3 字段 / `IDENTITY_FIELDS` 基础企业 6 字段，不扩个人、agency、auth。不新增 source / run / capture 版本，不改旧文件，旧 scalar 子集仍 load，不补齐旧证据。collect / compare 使用 strict 日历 helper 重算 `filingPeriodsVerified` / `filingPeriodCoverage`、`filingPeriodsComparable` / `filingPeriodPairsEqual` / `filingPeriodMultisetEqual` 与 `enterpriseBasicFieldCoverage`；缺日期旧历史不可比，不由 missing == missing 推 true。原 filing projection 的 `periodVerified = false` 不变，显式 `currentPendingPeriodVerified = false`。

初次新字段 raw 两轮已取得期间，但旧 helper 两格式对 6 行判 unsupported；root 本机固定格式计数确认起止各 6 / 6 精确 `YYYY-MM-DD 00:00:00`。作者仅新增严格零时间格式与 Midnight 计数，拒绝非零 time、T、timezone、毫秒及空白；日期原值不入模型 / Git。root 最终完整 `npm test` 26 / 26 套、独立原 54 项 + 增量 45 项、作者 190 项定向均通过。

最终真实新增企业 6 字段均 present / nonempty 6 且两轮投影相等；期间 validPair 6，缺失 / 非法 / 倒序 / 不支持均 0，起止 Midnight 各 6、distinctPeriodCount 3、alreadyFiledWithValidPeriod 6。`filingPeriodsVerified = true`，source / run 与 run / run 的 `filingPeriodsComparable`、PairEqual、MultisetEqual 均 true；身份 / 企业 / filing 投影相等，独立请求 true。它仅证明这些已申报行的期间与基础企业覆盖；`currentPendingPeriodVerified`、`periodVerified`、`businessScopeVerified`、`projectionComplete` 仍 false，完整 profile / full business 仍缺。

## 查询入口与下一步

已发现唯一有效“纳税人信息查询”与“申报信息查询”菜单各 1 项。同源静态 handler `/szc/szzh/sjswszzh/spHandler` 的唯一 `cdlj` 分别对应公共技术路由 `/szzh/zhcx/nsrxxcx`、`/szzh/zhcx/sbxx/sbxxcx`。正常导航原型独审 30 项通过，所有新 JS 均 private 隔离、`safeAssetRefs = []`；已进入纳税人信息查询页，业务数据捕获不足。运行时 URL、query 值、refs 只在本机，不入模型 / Git。

root 已沿当前企业有效菜单一次正常 `Page.navigate` 进入纳税人信息查询；导航前 2 + 后 1 共 3 个 identity complete，`documentScopeVerified` / `identityProjectionMatched` true，无保留锁。初次仅被动 Network 观察：127 请求，29 超上限、74 外部跳过、6 显式副作用跳过；JSON 仅见用户消息等框架接口，企业档案业务成功证据、只读 recipe 核验与业务接口复采尚未完成。`safeAssetRefs = []`，新 JS 全本机 private 隔离，无点击或未知接口重放。首轮被静态 / 外部资源占满，正最小调整 ignored 采样为优先业务 XHR / Fetch 并暖缓存再观察，第二次结果未出，不预填成功；当前待办、完整企业资料与申报查询页仍未完成。

1. 字段与严格零时间格式修复的实现 / 合成 / 独立验证 / 最终两轮真实 MCP 已完成，文档冻结交 root 锁 head 审查 / PR。自身未知提交不预填，查询页后续结果可另包继续。
2. 纳税人信息查询已进入但业务捕获不足，继续优先业务 XHR / Fetch、暖缓存观察；实际只读请求 / schema 与企业 / 事项期间核实后，才固定 recipe 后端独立复采。不能从菜单名或已导航推业务成功，申报查询页仍未完成。
3. 不走已申报行更正 / 作废 / 财报报送入口；当前待办集合、期间、完整企业资料、业务字段仍有缺项，不能把新字段补齐升级为总任务完成。

root 独占真实会话和 Git；本轮用户授权 Codex subagent 实施，最终 reviewer 未参与实施且不继承实施上下文。文档 owner 仅本包 6 文档，不改旧任务 / 交接或 core。本包字段事实已冻结，合成测试与真实业务结果分列；后续查询页不能预填成功。

恢复仅 root 本机查本 worktree ignored `.agent-runs/TAX-COLLECTION-CHECKPOINT.json`，实施者不读取真实 checkpoint / source / run / profile / raw / evidence。真实数据 / 凭据只本机，安全 refs 也不入 Git；正常导航授权有效，自动点击、提交、缴款、更正、作废、备案变更及副作用不明操作禁止。
