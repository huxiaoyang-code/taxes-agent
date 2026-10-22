# LOCAL-05a / Issue #45 内部报表真实 XLSX / PDF 导出

## 1. 基本信息

- 任务 ID：LOCAL-05a（五类内部报表真实 XLSX / PDF 导出）；总任务 LOCAL-05 尚未完成。
- 状态：模块实现、独立审查返工（2 项 P2 已修）与员工自测完成；本轮追加**纯 DTO 渲染无数据库副作用**小修（`report-export.mjs` 改为 `buildOfficeExport` 内动态导入，并补真实隔离子进程回归），已由根管理者在 `1e11d1c` 内容上实跑 **21/21、exit 0**（含 pdfplumber 几何）；旧模块源码的视觉 QA 也已由根管理者完成。代码**未接线**（无 HTTP 路由、无页面入口），本任务单不代表 LOCAL-05 整体完成；当前 head 正由最终独立 reviewer 审查，结论不预报。
- 代码来源：模块源冻结于 `9f585d0`（`feat(reports): add verified Excel and PDF export module`）；纯 DTO 无副作用修改的源码冻结提交：`1e11d1c`；当前分支 head：`5ba31adcbe32e9e7b7b99cec39b41db729572fb3`（= `1e11d1c` 与最新 `origin/main` `b42bae9ae76e54aeda63bcc4db0dc34663286b7d` 的合并；新 main 只新增独立 LOCAL08 模块，导出代码不变）。
- 负责人（人类成员 / GitHub）：`huxiaoyang-code`。
- 执行员工：pi（主 / 唯一回退模型 `tokenhub/deepseek-v4.1-flash` 锁定；未使用其他模型或子 agent）。
- 分支：`codex/huxiaoyang-code/local-05-office`。
- 基线（分叉时）：`0c4e0dd622fc35bcb5d6e6af3620c6f971b2a805`。
- 关联 Issue：#45（本任务）。LOCAL01 #43（共享接线）**已合并关闭**；后续 HTTP / 页面接线等 LOCAL02 #47 释放窗口后由根管理者另行派工，接线不由本任务承担，也不宜再派给已关闭的 #43。

### 1.1 既有验收事实（已由根管理者完成，两类分开记录，互不覆盖也不互相否定）

**旧模块源码 `9f585d0`（渲染逻辑自那以后未变）：**

- 根管理者实跑模块测试 **20/20 通过、exit 0**；独立 reviewer **20/20**，无剩余阻塞。
- 11 个 PDF 共 43 页几何检查：文字重叠 **0**、越界 **0**（pdfplumber）。
- 根管理者**已实际渲染 11 个 PDF（共 43 页）并逐张检查全部 5 张 contact sheet**，确认中文、分页、表格可读、无视觉阻塞。视觉检查**已完成**，不是待办；渲染输出在 `06-workbench/tmp/report-office-full-qa-v2`（gitignored）。

**当前纯 DTO 修改（`1e11d1c` 内容，只改动态 `import` + 新增隔离回归，不改渲染）：**

- 根管理者实跑 `REPORT_OFFICE_PYTHON=<验收 Python> npm run test:office-export`：**21/21 被接受、exit 0**，明确输出 `pdfplumber geometry verified for 11 PDFs`。
- 原 pure 员工在中断前同样完成过 21/21、exit 0（含几何）；恢复员工做文档与回归后亦 exit 0。

既有视觉 / 几何证据覆盖的是**未改变的渲染逻辑**；本次新增隔离回归证明的是**纯 DTO 导入不打开数据库**。只有渲染 / 导入逻辑本身变动才需重做对应检查，仅文档或无关基线（如新增独立 LOCAL08 模块）更新不要求重跑整套。

## 2. 需求与边界

