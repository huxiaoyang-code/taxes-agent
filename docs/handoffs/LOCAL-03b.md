# LOCAL-03b A+B1 交接

负责人 huxiaoyang-code，Issue64，分支 `codex/huxiaoyang-code/local-03b`；基线 `4146e46383e8826c8a4ee02b93f947c26efec014`。当前为实施者交付候选，等待管理者复验、全新上下文独审与 PR；未 Git / 未合并。用户授权额度不足时的单一兜底实施；未派其它agent或调用其它模型。

已实施三维实体/期初/真实分录分配、本机CLI、期间与核心生命周期保护、独立幂等回执/必要操作记录、官方严格备份恢复。接口、安装次序、事务结果与未完边界统一见 [LOCAL-AUXILIARY](../LOCAL-AUXILIARY.md)，不复制完整设计。

验证命令工作目录为 `06-workbench`，均使用合成库：

| 套件 | 实际结果 |
|---|---|
| `node test/auxiliary-storage.test.mjs` | 通过，安装前真实备份、未知组合零DDL、引用/父行守卫 |
| `node test/auxiliary-accounting.test.mjs` | 通过，两准则跨年独立手算与生命周期 |
| `node test/auxiliary-cli.test.mjs` | 通过，10个真实child均close |
| `node test/auxiliary-core-integration.test.mjs` | 通过，来源回放不变、派生重算与期初回滚、实际COMMIT_BUSY及未知状态隔离 |
| `node test/auxiliary-backup-integration.test.mjs` | 通过，bank0/1、WAL、恢复后实际续写683、9类伪结构与损坏拒绝 |
| `node test/auxiliary-bank-integration.test.mjs` | 通过，两准则同entryId往来状态及双方1130调节 |
| `node test/accounting-guards.test.mjs` / `accounting-derived.test.mjs` / `accounting-period-integrity.test.mjs` | 23/23、31/31、45/45 |
| `node test/import-incremental.test.mjs` | 57/57 |
| `node test/local-backup.test.mjs` | 原沙箱28/29，唯一硬链接EPERM；获自动审批后29/29，保留夹具 |
| `node test/bank-reconciliation.test.mjs` | 原沙箱42/43，唯一junction EPERM；获自动审批后43/43 |
| `node test/bank-import.test.mjs` / `bank-reconcile-cli.test.mjs` / `local-bank-backup-integration.test.mjs` | 均exit0，银行官方备份集成5/5 |

通过运行均实际 exit0 / close，无 timeout、无 skip 修改；旧失败记录保留，未弱化旧断言。没有重跑全73，不以旧全73代替本段验证。新测试保留各自UUID现场；既有套件只按其原逻辑处理本次自有fixture，未清理历史或未知根。所有自有直接child与数据库均已关闭，详细本机日志和精确文件hash由交付报告定位，不把本机路径写入版本文档。

已知未完：含维度的一体导入、HTTP/Agent/MCP、总入口为B2；银行只支持先bank后aux；audit/batch未知组合拒绝；真实税局0；UI上传工具限制仍未知。未知提交状态不自动重试，连接隔离后需关闭并核查持久回执。此候选不等于管理者验收通过。
