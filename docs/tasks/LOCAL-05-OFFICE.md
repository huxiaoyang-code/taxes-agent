# LOCAL-05a / Issue #45 内部报表真实 XLSX / PDF 导出

## 1. 基本信息

- 任务 ID：LOCAL-05a（五类内部报表真实 XLSX / PDF 导出）；总任务 LOCAL-05 尚未完成。本任务单现包含**模块交付**（已合并）与**接线**（已独审，已在冻结核心之上完成预整合候选，未 PR / 未合并）两个部分。
- 状态：**模块已随 PR #52 合并**（merge `257f96275031eefa484699dd71bd012e2d221e51`，源码最终 `2681df1`；管理者 / 独立 reviewer 21/21 含 11 个 PDF 几何，原 11 PDF / 43 页已全目视）。接线分支 `codex/huxiaoyang-code/local-05-wire` 基于该 merge，完成：页面格式选择 + 下载校验、真实 HTTP 黑盒测试、**`server.mjs` 报表导出路由实际挂载 `buildOfficeExport`**（只改导出路由与错误映射，不新增框架）、**最小接线回归修复**（附件真实支持 xlsx；`/export-data` 保持严格 CSV DTO；旧失效断言已在本分支解决），以及四份文档（原三份 + 本轮追加所有权的 `docs/REPORT-EXPORT.md`）。
- 冻结 head：`71894a13828e828b530e5b2258bd6812bbc6064f`（源码冻结 head）。**未建 PR / 未合并**；当前只做到**冻结核心 3a8 之上的预整合候选**（见 1.2），不是最终 main。历史快照：该分支在 `71894a1` 时点为 1 个提交、相对**当时**的 `origin/main` ahead 1 / behind 9，那只是 `71894a1` 时点的记录；预整合候选与当前 `main` 已不同，**不得把它当作当前差距**。
- 独立审查（未参与实现、未读员工日志，`fork_turns=none`）：在 `71894a1` 上实跑 `node test/report-office-http.test.mjs` **6/6、exit 0**、既有 `node test/report-export-http.test.mjs` **31/31、exit 0**；另用独立分支探针驱动页面 `downloadReport()`，三格式均触发下载，422 / 500 / MIME / 扩展名 / 长度 / 魔数失败均取消保存且控件恢复，提示文案不含内部路径。**探针不是真浏览器**。
- 页面实测（根管理者）：真实 IAB 新标签页加载本机 loopback 服务与合成账套（期初银行 1,000 / 资本 1,000；收入 800、费用 300；预览银行 1,500），CSV / XLSX / PDF 分别页面选择并点击，均显示“已生成并开始下载”，按钮正常恢复；服务 / 库 / 标签页已自清理，截图留在 root 忽略目录。**只声称页面实际生成并触发下载**：未检查浏览器保存位置，也未新增 PDF 几何结论；真实附件二进制重开由 HTTP 套件的独审证据覆盖。
- 当前候选状态：源码已独审；`scripts/test-all.mjs` 的登记已在**本轮预整合**完成（55 → 56，新套件追加在末尾），最终整合 / PR / 合并仍待根管理者。**非全包 LOCAL-05 完成**：复杂现金流分类与双准则官方映射按后续核心子包（LOCAL-03 等）处理。
- 历史轮次（2026-10-22 文档纠正）：那一轮只改 4 份文档（`docs/tasks/LOCAL-05-OFFICE.md`、`docs/handoffs/LOCAL-05-OFFICE.md`、`docs/REPORT-OFFICE-EXPORT.md`、`docs/REPORT-EXPORT.md`），源码 / 测试不改，未重复跑测试。该轮记录按历史保留，**当前状态以 1.2 为准**。
- 代码来源：模块源冻结于 `9f585d0`（`feat(reports): add verified Excel and PDF export module`）；纯 DTO 无副作用修改 `1e11d1c`；模块源码最终 `2681df1`，随 PR #52 合并为 merge `257f96275031eefa484699dd71bd012e2d221e51`。
- 本阶段分支：`codex/huxiaoyang-code/local-05-wire`（基于 `257f962`）。
- 负责人（人类成员 / GitHub）：`huxiaoyang-code`。
- 执行员工：pi（主 / 唯一回退模型 `tokenhub/deepseek-v4.1-flash` 锁定；未使用其他模型或子 agent）。
- 原始基线（分叉时）：`0c4e0dd622fc35bcb5d6e6af3620c6f971b2a805`。
- 关联 Issue：#45（本任务）。LOCAL01 #43（共享接线）**已合并关闭**。**当前文件归属（更正过时旧说法）**：`server.mjs` 与 `public/`（`index.html` / `app.js`）**归本任务 #45**（接线 diff 已在冻结 head 与预整合候选中，最终由根管理者在实际 `main` 上合并）；`scripts/test-all.mjs` 的登记所有权**本轮预整合已由 #47 释放给 #45**（只在末尾追加 1 个套件，见 1.2）。**Agent / MCP / 公共 `docs/handoffs/STATE.md` / 公共索引仍归 LOCAL02 #47**，本任务不改。

