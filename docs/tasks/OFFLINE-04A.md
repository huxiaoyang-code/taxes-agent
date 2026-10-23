# OFFLINE-04A / #81A：显式只读账务一致快照基础

Refs #76 / #80 / #81。基线main `9cd0176bb912c94b519fc40b155159d4ca5b81c7`（PR90），分支 `codex/huxiaoyang-code/offline-04-snapshot`。本轮唯一当前会话模型实施subagent，不再委派，不调用pi/Claude/TokenHub或其他模型执行器，不做Git提交/推送/合并；root负责独立验证、全新独审及Git。

目标：从显式本机DB只读获取规范企业账套的真实posted/draft完整数据、profile/账户/期初/期间、import来源和实例上下文；同事务读取，私有进程能力绑定和范围内容重验。CLI新建诊断JSON，固定安全stdout，拒覆盖。精确合同及限制见 [OFFLINE-LEDGER-SNAPSHOT](../OFFLINE-LEDGER-SNAPSHOT.md)。

写窗口仅六文件：

- `06-workbench/server/offline-ledger-snapshot.mjs`
- `06-workbench/scripts/offline-ledger-snapshot.mjs`
- `06-workbench/test/offline-ledger-snapshot.test.mjs`
- `docs/OFFLINE-LEDGER-SNAPSHOT.md`
- `docs/tasks/OFFLINE-04A.md`
- `docs/handoffs/OFFLINE-CLOSELOOP.md`

核心DB/accounting/import/bank/aux/audit/coordinator/batch/HTTP/MCP、package、test-all、STATE/NEXT-SESSION均只读。未读真实账套/原件/凭据，无schema迁移、安装或DB写；合成测试夹具通过官方安装API构造audit/batch组件。

验收：实际核心导入posted+创建draft，独立金额分值/完整ID和行序；企业/月份隔离，空账和缺月份不当零申报；来源缺失/失配和真实性未核验；金额/状态/来源/profile/绑定/期初/账户/期间/范围前历史/实例更正失效；无关企业不失效；clone/JSON/公开digest/跨source不能认证；真实writer中途提交仍读同事务一致快照；逻辑表/DB/WAL零写；CLI新output、安全stdout/拒覆盖；关闭、路径身份失效拒绝。

生产状态固定calculationReady=false、submittable=false。#81整项未完成：税算、完整度认证、合法连续纳税期间、原始文件与经济事项真实性、正式写账/连续过账及提交仍留后续。#54另一窗口coordinator未合，不能把本片当其正式写依赖完成。

实施结果及失败修复事实记录在 [离线闭环交接](../handoffs/OFFLINE-CLOSELOOP.md)。本任务文档不预报root验收、fresh接受或PR/合并。
