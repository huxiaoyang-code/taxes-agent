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

## 2. 精确文件权限（本包 11 个文件；独审返修 1 把 `db.mjs` 与新增 guard 纳入边界）

| 文件 | 作用 |
|---|---|
| `06-workbench/server/db.mjs` | 仅在 import 时、任何核心 DDL / WAL / 迁移写之前调用一次库身份初始化钩子；普通业务入口行为不变 |
| `06-workbench/server/database-open-guard.mjs` | 独占创建事实（私有 `WeakMap`）/ 空库种子 + 页 1 nonce（只用创建 fd 写入；nonce 是本地随机识别标记，不是秘密凭据）/ 连接归属校验 / 失败清理（身份未知就保留现场） |
| `06-workbench/server/local-batch-storage.mjs` | manifest 校验 / 表结构 / component 版本 / 锁与 fencing / 快照 / 状态汇总 / 取消重试（不 import `db.mjs`） |
| `06-workbench/server/local-batch-runner.mjs` | 计划展开、逐账套编排、worker 池、受控发布、恢复与证据核验 |
| `06-workbench/server/local-batch-actions.mjs` | 固定 7 类本地操作的真实领域适配（不复制金额 / 结账规则） |
| `06-workbench/server/local-batch-report-worker.mjs` | worker 线程：只把已冻结 DTO 渲染成 XLSX / PDF（无数据库副作用） |
| `06-workbench/scripts/local-batch.mjs` | CLI：`help/start/status/resume/cancel/retry`；启动期短连接 + 原生锁错误归一 |
| `06-workbench/test/local-batch-persistence.test.mjs` | 失败隔离 / 前序失败门禁 / 一企一套绑定（含推断账套落库）/ 输入快照选择 / 报表依赖证据 / 崩溃恢复 / 互斥 fence / 迁移回滚 / 独占新建与折旧证据重检 |
| `06-workbench/test/local-batch-cli.test.mjs` | CLI 契约 / 20 家企业两月真实动作链 / 五类报表 / 并发证据 / 代表性 PDF 文本与渲染 |
| `docs/LOCAL-BATCH-CLI.md` | 可执行契约（CLI、manifest、状态机、锁、恢复、并发、限制） |
| `docs/tasks/LOCAL-07-CLI.md` | 本任务单 |
| `docs/handoffs/LOCAL-07-CLI.md` | 版本化交接 |

**不修改**任何既有 accounting / import-storage / import-incremental / report-export /
report-office-export / server 入口 / Agent / MCP / test-all / package / 锁 / public / 共享状态索引文件，
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
| B 20 家真实动作链 | 同上 B1（20 家 × 2 月 = **840 阶段**，含 40 真实 period-check + 40 真实 close；**600 产物**；CSV/XLSX 按独立手算表核对，PDF 此组仅结构 / 页数；PDF 文本金额及视觉仅两家两月五类代表抽样，非 600 份逐份人工验算）、B2（create + 次月 append + 幂等 / 异内容拒绝）、B3（年末结转跨年 + 下一年期初 / 累计） |
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
| L 独审 P1：折旧 no_action / 已计提证据与 resume 重检 | `local-batch-persistence.test.mjs` K1（卡片事实 + 全部 runs + 关联凭证 / 分录
指纹；跨进程 resume 不重做；反过账 → `draft_pending` → needs_review 且不补提；修复路径；后续合法计提后历史仍可核验）、
K2（增删卡 / 未来卡变 due / run 金额被改 / 凭证分录被改 → needs_review，零补提） |
| M 独审 P1：独占新建写目标绑定真实对象 + 回执不可变 | 同上 H4 / H5（创建 fd 写页 1 nonce；外部零字节 / 外部旧库 /
同路径同 `dev/ino` 就地改写 / 页面删除均零写入拒绝；回执改字段 / 复制 / 伪造 / 删字段不能改向；释放时保留外部对象）、
H6（失败清理只认不可变事实：`fstat` 真实 `EIO` 后外部零字节 / 合成旧库 / 被替换的标记均原样保留；
自有零字节库与自有标记仍正常释放；`open` 失败分支同样区分自有 / 外部标记） |
| N 报表验收缺口：代表性三格式 / PDF 文本金额 / 中文分页渲染 | `local-batch-cli.test.mjs` B4（企业1 五类两月 + 企业2 代表；
pdfplumber 逐页文本金额；**现金流量表 XLSX 独立读取工作表数值**并按手算本期 / 累计经营净额、现金期初 / 期末核对，
不只与 PDF 互证；CSV 同口径；多页中文页码 / 续页；pdftoppm 渲染 **10 张唯一页** PNG + 非白像素断言；
本次 `mkdtemp` 唯一目录 + `OWNER.json` / `manifest.json` / `README.txt` + 60 份代表性原件，不删任何已有目录） |
| O 管理复验返修 3（跨路径 / 标记归属，本轮） | `local-batch-persistence.test.mjs` H7（活动创建事实下打开另一个库 / junction 别名 /
多 claim 匹配与不匹配 / 全部释放后普通入口）、H8（同 nonce 字节相同与同 nonce 加字段的替换对象在 open / release
下均不误删，自有标记仍释放）；H6 新增同 nonce 替换用例（按 fd 注入） |

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