- 目标：在既有 `06-workbench/server/report-export.mjs` 稳定 `report` DTO（`schemaVersion: 1`）之上，为 `balance-sheet`、`income-statement`、`cash-flow-statement`、`trial-balance`、`ledger` 五类内部报表生成真实 XLSX 与 PDF 二进制；保留 CSV。
- 明确不做：
  - 不改既有 `report-export.mjs`、`tax-report-format.mjs`、`accounting.mjs`、`db.mjs`、`server.mjs`、agent tools、MCP、`scripts/test-all.mjs`、公共索引或 `public/*`。
  - 不新增 HTTP 路由、前端入口或共享接线；接线在一个独立 PR 中完成（LOCAL01 #43 已合并关闭，后续等 LOCAL02 #47 释放窗口后由根管理者排工），之后再做真实接口验收。
  - 不重算会计金额、不补造缺失数据、不改变现金流比例分摊或间接法算法，不宣称完整准则映射或申报就绪。
  - 不宣称 LOCAL-05 整体完成；复杂现金流分类与双准则官方映射仍待后续核心子包。
  - 不使用真实账套、真实凭据、税局系统或旧后端做自动测试。
- 输入：`buildReportExport(setId, {kind, period, format:'csv', code})` 返回的同一 `report` DTO。
- **导入副作用约束（本轮新增）**：`report-office-export.mjs` 在模块顶层**不得**导入 `report-export.mjs`。后者导入 `db.mjs`，而 `db.mjs` 在导入时即打开 / 创建默认 `workbench.db`（含迁移）。后续 LOCAL-07 worker 只消费 DTO、只调用 `buildReportDocument` / `buildReportXlsx` / `buildReportPdf`，若静态导入就会因「导入模块」触发数据库打开与迁移。因此该依赖改为在 `async buildOfficeExport` 实际调用时动态 `import`；函数签名、返回值、金额来源、格式 / 字体 / 分页 / 超长字段拒绝行为全部不变，也不复制上游报表计算。
- 输出：`buildOfficeExport(setId, options)` 返回 `{ filename, contentType, body, report, pageCount?, font? }`；CSV `body` 仍为字符串，XLSX / PDF `body` 为 `Buffer`。
- 建议文件范围：新增 `06-workbench/server/report-office-export.mjs`、`06-workbench/test/report-office-export.test.mjs`，仅为本模块在 `06-workbench/package.json` 增加实际依赖与 `test:office-export` 脚本并生成 `package-lock.json`。

## 3. 契约与口径

- DTO 复用：导出层只格式化 `report`，金额、期间、`warnings`、`checks`、空账与完整性状态全部来自上游 DTO。
- 金额：数值单元格 / PDF 数字均来自 DTO 金额，保留两位小数；XLSX 使用数值单元格与 `#,##0.00` 格式，不写文本假金额。
- 文本：科目名称、摘要、账套名称等按文本保存；XLSX 明确字符串类型且不写公式，PDF 以嵌入字体绘制，不做 markup / 脚本执行。
- 期间列：资产负债表为“期间期初（上期末）/ 期末”；利润表为“本期发生（YYYY-MM）/ 本年累计（自 YYYY-MM-DD 起）”；现金流量表含对方科目编码及本期 / 本年累计；余额表为 11 列（编码、名称、方向、四个口径借贷）；明细账汇总与逐笔区分，逐笔含真实凭证 ID、分录 ID、余额（借减贷）。
- 限制提示：完整性未核实、内部报表非申报文件、映射未核实、空账、年中启用、现金流比例分摊、间接法非独立勾稽均随 DTO 输出；格式层不消除这些限制。
- 文件名：`<kind>-<账套ID>-<期间>[-<科目编码>].<csv|xlsx|pdf>`，动态段仅保留 `[A-Za-z0-9_-]`，最长 64 字符。
- 文本长度上限：任一最终文本单元格 / PDF 单字段最多 **32767 字符**（Excel 官方单格上限）。超过时在生成任何字节前抛 `office_text_too_long`，`details` 含受控字段定位 `field`（如 `accountSet.name`、`sections[1].rows[0].cells[7]`）、`length`、`limit` 及行号 / 列名，不回显原文。XLSX 与 PDF 使用同一上限；不静默截断、不生成续行伪造金额。CSV 属既有模块，不受格式层上限限制。