### 1.1 既有验收事实（分两类记录，互不覆盖也不互相否定）

**旧模块源码 `9f585d0`（渲染逻辑自那以后未变）：**

- 根管理者实跑模块测试 **20/20 通过、exit 0**；独立 reviewer **20/20**，无剩余阻塞。
- 11 个 PDF 共 43 页几何检查：文字重叠 **0**、越界 **0**（pdfplumber）。
- 根管理者**已实际渲染 11 个 PDF（共 43 页）并逐张检查全部 5 张 contact sheet**，确认中文、分页、表格可读、无视觉阻塞。视觉检查**已完成**，不是待办；渲染输出在 `06-workbench/tmp/report-office-full-qa-v2`（gitignored）。

**当前纯 DTO 修改（`1e11d1c` 内容，只改动态 `import` + 新增隔离回归，不改渲染）：**

- 根管理者实跑 `REPORT_OFFICE_PYTHON=<验收 Python> npm run test:office-export`：**21/21 被接受、exit 0**，明确输出 `pdfplumber geometry verified for 11 PDFs`。
- 原 pure 员工在中断前同样完成过 21/21、exit 0（含几何）；恢复员工做文档与回归后亦 exit 0。

既有视觉 / 几何证据覆盖的是**未改变的渲染逻辑**；本次新增隔离回归证明的是**纯 DTO 导入不打开数据库**。只有渲染 / 导入逻辑本身变动才需重做对应检查，仅文档或无关基线（如新增独立 LOCAL08 模块）更新不要求重跑整套。

**合并事实**：上述模块与回归已随 PR #52 合并（merge `257f96275031eefa484699dd71bd012e2d221e51`，源码最终 `2681df1`）。本阶段只在其上做页面与 HTTP 测试，**不改模块渲染代码**；预整合轮的全量 56 套复跑确实再次经过 `office-export` 21/21 与 pdfplumber 几何（见 1.2），那是**顺带实跑**，不等于重新做像素目视。

### 1.2 预整合轮（2026-10-22，冻结核心 3a 之上的候选）

本轮把本包的接线候选叠到**冻结核心** `3a8ae7ab0a3ca61ed15ddc6aa112eba6c4837795` 之上做预整合，范围严格限定：

- 唯一冲突只在 `06-workbench/server/server.mjs` 顶部：Office 的 `REPORT_NOT_FOUND_ERRORS` / `REPORT_REJECTED_ERRORS` / `REPORT_FONT_ERRORS` / `reportError()` 与核心的 `PERIOD_GUARD_CODES` 相邻插入冲突。解决方式只做**语义并列保留**：Office 固定错误映射（400 / 404 / 422 / 500 与固定中文文案、`details: null`）与核心期间守卫错误码集合（409 + 明细）同时保留，两套行为都不丢、互不覆盖；未改其它路由、中间件、启停逻辑，也未改任何公共 UI 或业务模块。
- `06-workbench/scripts/test-all.mjs` 只在**末尾追加** `report-office-http`（真实本包 `server.mjs` 子进程套件），套件总数 **55 → 56**；原 55 个套件的顺序与内容一字未动，未删改任何旧断言。该文件的登记所有权本轮由 LOCAL02 #47 释放给 Issue #45。
- 四份文档（本文件、`docs/handoffs/LOCAL-05-OFFICE.md`、`docs/REPORT-OFFICE-EXPORT.md`、`docs/REPORT-EXPORT.md`）同步为当前事实；共享 `docs/handoffs/STATE.md` 与公共索引仍归 #47，本任务不改。
- 本包源码 / 测试语义与冻结 head `71894a1` 一致（只多了冲突解决导致的相邻并列与统一入口追加）。

