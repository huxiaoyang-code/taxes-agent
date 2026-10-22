# 任务单 · LOCAL-04-BANK 本地银行 CSV、持久对账与余额调节

- 类型：后端领域 + 组件持久层 + 本机 CLI + 契约文档 + 测试
- 状态：原 56 项银行包已独审并合入冻结核；**2026-10-22 追加「现库安装 / 组件备份」子包，真实集成验收完成；随后 #53 独审 2 项 P2 分窗回修：A 窗（索引键语义 + 回滚失败状态）完成，第二轮独审 P2（调用方外层事务 / 事务未建立 vs 已确认回滚）已完成，银行 A 最终 `950b7d6` 的独立复审已被 root 记录接受；B 窗已同步已合核心 main 并补齐备份侧银行组件索引键语义，自测完成，待 root 冻结 / 独立复审 / Git 收尾**。本文件不预写 PR 编号、已审 head 或 merge，也不声称最终已通过。
- 第二轮独审回修基线：`c8f490c6b4d4e0f4bdaa9acf378defa900334e80`；B 窗开工时工作区已实际包含银行 A `950b7d6` 与核心 PR #60 merge `dfefae0`（含备份严格索引修复 `75b448d`）。
- B 窗只改 13 文件 claim 的子集（见 §11.3），**不改** `bank-reconciliation.mjs`、核心 / DB / import / HTTP / Agent / MCP / public / `scripts/test-all.mjs` / package；四个银行套件的 test-all 登记仍由 root 后续独立短窗完成。
- 子包基线：`ce4078222c9e5fb8508c9fe24a9183f17d46ea28`（银行 91f07eb + 核心 bd05415 + 备份 3399500 冻结组合并入最新 main `db6020a`）
- 本轮返工基线（原 56 包冻结 head）：`46e0fc0ecb74703cc8482aab9a1cf3f85839f232`；原分页 / 截止日 / 事务 / CSV 四项及大数据探针已独审通过，返工只限结构门槛及必要测试文档。
- 上一轮阻塞审查基线：`e2545216226b87262508d8a94f38426415670d8c`。
- 基线：`257f96275031eefa484699dd71bd012e2d221e51`（含已审 PR #52 导出模块、PR #50 输出策略模块；schema 仍为 LOCAL-01 v3）
- 分支：`codex/huxiaoyang-code/local-04-bank`；工作区：`.worktrees/local-04-bank`
- 负责人：`huxiaoyang-code`（已核实）
- 远端载体：[Issue #53](https://github.com/huxiaoyang-code/youshu-fork/issues/53)（`Refs #20` / `Refs #13`）
- 契约：[LOCAL-BANK](../LOCAL-BANK.md) · 交接：[handoffs/LOCAL-04-BANK](../handoffs/LOCAL-04-BANK.md)
- 总览：[INDEPENDENT-PRODUCT-WORK](INDEPENDENT-PRODUCT-WORK.md)（八包中的 LOCAL-04）

## 1. 目标

交付本机可直接运行的银行流水与余额调节闭环：

1. CSV 预检 / 字段映射（含引号、BOM、多行字段、严格日期、整数分、方向显式映射）；
2. 批次导入落库：批次身份绑定账套 / 银行账户 / 来源 / 批次 ID / 文件摘要 / 映射与规范化版本；
   同批重试幂等、同文件重导不增流水、同稳定 ID 同内容复用、改内容结构化冲突；
3. 无银行稳定 ID 时只把同特征行保存为**待人工判定的疑似重复证据**（不误吞、不静默合并），
   由操作者逐行判定「同一笔 / 不同一笔」并给理由；
4. 从真实库的 **posted** 凭证银行科目分录生成候选（`voucher_id + entry_id + line_no`），
   人工确认 / 取消匹配；同一流水 / 同一分录只能有一个有效匹配；
5. 所有 status / 查询 / 候选 / 确认 / 对账都**读时重新核验**账务：反过账、删除、改分录 / 日期 / 期间 /
   科目 / 金额后立即失效并降级，不自动恢复；
6. 余额调节：账面 = 真实期初 + 截止日全部历史 posted 银行分录；银行截止余额由操作者声明并与
   覆盖期流水净额自校验；输出四类未达项、两边调节后余额与差额，差额不得自动补项凑平；
7. 独立 `bank_*` 组件 schema 与组件版本；已有库迁移前必须走 LOCAL-06 一致备份门槛，
   备份不可用时安全拒绝（`migration_backup_unavailable`）；新库由创建事实驱动的初始化流程建立；
8. 真实可调用 Node CLI（显式 `--db`），清晰 JSON / text 输出、稳定错误码与非零退出码。

## 2. 非目标

- 不接银行网站 / 银行 API / 银行凭据，不做自动下载对账单；
- 不做 SaaS / 多租户 / 租户权限 / 对外服务 / 账户体系（产品仍是本机单用户）；
- 不生成、修改、删除任何账务凭证 / 期初 / 期间；不自动结账、不把「银行已对平」当账务可结账；
- 不实现一对多 / 多对一自动组匹配（只返回明确的「需要人工 / 未实现」提示）；
- 不扩展外币 / 换汇 / 汇率；不实现辅助核算维度（等 LOCAL-03 稳定契约）；
- 不修改 `accounting.mjs` / `db.mjs` / `import-storage.mjs` / `coa.mjs` / `server.mjs` /
  `agent-tools.mjs` / MCP / `scripts/test-all.mjs` / `package.json` / 锁文件 / `public/*` /
  共享 STATE / 索引 / 其他 docs / local-backup / report-office / LOCAL08 模块；
- 不做 HTTP / Agent / MCP / UI 接线（共享串行窗口另开任务）；
- 不执行 Git 提交 / 推送 / 合并；不读取真实账套、银行文件或凭据。

## 3. 精确文件清单（原 56 项包历史清单）

> 下列 10 文件是原 56 项银行包的历史边界；2026-10-22 现库安装 / 备份子包的 10 文件边界见 §9.1。

| 文件 | 作用 |
|---|---|
| `06-workbench/server/bank-import.mjs` | CSV 解析、字段映射、日期 / 金额 / 方向规范化、预检、指纹与限制（纯函数，无数据库副作用） |
| `06-workbench/server/bank-storage.mjs` | `bank_*` schema v1、组件版本、迁移前备份门槛、创建事实回执、CRUD / 审计 / 对账运行记录 |
| `06-workbench/server/bank-reconciliation.mjs` | 账户登记、导入落库、候选、确认 / 取消、读时失效核验、余额调节、状态汇总 |
| `06-workbench/scripts/bank-reconcile.mjs` | 本机 CLI（显式 `--db`、JSON / text、错误码与退出码、`init-db`） |
| `06-workbench/test/bank-import.test.mjs` | CSV / 映射 / 金额 / 日期 / 预检纯函数回归（16 项） |
| `06-workbench/test/bank-reconciliation.test.mjs` | 真实临时库领域回归：幂等 / 去重 / 歧义 / 候选 / 匹配 / 失效 / 余额调节 / 分页与 asOf / 结构契约（含索引谓词、外键完整集合、版本表形状、**索引键 collation / 方向 / 表达式 / 来源**）/ 对账原子性 / **回滚失败状态机与导入失败审计**（A 窗 29 → 36 项） |
| `06-workbench/test/bank-reconcile-cli.test.mjs` | CLI 子进程端到端回归（A 窗 11 → 12 项，含索引键漂移 exit 5） |
| `docs/LOCAL-BANK.md` | 契约：表 / 函数 / CLI / 公式 / 错误码 / 限制 / 备份门槛 |
| `docs/tasks/LOCAL-04-BANK.md` | 本任务单 |
| `docs/handoffs/LOCAL-04-BANK.md` | 版本化交接（实际结果、未完成项、复验命令） |

**修改文件：无。** 需要更多文件（共享路由、共享测试总入口、UI、备份合同接线）时必须先由管理者登记。

## 4. 依赖与合同状态

| 依赖 | 状态 | 本包如何处理 |
|---|---|---|
| LOCAL-01 批次语义 / v3 schema | 已合并 | 银行组件独立 `bank_*` 命名空间，只读当前 `vouchers` / `voucher_entries` / `opening_balances` / `accounts` / `periods`，不写全局版本 |
| LOCAL-06 一致备份 | 已合入冻结核（3399500）并由 §9 子包真实打通 | 备份实现作为窄依赖注入；未提供时安全拒绝（`migration_backup_unavailable`）。§9 已补全新专属备份子目录、严格真实字段校验、DB 句柄路径绑定、`BEGIN IMMEDIATE` 排他安装与失败回滚；组件备份支持可选 bank v1 |
| LOCAL-02 金额 / 期末完整性 | 冻结组合 bd05415；最终合入 02 正式 main 待 root 同步 | 按当前真实 v3 / v4 schema 读账；账务金额按整数分读取，非精确到分给结构化错误；最终同步后需补兼容回归 |
| LOCAL-03 双准则 / 辅助维度 | 未合并 | 首版一个银行账户绑定一个 1002 叶子科目，同科目多账户拒绝；**双准则与 1002 叶子科目映射尚未实际复验**，不得声称已完成 03 依赖 |
| 共享接线（HTTP / Agent / MCP / UI / test-all） | 未做 | 本包直接交付可调用 Node CLI 与领域 API，不等待接线即可跑业务；接线单列后续任务 |

## 5. 验收标准（对照本包实际结果）

| 验收项 | 结果 |
|---|---|
| CSV 引号 / BOM / 换行 / 重复表头 / 畸形引号 / 缺列 / 超限 | 通过（`bank-import.test.mjs`） |
| 严格日期、真实日历、期间一致、不做时区换算 | 通过 |
| 整数分、空 / 零 / 负号 / 千分位 / 超精度 / 指数 / 超界 / 双边非零 | 通过 |
| 同批跨进程重试幂等、同文件新批次不增流水并逐行追踪 | 通过（CLI 子进程） |
| 同稳定 ID 同内容复用、改内容冲突、不同 ID 同日同额保留两笔 | 通过 |
| 无稳定 ID：文件内两条都保留；交叠窗口只存待判定证据；same / distinct / 幂等 / 改判拒绝 | 通过 |
| 真实会计 API 建两企业账套 / 银行科目 / 期初 / posted / 草稿；候选只读 posted | 通过 |
| 错账套 / 账户 / 币种 / 期间 / 日期 / 金额 / 方向拒绝；多候选人工选择；组匹配明确未实现 | 通过 |
| confirm / cancel / reconfirm 跨进程持久；双重占用只成功一次；取消保留证据且幂等 | 通过 |
| 反过账后查询立即失效；重过账不自动恢复；删除 / 改金额 / 日期 / 科目 / 行号分别识别 | 通过 |
| 余额调节固定手算 140000 / 140000 / 差额 0；1 分差异暴露；跨月未达；期初贷方余额；非零差额 | 通过 |
| 覆盖不完整 / 缺来源 / 未决歧义 / 失效匹配时不得声明已对平 | 通过 |
| 事务中途数据库错误后无半笔流水；修复后同批次可重试 | 通过（触发器注入失败） |
| CLI 显式 `--db`；无参 / help / 拼错路径不创建默认库 | 通过 |
| 已有库无备份实现时安全拒绝且不建 `bank_*` 表 | 通过（exit 5） |
| 不生成 / 修改凭证与期间；审计不被业务删除级联抹掉 | 通过 |
| 内部业务判定不读展示分页：501 笔全确认后调节后 50100 / 50100、反过账后 checked=501、候选全部标记占用、201 批次 / 501 歧义的**真实计数**、>500 已复核失效前缀不掩盖后续未复核 | 通过（首轮审查 P1 修复，冻结 head 上失败） |
| 余额调计按 asOf 视角：合法跨日匹配不提前消除、反方向跨日与两侧都发生正常消除 | 通过（首轮审查 P1 修复） |
| 组件结构 / 版本契约：未来版本 / 矛盾版本 / 缺表 / 缺列 / 主键 / UNIQUE / 索引签名 / 外键动作 / 额外表均在业务写前拒绝且无写入，CLI 不能绕过 | 通过（首轮审查 P2 修复，领域 + 子进程两路） |
| 结构契约复审收敛：部分索引实际 `WHERE` 谓词、外键完整集合（额外 / 重复）、版本表形状损坏都在业务写前结构化拒绝；正确谓词的空白 / 引号写法兼容，未来版本仍拒绝，不泄露原始 SQL | 通过（本轮 3 项 P2，领域 3 + CLI 1 新增用例；冻结 head 上先红后绿） |
| 索引键语义：`COLLATE NOCASE` / `RTRIM` / `DESC` / 表达式键 / 额外唯一索引 / 命名与自动索引互顶都在任何业务写前 `bank_schema_corrupt`；正常结构下只差大小写的稳定 ID 两条都导入 | 通过（A 窗 P2-1，领域 2 + CLI 1 + 集成 1 用例） |
| 回滚状态：真实 `COMMIT` busy（DELETE journal 读事务）后确认回滚才说已回滚；回滚失败 / 未知给固定错误 + 标志，未知连接拒绝银行读写与安装，需显式恢复 / 丢弃；fresh 与嵌套 SAVEPOINT 同样；导入失败审计不伪造已留痕 | 通过（A 窗 P2-2，领域 5 用例；`ROLLBACK` 失败为单点注入，不是实测磁盘故障） |
| 事务冲突 / 事务未建立：调用方已有外层事务时安装与写入在消耗回执 / 备份 / DDL 前即 `bank_transaction_conflict`（`started:false` / `rolledBack:false` / `transactionActive:true`），调用方事务与未提交行保持原样、银行未安装；`bankConnectionState` 不说 `transactionActive:false`；调用方结束后同一回执可完成新库安装、现库可安装、写入恢复；`BEGIN` / `SAVEPOINT` 没建立给 `bank_transaction_begin_failed`，嵌套层整层放弃给 `bank_transaction_discarded`；调用方事务里不写失败审计 | 通过（第二轮独审 P2，领域 4 用例，冻结 head 上 4 / 4 失败） |
| 对账结果持久化原子：插运行记录失败与插审计失败都全组件回滚，无无审计新结果、无误废弃旧结果 | 通过（首轮审查 P2 修复） |
| CSV 错误列表总上限：201 行坏金额不崩、重复流水号追加路径共用上限、截断不误报 ok | 通过（首轮审查 P2 修复） |
| 既有全套回归 | 上一轮 `npm test` 47 / 47 套件通过；本轮只跑定向 3 套（未改上游共享代码） |

## 6. 实际测试命令与结果（本次运行）

> 第二轮独审 P2 的本轮实际运行与先红后绿证据见 §11.4；下列为 A 窗记录（仍然成立）。

工作目录 `06-workbench`：

```
node --test test/bank-import.test.mjs          # 16 / 16 通过
node --test test/bank-reconciliation.test.mjs  # 36 / 36 通过（A 窗 29 → 36）
node --test test/bank-reconcile-cli.test.mjs   # 12 / 12 通过（A 窗 11 → 12）
node --test test/local-backup.test.mjs         # 20 / 20 通过（A 窗未回退）
node --test test/local-bank-backup-integration.test.mjs  # 5 / 5 场景（A 窗 4 → 5）
                                                # 五套合计 89 / 89 通过，exit 0
```

原 52 项用例（16 / 26 / 10）保留未删弱；本轮新增 4 个用例（3 领域 + 1 CLI）在冻结 head `46e0fc0` 上
全部失败、在返工实现上全部通过。红 / 绿探针使用真实临时 SQLite：冻结 head 上错索引谓词仍 `ok + already-initialized`、
audit 额外 FK 仍 `ok` 且真实删除账套后审计 1→0、版本表改名后 `bankSchemaContract` 抛 `ERR_SQLITE_ERROR`；
返工后三处均为结构化 `bank_schema_corrupt`，审计额外 FK 被拒，版本表形状损坏不再抛原始 SQL。
`npm test` 本轮未重跑（只改银行包内文件，未动上游共享代码），不把上一轮 47 / 47 当作本轮证据。

## 7. 未完成项（不声称整个 LOCAL-04 已交付完成）

1. ~~已有库迁移 / 组件升级的真实验收~~：**已由 §9 子包完成**（真实 create + verify、WAL 已提交内容、失败回滚、
   backup → verify → restore-new、银行流水 / 批次 / 确认取消 / 未达金额完整性）。仍不包含原位覆盖恢复与通用版本回退。
2. HTTP / Agent / MCP / UI 与 `scripts/test-all.mjs` 接线（共享串行窗口）；本轮只跑定向 3 套，未重跑 `npm test`。
3. LOCAL-02 / LOCAL-03 稳定合同合并后的真实兼容回归与版本记录；辅助核算维度下的多银行账户支持再评估；
   03 双准则与 1002 叶子科目映射尚未实际复验。
4. 一对多 / 多对一人工组匹配（当前只有明确提示码，不自动占用分录）。
5. 外币 / 换汇、银行网站 / API 接入：明确不在本包范围。
6. 组件结构契约只核对结构 / 版本（不做内容 / 行数 / 哈希校验），且不加缓存；部分索引谓词按规范化文本整体相等
   比较（逻辑等价但写法不同会被保守拒绝）；外键按完整集合比较；额外 `bank_*` 表会被拒绝，真正加表必须先升版本并补迁移。
7. 内部完整扫描的性能：501 笔全确认约 8 秒级，数据量更大时耗时会线性增长；本版不做增量 / 缓存。
8. **备份层索引键语义（B 窗已补齐）**：B 窗已把银行组件全部 19 条索引（PK / UNIQUE / 命名 / 自动）接入
   逐键比对（`seqno` / collation / 方向 / 表达式 / rowid / `origin` / `partial` / 真实谓词）与主键
   `rowidAlias` / 复合主键语义；`create`（源库）/ `verify`（快照）/ `restore-new`（恢复目标）三入口一致拒绝，
   原先集成用例中「备份仍放行」的显式断言已改为拒绝。仍不支持未来 bank v2+、batch / audit 组件、原位覆盖 / 版本回退。
   清单格式 / `structureDigest` 口径未改，旧 core v3 / v4 与旧 bank 内部候选备份保持可读。
9. **回滚未知态 / 调用方事务需调用者处置**：不自动重试、不自动重开事务、不关闭全局连接或强杀服务；CLI 单次进程失败后
   丢弃连接（退出），不把未知态当成功。连接上已有调用方事务 / 保存点时一律 `bank_transaction_conflict`（本次未开始，
   不提交 / 不回滚那层事务），**不提供**在调用方事务里嵌套安装 / 写银行数据；需调用方先自行提交或回滚后重试。

## 8. 交付后管理者需要做

1. 阅读实际 diff（4 实现 + 3 测试 + 3 文档，无共享文件改动）；
2. 复现关键金额与失败路径（§6 命令；固定手算 140000 / 140000 / 差额 0；1 分差异 pending_review；
   已有库无备份 exit 5；错索引谓词 / 额外外键 / 版本表改名均在业务写前 `bank_schema_corrupt`；
   调用方外层事务下 `bank_transaction_conflict` 且 `isTransaction` / 未提交行不变，调用方结束后可安装）；
3. 由未参与实施、不继承实施上下文的独立 Codex subagent 独审；返工仍由本员工实现；
4. 按已验证 head 提交 / 建 PR / 合并，并补真实交接与远端 Issue 关联；本文件不预写这些结果。

## 9. 2026-10-22 子包：现库安装 / 组件备份真实整合

### 9.1 边界

- 基线 `ce4078222c9e5fb8508c9fe24a9183f17d46ea28`；沿用远端 53 + 47 已登记的 10 文件边界，只动：
  `server/local-backup.mjs`、`server/bank-storage.mjs`、`scripts/bank-reconcile.mjs`（本轮无需修改）、
  `test/local-backup.test.mjs`（未修改）、`test/bank-reconciliation.test.mjs`、`test/bank-reconcile-cli.test.mjs`、
  新增 `test/local-bank-backup-integration.test.mjs`、`docs/LOCAL-BANK.md`、本文件、`docs/handoffs/LOCAL-04-BANK.md`。
- **未分配 / 未修改**：`accounting.mjs`、`db.mjs`、`import-storage.mjs`、其他组件、`server.mjs`、Agent / MCP、
  `scripts/test-all.mjs`、`package.json`、`docs/LOCAL-BACKUP.md` 及另外两份公共 backup docs。公共 backup 文档待后续专门同步。
- 只使用合成临时库；未接真实税局 / 真实账套 / 凭据。未执行 Git 提交 / 推送 / 合并。

### 9.2 实现事实

1. `ensureBankSchema` 不再把已有 `dataDir` 直接当 `outDir`：每次安装分配全新
   `<dataDir>/bank-component-backups/pre-bank-v1-*`，与真实 `createBackup` 的「全新目录」要求一致。
2. 严格读取真实返回：create 必须 `ok` + `backupDir` + `backupMeta.snapshotBytes/sha256`；verify 必须
   `ok` + `status='ok'` 且摘要绑定 create；再绑定清单来源文件 / 核心 schema 版本 / 不得已含组件。
   `true`、`integrity:'ok'`、仅 `{ok:true}` 的 mock 均拒绝。
3. 安装前用 `PRAGMA database_list` 核对连接的真实文件就是 `dbPath`；不一致 `database_handle_mismatch`，不备份 A 装 B。
4. 已有库的备份 + DDL + 版本 / 备份证据在同一个 `BEGIN IMMEDIATE` 写事务内；备份期间其他连接不能提交新业务写入，
   DDL 后自检失败整体回滚；失败时迁移前备份保留但不登记为成功证据。
5. `bankSchemaContract` 扩展到列名 / 类型 / NOT NULL / 默认值 / 主键 / UNIQUE / 索引签名与真实 partial 谓词 /
   外键完整多重集与动作 / 额外索引；新增 `BANK_COMPONENT_STRUCTURE` 作为 backup 共用的完整结构契约。
6. `local-backup.mjs` 支持可选 bank 组件 v1：完整 10 表 + 严格结构 / 内容约束 + 无未登记触发器和视图；
   manifest 新增可选 `components[]`（name / version / tables / structureDigest / contentDigest / rows），
   create / verify / restore-new 三层一致重算。无 bank 的旧 v3 / v4 清单保持无 `components` 且原样验证 / 恢复。
7. 未知 / 半套 / 未来 / 错报组件、额外 `bank_*` 或 audit / batch 未知表仍拒绝；只恢复到全新目标。

### 9.3 本轮实际测试（工作目录 `06-workbench`）

```
node --test test/bank-import.test.mjs                        # 16 / 16
node --test test/bank-reconciliation.test.mjs                # 29 / 29
node --test test/bank-reconcile-cli.test.mjs                 # 11 / 11
node --test test/local-backup.test.mjs                       # 20 / 20
node --test test/local-bank-backup-integration.test.mjs      # 4 / 4 场景（40+ 断言）
```

五套合计 **80 / 80**，全部 exit 0。原 backup 20 项与银行 16 + 29 + 11 项语义保留；
银行领域新增了对列类型 / 默认值 / NOT NULL、额外索引与触发器的更严结构核对（业务写入口不拒绝合成测试用 trigger，
避免破坏原有注入失败测试；备份验证器会拒绝未登记 trigger）。
另修正两处**基线漂移**的旧断言：核心 import schema 已到 v4，`schema_migrations` 期望由 `[1,2,3]` / `3` 更新为 `[1,2,3,4]` / `4`，
语义仍是「银行组件不得写全局迁移版本」。

### 9.4 金额与恢复证据

- 期初账面 / 对账单 1000；共同收 200、共同支 100；企业已收银行未收 50；企业已付银行未付 30；
  银行已收企业未收 20；银行已付企业未付 10。
- 账面 1120.00；对账单 1110.00；四类未达 50 / 30 / 20 / 10；调节账面 = 调节银行 = 1130.00，差额 0；不生成调整凭证。
- 安装前备份可恢复到全新目标并还原原核心；安装后 `backup → verify → restore-new` 保留 4 笔流水、1 个批次、2 笔确认、
  运行记录与 1130 / 1130 / 0；恢复后取消匹配与反过账使 stale / invalidation 可见；双账套互不影响。
- core3 派生库安装银行后仍为 v3；备份清单仍按 v3 并绑定 bank v1；恢复后不自动升级。

### 9.5 未完成 / 后续依赖

1. 仅支持 core v3 / v4 + 可选 bank v1；audit / batch 组件、原位覆盖恢复、通用版本回退、HTTP / Agent / MCP 接线未交付。
2. 原「现库安装 / 组件备份」子包未修改 `scripts/test-all.mjs`、`package.json` 与公共 backup 三文档；B 窗按新 13 文件 claim 已同步 banking 与备份三文档，但四个银行套件的 test-all 登记仍由 root 后续独立短窗完成。
3. 本分支不是「LOCAL04 整体 / LOCAL03 科目往来已完成」；LOCAL02 正式合入并同步最终修复前，本子包不合并；
   最终合入仍需 root 同步 02 正式 main。
4. 上游整合后 root 需重跑全量回归；本包只跑影响面定向五套。

## 10. 2026-10-22 A 窗：#53 独审 2 项 P2 回修

### 10.1 分窗边界（本窗精确文件）

A 窗只改 9 文件：`06-workbench/server/bank-storage.mjs`、`server/bank-reconciliation.mjs`、
`scripts/bank-reconcile.mjs`、`test/bank-reconciliation.test.mjs`、`test/bank-reconcile-cli.test.mjs`、
`test/local-bank-backup-integration.test.mjs`、`docs/LOCAL-BANK.md`、本文件、`docs/handoffs/LOCAL-04-BANK.md`。

**禁止**：`server/local-backup.mjs` / `test/local-backup.test.mjs`（核心备份两文件已交 #47）、共享 core / test-all、
`docs/05` / `docs/08`。未接 HTTP / Agent / MCP / UI，未跑全 55 套（已知 02 输出兼容候选未同步，不越界修）。
本窗不宣称三入口均已拒绝 collation 变体，也不写「已提交 / 已合 / 最终通过」。

### 10.2 P2-1 索引键语义（不只比列名）

- 回修前真实表现（head `06d1bd1`）：把 `idx_bank_txn_ref` 最后键改为 `bank_ref_id COLLATE NOCASE`，列名 / UNIQUE /
  partial / `WHERE` 全不变 → `bankSchemaContract` 仍 ok，`createBackup` / `verifyBackup` / `restoreNew` 也 ok；
  恢复库上真实导入 `Ref-A` / `ref-a` 第二笔 UNIQUE 失败，而正常结构下两笔都成功。
- 修复：`indexSignatures` 改读 `pragma_index_xinfo`，逐键固定列名 / `coll` / `desc` / 是否表达式 / 是否 rowid，
  并校验 `origin`（命名 `c`；自动 `pk` / `u`）；契约对全部 19 条索引声明「普通列 + BINARY + 升序 + 非表达式」，
  列名从键语义派生；额外唯一约束 / 表达式 / 来源顶替一律 `bank_schema_corrupt`。
- B 窗已补齐：`local-backup.mjs` 的银行组件校验现按同一 `BANK_COMPONENT_STRUCTURE` 逐键读 `keys` / `origin` / `partial` / 真实谓词，
  并把 `rowidAlias` 与复合主键纳入 core 同套对象模型；源库 / 快照 / 恢复目标三入口一致拒绝（见 §11.3）。

### 10.3 P2-2 回滚失败不得冒充已回滚

- 回修前真实表现：真实 DELETE-journal 读事务让安装 `COMMIT` 实际 `database is locked`，正常 `ROLLBACK` 后
  `isTransaction=false`、bank 表 0；再仅注入 `ROLLBACK` 抛 I/O 错误，实现仍报「原库已回滚」，而
  `db.isTransaction=true`、同连接内 10 张 bank 表 / 版本行仍未提交；fresh 分支 `inTransaction` 同样吞错。
- 修复：`inTransaction` / `ensureBankSchema` 区分已确认回滚（`rolledBack:true`）、已确认整体放弃
  （`bank_transaction_discarded`）、回滚失败 / 未知（`bank_transaction_rollback_failed` + `rolledBack:false` +
  `transactionActive`，固定措辞不回显原始 SQL / 路径）；内层 `SAVEPOINT` 失败即使被吞掉外层也绝不 `COMMIT`；
  未知态连接对银行读写与 `ensureBankSchema` 统一 `bank_connection_state_unknown`，只能由调用方先确认回滚 /
  丢弃连接再 `recoverBankConnectionState`（仍在事务中给 `bank_connection_recovery_refused`）；
  导入失败审计只在确认回滚的连接上写，未知态 `auditRecorded=false` + `auditFailure` 明说未写入。

### 10.4 本窗实际测试（工作目录 `06-workbench`，合成临时库）

```
node --test test/bank-import.test.mjs                     # 16 / 16
node --test test/bank-reconciliation.test.mjs             # 36 / 36（29 → 36）
node --test test/bank-reconcile-cli.test.mjs              # 12 / 12（11 → 12）
node --test test/local-backup.test.mjs                    # 20 / 20（未回退）
node --test test/local-bank-backup-integration.test.mjs   # 5 / 5（4 → 5）
                                                          # 合计 89 / 89，exit 0
```

root 在 06d 管理的 16 + 29 + 11 + 20 + 4 = **80** 是回修前 head 的结果，仍然成立；本窗新增 7 领域 + 1 CLI +
1 集成用例，旧断言未删弱。真实 `COMMIT` busy 是 DELETE-journal 读事务实测（产品 WAL 路径当前无此失败）；
`ROLLBACK` 失败是**单点注入**，不声称已实测真实磁盘故障。绿测不等于独审通过：root 冻结后仍需独立复审；
下一 B 窗新会话同步 #47 后补备份侧索引键语义，不继续扩大本窗。

## 11. 2026-10-22 第二轮独审 P2：调用方外层事务 / 未开始不得冒充已确认回滚

### 11.1 边界

- 回修基线：head `c8f490c6b4d4e0f4bdaa9acf378defa900334e80`；仍只在 §10.1 登记的 9 文件范围内改动，
  实际改动 7 个（3 实现 + 1 测试 + 3 文档；CLI / 集成两个测试只重跑未改）；
  **禁止** `server/local-backup.mjs` / `test/local-backup.test.mjs`（已交 #47）、共享 core / `scripts/test-all.mjs`、
  `docs/05` / `docs/08`。未接 HTTP / Agent / MCP / UI，未跑全 55 套，未用真实账套 / 税据。

### 11.2 回修前真实表现（独审复现，已由本窗重新确认）

真实新库 + 有效 `claimFreshDatabase` 回执，调用方先 `db.exec('BEGIN IMMEDIATE')` 并插 1 条合成 `account_sets`，
再 `await ensureBankSchema(db, { dbPath, receipt })`：

- `inTransaction` 的 `BEGIN IMMEDIATE` 在 `try` 外抛错，fresh 分支仍包成 `bank_migration_failed` +
  `rolledBack:true` / `transactionState:'rolled_back'`，消息称「已确认回滚（未留下半成品）」；
  实际 `db.isTransaction=true`、未提交行仍在、10 张 `bank_*` 表 0，且没有执行 `ROLLBACK`；
- `bankConnectionState` 却返回 `writable:true` / `transactionActive:false`（与实际活动外层事务不符）；
- 创建回执被消耗，调用方结束后同一回执重试落到已有库备份门槛（`migration_backup_unavailable`），
  本应可完成的新库安装反而失败；
- 现库分支同一场景给 `migration_lock_failed`（不是事务冲突）；调用方事务里导入只抛原始 `ERR_SQLITE_ERROR`；
  `BEGIN` / `SAVEPOINT` 没建立时没有任何结构化错误，也无法与「已确认回滚」区分。

### 11.3 修复

1. `inTransaction` 在 `BEGIN` / `SAVEPOINT` 之前先识别调用方事务：`bank_transaction_conflict` +
   `started:false` / `rolledBack:false` / `transactionState:'external_transaction'` / `transactionActive:true` /
   `bankManaged:false`；不开事务、也**不**提交 / 回滚调用方事务。`BEGIN` / `SAVEPOINT` 没建立起来时给
   `bank_transaction_begin_failed` + `transactionState:'not_started'`，不把连接拉黑（没有写入可回滚）。
2. `ensureBankSchema`（新库与现库）在任何 DDL / 备份目录 / 回执消耗**之前**做同一冲突检查（银行嵌套层给
   `bankManaged:true`）；新库分支只在安装确认提交后才消耗回执；现库 `BEGIN` 失败且 `db.isTransaction=true` 时按冲突
   报告（不再写成锁失败）；`migration_lock_failed` 也带 `started:false` / `rolledBack:false`。
3. `bankConnectionState` 的 `transactionState` 为 `clean` / `external_transaction` / `rollback_unconfirmed`，
   `transactionActive` 直接来自 `db.isTransaction`，`writable` 只表示「银行可自行开事务并提交」
   （未知态与调用方事务都不满足），并新增 `externalTransaction` / `bankManagedTransaction` 标志。
4. 导入失败审计：调用方事务仍在进行时不写进它，固定 `auditFailure`（「调用方事务仍在进行（银行未启动自己的事务），
   本次失败审计未写入」）+ `auditRecorded:false`；未知态文案保持不变。
5. CLI：`bank_transaction_conflict` / `bank_transaction_begin_failed` 映射为 exit 5（写入被阻断），
   不泄露原始 SQL / 路径。
6. 保持：本库管理的嵌套事务成功与外层整层放弃语义、真实 `COMMIT` busy 四象限、单点 `ROLLBACK` 注入结论均不变；
   **未**用自动关闭用户连接 / 强杀服务解决。

### 11.4 本窗实际测试（工作目录 `06-workbench`，合成临时库）

```
node --test test/bank-reconciliation.test.mjs             # 40 / 40（36 → 40）
node --test test/bank-reconcile-cli.test.mjs              # 12 / 12（断言未改，验证新错误码不破坏既有 exit 码）
node --test test/local-bank-backup-integration.test.mjs   # 5 / 5（回滚与备份四象限保持）
                                                          # 受影响三套 57 / 57，exit 0
```

`bank-import` 16 与 `local-backup` 20 本轮内容未改、**未重跑**（不写「又跑过」）。
新增领域 4 用例先红后绿：将冻结 head `c8f490c` 的三份实现文件（不通过 Git 提交，仅临时替换后恢复）跑同一 4 个用例，
结果 **4 / 4 失败**（新库分支 `bank_migration_failed(rolledBack:true)`、现库分支 `migration_lock_failed`、
导入抛原始 `ERR_SQLITE_ERROR`、BEGIN 失败无结构化错误）；本轮实现下 **4 / 4 通过**。
CLI 无法从子进程制造调用方事务，故本轮只有错误码 → exit 5 的映射，无对应子进程用例（不伪造）。

### 11.5 未完成 / A 与本包边界

- 本包仍**不是** LOCAL-04 整体完成：HTTP / Agent / MCP / UI 与 `scripts/test-all.mjs` 接线未做；
  LOCAL-02 / LOCAL-03 正式合同同步后需补兼容回归；组匹配、外币、银行网站 / API 仍不做。
- 备份层索引键语义的 A 窗缺口已由 B 窗补齐（§12）；本窗（第二轮）未改 backup，当时的三入口不一致描述仅对当时 head 成立。
- 调用方事务不做「嵌套安装 / 写银行数据」支持；需要时由调用方先提交或回滚自己的事务再重试（未知态仍需显式
  `recoverBankConnectionState` 或丢弃连接）。

## 12. 2026-10-22 B 窗：同步已合核心并补齐备份侧银行组件索引键语义

### 12.1 边界与基线

- root 已正式开窗，确认银行 A 最终 `950b7d6` 的独立复审接受，无新阻塞；远端 Issue #53 / #49 已发布 13 路径正式 claim。
- 工作区实际 HEAD 含核心 PR #60 merge `dfefae0`（含备份严格唯一性键修复 `75b448d`）；未自行 Git merge / commit。
- 本窗允许 13 文件：`server/local-backup.mjs`、`test/local-backup.test.mjs`、`server/bank-storage.mjs`、
  `scripts/bank-reconcile.mjs`、`test/bank-reconciliation.test.mjs`、`test/bank-reconcile-cli.test.mjs`、
  `test/local-bank-backup-integration.test.mjs`、`docs/LOCAL-BANK.md`、本文件、`docs/handoffs/LOCAL-04-BANK.md`、
  `docs/LOCAL-BACKUP.md`、`docs/tasks/LOCAL-06-BACKUP.md`、`docs/handoffs/LOCAL-06-BACKUP.md`。
- **不改** `bank-reconciliation.mjs`（A 审完保持）、核心 / db / import / coaprofile / HTTP / Agent / MCP / public /
  `scripts/test-all.mjs` / package / 共享 STATE；03B1 WIP 不读取 / 不复制。
- 实际改动 **9 文件**（claim 的子集）：`server/local-backup.mjs`、`server/bank-storage.mjs`、
  `test/local-bank-backup-integration.test.mjs`、`docs/LOCAL-BANK.md`、本文件、`docs/handoffs/LOCAL-04-BANK.md`、
  `docs/LOCAL-BACKUP.md`、`docs/tasks/LOCAL-06-BACKUP.md`、`docs/handoffs/LOCAL-06-BACKUP.md`；
  未改 `test/local-backup.test.mjs`、`scripts/bank-reconcile.mjs`、`test/bank-reconciliation.test.mjs`、
  `test/bank-reconcile-cli.test.mjs`（只重跑）。

### 12.2 实际变化

1. **合并冲突的真实解决（只在本清单文件内）**：核心 `75b448d` 把完整唯一性键模型接入结构校验后，
   银行表被并入 `effectiveStructure` 但 `unique` 仍是旧空数组，导致**健康 bank 备份被 `unexpected_unique_index` 误拒**
   （集成基线 1 / 5）。`BANK_COMPONENT_STRUCTURE` 每表补上对象形状的 `unique`（从同一份
   `BANK_SCHEMA_CONTRACT.indexes` 静态派生）与显式 `rowidAlias`，不丢掉任一已审合同，也不从当前库动态生成期望。
2. **备份侧逐键校验**：core `unique` 模型支持带名字 / `partial` / `where` 的条目；组件索引改用完整
   `pragma_index_xinfo` 事实（`seqno` / collation / 方向 / 表达式 / rowid / `origin` / 真实谓词），
   全部 19 条索引逐条比对；额外 / 缺失 / 命名与自动索引互相顶替都拒绝，不针对 `idx_bank_txn_ref` 特判。
3. **rowidAlias / 复合主键**：`INTEGER PRIMARY KEY` 表按真实 rowid 别名核对（不另建主键索引、逐行相等）；
   `bank_accounts` / `bank_batches` 复合主键按真实自动主键索引的键列与 `BINARY` 升序语义核对。
4. **兼容**：清单格式 / `formatVersion` / `components[].structureDigest` 口径未改；旧 core v3 / v4 与旧 bank
   内部候选备份保持可读，不要求重生成 / 升级；到实际业务打开才按产品入口迁移。
5. **旧合同保持**：10 表列 / 类型 / null / default、外键完整集合 / 动作、版本行、未知 trigger / view、
   安装前 backup + verify、DBPath / 句柄一致、`BEGIN IMMEDIATE` 排他、fresh 回执、失败审计 / 回滚未知态均未回退。

### 12.3 本窗实际测试（工作目录 `06-workbench`，合成临时库）

```
node test/local-backup.test.mjs                          # 22 / 22（核心 22 项含义未变）
node test/bank-import.test.mjs                           # 16 / 16
node test/bank-reconciliation.test.mjs                   # 40 / 40
node test/bank-reconcile-cli.test.mjs                    # 12 / 12
node test/local-bank-backup-integration.test.mjs         # 5 / 5（断言更新，不删旧断言）
                                                         # 合计 95 / 95，exit 0
```

集成用例新增：源库 / 快照 / 恢复目标三入口对 `NOCASE` / `RTRIM` / `DESC` / 表达式 / 错误 partial 谓词 /
额外唯一索引 / 命名与自动索引互顶 / `INTEGER PRIMARY KEY DESC`（rowid 别名被破坏）全部拒绝，
快照同时重算清单字节数与 sha256（摘要自洽）仍拒绝且不生成恢复目标；健康库 `backup → verify → restore-new`
后真实 `Ref-A` / `ref-a` 两笔继续导入成功；与真实 DDL 同义重建不被误拒。
**未跑**全量 suite（代码只改备份 / 银行契约与文档；整合面全量由 root 冻结后执行，不为无源码变化的套件重复全量）。

### 12.4 未完成 / 边界

- 仍为 **core v3 / v4 + 可选 bank v1**；未来 v5+、bank v2+、batch / audit 与其它未登记组件仍拒绝。
- 无 UI / 共享模型入口 / HTTP / Agent / MCP 接线；`scripts/test-all.mjs` 四个银行套件登记由 root 后续独立短窗完成。
- LOCAL-03 双准则 / 辅助维度 / 往来合同未在本窗验收；不声称 LOCAL-04 整体或 03 科目往来已完成。
- 不宣称已提交 / 已建 PR / 已合 / 最终通过；待 root 冻结、独立复审与 Git 收尾。
