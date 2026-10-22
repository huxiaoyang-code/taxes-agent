# LOCAL-05a / Issue #45 交接：内部报表 XLSX / PDF

## 状态

- 任务：五类内部报表真实 XLSX / PDF 导出（LOCAL-05a，Issue #45）。
- 分支：`codex/huxiaoyang-code/local-05-office`。
- 基线（分叉时）：`0c4e0dd622fc35bcb5d6e6af3620c6f971b2a805`。
- 模块源冻结：`9f585d0`（`feat(reports): add verified Excel and PDF export module`）；此后合入 `origin/main` `94a79ef4a5e1c19e1320aed2e848ba42a7121712`，**当前分支 head `40236c359011c481fde66cfbf3ca9e9ec2b18066`**，本轮小修改动基于该 head。
- 员工状态：实现 + 独立审查返工 + 合成自测完成（模块套件 **21/21**，含本轮新增隔离回归）。**未执行 Git 提交 / 推送 / 合并**；提交、PR 与合并由根管理者按新 head 执行（尚未发生）。
- 本轮小修（纯导入副作用）：`report-export.mjs` 由顶层静态导入改为 `async buildOfficeExport` 内部动态导入；新增真实隔离子进程回归。函数签名 / 返回结构 / 金额来源 / 格式、字体、分页、超长字段拒绝全部未变，未复制上游报表计算，未增加抽象框架。
- 小修前的既有事实：根管理者实跑模块测试 **20/20**、独立审查 **20/20**（无剩余阻塞），pdfplumber 检查 11 个 PDF 共 **43 页**文字重叠 0 / 越界 0。这些是**小修前**、20 项套件与旧静态导入结构上的事实，不能直接当作本轮新代码的验收；并且它们不涉及本轮改动。目视 QA **无明确证据**，仍待根管理者补。
- LOCAL-05 整体：**未完成**。本部分只交付独立导出模块，未做 HTTP / 页面接线（无路由、无前端入口）。
- 当前没有需要保留的本地服务、后台进程或会话；临时库与隔离临时目录已关闭并清理。

## 变更内容

新增：

- `06-workbench/server/report-office-export.mjs`
  - `buildOfficeExport(setId, { kind, period, format, code })`：`csv` 委托既有 `buildReportExport`；`xlsx` / `pdf` 返回真实 `Buffer`。
  - **`report-export.mjs` 只在 `async buildOfficeExport` 内动态导入**；模块顶层不触碰 `report-export.mjs` / `db.mjs`，因此仅导入本模块不会打开 / 创建默认 `workbench.db`、不跑迁移。
  - `buildReportDocument(report)`：XLSX / PDF 共用文档模型，只读取 `schemaVersion: 1` DTO；生成后统一校验全部文本字段 ≤ `MAX_TEXT_FIELD_LENGTH = 32767`。
  - `buildReportXlsx(report, document?)`、`buildReportPdf(report, document?)`。
  - `resolvePdfFontCandidates()`、`OFFICE_FORMATS`、`OFFICE_REPORT_KINDS`、`MAX_TEXT_FIELD_LENGTH`。
- `06-workbench/test/report-office-export.test.mjs`：**21 项**合成验收（原 20 项全部保留，另加 1 项无数据库副作用回归）。
- `docs/REPORT-OFFICE-EXPORT.md`：模块契约、格式、文本上限、字体、依赖、错误码、验收与边界。
- `docs/tasks/LOCAL-05-OFFICE.md`：任务单与验收记录。
- `docs/handoffs/LOCAL-05-OFFICE.md`：本交接。

修改：

- `06-workbench/package.json`：新增 `exceljs: 4.4.0`、`pdfkit: 0.20.2` 与 `test:office-export` 脚本；npm 同时把既有 `engines` 从单行格式化为多行，无其他语义变化。
- `06-workbench/package-lock.json`：新增，锁定上述依赖及其传递依赖（lockfileVersion 3）。
- 区分口径：上述两个依赖文件属冻结模块提交 `9f585d0`；**本轮无副作用小修的未提交 diff 只有 5 个文件**——`server/report-office-export.mjs`、`test/report-office-export.test.mjs` 与本交接 / 任务单 / `docs/REPORT-OFFICE-EXPORT.md` 三份文档，未再动 `package.json` / `package-lock.json`。