B1 实测：`cli` **11 / 11**、`persistence` **35 / 35**（新增 H6），均 exit 0；定向 `smoke` 28 / 28、
`accounting-period-integrity` 45 / 45、`report-office-export` 21 / 21、`import-incremental` 49 / 49，均 exit 0
（`db.mjs` 初始化钩子影响面）。本包代表性 PDF 验收需 `REPORT_OFFICE_PYTHON`（已核中文 Python：pdfplumber + Pillow）
与 PATH 上的已核 Poppler `pdftoppm`；未设置时 B4 显式失败，不静默降级。实际结果、独立审查真实复现与修复、
员工自测与管理者复验的区别见 [交接](../handoffs/LOCAL-07-CLI.md)。合并前须由未参与实现的独立 reviewer 审查；
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
7. 20 家两月实际 **840 stage / 600 产物**，CSV/XLSX 按独立手算表核对；PDF 全量只核结构 / 页数，文本金额及视觉仅两家两月五类代表抽样，不是 600 份逐份人工验算；
8. 完整两套测试 **11 / 11 + 34 / 34**（独审返修后；本轮 B1 管理复核收尾为 **11 / 35**，见 §6.6），
   受影响依赖定向回归全部 exit 0。

未完成（不伪造、不写成本包完成）：

- W3：现库组件安装 / 备份支持（`createBackup → verifyBackup` 接线）与手工 HTTP / Agent 共享入口互斥；
- W4：真实 `createBackup → verifyBackup → restoreNew`、实例分叉、旧锁 / 路径与报表重建；
- 共享 `test-all` / docs 索引接线；提交 / PR / 合并。

历史两次 22 / 23 完整失败原始输出缺失、原因未定位；本轮绿色结果不得用于覆盖。
只读探测无全局 deadline 与约 30 秒的那一次真实观察继续保留，不承诺固定总时长。

### 6.5 独审返修 1 续接（本轮，三个 P1 + 报表验收缺口）

已在 B1 基础上完成（未回退旧修复，未删旧断言）：

1. **P1 独占新建写目标绑定真实对象**：`claimFreshDataDir` 保留 `O_EXCL` 创建 fd，`database-open-guard.mjs` 用**创建 fd**
   把经真实 SQLite 验证的空库种子写入页 1（`application_id = LB07` + 随机 `user_version` nonce），不再先按路径
   重新打开连接再写；`db.mjs` 初始化钩子在**任何核心 DDL / WAL / 迁移写之前**用同一条已打开连接读 nonce，
   并复核连接路径 / 连接 schema 对象数 / 创建 fd `fstat` 身份 / 文件路径身份。新增真实负例 H5：外部零字节文件、
   外部非空旧库、同路径同 `dev/ino` 就地改写为外部库、目标被删——全部在零写入情况下拒绝，且外部字节 / schema 不变。
2. **P1 回执不可变**：回执改为空对象 token，创建事实（路径 / 身份 / nonce / fd）只在 guard 私有 `WeakMap`；
   改字段 / 嵌套改值 / 复制 / 伪造 / 删字段都不能改向；失败清理只删本进程标记与仍为种子的对象，保留被替换文件。
