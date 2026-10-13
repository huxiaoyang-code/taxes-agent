# FLOW 交接

- 状态：审查中（待管理者 PR 验收与合并）
- 目标、验收、明确不做的事项：
  - 目标：补齐 `bookkeeping`（含 7 份 reference）与 `legacy-book-import` 的**真实可用**记账/导入规则；
    新增 MCP→临时后端闭环验收 `workflow-test.mjs`；新增统一回归入口 `test-all.mjs`；撰写第一阶段验收说明。
  - 验收：`node 05-reconstruction/codex/mcp/finance-mcp/workflow-test.mjs` 23/23 通过；`cd 06-workbench && npm test`
    （= `node scripts/test-all.mjs`）已执行步骤通过、退出码 0（税务未执行时不称全套验收）；技能 YAML `name/description` 正确、
    可经 `skills_read` 读取、不再把占位工具列为可用。
  - 不做：不改领域实现/工具 schema/MCP package/共享 README、INDEX、TEAM、STATE；不开发新领域功能；
    不修改任何已有测试；不新增 npm 依赖或 CI；不连接 8787、不读写 `06-workbench/data`、不用真实账套或凭据。
- 基线完整 SHA：`91b623a9a75d19b1e88fe00719aee084973d2cde`（main，CORE-B 合并后）
- 分支 / worktree / 执行者 / 显式模型：`codex/workflow-acceptance` / `.worktrees/flow` / 本地 pi / DeepSeek V4.1 Flash
- 允许修改的文件与依赖契约：
  - 改：`05-reconstruction/codex/skills/bookkeeping/SKILL.md` 及 7 份 reference；
    `05-reconstruction/codex/skills/legacy-book-import/SKILL.md`；`06-workbench/package.json`。
  - 新增：`05-reconstruction/codex/mcp/finance-mcp/workflow-test.mjs`；
    `05-reconstruction/codex/skills/legacy-book-import/references/import-rules.md`；
    `06-workbench/scripts/test-all.mjs`；`docs/PHASE1-ACCEPTANCE.md`；本文件。
  - 依赖契约：`tools.mjs`、`agent-tools.mjs`、`server.mjs`（MCP）与 `accounting.mjs` 的现有字段/工具名/返回结构；
    复用 `mcp-stdio-client.mjs`（未修改），不改 `contract-test.mjs`/`smoke-test.mjs`。
- 实现摘要、关键取舍与接口变化：
  - `bookkeeping/SKILL.md` 重写为“何时使用 + 真实可用工具 + 可用/未实现查询能力 + 通用规则（显式 accountSetId/period、
    默认草稿→校验→授权过账、不假设上下文持久、不猜税额科目）+ 边界”，明确列出发票/申报/exec/任务状态为占位不可用。
  - 7 份 reference 写实：发票/银行/工资仅基于用户已核实结构化数据；固定资产强调购入凭证与卡片分别创建、
    卡片不增加 1601 原价、折旧反向操作约束与封账/期初限制；期末写清结转不重复与封账条件。
  - `legacy-book-import/SKILL.md` + 新增 `references/import-rules.md`：真实 schema（paths/texts/files/payload/dryRun/encoding/meta）、
    默认预检→显式落库、Excel 先单独转 CSV、`exec` 不可用、正式导入新建账套且**非幂等**、失败先查询核对。
  - `workflow-test.mjs`：自建临时数据目录+空闲端口+stdio MCP；示例 CSV 经 `paths` 真实导入；
    主账套业务闭环；预期金额由“示例 CSV 原始列算术 + 手写业务常量”独立给出；封账前后账簿快照比对；仅清理自身资源。
  - `test-all.mjs`：`process.execPath` + `spawnSync`（inherit stdio）顺序运行 guards/derived/原 smoke/contract/workflow，
    退出码传播；`tax-contract-test.mjs` 存在才跑，否则明确跳过不计通过。
  - `06-workbench/package.json`：`test` 改为全套入口，保留 `test:smoke`。
  - 无接口/schema 变更；未改领域实现。
