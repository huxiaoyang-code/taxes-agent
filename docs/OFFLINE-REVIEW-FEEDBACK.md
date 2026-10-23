# 本机结构化会计反馈与版本登记（OFFLINE-05B）

本片是 #82 的本机文件版本登记及选定字段确认，不是整期审定、正式业务写账或既存账更正。API 见 `06-workbench/server/accountant-review-store.mjs`，反馈合同见 `accountant-review-feedback.mjs`。输入仍是实际 `offline-vat-input/1` 配置；不能登记上传的 bundle、税额、ready 或批准。

## 存储与新鲜度

`initReviewStore(newDirectory, scope)` 只创建不存在的新目录。`registerReview(store, inputPath, {expectedJournalHead, supersedes})` 每次 fresh loader→create→export 自有 pending 草稿；首次 supersedes=null，后续必须精确当前 versionId。每条不可变 receipt 连接前一 digest，链尾既是 expectedJournalHead，也是当前版本指针的权威来源。版本 receipt 存 inputPath、scope、bundleDigest/inputHash/ruleVersion/ruleDigest/calculationVersion/ledgerSnapshotDigest、规则代码 digest 和自有 artifact 文件实 hash。旧包/旧反馈保留；同一当前计算重复登记返回原版本、不追加 receipt。

每次重开全量核 journal 和所有引用包、manifest、scope、pending 限制。每次 inspect 和反馈均实际重读原输入/store、当前规则及真实只读账库重算。失配保留历史记录，但 effectiveConfirmation=false/stale。Node 缓存已加载模块，故 `ruleCodeDigest` 除税规则还绑定本链明确28个本地模块的实际字节；运行期间这些代码变化拒写并 stale，要求重启后按当前模块重算；新进程仍与登记摘要比较。不扫描整个server，不热加载。公共 hash 仅比较完整性，不认证会计身份或经济事实；不认证第三方依赖或 Node 运行时本身。

有限清单（均在06-workbench/server）：accountant-review-store、accountant-review-feedback、accountant-review、accountant-review-export、offline-vat-input、offline-ledger-snapshot、offline-accounting-readiness、offline-materials、offline-material-adapters、offline-material-store、offline-invoice-xlsx、offline-contracts、offline-bookkeeping、offline-voucher-rules、offline-task-planner、material-completeness、customer-data-request、tax-calculation、tax-rule-registry、enterprise-identity、import-storage、bank-import、money、accounting-profiles、local-audit-storage、local-audit、local-batch-storage、database-open-guard（扩展名均为.mjs）。仅读取这些实现字节，不调用其写账能力。

只用专用 wx writer 锁及 append receipt；没有后台队列/数据库写入/通用恢复。锁未知、残锁、partial receipt、内部损坏一律 fail closed，不自动删除。最多2000 receipt，单receipt最多2MiB，单artifact文件最多64MiB；满额拒新追加，已登记查询/同ID重放仍可用。未提交 artifact 仅是诊断目录，不是有效版本；失败或响应丢失须 inspect，反馈同 ID 重试可查已提交记录。提交后再次 fresh 读实际输入/规则/账库；提交窗变更时回执保留历史，返回stale/effective=false。#83 通用恢复仍未实现；不承诺断电或跨文件/DB 的事务。

## 反馈 JSON（固定白名单）

必需：`version: "offline-accountant-feedback/1"`、`feedbackId`（稳定标识）、`action`（request_materials/reject/confirm_selected_fields）、`scope`、`versionId`、`binding`、`expectedJournalHead`、`actor: {name, role:"accountant"}`、`occurredAt`（规范 UTC ISO，毫秒及 Z）、非空 `reason`。

