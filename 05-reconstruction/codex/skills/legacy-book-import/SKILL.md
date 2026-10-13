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
2. **先核对原始金额文本**：逐项确认各 CSV 金额列是合法数字（允许千分位与 ¥/￥ 前缀）。
   非法或空白的金额文本会被**静默按 0 处理**，且不一定触发借贷不平衡；发现非法金额必须先修复源文件，
   即使此时借贷仍平衡也不得继续导入。
3. **默认预检**：`legacy_book_import({ paths })`（不带 `dryRun`）。检查 `validation.ok`、
   `summary` 与 `errors`/`warnings`。预检不落库。
   **注意：预检只覆盖名称/期间格式、科目字段、期初与凭证借贷平衡等，不等于完整校验**
   （不校验月份范围、金额负数、单行同时填借贷、非法金额文本等），预检通过**不构成**可正式导入的保证。
4. 有 `errors` 时逐条修正源 CSV 后重新预检；**不要**带着错误强行落库。
5. 确认原始数据与预检结果均无误后**显式**正式导入：`legacy_book_import({ paths, dryRun: false })`。
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
- **预检通过 ≠ 可正式导入**：预检不校验月份范围、负数、单行双向、非法金额文本；预检成功只说明已覆盖项通过，
  仍需人工核对源数据。
- **非法金额不保证被检出**：非法金额文本被按 0 静默处理，借贷仍可能平衡，不能依赖不平衡报错兜底。

## 参考

- `legacy-book-import/references/import-rules.md` — CSV 列定义、方向/金额规则、预检与失败处理
