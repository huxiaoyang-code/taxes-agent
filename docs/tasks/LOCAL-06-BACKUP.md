# 任务单 · LOCAL-06-BACKUP 本机一致性备份 / 验证 / 恢复到全新目标

- 类型：独立子包（新模块 + CLI + 测试 + 契约文档），**不接线**任何共享文件
- 状态：**实现与自测完成（含第一轮定向返工 + 终审 P2 外键动作返工 + 外键重复声明补修），未提交 / 未 PR / 未审查 / 未合并**
  （不代表 LOCAL-06 整体完成；上一轮冻结候选的 15 / 15 与外键动作返工后的 16 / 16 均**未最终通过**）
- 基线：main `94a79ef4a5e1c19e1320aed2e848ba42a7121712`（LOCAL-01 合并后主线，schema **v3**）
- 分支：`codex/huxiaoyang-code/local-06-backup`
- 负责人：`huxiaoyang-code`（已核实）
- 远端载体：[Issue #49](https://github.com/huxiaoyang-code/youshu-fork/issues/49)（`Refs #20` / `Refs #13`）
- 契约文档：[LOCAL-BACKUP](../LOCAL-BACKUP.md) · 交接：[handoffs/LOCAL-06-BACKUP](../handoffs/LOCAL-06-BACKUP.md)
- 总览：[INDEPENDENT-PRODUCT-WORK](INDEPENDENT-PRODUCT-WORK.md)（八包；本行状态由管理者在合并后补写，本包不预报）

## 1. 背景与目标

LOCAL-01 已把增量导入落成 schema v3，并在**每次真正迁移前**生成一次 `VACUUM INTO` 一致备份。
但当时的最小工具只承诺「迁移可回退」，**不构成**可验证的备份 / 恢复能力：

- 备份是否**真的**包含 WAL 中已提交的数据、是否排除未提交内容，没有独立入口可验证；
- 「文件大小非 0 就当可用快照」的做法会在原库又有新业务后复用过期快照；
- 没有任何清单能把「这份快照 = 这份数据」绑定起来，也没有入口能识别损坏 / 篡改 / 半成品 / 未来版本；
- 没有人能从备份**实际恢复**到一个可用目标并验证金额与来源。

本子包交付**可直接使用的备份 / 验证 / 恢复全新目标**能力：

1. 运行中 SQLite 的**一致性单文件快照**：用**真正只读**连接 `VACUUM INTO`，WAL 已提交数据必须包含，
   未提交内容不得进入；不直接复制主文件、不忽略 `-wal`、不先 checkpoint、**不写源库**
   （源主库与 `-wal` 字节不变、不被删除；`-shm` 的读锁 / 读标记变化见契约文档 §2.1）；
2. 备份**清单**（产品 / 格式 / 结构 / 迁移记录 / 内容摘要 / 快照物理属性绑定 + SQLite 完整性 / 外键 +
   **真实 v3 结构校验**），并明确拒绝损坏、被改、清单缺失 / 半成品、未知未来版本、旧结构版本、非本产品库；
3. **恢复到全新独立目标**（`backup` / `verify` / `restore-new` CLI），已有目标默认拒绝且内容完全不动；
   先验证再发布，失败 / 中断不留半套数据；恢复后能被**当前实际会计 / 导入接口**读取金额与来源；
4. 明确的路径 / sidecar / 别名 / 覆盖 / 并发安全规则与稳定错误码（含「目标落在备份目录内」按真实路径判定）；
5. 原位恢复只给**接入契约**（明确未实现），留给后续共享维护窗口。

### 1.1 第一轮定向返工的必改项（本轮已处理，证据见交接 §3）

1. **P1 源库保护**：初版 `createBackup` 用 `readOnly: false` 打开源库，在「父业务连接已不存在、
   WAL 已提交但未 checkpoint」时会 checkpoint 源库（改主文件、删 `-wal`）。已改为真正只读连接，
   并新增「子进程写完直接 `process.exit(0)` 留下 WAL」的回归用例；
2. **P1 真实结构版本**：初版只校验六张核心表的少数列、`schemaVersion` 仅取 `MAX(schema_migrations.version)`，
   用一个「只建核心表 + 写一条 version=3」的假 v3 库也能备份成功。已改为按当前真实结构（列 / 类型 /
   NOT NULL / 主键 / UNIQUE / 外键）+ 迁移记录连续性 + 迁移前备份记录校验，并明确**只支持 v3**；
3. **清单类型与真实字段一致**：`appVersion` 缺失 / 类型非法、`pageSize` / `journalMode` / `user_version` /
   `migrations` / `content.tables` 键集合等逐项校验，可重算字段与真实快照比对；
   `appVersion` 保持**信息性**，不伪装成严格的未来应用版本拒绝；
4. **fsync 与文档一致**：真实加入「先把 partial 快照 / 清单 / 未完成标记 `fsync` 再 rename」，
   并把「Windows 无法 `fsync` 目录项」的边界如实写进文档；
5. **路径别名**：`target_conflicts_backup` 两侧都按真实路径（realpath）比较，父目录 junction 别名
   不能把恢复目标写进备份目录（返工前已复现，返工后有用例守住）。

### 1.2 终审 P2 返工：外键动作兼容性（本轮必改）

终审独立探针发现：上一冻结候选（head `829541a`，六文件源码 `ddadb03` + main `257f962`）虽然
管理者与独立 reviewer 均实跑 15 / 15 通过，但 `foreignKeyGroups()` 丢弃了
`PRAGMA foreign_key_list` 的 `on_delete` / `on_update`，`TABLE_STRUCTURE` 也只列映射，
因此**只改外键动作的伪装结构可以全部通过**：

- 复现（独立、真实）：新临时 `WORKBENCH_DATA_DIR` 初始化产品 v3 库并建账套；关闭外键，在事务内
  **仅重建 `periods`**，把 `account_set_id` 外键从 `ON DELETE CASCADE` 改成 `NO ACTION`，
  其余列 / 主键 / 数据 / 迁移记录不变；再开回外键。结果 `backup` / `verify` / `restore-new` 均 `ok:true`，
  而恢复后用真实 `accounting.deleteAccountSet` 抛 `FOREIGN KEY constraint failed`（正常结构对照能删除，
  账套与期间都归 0）。

必改项（已处理，证据见交接 §3）：

1. 按真实 DDL 的外键契约（全部 `ON DELETE CASCADE` + 默认 `ON UPDATE NO ACTION` + 默认 `MATCH NONE`）
   逐外键比对**列组 + 删除 / 更新 / 匹配动作**，按 `pragma_foreign_key_list` 的 `id` 分组（多列外键整体比较），
   不只检查目标列；未声明的额外外键也不接受（`unexpected_foreign_keys`）；
2. **源库与快照两侧都拒绝**同类伪结构（快照侧即使攻击者把清单 `bytes` / `sha256` 一并重算也拦住）；
3. 不通过关闭外键 / 放宽兼容 / 吞异常过关；正常 `backup` / `verify` / `restore-new` 行为不变；
4. 测试新增 `ON DELETE` 与 `ON UPDATE` 两个错误变体 + 只做结构负例不够的「恢复后真实删除」正常对照。

### 1.3 补修：外键重复声明可绕过 (§1.2 修复后仍存在)

根真实合成探针发现：保留 `periods.account_set_id REFERENCES account_sets(id) ON DELETE CASCADE`，
再额外声明同列同目标的一条 `FOREIGN KEY(account_set_id) REFERENCES account_sets(id) ON DELETE RESTRICT`。
`PRAGMA foreign_key_list` 给出两个分组（`id0=RESTRICT`、`id1=CASCADE`），
但 §1.2 的实现把实际外键按目标键装进 `Map`，后一条会**静默覆盖**前一条，于是只看剩的 `CASCADE`；
期望目标集合又让重复目标不算 `unexpected`。实测 `createBackup` 成功，随后真实
`accounting.deleteAccountSet` 仍抛 `FOREIGN KEY constraint failed`。**不得误称已修好全部外键。**

必改项（已处理，证据见交接 §3.0）：

1. 实际外键分组与期望外键**一对一**匹配（多列外键仍按 `id` / `seq` 成一个分组）；
   任何重复分组（`foreign_key_duplicate`）或额外分组（`unexpected_foreign_keys`）都拒绝，
   不再用「按目标键建 Map」；
2. 匹配动作对**每个**实际分组逐一验证（`ON DELETE` / `ON UPDATE` / `MATCH`），不放宽兼容、
   不关闭外键检查、不吞异常；
3. 源库入口与快照入口都拒绝，快照侧即使攻击者把清单 `bytes` / `sha256` 一并重算也拦住；
4. 测试补「重复外键」源库负例 + 重算清单的**快照**负例（先断言伪结构确实产生两个分组、
   真实删除确实失败），正常级联对照仍需通过；只做此真实残留与必要文档，不扩大其它数据库篡改课题。

## 2. 非目标

- 不实现原位（就地）在线恢复、停写 / 关连接 / 现库保护 / 重新打开的编排；
- 不实现审计留痕体系、批量编排 / CLI（LOCAL-07）、Windows 干净安装 / 启动 / 升级交付；
- 不改任何共享文件：`server/db.mjs`、`server/import-storage.mjs`、`server/accounting.mjs`、
  `server/server.mjs`、`server/agent-tools.mjs`、MCP 注册（`05-reconstruction/codex/mcp/finance-mcp/*`）、
  `scripts/test-all.mjs`、`package.json`、`public/*`、`docs/handoffs/STATE.md`、
  `docs/INDEX.md`、`docs/CHANGELOG.md`、`docs/tasks/README.md` 及其他 docs；只按需**只读**；
- 不实施 / 不猜 schema v4（LOCAL-02 #47 在另一隔离 worktree 独占金额 / 期末与 v4），
  只跟随当前 v3 契约，并明确「v4 合并后必须重验」；
- 不接税局、不访问浏览器 / 税局后端 / 真实账套 / 凭据；不做自动测试以外的真实数据动作；
- 不引入第三方依赖、不写安装器；
- 不做 Git 提交 / 推送 / 合并。

## 3. 精确文件清单（本包唯一改动范围）

新增（6 个文件，均已登记到远端 Issue #49）：

| 文件 | 作用 |
|---|---|
| `06-workbench/server/local-backup.mjs` | 一致性快照 / 清单生成与验证 / 恢复到全新目标的模块（无模块级副作用，不 import `db.mjs`） |
| `06-workbench/scripts/local-backup.mjs` | CLI：`backup` / `verify` / `restore-new`，JSON 输出 + 稳定退出码 |
| `06-workbench/test/local-backup.test.mjs` | 真实 SQLite/WAL + 真实 CLI 子进程回归（合成业务、结构负例、故障与并发） |
| `docs/LOCAL-BACKUP.md` | 备份格式 / 兼容范围 / 安全规则 / 错误码 / 下游函数契约 / 原位恢复接入契约 |
| `docs/tasks/LOCAL-06-BACKUP.md` | 本任务单 |
| `docs/handoffs/LOCAL-06-BACKUP.md` | 本包版本化交接 |

**未改任何共享文件**（包括 `scripts/test-all.mjs`，因此本套件**不进入** `npm test` 聚合入口；
如需纳入，应由拥有该共享文件所有权的任务单独接线）。

## 4. 验收标准

1. `node test/local-backup.test.mjs`（工作目录 `06-workbench`）**全部通过、exit 0**，覆盖：
   - 运行中快照（WAL 已提交包含 / 未提交排除 / **源主库与 `-wal` 字节不变且不被删除** / 备份后继续可写）；
   - **遗留 WAL**（子进程写完直接退出、无活动连接）：快照仍含已提交业务，源库不被 checkpoint；
   - 清单绑定与**字段类型 / 规范范围**校验、可重算字段（页大小 / journal mode / user_version /
     表清单 / 迁移记录 / 摘要）与真实快照比对；
   - **真实结构负例**：缺导入表、缺关键列、缺 UNIQUE / 外键约束、迁移记录矛盾、迁移备份记录为空，
     源库与快照两个入口都拒绝；
   - **外键动作负例**：只改 `ON DELETE`（CASCADE → NO ACTION）或 `ON UPDATE`（NO ACTION → CASCADE）、
     其余结构 / 数据 / 迁移记录不变并把清单摘要一并重算的伪结构，源库与快照两侧都拒绝；
   - **外键重复声明负例**：保留原 `ON DELETE CASCADE` 再额外声明同列同目标 `ON DELETE RESTRICT`
     （实际两个外键分组），源库与快照（清单摘要一并重算）两侧都拒绝，明细含 `foreign_key_duplicate`；
     同一套正常结构恢复后用真实 `deleteAccountSet` **能**级联删除（账套 / 期间 / 凭证 / 分录 / 来源归 0）；
   - 恢复后金额与来源一致性、已有目标不动、损坏 / 篡改 / 半成品 / 未来 / 旧版本 / 非本产品库拒绝；
   - 路径与别名边界（含**父目录 junction 别名不能绕过** `target_conflicts_backup`）、
     真实进程中断的原子边界、并发同目录 / 同目标、时点隔离；
2. 模块导入**无副作用**（不在导入时打开数据库 / 创建目录）；
3. 恢复必须"先验证再发布"，失败与中断不留被当成成功的 `workbench.db`；
4. CLI 三子命令可真实执行，输出稳定 `code`，不回显账务原文 / 原始 SQL / 堆栈 / 绝对路径；
5. 三份新文档按事实记录范围、格式、兼容（**只支持当前 v3**）、耐久性边界、测试命令与 exit、限制与后续接入约束，
   **不预报**已审 head / PR / merge，**不声称** LOCAL-06 整体完成，**不声称**税局或真实财务验证。

## 5. 实现要点（给审查者的对照清单）

1. **快照机制**：`new DatabaseSync(path, { readOnly: true })` + `VACUUM INTO`（与 `import-storage.mjs`
   迁移备份同契约），单文件、`journal_mode=delete`、不含 sidecar；**不复制主文件、不 checkpoint、不写源库**；
   只读连接无法读 WAL 索引时给 `source_readonly_blocked`，**不会**改用可写连接。
2. **绝不复用旧快照**：每次 `backup` 都重新生成并重新验证，判定完全不看「文件大小非 0」。
3. **清单绑定**：`product` / `format` / `formatVersion` / `appVersion`（**信息性**，只校验类型与存在）/
   `source.{file,bytes,schemaVersion,journalMode}` /
   `structure.{schemaVersion,userVersion,sqliteVersion,migrations,tables}` /
   `content.{digest,tables[表]={rows,digest}}` / `snapshot.{bytes,sha256,pageSize,journalMode}`。
4. **验证只信自己重算的结果**：不按清单路径取文件（固定文件名）、不执行备份内 SQL、
   不用迁移 / 初始化去"修好"候选库（`readOnly` 打开 + 固定 PRAGMA / SELECT）；
   `pageSize` / `journalMode` / `userVersion` / `tables` / `migrations` / 摘要全部与真实快照比对。
5. **真实结构校验（唯一支持 v3）**：`TABLE_STRUCTURE` 逐表校验列名 / 声明类型 / NOT NULL / 主键顺序 /
   UNIQUE 列组 / 外键（目标列组 + `ON DELETE` / `ON UPDATE` / `MATCH` 动作，按外键分组整体比较，
   多列外键不只比单个目标列，实际分组与期望**一对一**匹配，重复分组 `foreign_key_duplicate` 与
   未声明额外分组 `unexpected_foreign_keys` 都不接受），外加 `schema_migrations` 记录从 1 连续且与版本一致、
   `schema_backups` 存在合法记录；
   缺表 / 缺列 / 缺约束 / 外键动作不符（`foreign_key_actions`）/ 伪造或矛盾迁移记录 → `structure_invalid`
   （源库入口为 `source_structure_invalid`）；更高版本 → `schema_unsupported`，更低版本 → `schema_outdated`。
6. **耐久性**：partial 快照 / 清单 / 未完成标记写后 `fsync` 再 `rename`；POSIX 额外尝试 `fsync` 目录，
   Windows 明确不支持并如实汇报（`backupMeta.durability` / `durability`）。
7. **恢复原子性**：`mkdir` 独占 → 未完成标记（`fsync`）→ partial 复制 → 复制结果重新校验 sha256 →
   `fsync` → 原子 `rename` → 再验证已发布文件 → 写清单副本 / 回执（各 `fsync`）→ 最后删标记。
8. **互斥**：靠操作系统的原子 `mkdir`，不使用锁文件，不存在过期锁。
9. **稳定错误码 + 无敏感回显**：见 [LOCAL-BACKUP §5.1](../LOCAL-BACKUP.md)。

## 6. 依赖与输入

- 只读依赖 `06-workbench/server/import-storage.mjs` 的 `IMPORT_SCHEMA_VERSION` 与 `schemaVersion()`
  （当前 **3**）；不写该文件、不建表、不迁移。
- 运行环境：Node 内建 `node:sqlite`（本机实测 Node v24.15.0 / SQLite 3.51.3）与 `node:fs` / `node:crypto` / `node:path`。
- 测试只用系统临时目录里的合成库 / 合成账套，自行清理自己创建的目录与连接。

## 7. 风险与后续

- 见 [LOCAL-BACKUP §9](../LOCAL-BACKUP.md)：未接线、严格拒绝的代价、只支持 v3、清单无签名、
  全表扫描成本、`-shm` 读锁边界、Windows 目录项耐久性边界、未验证真实账套、未验证 Windows 交付路径。
- 原位恢复接入契约见 [LOCAL-BACKUP §6.5](../LOCAL-BACKUP.md)，属后续共享维护窗口任务，**本包未实现**。
- 审计留痕（谁在什么时候备份 / 恢复 / 恢复到哪个目标）属 LOCAL-06 审计部分，**本包未实现**。
- schema v4（LOCAL-02 #47）合并后必须扩展 `TABLE_STRUCTURE` 并重跑本套件，不得只靠动态表清单一律放行。