3. **P1 折旧 no_action / 已计提证据与 resume 重检**：证据覆盖卡片集合与当期适用性事实、动作前后状态、该期间
   **全部** runs + 关联凭证状态 / 分录指纹；resume 逐卡重算 `assetCardPeriodStatus` 并重查全部 runs / 凭证。
   未来卡变 due、凭证反过账 `draft_pending`、已过账计提 `posted_stale`、增删卡、金额 / 分录被改均 `needs_review`
   且零补提；正常 no_action 跳进程 resume 不重做；后续期间合法计提后历史期间仍可核验。
4. **报表验收缺口**：新增 CLI B4，用真实中文 Python 提取代表性 PDF 文本金额（企业1 五类两月 + 企业2），
   与 CSV/XLSX 对应值交叉核对；多页中文页码 / 续页标记；Poppler 渲染代表性页面并断言非白像素，PNG 保留在
   工作区 `.agent-runs/local-07-b1-review1-renders/` 供人工抽查（本轮 B1 复核收尾起改为每次 `mkdtemp`
   新建唯一目录，见 §6.6；旧目录原样保留）；B1 名称与描述不再把 PDF 结构检查说成金额验算。

仍未完成（不伪造）：W3 / W4 / 共享手工入口互斥 / 共享 `test-all` 接线 / 提交与 PR；新建库身份绑定的
残余边界（`user_version` 长存 nonce、Windows 下 SQLite 不共享 delete 使直接文件 ABA 不可构造）已写入契约 §11，
**不把它说成彻底排除所有平台上的 ABA**。

### 6.6 B1 管理复核收尾（本轮，四处针对性修复）

前一会话已完成候选实现与自测（cli 11 / 11、persistence 34 / 34），但**尚未**管理 freeze / 独审。本轮只修
管理指出的四处实际缺陷，不重做已完成逻辑，不删旧断言，不新增页数：

1. **初始化异常清理不得删除身份未知 / 已替换对象**（`local-batch-storage.mjs`）：`O_EXCL` 创建后 `fstat` 失败时
   不再按「普通文件 + 零字节」删除库文件（那仍不是所有权证明，外部零字节 replacement 会被误删），也不再无条件
   `unlink` 标记；改为保留现场并返回 `fresh_claim_cleanup_required`（`details.status = manual_review_required`）。
   库文件删除必须同时满足「创建 fd 的 `fstat` 身份 == 路径对象 `dev`/`ino`」+ 非符号链接 + 仍零字节；
   标记删除必须「内容仍是本进程 nonce」。新增 H6，用**真实子进程 + Node 内置模块故障注入**
   （`fstat` 抛 `EIO`、`open` 抛 `EEXIST` / `EACCES`、登记时 `fstat` 身份被篡改）复现：外部零字节 / 合成旧库 /
   被替换的标记字节与存在性不变；同时验证自有零字节库与自有标记仍被正常释放。`db.mjs` 在 guard 抛错时
   关闭刚打开的 SQLite 连接（前一会话已加，本轮保留未改）。
2. **测试产物唯一归属**（`local-batch-cli.test.mjs`）：`resetRenderOut` 删除固定目录的做法已移除；B4 改为
   `mkdtemp` 本次唯一目录 + `OWNER.json` 所有权清单，祖先链先核实无符号链接 / junction，**不删除**任何已有目录 / 旧 run，
   成功也不自动清理。manifest 只登记本次实际请求的页（`uniqueRenders = 10`、条数断言 = 唯一 PNG 数 = 10），
   并把 60 份代表性 PDF / CSV / XLSX 复制进同一目录 `artifacts/`。此前已核的
   `.agent-runs/local-07-b1-review1-renders/` 10 张 PNG 未动（本轮实际运行前后逐文件 SHA256 一致）。
3. **现金流 XLSX 独立预期**：B4 现在直接读现金流量表 XLSX 实际工作表值，按独立手算的本期 / 累计
   经营活动净额、现金期初（期间初 / 年初）/ 现金期末核对；CSV 同口径；不再只与 PDF 互相相等。
