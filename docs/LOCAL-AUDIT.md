> **2026-10-24 当前事实：W3b 已合，W4a 为待审候选。** [PR111](https://github.com/huxiaoyang-code/youshu-fork/pull/111) 于 2026-10-24T05:13:10Z 合并；已审 head `d8a15f9d793653cb7a32387425df1ee94c0715bb`，merge `cfa19ed9f4c438005e029aa169e52cd8c96105ab`，tree `1951407c5c8de8f9cf222ab2a0c3ca419987dce2` 一致。该 head 管理者实跑完整20企两月、19＋1隔离、30代表报表、运行中官方备份、326 checkpoint续跑及R1–R9故障/来源矩阵，exit/close 0；独立完整内容审查接受。直接父c1d的Q2 35及七套通过属于原时点，R9未重复这八套，旧失败不改写。
>
> 本包W4a在该head实现 ledger2 预绑定、restore-control1、receipt2、真实审计/批量分叉与pending准入；员工自测不代替root/fresh最终验收，尚未PR/合并。W4b输入/输出重绑与合法激活、最终Windows冷链/升级回退和总合成E2E仍未完成，LOCAL06/07与总任务继续开放。产品仍本机单用户、一企一套、同DB多企业；全国税局真实接入0。下方旧候选与旧接口保留历史，当前恢复合同以本节及LOCAL-BACKUP当前W4a说明为准。

> **当前 W2b 已合并（2026-10-24）**：[PR #100](https://github.com/huxiaoyang-code/youshu-fork/pull/100)，merge `e13cc43d9f95ee78599b288486ff5721b01f00e2`；[本次13docs交接认领](https://github.com/huxiaoyang-code/youshu-fork/issues/54#issuecomment-6376358168)。交接元数据待提交／复核，LOCAL06/07未整体完成、八任务仍6/8、税局真实0。审定head、独审和后续边界见[LOCAL06当前交接](handoffs/LOCAL-06-AUDIT.md)。

以下保留合并前阶段说明；最新PR #100已合并事实与后续边界以页头交接为准。

R4在读取原options的scope、spread或persist之前，无回调拒Proxy/accessor/非法原型/symbol/cycle/function等，再生成安全数据副本，scope/request/body/refs使用同一数据。严格S_result保持；银行仅既有两个明确顶层statement cents BigInt可投影十进制字符串，业务副本仍保BigInt，其它位置及深层BigInt拒绝。复制保own undefined/holes/nullproto/安全__proto__。extractOperationMetadata仅复用提取的纯私有descriptor clone，先严格snapshot及返回合同不变；固定银行entry最后写入审计请求。

安全前检先以模块私有、data-descriptor-only临时副本拒绝proxy/accessor/cycle等，再复用原金额/legacy validator；该临时副本仅为保NaN/Infinity的原错误码/validation DTO，绝不进入C、result摘要、pending或授权。真正准入仍严格S_result_v1。aux附录仅对非Proxy、plain/null原型根的自有data descriptor复用原纯parse validator；真实执行完整重验。入口metadata提取在严格检查后保原own undefined/holes/安全__proto__定义，仅剥root operationId；不再用摘要归一化后的.value冒充payload。

本机REST按原业务码/详情/状态返回并附真私有proof；模型先固定安全投影，bank固定错误投影只复制原WeakMap已有证据，不接收任意code/metadata/authority。caller BEGIN/SP/auxTransaction不授能力；helper若自己开启事务则可回滚自己事务。已准入业务错误必须保业务回滚与失败终态，纯静态拒绝仍全表零写。aux/I内部真私有outer中的失败固定队列只在确认整体rollback后消费；任何失败元数据/终态写失败都全回滚留pending/unknown，不增attempt自动重跑。

## 2026-10-24 W2b 接线合同（R4根影响验收通过，待新最终独审）

本轮最初实施起点为 PR87 merge `882c5b65564fd7e2281eba4a799b3a7a25c5b5f3`；当前整合BASE以页头35bd为准。真实会计、首次/增量导入、辅助核算、银行写入及有失效刷新副作用的银行查询，统一进入同步 `local-audit-coordinator.mjs`。`db.mjs` 在核心迁移和真实新库连接核验之后 await 官方 audit 安装/升级；安装失败阻止领域模块启用。单用户、同库多企业、一企一套和两种 profile 均保持。

领域先在事务外持久化 pending 并取得私有单用 authorization，再拥有最外层事务。业务保存点仅逐次许可内部自产名称/动作；执行领域函数时许可已关闭。银行结构核验仅走固定只读 metadata 门。caller BEGIN/SAVEPOINT、actor、ALS、operationId、parent 和序列化 receipt 都不授执行能力。批量固定 child 在父执行前准备，只有同 db/file/instance 和真实父 authorization 才可消费；业务、来源/批次完成、父子终态和 checkpoint 同 COMMIT。已确认 rollback 后父子失败终态另事务落库；未知态保 pending 并禁止通过增加 attempt 绕过。

新写 receiptVersion=2；旧1严格只读兼容，不增加 DDL/version。2严格保留1的基础字段并增加 `resultRefs`、`resultDigest`，未知版本或额外字段拒绝。refs 只存固定 typed 正整数内部ID，或 account/import_batch/bank_account 三类自然键的 keyDigest；新终结核归属，历史回执不依赖对象继续存在。删除保存原内部ID，账套删除的顶层 undefined 与 null 摘要不同。

请求采用更窄的 digest-first 投影：未改变的领域请求先做同一安全 `S_result_v1` 快照及SHA256，只有固定 `{domainRequestDigest:<技术摘要>}` 进入原 integer-only C；action/scope/instance仍独立绑定，不持久化金额或原文。精确同请求重放，不按字段名猜金额/费率、不把不同原请求强行量化合并；未声称逐财务字段生成整数分。唯一BigInt例外是原银行API明确允许的两个statement*Cents字段先转规范十进制cents串，其他BigInt拒绝。

`resultDigest` 对 `{version:1,rootKind:'json',value:原DTO快照}`，或无 value 的 undefined 根做 `S_result_v1` 后 SHA256。编码对象键按 UTF-16 码元序（含数字形键）、数组保序；有限数用标准 JSON，-0归0、对象undefined省略、数组undefined为null。先检查 data descriptor，拒 proxy/accessor/cycle/非普通原型/非有限/BigInt/函数，不执行 getter。首次仅真实 COMMIT 后返回原DTO；同ID重放不运行callback。同进程用独立快照，重启只读 refs 重建并比对 digest；缺失/改变/旧1无法精确重建返回 `audit_result_unavailable`，仍保 committed / applied=true，不重执或拿当前变化DTO冒充旧结果。

HTTP 可提供 `X-Workbench-Operation-Id`，raw Agent/MCP可提供operationId元字段，中央校验、冲突拒绝并剥离后进入原业务严格payload。无ID生成UUID；可靠跨响应丢失重试须在首次请求前自行保存稳定UUID，成功后的新动作使用新ID。银行draft在prepare时绑定独立UUID，preview/approve/失效/撤销/账套门保留，执行响应header与真实receipt ID一致；draftRef不进审计绑定。CLI写入口支持 `--operation-id`，机器模式仅在唯一正式结果/错误JSON返回ID；可靠丢响应重试须调用方运行前保存显式ID，自动生成ID不保证崩溃前交付；人类text模式可提前输出文本。`local-audit operation --db <显式文件> --operation <id> [--instance <id>] [--attempt <n>]` 全程只读，不建库、不迁移。

incremental 的静态参数/来源/规范mode与scope预检复用原纯校验，在 audit.prepare 前完成，保持原DTO与全库零写；私有同步 admissionOnly 阶段在任何写入或回放附录副作用前返回，不可由options/JSON启用，不授执行权。实际执行仍在outer中完整重验。既存稳定ID只为同import动作保留原scope的只读重放；跨入口ID确定冲突，prior binding不授新能力。

incremental 和银行导入失败只登记私有固定字段队列；只有确认真实rollback后，固定markBatchFailed（保原failed attempts累计及各自completed/pending_review保护）与全局失败终态同事务提交；batch下真实child栈仅由私有授权核验push/finally pop，已绑定child与父失败终态同COMMIT，create失败不留已回滚accountSetId。任一失败记录写入失败均回滚整层并如实unknown/audit_unavailable。窄银行手工连接恢复只核“准入pending COMMIT_BUSY，authorization尚未发出，随后真实结束事务，同file/instance且精确pending行不存在”的私有记录；持久pending/已提交/执行未知/文件或实例变更均不清隔离、不重执。

本片只完成 W2b 接线候选；W3b 全入口统一账套锁、20企业完整故障核证、W4恢复分叉/重绑、Windows与最终链仍待办。税局真实接入0，原八包仍6/8。详细自测和失败历史见审计交接；前轮50定点＋4probe按未变范围复用；R4根13原套＋1probe通过，新最终fresh尚待；旧9cd完整97实际73通过/24失败，员工未跑 full/npm test。

以下为各阶段历史合同；与本页当前W2b说明冲突时，以本页头部为准。

> **2026-10-24 W3a 同轮返工候选**：完整 `605e057794850a19d0f533ce273323b4ae1c7f4d` 复审仍拒一项P2：已claim/成功report缺必需snapshot/artifact反向存在性；原内部种子失败保全P2已由独审实际闭合。现补own tuple存在与归属，保未claim无记录、已claim未发布、旧attempt及最新可变DTO/CSV窗口。实际report-p2两组/92拒绝和两安装夹具定点、失败历史见[LOCAL07交接](handoffs/LOCAL-07-CLI.md)。尚待root新冻结十一影响套及新完整head独审，未PR/合并；原八包6/8、LOCAL06/07未完、税局真实接入0。

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

## W4a当前候选：显式恢复、分叉与只读保全

`backup`与`verify`仍使用format1。恢复单独使用receiptVersion2；旧restore.json format1只能只读理解，不授新恢复执行权。旧文中的双参restore-new示例已停止适用：API缺少ledgerPath/operationId返回restore_contract_required，CLI缺参是usage错误，零目标副作用。

```sh
node scripts/local-backup.mjs restore-new --backup /absolute/BACKUP --target /absolute/NEW_TARGET --ledger /absolute/LEDGER_ROOT/restore.db --operation OPERATION_ID
node scripts/local-backup.mjs reconcile --backup /absolute/BACKUP --target /absolute/TARGET --ledger /absolute/LEDGER_ROOT/restore.db --operation OPERATION_ID
```

三个使用根互为独立兄弟，ledger根不能包住备份或目标；路径必须完整绝对、逐祖先plain/realpath、普通文件单链接。产品不扫描目录猜源路径；manifest没有已绑定源绝对路径，结果诚实返回sourcePathVerified=false。备份快照/manifest均先verify，再核复制后的原bytes/SHA和strict内容；源与备份不升级、不锁杀源进程。

API为 `restoreNew({backupDir,targetDir,ledgerPath,operationId,now?})` 和同四路径参数的 `reconcileRestore`。ledger2在复制前持久目标UUID、ledger文件dev/ino与规范路径摘要绑定；同op只能同备份、同ledger和同target。ledger1保留合法旧技术ID及完整历史，只读兼容；显式 `upgradeRestoreLedger(path,{backupPath})` 先BEGIN IMMEDIATE保源，再由另一真实只读连接VACUUM INTO独占保护文件，fsync并逐行/sequence/strict1核相同后迁移；失败回滚、保保护副本，不能由业务备份冒充ledger保护。

目标在未公开partial连接内建立独立restore-control1 pending，控制UUID不冒充audit/batch实例。audit0保持缺失；audit1/2真实fork活动父、旧event/operation/receipt不重写。batch0/1不伪造源实例，batch2/3真实fork父并把新输入输出绑定disabled/path NULL；版本不盲升。batch3只使目标活动lock对应epoch安全+1并清该副本活动lock，已释放epoch保持，running stage为needs_review且attempt/证据/已成功金融不改。源PID不探杀。

关闭目标连接、checkpoint/fsync后记录转换后DB bytes/SHA与真实dev/ino；目标SHA正常不同于原snapshot SHA。receipt2固定source/target版本、组件摘要、父/新身份及pending，不含原始路径/业务金额。receipt canonical hash只存ledger，不写回DB，避免自引用。prepared持久后独占发布，完整证据才succeeded。Windows目录fsync如实unsupported，不声称目录项已耐久。

ledger成功不授业务写。默认DB/TLA、显式bank/aux/batch安装/写、锁/runner先拒restore_target_pending，目标只允许安全只读验库、查询及再次备份。control半装/未知对象/错版本拒绝，不靠缺失receipt/marker退回普通库；无public force或set-ready。reconcile实读显式receipt、ledger/file绑定、发布SHA、strict内容及源→目标允许变更与实例父链，重复succeeded仍重核，不能传恒真callback代验。无足够证据返回restore_reconcile_pending并保状态；发布后ledger终态失败返回unknown/restore_published_pending，目标/回执保全。

旧套将恢复pending历史只读与正式合成seed上的原业务正负场景分开：1130对账、683辅助后续、v3/v4迁移、封账/计提/级联、Ref-A/ref-a与四unknown注入仍真实执行；W4b才补恢复目标合法激活后的正向。三新恢复套及旧ledger套仅末尾追加总入口，原登记逐字/顺序保持；本轮不运行full/npm，具体实际exit/close与失败历史见员工交付和管理者最终验收。

恢复pending先于普通prepare/execute回调；公开JSON不能签发恢复维护能力。真实fork只在已verify、ledger2 durable started、独占目标copy后固定转换内进行，同连接/文件/control/op/ledger/backup绑定并finally撤销；audit1合法历史ID不强改UUID，旧receipt1/2与事件hash保真。
