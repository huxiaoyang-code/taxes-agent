## B2a 当前交付候选（2026-10-23）

本段从 PR69 merge `0e8ed007ff6b783f4954a2126a04a8233c8b2196` 开始，分支 `codex/huxiaoyang-code/local-03b-b2`。实现纯数据auxiliaryAppendix v1与原增量导入同连接同事务；预先安装aux1，不改DDL/版本/FK、三个核心指纹函数或HTTP/Agent/MCP入口。完整合同见 [LOCAL-AUXILIARY](../LOCAL-AUXILIARY.md) / [LOCAL-IMPORT](../LOCAL-IMPORT.md)。实施者未Git、未自审；待管理复验、全新独审及PR，不预报合并。

真实自测（cwd `06-workbench`）：

| 命令 | 结果 |
|---|---|
| `node test/auxiliary-import.test.mjs` | 最终53检查通过；CLI安装、恢复续写及4类未知事务共6个child均close/exit0，主DB finally close |
| `node test/import-incremental.test.mjs` | 57/57，exit0/close |
| `node test/import-strict.test.mjs` | 初跑49/54，5个loopback fetch失败；自动审批后原样54/54，exit0/close，未删旧断言 |
| `node test/enterprise-identity.test.mjs` | exit0/close |
| `node test/auxiliary-core-integration.test.mjs` | exit0/close |
| `node test/auxiliary-backup-integration.test.mjs` | bank0/1及实际恢复续写均exit0/close |

两准则同库两企业独立预期：A的AR1000→1400→800，B双倍；12月gross借1700/贷300，1月发生0/600，银行9400→9900，三维及单维相等。create/append均在实体、第2映射、分配、总回执注入错误，逐表全事务回滚；dryRun全表不变。旧同额同摘要双行强制actualEntryId，映射不迁移；核心FP/老payload回放不变、实体编辑冲突、跨套/封账/未知profile、人工命名空间碰撞、两连接竞争、caller保存点和未知状态隔离均已测。官方backup→verify→restore-new保持JSON映射并成功回放/继续合法导入。

早期新套件有fixture错误（append缺meta、profile ID拼写、跨批mode、封账前缺结转）及固定busy码二次归类问题，均已修复后通过；失败现场保留。最终测试后仅补文档，无继续扩大套件；没有完整总入口、HTTP/Agent/MCP/模型附录验收。原15套是PR69事实，不代替本段验证。所有本次自有直接child均已close，未留运行员工/服务，未扫描或清理历史TEMP。B2b另新会话处理真实入口、安全投影和总测试登记；Issue64仍开放，整个03/八包未完成，税局0。

> 2026-10-23 更新：A+B1 已实际随 [PR69](https://github.com/huxiaoyang-code/youshu-fork/pull/69) 合并；已审完整 head `516afaf2d21b7cfde2d606cd52f9fd308eac33c8`，merge `0e8ed007ff6b783f4954a2126a04a8233c8b2196`，mergedAt `2026-10-23T09:19:16Z`。管理者复跑6新+9旧正式套件全部 exit0/close，26路径hash前后不变；全新上下文独审接受完整head，独立合成probe验证三维、跨年、跨套拒绝、保存点及官方恢复续写。下方实施候选与失败历史保留作追溯，不代替B2a验收。

当前 B2a 从上述 merge 开始，仅实现数据型附录与原核心增量导入同事务；HTTP / Agent / MCP / 模型投影及总测试登记属于后续 B2b。B2a 尚未验收、PR或合并，Issue64继续开放。

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
