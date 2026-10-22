# 交接 · LOCAL-06-BACKUP 本机一致性备份 / 验证 / 恢复到全新目标

- 任务单：[tasks/LOCAL-06-BACKUP](../tasks/LOCAL-06-BACKUP.md) · 契约：[LOCAL-BACKUP](../LOCAL-BACKUP.md)
- 负责人：`huxiaoyang-code`（已核实）；远端载体：[Issue #49](https://github.com/huxiaoyang-code/youshu-fork/issues/49)
  （`Refs #20` / `Refs #13`）
- 基线：main `94a79ef4a5e1c19e1320aed2e848ba42a7121712`
- 分支：`codex/huxiaoyang-code/local-06-backup`
- 已审 head：**无**（本包尚未提交、未推送、未开 PR、未审查、未合并；不预报任何 head / merge）
- 状态：**实现与自测完成（含第一轮定向返工），等待管理者验证与独立审查**
- 范围：LOCAL-06 的**独立子包**（备份 / 验证 / 恢复全新目标）；LOCAL-06 整体**未完成**
  （审计留痕、原位在线恢复、Windows 干净安装 / 启动 / 升级交付均未实现）

## 1. 交付物（只新增 6 个文件，未改任何共享文件）

| 文件 | 行数 | 作用 |
|---|---|---|
| `06-workbench/server/local-backup.mjs` | 1413 | 快照生成 / 清单生成与验证 / 真实结构校验 / 恢复到全新目标；无模块级副作用 |
| `06-workbench/scripts/local-backup.mjs` | 86 | CLI `backup` / `verify` / `restore-new`（JSON 输出 + 稳定退出码） |
| `06-workbench/test/local-backup.test.mjs` | 1238 | 真实 SQLite/WAL + 真实 CLI 子进程回归（15 个用例） |
| `docs/LOCAL-BACKUP.md` | 438 | 备份格式 / 兼容范围 / 错误码 / 安全规则 / 耐久性边界 / 下游契约 / 原位恢复接入契约 |
| `docs/tasks/LOCAL-06-BACKUP.md` | 135 | 本包任务单 |
| `docs/handoffs/LOCAL-06-BACKUP.md` | — | 本交接 |

未改（共享文件，仅只读）：`server/db.mjs`、`server/import-storage.mjs`、`server/accounting.mjs`、
`server/server.mjs`、`server/agent-tools.mjs`、MCP 注册、`scripts/test-all.mjs`、`package.json`、
`public/*`、`docs/handoffs/STATE.md`、`docs/INDEX.md`、`docs/CHANGELOG.md`、`docs/tasks/README.md`。

## 2. 实现事实（可逐条核对）

1. **真正只读的源连接**：`createBackup` 用 `new DatabaseSync(source, { readOnly: true })` 打开源库，
   先做真实结构 / 迁移记录预检，再执行 `VACUUM INTO` 得到**单文件**快照；**不使用可写连接**，
   因此不会 checkpoint、不改写源主库、不删除 `-wal`。
   只读连接若无法读取 WAL 索引（需要写 `-shm` 的环境），返回 `source_readonly_blocked` 并提示先用
   产品真实入口打开一次，**不会**为了备份去写源库。
2. **源库保护的可复现边界**：源 `workbench.db` 与 `-wal` 的 sha256 / 大小在备份前后**完全不变**，
   `-wal` 仍然存在；`-shm` 的读锁 / 读标记可能变化（SQLite 锁协调，不承载业务数据），文档 §2.1 已如实区分。
3. **绝不复用旧快照**：每次备份都新建目录、重新生成、重新自检（完整性 / 外键 / 真实结构 / 内容摘要），
   完全不使用「文件大小非 0」这类判定。
4. **真实结构校验（唯一支持当前 v3）**：`TABLE_STRUCTURE` 逐表校验
   列名集合、声明类型、`NOT NULL`、主键列与顺序、UNIQUE 约束列组、外键（本表列 → 目标表列）；
   另校验 `schema_migrations` 记录从 1 到当前版本**连续**、`applied_at` 可解析、
   `schema_backups` 至少一条形状合法的迁移前备份记录。
   8 张核心会计表 + `schema_migrations` / `schema_backups` + 5 张 `import_*` 全部必需；
   缺表 / 缺列 / 缺约束 / 伪造或矛盾迁移记录 → `structure_invalid`（源库入口 `source_structure_invalid`），
   缺表 → 非本产品库（`source_not_product_database` / `snapshot_not_product_database`）。
   版本高于支持上限 → `schema_unsupported`；**低于** → `schema_outdated`（旧库先用当前产品入口升级，
   本模块不替候选库初始化 / 迁移）。
5. **清单绑定**（`formatVersion: 1`）：产品 / 格式 / 格式版本 / 应用版本 / 源库事实 /
   `structure.{schemaVersion,userVersion,sqliteVersion,migrations,tables}` /
   `content.{digest, tables[表]={rows,digest}}` / `snapshot.{bytes,sha256,pageSize,journalMode}`。
   表清单、每表摘要与迁移记录从真实库**动态**计算；金额与来源变化必然改变摘要。
   清单与回执**不含本机绝对路径**。
6. **清单字段类型 / 规范范围全项校验**：`appVersion`（存在且非空字符串，**仅信息性**、不参与兼容判定）、
   `formatVersion`（正整数且 ≤ 当前）、`pageSize`（2 的幂）、`journalMode`（白名单）、
   `structure.migrations`（必须等于 `1..schemaVersion`）、`content.tables` 的键集合与 `structure.tables` 一致、
   `structure.tables` 无重复、`source.file` 只是文件名、`source.schemaVersion` 与结构版本一致等。
7. **验证只信自己重算的结果**：快照按**固定文件名**查找（不按清单自报路径）；
   `readOnly` 打开后只执行固定 `PRAGMA` / `SELECT`（不执行备份里的 SQL、不初始化 / 不迁移候选库）；
   可重算字段（`bytes` / `sha256` / `pageSize` / `journalMode` / `userVersion` / `tables` / `migrations` /
   内容摘要与每表行数）逐项与真实快照比对，不符即 `snapshot_metadata_mismatch` / `structure_mismatch` /
   `content_mismatch`。`source.bytes` / `source.journalMode` / `sqliteVersion` / `appVersion` / `createdAt`
   只作记录（仍校验类型 / 范围），文档 §3.1 已明确哪些能重算、哪些不能。
8. **耐久性（真实执行的步骤）**：未完成标记、partial 快照、partial 清单都是「写 → `fsync` → `rename`」；
   POSIX 额外 `fsync` 目录，**Windows 无法 `fsync` 目录项**，命令输出
   `backupMeta.durability` / `durability` 如实报告 `fileContentsSynced` 与 `directoryEntrySyncSupported`。
   文档不承诺目录项持久化，也不把断电后丢文件名说成安全无损（此时标记残留，按未完成处理）。
9. **恢复只写全新目录**：目标已存在（含空目录 / 文件 / 符号链接 / 未完成残留）一律拒绝且内容不动；
   发布顺序 = 独占 `mkdir` → 未完成标记（`fsync`）→ partial 复制 → **对复制结果重算 sha256 / 字节数** →
   `fsync` → 原子 `rename` → **再验证已发布文件** → 清单副本 + 回执（各 `fsync`）→ 最后删标记。
   失败清理自己创建的条目并尝试删目录；失败 / 中断**不会**出现顶着 `workbench.db` 名字的半套数据。
10. **路径别名判定用真实路径**：`target_conflicts_backup` 两侧都比较 `realpath`；
    返工前已在本机复现「备份经父目录 junction 访问 + 目标写进备份内 → 绕过检查并污染备份目录」，
    返工后同一场景返回 `target_conflicts_backup` 且备份目录签名不变（测试内有用例守住）。
11. **互斥**：靠操作系统原子 `mkdir`，无锁文件、无过期锁问题；并发同目录 / 同目标恰好一个成功。
12. **稳定 code、无敏感回显**：所有可预期失败以 `{ok:false,status:"rejected",code,details}` 返回，
    `details` 只含字段名 / 计数 / 表名 / 列名 / 版本号 / 问题类型；未预期错误折叠为 `internal_error`，
    不带 SQL / 堆栈 / 账务原文 / 绝对路径。CLI 退出码 `0/1/2/3`（成功 / 用法 / 明确拒绝 / 内部错误）。
13. **依赖**：只用 Node 内建 `node:sqlite` / `node:fs` / `node:crypto` / `node:path` 与
    `import-storage.mjs` 的只读常量 / 版本函数；**零新增第三方依赖**，无安装器。

## 3. 测试证据（实际实跑，非自报估计）

工作目录：`06-workbench`。运行环境：Node **v24.15.0**、SQLite **3.51.3**（`node:sqlite`）、Windows。

**本轮（第一轮定向返工后的最终六文件）实跑结果**：

| 命令 | 结果 | 退出码 |
|---|---|---|
| `node test/local-backup.test.mjs` | **15 / 15 通过** | **0** |
| `node test/import-incremental.test.mjs`（回归对照，LOCAL-01 未受影响） | 49 / 49 通过 | 0 |
| `node test/import-incremental-http.test.mjs`（回归对照） | 22 / 22 通过 | 0 |
| `node test/smoke.test.mjs`（回归对照） | 28 / 28 通过 | 0 |

说明：本套件**未**接入 `scripts/test-all.mjs`（该文件是共享文件，不在本包所有权内），
因此**没有**「`npm test` 全部套件都跑过本套件」这一事实；上表是逐条实跑命令与真实结果。
回归对照三套是在本轮返工之后运行的，只证明**没有破坏**既有入口（本包未改任何既有文件）。

> 历史记录（**初版**，已被本轮返工取代，不再代表当前代码）：初版自测 12 / 12 通过、exit 0（连续 3 次）；
> 该结果只说明初版在被指出的缺陷上**没有**相应断言（源连接可写、结构校验薄弱、`appVersion` 未校验、
> 备份未 `fsync`、别名未用 realpath）。本轮返工后以 15 项用例为准。

### 3.1 本轮 15 个用例各自验证什么（全部合成数据）

1. **模块导入无副作用**：子进程仅 import 模块 + 指向不存在的 `WORKBENCH_DATA_DIR`，
   断言该目录未被创建、仓库默认数据目录里的库字节未变。
2. **遗留 WAL（本轮新增，对应返工必改项 1）**：真实子 Node 用 `db.mjs` + 真实导入接口写入合成业务后
   **不关闭连接直接 `process.exit(0)`**，留下已提交但未 checkpoint 的 `-wal`；
   父进程记录主库 / `-wal` 的 hash 与大小 → 调用**真实 CLI backup**：
   快照含 2 张已提交凭证（借方合计 13300）与批次 / 来源 / 逐张关联；
   源主库与 `-wal` **字节与大小完全不变、文件仍在**，无 `-journal`；`verify` 通过；
   之后源库仍能被真实产品入口打开并读到相同余额（WAL 未被破坏）。
3. **运行中快照**：源库 WAL 中已有已提交未 checkpoint 的 4 张凭证；在 `db` 连接上开 `BEGIN IMMEDIATE`
   写入未提交凭证，此时用真实 CLI 备份：快照 `integrity_check=ok`、`journal_mode=delete`、
   含 4 张已提交凭证、**不含**未提交凭证及分录；`import_batches=2`、`import_voucher_sources=4`、
   `import_batch_vouchers=4`，来源→凭证→分录金额逐张 join 断言；备份期间源 `-wal` 与主库 hash **不变**、
   未提交事务仍在（未被回滚 / 阻塞）；`ROLLBACK` 后全表逐行相等；备份后继续写业务成功且不进旧快照。
4. **清单绑定**：`verify` 通过；断言产品 / 格式 / `formatVersion=1` / `appVersion` 为非空字符串 /
   `structure.schemaVersion` / `source.schemaVersion` / `structure.migrations=[1,2,3]` /
   `snapshot.bytes` 与 `sha256` 与文件实际一致 / `snapshot.journalMode=delete` / `source.journalMode=wal` /
   表清单与内容摘要覆盖核心业务表与全部导入来源表 / 清单文本不含本机绝对路径与盘符；
   并断言备份结果 `backupMeta.durability.fileContentsSynced=true`（fsync 真的执行）。
5. **清单字段类型 / 规范范围（本轮新增，对应返工必改项 3）**：21 项类型 / 范围负例逐项断言
   `manifest_invalid`（缺 `appVersion`、`appVersion` 为对象 / null、`formatVersion=0`、
   `createdAt` 非字符串、`snapshot.bytes=0`、`snapshot.sha256` 非摘要、`pageSize=3000`、
   `journalMode="wal-ftw"`、`structure.sqliteVersion` 非字符串、`userVersion=-1`、
   `tables` 多出表 / 重复表、`migrations` 非连续、某表摘要长度非法 / 行数为负 / 整表缺失、
   `source.bytes=0`、`source.file` 带路径、`source.journalMode` 非法、`source.schemaVersion` 非整数）；
   另断言 `appVersion="9999.0.0"` **仍然通过**（信息性字段，不伪装严格未来版本拒绝），
   以及可重算字段不符时分别报 `snapshot_metadata_mismatch`（`pageSize` / `journalMode`）与
   `structure_mismatch`（`userVersion`）。
6. **恢复到全新目标**：`restore-new` 成功；目标内只有 `workbench.db` / `manifest.json` / `restore.json`，
   无未完成标记；回执 `verified=true`、`structure.migrations=[1,2,3]`、sha256 与目标库一致、
   `durability.fileContentsSynced=true`；用**真实子进程 + 真实 `accounting.mjs` / `import-incremental.mjs`**
   （`WORKBENCH_DATA_DIR=<新目标>`）读取：期初 `1002/1405/3001 = 100000/6000/106000`、1 月余额
   `{1002:98000,1122:11300,1405:6000,5001:-10000,5602:2000,2221:-1300,3001:-106000}`、
   2 月余额 `{1002:106300,1122:0,1405:9000,...同}`、试算平衡 1 月（开 106000/106000、发生 13300/13300、
   结 117300/117300）与 2 月（累计发生 27600/27600、结 117300/117300）、
   1 月利润表净利润 8000（收入 10000 − 管理费用 2000）、2 月本年累计净利润 8000、
   4 张凭证（期间 / 字号 / 状态 / 借贷合计）、批次 `completed` 且账套 / 企业身份一致、
   逐张 `sourceTrace` 全部 `created` / `ok`、企业账套绑定与来源证据各 1 条 —— 全部与**手算预期**一致。
7. **已有目标默认拒绝**：目标目录内含文件与子目录，`restore-new` 返回 `target_exists`，
   目录签名（递归 名称+大小+sha256）**前后完全相等**；直接调用模块 API 结果一致。
8. **坏备份拒绝**（逐项断言稳定 code）：快照改 1 字节 → `snapshot_digest_mismatch`（且**未创建**恢复目标）；
   截断 200 字节 → `snapshot_size_mismatch`；删清单 → `manifest_missing`；非法 JSON → `manifest_invalid`；
   `formatVersion=99` → `backup_format_unsupported`；`product=other` → `backup_app_unsupported`；
   自报 `schemaVersion=99` → `schema_unsupported`；自报 `schemaVersion=2` → `schema_outdated`；
   `structure.migrations=[1,2,3,4]` → `manifest_invalid`；内容摘要被改 / 某表行数被改 → `content_mismatch`；
   未完成标记 / `.partial-*` / 快照 `-wal` → `backup_incomplete`；
   清单声明 `snapshot.file="../outside.db"` → `manifest_invalid`（**不按清单路径取文件**）；
   非本产品库（`foo` 表）+ 同步改对 sha → `snapshot_not_product_database`；
   校验和自洽但页已损坏 → `integrity_failed` / `snapshot_unreadable` 等稳定 code；
   备份目录不存在 → `backup_dir_missing`。
9. **源库侧拒绝**：非本产品库 → `source_not_product_database`（且**未创建**备份目录）；
   随机字节文件 → `source_not_database`；`schema_migrations` 记 99 → `schema_unsupported`；
   0 字节 → `source_empty`；外键被破坏（`DELETE FROM account_sets`）→ `foreign_key_violation`（未创建备份目录）。
10. **真实结构负例（本轮新增，对应返工必改项 2）**：
    - 假 v3（只留核心表、删掉全部 `import_*` 与 `schema_backups`、重建 `schema_migrations` 写一条 3）
      → 源库 `source_not_product_database`，明细列出缺失的导入表；
    - 缺关键列（`ALTER TABLE import_batches DROP COLUMN result_json`；另有一例重建 `vouchers` 缺 `kind`）
      → `source_structure_invalid` + `missing_columns`；
    - 缺 UNIQUE 约束（重建 `accounts` 去掉 `UNIQUE (account_set_id, code)`）→ `source_structure_invalid` + `unique`；
    - 缺外键（重建 `periods` 去掉 `REFERENCES account_sets`）→ `source_structure_invalid` + `foreign_key`；
    - 迁移记录矛盾（删掉 v2 记录，只剩 1 / 3）→ `source_structure_invalid` + `migrations_gap`；
    - 迁移前备份记录被清空 → `source_structure_invalid` + `backup_records_empty`；
    - 上面前三类同时作用于 **verify / restore-new**（把快照换成被改结构库并同步清单摘要）：
      `snapshot_not_product_database` / `structure_invalid`，且**不会**创建恢复目标。
11. **路径 / 别名边界**：硬链接源库 → `source_alias`（用后立即删除）；经 junction 目录的源库路径 →
    `source_alias`；`--db <库>-wal` → `source_sidecar`；已存在目录 / 文件作 `--out` → `out_exists`
    （文件内容未变）；junction 作 `--out` → `out_alias`；目标在备份目录内 → `target_conflicts_backup`
    （未创建该子目录）；junction 作 `--target` → `target_alias`；`--target` 指向正在使用的库文件 →
    `target_exists` 且该文件仍是普通文件；**父目录 junction 别名两侧都试**
    → 均 `target_conflicts_backup`、备份目录签名不变、经别名读取的备份仍可 `verify`；6 种 CLI 用法错误 →
    退出码 1 与对应 `usage_*` code。（若运行环境禁止创建目录链接，junction 子用例明确打印跳过，不伪装通过。）
12. **中断残留**：目标目录内只有 `.restore-incomplete` + `.partial-*.db`（无 `workbench.db`）→
    `target_incomplete`，目录签名前后不变；删除该目录后重试 → 成功且 sha256 与快照一致、金额可读。
13. **真实进程中断**：先造一个 >8 MiB 的合成本产品库（1200 张填充凭证）并正常备份。
    - 备份进程：观测到未完成标记后 `kill` → 备份目录要么不存在，要么**不通过** `verify`
      （`backup_incomplete` / `manifest_missing` / `snapshot_missing`），且**没有** `manifest.json`；
      清理残留后重试成功。
    - 恢复进程：观测到标记后 `kill` → 若出现 `workbench.db`，其 sha256**必须等于**清单里的快照 sha256
      （先校验后 rename，不存在半套正式文件）；未完成目标再恢复会被明确拒绝；清理后重试成功。
14. **并发**：两个 CLI 同时备份到同一 `--out` → 退出码恒为 `{0,2}`，失败方 code 为
    `out_exists` 或 `out_incomplete`（取决于观测时机）；随后 `verify` 通过，目录里只剩
    `workbench.db.snapshot` + `manifest.json`（无临时文件 / 标记）。两个 CLI 同时恢复到同一 `--target` →
    退出码 `{0,2}`，失败方 `target_exists` / `target_incomplete`；成功目标 sha256 与快照一致、
    无未完成标记、金额可读。
15. **时点隔离**：备份后再写入两笔业务 → 源库继续可写且余额按手算变化；旧备份仍 `verify` 通过、
    仍是 4 张凭证、分录借方合计 27600；已恢复的库仍是 4 张凭证（不被后来的源库业务改动）。

### 3.2 没有做的事（测试口径）

- 没有连接真实账套库 / 真实数据 / 税局 / 浏览器；没有把任何真实凭据或账务原文写入代码、测试或文档。
- 没有跑 `npm test` 全量聚合（本套件不在 `test-all.mjs` 里，见 §3 说明）。
- 没有在 schema v4 / LOCAL-02 分支代码上运行过（见 §5）。
- 没有验证网络盘 / 同步盘 / 杀毒软件占用 / 真实断电等 Windows 交付场景。

## 4. 下游契约（给后续任务的输入）

- 模块导出：`createBackup({dbPath,outDir})` / `verifyBackup({backupDir})` /
  `restoreNew({backupDir,targetDir})` / `backupContract()`，**不抛异常**、返回统一
  `{ok,status,code,details,...}`；稳定 code 表见 [LOCAL-BACKUP §5.1](../LOCAL-BACKUP.md)。
- `backupContract()` 另暴露 `supportedSchemaVersion`（本模块校验过的真实结构版本，当前 3）与
  `productSchemaVersion`（`IMPORT_SCHEMA_VERSION`，当前 3）：v4 合并后两者不一致时，
  必须先扩展结构规范再重验（测试里有显式断言）。
- 备份目录：`workbench.db.snapshot` + `manifest.json`；恢复目标：`workbench.db` +
  `manifest.json`（副本）+ `restore.json`（回执）。
- 源库定位口径：恢复目标目录可直接当产品数据目录（`WORKBENCH_DATA_DIR=<目标>`），
  产品启动时 schema 已是目标版本则不会重复迁移。
- 需要审计 / 批量编排的一方（LOCAL-06 审计部分、LOCAL-07）可直接消费 `code`；
  若要接线到 HTTP / Agent / MCP，必须遵守 LOCAL-08 的数据输出边界，
  不要把 `manifest` / `details` 原文透出到模型侧。

## 5. 未完项 / 风险 / 下一任务输入

1. **未提交 / 未 PR / 未审查 / 未合并**：本交接不预报已审 head 或 merge；合并后由管理者补齐。
2. **LOCAL-06 整体未完成**：审计留痕、原位在线恢复、Windows 干净安装 / 启动 / 升级交付均未实现；
   本包只交付「备份 / 验证 / 恢复全新目标」。
3. **只支持当前 v3 结构**：`schema_outdated`（v0 / v1 / v2）要求先用当前产品入口升级；
   不替候选库做初始化 / 迁移，也不盲放旧结构。
4. **schema v4（LOCAL-02 #47）合并后必须重验**：按真实契约扩展 `TABLE_STRUCTURE`
   （列 / 约束 / 迁移记录），在最新 main 上重跑 `node test/local-backup.test.mjs`，
   并复核是否需要提升 `formatVersion`；动态表清单不是「v4 已支持」的证据。
5. **源库保护边界**：主库与 `-wal` 字节不变、不被删除；`-shm` 读锁 / 读标记可能变化（锁协调）。
   某环境若只读连接无法读 WAL 索引，会明确 `source_readonly_blocked`，不使用可写连接绕过。
6. **耐久性边界**：文件内容 `fsync` 后再 `rename`；Windows 无法 `fsync` 目录项，
   断电可能丢失刚发布的文件名（此时按未完成处理）。
7. **严格拒绝的代价**：真实库若存在外键 / 页级问题或结构被手工改过会被拒绝备份
   （`foreign_key_violation` / `integrity_failed` / `structure_invalid`），需先人工核对；本包不提供修复工具。
8. **清单无签名**：防损坏 / 不一致 / 半成品 / 结构不符，不防「清单与快照一起整体伪造」；
   防伪属后续审计部分。
9. **未接线**：没有定时备份、没有产品 UI / HTTP / Agent / MCP 入口、没有自动切换数据目录。
10. **性能边界**：内容摘要为全表扫描 + 逐行规范序列化，大库会变慢且单表内存随行数增长；
    未做增量 / 分块优化。
11. **Windows 交付未验证**：junction / 硬链接规则已在本机 Windows 实测；网络盘 / 同步盘 / 杀毒软件
    占用、长时间断电等场景未验证。

## 6. 本次执行边界（会话事实）

- 实施员工：本机 pi，仅使用已核实的 **DeepSeek V4.1 Flash**；未启动其它模型、未启动子 agent。
- 本轮为第一轮定向返工的**新进程 / 新会话**（`--no-session`，不 resume，未读取原员工 jsonl 全日志）；
  在同一 worktree 上接续初版成果定向修复，未重置初版成果。
- 未执行 Git 提交 / 推送 / 合并；未修改共享文件；未访问税局 / 浏览器 / 真实账套 / 凭据。
- 只写系统临时目录与本 worktree 内 `tmp-l06-fix/`（手工探针，交付前删除）与既有
  `tmp-l06-probe*`（初版员工遗留的合成探针，本轮核对绝对路径确认在本 worktree 后清理）；
  测试进程自行清理自己创建的临时目录与数据库连接。
- 需要返工请开**新会话**（不 resume），只需本任务单、本交接、契约文档与相关源码。
