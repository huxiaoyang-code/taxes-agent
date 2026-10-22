# LOCAL-07 持久批量任务与 CLI（任务单）

- Issue：[#51](https://github.com/huxiaoyang-code/youshu-fork/issues/51)（`Refs #20 / #13 / #14`；不关闭总体 Issue）
- 负责人（人类）：`huxiaoyang-code`；执行：本机 pi 实施员工（主 / 唯一回退 `tokenhub/deepseek-v4.1-flash`）
- 独立 worktree：本机 worktree `<LOCAL07_WORKTREE>`（由管理者建立与登记，不入 Git）
- 分支：`codex/huxiaoyang-code/local-07-cli`
- 开工基线：`257f96275031eefa484699dd71bd012e2d221e51`；B1 实际基线：root 已实际合并 LOCAL-02 PR #60
  （actual main `dfefae0553052474b8a9308105443714bc5d9cfb`），管理者合入本分支 `f7ae456f`，保留已审 batch head `11f1877f`。
- 交付文档：[实现契约](../LOCAL-BATCH-CLI.md) · [交接](../handoffs/LOCAL-07-CLI.md)

## 1. 目标

交付可直接运行的本机**持久批量 CLI**：多企业每企一个账套，真实批量导入、过账、计提 / 摊销、结转、
期末检查、结账与内部报表；逐家状态、重启恢复、受控重试 / 取消、同账套批量互斥、20 家合成真实动作链
与可验证报表渲染并发。**不能只交通用队列、接口、mock executor 或模拟成功**。

产品仍是本机单用户：一家企业一个账套，多企业批量 = 多账套批量；不做 SaaS / 多租户 / 账户平台；
本包不做税局、官方申报文件或新增网页平台。

## 2. 精确文件权限（本包只有这 10 个文件）

| 文件 | 作用 |
|---|---|
| `06-workbench/server/local-batch-storage.mjs` | manifest 校验 / 表结构 / component 版本 / 锁与 fencing / 快照 / 状态汇总 / 取消重试（不 import `db.mjs`） |
| `06-workbench/server/local-batch-runner.mjs` | 计划展开、逐账套编排、worker 池、受控发布、恢复与证据核验 |
| `06-workbench/server/local-batch-actions.mjs` | 固定 7 类本地操作的真实领域适配（不复制金额 / 结账规则） |
| `06-workbench/server/local-batch-report-worker.mjs` | worker 线程：只把已冻结 DTO 渲染成 XLSX / PDF（无数据库副作用） |
| `06-workbench/scripts/local-batch.mjs` | CLI：`help/start/status/resume/cancel/retry`；启动期短连接 + 原生锁错误归一 |
| `06-workbench/test/local-batch-persistence.test.mjs` | 失败隔离 / 前序失败门禁 / 一企一套绑定（含推断账套落库）/ 输入快照选择 / 报表依赖证据 / 崩溃恢复 / 互斥 fence / 迁移回滚 |
| `06-workbench/test/local-batch-cli.test.mjs` | CLI 契约 / 20 家企业两月真实动作链 / 五类报表 / 并发证据 |
| `docs/LOCAL-BATCH-CLI.md` | 可执行契约（CLI、manifest、状态机、锁、恢复、并发、限制） |
| `docs/tasks/LOCAL-07-CLI.md` | 本任务单 |
| `docs/handoffs/LOCAL-07-CLI.md` | 版本化交接 |

**不修改**任何既有 accounting / db / import-storage / import-incremental / report-export /
report-office-export / server / Agent / MCP / test-all / package / 锁 / public / 共享状态索引文件，
也不改 LOCAL-02 / 05 / 06 的其他文件。

## 3. 依赖与前置

| 依赖 | 本包要求 | 当前实际 |
|---|---|---|
| LOCAL-01 增量导入（已合并） | 稳定 batchId / source / 内容指纹 / 一企一账套 / 跨批去重 | 已合并；本轮只读取其企业↔账套绑定做核验，未改其代码 |
| LOCAL-05a 纯渲染（已合并） | `buildReportDocument/buildReportXlsx/buildReportPdf` 导入无 DB 副作用 | 已合并；worker 只消费冻结 DTO |
| LOCAL-02 金额 / 期末完整性 | `A.periodEndCheck` 的 `{ ready, steps, blocking }` 与 `A.setPeriodStatus` 用于 `period-check` / `close` | **已实际合入 main（PR #60）**；B1 已按真实 DTO / 入口适配，20 家两月真实成功 |
| LOCAL-06 备份恢复 | `createBackup` / `verifyBackup` / `restoreNew` 用于既有库新增 / 升级 component 结构 | 模块已合；**现库安装 / restore-new 未接线**：既有库拒绝 `migration_requires_backup`，只允许显式新目标初始化 |
| 共享互斥 guard | 批量与手工 HTTP / Agent 入口强互斥 | **未接线**：本包只保证批量 runner 间按账套互斥，本轮未改 `server.mjs` / 未扩锁 |

若依赖最终版本接口名或返回结构不同，管理者登记具体接口缺口后由续接会话对齐，**不得复制上游算法或私扩锁**。

## 4. 验收映射（A–H）

| 条目 | 覆盖位置 |
|---|---|
| A 模块 / CLI 无默认 DB 副作用 | `local-batch-cli.test.mjs` A1–A5：help / 非法命令 / status 缺库 / 无 `WORKBENCH_DATA_DIR` 时拒绝 import / status 只读哈希不变 |
| B 20 家真实动作链 | 同上 B1（20 家 × 2 月 = **840 阶段**，含 40 真实 period-check + 40 真实 close；**600 产物**；独立手算表核对两月 CSV+XLSX+PDF）、B2（create + 次月 append + 幂等 / 异内容拒绝）、B3（年末结转跨年 + 下一年期初 / 累计） |
| C 并发证据 | 同上 C1（跨企业渲染区间相交、peak ≤ concurrency、threadId 不同）、C2（`concurrency=1` 串行对照） |
| D 单家失败隔离 + 去重 | `local-batch-persistence.test.mjs` D1 |
| E 崩溃真实新进程恢复 | 同上 E1（import commit 后）、E2（计提事务中）、E3（结转事务中）、E4（产物发布后）、E5（close 未提交回滚）、E6（close 已提交后中断） |
| F 两 CLI 竞争与 fence | 同上 F1–F7（同 jobKey、同账套、过期租约存活 owner、死 owner 接管、旧 token/attempt、两种取消边界） |
| G 输入 / 证据失效 | 同上 G1（原文件改 / 缺 / 快照 hash 改；普通 resume 与 retry 都拒绝）、G2（反过账 / 删除）、G3（完成文件丢失只重生成报表） |
| H 迁移 / 备份 / 恢复 | 同上 H1（既有库拒绝自动建表）、H2（迁移中断回滚 + 布尔 fresh / 伪造回执无效）、H3（LOCAL-06 依赖如实标注、零字节 / junction 拒绝）、H4（独占新建回执 / 并发 / 探测后替换） |
| I 独立审查 5 个 P1 回归（本轮新增） | 同上 I1–I5（详见下方列表） |
| 独审新增 P2（推断账套持久化）回归 | 同上 I6–I7：省略可选 `accountSetId` 时绑定推断出的账套必须**真实落库**并贯穿后续阶段 / 产物证据 /
新进程 `resume` 核验（不只改内存快照）；仅 post / 无 import 仅报表 / 含 import 三种形态均不误报失效；错绑定仍零写入且不覆盖已声明账套 |
| K B1 真实核心接入 | 同上 J1（真实 check/close + 单家缺折旧阻断 + 补齐后 retry/resume）、J2（陈旧 check 被核心重新拒绝）、
J3（取得期间未到 / 未入账 / 0 分分期 / 已提足 / 已计提）、B3（年末跨年） |

I 组具体覆盖（新增，不替代 / 不削弱 A–H）：

- I1 前序阶段 `failed` / `needs_review` 不得被越过；同一次执行内产生的 `needs_review` 同样停住；显式 retry 修复路径保留；
- I2 一企一套绑定核验覆盖无 import / 报表 / 恢复核验，失败零写入，其它企业继续；
- I3 报表快照 / 参数异常只影响该 item 阶段状态，不再使整 job `exit 2`；
- I4 报表证据覆盖以前期间 / 跨年依赖，真实重算 hash 与旧产物不同；
- I5 源 payload 金额 100→200：普通 resume 拒绝，显式快照才写旧内容并留痕。

J 组（独审新增 P2，最小修复；不撤销「`accountSetId` 可选」契约）：

- I6 企业已绑定、manifest 省略 `accountSetId`、仅请求报表 → `start` 成功且 `local_batch_items.account_set_id`
  与产物证据 `accountSetId` 都是真实绑定账套；停机后新进程普通 `resume` 仍 `succeeded`（`verified.ok=true`），
  不得 `report_evidence_changed`，产物文件 hash 与凭证数不变；
- I7 同一推断规则覆盖「仅 post（无 import）」「仅报表（无 import）」「含 import + 报表」，且错绑定
  （企业已绑定 A，manifest 声明 B）仍 `enterprise_binding_mismatch` / 零业务写入 / 不把账套改成推断值。

真实动作只调用既有领域：`importIncremental`（已含 `BEGIN IMMEDIATE`）、`postVoucher`、`generateDepreciation`、
`carryForwardProfit`、`setPeriodStatus`，报表复用 `buildReportExport` + LOCAL-05 渲染。

## 5. 明确非目标

- 不接税局、不生成官方申报文件、不新增网页 / HTTP 平台；
- 不做多租户 / 账户体系 / 一企多账簿（`bookKey`）；
- 不把批量 runner 的互斥宣传成「全产品互斥」；
- 不实现 LOCAL-02 / LOCAL-06 的算法或备份工具，也不复制其草稿代码。

## 6. 验收命令

```bash
cd 06-workbench
node test/local-batch-cli.test.mjs
node test/local-batch-persistence.test.mjs
# 受影响依赖只读回归（不改这些文件）
node test/accounting-period-integrity.test.mjs && node test/accounting-period-http.test.mjs
node test/report-office-export.test.mjs && node test/report-export.test.mjs
node test/import-incremental.test.mjs
```

B1 实测：`cli` **10 / 10**、`persistence` **31 / 31**，均 exit 0；定向 `accounting-period-integrity` 45 / 45、
`accounting-period-http`、`report-office-export` 21 / 21、`report-export` 21 / 21、`import-incremental` 49 / 49，均 exit 0。
实际结果、独立审查真实复现与修复见 [交接](../handoffs/LOCAL-07-CLI.md)。合并前须由未参与实现的独立 Codex reviewer 审查；
本任务单不预报审查结论、head 或 merge。

## 6.1 本轮（独立审查阻塞修复）已完成 / 未完成

已完成（真实复现 → 修复 → 两套 CLI + persistence 实跑；详见交接 §3）：

1. 前序阶段失败 / 需复核不得被越过（含同一执行内产生的 `needs_review`），显式 retry 修复路径保留；
2. 一企一套：任何动作（含无 import / 报表 / 验证恢复）前统一核对企业↔账套绑定，失败零业务写入、其它企业继续；
3. 首次执行与普通续跑都核验源证据，显式 `--use-saved-inputs` 才用快照并留痕原因；
4. 报表证据覆盖全部实际依赖（以前期间 / 期初 / 累计 / 科目与期间状态，含跨年），并含全部 5 类报表；
5. 报表快照 / 参数 / 发布异常降为 item 级阶段状态与失败隔离，不再让整 job 以 `exit 2` 中止；崩溃 / 取消 / fence 语义不变。

未完成（历史项；其中 LOCAL-02 已在 B1 关闭）：LOCAL-02 依赖下的真实 `period-check` / `close` **已由 B1 完成**；
仍剩 LOCAL-06 的既有库迁移 / `createBackup → verifyBackup → restoreNew` 后新进程续跑（归 W3 / W4）；
共享互斥 guard 接线；提交 / PR / 合并。

### 6.2 本轮（独审新增 P2 最小修复）

已关闭的 5 个 P1 修复保留不变（未回退、未放宽断言）。新增 P2：企业已绑定账套、manifest 省略可选
`accountSetId`、仅请求报表时，`resolveItemBinding` 虽在锁作用域推断成功，但账套 ID 没有落库 ——
`start` 退出码 0 / `succeeded`，而 `local_batch_items.account_set_id` 与产物证据 `accountSetId` 仍为 `null`；
数据与文件完全未变的紧接普通 `resume` 却 `exit 1` / `needs_review` / `report_evidence_changed`（用 `null` 重算摘要）。

已完成：绑定核验通过后立即把解析出的账套写进 `local_batch_items`（`account_set_source = enterprise_binding`），
后续阶段作用域 / 产物证据 / 恢复核验统一用这个持久值；恢复核验的账套作用域改为「证据记录的账套，否则已落库的账套」，
不再用 `null` 重算业务摘要；错绑定 / 缺绑定仍、在任何写入之前抛错（零写）。已转 `needs_review` 的旧任务仍需显式 `retry`，
不自动改回成功。未完成同上（LOCAL-06 / W3 / W4 / 共享 guard / 提交与 PR）；LOCAL-02 真实 check/close 已由 B1 关闭。

### 6.3 并发 `start` 瞬时锁（附带修复；**不是**历史 22 / 23 的已证明根因）

历史事实：P1 阶段出现过**两次** 22 / 23 完整失败，但当时**只保留输出尾部、原始完整输出缺失**，因此
**原因至今仍未定位**。本轮的新探针只**独立观察到**两类瞬时 SQLite 锁竞争现象：只读探测误报
`database_unreadable`（`database is locked`），以及共享 `server/db.mjs` 初始化建表在另一执行者持写锁时抛原生
`ERR_SQLITE_ERROR`（栈 `db.mjs:14`）。这两类现象**不能**当作已证明的历史根因，也**不**绝对排除 PID 存活 /
SIGKILL 时序、账务逻辑或断言层面的原因；后续需**另行复现并分别处理**这两类故障，不得用多轮绿覆盖未知历史故障。
新探针的 60 / 150 轮结果**只指该探针自身的观察**。

已修（仅本包文件）：只读探测对瞬时锁有限重试，预算如实为「每连接 `busy_timeout = 5000` 毫秒、最多 4 次尝试、
重试间额外睡眠合计 300ms」，**没有 < 1 秒或其它全局总时长截止**，仍失败才 fail-closed；`start` / `resume` 在加载
编排层前用本包连接预热并保持到批量结构确认完成，原生锁错误归一为 `database_busy`（退出码 3）。
**未改共享 `db.mjs`**（不在本包边界）：处理共享库初始化锁冲突需管理者另排共享文件窗口。
独审真实观察（不推断）：用自己的 DELETE-journal 库以 `BEGIN EXCLUSIVE` 持锁，另一子进程单次 `inspectDataDir`
实测 29812ms（wall 29867ms），最终 `readable=false` / `database is locked`；该次观测**不**推成每环境固定 30 秒
或总 20 秒。产品未要求 < 1 秒，本轮**未**新增 deadline、**未**改行为。

### 6.4 本轮 B1（已审会计核心接入）已完成 / 未完成

已完成（真实临时库 + 真实 CLI + 20 家合成企业一企一本）：

1. `period-check` 按真实 `{ ready, steps, blocking }` 判定，`close` 真实调用 `setPeriodStatus` 并由核心重新拒绝
   陈旧前置；两月在 20 家全部真实成功（40 check + 40 close）；
2. 折旧逐卡复用 `assetCardPeriodStatus`，覆盖取得期间未到 / 未入账 / 0 分分期 / 已提足 / 已计提；
3. 年末结转与下一年的期初 / 累计独立核对；
4. 单家缺折旧阻断、补齐后 retry/resume 只做未完成部分；check 成功后新增草稿 → close 由核心拒绝；
5. close 事务中 / 已提交后进程中断的恢复；
6. 独占新建回执：零字节既有库、非空目录、别名 / junction、并发占用、探测后替换、伪 fresh / 伪回执全部不能建立结构；
7. 20 家两月实际 **840 stage / 600 产物**，CSV/XLSX/PDF 金额来自独立手算表；
8. 完整两套测试 **10 / 10 + 31 / 31**，受影响依赖定向回归全部 exit 0。

未完成（不伪造、不写成本包完成）：

- W3：现库组件安装 / 备份支持（`createBackup → verifyBackup` 接线）与手工 HTTP / Agent 共享入口互斥；
- W4：真实 `createBackup → verifyBackup → restoreNew`、实例分叉、旧锁 / 路径与报表重建；
- 共享 `test-all` / docs 索引接线；提交 / PR / 合并。

历史两次 22 / 23 完整失败原始输出缺失、原因未定位；本轮绿色结果不得用于覆盖。
只读探测无全局 deadline 与约 30 秒的那一次真实观察继续保留，不承诺固定总时长。

## 7. 完成口径

- B1 已完成「LOCAL-02 真实七阶段接入」的验收范围：20 家两月真实 check / close / 报表全部成功；
  但**不称 LOCAL-07 整包完成**。
- 现库组件安装 / 备份支持 / 共享手工入口互斥（W3）与 `createBackup → verifyBackup → restoreNew` /
  实例分叉 / 旧锁路径 / 报表重建（W4）仍未完成，不能把 B1 成功写成整包完成。
- 最终整体验收需在 W3 / W4 完成后重跑旧结构迁移、恢复后新进程续跑，再由独立审查通过后合并。
