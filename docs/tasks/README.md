# 任务看板 · TASK BOARD

> 本文件是**任务分配与认领的权威规则**；具体任务单在 `docs/tasks/`，远端载体是 GitHub **Issue**（模板 `.github/ISSUE_TEMPLATE/requirement.md`）与 **PR**。
> 任务状态以 **GitHub Issue / PR + 本看板 + 版本化交接** 为准，**不以聊天、本机磁盘或 `.agent-runs/` 为准**。

## 0. 全量开发接管入口（2026-10-19 用户最新指示，优先于下文历史分工）

用户已把**全部后续开发**交给同事在**另一台电脑**的 Codex 接手，继续向同一私有仓库 `https://github.com/huxiaoyang-code/youshu-fork` 提交；**沿用 `huxiaoyang-code` 账号**，不另找用户名、不 fork、不另建仓库。**不复制**原机器 token / config / session / 账套 DB；目标机由用户自行登录、按已有授权独立配置。

- 接管任务单：[FULL-DEVELOPMENT-TAKEOVER](FULL-DEVELOPMENT-TAKEOVER.md)；自足交接：[../handoffs/FULL-DEVELOPMENT-TAKEOVER.md](../handoffs/FULL-DEVELOPMENT-TAKEOVER.md)；税局登录后 checkpoint：[../handoffs/TAX-POSTLOGIN-CHECKPOINT.md](../handoffs/TAX-POSTLOGIN-CHECKPOINT.md)。
- 交付目标为**最新业务 PRD 全部范围**（[PR #18](https://github.com/huxiaoyang-code/youshu-fork/pull/18) head `346e1c307379e9a6bf96ef34244dee154558777f`，Draft，未合并进 main）；漳州先验收 ≠ 全国完成。
- 远端载体：**总接管 [Issue #20](https://github.com/huxiaoyang-code/youshu-fork/issues/20)**（OPEN，assignee `huxiaoyang-code`）；业务 Issue #13 / #14 / #17 仍 OPEN（旧 assignee 未变、未关闭）；子 PR 用 `Refs #20` 并按业务 `Refs #13` / `Refs #14` / `Refs #17`。
- **旧 A / B 分工与本看板下文现有分工属历史快照**，不再限制接手者；Issue #13 / #14 / #17 保留、**不自动关闭**，也**不假定**旧机器已停止；开工前在 GitHub 核对在途 PR 并登记同名文件，**接管授权已由用户确认，不需要再次确认切换审批**，只在发现实际冲突或未停的同文件实施时协调，**不因同一 GitHub 账户推断技术互斥**。
- `huxiaoyang-code` 既有自动合并授权继续有效，仍须独立内容审查 / 影响验证 / 共享变更串行整合；**不是** GitHub 第二账号 review；真实外部提交仍按 PRD 操作前批次确认。自动点击浏览器 / 点击脚本路线已被用户**永久否决**。

## 1. 权威认领规则

1. **远端可见**：每个任务对应一个 GitHub Issue；开工前查看其 **assignee / 标签 / 状态 / 关联 PR**。
2. **唯一持有人**：同一共享文件（见 [团队协作协议 §6](../TEAM-COLLABORATION.md)）在任一时刻**只能有一个任务**声称编辑；由项目负责人在 Issue 上确认。
3. **禁止本地锁**：仅存在本机的编辑表格、worktree 目录或聊天约定**不能**当作全局锁。
4. **先拉基线**：`git fetch origin` 后基于最新 `origin/main` 建 `codex/<member>/<task>` 分支。
5. **初始状态**：新建任务一律从**「已分配 / 待开工」**开始，**不是「开发完成」**；`Refs #13` / `Refs #14` 关联子 PR，**不因 A0 / B0 完成就 Closes 总任务**。
6. **认领需登记**：在本看板「当前任务」表中登记 assignee、状态、分支与关联 Issue / PR（由管理者或任务持有人更新）。

## 2. 状态定义

| 状态 | 含义 | 允许的下一步 |
|---|---|---|
| 已分配 / 待开工 | 需求与验收已确认，尚未写代码 | 建分支、开工 |
| 开发中 | 本机执行员工正在实现并自测 | 提交审查 |
| 审查中 | 本机 Codex 在读 diff / 跑验证 / 核对边界 | 合并或退回返工 |
| 已合并 | PR 已合并，交接已更新 | 归档，开下游任务 |
| 阻塞 | 依赖未满足 / 需真实账号 / 需授权 | 记录阻塞路径，做可并行前置 |

## 3. 总任务 Issue（2026-10-16 管理者实测）

| 总任务 Issue | 工作包 | 业务承接人 / assignee | 状态 |
|---|---|---|---|
| [#13](https://github.com/huxiaoyang-code/youshu-fork/issues/13) | RC-A-LOGIN-DATA（RC-0 / RC-1 / RC-2a / RC-2b 与数据处理集成） | 负责人 `huxiaoyang-code`（assignee 已实际绑定） | OPEN |
| [#14](https://github.com/huxiaoyang-code/youshu-fork/issues/14) | RC-B-REPORTS（RC-4 / RC-5 与报表口径盘点） | 同事 `xiaoyihaishiaini`（assignee 已实际绑定） | OPEN |

> 子 PR 用 `Refs #13` / `Refs #14`；**只有总任务所有验收完成才关闭总 Issue**，避免总 Issue 被误当作所有子步骤都已完成。新子需求可另开 Issue 并链接总任务。本轮**本地员工未代发 Issue**；上述总任务 Issue 由管理者建立。

## 4. 当前任务

| 任务 ID | 负责人 | 范围 | 状态 | 依赖 | 任务单 |
|---|---|---|---|---|---|
| RC-A · RC-0 第一步 | 项目负责人 `huxiaoyang-code` | `TAX-BROWSER-REVIEW` 隔离快照与合成复验 | 已分配 / 待开工 | 无 | [RC-A-LOGIN-DATA](RC-A-LOGIN-DATA.md) |
| RC-A · RC-1 | 项目负责人 | 登录会话、办税员身份 → 授权企业 → 账套关联 | 已分配 / 待开工 | RC-0 第一步 + 第二步 | 同上 |
| RC-A · RC-2a / RC-2b | 项目负责人 | 目标账套定向导入、数据落地与重试、最小恢复 | 已分配 / 待开工 | RC-1 | 同上 |
| RC-B · B0 | 同事 `xiaoyihaishiaini` | 报表现状 / 独立金额样例 / 官方模板来源盘点；导出 DTO / 错误契约 | **已交付**（随 PR #15 合并，见 [RC-B 交接](../handoffs/RC-B-REPORTS.md)） | 无 | [RC-B-REPORTS](RC-B-REPORTS.md) |
| RC-B · B1 | 同事 | `report-export` 五类内部 CSV 导出与 HTTP / 页面集成（RC-4 前置） | **已交付**（PR #15 合并 `c2d5619`；完整 RC-4 验收仍依赖 RC-3 接线，[REPORT-EXPORT](../REPORT-EXPORT.md)） | B0 | 同上 |
| RC-B · B2 | 同事 | `tax-report-format.mjs` 税局申报可上传文件（RC-5 前置） | **未完成**；已有法定结构参考 / 勾稽与就绪性阻断，缺适用地区 / 准则 / 模板版本 / 上传格式，导出返回 422 `tax_template_unverified` | B0 + 官方模板核实 | 同上 |
| RC-3 | 项目负责人统一协调 | 会计核心 / 口径缺口；按 B 的发现另开聚焦任务 | 已分配 / 待开工 | RC-2a / RC-2b | [RC-A-LOGIN-DATA](RC-A-LOGIN-DATA.md) |
| RC-6 | 项目负责人统一协调 | 端到端联调与交付 | 已分配 / 待开工 | RC-4 + RC-5 | [报表闭环补全方案](../REPORT-CLOSURE-PLAN.md) |

**并行说明**：B0 已完成；B1 / B2 的**纯模块与合成 DTO 测试**可基于已协商 DTO 在 RC-3 完成前先行开发，**完整集成验收**才依赖 RC-3 与接线。RC-4 / RC-5 的**完整验收**依赖 RC-3 与真实官方模板，「**可以并行做前置**」不等于「**已经通过完整闭环**」。官方目标地区 / 准则未核实时一律记为**未知**，不得自称申报可用；内部 CSV 导出不等于税局申报可用文件。

## 5. 任务单必填字段

见 [任务模板](TEMPLATE.md)。每份任务单至少包含：需求与验收结果、文件所有权与共享改动协商、依赖 / 基线、成员与执行员工模型、Codex 独立验证、真实数据边界、验证 head、自动合并权限 / 协调记录、回退与交接。

## 6. 文件所有权速查

- **共享受控**：`accounting.mjs` / `coa.mjs` / `db.mjs` / `server.mjs` / `agent-tools.mjs` / MCP 注册 / `scripts/test-all.mjs` / `package.json` / `public/*` / 共享状态索引；同一时刻唯一编辑责任人。
- **B 专属**：`report-export`（RC-4）、**`tax-report-format.mjs`**（RC-5，`tax*` 规则的模块名专属例外）。
- **A 负责**：`tax*` 税务采集 / 登录 / 会话（`tax-gateway.mjs`、`tax-browser*.mjs`、`tax-import.mjs`）与 `import*` 定向导入。
- 完整规则见 [团队协作协议 §6](../TEAM-COLLABORATION.md)；共享接线走独立集成 PR 或申请短期文件所有权。

## 7. 合并协调

- 合并前核对最新 `origin/main`；基线变动**重验受影响范围**；锁定已验证 head 再合并。
- **GitHub 不能原子锁 base**：两个 PR 基于不同基线时，共享关键变更**串行合并**；可用远端 Issue 标注当前整合人，但**不声称评论等于技术互斥**。
- 成员可在满足验收与整合约束后**自动合并自己的 PR**；该授权**只适用已确认 / 登记且经项目负责人授权的成员及其任务**，新贡献者不能自授权。跨成员评审按任务风险与共享文件需求安排（见 [团队协作协议 §8](../TEAM-COLLABORATION.md)）。

## 8. 相关文档

- [团队协作协议](../TEAM-COLLABORATION.md) · [项目章程](../PROJECT-CHARTER.md)
- [报表闭环补全方案](../REPORT-CLOSURE-PLAN.md) · [阶段状态](../handoffs/STATE.md)
- [成员入场包](../handoffs/MEMBER-ONBOARDING.md) · [交接模板](../handoffs/TEMPLATE.md)
