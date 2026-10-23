> **当前 W2b：29完整65独审接受，main0e新head待增量核证／PR（2026-10-24）**：BASE `0e89a2d107fd75ff18dc0998e89d96c3217baeb3`，[最新精确认领](https://github.com/huxiaoyang-code/youshu-fork/issues/54#issuecomment-6376168302)，原66／总65文件不增。五套上游补验已通过，尚未PR／合并；八任务6/8、税局真实0。当前证据与后续动作见[LOCAL06交接](LOCAL-06-AUDIT.md)。

以下保留R4阶段说明；最新main0e与已接受的29独审状态以页头交接为准。

当前只完成同W2b的R4补修和根影响验收，最终独审尚须重新执行，原81拒绝不能由前轮验收覆盖。batch未新增能力，W3b全入口共享资源锁/持久代次/20企两月19＋1与运行中备份、W4恢复分叉/路径重绑及Windows最终链继续待办。

## 2026-10-24 R4之前基线与W2b交接（历史）

W3a 已合 [PR87](https://github.com/huxiaoyang-code/youshu-fork/pull/87)：已审head `f11e92dfad79e975fbdaa6bab68c41ee44a59b5a`，实际merge `882c5b65564fd7e2281eba4a799b3a7a25c5b5f3`（2026-10-23T16:56:21Z）；root十一影响套及fresh最终完整head接受事实见文末已合记录。本W2b最初以该merge实施，当前已由root整合到页头6465；真实batch两企业200/200、父子审计/来源完成/checkpoint同提交、fence失效零业务效果、child失败原子性、pending旧attempt不绕过的必要定点已自测，仍待新BASE的root冻结验收/独审/PR；旧完整97失败按页头保留。W3b/W4与整包07未完，详见[LOCAL06当前交接](LOCAL-06-AUDIT.md)。下方候选和旧SHA均为历史时点。

## 2026-10-24 W2b batch 接线候选

W3a已合PR87事实见下方。当前W2b在该基线完成可信外层与固定child审计接线，import业务/来源完成/父子终态/checkpoint同提交；报告仅已核metadata短事务，文件异步边界保留。旧stage attempt关联pending须先needs_review，恢复/重绑仍W4；W3b统一全入口锁、真实20企业与完整故障矩阵仍待办。新domain两企业各200、真实import/depreciation/carryforward/period-check/close/CSV与fence失配原子反例为合成必要定点，不冒充20家或恢复续跑。W2b未root最终验收/PR/合并，LOCAL06/07未关闭。

> **2026-10-24 W3a 同轮返工候选**：完整 `605e057794850a19d0f533ce273323b4ae1c7f4d` 复审仍拒一项P2：已claim/成功report缺必需snapshot/artifact反向存在性；原内部种子失败保全P2已由独审实际闭合。现补own tuple存在与归属，保未claim无记录、已claim未发布、旧attempt及最新可变DTO/CSV窗口。实际report-p2两组/92拒绝和两安装夹具定点、失败历史见[LOCAL07交接](LOCAL-07-CLI.md)。尚待root新冻结十一影响套及新完整head独审，未PR/合并；原八包6/8、LOCAL06/07未完、税局真实接入0。

> **2026-10-23 W3a 当前候选（尚未 root 验收 / fresh 独审 / PR / 合并）**：基线为 PR75 merge `4223ccb3ad2c1b71178f2a510ed1f196ff963f03`。严格 batch1/2 官方备份、batch2 实例与绑定、显式保护安装、readiness 门已实施并完成必要合成定点。下方旧 B1 的「现库安装未接线」仅保留历史；本候选不开放恢复分叉 / 重绑或共享全写锁。LOCAL06/07、Windows W2 和最终整链仍未完成，原八包仍 6/8，税局真实接入 0。

> **2026-10-23 当前交付事实（覆盖下方旧状态，历史验收数字仍按原时点阅读）**：B1 已随 [PR #65](https://github.com/huxiaoyang-code/youshu-fork/pull/65) 合并，已审最终源 head `37bcb286041f76d85c01ff5f6078727497570425`，main merge `97384868ca1cb7a3f07bf561fedac666c7674eb3`，管理者核对合并树与已审树一致。前一源码候选 `214a0c1e` 与 `37bcb286` 的整个 `06-workbench` 树相同；后者只收窄两份文档的归一化金额 / 指纹边界，且获独立审查接受。独立验证 CLI **11/11**、persistence **39/39** 加 **5 组 probe**；root 管理验证 persistence **39/39**。这些是 PR65 候选的既有证据，本次文档轮没有重跑。
>
> **只完成 B1，LOCAL-07 整包未完成**：现库组件安装、共享手工 / 批量互斥（W3），真实备份恢复后的实例分叉、输入 / 输出重绑与核验（W4）仍待实施。[Issue #51](https://github.com/huxiaoyang-code/youshu-fork/issues/51) 继续跟踪；不关闭总任务。已合测试的统一入口登记现纳入 LOCAL-08 候选（原59追加2形成61），最终全入口验证待 root。

# LOCAL-07 交接：持久批量任务与 CLI（B1 已审会计核心接入）

- Issue：[#51](https://github.com/huxiaoyang-code/youshu-fork/issues/51)（`Refs #20 / #13 / #14`；不关闭总体 Issue）
- 负责人：`huxiaoyang-code`；本窗口实施：本机 pi 员工（唯一模型 `tokenhub/deepseek-v4.1-flash`，无子 agent、未执行 Git）
- 分支：`codex/huxiaoyang-code/local-07-cli`
- 本窗口事实基线：root 已实际合并 LOCAL-02 [PR #60](https://github.com/huxiaoyang-code/youshu-fork/pull/60)，actual main `dfefae0553052474b8a9308105443714bc5d9cfb`；管理者把该 main 合入本分支为 `f7ae456f02fbc3b2c606357801f3b1a4b2ba942a`（保留了已审 batch head `11f1877ff7256065387c4c696c546654c4d1f629`）。
- 只读冻结参考：batch `11f1877`、core `bd05415fe6de080b41f0dd9f6f56fb1f57d8dae0`、backup `33995009109cb922c86c9a5e9847e95554faaa4b`；组合 `04c38d4` 不是本包实施基线。
- 状态：**B1 实现 + 独审返修 1（三个 P1 + 报表验收缺口）实现与自测完成；未提交 / 未 PR / 未合并**
  （员工不执行 Git）。本轮返修起点为本 worktree HEAD `034404b4`（已合 PR #62 实际 main `f0b41a44`）；
  保留了上一会话的 WIP（`db.mjs` 初始化钩子 + 新增 `database-open-guard.mjs`），但**重写了其未验证的按路径写标记段**。
  最终独审由未参与实现 / 本任务规划者承担。

## 1. 本包精确文件（11，本轮仅新增 `database-open-guard.mjs`；`db.mjs` 本轮新纳入边界）

代码 / 测试（`06-workbench`）：

1. `server/db.mjs` — **本轮新纳入边界**（root 已协调 db 独占给 07）：只在 import 时、**任何核心 DDL / WAL / 导入迁移写之前**调用一次库身份初始化钩子；普通业务入口（无创建事实）行为不变。未加 `busy_timeout`（见 §4）。
2. `server/database-open-guard.mjs` — **本轮新增**：独占创建事实（私有 `WeakMap`）、空库种子 + 页 1 nonce（只用创建 fd 写入）、连接归属校验、标记校验、失败清理。
3. `server/local-batch-storage.mjs` — manifest / 计划 / `local_batch_*` 结构 / 锁与 fence / 输入快照 / 产物 / 状态；独占新建改为持有 guard token（无任何可变授权字段）。
4. `server/local-batch-actions.mjs` — 7 类固定操作的真实领域适配；计提证据与 resume 重检本轮补齐。
5. `server/local-batch-runner.mjs` — 编排 / worker 池 / 受控发布 / 恢复核验；新增核心阻断码转 `needs_review`。
6. `server/local-batch-report-worker.mjs` — 仅 DTO → XLSX / PDF；本窗口未改。
7. `scripts/local-batch.mjs` — CLI；`start` 独占回执，`fresh_*` / `data_dir_*` 归一退出码 3。
8. `test/local-batch-cli.test.mjs` — 11 组（含 B4 代表性三格式 / PDF 文本 + 中文分页渲染）。
9. `test/local-batch-persistence.test.mjs` — 34 组（含 H5 写目标绑定、K1–K2 折旧证据与 resume 重检）。

文档：

10. `docs/LOCAL-BATCH-CLI.md`
11. `docs/tasks/LOCAL-07-CLI.md`
12. `docs/handoffs/LOCAL-07-CLI.md`（本文件）

**未修改** shared `accounting.mjs` / `period-end-controls.mjs` / `money.mjs` / import-* / report-* / HTTP / Agent / MCP / test-all / package / lock / backup 及其测试。核心只读调用，发现缺口交 root 登记 owner，未以「顺手兼容」扩 scope。

## 2. B1 交付能力（真实可用，非 mock）

### 2.1 期末检查 / 封账按真实接口

- `A.periodEndCheck(setId, period)` 的真实返回是
  `{ accountSetId, period, ready, steps, blocking, missing, rules }`。
  B1 适配只读 `ready` / `steps` / `blocking`，**不再读不存在的 `ok` / `status` / `checks`**。
- 判定：`ready === true` 且 `steps` 非空且 `blocking.length === 0` → `succeeded`；否则 `needs_review`，
  证据只保留 `{ step, code }` 与步骤 `{ id, status }`，**不落企业 / 资产自由文本 details**。
- `close` 真实调用 `A.setPeriodStatus(setId, period, 'closed')`：保留「同期间 check 成功」阶段门禁，
  但**不信任旧 check 静态结果**；核心会重新校验草稿 / 试算平衡 / 计提 / 卡片总账 / 损益与年末结转 / 连续期间。
  close 效果 + checkpoint 同一 `BEGIN IMMEDIATE` 事务（核心领域用 SAVEPOINT，不套第二 BEGIN）；
  查库确认 `periods.status='closed'`；故障整段回滚。
- 新增核心阻断码统一转 `needs_review`：`period_end_check_failed` / `period_has_draft_vouchers` /
  `period_unbalanced` / `period_not_found` / `period_before_start` / `depreciation_run_stale` /
  `depreciation_draft_exists` / `depreciation_global_over_depreciable` / `asset_ledger_pending` /
  `carryforward_stale` 等；不制造 ready、不直接 SQL 置 closed、不复制封账算法。
- **恢复核验**：早前期间 `period-check` 在后续期间合法封账后会重查出 `later_period_closed`。B1 只有
  「阻断全部是该合法后续效果且目标期间仍 closed」才继续认成功；其它变化 → `needs_review`
  （`period_check_regressed`）。因此不会因自己完成 close 误判旧 check 失效，也不完全跳过真实核验。
  已失败 check 不能被 resume 越过（仍按前序门禁停住）。

### 2.2 折旧 / 结转按核心领域状态

- 计提**不再**用 `start_period <= period && remaining > EPS` 自算应提；改为逐卡调用已合入的纯规则
  `assetCardPeriodStatus(db, card, period)`：
  `not_existed`（取得期间未到）/ `not_started` / `ledger_pending`（未入账）/ `no_amount_due`（按分取整为 0）/
  `fully_depreciated`（已提足）/ `posted`（已计提）/ `due`（本期应提）/ `posted_stale` 等。
- `generateDepreciation` 无凭证时：只有存在真实 `due` 卡才 `needs_review` +
  `depreciation_due_but_no_action`；其余真实「不适用」如实 `not_applicable`，证据记录每卡状态与应提 / 已提分金额。
- 生成凭证时仍核 runs 与凭证借 / 贷金额一致；核心抛出的 `asset_ledger_pending` / `depreciation_run_stale` /
  `depreciation_global_over_depreciable` / `depreciation_draft_exists` 全部转 `needs_review`，不静默补提。
- **证据完整性（独审 P1 返修）**：`evidence.cards` 记动作**完成后**每张卡的适用性事实（取得 / 起提期间、账簿状态、
  寿命、原值、残值率、期初累计、三大科目、期间序号、可计提 / 累计 / 剩余、状态、应提 / 已记金额），另存 `preAction`；
  `evidence.runs` 记该期间**全部**计提记录（含 no_action 时已有的已过账 runs）及关联凭证状态 / 分录指纹；
  no_action 时 `reason` 区分 `no_asset_cards` / `no_card_due_this_period` / `already_posted_this_period`。
- **resume 重检（独审 P1 返修）**：重算当前卡片集合与逐卡期间口径状态 + 重查全部 runs / 凭证分录，
  变化原因写进 `evidence.verificationFailure`；末来卡变 due、凭证反过账 `draft_pending`、
  `posted_stale`、增删卡、金额 / 分录被改 → `needs_review`，复核**不补提**；正常 no_action 跳进程 resume 不重做；
  后续期间的合法计提不会让历史期间（期间口径）误报失效。
- 结转沿用真实已过账凭证 + 余额证据；`carryforward_stale` / `year_end_carry_expected` 不再只靠异常名字。
- 测试用正式建卡 / 期初 / 凭证入口准备数据，未伪造卡片与总账一致。

### 2.3 独占新建事实（仍**不**开放现库批量组件安装）

- 旧的「`assertInitializable` 返回 fresh 布尔 → `ensureBatchSchema({freshDatabase: init.fresh})`」已移除；
  **布尔值 / 自造回执不再能建立结构**（无回执一律 `migration_requires_backup`）。
- 新流程：只允许「数据目录里根本没有 `workbench.db`」的显式新目标；`claimFreshDataDir` 先校验目录真实身份，
  再以 `O_EXCL` 原子创建 `.local-batch-create` 所有权标记和**库文件本身**，并且**保留库文件的创建 fd**。
  创建事实（目录 / 库路径 / 标记路径 / `fstat(fd)` 的 `dev`+`ino` / 随机 nonce / 创建句柄）只放在
  `database-open-guard.mjs` 的模块私有 `WeakMap`；对外回执是一个**空对象 token**，安装 / 校验 / release
  只信内部不可变记录（改字段 / 嵌套改值 / 复制 / 伪造 / 删字段都不能改向）。
- **页 1 种子只经创建 fd 写入**：把经真实 SQLite 验证过的空库种子（4096 字节、1 页、无 schema 对象）写入偏移 0，
  并把本进程随机 nonce 写进页 1 的 `user_version`、`LB07` 魔数写进 `application_id`。写入目标是 `O_EXCL`
  时得到的对象，**不按路径重开**，所以「claim 后换成外部旧库 / 零字节文件 / ABA 换走再换回」都无法让写入
  落到外部文件上；写完用**只读** SQLite 连接复核种子。
- `db.mjs` 初始化钩子在任何核心 DDL / `journal_mode = WAL` / 迁移写**之前**执行：用同一条已打开连接读
  页 1 nonce / 魔数、要求 `PRAGMA database_list` / `db.location()` 指向目标、连接里还没有 schema 对象、
  创建 fd 的 `fstat` 身份未变、路径 realpath / 非符号链接。**nonce 是决定性证据**，只靠路径会被「路径相同、
  文件已换」骗过。普通业务入口（无创建事实）行为与旧实现一致。
- **跨路径（本轮 review3 必修 A）**：只要本进程仍持有活动创建事实，核心首次打开的目标必须对应其中一次
  创建事实，否则在任何写之前 `fresh_claim_target_mismatch`（退出码 3）拒绝。按路径查表未命中**不得**
  退化成普通入口（那正是「claim A → 打开既有库 B」被建表的入口）；别名 / junction 与多个活动 claim 下
  的第三路径同样拒绝，目标匹配时仍做连接核验；没有任何活动创建事实时旧行为完全不变。
- **所有权标记归属（本轮 review3 必修 B）**：标记也用 `O_EXCL` 创建 fd 的 `fstat` 抓 `dev`/`ino`，与
  「本进程写下的期望内容」一起只存私有 facts；删除 / 打开校验都只比对这份身份 + 期望内容，nonce 相同
  的新文件对象（含字节完全相同）或追加外部字段的标记一律保留，绝不按路径重新认领当前对象。
- `ensureBatchSchema` 必须收到本进程 token；建表前后都校验标记归属 + 连接页 1 nonce + 创建 fd 身份。
  事务失败整体回滚；成功后才释放标记。
- 并发抢同一新目标：`O_EXCL` 保证最多一个拥有创建资格；另一个稳定 `fresh_target_claimed`（退出码 3），
  只有能确认完整已初始化结构时才按已有库路径继续，否则拒绝，不「帮忙修半库」。
- 已有核心库（空业务 / 非空 / **零字节文件** / 缺批量表）继续 `migration_requires_backup`；
  符号链接 / junction 目标稳定 `data_dir_alias`。失败清理只删「身份未变且仍只有页 1 种子」的对象与
  「文件对象仍是创建时 `dev`/`ino` 且内容是本进程写下那份」的标记（本轮 §3.7 起，不再仅凭 nonce）；
  被替换对象 / 外部零字节文件 / 已有结构一律保留现场。
- 已合法安装 batch 的原库继续 `start` / `resume` 正常（不再要求 fresh）。

## 3. 实测结果（本窗口实际执行）

工作目录 `06-workbench`；Node `v24.15.0`；合成临时 SQLite / 临时目录；未连真实账套、凭据或税局。

| 命令 | 结果 | 退出码 |
|---|---|---|
| `node test/local-batch-cli.test.mjs` | **11 / 11** 组通过（A1–A5、B1、B2、B3、B4 代表性三格式 / PDF 文本 + 分页渲染、C1、C2） | 0 |
| `node test/local-batch-persistence.test.mjs` | **35 / 35** 组通过（D1、E1–E6、F1–F7、G1–G3、H1–H6、I1–I7、J1–J3、K1–K2） | 0 |
| `node test/accounting-period-integrity.test.mjs` | 45 / 45 | 0 |
| `node test/accounting-period-http.test.mjs` | 通过（随机回环服务，不碰既有税局后端） | 0 |
| `node test/report-office-export.test.mjs` | 21 / 21（含真实 PDF 几何抽查） | 0 |
| `node test/report-export.test.mjs` | 21 / 21 | 0 |
| `node test/import-incremental.test.mjs` | 49 / 49 | 0 |
| `node test/smoke.test.mjs` | 28 / 28（本轮 B1 收尾新增的 db 影响面回归） | 0 |

本包两套测试的完整 stdout + stderr 已整份保存在本 worktree 的 `.agent-runs/`（Git 忽略，不入 Git）。
历史上的 **9 + 25** 是旧基线事实；B1 新结果是 **10 + 31**，独审返修 1 后为 **11 + 34**，
本轮 B1 管理复核收尾（新增 H6）后为 **11 + 35**，不是删断言保数字。

### 3.1 20 企业 × 连续两月真实七阶段

- 新临时目录由**正式 CLI `start`** 建立批量结构（独占回执；不是预建 core 库 + fresh 布尔豁免）。
- 20 个不同规范 `enterpriseKey`，各自唯一账套；月 1 首次 `create`，月 2 向同一账套 `append`；
  月 1 另有跨批同来源幂等回放，真实核验 `sourceTrace`。
- 每月真实执行 `import → post → depreciation → carryforward → period-check → close → reports`；
  两月都真实 `period-check` / `close` 成功，期间 `closed`。
- 任务计划实际条数：主任务 **840 个 stage** =
  20 企业 × [2 月 × 6 个动作阶段（import / post / depreciation / carryforward / period-check / close）
  + 2 月 × 15 个报表阶段 = 12 + 30]；全部 `succeeded`。
  另有 provisioning 任务的 20 个 import stage（首次 create）。
- 业务事实：每企业 8 张已过账凭证（两月各 2 导入 + 1 计提 + 1 结转）、2 条计提 run、
  3 个 completed 批次（provision create + 月 1 跨批回放 + 月 2 append）。
- 报表产物：每企业每月 15 = 5 类 × 3 格式（CSV / XLSX / PDF），共 **600 个**，
  逐个核对文件存在、字节 hash、MIME、受控相对路径；XLSX 读工作簿值，PDF 核头 / `%%EOF` / 页对象。
- 独立手算表（元，金额按分断言）：
  - 公司 1 完全采用任务样例：期初银行 10000 + 设备 1200 = 资本 11200；设备零残值 12 期、每期 100；
    月 1 收入 2000 / 费用 300 / 折旧 100 → 银行 11700、设备净值 1100、月利润 1600、权益 12800；
    月 2 收入 1500 / 费用 250 / 折旧 100 → 银行 12950、设备净值 1000、月利润 1150、累计 2750、权益 13950。
  - 其余 19 家使用不同银行期初 / 设备原值 / 寿命（6 / 12 / 24 期）/ 收入 / 费用，逐家独立核对；
    未串读同一账套。
  - 核对的报表项：资产总计、负债合计、所有者权益、固定资产净值、累计折旧、资产负债表平衡、
    利润表本期 / 年累计净利润、余额表借贷合计、明细账期末余额、现金流勾稽，CSV 与 XLSX 同金额。
- 同 `jobKey` / 同 manifest 再次 `start`：不新增账套 / 凭证 / run / 产物，stage `attempt` 不变；
  新进程 `resume` 同样不重跑，早前 `period-check` 不被后续 close 误判失效。

### 3.2 年末跨年样例（B3，独立核对）

- 2026-12：收入 12000、费用 2000 → 年利润 10000；`yearEnd=true` 结转后 3103 = 0、3104 = 10000；
  资产负债表未分配利润 10000；利润表本期 / 年累计 10000。
- 2027-01：收入 3000、费用 1000 → 月利润 2000；普通结转后 3103 = 2000、3104 仍 10000；
  2027 年期初未分配利润 10000、期末 12000；利润表本期 / 2027 年累计 2000（按年重置）。
- 两期 `period-check` / `close` 均真实成功；新进程 `resume` 不重跑。

### 3.3 失败隔离、陈旧 check 与 close 崩溃点

- J1：3 家企业中 1 家故意缺计提 → 该家 `period-check` 真实 `needs_review`（blocking 含 depreciation 步），
  close / reports 被前序门禁停住；另 2 家照常 check / close / report 成功。
  按核心顺序反过账旧结转 → 独立任务真实计提 → `resume` 把失效结转标 `needs_review` →
  显式 `retry` 只重开 carryforward / period-check / close / report → `resume` 完成；
  另 2 家 stage `attempt` 与凭证完全不变。
- J2：`period-check` 成功后、`close` 之前用受控 hook 真实新增一张草稿凭证；core `setPeriodStatus` 重新拒绝
  `period_has_draft_vouchers`，close 阶段 `needs_review`，期间保持 open。旧 check 成功不代替核心前置。
- E5：close 事务中 SIGKILL → 期间保持 open（close 效果未提交）；重启后重新封账一次，结转不重复。
- E6：close 已提交后 SIGKILL → 期间 closed、close 阶段与 checkpoint 同事务已 `succeeded`；
  新进程 `resume` 识别已提交合法效果，不重复封账。
- J3 卡片状态适配：取得期间未到 → `not_existed`；未入账 → `asset_ledger_pending`（needs_review）；
  0 分分期 → `no_amount_due`；期初累计已提足 → `fully_depreciated`；已计提 → `posted`；
  后四类不适用状态均不生成凭证。

### 3.4 并发与新建负例

- C1：至少两家企业、不同 worker 线程的 XLSX / PDF 渲染区间真实相交；本窗口实测峰值 **3**（= `concurrency=3`），
  跨企业重叠线程为两个不同线程（本次运行 3 / 1，threadId 随运行变化，不作固定值），区间重叠 = true；
  记录真实 `worker_thread_id` 与可跨线程比较的起止时间。
- C2：`concurrency=1` 对照，渲染区间不重叠、峰值 = **1**。
- 并发口径如实说明：SQLite 业务写事务始终串行；并发只发生在 **XLSX / PDF 报表渲染 worker 线程**，
  不是账务写并发，也不是队列长度或 mock 延时。
- H4 / H5：同进程 / 跨进程第二个新建占用者均 `fresh_target_claimed`；零字节既有库 / 非空目录 /
  探测后库文件被替换 / 伪造回执都不能建立批量结构或改动他人文件；H5 另覆盖「写目标绑定真实对象」的
  外部零字节 / 外部旧库 / 同对象就地改写 / 目标缺失五种负例（详见 §3.5）。

### 3.5 独审返修 1（三个 P1 + 报表验收缺口）实际结果

本节是本轮新增的真实验证（与上方 B1 旧结果分开读；旧断言均保留、未删改）：

- **H5 写目标绑定真实对象（persistence）**：`claimFreshDataDir` 后先经真实 SQLite 确认页 1 种子（4096 字节、
  `application_id=LB07`、`user_version=nonce`、`page_count=1`、`sqlite_master=0`）；然后分别在**子进程**里制造：
  ① 换入外部零字节文件；② 换入真实外部旧库（含 `account_sets` / `vouchers` 与数据）；③ 同路径且同 `dev/ino`
  被就地改写为外部库（路径与身份检查都会通过）；④ 同路径同 `dev/ino` 被就地改写成非 SQLite 文本；
  ⑤ 目标文件被完全删除。五种均真实 `import db.mjs`：①⑤ → `fresh_database_replaced`，② → `fresh_database_replaced`，
  ③④ → `fresh_database_foreign_content`；全部 `opened=false`（没有完成 DDL），外部文件字节 hash / `dev`+`ino` / 表集合 / 行数 / `user_version`
  均不变，无 `-wal` / `-shm`。正常路径（无替换）钩子通过、核心表建立、页 1 nonce 保留；随后无回执的普通入口照常打开。
- **回执不可变（H4 / H5）**：对真 token 改 `identity`（含置 `null` / 嵌套改值）/ `dbPath` / `markerPath` / `dataDir` /
  删字段 / 改 nonce 后，`assertFreshReceipt` 仍按内部事实绑定；`releaseFreshClaim({...token})` / `{}` 均无效；
  真 token 在库已被换成外部零字节文件后 release：只删本进程标记，**外部零字节文件保留**（仍 0 字节），
  重复 release 是 no-op。
- **K1 / K2 折旧证据与 resume 重检（persistence）**：无卡片 → not_applicable；真实建卡后 resume →
  `depreciation_cards_changed`；未来卡（`not_existed`）真实改成当期取得 → `depreciation_card_became_due`；
  删除卡片 → `depreciation_cards_changed`；真实反过账计提凭证 → `depreciation_card_draft_pending`；
  真实 SQL 改 run 金额 → `depreciation_card_posted_stale`；只改凭证分录（run 金额不变，凭证仍平衡）→
  `depreciation_run_voucher_modified`。以上均 `needs_review` + `evidence_changed`，且**凭证 / run 数量不变**
  （不默补提）；已计提 no_action 跨进程 resume 不重做（attempt 不变）；真实重新过账 + retry 后可恢复；
  后续期间合法计提后，历史期间仍 `not_applicable` 并核验通过。
- **B4 报表代表性验收（cli）**：企业1 五类报表 × 两月 + 企业2 代表，共 4 组；用 `REPORT_OFFICE_PYTHON`
  （pdfplumber）提取逐页文本，按行核对手算金额（资产负债期初 / 期末、利润本期 / 累计、现金流本期 / 累计 / 期末余额、
  余额表 1002 行 8 列与合计 8 列、明细账期初 / 发生 / 累计 / 期末），并与同组 CSV / XLSX 值交叉核对；
  多页余额表逐页断言中文页码与续页标记；Poppler `pdftoppm` 渲染 10 张代表性页 PNG（含非白像素比），
  当时保留在本工作区 `.agent-runs/local-07-b1-review1-renders/`（`manifest.json` / `README.txt`）；
  本轮 B1 复核收尾改用每次新建的唯一目录（见 §3.6），旧目录原样保留。

日志（本工作区 `.agent-runs/`，Git 忽略）：最终代码实跑 `local-07-b1-review1-retry-cli-final3.log`（11 / 11，exit 0）
与 `local-07-b1-review1-retry-persist-final3.log`（34 / 34，exit 0）；受影响依赖（最终代码）：
`local-07-b1-review1-retry-final-dep-{smoke,import-incremental,accounting-period-integrity,report-office-export}.log`
（28 / 49 / 45 / 21，全 exit 0；更早的相同套件日志 `...-dep-*.log` 含 `accounting-period-http` / `report-export`）。
员工自测，不等于管理者复验。

### 3.6 B1 管理复核收尾（本轮，四处针对性修复，新会话）

起点 `034404b4`；上一会话实跑完候选后退出，本轮只修管理指出的四处，不重做已完成逻辑、不删旧断言、
不新增页数（PNG 维持 10 条 / 10 unique）。

1. **初始化异常清理不得删除身份未知 / 已替换对象**（`local-batch-storage.mjs`）：
   - `fstat(dbFd)` 失败时不再按「普通文件 + 零字节」删库文件（仍不是所有权证明），也不再无条件删标记；
     实测改为保留现场 + `fresh_claim_cleanup_required`（`details.status = manual_review_required`，退出码 3）。
   - 库文件删除前提收敐为：创建 fd 的 `fstat` 身份 == 路径对象 `dev`/`ino` + 非符号链接 + 仍零字节；
     标记删除前提（当时）：内容仍是本进程 nonce；**本轮 §3.7 已进一步收敐为创建时 `fstat` 身份 +
     本进程写下的期望内容（nonce 相同的新对象也不再删）**。`open` 失败 / guard 登记失败两个分支均改为这个口径。
   - `db.mjs` 在 guard 抛错时关闭刚打开的 SQLite 连接（前一会话已加，本轮保留未重复改）。
2. **测试产物唯一归属**（`local-batch-cli.test.mjs`）：删除固定目录的 `resetRenderOut` 已移除；
   改为 `mkdtemp` 本次唯一目录（`.agent-runs/local-07-b1-review2-renders-<随机>`）+ `OWNER.json`，
   祖先链先核无符号链接 / junction；**不删任何已有目录 / 旧 run**，成功也不自动清理。
   只登记本次实际请求的页（`uniqueRenders = 10` = manifest 条数 = 唯一 PNG 数），
   并把 60 份代表性 PDF / CSV / XLSX 复制到该目录 `artifacts/`。
3. **现金流 XLSX 独立预期**：B4 直接读现金流量表 XLSX 实际工作表值（本期 / 累计经营活动净额、
   现金期初期间初 / 年初、现金期末），与独立手算值核对；CSV 同口径；不只与 PDF 互相相等。
   `cashFlow` checklist 已补 `xlsx: true`。
4. **准确说明**：guard 头注释 / 契约不再声称 nonce「从不写磁盘其它位置 / 不外泄 / 32 位不可伪造」；
   已更正为 31 位本地随机识别标记（标记 JSON / 页 1 `user_version` / `describeFreshClaim` / 测试诊断都能看到），
   真正授权来自私有 `WeakMap` + 创建 fd + 实际连接 / 路径核验。

本轮新增/新增验证（与 §3.5 旧结果分开读，旧断言均保留）：

- **H6（persistence）真实故障注入**（子进程 + 打补丁 `node:fs` + `syncBuiltinESMExports`，在 import 存储层前完成）：
  ① `O_EXCL` 创建后、`fstat` 失败前把路径换成外部零字节文件，`fstat` 真实抛 `EIO` → `fresh_claim_cleanup_required`
  + `manual_review_required`，外部文件仍 0 字节（sha256(空)）、标记保留、无 `-wal`/`-shm`；
  ② 同窗口换成真实合成旧库 → 外部库 sha256 / 表集合 / 行数 / `user_version` 完全不变；
  ③ guard 登记时 `fstat` 身份被篡改 + 标记已被换成外部内容 → 自有零字节库释放、外部标记字节原样保留；
  ④ 同样登记失败但标记仍属自己 → 库文件与标记都被释放（正常清理未被收敐破坏）；
  ⑤ `open` 抛 `EEXIST` / `EACCES` + 标记已被换 → 外部标记保留；⑥ 同样失败但标记仍属自己 → 标记被释放。
- **B4（cli）**：新唯一目录下 10 张唯一页 PNG + 60 份原件；现金流 XLSX / CSV 六个数按手算本期 / 累计经营净额、
  期间初 / 年初现金、期末现金断言；旧 `.agent-runs/local-07-b1-review1-renders/` 运行前后 12 个文件 sha256 一致（未动）。

本轮实跑（员工自测，**不等于**管理者复验 / 最终独审）：`cli` **11 / 11**、`persistence` **35 / 35**（含新 H6），
`smoke` 28 / 28、`import-incremental` 49 / 49、`accounting-period-integrity` 45 / 45、`report-office-export` 21 / 21，全 exit 0。
日志：`local-07-b1-review2-cli-1.log`、`local-07-b1-review2-persist-3.log`（早期 `persist-1/2` 为修故障注入脚本的失败记录，
也保留）、`local-07-b1-review2-dep-{smoke,import-incremental,accounting-period-integrity,report-office-export}.log`。
新建的唯一渲染目录：`.agent-runs/local-07-b1-review2-renders-XBqMOI/`
（`OWNER.json` / `manifest.json` / `README.txt` / 10 张 PNG / `artifacts/` 60 份）。
候选输出已被管理者做过 PNG 视觉抽查（中文 / 分页 / 数字未发现裁切）；**最终独审 / 复验尚未完成**，不预报 PR。

### 3.7 B1 管理复验返修 3（本轮，必修 A / B / C）

起点 `034404b4`；上一会话实际 exit 0 并留下完整报告，但**无人实现**本轮两个必修项，也没覆盖完整 WIP。
管理层在真实子进程里已复现两个缺陷（只读证据 `local07-crosspath-probe-eaa0e2fee1c442bba72660d6956ed16a/RESULT.json`
= `not-rejected`，旧 run **未删未改**）：

- **必修 A（跨路径）**：`assertOpenedDatabaseClaimsMatch` 原来按 `ACTIVE_BY_DB_PATH` 查目标路径，查不到就
  返回 `claimed:false`（当普通入口）——于是「先 `claimFreshDataDir(A)`，再把 `WORKBENCH_DATA_DIR` 指向另建的
  既有库 B，再 `import db.mjs`」会给 B 建 `account_sets` 等核心表。
  现在（`server/database-open-guard.mjs`）：**只要本进程还持有活动创建事实**，核心首次打开的目标不对应
  其中一次创建事实时，一律在**任何核心 DDL / `journal_mode = WAL` / 迁移写之前**以
  `fresh_claim_target_mismatch`（退出码 3，`details` 只给 `activeClaims` + `basename(target)`）拒绝；
  按路径查表未命中**不得**退化成普通入口；别名 / junction 路径、多个活动 claim 下的第三路径同样拒绝；
  目标匹配时仍做完整连接核验（页 1 nonce / 魔数 / 创建 fd 身份 / 无 schema 对象）；**没有任何活动创建事实**
  时普通业务入口行为与旧实现完全一致。
- **必修 B（标记归属）**：`local-batch-storage.mjs` + guard 原来对标记只比 nonce 后 `unlink`；nonce 不是秘密，
  同一 nonce 的新文件对象 / 内容相同的外部标记会被误删。现在标记也在 `O_EXCL` 创建时用**创建 fd 的 `fstat`**
  抓 `dev`/`ino`，与本进程写下的**期望内容**一起只存 guard 私有 facts（`markerFd` / `markerIdentity` /
  `markerContent`）；打开校验 / `release` / 未登记失败清理都只比对这份身份 + 期望内容（加 realpath / 非符号
  链接确认），**删除时不重新认领当前路径对象**；取不到身份则保留现场。`discardOwnMarker` 现在必须收到
  创建时的身份快照（`null` 一律不删）。
- **必修 C（收尾）**：契约文档第 370 行行尾空格已修；`git diff --check` 无输出（exit 0）；三份文档同步本轮。

本轮新增 / 修改的验证（旧断言全部保留，未删未削弱）：

- **H7（persistence，新增）**：真实核心 import 子进程。① A claim + `WORKBENCH_DATA_DIR=B`（另建的 DELETE journal
  合成既有库，含 `sentinel` 2 行）→ `fresh_claim_target_mismatch`，`opened=false`，B 的 SHA / 大小 / `dev`+`ino` /
  表集合 / 行数 / `user_version` / `application_id` / `journal_mode` 与目录内容全部不变，无 `-wal`/`-shm`；
  ② junction 别名指向 B → 同样拒绝、B 不变（junction 构造失败会直接失败，不当成通过）；
  ③ 两个活动 claim、目标 = 其中一次创建事实 → 照常 `opened` 并建 >= 10 张核心表；④ 两个活动 claim、目标为第三目录 →
  拒绝且零 schema 对象；⑤ 两个 claim 全部释放后打开 B → 普通入口照常建核心结构（`journal_mode` 变 `wal`，
  `sentinel` 行数不变）——证明无 claim 时旧行为不变。
- **H8（persistence，新增）**：① 字节完全相同的替换标记对象（同 nonce）→ `assertFreshReceipt` = `fresh_receipt_stale`，
  `release` 后该对象与其字节完全保留（自己的、仍只有页 1 种子的库文件仍可释放）；② 同 nonce + 外部追加字段 →
  同样 stale，释放后外部标记原样保留；③ token 上任意赋值（含 `markerIdentity` / `markerContent` / `markerPath` /
  `markerFd`）不改变内部 facts，自己的标记与空库照常释放；④ H6 登记失败注入 + 同字节替换 / 同 nonce 加字段替换
  → 标记保留、库文件按创建身份清理；⑤ `open` 失败（`EACCES`）+ 同字节替换 → 标记保留。
- **H6 故障注入改造**：故障现在**按 fd 定位**（存储层本轮也会对标记创建句柄 `fstat`），不再按全局调用序号，
  原来的 `fstat` `EIO` 外部零字节 / 合成旧库不删不改写、自有零字节库与自有标记正常释放、`open` `EEXIST` / `EACCES`
  分支全部保留并通过（含标记替换形态扩为 foreign / same-bytes / same-nonce-extra）。

本轮员工实跑（**不等于**管理者复验 / 最终独审）：

| 命令（在 `06-workbench`） | 结果 | 日志 |
|---|---|---|
| `node test/local-batch-persistence.test.mjs` | **37 / 37**，exit 0（新增 H7 / H8） | `.agent-runs/local-07-b1-review3-persist-1.log` |
| `node test/local-batch-persistence.test.mjs`（最终树重跑） | **37 / 37**，exit 0 | `.agent-runs/local-07-b1-review3-persist-2.log` |
| `node test/local-batch-cli.test.mjs` | **11 / 11**，exit 0（B4 10 张唯一 PNG + 60 份原件） | `.agent-runs/local-07-b1-review3-cli-1.log` |
| `node test/smoke.test.mjs` | **28 / 28**，exit 0 | `.agent-runs/local-07-b1-review3-dep-smoke.log` |
| `node test/import-incremental.test.mjs` | **49 / 49**，exit 0 | `.agent-runs/local-07-b1-review3-dep-import-incremental.log` |
| `node test/accounting-period-integrity.test.mjs` | **45 / 45**，exit 0 | `.agent-runs/local-07-b1-review3-dep-accounting-period-integrity.log` |
| `node test/report-office-export.test.mjs` | **21 / 21**，exit 0（11 PDF 几何） | `.agent-runs/local-07-b1-review3-dep-report-office-export.log` |

- 本次唯一渲染目录：`.agent-runs/local-07-b1-review3-renders-D4WYev/`（`OWNER.json` / `manifest.json` /
  `README.txt` / 10 张唯一 PNG / `artifacts/` 60 份）。`local-07-b1-review1-renders/` 与
  `local-07-b1-review2-renders-XBqMOI/` **未删未改**；测试前缀常量改为 `local-07-b1-review3-renders-`，仍为 `mkdtemp` 唯一目录。
- 时序说明（便于复验）：`cli` 运行后到本轮收尾之间只改了**文档**与 `local-batch-storage.mjs` 的一处
  `releaseFreshClaim` **注释**（无行为变化）；因此又在最终树上重跑了 `persistence`（`persist-2`，37 / 37 exit 0）。
- 临时根：`TEMP`/`TMP` 均指向管理者新建的本轮专属目录 `.agent-runs/local-07-b1-review3-temp`（相对仓库根）；
  只清理本测试 `mkdtemp` 自己的目录（逐绝对目标 + 祖先链无 junction 校验），未扫描 / 批删任何旧目录。
- 员工透明记录：本轮一条临时探针少设了 `WORKBENCH_DATA_DIR`，一度在 gitignored 的 `06-workbench/data/`（默认开发库）
  生成了合成库 + `pre-v4` 备份；已核实该目录创建时间 = 探针运行时间（本轮新生成）、仅含这两份文件、祖先链无 junction，
  逐目标删除；**未涉及任何真实账套 / 凭据 / 税局浏览器**。

仍未完成（不伪造、不写成本包完成）：W3 现库组件安装 / 备份支持（`createBackup → verifyBackup` 接线）与手工 HTTP /
Agent 共享入口互斥；W4 真实 `createBackup → verifyBackup → restoreNew`、实例分叉、旧锁 / 路径与报表重建；
共享 `test-all` 接线；提交 / PR / 合并（员工不做 Git）。本任务单**不**预报管理复验 / 最终独审结论。

### 3.8 B1 资源收尾短修 4（本轮，仅标记创建 fd 关闭 + 定向断言）

起点与 review3 相同（`034404b4` + 现有 11 文件 WIP）；review3 的跨路径 guard / 标记身份与 CLI 11 / persistence 37 /
28 / 49 / 45 / 21 结果**未重做、未回退**。管理者发现一处明确资源遗漏：

- **缺陷**：`local-batch-storage.mjs` 的 `claimFreshDataDir` 在 `markerFd = openSync(markerPath, "wx")` 成功、
  标记身份已 `fstat` 且内容已写入之后，若 `dbFd = openSync(dbPath, "wx")` 抛 `EEXIST` / `EACCES`，catch 只
  `discardOwnMarker(markerIdentity)`，**没有关闭 `markerFd`**；该分支尚未把 fd 所有权移交给 guard，句柄会泄漏。
- **修复**：该分支现在**先无条件 `closeSync(markerFd)`**（与本进程能否删除标记无关），再按「创建时 `fstat` 身份 +
  本进程写下的期望内容」决定是否删标记；同 nonce 的新对象 / 追加字段的外部标记仍然保留（review3 行为不变）。
  同函数其它**未移交 fd** 的异常分支已逐个复查：标记 `openSync` 失败（尚无 fd）、标记 `fstat` / 写失败、
  `fstat(dbFd)` 失败、guard 登记失败拿不到 token 的分支都已关闭各自 fd，无新增业务改动。
- **测试（H6 / H8 故障注入补资源断言，用例数不变，仍 37）**：子进程在 `openSync` 打补丁时捕获标记 O_EXCL
  创建 fd（`fds.marker`），claim 失败后再 `fstat` 该 fd 必须抛 `EBADF`（`markerFdAfterFailure === "EBADF"`）；
  覆盖**自有标记**（`registration-mismatch` 无替换、`open-eacces` 无替换）与**被替换标记**
  （foreign / same-bytes / same-nonce-extra 下的 `registration-mismatch`、`open-eexist`、`open-eacces`）共 10 个
  失败场景（H6 六例 + H8 四例）。原有外部零字节 / 合成旧库保留、自有库与自有标记释放等断言全部保留。
- **判别性自检（如实记录）**：临时去掉该 `closeSync` 后，H6 的 `open-eexist` 场景立即失败
  （`实际 still-open`，36 / 37、exit 1），随后从本轮临时备份恢复文件并复核 diff；该失败日志保留在
  `.agent-runs/local-07-b1-review4-persist-mutation.log`，不是最终结果。
- **本轮员工实跑**（**不等于**管理者复验 / 最终独审）：`node test/local-batch-persistence.test.mjs` →
  **37 / 37**，exit 0（日志 `.agent-runs/local-07-b1-review4-persist-1.log` / `-persist-2.log`）。
  本轮按要求**未**重跑 `cli` / `report-office-export` / 其它核心套件（由管理者独立安排；
  `report-office-export` 现有测试会删固定 `qaDir`，故本窗口不重复）。
- 临时根：`TEMP`/`TMP` = `.agent-runs/local-07-b1-review4-temp`（相对仓库根）；只操作本轮自建合成目录，
  未删 / 未改旧 run 与旧 render，未扫描或批删系统 TEMP，未碰真实账套 / 凭据 / 税局浏览器。

### 3.9 B1 返修 5（2026-10-23，同月新增 subset 与完整恢复证据）

- 基线 `ac3b7725ed64ed56c83ae67aae8a7890fb1684b8`；本次只改 actions、persistence 测试与三份 07 文档。
  已审 `a5e8083` guard/db 保持不动；未改 storage / runner / test-all / 共享文档。
- 执行事实：历史 tokenhub 员工记录是历史。本次已获用户对火山 `ark.cn-beijing.volces.com` 的必要源码 /
  任务 / 合成错误授权，但 pi GLM 实际任务 429 周额度、无工具调用和修改；依用户新增授权由 root 派一个
  兜底实现 subagent。此处只报实施与自测，不冒充独审，不预报 PR / 合并。
- 修复：A600/12 已计提 50 后合法新增 B1200/12，本次只生成 B100；新增 runs 由动作前后差集确定，
  与 due 卡集合 / 本次新凭证逐项核对。全量卡片 / 全量 runs 仍持久化，旧 run 的凭证、金额和分录指纹
  在动作前后不变；每张原凭证分别核账套 / 期间 / 类型 / posted / 累折科目、借贷金额与科目存在性。
  恢复还显式核旧凭证账套 / 类型（这两字段不在既有凭证内容 hash 中），不依赖新凭证替旧凭证作证。
- 新 K3 实跑十种形态：合法新增 + 重启无重复；旧凭证分录 / 不存在科目 / 账套 / 期间 / 类型 / run 金额 / 反过账
  异常均拒绝且不新增 B 的 run / 凭证；已成功后单改旧分录 / 账套 / 类型亦被新进程 resume 拒绝。
  K1/K2 的 no_action / due / draft_pending / 卡增删和后续合法期间不失效历史等断言均保留。
- 本机日志根（相对本机管理仓库根）：`.agent-runs/local07-fallback-r5-ee1c4d97f80c4a03b7ee747fd540fbbf/`，
  包含本次 OWNER；TEMP/TMP 为其中 `temp/`，兜底 DATA 为 `fallback-data/`，均本次新建，逐层祖先核无 junction。
  各测试另建独占合成子目录，未用真实账套 / 凭据 / 税局，未删除旧 run / 旧 render，无裸 PID kill。

| 实际命令（06-workbench） | 最终实施者结果 | 日志（上述本机根内，附同名 `.exit`） |
|---|---|---|
| `node test/local-batch-persistence.test.mjs` | **39 / 39**，exit 0（追加 K4 后完整重跑） | `expense-final-persistence.log` |
| `node test/local-batch-cli.test.mjs` | **11 / 11**，exit 0（费用科目修复后完整重跑） | `expense-final-cli.log` |
| `node test/accounting-period-integrity.test.mjs` | **45 / 45**，exit 0 | `final-accounting-period-integrity.log` |
| `node test/smoke.test.mjs` | **28 / 28**，exit 0 | `final-smoke-retry.log` |
| `node test/import-incremental.test.mjs` | **49 / 49**，exit 0 | `final-import-incremental-retry.log` |

- 判别与失败如实保留：原实现 `red-persistence.log` **36 / 38**、exit 1，K3 正向确实
  `depreciation_run_inconsistent`，另 H7 因受限沙箱 junction `EPERM`；首轮实现后 **37 / 38**，
  K3 负例自身用了不存在账套而触发 FK，改为真实第二合成账套后 **38 / 38**。
  最终追加恢复时账套 / 类型负例后再完整跑 **38 / 38**。smoke 初次受限环境 HTTP 全部 fetch failed
  **0 / 28**、exit 1；获批在允许本机 loopback 的环境重跑 **28 / 28**。junction 套亦在获批环境真实通过，
  未把环境失败计为通过。
- CLI 仍真实产出 **840 阶段 / 600 产物**；PDF 全量仅结构 / 页数，文本金额及视觉证据只为
  两家两月五类代表抽样；本次留 **10 张唯一 PNG / 60 份原件**，最终目录为本 worktree 相对路径
  `.agent-runs/local-07-b1-review3-renders-QHgiv5/`（追加 K4 后 CLI 重跑）。本次未逐份人工查看，不称 600 份全部人工验算。
  未重跑会清固定共享 QA 的 Office suite。W3 / W4 / 最终独审 / PR / 合并仍未完成。
- 管理检查后的正常维护边界返工：K4 两个独立合成 fixture 均先 A5602 计提 50，再真实
  `updateAssetCard` 改 A 的未来费用科目为 5601，新增 B1200/12。真实核心生成 B100，首版 batch
  却报 `depreciation_amount_mismatch`（`expense-red-persistence.log` **38 / 39**、exit 1）。
  原因是用当前卡费用科目重建旧凭证。现仅新凭证严格使用当前卡费用科目；旧凭证核原借方金额、
  科目存在性与累折贷方科目 / 金额，并保存按规范化财务事实计算的原指纹。合法未来费用科目维护不废弃历史阶段，
  卡片费用字段仍留在追溯快照；K4 还验证成功后再次合法维护未来费用科目，普通新进程 resume 不重复，
  直接改旧凭证费用科目则 `depreciation_run_voucher_modified`。K3 新增不存在科目负例。
  旧 run **没有历史费用科目字段**，首次接管前无法区分原合法费用科目与同金额合法科目替换，
  因此不声称已证明其最初历史代码；首次捕获后按规范化财务事实与已纳入指纹字段的变化核验旧分录。
  金额沿用既有 `ROUND_HALF_UP` 归一到分的合同：`50 → 50.001` 的规范化金额相同，不保证检测这种
  被归一化消除的分以下原始金额差异，也不保证检测任意物理字段或 SQLite 字节变化。
  已验证的旧凭证费用科目改变、金额跨分变化、卡集合 / 期间 / 账套 / 凭证类型 / 摘要与失败原子性断言保留。
  最终完整 persistence **39 / 39**、CLI **11 / 11**，
  两个调用均实际 exit 0 且进程已返回；45 / 28 / 49 为此正常维护返工前的真实自测时点，未重复扩大测试。

## 4. 历史事实与限制（不得删除 / 不得用本轮绿色覆盖）

- **历史两次 22 / 23 完整失败**：P1 阶段出现过**两次**，当时**只保留输出尾部，原始完整输出缺失**，
  **原因至今仍未定位**。本窗口的新结果**不能**用来覆盖、解释或声称已修复这两次历史故障；
  也不把它归因到某个新探针问题。
- **只读探测无全局 deadline**：每连接 `busy_timeout = 5000` 毫秒、最多 4 次尝试、重试间额外睡眠合计 300ms
  （50 + 100 + 150），**没有** < 1 秒或其它总时长截止。独立审查曾用 DELETE-journal 库 `BEGIN EXCLUSIVE`
  持锁，实测另一子进程单次 `inspectDataDir` 29812ms（wall 29867ms）后才 fail-closed
  （`readable=false` / `database is locked`）。该数字只描述那一次观察，不承诺固定总时长。
- 共享 `server/db.mjs` 初始化本轮**已纳入边界**并加入库身份初始化钩子，但仍**未**加 `busy_timeout`（不是本包目标，
  没改那个行为）；CLI 只能把并发初始化窗口压到最小并归一为 `database_busy`（退出码 3），不声称并发启动已彻底根除。
- 本包**未**实现现库安装 backup / component、全产品共享手工入口互斥、`restoreNew` 实例分叉；
  这些仍归 W3 / W4，不能写成 LOCAL-07 整包完成。
- 新建库失败清理的残余边界：`fstat` 失败（身份未知）时本轮选择**保留**库文件与标记并要求人工核对
  （`fresh_claim_cleanup_required`），因此该目录在下一次 `start` 会稳定 `fresh_target_claimed`，
  需要人工按现场处理；这是有意的 fail-closed 取舍，不是自动修复。
- 报表仍是内部管理报表（`dataStatus.completeness = unverified`、`taxFilingReady = false`），不是税局申报模板；
  PDF 依赖本机中文字体，重新生成字节可能变化（按记录 hash 校验）。
- 未接税局、未使用真实账套 / 凭据；「20 家企业」为合成数据，真实接入数仍为 0。

## 5. 租约 / PID 分支的事实边界（§3.3 纠正）

> **租约已过期、PID 确认仍存活时拒绝抢锁；owner 释放后再次 retry 成功。本次独审没有实测 PID 存活无法确认分支。**

代码对「租约内且 PID 确认死亡」也会接管，对「PID 存活无法确认」保守拒绝；这些是**代码策略**，
不等于独审已实测所有分支。F3 用真实存活子进程覆盖「租约过期 + PID 存活 → `owner_active`」，
F4 用确认死亡 owner 覆盖接管与 fence 递增；本轮**未**新增「PID 存活无法确认」的真实受控验证，
因此不把该分支写成已测。

## 6. 依赖缺口与下一包

1. **W3（现库组件安装 / 备份支持 / 共享手工入口互斥）**：把已审 backup `createBackup → verifyBackup`
   接到「既有库新增 / 升级 batch 组件」，并接线批量与手工 HTTP / Agent 入口的共享互斥。
   当前本 CLI 对既有库仍 `migration_requires_backup`，只保证批量 runner 之间按账套互斥。
2. **W4（restoreNew / 实例分叉 / 旧锁与路径 / 报表重建）**：真实 `createBackup → verifyBackup → restoreNew`、
   恢复后新进程续跑、旧锁 / 路径处理与报表重建；本窗口未做，也没有 `copyFile` 伪备份。
3. 共享 `test-all` / docs 索引由对应 owner 另窗口接线；本包只显式列出所跑命令，
   **不**声称已进入总测试入口或全仓通过。
4. 若 #53 / #03 / #45→#44 同期有 main 变动，串行整合，不覆盖 owner 成果；基线变化需重验受影响范围并锁完整已审 head 后 PR。
5. 本轮的报表验收是**代表性抽样**（企业1 五类两月 + 企业2），不是 600 份 PDF 逐份人工验算；B1 只对 600 份做
   结构 / 页数检查，金额由 CSV / XLSX 的 20 家独立手算表覆盖。人工渲染抽查的 PNG 保留在本工作区
   `.agent-runs/`：旧目录 `local-07-b1-review1-renders/`（前一轮 10 张，未被本轮删除）
   与本轮新建的唯一目录 `local-07-b1-review2-renders-XBqMOI/`（10 张唯一页 + 60 份原件），**不随 Git 提交**，
   但保留供管理检查。
6. 新建库身份绑定的残余边界：页 1 nonce 会作为 `user_version` 长期留在库里（其它产品逻辑不读），
   并出现在所有权标记 JSON / `describeFreshClaim` / 测试诊断里（它是 31 位本地识别标记，不是秘密凭据）；
   `new DatabaseSync` 在目标文件被完全删除时会自己补一个 0 字节文件，钩子会在 DDL / WAL 前拒绝且不写它，
   但该 0 字节文件会保留现场；本机 Windows 的 SQLite 不共享 delete，「连接已打开在外部对象上、随后把路径
   换回本进程对象」的直接文件 ABA 在本机不可构造；实际可达的同类负例（外部零字节 / 外部旧库 / 同路径同
   `dev/ino` 内容被改写成外部库）已由 nonce 真实验证拒绝，**不把这些说成彻底排除所有平台的 ABA**。

完成本包验收 / PR 合并 / 交接后关闭本窗口 pi；下一包使用新进程、新会话，只载入任务所需材料。

## W3a 当前候选：真实自测与交付边界

基线 PR75 merge `4223ccb3ad2c1b71178f2a510ed1f196ff963f03`；W3a 尚未管理验收 / 独审 / PR / 合并。新增严格 batch1/2 登记、同步 fresh batch2、自有实例及三表绑定、async 显式保护安装 / CLI install、ready gate；audit 命名空间按对象归属及实际 SQL 表引用识别，普通 audit_instance_id 列和字符串/注释不污染审计事实。后装 bank/aux/audit 保持官方 source 预约核证并核真实 batch 维护准入。

实际命令 cwd 均为 `06-workbench`，解释器 `D:/node.exe`：

| 定点 | 实际结果 |
|---|---|
| `test/local-batch-install.test.mjs` | 扩至10组时全0；最后 report 可变快照兼容修正后，仅用 BATCH_TEST_CASE 精确选新增第11组实际 exit0，不把它写为整11组重跑 |
| `test/local-batch-backup-integration.test.mjs` | 6组 exit0；含48合法版本组合官方 backup→verify→restoreNew→again、四安装顺序、历史关联、WAL/非WAL、namespace与严格DDL/内容攻击 |
| `test/local-batch-persistence.test.mjs` | 实际39/39，exit0 |
| `test/local-batch-cli.test.mjs` | 实际11/11，exit0；已核 Python+Poppler 完成中文 PDF 文本/分页/金额及 CSV/XLSX |
| `test/local-backup.test.mjs` | 实际29/29，exit0 |
| `test/local-audit-install.test.mjs` | 4组 exit0，含24真实组合、四后装顺序、verify故障/预约、links/错句柄/DDL |
| `test/local-audit-backup-integration.test.mjs` | 实际 exit0（5组），非最终report兼容改动后重跑 |
| `test/bank-reconciliation.test.mjs` | 实际43/43，exit0，skip0 |
| `test/auxiliary-storage.test.mjs` | 实际 exit0，含严格未知组合零DDL |

DB 均 finally 实际关闭；异步 child 等 close 事件，外层逐套也等实际 close。仅新 UUID 合成根，业务 import 前设置 TEMP/TMP/WORKBENCH_DATA_DIR 和 KEEP_FIXTURES / WORKBENCH_TEST_KEEP_FIXTURES=1；不读真实账套/税务凭据/浏览器，不清旧目录或未知进程。

新两套最终全0现场 `w3a-newfinal-42de682e-36bd-4f49-bccb-b54e734e10d6`，对应 batch roots `batch2-test-c0d0d583-4f6e-4aed-9156-416c1a5a22ea` 和 `batch2-test-1f45b7e1-54cd-4b08-8354-57adf2b5dd70`；旧失败定点补齐后全0现场 `w3a-recheck-396961fd-7a38-489c-a670-6fb82f70b903`。这些是本机忽略现场名称，跨机器验收以源码/测试/PR为准。

保留失败历史：初次CLI缺已核Python、Windows link被沙箱EPERM，获准环境复跑原用例全部通过，未skip。新测试夹具的未export符号、audit索引建序与writable_schema防御失败均修正夹具，不放宽产品；所有UUID失败现场保留。G1原坏快照改为严格存储早拒batch_schema_invalid并核主库字节/业务与旧error不变；H2同名view在DDL前严格早拒，原冲突对象/半表零落地/伪回执反例保留。

原八表和序列迁移前后摘要示例 `ed383b5fd939440188d1a4ab025cf109498b8a526a9624176cb08425a826ae18` 完全相同；确定DDL故障回滚原库逻辑摘要 `2380965eee7ac47f505e49a216b167efba473595b5d04569f50a38d7ffa40488` 保持。新fixture保留42.37输入、12.39/0.03 DTO小数、19.37→23.81可变快照中断；合成两账套期初379.23/68.59（总447.82）。升级、备份不改变金额。完整每次根/命令/exit与精确SHA256文件清单由本片忽略交付卡提供 root 冻结。

最后 report 修正依据真实顺序：persistSnapshot 先覆盖可变DTO，再claimStage更新attempt hash；因此 pending/failed/running 历史hash只核摘要形状，有成功checkpoint时精确核evidence.snapshotHash。新增正例保留重试中断并官方备份/1→2，负例拒成功hash与自身checkpoint不一致。此修正后 root 仍须独立复跑受影响项；不能沿用先前自测冒称最终全绿。

原八包6/8，LOCAL06/07仍未完成。W2b业务coordinator、W3b共享写锁与真实20企业/检查点、W4恢复分叉/receipt/重绑、安全续跑、Windows与最终整链不在本片。本片roundtrip只是忠实恢复字节，不授予副本执行权。

### W3a 失败释放的保全取舍

实际新UUID/同inode反例证实：受控子进程WAL提交合成12.39后退出，旧release为判断空库打开SQLite会改变SHM字节。经root接受，本片仅在storage调用已审guard的固定 `{preserveDatabase:true}`，guard源码未改、不加可传清理开关；仍释放自己的marker/创建fd，但保留所有DB/WAL/SHM字节，连本次空种子也保留供诊断。**失败后不能承诺自动清空或同路径可直接fresh重试**，未提供删除命令。

新增真实child提交后actual close回归实际exit0：主库 `26d7467744a8a62c1beb99a28d0512306cdcde8e3836abbb793aee35325d56c7`、WAL `1a8f8c6828e24e30df0b9fb1e20ca9e9b14779bdfa2a7cd350a4fbd1cf227f29`、SHM `3939df1ca6d98b45659196f8a122481d2321f3f866efac2864b32f86285218d2` 前后完全相同，inode/dev不变，自己marker释放、二次release幂等。原H4/H8保留替换/外部对象断言，只更新受此取舍影响的空种子行为。

最终释放增量复验：`D:/node.exe test/local-batch-persistence.test.mjs`，cwd=06-workbench，在新UUID `w3a-release-final-547cec2f-28b0-42df-a674-3d0082142c2e` 实际39/39、exit0、child actual close。首轮保留现场 `w3a-release-persistence-0c3bd687-8c39-4692-b8cc-7d801a55a316` 为38/39，H8另一支旧“种子删除”断言漏同步，已同一保全合同更新为种子存在且hash同，替换marker/外部字节反例全部保留。新增install现为12组：第11可变report历史和第12sameinode释放各以精确BATCH_TEST_CASE单独exit0，不冒称整12组重跑；原10组/backup6组先前全0证据保留。report修正后的v1升级定点另实际exit0，八旧表/序列摘要 `8d39e2e10ff477751877a85c7fc24c5715748ba4b275a421a184f987e82ba2a6` 前后一致，component仅升version，原updated_at/note保持。root最终全影响验收/fresh独审/PR仍待进行。

## W3a e470 / 605 同轮独审返工（当前候选未验收 / PR / 合并）

root已copy-exclusive保留旧frozen/candidate/files/delivery/task与fresh报告，本执行者未修改其备份；本返工不进入后包，不Git、不子agent、不重复npm。原基线仍 `4223ccb3ad2c1b71178f2a510ed1f196ff963f03`，被拒父候选 `e470ec02b3e228080ec6ef0da841cd1fefa0c02b` 不得合并。

P2-1已按保存行的实际协议补齐：snapshot tuple须为manifest实际report计划；artifact校验真实stage/format/kind/code/key、确定安全相对路径、三态枚举、MIME、正attempt上界、渲染字段和可证摘要。保publishing及invalid旧attempt、恢复复用旧artifact到新attempt、最新snapshot覆盖窗口，不要求历史artifact=最新snapshot。成功checkpoint绑定自身evidence/bytes/outcome；CSV不在reportInputHash中，历史表示依自己的checkpoint保留，仅同attempt running publishing核当前CSV。全部为DB读取，不访问外部input/output。

P2-2已统一本次所有内部失败：已登记token的stamp catch固定preserveDatabase；未登记分支不再discardOwnEmptyDatabase。零字节/种子/DB/WAL/SHM固定保留，关闭自有fd并只清仍能证明自有的marker，guard源码不改。H6/H8原“未登记零字节自动删除”按同保全取舍更新为存在/size0/空摘要，保留所有外部替换断言。

本轮实际命令cwd均06-workbench、D:/node.exe，新UUID/import前两KEEP/env/祖先lstat与realpath、DB finally/child实际close；无真实数据或浏览器，无full93/npm。

| 阶段 | 命令与实际结果 |
|---|---|
| 两P2初修（最后CSV历史收窄之前的源） | 新install13组、newbackup8组、原persistence39/39均exit0/actualclose；现场 `w3a-p2-repair-7813b3a1-4b92-4dab-8914-c313850ffd12`。不冒称这三全套对应最后源码hash |
| 最后CSV历史收窄之后 | `BATCH_BACKUP_TEST_CASE=report-p2 node test/local-batch-backup-integration.test.mjs` 两组实际exit0/actualclose；含真实发布窗、CSV表示历史和42字段×v1/2的84拒绝例、外部路径读0 |
| 同最后源码 | `BATCH_PERSIST_TEST_CASES=E4,G3,H6,H8 node test/local-batch-persistence.test.mjs` 四个原用例实际4/4、exit0/actualclose。未删用例；默认未设过滤仍完整39 |

最后两条现场 `w3a-p2-final-42c701b4-293e-4139-bfcb-72c858c7197b`（忽略目录），新backup实体根 `batch2-test-9abc1482-1bb3-4e1c-9a14-95522b95727c`。合法正例为真实runner CSV/XLSX成功、rename前publishing和文件发布后checkpoint前受控child死亡、invalid旧artifact重渲染前死亡；恢复到新目录后真实保护1→2保全部旧行。真实业务379.23→402.41生成新DTO；旧artifact与新snapshot/claim同库仍合法，另验证同DTO/businessHash但CSV表示变更保原checkpoint。

fsync后EIO最终初修全套中种子SHA256 `48f8417b1a048057d8376e621a125893642a1b90aee7566b7f345700b2ca9c52` 前后同、4096bytes、dev/ino同；db/marker创建fd各实际EBADF，ownmarker释放，WAL/SHM均未创建。内部catch故障仅证明种子保全，不声称在该窗实测WAL损坏。单独首次定点也实际0、SHA256 `6119ad0426ae89b2524993a4aecccfe9fc5c2aa87de738f6328a04a1ed439365` 前后同，现场 `batch2-test-911f3cb7-8563-47ce-9f05-fcff24e51627`。

本轮一处编辑脚本对const路径变量重新赋值失败：只完成此前install测试文件写入，persistence文件尚未修改；随后单独正确修改并真实原39/最终4例通过，未将该脚本失败冒称产品测试。其余本轮新13/8/39及最后2/4定点均实际0，原e470失败与所有早期现场继续保留。

root后续仍须重新冻结21路径、十一影响套、独立probe与新的完整head fresh复审后方可PR；本交接不填写未来验收或合并。八包6/8、06/07/W2b/W3b/W4/Windows最终链未完，税局0。

返工最后仅测试harness增量：旧persistence在测试通过时不识别两KEEP，已按root允许仅让 `KEEP_FIXTURES=1` 或 `WORKBENCH_TEST_KEEP_FIXTURES=1` 任一成立保留本次已知ROOT；默认未设KEEP仍原清理行为，不改断言或执行。随后仅 `BATCH_PERSIST_TEST_CASES=H6,H8` 实际2/2、exit0/child close，确认现场 `w3a-p2-keep-541fc127-3900-40fd-9575-3e2fafb7fdb5/lb-persist-LdjPmX` 存在，保留已登记/未登记、外部marker替换及零字节DB证明。此前通过的旧persistence可能已由其当时的cleanup移除自身fixture，日志/结果仍留；不声称那些通过的故障fixture仍在，也未清理任何旧未知现场。最终产品source仍 `b1e360d0dc3b46398c495f8c1cc87b6efd2a47cf716cc9c5fc45e97a8b9dac35`，harness增量后未重跑全39/13/8；root最终十一套统一复验仍待进行。

### 605复审反向引用P2收口（2026-10-24）

完整605复审确认一项P2：只遍历现存artifact，删除成功阶段自己的artifact/snapshot后可跳过检查；改evidence指另一item或已claim running缺snapshot也能漏过。原内部种子P2已被独审以真实fsync后EIO/4096字节同/两个创建fd EBADF闭合；本次未改或重测guard/cleanup。root另存605全部证据为pre-reverse-repair，未触碰。

本次仅补stage反查：report attempt>0须有先persist的own snapshot tuple；succeeded须有own artifact及snapshot，再由原正向完整checkpoint绑定核归属。未claim pending0无两者、running有snapshot未登记artifact合法。无schema/runner算法/外部路径访问变更，保旧attempt复用、invalid、最新可变DTO/CSV历史。

实际命令cwd为本WT/06-workbench，D:/node.exe：BATCH_BACKUP_TEST_CASE=report-p2执行newbackup两组，exit0，46独立坏例×v1/2=92次全部inspect/source/verify/restore/保护安装拒且零变，外部读取0。真实runner基线另生成另一item artifact，四个新增反例分别删成功own artifact、删两者、删artifact改指另一item、claimed running删两者；正例pending0无记录和真实beforeArtifactPublish前受控child退出均完成官方backup→verify→restore→保护1→2→again，旧行不变。日志200条DB actualclose、10条child actualclose（计日志标记，不冒称总内部连接数）。

同轮必要fixture同步：v1 keeps…将无artifact伪成功改合法needs_review/attempt1，全部金额/旧行/锁/序列断言保留；mutable report…用真实runner成功artifact/evidence，再覆盖snapshot19.37→23.81，保成功自身input_hash漂移拒绝。两者各精确BATCH_TEST_CASE定点exit0/实际close，未重跑完整13/39或其它旧绿。mutable首次漏j变量、第二次误取stage.job_id先后exit1，finally/child均关闭，两个失败根保留；随后使用realReports返回job.id修正，单独exit0。

本次report-p2和v1日志根w3a-reverse-ef4994d7-72b2-4f51-82c0-e452717e446f（对应install测试中间hash，产品/backup hash与最终同）；mutable最终根w3a-reverse-mutable-54b0147c-4b62-42cc-93a3-00f52523f938。每次新UUID、import前TEMP/TMP/DATA/两KEEP及祖先realpath/lstat，所有新成功/失败现场保留，source-before/after相同。最终产品SHA256 0143a5715e98a9351886502ab4b0a37655a469afe1f941db6c2677b0a4bf26a5；先前b1e360、13/8/39等仅历史阶段，不冒称最终全验。root仍须统一十一套与新完整head独审；未PR/合并、八包6/8与06/07及后包未完。
> **2026-10-24 W3a 已合事实**：[PR #87](https://github.com/huxiaoyang-code/youshu-fork/pull/87) 已于 `2026-10-23T16:56:21Z` 合并；最终已审 head `f11e92dfad79e975fbdaa6bab68c41ee44a59b5a`，merge/main `882c5b65564fd7e2281eba4a799b3a7a25c5b5f3`。root 十一影响套实际 exit 0，两组独立验收及全新未实施者最终完整 head 独审接受，无确认 P1/P2；合并签名、tree 与父链接收 exit 0。原 e470 / 605 拒绝与下方候选记录保留为历史。原八包仍 6/8，LOCAL06/07、W2b/W3b/W4、Windows 与最终链未完，税局真实接入 0。
