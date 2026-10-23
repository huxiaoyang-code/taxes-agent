# OFFLINE-03A：原始业务事实到会计分录候选

Refs #76 / #79 / #80，补充材料格式 Refs #78。基于已合 PR89 `19e861a580ebffec0b5e14eafb41ca457f9de71e`。本片生成三类实际借贷分录候选、具体补件请求及版本差异；所有结果 `authorizesExecution:false`。未过账、未结转、未结账、未计算最终税额，不能视为整期完成。

在 `06-workbench` 执行：

```powershell
node scripts/offline-bookkeeping.mjs --input C:\local\bookkeeping-input.json --output C:\local\new-candidates.json
```

参数次序固定，output 必须不存在。只读显式指定的本机文件，仅写一个新 output；不扫描、不读取报告里登记的原件路径，不连接数据库或网络。原文快照重新 hash 和按原 mapping 标准化，并重新调用 `assessCompleteness`、`planOffline`，报告的 records/status/ready 不作为事实使用。#79 planning-input 的 previousPlan 只是旧规划比较提示，本入口不读取或采用其状态，直接重算当前计划。季度及显式月份 scope 沿用 #78/#79，范围必须完全相同。

```json
{
  "version":"offline-bookkeeping-input/1",
  "planningInput":"planning-input.json",
  "accountingFacts":"accounting-facts.json",
  "profileId":"small-2011-basic-v1",
  "previousCandidates":"previous-candidates.json"
}
```

