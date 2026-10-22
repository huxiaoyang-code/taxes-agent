# LOCAL-05a / Issue #45 交接：内部报表 XLSX / PDF

## 状态

- 任务：五类内部报表真实 XLSX / PDF 导出（LOCAL-05a，Issue #45）。
- 分支：`codex/huxiaoyang-code/local-05-office`。
- 基线：`0c4e0dd622fc35bcb5d6e6af3620c6f971b2a805`。
- 员工状态：实现 + 独立审查返工 + 合成自测完成；**未执行 Git 提交 / 推送 / 合并**，由管理者审查后提交。
- 返工内容：修复独立 review 复现的两项 P2（PDF 超长首页元数据越界、XLSX 超过 32767 字仍生成），并完成尾注去重 / 防孤页优化。
- LOCAL-05 整体：**未完成**。本部分只交付独立导出模块，未接线。
- 当前没有需要保留的本地服务、后台进程或会话；临时库已关闭并清理。

## 变更内容

新增：

- `06-workbench/server/report-office-export.mjs`
  - `buildOfficeExport(setId, { kind, period, format, code })`：`csv` 委托既有 `buildReportExport`；`xlsx` / `pdf` 返回真实 `Buffer`。
  - `buildReportDocument(report)`：XLSX / PDF 共用文档模型，只读取 `schemaVersion: 1` DTO；生成后统一校验全部文本字段 ≤ `MAX_TEXT_FIELD_LENGTH = 32767`。
  - `buildReportXlsx(report, document?)`、`buildReportPdf(report, document?)`。
  - `resolvePdfFontCandidates()`、`OFFICE_FORMATS`、`OFFICE_REPORT_KINDS`、`MAX_TEXT_FIELD_LENGTH`。
- `06-workbench/test/report-office-export.test.mjs`：20 项合成验收。
- `docs/REPORT-OFFICE-EXPORT.md`：模块契约、格式、文本上限、字体、依赖、错误码、验收与边界。
- `docs/tasks/LOCAL-05-OFFICE.md`：任务单与验收记录。
- `docs/handoffs/LOCAL-05-OFFICE.md`：本交接。

修改：

- `06-workbench/package.json`：新增 `exceljs: 4.4.0`、`pdfkit: 0.20.2` 与 `test:office-export` 脚本；npm 同时把既有 `engines` 从单行格式化为多行，无其他语义变化。
- `06-workbench/package-lock.json`：新增，锁定上述依赖及其传递依赖（lockfileVersion 3）。

未修改（刻意保持）：

- `server/report-export.mjs`、`server/tax-report-format.mjs`、`server/accounting.mjs`、`server/db.mjs`、`server/server.mjs`、agent tools、MCP、`scripts/test-all.mjs`、`public/*`、公共索引、`docs/REPORT-EXPORT.md`。
- 没有新增 HTTP 路由或前端控件。

## 关键实现事实

- 仅格式化 DTO：金额 / 期间 / 限制 / 检查 / 空账状态来自上游；不重算、不补数。
- XLSX：
  - 金额为数值单元格，`#,##0.00`；文本为字符串 + `@`，公式注入样例保持文本；测试遍历全部单元格确认无公式。
  - 冻结主明细表头、打印重复表头、设置打印区域、A4 横向 / 纵向、页脚页码。
  - 按文本长度估算行高，避免默认行高遮挡换行内容。
  - **单格上限**：所有最终文本单元格（账套名、准则、元数据、限制、列标题、科目名、摘要、尾注）≤32767 字符；超限抛 `office_text_too_long`，带 `field` / `length` / `limit` / 行号 / 列名，不回显原文，不截断、不拆续行。
- PDF：
  - PDFKit 直接生成；嵌入中文字体子集（`/FontFile2`）；无未嵌入 Helvetica。
  - 首页标题、副标题、每个元数据字段、限制框均按剩余高度逐行分页；单个字段超过一页会续排，不再越界。
  - 续页重复标题与表头；长行跨页续排、不截断；页脚“第 X 页 / 共 Y 页”。
  - 尾注与 `warnings` 去重；最后一节预留尾注高度，让尾注跟最后一块内容同页，避免孤页；保留空账 / 完整性 / 现金流限制与明细账借贷余额说明。
  - 11 列报表自动横向；金额右对齐两位小数。
- 字体：
  - 默认探测 `%SystemRoot%\Fonts\simsun.ttc`（族 `SimSun`）、`simhei.ttf`、`Deng.ttf`；可用 `REPORT_PDF_FONT` / `REPORT_PDF_FONT_FAMILY` 覆盖。
  - 缺字体 / 非字体文件 → `pdf_font_unavailable`；字体缺字 → `pdf_font_glyph_missing`，不画方框。
  - 字体文件未入 Git；文档未记录用户绝对路径。
- CSV 回归：`buildOfficeExport(..., format:"csv")` 与 `buildReportExport` 输出 DTO 完全一致，既有 21 项 CSV 测试仍全过。