- 本轮审查修正（纯文档与汇总输出，未改领域实现，未重复跑全套测试）：
  1. `bookkeeping` frontmatter description 改为“根据已核实数据记账、查账、资产与期末处理”，不再暗示工资计算；
     `legacy-book-import` description 写明 JSON/CSV 导入、Excel 先转 CSV，避免误路由。
  2. 固定资产 reference 尾差改为“可能在后续期间提足”，并如实记录 1000/3 期需第 4 次补 0.01 的限制。
  3. 期末 reference 的“未分配利润 = 本期利润”限定为无历史余额/分配的测试场景，真实核对需计入 3104/3103 历史余额与
     尚未结转损益；明确 `yearEnd` 仅用户指定年末结转时使用（后端不强制 12 月）。
  4. legacy SKILL 补全 `enterprise_account.subject_system.all`；明确预检仅覆盖格式/平衡、不等于完整校验，
     CSV 非法金额按 0 静默吞数、不能依赖不平衡检出，必须先核对原始金额文本、非法即修复再导入。
  5. 发票 reference 去掉“按票种/身份推断抵扣”，改为按用户/会计已核实的可抵扣结论分别给示例，工具不自行判定税法资格。
  6. 各 reference 的“用户确认后”统一为“在当前授权范围内过账，只有授权缺失才确认”；代码示例补全 `accountSetId`。
  7. 本交接“管理者验证”改为“执行者自测（管理者待复核）”；22 份技能 reference 正常保留，无需请示保持 21，catalog 证据仍冻结。
  8. `test-all.mjs` 税务跳过时汇总改为“已执行步骤通过；税务契约未执行”，不再输出误导性的“全部步骤通过”。
- PR / 已审查 head SHA / 合并 SHA：PR 待管理者创建；head 为 `codex/workflow-acceptance` 上本部分提交（未提交，见“未完成项”）。
- 执行者自测（管理者待复核，不代替管理者背书；最终结果由管理者更新）：
  - 工作目录、命令、结果、未验证范围
    - `D:/有数云fork/.worktrees/flow/05-reconstruction/codex/mcp/finance-mcp`：`node workflow-test.mjs` → 23/23、exit 0。
    - `D:/有数云fork/.worktrees/flow/06-workbench`：`node scripts/test-all.mjs` → guards 23/23、derived 31/31、
      smoke 28/28、contract 44/44、workflow 23/23，已执行步骤通过、exit 0；tax 明确跳过（文件尚未合并），
      汇总结论为"已执行步骤通过"而非全套验收。
    - 技能自检：经 stdio MCP `skills_list`/`skills_read` 读取 10 个目标文件成功，YAML 头正确，无残留 TODO。
    - 未验证范围：真实账套/真实数据、8787 运行后端、税务契约（TAX 未合并）、Excel 转换脚本实跑、网页 UI 交互。
- 未完成项、风险和下一部分输入：
  - 本部分改动**尚未提交**（执行者禁止 Git 写操作）；需管理者提交并建 PR。工作区仅含上述允许文件，无其他改动。
  - `skills_list` 文件数由 21 增至 22（新增 `legacy-book-import/references/import-rules.md`）；
    新增该 reference 属正常，无需另行请示保持 21。catalog 的 21 项原站 label 映射不变，原站 catalog 证据仍冻结。
  - `test-all.mjs` 中税务入口路径固定为 `05-reconstruction/codex/mcp/finance-mcp/tax-contract-test.mjs`
    （与 TAX 工作区实际文件一致）；TAX 合并后须重跑全套确认。
  - 下一部分输入：`docs/PHASE1-ACCEPTANCE.md`、`docs/handoffs/STATE.md`、本文件；`workflow-test.mjs` 可作为后续回归基线。
- 仍运行进程、会话 ID、日志及退出码：本次为 `--no-session` 全新进程；未遗留后台进程；测试临时后端均已退出并清理临时目录。
- 上下文：本员工会话已结束；下一部分须新会话读取 `AGENTS.md`、`docs/PROJECT-CHARTER.md`、`docs/handoffs/STATE.md`、
  本文件与对应任务包，再按需读取 `workflow-test.mjs`、`test-all.mjs`、技能文件。
