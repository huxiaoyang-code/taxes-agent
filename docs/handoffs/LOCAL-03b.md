# B2b 第二P2：辅助账簿六金额完整投影守卫（2026-10-23，候选）

Root保存的修前完整head为 `a6e19b074e27a51ff62ae04ac4fd0cae225875d5`（未push/PR）；全新未参与实施的审查者确认新增辅助账簿摘要P2：真实期初700000000000.07 + 借400000000000.11 - 贷0.03，raw closing正确1100000000000.15，但原摘要未核六合计的模型上限，sanitizeProjection丢closing/debitBalance后仍ok=true并签发localRef。该完整候选暂不接受；此前员工完整83、root修前83及分精度修后必要五门均只保留各自真实时点，不能证明本P2不存在。

同一实施者仅修新增auxiliary_ledger六个totals：opening/debit/credit/closing/debitBalance/creditBalance逐一requireNum、复用已审storedCents/centsToNumber规范读取/安全转换，再核既有绝对值模型上限；任一失败拒绝整份摘要及引用，不能静默丢关键字段成功。没有改公共money/旧摘要/原compute/业务域/备份或旧断言，没有扩工具注册。

新model反例先实际红：真实新库正向期初/凭证raw closing准确，summaryUnavailable却false。修后真实正/负两账套closing分别±1100000000000.15都拒摘要/无ref；静态逐六字段验证±现有模型同边界合法值，六字段全部保留、projectionDropped=0且引用可用；逐六字段的正负超界、NaN、Infinity及大数值拒绝摘要/无ref。新model现92命名调用检查及既有额外反例通过/DB关闭。

本轮按管理者要求只跑原policy、新model、原adapter、原MCPtransport、新MCP必要五门，全部exit0/close、timeout=false；12源码/测试前后冻结SHA256一致，全部自有直接child及DB已关闭，无仍运行本片进程。之后仅同步文档/交付，源码/测试冻结停止；不重复其它78无变化旧门，不重跑完整83，也不能把任何修前83写成第二P2修后完整验收。自测仍待root独立5门/金额probe、完整diff及原fresh审查者审新完整head。以下保留第一P2及更早候选的真实历史。

# B2b P2 分精度最小返修（2026-10-23，候选）

管理者独立验收发现：新增 `auxiliary_entries` 先用Number逐行累加再舍入，合法1001行（首借900000000000.01、后999行各借0.01、末行贷900000000010）的摘要借方错误为900000000010.01，且未报告摘要失败；独立纯模块probe实际exit1、无DB/child。管理者修前完整83/83、exit0/close也不能证明此精度问题不存在；下方实施者修前83套记录保留原时点，不作为本次修后验收。

管理者完整入口真实close后才激活同一员工最小返修。只在policy新增辅助分录摘要中复用已审 `storedCents` 逐行转BigInt分累加，再用 `centsToNumber` 检查安全分数/往返保分；转换后若超过既有projection数值上限，整份摘要失败关闭，不能静默丢金额字段。公共money/core/旧摘要/原compute算法及旧断言未改。

新model反例先实际红（多0.01），修后借贷独立预期均精确900000000010；另含各行合法但合计超过模型上限和安全整数分的两例，摘要失败且adapter拒绝引用。新负例起初误把query失败ref预期null，真实既有query合同不提供该字段，已仅改新断言为undefined并保留失败历史。新model现48命名调用检查及既有额外反例全绿/DB关闭。

修后必要五门：原policy、新model、原adapter、原MCPtransport、新MCP，全exit0/close且timeout=false；不重复无影响绿门。修后最终冻结 `node scripts/test-all.mjs`（cwd `06-workbench`）实际83/83套、exit0、child close=true、timeout=false；12源码/测试冻结前后SHA256全部相同。全部自有直接child与DB已关闭，无仍运行本片进程；失败现场保留。返修后只补文档/交付，源码/测试冻结停止。自测不替代管理者独立内容验收/fresh独审；Issue64仍开放。以下是修前候选与真实历史。

# B2b 入口候选实施（2026-10-23）

