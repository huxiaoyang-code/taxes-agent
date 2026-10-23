# 离线闭环交接

## 2026-10-24 OFFLINE-04A / #81A 实施候选（待最终冻结独审与PR）

PR90实际已合：[PR90](https://github.com/huxiaoyang-code/youshu-fork/pull/90)，base `19e861a580ebffec0b5e14eafb41ca457f9de71e`，已审head `85eabbba1a8d92ce0101588919ddbaae33003655`，merge/main `9cd0176bb912c94b519fc40b155159d4ca5b81c7`。行政候选以completionDate确认日修复后的bookkeeping43/43、root验证及fresh接受事实以该已合版本为准；下方03A未验/42套及修前接受等均保留历史，不作为新候选接受。

本片基于PR90，branch `codex/huxiaoyang-code/offline-04-snapshot`，Refs #76/#80/#81。用户明确授权唯一当前模型实施subagent，未再委派、未使用pi/Claude/TokenHub或其他执行模型，无Git提交/推送/合并。只改六文件窗口（新增模块/CLI/测试/合同/任务单及本交接）；DB/accounting/import/bank/aux/audit/coordinator/batch/HTTP/MCP、package/test-all、STATE/NEXT-SESSION均未改。#54审计coordinator仍在另一窗口在途，正式写依赖未合，本片独立提供只读基础。

接口：`openReadonlyLedgerSource(explicitPath)` 返回模块私有品牌source，只公开close；`captureLedgerSnapshot(source,{enterpriseKey,accountSetId,fromPeriod,toPeriod})` 同事务从实际规范企业绑定、持久profile/账户/期初/期间、完整posted/draft凭证及分录、真实import来源/批次和可选audit/batch实例生成深冻结产物；`validateLedgerSnapshot(source,snapshot)` 重新读取scope比较current/stale。所有产物固定calculationReady=false/submittable=false/authorizesExecution=false，完整度/历史/原文件及经济事实真实性独立unverified。公开digest或导出JSON不能恢复WeakMap可信能力；clone、跨source、任意callerDB及关闭后均拒绝。完整合同见 [OFFLINE-LEDGER-SNAPSHOT](../OFFLINE-LEDGER-SNAPSHOT.md)，任务窗口见 [OFFLINE-04A](../tasks/OFFLINE-04A.md)。

CLI为 `node scripts/offline-ledger-snapshot.mjs --db <本机.db> --enterprise-key <key> --account-set-id <id> --from YYYY-MM --to YYYY-MM --output <NEW.json>`（cwd `06-workbench`）。显式readOnly开库、复用withReadSnapshot，不导入默认db、不迁移安装、不联网；output独占新建，只有该本机JSON含明细，stdout固定状态/计数，错误固定白名单，无路径/企业/金额/堆栈。未来税算必须同进程从source新捕获并重验，JSON只是diagnostic。

首版root独立probe已通过实际import439.27+4.39=443.66、posted借贷各44366分、22.87草稿分离、缺3月、clone拒绝、他企81.53不失效、新3月及反过账stale；source/db finally close。第一次probe因root未建忽略.agent-runs父目录ENOENT，未到产品执行；建目录后通过，非产品失败。该probe不是最终冻结验收。

实施自测历史按真实发生保留：首轮 `node test/offline-ledger-snapshot.test.mjs`18/21 exit1，binding-key夹具被现行FK拒绝、系统Temp下官方audit夹具backup_invalid、持连接文件rename EBUSY。保留规范FK约束，改用无来源空账套的合法更正；history故障修改后恢复原summary；将合成root改repo忽略.agent-runs、import前隔离WORKBENCH_DATA_DIR/TEMP/TMP后官方audit/batch安装通过。随后19/22、21/22仍exit1，剩Windows父目录rename EPERM。改为严格win32/errno分支，实查原dev/ino/birthtime及字节不变、原快照仍current，明确输出OS_BLOCKED而不声称实际换入已验。新增held库hardlink后23/24 exit1，沙箱内EPERM；root随后获授权沙箱外实际运行24/24 exit0，真实hardlink建立/nlink=2触发产品拒绝、移除后current、DB实际close。最终保留实际硬链断言，不skip、不把沙箱EPERM降为通过、不使用文件身份mock。

root/fresh预审修复：未知audit结构原先会把活实例压成unverified/null，现保留实际实例raw rows、schema状态和问题入摘要；batch独立实例及component元数据也保留，官方安装及audit absent时batch实例变更失效已验证。逐表读取来源证据，避免四表every导致缺一表时丢弃其他已知事实：原root真实副本DROP import_batch_vouchers后改source fingerprint仍current的问题已修，保留各表presence/缺项与实际来源/批次、缺关联unverified，新增第25项变更必须stale回归。完整来源四表正常路径保留原结果。

root在修来源后已获授权沙箱外实跑25/25 exit0；随后fresh发现非有限SQLite数字的JSON摘要碰撞P2：Infinity/-Infinity会同序列化为null。现于读事务内对全部实际快照数据递归拒绝任何非有限数字（包括非money列），捕获和重验报固定ledger_stored_number_invalid，不构造自定义serializer。第26项真实SQL回归保留±Infinity金额与可空非金额REAL字段/NULL变更，要求捕获/重验明确拒绝及finally恢复后current；负值/非法subcent原诊断未删。25项结果为修前历史，尚待root修后26项及最终head验证。

范围前历史按实际原始凭证保留，账户/期初/期间和profile变更均入重验；非法超过两位的实际存储金额不舍入，minor=null并给stored_money_invalid。entries按Map单遍分组。三个月缺项、空账、无来源、指纹失配均不能当零申报或已证实完整。所有开发/故障夹具均合成，失败自动保留、成功默认清理、KEEP_FIXTURES=1可保留，无真实账套/原件/凭据测试，无自有常驻服务。

必要影响回归（同cwd，未改旧断言）：实施 `node test/offline-bookkeeping.test.mjs`43/43 exit0，`node test/import-incremental.test.mjs`57/57 exit0（后者启动前TEMP/TMP设repo忽略.agent-runs）；未跑无关全量。`git diff --check`exit0。维护入口flow status由root在维护仓库实跑，仍仅旧human-pl SHA mismatch exit1，未读改历史原件，与本片无关。

尚待root最终26项定点验证、全新未实施者按最终完整head独审、PR/合并，不以实施结果或旧24/25项结果代替新冻结验收。#81税算、#80正式连续过账、#77会计审定黄金及#78持久接收/#79正式执行回执等均未完成；税局真实接入仍0。

## 2026-10-24 OFFLINE-03A候选（尚未root最终验收/PR）

最终冻结后返工事实：root已将前一候选形成**仅本地、未发布未PR**的`717e4fb`，当时实施42/42；root最终定点发现行政服务日期P2：票日2026-03-10、#78业务date及新completionDate均2026-03-20，仍产生date03-10的管理费用/应付450.81候选。fresh实际复现后撤回对该版本的接受；42套通过及旧接受不构成修后验收。现修复行政候选date为实际completionDate，productSupported日期门也按该实际确认日，recognition.dateSource留逐字段pointer/hash；销售同日及预付银行日保持对应来源。新增同月异日正例，保持三候选和金额断言，**修后实施`node test/offline-bookkeeping.test.mjs`43/43，exit0**，`git diff --check`通过。仅本片源/测试/文档/交接必要修改，无Git操作；等待root新完整head及重新独审。下方42/42及更早验收均为修前历史，不作为本次修后接受。

PR89 实际已合：base `a004bd889554c091318e5e017a93ec575581cf5e`，已审head `0f1b0d68f3a9be5cc047ef5a72a1d8e693e0507b`，merge `19e861a580ebffec0b5e14eafb41ca457f9de71e`。root独立规划45/45及Q1补件/银行独立digest/账户冲突通过；fresh规划45+材料36+合同34+银行16通过并接受。下方“02A未提交”均保留历史时点。

OFFLINE-03A / #80A 基于该merge，branch `codex/huxiaoyang-code/offline-03-candidates`，限定8文件窗口。本轮唯一当前模型实施subagent，无再委派/外部执行器，无Git提交/推送/合并。实现纯readiness/规则/候选模块及CLI；显式重验#78快照并重算#79，严格原始业务补充事实有实际字节hash及逐字段JSON pointer。三种实际候选：未结算普通主营服务销售、当月行政服务采购未付、期末未来服务合同预付。完整契约与官方来源见 [OFFLINE-BOOKKEEPING](../OFFLINE-BOOKKEEPING.md)，窗口见 [OFFLINE-03](../tasks/OFFLINE-03.md)。

销售在当前scope开始完成且开票/完成/取得收款权利同日，按2026增值税法28条（一）派生同日trigger，不索取客户计算纳税义务日。小规模身份和申报周期须基础声明中的会计依据；非零票税仅初始应交增值税，不是最终申报或免税收益。预付限期末未履约、单次、无退款、未来12个月内普通服务，借预付/贷银行，不提前费用；独立预付不因VAT身份缺失而停。采购只精确补足旧用途缺口，不覆盖已知资产/个人/受益期矛盾；银行新合同可补未知性质，不能覆盖已明确工资/资产性质。

预付款稳定key锚原始bankAccountId/refId，不含可更正合同/供应商；后两者变更标newVersion。同合同多流水或费用/未履约预付矛盾均阻断；不声称核验既存ledger。本地摘要比较不是认证或执行凭据。官方规则目录递归冻结，产物rule及entry.ruleSources为副本，修改首产物不会污染下一调用。

实施自测最终 `node test/offline-bookkeeping.test.mjs` **42/42，exit0**（cwd `06-workbench`）：真实临时CSV/JSON→#78CLI→本CLI产生三候选，独立销售1763.00+17.63=1780.63、行政采购450.81、预付286.47，借贷合计各2517.91；假设期初bank/capital各1000的3231.44只作工程独立试算，未使用产品余额引擎/黄金运行输入。覆盖具体缺项、税分支隔离、scope/非法金额/红字/复杂结算、重复与关系冲突、hash/BOM/映射重验、版本与规则来源、防派生状态、固定安全stdout及拒覆盖。所有CLI同步子进程signal=null/stderr空，没有常驻进程、真实资料/账套/凭据或DB/网络写。

失败/修复事实：首轮35/36，唯一失败为同sourceId冲突被#79隔离后旧候选误标withdrawn；保持原conflict断言，补已知来源冲突身份传递后36/36。fresh指出预付按合同/供应商key会把更正变新业务；改锚原始银行交易，新增更正sameKey/newVersion回归。原“同合同多付一个key”的初稿期望改为两个原始支付key，仍全部conflict且零预付候选。fresh再指规则浅freeze外溢，递归freeze+输出clone，新增首产物修改不污染后续回归后38/38。未删减旧业务拒绝或金额断言。

后续fresh指出关联票角色/供应商及原业务性质/用途/受益期未核对；补统一一致性质量门、反向/异供应商/货物与三类用途/不同已知受益期负例及合法服务正例后39/39。自查显式月份scope可跨会计年度，补同会计年度条件及回归后40/40。root要求三规则统一候选确认日仅2026，新增productSupportedFrom/Through并与legalSourceEffective分开，2010/2025/2027拒绝、2026首末日三类可用的参数化回归后41/41。必要影响套同cwd `node test/offline-plan.test.mjs` **45/45**、`node test/offline-materials.test.mjs` **36/36**、`node test/offline-contracts.test.mjs` **34/34**、`node test/bank-import.test.mjs` **16/16** 均exit0；随后仅新增本片日期门及回归/文档，未重跑无关全量。`git diff --check`通过。财税入口按要求运行的flow status仅报告历史human-pl SHA mismatch，未读取/修改原件，与本片无关。

root结构审查指出显式invoiceRef/bankRef为null/false/0因truthy检查误入缺项；改为字段存在即严格校验，新增六种非法引用及真正省略的区分回归，最终42/42。未扩窗口或删旧断言。

尚待root独立验证、fresh最终冻结审查及PR/合并，不能用实施自测替代。正式写账、连续过账及恢复依赖#54 coordinator与后续接线，本片只候选，全部authorizesExecution=false，不宣称已过账或整期完成。#77会计审定黄金、#78持久接收、#79正式执行回执、#80正式连续过账均未完成。没有STATE/NEXT-SESSION/package/test-all或核心共享路径修改。

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
