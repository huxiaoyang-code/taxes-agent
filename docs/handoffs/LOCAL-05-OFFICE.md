> **2026-10-23 当前状态**：PR68 已合（merge `4146e46383e8826c8a4ee02b93f947c26efec014`），Issue56/61 已关闭；PR67 已合（merge `ef599f86b948e574aa1b796e2da21a31b7685fa6`），Issue59 已关闭。详细head/验证边界见 [LOCAL03a](LOCAL-03a.md) / [Windows](LOCAL-06-WINDOWS.md)。Issue64 的 [辅助A+B1](LOCAL-03b.md) 已实施、待管理验收/独审/PR；B2实际入口和一体维度导入未完。整包03/05/06/07仍未完成，真实税局0，UI文件上传仍未知。下方候选和未合状态为原日期历史，不代表当前主状态。

# LOCAL-05a 交接：内部报表 XLSX / PDF 与双准则候选

## 当前候选合同（2026-10-23）

负责人 `huxiaoyang-code`；分支 `codex/huxiaoyang-code/local-03a`，历史派工输入 `502640906262d6eefbe81b3460361e74ea0811b5`（不是当前候选 HEAD）；当前完整候选已本地保存为 `79a55e7d58e7d6d175997abc96ef6241afa37a14`，基线 main `47b6ec18385ef3f9f1240e12a721e46cd66f218f`，本轮文档提交后的最终 HEAD 由管理者另行锁定。双准则领域、出口、企业身份全入口已实施，当前候选已本地保存、未推送 / 未开 PR / 未合并，最终文档及不可变 HEAD 的独立接受待完成。统一入口保留 main 原 65 套逐字原序并末尾登记实际 8 套（3 个标准领域 / 迁移、身份领域 / HTTP / MCP、标准 HTTP / MCP），共 73 套；实际完整运行结果见下方“本轮完整验证”。

- 新建、legacy 首次导入与 incremental create 都必须显式稳定 `enterprise` / `source.enterpriseKey`；NFKC + trim，保留大小写，接受有限数值文本化，不从名称或来源系统造身份。同 key 换名 / 换来源不得另建账套，不同 key 同名允许。账套 / profile / 科目 / 期间 / canonical 身份在同一事务或保存点，失败原子回滚。
- 历史未绑定账套仍可读；`GET/POST /api/account-sets/:id/enterprise` 及本机 UI 支持显式确认关联。首次关联要求确认，同绑定返回 `no_change`，不强换绑、不自动合并旧重复账套。本机 UI 手工新建与确认绑定已有合成实操；一企一套不等于一企一数据目录，同一库允许多企业各有一个账套。新建 UI 已传显式身份；JSON / CSV UI 文件导入的受支持 filechooser 流程经 root 尝试后仍出现工具实际超时未受控，上传 / 预检结果未知，暂不继续该工具流程；不能由领域 / HTTP 测试代替 UI 成功。
- 真正省略 profile 默认 `small-2011-basic-v1`，精确企业准则选 `enterprise-2019-general-basic-v1`；显式空 / null / 非字符串 / 未知 profile 拒绝 `accounting_profile_unknown`，准则不合法与不匹配分别为 `accounting_standard_invalid` / `accounting_profile_standard_mismatch`，legacy profile 禁新建。历史 `legacy-small-coa-v1` 保持兼容，不能用标签转换。
- append 与已完成 create 批次先定位目标持久 profile，再归一化。旧成功批次重放保持账套 / voucher / source ID、原批次及来源指纹、attempt 与时间戳，验证 canonical / 来源证据 / batch links；重放不重算旧指纹。从未导入期初的批次允许后来合法补期初；实际导入过的期初变化仍冲突。
- 五类 CSV / XLSX / PDF 传持久 `accountingContext` 和 `reportStatus`，三表为 `complete/incomplete/legacy_compatibility`，余额 / 明细为 `not_applicable`。稳定行 ID 对齐，累计现金流保留各月诊断；新 profile 的未知 / 复合现金流不按比例凑齐，不能宣称完整。累计折旧借方净额列示（贷余额为负，零为零），折旧 magnitude、资产净值、利润、幂等及回滚合同不变。
- strict backup 识别 core schema 3 / 4 / 5 × bank 0 / 1 精确合同，未知结构 fail closed；不代表审计业务接线、现库安装或真实 restore 已完成。模型只接固定 profile / 状态 / 诊断计数，未知 fail closed，企业 key / 名称 / 明细与自由错误不出站；08 原脱敏 / 引用 / 账套隔离边界保持。

仅内部简化基础业务子集，不是完整准则或税局可上传申报文件；来源完整性仍 `unverified`，全国真实接入数 0。辅助核算 Issue #64、LOCAL06 审计 / 恢复与 Windows W2、LOCAL07 whole batch 仍未完成；不能由本候选宣称整个 LOCAL01 / 03 / 05 完成。

### 2026-10-23 独审 P2 修复后的验证边界

