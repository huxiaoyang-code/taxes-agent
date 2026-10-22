# 代码管理索引 · CODE INDEX

> **2026-10-22 新增（本机产品路线）：[增量导入契约](LOCAL-IMPORT.md)** · [任务](tasks/LOCAL-01.md) · [交接](handoffs/LOCAL-01.md) · [八包总览](tasks/INDEPENDENT-PRODUCT-WORK.md)。新增 `06-workbench/server/import-incremental.mjs`（领域：三种导入用法 / **一企一账套规范企业身份** / 批次 / 内容指纹 / 去重与结构化冲突 / 凭证状态核验 / 自动号码预分配 / 单事务）、`import-storage.mjs`（**schema v3**：企业→账套唯一关系 + 来源证据 + 落库指纹 + `import_batch_vouchers` 逐张批次关联，**先备份后建新结构**的迁移事务，迁移失败重新备份且不复用过期快照），并接线 `db.mjs`、`server.mjs`（`POST /api/import/incremental`、`GET /api/import/batches/:id`）、`agent-tools.mjs`（`book_import_incremental` / `book_import_batch`）与 MCP `tools.mjs`（同两个工具，`origin: local`）；旧 `importAccountSet` / `legacy_book_import` 不变。测试：上一冻结候选 `npm test` **47 / 47 套 exit 0**；最后定向修复后实跑领域 49 / 49、HTTP + Agent 22 / 22、MCP 7 / 7，均 exit 0（合成临时库 + 随机回环端口）；最终代码未重跑全套。最后定向返工：`create` 同批回放也核验当前真实期初（合法 API 改期初后不再伪报 replay），实际执行 / 查询 / 回放统一 `sourceTrace` 逐张 DTO。**税局现场仍暂停、真实接入仍 0**；本包不影响税局模块。状态：**已验收合并**：基线 `0c4e0dd` → 已审 head `e12e71e` → [PR #46](https://github.com/huxiaoyang-code/youshu-fork/pull/46) 已实际 MERGED → merge `1a15bcce`（北京时间 2026-10-22 17:13:24），独立审查无剩余阻塞；最终代码只实跑受影响三套，未重跑全套 47 套，仓库无 CI。

> **2026-10-21 新增：[税局接口目录](TAX-API-CATALOG.md)** · [任务](tasks/TAX-API-CATALOG.md) · [交接](handoffs/TAX-API-CATALOG.md)。把现成逆向报告明确列举的税局接口整理成 29 模块 / 131 条结构化目录，后端与 MCP 可检索 / 分页 / 详情 / 参数校验 / 调用准备，并附统一结果分类器。只读合同：未连接税局，本包线上已验证 0 条；完整可调用契约 0 条（缺响应 / 企业 / 权限前置条件）。初审问题已修复，待冻结后复审。

> **2026-10-21 当前：[税局下载探索](TAX-DOWNLOAD-EXPLORATION.md)** · [任务](tasks/TAX-DOWNLOAD-EXPLORATION.md) · [交接 / 命令](handoffs/TAX-DOWNLOAD-EXPLORATION.md)。本轮仅完成查询 / 下载探索支撑候审。财报按用户要求暂停；新门户 fresh 3 / 企业匹配已实测，发票已正常跳转，但只有脚本 / 认证 metadata，未识别列表 query。最新私有 snapshot 7 / 9 份、4,034,109B；observer 已独审 + root 37 项，120s / 180s 两个真实窗均 armed / scopeStable / 全 scope 布尔 true，事件 / metadata / bodies 0、cleanup true / 无锁，窗口现全停。用户已手动查询无结果，空或报错未区分，不推点击在记录窗内，不确认官网无数据 / 接口坏 / 登录失效。今天停止探索、仅收尾交接 PR，不请求 / 重开窗；下次须用户明确继续，再核 scope / snapshot + armed 后人工查询。41 组首跑 40 过、旧 MCP lost-response 模拟子 Node 异常，无改定向 4 / 4 过；root 随后全 41 组重试 exit 0、41 / 41 全过；本轮支撑交付冻结候审，[PR #40](https://github.com/huxiaoyang-code/youshu-fork/pull/40) 已创建、开放候审；代码已独审，用户今日停止事实的文档仍待最终 head 审查。 业务下载 / 新 MCP repeat 0；可先交支撑 PR，总专项继续，不转企业补资料。下方历史保留原时点。

> 本文件是仓库的**唯一索引入口**：先看这里，再进具体目录。
> 维护约定：新增/移动模块、改变入口或命令时，**必须同步更新本文件**。

- 仓库：`有数云fork` — 有数云「代账 / 财税工作台」逆向分析 + 复刻工程
- 骨架版本：`0.4.0`（见 [CHANGELOG](CHANGELOG.md)）
- 运行时：Node.js ≥ 22.5（`node:sqlite` 内置）、Python 3（仅分析脚本）
- 约束：**零第三方 npm 依赖**；前端零构建

---

## 0. 怎么用这份索引

| 我想…… | 去哪里 |
|---|---|
| 增量导入（连续多月 / 去重 / 幂等） | [增量导入契约](LOCAL-IMPORT.md) · [任务](tasks/LOCAL-01.md) · `06-workbench/server/import-incremental.mjs` |
| 看本机产品路线的八包计划 | [本机独立产品工作](tasks/INDEPENDENT-PRODUCT-WORK.md) |
| 跑起来看效果 | [§6 命令速查](#6-命令速查) → `06-workbench` |
| 看线上站点分析结论 | [`../REPORT.md`](../REPORT.md) |
| 看复刻总体方案 | [`../05-reconstruction/ARCHITECTURE.md`](../05-reconstruction/ARCHITECTURE.md) |
| 看哪些功能真正可用、哪些需要补齐 | [本机 Codex 功能盘点（2026-10-13）](CAPABILITY-AUDIT-2026-10-13.md) |
| 看本轮交付和可重复验收 | [第一期验收](PHASE1-ACCEPTANCE.md) · [税务适配契约](TAX-INTEGRATION.md) |
| 看当前优先级与补全计划 | [报表闭环补全方案](REPORT-CLOSURE-PLAN.md)（RC-0 ~ RC-6，当前首包 RC-0） |
| 开新对话继续工作 | [新会话入口](handoffs/NEXT-SESSION.md) · [阶段状态](handoffs/STATE.md) · [本地优先技能](../team-skills/local-agent-first/SKILL.md) |
| 看并发分工、需求和验收规则 | [团队实施计划](TEAM-PLAN.md) · [任务看板](tasks/README.md) |
| 多人协作 / 分角色 / 新成员加入 | [团队协作协议](TEAM-COLLABORATION.md) · [成员入场包](handoffs/MEMBER-ONBOARDING.md) · [任务单模板](tasks/TEMPLATE.md) · [TEAM-HANDOFF 交接](handoffs/TEAM-HANDOFF.md) |
| 看总流程、阶段重置与恢复工作 | [项目执行章程](PROJECT-CHARTER.md) · [阶段状态](handoffs/STATE.md) |
| 改记账/报表逻辑 | [§3.1 领域层](#31-领域层server) → `server/accounting.mjs` |
| 下载内部五类报表 / 看导出口径 | [REPORT-EXPORT](REPORT-EXPORT.md) · `06-workbench/server/report-export.mjs` · [RC-B 交接](handoffs/RC-B-REPORTS.md) |
| 看税局模板来源与未完成项 | [TAX-REPORT-FORMAT](TAX-REPORT-FORMAT.md) · `06-workbench/server/tax-report-format.mjs`（B2 实际上传成功路径未完成） |
| 加接口 / 加 Agent 工具 | [§3.2 接口层](#32-接口层server) → `server/server.mjs` |
| 接发票 / 申报 | [ROADMAP](ROADMAP.md) → `agent-tools.mjs` 注册表 |
| 找原始证据 | [§5 分析与证据](#5-分析与证据-0004) |

---

## 1. 仓库分层

```
证据层 (Evidence)   00-recon / 01-capture / 02-scripts / 03-analysis / 04-report
                    └ 只读归档，可复现生成，不参与运行
方案层 (Design)     05-reconstruction
                    └ Agent 契约 + Codex/MCP 骨架，供工程层复用
工程层 (Product)    06-workbench
                    └ 可运行的记账+报表 MVP
管理层 (Docs)       docs/
                    └ 本索引、规范、变更、路线图
```

---

## 2. 顶层目录索引

| 目录 | 内容 | 类型 | 入口文件 | 状态 |
|---|---|---|---|---|
| `docs/` | 代码管理索引与规范 | 文档 | `INDEX.md` | ✅ |
| `00-recon/` | 侦察：域名更正、HTTP 头、首页 HTML | 证据 | `dns-corrected-url.md` | ✅ 冻结 |
| `01-capture/` | REA 被动抓取：页面/DOM/网络/截图 | 证据 | `inspect-web-page.json` | ✅ 冻结 |
| `02-scripts/` | 前端脚本：`work/`(工作台)、`finance/`(登录) | 证据 | `*/index.html` | ✅ 冻结 |
| `03-analysis/` | REA 原始证据 JSON（应用图、接口、分包） | 证据 | `api-endpoints.json` | ✅ 冻结 |
| `04-report/` | 主题报告 01–10 + 报告生成脚本 | 文档 | `build_report.py` | ✅ |
| `05-reconstruction/` | 复刻契约 + Codex MCP 骨架 | 方案+代码 | `ARCHITECTURE.md` | 🚧 |
| `06-workbench/` | 记账 + 报表 MVP | 工程 | `server/server.mjs` | 🚧 |

---

## 3. 复刻工程 `06-workbench/`

```
06-workbench/
├── package.json          npm 脚本：start / test
├── README.md             使用说明（启动、API、口径、TODO）
├── server/               后端（ESM，零依赖）
│   ├── server.mjs        接口层：REST + /agent/tools + 静态资源
│   ├── agent-tools.mjs   工具注册与输入校验、真实能力目录
│   ├── tax-gateway.mjs   税务会话/地区适配契约（真实接入数 0）
│   ├── accounting.mjs    领域层：账套/科目/期初/期间/凭证/余额/报表
│   ├── coa.mjs           领域数据：小企业会计准则科目表
│   └── db.mjs            持久层：SQLite 建表与连接
├── public/               前端（零构建）
│   ├── index.html        视图骨架（页签：凭证/科目/期初/资产/报表/期间）
│   ├── app.js            前端逻辑（SPA，原生 DOM）
│   └── styles.css        样式
├── test/
│   ├── smoke.test.mjs    原有端到端测试（28 用例）
│   ├── accounting-guards.test.mjs  封账/期初/期间（23 用例）
│   └── accounting-derived.test.mjs 明细/折旧/结转（31 用例）
├── scripts/
│   ├── test-all.mjs      全套测试入口（含 MCP、税务、完整闭环）
│   └── seed-demo.mjs     演示数据种子（--force 重建，账套 id=1）
└── data/                 运行期 SQLite（已 gitignore）
```

### 3.1 领域层 `server/`

| 文件 | 关键导出 | 职责 | 依赖 |
|---|---|---|---|
| `db.mjs` | `db` | 建表/连接（account_sets, accounts, opening_balances, periods, vouchers(**kind**), voucher_entries, asset_cards, asset_depreciation_runs）含老库自动迁移 | `node:sqlite` |
| `coa.mjs` | `COA`, `STANDARDS` | 标准科目表（60+，含备抵科目标记 `contra`） | — |
| `accounting.mjs` | 账套/科目/期初/期间：`createAccountSet` `listAccounts` `setOpeningBalances` `ensurePeriod` `setPeriodStatus`；凭证：`checkVoucher` `createVoucher` `listVouchers` `getVoucher` `postVoucher` `unpostVoucher` `deleteVoucher`；报表：`accountBalances` `trialBalance` `balanceSheet` `incomeStatement` `generalLedger` `cashFlowStatement`；**P1**：`carryForwardProfit` `listAssetCards` `addAssetCard` `deleteAssetCard` `listDepreciationRuns` `generateDepreciation`；**导入**：`parseCsv` `parseImportTexts` `validateImportPayload` `importAccountSet` | 全部记账与报表算法 | `db.mjs`, `coa.mjs` |

### 3.2 接口层 `server/`

`server.mjs` 两条出口：

1. **网页 REST** — `/api/...`，见 [`../06-workbench/README.md`](../06-workbench/README.md) 的 API 表。
2. **Agent 工具** — `POST /agent/tools/:name`，被 `05-reconstruction/codex/mcp/finance-mcp/backend.mjs` 调用，
  使 Codex 能直接记账出报表。工具映射见 `agent-tools.mjs` 的注册表。

> 加本地工具/查询时同步更新 `agent-tools.mjs`、MCP `tools.mjs`（税务工具在 `tax-tools.mjs`）及契约测试。
> [`../05-reconstruction/catalog.json`](../05-reconstruction/catalog.json) 是原站证据，保持冻结；本地能力独立标注。

---

## 4. 复刻方案 `05-reconstruction/`

| 文件 | 职责 |
|---|---|
| `ARCHITECTURE.md` | ★ 复刻总方案 + “它就是 Codex 客户端” 的证据链 |
| `catalog.json` | 从 bundle 提取的 Agent 契约：5 子智能体 / 22 工具 / 21 查询 / 21 技能 / 协议 |
| `extract_catalog.py` | 从 `02-scripts/work/index-yoSd2Nx7.js` 重新提取契约 |
| `generate_skill_stubs.py` | 生成 21 份 SKILL.md / references 模板 |
| `codex/config.toml` | Codex MCP 注册示例 |
| `codex/.env.example` | 后端地址 / Skill 目录 |
| `codex/README.md` | Codex 集成说明 |
| `codex/mcp/finance-mcp/server.mjs` | MCP stdio Server（45 个入口，含不可用兼容入口；真实状态以 tools/list 为准） |
| `codex/mcp/finance-mcp/tools.mjs` / `tax-tools.mjs` | 本地工具 schema、可用状态；税务接口已预留，未接真实税局 |
| `codex/mcp/finance-mcp/contract-test.mjs` / `tax-contract-test.mjs` / `workflow-test.mjs` | 临时后端上的 MCP 契约、税务状态机与业务闭环验收 |
| `codex/mcp/finance-mcp/backend.mjs` | 后端适配器（默认指向 `http://127.0.0.1:8787`） |
| `codex/mcp/finance-mcp/smoke-test.mjs` | MCP 冒烟（在线时直连工作台） |
| `codex/mcp/finance-mcp/import-demo.mjs` | 本地复现「导入旧账」端到端演示（读取示例 CSV → 预检 → 导入 → 勾稽） |
| `examples/legacy-book/**` | 导入旧账示例数据集（4 张 CSV） |
| `tools/xlsx-to-csv.py` | 旧账 Excel(.xlsx) → CSV 转换器（openpyxl） |
| `codex/skills/**` | 记账及其 7 份规则、旧账导入已补齐；发票/申报等其余内容仍待开发 |

---

## 5. 分析与证据 `00–04`

### 5.1 证据台账（Evidence IDs）

| Evidence ID | 操作 | 产出 |
|---|---|---|
| `ev_f3601e80…b16837` | `list_browser_targets` | 目标发现 |
| `ev_5cf4d9b1…1189311` | `inspect_web_page` | `01-capture/inspect-web-page.json` |
| `ev_8143096e…124326d` | `capture_web_screenshot` | `01-capture/screenshot.png` |
| `ev_66f34fbf…19b6962` | `analyze_web_bundle` | `03-analysis/analyze-web-bundle.json` |
| `ev_77753503…5d644c84` | `analyze_javascript_application`（finance） | `03-analysis/finance-app-analysis.json` |
| `ev_ad4fac8e…4f2011c0` | `analyze_javascript_application`（work） | `03-analysis/work-app-analysis.json` |
| `ev_7f835b30…d7d0754d` | `discover_webmcp_tools` | `03-analysis/webmcp-tools.json` |
| `ev_4e3f22c8…046cf2c2` | `export_web_scripts` | `02-scripts/finance/` |

完整台账见 [`../REPORT.md`](../REPORT.md) §5。

### 5.2 报告索引 `04-report/`

| 文件 | 主题 |
|---|---|
| `01-app-overview.md` | 站点身份、两个 SPA |
| `02-frontend-architecture.md` | Vite/React/antd/axios/Mermaid/Sentry |
| `03-routes.md` | 路由与鉴权跳转 |
| `04-api-endpoints.md` | 67 条候选接口 |
| `05-feature-map.md` | 业务功能地图 |
| `06-tech-stack-and-thirdparty.md` | 依赖与第三方 |
| `07-security-observations.md` | 响应头/会话/监控 |
| `08-method-and-evidence.md` | 方法与证据对照 |
| `09-unknowns-and-limits.md` | 未知与覆盖边界 |
| `10-account-set-import.md` | 账套导入实现（page=account-sets）：建账向导旧账文件 + `legacy-book-import` 子智能体 |
| `build_report.py` | 由 `03-analysis/*.json` 重新生成以上报告 |

---

## 6. 命令速查

```bash
# —— 工程：记账 + 报表 ——
cd 06-workbench
npm start                 # 启动 → http://127.0.0.1:8787/
npm test                  # 全套领域回归 + MCP/税务契约 + 完整闭环（临时库）
npm run test:smoke        # 原有 28 项端到端测试

# —— 方案：Codex / MCP（工作台需先启动）——
cd 05-reconstruction/codex/mcp/finance-mcp
node smoke-test.mjs       # MCP 工具清单 + skills_read + finance_query 实调
node import-demo.mjs      # 导入旧账端到端演示（示例 CSV → 预检 → 导入 → 勾稽）
node server.mjs           # 单独起 MCP（一般由 Codex 拉起）

# —— 旧账 Excel → CSV ——
python 05-reconstruction/tools/xlsx-to-csv.py 旧账.xlsx -o out/ --list

# —— 证据：重新生成报告 / 契约 ——
python 04-report/build_report.py
python 05-reconstruction/extract_catalog.py
python 05-reconstruction/generate_skill_stubs.py
```

环境变量：`PORT`（默认 8787）、`WORKBENCH_DATA_DIR`（默认 `06-workbench/data`）、
`FINANCE_API_BASE`（默认 `http://127.0.0.1:8787`）、`FINANCE_SKILLS_DIR`。

---

## 7. 依赖与数据流

```
网页(public)  ──REST /api──▶  server.mjs  ──▶  accounting.mjs  ──▶  db.mjs(SQLite)
Codex         ──MCP stdio─▶  finance-mcp  ──HTTP /agent/tools──▶  server.mjs
                                   ▲
原站 catalog.json（冻结） + 本地能力定义 ──┘（工具契约来源）
```

- 原站 `05-reconstruction/catalog.json` 是逆向证据，**保持冻结、不修改**；本地新增/调整工具写入 `06-workbench/server/agent-tools.mjs` 与 `05-reconstruction/codex/mcp/finance-mcp/tools.mjs`（税务工具 `tax-tools.mjs`）并同步契约测试。

- 外部依赖：**无**（无 npm 包）。Codex 由使用者自行安装。
- 运行期数据：`06-workbench/data/workbench.db`（不入库）。
- 证据文件：只读，由 REA 6.4.0 生成，`04-report/build_report.py` 可重建报告。

---

## 8. 模块 ↔ 报告 ↔ 证据 对照

| 模块 / 能力 | 设计依据（报告） | 原始证据 |
|---|---|---|
| 账套、科目体系 | `04-report/05`, `01` | `catalog.json` → `finance_query_catalog` |
| 凭证（创建/检查/过账） | `04-report/05` | work 应用图 `voucher_create`/`voucher_check` |
| 科目余额表 / 试算平衡 | `04-report/05` | `report.*` 能力目录 |
| 资产负债表 | `04-report/05` | `report.balance_sheet` |
| 利润表 | `04-report/05` | `report.income_statement` |
| 明细账 | `04-report/05` | `voucher.detail`、`voucher.generated.list` |
| Agent 工具契约 | `05-reconstruction/ARCHITECTURE.md` | `ev_ad4fac8e…`、`ev_66f34fbf…` |
| MCP 集成 | `05-reconstruction/codex/README.md` | Codex app-server 证据链 |
| 发票 / 申报（未实现） | `04-report/05` | `invoice_*`、`declaration_query` |

---

## 9. 状态看板

| 项 | 状态 |
|---|---|
| REA 证据归档 | ✅ 完成（冻结） |
| 复刻契约与 MCP 骨架 | ✅ 可运行 |
| 记账 + 报表 MVP | ✅ 可运行，六项可靠性修复已交付；测试见第一期验收 |
| 全国电子税务局 | 🚧 7 个接口入口和地区路由已预留，真实接入 0 个地区 |
| P1 会计闭环（结转损益/折旧摊销/现金流量表） | ✅ 完成 |
| 导入旧账（JSON/CSV，GBK 支持） | ✅ 完成 |
| 导入严格校验（IMPORT-STRICT） | ✅ 完成（PR #10，merge `67f5e45`） |
| 报表闭环（当前优先级，RC-0 ~ RC-6） | 🚧 进行中；顺序与门槛见 [报表闭环补全方案](REPORT-CLOSURE-PLAN.md)。**B1 内部五类 CSV 导出已由 PR #15 交付（RC-4 前置）；B2 税局申报可用文件、RC-3 财务流水线完整性、RC-1/RC-2 登录与定向导入、RC-6 端到端均未完成**；首包 RC-0（tax-browser 草稿审查 + 登录与数据链路可行性） |
| 多人跨电脑协作（成员 / 文件所有权 / 任务看板） | ✅ 已建立（文档与模板）：[团队协作协议](TEAM-COLLABORATION.md) · [成员入场包](handoffs/MEMBER-ONBOARDING.md) · [任务看板](tasks/README.md) · [交接](handoffs/TEAM-HANDOFF.md)；分工：负责人 RC-0/1/2 与数据处理（[Issue #13](https://github.com/huxiaoyang-code/youshu-fork/issues/13)，OPEN），同事 RC-4/5 与报表口径（[Issue #14](https://github.com/huxiaoyang-code/youshu-fork/issues/14)，OPEN）。本轮共 18 文件（10 修改 + 8 新增），**已完成管理者终审返工**；**是否已提交 / 已合并以 Git、PR 与远端实际状态为准**，本索引不预报合并 |
| 辅助核算 / 银行对账 / 导出 | 🚧 部分：内部 3 表 + 余额表 / 明细账 CSV 导出已由 PR #15 交付（RC-4 前置）；辅助核算 / 银行对账仍未实现，Excel/PDF 未实现 |
| 发票 / 申报 | ⬜ 待办（ROADMAP P2，返回 `not_implemented`）；税局申报格式导出属闭环 RC-5 |
| 历史上排：导入幂等（IMPORT-IDEMPOTENCY） | ⬜ 已并入报表闭环 **RC-2**（不再是第一优先） |
| 后排：本机泛用批量任务队列 / 管理（BATCH-QUEUE / BATCH-MANAGEMENT） | ⬜ 报表闭环完成后再定归属；本阶段不先行搭建泛用批量平台 |
| 账套隔离 / 操作日志 / 备份恢复 / 凭据安全 | ⬜ 待办（ROADMAP P3 本机化；**不做多租户**）；闭环必需的最小恢复能力见 RC-2 / RC-3 |