**本轮实跑（员工自测 + 管理者独立复验，两层结论一致）**：在 `06-workbench` 设 `REPORT_OFFICE_PYTHON` 后跑 `npm test`（真实 56 套，临时合成库，随机回环端口），员工自测与管理者独立复验均为 **56 / 56 套 exit 0**，且都含 `office-export` **21/21** 与 `pdfplumber geometry verified for 11 PDFs`；员工侧另记 `report-office-http` **6/6**、`report-export-http` **31/31**、`accounting-period-*` 与 `local-backup` 等核心套件全绿。两份完整输出各自保全在忽略目录日志，**未 skip 几何、未弱化断言、未只跑部分**。

**边界**：本轮只是**冻结核心之上的预整合候选**，不是最终 `main`；LOCAL-02 #47 的备份修复落到实际 main 后，还需在真正的最终 main 上同步这份补丁，并在该 head 上重新独审与实跑。最终审查 / PR / 合并仍待；LOCAL-05 整体、双准则与复杂现金流仍未完成。

## 2. 需求与边界

- 目标：在既有 `06-workbench/server/report-export.mjs` 稳定 `report` DTO（`schemaVersion: 1`）之上，为 `balance-sheet`、`income-statement`、`cash-flow-statement`、`trial-balance`、`ledger` 五类内部报表生成真实 XLSX 与 PDF 二进制；保留 CSV。
- 明确不做：
  - **模块阶段**不改 `report-export.mjs`、`tax-report-format.mjs`、`accounting.mjs`、`db.mjs`、`server.mjs`、agent tools、MCP、`scripts/test-all.mjs`、公共索引或 `public/*`。
  - **接线阶段（历史约束）**只允许在 `server.mjs` 的报表导出路由上做最小挂载（import `buildOfficeExport`、`await` 生成后再写头、固定错误映射），不改该文件其他路由 / 中间件 / 启停逻辑；当时 `scripts/test-all.mjs` 仍归 LOCAL02 #47，禁止为让新测试进统一入口而抢改。**该约束已由本轮预整合受控放开**：经所有权释放后仅在 `test-all.mjs` 末尾追加 1 个套件（55 → 56，原 55 内容 / 顺序不变），先 1 行登记 + 1 行注释，不重排、不修改既有套件。Agent / MCP / 会计 / `report-export.mjs` / `tax-report-format.mjs` / `db.mjs` / `package.json` / `package-lock.json` / 公共 docs 一律不改。
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

### 5.1 接线阶段验收（本阶段）

- 页面五类报表均可选择 CSV / Excel / PDF，文案为清晰中文；下载按所选格式传 `format`，并按格式校验 `Content-Type` / 扩展名（含 `Content-Disposition`）/ `Content-Length` / 文件魔数，不匹配即取消保存；错误页不能被当附件保存；错误提示不包含堆栈或字体绝对路径。
- 预览仍用 `/export-data` 的 DTO，并保持**原严格格式契约**：缺省 / `format=csv` 返回同一 CSV DTO；`xlsx` / `pdf` / `yaml` / 空 `format=` 仍为 400 `report_format_unsupported`（`details: {supported:["csv"]}`），**不为纯 DTO 生成 xlsx / pdf 附件，也不把无效输入静默转 CSV**。
- 附件路由 `/export` 真实支持 `csv` / `xlsx` / `pdf`（缺省 `csv`）。
- `06-workbench/test/report-office-http.test.mjs` 必须在临时合成库上启动本包 `server.mjs` 子进程（随机回环端口），通过真实 HTTP 覆盖五类 × 三格式；XLSX 由 ExcelJS 重开并比对独立手算金额，PDF 校验魔数 / 中文文本 / 可打开页数（真实文本提取 + 可用时 `pdfinfo`），CSV 保持旧语义；未过账凭证排除；未知格式 / 缺科目 / 未登记期间 / 缺字体 / 超长字段不产生半截附件；下载不改变数据库。
- **已挂载并实际全绿**：`server.mjs` 导出路由改为 `await buildOfficeExport(...)`，同一测试在真实 `server/server.mjs` 子进程上 **6/6 通过、exit 0**（2026-10-22 实跑）。准备阶段的“临时替身 6/6”只是历史旁证，**不作为验收证据**；正式证据是本条的真实服务实跑。

