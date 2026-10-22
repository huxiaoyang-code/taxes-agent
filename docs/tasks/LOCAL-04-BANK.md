# 任务单 · LOCAL-04-BANK 本地银行 CSV、持久对账与余额调节

- 类型：后端领域 + 组件持久层 + 本机 CLI + 契约文档 + 测试
- 状态：原 56 项银行包已独审并合入冻结核；**2026-10-22 追加「现库安装 / 组件备份」子包，真实集成验收完成，待管理者复验 / 提交 / PR / 合并**。本文件不预写 PR 编号、已审 head 或 merge，也不声称最终已通过。
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
| `06-workbench/test/bank-reconciliation.test.mjs` | 真实临时库领域回归：幂等 / 去重 / 歧义 / 候选 / 匹配 / 失效 / 余额调节 / 分页与 asOf / 结构契约（含索引谓词、外键完整集合、版本表形状）/ 对账原子性（29 项） |
| `06-workbench/test/bank-reconcile-cli.test.mjs` | CLI 子进程端到端回归（11 项） |
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
| 对账结果持久化原子：插运行记录失败与插审计失败都全组件回滚，无无审计新结果、无误废弃旧结果 | 通过（首轮审查 P2 修复） |
| CSV 错误列表总上限：201 行坏金额不崩、重复流水号追加路径共用上限、截断不误报 ok | 通过（首轮审查 P2 修复） |
| 既有全套回归 | 上一轮 `npm test` 47 / 47 套件通过；本轮只跑定向 3 套（未改上游共享代码） |

## 6. 实际测试命令与结果（本次运行）

工作目录 `06-workbench`：

```
node --test test/bank-import.test.mjs          # 16 / 16 通过
node --test test/bank-reconciliation.test.mjs  # 29 / 29 通过
node --test test/bank-reconcile-cli.test.mjs   # 11 / 11 通过
node --test test/bank-import.test.mjs test/bank-reconciliation.test.mjs test/bank-reconcile-cli.test.mjs
                                                # 56 / 56 通过，exit 0（约 11.1s）
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

## 8. 交付后管理者需要做

1. 阅读实际 diff（4 实现 + 3 测试 + 3 文档，无共享文件改动）；
2. 复现关键金额与失败路径（§6 命令；固定手算 140000 / 140000 / 差额 0；1 分差异 pending_review；
   已有库无备份 exit 5；错索引谓词 / 额外外键 / 版本表改名均在业务写前 `bank_schema_corrupt`）；
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
2. `scripts/test-all.mjs`、`package.json`、公共 backup 三文档未修改；新集成套件尚未注册总入口。
3. 本分支不是「LOCAL04 整体 / LOCAL03 科目往来已完成」；LOCAL02 正式合入并同步最终修复前，本子包不合并；
   最终合入仍需 root 同步 02 正式 main。
4. 上游整合后 root 需重跑全量回归；本包只跑影响面定向五套。
