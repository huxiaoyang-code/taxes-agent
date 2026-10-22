# 本机一致性备份 / 验证 / 恢复到全新目标 · LOCAL-BACKUP（LOCAL-06 独立子包契约）

状态：**LOCAL-06 备份子包已随 [PR #55](https://github.com/huxiaoyang-code/youshu-fork/pull/55) 验收合并**（PR head
`55dfe44`，merge `98977e04bd24aa293074021802191814f8c2a1d2`，已审源码 head `b2dcba35e87e9ebb75245dcc874aa41705b31243`
独审 16 项）。
本文件同时包含**合并后兼容整合轮**（schema v3 / v4 精确契约）的最新事实：该轮源码**尚未提交 / 未建 PR / 未合并**，
最终独立审查待做。这仍是 LOCAL-06 的**独立子包**，不表示 LOCAL-06 整体完成（审计留痕、原位在线恢复、
Windows 干净安装 / 启动 / 升级、整套交付仍未实现）。

- 远端载体：[Issue #49](https://github.com/huxiaoyang-code/youshu-fork/issues/49)（`Refs #20` / `Refs #13`）；
  Issue #49 保持 OPEN，用于后续兼容整合；完整审计留痕在
  [Issue #54](https://github.com/huxiaoyang-code/youshu-fork/issues/54)
- PR：[#55](https://github.com/huxiaoyang-code/youshu-fork/pull/55)（base `257f96275031eefa484699dd71bd012e2d221e51`，
  PR head `55dfe44`，**已审源码** head `b2dcba35e87e9ebb75245dcc874aa41705b31243`，**已 MERGED**，
  merge `98977e04bd24aa293074021802191814f8c2a1d2`）；
  兼容整合轮在此基础上改 3 个源码 / 测试文件（+ 仅追加的 `scripts/test-all.mjs` 登记）
- 基线：main `94a79ef4a5e1c19e1320aed2e848ba42a7121712`；分支 `codex/huxiaoyang-code/local-06-backup`
- 任务单：[tasks/LOCAL-06-BACKUP](tasks/LOCAL-06-BACKUP.md) · 交接：[handoffs/LOCAL-06-BACKUP](handoffs/LOCAL-06-BACKUP.md)
- 精确文件归属：本包**只改动自己的 6 个文件**（见任务单 §3），共享文件仅按兼容整合轮任务单**追加**
  `scripts/test-all.mjs` 的三条已合入套件登记（不改原有 50 套的顺序 / 内容）；
  其余共享文件（`db.mjs` / `import-storage.mjs` / `accounting.mjs` / `server.mjs` / `agent-tools.mjs` / MCP 注册 /
  `package.json` / `public/*` / 公共索引文档均未改）。
- 与 LOCAL-01 的关系：本包**读取** `import-storage.mjs` 的 `IMPORT_SCHEMA_VERSION` / `schemaVersion()`
  作为当前真实 schema 契约（当前 **v3**），不复制其迁移逻辑、不建表、不迁移、不写任何持久表。
- 与 LOCAL-02 的关系：`#47` 独占金额 / 期末与 schema **v4** 实施；兼容整合轮已按 **真实 v4 结构**
  （`asset_cards` 5 个补项列 + 精确默认值）做独立契约与真实产品合成库验收（见 §4）。
  bank / batch / audit 等尚未合入的组件**未**做契约，仍然一律拒绝（`unexpected_tables`）。

## 1. 范围与非目标

**本子包交付（真实可用，不是接口壳）**

1. 运行中 SQLite 的**一致性单文件快照**：用**真正只读**连接 `VACUUM INTO` 生成，WAL 中已提交数据必须包含，
   未提交内容不得进入；源主库与 `-wal` **不被改写、不被 checkpoint、不被删除**；
2. 可验证备份**清单**（产品 / 格式 / 结构 / 迁移记录 / 内容摘要 / 快照物理属性绑定）+ 拒绝损坏、篡改、
   半成品、未来版本、旧结构版本、非本产品库、非真实结构；
3. 恢复到**全新独立目标目录**（`backup` / `verify` / `restore-new` 三个真实 CLI 子命令），
   恢复后的库能被当前实际会计 / 导入接口直接读取金额与来源；
4. 明确的路径 / 别名 / 覆盖 / 并发安全规则与稳定错误码，"目标落在备份目录内"用**真实路径**判定；
5. 原位恢复的**接入契约描述**（明确未实现，留给后续共享维护窗口）。

**非目标（本子包不做，也不在本包声明）**

- 不实现原位（就地）在线恢复、停写编排、连接关闭 / 重新打开、现库保护流程；
- 不实现完整审计 / 操作留痕体系（LOCAL-06 其他部分）、批量编排与 CLI（LOCAL-07）；
- 不做 Windows 干净安装 / 启动 / 升级 / 卸载交付，不生成安装器，不新增依赖；
- 不接后端 HTTP / Agent / MCP 接口，不改 `db.mjs` 启动流程，不把备份接入产品 UI；
- 不接税局、不访问浏览器 / 税局后端 / 真实账套 / 凭据；**真实财务与税局口径均未验证**；
- 不提供备份修复工具，不对不合格的库做「修好再通过」的补救（见 §5）。

## 2. 为什么不能直接复制主库文件

本产品数据目录里的库以 **WAL** 模式运行（`db.mjs` 启动即 `PRAGMA journal_mode = WAL`）。若直接复制
`workbench.db`：

- WAL 中**已提交但尚未 checkpoint** 的业务数据会丢失（最常见的「刚记完账就备份，恢复后少了几张凭证」）；
- 复制过程中源库仍在写入，可能得到**页级撕裂**的文件；
- 若连 `-wal` 一起复制，得到的是一组**互相耦合的多文件**，任何一侧缺失都不再是一致快照。

因此快照必须由 SQLite 自己产生。本子包与 `import-storage.mjs` 的迁移前备份采用**同一契约**：
在**独立只读连接**（`new DatabaseSync(path, { readOnly: true })`）上执行 `VACUUM INTO`，
得到一个**单文件**一致快照。

- `VACUUM INTO` 在内部读事务内完成，因此快照对应**一个明确的事务时点**：金额、来源证据、批次、
  逐张来源关联、期间、期初全部来自同一时点，不会出现「凭证在、来源关联不在」的半截状态；
- 快照**包含 WAL 中已提交的数据**（不需要先 checkpoint，也不需要写源库）；
- 快照**不包含**其它连接尚未提交的事务（未提交数据还未进入可读的一致状态）；
- 快照产物的 `journal_mode` 是 `delete`，即**不依赖 `-wal` / `-shm`**，可直接复制 / 归档 / 恢复到别处。

### 2.1 源库保护的真实边界（可复现事实）

- **主库文件 `workbench.db` 与 `-wal` 的字节不变**：备份调用结束后两者 sha256 与大小都不变，
  且 `-wal` **仍然存在**（不会被 checkpoint 后删除）。这是本包自测的硬断言
  （覆盖「子进程写完直接 `process.exit(0)`、没有任何活动连接、只留下已提交未 checkpoint 的 WAL」场景）。
- **`-shm` 可能发生变化**：SQLite 只读连接读取 WAL 时需要读写 `-shm` 里的**读标记 / 读锁**，
  这是锁协调用的共享内存索引，**不承载业务数据**。因此本包只承诺「主库与 `-wal` 字节不变、
  业务数据不被 checkpoint / 改写 / 删除」，**不会**声称「所有 sidecar 字节绝不变化」。
- 备份不使用任何「先 checkpoint 再复制」或「先改源库」的捷径：只读连接本身不可能写主库；
  若某个环境下只读连接连 WAL 索引都打不开（需要写 `-shm`），本包以 `source_readonly_blocked`
  明确拒绝，并提示操作者用产品真实入口打开一次后再备份，不会擅自打开可写连接。

与迁移备份的差别（有意为之）：迁移备份只在**真正需要升级时**生成，并登记在 `schema_backups`；
本子包**每次都重新生成并重新验证**，**绝不**用「备份文件大小非 0」这类条件复用旧快照。

## 3. 备份目录格式

一次 `backup` 生成一个**全新目录**（目录必须不存在，CLI 会创建它），内容固定为：

| 文件 | 说明 |
|---|---|
| `workbench.db.snapshot` | 单文件一致性快照（`VACUUM INTO` 产物，`journal_mode=delete`，不含各类 sidecar） |
| `manifest.json` | 清单：绑定产品 / 格式 / 版本 / 结构 / 迁移记录 / 内容摘要 / 快照物理属性 |

生成过程中还会短暂出现（结束时清理，**残留即视为未完成**）：

| 文件 | 说明 |
|---|---|
| `.local-backup-incomplete` | 未完成标记，创建于快照之前（写入后 `fsync`），最后一步才删除 |
| `.partial-<pid>-<随机>.db` / `.partial-<pid>-<随机>.json` | 快照 / 清单的临时文件，`fsync` 后原子 `rename` 为正式名 |

### 3.1 清单字段（`formatVersion: 1`）

```jsonc
{
  "product": "youshu-workbench",              // 产品标识；不匹配即拒绝（别的产品的备份不能恢复）
  "format": "youshu-workbench-local-backup",  // 备份格式标识
  "formatVersion": 1,                         // 清单格式版本；更高版本一律拒绝
  "appVersion": "0.4.0",                      // 生成时应用版本：仅信息性，不参与兼容判定（仍校验类型）
  "createdAt": "2026-10-22T09:37:03.236Z",    // 清单时间
  "source": {                                 // 备份时源库事实（只记文件名，不记本机绝对路径）
    "file": "workbench.db",
    "bytes": 159744,
    "schemaVersion": 4,
    "journalMode": "wal"
  },
  "snapshot": {                               // 发布产物的物理绑定（全部会被重新计算核对）
    "file": "workbench.db.snapshot",
    "bytes": 159744,
    "sha256": "<64 hex>",
    "pageSize": 4096,
    "journalMode": "delete"
  },
  "structure": {                              // 结构绑定
    "schemaVersion": 4,                       // 必须是已声明的真实结构版本（当前：3 或 4）
    "userVersion": 0,
    "sqliteVersion": "3.51.3",                // 生成端 SQLite 版本（信息性；类型仍校验）
    "migrations": [1, 2, 3, 4],              // 必须与真实 schema_migrations 记录一致且从 1 连续
    "tables": ["account_sets", "..."]         // sqlite_master 的全部表，动态计算（新增表自动纳入）
  },
  "content": {                                // 内容绑定
    "digest": "<64 hex>",                     // 由下表每项 (表名, 行数, 摘要) 串联的 sha256
    "tables": {
      "vouchers": { "rows": 4, "digest": "<64 hex>" }   // 每表：行数 + 逐行规范序列化的 sha256
    }
  }
}
```

- **内容摘要**对每张表逐行计算：行内键排序、BLOB 转 base64、BigInt 显式标注、按 `rowid` 顺序；
  表清单与每表摘要共同组成 `content.digest`。因此**金额、来源、关联**任何一处变化都会让摘要变化。
- 清单**不包含本机绝对路径**（`source.file` 只有文件名），可随备份目录一起归档 / 转交；
  恢复回执 `restore.json` 同样只含文件名与仓库相对概念。
- **哪些字段会被重新计算**（验证端不信清单自报）：
  快照 `bytes` / `sha256` / `pageSize` / `journalMode`、`structure.schemaVersion` / `tables` /
  `migrations` / `userVersion`、`content.digest` 与每表 `rows` / `digest`。
  **哪些只作记录、无法重算**：`source.bytes`（源库在备份后仍会写入）、`source.journalMode`、
  `structure.sqliteVersion`、`appVersion`、`createdAt` —— 这些仍会校验**类型 / 规范范围**，
  但不作为「快照就是这份数据」的证据。`source.schemaVersion` 必须与 `structure.schemaVersion` 一致。
- **schemaVersion 只用来选契约，不足以为凭**：写成 4 但结构仍是 v3（缺 5 个补项列）、写成 3 但已带 v4 列、
  或默认值 / NOT NULL / 类型 / 迁移记录不连续，都会按**真实结构**被 `structure_invalid` /
  `manifest_invalid` 拦住（不会因为版本号而放行，也不把 `unexpected_tables` 关掉）。
  已知支持的版本集合由 `backupContract().supportedSchemaVersions`（当前 `[3, 4]`）显式暴露。

### 3.2 清单的信任边界

清单**没有签名**：它的作用是绑定「这份快照就是清单描述的这份数据」，能发现**损坏、截断、半成品、
版本不明、清单与内容不一致、别的产品 / 别的结构**，**不能**防止有人把清单与快照一起整体伪造
（自测里就专门构造了「清单摘要同步改对、但结构与本产品不符」的负例，靠**真实结构校验**而不是摘要拦住；
并另加「只改外键 `ON DELETE` / `ON UPDATE` 动作、列 / 主键 / 数据 / 迁移记录全不变、并将清单摘要
一并重算」与「重复声明同列同目标外键」两类伪结构负例，源库与快照两侧均被
`foreign_key_actions` / `foreign_key_duplicate` 拦住）。
若后续需要防伪，应在 LOCAL-06 的审计部分引入签名 / 校验和登记，本子包不假装已具备。

### 3.3 写入耐久顺序（实际执行的步骤）

`backup` 的发布顺序（每一步都是真实执行，不是文档承诺）：

1. `mkdir` 独占创建备份目录（原子互斥）；
2. 写 `.local-backup-incomplete` 并 `fsync`；
3. `VACUUM INTO` 生成 `.partial-*.db` → 用**只读连接**自检（完整性 / 外键 / 真实结构 / 内容摘要）；
4. 对自检通过的部分快照 `fsync`（失败即 `snapshot_fsync_failed`，整次备份作废）；
5. `rename` 为 `workbench.db.snapshot`；
6. 写 `.partial-*.json` 清单并 `fsync`，`rename` 为 `manifest.json`；
7. 最后删除 `.local-backup-incomplete`。

**边界（如实收窄）**：以上 `fsync` 保证**文件内容**在 `rename` 前已提交给操作系统；对**父目录项**
（新文件名本身的持久化）本模块在 POSIX 上额外尝试 `fsync` 目录，**Windows 上无法对目录 `fsync`**，
因此不承诺「rename 后立刻断电，文件名一定还在」。断电可能丢失刚发布的文件名，此时目录里会留下
未完成标记 / 部分文件，`verify` 会以 `backup_incomplete` / `manifest_missing` 拒绝，
按未完成处理并重做即可（不需要、也不会被当成可用备份）。命令输出的
`backupMeta.durability` / `durability` 会如实报告 `fileContentsSynced`（恒为 true）与
`directoryEntrySyncSupported` / `directoryEntrySynced`（Windows 为 false）。

## 4. 兼容范围

| 维度 | 当前合同 | 不兼容时的行为 |
|---|---|---|
| 产品 | `youshu-workbench` | `backup_app_unsupported` |
| 清单格式 | `youshu-workbench-local-backup` × `formatVersion = 1` | `backup_format_unsupported` |
| schema / 结构 | **恰好 v3 或 v4 两个已声明的真实结构之一**（列 / 类型 / NOT NULL / **默认值** / 主键与 **rowid 别名语义** / **唯一性键的完整比较语义**（键列顺序 / 排序规则 / 方向 / 表达式 / 部分索引）/ 外键目标列与动作 / 迁移记录连续性与迁移前备份记录全量校验） | 更高版本（未来 v5+）→ `schema_unsupported`；更低版本（v0 / v1 / v2 旧库）→ `schema_outdated`；版本对但结构不符 → `structure_invalid` |
| 应用版本 | **仅记录**（校验「存在且为非空字符串」），不参与兼容判定 | 缺失 / 类型不合法 → `manifest_invalid`；不同版本号**不会**被拒绝 |

- **两个版本各自独立契约**：
  - **v3**（LOCAL-01 迁移后、**无**资产补项列）：旧备份按 v3 契约**只读验证**并**原样**恢复到全新目录；
    验证 / 恢复**不迁移备份也不迁移源库**（备份目录与源库字节不变）；恢复出来的库仍是 v3，
    只有在把它**显式交给当前产品打开**时才走既有 v3→v4 迁移路径（会留下 `workbench.db.pre-v4-*.bak`、
    推进迁移记录到 4，并按真实 DDL 默认值把 5 个新列落为 `NULL / 0 / 'booked' / '' / 'purchase'`）；
  - **v4**（v3 + `asset_cards` 5 个补项列）：按真实 `ALTER TABLE` 契约校验列类型 / NOT NULL / **默认值**
    （`acquired_period TEXT`、`opening_accumulated REAL NOT NULL DEFAULT 0`、
    `ledger_status TEXT NOT NULL DEFAULT 'booked'`、`ledger_note TEXT NOT NULL DEFAULT ''`、
    `origin TEXT NOT NULL DEFAULT 'purchase'`），v4 的备份能被当前工具验证与恢复，恢复后能用真实产品入口继续记账 / 计提。
- 为什么**不支持 v0 / v1 / v2**：本模块校验的是**具体结构**（每张表、每个关键列与约束、默认值、迁移记录连续性）。
  对更旧的库没有对应结构规范，**不为兼容旧结构盲目放行**；这类库应先用**当前产品真实入口**打开一次完成升级。
  本模块**不会**为候选库执行初始化 / 迁移来「让它通过」。
- **表清单与内容摘要是动态的**：`structure.tables` 从 `sqlite_master` 实时计算，每表摘要也逐表计算，
  因此新增表（如今后的 bank / batch / audit 组件）会被自动纳入绑定、并因「该版本契约里没有这张表」而**被拒绝**
  （`structure_invalid` / `unexpected_tables`）——这就是「未合入的组件不得被当成已支持」的兜底，
  不靠关掉 `unexpected_tables` 或只抬高版本号过关。
- **外键动作也是结构契约**（v3 / v4 相同）：真实 DDL 里所有外键都是 `ON DELETE CASCADE` +
  默认 `ON UPDATE NO ACTION`（匹配语义默认 `NONE`），这不是风格差异而是业务语义——删除账套依赖级联。
  只改动作的伪结构（例如把 `periods.account_set_id` 的 `ON DELETE CASCADE` 改成 `NO ACTION`）
  列 / 主键 / 数据 / 迁移记录都可以完全不变、内容摘要也完全一致，但恢复后真实「删除账套」会抛外键错误。
  因此本模块按 `PRAGMA foreign_key_list` 的**外键分组**（多列外键整体比较）逐项比对
  `ON DELETE` / `ON UPDATE` / `MATCH`，并把未声明的额外外键与**重复声明**（同列组同目标多组）
  也当作结构不符（`foreign_key_actions` / `unexpected_foreign_keys` / `foreign_key_duplicate`）。
  任何版本若出现不同动作，必须在该外键条目上逐条显式声明（`actions`），**不得**放宽成
  「任一动作均可」或关闭外键检查。
- **唯一性键的比较规则也是结构契约**（v3 / v4 相同，逐表由 `collationKey` 声明）：
  「哪些列唯一」不足以定义约束，**键列顺序 / 排序规则 / 升降序 / 表达式键 / 部分索引**
  都会改变「哪些业务写入必须被拒绝」。真实验证独立复现的缺陷：把 `import_voucher_sources`
  表级 `UNIQUE (source_system, enterprise_key, source_voucher_id)` 的**最后一列改成 `COLLATE NOCASE`**，
  列 / 默认值 / 外键完全不变——旧版本 `create` / `verify` / `restore` **全部放行**（清单字节数与 sha256
  也自洽），但恢复后真实增量导入「已存 `Ref-A` 再追加 `ref-a`」会抛 `ERR_SQLITE_ERROR`，
  而正常 `BINARY` 对照是 `applied` 且两条来源并存。因此本模块按 `PRAGMA index_xinfo` 逐条比对
  **真实唯一性索引**的 origin（`pk` 主键 / `u` `UNIQUE` 约束 / `c` `CREATE UNIQUE INDEX`）、
  键列名与顺序、排序规则（`BINARY` / `NOCASE` / `RTRIM`）、升降序、表达式键、`WHERE` 部分索引，
  并与契约**一对一**匹配：语义不同 → `unique`（`reason: "semantics"`）、缺失 → `unique`
  （`reason: "missing"`）、额外 / 重复 / 契约外的唯一索引（含 `origin=c` 的命名唯一索引）→
  `unexpected_unique_index`。`INTEGER PRIMARY KEY` **不另建主键索引**（rowid 别名），按真实 rowid 语义
  核对（`rowid <> 主键列` 逐行比较；`WITHOUT ROWID` / `INTEGER PRIMARY KEY DESC` 都不符）→ `rowid_alias`；
  多列文字主键（`opening_balances(account_set_id, code)`、`periods(account_set_id, period)`）按其**真实主键索引**
  的键列与比较规则比对。真实 v3 / v4 **没有**命名唯一索引：v1 的 `idx_import_bindings_set` 在 v2 重建
  `import_source_bindings` 时已随旧表删除，**不得按旧 DDL 要求它存在**，快照里重新加上它会被拒绝。
  **非唯一**的普通查询索引只影响性能、不改变唯一性 / 去重语义，因此既不作为结构等价证据、
  也不据此拒绝（避免把正常库误拒）。
- **新增版本必须先加契约**：未来 v5 需新增独立结构契约、真实 SQLite 行为与合成临时库验收，
  再加入 `SUPPORTED_SCHEMA_VERSIONS`；模块最高支持版本（`backupContract().supportedSchemaVersion`）
  必须与产品 `IMPORT_SCHEMA_VERSION` 对齐（测试里有显式断言）。
- 反向（旧应用打开新备份）：`formatVersion` / `schema_unsupported` 会明确拒绝，
  旧应用不会误读新结构；需要恢复时应使用**不旧于**备份的工具版本。

## 5. 验证规则与稳定错误码

`verify` 的顺序（任一步失败即拒绝，**不做**任何"修复"）：

1. 目录存在且是目录；目录内**没有**未完成标记 / `.partial-*`；快照**没有** `-wal` / `-shm` / `-journal` 同伙；
2. `manifest.json` 存在、是普通文件（不是符号链接）、≤ 1 MiB、是合法 JSON，**所有必备字段的类型与
   规范范围**都成立（见 §3.1；含 `appVersion` 存在且为字符串、`pageSize` 为 2 的幂、
   `journalMode` 在白名单内、`content.tables` 的键集合与 `structure.tables` 完全一致等）；
3. `product` / `format` / `formatVersion` / `schemaVersion` 在兼容范围（§4）；
4. 快照按**固定文件名** `workbench.db.snapshot` 查找（**不按清单自报的路径找文件**），存在、是普通文件；
5. 文件字节数与 `snapshot.bytes` 一致；sha256 与 `snapshot.sha256` 一致；
6. 以 **`readOnly`** 打开快照，执行固定 `PRAGMA integrity_check` / `PRAGMA foreign_key_check`
   与固定 `SELECT`：**不执行备份里的任何 SQL，也不初始化 / 迁移候选库**；
7. **真实结构校验**（按版本选择它的独立契约：v3 → `STRUCTURE_V3`，v4 → `STRUCTURE_V4`）：
   - 必需表齐全（8 张核心会计表 + `schema_migrations` / `schema_backups` + 5 张 `import_*`），
     且没有该版本契约之外的业务表（`unexpected_tables`）；
   - 每张表的列名集合、声明类型、`NOT NULL`、**默认值**（与 `PRAGMA table_info.dflt_value` 逐字比对，
     不符 → `column_default`）、主键列与顺序全部匹配；
   - **唯一性键的完整比较语义**按 `PRAGMA index_list` + `PRAGMA index_xinfo` 逐条比对：主键 / `UNIQUE` 约束的
     键列名与顺序、排序规则（`BINARY` / `NOCASE` / `RTRIM`）、升降序、表达式键、`WHERE` 部分索引，
     以及与契约**一对一**匹配（额外 / 重复 / 契约外的唯一索引，含 `origin=c` 的 `CREATE UNIQUE INDEX`，
     一律拒绝）；`INTEGER PRIMARY KEY` 必须确实是 rowid 别名（不另建主键索引，且 `rowid` 与主键列逐行相等）；
     UNIQUE 键列组本身缺失 → `unique`，语义不同 → `unique`（带 `collation` / `desc` / `expression` 明细），
     额外唯一索引 → `unexpected_unique_index`，不是真实 rowid 别名 → `rowid_alias`；
   - 外键按 `PRAGMA foreign_key_list` 的分组（`id`）与期望外键**一对一**整体比对：本表列组 → 目标表列组
     **以及** `ON DELETE` / `ON UPDATE` / `MATCH` 动作；每个实际分组都要验动作，且不接受未声明的额外
     外键与重复声明（同列组同目标多个分组）（多列外键按 `seq` 聚合，不只比单个目标列）；
     只改动作的伪结构 → `foreign_key_actions`，重复声明 → `foreign_key_duplicate`；
   - `schema_migrations` 记录必须是从 1 到当前版本**连续**、`applied_at` 可解析；
   - `schema_backups` 必须至少有一条迁移前备份记录，形状（版本 / 路径 / 时间 / integrity）合法；
   - 任一项不成立 → `structure_invalid`（明细只含问题类型、表名、列名、计数、版本号，以及约束动作关键字
     如 `CASCADE` / `NO ACTION` / `NONE`、索引来源 `pk` / `u` / `c`、排序规则令牌
     `BINARY` / `NOCASE` / `RTRIM`（未知排序规则只报 `nonstandard`）、表达式键令牌 `expression`、
     升降序布尔值和**已知**默认值字面值（未知默认值只报 `nonstandard`）；**不含**业务原文、
     索引表达式原文与 DDL SQL）；
     结构指纹不成立 / 缺表 → 判定非本产品库；
8. 实际 schema 版本与清单 `structure.schemaVersion`、`source.schemaVersion` 一致，
   `structure.migrations` 与真实迁移记录逐项一致，`user_version` 一致；
9. 实际表清单与清单一致（不多不少）；
10. **可重算的物理属性**与清单一致：`snapshot.pageSize`、`snapshot.journalMode`；
11. 重新计算每表行数 + 摘要 + 总摘要，与清单逐项一致。

`integer`/`real` 值、金额与来源关联都包含在摘要里，因此「金额被改一点点」「来源关联被删一条」
都会以 `content_mismatch` 被拦住，而不是只靠文件大小。

### 5.1 错误码（稳定，供上层脚本判定；不含账务原文 / 原始 SQL / 堆栈 / 绝对路径）

备份入口：

| code | 含义 / 可操作建议 |
|---|---|
| `db_path_required` / `source_missing` / `source_not_file` | 明确传 `--db <文件>`，且必须存在、是普通文件 |
| `source_alias` | 源库是符号链接、硬链接（`nlink > 1`）或经过符号链接 / junction 的路径：改传真实现路径 |
| `source_sidecar` | `--db` 指到了 `-wal` / `-shm` / `-journal`：改传主库文件 |
| `source_empty` | 0 字节文件不是可用库 |
| `source_unreadable` / `source_not_database` / `source_busy` | 打不开 / 不是 SQLite 库 / 被独占锁住（稍后重试） |
| `source_readonly_blocked` | 只读连接无法完成 WAL 索引读取（该环境需要写 `-shm`）：先用产品真实入口打开一次再备份；本包不会改用可写连接 |
| `source_not_product_database` | 不是本产品库（缺必需表，含缺 `import_*` / `schema_backups`） |
| `source_structure_invalid` | 是本产品库但结构 / 约束 / 迁移记录与本模块校验的当前结构不符（明细给出问题类型与表 / 列） |
| `schema_unsupported` | 源库 schema 版本高于本模块支持上限（未知未来版本，例如 v5+） |
| `schema_outdated` | 源库 schema 版本低于本模块支持的当前结构（旧库需先用当前产品入口升级） |
| `out_required` / `out_invalid` / `out_parent_missing` | `--out` 必须是路径，且**父目录**已存在（不递归猜位置） |
| `out_exists` / `out_incomplete` / `out_alias` / `out_uncreatable` | 目录已存在 / 有上次残留 / 是符号链接 / 无法创建：换一个新目录 |
| `path_conflicts_source` | 计划写入的文件与源库自身或其 sidecar 冲突：换目录 |
| `snapshot_failed` / `snapshot_fsync_failed` / `integrity_failed` / `foreign_key_violation` / `snapshot_busy` / `snapshot_unreadable` / `write_failed` | 快照生成、落盘或自检不通过：源库需要先人工核对（本包不提供修复） |
| `internal_error` | 未预期错误（已折叠，不含内部细节） |

验证入口（`verify` 与 `restore-new` 的第一阶段，后者额外带 `"stage": "verify"`）：

`backup_dir_required` / `backup_dir_missing` / `backup_incomplete` / `manifest_missing` / `manifest_invalid` /
`backup_format_unsupported` / `backup_app_unsupported` / `schema_unsupported` / `schema_outdated` /
`snapshot_missing` / `snapshot_symlink` / `snapshot_size_mismatch` / `snapshot_digest_mismatch` /
`snapshot_unreadable` / `snapshot_busy` / `integrity_failed` / `foreign_key_violation` /
`snapshot_not_product_database` / **`structure_invalid`** / **`snapshot_metadata_mismatch`** /
`structure_mismatch` / `content_mismatch` / `internal_error`

恢复入口额外（`"stage": "target"` 或 `"stage": "restore"`）：

| code | 含义 / 可操作建议 |
|---|---|
| `target_required` / `target_invalid` / `target_parent_missing` | `--target` 必须是路径，父目录已存在 |
| `target_alias` / `target_exists` / `target_incomplete` | 目标是符号链接 / 已存在 / 有上次未完成残留：**不得覆盖**，另选新目录或按 §6.3 清理 |
| `target_conflicts_backup` | 目标的**真实路径**落在备份目录内（含父目录 junction 别名情形）：换目录 |
| `target_uncreatable` | 无法创建目标目录 |
| `restore_copy_failed` / `target_no_space` | 复制失败 / 空间不足（目标不会留下 `workbench.db`） |
| `snapshot_size_mismatch` / `snapshot_digest_mismatch` | 复制期间快照被替换 / 变化：备份目录已被改动，需重新备份 |
| `restore_fsync_failed` / `restore_publish_failed` / `restore_verify_failed` / `write_failed` | 落盘 / 发布 / 发布后复验 / 写回执失败：目标被回滚清理 |

清理未能删除目录时，结果会带 `details.cleanup = "directory_kept"`（提示操作者人工删除，**不会**伪装成功）。

## 6. 恢复到全新独立目标

### 6.1 前置与结果

- `--target` 必须是**不存在**的目录（父目录需存在）。已存在（含**空目录**、文件、符号链接、未完成残留）
  一律拒绝，**目标内容完全不动**。
- 成功后目标目录内容固定为：

| 文件 | 说明 |
|---|---|
| `workbench.db` | 恢复出来的库（可直接作为产品数据目录使用） |
| `manifest.json` | 原备份清单的副本（溯源用） |
| `restore.json` | 恢复回执：`verified`、`restoredAt`、快照 sha256 / 字节数、结构版本 / 迁移记录 / 表清单（**无绝对路径**） |

### 6.2 发布顺序（先验证再发布）

1. 完整跑一遍 `verify`（§5）；失败则**不创建目标目录**；
2. 用**真实路径**判定目标是否落在备份目录内（§7），命中即拒绝；
3. 原子创建目标目录（`mkdir` 无 `recursive`，已存在即失败，天然互斥）；
4. 写 `.restore-incomplete` 标记并 `fsync`；
5. 把快照复制为 `.partial-<pid>-<随机>.db`，**对复制结果重新计算字节数与 sha256** 并与清单比对
   （防「验证与复制之间快照被替换」）；
6. `fsync` 该临时文件；
7. `rename` 为 `workbench.db`（同目录内原子操作）；
8. 以 `readOnly` **再验证已发布文件**（摘要 / 完整性 / 外键 / 真实结构 / 内容摘要 / 无 sidecar 残留）；
9. 写 `manifest.json` 副本与 `restore.json` 回执（各自 `fsync`）；
10. 最后删除 `.restore-incomplete` 标记。

任何一步失败：删除本次创建的条目并尝试删除目标目录；失败结果**绝不**包含 `ok: true`。
目录项耐久性与 §3.3 相同：文件内容已 `fsync`，Windows 上无法 `fsync` 目录，断电后可能丢失刚 rename
的文件名，此时标记仍在，按未完成处理。

### 6.3 中断语义（进程被 kill / 断电）

- 目标目录里**没有** `workbench.db` ⇒ 一定没有可用的恢复结果；残留只有 `.restore-incomplete` 与 `.partial-*`，
  后续 `restore-new` 会以 `target_incomplete` 明确拒绝。
- 目标目录里**有** `workbench.db` ⇒ 它一定是**完整副本**：`workbench.db` 这个文件名只在复制结果通过
  sha256 / 字节数比对并 `fsync` 之后才出现，**不存在**「半套数据顶着正式文件名」的窗口。
  但若 `.restore-incomplete` 仍在，说明回执 / 清单副本尚未写完，**按未完成处理**。
- 处置规则：**删除该目标目录后重做**（不要在半成品上继续操作）；
  `verify` 也不会把带未完成标记的目录当成备份（`backup_incomplete`）。

### 6.4 恢复后如何被当前产品使用

当前产品以「数据目录 + `workbench.db`」定位库（`db.mjs`：`WORKBENCH_DATA_DIR` 或默认数据目录）。
因此恢复出来的目标目录可以直接作为数据目录使用；产品启动时若 schema 版本已是目标版本，不会重复迁移 / 备份。

本包自测就是用**当前真实入口**验证的：子进程设置 `WORKBENCH_DATA_DIR=<新目标目录>`，
import 真实 `accounting.mjs` / `import-incremental.mjs`，读到的期初、两个月余额、试算平衡、
利润表与来源追踪与手算预期、与备份时点完全一致；v4 场景还读出资产卡片 5 个补项列 / 期初累计 /
连续两个月计提与总账 / 封账状态 / 两批导入批次与来源，并在恢复库上继续记账与计提（见交接 §3）。

**恢复一个 v3 备份得到的是 v3 库**（不做隐式迁移）：要交给当前产品使用，就把它作为数据目录**显式打开一次**，
由产品自己的 v3→v4 迁移路径升级（会先做一份 `workbench.db.pre-v4-*.bak`）；升级后的实际差异已在自测中断言
（新列按默认值落为 `NULL / 0 / 'booked' / '' / 'purchase'`，旧卡片因此会报 `asset_acquired_period_missing` /
`asset_accumulated_mismatch` 等真实缺项，而不是凭空补出历史累计）。

**不自动切换**：本子包不修改正在使用的数据目录、不改环境变量、不停止正在运行的产品进程。

### 6.5 原位恢复的接入契约（后续共享维护窗口，本包**未实现**）

原位恢复（把备份写回正在使用的数据目录）**不在本子包**，需要与 `db.mjs` 等共享文件统一维护，
接入时必须满足（作为后续任务的输入契约）：

1. **停写**：确认没有正在写入的产品进程 / 脚本 / 批量任务（本产品是本机单用户，但仍可能有多进程）；
2. **关闭连接**：关闭 `db.mjs` 的 `DatabaseSync` 句柄（否则 WAL / `-shm` 仍被占用，Windows 上文件无法替换）；
3. **保护现库**：先把现库按本包方式**另做一个备份**（不能只把现库挪走），并记录切换前的
   `schemaVersion` / 内容摘要，供切换后核对；
4. **整体替换**：现库及其 `-wal` / `-shm` / `-journal` 必须**一起**移走，不能只覆盖主文件（否则旧 WAL 会
   与"新"主文件错配，这是最危险的失败模式）；
5. **重新打开并核对**：以产品真实入口重新打开，核对 `schemaVersion`、内容摘要、关键余额；
6. **失败回退**：保留第 3 步的现库备份，切换失败时按同样步骤回退；
7. **审计留痕**：原位恢复必须写入操作日志 / 审计（LOCAL-06 审计部分），并区分"恢复到新目标"与"就地替换"。

在此之前：本子包只做**恢复到新目录**，让操作者自行核对后再决定是否切换数据目录。

## 7. 路径 / 别名 / 覆盖 / 并发规则

| 场景 | 规则 | 结果 |
|---|---|---|
| 源库是符号链接 / junction 路径 / 硬链接 | 备份来源必须可追溯，拒绝 | `source_alias` |
| `--db` 指向 `-wal` / `-shm` / `-journal` | 拒绝（要求主库文件） | `source_sidecar` |
| 备份目录 / 恢复目标已存在（目录或文件） | **绝不覆盖** | `out_exists` / `target_exists` |
| 备份目录 / 恢复目标是符号链接（含 Windows junction） | 拒绝，避免写到别名位置 | `out_alias` / `target_alias` |
| 目录里有上次中断的标记 / `.partial-*` | 明确「未完成」，给可操作提示 | `out_incomplete` / `target_incomplete` |
| 恢复目标真实路径在备份目录内 | 拒绝（避免污染已验收备份） | `target_conflicts_backup` |
| 计划写入的文件与源库 / sidecar 同路径 | 拒绝 | `path_conflicts_source` / `target_conflicts_backup` |
| 两个进程同时备份到同一目录 / 恢复到同一目标 | **独占 `mkdir`** 保证恰好一个成功；另一个明确拒绝（`out_exists` / `out_incomplete` / `target_exists` / `target_incomplete`），不留半成品 | 见 §5.1 |
| 父目录不存在 | 不递归创建（避免误建到意外位置） | `*_parent_missing` |

**别名判定用真实路径**：源库 / 输出目录 / 恢复目标的路径先按父目录 `realpath` 归一化，
`target_conflicts_backup` 两侧都按真实路径比较，因此「经父目录 junction 访问备份、把目标写进备份目录」
不能绕过（自测里有对应用例：经 junction 访问备份 + 目标在备份内 → `target_conflicts_backup`，
备份目录内容完全不变）。

互斥实现说明：**互斥由操作系统的原子 `mkdir` 提供**，本子包**不使用锁文件**，因此不存在
「锁文件过期 / 需要强制解锁」的问题；中断后残留由未完成标记表达。

## 8. 下游函数契约

模块：`06-workbench/server/local-backup.mjs`（依赖：`node:sqlite`、`node:crypto`、`node:fs`、`node:path`
与 `./import-storage.mjs` 的**只读常量 / 版本函数**；**零新增第三方依赖**，无模块级副作用）。

```js
createBackup({ dbPath, outDir, now? })
  -> { ok, status: "ok"|"rejected"|"failed", code, details,
       backupDir?, backupMeta?, manifest? }
     // backupMeta.durability = { fileContentsSynced: true,
     //                           directoryEntrySynced, directoryEntrySyncSupported }

verifyBackup({ backupDir })
  -> { ok, status, code, details, backupDir?, manifest?, summary? }
     // summary.migrations = [1,2,3]（v3 备份）或 [1,2,3,4]（v4 备份）

restoreNew({ backupDir, targetDir, now? })
  -> { ok, status, code, details, stage?, targetDir?, database?, receipt?, durability?, summary? }

backupContract()
  -> { format, formatVersion, product, supportedSchemaVersion, supportedSchemaVersions,
       productSchemaVersion, snapshotFile, manifestFile, targetDatabase, coreTables, requiredTables }
     // supportedSchemaVersions = [3, 4]（每个版本都有独立结构契约）
     // supportedSchemaVersion = 4（最高支持版本，必须与产品 IMPORT_SCHEMA_VERSION 对齐）
```

约定：

- **不抛异常**：所有可预期失败都以 `{ ok: false, status: "rejected", code }` 返回；
  未预期错误折叠为 `status: "failed"`, `code: "internal_error"`，**不带**内部信息。
- `details` 只含字段名 / 计数 / 表名 / 列名 / 版本号 / 问题类型 / 白名单化 reason，
  **不含**账务原文、原始 SQL、堆栈或绝对路径。
- 需要落日志 / 写入审计的一方（LOCAL-06 审计部分、LOCAL-07 批量任务）可直接消费 `code` 做稳定判定。
- 上层接线（HTTP / Agent / MCP / UI）**尚未实现**；若后续接入，必须只暴露本模块的返回结构，
  不要把 `manifest` / `details` 原文透出到模型侧（见 LOCAL-08 的数据输出边界）。

CLI：`06-workbench/scripts/local-backup.mjs`

```
node scripts/local-backup.mjs backup      --db <源库文件> --out <全新的备份目录>
node scripts/local-backup.mjs verify      --backup <备份目录>
node scripts/local-backup.mjs restore-new --backup <备份目录> --target <全新的目标目录>
```

- 标准输出**始终**是一段 JSON（含 `command` / `ok` / `status` / `code`，成功时带目录与摘要信息）；
- 退出码：`0` 成功、`1` 用法错误（`usage_*`）、`2` 明确拒绝、`3` 内部错误；
- 只处理命令行显式给出的路径，不读未显式给出的数据目录；输出里的路径是**本机信息**，
  不要把它写进仓库文档或提交记录。

## 9. 风险与限制

1. **未接产品**：本包没有接线到 `db.mjs` / HTTP / Agent / MCP / UI，也没有定时 / 自动备份；
   操作者需要自己按 CLI 手动备份。
2. **严格拒绝有代价**：`foreign_key_violation` / `integrity_failed` / `structure_invalid` 会拒绝整次备份。
   若真实账套历史数据本身存在外键或页级问题，或库被手工改过结构，会**先被拦住**（这是有意的安全取向），
   此时需要先人工核对（本包**不提供**修复工具，也不会替库做迁移）。
3. **schema 只支持已声明的 v3 / v4**（§4）：v0 / v1 / v2 旧库给 `schema_outdated`，必须先用当前产品入口升级；
   v3 备份只读验证 / 原样恢复（不隐式迁移），要升到 v4 必须由产品入口显式打开。
   未来 v5 **必须**先新增独立结构契约、真实 SQLite 行为与合成临时库验收，再加入支持集合；
   bank / batch / audit 等**尚未合入**的组件仍未做契约，带这些表的库会被 `unexpected_tables` 拒绝。
4. **清单无签名**（§3.2）：防损坏 / 防不一致，不防整体伪造；结构校验能拦住「结构不符」
   （含只改外键 `ON DELETE` / `ON UPDATE` 动作的伪结构、重复声明同列外键的伪结构，
   以及只改唯一性键排序规则 / 键顺序 / 方向 / 表达式 / 部分索引的伪结构），
   但拦住的是结构而不是恶意同构伪造。
   本轮的索引键语义校验**未改变清单格式**（不新增索引字段，`formatVersion` 仍为 1），
   因此旧工具生成的合法 v3 / v4 清单不会因新增内部校验而摘要失配。
5. **内容摘要是全表扫描**：大库（几十万凭证）备份 / 验证会明显变慢，且内存占用随单表行数增长
   （逐行规范序列化）；当前按本机单用户规模设计，未做增量 / 分块优化。
6. **源库保护的边界**：只承诺「主库与 `-wal` 字节不变、不被 checkpoint / 删除」；
   `-shm` 的读锁 / 读标记可能变化（§2.1），它不承载业务数据。
7. **耐久性边界**：文件内容在 `rename` 前 `fsync`；**Windows 无法 `fsync` 目录项**，
   断电可能丢失刚发布的文件名（按未完成处理），不承诺目录项持久化。
8. **未验证真实账套**：所有自测都是合成数据（临时目录 + 合成账套 / 批次 / 来源 / 资产卡片），
   没有接触真实财务数据，**不构成真实财务正确性验证**；也没有任何税局相关动作。
   v3 夹具是从**真实 v4 产品快照**用 SQLite `DROP COLUMN` 反向去掉 v4 只加列并回退迁移记录 4 得到的
   **结构等价合成库**（用例里逐列断言列 / 类型 / NOT NULL / 默认值 / 迁移记录确实是 v3），
   不是字节级的历史 v3 账套；因此本包**不声称**验证过真实历史账套的旧备份。
9. **未验证 Windows 交付路径**：没有做干净机器安装 / 服务化 / 权限 / 杀毒软件占用等场景验证；
   junction / 硬链接规则在本机 Windows 上实测过，但不同文件系统（网络盘、同步盘）行为未验证。
10. **索引键校验的边界**：只对**唯一性**（主键 / `UNIQUE` 约束 / 唯一索引）做语义比对，因为只有它们
   改变「哪些写入必须被拒绝」；非唯一查询索引不作为结构证据、也不据此拒绝。`AUTOINCREMENT` 与
   表的 `WITHOUT ROWID` 以外的存储选项不在本轮校验范围（rowid 别名语义本身会被核对）。
   表达式 / 部分索引目前只作为**拒绝依据**出现（真实 v3 / v4 没有它们），契约没有对应的正向条目。

## 10. 自测

命令（在 `06-workbench` 目录）：

```
node test/local-backup.test.mjs
```

覆盖与真实结果见交接文档 [handoffs/LOCAL-06-BACKUP](handoffs/LOCAL-06-BACKUP.md) §3。

当前（索引键语义回修轮）**22 / 22 通过、exit 0**；兼容整合轮是 **20 / 20**，其中 1–16 是 PR #55 已验收的原有 16 项
（全部保留，仅在 schema 版本断言上从 v3 改为 v4），17–20 是兼容整合轮新增，21–22 是本轮新增：

- **v4 真实产品合成库全链路**：真实产品入口建库（增量导入两批 + 资产卡片 5 个补项列 + 期初累计 +
  连续两个月计提与总账 + 1 月真实封账 + 2 月保持 open），`createBackup` → `verifyBackup` → `restoreNew`，
  再用真实 `accounting.mjs` / `import-incremental.mjs` 读出并**独立手算核对**期初 / 两个月余额 /
  试算平衡 / 凭证清单 / 计提记录 / 卡片补项与累计 / 批次与来源 / 期初检查步骤状态；
- **v4 恢复库上的真实后续操作**：继续记账、继续计提 3 月，且已封账期间的写入 / 计提反过账被 `period_closed` 拒绝；
- **v3 旧备份语义**：只读验证（源库与备份字节均不变）→ 恢复到全新目录（仍是 v3）→ 产品入口显式升级到 v4
  （新增迁移前备份文件、迁移记录 4、5 列按真实默认值落库、旧卡片缺项如实报告）→ 升级后的库能按 v4 备份 / 验证，
  旧 v3 备份仍只读可用；
- **伪兼容拒绝**：只抬高版本号（v3 结构 + version=4 记录）、缺列、错默认值、错 null、错类型、
  未知组件表、未来 v5、迁移记录不连续、v4 结构却声称 v3，以及把快照换成伪结构并**重算清单 sha256** 的
  快照侧伪兼容；全部给稳定 code，且源库字节不变、不创建输出目录 / 恢复目标。
- **唯一性键比较语义（本轮新增，第 21 项，v4）**：`import_voucher_sources` 表级 `UNIQUE` 最后一列改
  `COLLATE NOCASE` / `RTRIM`、`opening_balances` 主键文字列 `code` 改 `COLLATE NOCASE`、`periods` 主键键列 `DESC`、
  `accounts` 的 `UNIQUE` 键列顺序反转、把 v1 已删除的 `idx_import_bindings_set` 加回、同一唯一键重复声明成命名索引、
  表达式唯一索引、`WHERE` 部分唯一索引、`vouchers.id INTEGER PRIMARY KEY DESC`（不再是 rowid 别名）——
  十种变体在**源库入口**与**重算清单字节数 + sha256 的快照入口**均被拒绝（`unique` / `unexpected_unique_index` /
  `rowid_alias`），恢复不产目标目录、源库字节不变、错误明细不含 SQL / 表达式原文 / 本机路径 / 业务原文；
  同时保留两组正常对照：与真实 DDL **同义重建**的表、额外**非唯一**查询索引都不被误拒，真实 v4 备份照旧通过。
  用例里先验证了「NOCASE 下只差大小写的来源 ID 真的会撞唯一约束」这个前置事实，因此拒绝不是风格问题。
- **唯一性键比较语义（本轮新增，第 22 项，v3 旧快照）**：同一组 NOCASE / 主键文字键 / 复活旧命名唯一索引
  变体在**真实 v3 快照**上同样被拒绝（`structure_invalid` 且明细指向 `schemaVersion: 3`），恢复不产目标；
  未变形的 v3 备份仍可验证 / 可恢复。
- **旧工具产物向后兼容（本轮实跑事实，不属新用例）**：先**用修改前的冻结源码**生成真实 v4 / v3 合成备份
  （16 表 / 88 行与 87 行，清单 sha256 与快照 sha256 已记录到忽略目录），修改后该两个备份
  `verify` 仍通过、清单 / 快照字节未变、`restore-new` 成功、恢复文件仍是备份时的 schema 版本，
  期初 / 余额 / 凭证 / 来源凭证 ID 与旧工具记录一致；恢复库上真实增量导入追加只差大小写的 `ref-a`
  仍为 `applied` 且 `Ref-A` / `ref-a` 两条并存（费用 700 → 705）——即旧工具生成的合法清单不因新增内部校验而失配。

已审源码 head `b2dcba35e87e9ebb75245dcc874aa41705b31243`（PR #55）上是 **16 / 16**，分别由管理者与
未参与实现、fork 为 none 的独立审查各实跑一次；独立审查另实跑五种外键变体（`ON DELETE NO ACTION`、
`ON UPDATE CASCADE`、`CASCADE + RESTRICT`、逆序重复、两个同 `CASCADE`），源库与重算清单 hash 的快照
两侧均被拒绝且不创建输出 / 目标，正常结构恢复后真实 `accounting.deleteAccountSet` 成功级联。
本轮的 20 项在外键分组一对一比对之上保留了这三种动作 / 重复变体用例（第 11 项）。

历史状态必须分开看：head `829541a`（六文件源码 `ddadb03`）的 15 / 15 与第一轮 16 / 16 都曾漏掉
「重复声明同列同目标外键可绕过」，因此**未最终通过**，已被当前的外键分组一对一比对取代。
`import-incremental` 49 / 49、`import-incremental-http` 22 / 22、`smoke` 28 / 28 是更早一轮返工后的
受影响回归结果；本包只改自己的文件、未动共享业务源码，因此没有把它们当作本轮证据。

聚合入口：按任务单授权**仅追加**本套件与两个已合入模块套件（`finance-output-policy` 28 / 28、
`report-office-export` 21 / 21）到 `scripts/test-all.mjs`，原有 50 套顺序与内容不变；
在 `06-workbench` 设 `REPORT_OFFICE_PYTHON` 后跑 `npm test` 为 **55 / 55 套 exit 0**（真实运行；
Office 导出验收 21 / 21，外部 poppler + pdfplumber 对 **11 个真实 PDF** 的几何校验通过）。

## 11. 当前状态与下一步

1. **已验收合并的部分**：已审源码 head `b2dcba3` 的 16 / 16（管理者 + 独立审查各一次，均 exit 0）、
   五种外键变体在源库与快照两侧均被拒绝、正常结构恢复后真实删除账套成功；已随 PR #55 合并。
2. **合并事实**：PR [#55](https://github.com/huxiaoyang-code/youshu-fork/pull/55) 已 MERGED，
   merge `98977e04bd24aa293074021802191814f8c2a1d2`（北京时间 2026-10-22）；已审源码 head `b2dcba35e87e9ebb75245dcc874aa41705b31243`。
3. **兼容整合轮状态**：v3 + v4 精确契约、20 / 20 自测、`npm test` 已在本机真实跑过；
   该轮源码 / 测试 / 文档**尚未提交、未建 PR、未合并**，最终独立审查待做（不预报 head / merge）。
3.1 **索引键语义回修轮（本轮）**：独立审查在银行候选上发现并实际证实「继承旧版本的本模块也挡不住
   唯一性比较规则变化」这一缺陷（`COLLATE NOCASE` 变体旧版本 `create` / `verify` / `restore` 全部放行，
   恢复后真实增量导入 `Ref-A` / `ref-a` 行为与正常库不同）。本轮把结构契约升级为**完整唯一性键语义**
   （`PRAGMA index_xinfo` 的键列 / 排序规则 / 方向 / 表达式 + `index_list` 的 origin / partial + 真实 rowid 语义），
   并新增十种变体与两组正常对照、v3 旧快照变体、旧工具产物向后兼容核对。
   实跑：`node test/local-backup.test.mjs` **22 / 22 exit 0**；`npm test` **55 / 55 套 exit 0**。
   先红后绿：同一套测试在修改前模块上为 **20 / 22**（两项新测试均以「期望拒绝、实际接受」失败）。
   **清单格式与 `formatVersion` 未变**（只强化验证，不新增字段 / 不改摘要口径）。
   状态：**实现与自测完成，待 root 冻结与备份独立审查**；未提交 / 未建 PR / 未合并。
4. **仍未支持**：v0 / v1 / v2 旧库（先用产品入口升级）、未来 v5+、bank / batch / audit 等未合入组件；
   这些必须**显式**做结构契约与真实 SQLite 行为 + 合成临时库验收，不得用动态表清单或「旧用例通过」推定已支持。
5. **Issue #49 保持 OPEN** 供兼容整合；完整审计留痕在
   [Issue #54](https://github.com/huxiaoyang-code/youshu-fork/issues/54)。
6. **后续仍未实现**：原位（就地）恢复与回退编排、Windows 干净安装 / 启动 / 升级交付、
   审计接线、定时 / 批量入口；这些完成后本子包才能计入 LOCAL-06 整体交付，
   本文件**不声称** LOCAL-06 整体完成。