## 6. 文件所有权

- 模块阶段（已合并）新增 / 修改：
  - `06-workbench/server/report-office-export.mjs`（新增）
  - `06-workbench/test/report-office-export.test.mjs`（新增）
  - `docs/tasks/LOCAL-05-OFFICE.md`、`docs/handoffs/LOCAL-05-OFFICE.md`、`docs/REPORT-OFFICE-EXPORT.md`（新增）
  - `06-workbench/package.json`（仅依赖与 `test:office-export`）、`06-workbench/package-lock.json`（新依赖锁定）
- 本轮无副作用小修只改 `report-office-export.mjs`、`report-office-export.test.mjs` 与上述三份文档；未改 `package.json` / `package-lock.json`。
- **本阶段精确允许（提交 `71894a1` 为 8 个文件；本轮文档纠正再追加 `docs/REPORT-EXPORT.md`）**：`06-workbench/server/server.mjs`（**仅**报表导出路由 + import + 错误映射）、`06-workbench/public/app.js`、`06-workbench/public/index.html`、新增 `06-workbench/test/report-office-http.test.mjs`、`06-workbench/test/report-export-http.test.mjs`（仅失效旧断言替换 + 两条路由契约回归，已在 Issue #45 comment 6340280514 认领）、`docs/REPORT-OFFICE-EXPORT.md`、`docs/tasks/LOCAL-05-OFFICE.md`、`docs/handoffs/LOCAL-05-OFFICE.md`，以及本轮追加所有权并修正的 `docs/REPORT-EXPORT.md`。其他一概不改（`package.json` / `package-lock.json` / 模块实现无需改）。
- （接线阶段口径）除本包自有文件外，以下共享文件仍未改动：`report-export.mjs`、`tax-report-format.mjs`、`accounting.mjs`、`db.mjs`、agent tools、MCP、公共索引；`server.mjs` 只在报表导出路由与错误映射有 diff。**预整合轮新增的唯一共享文件改动**是 `scripts/test-all.mjs` 末尾追加（已获 #47 释放登记所有权），未动其既有 55 个套件。
- `docs/REPORT-EXPORT.md` 的所有权已随本轮追加到 Issue #45 并修正为当前事实（纯 CSV DTO 函数 + `/export-data` 严格 CSV DTO + `/export` 三格式 + 失败无附件；旧“首版仅 CSV”只作历史）；其他公共文档不在本任务可写范围。

## 7. 验证记录（员工自测）

工作目录 `06-workbench`，全部使用临时合成库（`WORKBENCH_DATA_DIR` 指向系统临时目录，退出时关闭并删除），不触碰真实数据。

### 7.1 本轮无副作用小修的实际命令与结果

| 命令 | 结果 | 退出码 |
|---|---|---|
| `node --check server/report-office-export.mjs` / `node --check test/report-office-export.test.mjs` | 两个文件语法检查通过 | 0 |
| `npm run test:office-export`（员工自测，未设 `REPORT_OFFICE_PYTHON`） | **21/21 通过**（原 20 项全部保留 + 新增隔离子进程 1 项）；含 poppler 页数 / PNG 渲染；pdfplumber 几何检查明确 SKIP | 0 |
| `REPORT_OFFICE_PYTHON=<验收 Python> npm run test:office-export`（根管理者在 `1e11d1c` 内容上实跑） | **21/21 通过**，`pdfplumber geometry verified for 11 PDFs` | 0 |
| `node test/report-export.test.mjs` | 21/21 通过（既有 CSV / DTO 回归未受影响） | 0 |
| `node test/report-export-http.test.mjs` | 29/29 通过（既有 HTTP 导出契约未受影响；上阶段早前轮次） | 0 |
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

## 8. 接线阶段（2026-10-22）