## 4. 字体与运行依赖

- Node 运行时：`06-workbench/package.json` 既有 `engines.node: >=22.5.0`；本机实际验证 Node v24.15.0。
- npm 依赖（精确锁定，`--save-exact --ignore-scripts`）：
  - `exceljs@4.4.0`：真实 XLSX 工作簿、数值单元格、冻结窗格、打印区域 / 重复表头。
  - `pdfkit@0.20.2`：真实 PDF、TTC / TTF 字体嵌入、子集化、文本测量。
  - `package-lock.json` 一并入库；不使用全局 npm 配置，不执行下载安装器。
- 中文字体：产品运行时必须有可嵌入中文字体。默认按顺序探测 `%SystemRoot%\Fonts\simsun.ttc`（字体族 `SimSun`）、`simhei.ttf`、`Deng.ttf`；非 Windows 另探测常见 Noto CJK / PingFang 路径。显式覆盖：
  - `REPORT_PDF_FONT`：字体文件路径（缺失时明确报错，不静默回退）。
  - `REPORT_PDF_FONT_FAMILY`：TTC 集合的字体族名（仅与显式路径配合）。
- 不在 Git 保存 Windows 系统字体；版本化文档不记录用户绝对路径。
- 本机核实：`simsun.ttc` 的 `SimSun` / `NSimSun` 可被 pdfkit 嵌入；`msyh.ttc` 以 `Microsoft YaHei` / `Microsoft YaHei UI` 族名在该版本报“Not a supported font format”，故默认候选不含微软雅黑。缺字时抛 `pdf_font_glyph_missing`，不绘制方框冒充中文。

## 5. 验收标准

- 五类报表 × XLSX / PDF 均生成真实文件，不是改扩展名的 CSV，也不是浏览器打印：
  - XLSX 以 ExcelJS 重开成功，金额单元格为数值、`#,##0.00`、冻结表头、打印区域 / 重复表头存在。
  - PDF 以 `%PDF-` 开头、页数可核、含 `/FontFile2` 嵌入字体、无未嵌入 Helvetica；独立解析 ToUnicode + 文本流可提取中文标题、金额与页脚。
- 独立手算合成账套：2026-01 / 2026-02 关键金额与既有 RC-B 样例一致；草稿与反过账不入表。
- 公式注入：账套名 `=SUM(1,2)`、科目名 `@危险科目`、摘要 `=1+1` 等保持文本，不产生公式单元格；CSV 行为由既有模块保留。
- 分页：230 行明细、长中文账套 / 科目 / 摘要实际生成 19 页 PDF；每页重复明细表头与页码，230 条摘要全部可从 PDF 文本提取，无截断；另用单行 2,000+ 字摘要验证跨页续排（4 页），前后段标记与全部字符均可提取，XLSX 单元格保留完整原文。
- 超长元数据：4,000 字中文账套名（`name='超长名称'.repeat(1000)`）的资产负债表 PDF 逐行分页为 5 页，3,000 字无断词 ASCII 名称余额表为 4 页，4,000 字明细账科目名 3 页；pdfplumber 越界字符 0，重复名称 / 无断词字符全部可提取。
- 单格边界：32767 字摘要 XLSX 完整保存为 1 个单元格且 1 元明细账金额只出现 5 次（无续行重复）；32768 字与 40,000 字摘要、40,000 字账套名、40,000 字明细账科目名元数据在 XLSX / PDF 均以 `office_text_too_long` 拒绝，错误分别定位 `sections[...]` / `accountSet.name` / `meta[i].value` 且不回显原文。
- 尾注 / 孤页：现金流限制文字只出现 1 次（1 页）；2,000+ 字单摘要明细账仍为 4 页，最后一页同时含明细表头与尾注，没有只剩尾注的孤页；空账提示与“余额（借减贷）/ 负数表示贷方余额”说明保留。
- 失败路径：不存在的 `REPORT_PDF_FONT`、非字体文件、字体缺字、未知格式、未登记期间、缺明细账科目、非法账套均返回稳定错误码。
- 导入无副作用：全新子进程中**仅导入**本模块并基于合成 DTO 执行纯渲染（`buildReportDocument` → `buildReportXlsx` → `buildReportPdf`）时，即使 `WORKBENCH_DATA_DIR` 指向尚未创建的专属临时位置，也不得创建该目录 / 其父目录 / `workbench.db` / `-wal` / `-shm`，不得回落到 `06-workbench/data`，且该子进程仍须真正产出 XLSX / PDF 字节。同一进程内的检查不算证据（父进程已导入 `db.mjs`，模块缓存会掩盖副作用）；不得以 mock 数据库证明。
- 命令与结果见第 7 节。

