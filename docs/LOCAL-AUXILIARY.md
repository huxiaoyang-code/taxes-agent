> **当前 W2b：29完整65独审接受，main0e新head待增量核证／PR（2026-10-24）**：BASE `0e89a2d107fd75ff18dc0998e89d96c3217baeb3`，[最新精确认领](https://github.com/huxiaoyang-code/youshu-fork/issues/54#issuecomment-6376168302)，原66／总65文件不增。五套上游补验已通过，尚未PR／合并；八任务6/8、税局真实0。当前证据与后续动作见[LOCAL06交接](handoffs/LOCAL-06-AUDIT.md)。

以下保留R4阶段说明；最新main0e与已接受的29独审状态以页头交接为准。

R4辅助四个公开写wrapper在第一次读取accountSetId前严检原options并复制，scope/request/body/refs共享安全数据，getter/Proxy无回调拒绝。旧独审仅观察到aux scope getter调用1次后拒绝且零写，未观察到aux跨账套写。四入口真实成功、13729分分配及caller事务拒绝合同已复验。

caller手工BEGIN/SP中的领域facade拒绝audit_transaction_conflict，caller事务仍在、全表零变；模型applied=false且不发localRef。公开auxTransaction自行开事务并不授领域继承能力，其自己事务可按原owner语义回滚。真实合法私有import组合、顶层dimension_invalid及真实先INSERT后SQL故障另保全部业务回滚/失败receipt；不是只把原错误替换为冲突。quarantine在新事务冲突之前检查，原raw COMMIT_BUSY和未知隔离仍保。业务requestId回放的新技术操作只增加精确no_change审计，固定技术ID重放全表零变。CLI机器信封唯一JSON，显式--operation-id须调用方运行前保存，自动ID仅最终返回，不承诺崩溃前交付。

## 2026-10-24 W2b 审计接线候选

实体创建/更新、分配替换和requirement设置均走同一同步领域审计外层；内部auxTransaction使用受控保存点，caller事务无活能力拒绝。原输入/状态/本机返回shape保留，首次entity不靠不存在的status判断成功。显式CLI仅写命令官方启用audit；entities/entries/ledger/party保持只读、不安装缺失组件、不触碰默认库。写命令可给--operation-id，机器模式在唯一正式JSON信封返回ID；重启同ID无精确原DTO时保committed并返回audit_result_unavailable，不重复写。

# B2b 真实入口候选（2026-10-23）

B2a 已随 PR70 实际验收合并，完整 head / merge / 时间及独立证据见 [交接](handoffs/LOCAL-03b.md)。本轮在该基线接通八个 origin=local 工具和 REST、增量导入附录透传、模型摘要与进程内 localRef；当前为实施自测候选，待管理验收、fresh独审和PR。无HTTP安装、任意库路径或真实税局连接。

REST 仅接受 POST `/api/account-sets/:id/auxiliary/<action>`；action为 `entities`、`entries`、`ledger`、`party`、`entity-create`、`entity-update`、`allocate`、`requirement`。对应Agent/MCP名称为 `auxiliary_entities`、`auxiliary_entries`、`auxiliary_ledger`、`auxiliary_party`、`auxiliary_entity_create`、`auxiliary_entity_update`、`auxiliary_allocate`、`auxiliary_requirement_set`。账套必须显式；正文 accountSetId / account_set_id 若出现必须规范后与路径相同，未知字段/动作拒绝，aux未安装返回aux_not_installed。四写复用同一db领域事务；entities/entries返回 `{accountSetId,items}`，其余查询保留领域DTO，写返回 `{accountSetId,result}`。业务输入与CLI同领域字段，不能以行号/名称/金额替代真实ID。

`POST /api/import/incremental`、Agent/MCP `book_import_incremental` 显式透传顶层 `auxiliaryAppendix`，不在入口二次写辅助。三数组必填、null不等于省略；新凭证raw entries逐行明确sourceEntryId，旧无映射须actualEntryId。无附录的旧aliases、默认dryRun、profile与指纹语义保留。

辅助分录摘要的借贷合计逐行复用整数分转换并用BigInt累加，安全转换及既有模型数值上限任一不满足时整份摘要拒绝，不能以浮点逐行累加或静默丢字段。独立精度P2及返修验证见交接。

辅助账簿六个totals逐一规范为安全金额并检查既有模型绝对值上限；任一不满足即整份摘要和引用拒绝，不允许sanitize静默丢closing等关键金额后成功。正负大余额及逐字段同边界/超界证据见交接。

模型仅给固定计数、状态、金额及已登记技术ID；不输出维度名码、摘要、来源/企业/批次/请求/理由或自由异常。四查询的真实明细可经同进程localRef读取；ledger可对 `groups.[].closing` 求和，entries可对 `items.[].debit` 求和。引用绑定账套/operation、到期可撤销，拒绝伪channel/local；read/compute不注册MCP工具。导入结果没有proof/实体明细，不承诺从导入ref读取不存在字段。

写入证据读取真实durability。核心idempotent_replay而auxiliary.status=applied、两层committed时确有辅助新写（即使三个Count都为0）；Count不是新增行数。dryRun明确无此次写；辅助replayed且核心回放无新增写；staged/pending_outer_commit及未知结果保守unknown、needsLocalReview。未知附录错误只给固定码，不声称已回滚或自动重试。

以下为A+B1/B2a历史说明；“入口待后续”的旧句按各时点追溯，当前能力以本节和交接为准。

# 本机辅助核算（LOCAL-03b A+B1 / B2a）

A+B1 的真实总账三维分配、领域 API、本机 JSON CLI 与官方备份恢复已随 [PR69](https://github.com/huxiaoyang-code/youshu-fork/pull/69) 验收合并。负责人 huxiaoyang-code，Refs Issue64。当前 B2a 增加领域层同事务导入附录，已自测、待管理验收与全新上下文独审；HTTP / Agent / MCP、模型投影及总测试登记留后续 B2b，不代表整个 LOCAL03 或八包已完成。

## 安装与版本

安装器 `ensureAuxiliarySchema(db, {dbPath, outDir})` 不在模块导入时建表，不接受 fresh 布尔豁免。只支持实际 core5 + bank0/1 + auxiliary1。需要银行时先安装 bank1，再安装辅助组件；当前 bank 安装器不支持在 aux 后加装银行。无 aux 的 core3/4/5 × bank0/1 仍由官方备份按原精确契约验证与恢复。旧 core 带 aux、未知 aux2、audit/batch 与其它未知组合一律拒绝；不会为安装辅助而改 core 版本或清除未知表。

安装核对实际文件路径、祖先无链接与连接路径，持有 `BEGIN IMMEDIATE` 写预留，调用真实 `createBackup → verifyBackup`，并比对源连接的结构、内容和组件摘要。备份通过后才事务创建全部 aux 表、索引与父表保护触发器，记录快照 SHA256 / 字节数。已安装重入也只读验证整个官方结构组合。备份失败或结构不支持时零 aux DDL；备份文件保留。

官方 `local-backup.mjs` 的 backup / verify / restore-new 已共同识别 aux1 精确 DDL：列 / 默认值 / NOT NULL / CHECK / PK rowid / UNIQUE、全部索引名称和键语义、FK 动作、组件及挂在核心父表上的触发器。缺失、多余或替换对象均拒绝；清单中重新计算文件哈希不能授权伪结构。恢复到新目录后仍带原辅助 ID、tuple、来源分录、回执及操作记录，可继续合法记账。

## 账簿规则

- 总账 `voucher_entries.id` 和 `opening_balances(account_set_id, code)` 是唯一金额来源。每条分配事实是一组 `(projectId?, departmentId?, partyId?)` 加借/贷整数分；一次替换整套分配，同 tuple 不重复。名称仅展示，编码和稳定 ID 识别实体，不按名称猜往来。
- 分录分配的借/贷分别不得超过真实分录。没有分配及部分分配的余量都以维度 ID 为 null 的未分配桶展示。三维存在同一行，不做多值维表笛卡尔连接。
- 期初各往来可分别有借余额与贷余额。辅助期初净额加明确的未分配净额等于总账期初净额；不错误要求辅助借贷 gross 等于总账净单侧列。例如 1200 借与 200 贷对应总账净借 1000。
- 账簿只计 posted。查询期间的 opening 是进入该月的余额，debit / credit 仅本月发生，closing 为累计余额；跨年应收和银行余额延续，不用核心累计 `period_debit` 冒充单月发生。每组同时给借余额、贷余额与真实来源 ID。
- 普通原始负金额与不足一分的非零金额拒绝；合法正数反向分录可冲减，负净余额是合法结果。没有新增负数红字格式。

## 编辑、期间与事务

反过账保留分配，再过账只计一次。有分配的凭证删除、分录金额/科目/归属/行号变更、父凭证账套/期间变化和派生凭证重算均明确拒绝 `aux_entry_reallocation_required`。用户须在开放期间用新 requestId、有理由地把分配替换为空，再走真实核心删除/重建；旧行 ID 不迁到新行。操作历史保留。

核心 `setOpeningBalances` 的同值更新跳过 DELETE+INSERT 保留分配；有分配时改变期初拒绝 `aux_opening_reallocation_required`。多科目更新中途拒绝时，整个核心保存点回滚。

分配、期初及已被引用实体的 name/active 编辑均检查当前封账、后续封账和真实后续年末结转依赖。改名保留 ID；停用不删除历史分配，不能用于新分配。`entryPartyAllocation` 同时给 `inactivePartyIds` / `partyActive`；`confirmed` 仅表示该分录完整分到唯一往来，不表示银行对手方已验证。被引用实体受 FK 限制不能删除。

只有显式 `setAuxiliaryRequirement` 配置的科目/维度会进入期末完整性阻断；历史未配置账套不因未分配而一刀切禁止结账。配置检查未分配余量、缺维度和停用引用。

写入使用同一个实际 SQLite 连接。独立调用成功返回 `durability: committed`；调用方已开事务时使用保存点，返回 `durability: pending_outer_commit`，分配状态为 `staged`，必须由调用方完成最终提交才持久化。相同 requestId 与相同规范内容只读回放；不同内容冲突，已绑定分录或分配状态变化也明确冲突。回执与本地必要操作记录在同事务落库，历史表禁止 update / delete / replace。

COMMIT_BUSY 且可确认回滚时保留原失败，不谎报成功。提交、回滚或保存点结果不明则 `aux_commit_unknown` 并隔离该连接，此连接后续 aux 读/写/安装全部拒绝 `aux_connection_quarantined`。调用方应停止操作、关闭连接，重新只读核对真实持久状态与 requestId；不能按未知结果自动重试。本包未接通用 audit/batch 安装或事务平台。

## 本机 CLI

在 `06-workbench` 目录运行；所有数据库/输入/备份路径由操作者显式给出。CLI 不 import 默认 `db.mjs`，不会先初始化或迁移未知目标。stdout 是本机明细 JSON，不是模型端安全 DTO。

```text
node scripts/local-auxiliary.mjs install --db <已有workbench.db> --out <全新安装前备份目录>
node scripts/local-auxiliary.mjs entity-create --db <已有workbench.db> --input <entity.json>
node scripts/local-auxiliary.mjs entries --db <已有workbench.db> --input <selection.json>
node scripts/local-auxiliary.mjs allocate --db <已有workbench.db> --input <allocation.json>
node scripts/local-auxiliary.mjs ledger --db <已有workbench.db> --input <query.json>
node scripts/local-auxiliary.mjs party --db <已有workbench.db> --input <entry.json>
```

实体示例：`{"accountSetId":1,"kind":"party","code":"C1","name":"客户一","requestId":"entity-C1"}`。选择示例：`{"accountSetId":1,"voucherId":1}`；必须使用 `entries` 返回的真实 `entryId`，不能自行按行号/摘要猜 ID。

分配示例：`{"accountSetId":1,"entryId":1,"allocations":[{"projectId":2,"departmentId":3,"partyId":1,"debit":400},{"projectId":2,"departmentId":4,"partyId":1,"debit":200}],"requestId":"assign-001","reason":"人工核对来源分录"}`。期初用 `openingCode` 替代 `entryId`。查询示例：`{"accountSetId":1,"period":"2025-12","code":"1122","groupBy":["party"]}`。

另有 `entities`、`entity-update`、`requirement` 命令，字段与同名领域能力一致；`entity-update` 需要 `entityId` 和 reason，`requirement` 需要 code、project/department/party 布尔值和 reason。help 列出能力。成功 exit0、拒绝 exit2，错误不回显原始账务/SQL/路径。

## 导入与银行边界

A+B1 的导入后显式绑定继续可用；B2a 在领域函数 `importIncremental` 增加可选数据参数 `auxiliaryAppendix`。未提供附录保持旧行为，原核心批次/来源/落库指纹算法不变，重放不清空分配。该参数尚未在 HTTP / Agent / MCP 透传，Issue64 保持开放。

附录严格形状为 `{version:1,requestId,reason,entities:[],entries:[],openings:[]}`；所有集合必填，未知键、重复身份、原型键、访问器、Proxy、函数及稀疏数组拒绝。实体为 `{ref,kind,code,name,existingId?}`，kind 为 project/department/party，引用已有编码时必须显式 existingId 并核同账套/种类/编码/名称/启用状态。分录为 `{sourceVoucherId,sourceEntryId,actualEntryId?,allocations:[]}`，期初为 `{openingCode,allocations:[]}`；分配元素仅含 projectRef/departmentRef/partyRef 与 debit/credit，refs 必须指本附录同类型实体。金额复用整数分、净期初与显式未分配规则。

本事务刚创建的凭证必须在 raw entries 逐行提供唯一 sourceEntryId；核实真实新凭证行数、连续行号、科目、摘要和借贷后才按本次插入顺序建立实际 entry ID 映射。旧已有/跨批去重/旧 completed 没有映射时必须显式 actualEntryId，不按行号、摘要或同金额猜配；已有映射每次核原 ID、来源登记、posted 状态与完整凭证行证据，删除重建不迁移。历史映射存在 aux1 不可变 JSON 回执中，真实分配仍依赖 SQLite FK；未改表、版本或核心 fingerprint。

aux 必须先通过真实 CLI 安装。附录预检全程零写；正式执行复用同一连接的受控事务/保存点，核心、实体、分配、映射、操作与成功回执一起提交。completed 有附录也进入事务重核来源与映射。相同键/内容/现态只读重放，内容或现态变化冲突；不同请求只允许增加尚未分配目标，不能覆盖人工分配。内部请求使用确定性命名空间并核完整原键，人工回执碰撞明确冲突。

只有最终 COMMIT 确认后才返回 committed；调用方已有事务返回 staged / pending_outer_commit，不能当成已持久化。未知 BEGIN/COMMIT/ROLLBACK/RELEASE 结果返回 aux_commit_unknown，隔离连接且不自动重试、不追加 failed 审计；调用方关闭连接后核查持久回执。可确认回滚才允许保留原合法 failed 审计，已 completed 永不覆写。附录异常使用固定错误码，未知执行错误为 aux_import_failed，锁竞争为 aux_import_busy。

银行先按真实日期/金额候选及人工确认匹配，然后用同一个 entryId 调用 `entryPartyAllocation`。无往来为 unknown；多往来或部分往来为 ambiguous；完整唯一为 confirmed，同时明示停用状态。不会从银行摘要/名称/金额推断往来，不改原银行指纹、不生成调整分录。

## 验证

显式执行 `node test/auxiliary-storage.test.mjs`、`auxiliary-accounting.test.mjs`、`auxiliary-cli.test.mjs`、`auxiliary-core-integration.test.mjs`、`auxiliary-backup-integration.test.mjs`、`auxiliary-bank-integration.test.mjs`。每套只用新 UUID workspace 合成根，导入核心前设环境，保留新套件现场，child 等 close。

B2a 定向命令另加 `node test/auxiliary-import.test.mjs`，53个检查及6个真实child均通过，含CLI安装、官方backup/verify/restore后映射回放及续写、四类未知事务隔离；定向旧回归与权限失败历史见 [交接](handoffs/LOCAL-03b.md)。未运行本段完整总入口。

两准则独立手算：小企业 AR 期初1000、12月1400、次年1月800；银行9000→9400→9900；12月借余额1700/贷余额300，往来C1=1500/C2=-300，1月借发生0/贷发生600。企业准则全部金额双倍。另验草稿/反过账/重过账、三维拆分、核心变更阻断与真实重算回滚、直接SQL跨账套/错类型/父变更、两连接锁、未知事务状态隔离、官方WAL备份恢复与伪结构拒绝，以及银行两准则1130调节闭环。
