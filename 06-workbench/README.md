# 记账 + 报表 工作台（MVP）

复刻有数云 `财税工作台` 的**记账与报表**能力，先落地最小可用版本。
**发票、申报（个税/增值税等）暂未实现**，但工具入口已保留并显式返回 `not_implemented`。

- 技术栈：Node.js（`node:sqlite` 内置，**零 npm 依赖**）+ 零构建网页
- 记账：复式借贷、凭证（草稿/过账/反过账）、期初余额、期间结账
- 报表：科目余额表（试算平衡）、资产负债表、利润表、**现金流量表**、明细账/总账
- **P1 会计闭环**：期末结转损益（3103→3104）、固定资产折旧/无形资产摊销计提
- 同时对外暴露：**网页 REST** 与 **Codex Agent 工具入口**（`/agent/tools/:name`）

## 启动

```bash
cd 06-workbench
node server/server.mjs
# 打开 http://127.0.0.1:8787/
```

数据库文件：`06-workbench/data/workbench.db`（SQLite，WAL）。
重置：停服务后删除该文件再启动即可。

## 网页功能

| 页签 | 说明 |
|---|---|
| 账套 | 新建账套，自动载入《小企业会计准则》标准科目表（可扩展） |
| 凭证 | 多分录录入，实时借贷平衡校验；存草稿 / 保存并过账 / 反过账 / 删除 |
| 科目 | 查看、新增科目（资产/负债/权益/成本/损益，借或贷） |
| 期初余额 | 按科目录入期初借方/贷方 |
| 资产 | 固定资产/无形资产卡片，一键计提折旧/摊销（直线法、幂等） |
| 报表 | 科目余额表、资产负债表、利润表、现金流量表、明细账；支持打印 |
| 期间 | 登记期间、结转本期损益、结账 / 反结账（结账后禁止录入） |

## HTTP API

```
GET    /api/meta
GET    /api/account-sets                      POST /api/account-sets
GET    /api/account-sets/:id                  DELETE /api/account-sets/:id
GET    /api/account-sets/:id/accounts         POST /api/account-sets/:id/accounts
GET    /api/account-sets/:id/opening-balances PUT  .../opening-balances
GET    /api/account-sets/:id/periods          POST .../periods {period,status}
GET    /api/account-sets/:id/vouchers?period=&status=
POST   /api/account-sets/:id/vouchers
GET    /api/account-sets/:id/vouchers/:vid
POST   /api/account-sets/:id/vouchers/:vid/post | /unpost
DELETE /api/account-sets/:id/vouchers/:vid
GET    /api/account-sets/:id/reports/trial-balance?period=YYYY-MM
GET    /api/account-sets/:id/reports/balance-sheet?period=YYYY-MM
GET    /api/account-sets/:id/reports/income-statement?period=YYYY-MM
GET    /api/account-sets/:id/reports/cash-flow-statement?period=YYYY-MM
GET    /api/account-sets/:id/ledger?code=&period=

POST   /api/account-sets/:id/carry-forward        {period, yearEnd?}   # 结转损益
GET    /api/account-sets/:id/assets                                    # 资产卡片（含已提/剩余）
POST   /api/account-sets/:id/assets               {kind,name,original_cost,residual_rate,useful_life_months,start_period,expense_account?}
DELETE /api/account-sets/:id/assets/:aid
POST   /api/account-sets/:id/depreciation         {period}             # 计提折旧/摊销
GET    /api/account-sets/:id/depreciation-runs?period=
```

## Codex / MCP 集成（已打通）

`05-reconstruction/codex/mcp/finance-mcp/backend.mjs` 默认指向
`http://127.0.0.1:8787`，因此 Codex 可以直接读写本工作台：

```bash
cd 05-reconstruction/codex/mcp/finance-mcp
node smoke-test.mjs
# tools (22) ... finance_query 利润表 2026-02 净利润 = 3000
```

已实现的 Agent 工具：

| 工具 | 行为 |
|---|---|
| `account_context` / `finance_context_resolve` | 返回账套与期间 |
| `finance_query`（nodeId） | `enterprise_account.account_set`、`enterprise_account.subject_system.all`、`voucher.generated.list/summary`、`voucher.draft.summary`、`voucher.detail`、`report.balance_sheet`、`report.income_statement`、`report.cash_flow_statement`、`period_end.summary` |
| `finance_query_catalog` | 能力目录 |
| `voucher_create` | 创建凭证（草稿/过账） |
| `voucher_check` | 借贷平衡与科目校验 |
| `carry_forward_profit` | 期末结转损益（`yearEnd` 时结转 3103→3104） |
| `asset_list` / `asset_create` | 资产卡片查询/新增 |
| `depreciation_run` | 计提折旧/摊销并生成凭证 |
| `update_plan` | 保存处理计划 |
| 其他（`invoice_*`/`declaration_query`/…） | 返回 `not_implemented` |

> 注：`carry_forward_profit` / `asset_*` / `depreciation_run` 为本复刻工程**扩展工具**（原站契约未包含），
> 已在本工作台与 MCP Server 注册；`05-reconstruction/catalog.json` 保留原站提取结果不变。

## 会计口径（重要，可按需调整）

- 标准：《小企业会计准则》；科目表见 `server/coa.mjs`。
- 记账方向：资产/成本/费用借增；负债/权益/收入贷增。
- 余额 = 期初 + 启用期间至目标期间的**已过账**发生额。
- 资产负债表：`未分配利润 = 利润分配(3104) + 本年利润(3103) + 尚未结转的本年损益`
  （兼容“已结转/未结转”两种状态）。
- 利润表：本期金额 = 当期；本年累计 = 年初（或启用期间）至当期；**不含结转凭证**。
- 期末结转损益：损益科目余额 → `3103 本年利润`；`yearEnd` 时再 `3103 → 3104 利润分配`。
  结转凭证 `kind='carryforward'`，不计入利润表发生额，避免重复计算；同期重复结转被拒绝。
- 折旧/摊销：直线法，`月计提 = 原值 × (1 − 残值率) ÷ 使用月数`；
  提足或未到计提期自动跳过；同一期间不会重复计提（`asset_depreciation_runs` 唯一约束）。
- 现金流量表：直接法——按货币资金（1001/1002/1012）对方科目分为经营/投资/筹资，
  并以与货币资金变动**勾稽**为校验；另附「净利润 → 经营活动净额」间接法补充资料。
- 现金流量表科目分类：投资含 1101/15xx/16xx/1701/1702/1801；
  筹资含 2001/2231/2232/2501/2701/3001/3002/310x；其余归经营。

## 未实现 / 后续 TODO

1. 发票：采集/查验/开票/红冲（`invoice_*`）。
2. 申报：增值税/附加税/企业所得税/个税（`declaration_query`、`tax_declaration_query`）。
3. 辅助核算（客户/供应商/部门/项目）、多币种。
4. 导入旧账（Excel）与银行流水对账。
5. 打印/导出（PDF/Excel）。
6. 用户与权限、审计日志、多租户。

## 目录

```
06-workbench/
├── server/
│   ├── server.mjs      HTTP（REST + /agent/tools + 静态）
│   ├── accounting.mjs  记账与报表领域逻辑
│   ├── coa.mjs         标准科目表
│   └── db.mjs          SQLite 建表
├── public/             网页（index.html / app.js / styles.css）
└── data/               workbench.db（运行时生成）
```
