# 本机持久批量 CLI（LOCAL-07 / B1）

本机**单用户**财税工作台的持久批量任务与命令行入口：一名操作者在自己电脑上对**多家企业**做批量导入、
过账、计提 / 摊销、结转、期末检查、结账与内部报表。**一家企业只有一个账套**，多企业批量处理 = 多个账套。

- 批量 ≠ 多租户：不引入 SaaS、租户权限、账户体系或对外服务；只保留本机实际需要的账套隔离、审计留痕与备份恢复。
- 本 CLI **不**接税局、不生成官方申报文件、不新增网页平台。真实税局接入数仍为 0。
- 报表是**内部管理报表**（`schemaVersion=1` DTO），不是税局申报模板；数据完整性「未核实」的提示随报表一起输出。

相关实现与交接：

- [任务单](tasks/LOCAL-07-CLI.md) · [交接](handoffs/LOCAL-07-CLI.md)
- 上游契约：[增量导入契约](LOCAL-IMPORT.md)（LOCAL-01，已合并）
- 八包总览：[tasks/INDEPENDENT-PRODUCT-WORK.md](tasks/INDEPENDENT-PRODUCT-WORK.md)

## 1. 当前依赖状态（必须如实阅读）

| 依赖 | 状态 | 本 CLI 的处理 |
|---|---|---|
| LOCAL-01 增量导入（`import-incremental.mjs`） | 已合并 | 直接用；批次 / 来源 / 一企一账套 / 跨批去重规则全部沿用上游 |
| LOCAL-05a 纯渲染（`report-office-export.mjs`） | 已合并 | worker 线程只调用 `buildReportDocument/buildReportXlsx/buildReportPdf` |
| LOCAL-05b 会计口径 / 双准则 | 未完成 | 不冒充合规；报表沿用现有本地科目映射，限制写在 DTO 与产物里 |
| **LOCAL-02 金额 / 期末完整性（`A.periodEndCheck` / `A.setPeriodStatus`）** | **已实际合入 main（PR #60）** | `period-check` 只按真实 `{ ready, steps, blocking }` 判定；`close` 真实调用 `setPeriodStatus`，由核心重新校验前置，close 效果与 checkpoint 同一事务。旧 check 成功不代替核心校验 |
| **LOCAL-06 备份恢复（`createBackup` / `verifyBackup` / `restoreNew`）** | 模块已合，但**现库组件安装 / restore-new 未接线** | 只在**显式新目标**上初始化批量结构；既有库（含零字节文件 / 空业务核心库）一律 `migration_requires_backup` / `dependency_unavailable`，不自动建表、不用 `copyFile` 冒充备份 |

因此本 B1 交付的是「真实七阶段（含真实期末检查 / 封账）+ 持久协议 + 独占新建安全」。
现库组件安装、共享手工入口互斥与 `restoreNew` 实例分叉仍归后续 W3 / W4，**不能宣称 LOCAL-07 整包完成**。

## 2. 运行方式

```bash
# 在工作台目录（06-workbench）执行
node scripts/local-batch.mjs help
node scripts/local-batch.mjs start  --data-dir <数据目录> --manifest <manifest.json> --output-dir <输出根目录>
node scripts/local-batch.mjs status --data-dir <数据目录> --job-key <jobKey>
node scripts/local-batch.mjs resume --data-dir <数据目录> --job-key <jobKey> [--use-saved-inputs]
node scripts/local-batch.mjs cancel --data-dir <数据目录> --job-key <jobKey>
node scripts/local-batch.mjs retry  --data-dir <数据目录> --job-key <jobKey> [--item <itemKey>] [--period <YYYY-MM>] [--stage <stageKey>] [--use-saved-inputs]
```

