# LOCAL-05a / Issue #45 交接：内部报表 XLSX / PDF（模块已合并 + 接线 Draft PR #62 待最终审查）

## 状态

- 任务：五类内部报表真实 XLSX / PDF 导出（LOCAL-05a，Issue #45）；LOCAL-05 整体仍未完成。
- **模块已随 PR #52 合并**：merge `257f96275031eefa484699dd71bd012e2d221e51`，源码最终 `2681df1`；模块源冻结 `9f585d0`，纯 DTO 无副作用修改 `1e11d1c`。管理者 / 独立 reviewer 各 21/21（含 11 个 PDF 的 pdfplumber 几何），原 11 PDF / 43 页已全部目视检查。
- **接线已在本分支实现**：`codex/huxiaoyang-code/local-05-wire`，基于 merge `257f962`。完成：
  - 页面格式选择（CSV / Excel / PDF）与下载前强校验；
  - 新增真实 HTTP 黑盒测试 `06-workbench/test/report-office-http.test.mjs`（6 个用例）；
  - **`server.mjs` 报表导出路由实际挂载 `buildOfficeExport`**（`await` 生成成功后写头 + 固定错误映射；其他路由 / 中间件未动）；
  - 三份文档同步（`docs/REPORT-OFFICE-EXPORT.md`、`docs/tasks/LOCAL-05-OFFICE.md`、本交接）；本轮再把追加入 Issue #45 所有权的 `docs/REPORT-EXPORT.md` 一并按当前事实修正。
- **最小接线回归修复（2026-10-22）**：
  - `/export?format=xlsx` 本就应返回真实附件，旧套件“`format=xlsx` 必须 400”的断言已失效；已**替换**为真正不支持的 `format=yaml`（不删测试 / 不 skip / 不改弱），并新增 `/export` 真实 XLSX 附件断言；
  - `/export-data` 恢复**原严格 CSV 格式契约**：缺省 / `csv` 返回同一 DTO，`xlsx` / `pdf` / `yaml` / 空 `format=` 仍为 400 `report_format_unsupported`（`details: {supported:["csv"]}`），不静默转 CSV、不为纯 DTO 生成 Office 附件；
  - 两套测试都补了明确的两条路由契约回归（新真实 HTTP 6 项全部保留）。