未修改（刻意保持）：

- `server/report-export.mjs`、`server/tax-report-format.mjs`、`server/accounting.mjs`、`server/db.mjs`、`server/server.mjs`、agent tools、MCP、`scripts/test-all.mjs`、`public/*`、公共索引、`docs/REPORT-EXPORT.md`。
- 没有新增 HTTP 路由或前端控件。

## 关键实现事实

- 仅格式化 DTO：金额 / 期间 / 限制 / 检查 / 空账状态来自上游；不重算、不补数。
- **导入无副作用**：`import { buildReportDocument, buildReportXlsx, buildReportPdf } from ".../report-office-export.mjs"` 不需要数据库；只有真正调用 `buildOfficeExport(setId, ...)`（需要账套 / 期间校验与 DTO）时才动态加载 `report-export.mjs` → `db.mjs`。这是后续 LOCAL-07 worker 只消费 DTO 的前提。
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

### 本轮（无副作用小修）实际运行

| 命令 | 观察结果 | 退出码 |
|---|---|---|
| `node --check server/report-office-export.mjs`、`node --check test/report-office-export.test.mjs` | 两文件语法通过 | 0 |
| `npm run test:office-export` | **21/21 通过**（原 20 项全保留 + 1 项隔离回归）；poppler 页数 / PNG 渲染通过；未设 `REPORT_OFFICE_PYTHON` 时 pdfplumber 几何检查明确 SKIP | 0 |
| `node test/report-export.test.mjs` | 21/21 通过 | 0 |
| `node test/report-export-http.test.mjs` | 29/29 通过 | 0 |
| `WORKBENCH_DATA_DIR=<不存在的新临时路径> node --input-type=module -e 'await import("./server/report-office-export.mjs")'` | `{"dataDirExists":false,"db":false,"wal":false,"shm":false,"exports":8}`；前后均无目录，且未创建 `06-workbench/data` | 0 |

隔离回归具体口径：全新 Node 子进程 → 先断言 `WORKBENCH_DATA_DIR` 及其父目录均不存在 → 仅导入渲染模块 → 基于合成 DTO 调用 `buildReportDocument` / `buildReportXlsx` / `buildReportPdf`（要求 XLSX 以 `PK` 开头、PDF 以 `%PDF-` 开头且 `pageCount >= 1`、行数 ≥ 1）→ 再断言目录与 `workbench.db` / `-wal` / `-shm` 仍不存在、`06-workbench/data` 与运行前一致。因为子进程从未加载 `db.mjs`，这是真实无副作用证明，不是 mock，也不受父进程模块缓存影响。

### 小修前的既有自测与管理者事实（历史，不当作本轮新证据）

| 命令 / 事实 | 观察结果 |
|---|---|
| `npm run test:office-export`（冻结源 `9f585d0`） | 20/20 通过，exit 0 |
| `REPORT_OFFICE_PYTHON=<验收用 Python> npm run test:office-export` | 20/20 通过；pdfplumber 对 11 个 PDF（43 页）文字重叠 0、越界 0 |
| 根管理者实跑 + 独立审查（小修前） | 20/20 与 20/20，无剩余阻塞 |
| `node test/report-export.test.mjs` / `node test/report-export-http.test.mjs` / `node test/smoke.test.mjs` | 21/21、29/29、28/28（早前轮次） |

本轮未重跑 `REPORT_OFFICE_PYTHON` 几何检查，未重跑全仓 `npm test`；不据此声称 43 页几何结果是本轮新代码的验收。

生成物（gitignored，每次运行先清空再重建）：`06-workbench/tmp/report-office-qa/`

