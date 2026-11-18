---
name: company-baseline
description: 从特定企业的实际账套、代表性历史、合同和申报资料提炼少量可沿用的做账原则，用于首次接手、规则变化及按既有基线处理新月份。
---

# 企业短业务基线

1. **核实范围。** 以已绑定的实际账库、企业、账套、期间及获准资料根为准。用 `finance_baseline_read({target:{accountSetId,period}})` 查短基线。`ready` 且适用条件未变时，直接沿用并按[本期取数](references/materials-and-save.md#按短基线处理本期的本机取数)处理新材料。普通业务新凭证沿用原版。
2. **需要调查时直接读取。** 通过当前宿主已有的本机文件和脚本权限，读取相关历史、合同／底稿和申报导出。先确认实际主体、期间、单位及字段含义。按需读 `finance_record_contract({recordType:"baseline"})` 与[宿主原件读取](references/material-adaptation.md)，从原件选出能支撑本次结论的观察，写到审计根的 `agent-materials` 中，只将结果文件路径交给 `finance_baseline_materials`。格式和编码由实际材料决定。原件、读取过程及取数明细留本机，按现有授权披露。
3. **取可执行结论。** 看真实 `principleSupport`、税费结果及 `coverage`，沿实际续页查看必要分支。核当前适用规则和同业务证据，选能指导本期的准则、归类、成本、税会所属期、当期／分期／资本化及关键税务选择。行业标签、科目或同额记录单独不足以证明算法。无法确认的事项保留具体待核。仅有账套配置时，报告已知准则及尚缺的历史证据。
4. **合并、保存、回读。** 依据分开提交时，显式合并相关 `materialRefs`，保留税费来源。按[保存合同](references/materials-and-save.md)选择实际返回的重要 `supportRef`，保存时使用实际并发版本和有效期。用 `finance_baseline_read` 核短文、意图范围、所选分支及税负。短文最多 8 条、600 个 Unicode 字符，重要待核最多 3 项，按实际依据决定条数。
5. **处理本期。** 对同类业务沿用适用口径，金额、余额和合同进度按本期实际来源取数。会计政策、长期处理原则或有效选择确实变化时才换版。原件变动或冲突时只调查相关规则。旧方法及案例按[企业记忆参考](../shared/references/business-memory.md)需要查回。

历史税负分税种、应纳／实缴、所属期／缴款期、本期／累计及税额阶段。增值税按可比期间的合计税额除以合计不含税销售额，所得税累计值单列。缺项留未知，历史区间只作调查参考。本期政策时效或适用条件有疑点时查 `finance_rules` 或当前官方原文。

按[报告顺序](../shared/references/reporting.md)交付金额、异常、所用口径和有限待核。凭证、税费及整期任务分别接[凭证编制](../journal-entry/SKILL.md)、[税费复核](../tax-review/SKILL.md)和[整期入口](../tax-period/SKILL.md)，正式操作遵守原有人审与防重复控制。
