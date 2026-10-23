# OFFLINE-00B 独立合成业务黄金

Refs #76 / #77 / #85。基线 `98e57bdfbe29e2f8716ab0768492583064cd30c1`。12组均为合成资料，`accountantStatus=pending`；本片没有会计签字、真实客户资料或真实税局接入。新增测试不接入旧全量入口，不改变旧16组工程合同。

`06-workbench/test/fixtures/offline-business-golden-v1/raw/G01..G12/` 保存实际CSV、XLSX、业务事实、会计事实、声明和税务事实。raw没有预期分录、申报计算税额或预制凭证；原始发票保留真实合成票面税额。银行/出资期初只是原始历史事实。`expected/G01.json..G12.json` 是产品执行前独立十进制预算冻结的字面量：全部分录、1/2/3月逐科目及总额、VAT选定字段状态/值/公式/来源，另含逐笔业务身份、原件SHA、具体行/cell、会计事实pointer与文字推导。运行不从expected生成业务事实或凭证。

|案例|独立业务|3月累计借贷发生额（各）|3月余额借贷合计（各）|申报结果|
|---|---|---:|---:|---|
|G01|普通服务净额300000，CSV，恰好起征点|303000.00|303000.00|选定字段，应补3000.00|
|G02|净额199937+100064，1/3月XLSX，前导零长票号|303001.01|303001.01|应补3000.01|
|G03|净额123457+112233+98765，三月CSV/XLSX，同票重复|337799.55|337799.55|应补3344.55，三笔而非四笔|
|G04|净额412789；行政服务gross274.83，1月票2月完成|417191.72|417191.72|应补4127.89；首次发现的产品阻断已窄修|
|G05|净额388927；行政gross418.73；实际持久接收及新进程reopen|393235.00|393235.00|应补3889.27|
|G06|净额271828+161803；行政274.83+418.73，多客户/供应商/月|438660.87|438660.87|应补4336.31；同一门修复后通过|
|G07|净额1763；初始账载VAT17.63|1780.63|1780.63|低门槛unsupported，申报null|
|G08|仅行政服务gross450.81|450.81|450.81|无销项unsupported，null|
|G09|未来短期服务预付286.47；期初银行/实收资本1000|286.47|1000.00|已知历史期初unsupported且完整度missing→blocked/null；银行713.53|
|G10|净额1763及行政450.81|2231.44|2231.44|低门槛unsupported，null|
|G11|行政312.45、预付208.37；期初银行/资本1000|520.82|1312.45|历史期初unsupported且完整度missing→blocked/null；银行791.63|
|G12|净额345679、行政613.29、预付637.29；期初银行/资本2000|350386.37|351749.08|即使超过门槛，历史期初unsupported且完整度missing→blocked/null|

每例使用独立子进程和临时DB，raw内固定 `accountSetId=1`；不运行时改写原件scope。核心模块import之前隔离WORKBENCH_DATA_DIR/TEMP/TMP。实际文件经 `openOfflineActionInput` 重读、产品 `buildOfflineCandidates` 自动生成分录，再由测试专用adapter把**产品候选**送现有 `importIncremental`。该adapter没有伪造权限、审计记录、快照或来源指纹；#54正式coordinator尚未合入接线，此测试不代表正式产品写账入口。9/11/12在执行前由测试明确调用 `A.setOpeningBalances`，声明诚实保留 `balances_required/prior_required`。

随后逐月调用真实 `A.trialBalance`，从实际DB捕获私有可信快照并调用 `calculateOfflineVat`。独立helper只用BigInt和十进制字符串，禁止导入产品money/tax数学。断言逐笔原件hash/identity/实际行或cell/会计事实pointer→候选rule/entry→真实已过账voucher/entry ID及来源关系→选定VAT规则与数值，其他税字段始终null。G03重复来源全部保留追溯且只生成三笔。G05真正receive落盘，新进程inspect持久receipt，再由新reader打开store输入。

`trialBalance.period_debit/credit` 是自账套start_period至请求月的**累计**发生额，opening是最初建账期初。expected分别列 `initialOpening/cumulativeMovements/monthlyMovements/closing`；测试直接比累计，另用相邻累计之差核对当月。各期均未结账、未结转；这不是正式结账余额，也不是两个合法连续申报期。

