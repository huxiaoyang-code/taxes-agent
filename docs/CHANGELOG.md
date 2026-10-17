# 变更日志 · CHANGELOG

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与
[语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Changed — RC-A0 tax-browser 草稿复审与安全修复（**第一步本机独立验收通过 + 已开 PR #19**，2026-10-17）

- 负责人 A 在隔离 worktree `<repo>/.worktrees/rc-a0-review`（分支 `codex/huxiaoyang-code/rc-a0-review`，基线 `d0221df1d18e2bfcbd7db2cc9aa0875ab32a7fd4`）对 tax-browser 草稿做复审与**选择性整合**；**第一步本机独立验收通过（15 套 496 项 + smoke 28/28、exit 0，代码验证 head `0293ed2`）；代码已由管理者提交（初轮 `866fc308cd77bbce85d23de0b641a2e05682b3a9`（`866fc30`，14 文件）+ 收尾安全修复 `0293ed21968864d7bbabb071a7a0234fb9dbfbd6`（`0293ed2`，只追加 `server/server.mjs` 与 `test/server-local-boundary.test.mjs`））并开 PR [#19](https://github.com/huxiaoyang-code/youshu-fork/pull/19)（未合并，待跨成员 Codex 复核）**。新增 [RC-A0 审查报告](REVIEW-TAX-BROWSER.md)、[数据可得性矩阵](DATA-AVAILABILITY.md)、[RC0-SNAPSHOT](handoffs/RC0-SNAPSHOT.md)、当前接口概述 [TAX-BROWSER](TAX-BROWSER.md)；[handoffs/TAX-BROWSER](handoffs/TAX-BROWSER.md) 降为**历史交接记录**（非接口全文迁移）。
- 已核实：原件 14/14 SHA256 与源清单一致；旧草稿复跑（**2026-10-16**）**7 套 272 项、exit 0**（沙箱首跑 exit 1、5 套失败为 EACCES 回环限制，两轮分别保留）；main `c2d5619` 基线 10 套 336 项 exit 0（既有历史）。**基线差异按完整 `9783420..d0221df` 区间说明**（PR #9 / #10 / #11 / #12 / #15 / #16；`#13` / `#14` 是 Issue 不是 PR）：PR #10 IMPORT-STRICT 改了 `accounting.mjs`，PR #15 未改；根 `README.md` 与产品形态 / `team-skills` 文档也在区间内改动。本轮未触碰 `accounting.mjs`，保留已合并严格导入。
- 安全修复（已确认 + 合成测试）：HTTP 固定错误字典 + 固定文案不透传 `err.message`/details；连接来源回环校验不信任 `X-Forwarded-*`；未知路径不回显；CDP 错误去 `details`；**日志只输出调用方固定 fallback**（不读外部 code/message/details）；页内脚本先校验白名单 origin；stderr `ws://` 修正；主动 TTL timer；启动竞态与幂等清理（失败保留待关闭 sid / 在途 close 门禁、每次 await 后生命周期校验）；root 延迟清理（**不可变自建绝对根、非递归仅删空目录；未决 launch 保留、后续定向回收**）；UI 迟到 read/import、取消后令牌未触发新开。**收尾又发现旧 REST CORS 绕过**（恶意 Origin 对 `GET /api/account-sets` 返回 200 + `Access-Control-Allow-Origin: *` + 合成企业名），已由员工修复（`0293ed2`）：旧 REST `/api/*` 与 Agent `/agent/*` 在读写前均校验回环真实 socket、回环 Host、Origin 若存在须精确同源；移除通用 JSON 与旧 OPTIONS 的全部 CORS 放行头，旧 REST/Agent 恶意 Origin 预检 403；原税局 OPTIONS 仍保持 204 无 CORS（**不能一概写所有 OPTIONS 都 403**）；静态文件回环访问不变。`server-local-boundary` **28 项**覆盖畸形 Host 400 / 服务存活 / 税局 config 边界 / 旧 REST 合成企业名跨站读拒绝 / 跨站 JSON 与 text/plain 写拒绝且 DB 未变 / 真实 Agent 入口拒绝 / 本机同源·无 Origin·localhost 可用 / 跨站 OPTIONS 拒绝 / 静态页正常。
- **本机独立验收（2026-10-17，最终 `0293ed2`）**：`npm test` **15 套 496 项、exit 0**（**仅 `server-local-boundary` 由初轮 13 增至 28（追加 15 项），其他分套不变；初轮 `866fc30` 为 15 套 481 项，属历史**）；`npm run test:smoke` **28/28、exit 0**；验证前后 29 文件 SHA256 一致（元数据 `rc-a0-verified-source-hashes-v2.json`，仅本机忽略），原件 14/14 仍一致，`accounting` / `coa` / 报表模块与主线测试、MCP 无 diff。
- **未完成 / 不冒称**：**跨成员 Codex 复核未获得**；PR #19 未合并（创建时为 draft，实时 draft/ready 以 GitHub 为准）；文档后续提交不改已提交代码，最终 PR head 以 PR 当前提交为准，代码验证 head 用 `0293ed2`；真实登录未验证，真实接入 0。含共享接线与数据边界，按 [团队协作协议 §8](TEAM-COLLABORATION.md) 待复核后合并；**不得因 A0 而关闭总 Issue #13（保持 OPEN）**；回退为新 revert PR，不建议直接丢弃已提交成果。

### Changed — 多人跨电脑协作与任务分配（2026-10-15，2026-10-16 更新状态）

- 用户明确确认多人协作方式：同事账号 `xiaoyihaishiaini`（个人私有仓库协作者）已**接受** write 邀请（邀请 ID `337920044`），管理者 2026-10-16 通过 GitHub API 实测 `permission = write`。负责人 `huxiaoyang-code` 负责税局登录与数据接入（RC-0 / RC-1 / RC-2a / RC-2b 及数据处理集成，协调 RC-3），同事负责两类报表口径核对与导出（RC-4 / RC-5）。**开发多人不等于产品多租户**：产品仍为本机单用户、可多账套批量。
- 已建立总任务 [Issue #13](https://github.com/huxiaoyang-code/youshu-fork/issues/13)（RC-A-LOGIN-DATA，assignee `huxiaoyang-code`）与 [Issue #14](https://github.com/huxiaoyang-code/youshu-fork/issues/14)（RC-B-REPORTS，已实际绑定 assignee `xiaoyihaishiaini`），均 OPEN。子 PR 用 `Refs #13` / `Refs #14`，**不因 A0 / B0 完成就 Closes 总任务**；新子需求可另开 Issue 链接总任务。
- 新增 [团队协作协议](TEAM-COLLABORATION.md)（双层角色、权限、共享同步、交接契约、文件所有权矩阵、任务生命周期 / 认领、跨成员评审、凭据与数据边界，以及官方资料短摘要）、[成员入场包](handoffs/MEMBER-ONBOARDING.md)（可直接转发同事）、[任务看板](tasks/README.md)、[任务单模板](tasks/TEMPLATE.md)、[RC-A-LOGIN-DATA](tasks/RC-A-LOGIN-DATA.md)、[TEAM-HANDOFF 交接](handoffs/TEAM-HANDOFF.md)，以及 `.github/pull_request_template.md` 与 `.github/ISSUE_TEMPLATE/requirement.md`（**8 个新增**；`RC-B-REPORTS` 任务单不在此列——它是 PR #15 已有、本轮修改）。
- 修改 `AGENTS.md`、[项目章程](PROJECT-CHARTER.md)、[团队实施计划](TEAM-PLAN.md)、[报表闭环补全方案](REPORT-CLOSURE-PLAN.md)、[阶段状态](handoffs/STATE.md)、[新会话入口](handoffs/NEXT-SESSION.md)、[索引](INDEX.md)、[交接模板](handoffs/TEMPLATE.md)、[RC-B-REPORTS 任务单](tasks/RC-B-REPORTS.md) 与本文（**10 修改**，共 **18 文件**）；**新增「先识别自己成员与已分配任务」**，避免所有机器默认接 RC-0 导致重复派工。
- **2026-10-16 已接受（已核实）**：本轮团队协作文档已被管理者接受；同事 `xiaoyihaishiaini` 已接受 write 邀请，管理者经 GitHub API 实测 `permission = write`；总任务 [Issue #14](https://github.com/huxiaoyang-code/youshu-fork/issues/14) 已实际绑定 assignee `xiaoyihaishiaini`（OPEN）。`docs/tasks/RC-B-REPORTS.md` 属 PR #15 已有任务单的本轮修改，**不是新增，也不新增任何 B 任务单**。
- **新任务**初始状态为**「已分配 / 待开工」**（不是「开发完成」）；但不使已有进展退回：**RC-B B0 / B1 已随 PR #15 交付，B2 继续推进**，A 的 RC-0 等仍为待开工。本轮本地员工**未代发 Issue**，总任务 Issue #13 / #14 已由管理者建立（#14 已绑定 assignee）。成员可在满足验收与整合约束后自动合并自己的 PR；本机 Codex 审查不冒充 GitHub 第二账号批准。
- 本轮**不新增 GitHub Actions / CODEOWNERS / 规则集，不声称已有 CI / 分支保护；未改任何远端设置；未改 `team-skills/`；未改业务代码 / 测试**。这是本轮实现范围，不是永久禁止后续经负责人授权的治理变更。
- 团队文档变更不要求员工重跑业务回归；**管理者已在本轮对新基线 `c2d5619` 独立复验 `npm test` 10 套 336 项、exit 0**（合成临时库，未读真实数据），见 [TEAM-HANDOFF 交接](handoffs/TEAM-HANDOFF.md)。

### Added — RC-B 内部报表导出与模板前置核验（PR #15，2026-10-15）

- 同事 PR [#15](https://github.com/huxiaoyang-code/youshu-fork/pull/15)（head `843cad08c0e42e0614459bbbfc77160eadf498ad`，代码验证提交 `b913409d420cdd1d8264ad0d64a474880604c90f`）合并入 main `c2d561994377d9123a1cd5b8b67dfa8a16a5d2b0`；见 [RC-B 交接](handoffs/RC-B-REPORTS.md)。
- 新增五类内部 CSV 下载及同口径预览：三表、各科目余额表、按科目/期间追踪的明细账。区分期间期初、本月发生、本年累计、期末；只读已过账范围，封账可读，拒绝未登记期间及非法参数。中文 BOM、CSV 转义、公式注入防护、试算与现金流勾稽标志、数据完整性未核实和算法限制随文件输出。
- 新增 21 项独立金额验收，预先手算跨月/跨年、父子科目、结转/折旧及简单混合现金流的预期值，同时校验下载 CSV 关键行；覆盖草稿/反过账、年中启用、空账、异常请求、封账只读、账套隔离及非有限金额。旧断言不变；实际全套复验结果见 [交接](handoffs/RC-B-REPORTS.md)。
- 新增官方小企业报表法定结构参考及校验，实际电子税局上传模板未核实，因此 **B2 仍未完成**。三表算法继续沿用现有核心，复杂混合现金流、准则映射和来源完整性等 RC-3 / RC-6 工作尚需整合；不宣称整个报表闭环或税局申报文件已完成。详见 [导出说明](REPORT-EXPORT.md)、[税局格式研究](TAX-REPORT-FORMAT.md)。
- 本任务遵循用户本轮明确授权，由 Codex Subagent 实施、主 Codex review / 验证 / PR / 合并；不改其他成员长期执行规则。

### Changed — 报表闭环优先级与补全方案（2026-10-15）

- 用户明确最终交付为**报表闭环**（办税员账号登录 → 授权企业 / 账套 → 财务操作 → 出报表），且**两类报表都需要**：内部资产负债表 / 利润表 / 现金流量表 + 余额表 / 明细账，以及税局财务报表申报格式；前端展示次要。新增 [报表闭环补全方案](REPORT-CLOSURE-PLAN.md) 与 [REPORT-CLOSURE 交接](handoffs/REPORT-CLOSURE.md)，把现行排序从「IMPORT-IDEMPOTENCY 第一优先」切换为 **RC-0 ~ RC-6**（IMPORT-IDEMPOTENCY 并入 RC-2，泛用批量队列后排）。
- 更新 [项目章程](PROJECT-CHARTER.md)、[路线图](ROADMAP.md)（新增 P1.5 报表闭环里程碑）、[团队实施计划](TEAM-PLAN.md)、[阶段状态](handoffs/STATE.md)、[新会话入口](handoffs/NEXT-SESSION.md)，并同步本索引与本变更日志；已完成表补记 PR #11（IMPORT-STRICT 交接文档归档，`cc6e789`）。
- 首审返工修订：RC-0 拆「代码审查 / 合成验证」与「用户本机人工可行性」两步（原 tax-browser 只读保留，隔离工作区仅复制源码 / 补丁与基线快照，不复制 DB / 凭据 / 临时 profile / 日志；先复现旧草稿测试再在最新 main 复用必要改动）；RC-1 补实际账号 / 凭据入口、适配器与最少 UI（凭据与验证码只由用户本机输入；模型侧 MCP / Agent 仅收安全引用与不含真实业务 / 身份原文的状态摘要，本机 UI 专用回环通道可处理瞬时凭据 / OTP，不送模型）；RC-2 补目标账套定向导入、标准 DTO 转换、完整性与映射预检、稳定业务键与最小恢复能力；报表验收补独立预期金额 / 会计口径；范围弹性与未知源数据边界明确。
- 纯文档变更，未改业务代码、算法或测试，不重复整套 208 / 262 项回归。**整体不宣称报表闭环已达成**。
- 该方案已由 PR [#12](https://github.com/huxiaoyang-code/youshu-fork/pull/12) 合并入 main `8ebc73917123b7057dec7d00f28f5651b6fd8a4a`（2026-10-15，文档变更，未重跑业务测试）；后续团队协作交接以该 SHA 为基线。

### Changed — 方向修正为本机单用户批量 + 工作范式技能（2026-10-14）

- 明确产品为**本机单用户**工具，目标支持多个企业 / 账套的批量处理（批量队列与管理尚待开发）；删除 SaaS、多租户、租户权限平台方向，保留账套隔离、操作日志、备份恢复、凭据安全等本机实际需要。涉及 `AGENTS.md`、PROJECT-CHARTER、TEAM-PLAN、ROADMAP、INDEX、CONVENTIONS 及 README。
- 新增仓库权威技能 `team-skills/local-agent-first/SKILL.md`（含 `references/windows-launch.md`）：本地 pi / Claude Code 实施，Codex 只派工、审查、Git/PR 与合并；模型仍锁定 GLM 5.3 / DeepSeek V4.1 Flash。员工维护仓库副本，Codex 全局技能由管理者审查后安装；不直接修改用户全局技能与 Codex 配置。本机安装与校验结果见 [新会话入口](handoffs/NEXT-SESSION.md)。
- 新增 [新会话入口](handoffs/NEXT-SESSION.md) 并更新 [阶段状态](handoffs/STATE.md)：固定“每部分验收+合并+交接后关闭员工会话、下一部分新进程新会话”的交接方式。
- 分支前缀统一为 `codex/`；原站 `catalog.json` 保持冻结，本地能力改在 `agent-tools.mjs` / `tools.mjs` / `tax-tools.mjs` 维护。
- 纯文档与 Skill 变更，未改业务代码或算法，不重复整套 208 项回归。

### Added / Fixed — 第一期可靠性与本机 Agent 接入（2026-10-13）

- MCP 补齐账套、科目、期初、期间、凭证状态、查账、资产、折旧和结转入口；工具/查询目录如实说明可用状态，未实现不再伪报成功，导入默认预检。
- 封账后的反过账/删除受保护；期初按完整合并结果校验平衡并原子写入，已有正式账务后禁止重写；合法新期间可登记。
- 明细科目参与报表和总账归集；零利润/反向损益/年末结转可用，失败回滚；折旧删除同步清理计提记录，恢复旧凭证不能超额折旧。
- 预留全国电子税务局 7 个接口，按地区选择适配器，验证异步登录状态、会话隔离、过期/退出和输出脱敏。当前真实接入地区为 0。
- 补齐记账及旧账导入规则，新增临时账套的完整 MCP 闭环验收和统一 `npm test` 入口。
- 新增项目章程、`AGENTS.md` 和阶段交接：每部分验收合并后归档，下一部分以全新本地员工会话执行。
- 验收命令、结果及限制见 [第一期验收](PHASE1-ACCEPTANCE.md)，PR 与阶段状态见 [交接](handoffs/STATE.md)。

### Added — 逆向分析：账套导入
- 新增主题报告 [`04-report/10-account-set-import.md`](../04-report/10-account-set-import.md)：
  `page=account-sets` 的导入实现（建账向导“期初旧账/旧账文件” + `legacy-book-import` 子智能体）
- 新增证据 [`03-analysis/account-set-import.json`](../03-analysis/account-set-import.json)：向导字段/默认值/接口契约/附件管道/状态机
- 归档实时复核 bundle `02-scripts/work/index-CiSnIgwe.js`（sha256 `691cf9c2…`），与旧版 `index-yoSd2Nx7.js` 行为一致
- 关键结论：向导中的 `openingBalanceFile` 被提交前丢弃，`createAccountSet` 零调用；导入由 Agent 附件管道完成

### Added — 本地复现「导入旧账」（Codex 客户端）
- `finance-mcp` 修复 Windows 下 `skills_read` 路径误判（正/反斜杠）
- `legacy_book_import` 新增 `paths` 参数：MCP Server 直接读本地 CSV，免 base64
- 新增 `codex/mcp/finance-mcp/import-demo.mjs`：读规则 → 预检 → 导入 → 报表勾稽 一条龙演示
- 新增 `examples/legacy-book/` 示例旧账（4 张 CSV）与 `tools/xlsx-to-csv.py`（openpyxl，Excel → CSV）
- `codex/README.md` 新增「本地复现：导入旧账」步骤（工作台 + MCP + Codex 提示词）

### Planned
- 报表闭环工作包 RC-1 ~ RC-6（见 [报表闭环补全方案](REPORT-CLOSURE-PLAN.md)）
- 辅助核算（客户/供应商/部门/项目）
- 银行流水对账
- 打印/导出（PDF/Excel）
- 发票 / 申报工具对接

---

## [0.4.0] - 2026-10-12

### Added — 导入旧账
- **导入账套**：一次导入「账套信息 + 科目 + 期初余额 + 历史凭证」
  - `parseImportTexts()`：解析 4 张 CSV（账套/科目/期初余额/凭证），支持 GBK/GB18030 中文 Excel 导出
  - `validateImportPayload()`：借贷不平、科目不存在、类别/方向非法均显著报错
  - `importAccountSet(payload, {dryRun})`：先预检后落库，**事务包表失败回滚**
  - 支持新增非标准科目（如企业会计准则 6602）
- API：`POST /api/import/parse`、`POST /api/import/account-set`、`GET /api/import/templates`
- Agent 工具：`legacy_book_import`（默认 `dryRun=true` 仅预检），对应原子智能体 `legacy-book-import`
- 网页：顶部「↓ 导入账套」（JSON 或 4 CSV + 编码选择 + 预检结果 + 下载模板）

### Fixed
- 利润表改为按**科目名称/编码尾号**归集（兼容小企业 5xxx 与企业准则 6xxx），
  修复导入的非标准损益科目不计入利润表的问题；未匹配的损益科目归入「其他收入/其他费用」

### Tests
- 端到端测试 22 → **28 例**（新增 CSV 解析/预检、期初不平、科目不存在、事务导入、导入后报表）

---

## [0.3.0] - 2026-10-12

### Added — P1 会计闭环
- **期末结转损益** `carryForwardProfit(setId, period, {yearEnd})`
  - 各损益科目余额结转到 `3103 本年利润`，`yearEnd=true` 再结转 `3103 → 3104`
  - 结转凭证 `kind='carryforward'`，**不计入利润表发生额**，避免重复计算
  - 同期重复结转被拒绝（`already_carried_forward`）
- **固定资产折旧 / 无形资产摊销**
  - 新增资产卡片表 `asset_cards`（直线法、残值率、使用月数、起提期间、费用科目）
  - `generateDepreciation(setId, period)`：一键计提、生成凭证、记录 `asset_depreciation_runs`
  - 同期幂等；提足/未到计提期自动跳过
- **现金流量表** `cashFlowStatement(setId, period)`
  - 直接法（按货币资金对方科目分类为经营/投资/筹资）+ 与货币资金变动勾稽
  - 附「净利润 → 经营活动净额」的**间接法补充资料**
- 凭证新增 `kind` 字段（`normal` / `carryforward` / `depreciation`），含老库自动迁移
- 网页新增「资产」页签、现金流量表、「结转本期损益」按钮
- Agent 工具新增：`carry_forward_profit`、`asset_list`、`asset_create`、`depreciation_run`；
  `finance_query` 的 `report.cash_flow_statement` 改为真实实现
- 端到端测试扩到 **22 例**（新增折旧、结转、现金流量表、勾稽等），全部通过

### Changed
- 资产负债表「未分配利润」= `3104 + 3103 + 尚未结转的本年损益`（兼容已结转/未结转两种状态）

---

## [0.2.0] - 2026-10-12

### Added
- **`06-workbench/` 记账 + 报表 MVP**（可运行）
  - 后端：Node + `node:sqlite`，零第三方依赖
  - 账套 / 标准科目表（小企业会计准则）/ 期初余额 / 期间结账
  - 凭证：多分录、借贷平衡校验、草稿 / 过账 / 反过账 / 删除
  - 报表：科目余额表（试算平衡）、资产负债表、利润表、明细账
  - 前端零构建网页（`public/`）
  - 端到端测试 `test/smoke.test.mjs`（11 用例，全部通过）
- **Codex / MCP 打通**：`/agent/tools/:name` 接口，`finance-mcp` 默认指向工作台
- **`docs/` 代码管理索引目录**：`INDEX.md`、`CONVENTIONS.md`、`CHANGELOG.md`、`ROADMAP.md`
- 根 `README.md` 项目落地页；`.gitignore` / `.gitattributes` / `.editorconfig`

### Fixed
- 资产负债表中「本年利润」方向错误导致资产 ≠ 负债 + 权益
  （改为 `本年利润 = −Σ(损益类 net)`）
- 静态资源根路径 `/` 返回 404（Windows 路径分隔符问题）

---

## [0.1.0] - 2026-10-12

### Added
- **REA 逆向分析归档**
  - 目标更正：`daizhang.youshu.yuork`（不存在）→ `daizhang.youshu.yun`
  - `00-recon/` 侦察证据；`01-capture/` 被动抓取与截图
  - `02-scripts/` 前端脚本（`work` 工作台、`finance` 登录）
  - `03-analysis/` REA 原始证据：应用图、接口、路由、分包、WebMCP
  - `04-report/` 主题报告 01–09 + `build_report.py`
  - `REPORT.md` 分析总索引与证据台账（8 个 Evidence ID）
- **`05-reconstruction/` 复刻方案**
  - 关键发现：`/work` 财税工作台是 **OpenAI Codex app-server 客户端**
  - `catalog.json`：5 子智能体 / 22 工具 / 21 查询能力 / 21 技能文件 / 协议
  - `codex/`：`config.toml`、MCP Server 骨架（22 工具）、5 份 SKILL.md 模板
  - `extract_catalog.py`、`generate_skill_stubs.py` 可复现脚本

[Unreleased]: #unreleased
[0.4.0]: #040---2026-10-12
[0.3.0]: #030---2026-10-12
[0.2.0]: #020---2026-10-12
[0.1.0]: #010---2026-10-12
