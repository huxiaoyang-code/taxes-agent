# PROJECT-PRD-REVIEW 交接（PRD 与高级 review 入场包）

> 版本化交接，只写可核验事实，不伪造 head / PR。相关：[产品 PRD](../PRODUCT-PRD.md) · [review 任务单](../tasks/PROJECT-REVIEW-SHOWMAKER101.md) · [阶段状态](STATE.md)。

## 1. 基本信息

- 任务 ID / 状态：`PROJECT-PRD-REVIEW` — **草稿交付**；业务无变化。
- 负责人：`huxiaoyang-code`；执行员工：pi（主 / 回退 tokenhub DeepSeek V4.1 Flash 显式锁定）。
- 分支：`codex/huxiaoyang-code/project-prd-review`；worktree：`<repo>/.worktrees/project-prd-review`。
- 关联 Issue / PR：**review Issue [#17](https://github.com/huxiaoyang-code/youshu-fork/issues/17)（OPEN，待接受邀请后指派给 Showmaker101；尚未提交 review 结果）；开发任务在方案确认后按 Issue 派工**。总任务 [#13](https://github.com/huxiaoyang-code/youshu-fork/issues/13) / [#14](https://github.com/huxiaoyang-code/youshu-fork/issues/14) 保持 OPEN，**不关闭、不重新分配**。
- 目标：落实用户 2026-10-17 最新确认，产出 PRD v0.1 与 Showmaker101 高级 review 入场包；**绝不实现业务**。

## 2. 基线与交付口径

- 基线（`origin/main` 完整 SHA）：`d0221df1d18e2bfcbd7db2cc9aa0875ab32a7fd4`（含 PR #15 报表 + PR #16 团队文档）。
- 交付口径：**草稿交付；业务无变化；审核与提交信息由管理者在 GitHub 草稿 PR 记录，最终实施方案未冻结**。
- head 时间锚点：**员工交付时尚未提交；管理者审核及提交 head 以关联 Draft PR 为准**（本文不预测具体 head / 链接）。

## 3. 本轮允许写入的文件与所有权

- **仅 3 个文件**（无其他修改）：
  - `docs/PRODUCT-PRD.md`：中文 PRD v0.1（最终产品、能力矩阵、需求 ID、自动化边界、会计 / 税务验收、里程碑、非功能、官方参考、待确认决策）。
  - `docs/tasks/PROJECT-REVIEW-SHOWMAKER101.md`：高级 review 任务单与入场包。
  - `docs/handoffs/PROJECT-PRD-REVIEW.md`：本交接。
- **未触碰**：任何源码 / 测试 / 索引 / AGENTS / 章程 / STATE / 看板；**未动** RC-A0 在途整合。

## 4. 实现摘要与关键取舍

- PRD §0 **逐条落实用户最新确认**，并明确声明本轮 PRD 的 V1 边界**替代**旧 ROADMAP 把全国 / 发票 / 申报后排的表述（**不修改旧文件**）。
- **V1 必做域（不得后排为可选）**：全国适配、双准则账务、两类报表、持续导入 / 幂等、发票、企业各税种与个税正式申报、审计 / 备份 / 安全 / 交付。
- 「福建漳州报表闭环」标为 **M2 子里程碑**，不冒充 V1 完成。
- 能力矩阵给**代码路径与限制**，不用完成百分比；已实现 / 部分实现 / 仅接口 / 未验草稿 / 待开发 / 待真实验证分开；已实现能力（税表历史参考 + 勾稽校验、`db.mjs` 基础建表 + `vouchers.kind` 轻量迁移、`accounting.mjs` SAVEPOINT 事务）与缺口同时写明，不抹去已有能力。
- 新增行：XLSX / PDF 输出、辅助核算、银行对账 / 银行流水来源均标**未实现**，需求列 §10 D-12 ~ D-14 **待决策**（不自动加首版，也不丢失盘点）。
- 自动化边界：准备 / 校验 / 批次计划允许；开票 / 红冲 / 正式申报须本机预览确认；验证码 / 实名不绕过；超时先回查再重试；提交成功无回执保持未知防重发。
- 待确认决策**集中列 §10**（税种清单、个税经营所得 / 汇算、特种票、社保非税 / 缴款、更正撤销、来源实证、频率与模板、交付规模、技术通道、每区验收材料）；**已确认的全国 / 双准则 / 漳州 / 角色不再列为未知**。
- 金额精度 / 舍入规则 / 独立金额边界测试必须明确；整数分 / 定点十进制等技术选型与当前 `REAL` / Number 迁移策略**待 review 评估**，不据此强制重写架构（§3、§4~§8 的工程实现与建议验收均标「方案建议，待 review 冻结」）。
- 官方参考只登记官方来源、发布日期 / 查询日与有限支持结论（无「每条 ≤ 50 字」要求），**不推定开放 API**。

## 5. 用户本轮全部选择（记录在 PRD §0）

1. 高级 review 先行，与用户 review 最终形态 / 需求 / 未完功能后再给 PRD 与派工。
2. 首版含全国适配、发票采集 / 开票、各税种及个税正式申报；可分阶段，但不得降为首版外 / 长期选做。
3. 首个真实验收地区福建漳州；两种准则都要。
4. Showmaker101 先全面 review 提整改计划，方案确认后接开发；保留 A / B 分工；未给新成员自动合并授权。
5. 用户已授权 write，邀请已发出待接受（ID `338167875`，`Showmaker101`，write）。

## 6. 未完成项、风险与待决策

- PRD 为 **v0.1 讨论稿**；详细实施方案须**项目负责人 + 高级 review 确认**后才作为最终实施基线。
- 待确认决策见 PRD §10，需用户 / 官方证据推进（尤其 D-01 税种清单、D-06 来源实证、D-07 现行模板）。
- 高级 review 任务单为入场包，**review Issue [#17](https://github.com/huxiaoyang-code/youshu-fork/issues/17)（OPEN，待接受邀请后指派给 Showmaker101；尚未提交 review 结果）**；Showmaker101 邀请**仍待接受**。

## 7. 验证状态与边界

- 本轮为**文档 only**：员工前两次有效文档会话已由管理者核实 **exit 0**；管理者已完整阅读 3 份文档及相关 main 源码片段、核对用户已确认范围，并检查 49 个本地 Markdown 相对链接全部存在；**业务代码 / 测试无修改，未重跑业务测试**，不声称任何业务测试通过 / CI 通过。
- Git 差异检查、最终提交 head 与 Draft PR 链接**由管理者在对应 GitHub 草稿 PR 记录，本文不预测**。
- 未触碰真实账套 / 凭据 / `.env` / profile / 历史日志；未绕过沙箱；无真实登录 / 开票 / 申报 / 缴款。
- **RC-A0 未触碰**：负责人本机整合仍未提交 / 未 PR / 未合并（盘点时曾见一批未提交变更，可能随在途工作变化，**需恢复后重核**），不复制其本地代码入本分支。

## 8. 回退与下一步

- 回退方式：本分支文档可通过新提交调整；**合并后如需回退用 revert PR，不重写 main 历史**；不建议删除用户成果。
- 下一步输入：管理者审核本 3 份文档并在只读 review Issue [#17](https://github.com/huxiaoyang-code/youshu-fork/issues/17) / Draft PR 记录 → 待 Showmaker101 接受邀请后指派 → 与用户 review 最终形态 → Showmaker101 全面 review 出整改计划 → 方案确认后按 Issue / 文件所有权 / PR 派工。
- 仍运行进程 / 会话 / 日志：本会话为一次性文档会话；「仍运行进程」等描述为**盘点时快照**，可能随在途工作变化，**需恢复后重核**，不当作实时监控。