税规则沿用已核对的 `offline-vat-selected/1` 与现有官方来源，不新增政策解释：2026-Q1新设企业、小企业准则、季度小规模、普通境内主营服务、每笔不含税整元、票面及初始账载1%，全部其他排除事实有本机合成声明。达到30万按全额3%计算，2%减征，选定current1/2/3/15/16/20/21/22；首期对应YTD同值，YTD21/22为不适用null，其余未算字段null。低门槛、无销售、历史期初及小数净额均不给零申报。历史期初已知不在当前税规则支持范围；即使补齐原始资料也不自动开放该规则路径，当前blocked同时包含完整度missing与明确unsupported原因。

规则核对日期2026-10-24；[增值税法](https://shanghai.chinatax.gov.cn/zcfw/zcfgk/zzs/202412/t474694.html)自2026-01-01施行（第23/28/38条）；[2026年第10号公告](https://shanghai.chinatax.gov.cn/zzzb/zcwj/202602/t479283.html)的30万起征点与1%适用期2026-01-01至2027-12-31；[2026年第6号公告](https://fgk.chinatax.gov.cn/zcfgk/c100012/c5247507/content.html)表式过渡2026-02-01；[填写说明](https://shanghai.chinatax.gov.cn/tax/bsfw/xzzx/bgxz/sbzsl/202107/t459066.html)及[官方空表](https://12366.chinatax.gov.cn/bzds/003/003.html)支持行次和横杠。会计分录采用现有 `small-service-sale/1`、`small-admin-service/1`、`small-future-service-prepayment/1` 的[小企业准则](https://kjs.mof.gov.cn/zhengcefabu/201111/P020111118325852319878.pdf)及[科目说明](https://kjs.mof.gov.cn/zhengcefabu/201111/P020111118325852734144.pdf)，销售账载税依据[财会〔2016〕22号](https://www.mof.gov.cn/gkml/caizhengwengao/2017wg/wg201703/201707/t20170707_2641107.htm)。工程日期窗口与法规生效日期分开，黄金不构成会计/法规生产批准。

执行：在 `06-workbench` 运行 `node test/offline-business-golden.test.mjs`。首次实际12/14，追加小数净额控制后13/15，exit1；10/12业务通过，两个失败均是G04/G06跨发票月完成的真实产品缺陷：`offline-bookkeeping.mjs` 行政benefit span仍按原票 `r.date` 月比较，从而把2月完整受益误标 `unsupported_benefit_span`。先报告管理者、保持原业务/预期，未skip/删除失败断言。管理者经#77 comment6375643868/#80 comment6375644345扩认领唯一产品文件后，窄修该门以实际completionDate月份比较；其他守卫保持。新增原票月受益、两月跨度、completion出Q1/2027、缺completion、原始受益事实冲突均拒绝且独立销售保留。修后新增套 **15/15、exit0，12/12业务全部通过**，包含G05实际持久receipt新进程reopen。相关未改旧套bookkeeping **43/43**、action-plan **33/33**、VAT **22/22**均exit0。没有扩大到全量。管理者随后独立复跑新15/15及旧43/33/22均exit0/skip0；按原件另行Python Decimal复核12组逐笔、36份月末快照、税字段与SHA全部通过。管理者另以全新S469271+行政617.29输入跑真实域API，独立核到税行15=14078.13、16=9385.42、22=4692.71及3月未结账试算474581.00（各侧）与原件SHA，均通过。管理者完成月守卫探针亦通过；这些是工程验证，仍待全新上下文最终独审。

附加控制不计入12业务数：缺完成事实拒候选、更正事实保持businessKey但newVersion、原件金额更正改变候选、红票拒绝、小数净额保留初始账载税但申报unsupported/null、快照clone/跨企/跨期拒绝、真实反过账使旧快照stale、poison expected导致断言失败而产品输出不变。所有DB/source/session在finally实际关闭；成功清理，失败保留ignored `.agent-runs`，KEEP_FIXTURES=1可保留成功资料。没有无关全量测试、真实客户试用或会计签字；#77/#85及OFFLINE整链仍未闭环。
