# 内部报表 XLSX / PDF 导出（LOCAL-05a / Issue #45）

本文件描述**新增的独立导出模块** `06-workbench/server/report-office-export.mjs`。它复用 [REPORT-EXPORT](REPORT-EXPORT.md) 的稳定报表 DTO，为五类内部报表生成真实 XLSX / PDF，同时保留 CSV。

**当前状态（2026-10-22 接线阶段 + 最小接线回归修复）：模块已随 PR #52 合并（merge `257f96275031eefa484699dd71bd012e2d221e51`，源码最终 `2681df1`；管理者与独立 reviewer 各 21/21，含 11 个 PDF 的 pdfplumber 几何检查，原 11 PDF / 43 页已全部目视检查）。当前分支 `codex/huxiaoyang-code/local-05-wire` 基于该 merge，已完成**页面格式选择与下载校验**、**真实 HTTP 黑盒测试**、**`server.mjs` 报表导出路由的最小挂载**（`await buildOfficeExport` + 固定错误映射，不新增框架）、**两条路由契约回归修复**（附件真实支持 XLSX；`/export-data` 恢复原严格 CSV 格式契约）和文档（原三份，本轮再把追加所有权的 `docs/REPORT-EXPORT.md` 一并修正为四份）。挂载后 `node test/report-office-http.test.mjs` 在**真实 `server/server.mjs`** 子进程上实跑 **6/6 通过、exit 0**；`node test/report-export-http.test.mjs` 现为 **31/31 通过、exit 0**（旧的 `format=xlsx` 必须 400 断言已换成真正不支持的 `yaml`，并新增两条路由契约回归）。准备阶段的“临时替身 6/6”只是历史旁证，不作为验收证据。已提交为 `71894a1`（分支 `codex/huxiaoyang-code/local-05-wire`），**未建 PR / 未合并，尚未合入 LOCAL02**。独立审查已完成：在该 head 上实跑 `report-office-http` 6/6、`report-export-http` 31/31 均 exit 0；页面脚本探针与 root 在真实页面点击三格式均触发下载（探针 / 页面都不是保存位置检查，也未新增 PDF 几何）。`scripts/test-all.mjs` 仍归 LOCAL02 #47，新套件尚未进入统一入口。

返工已修复两项独立 review 复现的 P2：PDF 超长首页元数据越界、XLSX 超过 Excel 单格上限仍成功生成；同时去除了重复尾注并避免尾注孤页。`docs/REPORT-EXPORT.md` 所有权已追加到 Issue #45，本轮已按当前事实修正（原文“首版仅 CSV”改为历史表述），无需再由其他变更代同步。

- 模块分支：`codex/huxiaoyang-code/local-05-office`（已随 PR #52 合并；模块源冻结 `9f585d0`，纯 DTO 无副作用修改 `1e11d1c`，源码最终 `2681df1`）。
- 接线阶段分支：`codex/huxiaoyang-code/local-05-wire`，基于上述 merge `257f962`（在本分支上不另做模块实现，只在报表导出路由做最小挂载）。
- 原始基线（分叉时）：`0c4e0dd622fc35bcb5d6e6af3620c6f971b2a805`
- Issue：#45（LOCAL-05a）；LOCAL-05 整体未完成：模块已合并，**HTTP / 页面接线已在本分支实现并完成独审（`71894a1`），未建 PR / 未合并**。
- 合成验收产物：`06-workbench/tmp/report-office-qa/`（gitignored）。

既有验收事实分两类，不可混用也不可互相否定：

- **旧模块源码 `9f585d0`（渲染逻辑未变）**：根管理者实跑模块测试 20/20、独立 reviewer 20/20，无剩余阻塞；pdfplumber 检查 11 个 PDF 共 43 页文字重叠 0 / 越界 0；根管理者**已实际渲染 11 个 PDF（43 页）并检查全部 5 张 contact sheet**，确认中文、分页、表格可读、无视觉阻塞——视觉检查已完成，不是待办。渲染输出在 `06-workbench/tmp/report-office-full-qa-v2`（gitignored）。
- **当前纯 DTO 修改（`1e11d1c` 内容，只改为动态 `import` 并新增隔离回归，不改渲染）**：根管理者在该提交内容上实跑 `REPORT_OFFICE_PYTHON=<验收 Python> npm run test:office-export`，**21/21 通过、exit 0**，并明确输出 `pdfplumber geometry verified for 11 PDFs`。