目标：让用户能在页面选 CSV / Excel / PDF 并拿到真实文件，同时用可重复的真实 HTTP 黑盒测试锁住契约。`server.mjs` 的导出路由已**实际挂载** `buildOfficeExport`（只改路由与错误映射）；统一测试入口的登记在预整合轮完成（`report-office-http` 追加在末尾，55 → 56）。

### 8.1 已实施

- `06-workbench/public/index.html`：报表面板新增中文格式选择（CSV / Excel 工作簿 / PDF），下载按钮改为“下载报表”，提示文案明确三类都是内部报表、预览不生成 PDF。
- `06-workbench/public/app.js`：`downloadReport()` 按所选格式传 `format`，并校验 `Content-Type`、`Content-Disposition` 的 `filename*`（UTF-8 解码后扩展名必须与所选格式一致；无 `filename*` 时退回本地 `<kind>-<period><扩展名>`）、`Content-Length` 与真实魔数；不匹配即取消保存，因此 HTML / JSON 错误页不会被当成 xlsx。**UI 未实现 `filename` 与 `filename*` 的同名比对**，只校验实际采用的 `filename*` 扩展名；相关响应头的一致性由 HTTP 套件断言。错误提示用固定中文文案，不透传堆栈或字体路径。预览仍用 `/export-data` 的 DTO。
- 新增 `06-workbench/test/report-office-http.test.mjs`（6 个用例）：临时 `WORKBENCH_DATA_DIR` + 本包 `server.mjs` 子进程（`PORT=0` 随机回环端口，不接旧 / 税局服务）；合成账套、期初、已过账与**未过账**凭证；五类 × 三格式真实下载；XLSX 用 ExcelJS 重开并比对**独立手算**的收入 / 利润 / 现金 / 明细；PDF 独立解析 ToUnicode 与文本流并用 `pdfinfo` 核对页数；CSV 旧语义；非法请求 / 缺字体 / 超长字段均无附件；下载后全库快照不变；结束时先校验临时目录归属再删除。
- `06-workbench/server/server.mjs`：报表导出路由改为 `await buildOfficeExport(+id, { kind, period, format, code })`；`export-data` 先按原契约校验格式，仅缺省 / `csv` 返回 CSV DTO，`xlsx` / `pdf` / `yaml` / 空 `format=` 一律 400 `report_format_unsupported`（**客户端传什么 `format` 都不会生成 Office 或返回附件**）；只有生成成功后才 `res.writeHead(200)`，`Buffer` 原样输出、字符串按 UTF-8 转 `Buffer`，头使用模块返回的 `contentType` / `filename` 与既有 `attachmentName()`，保留 `x-content-type-options: nosniff` 与 `cache-control: no-store`；错误统一经固定映射函数，不把 `details` 内部信息、字体路径或堆栈返回给用户。

### 8.2 实际结果（真实 `server.mjs` 已挂载）

| 命令 | 结果 | 退出码 |
|---|---|---|
| `node --check server/server.mjs` / `node --check public/app.js` / `node --check test/report-office-http.test.mjs` | 语法通过 | 0 |
| `node test/report-office-http.test.mjs`（真实本包 `server.mjs` 子进程、临时合成库、随机回环端口） | **6/6 通过**：CSV 五类（BOM / 中文 / 行语义）、XLSX 五类（ExcelJS 重开 + 独立手算）、PDF 五类（魔数 / 嵌入字体 / 中文文本 / 页脚 / `pdfinfo` 页数）、预览 DTO（含 `xlsx|pdf|yaml|空` 一律 400）、既有输入校验、超长字段 422 与缺字体 500 均无半截附件、下载后全库快照不变 | 0 |
| `node test/report-export.test.mjs` | 21/21 通过（CSV / DTO 契约未受影响） | 0 |
| `node test/report-export-http.test.mjs` | **31/31 通过**（旧 `format=xlsx` 必须 400 断言已改为真正不支持的 `yaml`；新增 `/export-data` 严格 CSV 契约与 `/export` 真实 XLSX 附件两条回归） | 0 |
| `REPORT_OFFICE_PYTHON=<验收 Python> npm run test:office-export` | **21/21 通过**，`pdfplumber geometry verified for 11 PDFs`（**前轮结果**；本轮未改模块渲染代码，未重跑） | 0（前轮） |