- **正式证据**：在冻结 head `71894a1` 上，`node test/report-office-http.test.mjs`（真实 `server/server.mjs` 子进程）**6/6 通过、exit 0**；既有 `node test/report-export-http.test.mjs` **31/31 通过、exit 0**；`node test/report-export.test.mjs` **21/21 通过、exit 0**。准备阶段的“临时替身 6/6”**不作为验收证据**。
- **独立审查已完成（2026-10-22）**：审查者未参与实现、未读员工日志（`fork_turns=none`），**其审查 head 是 `71894a1`，不是当前候选 `a9fb1bcf`**；在该 head 上实跑上表两套 HTTP（6/6、31/31）并做页面脚本探针（三格式触发下载；422 / 500 / MIME / 扩展名 / 长度 / 魔数失败均取消保存且控件恢复；内部路径不显示）。**探针不是真浏览器**。
- **页面实测（root 管理者）**：真实 IAB 新标签页 + 本机 loopback 服务 + 合成账套（期初银行 1,000 / 资本 1,000；收入 800、费用 300；预览银行 1,500），CSV / XLSX / PDF 分别页面选择并点击，均显示“已生成并开始下载”、按钮恢复；服务 / 库 / 标签页已自清理，截图在 root 忽略目录。**只声称页面实际生成并触发下载**；未检查浏览器保存位置，也未新增 PDF 几何。
- **当前状态：源码冻结点 `71894a1`；本包分支基于 `d5816078`，已无冲突同步 LOCAL-02 的 [PR #60](https://github.com/huxiaoyang-code/youshu-fork/pull/60) 实际 main（merge `dfefae0`）得到候选 `a9fb1bcf112588f33f615523d46bff8f8bbeb50c`（PR #60 不含本包 Office 接线），已建 Draft [PR #62](https://github.com/huxiaoyang-code/youshu-fork/pull/62)（OPEN，未合并）**；最终独立审查（root / `review_local05`）尚未完成。员工不执行 Git；**前轮页面验收用**的后台 / 服务 / 临时库已清理（仅指那一轮，不概括当前进程 / 会话）。
- **历史轮次（2026-10-22 文档纠正）**：那一轮只改文档（含本轮追加所有权的 `docs/REPORT-EXPORT.md`），修正 3 处与代码不符的表述（`/export-data?format=xlsx` 实为 400、接线轮未重跑模块 21/21 几何、UI 不做 `filename` / `filename*` 同名比对）；该记录按历史保留，当前状态以下节为准。
- **前轮结果不冒充本轮**：源码 Office 生成器未变，模块轮 / 接线前轮的 21/21（含 11 PDF 几何）与视觉 QA **各自只属于其轮次**；预整合与最终同步轮（精确 `a9fb`）的全量 56 套里又顺带实跑了 `office-export` 21/21 与 pdfplumber 几何（见下节），但那不是重新做像素目视。
- **原合并前阻塞已解决**：`test/report-export-http.test.mjs` 失效旧断言已在本分支修正（该文件已在 Issue #45 comment 6340280514 追加认领，提交 `71894a1` 共 **8 个文件**）。
- （历史阶段事实，仅指前轮页面验收）前轮页面验收用的本地服务 / 后台进程 / 会话已清理，临时库、隔离临时目录与 gitignored 临时替身已删除；该句只描述那一轮，不概括当前进程 / 会话状态。

## 预整合、实际合入与 Draft PR #62（2026-10-22）

- **LOCAL-02 [PR #60](https://github.com/huxiaoyang-code/youshu-fork/pull/60) 已于 2026-10-22T13:34:48Z 实际 MERGED**：merge `dfefae0553052474b8a9308105443714bc5d9cfb`，最终文档 head `18aa6fb8b5d36181092397504bf1b8b338d71fb9`，其 tree `1d2a4b8b84e763ebac5bf52801d4989b7f5b8e33` 与 merge tree 一致；Issue #47 已 CLOSED。
- 本包分支基于 `d58160783f89bfeb21e80a584b9eceadf6c2b60f`，**已无冲突同步 PR #60 实际 main `dfef`**（PR #60 不含本包 Office 接线），得到当前源码候选 `a9fb1bcf112588f33f615523d46bff8f8bbeb50c`；相对 `d581` 只带入 main 已验收的备份 / 审计改动，**本包 Office 源码未变**。
- 预整合范围（历史记录，仍在候选内）：`server.mjs` 顶部冲突只做语义并列保留 —— Office 固定错误映射（400 / 404 / 422 / 500、固定中文文案、`details: null`）与核心 `PERIOD_GUARD_CODES`（409 + 明细）同时保留，其它路由 / 中间件未动；`scripts/test-all.mjs` 只在末尾追加 `report-office-http`（55 → 56，原 55 个套件内容 / 顺序不变），登记所有权由 LOCAL02 #47 释放给 Issue #45；四份文档同步。
- **管理者独立实跑（精确 `a9fb` 源码）**：`REPORT_OFFICE_PYTHON=<已核实 Python> npm test` → **56 / 56 套 exit 0**；忽略目录相对证据名 `local-05-final-manager-test.log`（含 `pdfplumber geometry verified for 11 PDFs` 与 `Office export acceptance: 21/21 passed`），exit 文件为 0。`report-office-http` **6 / 6**、`report-export-http` **31 / 31** 通过。
- **证据分层（不混轮）**：LOCAL-02 的 root 55 套、Office 21 / 21、11 PDF 几何、备份 22 / 22 均在**精确 98a** 取得；核心 `bd05415`、输出协议 `3a8ae7a`、备份（精确 98a）各自独审接受，旧 v3 / v4 备份恢复另有过独审；最终文档 head `18aa6fb` 未重跑这些套件。本包 `71894a1` 独审与真实 IAB 三格式点击 / 控件恢复记录继续有效，**浏览器保存位置未查、未新增像素目视**。
- **PR 状态**：Draft [PR #62](https://github.com/huxiaoyang-code/youshu-fork/pull/62) **OPEN、未合并，未合入 main**；最终独立审查（root / `review_local05`）待做。LOCAL-05 整体、双准则与复杂现金流仍未完成。

## 本阶段变更（接线轮 8 个文件）

新增：

- `06-workbench/test/report-office-http.test.mjs`
  - 6 个用例：CSV 五类（旧语义 + BOM + 中文 + 行内容）；XLSX 五类（ExcelJS 重开 + 独立手算金额 + 逐笔明细 + 未过账排除）；PDF 五类（魔数 + 嵌入字体 + ToUnicode 文本提取 + 页脚 + 独立手算金额 + `pdfinfo` 页数交叉核对）；预览仍为 DTO；既有输入校验仍为 JSON 无附件；生成失败（超长字段 / 缺字体）固定 JSON 错误且无半截附件。
  - 自建临时 `WORKBENCH_DATA_DIR` 与子进程（`PORT=0` 随机回环端口），只启动本包 `server.mjs`，不接旧后端 / 税局服务；定期快照全库并在结束时断言未被下载改动；清理前先校验目录属于 OS 临时目录。

修改：

- `06-workbench/test/report-export-http.test.mjs`（Issue #45 comment 6340280514 追加认领）：
  - 失效旧断言 `["period=2026-01&format=xlsx", "report_format_unsupported"]` **替换**为真正不支持的 `format=yaml`（保留 `format=` 空值），严格错误断言不变（400 + `report_format_unsupported` + JSON + 无 `Content-Disposition`）；
  - 新增回归：`/export-data` 缺省与 `format=csv` 返回 `schemaVersion:1` JSON DTO，`xlsx` / `pdf` / `yaml` / 空一律 400 `report_format_unsupported`；`/export?format=xlsx` 返回 200 真实工作簿（`spreadsheetml` Content-Type、`.xlsx` 文件名、`PK\x03\x04` 魔数、`Content-Length` 一致）。
- `06-workbench/server/server.mjs`（**仅报表导出路由**）：
  - import 改为 `buildOfficeExport`；下载路由 `await buildOfficeExport(+id, { kind, period, format, code })`（`csv | xlsx | pdf`，缺省 `csv`）；
  - `export-data` **保持原严格格式契约**：调用导出模块前先校验，仅接受缺省 / `csv`，其他格式抛 `report_format_unsupported`（`details: {supported:["csv"]}`）→ 400，**不静默转 CSV、不生成 Office 附件**；
  - 只有生成成功后才 `writeHead(200)`；`Buffer` 原样输出、字符串 UTF-8 转 `Buffer`；头用模块 `contentType` / `filename` 与既有 `attachmentName()`，保留 `nosniff` / `no-store`；
  - 错误统一经 `reportError()` 固定映射：输入错误 400、未找到 404、`report_data_invalid` / `office_text_too_long` 422（后者 `details` 只留 `{field,length,limit}`）、`pdf_font_unavailable` / `pdf_font_glyph_missing` 500（原错误码 + 固定中文文案、`details: null`）、其他 500 `report_export_failed`。
  - 未改动该文件的其他路由 / 中间件 / 启停逻辑。
- `06-workbench/public/index.html`：报表面板新增中文格式选择（CSV 表格 / Excel 工作簿 / PDF），按钮改为“下载报表”，提示说明三类均为内部报表、预览不生成 PDF。
- `06-workbench/public/app.js`：`downloadReport()` 按所选格式传 `format`，并校验 `Content-Type`、`Content-Disposition` 的 `filename*`（UTF-8 解码后扩展名需与所选格式一致；无 `filename*` 时退回本地 `<kind>-<period><扩展名>`）、`Content-Length`、文件魔数（CSV BOM / `PK\x03\x04` / `%PDF-`）；不匹配即取消保存，错误提示使用固定中文文案，不透传堆栈或字体路径。预览仍走 `/export-data` 的 DTO。**UI 未实现 `filename` 与 `filename*` 同名比对**，响应头一致性由 HTTP 套件断言。
- `06-workbench/test/report-office-http.test.mjs`（新套件本轮仅补预览格式断言）：6 个用例保持不变（CSV / XLSX / PDF 五类真实下载与手算、预览 DTO、输入校验、生成失败无半截附件、下载后全库快照不变）；预览用例新增 `xlsx` / `pdf` / `yaml` / 空 `format=` 的严格 400 `report_format_unsupported` 断言。
- `docs/REPORT-OFFICE-EXPORT.md`、`docs/tasks/LOCAL-05-OFFICE.md`、`docs/handoffs/LOCAL-05-OFFICE.md`：同步合并事实、接线与两条路由契约、回归修复、实测结果与待完成项。

（接线轮历史记录）刻意未改：

- `scripts/test-all.mjs`（当时归 LOCAL02 #47（仍 47 套）、Agent / MCP、`accounting.mjs`、`db.mjs`、`report-export.mjs`、`tax-report-format.mjs`、`report-office-export.mjs`（源码 Office 生成器未变）、`public/` 其他文件、`package.json` / `package-lock.json`、公共索引、`docs/REPORT-EXPORT.md`。

预整合与最终同步的变化仅限：`server.mjs` 顶部冲突语义解决、`scripts/test-all.mjs` 末尾登记 1 个套件（已获所有权释放）、同步 PR #60 实际 main 带入的已验收备份 / 审计，以及四份文档同步；其余仍不改。

## 已实施的挂载语义（根管理者审查时对照）

1. 下载路由 `await buildOfficeExport(setId, { kind, period, format, code })`（`csv | xlsx | pdf`，缺省 `csv`）；`export-data` 预览保持原严格 CSV 格式契约（缺省 / `csv` 返回 DTO，其余 400 `report_format_unsupported`），不生成 Office 文件。
2. 只有生成成功后写响应头；`Buffer` 原样输出，字符串按 UTF-8 转 `Buffer`；`Content-Type` / `Content-Length` / `Content-Disposition` 使用模块返回的 `contentType` / `filename` 与既有 `attachmentName()`，保留 `nosniff` / `no-store`。
3. 固定错误映射：既有输入错误 400；`account_set_not_found` / `account_not_found` 404；`report_data_invalid` / `office_text_too_long` 422（后者 `details` 只保留 `{field,length,limit}`，不回显原文）；`pdf_font_unavailable` / `pdf_font_glyph_missing` 500（原错误码 + 固定文案、`details: null`）；其他 500 `report_export_failed`、`details: null`。
4. 失败必须是 JSON 且无 `Content-Disposition`；成功必须是完整文件，无半截附件。
5. 不新增通用 HTTP 框架、不做前端重构。

完整错误表与理由见 `docs/REPORT-OFFICE-EXPORT.md` 的“接线”一节。

## 验证结果（员工自测）

工作目录 `06-workbench`；全部临时合成库，无真实账套 / 凭据 / 税局系统。

| 命令 | 观察结果 | 退出码 |
|---|---|---|
| `node --check server/server.mjs`、`node --check public/app.js`、`node --check test/report-office-http.test.mjs` | 语法通过 | 0 |
| `node test/report-office-http.test.mjs`（真实 `server.mjs` 子进程） | **6/6 通过**（五类×三格式 + 预览 DTO / 严格格式 400 + 输入校验 + 超长字段 422 / 缺字体 500 无半截附件 + 下载后全库快照不变） | 0 |
| `node test/report-export.test.mjs` | 21/21 通过 | 0 |
| `node test/report-export-http.test.mjs` | **31/31 通过**（旧 `format=xlsx` 断言改为真正不支持的 `yaml`；新增 `/export-data` 严格 CSV 契约与 `/export` 真实 XLSX 附件回归） | 0 |
| `REPORT_OFFICE_PYTHON=<验收 Python> npm run test:office-export` | **前轮 21/21**，`pdfplumber geometry verified for 11 PDFs`（本轮未改模块渲染代码，**未重跑**） | 前轮 0 |

接线准备阶段（挂载前）的 3 通过 / 3 失败与 gitignored 临时替身 6/6 均为**历史记录**，不作为验收证据；正式证据是上表真实服务的 6/6。

（接线轮历史记录）当时未跑全库 `npm test`（当时 `scripts/test-all.mjs` 仍为 47 套且归 LOCAL02 #47）。**当前状态已变化**：套件已登记为 56，管理者在精确 `a9fb` 实跑 **56 / 56 exit 0**（含 `office-export` 21/21 与 pdfplumber 11 PDF 几何）。

### 模块阶段既有验收（已合并，仍然有效）

| 命令 / 事实 | 结果 |
|---|---|
| `npm run test:office-export`（`9f585d0`） | 20/20 通过，exit 0 |
| `REPORT_OFFICE_PYTHON=<验收 Python> npm run test:office-export` | 21/21 通过（`1e11d1c` 内容），`pdfplumber geometry verified for 11 PDFs` |
| 根管理者 + 独立 reviewer | 20/20 与 20/20，无剩余阻塞 |
| 根管理者目视 QA（11 个 PDF / 43 页，全部 5 张 contact sheet） | 中文 / 分页 / 表格可读，无视觉阻塞 |
| `node test/report-export.test.mjs` / `node test/report-export-http.test.mjs` | 21/21、29/29（模块阶段早前轮次） |

模块渲染代码未改，因此不重做像素目视；轮次分开记：**11 PDF 几何只属于纯模块轮与初次接线前轮**，后续最小回归轮只跑 `report-office-http` 6/6、`report-export-http` 31/31、`report-export` 21/21（CSV / DTO），未设 `REPORT_OFFICE_PYTHON`，**不含几何**。

## 审查重点

1. 页面是否只在所选格式下下载对应类型，并在保存前校验 `Content-Type` / 扩展名 / `Content-Length` / 魔数；错误页是否绝不会被当附件保存。
2. 错误提示是否只使用固定中文文案，未把服务器堆栈、`details` 或字体路径显示给用户。
3. 预览是否仍为 DTO、与下载分离，且**保持原严格格式契约**（`xlsx` / `pdf` / `yaml` / 空 = 400 `report_format_unsupported`，不静默转 CSV、不生成附件）。
4. `server.mjs` 的 diff 是否只限报表导出路由 / import / 错误映射，未顺手改其他路由、中间件或启停逻辑。
5. 旧套件是否**替换而非删除**失效断言、错误断言未改弱，且新增的两条路由契约回归确实覆盖两条路由。
6. 新测试是否为真实子进程 HTTP（非 mock `buildOfficeExport`、非“源码包含 format”）、是否使用临时合成库与随机端口、是否验证未过账排除与手算金额、是否在结束时清理且不改库。
7. 是否未宣称 LOCAL-05 / LOCAL-03 / 双准则完成，也未把准备阶段临时替身或前轮 11 PDF 几何当本轮结果。

## 明确未完成 / 未声称

- **Draft PR #62 未合并，也未进入 main**：源码冻结点 `71894a1`，当前源码候选 `a9fb1bcf`；页面 / 路由 / 统一入口变更对用户主工作区尚未生效，取决于 PR #62 合并。
- **独立审查已完成，但审查 head 是 `71894a1`**。边界：源码、两套真实 HTTP 与页面脚本探针已独审，root 也已在真实页面点击三格式并看到“已生成并开始下载”；**未检查浏览器实际保存位置**；真实附件二进制重开以 HTTP 套件为证据。**“几何仍只指前轮 11 PDF”只属于接线历史轮**：预整合与最终同步轮（精确 `a9fb`）实跑 56 套，其中含 11 PDF 的 `pdfplumber` 几何并输出 `pdfplumber geometry verified for 11 PDFs`，但**仍未重新做像素目视**。当前候选的最终独立审查待 root / `review_local05`。
- **`scripts/test-all.mjs` 已登记**：新套件已追加在末尾（55 → 56，原 55 个套件顺序 / 内容不变）；管理者在精确 `a9fb` 实跑 `npm test` **56/56 exit 0**，含 Office 21/21 与 11 PDF 几何。合并取决于 PR #62。
- **`docs/REPORT-EXPORT.md` 已在本轮修正**：文件所有权已追加到 Issue #45；已准确交代“`report-export.mjs` 为纯 CSV DTO、`/export-data` 严格 CSV DTO、`/export` 真实三格式、失败无附件”，原“首版仅 CSV”标为已被接线取代的历史表述，不把内部报表称为法定双准则 / 官方申报格式。
- **未修复会计算法**：现金流比例分摊、间接法非独立勾稽、双准则官方映射、来源完整性仍按既有状态保留提示；不声称 LOCAL-03 或双准则完成。
- **未宣称申报就绪**：所有文件均为内部报表。

## 下一任务输入（根管理者）

- 源码冻结点 `71894a1` 上已完成一次独立审查（实跑 `report-office-http` 6/6、`report-export-http` 31/31 exit 0；页面脚本探针与 root 真实点击三格式均触发下载）；**当前候选 `a9fb1bcf` 的最终独立审查（root / `review_local05`）待做**，之后才进入合并。
- 预整合与实跑证据：`server.mjs` 顶部冲突语义解决（Office 固定错误映射 + 核心 `PERIOD_GUARD_CODES` 并列保留）、`scripts/test-all.mjs` 末尾登记（55 → 56）、四份文档同步；管理者在精确 `a9fb` 实跑 `npm test` **56 / 56 exit 0**（含 Office 21/21、11 PDF 几何、`report-office-http` 6/6、`report-export-http` 31/31），忽略目录相对证据名 `local-05-final-manager-test.log`，exit 文件 0。
- **后续所有权（计划，未释放）**：当前 root 持 main 锁。本 Office 最终验收合并后，`server.mjs` 共享入口计划交 Issue #44；`scripts/test-all.mjs` 计划先交 Issue #53 登记银行 4 套，53 完成后再由 #44 追加（#44 当前只代码 + 3 套件单跑）。只记录计划，不表示已释放，也不改本包实现。
- 剩余工作：读 diff、完成最终独立审查、写 PR 正文并合并（Draft PR #62 已存在，OPEN）。若挂载实现与文档契约不同（状态码或错误码），先确认契约变更并同步本任务 4 份文档，不能只改测试断言。

## Git / 回退

- 员工本轮未执行任何 Git 写命令（无 add / commit / push / merge），文档改动留在工作区由管理者处理。导出路由、页面变更、路由契约回归已冻结在 `71894a1`；预整合与最终同步只做 `server.mjs` 冲突语义解决 + `test-all.mjs` 末尾登记 + 同步 PR #60 实际 main 带入的已验收改动 + 四份文档。
- 本机实测：管理者在精确 `a9fb` 源码上实跑 `npm test` **56 / 56 套 exit 0**（含 Office 21/21 与 11 PDF 几何）；完整输出在忽略目录日志。PR #62 的最终独立审查与合并仍待。
- 若合并后发现缺陷，按项目规则用新的 revert PR 回退，禁止重写 main 历史。
- 临时替身 / 探针脚本只存在于 gitignored `06-workbench/tmp/`，已删除，不入库。
