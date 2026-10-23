# 本机审计（LOCAL06 W2a 候选）

产品仍为本机单用户、同库多企业、一企一个账套。W2a 提供保护安装、audit1/2 严格备份和操作原语；实际业务入口尚未接入，不能声称任意业务 SQL 都已受审计保护。LOCAL06、LOCAL07、Windows W2与最终整链仍未完成；全国电子税务局真实接入0。

## 安装与版本

`installAuditSchema(db, {dbPath, outDir})` 异步安装或升级 `business-audit` 到2。core3/4支持裸库或bank1，core5支持裸库、bank1、auxiliary1及两者组合；W3a候选将严格batch1/2加入官方注册表，尚待root验收/独审/PR。core、bank、aux版本不变。

安装拒绝caller事务、错路径/句柄、路径别名/多硬链接、未知/半安装结构。实际源连接持 `BEGIN IMMEDIATE`，独立只读reader执行官方 `createBackup({dbPath,outDir})` 的VACUUM INTO，固定官方verify核快照字节/摘要与manifest，再用真实 `assertBackupSourceConnection(db,manifest)` 比较持锁源库，复核文件identity后才执行DDL并提交。失败在能证明ROLLBACK时回滚；提交结果不明则隔离该写连接并返回固定unknown错误，不能宣称原库未变。

合法audit1的原事件、dedupe、digest、实例及历史字节保留；升级仅给原事件新增默认格式1列，不伪造operation。合法audit1/2均可inspect/assert/query/verify及只读CLI。`ensureAuditSchema(db)`仅核验已安装结构；无路径调用不能安装新库或升级。raw audit-only库可以只读检查，但没有受支持core就不能产品升级。

## 操作协议

```js
const prepared = prepareOperation(db, {
  context: {operationId: 'op-1', attempt: 1, actor: 'domain', action: 'voucher.post'},
  scope: {kind: 'database', value: null},
  request: {amountCents: 137}, // 可信适配器已验证的实际请求；不传凭据
});
if (prepared.code === 'prepared') {
  const result = executePreparedOperation(db, prepared.authorization, () => {
    // 可信、同步的领域写入；本片没有替任何实际入口自动接线。
    return {state: 'succeeded', resultCode: 'voucher_post_succeeded'};
  });
}
```

入口由 `server/local-audit-operation.mjs` 导出prepare/execute/query；存储模块保留同名导出。调用方必须拥有显式连接、启用foreign_keys，且没有活动BEGIN/SAVEPOINT。父操作字段只作关联，不授予继承outer事务权限。拒绝caller事务时不会提交或回滚caller。

prepare在最外层写锁内核对key和binding，插入pending并明确COMMIT后才发私有WeakMap授权。授权是冻结空对象，绑定原句柄、真实文件identity、活动实例、key/binding，只能消费一次；序列化、伪造、跨句柄、跨实例、已消费、关闭后重开均不能获得执行权。准入BUSY未开始且可重试；已有pending只返回needsReview，不补发权限。进程重启也不能从JSON/PID恢复权限。

execute重新持写锁核pending后消费权限，可信同步callback的业务效果、格式2终态事件、operation终态和技术receipt同一次COMMIT。callback期间拒绝事务控制、PRAGMA、DDL及直接审计写入；这是协议约束，不是任意插件SQL沙箱。callback结束后还核实外层事务仍在，丢失事务直接unknown，不先autocommit成功审计。

结果只准 `{state,resultCode?,reasonCode?,targets?}`，四终态succeeded/no_change/failed/rejected及固定词表。Promise/thenable、未知DTO、自由业务字段拒绝；数据使用安全整数/普通对象/数组，先检查own descriptor并拒绝Proxy/accessor，绝不调用getter。失败DTO/throw先真实ROLLBACK，再短事务留固定失败事件；异常原文不进回执。失败留痕也失败时保留pending并needsReview。

真实COMMIT BUSY且事务仍活动、ROLLBACK成功才是确定失败；提交后异常、断连或无法证明回滚均unknown。已成功终态不会被unknown覆盖。相同实例+operationId+attempt重放同一receipt；binding冲突callback为0。只有同binding、紧邻前次failed/rejected才能prepare下一attempt；pending/成功不自动递增。