既有视觉 / 几何证据覆盖的是**未改变的渲染逻辑**；本次新增隔离回归证明的是**纯 DTO 导入不打开数据库**。两者各自成立，不因文档或无关基线更新而失效。

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

## 接线：页面格式选择与真实 HTTP 黑盒测试（2026-10-22）

本阶段改动页面、测试与导出路由（`server.mjs` 仅导出路由与错误映射，其他路由 / 中间件 / 启停逻辑未动；`scripts/test-all.mjs` 仍归 LOCAL02 #47）：

- 页面 `06-workbench/public/index.html` / `public/app.js`：五类报表下载增加中文格式选择（CSV 表格 / Excel 工作簿 / PDF），按钮改为“下载报表”。`downloadReport()` 按所选格式传 `format`，保存前逐项校验：
  - `Content-Type` 与所选格式一致（`text/csv; charset=utf-8`、`application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`、`application/pdf`）；
  - `Content-Disposition` 的 `filename*` 解码后扩展名与所选格式一致（无 `filename*` 时退回本地 `<kind>-<period><扩展名>`）。**UI 未实现 `filename` 与 `filename*` 的同名比对**：只校验实际采用的 `filename*` 扩展名；两边响应头一致性由 HTTP 套件断言，不为迁就文档而扩展 UI；
  - `Content-Length` 与实际字节数一致；
  - 文件魔数真实（CSV 的 UTF-8 BOM、XLSX 的 `PK\x03\x04`、PDF 的 `%PDF-`）。
  任一项不满足即取消保存，因此 HTML / JSON 错误页不会被当成 xlsx 保存；错误提示使用固定中文文案，**不展示内部堆栈或字体绝对路径**。
- 预览仍走 `/export-data`（报表 DTO + 页面表格），下载与预览保持分离，预览不会生成 PDF，也**不会为纯 DTO 生成 xlsx / pdf 附件**。
- 新增 `06-workbench/test/report-office-http.test.mjs`：在临时 `WORKBENCH_DATA_DIR` 下启动**本包自己的** `server/server.mjs` 子进程（`PORT=0` 随机回环端口），用合成账套 / 期初 / 已过账与未过账凭证，通过真实 HTTP 覆盖五类报表 × CSV / XLSX / PDF；XLSX 用 ExcelJS 重开并比对独立手算金额，PDF 独立解析 ToUnicode 与文本流并用 `pdfinfo` 核对页数，CSV 校验旧语义（BOM、中文、行内容）。它不是 mock `buildOfficeExport`，也不以“源码里出现 format”冒充真实调用。
- `06-workbench/server/server.mjs`：下载路由 `await buildOfficeExport(setId, { kind, period, format, code })`，`format` 取 `csv | xlsx | pdf`（缺省 `csv`）；`export-data` 保持**原严格格式契约**——缺省或 `format=csv` 返回同一 CSV DTO，`xlsx` / `pdf` / `yaml` / 空 `format=` 仍以 400 `report_format_unsupported`（`details: {supported:["csv"]}`）拒绝，**不把无效输入静默转成 CSV、也不生成 Office 附件**；只有生成成功后才写响应头，`Buffer` 原样输出 / 字符串按 UTF-8 转 `Buffer`，使用模块返回的 `contentType` / `filename` 与既有 `attachmentName()`，保留 `nosniff` / `no-store`；错误经一个固定映射函数处理。
- **实测全绿**：挂载后 `node test/report-office-http.test.mjs` 为 **6/6 通过、exit 0**（准备阶段实际为 3/6 红，其失败码与计数仍保留作历史记录，见下文）。

运行方式：`cd 06-workbench && node test/report-office-http.test.mjs`。该测试自建临时目录与子进程，结束时删除临时库；不连接旧后端、税局服务或真实账套。

### 已实施的挂载语义（不新增通用 HTTP 框架）