## 6. 文件所有权

- 本任务精确新增 / 修改：
  - `06-workbench/server/report-office-export.mjs`（新增）
  - `06-workbench/test/report-office-export.test.mjs`（新增）
  - `docs/tasks/LOCAL-05-OFFICE.md`、`docs/handoffs/LOCAL-05-OFFICE.md`、`docs/REPORT-OFFICE-EXPORT.md`（新增）
  - `06-workbench/package.json`（仅依赖与 `test:office-export`）、`06-workbench/package-lock.json`（新依赖锁定）
- 本轮无副作用小修只改 `report-office-export.mjs`、`report-office-export.test.mjs` 与上述三份文档；未改 `package.json` / `package-lock.json`。
- 共享文件未改动：`report-export.mjs`、`tax-report-format.mjs`、`accounting.mjs`、`db.mjs`、`server.mjs`、agent tools、MCP、`scripts/test-all.mjs`、`public/*`、公共索引。
- `docs/REPORT-EXPORT.md` 不在本任务可写范围，仍描述“首版仅 CSV”；共享接线完成后需由持有该文件的变更同步更新，不能据此认为新格式已经对外可用。

## 7. 验证记录（员工自测）

工作目录 `06-workbench`，全部使用临时合成库（`WORKBENCH_DATA_DIR` 指向系统临时目录，退出时关闭并删除），不触碰真实数据。

### 7.1 本轮无副作用小修的实际命令与结果

| 命令 | 结果 | 退出码 |
|---|---|---|
| `node --check server/report-office-export.mjs` / `node --check test/report-office-export.test.mjs` | 两个文件语法检查通过 | 0 |
| `npm run test:office-export`（员工自测，未设 `REPORT_OFFICE_PYTHON`） | **21/21 通过**（原 20 项全部保留 + 新增隔离子进程 1 项）；含 poppler 页数 / PNG 渲染；pdfplumber 几何检查明确 SKIP | 0 |
| `REPORT_OFFICE_PYTHON=<验收 Python> npm run test:office-export`（根管理者在 `1e11d1c` 内容上实跑） | **21/21 通过**，`pdfplumber geometry verified for 11 PDFs` | 0 |
| `node test/report-export.test.mjs` | 21/21 通过（既有 CSV / DTO 回归未受影响） | 0 |
| `node test/report-export-http.test.mjs` | 29/29 通过（既有 HTTP 导出契约未受影响） | 0 |
| 独立单次子进程检查：`WORKBENCH_DATA_DIR=<不存在的新临时路径> node --input-type=module -e 'await import("./server/report-office-export.mjs")'` | 输出 `{"dataDirExists":false,"db":false,"wal":false,"shm":false,"exports":8}`；目录前后均不存在，`06-workbench/data` 亦未被创建 | 0 |

无副作用证明要点：新增回归在一个**全新 Node 子进程**里完成，先断言隔离目录及其父目录尚不存在，再仅 `import` 渲染模块，然后基于合成 DTO 依次调用 `buildReportDocument` / `buildReportXlsx` / `buildReportPdf`，断言 XLSX 以 `PK` 开头、PDF 以 `%PDF-` 开头且 `pageCount >= 1`、行数 ≥ 1，最后断言隔离目录 / `workbench.db` / `-wal` / `-shm` 均未出现，且 `06-workbench/data` 与运行前一致。因为该子进程从未加载 `db.mjs`，所以证明的是真实导入无副作用，而不是 mock。