4. **准确说明**：guard 头注释与契约不再说 nonce「从不写磁盘 / 不外泄 / 32 位不可伪造」——已改为 31 位
   本地随机识别标记（标记 JSON、页 1 `user_version`、`describeFreshClaim`、测试诊断均可看到），
   真正授权来自私有 `WeakMap` + 创建 fd + 实际连接 / 路径核验。

本轮实际自测（员工自测，**不等于**管理者复验或最终独审）：`cli` **11 / 11**、`persistence` **35 / 35**、
`smoke` 28、`import-incremental` 49、`accounting-period-integrity` 45、`report-office-export` 21，全部 exit 0。
候选输出的 10 张唯一 PNG 已被管理者做过视觉抽查（中文 / 分页 / 数字显示未发现裁切）；**最终独审 / 复验仍未完成**，
本任务单不预报 PR、head 或合并。

### 6.7 B1 管理复验返修 3（本轮，必修 A / B / C）

管理复验在真实子进程里复现了两个仍存在的缺陷（只读证据：`local07-crosspath-probe-eaa0e2fee1c442bba72660d6956ed16a/RESULT.json`
= `not-rejected`，旧 run 原样保留），本轮定向修复：

1. **必修 A：跨路径仍可在 guard 之前写另一个库**。`assertOpenedDatabaseClaimsMatch` 原来按 `ACTIVE_BY_DB_PATH`
   查目标路径，查不到就返回 `claimed:false`（当成普通入口），于是「claim A 后把 `WORKBENCH_DATA_DIR` 指向另建的
   既有库 B」会让 `db.mjs` 给 B 建 `account_sets` 等核心表。现在：**只要本进程还持有活动创建事实**，核心首次
   打开的目标不对应其创建事实时一律在**任何 DDL / WAL / 迁移写之前**以 `fresh_claim_target_mismatch`
   （退出码 3）拒绝；别名 / junction、多个活动 claim 下的第三路径同样拒绝，目标匹配时仍做真实连接核验，
   **没有任何活动创建事实时普通业务入口行为不变**。新增 H7 用真实核心 import 子进程覆盖：合成既有库 B 的
   SHA / 表 / 行 / `user_version` / `application_id` / `journal_mode` 与目录内容全部不变、不产生 `-wal`/`-shm`；
   junction 目标同样拒绝且 B 不变；多 claim 匹配目标仍通过、不匹配仍拒绝且零 schema 对象；释放全部回执后
   再打开 B 照常建结构（旧行为）。
2. **必修 B：标记清理不能只凭公开 nonce 认定归属**。nonce 不是秘密（标记 JSON / 页 1 / `describeFreshClaim` /
   诊断输出都有），所以「内容命中 nonce」不能当删除依据。现在所有权标记在 `O_EXCL` 创建时就用**创建 fd 的
   `fstat`** 抓 `dev`/`ino`，连同「本进程写下的期望内容」一起只存在 guard 私有 facts；打开校验 / release /
   未登记失败清理都只比对这份身份 + 期望内容（并用 realpath / 非符号链接确认路径对象），**删除时不重新认领
   当前路径对象**。身份取不到就保留现场。H6 的故障注入改为**按 fd 定位**（存储层现在也会 fstat 标记句柄），
   并新增同 nonce 的两种替换（字节完全相同的新对象、同 nonce + 外部追加字段）在 `open` 失败 / guard 登记
   失败路径的用例；新增 H8 覆盖 `assertFreshReceipt` 失败与 `release` 不误删、以及自有标记 / 空库仍正常释放、
   token 任意赋值（含 marker 字段）不改变内部 facts。H6 原有 fstat `EIO` 外部零字节 / 旧库不删除不改写断言全部保留。
3. **必修 C：收尾**。契约 `docs/LOCAL-BATCH-CLI.md` 第 370 行行尾空格已修（`git diff --check` 无输出，exit 0）；
   三份文档记录本轮定向测试与员工自测结果，**不声称**管理复验 / 最终独审通过。

