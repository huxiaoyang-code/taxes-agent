# 内部报表导出 · RC-B-REPORTS

本包交付五类内部 CSV：资产负债表、利润表、现金流量表、科目余额表、明细账。报表只读取现有账簿，包含建账期初及已过账凭证；草稿、反过账凭证不进入金额。CSV 不是税局申报文件，下载成功也不证明账套来源完整或符合目标准则。总体任务及尚未完成的 B2、RC-3、RC-6 见 [交接](handoffs/RC-B-REPORTS.md) 与 [闭环方案](REPORT-CLOSURE-PLAN.md)。

## 使用与文件格式

在报表页选择账套和已登记期间，选择报表后下载 CSV；明细账还需选择科目。程序接口：

```text
GET /api/account-sets/:id/reports/:kind/export?period=2026-01&format=csv
GET /api/account-sets/:id/reports/ledger/export?period=2026-01&format=csv&code=1002
GET /api/account-sets/:id/reports/:kind/export-data?period=2026-01&code=1002
```

`kind` 为 `balance-sheet`、`income-statement`、`cash-flow-statement`、`trial-balance`、`ledger`。`export-data` 用于与下载一致的页面预览，原报表 REST 接口保留兼容；老接口的余额表发生额和明细账范围不能直接解释为本期发生额。

CSV 使用 UTF-8 BOM、CRLF、中文标题、金额两位小数。文件按元数据、限制、试算检查和报表主体分节，不是单一矩形数据导入模板。文本使用双引号及双引号转义；危险的公式文本（含前导空白、制表符等）加单引号，内部生成的负数金额仍为数值。文件名以报表类型、账套 ID、期间和可选科目编码组成，不携带账套名称。首版仅支持 CSV；Excel/PDF 尚未实现。

## 金额与范围

| 报表 | 明确口径 |
|---|---|
| 资产负债表 | 期间期初为上期末；期末为所选期末。复用现有三表算法；附两期平衡标志。|
| 利润表 | 本期发生、本年累计；损益结转凭证不重复计入收入费用。本年从当年 1 月或更晚的启用期间开始。|
| 现金流量表 | 本期与本年分类及净额；年累计相加各月流量，现金期初/期末取区间边界，不相加余额。附余额变动勾稽和比例分摊限制。|
| 科目余额表 | 每个科目的自身金额各一行，含父级直接记账和明细科目；不叠加重复的父级汇总。期间期初、本期借贷发生、本年借贷发生、期末借贷余额及合计齐全。|
| 明细账 | 本科目及编码前缀下级的所选月份逐笔记录，期间期初、本期、本年、期末汇总；记录含真实科目编码、凭证 ID、分录 ID，余额按借减贷表示。|

期间期初 = 建账期初 + 启用日至所选月前的已过账净发生额。本年累计不包含建账期初；年中启用时标记 `partial_year`，不会虚构启用前业务。余额表发生额包含已过账结转凭证，利润表和现金流按原核心规则排除结转凭证，二者用途不同。

未登记期间不被自动创建，封账期间可只读导出。`empty` 仅表示查询范围内无非零建账期初和已过账凭证，**不是已确认没有业务**。现阶段完整性始终为 `unverified`，不能将缺失来源或缺失期间解释为合法零业务。

## DTO 与错误契约

模块 `06-workbench/server/report-export.mjs` 导出：

```js
buildReportExport(setId, { kind, period, format = 'csv', code })
// => { filename, contentType, body, report }
```

`report` 版本为 `schemaVersion: 1`：

| 字段 | 说明 |
|---|---|
| `kind`, `period` | 已验证报表类型、YYYY-MM 期间。|
| `accountSet` | `id`, `name`, `startPeriod`, `accountingStandard`；准则是登记值，不是认证结果。|
| `scope` | `status: 'posted'`, `periodStart`, `yearStart`（日期字符串）及 `periodStatus`。|
| `dataStatus` | `empty`, `completeness: 'unverified'`, `taxFilingReady: false`。|
| `warnings` | `{code,message}[]`，包括完整性、内部用途、映射未知，必要时空账、年中启用及现金流算法限制。|
| `checks.trialBalance` | `opening/current/ytd/closing` 各有 `balanced/debit/credit/difference`。|
| 其他 `checks` | 资产负债表期初/期末平衡；现金流本期/本年勾稽；`indirectIndependent: false`。|
| `data` | 资产负债表原结构加 `opening`；利润表 `current/ytd`；现金流原结构加 `ytd`；余额表 `period/lines/totals`；明细账见下。|

余额表每行有 `code/name/category/direction` 与 `opening_debit/opening_credit/period_debit/period_credit/ytd_debit/ytd_credit/closing_debit/closing_credit`。明细账为 `code/name/direction/period`、四口径 `{debit,credit}` 及 `items`；逐笔字段为 `entry_id/voucher_id/period/voucher_date/word/number/code/name/summary/debit/credit/balance`，按日期、凭证号、凭证 ID、分录顺序排序。

错误在生成文件前抛出，HTTP 返回结构化 JSON，不返回半成品附件：

