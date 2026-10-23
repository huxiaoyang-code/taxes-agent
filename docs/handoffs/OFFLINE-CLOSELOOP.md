# 离线闭环交接

## 2026-10-24 当前事实（优先于下方历史候选）

OFFLINE-01A 已随 [PR88](https://github.com/huxiaoyang-code/youshu-fork/pull/88) 合并：base `882c5b65564fd7e2281eba4a799b3a7a25c5b5f3`，已审 head `02083eb6c89b3f367df8561d008e015c2061d5b1`，merge `a004bd889554c091318e5e017a93ec575581cf5e`。root 独立材料36/36及新base重跑通过，旧合同34/34、银行16/16通过，fresh接受。#78B仍未实现，#77/#78整项均未完成；下方“01A未提交候选”保留为当时历史。

OFFLINE-02A / #79A 在 PR88 merge 上实施，branch `codex/huxiaoyang-code/offline-02-plan`。当前为未提交实施候选，**待root独立验证、fresh最终冻结审查及PR，不预报合并，不关闭#79**。用户本轮授权唯一实施 subagent 使用当前会话模型，旧实施额度停止后保留并恢复5个未跟踪模块/测试；未再委派、未调用pi/Claude/TokenHub/其它模型执行器，没有Git提交/推送/合并。

本片为纯资料完整度矩阵、解释性准备DAG、本机中文补件文本及选择性重规划，入口 `node scripts/offline-plan.mjs --input <planning-input.json> --output <new-plan.json>`（cwd `06-workbench`）。输入只显式引用 #78 report、基础声明JSON及可选previousPlan，声明null先请求基础信息。rawContent重新hash并标准化，不信任report的status/records；坏源隔离、合法独立源保留。仅新output包含具体业务/字段/补件文本，stdout固定状态/计数，stderr为空，拒绝覆盖；不读取真实资料、账套或凭据，不发消息。契约见 [OFFLINE-PLAN](../OFFLINE-PLAN.md)，文件窗口见 [OFFLINE-02](../tasks/OFFLINE-02.md)。

`ready` 仅代表可整理该笔 `business_evidence_packet`，`produced:false`、`accountingEligibility:not_assessed`、`authorizesExecution:false`。服务完成+unpaid不证明已取得收款权利、主营性质或VAT纳税义务；已收/已付缺逐笔分配、未履约及采购用途/对象/受益期不足均需澄清。post/close/compute_tax/review为显式未实现依赖节点；正式会计准入/执行完成/回执复用仍留后续#79及#80/#81/#82，不把资料ready当会计完成。未碰另一窗口#54 W2b的accounting/import/db/coordinator/bank/aux/HTTP/MCP/batch核心。

恢复期间修复：账户清单遗漏已有账户、销/采购/逐账户无业务声明与实际记录矛盾均传递阻断对应分支；缺整期覆盖或partial仍可整理独立单笔。相同sourceId冲突组排除后仍保受影响docId与business.invoiceRef身份，第三独立来源副本不能隐藏同票已知冲突。同银行流水全部冲突版本及实际相关无业务声明/依据入局部摘要，状态仍conflict时材料版本变化也使对应任务及后继失效，无关票/账户不失效。中文补件保机器code，但转发文本用固定中文原因、具体票号/账户/字段及任务goal，原始资料和登记替代依据分别列出，税属性仅索取未知字段，不要求预制分录/凭证/税额。

最终实施自测（cwd `06-workbench`）：`node test/offline-plan.test.mjs` **45/45、exit0**。含临时合成真实CLI、null声明、独立1234.57+37.04=1271.61仅资料准备、工资资产/期初历史税属性、跨企业/账套/期间/币种、派生伪造、来源损坏/冲突身份传播、全部冲突银行版本、无业务依据更新、补件局部失效、四后续节点、stdout/不覆盖。所有CLI子进程signal=null、stderr为空，无自有常驻进程；未跑无关全量，无DB/package/test-all/STATE/NEXT-SESSION/锁或#78实现改动。

修复过程先42/43通过，失败为原采购用途测试默认套用purchase:no_activity，而新矛盾传播正确令其blocked_conflict；保持原blocked_unknown及用途中文断言，仅将该用例覆盖声明设为真实有采购complete/sourceIds，同时新增无业务采购冲突断言。随后44/44及新增实际CLI冲突/完整DAG后的45/45通过；没有删除旧断言或伪造通过。管理者要求收尾影响回归：同cwd `node test/offline-materials.test.mjs` **36/36、exit0**；`git diff --check` **exit0**。这些是实施自测，不能代替root和fresh冻结验收。#77/#78/#79整项仍未完成。

OFFLINE-00 已随 [PR86](https://github.com/huxiaoyang-code/youshu-fork/pull/86) 合并：已审 head `3afe123bd2ba35114ff543d676224f2111600d8a`，merge `5410be670657f5df0bdaec80c05e83de939709fd`。root 独立34/34通过、全新上下文独审接受。#77工程合同已合不等于其会计生产黄金/法规表式/客户试用验收完成。

OFFLINE-01A / #78A 在上述基线上实施，当前为未提交候选，待root独立验证/全新独审/PR，不预报合并。只新增纯发票/银行CSV及基础事实JSON标准化、本机CLI与测试/文档，未接入运行账套。字段/来源hash/重复冲突/命令/支持边界见 [OFFLINE-MATERIALS](../OFFLINE-MATERIALS.md) 和 [任务单](../tasks/OFFLINE-01.md)。仅显式新output可包含路径与原值；stdout固定状态/计数；整体not_assessed、#79未实现。银行归属是本机配置声明，原票引用未核验既存记录，均不冒充真实性认证。

实施最终自测（cwd `06-workbench`）：`node test/offline-materials.test.mjs` **36/36、exit0**；相关未改模块 `node test/offline-contracts.test.mjs` **34/34、exit0**、`node test/bank-import.test.mjs` **16/16、exit0**。实际CLI同步子进程均返回明确status、signal=null，无自有常驻进程。新增测试覆盖独立1234.57+37.04=1271.61/银行647.29，真实三文件临时落盘、hash与重放、stdout敏感标记、已有输出/输入零改动。过程中31→33→34→35→36项按新增断言扩大，未删除旧断言；未运行无关全量。

审查期间修复JSON date及invoiceRef.code/number类型强转P2：现要求规范字符串，数组/数值/空白日期全部拒绝，新增固定回归。合法单源business JSON保留事实并标referenceVerification=missing/unresolvedReferences，不再因缺本批发票当非法；真实CLI已验。错误改为固定白名单类别、纯函数数值来源/行/字段定位，CLI只给固定分类，非法材料当前不输出报告，可逐源重验；#79分支调度仍未实施。以上是实施自测，不能替代root和fresh最终head验收。

#78B的XLSX、正式接收持久化/重启、跨批幂等与文件替换失效仍未实现，#78保持未完成。共享STATE/NEXT-SESSION未改；没有真实资料/账套/凭据测试，没有常驻服务，没有DB/package/锁/全量入口变更。

下方是OFFLINE-00实施时点记录，保留其历史状态。

2026-10-24，OFFLINE-00 合同准备部分（Refs #76 / #77）。实际 base `4223ccb3ad2c1b71178f2a510ed1f196ff963f03`，branch `codex/huxiaoyang-code/offline-00-contract`。本片尚待管理者独立验证、全新上下文审查及 PR，不预报合并。

交付：9类文档的 v1 严格纯校验、16组分离的合成输入/工程期望、独立十进制/借贷/舍入测试。调用返回 validationOnly=true、authorizesExecution=false。模块不落库、不读文件、不加载黄金，不发消息。税务真实数值全部未知；确认和任务完成状态当前拒绝。

实施自测：工作目录 `06-workbench`，命令 `node test/offline-contracts.test.mjs`，最终34 / 34 通过，exit 0（包含独审指出的负借贷侧、无关历史证据替换、补件材料目录、options 错误边界四项回归）。未跑全量（新增纯模块未接线、不改依赖或共享文件）。测试只合成夹具与自动清理临时目录；没有真实资料/账套/凭据。

本轮唯一实施 subagent，禁再委派，用户授权覆盖旧本地执行器；管理者负责 Git/PR 和独审。无自有服务或常驻进程。

下一步 #78 可复用这套约束实现 CSV/XLSX/JSON 的显式字段映射、来源记录/归一化和局部重复冲突检测；应扩展逐笔银行/工资/资产等来源合同。不得读取 expectations 作为运行输入。不要将 candidate 科目/税额反向要求客户输入；历史迁移保持独立。

#77 仍未完：会计审定范围与至少12组真实分录/结转余额/税额黄金、官方2026规则完整条款与福建表式、合法连续申报期、真实业务试用。当前16组是工程合同/算术样例，未结转试算不是结账余额，7/100不是税率。#79/#80/#81/#82 依次落实规划、幂等记账、税务计算和真实版本确认；#49/#51/#54 继续按既有依赖协调。

完整说明、官方来源、现有模块复用与回退：[OFFLINE-CLOSELOOP](../OFFLINE-CLOSELOOP.md)。共享 STATE 与 NEXT-SESSION 未改，避免覆盖其他窗口。