binding 精确包含 bundleDigest、inputHash、ruleVersion、ruleDigest、calculationVersion、ledgerSnapshotDigest、ruleCodeDigest、inputFilesDigest。最后一项绑定loader实际文件inventory的JSON规范化摘要（与manifest一致，省略undefined可选成员，保留null/0/false），连原始配置文件字节/路径也比较。补件/驳回另必需 `facts: [{field, observedFact, requestedFact}]`；内容说明原始事实、依据和理由，不要求客户预制分录/税额。确认另必需 `selectedFields: [{row,column:"services",period}]`；仅可确认当前支持且 computed 的服务字段，不能确认 NA、未知或整表。所有顶层和嵌套结构拒绝其它键，不接受金额/税基/科目/patch/公式/ready。

确认须当前版本、精确 CAS、实际原输入/账库/规则绑定相同、calculationReady 且无税算异常。补件/驳回允许登记当前 blocked 草稿，但同样必须 fresh 与登记一致。每条反馈记录仅是本机操作者声明，姓名/角色不具身份或签名认证。最新反馈是确认且 fresh 才有效；后续补件/驳回撤销当前有效性。相同 ID+完整 payload 无新记录，同 ID 改 payload 拒绝；重放仍 fresh 判断，旧 confirmed 不能冒作当前有效。

fresh失效是当前精确绑定比较，inspect只读、不持久写“观察到变化”的事件。未登记新版本而完全恢复原文件/账/代码绑定时，当前原版本的原确认可重新显示有效；一旦显式登记新version，旧版本的确认始终仅是历史，即使其bundleDigest后来相同也不沿用。

`request_materials`/`reject` 会追加不可变反馈，持久撤销当前版本先前的有效确认；重启或完全恢复原绑定不会跳过这条最新反馈恢复旧确认，必须再提交新的选定字段确认。这与仅由fresh绑定不一致产生的暂时失效不同；不需要inspect写观察日志。上述精确比较语义已经双方确认，不能据此宣称任意观察到的变化都会永久作废。

`inspectReviewStore` 返回 current/history/feedbacks、逐字段状态和值差异（null/0/NA 分开）、current freshness、effectiveConfirmation 和确认的具体字段。独立 `reviewState` 为 no_version/pending_review/materials_requested/rejected/changed_pending_review/selected_fields_confirmed/stale/blocked；不混同税算的status。当前补件/驳回的feedbackStatus为recorded_current，当前有效选定确认是recorded_effective，其余recorded_stale/history。反馈操作另有feedbackEffectiveConfirmation，避免旧ID重放被误当新版本确认。整体 periodComplete/submittable/authorizesExecution 永远 false，原 pending bundle 永不修改。旧导出模块的草稿pending文字不因本片增加独立登记能力而改写；当前反馈状态看登记结果。新版本不继承旧确认。反馈只能作用于当前版本；历史版本的记录由 inspect 查询。

## CLI

在 `06-workbench` 执行，所有操作必须 `--output <NEW.json>`，副作用前核canonical parent并要求结果路径位于store之外，再wx预留结果文件；不允许结果路径创建假锁/receipt/内部artifact。路径/企业/金额/理由只进入该本机文件，stdout 仅固定状态/计数，stderr 不打印自由异常。

```
node scripts/accountant-review-feedback.mjs init --store <NEW_DIR> --scope <scope.json> --output <NEW.json>
node scripts/accountant-review-feedback.mjs register --store <DIR> --input <input.json> --expected-head <digest|none> --supersedes <versionId|none> --output <NEW.json>
node scripts/accountant-review-feedback.mjs feedback --store <DIR> --feedback <feedback.json> --output <NEW.json>
node scripts/accountant-review-feedback.mjs inspect --store <DIR> --output <NEW.json>
```

退出码：0 已记录/当前可查；3 stale、blocked 或 unsupported 的已写结果；2 参数错；4 读取/绑定/CAS/锁/损坏/输出失败。非零不证明无部分文件或无已提交记录。结果文件写入/响应故障后不覆盖重试，改用新结果路径 inspect；原文件保留诊断。

用户更正自己的原始税分类事实→register 新计算→查字段差异→新选定字段确认是本片支持的链；不自动改原事实，不绕过 #54 在途正式写依赖，不是既存账更正/自动调整。真实会计审定、生产黄金、试用、其余税种及 #83 恢复仍未完成，税局真实接入0。