1. 下载路由把 `format` 原样传给 `await buildOfficeExport(setId, { kind, period, format, code })`（`csv | xlsx | pdf`，缺省 `csv`）；`export-data` 预览保持原严格 CSV 格式契约（缺省 / `csv` 返回 DTO，其余格式 400 `report_format_unsupported`），不生成 Office 文件。
2. 只有 `buildOfficeExport` **成功返回后**才写响应头；`body` 为 `Buffer` 时原样输出，字符串按 UTF-8 转 `Buffer`；`Content-Type` / `Content-Length` / `Content-Disposition` 使用模块返回的 `contentType` / `filename` 与既有 `attachmentName()`，并保留 `x-content-type-options: nosniff` 与 `cache-control: no-store`。
3. 错误固定映射（已在 `server.mjs` 实现，不把字体路径、内部信息或堆栈返回给用户）：

| 错误码 | HTTP | 返回 |
|---|---|---|
| `report_options_invalid`、`period_required` / `period_invalid` / `period_before_start` / `period_not_registered`、`report_kind_unsupported`、`report_format_unsupported`、`account_code_required` | 400 | 原错误码 + 既有 `details`（`/export-data` 的 `report_format_unsupported` 固定为 `{supported:["csv"]}`，与接线前契约一致） |
| `account_set_not_found`、`account_not_found` | 404 | 原错误码 |
| `report_data_invalid` | 422 | 原错误码 |
| `office_text_too_long` | 422 | 原错误码；`details` 只保留 `{field,length,limit}`（模块层的行号 / 列名补充定位不向客户端返回），不回显原文 |
| `pdf_font_unavailable`、`pdf_font_glyph_missing` | 500 | 原错误码 + 固定中文文案，`details: null` |
| 其他未预期错误 | 500 | `report_export_failed`，`details: null` |

4. 失败必须是 JSON 且**没有 `Content-Disposition`**；成功必须是完整文件，不能出现半截附件。

## 导入无副作用（纯 DTO 渲染）

`report-export.mjs` 以**静态导入**方式依赖 `db.mjs`，而 `db.mjs` 在模块加载时就会打开（必要时创建）默认 `workbench.db` 并执行迁移。若本模块也在顶层静态导入 `report-export.mjs`，则任何只想消费 DTO 的调用方（例如后续 LOCAL-07 worker 只调用 `buildReportDocument` / `buildReportXlsx` / `buildReportPdf`）仅因“导入了一个渲染模块”就会触发数据库打开 / 迁移与目录创建。

因此本模块：

- 模块顶层**不**导入 `report-export.mjs`；
- `buildReportDocument` / `buildReportXlsx` / `buildReportPdf` 只依赖传入的 `report` DTO；
- `report-export.mjs` 仅在 `async buildOfficeExport` 实际调用时动态 `import`（带模块缓存，不重复加载）；
- 函数签名、返回结构、金额来源、格式 / 字体 / 分页 / 超长字段拒绝行为均未改变，也未复制上游报表计算逻辑。

回归证据要求（不能靠 mock 代替）：在一个**全新 Node 子进程**中仅导入本模块，并基于合成 DTO 真正生成 XLSX / PDF；即使 `WORKBENCH_DATA_DIR` 指向尚未创建的专属临时位置，也不得创建该目录或其父目录、不得出现 `workbench.db` / `-wal` / `-shm`，且不得回落到 `06-workbench/data`。同一进程内检查无效（父进程已加载 `db.mjs`，模块缓存会掩盖副作用）。

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

所有错误在返回文件前抛出，不返回半成品附件。HTTP 状态与 `details` 的固定映射见上文“已实施的挂载语义”。

## 验收证据（员工自测）

工作目录 `06-workbench`，临时合成库；不含真实账套或凭据。

### 导入无副作用小修轮（模块阶段）实际命令

