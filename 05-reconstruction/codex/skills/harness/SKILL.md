---
name: finance-harness
description: 从目标和原始资料开始，发现能力，维护证据、计划、回执、补件、会计反馈与恢复。pi 优先，其他 MCP Agent 可接入。
---

# 本机财税 Harness

先 `harness_discover`，按实际支持条件选择可执行分支；声明可调用不代表适用。用 `harness_scope_discover` 从明确现库路径或启动配置 FINANCE_DATABASE_PATH 核实企业/账套/实例/期间，不让客户提供内部ID，不猜默认账套。新企业通过已有 `account_set_create` 建账再发现绑定（后端需指向同一明确本机数据目录）；资料不足则具体补件。显式绑定企业、账套、数据库实例、月或季、币种，用 `harness_init` 创建独立元数据目录。

用户只需给业务目标和原始资料。宿主可委派解析子 Agent，编写并运行解析/整理代码；不要要求客户固定模板、预制分录、科目或已算好的税额。按阶段只读相关指引：

- [资料接入](references/materials.md)
- [计划与核算](references/accounting.md)
- [期间与税务](references/tax.md)
- [会计反馈与更正](references/review.md)
- [恢复与故障](references/recovery.md)

Agent 根据事实调整 DAG，程序约束数据、金额、账务、版本与执行记录。独立分支继续；缺失、冲突、未知、不支持、不适用分别保留，不能靠改标签消除阻塞。补件只生成本机文件或可转发文本。脚本通过不代表真实 Agent 或全税业务验收完成。