负责人huxiaoyang-code / Issue64；基线PR70 merge `3ada7ab5c9388a2b5e4dea3e06b27f510cab6573`，分支 `codex/huxiaoyang-code/local-03b-b2-entry`。用户额度不足时授权的唯一fallback实施者执行，未Git、未另起员工/子agent、未自审。窗口原21路径；管理者确认真实运输固定登记缺口后，以 [comment6362820202](https://github.com/huxiaoyang-code/youshu-fork/issues/64#issuecomment-6362820202) 追加transport源文件至22路径，原transport测试不改。新工具分类、固定状态/reason和错误category与policy一致，未知自由文本仍拒绝；原applied token本来存在，没有重复增加。

八个origin=local工具已接REST/Agent/MCP，增量导入显式透传顶层auxiliaryAppendix；只复用现有db/领域事务。四查询摘要固定、四写持久证据按实际DTO读取；同进程localRef能实际读明细/compute，跨套/错operation/过期/撤销/伪channel/local拒绝。completed核心回放+新aux applied且两层committed正确判新写；零Count仍可写回执，Count不是新增行数。dryRun无此次写，staged/pending/unknown保守unknown。未知顶层status/ok组合及四写不可能的status拒绝摘要/引用，不拿自由字符串sanitize冒充白名单。导入ref无proof/实体明细承诺。完整合同见 [LOCAL-AUXILIARY](../LOCAL-AUXILIARY.md)。

本轮实际自测（所有命令均以node执行；workbench套cwd `06-workbench`，MCP套cwd `05-reconstruction/codex/mcp/finance-mcp`）：

| 范围 | 真实结果 |
|---|---|
| 新 `auxiliary-http.test.mjs` | 17命名检查组；两profile各8REST+8Agent、反过账/重过账、附录create/append/dry/replay/completed新增与冲突、路径/alias/跨套/停用/封账/金额/非法附录；exit0，安装CLI及后端child真实close，DB关闭 |
| 新 `auxiliary-model-boundary.test.mjs` | 45命名调用检查及额外DTO反例；真实引用/compute、scope、Proxy/getter/未知字段、到期/撤销、两层持久证据正反例；exit0，DB关闭 |
| 新 MCP `auxiliary-test.mjs` | 28真实成功调用；八工具、附录create/append/核心回放新增、真实localRead/compute；非2xx/畸形信封/断连各八工具固定拒绝、一次转发、无raw回退或敏感marker；exit0，安装CLI/stdio/后端child均close，代理与DB关闭 |
| 受影响12旧套 | import-incremental、import-strict、enterprise-identity、enterprise-identity-http、finance-output-policy、finance-model-adapter、finance-model-entry、finance-model-http、MCP enterprise-identity/import-incremental/finance-model-entry及原transport；全部exit0/close。旧MCP entry测试仅14→18与新增名/无重复最小断言，其它旧断言保留 |
| DTO修正后必要3门 | 原policy、新model、新MCP；全部exit0/close，未扩大其它绿门 |
| 总入口登记 | 原73逐字原序；去掉新增块重构原SHA256 `3462e5535559c83938f8b118a2baceb4f72321bf05d4873a88e35e1597cb9160`。末尾六A+B1、一B2a、三B2b，共83唯一条目 |
| 首轮完整入口 | 实际83/83、exit0/close；运行期间policy及新model反例被修改，只保留混版历史，不作为冻结最终验收 |
| 最终冻结完整入口 | `node scripts/test-all.mjs` 实际83/83套、exit0；runner观察child close，timeout=false。12源码/测试文件与冻结前SHA256全部相同；全部测试现场保留 |

两准则同库两企业AR1000→1400→800/B双倍，辅助三维不重复聚合，未分配桶和真实entry ID保持；旧无附录重放保留辅助事实及核心指纹，失败附录不把已completed批次改坏。模型成功/失败/stdio/受控服务日志均无合成敏感marker；本机合法原文仍正常可读。未实现旧upstream `enterprise_account.auxiliary_accounting.all`，12 available/11 unimplemented口径不变。

失败历史保留：新model首轮把失败信封localRef预期undefined而真实为null，改新断言后通过；HTTP原沙箱loopback EACCES，自动审批原样跑后发现新测试对空对象附录预期generic invalid而真实version_invalid，改新断言后通过；首轮MCP因运输固定登记缺失失败，扩窗后只补登记；一次编辑辅助脚本误认常量名失败且shell继续测试，源码未落写、同失败再次出现。DTO组合缺口修正时首轮full尚运行，已向管理者如实报告并待其真实close，再重跑必要3门和最终冻结full。未弱化旧业务断言、未隐去失败或清理未知现场。

现场均为workspace新UUID根，业务import前设TEMP/TMP/WORKBENCH_DATA_DIR且传child，祖先realpath/lstat核无链接，KEEP_FIXTURES=1；不扫删旧TEMP、不按裸PID杀进程。正常测试child退出码0；服务/stdio由自有句柄终止，实际close signal=SIGTERM（不伪称exit0）。最终完整入口已真实close，12源码/测试前后哈希一致，本片全部自有直接child与数据库已关闭，无仍运行自有进程。实施者已冻结停止，后续仅由管理者独立验收。候选待管理者独立复验、fresh独审与PR；本片尚未合并，Issue64/整个八包其它余项不关闭。银行先bank后aux、audit/batch未知组合、UI上传未知、真实税局0保持。

> B2a 实际验收合并（2026-10-23）：[PR70](https://github.com/huxiaoyang-code/youshu-fork/pull/70) 已于 `2026-10-23T10:10:00Z` 合并；已审完整 head `85c56a54172a3a8c02c237c579122c4ee87075d7`，merge `3ada7ab5c9388a2b5e4dea3e06b27f510cab6573`，两者树相同。管理者复跑 auxiliary-import 53 检查及 7 套旧领域/HTTP回归全部 exit0/close，11路径哈希不变。全新独审接受完整head，并独立以283.47、期初净412.13→695.60→565.87、旧71.83同额双行、失败回滚及官方恢复后619.27续写共11组合成检查通过/exit0/close。下方候选与失败历史保留追溯，B2b尚未验收，不代表83套或整个八包已完成。

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
