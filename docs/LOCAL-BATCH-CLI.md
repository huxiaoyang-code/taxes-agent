> **2026-10-23 W3a 当前候选（尚未 root 验收 / fresh 独审 / PR / 合并）**：基线为 PR75 merge `4223ccb3ad2c1b71178f2a510ed1f196ff963f03`。严格 batch1/2 官方备份、batch2 实例与绑定、显式保护安装、readiness 门已实施并完成必要合成定点。下方旧 B1 的「现库安装未接线」仅保留历史；本候选不开放恢复分叉 / 重绑或共享全写锁。LOCAL06/07、Windows W2 和最终整链仍未完成，原八包仍 6/8，税局真实接入 0。

> **2026-10-23 当前交付事实（覆盖下方旧状态，历史验收数字仍按原时点阅读）**：B1 已随 [PR #65](https://github.com/huxiaoyang-code/youshu-fork/pull/65) 合并，已审最终源 head `37bcb286041f76d85c01ff5f6078727497570425`，main merge `97384868ca1cb7a3f07bf561fedac666c7674eb3`，管理者核对合并树与已审树一致。前一源码候选 `214a0c1e` 与 `37bcb286` 的整个 `06-workbench` 树相同；后者只收窄两份文档的归一化金额 / 指纹边界，且获独立审查接受。独立验证 CLI **11/11**、persistence **39/39** 加 **5 组 probe**；root 管理验证 persistence **39/39**。这些是 PR65 候选的既有证据，本次文档轮没有重跑。
>
> **只完成 B1，LOCAL-07 整包未完成**：现库组件安装、共享手工 / 批量互斥（W3），真实备份恢复后的实例分叉、输入 / 输出重绑与核验（W4）仍待实施。[Issue #51](https://github.com/huxiaoyang-code/youshu-fork/issues/51) 继续跟踪；不关闭总任务。已合测试的统一入口登记现纳入 LOCAL-08 候选（原59追加2形成61），最终全入口验证待 root。

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
  证据存 `local_batch_stages.evidence_json`；计提阶段的证据必须覆盖：
  - `cards`：动作完成后的卡片集合及**与当期适用性相关的事实**（取得期间、起提期间、账簿状态、寿命、原值、残值率、
    期初累计、三大科目、期间序号、可计提额、累计 / 剩余、状态、应提 / 已记金额），另存 `preAction`（动作前状态）；
  - `runs`：该账套**该期间全部**计提记录（含本次之前已存在、以及 no_action 时已有的已过账 runs），
    每条带 `voucherId` / `voucherStatus` / 关联凭证分录指纹 `entriesHash`；
  - `voucher`：本次生成凭证的证据（无生成时为 `null`）、`dueCards`、`skipped`、`reason`（如
    `already_posted_this_period` / `no_asset_cards` / `no_card_due_this_period`）。
  旧实现只记录「本次新生成的 runs」，no_action 时恒为空、resume 会错误通过；现已改为上述全量证据。
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
  再调用 `claimFreshDataDir`：以 `O_EXCL` 原子创建所有权标记和库文件本身。创建事实（目录 / 库路径 /
  标记路径 / 创建句柄 `fd` / `fstat(fd)` 的 `dev`+`ino` / 随机 nonce）**只保存在 `database-open-guard.mjs`
  的模块私有 `WeakMap`**；对外回执是一个**空对象**，调用方改字段 / 嵌套改值 / 复制 / 伪造 / 删字段都不能
  改变授权目标（安装、校验、release 全部只信内部不可变记录）。
- **nonce 的准确定位**：31 位随机正整数，是**本地随机识别标记**，不是秘密、也不是认证凭据——它同时出现在
  所有权标记 JSON、页 1 的 `user_version` 与 `describeFreshClaim` 返回值中，测试诊断也会输出。它证明的是
  「这条连接里读到的是本进程 claim 时写下、未被覆盖的值」；真正授权来自私有 `WeakMap` 的创建事实 +
  创建 fd 身份 + 实际连接 / 路径核验。不承诺「不可伪造」或「32 / 64 位强度」。
- **库文件创建即写页 1 种子，而且只经创建 fd 写入**：claim 阶段把一份经真实 SQLite 验证过的空库种子
  （4096 字节、1 页、无任何 schema 对象）写入文件名偏移 0，并把本进程随机 nonce 写进页 1 头部的
  `user_version`、把 `LB07` 魔数写进 `application_id`。写入目标是 `O_EXCL` 时得到的 fd 所绑定的文件对象，
  **不经路径重新打开**，因此「claim 之后把 `workbench.db` 换成外部旧库 / 零字节文件 / ABA 换走再换回」
  都不能让这段写入落到外部对象上（外部文件永远不会被写）。写完后用**只读** SQLite 连接校验种子
  （`application_id` / `user_version` / `page_count` / `sqlite_master=0`），失败即 `fresh_claim_stamp_failed`。
- `db.mjs` 的初始化钩子（`assertOpenedDatabaseClaimsMatch`）在**任何核心 DDL / `journal_mode = WAL` /
  迁移写之前**执行：用**同一条已打开的连接**读页 1 的 `application_id` + `user_version`，并要求
  `PRAGMA database_list` / `db.location()` 指向目标、连接里还没有任何 schema 对象、创建 fd 的 `fstat`
  身份未变、路径身份（realpath / 非符号链接）未变。**nonce 是决定性证据**：`PRAGMA database_list` 只返回
  路径字符串，单独用会被「路径相同、文件已换」骗过。
- **跨路径也必须拒绝（本轮返修）**：只要本进程**还持有活动创建事实**，核心首次打开的目标就必须对应
  其中一次创建事实（按规范化绝对路径匹配），否则在任何写之前以 `fresh_claim_target_mismatch`（退出码 3）
  拒绝。按路径查表**未命中不得退化成普通入口**——否则「claim A 之后把 `WORKBENCH_DATA_DIR` 指向另一个
  既有库 B」就会在 guard 之前给 B 建 `account_sets` 等核心表（管理复验已真实复现的 `not-rejected`）。
  别名 / junction 路径、多个活动创建事实下的第三路径同样拒绝；目标与某次创建事实对应时仍走 `claimed` 路径
  （继续做连接核验）；**没有任何活动创建事实**时普通业务入口行为与旧实现完全一致（`claimed:false`）。
  由测试 H7 用真实核心 import 子进程覆盖：合成既有库 B 的 SHA / 表 / 行 / `user_version` / `application_id` /
  `journal_mode` 与目录内容全部不变，不产生 `-wal` / `-shm`；释放全部回执后再打开 B 照常建结构（旧行为）。
- `ensureBatchSchema` 必须收到本进程回执，建表前后都校验标记归属 + 连接页 1 nonce + 创建 fd 身份；
  **布尔 fresh / 伪造回执无效**。错误码：`fresh_database_replaced` / `fresh_database_foreign_content` /
  `fresh_database_mismatch` / `fresh_database_alias` / `fresh_receipt_invalid` / `fresh_receipt_stale` /
  `fresh_claim_stamp_failed` / `fresh_claim_target_mismatch` 等，均为退出码 3（需人工核对现场，且不做
  「先污染后拒绝」）。
- **所有权标记的归属只认创建时的不可变身份（本轮返修）**：标记也用 `O_EXCL` 创建句柄的 `fstat` 抓
  `dev`/`ino`，与「本进程写下的期望内容」一起只保存在私有 facts。nonce 不是秘密（标记 JSON / 页 1 /
  `describeFreshClaim` / 诊断都有它），因此**内容命中 nonce 不能当归属证据**：同一个 nonce 的新文件对象
  （哪怕字节完全相同）、加了额外字段的外部标记都保留，绝不在删除时按路径重新认领当前对象；身份取不到时
  保存现场。由测试 H8 覆盖 open 校验 / release / guard 登记失败三条路径。
- 并发两个进程抢同一新目标：最多一个取得创建资格；另一个稳定 `fresh_target_claimed`（退出码 3），
  只有能确认完整已初始化结构时才按已有库路径继续，不帮忙修半库。
- 失败清理只删除「本进程创建、身份未变、除页 1 种子外没有任何结构」的对象与「文件对象仍是创建时
  `dev`/`ino` 且内容仍是本进程写下的那份」的标记；被替换对象 / 外部零字节文件 / 已有核心表一律**保留现场**。
  重复 release 是无副作用 no-op。
- **失败清理不拿猜测当所有权**（本轮返修）：
  - 库文件 `/ 标记文件` 的删除各有独立前提：库文件必须「本次创建 fd 的 `fstat` 身份 == 路径上对象的
    `dev`/`ino`、非符号链接、仍零字节」；标记必须「本次创建 fd 的 `fstat` 身份 == 路径上对象的 `dev`/`ino`、
    非符号链接、realpath 一致、内容等于本进程写下的期望内容」。任一条不成立就保留原对象。
  - `O_EXCL` 创建后 `fstat` 失败（例如真实 `EIO`）时**没有任何身份证明**：即使路径上只是零字节普通文件
    也不删，标记也不删，返回 `fresh_claim_cleanup_required`（`details.status = manual_review_required`，
    退出码 3），提示人工核对现场；不以「本进程曾在该路径创建成功」作为删除依据。
  - 标记被换成别的内容 / 同 nonce 的新文件对象时（库文件打开失败 / guard 登记失败 / 释放）一律保留这个
    外部标记，同时仍会释放「已证明属于自己的零字节库文件与自己的标记」，不因收紧而遗留自有垃圾。
  - 以上由测试 H6（故障注入 `fstat` 抛 `EIO`、打开抛 `EEXIST` / `EACCES`、篡改登记身份、同字节 / 同 nonce
    加字段的标记替换，故障只落在指定 fd 上）与 H8（open / release 路径）真实覆盖，外部替换对象字节 /
    存在性不变。
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
- 计提阶段的重检**不是**只遍历已记录的 runs：重算该账套当前卡片集合与每张卡在该期间的
  `assetCardPeriodStatus`（期间口径，后续期间的合法计提不会污染历史期间），逐项对比证据里的卡片事实；
  并重查该期间**全部** runs 与关联凭证状态 / 分录指纹。证据变化的具体原因写入
  `evidence.verificationFailure`（`depreciation_cards_changed` / `depreciation_card_became_due` /
  `depreciation_card_draft_pending` / `depreciation_card_posted_stale` / `depreciation_card_changed` /
  `depreciation_runs_added` / `depreciation_run_removed` / `depreciation_amount_changed` /
  `depreciation_run_voucher_modified` / `depreciation_voucher_unposted` 等）。
  同月已计提卡片之外合法新增卡片时，只按动作前后新增的 runs 子集核对本次凭证和应提卡集合；
  全量 runs / 卡片仍写入恢复证据。每个旧 run 的原凭证分别核对账套、期间、计提类型、过账状态、
  对应累折科目 / 借贷金额及科目存在性，且旧 run 指纹在动作前后必须不变。任一不一致整体回滚，不以新增子集
  取代旧记录检查。例如 A600/12 已计提 50 后新增 B1200/12，本次只生成 B100，保留 A 原凭证；
  新进程 resume 重检两张凭证，不重复计提。
  核心允许在已计提后合法维护仅影响未来的 `expense_account`：新凭证严格使用当前卡费用科目，
  旧凭证不能强套这个未来值。旧 run 没有历史费用科目字段，首次接管只能证明原凭证借方金额 / 科目存在性、
  贷方累折科目与 run 一致，不能证明其借方代码就是最初入账时的代码；合法历史修改与首次捕获前的
  同金额合法科目替换无法单凭现有数据区分。捕获后保存的原凭证指纹按规范化财务事实与已纳入指纹的字段严格核验，
  改旧凭证费用科目也会使恢复拒绝；单改卡片未来费用科目不会使已完成历史阶段失效。
  金额沿用既有合同，按 `ROUND_HALF_UP` 归一到分；例如 `50 → 50.001` 的规范化金额相同，
  不保证检测被归一化消除的分以下原始金额差异，也不保证检测任意物理字段或 SQLite 字节变化。
  未来卡改成当期 `due`、已计提凭证被反过账成 `draft_pending`、增删卡、金额跨分变化或已纳入指纹的分录字段改变，都会转
  `needs_review`；账套归属、期间、凭证类型与摘要等已有核验继续有效。**复核不补提、不改凭证、不把 no_action 当成成功绕过**。
  期末检查重新执行真实 `A.periodEndCheck`：若只剩「更晚期间已由本任务合法封账」的 `later_period_closed`
  且目标期间仍 `closed`，视为合法后续效果；其它回退 → `period_check_regressed`。
  核验的账套作用域取「阶段证据记录的账套，否则 item 已落库的账套」；两者都没有才视为无法核验（不放行）。
  因此省略 `accountSetId` 的任务一旦把绑定推断出的账套落库，重启后的核验与原执行使用同一账套，
  不会因 `null` 重算摘要而假报 `report_evidence_changed`（真变化仍会报）。
- `retry` 只重开选定的失败 / 需复核 / 已取消未完成阶段；`succeeded` / `not_applicable` 永不重跑。
## 8. 报表快照、并发与发布

- 五类报表：资产负债表、利润表、现金流量表、科目余额表、明细账（`ledger` 按科目编码）。
- 报表验收口径（不得重复表述）：
  - **20 家 × 两月 = 600 个产物**的材料全部生成；CSV / XLSX 金额逐家按独立手算表核对（不是抽样）；
    PDF 在该组里只核结构（头 / `%%EOF` / 页对象 / 页面数）。
  - **代表性三格式与 PDF 文本层**：企业 1 五类报表 × 两月 + 另一个不同金额企业（企业 2）代表；
    用真实中文 Python（`REPORT_OFFICE_PYTHON`：pdfplumber）提取 PDF 逐页文本，按行核对手算金额
    （资产负债表期初 / 期末、利润表本期 / 累计、现金流本期 / 累计与期末余额、余额表 1002 行与 8 列合计、
    明细账期初 / 发生 / 累计 / 期末），并与同组 CSV / XLSX 实际单元格值交叉核对。
    **现金流量表的 XLSX 是独立预期**：直接读实际工作表的「经营活动产生的现金流量净额 / 现金期初余额 /
    现金期末余额」×「本期 / 本年累计」六个数，与手算的本期经营净额、累计经营净额、期间初 / 年初现金、
    期末现金比较（不是「与 PDF 相等」互证）；CSV 的 `经营活动净额 / 现金期初余额 / 现金期末余额`
    同样按独立手算值断言。
  - **中文分页渲染**：多页 PDF 逐页断言中文页码（`第 N 页 / 共 M 页`）与续页标记（`（续）`）；用已核 Poppler
    `pdftoppm` 把代表性页面渲染成 PNG（含非白像素比断言），manifest 只登记**本次实际请求的页**
    （条数 = 唯一 PNG 数 = 10，同一目录先后渲染第 1 页与末页也不重复记账），另有 60 份代表性
    PDF / CSV / XLSX 原件（2 企业 × 2 月 × 5 类 × 3 格式，仅本次合成数据）复制到同一目录 `artifacts/`。
    输出目录每次运行由 `mkdtemp` 新建唯一目录（`.agent-runs/local-07-b1-review2-renders-<随机>`，
    内含 `OWNER.json` / `manifest.json` / `README.txt`），**不删除**任何已有目录或旧 run；
    此前已核的 `.agent-runs/local-07-b1-review1-renders/` 10 张 PNG 原样保留。
  - 这些是**代表性抽样**证据，**不是**「600 份 PDF 逐份人工验算」；也不把 LOCAL-05 的 11 项几何测试当作本包
    600 份报告的金额验收。
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
node test/local-batch-cli.test.mjs          # 11 组：CLI 契约 / 20 家企业两月真实七阶段 / 年末跨年 / 并发证据 /
                                            #        代表性三格式 + PDF 文本金额 + 中文分页渲染
node test/local-batch-persistence.test.mjs  # 37 组：失败隔离 / 前序失败停住 / 一企一套绑定（含省略 accountSetId 的
                                            #        推断账套落库与重启核验）/ 崩溃恢复（含 close 前后）/ 互斥与 fence /
                                            #        失效证据 / 输入快照选择 / 报表依赖证据 / 迁移回滚 /
                                            #        真实期末检查与封账 / 卡片状态 / 独占新建安全 /
                                            #        写目标绑定真实对象 / 新建失败清理（含故障注入）/
                                            #        跨路径与别名拒绝（H7）/ 标记只认创建时身份（H8）/
                                            #        折旧证据完整与 resume 真实重检
```

B1 实测：`cli` **11 / 11**、`persistence` **35 / 35**（新增 H6），均 exit 0；此后本轮返修（跨路径 H7 +
标记身份 H8）的定向重跑为 **37 / 37**（员工自测，不等于管理者复验 / 最终独审）。20 企业主任务实际 **840 个 stage**
（全部 succeeded，含 40 个真实 period-check + 40 个真实 close）与 **600 个报表产物**；
不是旧 480 / 300 数字。历史 9 + 25 是旧基线事实，不被覆盖。

代表性 PDF 验收需要：`REPORT_OFFICE_PYTHON` 指向已核实的中文 Python（pdfplumber + Pillow），
且 PATH 上有已核 Poppler `pdftoppm`；**未设置时该组显式失败**（不静默略过），以免把「结构检查」冒充成
「PDF 文本金额 / 渲染验收」。

两份测试全部使用**真实 CLI 子进程 + 真实 SQLite + 真实领域接口 + 真实 XLSX/PDF 渲染**，
合成临时库位于系统临时目录（不访问真实账套 / 凭据 / 税局）；`mock` 只用于故障注入（子进程 `SIGKILL` /
受控同步点），不替代主验收。

定向回归（本包不修改这些文件，只证明未受影响）：`smoke` 28、`accounting-period-integrity` 45、
`report-office-export` 21、`import-incremental` 49，均 exit 0（`db.mjs` 初始化钩子影响面）。

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
9. **新建库身份绑定的边界（如实记录）**：写入页 1 种子只用创建 fd，不按路径重开，因此外部文件不会被写；
   nonce 是 31 位**本地识别标记**而非秘密：它会以 `user_version` 长期留在本次创建的库里，也出现在所有权标记
   JSON、`describeFreshClaim` 与测试诊断中（产品其它逻辑不读 `user_version`；LOCAL-06 备份只把它当待比对字段）。
   `new DatabaseSync` 在「目标文件被完全删除」时自身可能补出一个 0 字节文件，
   钩子会在任何 DDL / WAL 之前拒绝且不写入它，但该 0 字节文件会保留现场（不当作本进程对象删除）。
   本机 Windows 上 SQLite 打开文件不共享 delete，因此「连接已打开在外部对象上、随后把路径换回本进程对象」
   的直接文件 ABA 在本机**不可构造**；实际可达的同类负例（换成外部零字节 / 外部旧库 / **同路径同 `dev/ino`
   但内容被改写成外部库**）均已真实验证由 nonce 拒绝（见测试 H5），且外部内容字节 / schema 不变。
   失败清理的身份未知分支（`fstat` 抛错）保留现场并要求人工核对，见 §6。标记的归属同样不靠 nonce：见 §6
   「所有权标记的归属只认创建时的不可变身份」，同 nonce 字节相同的替换对象也是外部对象（测试 H8）。
10. **报表验收口径**：见 §8。600 份产物的 PDF 只做结构 / 页数检查，PDF 文本金额与渲染是代表性抽样，
   不等同于 600 份逐份人工验算；PDF 字节依赖本机中文字体与元数据，重新生成视为新 attempt。

## W3a：batch2 存储与显式安装合同

在 `06-workbench` 执行 `node scripts/local-batch.mjs install --data-dir <已有数据目录> --out-dir <全新备份目录>`。此命令直接打开指定连接，await `installBatchSchema(db,{dbPath,outDir})`；安装前不 import 会迁移核心库的 db/runner。缺库、零字节与非产品库拒绝；outDir 必须本次全新，不能复用旧备份。start/resume 要求严格 batch2，v1 明确提示 install，零迁移写；v1 status/inspect/官方 backup 严格只读。

`ensureBatchSchema` 仍同步：只校验已安装2，或持 guard 私有 fresh 回执一次原子新装2。原八表列、ID、字节和自增序列保留；只新增 database_instances、job_bindings、input_bindings 三张 local_batch_ 表及唯一 active partial 索引。batch UUID 独立持久；无 audit 时关联为 NULL，有 audit 时当前 active 映射必须一致，两边父链均严格核验。audit 后装只在受保护事务中填当前 batch active 的 NULL，不改历史 NULL/非NULL或 UUID。

保护安装拒绝 caller BEGIN/SAVEPOINT且保留 caller 事务；校验 main/显式路径/全部祖先和普通单硬链接文件身份，持 BEGIN IMMEDIATE 写预约后再次严格核结构及维护事实，官方 create→verify→快照 bytes/hash/manifest 绑定→真实 held-source 核验后才 DDL/实例/绑定/版本→自检→COMMIT。活 PID、不确定 PID、running owner 无可核 PID 均拒绝；确认死亡仅允许迁移，原锁、阶段、fence 不推进。未知提交 / 回滚隔离连接，不假报确定回滚。

createJob 在既有事务内同时写全部新 job/input 绑定；当前实例必须覆盖全部现有 job/input，历史实例无需补后来的任务。storage create/cancel/retry、CLI 写入口与 runner 入口先核 ready/完整且可用绑定，早于读源、创建输出目录或清 cancel 标志。restore_pending、disabled 及尚未支持的 saved_snapshot 写路径均拒绝，绝不回退历史路径。输入保存字节、manifest canonical JSON 与 DTO 原 JSON.stringify 摘要分别按原合同校验，合法货币小数保留；只读 validator 不访问源/输出外部文件。report 首次计划 hash 精确核验，已成功 attempt 绑定该次 evidence.snapshotHash；可变最新 DTO 不否定重试中断窗中的历史 attempt，业务/产物新鲜度仍由原 runner 验证。

本片只证明 storage/gate 和备份忠实。restoreNew 仍复制实例/owner/路径；不代表副本可安全 resume。后续依次 W2b 业务 coordinator、W3b 共享全写锁/真实20企业/检查点、W4 receipt/分叉/重绑，再做 Windows/最终整链。

### W3a 失败释放的保全取舍

实际新UUID/同inode反例证实：受控子进程WAL提交合成12.39后退出，旧release为判断空库打开SQLite会改变SHM字节。经root接受，本片仅在storage调用已审guard的固定 `{preserveDatabase:true}`，guard源码未改、不加可传清理开关；仍释放自己的marker/创建fd，但保留所有DB/WAL/SHM字节，连本次空种子也保留供诊断。**失败后不能承诺自动清空或同路径可直接fresh重试**，未提供删除命令。

新增真实child提交后actual close回归实际exit0：主库 `26d7467744a8a62c1beb99a28d0512306cdcde8e3836abbb793aee35325d56c7`、WAL `1a8f8c6828e24e30df0b9fb1e20ca9e9b14779bdfa2a7cd350a4fbd1cf227f29`、SHM `3939df1ca6d98b45659196f8a122481d2321f3f866efac2864b32f86285218d2` 前后完全相同，inode/dev不变，自己marker释放、二次release幂等。原H4/H8保留替换/外部对象断言，只更新受此取舍影响的空种子行为。
