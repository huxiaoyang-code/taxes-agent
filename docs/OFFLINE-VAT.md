# OFFLINE-04B：从真实已过账凭证到选定 VAT 行底稿

Refs #76 / #80 / #81。本片是只读、非零选定行工程实现，#81 整项未完成。没有写账、结转、确认回执或税局提交入口；税局真实接入仍为 0。

## 支持范围与法律期限

工程仅支持 **2026-Q1、新设首期小规模企业（非个体/自然人）**，原材料 scope 的 accountSetId 必须为实际账套 ID 的规范十进制字符串。基础声明明确 small-2011/service-company；会计有登记依据确认 small_scale、quarterly，不能从账套 taxpayer_type 或 profile 默认推断 VAT 资格。会计另确认新设日期、new_zero 期初和 first_period 历史；实际账库也须从 2026-01 启用、无非零期初、无前期凭证。三个月份须有真实期间记录。

销售限 #80 已准入的普通主营服务：本 scope 开始并完成、开票/完成/取得收款权同日、尚未结算、普通发票、境内消费。**每张原票不含税金额整元、税额非零且精确为 1%，与真实过账初始 VAT 相同**；全季度销售额达到 300000 元。本片没有通用舍入策略，非整元即 unsupported；不得用浮点乘法、客户计算的税额或“ready”声明补足。

全季度覆盖由基础声明的完整业务/销购/逐账户银行材料清单与依据、#79 重验共同判断；来源文件多不代表完整。工资、资产须带依据明确不适用，期初和历史须会计确认首期无余额/无历史；缺失、未知和已知不支持分别表达。每笔已提供采购/银行事项也须 #80 准入且与已过账凭证对应。未知业务不当“不适用”。本片只允许没有结转/其他未解释凭证的初始账；复杂已结转账不支持。

低于起征点的免税路径、真实空账合法零额、免税收益、专票、不动产售租、土地、建筑预缴、差额、跨境、视同交易、其他优惠抵减、放弃减征及历史调整等不开放。合法空账在资格、整期无业务及首期依据完整时为明确 unsupported 零额路径；缺材料则 blocked。所有未能计算的申报金额为 null。

工程 Q1 限制不等于法律期限。规则注册表递归冻结，getVatRules() 返回副本，底稿结果递归冻结且不冻结 caller 输入。版本 `offline-vat-selected/1`，核对日期 2026-10-24：

