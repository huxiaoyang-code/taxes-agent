# 内部报表 XLSX / PDF 导出（LOCAL-05a / Issue #45）

本文件描述**新增的独立导出模块** `06-workbench/server/report-office-export.mjs`。它复用 [REPORT-EXPORT](REPORT-EXPORT.md) 的稳定报表 DTO，为五类内部报表生成真实 XLSX / PDF，同时保留 CSV。

**当前状态：模块已实现、独立审查返工并通过员工合成自测，但尚未接入 HTTP / 前端，也未合并或验收。** 返工已修复两项独立 review 复现的 P2：PDF 超长首页元数据越界、XLSX 超过 Excel 单格上限仍成功生成；同时去除了重复尾注并避免尾注孤页。既有 `docs/REPORT-EXPORT.md` 仍描述“首版仅 CSV”，因为共享接线归 LOCAL01 #43；在接线完成前，用户不能通过页面或 `/api/.../export?format=xlsx|pdf` 使用本模块。

- 分支：`codex/huxiaoyang-code/local-05-office`
- 基线：`0c4e0dd622fc35bcb5d6e6af3620c6f971b2a805`
- Issue：#45（LOCAL-05a）；LOCAL-05 整体未完成。
- 合成验收产物：`06-workbench/tmp/report-office-qa/`（gitignored）。

## 使用

```js
import { buildOfficeExport } from "./server/report-office-export.mjs";

const file = await buildOfficeExport(accountSetId, {
  kind: "balance-sheet",       // balance-sheet | income-statement | cash-flow-statement | trial-balance | ledger
  period: "2026-01",           // 已登记 YYYY-MM
  format: "xlsx",              // csv | xlsx | pdf
  code: "1002",                // 仅 ledger 必填
});
// file = { filename, contentType, body, report, pageCount?, font? }
```

- `format: "csv"`：直接委托 `buildReportExport`，返回既有字符串 `body` 与同一 `report`，行为不变。
- `format: "xlsx" | "pdf"`：先调用 `buildReportExport(..., { format: "csv" })` 完成全部校验并取得 DTO，再生成 `Buffer`；不重算会计金额。
- 纯格式化入口：
  - `buildReportDocument(report)` → 与两种格式共用的文档模型（标题、元数据、限制、分节、列、行、脚注）。
  - `buildReportXlsx(report, document?)`、`buildReportPdf(report, document?)`。
- 便于测试 / 接入的常量：`OFFICE_FORMATS`、`OFFICE_REPORT_KINDS`。

## 数据与口径

金额、期间、空账、完整性、限制和勾稽检查全部来自 `report` DTO（`schemaVersion: 1`）。导出层不做以下行为：

- 不查询或改写账簿，不补造零金额或缺失数据；
- 不改变现金流比例分摊、间接法末行复用直接法经营净额等既有算法；
- 不把完整性从 `unverified` 改成已核实，不把内部报表标成税局申报模板。

每种报表的列含义：

| 报表 | 列 |
|---|---|
| 资产负债表 | 项目、期间期初（上期末）、期末；分“资产”“负债和所有者权益”两节，附两期平衡检查。 |
| 利润表 | 项目、本期发生（所选期间）、本年累计（自 `scope.yearStart` 起）；净利润 / 营业利润 / 利润总额加粗。 |
| 现金流量表 | 项目、对方科目编码、本期发生、本年累计；经营 / 投资 / 筹资分节、净额、现金期初 / 期末 / 变动、勾稽检查、间接法补充（明确标注非独立勾稽）。 |
| 科目余额表 | 科目编码、科目名称、方向、期初借贷、本期借贷、本年借贷、期末借贷（11 列）；每科目仅自身发生额，合计行注明“不含父级重复汇总”；附四口径试算检查。 |
| 明细账 | 汇总：期间期初 / 本期发生 / 本年累计 / 期末余额（借贷）；逐笔：日期、凭证字、凭证号、凭证 ID、分录 ID、科目编码、科目名称、摘要、借方、贷方、余额（借减贷）。 |

元数据与限制在文件开头明确列出：账套名称、账套 ID、准则登记值、期间与起止日期、本年累计起点、金额单位“人民币元”、数据范围（仅建账期初及已过账凭证）、完整性“未核实”、空账标记、非税局申报文件；所有 `warnings` 原样展示。

### 文本长度上限（XLSX 与 PDF 共用）

Excel 官方规定单个单元格最多 32,767 字符；超过后 Excel 会修复 / 拒绝工作簿。为避免生成 ExcelJS 自读能打开、Excel 却修复的文件，导出层在写入任何字节前统一校验文档模型中的所有最终文本字段：

- 账套名称、会计准则、标题、副标题；
- 元数据标签 / 值、限制代码 / 说明；
- 节标题、列标题、所有文本单元格（科目名、摘要等）、尾注。

