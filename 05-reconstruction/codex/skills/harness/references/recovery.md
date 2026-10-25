# 恢复与故障

中断后先 status：实读原始源、解析代码、验证、业务代码和真实账务证明。观察变更后持久失效，改回原字节不会复活旧确认，须重新登记复核。写意图先落日志；unknown 用 run phase=query 核对原 operationId、真实业务回执和凭证，不能新造 ID 盲重试。

创建草稿的证明绑定创建事实、凭证期间和分录，允许随后正常过账；实际状态仍如实返回。post/unpost 或直接创建 posted 凭证的状态变化仍失效。旧版本已记录的失效不删除：修复或代码升级后，先对 create、再对其 post 等依赖任务显式 `run phase=query`。只有原 request 一致、来源及父依赖当前可核验、原操作没有历史会计拒绝，才以原 operationId 追加当前代码/依赖版本的新查询回执，返回 currentBinding=true；不再执行业务写，旧回执和旧确认保留历史，新回执待复核。currentBinding=false 或 harness_query_historical_only 表示仅完成历史核查，不能据此声称当前任务已恢复；历史拒绝必须走更正，不能靠改依赖或 query 清除。

recover_lock 只回收已证明原进程不存在的本 Store 锁；活进程、PID 复用或权限不明均不抢锁。恢复数据库的 instance/path 变化须停旧写，按现有 local-batch restore-check/restore-activate 和官方备份恢复契约处理，不把文件复制称为恢复。

agency.posting 使用 prepare 已保存的 batchId/operationId/archivePath/archiveId 调用原生 queryAgencyPosting，核查现存审计、导入批次、来源指纹和真实过账分录，归档目录存在不代表写入成功。跨进程不反序列化 WeakMap proposal；只在原查询明确 not_started、来源及原方案仍一致且有人类版本绑定接受材料时，按原生 CLI 模式同进程重建再执行。unknown 或源/版本变化保留具体核查路径，不换批次重试。只读底稿/年度结果失效后显式执行真正重算，旧确认不会随原始字节恢复而复活。

解析失败或关键证据不足保留未识别内容、阻塞事实与具体处理路径。补件 request_materials 的 request={taskIds,text} 仅生成本机可转发文本，不发送。补齐只登记与重跑受影响分支。

故障分 skill/capability/mcp/parser/business_rule/agent_judgment/environment，保存复现输入、版本、实际返回、预期和产物；公共场景仅合成/脱敏。经复核的问题转回归用例；脚本测试不能代替真实 pi 委派及 MCP 演示。