| 官方依据 | 适用事实与定位 |
| --- | --- |
| [增值税法](https://shanghai.chinatax.gov.cn/zcfw/zcfgk/zzs/202412/t474694.html) | 2026-01-01 施行；7/11/14/17 条价外税、3%及简易计算，23 条达到起征点全额，28 条同日义务，30 条具体计税期间核定 |
| [财政部税务总局2026年第10号](https://shanghai.chinatax.gov.cn/zzzb/zcwj/202602/t479283.html)，[辽宁税局同文](https://liaoning.chinatax.gov.cn/art/2026/1/30/art_5869_7749.html) | 2026-01-30 成文；一（一）季度 30 万、三（三）6 的 3%减按1%与不动产售租/土地排除，相关规定适用 2026-01-01 至 2027-12-31 |
| [税总2026年第6号](https://fgk.chinatax.gov.cn/zcfgk/c100012/c5247507/content.html) | 2026-02-01 起暂用现有表按调整说明填报；本片用于 Q1 结束后的离线底稿，不按 Q1 起日过滤该表式 |
| [小规模表2026调整及说明](https://shanghai.chinatax.gov.cn/tax/bsfw/xzzx/bgxz/sbzsl/202107/t459066.html) | 页面更新 2026-02-09；顶部调整说明：1%销售额填行1、销售额2%填行16；原说明二（五）（六）（十八）（二十三）对应2/3/15/21 |
| [官方空表](https://12366.chinatax.gov.cn/bzds/003/003.html) | 元列至角分；20=15-16、22=20-21；21/22本年累计横杠 NA |

实施读取 VAT 法、#6、更新说明、官方空表及辽宁 #10 同文成功。上海 #10 timeout、青岛同文412的访问失败如实保留，未冒称读取成功。注册表保留原官方 URL 和已核同文备用 URL。

## 输入与账证匹配

API：`calculateOfflineVat(input, readonlySource, privateSnapshot)`。后两项必须由 #81A 同进程 `openReadonlyLedgerSource(explicitDbPath)`、`captureLedgerSnapshot(source, actualScope)` 产生；首先及返回前实际 `validateLedgerSnapshot`，stale 则 blocked。上传 JSON、clone、公开 digest 或任意 DB 句柄不能替代私有能力。

input 精确字段：scope、reports、declaration、profileId、accountingFacts `{text,fileSha256}`、taxFacts `{text,fileSha256}`，可选 previousComputation。内部重新调用 `buildOfflineCandidates`，重放 #78 原文摘要/映射与 #79 准入，重算所有候选；不接上传候选、预制分录或计算税额。API 只表示本次给定字节与私有账库读取时点，不监测调用者磁盘路径。

固定未来桥接契约（**本片不生产执行**）：

| 内容 | 精确匹配 |
| --- | --- |
| source.system | `offline-bookkeeping-candidates-v1` |
| sourceVoucherId | 自动候选 businessKey，无客户手编 ID |
| voucher.summary | `offline:` + businessKey |
| voucher.date / period / kind | 候选 date / date前7位 / normal；真实 posted |
| entries | 完整数量、顺序 line_no、accountCode、分金额；summary 为 detail，缺省为 kind |
| 导入登记 | 实际 source binding 的 source_system/enterprise_key、规范企业到账套 binding、voucher source、batch voucher 对应、实际源内容指纹与 persisted 指纹 |
| 批次 | 实际 import_batches.status=completed，企业/账套/source一致；失败或未知批次不因已过账而放行 |

真实持久 profile 必须已登记且 ID/declaredStandard 与 accountSet.accounting_standard 一致。任何未解释的 posted、draft、缺来源、来源指纹失配、缺月份或跨企业跨期均阻断。复用 #81A `sources.checks` 与实际关联；全目标范围凭证必须都得到解释，不能只筛收入科目。生产模块不导入默认 db.mjs、不开默认数据目录、不迁移、不安装、不写账。

## taxFacts 原始税务事实

`offline-tax-facts/1` 精确字段是 version、scope、enterprise、period、invoices。每个确认对象都包含 confirmedBy `{name,role}`、basis、非空 sourceRefs。不能加入金额、税基、申报行、科目、分录、ready 等派生字段。

- enterprise：form=`enterprise|individual_business|natural_person|unknown`，establishedOn 为真实日期或 null（未知）；企业事实须 accountant 确认。
- period：exclusions 数组及整个期间清单的 accountant 确认。每项 `{area,state,confirmedBy,basis,sourceRefs}`，state=`none|present|unknown`。
- invoices：逐张销项的 invoiceRef `{sellerKey,code,number}`、invoiceClass=`ordinary|special|unknown`、domesticConsumption=`domestic|cross_border|unknown`、serviceCategory=`ordinary_main_service|real_estate|land|construction|other|unknown`，再附确认和依据。缺失/多份矛盾不可用汇总 ready 替代。

排除清单 area 全部必需：otherSales（含未开票销售）、realEstateSalesAndLeasing、landUseRights、constructionPrepayments、differentialTaxation、crossBorder、deemedSales、exemptions、otherReliefsAndCredits、waivedReduction、prepayments、priorAdjustments、nonMonetaryOrAbnormalPricing、mixedTransactions、withholdingOrImports。每项 none 必须具体会计核对依据，不能只传布尔值。已知 present 为 unsupported；unknown/缺项 blocked，均不转成零。

sourceRefs 为 `{kind,fileSha256,pointer}`，kind 可为 declaration（摘要为该对象 stable JSON 的 SHA）、accounting_facts（原字节摘要），或 business_json（再有 sourceId、对应 #78 原始业务 JSON 摘要）。JSON pointer 必须真实存在并非空。比如 declaration 的 `/evidence/1/basis` 可以引用会计核对的登记来源。验证的是本机给定资料与引用一致性，**hash 不是身份或经济事实认证**；会计审批始终 pending。补充事实应说明实际登记、逐票类别、完整排除事项，不要求客户填分录或最终税额。

## 输出与追溯

S 为逐票原始净额与真实已过账收入、初始 VAT 逐项核对后的税务基础。只用整数分和 BigInt，所有已算值都精确到分、没有舍入：

| 服务列行 | 算式 |
| --- | --- |
| 1 / 3 | S |
| 2 | 每张销项确认为普通发票且完整覆盖后的有依据零 |
| 15 | S×3%（名义计征金额，并非账面初始1%） |
| 16 | S×2%（减征，不产生账面2%收益） |
| 20 | 15−16，等于已核账面初始1%总额 |
| 21 | 会计完整核对无预缴的有依据零 |
| 22 | 20−21 |

完整首期 Q1 的1/2/3/15/16/20本年累计同本期；21/22累计为 NA/null。其它行、货物列、附加23–25及其他税种 not_computed/null；不把未算行写零。

calculationNodes 区分税务基础、账面初始 VAT、无调整、名义3%、2%减征、最终应纳与预缴。每行指向节点；节点连至逐笔 businessKey，sales/reconciledBusinesses 留真实凭证 ID、entry ID/行序/科目/分金额、原材料 SHA/location、accountingFacts pointer、taxFacts pointer/依据、来源关联/检查/批次与规则引用。仅全门通过才给税务基础和无调整数字，否则派生税基/调整/选定行都 null。

contentDigest/inputHash/ruleVersion/ruleDigest/ledgerSnapshotDigest 支持本地重放比较。previousComputation 仅接受 `vatComparisonSummary(product)` 的七字段摘要（version/scope及上述五值），不接受已批准标志；变化为 stale_previous_new_version，oldApprovalReusable 始终 false，不能认证旧确认。原资料金额变更而现账未协调时输出 blocked；正式既存账更正/撤销与 #82 确认链尚未实现，不通过修改导入来源登记来冒充更正闭环。

仅选定字段通过时 calculationReady/reviewReady=true；readinessScope=`selected_services_fields_only`。periodComplete=false、submittable=false、onlineCompatibility=unverified、accountantApproval=pending、sourceAuthenticity=unverified、authorizesExecution=false 固定，未声称全表/整期完成。

## CLI 与验证

工作目录 `06-workbench`：`node scripts/offline-vat.mjs --input <input.json> --output <NEW.json>`。

配置版本 `offline-vat-input/1`，字段 scope/profileId/declaration/accountingFacts/taxFacts/db 均显式（文件路径相对该配置）；二选一 materialsInput 或 materialStore。materialsInput 是现有 `{scope,sources:[{sourceId,kind,scope,path,mapping}]}` 文件，CLI 实际读取源 CSV/JSON生成 #78 report，再传 #80；materialStore 使用 #78B inspect 重开并核实际原路径，stale/锁住不放行。不接受上次预检报告或计算 JSON 自称 current。可选 previousComputation 路径只读本地摘要。

每次新开只读 DB、重新捕获私有快照、读取及重验所有显式文件，计算后再次比对文件字节、store 和账库。输出 wx 独占新建，拒覆盖；只有新输出含本机业务数据，stdout 固定 `OFFLINE_VAT_WRITTEN ready=0|1 issues=N` 或固定拒绝码，无路径/企业/金额。exit0=选定字段成功，3=已写诊断底稿但未计算，4=格式/能力/读写拒绝，2=用法错误。无联网或消息发送。

专属合成测试 `node test/offline-vat.test.mjs`：core import 前隔离 WORKBENCH_DATA_DIR/TEMP/TMP 到仓库忽略 `.agent-runs/offline-vat-synthetic-*`；全部来源先落盘再自动候选，经现有 importIncremental 核心入临时库。没有 golden 运行输入/真实资料。失败保留夹具，成功默认清理，KEEP_FIXTURES=1 保留；DB/source/CLI child 实际结束。测试适配只供合成数据，不是绕过 #54 的生产写入口。独立新金额样例只能验证新底稿算术，不能证明既存账更正链。
