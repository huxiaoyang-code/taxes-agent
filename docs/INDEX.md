# 代码管理索引 · CODE INDEX

> 本文件是仓库的**唯一索引入口**：先看这里，再进具体目录。
> 维护约定：新增/移动模块、改变入口或命令时，**必须同步更新本文件**。

- 仓库：`有数云fork` — 有数云「代账 / 财税工作台」逆向分析 + 复刻工程
- 骨架版本：`0.3.0`（见 [CHANGELOG](CHANGELOG.md)）
- 运行时：Node.js ≥ 22.5（`node:sqlite` 内置）、Python 3（仅分析脚本）
- 约束：**零第三方 npm 依赖**；前端零构建

---

## 0. 怎么用这份索引

| 我想…… | 去哪里 |
|---|---|
| 跑起来看效果 | [§6 命令速查](#6-命令速查) → `06-workbench` |
| 看线上站点分析结论 | [`../REPORT.md`](../REPORT.md) |
| 看复刻总体方案 | [`../05-reconstruction/ARCHITECTURE.md`](../05-reconstruction/ARCHITECTURE.md) |
| 改记账/报表逻辑 | [§3.1 领域层](#31-领域层server) → `server/accounting.mjs` |
| 加接口 / 加 Agent 工具 | [§3.2 接口层](#32-接口层server) → `server/server.mjs` |
| 接发票 / 申报 | [ROADMAP](ROADMAP.md) → `agentTool()` 分支 |
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
| `04-report/` | 主题报告 01–09 + 报告生成脚本 | 文档 | `build_report.py` | ✅ |
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
│   ├── accounting.mjs    领域层：账套/科目/期初/期间/凭证/余额/报表
│   ├── coa.mjs           领域数据：小企业会计准则科目表
│   └── db.mjs            持久层：SQLite 建表与连接
├── public/               前端（零构建）
│   ├── index.html        视图骨架（页签：凭证/科目/期初/资产/报表/期间）
│   ├── app.js            前端逻辑（SPA，原生 DOM）
│   └── styles.css        样式
├── test/
│   └── smoke.test.mjs    端到端测试（临时库+随机端口，22 用例）
└── data/                 运行期 SQLite（已 gitignore）
```

### 3.1 领域层 `server/`

| 文件 | 关键导出 | 职责 | 依赖 |
|---|---|---|---|
| `db.mjs` | `db` | 建表/连接（account_sets, accounts, opening_balances, periods, vouchers(**kind**), voucher_entries, asset_cards, asset_depreciation_runs）含老库自动迁移 | `node:sqlite` |
| `coa.mjs` | `COA`, `STANDARDS` | 标准科目表（60+，含备抵科目标记 `contra`） | — |
| `accounting.mjs` | 账套/科目/期初/期间：`createAccountSet` `listAccounts` `setOpeningBalances` `ensurePeriod` `setPeriodStatus`；凭证：`checkVoucher` `createVoucher` `listVouchers` `getVoucher` `postVoucher` `unpostVoucher` `deleteVoucher`；报表：`accountBalances` `trialBalance` `balanceSheet` `incomeStatement` `generalLedger` `cashFlowStatement`；**P1**：`carryForwardProfit` `listAssetCards` `addAssetCard` `deleteAssetCard` `listDepreciationRuns` `generateDepreciation` | 全部记账与报表算法 | `db.mjs`, `coa.mjs` |

### 3.2 接口层 `server/`

`server.mjs` 两条出口：

1. **网页 REST** — `/api/...`，见 [`../06-workbench/README.md`](../06-workbench/README.md) 的 API 表。
2. **Agent 工具** — `POST /agent/tools/:name`，被 `05-reconstruction/codex/mcp/finance-mcp/backend.mjs` 调用，
   使 Codex 能直接记账出报表。工具映射见 `server.mjs` 的 `agentTool()`。

> ⚠️ 加新工具/新查询能力时，必须同时更新：`agentTool()`、`CATALOG_QUERIES`、
> [`../05-reconstruction/catalog.json`](../05-reconstruction/catalog.json)（保持契约一致）。

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
| `codex/mcp/finance-mcp/server.mjs` | MCP stdio Server（22 工具 + skills 资源） |
| `codex/mcp/finance-mcp/backend.mjs` | 后端适配器（默认指向 `http://127.0.0.1:8787`） |
| `codex/mcp/finance-mcp/smoke-test.mjs` | MCP 冒烟（在线时直连工作台） |
| `codex/skills/**` | 5 个子智能体、21 份业务规则模板（待填正文） |

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
| `build_report.py` | 由 `03-analysis/*.json` 重新生成以上报告 |

---

## 6. 命令速查

```bash
# —— 工程：记账 + 报表 ——
cd 06-workbench
npm start                 # 启动 → http://127.0.0.1:8787/
npm test                  # 端到端测试（11 用例）

# —— 方案：Codex / MCP（工作台需先启动）——
cd 05-reconstruction/codex/mcp/finance-mcp
node smoke-test.mjs       # MCP 工具清单 + finance_query 实调
node server.mjs           # 单独起 MCP（一般由 Codex 拉起）

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
05-reconstruction/catalog.json ────┘（工具契约来源）
```

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
| 记账 + 报表 MVP | ✅ 可运行，22/22 测试通过 |
| P1 会计闭环（结转损益/折旧摊销/现金流量表） | ✅ 完成 |
| 辅助核算 / 导入旧账 / 银行对账 / 导出 | ⬜ 待办（ROADMAP P1 剩余） |
| 发票 / 申报 | ⬜ 待办（ROADMAP P2，返回 `not_implemented`） |
| 多用户 / 权限 / 审计 | ⬜ 待办（ROADMAP P3） |