- `--data-dir` 每次都必须显式给出（该目录内是 `workbench.db`）。`start` 还必须显式给出 `--manifest` 与 `--output-dir`。
- `--data-dir` 必须是真实目录（不能是符号链接 / junction，realpath 必须与显式路径一致），否则 `data_dir_alias`。
- `status` 使用**只读**连接：不建表、不升级、不续跑；缺库返回 `database_not_found`，不会把不存在的库当新库。
- 数据目录只读探测对**并发瞬时锁**有限重试（另一个执行者正在写 / 正关闭连接并清理 `-wal`、`-shm` 时
  只读探测会瞬时拿到 `database is locked`，这不是库损坏）；真正读不出才报 `database_unreadable`（fail-closed）。
  重试预算如实为：**每连接 `busy_timeout = 5000`（毫秒）、最多 4 次尝试、重试间额外睡眠合计 300ms、没有全局截止**，
  因此**不保证 < 1 秒**。独立审查实测：另用 DELETE-journal 模式的库以 `BEGIN EXCLUSIVE` 持锁时，另一子进程单次
  只读探测耗时 29812ms（wall 29867ms）后才 fail-closed（`readable=false` / `database is locked`）；该数字只描述
  那一次观测，不代表每个环境的固定时长。产品未要求 < 1 秒，本包未加 deadline、未改该行为。
- `cancel` / `retry` 只改任务状态（不 import 会打开业务库的编排模块），`retry` 之后仍需 `resume` 继续。
- stdout 只有一行受控 JSON；stderr 只输出错误码与一句话说明，不含账务文本 / SQL / 堆栈。
- 输出文件只写入 `--output-dir` 之内（受控相对路径），从不覆盖已有无关文件。

### 退出码

| 退出码 | 含义 |
|---|---|
| `0` | 命令成功且任务状态为 `succeeded`（或 `cancel` / `retry` 正常登记） |
| `1` | 仍有失败 / 需复核 / 依赖阻塞 / 已取消 / 其它实例正在执行 |
| `2` | 参数、manifest 校验或 jobKey 冲突错误 |
| `3` | 依赖或数据目录错误（缺库、无批量结构、需先备份、结构版本不兼容、并发占用 `database_busy`、新建目标已被占用 / 非空 / 别名） |

并发 `start` / `resume` 时，共享库初始化会执行建表 / 建索引语句；若此时另一个执行者正在写，原生 SQLite
错误 `database is locked` 不当作参数错误，而统一归一为 `database_busy`（退出码 3，提示稍后重试；已进行的阶段仍可 `resume`）。

典型 JSON：`{"ok":true,"command":"start","jobKey":"...","jobId":1,"status":"succeeded","created":true,"renders":15,...}`；
错误：`{"ok":false,"command":"status","error":{"code":"database_not_found","message":"..."}}`。

## 3. manifest（schemaVersion = 1）

JSON 文件；**精确白名单字段**，出现未知字段即拒绝。规范 JSON（对象键排序）的 SHA-256 与 `jobKey` 一一绑定。

```json
{
  "schemaVersion": 1,
  "jobKey": "batch-2026-01",
  "concurrency": 4,
  "items": [
    {
      "itemKey": "ent-01",
      "source": { "system": "local-export", "enterpriseKey": "91350...", "enterpriseName": "合成甲公司" },
      "accountSetId": 12,
      "periods": [
        {
          "period": "2026-01",
          "imports": [
            { "batchId": "ent01-2026-01", "mode": "append", "confirmNewBinding": true,
              "payloadFile": "payloads/ent01-2026-01.json" }
          ],
          "post": { "vouchers": [ { "voucherId": 41 }, { "sourceVoucherId": "ent01-sale" } ] },
          "depreciation": true,
          "carryforward": { "yearEnd": false },
          "periodCheck": true,
          "close": true,
          "reports": [
            { "kind": "balance-sheet", "formats": ["csv", "xlsx", "pdf"] },
            { "kind": "ledger", "formats": ["csv", "xlsx", "pdf"], "code": "1002" }
          ]
        }
      ]
    }
  ]
}
```

字段与约束：

