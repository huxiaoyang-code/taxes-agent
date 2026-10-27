---
name: finance-harness
description: 根据业务目标与原件，按需发现本机财税能力；维护事实、任务、底稿、复核与恢复。适用于核算、期间更正、年度检查和批量任务。
---

# 本机财税 Harness

从用户目标和原始资料出发。Agent 理解资料、判断业务、选择能力并拼装请求；Harness 保存事实/版本/执行历史，固定原生能力负责计算与写入。客户不需内部模板、分录或算好的税额。

先用 `harness_discover()` 查看轻量领域目录；以 `{domain:"agency"}` 或 `{query:"service workpaper",limit:8}` 找候选，按 nextOffset 继续。选中后用 `{capabilityId}` 读取完整输入合同、例子、适用范围、阶段和恢复。只读相关 Wiki；候选和例子都不证明客户业务适用。正常调用所需信息由合同/诊断/Wiki提供，无法解释的缺口保留并报告。

用 `harness_scope_discover` 从明确现库核实企业、账套、实例；再以 `harness_init` 绑定期间/币种和新元数据目录。不要猜默认账套。各能力支持月/季/年的范围不同：材料和原生税务复核 Store 当前仅支持季度字符串，年度检查是只读草稿；按单能力 supportedPeriods 核实。

按当前任务加载：

- [资料接入与证据](references/materials.md)：解析任意原件、登记事实、保留缺失/冲突。
- [计划与核算](references/accounting.md)：显式请求绑定、依赖与固定业务能力。
- [期间与税务](references/tax.md)：当前支持范围、税款口径与年度限制。
- [会计反馈与更正](references/review.md)：实际人审、版本和关联更正。
- [恢复与故障](references/recovery.md)：原操作查询、历史及定向回执。

新任务用 requestFactId 选择已登记的请求事实，同时将它和全部推导输入放入 factIds；无需靠数组首位选择请求。登记/status 返回 factBindings 的当前 valueDigest/factVersion，直接使用这些绑定，不自行计算摘要。业务日期、原件事实、业务判断和授权须明确有据；Harness 不默认填事实。

缺项只阻塞依赖分支；独立分支可继续。`harness_plan` 仍替换完整 DAG，保留仍需任务。补件后更新受影响事实和请求，查看 nextSteps/失效结果。unknown 写入先 query 原身份；执行历史、当前结果和当前确认分别报告。

默认回执为摘要，完整原生结果持久保存；按 presentation.details 用 `harness_receipt_read` 定向读取。应纳、计提、实缴、差额按原生字段分别表述；缺地区不猜“市区7%”，无支付证据不称已缴。未覆盖业务保留缺项或走有据的企业处理/验证/反馈。实际人审、申报和缴款不能由脚本通过或模型说明代替。
