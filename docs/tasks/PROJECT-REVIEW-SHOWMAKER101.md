# PROJECT-REVIEW-SHOWMAKER101 任务单 · 高级 review 与整改计划入场包

> 本文件是**入场包 + 任务单**，对应用户 2026-10-17 最新确认：先由高级程序员 Showmaker101 全面 review 项目并提整改计划，**方案确认后**再按任务接开发。
> 只写可核验事实，不伪造测试 / head / PR。授权继承自 [项目章程](../PROJECT-CHARTER.md) 与用户后续指示；**任务单不扩大授权**。相关：[产品 PRD](../PRODUCT-PRD.md) · [协作协议](../TEAM-COLLABORATION.md) · [任务看板](README.md) · [本地优先技能](../../team-skills/local-agent-first/SKILL.md)。

## 1. 基本信息

- 任务 ID：`PROJECT-REVIEW-SHOWMAKER101`（高级 review 阶段任务）
- 状态：**待开工**；本文件为入场包，尚未提交 review 结果。
- Issue / 派工：**review Issue [#17](https://github.com/huxiaoyang-code/youshu-fork/issues/17)（OPEN，待接受邀请后指派给 Showmaker101；尚未提交 review 结果）；业务开发任务在方案确认后按 Issue 派工**。
- 负责人（人类成员 / GitHub）：**Showmaker101**（用户指定）
- 执行员工：本机 pi / Claude Code，**只允许 GLM 5.3 或 DeepSeek V4.1 Flash，主 / 回退显式锁定**；人工 review 由人类成员自己做，**不受本地模型限制**
- 本机管理者：Showmaker101 自己的本机 Codex
- 分支：建议 `codex/Showmaker101/project-review`（方案确认后按章程建立独立 worktree）
- 基线：`origin/main` = `d0221df1d18e2bfcbd7db2cc9aa0875ab32a7fd4`（含 PR #15 报表 + PR #16 团队文档）
- 关联 Issue / PR：**review Issue [#17](https://github.com/huxiaoyang-code/youshu-fork/issues/17)（OPEN，待接受邀请后指派给 Showmaker101）**；现有总任务 [#13](https://github.com/huxiaoyang-code/youshu-fork/issues/13)（A，OPEN）/ [#14](https://github.com/huxiaoyang-code/youshu-fork/issues/14)（B，OPEN）保持不变，**本 review 不关闭、不重新分配它们**。

## 2. 权限与角色事实（不得渲染为阻塞）

- 用户已明确授权 **write**；邀请已由管理者**实际发出并复核**：邀请 ID `338167875`，invitee `Showmaker101`，`permissions = write`，**仍待本人接受**；列表见[邀请列表](https://github.com/huxiaoyang-code/youshu-fork/invitations)。
- 初次自动审批拒绝**已因用户明确确认解决**，**不再是当前阻塞**。
- **未给新成员自动合并授权**，不自推：Showmaker101 可 review / 开发，但合并需按流程（见 §9）；现有 A / B 自审自合并授权**不自动转移**。
- 角色边界见 [团队协作协议 §2](../TEAM-COLLABORATION.md)；每人用自有凭据，**绝不复制** owner token / config / session / 账套 DB。

## 3. 目标

1. **全面 review 项目**：架构、账务与双准则、现金流、金额精度、隔离 / 事务 / 幂等、入口与会话安全、来源完整性、发票 / 申报写入状态机、全国 / 模板 / 版本维护、恢复 / 运维。
2. **输出整改计划**：按 P0 / P1 / P2 分级，可核验、可派工。
3. **与用户 review 最终形态 / 需求 / 未完成功能**，确认完整方案后**接开发任务**（保留现有 A / B 分工与文件所有权）。

非目标：本轮 review **不实现业务功能**、不抢 Issue #13 / #14 的在途范围、不改 main、不动 RC-A0 在途整合。

## 4. 入场材料（建议读取顺序）

| 顺序 | 材料 | 说明 |
|---|---|---|
| 1 | [AGENTS.md](../../AGENTS.md) · [项目章程](../PROJECT-CHARTER.md) · [协作协议](../TEAM-COLLABORATION.md) | 规则与角色 |
| 2 | [产品 PRD](../PRODUCT-PRD.md) | 本轮范围 / 需求 ID / 待确认决策 |
| 3 | [阶段状态](../handoffs/STATE.md) · [任务看板](README.md) | 已合并 PR、Issue 状态、当前分工 |
| 4 | [报表闭环补全方案](../REPORT-CLOSURE-PLAN.md) · [路线图](../ROADMAP.md) | RC 工作包与旧边界（旧边界已被 PRD §0 替代） |
| 5 | [内部导出](../REPORT-EXPORT.md) · [税局格式边界](../TAX-REPORT-FORMAT.md) · [税务适配契约](../TAX-INTEGRATION.md) | 报表与税务现状与限制 |
| 6 | [本地优先技能](../../team-skills/local-agent-first/SKILL.md) | 执行 / 管理者范式 |

**只读参考**：RC-A0 为**负责人本机未提交现场**（未提交 / 未 PR / 未合并）。
同事无需寻找本机文件：如需参考，**由负责人提供经审查的版本或摘要**，不复制本地未提交代码、不要求找 D 盘路径。跨电脑只描述版本状态与可得性。

## 5. 代码地图与命令

- 领域层：`06-workbench/server/accounting.mjs`（账务 / 报表 / 导入）、`coa.mjs`（科目表）、`db.mjs`（SQLite 建表与轻量迁移；金额字段为 `REAL`）。
- 接口层：`06-workbench/server/server.mjs`（REST + `/agent/tools`，静态资源）、`agent-tools.mjs`（工具注册与真实能力目录）、`tax-gateway.mjs`（税务契约 / 状态机）、`report-export.mjs`、`tax-report-format.mjs`。
- 前端：`06-workbench/public/*`（零构建）。
- MCP：`05-reconstruction/codex/mcp/finance-mcp/*`。
- 运行要求：**Node >= 22.5.0**（`node:sqlite`）；**当前零外部依赖，无需 `npm install`**。
- 命令（工作目录 `06-workbench`）：
  - **`npm test`**：统一入口，一次跑完全部契约套件（guards / derived / import-strict / report-export / tax-report-format 及 MCP contract / workflow / tax 等），各套件自带临时数据目录，**推荐优先使用**。
  - `npm run test:smoke`：仅工作台 HTTP 冒烟。
  - `npm start`：启动工作台服务；**未指定 `WORKBENCH_DATA_DIR` 时会写入默认 `data/` 生产库**，因此演示 / 试验**必须先指定临时 `WORKBENCH_DATA_DIR`**，或只跑隔离测试；默认地址 `http://127.0.0.1:8787/` 只是本机示例，**非共享配置**。
  - MCP（在 `05-reconstruction/codex/mcp/finance-mcp` 下）：`node smoke-test.mjs` 的**后端部分依赖一个临时启动的 workbench 后端**（未启动时会清晰报告并跳过后端校验）；其他契约套件已由 `npm test` 统一覆盖，直接跑 `npm test` 更简单。
- 环境变量：`PORT`、`WORKBENCH_DATA_DIR`、`FINANCE_API_BASE`、`FINANCE_SKILLS_DIR`（均在源码中实际使用）。
- **独立临时数据**：自动测试只用 `WORKBENCH_DATA_DIR` 指向的临时目录与合成数据；**禁止真实账套 / 凭据 / `.env` / profile / 历史日志**。

## 6. review 交付要求（P0 / P1 / P2）

每条发现写明：**源码位置（文件 + 行）→ 复现情境 → 影响 → 修复建议 → 验收方式**。分级建议：

- **P0 / P1 / P2 表示缺陷严重度与修复先后，不表示可选范围**：已确认的 V1 域（全国适配、发票、各税种与个税申报）不会因分级而变可选。
- **P0**：安全 / 数据正确性 / 不可逆错误 / 阻塞 V1 必做域。
- **P1**：正确性边界、可维护性、缺证据。
- **P2**：优化与体验改进；**不代表「V1 可做可不做」**。

不得省略：无法复现或未运行的项**标注「未验证」**，不得声称已通过。

## 7. 重点核查清单（已知线索，须独立复现）

| 方向 | 已观察线索（须自行复现，不当作已结论） |
|---|---|
| 入口 / 会话安全 | `server.mjs` `json()` 带 `access-control-allow-origin: *`；`OPTIONS` 全放行；`server.listen(PORT)` 未指定回环地址；缺 Host / Origin / 客户端令牌校验 |
| 金额精度 | `db.mjs` 金额字段为 SQLite `REAL`；核心运算用 Number + `r2` / `EPS`（`accounting.mjs`）。核查精度规则、舍入边界与迁移策略，**不得无证据称所有金额错误** |
| 双准则 | `createAccountSet` 始终加载同一份 `COA`，准则仅登记字段；核查分别完备映射缺口 |
| 现金流 | `cashFlowStatement` 按比例分摊复杂混合凭证可能误分类；间接法末行借用直接法经营净额，非独立验算 |
| 资产 / 总账 | 资产卡片不自动生成购置凭证、不证明总账一致 |
| 导入 | `importAccountSet` 总新建账套、非幂等、无绑定账套持续追加；缺来源完整性 / 批次 / 稳定业务键 / 版本冲突 |
| 税务 | `tax-gateway.mjs` `TAX_RESOURCES` 不含科目 / 期初 / 凭证 / 银行 / 发票；真实接入 0；`tax-report-format.mjs` 固定 422 |
| 恢复 / 运维 | 无审计 / 备份恢复 / 通用持久批量队列 |

## 8. 约束与真实数据边界

- 先 review 再重构；**不抢 Issue #13 / #14** 的在途范围。
- **不触碰 RC-A0 在途整合**（负责人本机未提交 / 未 PR / 未合并；「27 项变更」等为**盘点时快照**，可能随在途工作变化，**需恢复后重核**）；不复制其本地代码。
- 自动测试只用**合成数据**；真实账套数据与税务凭据**不发到模型服务 / 日志 / GitHub**；真实登录、OTP 只在用户本机可信界面。
- 不得覆盖生产库、不绕过沙箱；**本轮只做 review 与文档**，不实际登录 / 开票 / 申报 / 缴款。
- 跨电脑只描述版本状态 / 可得性；不共享本机路径、端口或进程 ID。

## 9. 验收与合并

- review 交付物：**review 报告 + 整改计划（P0 / P1 / P2）**，每条含源码位置与可复现结论；**是否接受最终形态 / 需求由用户确认**。
- 方案确认后，新开发任务**须按 Issue / 明确文件所有权 / PR** 走（见 [协作协议 §6 / §7](../TEAM-COLLABORATION.md)）。
- **合并授权**：现有自动合并授权只属已登记的 `huxiaoyang-code` 与 `xiaoyihaishiaini`；Showmaker101 **未获自动合并授权**，需由项目负责人确认后合并（跨成员评审见 [§8](../TEAM-COLLABORATION.md)）。
- 禁止强推 main、重写历史；回退用 revert PR。
- 初始状态写「待开工，尚未提交 review 结果」；未运行的测试不得预先声称通过。

## 10. 交接

- 产物：review 报告与整改计划（建议提交到 `docs/` 下新文件或 PR 正文，路径由管理者确认）；本任务单与 [本轮交接](../handoffs/PROJECT-PRD-REVIEW.md) 作为入场与状态记录。
- 交接必填：基线、**员工交付时尚未提交；管理者审核及提交 head 以关联 Draft PR 为准**、验证命令与结果摘要、依赖契约、未完项。
- 授权继承自 [项目章程](../PROJECT-CHARTER.md) 与用户指示；任务包**不能扩大授权**。