| 层级 | 字段 | 约束 |
|---|---|---|
| 根 | `schemaVersion` | 必须为 `1` |
| 根 | `jobKey` | `[A-Za-z0-9._:-]`，≤128，与规范 manifest 哈希绑定；同 key 同内容幂等返回同一 job，同 key 异内容 → `job_key_manifest_conflict` |
| 根 | `concurrency` | 可选，整数 `1..8`，默认 4；= **真实渲染 worker 线程数**（不是 SQLite 并行写） |
| 根 | `items` | 非空数组，≤200 |
| item | `itemKey` | 唯一，`[A-Za-z0-9._:-]`，≤128 |
| item | `source.system` / `source.enterpriseKey` | 必填；`enterpriseKey` 只做 **NFKC + trim**，不按名称 / 大小写猜身份；同一 job 内不得重复（一企一账套） |
| item | `accountSetId` | 可选，已确认的既有账套 ID（正整数）；给了就不能再用 `mode=create` |
| item | `periods` | 非空、按年月升序、无重复，≤36 |
| period | `period` | `YYYY-MM`（月份 01-12） |
| period | `imports` | ≤10；每项 `batchId` 稳定、`mode=create|append`；`payloadFile` 与内联 `payload` **二选一**；`payloadFile` 必须是 manifest 目录内相对路径（禁止绝对路径与 `..`） |
| period | `post.vouchers` | 必须**显式**列出要过账的凭证：`{voucherId}` 或 `{sourceVoucherId}`，二选一；绝不自动过账账套内所有草稿 |
| period | `depreciation` | 布尔；统一走现有 `generateDepreciation`（固定 / 无形资产） |
| period | `carryforward` | `{ "yearEnd": bool }` 或 `false`；`yearEnd` 只按显式选择 |
| period | `periodCheck` / `close` | 布尔；`close=true` 必须同期间 `periodCheck=true`（不得跳过期未检查直接封账） |
| period | `reports` | ≤10；`kind ∈ {balance-sheet, income-statement, cash-flow-statement, trial-balance, ledger}`，`formats ⊆ {csv,xlsx,pdf}`，`ledger` 必填 `code` |

上限：manifest ≤ 4 MiB；单个 payload ≤ 16 MiB；items ≤ 200；periods ≤ 36；`post.vouchers` ≤ 2000。
`start` 即代表**正式执行** manifest 授权动作（预检不计完成）。

阶段顺序固定（没有 JS / SQL / 任意 URL 执行入口）：

```
import(按清单) → post → depreciation → carryforward → period-check → close → reports
```

## 4. 状态机

阶段状态：`pending / running / succeeded / not_applicable / failed / needs_review / blocked_dependency / cancelled`。
任务与 item 状态：`pending / running / succeeded / needs_review / failed / cancelled`。

- `succeeded` 只在**结果已核验**后落地：导入要 `import_batches=completed` 且逐张 `sourceTrace.state=ok`；
  计提要核 runs 与已过账凭证金额；结转要核真实结转凭证；封账要核 `periods.status=closed`；
  报表要核产物文件字节 hash。
- `not_applicable` 必须有真实领域证据（例如无资产卡片 / 取得期间未到 / 未到起提期 / 已提足 / 按分取整为 0 / 本期已计提），
  不能用开关绕过。计提逐卡复用 LOCAL-02 的 `assetCardPeriodStatus`，不自写 `remaining > 0` 规则。
  证据存 `local_batch_stages.evidence_json`（卡片状态、runs、原因码）。
- 期末检查 / 封账的判定：真实 `A.periodEndCheck` 返回 `{ ready, steps, blocking }`；`ready===true` 且
  `steps` 非空且无 blocking 才 `succeeded`，否则 `needs_review`（证据只留步骤 id / 状态与阻断码，
  不落企业 / 资产自由文本 details）。`close` 真实调用 `A.setPeriodStatus`，核心会重新校验业务前置；
  旧 check 成功不代替它。
- 某 item 阶段失败只停止**该 item** 的后续阶段，其它企业继续。执行器按「期间 → 阶段顺序」线性推进：
  遇到任何前序 `failed` / `needs_review` 就不再执行后序阶段（后序未开始阶段标 `needs_review` +
  `prior_stage_unresolved`，证据里记 `blockedBy`）；**同一次执行**内某阶段自身登记 `needs_review`
  （例如计提「有卡片到期但本次无动作」）同样立刻停止该 item 后序。已提交的会计动作与已成功阶段不倒撤。
  只有显式 `retry` 才重开这些阶段；`succeeded` / `not_applicable` 永不重跑。