本轮员工自测（**不等于**管理者复验 / 最终独审）：`persistence` **37 / 37**（新增 H7 / H8）、`cli` **11 / 11**，
均 exit 0；受影响的正向入口定向回归 `smoke` 28 / 28、`import-incremental` 49 / 49、
`accounting-period-integrity` 45 / 45、`report-office-export` 21 / 21，均 exit 0。
B4 本次唯一渲染目录 `.agent-runs/local-07-b1-review3-renders-D4WYev/`（10 张唯一 PNG + 60 份原件），
旧 `.agent-runs/local-07-b1-review1-renders/` 与 `local-07-b1-review2-renders-XBqMOI/` **未动、未删**。
仍未完成（不伪造）：W3 现库组件安装 / 备份支持与共享手工入口互斥、W4 `createBackup → verifyBackup →
restoreNew` 与实例分叉，以及提交 / PR / 合并；**不能写整包完成**。

### 6.8 B1 返修 5（2026-10-23，同月新增卡片）

历史 tokenhub / pi 执行记录保留其原时点。本次用户已授权当前火山 `ark.cn-beijing.volces.com`
处理必要源码 / 任务 / 合成错误；实际 pi GLM 任务返回周额度 429 且无修改。按用户新增授权由 root
派单一兜底实现 subagent 完成本子包；未再调用 pi / Claude 或启动其他实现者，独立审查仍另行安排。

真实回归先复现：A600/12 已计提 50 后，同月新增 B1200/12，旧 actions 把全期 runs 当作本次新凭证，
导致 `depreciation_run_inconsistent`。现按前后新增 runs 与本次 due 卡集合核本次 B100 凭证；保留两张卡、
全部 runs 与旧凭证的证据，并逐原凭证核账套 / 期间 / 类型 / 过账状态 / 累折科目 / 借贷金额和科目存在性，旧 runs 不得被改写。
K3 覆盖真实新进程不重复、旧分录 / 金额 / 期间 / 账套 / 类型 / 反过账异常与失败原子性，
恢复时篡改旧凭证账套 / 类型亦拒绝。旧 K1/K2 与三个 P1 回归保留。

追加 K4 前的实施者自测：`persistence` **38 / 38**、`cli` **11 / 11**、`accounting-period-integrity` **45 / 45**、
`smoke` **28 / 28**、`import-incremental` **49 / 49**，均真实 exit 0；不等于独立审查 / 管理验收。
CLI 实产 840 阶段 / 600 产物，PDF 文本及视觉仅两家两月五类代表抽样（10 张 PNG / 60 份原件），
本次实施者未逐份人工查看 600 产物。详细日志与受限环境失败记录见交接 §3.9。
未改已审 guard/db、storage、runner、test-all 或共享文档；未重跑会清共享 QA 的 Office 套件。
W3 / W4 与最终 PR / 合并仍未交付，不预报审查或合并结论。

管理检查后追加 K4 实证：已计提 A 的费用科目从 5602 合法维护为 5601 后，真实核心同月新增 B100 成功，
而首版严格重建历史费用科目的 batch 误拒。现新凭证仍按当前费用科目严格核验，旧凭证保留历史分录，
未来费用科目维护也不使已完成历史 resume 失效；捕获后改旧凭证费用科目仍按完整指纹拒绝。
旧 run 未存历史费用科目，首次接管无法证明该代码的原始历史，只能核金额、累折贷方与科目存在性，
此边界见实现契约。追加后最终完整 `persistence` **39 / 39**、`cli` **11 / 11**，均实际 exit 0，
日志见交接 §3.9；45 / 28 / 49 为此前自测时点，未无依据重跑。

## 7. 完成口径

- B1 已完成「LOCAL-02 真实七阶段接入」的验收范围：20 家两月真实 check / close / 报表全部成功；
  但**不称 LOCAL-07 整包完成**。
- 现库组件安装 / 备份支持 / 共享手工入口互斥（W3）与 `createBackup → verifyBackup → restoreNew` /
  实例分叉 / 旧锁路径 / 报表重建（W4）仍未完成，不能把 B1 成功写成整包完成。
- 最终整体验收需在 W3 / W4 完成后重跑旧结构迁移、恢复后新进程续跑，再由独立审查通过后合并。