`queryOperation(db,{databaseInstanceId,operationId,attempt})`只读返回终态回执或pending待核。W2a不提供force/recover/自动重跑接口。恢复到新目录的pending原样保留，但副本没有私有执行权。

## Binding、事件与回执

规范JSON对象键按Unicode码元序，数组保序，只准null/boolean/string/安全整数，不改Unicode。数据库内JSON必须逐字等于规范序列化，重复键/额外键/非法类型拒绝。

scope形状固定 `{kind,value}`：database为null；account_set为真实内部ID且与context.accountSetId一致；enterprise先沿核心NFKC/trim规范身份并核已给账套的企业绑定。原企业身份与实际请求只用于本机计算摘要，不写operation表。该API接收可信领域适配输入，不把外部自填hash当授权。

scope_token=`SHA256(C(['audit-scope-v1',kind,canonicalScope]))`；request_digest=`SHA256(C(['audit-request-v1',action,normalizedRequest]))`。binding包含版本1、action、scope_kind/token、七技术目标、父operation/attempt、request_digest；actor首次留痕但不进binding。

格式1保持旧摘要与去重算法；格式2 dedupe含实例+operation+attempt，digest使用 `['audit-event-v2',旧字段顺序数组]`。新终态operation与格式2事件严格双向对应。持久receipt精确为：

`{receiptVersion,databaseInstanceId,operationId,attempt,state,resultCode,reasonCode,eventId,eventSeq,targets}`

七目标固定accountSetId/voucherId/period/jobId/itemId/stageId/correlation，缺省null；结果仅可补原null目标。receipt不存业务DTO、金额、姓名、路径或异常原文。首执与重放receipt字节相同。

envelope为 `{ok,code,state,replayed,durability,retryable,needsReview,receipt}`；prepare首次另有私有authorization。durability=committed/not_started/unknown，失败的committed仅指失败审计已提交；unknown固定needsReview且不能自动重试。

旧 `runAuditedOperation`、公共 `appendAuditEvent`、`appendDeferredFailure`、`markAuditInstanceFork`固定 `audit_operation_protocol_required`，在callback或事务前拒绝；伪造error属性不能授写权。纯context/hash/事务utility仍不授审计写权限。

## 严格检查与验收边界

audit1/2完整DDL、全列/default/PK/rowid/CHECK、完整自动/显式index键collation/order/origin/partial、全部FK/trigger/view集合与逐行内容均从实际SQLite核验。未知版本、半装、额外对象及非法事件/operation/receipt拒绝，不repair。严格合同由同一存储模块供备份注册表复用，bank/aux安装gate只接受官方核验的已登记组件组合并排除本次target已装。

定点套件：local-audit-operation、local-audit-install、local-audit-backup-integration、迁移后的local-audit；旧backup/bank/aux按影响复验。原88测试逐字原序末追加3为91；本片不跑完整入口。实际命令、失败历史、close和hash证据见 [本片交接](handoffs/LOCAL-06-AUDIT.md)。

后续依赖由root确认：W3a batch1/2严格registry与保护升级 → W2b可信业务coordinator → W3b统一锁与真实批量链 → W4恢复分叉/Windows/最终整链。上述均未由W2a实现。
## W3a 同库 batch 关联及后装保护（候选）

batch持独立UUID；没有audit时当前关联为NULL。audit先装时batch安装在同一受保护事务记录真实audit active；batch先装时audit安装在写预约和官方source核证后，捕获已严格核验的batch当前active，仅给该行原NULL填当前audit active。历史NULL、已有非NULL、两方原实例ID/父链/历史事件均不改；公共validator无可传布尔放宽门。active错配、未知对象/引用、任一父链循环拒绝。

审计schema facts只收对象自身audit_/idx_audit_命名、所属审计表或SQL真实表引用。普通audit_instance_id列、字符串/注释不算依赖；任意名view/trigger真实引用审计表、附着audit表的未知index/trigger、大小写等价的额外命名对象仍严格拒绝。未改audit1/2既有DDL/历史摘要/owner-only receipt/pending协议。W2b尚未接线，不能把旧batch事务冒充业务coordinator。