准备阶段“临时替身 6/6”只是历史旁证，**不作为验收证据**；正式证据是上表真实 `server/server.mjs` 的 6/6。

### 8.4 最小接线回归修复（2026-10-22）

只修两个点，不改模块渲染 / 会计 / 其它 public：

1. **附件路由真实支持 xlsx**：`/export?format=xlsx` 按契约返回 200 真实工作簿，因此旧套件里“`format=xlsx` 必须 400”的历史断言失效。处理方式为**替换**而非删除：改成真正不支持的 `format=yaml`，保留 `format=` 空值用例，错误断言仍为 400 + `report_format_unsupported` + `application/json` + 无 `Content-Disposition`；新增“`/export` 以 XLSX 附件返回”的严格断言（Content-Type、`.xlsx` 文件名、`PK\x03\x04` 魔数、`Content-Length`）。新真实 HTTP 6 项全部保留。
2. **`/export-data` 恢复原严格格式契约**：`server.mjs` 预览分支在调用导出模块前先校验 `format`，仅接受缺省 / `csv`；`xlsx` / `pdf` / `yaml` / 空 `format=` 一律 400 `report_format_unsupported`（`details: {supported:["csv"]}`，与接线前 `report-export.mjs` 契约一致），**不静默转 CSV、不为纯 DTO 生成 xlsx / pdf 附件**；`/export` 的 `csv` / `xlsx` / `pdf` 支持不变。

新增回归明确两条路由契约：`/export-data` 在缺省与 `format=csv` 下返回 `schemaVersion: 1` 的 JSON DTO（无附件、`no-store`），四种无效格式为严格 400；`/export` 的 `format=xlsx` 为真实附件。两套测试各自都覆盖这两条契约（`report-export-http` 与新增的 `report-office-http` 预览 / 输入校验用例）。

本轮实跑（`06-workbench`，临时合成库，真实 `server.mjs` 子进程 + 随机回环端口）：`report-office-http` **6/6**、`report-export-http` **31/31**、`report-export` **21/21**，均 exit 0；保留 CSV 值 / XLSX 重读 / PDF 文本断言。源码 Office 生成器未变，**前轮 11 PDF 几何结果只标前轮，该接线轮（最小回归轮）未重跑**（不伪报；预整合轮已在 56 套里含此几何，见 1.2）。（历史轮次记录）该最小回归轮未跑全库 `npm test`：当时 `scripts/test-all.mjs` 仍为 47 套且归 LOCAL02 #47。**当前状态已变化**：预整合轮已在末尾登记 `report-office-http`（55 → 56）并实跑 56 / 56 exit 0，见 1.2。

### 8.3 已实施的挂载语义（不新增通用 HTTP 框架）

1. 导出路由 `await buildOfficeExport(setId, { kind, period, format, code })`；`export-data` 固定 CSV DTO，不生成 Office：`server.mjs` 在调用导出模块前先校验，缺省 / `format=csv` 返回同一 DTO，`format=xlsx` / `pdf` / `yaml` / 空 `format=` 一律 **400 `report_format_unsupported`（`details: {supported:["csv"]}`）**，不静默转 CSV、也不返回附件；只有 `/export` 才按 `csv | xlsx | pdf` 生成真实附件。
2. 仅生成成功后写头；`Buffer` 原样输出，字符串按 UTF-8 转 `Buffer`；`Content-Type` / `Content-Length` / `Content-Disposition` 用模块返回的 `contentType` / `filename` 与既有 `attachmentName()`。
3. 固定错误映射（已实现）：既有输入错误 400；`account_set_not_found` / `account_not_found` 404；`report_data_invalid` / `office_text_too_long` 422（后者 `details` 只保留 `{field,length,limit}`，不回显原文）；`pdf_font_unavailable` / `pdf_font_glyph_missing` 500（原错误码 + 固定中文文案、`details: null`）；其他 500 `report_export_failed`、`details: null`。
4. 失败必须是 JSON 且无 `Content-Disposition`；成功必须是完整文件，无半截附件。