- 5 类 XLSX、5 类 PDF；长明细 PDF（2026-03、230 行、19 页）；单行超长摘要 PDF（2026-03、4 页）；4,000 字账套名 PDF（5 页）；3,000 字无断词名称 PDF（4 页）；4,000 字科目名 PDF（3 页）；现金流限制去重 PDF（1 页）。
- `pdftoppm` 渲染 PNG：资产负债表首页、余额表首页、长明细前 2 页与末 2 页、现金流 1 页、4,000 字账套名 1–5 页、无断词名称首页、4,000 字科目名 1–3 页、2,000 字摘要末 2 页。
- 页数 / 页面尺寸已用 `pdfinfo` 独立核对（资产负债表纵向 1 页；现金流量表纵向 1 页；余额表横向 3 页；明细账横向 1 页 / 19 页 / 4 页；长名称 5 / 4 / 3 页）。
- 2,000+ 字摘要明细账第 4 页仍含明细表头与尾注，未出现只剩尾注的孤页。

## 审查重点

1. `report-office-export.mjs` 是否只消费 DTO，没有重新查询 / 计算金额。
2. **模块顶层是否真的不导入 `report-export.mjs` / `db.mjs`**；隔离回归是否为真实子进程且真正执行了 XLSX / PDF 渲染；是否避免了「父进程已加载 db」的缓存掩盖。
2. XLSX 金额是否为数值 + 两位格式；文本是否保持字符串；公式注入样例是否无公式单元格；所有文本单元格是否 ≤32767 且超限稳定拒绝。
3. PDF 是否真的嵌入字体、可提取中文 / 金额；长行与超长元数据是否跨页续排、每页重复表头与页码；4,000 字名称是否 5 页无越界。
4. 字体探测与显式环境变量：缺失路径、非字体文件、缺字是否稳定失败。
5. 尾注是否与警告去重、是否仍有孤页；空账与借贷余额说明是否保留。
6. `package.json` / `package-lock.json` 是否只有本模块需要的依赖与脚本。
7. 是否没有改动共享文件、没有新增路由、没有宣称 LOCAL-05 整体完成。

## 明确未完成 / 未声称

- **新的最终独立审查待根管理者安排**：本轮小修后的 head / PR / merge 尚未发生，不预报通过；小修前 20/20 的审查结论不自动延伸到本轮改动。
- **未目视 PNG**：员工无图像识别能力。自动几何检查通过（且为小修前事实），但版式观感的最终视觉 QA 需根管理者打开 `tmp/report-office-qa` 的 PNG 确认；目视前不得声明“布局无缺陷”。
- **未接线**：HTTP / 前端 / 允许格式白名单 / 用户文档更新归后续接线 PR；LOCAL01 #43 **已合并关闭**，接线等 LOCAL02 #47 释放窗口后由根管理者排工，也不称由管理者亲写模块代码。接线后需做真实接口验收（仍用合成账套）。
- **未修复会计算法**：现金流比例分摊、间接法非独立勾稽、双准则官方映射、来源完整性仍按既有状态保留提示。
- **未宣称申报就绪**：所有文件均为内部报表。
- `docs/REPORT-EXPORT.md` 仍写“首版仅 CSV”，因其不在本任务文件范围；接线时一并更新。

## 下一任务输入（共享接线）

- 接线为**独立 PR**；本模块可先单独合并。
- 在导出入口把 `format` 传给 `buildOfficeExport`，对 `xlsx` / `pdf` 设置模块返回的 `contentType` 与 `filename`；`body` 为 Buffer。
- 保持既有错误码透传（尤其 `report_format_unsupported` 现在支持 `csv/xlsx/pdf`）。
- 页面下载按钮与预览保持分离（预览仍用 `export-data`），不要把二进制塞进 JSON。
- 接线完成后补 HTTP 下载测试：真实响应头、文件魔数、XLSX 重开、PDF 文本 / 页数；继续使用临时合成库。
- 共享文档更新由持有 `docs/REPORT-EXPORT.md` / `server/server.mjs` / `public/*` 的负责人执行。

## Git / 回退

- 员工未提交、未推送、未合并；根管理者审查实际 diff 后按已验证 head 提交并在新 head 上重跑验收与独立审查。
- 远端 `main` 已前进到 `b42bae9`（PR #50 仅新增独立输出边界文件）；与本分支的整合由根管理者执行，员工不自行 Git。
- 若合并后发现缺陷，按项目规则用新的 revert PR 回退，禁止重写 main 历史。
