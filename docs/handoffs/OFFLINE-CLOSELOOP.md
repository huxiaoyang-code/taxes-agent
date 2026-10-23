# 离线闭环交接

## 2026-10-24 OFFLINE-04C late-cache P2 返工：独立 Node worker（当前候选）

下方PR99/04C首稿19项均是返工前历史，不能证明晚加载guard之前的模块缓存边界。fresh实际 `.agent-runs/reviewer-history/late-cache-probe.mjs`：复制树先import原tax，再将磁盘calculateOfflineVat改throw DISK_CODE_SENTINEL，最后首次import history/guard；首稿仍mint并把新磁盘SHA绑定旧4071.91结果。root确认P2后解除冻结并授权8→9文件（新增worker，#81 comment6376375135），未改旧28模块或缩小代码字节承诺。

root已无冲突fast-forward本WT至#54 [PR100](https://github.com/huxiaoyang-code/youshu-fork/pull/100)实际merge `e13cc43d9f95ee78599b288486ff5721b01f00e2`，#54 comment6376358168 / 协调comment6376400477；随后[PR101](https://github.com/huxiaoyang-code/youshu-fork/pull/101)仅13共享docs交接（head642426a）合入，当前实际base `f74460f30699c2740b2163743050b78845979885`，core/test及本9路径未变，未提交范围保留。#54旧待PR/未合记录均为历史，不再作为当前阻塞。本片仍待root最终完整head验收/独审/PR，不能以#54已合推断#81或连续税期完成。

现每次open新启动固定脚本的全新Node进程，父facade只严格schema、31实际bytes和WeakMap私有IPC；loader真实session/readonly DB/前后current/v1税算及内部digest全部在该worker持有。父spawn前实际清单、worker加载/开算清单、父spawn后清单必须一致；消费串行并前后父子复验。父已缓存tax不执行计算，late-cache磁盘throw由新worker实际执行后明确拒绝。新31=原REVIEW_CODE_FILES28+context/guard/worker；未接旧review确认链。NODE_OPTIONS/NODE_PATH/WORKBENCH_DATA_DIR不继承，stdio忽略，只私有固定IPC；不是模型执行器。

close现为async，CLI/tests均await实际退出；失败/退出/30秒timeout永久废原receipt并关闭源、不偷偷重启；父disconnect也使worker关闭退出。关闭有500ms graceful、500ms SIGTERM及必要SIGKILL兜底，await实际exit；spawn error无exit事件时由close事件完成，避免挂起。runtime仍只读，不新增DB/defaultdir/journal写或源路径权限。prior-only/targetBinding not_verified/Q2false/approval pending/执行与提交false/真实性unverified等完整限制保留。

新增9项运行时回归，在原19全部保留基础上为28项：父先cached tax→磁盘throw→cold首次history；spawn窗实际代码变化；parallel消费/在途async close及实际exit；实际worker SIGKILL永久失效；真实不存在Node.exe ENOENT；实际挂起worker的timeout/实际exit；parent disconnect后workerexit+DB可rename；真实fork与worker两类观察ABA后同父再open永久拒绝及新进程恢复对照。代码变化均在复制所需源码的ignored临时树，不改工作区产品文件或复制真实data/config/node_modules。实施timeout仅父测试timer加速；fresh另实际生产30秒30522ms后prior_worker_timeout永久失效、SIGTERM退出、awaitclose后DB实际rename释放，不能把加速测试称生产时长。

新worker初稿保持原19为19/19；新增6项后25/25、实际spawn ENOENT后26/26均exit0，所有child实际close。fresh另确认观察ABA P2（`.agent-runs/reviewer-history/latch.mjs`）：父baseline后spawn→改tax注释→worker ready真实不同manifest→父处理前恢复原bytes；第一次restart_required、第二次同父却mint，违反已观察变化永久失效。现assertBinding mismatch或worker返回prior_code_restart_required均调用guard的只闭锁mark，使父guard永久latch；不以“未观察ABA”限制遮掩实际已观察。新增两种实际变化/恢复回归，最终 **`node test/offline-vat-history-context.test.mjs` 28/28 exit0、skip0，所有child实际close**，`git diff --check`及5个模块/测试语法检查exit0，已停写供root/fresh最终独审。root新audit独立557983→16739.49/11159.66/5579.83、31code/公开篡改/clone/严格extra/getter0/观测stale永久、新open+awaitclose、hiddenextra与pathProxy0、写后publication exit4+failed均已报通过。root另e13新基线旧VAT22/golden15/ledger27均exit0（WB/.agent-runs/root-after-audit.log），f744同core字节，未无理由重跑；旧基线review15通过仍仅旧基线事实。原发布窗/hidden/late-cache/latch失败probe均保留，未预报最终接受。

## 2026-10-24 PR99 已合事实与 OFFLINE-04C 首稿历史候选（已被上方返工替代）