| 命令 | 结果 | 退出码 |
|---|---|---|
| `node --check server/report-office-export.mjs` / `node --check test/report-office-export.test.mjs` | 语法检查通过 | 0 |
| `npm run test:office-export`（员工自测，未设 `REPORT_OFFICE_PYTHON`） | **21/21 通过**（原 20 项全保留 + 1 项隔离子进程回归）；pdfplumber 几何检查明确 SKIP | 0 |
| `REPORT_OFFICE_PYTHON=<验收 Python> npm run test:office-export`（根管理者在 `1e11d1c` 内容上实跑） | **21/21 通过**，输出 `pdfplumber geometry verified for 11 PDFs` | 0 |
| `node test/report-export.test.mjs` | 21/21 通过 | 0 |
| `node test/report-export-http.test.mjs` | 29/29 通过（模块阶段早前轮次） | 0 |
| `WORKBENCH_DATA_DIR=<不存在的新临时路径> node --input-type=module -e 'await import("./server/report-office-export.mjs")'` | `{"dataDirExists":false,"db":false,"wal":false,"shm":false}`，未见目录 / 库 / WAL / SHM | 0 |

### 本阶段（接线）实际命令

| 命令 | 结果 | 退出码 |
|---|---|---|
| `node --check server/server.mjs` / `node --check public/app.js` / `node --check test/report-office-http.test.mjs` | 语法检查通过 | 0 |
| `node test/report-office-http.test.mjs`（真实 `server/server.mjs` 子进程、临时合成库、随机回环端口） | **6/6 通过**：CSV 五类、XLSX 五类（ExcelJS 重开 + 独立手算）、PDF 五类（魔数 / 嵌入字体 / 中文文本 / 页脚 / `pdfinfo` 页数）、预览 DTO（含 `xlsx|pdf|yaml|空` 一律 400）、既有输入校验、超长字段 422 与缺字体 500 无半截附件、下载后全库快照不变 | 0 |
| `node test/report-export.test.mjs` | 21/21 通过 | 0 |
| `node test/report-export-http.test.mjs` | **31/31 通过**（旧 `format=xlsx` 断言改为真正不支持的 `yaml`；新增 `/export-data` 严格 CSV 契约与 `/export` 真实 XLSX 附件两条回归） | 0 |
| `REPORT_OFFICE_PYTHON=<验收 Python> npm run test:office-export` | **21/21 通过**，`pdfplumber geometry verified for 11 PDFs`（前轮结果；本轮未改模块渲染代码，未重跑） | 0（前轮） |

接线准备阶段的红色记录（历史，不得当正式证据）：当时 `server.mjs` 仍调用只支持 CSV 的 `buildReportExport`，实跑为 **3 通过 / 3 失败**：

```
format=csv  → 200 text/csv; charset=utf-8，附 Content-Disposition
format=xlsx → 400 application/json，{"error":"report_format_unsupported","details":{"supported":["csv"]}}
format=pdf  → 400 application/json，同上
```

当时同一测试在 gitignored 临时替身上得到的 6/6 **只是历史旁证，不作为验收证据**；正式证据是上表真实 `server/server.mjs` 的 6/6。

### 最小接线回归修复（2026-10-22）

接线后 `/export?format=xlsx` 按契约返回真实工作簿，旧套件里“`format=xlsx` 必须 400”的历史断言因此失效。修复**不改模块渲染代码、不删测试、不改弱断言**：

- `06-workbench/test/report-export-http.test.mjs`：把该条严格拒绝用例换成真正不支持的 `format=yaml`（保留 `format=` 空值用例），错误断言仍是 400 + `report_format_unsupported` + JSON + 无 `Content-Disposition`；新增两条路由契约回归：
  - `/export-data`：缺省与 `format=csv` 返回 `schemaVersion: 1` 的 JSON DTO（无附件、`no-store`）；`xlsx` / `pdf` / `yaml` / 空 `format=` 一律 400 `report_format_unsupported`，**不静默转 CSV**；
  - `/export`：`format=xlsx` 返回 200 真实附件（`spreadsheetml` Content-Type、`.xlsx` 文件名、`PK\x03\x04` 魔数、`Content-Length` 与字节一致）。
