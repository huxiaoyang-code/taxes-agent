# 恢复与故障

中断后先 status：实读原始源、解析代码、验证、业务代码和真实账务证明。观察变更后持久失效，改回原字节不会复活旧确认，须重新登记复核。写意图先落日志；unknown 用 run phase=query 核对原 operationId、真实业务回执和凭证，不能新造 ID 盲重试。

recover_lock 只回收已证明原进程不存在的本 Store 锁；活进程、PID 复用或权限不明均不抢锁。恢复数据库的 instance/path 变化须停旧写，按现有 local-batch restore-check/restore-activate 和官方备份恢复契约处理，不把文件复制称为恢复。

解析失败或关键证据不足保留未识别内容、阻塞事实与具体处理路径。补件 request_materials 的 request={taskIds,text} 仅生成本机可转发文本，不发送。补齐只登记与重跑受影响分支。

故障分 skill/capability/mcp/parser/business_rule/agent_judgment/environment，保存复现输入、版本、实际返回、预期和产物；公共场景仅合成/脱敏。经复核的问题转回归用例；脚本测试不能代替真实 pi 委派及 MCP 演示。
