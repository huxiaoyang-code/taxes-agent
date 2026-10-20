# TAX-READONLY-ABANDON · 当前交接

日期：2026-10-20。负责人：`huxiaoyang-code`。必读：[任务单](../tasks/TAX-READONLY-ABANDON.md)、[采集契约](../TAX-COLLECTION-CONTRACT.md)、[完整 URL 交接](TAX-FULL-URL-BINDING.md)。当前固定只读旧操作退役包已通过独立 37 / 37 与管理者最终 `npm test` 25 / 25 套；真实默认诊断 / 显式退役成功，控制面已完成。完整 13 文件候选 exact head 核对 / PR 由 root 收尾，不预填未知提交；整个业务采集专项未完成。

## 基线与已有历史

本包分支 `codex/huxiaoyang-code/tax-readonly-abandon`，基于 [PR #32](https://github.com/huxiaoyang-code/youshu-fork/pull/32) merge `2d53e4918f639c802c7104d95c8d802859bb19ba`；该 PR head `78cd3f902b52a06aa96628b91fc4875ddcfbea8b`，UTC `2026-10-20T06:20:32Z`。本包自身 PR / head / merge 未知，不预填。

- [PR #29](https://github.com/huxiaoyang-code/youshu-fork/pull/29)：head `c1d663a7b107f8538e01100a37c0b1102b9c02aa`，merge `bdc6e9a1c26835889d873ea0af1c57ac35d292ce`，UTC `2026-10-20T05:44:12Z`。历史身份 / 门户 6 行，两次各 3 个真实后端请求，source / run 与 run / run 三项白名单投影相等；仅部分覆盖。
- [PR #31](https://github.com/huxiaoyang-code/youshu-fork/pull/31)：head `57aeb06cf9236fbc7a1a75e14f737c6ca3b793f6`，merge `75eebbbfb78adfaf88be35a2e1080b5432764126`，UTC `2026-10-20T06:13:58Z`。v2 严格绑定 CDP full URL + fragment，active v1 在 open / lock 前拒绝，fetch 前再次绑定；v1 只保留历史 load / compare。当时 v2 实机未运行，本轮重新登录后的实际结果见下文。

`businessScopeVerified`、`enterpriseVerified`、`periodVerified`、`projectionComplete` 仍 false，缺 `business_period`、`full_enterprise_profile`、`full_business_fields`。历史 `documentScopeVerified = true` 不保证完整 URL 绑定，也不证明现场发生过片段切换。

## 当前现场与放弃语义

后续 ignored 原型曾在 `identity_before` 失败，`performedCount = 0` 不等于未尝试；当时未导航、无候选，`business_page_prepare` 新锁保留，现已显式退役。旧 host 已停止；source target 在显式 `filter: [{}]` 全包含目标清单中缺席。未 reload，缺席不证明 renderer / realm 同步销毁，现场未证明 BFCache；不能猜另一页面替代。

用户已确认重新登录完成，root 已形成全新 v2 source 并完成两轮真实 MCP 门户复采。此前 v1 身份及门户清单仅作退出前历史，不作为新登录的企业证明。下一阶段收窄到直接业务入口，不扩展泛化探索。

本包选择永久放弃已审旧只读操作和迟到结果：旧 host 死后不能继续后续 host 请求链、写应用文件或发布候选；残留 IIFE 最多为一个固定 identity GET 与读响应，旧结果无消费者。10 秒 Abort 不证明终止；原生 fetch 可接收 `Set-Cookie`，但未证现场改变身份 Cookie，不能承诺会话绝对不变。退役输出 `requestTermination: 'unknown_abandoned'`，不声称 `recovered`、`complete` 或 `contextDestroyed`。

旧版审计信任级别明确为 `operator_attested_not_loaded_bytes_proof`：历史 core `c1d663a7b107f8538e01100a37c0b1102b9c02aa` 的 `tax-live-collection.mjs` Git blob 为 `a5f850069a9693e720360677aa07e513ce64b805`。当时独审读 / 核 scratch 摘要前缀 `8FD7E4AFDACE` 后 root 调用，后来 v2 迁移覆盖；完整旧加载 bytes 未归档，不可伪称 loaded-bytes proof。此处只记审计信任边界，实施者不读取真实 operator-audit 或重建敏感材料。

## 实现、验收与待补事实

7 个代码 / 测试文件由代码作者独占，6 个文档由文档作者独占；root 唯一操作真实会话与 Git。用户明确授权本轮 Codex subagent 实施，最后由未参与实施且 `fork_turns = none` 的新 reviewer 独审，不冒充 GitHub 第二账号批准。

- 独立 admin-only `abandon_readonly` 不注册 MCP，默认诊断，execute / resume 均显式；严格 source / scope / nonce / dead owner / PID 复用 / registry / profile 校验。
- `nativeTarget.getTargetInfo` 仅按原 method 下精确 `-32602` / message 组合分类不可寻址；通用错误不作 not-found，辅助 `getTargets` 显式全包含。分类不能升级为请求或 renderer 已终止证明。
- 原锁 bytes + SHA 私有归档；prepare fsync → commit 永久 abandoned → 退役同 canonical 锁 → finished。崩溃必须显式 resume。Global OS mutex 只授当前 SID / SYSTEM，helper 在 host 死亡 / stdin EOF 后释放；持久 RECOVERY 挡普通 collector。collectionLock 创建后再检查 mutex，竞态失败仅撤自己的 nonce。
- 历史 run load / compare 保留；commit 后旧 source 不允许保存新 run，旧 source 不改写 / 升级，迟到结果不可作为新采集证明。
- fresh 独审确认 P2 修复通过：发布 commit / mutex 后验证失败据 disk / unknown 诚实报告，cleanup 失败仍保留 commit 事实。独立 37 / 37（36 合成 + 1 Windows 随机 Global mutex 烟测）通过；root 最终完整 `npm test` 25 / 25 套 exit 0。曾出现 contract 原生异常 `3221226505`，单独 44 / 44 与整轮复跑 25 / 25 通过，未因波动改代码。
- 真实默认诊断已完成：`diagnosed`、`targetAbsent = true`、`cleanup = true`、`lockRetired = false`。随后 root 按已审版本显式 execute 成功：`status = abandoned_readonly`、`phase = finished`、`lockRetired = true`、`resumed = false`；transport / adminGuard / overall cleanup 均 confirmed。原锁 bytes + SHA / private journal 已由程序验证存档，旧 source 不改写 / 升级。
- 实际退役仍为 `requestTermination = unknown_abandoned`、`realmDestructionProven = false`、`lateSessionEffectsPossible = true`、`oldResultConsumption = permanently_forbidden`、`auditTrust = operator_attested_not_loaded_bytes_proof`。这是控制面退役成功，不是请求终止证明或业务采集完成。
- 重新登录后，新 v2 source 正常导航成功，4 个被动请求 + 1 个主动 identity-after，完整 URL 语义为 v2；后续 MCP `documentScopeVerified = true`。现有 MCP stdio → HTTP → Agent → 后端两次各 3 个新请求、3 个完整响应，各 6 行，无保留锁。身份 / 企业 / filing 投影一致，run / run `independentRequests = true`；这仅计身份 / 门户申报列表。
- 新业务期间 / 完整企业资料 / 业务字段仍缺，`businessScopeVerified`、`periodVerified`、`projectionComplete` 均 false。业务候选 prepare 已完成 3 固定只读请求，6 行全为 branch_unverified，候选 / 导航均 0、lockRetained false；具体字段缺口正按官方消费者定位，未取得所属期 / 业务页，不以两轮门户相等宣布完整业务采集成功。

## 恢复与下一步

恢复入口仅本 worktree ignored `.agent-runs/TAX-COLLECTION-CHECKPOINT.json`，由 root 本机核对任务、执行提示、业务现场、验收与恢复。版本化文档不写真实 refs、PID、端口、运行时 URL、业务值或凭据；不读取实际 checkpoint / profile / registry / 原解析以补文档。旧 19 项未提交文件最新完整哈希未变，原 owner / 后端 / browser / quarantine 保留；另起旧 v1 临时后端已停止。

1. 代码 7 文件与文档 6 文件冻结交 root，完成完整候选 exact head 核对 / PR；不预填未知 SHA 或合并结果。
2. 本次退役已 finished，无需再执行 / resume。未来若有未完成事务，保留 RECOVERY，显式 resume；不得手删锁、改旧 source 或绕过 mutex / quarantine。
3. 全新 v2 source 与两轮 MCP 门户实采已完成，旧 source / 响应未复用；继续沿已确认直接业务入口补期间 / 完整资料。业务候选 prepare 已完成 3 固定只读请求，6 行全为 branch_unverified，候选 / 导航均 0、lockRetained false；具体字段缺口正按官方消费者定位，未取得所属期 / 业务页。

正常导航原已授权；自动点击、正式申报、财报报送、缴款、更正、作废、备案变更与副作用不明操作禁止。真实原值 / 凭据不入模型或 Git，安全引用不入 Git / PR。总任务与全国真实接入仍未完成。