- `06-workbench/server/server.mjs`：`export-data` 在调用导出模块前先按原契约校验 `format`（仅接受缺省 / `csv`），其余抛出 `report_format_unsupported`（`details: {supported:["csv"]}`），因此纯 DTO 预览不会生成任何 Office 附件；下载路由行为不变。
- `06-workbench/test/report-office-http.test.mjs`：预览用例补充上述四种格式的严格 400 断言，其余 6 个用例（CSV / XLSX / PDF 五类、输入校验、生成失败）断言不变。新增真实 HTTP 6 项保留。

本轮实跑：`report-export-http` **31/31**、`report-office-http` **6/6**、`report-export` **21/21**，均 exit 0（真实 `server.mjs` 子进程 + 临时合成库 + 随机回环端口）。源码 Office 生成器未变，**前轮 11 PDF 几何结果只标前轮、本轮未重跑**。

### 独立审查与页面验收（2026-10-22）

冻结 head `71894a1`（源码 / 测试不再改）。四类证据互相不可替代：

| 证据 | 执行者 | 结果 | 不覆盖 |
|---|---|---|---|
| `node test/report-office-http.test.mjs` | 独立审查（未参与实现） | **6/6、exit 0**（真实本包 `server.mjs` 子进程、临时合成库、随机回环端口） | 浏览器行为 |
| `node test/report-export-http.test.mjs` | 独立审查 | **31/31、exit 0**（包含 `/export-data` 严格 CSV 与 `/export` 真实 XLSX 契约） | 同上 |
| 页面脚本探针 | 独立审查 | CSV / XLSX / PDF 均触发下载；422 / 500 / MIME / 扩展名 / 长度 / 魔数失败均取消保存且控件恢复；内部路径不显示 | **不是真浏览器** |
| 真实页面点击 | root 管理者 | 真实 IAB 新标签页 + 本机 loopback + 合成账套（期初银行 1,000 / 资本 1,000；收入 800、费用 300；预览银行 1,500）；三格式分别选择并点击均显示“已生成并开始下载”、按钮恢复；服务 / 库 / 标签页已自清理，截图在 root 忽略目录 | **未检查保存位置**，**未新增 PDF 几何** |

口径：页面**实际生成并触发了下载**；附件二进制是否正确（XLSX 重开、PDF 可解析、CSV 行语义）以 HTTP 套件独审证据为准。

### 旧模块源码 `9f585d0` 的既有验收（渲染逻辑未变，仍然有效）

| 命令 / 事实 | 结果 |
|---|---|
| `npm run test:office-export` | 20/20 通过，退出码 0 |
| `REPORT_OFFICE_PYTHON=<验收 Python> npm run test:office-export` | 20/20 通过；pdfplumber 检查 11 个 PDF（43 页）无文字重叠、无越界 |
| 根管理者实跑模块测试 + 独立 reviewer | 20/20 与 20/20，无剩余阻塞 |
| 根管理者目视 QA（11 个 PDF / 43 页，全部 5 张 contact sheet 逐张检查） | 中文、分页、表格可读，无视觉阻塞 |
| `node test/report-export.test.mjs` / `node test/report-export-http.test.mjs` / `node test/smoke.test.mjs` | 21/21、29/29、28/28（早前轮次） |

覆盖要点：

- 五类报表 XLSX 均以 ExcelJS 重新打开，检查金额为数值、`#,##0.00`、冻结表头、打印区域 / 重复表头、列宽、横向 / 纵向。
- 五类 PDF 均检查 `%PDF-`、页数、嵌入字体、无 Helvetica、可提取中文标题 / 金额 / 页脚；长账套名、长科目名、230 行明细生成 19 页 PDF，每页重复表头与页码，230 条摘要全部可提取。
- 单行 2,000+ 字超长摘要跨页续排为 4 页，前后段标记与全部字符可提取，XLSX 单元格保存完整原文；最后一页仍有明细表头与尾注，不是孤页。
- 4,000 字中文账套名 PDF 为 5 页、3,000 字无断词 ASCII 名称 4 页、4,000 字明细账科目名 3 页；pdfplumber 越界 0，全部字符可提取。
- 单格 32767 字摘要通过并完整保存；32768 与 40,000 字摘要、40,000 字账套名在 XLSX / PDF 均以 `office_text_too_long` 拒绝，错误含字段定位且不回显原文；1 元明细账的 5 个金额单元格无续行重复。
- 独立手算金额（2026-01 / 2026-02）与 DTO、XLSX 单元格对应；草稿 / 反过账不入表。
- **导入无副作用**：隔离子进程仅导入模块并完成纯渲染，未创建 `WORKBENCH_DATA_DIR`、`workbench.db` / `-wal` / `-shm`，也未回落到默认数据目录。
- 公式注入样例保持文本；PDF 中动态文本不执行。
- 缺字体、非字体文件、缺字、未知格式、未登记期间、缺科目、非法账套均验证失败路径；空账提示在 XLSX / PDF 均保留。

