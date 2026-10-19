# FULL-DEVELOPMENT-TAKEOVER · 全量开发接管交接

日期：2026-10-19。来源：用户最新指示（见 [任务单](../tasks/FULL-DEVELOPMENT-TAKEOVER.md)）。本文件是**跨电脑自足交接包**：接手者在不接触原机器目录、进程、凭据、日志的前提下，凭本文件 + GitHub 远端即可恢复工作。

> 本文件只写可核验事实与无敏感摘要；**不含**真实身份原文、真实金额、凭据、token、session、本机绝对路径。仓库相对路径与远端 URL 是对外唯一引用方式。

## 1. 三分钟接管摘要

- 用户把**全部后续开发**交给另一台电脑的 Codex 接手，继续向私有仓库 `https://github.com/huxiaoyang-code/youshu-fork` 提交；**沿用 `huxiaoyang-code` 账号**，不 fork、不新建仓库。
- **不复制**原机器 token / config / session / 帐套 DB；目标机由用户自行登录、按已有授权独立配置服务。
- `huxiaoyang-code` 的「本机 Codex 自审验收后自动合并」授权**继续有效**（仍须独立内容审查 + 影响验证 + 整合约束；**不是** GitHub 第二账号 review，不伪造 review）。
- **旧 A / B 分工不再限制接手者**；Issue #13 / #14 / #17 保留、**不自动关闭**；**不假定**旧机器已停止。
- 接手前先在 GitHub 核对在途 PR / 成果并**登记**同名文件；按本次用户指示**直接接续，无须再次确认接管授权**；只有发现**实际冲突或未停的同文件实施**时协调，不覆盖他人未提交成果；**对方是否实际收件 / 已开工未知**。**本次只交接文档，原机器不新开业务实现**。
- 交付目标是**最新 PRD 的全部范围**（见 §4），漳州先验收 ≠ 全国完成，**不得**用自动点击浏览器 / 点击脚本路线（用户已永久否决）。

## 2. 远端在途资源（本交接撰写时经 GitHub 只读核对，接手时以实际为准）