[PR99](https://github.com/huxiaoyang-code/youshu-fork/pull/99) 已合：base `11e47e6ce6e1fff724a3e158f9c98b48fcb8f6d3`、已审 head `ef9ac0e4568fe30176ccf80304ad916646bc6441`、merge `0e89a2d107fd75ff18dc0998e89d96c3217baeb3`。交付 #78 comment6376059950 / #76 comment6376060428 / #54 comment6376060840；三方银行27，旧invoice19/store32/action33/golden15通过，P2数值币号/千分选项绕过已闭合，真实失败26/1保留。下方01D未合等为历史时点。

#54 最新实质 comment6376168302：旧完整65文件候选 `29f76f2479425a8f192f13cf1c11dd318ce63138` 已独审接受；main前移后整合到 `cef967e2d31f289c5e918bbb87a32afc09df0805`，原65文件bytes不变，13docs/5上游套补验中，最终精确head仍待reviewer/PR/合。root #54 comment6376209790 协调本片先基于0e89实施验证，待其实际合后再整合main与必要影响验证；不以旧R5窄修接受或旧完整head接受代替新head正式放行。

OFFLINE-04C / Refs #76/#81，认领 #81 comment6376161802，base为上述PR99 merge，worktree offline-04c-history。本轮唯一当前模型实施 Codex subagent，无再委派、pi/Claude/TokenHub/其它模型、Git写或全局配置；未读真实/历史资料。精确8文件见 [任务单](../tasks/OFFLINE-04C.md)，契约/命令/失败与回退见 [OFFLINE-VAT-HISTORY](../OFFLINE-VAT-HISTORY.md)。所有旧VAT规则/loader/ledger/review/feedback/28清单/core/audit/batch/oldtests/golden/包锁/test-all/STATE/NEXT/#54共享路径均未改。

新API只接严格显式priorInputPath，内部真实openVatInputFiles→前后assertVatInputSessionCurrent→重新calculateOfflineVat；v1可算且current、2026Jan新设/Jan起账的Q1才铸WeakMap私有receipt并保留内部session。consume每次重读文件/store/真实只读DB、重算并比较原摘要，公开副本/clone/跨进程/伪receipt不能授权；观察stale或close后永久失效、关闭source，恢复旧bytes也须新open。代码guard加载时固定原28清单+新2module共30实际bytes，缓存代码变化需新进程，未改旧review确认链。CLI actual request/new wx，write+sync后最后重验request与内部receipt，失败保留明确failed诊断。API无journal/DB/defaultdir写。

prior-only边界始终targetBinding=not_verified、q2CalculationReady=false、accountantApproval=pending、periodComplete/submittable/authorizesExecution=false、sourceAuthenticity=unverified；limitations先列prior_Q1_only/no_target_database_binding/no_Q2_tax_calculation/no_reusable_accountant_confirmation。公开snapshot无fd/fileidentity，未把两个公开摘要当同实际目标库；Q2完整引擎及#82接线仍后续，本片不承诺未接线的Q2确认自动失效。未认证材料/会计真实身份、不检测未观察ABA、不把低门槛/零销项/历史/缺件假零。

实施新套（cwd06-workbench）`node test/offline-vat-history-context.test.mjs` **19/19 exit0**。实际raw合成173211.00+238456.00=411667.00→现有候选/core importer实际过账→只读核15=12350.01/16=8233.34/22=4116.67、SHA/cell/真实voucher-entry/source/rule链。helper在core import前隔离数据/TEMP/TMP，用独立child避免全局DB缓存串例；所有child实际close。strict/getter0/Proxy、伪receipt/clone/crossprocess/close/public篡改、原件缺失/更正/恢复、store origin+真实sourceVersion CAS、false/null/unknown/历史/错scope、核心实际unpost/entry及sourcefingerprint变化、Q2截止外实际voucher、main+warmWAL byte不变、复制源码树codecached变化/新进程、actualCLI/wx/hardlink及写后source/request变化均通过。Windows held DB rename=EPERM实际阻止替换，明确未测到替换检测分支；冷readonly可能零字节WAL，不夸文件零侧效。

失败事实：首轮13/15是测试误把store API当journalHead CAS及沙箱拒symlink；修为实际supersedes/expectedSourceVersion CAS和hardlink后第二轮15/16仅沙箱hardlink EPERM。失败夹具保留，新套经获准创建临时链接的命令真实18/18、skip0。root独立首稿非零557983/16739.49/11159.66/5579.83、来源/30code/opaque/getter0/stale恢复验证已报通过；root另实际发现CLI发布窗P2（写完output、sync前改sales仍exit0旧computed），已加真实最后publication check与source/request两种子进程注入，原root失败probe未改。其后root/fresh实际复现18项覆盖缺口：hidden calculation额外字段仍mint、非法嵌套path/version Proxy递归前触发trap；已先查top isProxy/Reflect.ownKeys/own descriptors并确认恰好两个enumerable data及primitive strings，再运行旧fields/requirePlainJson，新增hidden data/getter/symbol/version+pathProxy计数0第19项。修后新套19/19。自查代码清单改codeBinding防覆盖固定code，拒绝诊断code断言保留。实施自测不代替root原probe修后复验和fresh最终head独审。

必要影响旧VAT22/review15/golden15均exit0，所有DB/source实际close；`git diff --check`通过，未运行无关全量。维护仓库flow status仍仅原human-pl SHA mismatch，未读改历史原件。本片尚未root最终验收、全新独审、PR/合；#81整包/#76/两合法税期仍未完成，税局真实接入0。

## 2026-10-24 PR98 已合事实与 OFFLINE-01D 受限银行 XLSX 实施冻结候选

[PR98](https://github.com/huxiaoyang-code/youshu-fork/pull/98) 已合：base `98e57bdfbe29e2f8716ab0768492583064cd30c1`、已审 head `a331b21abd72b94147742fd7e96fed0849e10cb6`、merge `11e47e6ce6e1fff724a3e158f9c98b48fcb8f6d3`。交付 #77 comment6375751257 / #76 comment6375751712 / #85 comment6375752159 / #80 comment6375752731；三方黄金15及旧候选43/行动规划33/VAT22通过，12组业务/24张凭证/36份月末快照已独立验算。下方00B“候选/待验”等为历史时点。#54 最新 comment6375884790（2026-10-23T22:20:35Z）：R5 两文件窄修已独立接受并提交 `d1d618b5d19f31a877f94407ffcfcf10f518af15`；正进行13份文档收口，上游受影响测试运行中。完整最终候选仍待 fresh/PR/merge，正式写依赖未放行；远端 main 仍 `11e47e6`，不以旧 `87043a` 待审记录作当前接受事实。

本片 OFFLINE-01D / Refs #76/#78，基于上述 merge，认领 #78 comment6375851534，工作区 offline-01d-bank-xlsx。唯一继承当前模型的实施 Codex subagent，用户明确覆盖旧外部执行器限制；无 pi/Claude/TokenHub/外部模型、再委派、全局配置或 Git 写。root 负责独立验收、全新未实施者审查及 Git/PR。精确八文件：四 server（offline-invoice-xlsx/material-adapters/materials/material-completeness）、新 test/offline-bank-xlsx.test.mjs、OFFLINE-XLSX 合同、新 OFFLINE-01D 任务及 own 本交接。未改旧测试、会计/税务规则、DB/store/CLI/package/lock/test-all/STATE/NEXT 与 #54 核心66路径；未加载真实或历史资料。

实现同一私有受限 readMappedXlsx，发票固定 net/tax/gross、银行固定 amount/balance 数值权限，用户 mapping 不能声明任意 numericKeys。bank-xlsx-v1 仅在原银行 amount_direction 显式归属/账户/日期/方向/负号/CNY/可选文本千分位及货币符号上增加 sheet/headerRow。OOXML 数值只 General/0/0.00；日期/流水号/方向/币种/摘要全text。复用 normalizeMapping/normalizeBankRow、经济语义/稳定身份与全部旧 ZIP/XML/关系/part/公式含cache/类型/限额拒绝。bank parsedInput 使用原 sheet/row/逐字段A1/column；CSV 原位置和语义保留，MATERIAL_VERSION 未变。

两 XLSX 都由统一 sourceText/sourceBytes 用 canonical base64 作JSON运输、SHA绑定实际二进制；银行 kind 纳入 missingKinds 银行槽与逐账户覆盖。既有 CLI/store 未改源码，但新套真实读取文件、wx生成报告、原件hash不变、actual receive blob字节等于XLSX、child重启inspect/replay、receipt/origin追溯及CAS更正已实验。原件变化不借旧报告继续准备，历史blob保留。openOfflineActionInput / buildOfflineActionPlanFromFiles 实读银行XLSX→银行覆盖provided_valid→现有未来服务预付候选；完整有效事实不重复索取，缺refund只问相应事实，坏银行/账户矛盾/跨企业/缺文件或变化只阻断相关分支，独立有效销售保留。无本片正式写账、DB、联网或客户联系，所有 authorizesExecution/periodComplete/completed=false。

修前实施自测（cwd06-workbench）：`node test/offline-bank-xlsx.test.mjs` **25/25 exit0**；共享parser必要旧 `node test/offline-xlsx.test.mjs` **19/19 exit0**，`node test/offline-bookkeeping.test.mjs` **43/43 exit0、skip0**。新套首次23/23通过，后追加非法方向/币种/零金额与非连续第12行定位两项为25/25；这25项未覆盖下述独审P2，不能作为修后最终接受。独立合成预付684.23/余额-315.77，销售净914.37+税9.14=923.51，更正预付685.27/余额-316.81；literal期望仅在测试，不作为产品输入。实际ExcelJS bytes、中文sheet/header3/长前导零ref、shared/inline/text/numeric、B4/E4及B12/D12、跨格式单候选/差额conflict、所有格式/归属/范围/安全拒绝、公开report篡改重读、固定stdout/stderr、实际store与action文件模式均有断言。CLI子进程signal=null、stderr空，无自有常驻进程；成功合成夹具默认清理，失败或KEEP_FIXTURES=1保留.agent-runs。

root另报告已完成核心初稿独立实证：自选银行1743.29/余额58256.71/B4→三候选及银行provided_valid、CSV同身份/语义duplicate与差额conflict、actualCLI fixedstdout/wx、actualstore原blob/replay与来源变化stale；旧invoice19/store32（Windows链接实建、skip0）/action33/golden15均exit0，日志在06-workbench/.agent-runs/root-*.log。此处仅按root报告登记，未读取其输入来确定实施预期；最终完整HEAD冻结和fresh独审仍待root，不提前声称接受/PR/合并。其后共享reader发生下述P2修复，必须按修后完整HEAD重新验收。

独审确认P2并暂停发布：`.agent-runs/review-numeric-lexical-01d.mjs` 证明 type=n 的 `<v>￥2,849.63</v>` / `2,849.63` / `2 849.63` 在银行 allowCurrencySymbol/thousandsSeparator 选项下会被当作文本重新解释并接受2849.63；原25套和早期探针通过不覆盖该缺口。实施先追加真实XML amount/balance负例及实际text/CSV正例，在原核心实跑 **26通过/1失败**，日志 `.agent-runs/implementation-bank-p2-before.log` 与合成失败目录 `bank-xlsx-synthetic-FZ1y7x` 保留；独审原probe未改。

修复只在固定 readBankXlsx 包装的私有 reader 路径启用 strictNumericLexical：数值单元格原字符串必须 trim 后完全相等，且是可选负号、规范整数、可选1~2位小数；amount和balance均先拒币号/分组/科学/空白含LF/CRLF/tab/加号/缺整数或小数/前导零，固定错误xlsx_cell_invalid。原readInvoiceXlsx路径不启用新检查，保留旧发票错误和词法语义；不修改通用bank normalization，实际文本的货币符号/逗号/空格分组仍按明确选项接受，与CSV同docId/semanticDigest。新增两测试后 **修后实施 `node test/offline-bank-xlsx.test.mjs` 27/27 exit0**，必要旧 **`node test/offline-xlsx.test.mjs` 19/19 exit0**；未改旧测试或放宽断言。最终完整HEAD root必要重验及fresh复审仍待，不能用修前25或早期独审接受代替。

维护入口已运行 `python tools/flow.py status`（维护仓库内），仍仅旧 rujin-202608-human-pl SHA mismatch/exit1，与本片无关，未读改原件。合同及回退见 [OFFLINE-XLSX](../OFFLINE-XLSX.md) 与 [OFFLINE-01D](../tasks/OFFLINE-01D.md)。#78整包/#76总项、#54正式写账接线、会计生产审定、真实试用及其他闭环仍未完成，税局真实接入0。当前为实施冻结候选，等待root最终验收与全新未实施者独审。

## 2026-10-24 PR97 已合事实与 #54 当前依赖状态

PR97已实际合并：[PR97](https://github.com/huxiaoyang-code/youshu-fork/pull/97)，base `2414c512e6ec0cd58e94a6d9a6895b2ddbb50944`，已审head `8d79547e0c06316f1f94b350fba6454934d71140`，merge/main `98e57bdfbe29e2f8716ab0768492583064cd30c1`。#79 comment6375420406 / #76 comment6375425702交付；实施/root/fresh三方action-plan33及旧plan45/bookkeeping43通过。下方02B“候选/待PR”均保留历史时点，以本段已合事实为准。

#54最新已读实质更新为comment6375303767：修复整合`58e072`待独审；只读调查工作区实际HEAD `87043a11b626a048e65e81931543be8dc3df2a3e`，尚未合入main。下方comment6374950499等旧拒绝均为历史事实，不能当最新候选状态。OFFLINE-00B仅使用现有域API测试adapter，仍不代表#54正式写账接线。

## 2026-10-24 OFFLINE-00B 独立业务黄金实施冻结候选（尚未root最终验收/独审/PR）

Refs #76 / #77 / #85，base `98e57bdfbe29e2f8716ab0768492583064cd30c1`，工作区 `offline-00b-business-golden`。本轮唯一当前模型实施subagent，用户明确覆盖外部执行器限制；没有pi/Claude/TokenHub、再委派、Git/PR或全局配置操作。初始窗口仅新raw/expected、新reference/helper测试、业务说明/任务和本own交接；实际黄金发现产品缺陷后root在#77 comment6375643868/#80 comment6375644345窄扩 `06-workbench/server/offline-bookkeeping.mjs` 唯一benefit月份门。未改旧test/旧16fixtures/其余server/package/lock/test-all/STATE/NEXT及#54核心66路径。

交付12组独立合成业务（不是原6+6故障变体），raw为实际CSV/XLSX/businessJSON及原始声明，literal expected先于产品运行冻结：每笔全部分录、业务identity、原件SHA/具体line或cell、会计事实pointer、规则与文字推导、Jan/Feb/Mar逐科目和总额及selected VAT。root已独立按raw及Python Decimal核完12全部分录、36个月快照、所选税字段和来源SHA，无金额差异（不读取实施预算算法）。运行函数只接raw目录，每例新子进程/隔离DB且scope原bytes不改，核心import前设WORKBENCH_DATA_DIR/TEMP/TMP。产品自动候选经现有importIncremental测试专用adapter进入真实账，再用A.trialBalance和私有真实snapshot/calculateOfflineVat验收，无客户预制分录、权限/审计/快照伪造。

trialBalance opening为初始期初、period为从start_period累计；expected明确initialOpening/cumulativeMovements/monthlyMovements/closing，测试通过相邻累计差核当月。全部未结账/未结转，不冒充正式结转或两合法连续税期。G09/11/12按实际历史银行/资本事实显式setOpeningBalances，声明balances_required/prior_required；申报blocked/null，G12即使收入超过30万也不填伪零。G07/08/10低门槛/无销项unsupported/null，初始账载17.63不当最终税申报。accountantStatus一律pending，税局真实接入仍0。

首次实际新套12/14、追加小数净额控制后13/15，均exit1（10/12业务通过）：G04/G06票Jan而完成/全部受益Feb，被产品line91旧r.date月份错误拒绝。先保黄金报告root，获上述唯一窄授权后以completionDate月比较，不改黄金金额/date；保留缺项、跨度、原事实冲突、scope/year及销售同日时点门。新增G04六种边界实拒且独立销售保留；G05真receive并新进程inspect reopen、同票跨格式一候选与每笔真实voucher/entry/raw/rule关联通过。

修后 `node test/offline-business-golden.test.mjs` **15/15、exit0（12/12独立业务）**。相关只读旧套 `node test/offline-bookkeeping.test.mjs` **43/43**、`node test/offline-action-plan.test.mjs` **33/33**、`node test/offline-vat.test.mjs` **22/22**均exit0（cwd06-workbench）。新增控制含原件更正、红票拒、小数净额unsupported、缺件/更正newVersion、反过账stale、clone/跨企/跨期拒绝、expected poison对产品零影响；控制不计12业务数。每子进程session/source/DB finally actualclose，无常驻服务或真实资料。失败合成目录保留.agent-runs，成功默认清理。未跑全量。

尚待root最终冻结自测、全新未实施者独审及Git/PR。#54正式coordinator接线不属于测试adapter，#77会计生产审定、#85试用及OFFLINE整链未完成，不关闭这些总项。详见[业务说明](../OFFLINE-BUSINESS-GOLDEN.md)与[任务](../tasks/OFFLINE-00B.md)。

root随后实际独立验证：新套15/15（KEEP_FIXTURES=1）及旧bookkeeping43/action33/VAT22均exit0、skip0；独立Python Decimal按raw复核12逐笔、36份月末快照、选定税字段及实际SHA全部PASS。额外新输入S469271+行政617.29（Feb完成），真实域API过账后核到税行15=14078.13、16=9385.42、22=4692.71及March未结账trial各侧474581.00，原件SHA实核PASS；证据在ignored `manager-new-amount-acceptance.json`。独立完成月探针确认正确完成月通过，发票月/跨月/出scope/2027拒绝，null由schema拒绝。root早期探针的URL编码/参数投影及同facts文件hash影响销售contentVersion的过严全对象相等均已更正，仅属探针设置错误，不记作产品缺陷。仍待fresh最终独审及root最终head/Git/PR，不作会计生产审定。

## 2026-10-24 PR96 已合事实与 OFFLINE-02B / #79B 实施冻结候选

PR96已实际合并：[PR96](https://github.com/huxiaoyang-code/youshu-fork/pull/96)，base `35bd8e53c703cdafa5989ba0df8e35fb7924e258`，已审head `dd89fc6fc8c1df18ef0069282094a965e8b6dcb3`，merge/main `2414c512e6ec0cd58e94a6d9a6895b2ddbb50944`。实施/root/fresh反馈20/20，root旧review15/VAT22均exit0；fresh接受，无P1/P2。root独立S499838→14995.14/9996.76/4998.38，fresh714760→21442.80/14295.20/7147.60。冷readonly首次可生成0字节WAL，预热后DB/WAL不变，无业务帧写。交付 #82 issuecomment6374939293 / #76 issuecomment6374943801。#82正式账更正、生产审定仍未完成，整项保持OPEN；下方05B“候选/未合”均为历史时点。

最新正式写依赖：#54 issuecomment6374950499（2026-10-23T21:19:34Z），head `81f404e465d052547d8913b1db1e066520769048` 因独审getter跨scope P2暂停发布/合并；在原66路径权限内仅bank-reconciliation、auxiliary-accounting、local-audit-coordinator、test/local-audit-domain四路径窄修。main仍2414，无新PR；root不接其实现，正式写仍blocked。以下旧6374636679协调记录保留为历史，不覆盖本条最新状态。

本片OFFLINE-02B基于PR96 merge，branch `codex/huxiaoyang-code/offline-02b-action-plan`，Refs #76/#79，认领#79 issuecomment6374952382。唯一继承模型实施subagent，用户授权覆盖旧本地执行方式；无再委派、pi/Claude/TokenHub/其它执行器、Git写或全局配置。精确7文件：新增06-workbench/server/offline-action-input.mjs、server/offline-action-plan.mjs、scripts/offline-action-plan.mjs、test/offline-action-plan.test.mjs，新增docs/OFFLINE-ACTION-PLAN.md、docs/tasks/OFFLINE-02B.md，仅修改本交接。旧planner/readiness/candidates/store/VAT/review及旧测试、核心/DB/accounting/import/audit/batch/HTTP/MCP/package/test-all/STATE/NEXT均未改。#54另一窗口66路径仍未合（协调6374636679、base35bd8e5，root50点修复后fresh/PR仍待），本片不正式写账或绕过审计。

实现与DTO/API见[OFFLINE-ACTION-PLAN](../OFFLINE-ACTION-PLAN.md)，窗口见[OFFLINE-02B](../tasks/OFFLINE-02B.md)。逐源实际readLocalFile/sourceText/preflight，原件清单与receipt store二选一，无DB/默认库/网络；纯façade复用assessCompleteness/planOffline/buildOfflineCandidates，不重复会计/税额规则。材料矩阵完整trace与原评估保留；只有全gate当前通过的特定用途/性质unknown才收敛为已提供。未来采购关联票只作预付证据，采用该支付的当前具体缺项，不索取行政完成日。每业务语义dependencyDigest显式选择实际记录、同factId/合同竞争/多付/反向关联、局部来源故障、账户/无业务及实际引用声明依据，不拿整文件candidate.contentVersion当局部键。完整出处含原件路径/hash、配置/声明/事实读入定位及receipt，文件模式从私有WeakMap取clone，不消费公开inventory；纯字节模式明确不代表磁盘当前。

所有任务authorizesExecution/periodComplete/completed=false，ready仅candidate_preparation_ready；post/close链待正式接线。compute_tax/review是本准备façade尚未集成/缺账务依赖（implementationScope=this_preparation_facade_only），既有#81窄VAT与#82底稿/反馈API能力保留，不宣称全产品均未实现。客户补件按业务字段覆盖与企业共享门合并，保全部原因/引用/影响任务；未知问真实情况，已知false/general等明确unsupported，不诱导更改实际事实。锁只操作者诊断，不能把技术依赖当客户补件。

最终实施自测（cwd `06-workbench`）`node test/offline-action-plan.test.mjs` **33/33 exit0**；必要旧 `node test/offline-plan.test.mjs` **45/45 exit0**、`node test/offline-bookkeeping.test.mjs` **43/43 exit0**，未改旧断言/未跑full/npm test。独立三金额净2917.00+税29.17=2946.17、行政590.19、预付337.83；真实CSV/JSON/XLSX二进制与sheet/cell、receipt store stale/锁/损坏、逐源坏映射/跨企/缺文件、同CSV改单票/重排、facts改单笔/反序、任务增删、税/期初/覆盖隔离、同factId/合同多付/反向关联/工资资产、共享补件count及DAG ready无阻塞父、wx/固定stdout/stderr均实际断言。夹具全部保留在06-workbench/.agent-runs/action-plan-synthetic-*，实际CLI child signal=null/stderr空，无自己的常驻进程、真实资料/凭据或DB/网络测试。

原始失败/修复如实保留：root原沙箱npm ci exit1/Exit handler never called，随后同WT获授权离线缓存 `npm ci --offline --ignore-scripts --no-audit --no-fund` 212packages/exit0；实施未重复安装。首轮新套20/20通过不覆盖独立预审发现：root缺文件出现旧session仍通过；fresh替换公开rawInput及交替getter可让FromFiles消费伪scope；root原始nature unknown误分missing、同一benefitBasis/共享tax重复请求、profile缺失时ready带blocked父；fresh同源坏采购可被relatedReady清问题、关联未履约票误索行政完成事实。修为负面读取状态+重读/store失败重inspect、WeakMap私有payload且descriptor拒getter、真实原始/补充字段分型、语义补件合并、独立上下文节点去不必要父、关联自身/支付门不可吞坏源。后续25/26/28/29/31/32均为各次历史通过，最终修后33新增真实回归并保旧断言，没有删除失败事实或skip。

root动态独立 `.agent-runs/manager-action-probe.mjs` 已PASS（索引manager-action-acceptance.json）：独立8319.37/739.61/193.27、零过时请求、缺benefitBasis只1/补回0、共享tax只1预付保留、反序业务digest稳、同合同矛盾、getter reads0、缺文件出现拒旧session、实际CLI拒覆盖/原件hash不变且未创建WORKBENCH_DATA_DIR。该动态probe不是最终冻结接受；本片仍待root最终33项/定点、全新未实施者按最终完整HEAD独审及PR/合并，不自称PR完成，不关闭#79/#76。#77会计审定黄金、正式连续过账/既存账更正、生产试用及#83恢复等仍未完成，税局真实接入仍0。

root冻结后最终验收已实际通过：cwd06-workbench，新 `node test/offline-action-plan.test.mjs` **33/33 exit0**（session46817实际结束）；旧plan **45/45**、bookkeeping **43/43** 均exit0，日志在06-workbench/.agent-runs/root-*-regression.log。综合manager-action-probe.mjs冻结后PASS exit0（manager-action-acceptance.json）；manager-same-source-probe.mjs冻结后PASS exit0（manager-same-source-acceptance.json）：同CSV两销售共4候选，第一8319.37→8329.47仅其task语义摘要变，第二1134.23、行政和预付不变，完整来源SHA刷新；private inventory的实际path/hash一致，公开inventory改空不影响，纯字节/文件模式明确。这是root最终冻结实证，不替代完整HEAD fresh独审；fresh、PR及合并仍待。本次仅合同/任务/本交接补事实，产品与测试未再改。此前git diff --check只覆盖tracked差异；另有全部7文件逐文件空白检查，未声称untracked已经cached check。

## 2026-10-24 PR95 已合事实与 OFFLINE-05B / #82B 本机反馈版本登记候选

PR95 已实际合并：[PR95](https://github.com/huxiaoyang-code/youshu-fork/pull/95)，base `6465a00e415c47d720d499e59faf233afd36708f`，已审 head `f523a2abefa8395081ff0609272487ad427105c6`，merge/main `35bd8e53c703cdafa5989ba0df8e35fb7924e258`。root/fresh 新 review **15/15 exit0**，旧 VAT **22/22**、XLSX **19/19** 通过；fresh 接受，无确认 P1/P2。root 独立 S499838→14995.14/9996.76/4998.38，fresh 独立 S419714→12591.42/8394.28/4197.14；七表100字段/trace/manifest/sourceSHA、DB/WAL零写及篡改失效通过。交付 #82 issuecomment6374295738 / #76 issuecomment6374296459。下方05A“候选/未PR”等保留历史时点，不覆盖本条已合事实。

本片 OFFLINE-05B 基于该 merge，branch `codex/huxiaoyang-code/offline-05b-feedback`，Refs #76/#82，认领 #82 issuecomment6374328794。唯一继承模型实施 Codex subagent；用户授权覆盖旧执行方式，无再委派、pi/Claude/TokenHub/其它执行器、模型配置或 Git 写操作。精确七文件窗口，root 管理独立验证、全新未实施者审查、Git/PR。#54 最新66路径在途、实施已停止但尚未独立审查/PR/合并；本片不改其核心/DB/import/audit/batch/HTTP/MCP、package/test-all/STATE/NEXT 或旧loader/review/税算/材料。维护入口由root实际执行，仅旧human-pl SHA mismatch，与本包无关，不读改原件。

实际实现为专用本机 scope store、不可变 receipt 摘要链及 wx writer锁。链尾就是CAS journalHead与当前版本的权威指针，不另造业务DB/可变head。register只能fresh原始配置→私有loader→review→自有pending JSON/七表XLSX/最后manifest，不能导入上传的ready/bundle/最终税额。逐版绑定原始inputPath、完整计算元数据、28个参与本链的本地模块实际字节、JSON规范化实际文件inventory和自有artifact实hash；重开全量核所有历史包/manifest/journal。满2000 receipt拒新追加且不生成2001/新artifact，仍允许query及完全同ID重放。未知锁/partial receipt/损坏failclosed，不自动删锁或旧包；未提交产物保留诊断，#83恢复仍未实现。

反馈固定schema与字段白名单，支持原始事实补件、驳回、选定computed服务字段确认；actor姓名/角色仅是本机操作者声明，不认证身份/签名。当前字段确认必须原始来源/真实账/当前规则fresh一致、calculationReady且无税算异常；每次inspect/反馈、提交前和提交后都实际再读。receipt提交窗变更保留反馈为历史，返回stale/effective=false；同ID重放也重新判断，不能把旧确认当当前。新版本显式supersedes/CAS，逐字段状态/金额差异区分null/0/NA，旧包/反馈不修改且不继承确认。reviewState区分待复核/补件/驳回/更正待复核/选定确认/失效；feedbackEffectiveConfirmation明确此次ID是否有效。原草稿一直pending，periodComplete/submittable/authorizesExecution=false，真实性unverified。

合同/CLI/退出码及有限代码清单见 [OFFLINE-REVIEW-FEEDBACK](../OFFLINE-REVIEW-FEEDBACK.md)，任务窗口 [OFFLINE-05B](../tasks/OFFLINE-05B.md)。CLI所有动作必须指定store外NEW结果文件，副作用前canonical parent/精确路径边界核验并wx预留，路径/企业/金额/理由只入该本机文件；stdout固定计数、错误固定码。无网络、消息发送、默认账库或业务写入。代码变化使用保守stale/拒写并要求新进程重算；不做热加载或第三方运行时/依赖认证。

实施自测最终（cwd `06-workbench`）：`node test/accountant-review-feedback.test.mjs` **20/20 exit0**，无skip，合成夹具 `06-workbench/.agent-runs/feedback-synthetic-5TPMLR` 全部保留。实际receipt materialStore整链、child重启同ID、并发writer、历史artifact/manifest/journal损坏、输入/真实账/规则及非税loader字节变、提交窗改源、真实2000合法receipt容量门、内部output/..prefix路径和NEW输出拒覆盖均通过；DB/source finally实际close、child实际close/signal=null，无自有常驻服务。首轮 **15/15 exit0**（`DaEfG2`）、定点后 **17/17 exit0**（`bYKwJO`）、store inventory修后 **18/18 exit0**（`KQNKNB`）是各自历史，不替代最终20项。必要旧 `node test/accountant-review.test.mjs` **15/15 exit0**、DB/source/child实际close；root另已实跑旧review15/VAT22 exit0，不重复full/npm test。产品四文件在最终20项运行期间未再修改；此后仅三文档收尾。全新未实施者接受及PR/合并仍待完成。

root修后已实际完成最终独立验证：同cwd `node test/accountant-review-feedback.test.mjs` **20/20 exit0**，夹具 `06-workbench/.agent-runs/feedback-synthetic-egcsfU`，DB/child实际close；旧review **15/15**、VAT **22/22** exit0。独立 `.agent-runs/manager-feedback-probe.mjs` **PASS exit0**，原始S499838→14995.14/9996.76/4998.38，confirm→request撤销→reconfirm，ordinary→special v2 blocked，恢复v3虽同bundleDigest但version不同不继承确认；旧ID历史、冲突ID、跨企、child重启、旧包及DB/WAL字节不变均通过。验收索引 `.agent-runs/manager-feedback-acceptance.json`。这是root实际独立结果，不预报fresh审查；fresh仍待最终HEAD。此后只在合同/任务/本交接补录root事实及持久撤销说明，产品/测试不变，七授权路径再次冻结停止写。

失败历史保留：首次生成新测试helper的Python命令因PowerShell引号语法失败exit1，未写测试/未触产品，改here-string后成功。root指出private inventory optional originStatus=undefined与manifest JSON省略不一致，实施者用首轮保留case-1真实materialStore实际复现register **exit1/review_artifact_binding_invalid**；`probe-material-store`、`probe-review-store`及未提交artifact保留。修为仅对inventory做JSON规范化后hash，null/0/false保留，并新增真实store注册/确认/child/来源变stale回归。root另实际复现只绑定税模块时改复制loader字节仍effective/current；已将实际依赖28本地模块明确绑定，新增live改loader拒确认/拒登记及重启后旧binding失效。root实际构造2000合法链后第2001先写入再自拒整store（`.agent-runs/review05b-preflight-code/capacity.mjs`/`capacity-store`），已在append最早及register产物前加容量门。root亦实际 `--output <store>/..root-dotdot-output.json` exit0且created/effective1，因startsWith('..')误判；已改相对路径首component精确判断，新增内部..local/..input拒绝及同级..legitimate允许。上述为修前真实失败，不删夹具/历史、不修改旧断言或skip。

本片测试为落盘合成 CSV/JSON（含实际#78B receipt store）及临时账库，自动候选经既有核心测试适配实际过账；独立S433631→13008.93/8672.62/4336.31，分类原事实special错误→reject→用户新tax/input文件→新版本S397531→3975.31及null→computed/0差异→新字段确认，实际同源只有1张凭证。没有手改来源指纹或删除原记录，没有自动改原事实或既存账更正。真实会计审定、生产黄金、试用、正式持续写账/既存账更正、其余税种及#83恢复仍未完成；#76/#82整体保持OPEN，税局真实接入0。本包root实际独立验证见上段，fresh仍待最终HEAD，尚无fresh接受/PR/合并。

精确fresh语义：inspect不写观察日志；尚未登记新版本且没有后续撤销反馈时，完全恢复原文件/账/代码绑定可使当前原版本确认重新有效（新套实际断言）。request/reject通过不可变反馈持久撤销先前确认，重启/恢复绑定也须新confirm才能有效。已显式supersede的旧版本永不继承为新版本确认，即使计算摘要后来恢复相同；不宣称观察到一次变化即永久作废。双方已确认该精确比较语义，不将其列为P2，也不扩充查询写日志。

root暂存七文件后实际 cached diff --check 发现新测试末尾额外空行（当时行293，new blank line at EOF）；此前未暂存的 git diff --check 未检查untracked新文件，不能称七文件完整空白检查通过。root已形成本地未发布 f6141d4e74730f633bddc13ef49da772940b3bab，不作最终接受。此次仅删除新测试EOF多余空白、保留单换行并补任务/交接；断言、测试逻辑及产品代码不变，按root要求不重跑20项。等待root重新cached check/amend及新最终HEAD fresh审查，实施再次冻结。

## 2026-10-24 PR94 已合事实与 OFFLINE-05A / #82A 当前实施候选

PR94 已实际合并：[PR94](https://github.com/huxiaoyang-code/youshu-fork/pull/94)，base `e564ce3dbcc2a84a4fc558c4a318c88637ced5e1`，已审 head `9c3dcb4049e65f7d32c88f189b0f72896edf459a`，merge/main `6465a00e415c47d720d499e59faf233afd36708f`。root 与 fresh 新 XLSX **19/19**，六旧影响 **36/45/43/32/22/26** 均 exit0；fresh 接受，无确认 P1/P2。root 独立1673.29+16.73=1690.02、640.57+6.41=646.98及原件改1690.03/CAS/重开；fresh 独立2371.49+23.71=2395.20、bank49.37，原hash/store/规划候选通过。交付回执 #78 issuecomment6373834923 / #76 issuecomment6373835425。#78 更广格式/搬迁、会计审定及真实试用未完成。下方01C“未验收/未PR”保留历史时点，不覆盖此条已合事实。

本片 OFFLINE-05A 基于上述 merge，branch `codex/huxiaoyang-code/offline-05a-review`，Refs #76/#82；认领 #82 issuecomment6373859336，#81协调6373859906。唯一当前继承模型实施 Codex subagent，用户授权覆盖旧执行器限制；无再委派、pi/Claude/TokenHub、其它模型或 Git 写操作。root 负责独立验证、未实施者全新审查及 Git。精确九文件窗口，未碰 #54 在途58路径的核心/DB/import/audit/batch/HTTP/MCP/旧测试/test-all/STATE/NEXT。维护入口由root先前实际运行，仅旧human-pl SHA mismatch，与本包无关，不读改历史原件。

本片交付真正重新读取原文件/store/只读账库的 review bundle 与七表 XLSX 草稿，最后发布完整 manifest。接口与本机命令见 [OFFLINE-REVIEW](../OFFLINE-REVIEW.md)，任务窗口见 [OFFLINE-05A](../tasks/OFFLINE-05A.md)。只复用 #81 选定 VAT 字段，不新增规则/舍入。所有 accountantApproval/confirmationStatus=pending，periodComplete/submittable/authorizesExecution=false，未登录税局/未提交缴款/未获会计确认/真实性unverified；#82 完整结构化反馈、驳回、更正再确认链尚未实现，不能关闭 #82 或宣称正式更正完成。

输入 loader 从原 VAT CLI 等价抽取，保持真实二进制 hash/sourceText、wx 输出/退出码和最后原件/store/ledger 再验。review 内部重新 VAT/完整度与真实账，WeakMap 约束 bundle 导出，公开 JSON clone 无身份。文件背书 rawInput 返回前绑定完整摘要，建包前改原文+SHA/声明/taxFacts拒绝，公开 facade/inventory 不能改私有 guard，省略 session 仍由 rawInput 私有关联实际再读。原文件及 store.active 的 sourceId/path/hash/version/receipt 只在本机 manifest 与索引明示，不在 stdout/stderr 输出。

Excel 全部字符串、金额整数分转两位文本、0/null/NA分开、原票sheet/cell/pointer/凭证entry/规则URL可查；无公式/执行超链接，长文或非法XML控制符完整留JSON并显式指针诊断。先渲染，再独占新目录/明细，发布前再验，最后manifest；写/重验失败保留诊断现场，无自己的成功标记，不删除未知路径。纯内存原始字节API明确标内存范围，不能声称文件监测或批准。

实施最终自测（cwd `06-workbench`）`node test/accountant-review.test.mjs` **15/15，exit0**。独立合成净额314159+123456=437615；XLSX读回15=13128.45、16=8752.30、20/22=4376.15、2/21及无调整0.00，所有100申报单元与9计算节点/两销售桥接金额逐分核对；另行政274.83、预付61.29。实际CSV及XLSX原票→自动候选→核心测试适配过账→fresh私有snapshot→JSON/XLSX/manifest；原票中文sheet/E4/原binarySHA、24位前导零、日期/中文/负号/注入字符串、零/null/NA、长40000原文/非法XML控制符保JSON+pointer诊断、ZIP无公式/超链接均实测。clone/伪snapshot/跨企业期、建包前三型raw变更、公开facade/副本篡改、省略session仍监测文件、实际账/原件/store变更拒绝；目录已存在/父目录缺失、真实第二文件故障/manifest打开失败/写后输入变化均不形成自己的完整标记。DB/WAL字节与全逻辑表零写，child signal=null/stderr空，DB/source实际close，无自有常驻服务。

必要旧影响（未改旧测试）`node test/offline-vat.test.mjs` **22/22 exit0**，`node test/offline-xlsx.test.mjs` **19/19 exit0**。后续仅完善私有payload前置/自动关联与本片测试显示，不涉及XLSX reader、税算或旧断言；不无理由跑full/npm test。`git diff --check` exit0（只报既有CRLF归一化warning，无内容错误）。失败合成夹具保留在repo忽略 `.agent-runs/accountant-review-synthetic-VEkkOd`；成功默认清理，KEEP_FIXTURES=1可保留，import核心前隔离TEMP/TMP/WORKBENCH_DATA_DIR。

失败/修复如实保留：首轮11/12 exit1，唯一为测试将25×2×2错写成200单元（期望201行），实际100单元/101行；修正算术断言后12/12。中途编辑辅助脚本有UTF8默认解码及数次cwd错误，未成功改到目标时仍跑旧版本，其12/13通过只记中途历史，不替代最终。root/fresh预审指出私有state外泄、完整度误显示JS类型、文件背书省略session降级、建包前payload未绑定：均补私有闭包/克隆inventory、真实每项目status行、rawSessions自动关联、loader读取时摘要及同步建包前校验，并保真实负例；加来源路径映射、XLSX链、真实manifest故障后最终15/15。未删旧断言、skip或伪造通过。

root 最终验收已实际通过：新套 **15/15 exit0**（root进程23437已actualclose）；独立 `.agent-runs/manager-review-probe.mjs` **PASS exit0**，合成S499838.00→15=14995.14、16=9996.76、20/22=4998.38。七sheet/100字段的JSON-XLSX状态与金额逐项读回，所有已填cell均string、无formula/hyperlink；manifest两文件hash、bundle digest及实际sourceId/路径/hash一致。已有目录拒绝且旧文件hash不变，导出前后DB+WAL字节hash不变。实际原件追加newline，同时把公开session.assertCurrent改空并省略session，仍报input_changed且未创建发布目录；建包前nested source原文修改并重算SHA直接input_payload_changed。finally所有session/source/CLI child实际close，未碰真实资料；合成验收产物索引 `.agent-runs/manager-review-acceptance.json`。本条是root实际最终验证，不代替fresh最终完整head审查。

现已再次冻结停止写，尚未fresh最终完整head接受或PR/合并，不预报完成。#54 仍在途，正式连续记账/既存账更正、会计审定黄金/真实业务试用、#83恢复、税局真实接入均未完成（税局仍0）。

## 2026-10-24 OFFLINE-01C / #78C 受限 XLSX 实施候选（尚待 root/fresh 最终验收）

PR93 已实际合并：[PR93](https://github.com/huxiaoyang-code/youshu-fork/pull/93)，base `e280877ce60d75ec859ad6da2b8514fa98341c46`，已审 head `5a6f321c548ad225a67de8cffc98a9a74661e0cc`，merge/main `e564ce3dbcc2a84a4fc558c4a318c88637ced5e1`。root/fresh 税套最终22/22；fresh 独立S426737得12802.11/8534.74/4267.37，root另430217得12906.51/8604.34/4302.17。只完成受限选定服务VAT字段，非整期/全税种/正式更正/确认/在线申报，#81仍OPEN。下方04B“待验/未PR”保留历史，不覆盖本条已合事实。

本片基于该merge，worktree `offline-01c-xlsx`，branch `codex/huxiaoyang-code/offline-01c-xlsx`，Refs #76/#78。认领 #78 issuecomment6373515907，#54协调6373516373；唯一当前继承模型实施Codex subagent，无再委派、pi/Claude/TokenHub/其它执行器，无Git提交/推送/合并。精确13文件窗口，未改旧测试/assertions、core/db/audit/import/batch、test-all或共享STATE/NEXT-SESSION。维护入口root先前实际human-pl旧SHA mismatch与本片无关，不读改历史原件。#54最新协调6373423200为 `local-06-w2b-repair`、base e280877、58路径（含旧snapshot测试仅fixture窗口），随后6373659077补CLI单JSON兼容；仍未PR/合并，正式写依赖未完成，与本片13文件无重叠。

实际新增纯同步OOXML reader：fflate0.8.3库central枚举后以1024压缩字节块流解压核实际entry集合/完成状态/原始长度/总量；saxes5.0.1严格XML语法加受限父子结构。精确sheet名→workbook关系Id→真实worksheet，显式headerRow/列映射。一行一票，原数值<v>词法不先double；和CSV复用同一invoice归一金额/日期/红字/企业/ID规则，所以同业务docId/semanticDigest一致。原二进制SHA、真实sheet/row/A1逐字段定位；JSON rawContent为canonical base64运输，真实blob仍原二进制。preflight/重放/store重开/CLI材料及税CLI均按kind重新解码原件，不信缓存CSV或派生records。CSV/JSON旧sourceVersion和scripts/exceljs/pdfkit不变，仅把原lock内fflate/saxes升直接固定依赖。

真实工程范围见 [OFFLINE-XLSX](../OFFLINE-XLSX.md)：票号/日期/企业等必须文本；金额普通十进制最多两位、小于原合同限额，数值只General/0/0.00格式；不重建前导零。公式含cached结果、错误/布尔/数值日期/数值票号/亚分/科学计数/格式歧义/合并/未知类型、rich text/多run和_xHHHH_转义、外链/宏/OLE/实际VML/未知part或关系、损坏/缺失part均拒绝。5MiB原文件/100entries/4MiB单entry/16MiB实际总解压、10000行/256列/XML深32/节点100000等硬界；不是全ZIP/OOXML合规或CRC/flags认证，不声称拒绝所有未公开加密/ZIP64标志。默认空slicer/timeline样式及无实际VML的默认声明可保留，其余扩展不支持。只读选定表业务，其它表不纳业务；真实性unverified。整期coverage缺失时period/tax blocked，依赖已满足独立逐票/银行候选保留；不标整期完成。

实施自测最终（cwd `06-workbench`）`node test/offline-xlsx.test.mjs` **19/19 exit0**，无skip。合成ExcelJS文件真实落盘/重读，shared与实际重打包inline变体，长前导零、金额531.79+5.32=537.11、E4/F4/G4、真实binaryhash、两次重放；CSV语义等价/跨格式重复及1分冲突；canonical base64实际5MiB边界；缺字段/非法日/不同企业/类型/格式/公式/外链/树结构/DTD/宏关系/contents/缺part/ZIP声明欺骗和实际流计数/总限额等故障。store真实二进制receipt/child重启inspect/替换原路径后仅隔离销项/独立银行182.49保留、精确CAS更正537.11→537.12/旧blob保留/重试同回执。新完整链实际CLI materials→plan→bookkeeping，候选经既有core仅合成临时库入账，再fresh私有snapshot→VAT；S388927原1%3889.27、总392816.27，独立期望15=11667.81、16=7778.54、22=3889.27，银行预付182.49不提前费用。VAT CLI实际原文件/materialStore两路均一致，原路径换入异企业原票后store路线拒绝，未冒称既存账更正已实现。所有DB/source finally实际close，child实际退出signal=null/stderr空，无常驻服务或真实资料/凭据。

必要旧影响（旧测试未改）`node test/offline-materials.test.mjs` **36/36**、`offline-plan` **45/45**、`offline-bookkeeping` **43/43**、`offline-vat` **22/22** 均exit0。`offline-material-store`首次沙箱29/32和`offline-ledger-snapshot`25/26均exit1，仅合成hardlink/junction创建EPERM；保留故障目录XZgwHH/qx12Ov/NtWCYj/WSAp8P、不skip或改断言。按已有授权require_escalated后实建真实别名，分别 **32/32**、**26/26** exit0/skip0，DB实际close。snapshot持连接目录换入仍OS明确EPERM且原身份字节不变，不能当实际目录替换通过。上述六套为新增最后XLSX专有part缺失检查前已通过的影响结果，之后只改XLSX reader/新测试并新套19/19，不无理由重跑旧套或full/npm test。`git diff --check`通过。

失败历史如实保留：早期probe合法目录entry尾/误拒、ExcelJS默认样式extLst误拒已修；新套首轮11/17，主要fixture反写replayReports参数、coverage id少:all、误以ExcelJS document writer shared=false即inline及旧#80逐票独立候选被测试错误期待全阻断，另fflate数字error.code的catch typeof风险。一次Python修复脚本错cwd导致未生效并11/17重现，所有夹具保留（mDuMwo/0uOz6I）；修后16/17剩bank taskId应prepare:bank。root/fresh预审实际宏Type和ContentType挂无害code.bin仍接受P2，改有限关系/内容类型/part白名单并保真实负例；白名单首轮漏默认无内容VML声明导致3/18，修为仅无实际VML时允许默认声明后18/18。新增缺part/总限额和税coverage后18/19是测试修改declaration未重算taxFact指向该文档SHA，被现有严格tax_reference_digest_mismatch正确拒绝；重算真实修改文档引用后19/19。未删旧断言、伪造通过或以先前结果代替修后验收。

root早期独立未冻结probe实际PASS：1673.29+16.73=1690.02及640.57+6.41=646.98，两票中文sheet/headerRow3/长前导零，XLSX data/docId与CSV一致，保存的PR93旧CSV完整preflight输出逐字段deepEqual，原定位E4/F5正确。夹具 `.agent-runs/manager-xlsx-independent` 为root自有，不作产品输入，不代替最终完整head验证。尚待root独立最终验证、未实施者fresh最终完整head审查及PR/合并。#78更多原始适配/XLSX更广格式和路径搬迁、#77生产黄金、#79真实执行回执、#80正式持续过账与更正、#81其余税表、#82确认版本链、#83恢复仍未完；会计审定/真实业务试用保持未完成，税局真实接入0。


root修后已独立实跑新套 **19/19 exit0**。另 `.agent-runs/manager-xlsx-probe.mjs` 独立probe **PASS exit0**：PR93旧CSV完整preflight逐字段与版本不变；中文表头/22位前导零两票1673.29+16.73=1690.02及640.57+6.41=646.98，XLSX与CSV身份/语义一致、E4/F5定位、跨格式4record duplicate；伪零缓存重放忽略。真实store原路径改成1673.30/1690.03后blocked_origin_changed/reports空，无CAS拒绝，精确前版CAS接受并保2历史/2receipt，重复replayed，child新进程CLI重开历史/金额一致。无DB写；这是root最终独立验证事实，尚未fresh完整head接受或PR合并。收到root结果后仅补本文档本段，无生产代码/测试变化，不重复测试。现冻结停止写。

## 2026-10-24 OFFLINE-04B / #81B 非零选定 VAT 行实施候选（待 root/fresh 冻结验收）

PR92 实际已合：[PR92](https://github.com/huxiaoyang-code/youshu-fork/pull/92)，base `0c6efe4bba9b7a62d09f434cd3fef071c917d4f8`，已审 head `ff8c30734a3d64ffb022efa2c63f0d3188aa3d5f`，merge/main `e280877ce60d75ec859ad6da2b8514fa98341c46`。#78B store 最终 root 与 fresh **32/32**，独立 root 实际 `547.83+5.48=553.31→553.32`、bank `126.49` 的三 receipt/CAS/原路径失效及独立银行不变验证；fresh 另独立 `324.73→324.74`、bank `73.91` 来源更正/旧版本保留。下方“01B仍待32/未PR”等保留历史时点，不能覆盖本条实际已合事实。#78 XLSX/路径重定位等未完，#78整体未完，资料真实性仍unverified。

本片基于该 merge，worktree `offline-04b-vat`，branch `codex/huxiaoyang-code/offline-04b-vat`，Refs #76/#80/#81，认领 issuecomment6373062873。唯一当前模型实施 Codex subagent，未再委派、未调用 pi/Claude/TokenHub/其他外部执行器，无 Git 提交/推送/合并。精确七文件窗口；#54 的 DB/accounting/import/audit/coordinator/batch/HTTP/MCP、package/test-all、STATE/NEXT-SESSION 及旧材料/规划/候选/store/snapshot实现全部只读。维护入口由root实跑，仍是旧human-pl SHA mismatch，与本片无关，不修历史原件。

实现 `calculateOfflineVat(rawInput, privateSource, privateSnapshot)`：内部从原始 #78 reports/declaration/accountingFacts 重新 `buildOfflineCandidates`（#79准入也重算），再核 #81A 当前实际只读账库。scope、规范企业绑定、持久profile/准则、完整posted凭证和分录顺序/ID/日期/科目/整数分、自动业务key、固定source_system与实际source/check/batch关联逐条匹配；批次必须completed。所有scope posted都须解释，draft/未知业务/结转/缺源/缺月/来源或账证矛盾均不放行。没有生产写账或默认DB导入。

工程范围严格是2026Q1新设首期季度小规模企业、普通境内主营服务、全季度销售达到300000元、逐票净额整元与原票1%及实际初始VAT完全一致；完整季度销购/逐账户银行覆盖、工资资产不适用、首期零期初/无历史、会计资格及逐项业务排除均须依据。taxFacts只接基础/排除与逐票类别事实、确认人/依据/真实来源pointer，不接税额/税基/科目/分录/ready。unknown/缺件、冲突、unsupported有具体classification和原始事实请求；合法空账和低于起征点明确unsupported，未计算字段null。工程期限和官方法律/表式日期分列，#6表式按Q1结束后底稿使用，不误按Jan1筛掉Feb1表式。

真实非零服务列1/2/3/15/16/20/21/22计算，区分已核净额税务基础、账面初始1%、无调整、名义3%、减征2%与最终1%；无账面2%收益。累计仅完整新设首期Q1同本期，21/22累计NA，货物列/其它行/附加及其他税种not_computed/null。每字段节点连原始fileSHA/location/业务事实pointer、真实voucher/entryIDs、source/batch及rule；规则与最终结果递归冻结，caller仍可编辑。contentDigest/inputHash/ruleVersion/ruleDigest/ledgerSnapshotDigest仅本地版本比较，不能认证或复用旧确认。

CLI 每次实际读取显式原始文件配置或 #78B store、重开只读DB/捕获私有snapshot，计算后重比文件字节/store/账库；不接旧JSON自称current。新output用wx，stdout固定状态/计数，错误固定码。calculationReady/reviewReady只对selected_fields；periodComplete=false/submittable=false/onlineCompatibility=unverified/accountantApproval=pending/真实性unverified固定。精确合同 [OFFLINE-VAT](../OFFLINE-VAT.md)，窗口 [OFFLINE-04B](../tasks/OFFLINE-04B.md)。

实施自测最终（cwd `06-workbench`）`node test/offline-vat.test.mjs` **22/22，exit0**。合成CSV/JSON先落盘，自动 #80 candidates 经现有 importIncremental 核心入专属临时库；正例S300123：15=9003.69、16=6002.46、20/22=3001.23、21=0，三销售加行政418.73/预付73.91全部真实凭证核对；S300000边界9000/6000/3000；另独立S412789：12383.67/8255.78/4127.89。覆盖raw重放、伪ready/候选、税资格/完整度/所有排除、合法空账/低额/非整元/专票/跨境、真实draft/金额科目日期行序/来源/指纹、批次failed/unknown、准则错配、未知日期null、假snapshot/DB、跨企业跨期、2025/2027工程门、hash变化/不相关企业不失效、结果冻结不冻结caller、累计NA/行勾稽、真实CLI原路径/store失效/安全stdout/拒覆盖/无默认DB及逻辑表/DB/WAL零写。DB/source finally实际close，所有CLI child status明确/signal=null/stderr空；未使用真实资料/账套/凭据或golden运行输入。

更正限制按实际能力保留：原材料金额300123改300124后旧账底稿stale_previous_new_version且blocked，不能复用旧确认；另独立新账fixture计算9003.72/6002.48/3001.24仅验证新金额算术，不是既存账更正链。本片未手改来源登记或删历史冒充正式更正；#80既存账更正/撤销及#82确认链仍未实现。

root实施期间独立金额probe **PASS exit0**（不是最终冻结验收）：原始事实201319+228898=430217，独立期望15=12906.51、16=8604.34、20/22=4302.17、21=0；他企23.57草稿不使目标snapshot失效；只改实际batch.status为failed后选定字段null/ready=false，恢复completed再ready；caller.scope冻结状态不变，source/db finally close。其合成夹具保留 `.agent-runs/offline-vat-synthetic-dNaiDy`，不以此预报fresh接受。

失败修复如实保留：首两轮0/17是新测试适配分别漏核心append必需account_set元数据、漏confirmNewBinding；依现行核心合同补合成适配后，错误cwd一轮14/17还暴露测试尝试过账后写期初被核心opening_rewrite_after_posting正确拒绝、CLI相对路径找不到；改用过账前独立期初夹具，CLI cwd由测试文件定位。失败夹具全部保留，未删旧断言或改核心。root预审发现来源binding v5无account_set_id、实际批次未查completed、持久标准错配及caller冻结风险均在正例/负例覆盖前修正；随后19/19→21/21→22/22全部exit0。未把旧结果替代最终冻结验收，未skip或mock真实文件/DB。

必要影响自测（同cwd、未改旧测试）`offline-materials` **36/36**、`offline-plan` **45/45**、`offline-bookkeeping` **43/43** 均exit0。TEMP/TMP置repo忽略.agent-runs，税test在core import前再专属隔离WORKBENCH_DATA_DIR/TEMP/TMP；失败自动保留、KEEP_FIXTURES=1可保留成功夹具。未跑full/npm test，没有自有常驻服务。尚待root独立最终验证、全新未实施者最终完整head审查及PR/合并，不关闭#81，不把本片当#54正式写依赖完成；#77生产黄金、#78剩余来源、#79正式执行回执、#80正式连续过账和既存账更正、#82确认均未完成，税局真实接入0。

root最终阅读再明确三处分类：已提供enterprise.form=unknown、establishedOn=null均为unknown；逐票taxFacts零份为missing，多份为conflict。对应现有定点补精确classification断言且选定金额继续null，修后税test仍 **22/22 exit0**、DB/source实际close；旧36/45/43为本次小改前已通过的影响结果，未无谓重复旧套。待root按修后完整内容重新冻结，不沿用修前审查。

## 2026-10-24 OFFLINE-01B / #78B 实施候选（尚待root/fresh验收）

PR91实际已合：[PR91](https://github.com/huxiaoyang-code/youshu-fork/pull/91)，base `9cd0176bb912c94b519fc40b155159d4ca5b81c7`，已审head `b88bc2e942a50776c706701c3d739ba8bdd1e088`，merge/main `0c6efe4bba9b7a62d09f434cd3fef071c917d4f8`。root/fresh最终快照26项、fresh另38项独立验证通过；Windows持连接目录替换被OS阻止，原身份/字节保持的证据不能当实际替换通过；硬链在获授权实跑中实际建立，nlink=2被产品拒绝，移除后重验current。下方04A待26项/未PR等保留为历史，不覆盖本条已合事实。

本片基于上述merge，branch `codex/huxiaoyang-code/offline-01b-receipts`，Refs #76/#78/#79；唯一当前模型实施subagent，无再委派、pi/Claude/TokenHub/其他执行器，无Git提交/推送/合并。严格六文件窗口；旧模块、核心DB/import/audit/coordinator/batch/HTTP/MCP、package/test-all、STATE/NEXT-SESSION只读。维护入口flow status由root实跑，仅旧human-pl SHA mismatch，与本片无关，不修历史原件。

实现显式专属store初始化/receive/inspect/recover-lock，原字节blob+manifest摘要链构成本机durable receipt；新目录rename是整批active提交点，排他wx锁与更正CAS，旧版本原字节保留。重开实际核验全部历史blob/manifest，不信保存status/records。active原路径逐源stale隔离，有效独立来源仍进入新reports；已核receipt/history始终可查；内部历史损坏整体failclosed。正常receive自身锁释放成功后writerBlocked=false。原路径stale期间补收独立源仍真实提交，返回blocked_origin_changed+receiveStatus及receiptIds，不能以CLI非零推断未接收。

最小恢复guard排他并协调普通writer，只有本store锁且OS PID明确不存在才显式解锁；未知/活/不确定锁保留，guard自身崩溃保守blocked。不是#83通用恢复，不承诺Windows断电保障。相同sourceVersion同origin重试重放同receipt；同版本搬迁暂报source_origin_conflict，显式origin重定位留后续，不能通过无意义mapping更改规避。

首轮实施实际 `node test/offline-material-store.test.mjs` **4/27，exit1**：主要沙箱将真实pending目录rename至commit一律EPERM，实际hardlink/junction也EPERM，失败合成Temp夹具全部保留。未skip/降格或伪造成功，已报root需授权实跑。随后补root指出的恢复并发P2与自身writerBlocked错误，以及逐源stale局部保留、receipt查询、独立补件，新增真实IPC恢复/活writer竞争测试。root获授权沙箱外实际 **31/32，exit1**，唯一失败是新测试把无code列表头税额列误写7（应6），失败fixture `Temp/offline-receipt-synthetic-dOeSQc`保留；其余实际IPC/前后提交child终止/硬链junction/局部规划均通过。已改独立期望6并反查实际header该列确为tax，不改产品或旧断言；待root重跑最终32项，不把31/32当通过。

合同 [OFFLINE-MATERIAL-STORE](../OFFLINE-MATERIAL-STORE.md)，任务 [OFFLINE-01B](../tasks/OFFLINE-01B.md)。接收回执authorizesExecution=false、completeness=not_assessed、authenticity=unverified，#79实际声明/完整度继续判断。#77会计审定黄金、#78 XLSX/其他来源/路径重定位、#79正式执行回执、#80正式写账/连续核算仍未完成，#54 coordinator另一窗口在途，税局真实接入0。尚待root最终定点、fresh完整head独审、PR/合并。

必要影响实施自测（cwd本worktree `06-workbench`）：`node test/offline-materials.test.mjs` **36/36 exit0**、`node test/offline-plan.test.mjs` **45/45 exit0**；旧断言未改，未跑full/npm test。`git diff --check`exit0；精确六文件变更，没有自有常驻进程。仅32项税列夹具期望和文档收尾后冻结，等待root实际32项新结果与独审。

root修后独立合成probe **PASS exit0**（`.agent-runs/root-store-GLyrwc`保留）：实际547.83+5.48=553.31初收，bank126.49追加receipt2；原invoice替换553.32后inspect局部blocked、receipt2仍可查、仅bank有效且#79银行inputDigest/unchanged不变；无CAS更正拒绝无新receipt，精确旧版本更正receipt3并保留两份sales历史；再次重试replayed仍3；新child CLI inspect exit0/signal=null/stderr空且原文重算report一致。该独立probe不代替最终32项与完整head独审。

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
