# 记账 + 报表 工作台（MVP）

复刻有数云 `财税工作台` 的**记账与报表**能力，先落地最小可用版本。
**发票、申报（个税/增值税等）暂未实现**，但工具入口已保留并显式返回 `not_implemented`。

- 技术栈：Node.js（`node:sqlite` 内置，**零 npm 依赖**）+ 零构建网页
- 记账：复式借贷、凭证（草稿/过账/反过账）、期初余额、期间结账
- 报表：科目余额表（试算平衡）、资产负债表、利润表、明细账/总账
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
| 报表 | 科目余额表、资产负债表、利润表、明细账；支持打印 |
| 期间 | 登记期间、结账 / 反结账（结账后禁止录入） |

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
GET    /api/account-sets/:id/ledger?code=&period=
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
| `finance_query`（nodeId） | `enterprise_account.account_set`、`enterprise_account.subject_system.all`、`voucher.generated.list/summary`、`voucher.draft.summary`、`voucher.detail`、`report.balance_sheet`、`report.income_statement`、`period_end.summary` |
| `finance_query_catalog` | 能力目录 |
| `voucher_create` | 创建凭证（草稿/过账） |
| `voucher_check` | 借贷平衡与科目校验 |
| `update_plan` | 保存处理计划 |
| 其他（`invoice_*`/`declaration_query`/…） | 返回 `not_implemented` |

## 会计口径（重要，可按需调整）

- 标准：《小企业会计准则》；科目表见 `server/coa.mjs`。
- 记账方向：资产/成本/费用借增；负债/权益/收入贷增。
- 余额 = 期初 + 启用期间至目标期间的**已过账**发生额。
- 资产负债表：`未分配利润 = 利润分配 + 本年利润`，`本年利润 = 收入 − 成本费用`
  （由损益类科目净发生额推出，不自动做结转凭证）。
- 利润表：本期金额 = 当期；本年累计 = 年初（或启用期间）至当期。
- 现金流量表：**未实现**（返回 `not_implemented`）。

## 未实现 / 后续 TODO

1. 发票：采集/查验/开票/红冲（`invoice_*`）。
2. 申报：增值税/附加税/企业所得税/个税（`declaration_query`、`tax_declaration_query`）。
3. 期末自动结转损益、自动计提折旧/摊销。
4. 辅助核算（客户/供应商/部门/项目）、多币种。
5. 导入旧账（Excel）与银行流水对账。
6. 现金流量表（直接法/间接法）。
7. 用户与权限、审计日志、多租户。

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
