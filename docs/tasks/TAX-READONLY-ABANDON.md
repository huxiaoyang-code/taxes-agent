# TAX-READONLY-ABANDON · 固定只读旧操作退役

日期：2026-10-20。负责人：`huxiaoyang-code`。Refs #20 / #13 / #14 / #17；不关闭总任务。状态：独立审查 37 / 37、管理者最终 `npm test` 25 / 25 套通过；真实默认诊断与显式退役均完成，控制面退役成功。代码 7 文件与文档 6 文件待 root 完整候选 head 核对 / PR；不预填未知提交。重新登录后的新 v2 source 与两轮 MCP 门户复采已完成；业务期间 / 完整资料仍缺，整个税局资料采集专项未完成。

- 基线：[PR #32](https://github.com/huxiaoyang-code/youshu-fork/pull/32) merge `2d53e4918f639c802c7104d95c8d802859bb19ba`，head `78cd3f902b52a06aa96628b91fc4875ddcfbea8b`，UTC `2026-10-20T06:20:32Z`。分支 `codex/huxiaoyang-code/tax-readonly-abandon`。
- 必读：[章程](../PROJECT-CHARTER.md)、[STATE](../handoffs/STATE.md)、[完整 URL 任务](TAX-FULL-URL-BINDING.md)及[交接](../handoffs/TAX-FULL-URL-BINDING.md)、[采集契约](../TAX-COLLECTION-CONTRACT.md)、[本包交接](../handoffs/TAX-READONLY-ABANDON.md)。
- 用户明确授权 Codex subagent 实施及无实施上下文的最终独审；root 独占真实会话与 Git / PR，实施者不操作真实页面或 Git。此项覆盖本轮旧员工实施范式，不扩大业务操作授权。

## 问题与目标

后续 ignored `candidate_only` 原型曾在 `identity_before` 失败，`performedCount = 0` 不等于未尝试；当时未导航、未生成候选，`business_page_prepare` 锁保留，现已由本包显式退役。旧 host 已停止，原 source target 在显式全包含目标清单中缺席；缺席或通用 CDP 错误不证明 renderer / realm 已同步销毁，也未证明现场发生 BFCache。

本包新增独立 admin-only `abandon_readonly`，永久放弃经审查的固定只读旧操作及其迟到结果，并退役其匹配锁。它不宣称请求终止，不把结果标记为 `recovered`、`complete` 或 `contextDestroyed`，不恢复或升级旧 source，也不把旧操作当新鲜证明。此能力不注册为 MCP 工具，默认只诊断，执行与崩溃恢复均须显式发起。

用户已确认重新登录完成；root 已用全新 v2 source 重新取得身份 / 门户申报列表并完成两轮 MCP 实采，未沿用旧 source 或响应。退出前历史门户投影不能代表新会话。后续收窄到直接业务入口，不继续泛化探索。

## 安全依据与限制

独立于实施上下文的前置审查已核对固定旧能力与 Chromium 原则：host 停止后不能继续后续 host 请求链、写应用文件或发布候选；残留 IIFE 至多为一个固定 identity GET 及读取响应，旧结果无消费者。10 秒 Abort 不是终止证书。原生 fetch 具备接收 `Set-Cookie` 的平台能力，未证明现场实际修改身份 Cookie；不能承诺会话绝对不变，下一次必须重新绑定。

旧版审计信任级别为 `operator_attested_not_loaded_bytes_proof`。当时管理者在独审后调用；旧完整加载 bytes 未归档，后来已由 v2 覆盖，不能伪造 loaded-bytes 证明。历史定位摘要只集中保留在本包交接，不散写入口；不得为补证明读取真实 operator-audit、registry、profile、checkpoint 或业务原值。

## 文件所有权与实施提示

代码实施者独占以下 7 文件：新增 `06-workbench/server/tax-readonly-abandon.mjs`、`06-workbench/scripts/abandon-tax-readonly-operation.mjs`、`06-workbench/test/tax-readonly-abandon.test.mjs`、`06-workbench/test/tax-readonly-abandon-guard.test.mjs`；修改 `06-workbench/server/tax-browser-transport.mjs`、`06-workbench/server/tax-collection-local.mjs`、`06-workbench/scripts/test-all.mjs`。

文档实施者独占本任务、本包交接及契约 / STATE / NEXT-SESSION / 任务 README 顶部必要入口，共 6 文档。不改全局 Skill、不改旧 19 项未提交文件、不纳 ignored 原型入 Git。真实现场、恢复与执行提示只指本 worktree ignored `.agent-runs/TAX-COLLECTION-CHECKPOINT.json`，由 root 本机核对；不在版本化文档写实际引用、PID、端口、URL 参数或业务值。

> 仅实现固定只读旧操作的 admin-only 放弃能力。默认诊断；执行 / resume 必须显式。严格校验 source、scope、nonce、dead owner 与 PID 复用、registry / profile 绑定。只将原 method 下精确的 `-32602` 与已确认 message 组合映射为目标不可寻址分类；通用错误不作 not-found，辅助目标清单显式全包含。将原锁 bytes 与 SHA 私有归档；先 prepare 并 fsync，再永久提交 abandoned，才可退役同 canonical 锁并 finished。崩溃须显式 resume。以当前 SID 与 SYSTEM 可访问的 Global OS mutex 串行化，helper 在 host 死亡 / stdin EOF 后释放；持久 RECOVERY 阻挡普通 collector。新建采集锁后再检查 mutex，竞态失败仅能撤自己的 nonce。保留历史 run load / compare，但 commit 后拒绝旧 source 保存新 run。旧 source 不改写 / 升级，输出 `requestTermination: 'unknown_abandoned'`。只用合成材料覆盖失败、崩溃与并发；不读真实材料、不浏览器导航、不 Git。

## 验收条件与已知结果

1. 默认诊断不改变文件、锁或页面；显式退役只作用于已审固定只读旧操作，绑定或 owner 不符即保留现场。
2. 原锁私有归档与持久提交先于锁退役；崩溃与并发不能让普通 collector 越过未完成恢复；resume 不重复放行已放弃 source。
3. target 不可寻址分类不等于 renderer / 请求终止证明；所有返回与持久状态诚实表达 abandoned / unknown，不把发布失败或 mutex 后验证失败伪装为成功。
4. 历史读取 / 比较仍可用；旧 source commit 后不能保存新 run，不能据迟到响应发布候选或覆盖新 source。
5. 独立审查及验证 37 / 37（36 合成 + 1 Windows 随机 Global mutex 烟测）通过；发布 commit / mutex 后失败状态已修复为从 disk / unknown 诚实报告，cleanup 失败保留已 commit 事实。管理者最终 `npm test` 25 / 25 套 exit 0；曾有 contract 原生异常，单独 44 / 44 与整轮复跑通过，未因波动改代码。
6. 真实默认诊断返回 `diagnosed`、`targetAbsent = true`、`cleanup = true`、`lockRetired = false`；随后显式 execute 成功，`status = abandoned_readonly`、`phase = finished`、`lockRetired = true`、`resumed = false`，所有 cleanup confirmed。原锁 bytes + SHA / private journal 已由程序验证存档，旧 source 不改写 / 升级。`requestTermination = unknown_abandoned`、`realmDestructionProven = false`、`lateSessionEffectsPossible = true`、`oldResultConsumption = permanently_forbidden`；这是控制面退役成功，不是终止或业务采集证明。
7. 重新登录后新 v2 source 正常导航成功，4 个被动请求 + 1 个主动 identity-after；完整 URL 语义为 v2，后续 MCP `documentScopeVerified = true`。现有 MCP stdio → HTTP → Agent → 后端两次各 3 个新请求、3 个完整响应，各 6 行，无保留锁；身份 / 企业 / filing 投影一致，run / run `independentRequests = true`。仅计身份 / 门户申报列表，业务期间 / 完整企业资料 / 完整字段仍缺，`businessScopeVerified`、`periodVerified`、`projectionComplete` 均 false；业务候选 prepare 已完成 3 固定只读请求，6 行全为 branch_unverified，候选 / 导航均 0、lockRetained false；具体字段缺口正按官方消费者定位，未取得所属期 / 业务页。

## 后续业务与恢复

安全退役及重新登录后的新 v2 门户实采已完成，不能用旧 target 缺席替代终止证明。root 继续沿已确认直接业务入口核实期间 / 资料，业务候选 prepare 已完成 3 固定只读请求，6 行全为 branch_unverified，候选 / 导航均 0、lockRetained false；具体字段缺口正按官方消费者定位，未取得所属期 / 业务页。此为全新 v2 请求，不是恢复旧 source，也未复用旧响应充数。

PR #29 历史仅有身份 / 门户 6 行及两次各 3 个真实请求的投影相等；`businessScopeVerified`、`enterpriseVerified`、`periodVerified`、`projectionComplete` 仍 false，缺 `business_period`、`full_enterprise_profile`、`full_business_fields`。正常导航允许；自动点击、正式申报、财报报送、缴款、更正、作废、备案变更及副作用不明操作继续禁止。原值与凭据不进模型 / Git，安全引用不入 Git / PR；原后端 / browser / quarantine 保留。