**视觉 QA 已完成：** 旧模块源码 `9f585d0` 的 11 个 PDF（43 页）已由根管理者实际渲染并逐张检查全部 5 张 contact sheet（输出在 `06-workbench/tmp/report-office-full-qa-v2`），中文 / 分页 / 表格可读、无视觉阻塞。该轮只改动态 `import` 并新增隔离回归，渲染逻辑未变，故该视觉证据继续覆盖本次源码。员工自身无图像识别能力，因此不做像素目视，也不重复执行该渲染。

复验范围按实际源码变动决定：仅文档或无关基线（例如新增独立 LOCAL08 模块）更新不要求重跑整套测试；只有渲染 / 导入逻辑本身变动时才需重新执行对应检查。轮次分开记，**不混轮**：

- **纯模块轮**（`9f585d0`，渲染逻辑冻结）：20/20；根管理者另在 `1e11d1c` 内容上实跑 `REPORT_OFFICE_PYTHON=<验收 Python> npm run test:office-export`，**21/21** 并输出 `pdfplumber geometry verified for 11 PDFs`；11 PDF / 43 页几何与目视结论只属于这些模块轮。
- **初次接线前轮**：上条 21/21（含 11 PDF 几何）作为**前轮证据**保留；接线当时未重跑，也不因接线重做视觉。
- **后续最小回归轮**（`71894a1`）：只跑 `report-office-http` **6/6**、`report-export-http` **31/31**、`report-export` **21/21**（CSV / DTO 套件），**未设 `REPORT_OFFICE_PYTHON`、未重跑 11 PDF 几何**。因此不能写“接线轮重跑了模块 21/21 并含几何”。

## 接线状态与后续

- **已接线、已提交、未合并**：导出路由挂载、两条路由契约回归与页面格式选择已在 `71894a1`（本分支），**未建 PR / 未合并、尚未合入 LOCAL02**，对用户主工作区尚未生效；`docs/REPORT-EXPORT.md` 已在本轮同步为当前事实（纯 CSV 函数 + `/export-data` 严格 CSV DTO + `/export` 三格式 + 失败无附件），旧“首版仅 CSV”只作历史。
- **旧断言失效问题已在本分支解决**：`test/report-export-http.test.mjs` 的 `format=xlsx` 无论断已换成真正不支持的 `yaml`，并新增两条路由契约回归；该套件现为 **31/31 通过、exit 0**，不再有范围外阻塞。
- **已完成**：根管理者独立审查（源码 + 两套真实 HTTP）与页面级验证（真实 IAB 点击三格式均触发下载）；**未检查浏览器保存位置，未新增 PDF 几何**。**仍待**：整合（本分支相对 `origin/main` behind 9，需先同步）、PR、合并；不由本任务声明已合并。
- **统一入口未登记**：`scripts/test-all.mjs` 归 LOCAL02 #47（仍为 47 套，本任务未改），新套件尚未纳入；本任务未跑全库 `npm test`（本分支尚未合入 CORE-02），**不声称全套通过**；全量回归待根管理者合 02 与登记后统一执行。
- 接线后仍需：由持有 `scripts/test-all.mjs` 的变更把新测试纳入统一入口；继续只用临时合成账套做真实 HTTP 验收。`docs/REPORT-EXPORT.md` 已于本轮同步，不再作为待办。
- 复杂现金流分类、间接法独立勾稽、双准则官方映射、来源完整性属于后续核心任务；本模块只保留限制提示，**不声称这些问题已修复**，也不声称 LOCAL-03 或双准则完成。