`previousCandidates` 可省略；其它字段必填，没有默认 profile。planningInput 指向 [#79原有输入](OFFLINE-PLAN.md)，其中 reports 指向 #78 报告快照，declaration 指向原始基础声明，声明未知可为 null。主输入引用相对其所在目录，planning-input 内引用相对该文件所在目录；output 相对当前工作目录。JSON 必须 UTF-8，可带 BOM；每份报告/声明/输入/旧产物最多64 MiB，补充事实最多5 MiB和1000条，来源界限沿用 #78/#79。

退出码0表示新候选文档写出成功，文档内可以有 needs_review 或 conflict；2表示参数错误，4表示输入格式/读取/输出创建拒绝。stdout 仅有 `OFFLINE_BOOKKEEPING_WRITTEN candidates=N review=N conflicts=N` 或固定错误类别，stderr 为空。金额、路径、身份、原始内容和具体补件信息只在本机 output。

## 原始补充事实 schema

顶层严格为 `version:"offline-accounting-facts/1"`、相同 `scope`、`facts` 数组（可为空）。每条必填 `factId`、`kind`、`confirmedBy:{name,role}` 和非空 `basis`。角色为 owner/business_operator/accountant；这只是本机声明及依据，程序不认证人或附件。每条事实以实际文件字节 SHA-256、来源版本、`/facts/N` 及各字段 JSON pointer 追溯；文件内容或 BOM 变化都会改变该来源版本。

以下为三个不同合同的完整结构示例；金额不属于补充事实，全部取原票或银行原字段。示例身份、日期、编号均为合成展示。基础 #78 业务JSON仍需提供与销售/采购票对应的 nature=service、performance=completed、settlement=unpaid、date=实际完成日。invoiceRef 的 code 可为空字符串。

```json
{
  "version":"offline-accounting-facts/1",
  "scope":{"enterpriseKey":"SYNTHETIC-OWNER","accountSetId":"synthetic-book","period":"2026-Q1","currency":"CNY","unit":"yuan"},
  "facts":[
    {
      "factId":"sale-1","kind":"service_sale",
      "confirmedBy":{"name":"合成经办人","role":"business_operator"},"basis":"合同及验收索款记录",
      "invoiceRef":{"sellerKey":"SYNTHETIC-OWNER","code":"","number":"1001"},
      "contractId":"CONTRACT-SALE","serviceStartDate":"2026-03-01",
      "completionDate":"2026-03-12","collectionRightDate":"2026-03-12",
      "mainService":true,"ordinaryService":true
    },
    {
      "factId":"admin-1","kind":"administrative_service",
      "confirmedBy":{"name":"合成经办人","role":"business_operator"},"basis":"合同和行政部门服务验收登记",
      "invoiceRef":{"sellerKey":"SYNTHETIC-SUPPLIER","code":"","number":"2001"},
      "contractId":"CONTRACT-ADMIN","completionDate":"2026-03-15",
      "purpose":"organizational_administration","nonAsset":true,"nonProjectCost":true,
      "benefitFrom":"2026-03-01","benefitTo":"2026-03-31","benefitBasis":"仅本月组织行政日常受益的具体业务依据"
    },
    {
      "factId":"prepay-1","kind":"service_prepayment",
      "confirmedBy":{"name":"合成经办人","role":"business_operator"},"basis":"合同、单次付款及截至期末履约退款核对登记",
      "bankRef":{"bankAccountId":"bank-A","refId":"BANK-PREPAY-1"},
      "contractId":"CONTRACT-FUTURE","supplierKey":"SYNTHETIC-FUTURE-SUPPLIER",
      "serviceStartDate":"2026-04-01","serviceEndDate":"2026-06-30","ordinaryService":true,
      "performanceThroughPeriodEnd":"not_started","refundThroughPeriodEnd":"none",
      "paymentCount":1,"otherRecognitionInProvidedMaterials":"none","relatedInvoiceRefs":[]
    }
  ]
}
```

kind 以外的业务字段可以省略并形成具体补件。保留字段不得传 null 或空字符串替代未知；枚举支持的 unknown 为：purpose=unknown，performanceThroughPeriodEnd=unknown，refundThroughPeriodEnd=unknown，otherRecognitionInProvidedMaterials=unknown。purpose 另可陈述 project/asset/personal，履约可 partial/completed，退款可 refunded，重复确认可 exists；这些不会成为支持候选。布尔 false 表示实际否定，也会形成需审查。日期必须有效且为规范字符串；paymentCount 为整数业务次数。不存在 entries/accountCode/debit/credit/ready/completed/最终税额/客户计算纳税义务日等输入，未知字段或不属于该 kind 的字段拒绝。不能要求客户先制作分录或计算税额。

## 准入与会计边界

三类规则统一仅支持**候选确认日2026-01-01至2026-12-31**；范围外返回具体 unsupported_rule_date 补件/审查。该区间是工程产品支持范围，不是法律有效期或失效日期。预付未来服务起止日可以在2027年，但本片只确认2026支付形成的期末预付资产，未来服务接受时另评估。

行政服务候选的date取补充业务JSON的实际completionDate，并与#78业务date核对；同月发票日可以更早，不能提前到发票日确认费用。规则支持日期门同样使用实际完成日。recognition.dateSource保留completionDate的文件摘要、来源版本与JSON pointer。销售因同日限制使用原票日，预付款使用实际银行支付日，二者也标明原始日期字段来源。

| 类型 | 必须成立的业务条件 | 候选分录 |
| --- | --- | --- |
| 普通主营服务销售 | #78销售蓝票、实际服务在当前scope内开始完成，开票日=完成日=取得收款权利日，未结算；基础声明中会计及登记依据确认小规模身份、申报周期；票面净额与税额均非零 | 借应收账款gross，贷主营业务收入net、应交税费（应交增值税语义）tax |
| 当月行政服务采购 | #78采购蓝票、已完成未付；组织行政日常用途，非资产非项目成本；票/完成/全部受益均在同一月，有受益依据；会计确认小规模身份，不抵扣进项 | 借管理费用gross，贷应付账款gross |
| 期末未来服务预付款 | 稳定账户和流水的实际outflow；供应商及合同对应；期末完全未接受服务、无退款、单次付款；服务在期末后开始且在期末后12个月内结束；已提供资料中无重复确认，明确关联发票清单 | 借预付账款实际支付amount，贷银行存款同额，期末保留资产 |

预付款仅转移资产，无当期费用或进项处理，不依赖VAT身份是否已知；仍需明确小企 profile、企业资料、银行账户归属清单及带依据业务事实。正式明细科目/辅助核算策略留后续接线。缺税属性会阻断销售与费用候选，不连带阻断独立预付款。企业资料缺失/非法、对应发票或银行冲突、账户遗漏、明确无业务声明矛盾均不能越过。期初、历史、工资资产和整期覆盖缺项仍保留在重算计划中，不冒充整期完整。

旧 #79 采购仅就明确 service/completed/unpaid 且用途 unknown/operating_service 的具体用途缺口，允许新充分行政用途与受益事实收敛；已知资产/个人/存货用途、不同受益期、未知核心履约或复杂结算均不能覆盖。银行仅就稳定outflow的旧未知性质，可由充分合同事实补足；已明确 payroll/asset/receipt 的相反性质进入 conflict。同票新旧完成日期及相互矛盾事实必须核对，红字、已收/已付、部分履约、跨月受益、多次付款、退款未知、同合同预付与费用矛盾均需补件/审查，不自动分摊。

预付款 relatedInvoiceRefs 是该合同对应发票的明确清单，空数组表示经确认在已提供资料中没有对应发票；有对应票时必须是同供应商的采购蓝票，并提供service/not_completed事实。销售票、其他供应商、已知goods或资产/存货/个人用途、已知受益期与合同起止不一致均冲突；未知性质/履约或缺对应事实需要具体补件，旧unknown受益期可由本次充分合同起止事实补足。它不是程序查过既存账簿的证明。已有材料中同合同或显式票/付款关系的费用与未履约预付矛盾会阻断双方候选，避免重复确认。不会按银行摘要猜供应商或用途。

## 规则来源与版本

使用 `getAccountingProfile`、`getAccountingRoles` 精确取得 small-2011-basic-v1 的科目表、版本和来源，主营收入与管理费用复用角色。仅本规则固定映射官方小企1122应收、2202应付、1123预付、1002银行、2221税费，并逐一校验profile.coa存在；不猜名称、编码尾号或VAT明细编码。2221候选标注“应交增值税”语义，真实目标明细及aux策略待正式接线。

规则目录 `offline-voucher-rules.mjs` 于2026-10-24核对如下官方来源；来源核对与会计正式审定不同，`accountingApproval:pending`。`productSupportedFrom/Through`记录上述2026工程范围，`legalSourceEffective`另记小企第90条的2013-01-01及增值税法的2026-01-01；财会〔2016〕22号的生效条款本目录未单独核定，from=null，不从通知日期臆填起效日或开放历史业务。这组范围不是所有2026会计税务规则的完整验证。

- [小企业会计准则](https://kjs.mof.gov.cn/zhengcefabu/201111/P020111118325852319878.pdf) 第63条、印刷21页：同一会计年度内开始并完成劳务的收入确认；本片更窄限同scope内开始完成。第7条支持一年内耗用资产范围。
- [会计科目附录](https://kjs.mof.gov.cn/zhengcefabu/201111/P020111118325852734144.pdf)：1122印刷7—8页、1123印刷8—9页、2202印刷37页、5602印刷64—65页。
- [财会〔2016〕22号](https://www.mof.gov.cn/gkml/caizhengwengao/2017wg/wg201703/201707/t20170707_2641107.htm) 二（一）5：小规模进项入成本费用；二（二）1：小规模销售初始税额确认。本片金额来自通过结构/范围校验的票面字段，真实性与合法性未由程序认证，不新增税率运算或舍入。
- [2024-01-23会计司回复](https://www.mof.gov.cn/bd/mhwzzxly/hjs/202401/t20240123_3926932.htm)：事前已知1%可按1%直接初始记账。候选不先按3%再把2%记收益，不判断后续免税收益科目。
- [中华人民共和国增值税法](https://shanghai.chinatax.gov.cn/zcfw/zcfgk/zzs/202412/t474694.html) 2026-01-01施行，第28条（一）。同日原始开票/完成/取得收款权利事实由程序派生同日 vatTriggerDate，不要求客户先计算税法结果；本片销售规则仅2026-01-01及以后。票税是初始应交税额，不是最终申报额或免税结转。

输出包括逐笔 decisions、具体字段请求、规则及官方来源、逐原字段定位、稳定 businessKey 与 contentVersion。发票key锚企业/账套+销方/代码/号码，预付款key锚企业/账套+原始银行账户/流水号；均不含period、contract/supplier、金额、规则或内容版本。合同/供应商更正保持同一预付款key，标明newVersion，不能偷偷新建业务ID。合同关系用于跨流水多次支付和费用/预付冲突检查，不能替代原始交易身份。

previousCandidates 仅作本地内容摘要比较，报告 new/unchanged/newVersion/conflict/withdrawn；文档及候选摘要重新核对，不接受完成或执行回执。不含密钥、身份认证或可信执行凭据，不能复用“已过账”状态。来源重复去重，已知来源冲突即使记录被#79隔离也传递到对应事实；规则目录递归冻结，输出规则副本修改不会污染以后调用。

正式生产写、连续过账、幂等接收、锁及恢复依赖 #54 coordinator 和后续 #79/#80接线。本片不绕过这些依赖；未实现DB/HTTP/MCP/batch或账簿查询，没有既存ledger核验。#77会计审定黄金、#78持久接收、#79正式执行回执、#80正式连续过账仍未完成。

验证：`node test/offline-bookkeeping.test.mjs`，合成真实CSV/JSON并经#78CLI及本CLI生成三类候选；独立期望销售1763.00/17.63/1780.63、行政采购450.81、预付286.47，借贷合计各2517.91。假定期初bank/capital各1000的3231.44试算只存在于工程测试，不是产品输入或会计审定黄金。另覆盖缺项、冲突、scope、原文hash/映射、复杂场景、重复、版本、安全输出、BOM与拒覆盖；不使用真实资料。删除新增文件及交接段即可回退，无数据库迁移。