新增明细科目的严格归一化现调用 `addAccount` 同源 `accountProfileSemantics`，按新建选定或目标持久 profile 拒绝 `account_semantics_conflict`；已有标准科目兼容与旧成功批次指纹规则保持。修后实际命令（cwd `06-workbench`）：`node --check server/accounting.mjs` exit 0；`node test/accounting-standards.test.mjs` 38/38、`node test/import-incremental.test.mjs` 57/57、`node test/import-strict.test.mjs` 54/54、`node test/accounting-standards-http.test.mjs` 2/2、`node ../05-reconstruction/codex/mcp/finance-mcp/accounting-standards-test.mjs` 2/2，全部 exit 0，自有直接 child 均已 close。双 profile 的 legacy / incremental create / append 错类别和方向均静态拒绝、业务及批次 / 来源全表零写；合法同根明细独立金额及 completed 批次 ID / 指纹只读重放通过。

此前管理者在修前候选执行完整入口 `node scripts/test-all.mjs`，73/73 套各 exit 0，入口实际 exit 0、child close，候选 76 文件 hash 前后相同。这是修前真实历史；更早实施者 71/73、1907/1909 项及两税务定点 61 项也保持各自历史时点。P2 修后管理者已重新在 cwd `06-workbench` 实跑完整入口 `node scripts/test-all.mjs`，73/73 套全部 exit 0，入口实际 exit 0、`childCloseObserved:true`，全部源码 / 测试 hash 前后相同；本机证据为根 `.agent-runs/local03-manager-final-c1a7f4d853344f66a9614d3cfeb37914/` 的 `full.log`、`full.exit.json`、`code-after.json`，不以修前完整结果替代。

未参与实施且使用全新上下文的 `review_03_final_whole_fresh` 已完成完整差异静态审查，并在全新合成根独立复验 32 分组：双 profile 的 legacy / incremental create / append 错 category / direction 在 dry / apply 均拒绝，业务及批次 / 来源全表零写；合法自选金额 27.61 / 48.37、旧 IDs / fingerprint / attempt / timestamps 保持，探针 exit 0、DB 已关闭，未确认其他 P1 / P2。本机证据为根 `.agent-runs/review03-final-semantics-fixed-9ba01fb5199e49af82b937d9872648b1/`；最终文档与不可变 HEAD 仍待该独立审查者接受，尚未推送 / PR / 合并，不代表整个 LOCAL03（含辅助 Issue #64）或 LOCAL04 / 06 / 07 已完成。

本机 UI 手工新建与确认绑定已有合成实操；一企一套不等于一企一数据目录，同一库允许多企业各有一个账套。UI JSON / CSV 文件导入两次 filechooser 工具超时；用户已授权 CDP 合成输入，但工具明确不支持 raw CDP，实操仍未知，不能记为通过。所有本轮自有 UI 服务均已结束，不再启动浏览器重试；领域 / HTTP / MCP 通过不替代 UI 实操。内部简化报表子集、来源完整性 `unverified`、真实税局接入 0、辅助维度与 LOCAL06 / 07 未完边界保持。

### 修前实施者完整验证历史

2026-10-23 实施者实际执行 `node scripts/test-all.mjs`（cwd `06-workbench`），新 UUID 合成隔离根、TEMP / TMP / DATA 预设并传 child，显式 Office Python：完整 73 套真正执行，**71/73 套、1907/1909 项，exit 1**。仅两个税务 MCP 旧建账 fixture 漏 enterprise：`tax` 58/59 与 `tax-acquisition-mcp` 1/2；其余 71 套全部 exit 0，含批量 CLI 11/11、Office 25/25、新标准与身份 8 套。批量真实 PDF 文本、CSV / XLSX 累计折旧负号与独立 magnitude / 净值 / 利润 / 幂等 / 回滚断言均通过。

经 Issue #56 comment6359944200 精确授权，完整入口实际 close 后，仅给 `tax-contract-test.mjs` 与 `tax-acquisition-test.mjs` 的两处建账参数补固定合成 enterpriseKey；所有税务请求和旧断言原样。新 UUID 根以原正式 suite 定点重跑 **59/59 + 2/2，均 exit 0**。原完整红例保留；不能将修后定点结果改写为同一最终 hash 的 73 套全绿，该时点管理者完整入口尚待执行；后续修前完整 73/73 已实际通过，见本页 P2 验证边界。修后完整入口与 fresh 独立复验的当前结果见本页 P2 验证边界；最终文档及不可变 HEAD 的独立接受仍待完成。

首轮普通沙箱完整入口因 loopback EACCES 和硬链接权限路径失败，在旧 `tax-readonly-abandon` 的 checkpoint 等待挂起；只进入 21 套、前 20 套已返回，未跑后续。精确核验命令 / 创建时间 / 父子链后持自有 Process handles 收尾，已 wait，wrapper 记录 child close，入口终止码 4294967295、wrapper exit 1；此轮不计完整 73 套。第二轮完整入口与两套定点的直接 child 均实记 close；无本段仍运行的自有 exec / 后端服务。所有 fixture / 失败日志保留，无全局 TEMP 清理、无真实账套或税局操作。逐套日志与 hash 已交管理者；本段不执行 Git。

## 历史阶段材料

下文按原阶段与日期保留来源 / 测试记录；其“未接线 / 待后续”仅指当时版本，现状以当前候选合同为准。

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