## 验证结果（员工自测）

工作目录 `06-workbench`；全部临时合成库（系统临时目录，测试结束删除），无真实账套 / 凭据 / 税局系统。

| 命令 | 观察结果 | 退出码 |
|---|---|---|
| `npm run test:office-export` | 20/20 通过；poppler 页数 / PNG 渲染通过；未设置 `REPORT_OFFICE_PYTHON` 时几何检查明确跳过 | 0 |
| `REPORT_OFFICE_PYTHON=<验收用 Python> npm run test:office-export` | 20/20 通过；pdfplumber 对 11 个 PDF（43 页）检查文字重叠 0、越界 0；230 条长摘要、2,000+ 字单行摘要、4,000 字账套名、3,000 字无断词名称、4,000 字科目名全部可提取 | 0 |
| `node test/report-export.test.mjs` | 21/21 通过 | 0 |
| `node test/report-export-http.test.mjs` | 29/29 通过 | 0 |
| `node test/smoke.test.mjs` | 28/28 通过 | 0 |
| `npm view exceljs version` / `npm view pdfkit version` | `4.4.0` / `0.20.2` | 0 |

生成物（gitignored，每次运行先清空再重建）：`06-workbench/tmp/report-office-qa/`

- 5 类 XLSX、5 类 PDF；长明细 PDF（2026-03、230 行、19 页）；单行超长摘要 PDF（2026-03、4 页）；4,000 字账套名 PDF（5 页）；3,000 字无断词名称 PDF（4 页）；4,000 字科目名 PDF（3 页）；现金流限制去重 PDF（1 页）。
- `pdftoppm` 渲染 PNG：资产负债表首页、余额表首页、长明细前 2 页与末 2 页、现金流 1 页、4,000 字账套名 1–5 页、无断词名称首页、4,000 字科目名 1–3 页、2,000 字摘要末 2 页。
- 页数 / 页面尺寸已用 `pdfinfo` 独立核对（资产负债表纵向 1 页；现金流量表纵向 1 页；余额表横向 3 页；明细账横向 1 页 / 19 页 / 4 页；长名称 5 / 4 / 3 页）。
- 2,000+ 字摘要明细账第 4 页仍含明细表头与尾注，未出现只剩尾注的孤页。

## 审查重点

1. `report-office-export.mjs` 是否只消费 DTO，没有重新查询 / 计算金额。
2. XLSX 金额是否为数值 + 两位格式；文本是否保持字符串；公式注入样例是否无公式单元格；所有文本单元格是否 ≤32767 且超限稳定拒绝。
3. PDF 是否真的嵌入字体、可提取中文 / 金额；长行与超长元数据是否跨页续排、每页重复表头与页码；4,000 字名称是否 5 页无越界。
4. 字体探测与显式环境变量：缺失路径、非字体文件、缺字是否稳定失败。
5. 尾注是否与警告去重、是否仍有孤页；空账与借贷余额说明是否保留。
6. `package.json` / `package-lock.json` 是否只有本模块需要的依赖与脚本。
7. 是否没有改动共享文件、没有新增路由、没有宣称 LOCAL-05 整体完成。

## 明确未完成 / 未声称

- **未目视 PNG**：员工无图像识别能力。自动几何检查通过，但版式观感的最终视觉 QA 需管理者打开 `tmp/report-office-qa` 的 PNG 确认；在目视前不得声明“布局无缺陷”。
- **未接线**：HTTP / 前端 / 允许格式白名单 / 用户文档更新归 LOCAL01 #43 或管理者；接线后需做真实接口验收（仍用合成账套）。
- **未修复会计算法**：现金流比例分摊、间接法非独立勾稽、双准则官方映射、来源完整性仍按既有状态保留提示。
- **未宣称申报就绪**：所有文件均为内部报表。
- `docs/REPORT-EXPORT.md` 仍写“首版仅 CSV”，因其不在本任务文件范围；接线时一并更新。

## 下一任务输入（共享接线）

- 在导出入口把 `format` 传给 `buildOfficeExport`，对 `xlsx` / `pdf` 设置模块返回的 `contentType` 与 `filename`；`body` 为 Buffer。
- 保持既有错误码透传（尤其 `report_format_unsupported` 现在支持 `csv/xlsx/pdf`）。
- 页面下载按钮与预览保持分离（预览仍用 `export-data`），不要把二进制塞进 JSON。
- 接线完成后补 HTTP 下载测试：真实响应头、文件魔数、XLSX 重开、PDF 文本 / 页数；继续使用临时合成库。
- 共享文档更新由持有 `docs/REPORT-EXPORT.md` / `server/server.mjs` / `public/*` 的负责人执行。

## Git / 回退

- 员工未提交、未推送、未合并；管理者审查实际 diff 后按已验证 head 提交。
- 若合并后发现缺陷，按项目规则用新的 revert PR 回退，禁止重写 main 历史。