### 7.2 旧模块源码 `9f585d0` 的既有验收（渲染逻辑未变，仍然有效）

| 命令 / 事实 | 结果 |
|---|---|
| `npm run test:office-export`（冻结模块源 `9f585d0`） | 20/20 通过，exit 0 |
| `REPORT_OFFICE_PYTHON=<验收用 Python> npm run test:office-export` | 20/20 通过；pdfplumber 对 11 个 PDF 共 43 页检查：文字重叠 0、越界 0 |
| 根管理者实跑模块测试 + 独立 reviewer | 20/20 与 20/20，无剩余阻塞 |
| 根管理者目视 QA（11 个 PDF / 43 页，全部 5 张 contact sheet） | 中文、分页、表格可读，无视觉阻塞（输出在 `06-workbench/tmp/report-office-full-qa-v2`） |
| `node test/smoke.test.mjs` | 28/28 通过（早前轮次，本轮未重跑） |

员工自测未设 `REPORT_OFFICE_PYTHON`；21/21 几何结果由根管理者在 `1e11d1c` 内容上实跑取得（见 1.1 与 7.1），不因员工未设环境变量而失效。视觉 QA 已在旧模块源码 `9f585d0` 上由根管理者完成（11 个 PDF / 43 页、5 张 contact sheet），本轮只改导入方式与回归，渲染逻辑未变，故该视觉证据继续覆盖；既有证据不「一概不适用」。

验收产物（gitignored）：`06-workbench/tmp/report-office-qa/` 与视觉 QA 渲染输出 `06-workbench/tmp/report-office-full-qa-v2/`。PDF 页数：五类基础报表 1 / 1 / 1 / 3 / 1 页；230 行长明细 19 页；单行 2,000+ 字摘要 4 页；4,000 字账套名 5 页；3,000 字无断词 ASCII 名称 4 页；4,000 字明细账科目名 3 页；现金流限制去重后 1 页。另有五类 XLSX 与 `pdftoppm` 渲染 PNG。员工以独立 ToUnicode 解析器与 pdfplumber 几何检查辅助；像素目视由根管理者完成。

## 8. 遗留与下一步

1. **最终独立审查进行中**：当前 head `5ba31adcbe32e9e7b7b99cec39b41db729572fb3`（`1e11d1c` + main `b42bae9`）正由最终独立 reviewer 审阅，结论未出，本任务单不预报；该源码的文档提交 head / PR 由根管理者后续填写。
2. 根管理者审阅实际 diff（仅 `report-office-export.mjs` + 测试 + 三份文档）；源码变更已完成复验（含 `REPORT_OFFICE_PYTHON` 的 21/21 与隔离无副作用证据），后续仅文档 / 无关基线更新不要求重跑整套。
3. 视觉 QA 已在旧模块源码 `9f585d0` 上完成（11 个 PDF / 43 页、5 张 contact sheet，无视觉阻塞），渲染逻辑未变；除非渲染逻辑再改，不重复目视。
4. LOCAL-05a 模块可以**单独一个 PR 合并**；共享接线（HTTP 路由、页面前端、允许格式白名单、`docs/REPORT-EXPORT.md` 更新）是**另一个 PR**，需等 LOCAL02 #47 释放窗口后由根管理者排工，且不得再派给已关闭的 LOCAL01 #43。
5. 远端 `main` 已前进到 `b42bae9`（PR #50 仅新增独立输出边界文件），已由根管理者合入本分支并得到当前 head `5ba31ad`；员工不做 Git 操作。
6. 后续核心子包：现金流复杂双向分类、间接法独立勾稽、双准则官方行次 / 科目映射；当前格式层只保留限制提示，不声称已修。