- 每次执行（首次 `start` 与普通 `resume`）在推进前都要过两道核验，失败一律只影响该 item、零业务写入：
  1. **企业 ↔ 账套绑定**（一家企业一个账套）：item 声明的账套与 `import_enterprise_account_sets` 绑定不一致 →
     `enterprise_binding_mismatch`；声明的账套已绑定其它企业 → `account_set_enterprise_mismatch`；
     非首次建账 / 非显式新绑定却没有任何绑定 → `enterprise_binding_missing`。该核验覆盖**全部**动作，
     含无 import 的过账 / 计提 / 结转 / 检查 / 结账 / 报表 / 恢复核验，不只在导入分支。
     **解析出的账套立刻落库**：manifest 的 `accountSetId` 仍是可选字段，省略时由绑定推断；推断结果写入
     `local_batch_items.account_set_id`（`account_set_source = enterprise_binding`），后续阶段作用域、
     产物证据（`evidence.accountSetId`）与恢复核验统一使用这个持久值。未绑定 / 错绑定仍在**任何写入之前**抛错，
     不覆盖 manifest 已声明的账套（零业务写入）；不会只用锁作用域或内存快照替账套，也不会用 `null` 去重算
     报表业务摘要（否则数据与文件都没变也会误报 `report_evidence_changed`）。
  2. **源输入证据**（见 §7）：源文件被改 / 丢失且未显式选择快照 → `input_changed` / `input_missing`。
- `blocked_dependency` 只在真实依赖接口不可用 / 同期间没有成功检查时出现；当前已合入的 LOCAL-02 接口存在，
  因此正常 20 企业链路会真实执行 check / close（不是依赖阻塞）。报表不因 check / close 的业务复核而伪造成功；
  前序 `needs_review` 会按门禁停住后续阶段。
- 状态转换持久化，每次写入都带 `owner_instance` + `fencing_token` + `attempt` 的 CAS 校验。

## 5. 互斥、fencing 与事务窗口

- 锁表 `local_batch_locks`：`resource_key` 主键、`owner_instance`、单调 `fencing_token`、`pid`、租约。
  资源键：`job:<id>`、`book:<规范enterpriseKey>`、`account-set:<id>`（后两者同时持有，防止 create 与 append 绕锁；
  相同账套不同月份同样串行）。
- 申请 / 续租 / 接管都是**数据库内原子操作**（`BEGIN IMMEDIATE` + CAS）：
  - 自己持有 → 续租；
  - 租约内且 owner 进程存活（或存活无法确认）→ `lock_active`；
  - 租约已过期但 PID 仍存活 / 无法确认 → `owner_active`，**保守拒绝，不按超时抢锁**
    （代码策略；独审实测的是「租约过期 + PID 存活」，未实测「PID 存活无法确认」分支）；
  - **PID 确认已不存在** → 递增 fence 接管（死进程不可能再提交）。
- 阶段结果写入必须与 fence 校验在**同一个** `BEGIN IMMEDIATE` 事务内；旧 token / 旧 attempt 的迟到提交会被
  `fence_lost` 拒绝，不会覆盖新尝试。
- 事务窗口：
  - `post` / `depreciation` / `carryforward` / `period-check` / `close`：会计效果 + checkpoint 同一事务；
    `close` 调用真实 `A.setPeriodStatus(..., 'closed')` 并查库确认期间状态，核心领域用 SAVEPOINT，
    不套第二 `BEGIN`，也不直接 SQL 置 closed；
  - `import`：`importIncremental` 自带 `BEGIN IMMEDIATE`，**禁止外包事务**；采用「上游批次幂等 + 事后真实核验 +
    独立 fence 事务补 checkpoint」，commit 后崩溃可安全回放（见 §7）；
  - 报表：主线程在**一致只读快照**里生成 DTO / CSV 后立即释放读事务，渲染在 worker 线程，主线程不持有写事务。
- 只有批量 runner 之间保证按账套互斥；手工 HTTP / Agent 入口尚未接线，**不宣传全产品互斥**。
- 启动期并发：`start` / `resume` 在 `import` 编排层前先用本包连接（`busy_timeout`）读一次 schema，并在整个
  「加载编排层 + 确认批量结构」期间保持该连接，把两个 CLI 同时初始化共享库时因 `-wal` / `-shm` 瞬态竞争的窗口
  压到最小（**不保证消除**：共享 `server/db.mjs` 初始化仍无 `busy_timeout`，不在本包边界）；该连接不写业务数据、结束后立即关闭。

## 6. 数据落盘（同一 workbench.db）

所有批量结构都在业务库里（`local_batch_` 前缀 + 独立 component 版本表），以便业务与 checkpoint 处于同一备份时点：