任一字段超过 **32767 字符**时抛 `office_text_too_long`，`details` 包含受控字段定位 `field`（如 `accountSet.name`、`sections[1].rows[0].cells[7]`）、`length`、`limit`，行号与列名（如 `column: "摘要"`）；**不回显原始文本**。不静默截断，也不拆成续行复制金额。CSV 由既有 `report-export.mjs` 输出，不受此格式层上限约束。

PDF 在 32767 字符以内完整逐行分页：首页标题、副标题、每个元数据字段、限制框、表格行和尾注都按页面剩余高度切分；单个字段超过一页时续排到后续页面，绝不绘制到页边距外。

## XLSX 实现

- ExcelJS 生成真实 `.xlsx`（zip + OOXML），单工作表，中文表名。
- 财务字段写为**数值单元格**并应用 `#,##0.00`；文本字段为字符串并显式 `@` 文本格式，避免公式执行。
- 摘要、科目名、账套名的公式注入样例（`=1+1`、`+SUM(...)`、`@...`）保持原文文本；测试遍历工作簿确认无公式单元格。
- 冻结主明细表头（`views.ySplit`），打印时重复该表头（`printTitlesRow`），打印范围限制为 `A1:<末列><末行>`；A4，11 列报表横向、其余纵向；`fitToWidth: 1`、水平居中、页脚 `第 &P 页 / 共 &N 页`。
- 列宽按报表设置；对换行文本按中英文宽度估算行高，避免打开时文本被默认行高遮挡（Excel 行高上限 409pt；接近 32767 字符的极端摘要仍完整存储在单元格中，屏幕 / 打印显示可能需手动调整行高，但不会截断数据）。
- 每个最终文本单元格都校验 ≤32767 字符；超限拒绝而不是让 Excel 静默修复。
- 表头、合计行、分段标题与限制行有独立样式，便于财务阅读。

## PDF 实现

- PDFKit 直接绘制 A4 PDF，不使用浏览器打印或 HTML 转 PDF。
- 中文字体以**嵌入字体子集**写入（`/FontFile2`），不使用未嵌入的 Helvetica；缺字时抛出 `pdf_font_glyph_missing`，不以方框代替中文。
- 首页含大标题、账套 / 期间 / 币种副标题、元数据、限制提示框；续页重复标题、期间和当前表格列头。
- 列宽按每节列数分配最小宽度；资产负债表 / 利润表 / 现金流量表默认纵向，11 列余额表与明细账自动横向。
- 文本按实测宽度自动换行；单个超长行若超过当前页剩余高度，会跨页续排（重复表头）而不是截断；首页标题、副标题、元数据、限制框与尾注同样分页，单个元数据字段再长也不会越界。
- 尾注与 `warnings` 去重：已由限制框完整表达的通用提示不再作为尾注重复；最后一节会预留尾注高度，使尾注落在最后一块内容同页，避免只剩重复尾注的孤页。空账、完整性、现金流限制与明细账“余额（借减贷）/ 负数表示贷方余额”说明仍保留。
- 金额右对齐并带千分位两位小数；负数保持数值来源，不做颜色或符号改写。
- 限制：PDF 1.3、未加密、未做无障碍 tagged PDF；这些不影响内部报表阅读，但不属于申报文件。

## 字体

运行时必须有可嵌入的中文字体，字体文件**不入 Git**。

默认探测（存在即尝试）：

1. `%SystemRoot%\Fonts\simsun.ttc`，字体族 `SimSun`；
2. `%SystemRoot%\Fonts\simhei.ttf`；
3. `%SystemRoot%\Fonts\Deng.ttf`；
4. 非 Windows 常见 Noto Sans CJK / PingFang 路径。

显式配置：

- `REPORT_PDF_FONT`：字体文件路径。设置后只使用该文件；文件不存在或无法嵌入会抛 `pdf_font_unavailable`。
- `REPORT_PDF_FONT_FAMILY`：TTC 集合的族名（如 `SimSun`）。不设置时按字体文件默认族解析。

若当前字体缺少待输出字符，导出抛 `pdf_font_glyph_missing` 并列出缺失字符及配置提示；不会静默画方框。`msyh.ttc` 的族名 `Microsoft YaHei` / `Microsoft YaHei UI` 在 pdfkit 0.20.2 本机验证中不被识别，因此不是默认候选。

## 依赖与安装

产品运行依赖：

- Node.js `>=22.5.0`（`06-workbench/package.json` 既有 `engines`）。
- npm 包（精确锁定，已写入 `package-lock.json`）：
  - `exceljs@4.4.0`
  - `pdfkit@0.20.2`
- 可嵌入的中文字体（见上节）。

选择理由：ExcelJS 是成熟的 OOXML 写入库，原生支持数值单元格 / 文本类型、数字格式、冻结窗格、打印标题与打印区域；PDFKit 支持 TTF / TTC 字体嵌入与子集化、文本宽度测量，适合在服务端直接生成正式 PDF。PDFKit 内置表格未用于本模块，因为跨页重复表头、超长行续排和“不裁切”需要自定义布局控制；当前实现使用其底层绘制能力自行排版。两者均为纯 Node 运行时依赖，不启动浏览器或外部打印进程。

