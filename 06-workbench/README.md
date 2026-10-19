# 记账 + 报表 工作台（MVP）

复刻有数云 `财税工作台` 的**记账与报表**能力，先落地最小可用版本。
**发票、申报（个税/增值税等）暂未实现**，但工具入口已保留并显式返回 `not_implemented`。

- 技术栈：Node.js（`node:sqlite` 内置，**零 npm 依赖**）+ 零构建网页
- 记账：复式借贷、凭证（草稿/过账/反过账）、期初余额、期间结账
- 报表：科目余额表（试算平衡）、资产负债表、利润表、**现金流量表**、明细账/总账
- 内部报表下载：上述五类支持中文 CSV、同口径预览，余额表与明细账区分期间期初 / 本期 / 本年 / 期末；仅含已过账范围。数据完整性仍未核实，CSV 不是税局申报文件，详见 [导出说明](../docs/REPORT-EXPORT.md)。
- **P1 会计闭环**：期末结转损益（3103→3104）、固定资产折旧/无形资产摊销计提
- **导入旧账**：JSON 或 4 张 CSV（账套/科目/期初/凭证），支持 GBK 中文 Excel，预检+事务
- 同时对外暴露：**网页 REST** 与 **Codex Agent 工具入口**（`/agent/tools/:name`）
- 可靠性：封账保护、平衡期初与写入原子性、新期间登记、明细汇总、零利润结转、折旧反向操作回归已覆盖。
- 全国电子税务局：已预留地区/能力目录、登录、人工验证、查询和退出接口；默认无真实适配器，见 [接口说明](../docs/TAX-INTEGRATION.md)。
- 税局浏览器导入（福建漳州，**RC-A0 第一步本机独立验收通过（15 套 496 项 + smoke 28/28、exit 0，代码验证 head `0293ed2`）；代码已提交（初轮 `866fc30` + 收尾修复 `0293ed2`）并开 PR [#19](https://github.com/huxiaoyang-code/youshu-fork/pull/19)，未合并、待跨成员复核（创建时为 draft，实时 draft/ready 以 GitHub 为准）**）：本机官方 Edge/Chrome 人工登录后只读识别企业列表并建/绑**空账套**（新建时载入标准科目表，但无期初/凭证）；企业列表 ≠ 财务数据，真实接入 0。合成测试已纳入统一入口（本机复跑 15 套 496 项、exit 0）。见 [接口概述](../docs/TAX-BROWSER.md) · [审查报告](../docs/REVIEW-TAX-BROWSER.md)。
- 定位：**本机单用户**工具，目标支持对多个企业 / 账套的批量处理（批量队列与管理尚待开发）；**不做多租户 / SaaS**。不同账套数据互相隔离。

## 本轮验收

RC-A0 已在统一入口纳入 tax-browser、tax-browser-security、tax-browser-lifecycle、tax-browser-ui、server-local-boundary 五套（合计 15 套）；本机管理者 2026-10-17 复跑 `npm test` **15 套 496 项、exit 0**（代码验证 head `0293ed2`；初轮 `866fc30` 为 481 项，属历史），`npm run test:smoke` **28/28、exit 0**；代码已提交（初轮 `866fc30` + 收尾修复 `0293ed2`）、PR #19 未合并、待跨成员复核。RC-B 新增独立金额测试：`node test/report-export.test.mjs`（21 项），覆盖五类 CSV 手算金额、跨月跨年、明细科目、结转/折旧、已过账范围、中文与公式防护。新 HTTP 与税局格式参考测试纳入统一入口。B2 的实际可上传申报文件与 RC-3 / RC-6 整体闭环尚未完成；详见 [RC-B 交接](../docs/handoffs/RC-B-REPORTS.md) 和 [税局格式证据](../docs/TAX-REPORT-FORMAT.md)。

在本目录运行 `npm test`，自动启动临时后端、临时账套，完成领域回归、MCP 与税务契约、导入到结账的闭环验收；`npm run test:smoke` 只运行原有冒烟测试。具体金额和能力边界见 [第一期验收](../docs/PHASE1-ACCEPTANCE.md)。

Git 合并不会自动更新内存中运行的后端或 MCP 服务；加载更新需重启相应进程。本轮自动验收没有操作现有业务库。

## 启动

```bash
cd 06-workbench
node server/server.mjs
# 打开 http://127.0.0.1:8787/
```

数据库文件：`06-workbench/data/workbench.db`（SQLite，WAL）。

```bash
npm run seed            # 空库时生成「已知可验收」的演示账套
npm run seed -- --force # 清空后重建（重置自增，账套 id 回到 1）
# 完全重置：停服务 → 删除 data/workbench.db* → npm run seed
```

## 网页功能

| 页签 | 说明 |
|---|---|
| 账套 | 新建账套（自动载入标准科目表）；**导入账套**（JSON / 4 CSV，预检+事务） |
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

GET    /api/import/templates                                          # 4 张 CSV 模板
POST   /api/import/parse         {texts:{meta,accounts,openings,vouchers}}  # 解析+预检
POST   /api/import/parse         {files:<base64 映射>, encoding:"gbk"}      # 也支持编码+base64
POST   /api/import/account-set   {payload, dryRun}                    # 导入（dryRun 默认预检）
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
| `legacy_book_import` | 导入旧账（默认 `dryRun=true` 仅预检；`payload` / `texts` / `files` / `paths`） |
| `update_plan` | 保存处理计划 |
| 其他（`invoice_*`/`declaration_query`/…） | 返回 `not_implemented` |

> 注：`carry_forward_profit` / `asset_*` / `depreciation_run` 为本复刻工程**扩展工具**（原站契约未包含），
> 已在本工作台与 MCP Server 注册；`05-reconstruction/catalog.json` 保留原站提取结果不变。

## 导入账套（旧账）

网页顶部 **↓ 导入账套**；也可用 Agent 工具 `legacy_book_import`。

### 方式 ①：一个 JSON 文件（最稳）

```json
{
  "account_set": { "name": "某某贸易有限公司", "taxpayer_type": "小规模纳税人",
                   "accounting_standard": "小企业会计准则", "start_period": "2026-01" },
  "accounts":          [ { "code": "1002", "name": "银行存款", "category": "资产", "direction": "debit" } ],
  "opening_balances":  [ { "code": "1002", "debit": 100000, "credit": 0 },
                         { "code": "3001", "debit": 0, "credit": 100000 } ],
  "vouchers":          [ { "period": "2026-01", "date": "2026-01-10", "word": "记", "number": 1,
                           "summary": "销售商品",
                           "entries": [ { "code": "1122", "debit": 11300, "credit": 0 },
                                        { "code": "5001", "debit": 0, "credit": 10000 },
                                        { "code": "2221", "debit": 0, "credit": 1300 } ] } ]
}
```

### 方式 ②：四张 CSV（Excel 另存为 CSV）

| 文件 | 列（带表头，顺序可识别中文名） |
|---|---|
| `账套.csv` | `键,值`（账套名称 / 纳税人性质 / 会计准则 / 启用期间） |
| `科目.csv` | `科目编码,科目名称,类别,方向`（类别：资产/负债/权益/成本/损益；方向：借/贷） |
| `期初余额.csv` | `科目编码,借方,贷方` |
| `凭证.csv` | `期间,日期,字号,凭证号,摘要,科目编码,借方,贷方`（一张凭证多行分录） |

- 支持 **UTF-8** 与 **GBK/GB18030**（中文 Excel 常见）；页面上选编码。
- 可点「下载 CSV 模板」拿到样例。
- 未在标准科目表中的编码会**自动新增**（如企业会计准则的 `6602 管理费用`）。
- 规则：期初借贷必须相等；每张凭证借贷必须相等；科目必须存在；预检失败**不会落库**。

### 严格校验（IMPORT-STRICT）

预检（`dryRun`）与正式导入**共用同一套约束**：预检通过后，正式导入不会再因同一静态约束（金额、期间、借贷、科目等）失败；预检本身不产生任何业务写入。

- **金额文本**：仅接受有限数字，或可带前导 `¥`/`￥`、正负号、千分位与小数的十进制文本（如 `1000`、`1,000.50`、`¥2,000`、`-0`）。**空白/缺失金额按 0 处理**；单元格为空白与“未填”等价。金额只允许 `number`/`string`/`null`/`undefined`，数组（如 `[100]`）、对象、布尔一律拒绝。
- **拒绝**：垃圾文本（`abc`）、部分可解析文本（`100元`、`12abc`、`1.2.3`、`1 000`）、`NaN`/`Infinity`、超出 `±999999999999.99` 的金额。**负号与超界都在四舍五入之前判定**：`-0.001` 这类极小负值不会被舍入成 `-0` 而漏过，`999999999999.994` 这类超界原值也不会因舍入进界内被接受。非法金额**不再按 0 吞掉**，即使借贷仍平衡也会报错。
- **归一化**：金额按四舍五入保留 2 位小数后写入。
- **日期**：凭证日期为 `YYYY-MM-DD`（真实日历日）或留空（落库时取 `期间-01`）；`2026/01/10`、`2026-02-30` 等被拒绝。同一张凭证的**每一行**原始日期都会被校验，同凭证内日期不一致会报错，不会只保留首行而漏掉后续行；日期与期间不在同一月份时给 `warnings` 提示但仍可导入。
- **期间**：启用期间与凭证期间必须为 `YYYY-MM` 且月份 `01-12`，凭证期间不得早于启用期间。
- **凭证号（CSV）**：合法缺省编号保持原契约（默认 `1`）；显式编号必须是安全正整数，`1oops`/`0`/`-1`/`1.5`/`1e3` 一律拒绝（不再被 `parseInt` 吞掉）。
- **CSV 逐行辅助字段**：解析器保留每行原始 `dates`（`date`）与 `numberRaw`（`number`），但原字段本体始终校验，辅助字段必须为数组/文本并与本体一致，不得覆盖或掩盖原字段的错误。
- **科目**：新增科目必须提供合法的方向（`debit`/`credit`）与类别（资产/负债/权益/成本/损益）；已在标准科目表中的编码会被跳过，不强制这两列以兼容历史输入。
- **账套 meta**：`name`/`taxpayer_type`/`accounting_standard`/`start_period` 的类型会被核对，对象/数组不会被 `String()` 成垃圾名称后写入 SQLite；错误时预检失败。
- **期初余额**：科目必须存在；金额不得为负；单行不得同时填借贷；**同一科目重复出现会直接报错**（数据库按期初科目覆盖写入，汇总与覆盖语义不同）；**单行两列都为 0 是允许的**（如仅用来占位），整体借方合计 = 贷方合计。
- **凭证**：至少两条分录；科目必须存在；金额不得为负；单行不得同时填借贷；**单行分录两列都为 0 会被拒绝**（与期初不同）；整张凭证借贷平衡。
- **形状**：`account_set` 必须是对象，`accounts`/`opening_balances`/`vouchers` 必须是数组且元素为对象，凭证 `entries` 必须是对象数组；集合缺失（`undefined`/`null`）按空处理，但显式给了错误类型必须报错，不会被静默丢弃。
- 错误信息带上下文（第几行 / 第几张凭证 / 第几条分录 / 哪个字段），便于直接定位原始数据。

### 命令行 / Agent

```bash
# 预检
curl -s -X POST http://127.0.0.1:8787/api/import/parse \
  -H 'content-type: application/json' \
  -d '{"texts":{"meta":"键,值\n账套名称,测试\n启用期间,2026-01\n","openings":"科目编码,借方,贷方\n1002,100,0\n3001,0,100\n"}}'

# Agent 一句话（默认仅预检，confirm 后落库）
# “把 D:/旧账/ 下的 4 个 CSV 导入成新账套” → legacy_book_import
```

> 用 **Codex 作客户端**完整复现（含示例数据与 Excel→CSV 转换），
> 见 [`../05-reconstruction/codex/README.md`](../05-reconstruction/codex/README.md) 的「本地复现：导入旧账」；
> 一键链路自测：`cd 05-reconstruction/codex/mcp/finance-mcp && node import-demo.mjs`。

## 会计口径（重要，可按需调整）

- 标准：《小企业会计准则》；科目表见 `server/coa.mjs`。
- 记账方向：资产/成本/费用借增；负债/权益/收入贷增。
- 余额 = 期初 + 启用期间至目标期间的**已过账**发生额。
- 资产负债表：`未分配利润 = 利润分配(3104) + 本年利润(3103) + 尚未结转的本年损益`
  （兼容“已结转/未结转”两种状态）。
- 利润表：本期金额 = 当期；本年累计 = 年初（或启用期间）至当期；**不含结转凭证**。
- 期末结转损益：损益科目余额 → `3103 本年利润`；`yearEnd` 时再 `3103 → 3104 利润分配`。
  结转凭证 `kind='carryforward'`，不计入利润表发生额，避免重复计算；同期重复结转被拒绝。
  年末结转与资产负债表同口径：`3103` 及其**下级明细**逐个科目转出到 `3104`，不静默只取根余额。
  期间登记（`ensurePeriod`）与凭证写入在同一保存点内，失败不留下新建的空期间。
- 折旧/摊销：直线法，`月计提 = 原值 × (1 − 残值率) ÷ 使用月数`；
  提足或未到计提期自动跳过；同一期间不会重复计提（`asset_depreciation_runs` 唯一约束）。
  折旧/摊销凭证重新过账时校验：`该资产其他已过账累计 + 本凭证计提 ≤ 可折旧额`；
  超出整单拒绝（`depreciation_exceeds_depreciable`，不部分过账），合法的未超额反过账/
  重过账与删除重算不受影响。
- 现金流量表：直接法——按货币资金（1001/1002/1012）对方科目分为经营/投资/筹资，
  并以与货币资金变动**勾稽**为校验；另附「净利润 → 经营活动净额」间接法补充资料。
- 现金流量表科目分类：投资含 1101/15xx/16xx/1701/1702/1801；
  筹资含 2001/2231/2232/2501/2701/3001/3002/310x；其余归经营。

## 未实现 / 后续 TODO

1. 发票：采集/查验/开票/红冲（`invoice_*`）。
2. 申报：增值税/附加税/企业所得税/个税（`declaration_query`、`tax_declaration_query`）。
3. 辅助核算（客户/供应商/部门/项目）、多币种。
4. 银行流水对账、导入旧账的**金蝶/用友专用格式**适配。
5. 打印/导出（PDF/Excel）。
6. 本机多账套批量任务队列与管理；账套隔离、操作日志、备份恢复、凭据安全（**不做多租户 / 权限平台**）。

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