| 载体 | 编号 / SHA | 状态 | 说明与处理建议 |
|---|---|---|---|
| main | `d0221df1d18e2bfcbd7db2cc9aa0875ab32a7fd4` | 最新已知 main（2026-10-16） | **不是**新会话必须停留的 HEAD；恢复时先 `git fetch` 以实际为准 |
| PR [#18](https://github.com/huxiaoyang-code/youshu-fork/pull/18) | head `346e1c307379e9a6bf96ef34244dee154558777f` | **OPEN / Draft** | 最新业务范围已确认（PRD v0.2），研发方案待评审。**不要**把该分支合入本交接任务；只用**固定 URL / 固定 SHA** 只读 PRD |
| PR [#19](https://github.com/huxiaoyang-code/youshu-fork/pull/19) | head `a47a53c3e7b077edcf827ee34aa40450cc3694ff` | **OPEN** | 福建漳州浏览器企业采集草稿的**安全整合**（主线 336 基线；PR 历史记录独立验收 15 套 496 + smoke 28，**本次未重跑**）。PR 仍缺跨成员独立复核，真实登录 / 采集器 / 财务闭环未验。**不得**当全国接入；保留可复用的安全 / 绑定能力，先评估与当前路线冲突，**不盲合并 / 删除 / 重复实现** |
| Issue [#20](https://github.com/huxiaoyang-code/youshu-fork/issues/20) | — | **OPEN** | **全量开发接管总 Issue**（assignee `huxiaoyang-code`，标题「全量开发接管：沿用 huxiaoyang-code 完成后续开发」）；子 PR 用 `Refs #20` |
| Issue [#13](https://github.com/huxiaoyang-code/youshu-fork/issues/13) | — | **OPEN** | 税局登录、账套关联与持续数据接入（旧 assignee `huxiaoyang-code`，**未改动**） |
| Issue [#14](https://github.com/huxiaoyang-code/youshu-fork/issues/14) | — | **OPEN** | 两类报表口径核对与导出（旧 assignee `xiaoyihaishiaini`） |
| Issue [#17](https://github.com/huxiaoyang-code/youshu-fork/issues/17) | — | **OPEN** | 全项目评审与完整 V1 整改计划 |

> **不虚构**新的 Issue / PR 编号，不声称旧 Issue 已关闭或 assignee 已转移，不声称接手者已开工或本交接文档 PR 已合并。本交接文档 PR 的编号 / 合并 SHA 由管理者在其后补录。

**可核验状态（管理者已核对，供接手者交叉验证）**：

- main `d0221df`，2026-10-19 在 `06-workbench` 运行 `npm test`：10 套 336 项全部通过、exit 0（测试用合成临时库，**无真实 DB**；**不是 CI**）。首次沙箱回环失败，获批沙箱外复跑全部通过。**本次只做文档，不重复跑业务套件。**
- 原 `tax-browser` 草稿仍在本机保留，已审查的远端可读快照见 PR #19；**不要求**目标机寻找任何 D 盘路径。

## 3. 代码地图（仓库相对路径，接手者按本表定位）

```
06-workbench/                        记账 + 报表工作台（Node ≥ 22.5，零第三方依赖）
├── package.json                     scripts: start / test / test:smoke / seed；engines.node >= 22.5.0
├── server/
│   ├── server.mjs                   接口层：REST /api/* + POST /agent/tools/:name + 静态资源
│   ├── agent-tools.mjs              Agent 工具注册表 + 入参校验 + 真实能力目录（unavailable 说明）
│   ├── tax-gateway.mjs              税务会话 / 地区适配契约（全国路由目录齐全；**产品已集成并验收的真实适配器数 0**）
│   ├── accounting.mjs               领域层：账套/科目/期初/期间/凭证/余额/三表/明细账/折旧/结转/导入
│   ├── coa.mjs                      科目表（小企业会计准则 COA，两准则共用同一 COA）
│   ├── db.mjs                       SQLite（node:sqlite）：建表 + 老库迁移
│   ├── report-export.mjs            内部五类 CSV 导出与预览 DTO（PR #15 合并）
│   └── tax-report-format.mjs        税局报表参考结构 / 就绪性检查 / 上传阻断（B2 未完成）
├── public/                          index.html / app.js / styles.css（零构建 SPA）
├── test/                            accounting-guards / accounting-derived / import-strict /
│                                    report-export / report-export-http / tax-report-format / smoke
├── scripts/test-all.mjs             全套测试入口（含 MCP 契约 / 工作流 / 税务契约）
└── data/                            运行期 SQLite（gitignore）；用 WORKBENCH_DATA_DIR 重定向到临时目录

05-reconstruction/codex/mcp/finance-mcp/   MCP stdio Server 与契约测试
├── server.mjs / tools.mjs / tax-tools.mjs / backend.mjs（默认 http://127.0.0.1:8787）
├── contract-test.mjs / workflow-test.mjs / tax-contract-test.mjs / smoke-test.mjs / import-demo.mjs
└── package.json

docs/                                索引 INDEX.md / 章程 PROJECT-CHARTER.md / 团队协作 TEAM-COLLABORATION.md
├── REPORT-CLOSURE-PLAN.md           报表闭环工作包 RC-0 ~ RC-6（**A / B 分工段为历史快照**）
├── REPORT-EXPORT.md                 内部五类 CSV 口径、DTO、错误码、金额样例
├── TAX-REPORT-FORMAT.md             税局参考结构来源与上传阻断
├── tasks/                           任务看板 README.md、RC-A / RC-B、本任务单
└── handoffs/                        STATE.md、NEXT-SESSION.md、本交接、TAX-POSTLOGIN-CHECKPOINT.md
```

关键入口：

- 领域逻辑集中在 `06-workbench/server/accounting.mjs`（约 1500 行）；**REST `/api/*` 账务路由直接调用 `accounting.mjs` 领域函数**；**`POST /agent/tools/:name` 经 `agent-tools.mjs` 的 `callAgentTool`**，MCP 侧 `backend.mjs` 把工具调用翻译为对该 HTTP 入口的调用。
- 全套测试入口 `06-workbench/scripts/test-all.mjs` 会连同 `05-reconstruction/codex/mcp/finance-mcp/{contract,workflow,tax-contract}-test.mjs` 一起跑。
- 数据库 Schema 见 `db.mjs`：`account_sets` / `accounts` / `opening_balances` / `periods` / `vouchers(kind)` / `voucher_entries` / `asset_cards` / `asset_depreciation_runs`；金额用 SQLite `REAL`。

## 4. 业务目标（以最新 PRD 为准）

- 权威 PRD（**固定 SHA 只读**）：<https://github.com/huxiaoyang-code/youshu-fork/blob/346e1c307379e9a6bf96ef34244dee154558777f/docs/PRODUCT-PRD.md>
- 文件在 **PR #18 head**，未合并进 main；见 §7 命令如何只读取得，并**先核对 head**。
- 范围要点（细节以 PRD 原文为准）：本机单用户 / 多企业多账套；全国首版目标、两套准则；内部报表与税局财报、**Excel 与 PDF 都要**；辅助核算与银行对账；发票采集 / 开票 / 红冲；企业各适用税种与个税（工资薪金 / 劳务 / 经营 / 年度汇算）；正式申报 / 缴款 / 社保 / 非税；备份恢复与可追溯；20 家两种账号模式实际同时办理；可比工作月一名操作者配合产品正确完成 **> 300 家**；真实外部提交**操作前批次确认**。

## 5. 状态矩阵（代码现状 / 缺陷；结合源码检查，不给完成百分比或工期承诺）

**已实现（有代码与回归证据）**：多账套 / 科目 / 期初；凭证草稿、过账、反过账；旧账 JSON / 4 CSV 严格导入（预检 + 原子事务，拒绝非法金额文本）；直线折旧摊销与防重复计提；损益结转与年末结转；封账保护；MCP 账务链路；五类内部 CSV 与预览 HTTP。

**未实现 / 未完整**：真实产品税局适配；源数据完整性；持续定向导入幂等与恢复；两准则完整口径；辅助核算；银行自动对账；发票及完整计税 / 个税 / 申报 / 缴款 / 社保 / 非税；Excel / PDF；审计备份恢复；持久任务与 20 家实际并发、月产出实证。税局财报导出当前返回 422 `tax_template_unverified`；内部 `completeness` 为 `unverified`、`taxFilingReady` 为 `false`。

| # | 缺陷 / 缺口（源码位置） | 复现与后续验收方向 |
|---|---|---|
| 1 | `accounting.mjs createAccountSet` 始终加载同一 `COA`，`coa.mjs` 两准则共用科目表；`accounting_standard` 只是登记字段 | 建两个不同准则账套，比较科目表；验收需按准则切换/映射并验证行次 |
| 2 | `accounting.mjs cashFlowStatement`（约 898 行起）按对方科目**绝对金额比例**分类；复杂混合凭证总额可能对、分类错；间接法末行直接复用直接法经营净额 | 构造双向混合凭证（借银行 / 借固定资产 / 贷借款），对比独立预期分类；`report-export` 已带 `cash_flow_allocation_limited` 与 `indirectIndependent:false` 警告 |
| 3 | `accounting.mjs setPeriodStatus` 结账只要求「无草稿 + 试算平衡」，**不证明**来源完整 / 已对账 / 已计提 | 结账前缺计提/对账仍可通过；验收需补前置条件与阻断 |
| 4 | 资产卡片与总账缺完整一致性校验（建卡不生成购买凭证） | 建卡后总账资产不变；需补卡片↔总账及连续期间计提完整性核对 |
| 5 | `accounting.mjs importAccountSet` 每次**新建账套**，缺后续追加与批次幂等 | 同键重复导入会建新账套；需去重查询先于空账套拒绝 + 定向追加（RC-2） |
| 6 | 金额用 SQLite `REAL` + `Number` + `r2`/`EPS`（`accounting.mjs` 顶部：`r2` 两位小数、`EPS = 0.005`） | 需明确精度与舍入口径、构造边界用例；**不无证据**称「所有金额错误」 |
| 7 | 直接凭证路径 `checkVoucher`（约 208 行）对非法金额可能**归零**：管理者合成复现 `checkVoucher(setId, entries=[{code:'1002',debit:100,credit:'bad-amount'},{code:'5001',debit:0,credit:100}])` 返回 `ok: true`（`bad-amount` 经 `r2` 变 0，等价贷 100，平） | 需拒绝非有限 / 非数值金额。**严格导入路径**（`normalizeImportPayload` / `parseImportAmount`）已有保护，**不能**宣称导入路径也无校验 |
| 8 | 主线 HTTP 本机边界弱（`server.mjs` 存在通配 `access-control-allow-origin: *` 与 `OPTIONS` 放行）；PR #19 有**未合并**修正 | 评估与 PR #19 的整合；安全边界需同源 / Host 校验且保留本机 CLI/MCP 无 Origin 场景 |
| 9 | MCP 返回真实账簿明细会越过「真实数据不送模型」约束（`agent-tools.mjs` 的 ledger 等返回明细） | 需改为**本机计算真实明细 + 只向模型回传安全引用 / 状态摘要** |

> 每条缺陷的验收**必须**先补合成回归、再改实现；失败回滚、防重复。**不虚构**已修复。

## 6. 建议接续顺序

1. 接管盘点 / 评审（本交接 §9 首日清单）；
2. 安全金额与会计核心缺陷分包（§5 的 #7 / #6 / #3 等无外部依赖项可先行）；
3. 真实登录 / 数据可得性与来源清单（结合 [TAX-POSTLOGIN-CHECKPOINT](TAX-POSTLOGIN-CHECKPOINT.md) 待验项）；
4. 连续两个月定向导入、对账与期末完整性；
5. 报表与计税底稿 / 规则版本 / 账表税勾稽；
6. 申报回执、缴款与防重恢复；
7. 发票、个税、社保、非税等全域逐项覆盖；
8. 20 家真实同时办理与真实工作月产出**分别**验收。

允许独立任务并行，但**先登记文件负责人**；不得只写计划不开发：完成环境 / 基线核对与任务拆分后，在已授权范围推进**无依赖的首个修复包**。

**税务处理原则**：按真实资料形成可追溯底稿；税负用于检查差异 / 遗漏 / 政策适用，**不按目标税负倒算账务**；每字段可追原始证据 / 凭证 / 调整 / 规则版本，区分预缴与汇算、财报报送与纳税申报、申报与缴款。本交接**不是税率政策建议，不编现行税率**。

## 7. 必要命令（接手者本机实际核实，不照抄版本号）

> 占位符说明：`<worktree-path>` 是**目标机自己选择的** worktree 路径，`<member>` / `<task>` 是分配给该包的成员名与任务名，**由目标机现场决定**；下文已给出可直接使用的分支例 `codex/huxiaoyang-code/voucher-amount-guards`。

```powershell
# 0) 先看现场，避免覆盖未提交内容：不要先 git pull 覆盖本地改动
git status
git worktree list
git remote -v
gh --version
gh auth status          # 确认登录到用户在目标机授权的 huxiaoyang-code 账号且具备 repo 权限
git fetch origin        # 只更新远端引用，不动工作区文件
git log --oneline -5 origin/main

# 1) 环境核验（Node 版本与内置 sqlite 必须实测；内存库用完即关）
node --version          # 需 >= 22.5.0
node -e "const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync(':memory:'); db.exec('create table t(a)'); db.prepare('insert into t values (1)').run(); console.log('node:sqlite ok', db.prepare('select count(*) c from t').get().c); db.close()"

# 2) 建独立 worktree 与分支（不强推；分支名 codex/<member>/<task>），在仓库目录执行：
git worktree add <worktree-path> -b codex/huxiaoyang-code/voucher-amount-guards origin/main

# 3) 从 worktree 根目录跑全套测试（每个套件自行 mkdtemp 合成临时库；失败即中止）
cd <worktree-path>
Push-Location 06-workbench
try {
  npm test
  if ($LASTEXITCODE -ne 0) { throw "npm test 失败，exit=$LASTEXITCODE，已中止后续步骤" }
} finally { Pop-Location }

# 4) 只读查看 PRD（未合并进 main；先核对 head 再读取）
gh pr view 18 --json headRefOid,state,title
git show origin/codex/huxiaoyang-code/project-prd-review:docs/PRODUCT-PRD.md   # 只读；不 checkout 该分支
```

- **不要**用 `git pull` 覆盖未提交内容；用 `git fetch` + 独立 worktree。
- **测试隔离事实**：`npm test`（= `06-workbench/scripts/test-all.mjs`）各套件自行 `mkdtempSync` 建合成临时库并设 `WORKBENCH_DATA_DIR`，不写 `06-workbench/data/`；因此无需额外手工设目录也能安全跑测试。全套**已包含 smoke**（以及 MCP contract / workflow / tax 契约），**不要求无理由重复跑 `test:smoke`**。
- **独立手动启动 / 演示**（`npm start`、`npm run seed`、手工起 HTTP 调试）**必须**先设 `WORKBENCH_DATA_DIR` 指向临时或专用目录；默认 `npm start` 会写 `06-workbench/data/`（`db.mjs` 缺省 `process.env.WORKBENCH_DATA_DIR || join(__dirname,'..','data')`），**不得**指向真实账套库。
- 基线：`npm test` 在 2026-10-19 为 **10 套 336 项**；**336 不是以后固定数字**，以实际为准。
- 每个 `npm` 命令都如实记录退出码；失败先判断环境（Node 版本 / `node:sqlite` / 端口 / 权限）还是代码，**不删改断言**。

## 8. 无需原机器缓存的恢复说明

- **不需要**原机器的日志、会话、worktree、进程状态、`.agent-runs/` 或公开 bundle 作为开工前提。
- 目标机只按**精确的公开 / 远端来源**重新取得资源：仓库本体（clone）、PR #18 的 PRD（固定 SHA 只读）、PR #19 的代码快照（`git fetch` 后 `git show`）、公开的税局参考结构来源（见 [TAX-REPORT-FORMAT](../TAX-REPORT-FORMAT.md)）。
- 环境 / 依赖 / 路径 / 端口 / PID **按目标机实际核实**，**不复制**原机器配置。
- 旧机器此刻的进程状态**不假定**；交接授权已由用户确认，**不需要再次审批**，开工前只需登记在途 PR / 同文件编辑，**只在发现实际冲突或未停的同文件实施时协调**。

## 9. 首日可执行清单

1. 读 [任务单](../tasks/FULL-DEVELOPMENT-TAKEOVER.md)、本文件、[TAX-POSTLOGIN-CHECKPOINT](TAX-POSTLOGIN-CHECKPOINT.md)、[PROJECT-CHARTER](../PROJECT-CHARTER.md)、[STATE](STATE.md)、[TEAM-COLLABORATION](../TEAM-COLLABORATION.md)、[tasks/README](../tasks/README.md)、[REPORT-CLOSURE-PLAN](../REPORT-CLOSURE-PLAN.md)、[REPORT-EXPORT](../REPORT-EXPORT.md)、[TAX-REPORT-FORMAT](../TAX-REPORT-FORMAT.md)、[local-agent-first SKILL](../../team-skills/local-agent-first/SKILL.md)。
2. `git status` / `worktree list` / `gh auth status` / `git fetch origin`；核对 main、总接管 Issue [#20](https://github.com/huxiaoyang-code/youshu-fork/issues/20)、在途 PR #18 / #19 与业务 Issue #13 / #14 / #17 的**实际状态**，并**登记**自己将改的同名文件。
3. 按 §7 核验环境并跑一次全套测试，记录实际数字与退出码（合成临时库）。
4. 只读取得 PRD（先核对 head `346e1c3…`），输出**差距清单**与**任务拆分**（每包登记唯一文件负责人）。
5. 从 §5 无外部依赖缺陷（如 #7 直接凭证非法金额）派本地员工做**首个修复包**：先补合成回归 → 改实现 → 自测；管理者读 diff、独立复跑、锁 head、开 PR 并（按已授权）合并。
6. 真实外部提交前**批次确认**；真实登录 / 数据来源缺口做独立前置并记为待验。

## 10. 可直接复制给目标机 Codex 的中文启动提示

```text
你是接手本项目的本机 Codex 管理者；接手人由**用户在本机登录授权的 `huxiaoyang-code` GitHub 账号**执行 Git / PR
操作，继续向私有仓库 https://github.com/huxiaoyang-code/youshu-fork 提交；不 fork、不新建仓库、不换用户名。
由用户在本机自行登录该 GitHub 账号，Codex 与模型服务按现有授权在目标机独立配置；不要复制原机器的任何
token / config / session / 账套 DB，也不要寻找原机器的目录、端口、PID、日志或 bundle。

请先读（仓库内相对路径）：
- docs/tasks/FULL-DEVELOPMENT-TAKEOVER.md（全量接管任务单）
- docs/handoffs/FULL-DEVELOPMENT-TAKEOVER.md（本交接包：代码地图、状态矩阵、在途资源、缺陷与顺序、命令、首日清单）
- docs/handoffs/TAX-POSTLOGIN-CHECKPOINT.md（税局登录后只读 checkpoint；当前暂停、待复验，不自动恢复真实操作）
- docs/PROJECT-CHARTER.md、docs/handoffs/STATE.md、docs/TEAM-COLLABORATION.md、docs/tasks/README.md
- docs/REPORT-CLOSURE-PLAN.md、docs/REPORT-EXPORT.md、docs/TAX-REPORT-FORMAT.md
- team-skills/local-agent-first/SKILL.md（本地执行、Codex 管理 / 审查 / 提交 / 合并）

事实与边界：
- 交接授权已由用户确认（用户已明确「用我的 GitHub 账户，他全面接手开发任务」），**不需要再次确认接管授权**；
  开工前只需核对并登记在途 PR / 同名文件，只在发现实际冲突或未停的同文件实施时协调，不覆盖他人未提交成果。
- 旧 A / B 分工不再限制你；Issue #13 / #14 / #17 保留、不自动关闭、旧 assignee 未变，也不假定旧机器已停止；
  总接管 Issue #20（OPEN，assignee huxiaoyang-code）为本次接管载体，子 PR 用 Refs #20，并按业务关联 #13 / #14 / #17。
- 在途 PR #18（Draft，业务 PRD v0.2，head 346e1c307379e9a6bf96ef34244dee154558777f）与
  PR #19（OPEN，福建漳州企业采集草稿安全整合，head a47a53c3e7b077edcf827ee34aa40450cc3694ff）；
  开工前先在 GitHub 核对其实际状态与与你将改文件的冲突。
- 最新业务 PRD 在 PR #18 分支上，未合并进 main：clone main 后没有该文件。请先 git fetch origin，
  再 `gh pr view 18 --json headRefOid` 核对 head，然后
  `git show origin/codex/huxiaoyang-code/project-prd-review:docs/PRODUCT-PRD.md` 只读查看，不要 checkout 该分支。
- 基线：npm test 在 06-workbench 目录运行，2026-10-19 为 10 套 336 项（合成临时库，不是 CI），
  336 不是永久数字，以你本机实际为准；设置 WORKBENCH_DATA_DIR 到临时目录，绝不覆盖生产库。
- 产品为本机单用户、多企业多账套批量；不做多租户 / SaaS / 对外服务。**产品已集成并验收的真实税局适配器数 0**
  （不等于本机只读联调记录为 0；已有本机人工登录后的部分只读观察，见 TAX-POSTLOGIN-CHECKPOINT）。
  自动点击浏览器 / 点击脚本路线已被用户永久否决，不得采用。
- 真实账套数据与税务凭据不发到模型服务；真实登录 / 验证码只在可信本机界面处理。
- 执行员工只允许 GLM 5.3 或 DeepSeek V4.1 Flash（主 / 回退显式锁定），不得用其他模型或子 agent；
  该约束不限制你（Codex）自身模型。你负责拆解、隔离 worktree、读实际 diff、跑验证、写任务单与
  PR 正文、Git / PR / 合并；不直接补写业务代码 / 测试 / 交付文档（即使小修也退回本地员工）。
- 我已授权你按既有范围执行，并在本机验收通过后自动合并自己的 PR（仍须独立内容审查、影响验证、
  共享变更串行整合）；真实外部提交（开票 / 红冲 / 正式申报 / 缴款）操作前需我按批次确认。
- 不要新建 GitHub Actions / CODEOWNERS / 规则集，不声称已有 CI 或分支保护，不擅自改远端设置。

请先做接管盘点：核实环境（Git / Node ≥ 22.5 与 node:sqlite 实测 / gh 登录 / 执行员工与允许模型）、
基线、worktree、在途 PR 与 Issue 实际状态；输出差距清单与任务拆分（每包登记唯一文件负责人），
然后直接派本地员工推进**无外部依赖的第一个修复包**（例如直接凭证路径非法金额被静默归零、
金额精度与舍入口径、封账前置条件不足），先补合成回归再改实现。不要只写计划，也不要空等真实输入。
```

## 11. 回退、限制与仍未验证范围

- 回退用**新的 revert PR**，禁止重写 main 历史。
- **仍未验收 / 不得当作已完成**：**产品端完整真实登录 / 验证码流程与完整采集仍未验收**；本机只在人工登录后做过**部分只读观察**（端点与成功判定见 [TAX-POSTLOGIN-CHECKPOINT](TAX-POSTLOGIN-CHECKPOINT.md)，**当前暂停、不自动恢复**，不宣称全部税局读取从未成功）；**产品已集成并验收的真实适配器数 0**；完整企业授权与财务数据来源；PR #19 的跨成员独立复核与真实登录 / 采集器 / 财务闭环；PR #18 的研发方案评审；税局可上传财报文件（422 `tax_template_unverified`）；Excel / PDF；辅助核算、银行对账、发票、个税、社保、非税、申报与缴款；20 家真实并发与月产出；本交接文档 PR 本身的编号与合并 SHA（由管理者后补，**不得假称已合并**）。
- **不虚构**已接管、已收件、旧 Issue 已关闭或 assignee 已变更、本交接 PR 已合并、他人进程已停止。

---

相关：[任务单](../tasks/FULL-DEVELOPMENT-TAKEOVER.md) · [税局登录后 checkpoint](TAX-POSTLOGIN-CHECKPOINT.md) · [阶段状态](STATE.md) · [新会话入口](NEXT-SESSION.md) · [团队协作协议](../TEAM-COLLABORATION.md) · [交接模板](TEMPLATE.md)。
