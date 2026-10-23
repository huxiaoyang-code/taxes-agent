# LOCAL-03b B2b 真实入口候选

负责人 huxiaoyang-code / Issue64，分支 `codex/huxiaoyang-code/local-03b-b2-entry`，基线PR70 merge `3ada7ab5c9388a2b5e4dea3e06b27f510cab6573`。B2a已实际验收合并；本片实施八工具REST/Agent/MCP、auxiliaryAppendix透传、固定模型投影/同进程localRef、总入口末尾追加10套（73→83候选）。实现仅接现有领域函数，不改B2a/core/auxdomain/DDL/backup/public/package。CLI仅help同步。

管理者独立发现新增辅助分录摘要浮点累加差1分P2；本轮仅改该合计为已审整数分/安全转换，并在新model增加正确金额与超界拒绝反例。修前全83通过保留原时点，不替代修后冻结总入口。

自测和失败历史、具体追加窗口及最终管理验收状态见 [交接](../handoffs/LOCAL-03b.md)，合同见 [LOCAL-AUXILIARY](../LOCAL-AUXILIARY.md)。MCP运输固定登记缺口已由管理者在 [comment6362820202](https://github.com/huxiaoyang-code/youshu-fork/issues/64#issuecomment-6362820202) 扩至22路径，仅增加固定工具分类、token/reason和错误category，未改运输校验算法；尚未宣告本片验收或合并。Issue64及整个八包仍保持未完成边界。以下旧任务状态保留历史。

# LOCAL-03b B2a 当前候选

负责人 huxiaoyang-code / Issue64；分支 `codex/huxiaoyang-code/local-03b-b2`，基线PR69 merge `0e8ed007ff6b783f4954a2126a04a8233c8b2196`。仅限已认领12路径的管理切片1：领域数据附录、稳定来源分录映射、同事务幂等与恢复，aux1结构及核心指纹不变。已实施、自测通过，尚待管理验收、独立审查与PR；不由实施者宣称合并。

实际53检查及旧5门定向结果、失败历史与生命周期见 [交接](../handoffs/LOCAL-03b.md)；合同见 [LOCAL-AUXILIARY](../LOCAL-AUXILIARY.md)。HTTP/Agent/MCP/model及test-all留B2b新会话，不占其入口文件、不把本段称为整个Issue64完成。

## A+B1 历史任务

> 当前执行 B2a 同事务导入附录；A+B1 的 PR69 真实合并、管理15套与独审接受见 [交接](../handoffs/LOCAL-03b.md)。下方候选为历史；B2b入口/总测试仍待后续。

# LOCAL-03b A+B1 任务

负责人 huxiaoyang-code；[Issue64](https://github.com/huxiaoyang-code/youshu-fork/issues/64)；分支 `codex/huxiaoyang-code/local-03b`。基线 main `4146e46383e8826c8a4ee02b93f947c26efec014`（PR68，已含PR67）。本段真实辅助账簿、CLI 与官方严格备份恢复已实施并提交本地验收；尚未 PR / 合并，不能关闭整个 Issue64。

范围与接口见 [LOCAL-AUXILIARY](../LOCAL-AUXILIARY.md)，证据见 [交接](../handoffs/LOCAL-03b.md)。只在已登记32路径内实施，未改核心 DDL、bank三源码、HTTP/Agent/MCP、public、package/lock 或 test-all。

验收要求：同账套稳定项目/部门/往来 ID，三维同tuple，整数分和明确未分配；两准则跨年独立手算；核心删除、期初、派生重算与期间保护；幂等回执及失败原子性；官方 core5+aux±bank 备份恢复、严格伪结构拒绝；实际银行 entryId 对应往来只读合同。

B2 仍需完成含维度一体导入附录、实际 HTTP/Agent/MCP 安全投影与引用、总测试入口登记及全入口验收。银行 aux后安装bank 的任意顺序留后续LOCAL04窗口；audit/batch组合留后续LOCAL06/07矩阵。禁止以本段候选声称整个 LOCAL03/06/07、全部八包或税局已完成。