详细契约与错误表见 [REPORT-OFFICE-EXPORT](../REPORT-OFFICE-EXPORT.md#接线页面格式选择与真实-http-黑盒测试2026-10-22)。

### 8.5 独立审查与页面验收（2026-10-22）

冻结 head `71894a1`，源码 / 测试自本轮起不再改动。证据分四层，互不替代：

| 层 | 执行者 | 结论 | 不覆盖 |
|---|---|---|---|
| 真实 HTTP（新套件） | 独立审查（未参与实现） | `node test/report-office-http.test.mjs` **6/6、exit 0**；本包 `server.mjs` 子进程、临时合成库、随机回环端口 | 浏览器行为 |
| 真实 HTTP（既有套件） | 独立审查 | `node test/report-export-http.test.mjs` **31/31、exit 0**（含 `/export-data` 严格 CSV 与 `/export` 真实 XLSX 契约） | 同上 |
| 页面脚本 | 独立审查 | 独立分支探针：CSV / XLSX / PDF 三格式均触发下载；422 / 500 / MIME / 扩展名 / 长度 / 魔数失败均取消保存并恢复控件；内部路径不显示 | **不是真浏览器**，不证明真实点击与保存 |
| 页面实测 | 根管理者 | 真实 IAB 新标签页 + 本机 loopback 服务 + 合成账套（期初银行 1,000 / 资本 1,000；收入 800、费用 300；预览银行 1,500）；三格式分别选择并点击均显示“已生成并开始下载”、按钮恢复；服务 / 库 / 标签页自清理，截图在 root 忽略目录 | **未检查浏览器保存位置**，**未新增 PDF 几何** |

结论口径：页面**实际生成并触发了下载**；真实附件二进制（XLSX 可重开、PDF 可解析、CSV 行语义）由上面 HTTP 套件的独立审查证据承担，不由页面点击替代。

## 9. 遗留与下一步

1. **原范围外历史断言已解决**：`06-workbench/test/report-export-http.test.mjs` 中 `["period=2026-01&format=xlsx", "report_format_unsupported"]` 是接线**前**的旧事实；本轮已替换为真正不支持的 `format=yaml`（未删测试、未 skip、未改弱 3 格式断言），该套件现 **31/31 通过**，并新增两条路由契约回归。该文件已在 Issue #45 comment 6340280514 追加认领，计入本阶段 8 个文件。
2. **`scripts/test-all.mjs` 已登记（本轮预整合）**：`report-office-http` 追加在末尾，55 → 56，原 55 个套件顺序 / 内容不变；该文件所有权已由 LOCAL02 #47 释放给本任务。员工自测与管理者独立复验均跑出 `npm test` **56 / 56 exit 0**，两者都含 `office-export` 21/21 与 pdfplumber 11 PDF 几何。最终 `main` 同步后的独审 / PR / 合并仍待。
3. **已提交 `71894a1`，未建 PR / 未合并**：员工不执行 Git；源码已独审（见 8.5），可进入整合；PR、合并与最终 main 同步仍待根管理者。本轮预整合是**冻结核心 3a8 之上的候选**，不冒充最终 main；#47 备份修复落到实际 main 后需在最终 main 上再同步一次本补丁。
4. **`docs/REPORT-EXPORT.md` 已在本轮修正**：该文件所有权已追加到 Issue #45，本轮改为准确交代“`report-export.mjs` 为纯 CSV DTO、`/export-data` 严格 CSV DTO、`/export` 真实三格式、失败无附件”，并把原“首版仅 CSV”标为已被接线取代的历史表述；不把内部报表称为法定双准则或官方申报格式。
5. 视觉 QA 已在旧模块源码 `9f585d0` 完成（11 个 PDF / 43 页、5 张 contact sheet，无视觉阻塞）。**“几何只标前轮、本轮未重跑”只属于接线历史轮**（`71894a1` 接线轮与最小回归轮未设 `REPORT_OFFICE_PYTHON`）；**本次预整合确实实跑了全量 56 套，其中含 11 个 PDF 的 `pdfplumber` 几何并输出 `pdfplumber geometry verified for 11 PDFs`**。边界保留：那是顺带实跑的几何数值检查，**仍未重新做像素目视**，渲染代码也仍未改。
6. 后续核心子包：现金流复杂双向分类、间接法独立勾稽、双准则官方行次 / 科目映射；当前格式层只保留限制提示，**不声称 LOCAL-03 或双准则已完成**。
