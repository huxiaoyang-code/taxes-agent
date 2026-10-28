# 企业接手与财税顾问技能包

维护入口：[taxes-company-advisor](../05-reconstruction/codex/skills/taxes-company-advisor/SKILL.md)。这是 Codex 的接手/调查/顾问工作法：历史整理、疑点复核、税费规划、税后现金四类工作按需加载；日常执行继续使用原有 Harness。工具没有覆盖的税费或现金计算不会因安装技能而变成已实现。

## 给同事使用

仓库：[huxiaoyang-code/taxes-agent](https://github.com/huxiaoyang-code/taxes-agent)。同事使用自己的 GitHub/模型服务身份，先取团队选定的已审提交；不要复制他人的配置、token、账库或会话。

两种使用方式：

1. 已配置本仓库 finance MCP：用 `skills_list` 找 `taxes-company-advisor/SKILL.md`，用 `skills_read` 按需读取。该路径属于 MCP 资源，**不会仅因拉取仓库就成为 Codex 原生已安装技能**。
2. 要在 Codex 用 `$taxes-company-advisor`：把整个 `05-reconstruction/codex/skills/taxes-company-advisor` 目录复制到自己的 `~/.agents/skills/taxes-company-advisor`，保留 references/assets/agents；或让 `$skill-installer` 从本仓库该路径、团队选定提交安装。不要只复制 SKILL.md，也不要无提示覆盖已有个人修改。安装后检查技能列表；未出现时重启 Codex。原生发现位置参见 [OpenAI 技能文档](https://learn.chatgpt.com/docs/build-skills)。

技能说明自包含；业务执行另需同事本机工作台及 finance MCP。配置方法见[代码索引 MCP](CODE-INDEX.md#mcp)和[Windows 启动](CODE-INDEX.md#windows)，使用本人机器的 Node/脚本路径及显式数据目录。没有连接时仍可制定调查和补件计划，不能报告已执行核算或已入库。真实资料仅放本机可信界面，模型输出边界见技能正文。

可以直接分配以下任务；将本机代号和期间替换为实际范围，不在消息里粘贴真实账务明细：

> 使用 $taxes-company-advisor 接手企业本机代号 A，接管截止日为指定日期。先核实已知资料和来源、列出缺件及影响，只放行有证据支持的分支，给出交给 Harness 的基线和未决问题。

> 使用 $taxes-company-advisor 复核 A 的这条疑点，按问题、证据、反证、缺口、解释草稿和处理选项组织；先出可复核结果，不自动发送回复或更改账务。

> 使用 $taxes-company-advisor 基于已核历史和老板的经营选择，比较下期税费支付、企业税后现金、最低现金缺口与行动建议；涉及股东取款时另核交易性质和个人税负，不把企业现金当可分红利润。

## 版本、交付与维护

- 以技能来源仓库的完整 commit SHA 管版本；分发时同时说明选定 SHA、技能路径和本机工作台版本。更新前比较差异并保留原安装目录；回滚技能用原提交的完整技能目录，不回滚或覆写真实账库。
- 用户可读入口在此，工作流正文及引用集中在技能目录。修改通过 Issue/PR 和独立审查，不再建立平行进度表。源代码任务用 GitHub；客户报告、缺件、证据和复核记录只留对应企业本机目录。
- [合成演练输入](../05-reconstruction/codex/skills/taxes-company-advisor/assets/synthetic-case.md)和[独立预期](../05-reconstruction/codex/skills/taxes-company-advisor/assets/synthetic-expected.md)分开。给评估者先读技能与输入，第一轮完成后才给更正，作答后对照预期；不使用真实账套。演练通过不等于业务或税务验收。

本包不自动安装依赖、不发送客户消息、不提供正式申报/缴款，也没有通用顾问报告的 B 展示接口。B 当前综合分析边界见[分析指引](../05-reconstruction/codex/skills/harness/references/analysis.md)。