在 `06-workbench` 执行常规安装即可；不修改全局 npm 配置、不执行安装器：

```text
npm install
```

本任务安装时使用 `npm install --save-exact --ignore-scripts exceljs@4.4.0 pdfkit@0.20.2`。`node_modules/` 由 `.gitignore` 排除，`package-lock.json` 应与 `package.json` 一同提交。测试脚本：`npm run test:office-export`。

Poppler（`pdfinfo` / `pdftoppm`）与 Python + pdfplumber 仅用于**验收检查**，不是产品运行依赖；缺少时测试会明确跳过对应外部检查，不影响模块运行。

## 错误码

| 错误码 | 触发 |
|---|---|
| `report_options_invalid` | 选项不是对象（含 `null`、数组）。 |
| `report_kind_unsupported` | 报表类型不在五类内（来自上游校验）。 |
| `report_format_unsupported` | 格式不是 `csv` / `xlsx` / `pdf`。 |
| `account_set_not_found` / `period_required` / `period_invalid` / `period_before_start` / `period_not_registered` | 与 `report-export.mjs` 相同的账套 / 期间校验。 |
| `account_code_required` / `account_not_found` | 明细账缺科目或科目不存在。 |
| `report_data_invalid` | DTO 含 NaN / Infinity 等非有限金额，拒绝输出伪金额。 |
| `office_text_too_long` | 任一最终文本单元格 / PDF 单字段超过 32767 字符；`details.field` 定位字段、`length` / `limit` 给出长度，不回显原文。 |
| `pdf_font_unavailable` | 没有可嵌入中文字体、显式字体路径不存在，或文件无法作为字体嵌入。 |
| `pdf_font_glyph_missing` | 字体缺少输出所需字符；`details.characters` 列出缺失字符（截断前 40 个）。 |

所有错误在返回文件前抛出，不返回半成品附件。

## 验收证据（员工自测）

工作目录 `06-workbench`，临时合成库；不含真实账套或凭据。

| 命令 | 结果 |
|---|---|
| `npm run test:office-export` | 20/20 通过，退出码 0 |
| `REPORT_OFFICE_PYTHON=<验收 Python> npm run test:office-export` | 20/20 通过；pdfplumber 检查 11 个 PDF（43 页）无文字重叠、无越界 |
| `node test/report-export.test.mjs` | 21/21 通过 |
| `node test/report-export-http.test.mjs` | 29/29 通过 |
| `node test/smoke.test.mjs` | 28/28 通过 |

覆盖要点：

- 五类报表 XLSX 均以 ExcelJS 重新打开，检查金额为数值、`#,##0.00`、冻结表头、打印区域 / 重复表头、列宽、横向 / 纵向。
- 五类 PDF 均检查 `%PDF-`、页数、嵌入字体、无 Helvetica、可提取中文标题 / 金额 / 页脚；长账套名、长科目名、230 行明细生成 19 页 PDF，每页重复表头与页码，230 条摘要全部可提取。
- 单行 2,000+ 字超长摘要跨页续排为 4 页，前后段标记与全部字符可提取，XLSX 单元格保存完整原文；最后一页仍有明细表头与尾注，不是孤页。
- 4,000 字中文账套名 PDF 为 5 页、3,000 字无断词 ASCII 名称 4 页、4,000 字明细账科目名 3 页；pdfplumber 越界 0，全部字符可提取。
- 单格 32767 字摘要通过并完整保存；32768 与 40,000 字摘要、40,000 字账套名在 XLSX / PDF 均以 `office_text_too_long` 拒绝，错误含字段定位且不回显原文；1 元明细账的 5 个金额单元格无续行重复。
- 独立手算金额（2026-01 / 2026-02）与 DTO、XLSX 单元格对应；草稿 / 反过账不入表。
- 公式注入样例保持文本；PDF 中动态文本不执行。
- 缺字体、非字体文件、缺字、未知格式、未登记期间、缺科目、非法账套均验证失败路径；空账提示在 XLSX / PDF 均保留。

**未完成的人眼目视：** 员工侧无图像识别能力，PNG 已由 `pdftoppm` 渲染到 `06-workbench/tmp/report-office-qa/`，自动几何检查通过，但“版式观感无缺陷”需管理者目视确认后才能声明。

## 未接线与后续

- 未修改 `report-export.mjs`、HTTP 路由、前端、`docs/REPORT-EXPORT.md`、`scripts/test-all.mjs` 或公共索引。
- LOCAL01 #43 / 管理者接线时应：
  1. 在导出接口按 `format` 选择 `buildOfficeExport`，保留既有 CSV 错误契约；
  2. 设置正确的 `Content-Type` 与安全文件名（模块已返回）；
  3. 更新面向用户的导出文档与页面提示；
  4. 用真实 HTTP 下载做接口验收（仍使用合成账套）。
- 复杂现金流分类、间接法独立勾稽、双准则官方映射、来源完整性属于后续核心任务；本模块只保留限制提示，**不声称这些问题已修复**。
