# 来源、许可证与改编记录

本目录年度 Skill 是以下 Anthropic 官方资料的本地改编；不包含 Agent SDK 或上游运行器，不宣称 Anthropic 对本项目或本地会计税务规则背书。

| 官方仓库与固定提交 | 采用文件 | 本地改编 |
|---|---|---|
| [anthropics/knowledge-work-plugins](https://github.com/anthropics/knowledge-work-plugins/tree/33d3dea41a341b341d4f5da2e8801ae0c89be2b8) | [finance/skills/close-management/SKILL.md](https://github.com/anthropics/knowledge-work-plugins/blob/33d3dea41a341b341d4f5da2e8801ae0c89be2b8/finance/skills/close-management/SKILL.md) | 采用依赖排序、阻塞暴露和审阅后完成机制；删除固定月结日历、工期和团队会议，按本机多账套的企业事实决定年度任务。原版本曾接共享编排；现改为直接业务工具，依赖仅保留可调整工作指导。 |
| [anthropics/financial-services](https://github.com/anthropics/financial-services/tree/574ed3624aebd0418c7e96cd101262f30210ab26) | [month-end-closer/agents/month-end-closer.md](https://github.com/anthropics/financial-services/blob/574ed3624aebd0418c7e96cd101262f30210ab26/plugins/agent-plugins/month-end-closer/agents/month-end-closer.md) | 采用计提支持、余额变动、差异调查及会计复核包；保留资料reader无写工具、凭证为草稿的权限边界；工具绑定本项目已发布能力。 |
| 同上 | [accrual-schedule/SKILL.md](https://github.com/anthropics/financial-services/blob/574ed3624aebd0418c7e96cd101262f30210ab26/plugins/agent-plugins/month-end-closer/skills/accrual-schedule/SKILL.md) | 采用支持来源、已入账、拟调整和 JE 草稿字段；不采用示例分摊公式、默认会计规则或自动冲回日期，改调用本地业务能力。 |
| 同上 | [roll-forward/SKILL.md](https://github.com/anthropics/financial-services/blob/574ed3624aebd0418c7e96cd101262f30210ab26/plugins/agent-plugins/month-end-closer/skills/roll-forward/SKILL.md) | 采用每项期初/变动/期末都应勾原账、差额不得强行填平；扩展为历史与次年余额及跨年台账关系，余额计算复用本地既有报表。 |
| 同上 | [variance-commentary/SKILL.md](https://github.com/anthropics/financial-services/blob/574ed3624aebd0418c7e96cd101262f30210ab26/plugins/agent-plugins/month-end-closer/skills/variance-commentary/SKILL.md) | 采用从实际活动解释差异、原因不明交会计调查；不采用默认重要性百分比或编造预算，扩展为年度更正前后版本的来源与数字差异。 |

许可核查：2026-10-25 读取上述固定提交的完整 Git 树与文件。knowledge-work-plugins 根目录及 `finance/LICENSE` 为 Apache License 2.0，finance 目录及目标子目录无 NOTICE；financial-services 根目录 `LICENSE` 为 Apache License 2.0，目标 month-end-closer 目录及祖先无额外 LICENSE/NOTICE。其他插件目录的许可与本次采用文件无关。两个适用许可文件的 Git blob 均为 `d645695673349e3947e8e5ae42332d0ac3164cd7`，同文全文保留在 [LICENSE](LICENSE)。来源文件无额外版权署名；保留 Anthropic 官方仓库归属与固定版本链接。

已验证可用的是上述依赖/调查/支持/草稿/人工复核机制。上游的 `mcp__internal-gl__*`、worker 运行器、xlsx 工具及 SDK 未整体引入。年度财税公式、所得税主体适用规则与账务执行来自本项目业务能力；尚未发布的能力始终标待实现，不由上游模板推导中国政策。

2026-10-30修改：默认调用改为direct finance工具，删除手工来源/事实/任务登记，后台自动保存调用及原件索引。报告顺序改为账本金额、凭证/计算、规则依据，调用及输入原件用于深入排错。保留来源历史和原Apache许可，不宣称上游提供中国税法实现。