| 表 | 作用 |
|---|---|
| `local_batch_component` | component 版本（`local-batch` / v1） |
| `local_batch_jobs` | `job_key UNIQUE`、manifest 哈希与规范 manifest、并发度、输出根、取消标志、状态 |
| `local_batch_items` | 每 job 每 itemKey / 每规范企业唯一；真实 `account_set_id` 与来源（`manifest` / `stage:<阶段>` / `enterprise_binding` 绑定推断） |
| `local_batch_stages` | `(item, period, stage_key)` 唯一；attempt、输入 / 结果哈希、证据、错误码、owner / fence、时间 |
| `local_batch_locks` | `resource_key` 唯一锁 + fencing token + 租约 |
| `local_batch_artifacts` | 稳定 `artifact_key`、snapshotHash、bytesHash、大小、MIME、受控相对位置、发布状态、真实 threadId 与渲染时间 |
| `local_batch_snapshots` | 报表 DTO / CSV 快照 + 业务证据 hash（供恢复与 restore-new 后按需重生成） |
| `local_batch_inputs` | 每次导入的**原始字节快照** + 指纹 + 原始相对来源（不打印原文） |

外键与唯一约束真实生效；结构建立与 component 记录在**同一事务**，失败整体回滚（不遗留半套 schema）。

### 结构初始化与备份依赖

- 只允许「数据目录里根本没有 `workbench.db`」的**显式新目标**初始化。`start` 先只读检查目录身份，
  再调用 `claimFreshDataDir`：以 `O_EXCL` 原子创建所有权标记和零字节库文件本身，把 `dev/ino` 绑定到
  进程内回执；`ensureBatchSchema` 必须收到本进程回执，建表前后都校验目录 / 库文件 / `PRAGMA database_list` /
  `dev/ino` 未被替换。**布尔 fresh / 伪造回执无效**。
- 并发两个进程抢同一新目标：最多一个取得创建资格；另一个稳定 `fresh_target_claimed`（退出码 3），
  只有能确认完整已初始化结构时才按已有库路径继续，不帮忙修半库。
- 既有库（哪怕只有核心表、空业务、甚至零字节文件）一律 `migration_requires_backup`（退出码 3，
  `details.dependency = LOCAL-06 createBackup/verifyBackup`）。`status` / `cancel` / `retry` 对这类库返回
  `batch_schema_unavailable`。符号链接 / junction 目录一律 `data_dir_alias`。
- **没有任何 CLI 参数 / 环境变量可以绕过备份**；LOCAL-06 现库安装 / `restoreNew` 由后续 W3 / W4 接线。

## 7. 输入快照、恢复与幂等

- 读源资料时**一次取得字节**，hash 与 JSON 解析使用同一份字节；超限 / 空文件 / 读一半 / 非法 JSON 一律拒绝。
- 原始字节存入 `local_batch_inputs`；manifest 规范 JSON 存入 job。源文件之后变化不会改变已保存快照。
- `retry` / `resume` 前校验源文件：
  - **普通 `resume`（以及首次 `start`）也核验**：源文件被改 → `input_changed`（needs_review，零业务写入），
    文件消失 → `input_missing`；不会静默把已保存快照的旧内容当成本次结果继续；
  - 显式 `--use-saved-inputs` → 才允许仅用受保护快照续跑，且导入阶段证据写入
    `inputEvidence = { mode: "saved_snapshot", reason: "input_changed"|"input_missing", sourceHash }`；
    未使用该开关时证据为 `mode: "source_file_verified"`（原因留痕，可审计）；
  - 快照 hash 被改 → 执行时 `input_changed`；
  - `resume` 输出在 `items[].inputEvidence` / `items[].inputBlocked` 与顶层 `inputEvidence` 中给出执行前的 job 级源证据摘要。
- **已完成项证据规则保持不变**：已 `succeeded` 的导入沿用其登记快照与逐张 `sourceTrace`，不因源文件后来变化重跑。
- 崩溃恢复协议：