| 错误码 | 含义 |
|---|---|
| `report_options_invalid` | 模块参数不是选项对象。|
| `account_set_not_found` | 账套不存在或 ID 非法。|
| `period_required` / `period_invalid` | 期间缺失或不符合合法 YYYY-MM。|
| `period_before_start` / `period_not_registered` | 早于启用期间 / 期间未登记。|
| `report_kind_unsupported` / `report_format_unsupported` | 报表类型 / 格式不支持。|
| `account_code_required` / `account_not_found` | 明细账科目缺失 / 不存在。|
| `report_data_invalid` | 账簿计算结果含非有限金额；拒绝输出 NaN、Infinity 或 JSON null 伪金额。|

## B0 独立金额样例

全部为合成资料，单位元。预期值直接按下列业务手算，测试不调用核心报表作为预期值生成器：

1. 2025-12 期初：银行父科目 1,000、银行子科目 200、固定资产 1,200，实收资本 2,400。12 月收现收入 300、支付管理费用 60，损益结转并年末转入未分配利润 240。
2. 2026-01：子科目收现收入 400；同一凭证借存货 120、固定资产 180，贷银行 300；支付管理费用 50；期初设备直线折旧 100（1,200 / 12，残值 0）。新增设备 180 未建卡，仅用于验证总账金额，不能据此推导其折旧已完整。
3. 2026-02：子科目收现收入 200、银行支付管理费用 20。本例只录入一月折旧，二月没有补计；这是已记账范围的报表样例，不是两个月资产计提完整性验收。

| 手算指标 | 2025-12 期末 | 2026-01 期末 | 2026-02 期末 |
|---|---:|---:|---:|
| 货币资金 | 1,440 | 1,490 | 1,670 |
| 固定资产净额 | 1,200 | 1,280 | 1,280 |
| 存货 | 0 | 120 | 120 |
| 资产 / 权益总额 | 2,640 | 2,890 | 3,070 |
| 当月净利润 | 240 | 250 | 180 |
| 当年累计净利润 | 240 | 250 | 430 |
| 当月经营现金净额 | 240 | 230 | 180 |
| 当月投资现金净额 | 0 | -180 | 0 |

二月银行父科目自身：期初借 890、本月贷 20、本年贷 370、期末借 870。子科目：期初借 600、本月借 200、本年借 600、期末借 800。父级明细账汇总两者，期初 1,490、当月借 200/贷 20、年累计借 600/贷 370、期末 1,670。所有关键数值同时验证 DTO 和下载 CSV，金额验证不止“下载 = 页面”。

## 已核实的核心边界与后续责任

| 事实与源码依据 | 本包处理 | 剩余工作 |
|---|---|---|
| `createAccountSet` 始终加载同一 `COA`，准则字段未切换科目表。| 输出登记准则并警告映射未核实。| RC-3 明确目标准则并验证相应科目、行次。|
| `balanceSheet` 按本地前缀归并，`incomeStatement` 按名称/前缀及其他收支兜底。| 复用算法，独立验证本例关键金额，不宣称完整官方映射。| RC-3 / B2 核对官方行次和全部目标业务。|
| `cashFlowStatement` 以现金净变动按对方科目绝对金额比例分摊。| 保留并显式警告；简单同向混合采购已独立验证。| 复杂双向混合凭证分类仍可能失真，即使总额勾稽通过。|
| 间接法末行直接使用直接法经营净额。| `indirectIndependent: false`，CSV 同样标明。| RC-3 实现、核验真正独立的间接法勾稽。|
| 建资产卡片不生成购买凭证，卡片与总账无自动一致性校验。| 验证建卡不增加总账资产、折旧过账/反过账影响恰为 100。| RC-3 补齐卡片与总账及连续期间计提完整性。|
| 缺少来源完整性/连续期间证明。| 保留 `unverified`，空账不会标“完整”。| RC-2 / RC-3 / RC-6 串接来源证据、完整性门槛和连续期间闭环。|

现金流反例：借银行 100、借固定资产 60、贷借款 160，原比例法可能把 100 分成投资流入 27.27、筹资流入 72.73。这种分配不能从混合凭证推导真实现金对应关系；测试只证明净变动为 100 并有显式警告，**不把该分类当正确会计结论**。缺口记录不是 RC-3 完成证据。

税局模板的官方来源、已核实的法定结构和未核实的真实上传格式单列在 [TAX-REPORT-FORMAT](TAX-REPORT-FORMAT.md)。B2 仍未完成；当前拒绝声称可申报的输出只是保护措施，不能代替合法成功路径和实际格式验证。

## 验证

在 `06-workbench` 运行 `node test/report-export.test.mjs`。该套 21 项测试在本轮 Subagent 自验全部通过；临时库通过 `WORKBENCH_DATA_DIR` 隔离，在退出时关闭并清理，不使用真实数据。涵盖跨月/跨年、父子科目、贷方余额、年中启用、已过账范围、年结/折旧、混合现金流、五类 CSV 金额、中文/公式防护、空账、异常请求、封账只读、账套隔离、失衡信号及非有限金额拒绝。完整回归和 HTTP 下载结果由管理者在待提交版本复验并登记 [交接](handoffs/RC-B-REPORTS.md)。
