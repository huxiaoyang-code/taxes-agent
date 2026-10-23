> **当前 W2b：根必要验收已通过，待最终fresh/PR（2026-10-24）**：BASE `35bd8e53c703cdafa5989ba0df8e35fb7924e258`，[Issue54精确66路径](https://github.com/huxiaoyang-code/youshu-fork/issues/54#issuecomment-6374636679)，实际65文件。root机械独立核对同65候选及完整WB/MCP源码/依赖，必要定点最终50/50（R1实绿36＋R2原14红短根复验全0），R3四真实独立probe全actual0/close、源前后同；包括最终领域21组及跨企真实渲染区间。未新跑完整97通过：旧97仍73/24/exit1，旧native134原因未知。R1部分原套finally自行删除夹具目录，数量未知，日志/result保留；短根实测输出目录67字符成功verify、224字符snapshot_failed，源全行保持，建议短路径，不推断全局阈值或具体journal原因。候选commit、最终fresh独审、PR/merge均未发生；仅本次docs收口，52非docs字节不改，不重50。原八包6/8、LOCAL06/07、W3b/W4、Windows与最终链继续未完成，税局真实0，同库多企业/每企唯一账套不要求独立目录。下方各旧候选/待验收记录按历史时点阅读。 root50＋4证据实际在6465及相同52份非docs字节上验收；root已快进35bd并核65WIP字节全同、9上游文件无66交叉，35bd独立上游由root按影响补验VAT/XLSX/accountant-review三套。

本机REST/raw的普通银行错误维持固定安全码；bank_local_operation_failed投影仅转移原Error身份已有的WeakMap真实证据，不能伪造authority/applied，不回显银行原文。真实audit_*协议码保持。CLI成功/错误机器输出各为唯一JSON，均携operationId与真proof；可靠丢响应重试须预存显式--operation-id，text可早显示文本。MCP元数据精确可选operationId，不扩draftRef/审批/TTL/scope输入权限。当前修复实际通过原银行HTTP、MCP与CLI，不以这些冒称页面paste/filechooser实操或外部银行接入。

## 2026-10-24 W2b 审计接线候选

register/import/resolve/confirm/cancel/reconcile和transactions/candidates/matches/status的真实refresh统一拥有审计outer；内部组合保原银行rollback/quarantine。无真实写的查询记no_change，same-file-new-batch因真实追踪写入记实际变化，不因truthy replayKind笼统记no_change。刷新真正失效后通知输出策略撤销该套银行引用。原失败批次/attempt累计保留：确认外层rollback后，固定失败字段与全局失败终态同COMMIT；未知rollback不写，不覆写completed/pending_review。

本机prepare银行draft时生成稳定技术operationId；原preview→明确approve→执行与TTL/撤销/账套门保留。无显式HTTP ID时响应header等于draft/真实receipt ID；显式ID冲突拒绝（包含已完成缓存重放），draftRef不持久化。CLI写命令及refresh查询启动时官方启用audit，支持--operation-id，机器模式仅在唯一结果或错误JSON中返回ID；真正只读命令不安装缺失组件。仅statementOpenCents/statementCloseCents两个已允许BigInt请求字段规范投影十进制cents串，原金额算法/DTO不变，任意其他BigInt仍拒。

## LOCAL04B 银行入口与受控模型输入（2026-10-23 实施候选）

本机单用户，同一数据库可有多家企业、每家唯一账套；不要求每企一个目录。当前只有本机CSV能力，外部银行与真实税局接入仍为0。A的银行领域/storage/CLI、aux、备份和核心本轮只读，沿PR73已合并DTO。往来分配只展示，不参与匹配依据、snapshot或失效判定。

本机明确启用/首次准备草稿时，先校验输入与账套，再从已打开连接的main库事实取得dbPath与目录，固定调用官方LOCAL06备份门槛及ensureBankSchema。非法tool/字段/缺必需项不会先做组件DDL；模型查询不安装组件。

本机支持接口只收JSON，复用回环/Host/Origin保护：

- POST /api/account-sets/:id/bank-drafts，body为{tool,payload,confirm?}，可选顶层accountSetId须等于路径。写类必须由本机明确确认传confirm:true；正式bank_import不能在此直接准备。
- POST /api/account-sets/:id/bank-drafts/approve-import，body仅{previewRef}。真实bank_import_preview成功后，用户点确认导入才按同份不可变payload派生bank_import草稿；不能附CSV/mapping或伪approved替换。
- POST /api/account-sets/:id/bank-drafts/revoke，body仅{draftRef}；非执行中立即释放记录和预算，执行中只撤销可再次调用的权利，不回滚已发出的业务。
- 业务POST /api/account-sets/:id/bank/:action只收{draftRef}。raw Agent和MCP工具都只收{accountSetId,draftRef}，拒额外字段、别套、别工具、finref冒充与过期引用。

草稿是bankdraft_加48位随机十六进制字符，绑定账套、工具、不可变内容hash和10分钟TTL，仅进程内存；不接受任意路径/URL/模块、local/raw/channel权限声明、访问器或原型键。最多32项，单payload UTF8 JSON为2MiB，总payload加已缓存结果为16MiB，不持久化；已执行写的结果若放不下缓存，首次仍返回真实提交结果，后续固定bank_draft_result_unavailable并禁止重执行。普通query在TTL内每次真实读取；write原子prepared→executing→completed，重复只回放，执行异常置unknown并禁止重试。重启即失效，日志不记录payload/ref/原始异常。

|action|tool|分类|
|---|---|---|
|accounts|bank_accounts|query|
|account-register|bank_account_register|write|
|import-preview|bank_import_preview|query|
|import|bank_import|write|
|batches|bank_batches|query|
|transactions|bank_transactions|query|
|ambiguities|bank_ambiguities|query|
|ambiguity-resolve|bank_ambiguity_resolve|write|
|candidates|bank_candidates|query|
|confirm|bank_confirm|write|
|cancel|bank_cancel|write|
|matches|bank_matches|query|
|reconcile|bank_reconcile|write|
|status|bank_status|query|
|audit|bank_audit|query|

本机raw/REST返回{accountSetId,result,evidence?}完整DTO，允许操作者看账户/CSV预检/批次/理由/往来等本机原文；这不是模型输出协议。模型走adapter→policy→transport白名单信封：只包含固定状态、期间、计数、必要数值ID和受控金额；不回声CSV、名称、账号、bankAccountId/sourceId/batchId、科目编码、文件名/路径、reason/note、message/details/stack或输入draftRef。结果finref仍绑定账套+operation：模型resolve只取同一摘要，本机read/compute可读完整DTO并做既有有界运算；未扩channel或本机读取权限，也没有新增draft MCP工具或raw fallback。

六写必须结合真实DTO与内部committed/performed/replayed证据。same-batch/same-batch-pending不新写，same-file-new-batch仍新增批次/追踪/审计，不能按replay布尔直接反转。bank_reconcile实际保存run/audit，属于write。transactions/candidates/matches/status查询可能refresh并持久化失效及审计，query是目的分类，不是无写承诺。提交后投影或finref失败保留applied事实并needsLocalReview；运输响应损坏/断连只报unknown且不自动重试。

所有Cents全份检查安全整数和金额上限，再转换元输出；任一越界字段拒绝整份查询摘要/引用，不能静默drop却ok/ref。往来仅给notInstalled/unknown/ambiguous/confirmed/inactive/unavailable固定计数；完整partyAllocation只在本机DTO。

页面银行tab有显式启用/登记、账户/期间、CSV文件/粘贴统一文本、JSON映射→预检→确认导入，人工same/distinct、候选逐行确认/取消、显式日期偏差支持跨期、四类未达及余额差额。动态内容用textContent/DOM节点；编辑、换账户/换套撤销草稿、清旧选择/余额，并以账套+代次拒绝旧异步响应。2MiB是新页面/草稿输入上限，原领域/CLI5MiB边界保持。本轮没有CUA/CDP/filechooser操作，页面paste与实际file选择器均未知；静态合同与同HTTP真链是分开的证据。

下方旧阶段叙述保留历史时点；与本节冲突时以本节及最新交接为准。

> 2026-10-23 LOCAL04A候选：银行候选与匹配新增当前账务`partyAllocation`展示（unknown/ambiguous/confirmed、active信息、完整分配与scope），不作为银行对方证明、不自动匹配、不改变snapshot或辅助变更失效合同。未安装固定not_installed，分录删除固定entry_unavailable；已装损坏/未知辅助组件明确拒绝。现库银行安装允许core5+唯一auxiliary@1，固定官方快照verify与持锁源content/components绑定后才DDL。两安装序、真实CLI两profile/历史legacy独立1130、联合restore续写及六正式套已自测通过；字段、错误、证据与限制以[LOCAL04A交接](handoffs/LOCAL-04-BANK.md)为准。REST/页面/MCP接线留B，本A未独立验收/合并，不代表整04完成。以下旧章节按历史时点追溯。

> **2026-10-23 最终出版候选补记（优先于下方历史阶段）**：银行源修复候选冻结为 `a38b2815d353c1f5749c5c3081ec6bdbd180ace0`，员工定向150/150 exit0（import16 / reconciliation43 / CLI14 / integration5 / backup22 / 07 persistence39 / CLI11），root源修复定向43/43+14/14 exit0。本窗口以实际main原61逐字原序保留，仅末尾追加银行4套，静态登记65；**最终全65、fresh独审与PR63合并仍待root，PR63仍Draft**。只是LOCAL04银行CLI组件候选，profile / 辅助实际入口与UI整合未完。
>
> 创建保护：O_EXCL保留创建fd、私有不可变receipt / marker身份与seed，SQLite打开前文件对象预检；真实连接hook在核心DDL / WAL / migration前见证，银行安装拒绝未见证连接。已有库仍须备份并验证；调用方BEGIN拒绝保留回执，确认提交后消费，银行release使用 `preserveDatabase` 保留库文件。通用guard仅复用已审Windows / Node24边界，不承诺绝对抗恶意同进程 / 物理伪造或Linux保护。旧core3 P1替换场景确有核心pre-v4备份；旧95/60绿测不覆盖后来fresh P1，原红与环境失败按下文原文保留。源码9路径冻结，本轮只登记与文档、未重跑财务套件、未自审、无Git写。

# 银行流水与持久对账契约 · LOCAL-BANK（LOCAL-04 交付）

状态：**实施 + 首轮独立审查 5 项阻塞修复 + 结构契约复审收敛修复 + A 窗独审 2 项 P2 回修（索引键语义 / 回滚失败状态）+ 第二轮独审 P2（事务冲突 / 未开始 vs 已确认回滚）已完成，且银行 A 最终 `950b7d6` 的独立复审已被 root 记录接受；随后 B 窗已同步实际 main 并补齐备份侧银行组件索引键语义，自测完成，待 root 冻结 / 独立复审 / Git 收尾**；本轮不声称最终已通过，也不写「已提交 / PR 已建 / 已合 / 最终通过」。B 窗工作区 HEAD 以实际 Git 为准（含 PR #60 merge `dfefae0` 的核心备份契约）；A 窗回修基线 `06d1bd185f68ea4f3c49f20e6cf98f6cdce613a2`、第二轮基线 `c8f490c6b4d4e0f4bdaa9acf378defa900334e80`；上一轮返工基线 `46e0fc0ecb74703cc8482aab9a1cf3f85839f232`；上一轮阻塞审查基线 `e2545216226b87262508d8a94f38426415670d8c`。

B 窗（2026-10-22）已按 root 正式开窗与远端 Issue #53 / #49 的 13 文件 claim 实施：在 `server/local-backup.mjs` /
`server/bank-storage.mjs` 打通银行组件**全部 19 条索引的逐键语义**（`seqno` / collation / 方向 / 表达式 / rowid /
`origin` / `partial` / 真实谓词，外加主键 `rowidAlias` 与复合主键），`create` / `verify` / `restore-new` 三入口一致拒绝；
原先集成用例里「备份层仍漏验、仍然放行」的断言已改为**拒绝**，并补三入口反例与健康恢复。
本窗仍**未**接 HTTP / Agent / MCP / UI，也**未**跑全量套件（代码只改备份 / 银行契约与文档；完整 suite 由 root 冻结后执行）。
`scripts/test-all.mjs` 的四个银行套件登记仍由 root 后续独立短窗完成，本窗未改。
- 远端载体：[Issue #53](https://github.com/huxiaoyang-code/youshu-fork/issues/53)（`Refs #20` / `Refs #13`）
- 基线：`257f96275031eefa484699dd71bd012e2d221e51`（含已审 PR #52 导出模块、PR #50 输出策略模块）
- 分支：`codex/huxiaoyang-code/local-04-bank`；工作区：`.worktrees/local-04-bank`
- 任务单：[tasks/LOCAL-04-BANK](tasks/LOCAL-04-BANK.md) · 交接：[handoffs/LOCAL-04-BANK](handoffs/LOCAL-04-BANK.md)

本包只新增 10 个文件（4 个实现 + 3 个测试 + 3 个文档），**未修改**共享文件
（`accounting.mjs` / `db.mjs` / `import-storage.mjs` / `coa.mjs` / `server.mjs` / `agent-tools.mjs` /
MCP / `scripts/test-all.mjs` / `package.json` / 锁文件 / `public/*` / 共享 STATE / 索引 / 其他 docs）。

## 1. 为什么需要这一层

本机操作者需要把银行对账单变成**可核对、可追溯、可重放**的本地数据：

- 银行账户**不是第二本账套**：一个银行账户属于一个账套，绑定该账套里一个明确、有效、可独立归属的银行存款叶子科目；
- 流水导入必须能安全重试（同批同内容幂等、同文件重导不增流水），也必须**优先不误吞**：
  没有银行稳定流水 ID 时，相同日期 / 金额 / 摘要只是**疑似重复**，不得自动合并；
- 银行流水与账务分录的匹配是**人工确认**的结果，不是自动对账；候选必须来自当前真实的 posted 凭证分录；
- 余额调节以真实期初 + 截止日全部历史 posted 银行分录为账面口径，对账单期初 / 期末由操作者显式提供，
  四类未达项与调节后余额必须逐项可追溯，差额不得用「调整项」凑平。

本版本不接银行网站 / 银行 API，不新增任何凭据服务，不生成或修改账务凭证。

## 2. 边界与产品口径

- 本机单用户；一家企业一个账套，多企业批量 = 多账套；银行账户只是账套内的辅助标识。
- 首版只支持 **CNY（分）**：不猜外币、不换汇、不把同科目下多个银行账户推断为可区分。
- 账套 / 银行账户 / 币种 / 日期窗口 / 账务期间必须**同时显式声明**；任何跨账套引用都拒绝。
- 银行账号 / 名称只是本地字段，**不能当企业身份**。
- 不自动改 `periods` 状态；银行侧「已对平」不等于账务可结账。
- 不生成、修改、删除任何 `vouchers` / `voucher_entries` / `opening_balances` / `periods` 数据。

## 3. 实现文件与职责

| 文件 | 职责 |
|---|---|
| `06-workbench/server/bank-import.mjs` | 纯函数：CSV 解析、字段映射校验、日期 / 金额 / 方向规范化、预检、指纹与限制。**无数据库副作用**。 |
| `06-workbench/server/bank-storage.mjs` | `bank_*` 独立命名空间、组件版本 `bank_component_migrations`、结构契约 `BANK_SCHEMA_CONTRACT` / `BANK_COMPONENT_STRUCTURE` / `bankSchemaContract` / `assertBankSchemaReady`、迁移前真实备份门槛（全新子目录 + 严格字段 + `BEGIN IMMEDIATE` 排他安装）、创建事实回执、CRUD / 审计 / 对账运行记录；以及内部完整判定用的键集游标扫描与 SQL 聚合（展示分页 API 与内部 API 严格分开）。 |
| `06-workbench/server/bank-reconciliation.mjs` | 账户登记、导入落库（单事务）、批次 / 流水 / 歧义查询、候选、确认 / 取消、读时失效核验、余额调节、状态汇总。 |
| `06-workbench/scripts/bank-reconcile.mjs` | 本机 CLI：显式 `--db`、JSON / text 输出、稳定错误码与退出码；`init-db` 使用产品真实建库入口创建新库。 |

三个模块都**不 import** `db.mjs` / `accounting.mjs`：数据库连接由调用方显式注入，导入模块不会打开默认库、
不会触发 LOCAL-01 / LOCAL-02 的全局迁移。账务数据一律按当前已核实结构只读查询。

## 4. 数据模型（组件 schema v1）

| 表 | 作用 | 关键约束 |
|---|---|---|
| `bank_component_migrations` | 组件版本 | `version INTEGER PRIMARY KEY`；只写本表，不写 `schema_migrations` / `schema_backups` / `PRAGMA user_version` |
| `bank_component_backups` | 组件迁移前备份证据 | 记录备份位置、字节数、完整性、创建原因（`existing-database` / `component-upgrade`） |
| `bank_accounts` | 银行账户登记 | PK `(account_set_id, bank_account_id)`；`UNIQUE(account_set_id, gl_account_code)` 保证一个叶子科目不被两个不可区分账户并行绑定；`currency` 目前固定 `CNY` |
| `bank_batches` | 批次身份与结果 | PK `(account_set_id, bank_account_id, batch_id)`；`content_sha256`（整份文件）、`mapping_fingerprint`、`normalization_version`、`period`、`source_id`、`status`、`attempts`、`replay_of_batch` |
| `bank_transactions` | 文件中的已确认流水行 | 有稳定 ID 时 `UNIQUE(account_set_id, bank_account_id, source_id, bank_ref_id)`（部分索引）；`UNIQUE(account_set_id, bank_account_id, batch_id, row_index)`；`content_fingerprint` + `row_fingerprint` |
| `bank_batch_rows` | 批次逐行追踪 | `UNIQUE(account_set_id, bank_account_id, batch_id, row_index)`；行状态 `imported` / `duplicate_reused` / `replayed` / `ambiguity_pending` / `ambiguity_resolved_same` / `ambiguity_resolved_distinct` |
| `bank_ambiguities` | 无稳定 ID 的疑似重复证据 | `UNIQUE(account_set_id, bank_account_id, batch_id, row_index)`；`candidate_transaction_ids` 保留候选证据；`status` / `decision` / `decision_reason` / `resolved_transaction_id` |
| `bank_matches` | 人工确认 / 取消 / 失效的匹配记录 | 部分唯一索引 `UNIQUE(transaction_id) WHERE status='confirmed'`、`UNIQUE(account_set_id, entry_id) WHERE status='confirmed'`：数据库级禁止双重占用；`snapshot_json` 保存确认时账务快照 |
| `bank_audit_events` | append-only 审计 | **无级联外键**：账套 / 账户 / 批次被业务删除后审计证据仍保留 |
| `bank_reconcile_runs` | 每次余额调节的运行记录 | 记录状态、账面 / 银行截止余额、调节后余额、差额、结果摘要、`stale` 标记 |

银行账户 / 批次 / 流水 / 逐行记录 / 歧义之间有外键（`ON DELETE CASCADE` 跟随账套删除）；
`bank_matches.transaction_id` 与 `bank_ambiguities.resolved_transaction_id` 使用 `ON DELETE SET NULL`，
快照字段保留原值，避免业务删除把匹配证据连带抹掉。

### 4.1 组件结构契约（v1，供备份 / 恢复与后续接线核对）

组件结构以代码常量 `BANK_SCHEMA_CONTRACT`（`server/bank-storage.mjs`）为唯一权威，并由
`bankSchemaContract(db)` 只读核对。**本节列出的列名 / 类型 / NOT NULL / 默认值 / 主键与 `rowidAlias` /
UNIQUE / 索引签名与逐键 `keys`（collation / 方向 / 表达式 / rowid）/ `origin` / 实际 `WHERE` 谓词 /
外键完整集合与动作 = 运行时真实门槛**；LOCAL-06 备份组合使用同一权威派生的
`BANK_COMPONENT_STRUCTURE`（列规范 + `primaryKey` / `rowidAlias` + **对象形状**的 `unique` 契约 +
全量 `indexes` + 外键动作 + 空触发器 / 视图集合），不要另行猜测结构。
B 窗（2026-10-22）起备份验证器也**逐键**读取这些 `keys` / `origin` / `partial` 与真实谓词，
并把 `INTEGER PRIMARY KEY` 的 rowid 别名语义与复合主键自动索引纳入同一套对象模型；
不再只比列名，也不因“是组件”而动态放松。

版本：`BANK_SCHEMA_VERSION = 1`；`bank_component_migrations` 必须**有且只有一行 `version = 1`**。
本版本**没有 v2 迁移**，也不伪造 v2。

| 表 | 列（按 DDL 顺序） | 主键 |
|---|---|---|
| `bank_component_migrations` | `version, applied_at, note` | `version` |
| `bank_component_backups` | `id, version, path, bytes, integrity, created_at, note` | `id` |
| `bank_accounts` | `account_set_id, bank_account_id, source_id, currency, gl_account_code, display_name, bank_account_no, created_at` | `(account_set_id, bank_account_id)` |
| `bank_batches` | `account_set_id, bank_account_id, source_id, batch_id, currency, period, content_sha256, mapping_fingerprint, normalization_version, status, row_count, imported_rows, reused_rows, ambiguous_rows, attempts, replay_of_batch, result_json, error_code, error_message, created_at, updated_at` | `(account_set_id, bank_account_id, batch_id)` |
| `bank_transactions` | `id, account_set_id, bank_account_id, source_id, currency, txn_date, period, direction, amount_cents, summary, bank_ref_id, balance_after_cents, content_fingerprint, row_fingerprint, batch_id, row_index, origin, created_at` | `id` |
| `bank_batch_rows` | `id, account_set_id, bank_account_id, batch_id, row_index, row_sha256, row_fingerprint, status, transaction_id, ambiguity_id, note, created_at` | `id` |
| `bank_ambiguities` | `id, account_set_id, bank_account_id, source_id, batch_id, row_index, txn_date, period, direction, amount_cents, summary, currency, row_fingerprint, content_fingerprint, batch_row_sha256, candidate_transaction_ids, status, decision, decision_reason, resolved_transaction_id, resolved_at, created_at` | `id` |
| `bank_matches` | `id, account_set_id, bank_account_id, currency, transaction_id, voucher_id, entry_id, entry_line_no, status, snapshot_json, reason, confirmed_at, cancelled_at, cancel_reason, invalidated_at, invalidation_reason` | `id` |
| `bank_audit_events` | `id, account_set_id, bank_account_id, event_type, subject_type, subject_id, detail_json, created_at` | `id` |
| `bank_reconcile_runs` | `id, account_set_id, bank_account_id, currency, period, as_of, status, book_close_cents, adjusted_book_cents, statement_close_cents, adjusted_bank_cents, difference_cents, result_json, stale, stale_reason, created_at` | `id` |

索引与 UNIQUE（`unique` / `partial` 均参与核对；无名字的项是表级 UNIQUE 约束生成的自动索引）：

部分索引除了同名 / 同列 / 同 `unique` / 同 `partial`，还必须与表中写明的 `WHERE` 谓词一致：
`sqlite_master.sql` 中的实际谓词会被规范化（删除字面量外空白、统一引号标识符大小写、剥外层括号，
**保留字符串字面量大小写**）后与契约谓词**整体比对**；不做宽泛 substring 判断。因此
`WHERE status='cancelled'`、`WHERE status <> 'confirmed'`、`WHERE bank_ref_id IS NOT NULL AND 1=1`
都会在同名同列同 UNIQUE/partial 的情况下被拒绝，而产品实际 DDL 的空白 / 引号写法差异不会误判。

| 表 | 索引 / 约束 | 列 | unique | partial |
|---|---|---|---|---|
| `bank_accounts` | `idx_bank_accounts_gl` | `(account_set_id, gl_account_code)` | 是 | 否 |
| `bank_accounts` | `idx_bank_accounts_source` | `(account_set_id, source_id)` | 否 | 否 |
| `bank_accounts` | 主键自动索引 | `(account_set_id, bank_account_id)` | 是 | 否 |
| `bank_batches` | `idx_bank_batches_file` | `(account_set_id, bank_account_id, source_id, content_sha256)` | 否 | 否 |
| `bank_batches` | `idx_bank_batches_status` | `(account_set_id, bank_account_id, status)` | 否 | 否 |
| `bank_batches` | 主键自动索引 | `(account_set_id, bank_account_id, batch_id)` | 是 | 否 |
| `bank_transactions` | `idx_bank_txn_ref` | `(account_set_id, bank_account_id, source_id, bank_ref_id)` | 是 | 是 |
| `bank_transactions` | `idx_bank_txn_batch_row` | `(account_set_id, bank_account_id, batch_id, row_index)` | 是 | 否 |
| `bank_transactions` | `idx_bank_txn_scope_date` | `(account_set_id, bank_account_id, txn_date)` | 否 | 否 |
| `bank_transactions` | `idx_bank_txn_fingerprint` | `(account_set_id, bank_account_id, source_id, row_fingerprint)` | 否 | 否 |
| `bank_batch_rows` | `idx_bank_batch_rows_txn` | `(transaction_id)` | 否 | 否 |
| `bank_batch_rows` | `UNIQUE(account_set_id, bank_account_id, batch_id, row_index)` | 同左 | 是 | 否 |
| `bank_ambiguities` | `idx_bank_ambiguities_status` | `(account_set_id, bank_account_id, status)` | 否 | 否 |
| `bank_ambiguities` | `UNIQUE(account_set_id, bank_account_id, batch_id, row_index)` | 同左 | 是 | 否 |
| `bank_matches` | `idx_bank_matches_active_txn` | `(transaction_id)`（`WHERE status='confirmed'`） | 是 | 是 |
| `bank_matches` | `idx_bank_matches_active_entry` | `(account_set_id, entry_id)`（`WHERE status='confirmed'`） | 是 | 是 |
| `bank_matches` | `idx_bank_matches_scope` | `(account_set_id, bank_account_id, status)` | 否 | 否 |
| `bank_audit_events` | `idx_bank_audit_scope` | `(account_set_id, bank_account_id, event_type)` | 否 | 否 |
| `bank_reconcile_runs` | `idx_bank_reconcile_scope` | `(account_set_id, bank_account_id, period, as_of)` | 否 | 否 |

外键（列顺序 + 目标列 + `ON DELETE` / `ON UPDATE` 动作都参与核对）：

外键按表比较**完整集合**（多重集，不按目标表去重）：缺必需项给 `bank_schema_foreign_key_missing`，
额外 / 重复 / 动作不符的约束给 `bank_schema_foreign_key_unexpected`。契约未列出外键的表
（含 `bank_audit_events` / `bank_reconcile_runs`）实际也**必须没有外键**，不能在审计 / 运行记录表上
加 `REFERENCES account_sets(id) ON DELETE CASCADE` 来改变真实删除行为。

| 表 | 列 | → 目标 | ON DELETE |
|---|---|---|---|
| `bank_accounts` | `account_set_id` | `account_sets(id)` | CASCADE |
| `bank_batches` | `(account_set_id, bank_account_id)` | `bank_accounts(account_set_id, bank_account_id)` | CASCADE |
| `bank_transactions` | `(account_set_id, bank_account_id)` | `bank_accounts(account_set_id, bank_account_id)` | CASCADE |
| `bank_transactions` | `(account_set_id, bank_account_id, batch_id)` | `bank_batches(account_set_id, bank_account_id, batch_id)` | CASCADE |
| `bank_batch_rows` | `transaction_id` | `bank_transactions(id)` | SET NULL |
| `bank_batch_rows` | `(account_set_id, bank_account_id, batch_id)` | `bank_batches(...)` | CASCADE |
| `bank_ambiguities` | `resolved_transaction_id` | `bank_transactions(id)` | SET NULL |
| `bank_ambiguities` | `(account_set_id, bank_account_id, batch_id)` | `bank_batches(...)` | CASCADE |
| `bank_matches` | `transaction_id` | `bank_transactions(id)` | SET NULL |

`bank_audit_events` / `bank_reconcile_runs` **没有外键**（审计证据与运行记录不随业务删除消失）；
契约按表比较完整外键集合，所以给这两张表加任何额外外键都会被结构化拒绝。

## 5. 账户与科目合同

登记请求：`accountSetId`、`bankAccountId`、`sourceId`、`glAccountCode`、`currency`（缺省 CNY）、
可选 `displayName` / `bankAccountNo`。

- `bankAccountId` / `sourceId` 是本组件在账套内的稳定标识（`^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$`）。
- `glAccountCode` 必须是该账套内**存在**、**叶子**（`is_leaf=1` 且没有子科目）、**资产类借方**、
  且属于 `1002` 银行存款或其显式明细科目（`1002xxxx`）。父科目含多账户时必须显式选择明细；无法区分则拒绝。
- 同一账套同一 `glAccountCode` 只允许一个银行账户；同一 `bankAccountId` 的绑定不允许静默改写
  （`bank_account_conflict`）；完全相同的重复登记幂等返回。
- 同一个 `bankAccountId` 出现在不同账套是**不同范围**，互不影响。
- 每次解析范围都会重新校验科目仍存在、仍是叶子、仍是银行存款科目，账套 / 账户 / 币种三者必须一致。

## 6. CSV 与字段映射

限制（`BANK_CSV_LIMITS`）：`maxBytes = 5 MiB`、`maxRows = 20000`、`maxColumns = 40`、
`maxFieldChars = 4096`、`maxErrors = 200`、`summaryMaxChars = 200`、`refIdMaxChars = 64`。

CSV 解析：UTF-8 BOM、CRLF / LF / CR、引号包裹、`""` 转义、字段内逗号与换行；重复 / 空表头、
未闭合引号、字段中途引号、引号后杂字符、字段过多、超限都返回结构化错误（含行号 / 起始行）。

映射（JSON）关键字段：

```json
{
  "columns": { "date": "交易日期", "summary": "摘要", "amount": "金额", "direction": "收付",
                "refId": "流水号", "currency": "币种", "balance": "余额" },
  "amountMode": "amount_direction",
  "directionLabels": { "inflow": ["收", "收入"], "outflow": ["付", "支出"] },
  "dateFormat": "YYYY-MM-DD",
  "currency": "CNY",
  "thousandsSeparator": ",",
  "allowCurrencySymbol": false,
  "negativeAmount": "reject",
  "ignoreBlankRows": true
}
```

- 两种模式：`debit_credit`（借 / 贷两列）与 `amount_direction`（金额 + 收付方向）。
- 业务方向统一企业视角：`inflow` = 银行余额增加 = 银行存款借方；`outflow` = 银行余额减少 = 贷方。
  银行原文件的借贷含义必须由映射确认，不按列名 / 符号 / 顺序猜。
- 日期：`YYYY-MM-DD` / `YYYY/MM/DD` / `YYYYMMDD` 三选一，必须显式声明；真实日历校验；
  行日期必须落在本次声明的账务期间（`YYYY-MM`）内；不做时区换算。
- 金额：必须规范化为安全整数分，上限 99,999,999,999,999 分；拒绝指数写法、多个小数点、混杂文本、
  `NaN` / `Infinity`、未声明千分位时含逗号、超过两位小数、超界、负数（除非 `amount_direction` 模式且
  `negativeAmount: "reverse_direction"` 显式声明才翻转方向）。空值（未提供）与显式 `0` 有区别：
  借 / 贷模式下两列都为空或 0 视为「本行没有发生额」而拒绝；整行有一个非零发生额才有效。
- 币种：无币种列时必须在映射里显式声明 `CNY`；有币种列时逐行必须是 `CNY`，否则拒绝。
- 余额列可选，允许负数（透支）；只保存为 `balance_after_cents`，不据此推断方向或对账平衡。
- 银行稳定流水 ID 可缺；有值时只能由映射显式指定列。**同一文件内重复的稳定 ID 直接拒绝**
  （无法判断哪一行才是该 ID 的规范内容）。
- 摘要超长拒绝（不截断），流水 ID 字符 / 长度非法拒绝。

**预检（`import-preview`）与正式导入共用同一套规范化规则**，预检只读、不写任何表。

错误列表**总条数上限 = `maxErrors = 200`**：CSV 解析、缺列、期间、行级规范化、文件内重复流水号
**共用同一个上限**；超过只置 `errorsTruncated = true`，不抛异常、不无限增长，也不因截断把有错误的文件
报成 `ok:true`（修复前 201 行非法金额会抛 `Assignment to constant variable.`，已回归）。

## 7. 批次身份、幂等与去重

批次身份 = `accountSetId + bankAccountId + sourceId + batchId + 文件内容摘要 + 映射指纹 + 规范化版本 + period`。

| 场景 | 行为 |
|---|---|
| 同 `batchId` + 同内容 + 同映射 + 同期间 | 直接回放，不新增流水（`replayKind: same-batch`），不修改批次记录 |
| 同 `batchId` 但内容 / 映射 / 来源 / 期间变化 | `batch_content_conflict`，已完成批次不被覆盖 |
| 同文件（同内容摘要 + 同映射）用新 `batchId` | 识别为已完成来源：新建批次记录 + 逐行 `replayed` 追踪到既有流水，**不新增流水**；已完成批次 → 回放批次 `completed`，待判定批次 → 回放批次 `pending_review` |
| 失败批次用同一 `batchId` 修正后重试 | 允许：失败批次的业务事务已整体回滚、没有半笔流水，先删除失败记录再重跑；尝试次数保留 |
| 有稳定 ID、规范内容相同 | 逐行 `duplicate_reused`，不新增流水 |
| 有稳定 ID、规范内容变化 | `source_transaction_content_changed`，整批回滚，不覆盖既有流水 |
| 无稳定 ID、同特征流水已存在（本批之前） | 保存到 `bank_ambiguities`（`pending`），该行**不进入已确认流水**；批次转 `pending_review` |
| 无稳定 ID、同一文件内两条完全相同的记录 | **两笔都保留**（可能是两笔交易）；文件内重复不触发歧义 |
| 无稳定 ID、不同文件交叠窗口 | 只把**本批之前已存在**的同特征流水作为候选证据，逐行等待人工判定 |

无稳定 ID 时 `row_fingerprint = sha256(date|direction|amountCents|summary)` 只是**疑似重复信号**，
绝不作为可靠唯一标识；稳定 ID 的唯一键为 `(accountSetId, bankAccountId, sourceId, bankRefId)`，
**同一 ID 在不同来源命名空间是不同流水**（跨来源不合并、不互相去重）。

人工判定（`resolve-ambiguity`）：

- `decision=same`：必须显式给 `--transaction <id>`（或候选唯一时自动取唯一候选），关联到既有流水，不新增；
- `decision=distinct`：新增一笔流水，保留来源行证据；
- 必须给理由；已判定的同一决定幂等返回，改判给 `ambiguity_already_resolved`；
- 批次内所有歧义判定完成后，`pending_review` → `completed`；未判定完成前批次**不会被伪报 complete**。

整批事务：任何行级错误、内容冲突或数据库错误都整体回滚，不留半笔流水 / 半行记录 / 半条匹配；
失败审计在独立事务写入（`markBatchFailed`），且**不覆写已完成批次**；失败审计本身失败时调用方如实返回。

## 8. 候选与人工匹配

候选来源：同一真实库内 `vouchers.status='posted'` 且分录科目 = 登记账户绑定科目的
`voucher_entries`，以 `voucher_id + entry_id + line_no` 标识。草稿不参与。

- 金额与方向必须与流水**完全一致**（整数分、同方向）。
- 日期窗口显式且有限：默认同日；`dateToleranceDays` 只能是 `0..31`；显式 `from` / `to` 超出
  「流水日期 ± 允许偏差」直接拒绝（`date_window_too_wide`）。
- 存在多个等价候选时全部列出且 `selection = requires_manual_choice`，绝不自动选第一条。
- 已被有效匹配占用的分录仍然列出但 `available=false` / `claimedByMatchId`。
- 一对多 / 多对一：**未实现自动组匹配**。只做提示：
  若同一窗口、同方向、未占用的两条分录合计恰好等于流水金额，返回
  `groupMatch.code = group_match_requires_manual` 与候选对；否则返回 `unsupported_group_match`。
  任何情况下都不自动占用分录、不把合计凑数当成已匹配。

确认（`confirm`）：必须显式 `--transaction`、`--voucher`、`--entry` 与理由。事务内用最新账务快照复核：

- 流水 / 分录 / 凭证都属于该账套与银行账户；
- 凭证 `posted`、分录科目 = 绑定科目、借贷方向明确、金额与流水完全一致；
- 凭证日期与流水日期偏差不超过显式允许值；凭证期间 = 凭证日期的月份；
- 同一流水 / 同一分录没有其他有效匹配（数据库部分唯一索引兜底，并发只会成功一次）。

取消（`cancel`）：必须给理由；释放占用但保留原匹配、原确认理由、成员与取消事件；重复取消幂等
（不新增审计事件）；取消后可再次确认并产生新的匹配记录（旧记录保留）。

## 9. 读时失效核验（无共享写入口接线时的真实工作路径）

`status` / `transactions` / `matches` / `candidates` / `confirm` / `reconcile` 每次都会重新核验范围内
所有 `confirmed` 匹配与当前账务是否一致。失效原因（写入 `bank_matches.invalidation_reason`）：

| 原因码 | 触发 |
|---|---|
| `bank_transaction_missing` | 银行流水被删除 |
| `bank_transaction_scope_changed` | 流水账套 / 账户变化 |
| `bank_transaction_changed` | 流水规范内容指纹变化 |
| `voucher_missing` | 凭证被删除 |
| `account_set_mismatch` | 凭证不属于该账套 |
| `voucher_unposted` | 凭证被反过账 |
| `voucher_entry_missing` | 分录被删除 / entry_id 不存在（含同号新凭证） |
| `entry_account_changed` | 分录科目变化 |
| `entry_line_changed` | 分录行号变化 |
| `entry_amount_changed` | 借方 / 贷方金额变化 |
| `entry_amount_unreadable` | 账务金额不是有限数或不是精确到分 |
| `voucher_date_changed` | 凭证日期变化 |
| `voucher_period_changed` | 凭证期间变化 |
| `voucher_period_date_mismatch` | 凭证期间与日期月份不一致 |

失效处理：事务性把匹配置为 `invalidated` 并写一条 `match_invalidated` 审计（**只写一次，不重复刷**），
把旧的对账运行记录标记 `stale`；重新展示必要未达项。**旧凭证反过账后又原样过账，不会自动恢复失效匹配**，
必须重新确认（产生新匹配记录）。

内部核验范围与展示分页严格分离：`refreshMatchStates` / 候选占用 / 对账未达项 / 状态计数一律读取
**完整集合或 SQL 聚合**（键集游标分块扫描 `listAllMatches`、直接按分录查占用、
`countBatchesByStatus` / `countMatchesByStatus` / `countTransactionMatchStates` / `countPendingAmbiguities*` /
`listConfirmedMatchSides`），不使用 `listMatches` / `listBatches` / `listAmbiguities` / `listTransactions`
这些**展示**分页（默认 500 / 200）的结果做业务判定。

观测边界（如实说明）：本版本没有可靠的账务修订号 / 变更事件流，检测发生在**读取时**，
因此只能保证「本次读取时点」的账务状态一致性，不能声称捕获两次调用之间未观察到的所有中间操作。
共享写入口（`accounting.mjs` 的反过账 / 删除 / 修改）的事件接线属于后续共享窗口任务，本包未改那些文件。

## 10. 余额调节

请求必须显式：`accountSetId`、`bankAccountId`、`currency`（CNY）、`period`、`asOf`、
`statementOpenCents`、`statementCloseCents`、`coverageFrom`、`coverageTo`、`statementSource`。

- 账面截止余额 = 该账套该银行存款科目的真实期初（`opening_balances` 借 - 贷）
  + `voucher_date <= asOf` 的**全部历史 posted** 银行分录（借 - 贷）。
  不按本月 / 候选窗口净额代替；asOf 必须落在声明期间内；期间早于账套启用期间拒绝。
- 银行截止余额由操作者显式声明；同时校验
  `声明期初 + 覆盖期流水净额 = 声明期末`，不一致保留差异（`statement_balance_mismatch`），
  不自动改余额、不补项。
- 覆盖范围必须包含 `asOf`，否则 `incomplete`。
- 四类未达项（逐项带来源，一律按 **截止日 asOf 视角**）：
  - 企业已收银行未收：未核销的账面 posted 银行借方分录；
  - 企业已付银行未付：未核销的账面 posted 银行贷方分录；
  - 银行已收企业未收：未核销的银行流入流水；
  - 银行已付企业未付：未核销的银行流出流水。
- 「核销」的判据：匹配为 `confirmed` **并且两侧都已发生**（凭证日期 `<= asOf` 且流水日期 `<= asOf`）。
  合法跨日匹配（如 1 月 31 日账面、2 月 1 日银行）在 1 月 31 日视角下仍算「企业已收银行未收」，
  不得因为已有匹配就把未发生的一侧当成已发生；截止后两侧都发生的匹配正常消除。
  这条规则**不禁止**跨日匹配，也不回写账务凑平，匹配本身仍保持 `confirmed`。
- 公式（整数分，BigInt 累加后校验范围）：
  - 调节后账面 = 账面截止余额 + 银行已收企业未收 − 银行已付企业未付
  - 调节后银行 = 银行截止余额 + 企业已收银行未收 − 企业已付银行未付
  - 差额 = 调节后账面 − 调节后银行
- 状态：`reconciled` 只在「差额为 0 + 对账单期初/期末校验一致 + 覆盖包含 asOf + 无未决歧义 +
  无未复核的失效匹配 + 期间日期一致」时给出；否则 `incomplete`（覆盖 / 期间 / 来源类）
  或 `pending_review`（差异 / 歧义 / 失效匹配类）。
- 每次调节都写 `bank_reconcile_runs` 与 `reconcile_computed` 审计，并把同一账户更早的运行记录标记 `stale`；
  三步（旧记录 stale → 新运行记录 → 审计）**在同一事务内**完成：任一步失败（包括合成触发器注入失败）
  全组件回滚，不留下「无审计的新结果」，也不误废弃旧结果；调用方已有外层事务 / 保存点时继续用保存点，
  与外层事务兼容。
- 未决歧义 / 未复核失效匹配的**计数**来自 SQL 聚合（先按条件过滤再限展示条数），
  不拿一页展示记录的长度冒充真实数量。
- 调节不生成、不修改任何凭证，也不改 `periods` 状态。

固定手算验收（单位分，测试中直接写独立常量）：两边期初 80000；账面仅有未达收款 30000、付款 10000；
银行仅有未达收款 50000、付款 10000 → 账面截止 100000，银行截止 120000，
调节后账面 = 100000 + 50000 − 10000 = 140000，调节后银行 = 120000 + 30000 − 10000 = 140000，差额 0。
把银行付款改为 10001 且保持声明截止 120000 → 计算期末 119999、声明与计算差 1 分、
调节后账面 139999 / 调节后银行 140000、差额 −1，状态 `pending_review`。

## 11. CLI

```
node scripts/bank-reconcile.mjs <command> --db <库文件> [选项] [--format json|text]
```

| 命令 | 作用 | 主要参数 |
|---|---|---|
| `init-db` | 在**不存在**的新路径创建账务库并初始化 bank_*（唯一允许建库的命令） | `--db <目录>/workbench.db` |
| `account-register` | 登记银行账户 | `--account-set`、`--bank-account`、`--source`、`--gl-code`、可选 `--name` / `--number` / `--currency` |
| `accounts` | 列出已登记账户 | `--account-set` |
| `import-preview` | 预检 CSV + 映射（不写库） | `--account-set`、`--bank-account`、`--source`、`--period`、`--csv`、`--mapping` |
| `import` | 执行导入 | 同上 + `--batch` |
| `batches` | 批次状态 | `--account-set`、`--bank-account`、可选 `--limit` |
| `transactions` | 流水查询（含匹配状态） | 可选 `--from` / `--to` / `--status matched\|unmatched\|all` / `--limit` |
| `ambiguities` | 疑似重复待判定行 | 可选 `--status` |
| `resolve-ambiguity` | 人工判定 same / distinct | `--ambiguity`、`--decision`、`--reason`、可选 `--transaction` |
| `candidates` | 候选分录（只读） | `--transaction`、可选 `--from` / `--to` / `--tolerance-days` / `--period` |
| `confirm` | 确认匹配 | `--transaction`、`--voucher`、`--entry`、`--reason`、可选 `--tolerance-days` |
| `cancel` | 取消匹配 | `--match`、`--reason` |
| `matches` | 匹配记录与有效性 | 可选 `--status` |
| `reconcile` | 余额调节 | `--period`、`--as-of`、`--statement-open`、`--statement-close`、`--coverage-from`、`--coverage-to`、`--statement-source`，可选 `--currency` / `--note` |
| `status` | 账户 / 批次 / 流水 / 匹配 / 歧义 / 最近对账 | `--account-set`、`--bank-account` |
| `audit` | append-only 审计事件 | 可选 `--limit` |
| `help` / `--help` | 命令列表（不接触数据库） | — |

金额参数用元（最多两位小数），输出同时给整数分与两位小数文本。`--format text` 给操作者本机可读明细。

展示与计数分开（如实标出边界）：`batches` / `transactions` / `matches` / `ambiguities` 的 `items` 是**展示页**
（有 `--limit` 上限，`status` 的批次 items 上限默认 200 并在 `itemsLimit` / `itemsTruncated` 中标明）；
`status` 的 `batches.total|completed|pendingReview|failed`、`transactions.total|matched|unmatched`、
`matches.confirmed|cancelled|invalidated`、`ambiguities.pending` 均为**真实计数**（SQL 聚合），不受展示页影响。

退出码：`0` 成功；`2` 用法 / 路径 / 范围参数错误；`3` 业务拒绝或冲突；
`4` 内部错误（默认不输出 SQL / 堆栈）；`5` 依赖未就绪（备份 / 结构门槛）。

常用错误码（完整列表见实现与 `test/bank-reconcile-cli.test.mjs`）：

| 类别 | 错误码 |
|---|---|
| 数据库 / 结构 | `db_not_found`、`db_not_workbench`、`schema_not_supported`、`bank_schema_missing`、`bank_schema_future_version`、`bank_schema_version_contradiction`、`bank_schema_corrupt` |
| 迁移门槛 | `migration_backup_unavailable`、`migration_backup_failed`、`migration_backup_invalid`、`bank_migration_failed` |
| 账户 / 范围 | `account_set_not_found`、`bank_account_not_registered`、`bank_account_conflict`、`bank_gl_account_already_bound`、`bank_gl_account_not_found`、`bank_gl_account_not_leaf`、`bank_gl_account_invalid`、`currency_unsupported`、`period_before_start` |
| CSV / 映射 | `csv_duplicate_header`、`csv_unclosed_quote`、`csv_stray_quote`、`csv_trailing_characters`、`csv_missing_column`、`mapping_*`、`row_date_*`、`row_amount_*`、`amount_*` |
| 批次 / 去重 | `batch_content_conflict`、`source_transaction_content_changed`、`import_rejected`、`replay_row_mismatch` |
| 歧义 | `ambiguity_not_found`、`ambiguity_already_resolved`、`ambiguity_decision_invalid`、`ambiguity_target_required`、`ambiguity_target_scope_mismatch` |
| 匹配 | `voucher_not_posted`、`entry_not_bank_account`、`match_amount_mismatch`、`match_date_out_of_window`、`entry_already_matched`、`match_already_confirmed`、`match_not_found` |
| 对账 | `statement_source_required`、`statement_coverage_required`、`statement_coverage_invalid`、`as_of_period_mismatch`、`date_window_too_wide` |

## 12. 组件迁移与备份门槛（LOCAL-06 依赖）

- `bank_*` 使用自己的 `bank_component_migrations` 版本（当前 v1），**不写** LOCAL-01 的
  `schema_migrations` / `schema_backups`，也不写 `PRAGMA user_version`。
- **已有库**首次加入 `bank_*`（或组件升级）必须先完成一次可验证的一致备份。备份实现来自
  LOCAL-06，本包只作为窄依赖注入（需 `createBackup({dbPath,outDir})` 与 `verifyBackup({backupDir})`）：
  - 未提供备份服务 → `migration_backup_unavailable`，原库结构 / 数据 / 版本都不动；
  - 备份生成失败 → `migration_backup_failed`；备份校验不通过 → `migration_backup_invalid`；
  - 只有备份校验返回 ok 之后，才在同一事务里建立组件表、记录备份证据与组件版本；DDL 失败整体回滚。
- 新库：`claimFreshDatabase({ dbPath })` 以 `O_EXCL` 新建并保留创建 fd，通过通用守卫写入并核验 SQLite 空库种子；
  回执绑定私有不可变事实，不接受字段篡改 / 克隆 / 路径替换。真实核心入口必须经 `initializeFreshDatabaseCore(receipt)`，
  手工核心初始化须先在实际连接调用 `verifyFreshDatabaseConnection(receipt, db, dbPath)`（在任何 DDL / WAL 前）；
  `ensureBankSchema` 只接受已见证的实际连接，成功提交后消费回执。失败调用者用 `releaseFreshDatabaseClaim` 关闭自有句柄并保留库现场。
  创建守卫的页 1 nonce 会留在 `user_version`，nonce 不是秘密；银行组件安装不改写该值，也没有 `--force` 旁路参数。
- **结构 / 版本契约统一拒绝（同一门槛覆盖 CLI 与领域写入口）**：`ensureBankSchema` / CLI `ensureBankReady` /
  领域 `resolveBankScope` / `registerBankAccount` 都调用同一套 `bankSchemaContract(db)` + `assertBankSchemaReady(db)`：
  - 版本比本程序新（如 v1 库里有一条 `version=2`）→ `bank_schema_future_version`；
  - 版本记录与表集合矛盾（有表无版本行、版本行不是唯一的 v1）→ `bank_schema_version_contradiction`；
  - 版本表本身形状损坏（`version` 列缺失 / 被改名）→ problems 含 `bank_schema_version_table_corrupt`，
    最终码为 `bank_schema_corrupt`；实现**先验证版本表形状再读 `version`**，不把 `ERR_SQLITE_ERROR` /
    原始 SQL 错误抛给领域或 CLI；
  - 缺表 / 缺列 / 主键不符 / 缺 UNIQUE 或索引签名不符 / 部分索引 `WHERE` 谓词不符 /
    **索引键语义漂移（collation / 方向 / 表达式 / 来源顶替 / 额外唯一约束）** /
    外键完整集合或动作不符（含额外 / 重复外键）/ 额外的未声明 `bank_*` 表 → `bank_schema_corrupt`；
  - 完全没有任何 `bank_*` 表才进入备份门槛迁移；
  - 拒绝时**不做任何 DDL / 写入**，不用 `CREATE TABLE IF NOT EXISTS` 静默修补坏库，失败即无写入；
  - 只做结构核对（`sqlite_master` + PRAGMA），**不扫全表内容**，不做昂贵内容校验。
- CLI 对以上错误码统一 exit 5（依赖未就绪）；`details.problems` 给出结构问题证据（表 / 列 / 索引签名与谓词 / 外键集合）。
  版本表形状损坏时，领域只读入口与 CLI `status` 同样是**非写入拒绝**：不执行 DDL、不补建表、不显示原始 SQL 错误。
- CLI 的 `init-db` 是唯一允许建库的入口：它先确认目标文件不存在（且文件名必须是 `workbench.db`），
  声明创建事实，设置 `WORKBENCH_DATA_DIR` 指向显式目录后调用产品真实建库入口 `server/db.mjs`，
  再在同一进程内初始化 `bank_*`。已有库加入 `bank_*` 时 CLI 支持 `--backup-service <模块>`。

**当前状态（如实）**：本分支已把已审 LOCAL-06 备份实现与本组件结构契约真实打通，`--backup-service <server/local-backup.mjs>`
可直接用于已有库安装。实现与验收事实：

- **真实备份目录**：安装不再把已有 `dataDir` 当 `outDir`，而是创建设置在 `<dataDir>/bank-component-backups/pre-bank-v1-*`
  下的全新专属子目录；`createBackup` 的 `outDir` 必须不存在，与本实现一致。
- **严格读取真实返回字段**：create 必须 `ok === true` 并返回非空 `backupDir` 与真实
  `backupMeta.snapshotBytes / snapshotSha256`；verify 必须独立返回 `ok === true` / `status === 'ok'`，
  且摘要与 create 一致；还要绑定清单来源文件、当前核心 schema 版本，并拒绝迁移前已含组件。
  `true`、仅 `{ integrity: 'ok' }`、仅 `{ ok: true }` 的弱 mock 都会被拒绝。
- **连接与库路径绑定**：安装前用 `PRAGMA database_list` 核对调用方连接的真实文件就是 `dbPath`，
  不一致返回 `database_handle_mismatch`，不会备份 A 却往 B 装。
- **排他安装窗口**：已有库的备份 + DDL + 版本 / 备份记录在同一个 `BEGIN IMMEDIATE` 写事务内完成；
  安装期间其他连接无法提交新业务写入，不会把「备份后、DDL 前」的并发写入当成已保护。
  `VACUUM INTO` 由备份服务在独立只读连接上执行，不需要在本事务内运行。
- **失败边界**：create 失败 / verify 失败 / DDL 后结构自检失败都整体回滚；原库 schema / 数据 /
  全局迁移版本不变，不留半套 `bank_*` 表或版本行。失败时迁移前备份目录保留（可人工核对），
  但不会登记为成功迁移证据。**回滚本身失败时不再声称「原库已回滚」**：
  `bank_transaction_rollback_failed` + `rolledBack:false`，连接被标为未知态（后续银行读写
  `bank_connection_state_unknown`，`ensureBankSchema` 同样拒绝把未知态连接当成「已初始化 / 可安装」），
  由调用方确认回滚成功或丢弃连接后再 `recoverBankConnectionState`。
- **事务冲突 / 事务没建立 ≠ 已回滚**：连接上已有调用方事务 / 保存点（或银行自己的未结束嵌套层）时，
  安装与银行写事务都在**任何 DDL / 备份 / 回执消耗之前**拒绝：`bank_transaction_conflict` +
  `started:false` / `rolledBack:false` / `transactionState:'external_transaction'|'bank_transaction_active'` /
  `bankManaged`；银行既不提交也**不**回滚那层事务，调用方未提交行保持原样，创建回执不被消耗。
  `BEGIN` / `SAVEPOINT` 没建立起来时给 `bank_transaction_begin_failed` + `started:false` /
  `rolledBack:false` / `transactionState:'not_started'`，连接不被拉黑（没有写入可回滚）。
  `bankConnectionState()` 如实反映连接事实：`transactionState` 为 `clean` / `external_transaction` /
  `rollback_unconfirmed`，`transactionActive` 直接来自 `db.isTransaction`（不把活动的外层事务说成 false），
  `writable` 只表示「银行可自行开事务并提交」，未知态与调用方事务都不满足；这种状态下导入失败审计
  **不写入调用方事务**并如实标记 `auditRecorded:false`（不冒充「已留痕」，也不把调用方事务说成「回滚失败」）。
- **组件备份支持（可选 bank v1）**：`local-backup.mjs` 在 core v3 / v4 精确契约之外增加可选的
  bank 组件 v1：必须完整 10 表、列类型 / NOT NULL / 默认值、主键列序与 `rowidAlias`、
  **全部 19 条 PK / UNIQUE / 命名 / 自动索引逐键语义**（`seqno` 顺序 / collation / 升降序 /
  表达式 / rowid / `origin` / `partial` 与规范化真实 `WHERE` 谓词）、外键完整集合与动作、
  版本表恰好一行 v1、无未登记触发器 / 视图；数量 / 额外 / 缺失 / 互相顶替一律拒绝。
  任何半套 / 未来 / 额外 `bank_*` 或 audit / batch 等未知表仍拒绝。
  **无 bank 的旧 v3 / v4 备份与旧 bank 内部候选备份保持可读**：清单格式与
  `components[].structureDigest` 口径未改，严格校验独立于摘要定义，不要求重生成 / 升级。
- **清单绑定**：有组件时清单显式记录 `components[]` 的 name / version / 表集 / 结构摘要 / 内容摘要 /
  行数；verify 从快照重算并逐项比对，不接受清单漏报或错报。**无组件的旧 v3 / v4 备份继续原样
  verify / restore-new，不升级，清单形状不被强制改写。**
- 备份模块只 import 无默认库副作用的 `bank-storage.mjs` 结构与谓词规范化函数，不 import
  `db.mjs` / `accounting.mjs` / actions / runner，导入备份模块不会打开或创建默认数据目录。

**停写 / 维护窗口与恢复损失边界（执行前提，不是已保证）**：

- 组件安装已用 `BEGIN IMMEDIATE` 排他写事务覆盖「备份 + DDL」；这防止其他连接在该窗口提交新写入，
  但**不等于**整个产品在安装期间可以继续服务：操作者仍应在维护窗口内关闭其他写入进程，
  以免它们在等待锁时超时失败。
- 恢复损失边界：备份是安装前某一时点的快照。安装成功后的业务写入不在该备份内；若用它恢复，
  安装后的银行组件与业务写入都会消失，必须由操作者明确确认后再执行 `restore-new`。
- 本包只支持恢复到全新目标；原位覆盖、通用版本回退、审计 / 批量组件的恢复接线均未交付。

## 13. 验收与测试（本次实际运行）

环境：Windows，Node v24.15.0，`node:sqlite`（无第三方依赖）。全部使用合成临时目录与合成 CSV，
不读取真实账套 / 银行文件 / 凭据。

| 套件 | 命令（在 `06-workbench` 目录） | 结果 |
|---|---|---|
| CSV / 映射 / 规范化 | `node --test test/bank-import.test.mjs` | 16 / 16 通过 |
| 持久化 / 匹配 / 失效 / 余额调节 / 索引键语义 / 回滚状态 / 事务冲突 | `node --test test/bank-reconciliation.test.mjs` | 40 / 40 通过（A 窗 29 → 36，第二轮 36 → 40） |
| CLI 端到端（子进程） | `node --test test/bank-reconcile-cli.test.mjs` | 12 / 12 通过（A 窗 11 → 12） |
| LOCAL-06 备份 / 验证 / 恢复 | `node --test test/local-backup.test.mjs` | 22 / 22 通过（B 窗按实际 main 同步后重跑，核心 22 项含义未变） |
| 银行现库安装 / 组件备份集成 | `node --test test/local-bank-backup-integration.test.mjs` | 5 / 5 场景通过（数量不变；B 窗已把「备份仍漏验」断言改为拒绝，并补三入口反例 / 健康恢复） |
| 受影响五套合计 | 领域 + CLI + 集成 + 银行解析 + backup（不使用 `npm test` 总入口） | **95 / 95** 通过，exit 0（B 窗实际 16 + 40 + 12 + 5 + 22） |

五套件**尚未注册**到 `scripts/test-all.mjs`：该文件属于共享测试总入口，按任务边界由后续共享接线窗口登记；
本包不修改它，因此 `npm test` 不包含这些套件。

### 13.3 本轮现库安装 / 组件备份集成验收（真实临时库）

基线：`ce4078222c9e5fb8508c9fe24a9183f17d46ea28`（银行 91f07eb + 核心 bd05415 + 备份 3399500 冻结组合）。
以下全部为合成临时库，不读取真实账套 / 银行文件 / 凭据；原始 stdout 保存在本工作区 `.agent-runs/`（未提交）。

| 场景 | 关键断言 | 结果 |
|---|---|---|
| core4 + 遗留 WAL 安装 | 安装前真实 create + verify；备份按 v4、无 bank 组件、包含 WAL 已提交凭证；恢复到全新目标后核心账套 / 凭证 / 分录一致；安装后完整 10 表、全局 schema 仍 v4、备份证据 1 条；重跑幂等且不新增备份 | 通过 |
| 银行固定手算 + 安装后备份恢复 | 账面 1120.00 = 1000 + 200 + 50 - 100 - 30；对账单 1110.00 = 1000 + 200 + 20 - 100 - 10；四类未达 50 / 30 / 20 / 10（分：5000 / 3000 / 2000 / 1000）；调节账面 = 调节银行 = 1130.00，差额 0；不生成调整凭证；backup → verify → restore-new 后金额 / 批次 / 4 笔流水 / 2 笔确认 / 运行记录保留；取消匹配与反过账后 stale / invalidation 可见；乙账套账面 600.00、流水 1 笔不受甲账套影响 | 通过 |
| core3 兼容路径 | 派生结构等价 v3 库先被 v3 契约接受；安装 bank 后核心仍 v3；backup 清单仍按 v3 并绑定 bank v1；恢复后仍 v3、完整 10 表、核心业务保留、不自动升级 | 通过 |
| 故障 | create 抛错 → `migration_backup_failed`；真实 create 后删除快照 → 真实 verify 失败 `migration_backup_invalid`；DDL 后自检失败 → 整体回滚、失败备份保留可验证但不登记；错 DBPath → `database_handle_mismatch` 且两库无写入；安装持锁期间另一连接写入被 `SQLITE_BUSY` 拒绝 | 通过 |
| 篡改矩阵 | 少表 / 多表 / 未知组件表；同名错 partial 谓词；FK 额外 / 重复 / 动作改；版本表缺列 / 多行 / 未来；列类型 / 默认值 / NOT NULL；未知 trigger；清单组件漏报 / 错报 future 版本 / 错结构摘要 / 错表集 / core-only 虚报 bank。每项都重算快照字节数与 sha256 后仍被结构 / 清单契约拒绝，且 `restore-new` 不生成目标库 | 通过 |

### 13.1 首轮独立审查 5 项阻塞：真实复现与回归

审查基线为冻结 head `e2545216226b87262508d8a94f38426415670d8c`。复现与回归都用
真实临时 SQLite + 真实建库 / 建账套 / posted 凭证 / 导入 / 确认 / 对账路径，金额用独立手算常量（分）。

| 阻塞 | 冻结 head 上的真实表现 | 修复 | 回归用例 |
|---|---|---|---|
| P1 内部计算读展示分页 | 501 笔×100 分全确认后期初 0 / 银行期末 50100，返回调节后 **50200 / 50200** 且 `reconciled`，最后 1 笔被两侧重复列为未达；反过账后 `refresh` 只核验 500 条、`invalidated[]` 且该 match 仍 `confirmed`；候选占用漏 1 条；批次数 200 封顶；待决歧义 500 封顶；>500 条已复核失效匹配前缀掩盖后续未复核 | 内部判定改用完整集合（键集游标分块 `listAllMatches`、按分录直查占用、`listConfirmedMatchSides`）与 SQL 聚合计数；展示分页保留明确边界 | `内部判定不被展示分页截断`、`批次与待决歧义真实数量…`、`失效匹配复核计数先过滤再限条…` |
| P1 截止日 asOf 未达 | 1/31 账面收款 1000.00 + 2/1 银行收款（容差 1 天已确认）→ 1/31 未达项为 0、调节后 1000 / 0、差额 1000 且 `pending_review`；反向同理 | 未达项按 asOf 视角：只有匹配两侧都已发生才消除；跨日匹配合法、不回写账务 | `余额调节按截止日 asOf 判定未达项…` |
| P2 组件结构 / 未来版本 | v1 库插入 `version=2` 后 `ensureBankSchema` 返回 success 且 `registerBankAccount` 能写；删除 `bank_reconcile_runs` 后初始化仍 success；CLI 同因旁路 | 统一 `bankSchemaContract` / `assertBankSchemaReady`：未来版本、矛盾版本、缺表 / 缺列 / 主键 / UNIQUE / 索引签名 / 外键动作 / 额外 `bank_*` 表都在业务写前拒绝；不 DDL 修补、不做内容扫描；仍为组件 v1 | `组件结构 / 版本契约…`（领域）、`CLI 组件结构契约损坏…`（子进程） |
| P2 对账持久化非原子 | 合成触发器让 `reconcile_computed` 审计插入失败后，runs 由 `[{id:1,stale:0}]` 变 `[{id:1,stale:1},{id:2,stale:0}]` 且旧结果被误废弃 | 旧记录 stale + 新运行记录 + 审计同一 `inTransaction`（嵌套用保存点） | `对账结果持久化原子…`（插 run 失败与插 audit 失败两路均校验全组件快照） |
| P2 CSV 错误截断 | 合法表头 + 201 行 `2026-01-10,bad,in`（正常映射）抛 `Assignment to constant variable.` | 错误列表改用有界 `addError`：行级错误 / 缺列 / 期间 / 文件内重复流水号共用总上限，超过置 `errorsTruncated` | `预检错误总上限…` |

回归证据（本轮实际执行）：

- 同一复现脚本在冻结 head 上 29 / 51 项断言失败（含上述 5 类现象）；修复后 51 / 51 通过。
- 新增 8 个回归用例（1 导入 + 6 领域 + 1 CLI）在冻结 head 上全部失败、在修复后全部通过；原 44 个用例两侧都通过。

### 13.2 结构契约复审收敛（本轮 3 项 P2）

返工基线为 `46e0fc0ecb74703cc8482aab9a1cf3f85839f232`。原分页 / 截止日 / 事务 / CSV 四项与大数据真实探针
已独审通过，本轮只收敛结构门槛与必要测试文档；三套用例原 52 项保留未删弱。

| P2 | 返工前真实表现（冻结 head `46e0fc0`） | 修复 | 回归用例 |
|---|---|---|---|
| 部分索引只比 `partial` 标志、忽略 `WHERE` | 把 `idx_bank_matches_active_txn` 重建为同名同列同 UNIQUE/partial 但 `WHERE status='cancelled'`，`bankSchemaContract` 仍 ok、`ensureBankSchema` 仍返回 already-initialized | `indexSignatures` 读取 `sqlite_master.sql` 的实际谓词，规范化后**整体**比对；三条部分索引（`idx_bank_matches_active_txn` / `idx_bank_matches_active_entry` / `idx_bank_txn_ref`）错谓词一律 `bank_schema_corrupt` | `部分索引契约核对真实 WHERE 谓词…`（领域；含正确谓词的空白 / 引号写法兼容） |
| 外键只找必需项、不拒绝额外 / 重复约束 | `bank_audit_events` 仅增加 `account_set_id REFERENCES account_sets(id) ON DELETE CASCADE`（并恢复原索引）后 contract 仍 ok；真实删除账套后审计行 1 → 0 | 按表比较完整外键多重集（列组 + 目标 + `ON DELETE` / `ON UPDATE`），额外 / 重复约束逐条给 `bank_schema_foreign_key_unexpected`；audit / reconcile-runs 原本无 FK 时实际也必须无 FK | `外键契约比较完整集合…`（领域；合法结构真实删除后审计仍 1，额外 FK 真实删除后审计变 0，重复同目标 FK 两条都暴露） |
| 版本表缺列时先查询 `version` 导致 SQLite 异常 | `ALTER TABLE bank_component_migrations RENAME COLUMN version TO broken_version` 后 `bankSchemaContract` 直接抛 `ERR_SQLITE_ERROR: no such column: version` | 先验证版本表形状（`version` 列存在）再读版本；形状坏时给 `bank_schema_version_table_corrupt`（最终 `bank_schema_corrupt`），`bankSchemaVersion` / `bankSchemaState` / 领域入口 / CLI `status` 都不抛原始 SQL、不写入；正常未来版本仍 `bank_schema_future_version` | `版本表形状缺失…`（领域）、`CLI 版本表形状损坏…`（子进程，exit 5 且不显示 SQLite 错误） |

红 / 绿证据（同一临时探针分别导入冻结 head 的实现与返工实现，真实临时 SQLite）：

```
冻结 head 46e0fc0：错索引谓词 contractOk=true / ensure=already-initialized；
                   audit 额外 FK contractOk=true，真实删除账套后 audit 1→0；
                   版本表改名后 contract 抛 ERR_SQLITE_ERROR(no such column: version)
返工实现：       错索引谓词 contractOk=false / bank_schema_corrupt / ensure 拒绝；
                   audit 额外 FK contractOk=false / bank_schema_corrupt；
                   版本表改名后 contract 返回 ok=false / bank_schema_corrupt（不抛原始 SQL）
```

本轮实际运行：`bank-import` 16 / 16、`bank-reconciliation` 29 / 29、`bank-reconcile-cli` 11 / 11，
三套合计 56 / 56 通过（约 11.1s）；原 52 项未删弱，新增 4 个用例（3 领域 + 1 CLI）。
冻结 head `46e0fc0` 实测：3 个领域新用例 3 / 3 失败；CLI 新用例 exit 3（原始 SQLite 错误被当作内部错误）
而非要求的 exit 5；返工实现后 4 / 4 通过。

### 13.4 A 窗独审 2 项 P2 回修（索引键语义 + 回滚失败状态）

回修基线：head `06d1bd185f68ea4f3c49f20e6cf98f6cdce613a2`（#53 独审 2 项 P2）。本窗只改登记的 9 个文件，
**未改** `local-backup.mjs` / `test/local-backup.test.mjs`（已交 #47），也未接 HTTP / Agent / MCP；
本包仍未整体完成。

| P2 | 独审在冻结 head 上的真实表现 | A 窗修复 | 回归用例 |
|---|---|---|---|
| 1 索引只比 `pragma_index_info` 列名 | 把 `idx_bank_txn_ref` 最后键改成 `bank_ref_id COLLATE NOCASE`（列名 / UNIQUE / partial / WHERE 全不变）后 `bankSchemaContract` 仍 ok、备份 `verify` / `restore-new` 也 ok；恢复库上真实导入 `Ref-A` / `ref-a` 第二笔 UNIQUE 失败，而正常结构下两笔都成功 | `indexSignatures` 改读 `pragma_index_xinfo`：逐键记录列名 / `coll` / `desc` / 是否表达式 / 是否 rowid，并按 `origin` 校验来源（`c` / `pk` / `u`）；契约对**全部 19 条索引**固定「普通列 + BINARY + 升序 + 非表达式」，命名与自动索引不得互相顶替，额外唯一约束 / 表达式一律拒绝 | `索引键语义契约：collation / 方向 / 表达式 / 额外唯一索引都拒绝…`、`真实导入对照：只有大小写不同的稳定流水 ID…两条都成功`（领域）、`CLI 索引键语义漂移…`（子进程 exit 5）、集成 `索引键语义 + 备份恢复…` |
| 2 吞 `ROLLBACK` 失败后无条件称「原库已回滚」 | 用真实 DELETE-journal 读事务让安装 `COMMIT` 实际 `database is locked`（正常 `ROLLBACK` 后 `isTransaction=false`、bank 表 0）；再仅注入 `ROLLBACK` 抛 I/O 错误，实现仍报「原库已回滚」，而 `db.isTransaction=true` 且同连接内 10 张 bank 表 / 版本行仍未提交；fresh 分支 `inTransaction` 同样 | `inTransaction` / `ensureBankSchema` 区分**已确认回滚**（`rolledBack:true`，可继续说已回滚）、**已确认整体放弃**（`bank_transaction_discarded`，内层 SAVEPOINT 失败但外层回滚成功 / 被吞掉时绝不 COMMIT）、**回滚失败 / 未知**（`bank_transaction_rollback_failed` + `rolledBack:false` + `transactionActive`，固定措辞不回显原始 SQL / 路径）；未知态连接对银行读写与 `ensureBankSchema` 统一 `bank_connection_state_unknown`，只能由调用方确认回滚成功 / 丢弃连接后 `recoverBankConnectionState`（仍在事务中给 `bank_connection_recovery_refused`）；导入失败审计只在确认回滚的连接上写，未知态 `auditRecorded=false` + `auditFailure` | `安装 COMMIT 真实失败（DELETE journal 读事务）…`、`仅注入 ROLLBACK 抛错（单点注入，不是实测磁盘故障）…`、`新库分支：COMMIT / ROLLBACK 失败都不冒充…`、`嵌套 SAVEPOINT 回滚失败…`、`导入失败审计：回滚未确认时如实标记未留痕…`（领域）、集成故障用例保持 |

测试口径（本窗实际运行，合成临时库，不连真实账套 / 税局）：`bank-import` **16 / 16**、
`bank-reconciliation` **31 → 36 / 36**、`bank-reconcile-cli` **11 → 12 / 12**、`local-backup` **20 / 20**（未回退）、
`local-bank-backup-integration` **4 → 5 / 5**，合计 **89 / 89** 通过。前一份 root 在 06d 管理的
16 + 29 + 11 + 20 + 4 = **80** 记录对应回修前 head，仍成立；本轮新增 7 领域 + 1 CLI + 1 集成用例，旧断言未删弱。
**真实 COMMIT busy 是 DELETE-journal 读事务实测**（非 WAL 产品路径）；`ROLLBACK` 失败是**单点注入**，
不声称已实测真实磁盘故障。绿测不等于独审通过：root 冻结后仍需独立复审，后续备份窗另开。

### 13.5 第二轮独审 P2 回修（调用方外层事务下的「未开始」不得冒充已确认回滚）

回修基线：head `c8f490c6b4d4e0f4bdaa9acf378defa900334e80`（A 窗后冻结 head）。本轮仍只在登记的
9 文件范围内改动，实际改动 **7 个**：`server/bank-storage.mjs` / `server/bank-reconciliation.mjs` /
`scripts/bank-reconcile.mjs` / `test/bank-reconciliation.test.mjs` / 三份文档；`test/bank-reconcile-cli.test.mjs`
与 `test/local-bank-backup-integration.test.mjs` 只重跑未改。**未改** `server/local-backup.mjs` /
`test/local-backup.test.mjs`，未接 HTTP / Agent / MCP，未跑全 55 套；本包仍未整体完成。

| P2 | 独审在冻结 head 上的真实表现 | 本轮修复 | 回归用例 |
|---|---|---|---|
| 真实新库 + 有效创建回执 + 调用方外层事务 | 调用方先 `BEGIN IMMEDIATE` 并插 1 条合成 `account_sets`，再 `await ensureBankSchema(...receipt)`：`inTransaction` 的 `BEGIN` 在 `try` 外抛错，fresh 分支仍包成 `bank_migration_failed` + `rolledBack:true` / `transactionState:'rolled_back'` / 消息称「已确认回滚（未留下半成品）」，而 `db.isTransaction=true`、未提交行仍在、10 张 bank 表 0；没有执行 `ROLLBACK`；`bankConnectionState` 却 `writable:true` / `transactionActive:false`；且创建回执被消耗，调用方结束后重试落到已有库备份门槛（`migration_backup_unavailable`） | `inTransaction` 在 `BEGIN` / `SAVEPOINT` 前先识别调用方事务：给 `bank_transaction_conflict` + `started:false` / `rolledBack:false` / `transactionState:'external_transaction'` / `transactionActive:true` / `bankManaged:false`，不开事务、不提交 / 不回滚调用方事务；`BEGIN` / `SAVEPOINT` 没建立给 `bank_transaction_begin_failed` + `transactionState:'not_started'`，不拉黑连接；`ensureBankSchema`（新库与现库）在消耗回执 / 分配备份目录 / 任何 DDL 之前做同一冲突检查，**安装成功提交后才消耗回执**；`bankConnectionState` 的 `transactionState` / `transactionActive` / `writable` 按连接真实事实给，不把活动外层事务说成 `false`；导入失败审计在调用方事务中不写并给固定 `auditFailure`；CLI 将两个新错误码映射为 exit 5 | `新库 + 创建回执 + 调用方外层事务…`、`现库安装 + 调用方外层事务…`、`BEGIN / SAVEPOINT 没建立起来…`、`导入失败审计不写进调用方事务…`（领域 36 → 40） |

先红后绿证据（同一新用例分别跑冻结 head 实现与本轮实现，真实临时 SQLite + 真实创建回执 + 真实未提交行）：

```
冻结 head c8f490c：4 / 4 失败 — 新库分支给 bank_migration_failed(rolledBack:true)、现库分支给 migration_lock_failed、
                  导入在调用方事务里抛原始 ERR_SQLITE_ERROR、BEGIN 失败没有任何结构化错误
本轮实现：      4 / 4 通过 — bank_transaction_conflict / bank_transaction_begin_failed + bank_transaction_discarded（嵌套保存点没建立、外层已确认回滚）
```

测试口径（本轮实际运行，合成临时库，不连真实账套 / 税局）：`bank-reconciliation` **36 → 40 / 40**、
`bank-reconcile-cli` **12 / 12**（本来未改断言，只验证新错误码不破坏既有 exit 码）、
`local-bank-backup-integration` **5 / 5**（真实 COMMIT busy 四象限与备份恢复保持通过），受影响三套合计
**57 / 57，exit 0**；`bank-import` 16 与 `local-backup` 20 本轮内容未改、未重跑（不代表已重跑）。
保持既有语义：受本库管理的嵌套事务成功 / 外层整层放弃不变；真实 `COMMIT` busy 与单点 `ROLLBACK` 注入结论不变；
未用「自动关闭用户连接」解决，未知态仍需调用方显式恢复 / 丢弃。

### 13.6 B 窗：同步已合核心并补齐备份侧银行组件索引键语义（2026-10-22）

基线：工作区实际 HEAD（已含核心 PR #60 merge `dfefae0` 的严格备份契约，及本轮银行 A 最终 `950b7d6`；
银行 A 的独立复审已被 root 记录接受）。本窗只改 13 个 claim 文件的子集（见任务单 B 窗§与交接），
**不改** `bank-reconciliation.mjs`、核心 / DB / import / HTTP / Agent / MCP / public / test-all / package。

| 变化 | 内容 | 结果 |
|---|---|---|
| 合并冲突的真实解决（只在本清单文件内） | 核心 `75b448d` 把完整唯一性键模型接入结构校验后，银行表被并入 `effectiveStructure` 但 `unique` 仍是旧空数组，导致健康 bank 备份被 `unexpected_unique_index` 误拒（真实复现：集成基线 1 / 5） | `BANK_COMPONENT_STRUCTURE` 每表补上对象形状的 `unique`（从同一份 `BANK_SCHEMA_CONTRACT.indexes` 静态派生）与显式 `rowidAlias`；不丢掉任一已审合同，也不从当前库动态生成期望 | 集成恢复 **5 / 5** |
| 备份侧逐键校验 | `local-backup.mjs` 的 core `unique` 模型支持带名字 / `partial` / `where` 的条目；组件索引改用完整 `pragma_index_xinfo` 事实（`seqno` / collation / 方向 / 表达式 / rowid / `origin` / 真实谓词），全部 19 条索引逐条比对；额外 / 缺失 / 命名与自动索引互相顶替都拒绝 | 正常产品 DDL 通过；`NOCASE` / `RTRIM` / `DESC` / 表达式 / 错 partial 谓词 / 额外唯一 / 互顶 / `INTEGER PRIMARY KEY DESC` 在**源库 / 快照 / 恢复目标**三入口全拒绝（快照同时重算摘要） | 三入口反例通过，不产恢复目标 |
| 健康链路 | 健康 bank 库 `backup → verify → restore-new` 后 `idx_bank_txn_ref` 仍为 `BINARY` 升序普通列，真实 `Ref-A` / `ref-a` 两笔各成功；与真实 DDL 同义重建不被误拒 | 通过 |
| 兼容边界 | 清单格式 / `formatVersion` / `components[].structureDigest` 口径未改；旧 core v3 / v4 备份与旧 bank 内部候选备份保持可读，不要求重生成 / 升级 | 通过 |
| 旧合同保持 | 10 表列 / 类型 / null / default、外键完整集合 / 动作、版本行、未知 trigger / view、安装前 backup + verify、DBPath / 句柄一致、`BEGIN IMMEDIATE` 排他、fresh 回执、失败审计 / 回滚未知态均未回退 | 原 40 项领域与集成断言全部保留 |

测试口径（本窗实际运行，合成临时库，不连真实账套 / 税局）：`local-backup` **22 / 22**、
`bank-import` **16 / 16**、`bank-reconciliation` **40 / 40**、`bank-reconcile-cli` **12 / 12**、
`local-bank-backup-integration` **5 / 5**，五套合计 **95 / 95，exit 0**；原 stdout 存在本工作区 `.agent-runs/`（未提交）。
**未跑**全量 suite（代码只改备份 / 银行契约与文档；整合面全量由 root 冻结后执行，不为无源码变化的套件重复全量）。
仍为 **core v3 / v4 + 可选 bank v1**；未来 v5+、batch / audit 与其它未登记组件仍拒绝；无 UI / 共享模型入口；
LOCAL-03 双准则 / 辅助维度 / 往来合同未在本窗验收，不声称 LOCAL-04 整体完成。

## 14. 限制与未完成项（不声称已交付完成）

1. **已有库安装已打通，但仍有明确边界**：真实迁移前备份（含 WAL 已提交内容）、失败回滚、
   `backup → verify → restore-new` 与银行流水 / 来源批次 / 确认取消 / 未达金额完整性已验证（§13.3）。
   未交付：原位覆盖恢复、通用版本回退、审计 / 批量组件的安装与恢复接线（后续独立包）。
2. **共享接线未做**：HTTP / Agent / MCP / UI 与 `scripts/test-all.mjs` 均未接入，由共享串行窗口另开任务；
   当前交付的是可直接调用的 Node CLI 与领域 API。
3. **LOCAL-02 / LOCAL-03 合并依赖**：本包已按真实 v3 / v4（资产补项 5 列）结构读取账户，
   但 LOCAL02 最终合并到正式 main、LOCAL-03 辅助核算维度稳定后仍需重新核验；当前不声称 LOCAL04 整体 / 03 科目往来完成。
4. **组匹配未实现**：只返回提示码 `group_match_requires_manual` / `unsupported_group_match`，不自动组合。
5. **单一币种**：只有 CNY（分），无外币、无换汇、无汇率字段。
6. **一个银行账户绑定一个叶子科目**：没有辅助维度时，同科目多个银行账户会被拒绝；
   不按科目名称 / 前缀猜整套准则，只接受 1002 或显式 1002 明细。
7. **无稳定 ID 的去重边界**：文件级幂等依赖「文件内容摘要 + 映射指纹 + 行顺序」；同一份对账单被
   另存为不同换行 / 编码即视为新文件，交叠行会变成待判定歧义（不会被静默合并），这是有意的保守行为。
8. **观测边界**：失效核验在读取时进行，没有账务修订号 / 事件流，不能声称捕获两次调用之间的所有中间操作；
   共享写入口事件接线待后续任务。
9. **对账单完整性**：银行截止余额由操作者声明并与覆盖期流水净额自校验；不读取银行原件、
   不自动判断对账单是否覆盖全部交易，只按显式覆盖范围与来源说明给状态。
10. **不做**：银行网站 / 银行 API、SaaS / 多租户、自动调整凭证、自动结账、发票 / 税务适配。
11. **结构契约的边界**：`bankSchemaContract` 只核对结构 / 版本（表 / 列 / 主键 / UNIQUE / 索引签名与
    键语义（collation / 方向 / 表达式 / 来源）/ 规范化谓词 / 外键完整集合与动作 / 版本表形状 / 额外表），
    **不做内容一致性、行数或哈希比对**；
    也不做缓存，每次调用都重新读 `sqlite_master` + PRAGMA。谓词比对是**规范化文本整体相等**，
    不是语义等价判断：逻辑等价但写法不同的谓词会被保守拒绝，必须在升级时同步改契约与迁移。
    额外或未知的 `bank_*` 表会被当作「契约外结构」拒绝——将来真的加表必须先升版本并补迁移。
12. **内部完整扫描的成本**：失效核验 / 对账未达项按完整集合读（键集游标分块）；数据量很大时
    耗时随匹配数增长（501 笔全确认约 8 秒级），本版本不做增量 / 缓存机制，也不以展示分页换正确性。
13. **现库安装 / 组件备份恢复已实现，但不是完整恢复平台**：只支持 core v3 / v4 + 可选 bank v1、
    只恢复到全新目标；无组件旧备份继续原样验证 / 恢复。audit / batch 组件、原位覆盖、版本回退、
    HTTP / Agent / MCP 接线均未在本包交付（详见 §12 / §13.3）。
14. **03 双准则与 1002 叶子科目契约未复验**：本包只接受 `1002` 或其显式明细作为资产类借方叶子科目；
    LOCAL-03 的双准则 / 辅助维度合并后必须重新核验，不能声称已完成 03 依赖。
15. **备份层索引键语义（B 窗已补齐）**：B 窗已把银行组件全部 19 条索引（PK / UNIQUE / 命名 / 自动）接入
    逐键比对（`seqno` / collation / 方向 / 表达式 / rowid / `origin` / `partial` / 真实谓词），且主键
    `rowidAlias` 与复合主键按 core 新对象模型核对；`create` / `verify` / `restore-new` 三入口一致拒绝，
    原集成用例中「备份仍放行」的显式断言已改为拒绝。**仍不声称**：旧 bank 内部候选备份以外的历史格式、
    未来 bank v2+、batch / audit 组件、原位覆盖 / 版本回退。清单格式与 `structureDigest` 口径未改，
    旧的健康 core v3 / v4 与 bank 备份保持可读（不要求重生成 / 升级）。

16. **回滚未知态 / 调用方事务需调用者处置**：回滚失败 / 未确认时不会自动重试或重开事务，也不会静默关闭全局连接 /
    强杀服务；调用者必须先确认回滚成功或丢弃 / 重建连接，再 `recoverBankConnectionState`。连接上已有调用方事务 /
    保存点时银行一律 `bank_transaction_conflict` 拒绝（本次未开始），且**不提供**「在调用方事务里嵌套安装 / 写银行数据」
    的支持：需调用方先提交或回滚自己的事务再重试。CLI 是单次进程，失败后直接丢弃该连接（进程退出），不把未知态当成成功；
    CLI 无法从子进程制造调用方事务，故本条只有错误码到 exit 5 的映射，无对应子进程用例（不伪造）。


## 2026-10-23 fresh P1 回修候选（未合并）

本轮以 `7ca2e319610086f25769fe744256841b21b56c2b` 为实施基线，Issue #53 窗口从银行 8 路径扩到 9 路径，仅额外允许通用守卫的 release 选项。没有修改核心 `db.mjs`、备份实现或共享登记文档。

创建时固定实际 fd / 文件身份 / marker 身份与内容，打开 SQLite 前先比对私有创建种子和当前路径对象；随后仍由真实核心连接的通用 preDDL hook 核验，避免先做核心 DDL / WAL / 迁移再拒绝。回执字段修改、克隆、不同路径、目录 junction、替换旧 core3/4 业务库、同 inode 原地填入旧库、相同字节的新 marker 对象均拒绝。现库正常安装继续要求 backup + verify + 精确 schema + 事务结果门槛。

真实 CLI 负测额外发现：只读 SQLite 打开旧 WAL 库仍可能生成 `-wal` / `-shm`。因此银行 release 使用通用 `releaseFreshClaimFacts(token, { preserveDatabase: true })`，注销私有登记、关闭自有句柄并按创建身份处理 marker，完全跳过数据库探测和删库。默认 release 清理行为保持不变。新库失败后会保留未完成目标供人工核对，重试 `init-db` 不会覆盖它。

旧 P1 的 core3 替换案例在银行守卫之前已触发核心 v4 迁移，**确有核心 pre-v4 备份**；问题是银行绕过自己的安装前备份，不能表述为「从无任何备份」。本轮负测确认 core3/4 业务字节、凭证行、版本行不变，不新增 WAL / SHM / 迁移或银行备份目录。故障注入只在测试生成的 ESM loader 内，没有生产绕过开关。

全部合成 fixture 由本轮新建的专属 workspace 根承载，TEMP / TMP / fallback DATA 先指向该根，创建前核验祖先不是 reparse point；未访问真实账套或税局。回滚确认 / 未知态、调用方 BEGIN 与严格索引验收仍保留。测试结果与环境失败详见本任务和交接的本轮条目；本候选待管理者独审、冻结与 Git 收尾，不代表 LOCAL-04 整体完成。

## 2026-10-23 首次读页前纯文件核验 P2 窄修（待最终独审）

本条补充并限定前述历史候选结论。冻结旧候选 `ac3fe2943872ab9a4ac97c2b1763b9abf53d6c74` 的独立复现明确拒绝：在银行 `assertPristineCreationFiles` 返回后、readOnly SQLite 连接核验前，同 inode 填充普通已关闭 WAL 业务库，拒绝码正确且主库字节不变，但首次读页 `PRAGMA application_id` 会生成 0 字节 WAL / 32768 字节 SHM。constructor 和 `PRAGMA database_list` 本身没有生成 sidecar；未观察到业务 DDL、迁移或银行备份。这是拒绝过程的文件污染 P2，不能写成已证业务损坏，也不能用旧 150 项或旧候选 65 入口成功解除它。

本轮仅修改守卫、银行 CLI 测试和银行三文档（Issue #53 comment6357702843 的五路径窗口）。守卫在 connectionFacts 首次 SQL 前，用新开的纯文件只读 fd 核验页头魔数、application_id 与 nonce；db-init 还要求实际大小和完整 4096 字节种子一致。新读取 fd 的 fstat 必须与私有创建身份及保留创建句柄、路径身份匹配；finally 仅关闭本次自有读取句柄。07 创建 fd 仍可为只写 `wx`，不要求改为读写。stamp 的种子验证也先做同样纯文件核验。原 marker、创建身份与实际 SQLite 连接核验继续保留，银行失败 release 继续 preserveDatabase；没有扩改 storage、生产故障开关或协议。

正式 CLI 新增精确预检后同 inode WAL 注入用例，原 14 项及业务断言保留。旧源码下该新用例 exit 1，失败于新增 WAL 断言；新源码下 exit 0，拒绝 `fresh_database_foreign_content`，主库字节、业务行 991、迁移版本 3 和 user_version 73 保持，拒绝时无 WAL / SHM / DDL / 迁移或备份目录。独立 SQL 验证安排在 sidecar 断言之后，避免把测试自身读取所建文件误算成被测入口行为。

本轮在 `06-workbench` 的受影响自测实际通过，均 exit 0：`node test/bank-reconciliation.test.mjs` 43/43、`node test/bank-reconcile-cli.test.mjs` 15/15、`node test/local-bank-backup-integration.test.mjs` 5/5、`node test/local-backup.test.mjs` 22/22、`node test/local-batch-persistence.test.mjs` 39/39、`node test/local-batch-cli.test.mjs` 11/11，合计 135 项。junction 用获批准的真实合成构造验证，没有 skip。07 CLI 首轮 10/11 exit 1 是本次漏设 `REPORT_OFFICE_PYTHON`；补设指定内置 Python 后完整 11/11 exit 0，初轮日志保留。纯文件自有探针另有正常只写创建 fd 成功、读取 EIO、短读三组：后两组在任何 SQLite SQL 前拒绝，读取 fd 关闭，创建 fd 未误关，主库不变且无 sidecar。

全部 TEMP / TMP / fallback DATA 在本轮新建 workspace 专属根内，事先核验祖先无 reparse point，只用合成 fixture 与自有子进程；未扫描清理全局 TEMP、未读取真实账套或税局凭据。日志、命令和最终五路径 SHA256 见管理者本机忽略目录 `.agent-runs/bank-narrow-wal-p2-delivery-20261023.md`。本次实现未执行 Git 写操作，未运行新候选全 65 入口，未声明最终独审接受、PR ready / 合并或 LOCAL-04 整体完成。边界仅闭合已实证时序及同根因文件内容检查，不承诺检查后无限持续恶意物理并发改写；下一步由管理者冻结新 head、fresh 独审和最终回归验收。