| 崩溃点 | 恢复行为 |
|---|---|
| `import` 已 commit、checkpoint 未落 | 同 batchId / 同内容再次导入 → 上游幂等回放（不新增账套 / 凭证）→ 核验 `sourceTrace` → 补 checkpoint（attempt +1） |
| `post` / `depreciation` / `carryforward` / `close` 事务中 | 事务回滚（会计效果与 checkpoint 一起撤销）→ 重新执行一次 |
| 产物已发布、checkpoint 未落 | 校验 `artifact_key + snapshotHash + 文件 bytesHash` 一致 → 补记 succeeded，**不重新渲染** |
| 产物记录为 `publishing` 但文件残缺 | 标 `invalid`，只重做该报表 |

- 每次 `resume` 都重新核验已成功阶段的上游证据：凭证被反过账 / 改金额 / 删除、来源状态回退、
  计提 runs 变化、封账被重开、报表业务证据变化 → `needs_review`（`evidence_changed`），停止盲续。
  期末检查重新执行真实 `A.periodEndCheck`：若只剩「更晚期间已由本任务合法封账」的 `later_period_closed`
  且目标期间仍 `closed`，视为合法后续效果；其它回退 → `period_check_regressed`。
  核验的账套作用域取「阶段证据记录的账套，否则 item 已落库的账套」；两者都没有才视为无法核验（不放行）。
  因此省略 `accountSetId` 的任务一旦把绑定推断出的账套落库，重启后的核验与原执行使用同一账套，
  不会因 `null` 重算摘要而假报 `report_evidence_changed`（真变化仍会报）。
- `retry` 只重开选定的失败 / 需复核 / 已取消未完成阶段；`succeeded` / `not_applicable` 永不重跑。

## 8. 报表快照、并发与发布

- 五类报表：资产负债表、利润表、现金流量表、科目余额表、明细账（`ledger` 按科目编码）。
- 主线程在**一个只读事务**内用现有 `buildReportExport` 生成 DTO / CSV，并计算：
  - `dtoHash`（DTO 规范 JSON 哈希）；
  - `businessHash`（该账套该期间报表**实际依赖**的全部入账数据摘要，见下）；
  - `snapshotHash = H(dtoHash, businessHash, format, code)`。
  事务立即释放，之后不再有数据库写事务。
- `businessHash` 的边界按报表真实读取范围（`report-export.mjs`）：账套登记（名称 / 启用期间 / 会计准则）、
  科目定义、**全部**期初余额、该账套自启用期间起到该期末的**全部已过账凭证与分录指纹**（含以前期间、跨年、
  本年累计；现金流量表还要逐月回看）、以及该期末及以前期间的期间状态。
  因此以前期间被反过账 / 改金额 / 删除、期初或科目定义变化、期间被重开都会让旧报表证据失效（`needs_review`）；
  本期之后的数据不在依赖范围内，不进入摘要（不会因后续月份开工就误报失效）。
- 报表快照异常（例如期间未登记 `period_not_registered`、明细账科目不存在 `account_not_found`、绑定不符）
  只把**该 item** 的报表阶段标成 `failed` / `needs_review` 并写错误码与证据，其它企业继续执行；
  不再让整个 job 以参数 / 基础设施错误退出（`exit 2`）。
- worker 线程（`local-batch-report-worker.mjs`）只消费 DTO，调用已审 LOCAL-05 纯渲染函数；
  **不 import db.mjs / accounting / report-export / buildOfficeExport**，不重算金额。
- `concurrency` 是真实 worker 线程数（1..8）。SQLite 写串行、渲染并发。同一时刻最多 `concurrency` 个渲染任务被认领。
- 每个产物记录：`worker_thread_id`、`render_started` / `render_finished`（各线程以 epoch 为基准，可跨线程比较）、
  `bytesHash`、大小、MIME、受控相对路径、attempt、发布状态。
- 发布：先写 `outputDir/.local-batch-tmp/` 内本任务临时文件 → 校验 hash → **不覆盖**地发布到
  `outputDir/<jobKey>/<itemKey>/<period>/<kind>[-code]-<period>.<ext>`。
  已存在的同名文件只有在内容 hash 完全一致（上次已发布成功、仅 checkpoint 未落）时才按恢复处理；
  否则 `output_conflict`，绝不覆盖用户既有文件。目录段由白名单字符 + 原文指纹构成，企业名 / 任意相对段不会被拼成可穿越路径。

## 9. 取消与失败

- `cancel` 只登记 `cancel_requested`；**不伪报** `cancelled`：
  - 执行者仍存活 → 当前阶段结束后停止后续阶段，未开始阶段由其确认成 `cancelled`；
  - 无执行者 / 已确认死亡 → `cancel` 命令自己确认未开始阶段为 `cancelled`。
