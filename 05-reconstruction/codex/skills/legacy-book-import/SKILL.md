---
name: legacy-book-import
description: 通过 JSON/CSV 导入历史账套、科目、期初余额与凭证；Excel 需先转换为 CSV。
---

# 导入旧账（legacy-book-import）

本文件描述本机 `finance-mcp` 分支**真实可用**的旧账导入方式与边界。字段与工具名以
`05-reconstruction/codex/mcp/finance-mcp/tools.mjs`、后端 `06-workbench/server/agent-tools.mjs`
和领域层 `06-workbench/server/accounting.mjs` 为准。详细 CSV 格式与示例见
`legacy-book-import/references/import-rules.md`。

## 何时使用

- 用户要把历史账套（账套信息 + 科目 + 期初余额 + 历史凭证）一次性导入，建立新账套；
- 用户已把旧账整理成本机 CSV/Excel（Excel 需先自行转 CSV）。

## 真实能力

- 工具：`legacy_book_import`（MCP）。输入支持：
  - `paths`：本机 4 个 CSV 文件路径 `{ meta, accounts, openings, vouchers }`（MCP 直接读盘，推荐同机使用）；
  - `texts`：4 段 CSV 文本 `{ meta, accounts, openings, vouchers }`；
  - `payload`：已解析对象 `{ account_set, accounts, opening_balances, vouchers }`；
  - `files`：4 段 base64 CSV（可配 `encoding`，如 `utf-8` / `gbk`）；
  - `meta`：覆盖账套信息 `{ name, taxpayer_type, accounting_standard, start_period }`；
  - `dryRun`：`true`（缺省）只预检，**必须显式 `dryRun=false` 才正式落库**。
- 导入内容：账套 + 科目（已存在的标准科目跳过）+ 期初余额 + 历史凭证（导入时按 `posted` 过账）。
- 返回：`{ dryRun, validation, created }`。预检时 `created=null`；正式导入时 `created` 含
  `id`、`name`、`start_period`、`accounts`、`opening_balances`、`vouchers`。
- `validation` 含 `ok`、`errors`、`warnings`、`summary`（行数统计）。

## 工作流

1. 先看 `finance_query_catalog` 与 `account_context`，确认目标账套尚未存在（正式导入会新建账套）。
2. **核对原始金额文本**：各 CSV 金额列应为合法有限数字，或可带 `¥`/`￥` 前缀、正负号、千分位与小数。
   非法或部分可解析文本（`abc`、`100元`、`12abc`、`1.2.3`、`1 000`、`NaN`/`Infinity`、超界）会被预检直接拒绝，
   不再按 0 静默处理；**空白/缺失金额按 0 处理**。预检报错时修正源文件后重试。
3. **默认预检**：`legacy_book_import({ paths })`（不带 `dryRun`）。检查 `validation.ok`、
   `summary` 与 `errors`/`warnings`。预检不落库，且与正式写入共用同一套约束。
4. 有 `errors` 时按上下文（第几行 / 第几张凭证 / 第几条分录 / 哪个字段）逐条修正源文件后重新预检；**不要**带着错误强行落库。
5. 确认原始数据与预检结果均无误后**显式**正式导入：`legacy_book_import({ paths, dryRun: false })`。
   预检通过后，正式导入不会再因同一静态约束（金额、期间、借贷、科目等）失败。
6. 导入后用 `finance_query` 核对：`enterprise_account.account_set`、
   `enterprise_account.subject_system.all`、`report.balance_sheet`（应平衡）、`report.income_statement`、
   `report.trial_balance`。

## 明确边界（不要承诺）

- **非幂等**：正式导入每次都会创建**新账套**，重复执行会产生重复账套；本地没有重复导入识别。
  失败后先查询核对（`account_context` / `finance_query`）再决定是否重试，不要盲目重跑。
- **Excel 需单独转换**：`.xlsx` 用仓库脚本 `05-reconstruction/tools/xlsx-to-csv.py` 先摊平成 CSV，
  再走导入；`.xls` 需先由用户自行转换。`exec` 工具在后端**未实现**，不能用它解析 Excel。
- **原站附件流程未接入**：`POST /api/attachments/raw-upload`、`finance_artifact_read` 等属于原站客户端行为，
  本地分支没有这套附件通道；不要把它当作"已接入的本地导入"。
- 不自动理解任意账表结构、不做列名语义映射之外的推断、不做金蝶/用友专用适配。
- 列名/方向/科目不合法时预检会报 `errors`；缺账套名称或启用期间会报错，不猜默认值。
- **严格校验已生效**：预检覆盖金额文本（垃圾/部分可解析/`NaN`/`Infinity`/超界/极小负值——负号与超界在四舍五入之前判定）、
  期间月份范围与不早于启用期间、日期格式与真实日历日（同一凭证每一行都校验，日期不一致报错）、
  凭证号（CSV **空白即缺省，保持默认 `1`**；JSON/对象调用**省略 `number` 则导入时自动取号**（`nextNumber`）；只要显式给出编号就必须是安全正整数）、单行双向、科目存在与新增科目的方向/类别，以及期初/凭证借贷平衡。
  期初同一科目重复出现直接报错；**期初单行两列都为 0 是允许的，而凭证单行分录两列都为 0 会被拒绝**。
  集合/元素形状与账套 meta 字段类型也会校验，显式错误类型不会被静默丢弃。
  非法金额文本不再被按 0 吞掉，即使借贷仍平衡也会报错。

## 参考

- `legacy-book-import/references/import-rules.md` — CSV 列定义、方向/金额规则、预检与失败处理
