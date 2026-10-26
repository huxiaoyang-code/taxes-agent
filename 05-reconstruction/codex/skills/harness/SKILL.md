---
name: finance-harness
description: 从目标和原始资料开始，发现能力，维护证据、计划、回执、补件、会计反馈与恢复。pi 优先，其他 MCP Agent 可接入。
---

# 本机财税 Harness

先 `harness_discover` 读适用条件、必要事实与限制；选中能力再 `harness_discover({capabilityId})` 读输入合同、最小示例与恢复说明。正常调用先用这些合同；确需调查细节再读原生指引或源码。声明可调用不代表适用。

用 `harness_scope_discover` 从明确现库路径或 FINANCE_DATABASE_PATH 核实企业、账套、实例；不让客户提供内部ID，不猜默认账套。新企业用已有 `account_set_create` 后重新发现。`harness_init` 绑定该目标、月/季/年与币种，创建独立元数据目录。

用户只需给业务目标和原始资料。宿主可委派解析子 Agent，编写并运行解析/整理代码；不要要求客户固定模板、预制分录、科目或已算好的税额。按阶段只读相关指引：

- [资料接入](references/materials.md)
- [计划与核算](references/accounting.md)
- [期间与税务](references/tax.md)
- [会计反馈与更正](references/review.md)
- [恢复与故障](references/recovery.md)

原件事实、程序推导和待核判断分开登记；来源ID不等于原文支持。缺地区保持未知，不填“市区7%”。应纳、会计计提、实缴、差额分别引用对应结构字段；没有缴款证据不称已缴。工具能核定位、数值绑定和版本，不能保证语义理解永不出错。

Agent 根据事实调整 DAG；`harness_plan` 替换整张图，保留仍需任务。缺项只阻塞依赖分支，独立分支继续；未覆盖业务沿用有依据的企业处理草稿、验证与反馈。默认回执同时压缩 text/structuredContent，完整原生数据保存在本机；按 `presentation.details` 调 `harness_receipt_read` 分段读取，见[恢复与故障](references/recovery.md)。执行历史、当前结果、当前确认分别报告。补件只生成本机文本；脚本通过不代表真实 Agent 或全税验收完成。

正常调用省略 responseMode 或设 summary，按 pointer 读取需要的字段；full 仅供旧原生客户端迁移且不设体积预算。