- 已提交的会计动作（导入、过账、计提、结转、封账）**不倒撤**；已发布产物与已成功阶段证据保留。
- 取消在渲染阶段同样生效：未认领的渲染任务直接标 `cancelled`，已发布的产物保留并仍对应 `succeeded` 阶段。
- 失败只停在当前 item；`retry --item/--period/--stage` 精确重开。

## 10. 测试与验收

在 `06-workbench` 目录：

```bash
node test/local-batch-cli.test.mjs          # 10 组：CLI 契约 / 20 家企业两月真实七阶段 / 年末跨年 / 并发证据
node test/local-batch-persistence.test.mjs  # 31 组：失败隔离 / 前序失败停住 / 一企一套绑定（含省略 accountSetId 的
                                            #        推断账套落库与重启核验）/ 崩溃恢复（含 close 前后）/ 互斥与 fence /
                                            #        失效证据 / 输入快照选择 / 报表依赖证据 / 迁移回滚 /
                                            #        真实期末检查与封账 / 卡片状态 / 独占新建安全
```

B1 实测：`cli` **10 / 10**、`persistence` **31 / 31**，均 exit 0。20 企业主任务实际 **840 个 stage**
（全部 succeeded，含 40 个真实 period-check + 40 个真实 close）与 **600 个报表产物**；
不是旧 480 / 300 数字。历史 9 + 25 是旧基线事实，不被覆盖。

两份测试全部使用**真实 CLI 子进程 + 真实 SQLite + 真实领域接口 + 真实 XLSX/PDF 渲染**，
合成临时库位于系统临时目录（不访问真实账套 / 凭据 / 税局）；`mock` 只用于故障注入（子进程 `SIGKILL` /
受控同步点），不替代主验收。

定向回归（本包不修改这些文件，只证明未受影响）：`accounting-period-integrity` 45、`accounting-period-http`、
`report-office-export` 21、`report-export` 21、`import-incremental` 49，均 exit 0。

## 11. 明确限制

1. **B1 只覆盖真实七阶段**：`period-check` / `close` 已按已合入的 LOCAL-02 真实执行并通过 20 企业两月验收；
   这不等于 LOCAL-07 整包完成。**现库组件安装 / 备份支持 / 共享手工入口互斥（W3）与
   `createBackup → verifyBackup → restoreNew` / 实例分叉 / 旧锁路径 / 报表重建（W4）仍未做**。
2. **既有库不迁移**：哪怕空业务核心库或零字节文件也 `migration_requires_backup`；未做真实一致备份 /
   `restoreNew` / 恢复后新进程续跑验收，也没有 `copyFile` 式伪备份。
3. 本 CLI 的互斥只覆盖批量 runner 之间；手工 HTTP / Agent 入口未接线，需管理者另排共享 guard 小窗口。
4. 报表仍然是内部报表：数据完整性「未核实」、不是税局申报模板；PDF 依赖本机中文字体，字节可能随字体 / 元数据变化，
   已完成产物按记录 hash 校验，重新生成视为新 attempt。
5. 未接入税局、未使用真实账套 / 凭据；「20 家企业」是**合成数据**，不代表任何真实客户或税务并发验收。
6. 报表失效判定按「实际依赖」而非「全账套任意变化」：本期之后的数据、与报表无关的资产卡片变动不会触发重算；
   但账套登记 / 科目定义 / 期初 / 期间的任何变化都会让相关期间报表证据失效（审慎优先）。
7. 企业与账套绑定核验依赖 `import_enterprise_account_sets` 这一已合并的上游结构；本 CLI 只读核验，
   不改绑定、不新增绑定接口。
8. 只读探测的重试**没有全局截止**（每连接 `busy_timeout = 5000`、最多 4 次、额外睡眠合计 300ms）：被外部
   `BEGIN EXCLUSIVE` 长期持锁时实测可长达约 30 秒才 fail-closed。产品未要求 < 1 秒，本包不新增 deadline；
   共享库初始化锁冲突同样未在本包边界内处理。历史两次 22 / 23 完整失败原始输出缺失、原因未定位，
   本轮绿色结果不得用于覆盖。
