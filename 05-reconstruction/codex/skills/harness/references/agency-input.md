# 原生 agency 资料输入

仅在选中 agency 能力后读取。客户提供任意原始布局；以下是 Agent 内部适配合同。路径可相对 manifest 所在目录，必须保留独立原件，不以 Agent 整理JSON或底稿冒充原件。

manifest 为 `{version:"agency-business-materials/1",scope:{enterpriseKey,accountSetId:正整数,databaseInstanceId,period:"2026-03",currency:"CNY"},originals:[{id:"receipt",path:"原件路径",sha256?:"实际摘要"}],sources:[{path:"整理事实JSON路径",sha256?:"实际摘要"}]}`，没有其他顶层字段。sources JSON 为 `{version:"agency-raw-facts/1",scope:同企业账套实例币种的原月份,records:[...]}`；累计来源可承接前月，manifest period 为本次计算月。

每条 record 有 `id/type/date/enterpriseKey/originalRefs`。originalRefs 为 `[{originalId:"receipt",locator:"页/表/行/字段",extractionReason:"为什么此处支持该事实"}]`；原件引用必须存在。每个 manifest 必须有且只有一条 type=entity，包含 entity 对象。公司主体示例字段为 `kind:"company"`（其他主体按实际能力适用条件核验）、industry、profileId、businessStartDate、vatStatus、vatPeriod、vatReliefWaived、incomeLevyMethod、bookkeepingMethod；region仅有原件时提供，缺地区可省略，不能填placeholder。只填原件已支持值，不能照抄示例猜税务属性。具体业务未满足条件会返回 issues，不能反向伪造事实消除它。

原生枚举：`vatStatus:"small"|"general"`（不是 small_scale）；`vatPeriod:"monthly"|"quarterly"`（不是 month/quarter）；`vatReliefWaived` 是原件支持的 boolean。支持行业枚举为 service/trade/ecommerce/catering/manufacturing/construction/transport/rental_property，不能用行业名替代税务认定。小企业公司示例主体为 `{kind:"company",industry:"service",profileId:"small-2011-basic-v1",businessStartDate:"2026-01-01",vatStatus:"small",vatPeriod:"monthly",vatReliefWaived:false,incomeLevyMethod:"actual_accounts",bookkeepingMethod:"double_entry"}`；仅当这些字段各自有原件依据时采用。

上述只是record内部的entity对象，不能直接当一条record。完整结构示例（仅当原件明确记载2026-01-01成立/登记事件时）：`{id:"entity-registration",type:"entity",date:"2026-01-01",enterpriseKey:"实际企业",originalRefs:[{originalId:"registration",locator:"原件成立/登记日期与主体属性字段",extractionReason:"该原件明确支持本记录日期和主体属性"}],entity:{kind:"company",industry:"service",profileId:"small-2011-basic-v1",businessStartDate:"2026-01-01",vatStatus:"small",vatPeriod:"monthly",vatReliefWaived:false,incomeLevyMethod:"actual_accounts",bookkeepingMethod:"double_entry"}}`。外层date必填，内层businessStartDate不替代它；两者相同也必须各有该原件事件的依据，不能自动拷日期或因是月初就填1日。缺实际日期时保留缺项/补件，不把不完整entity塞进可计算bundle。每条raw record禁止输入sourceRefs；只输入originalRefs，由原生生成追踪sourceRefs。

`record.date` 是有原件支持的完整实际日期 `YYYY-MM-DD`，须为真实日历日期、归属于实际业务月；不是仅填YYYY-MM。缺日不能用月初/月末占位，不得把猜填的date写入可执行manifest，即使另有一个missing事实也不能冲销这个假值。保留原件中的月份事实，在Harness独立缺项/冲突分支请求实际日期；该未决record不进入当前可计算bundle。产生分录的每条业务还必须带 `businessIdentity:{issuerKey:"原始出具方身份",documentNumber:"原合同/票/收据号",event:"该原始事件标识"}`；不同事件不可复制同一完整身份。

普通咨询服务的记录形状示例（不是客户事实）：`{id:"service-1",type:"service_complete",date:"2026-03-24",enterpriseKey:"实际企业",taxJurisdiction:"domestic",specialVatTreatment:"ordinary",businessIdentity:{issuerKey:"实际销方",documentNumber:"实际合同/票号",event:"service_complete"},accepted:true,collectionRight:true,work:[{units:"2",unitPrice:"100.00",priceIncludesVat:false}],invoiceKind:"ordinary",settlement:"unpaid",originalRefs:[...]}`。金额由已有规则计算；原件无验收/索款权、结算状态或税务性质时保留缺项，不套示例。

行政服务费用完整结构示例为 `{id:"expense-1",type:"expense",date:"2026-03-20",enterpriseKey:"实际企业",businessIdentity:{issuerKey:"实际供应商",documentNumber:"实际收据号",event:"expense"},use:"admin",gross:"37.23",net:"37.23",invoiceTax:"0.00",inputVatTreatment:"non_deductible",settlement:"unpaid",benefitPeriod:"2026-03",originalRefs:[...]}`。必要金额关系 net+invoiceTax=gross；use可选 admin/sales/service/transport/production/contract/rental，inputVatTreatment为 deductible/non_deductible，settlement为 paid/unpaid，benefitPeriod须等于实际date所在月。资产/项目/跨期不能无依据选 admin；taxNature等税会判断仅有依据时补充，不是绕过缺件的标签。

可计算bundle只包含本次已具备完整必要字段的record；这不表示客户整体资料已齐。服务工时冲突应登记Harness `state:"conflict"` 和来源，保留对应任务/补件，不要塞一条缺work/units的service_complete进ready sources试图让程序猜值。已知费用可由独立workpaper或企业处理分支继续；补件后再登记已核工时并加入受影响bundle，整张DAG仍保留未决任务。无覆盖清单不得造 period_coverage.complete 或 obligation_inventory.activities.present=false。原件未涉及事项保留 missing/unknown；超出现有规则的事项用企业处理草稿与验证，不扩大支持范围。

地区是独立记录 `type:"tax_location",classification:"city"|"county_town"|"other"`，缺地区时不生成该记录。实缴是独立 `type:"tax_payment",amount,obligationId,assessmentPeriod/assessmentYear` 及真实银行/完税身份；应纳或计提结果不构成税款支付记录。

中文原件不需改成英文模板。绑定可声明有限转换 `transform:"tax-location-classification-v1"`，精确原文“市区/县城/镇/县城镇/其他地区”映射既有 city/county_town/other。例原件第2行为“登记所在地：市区”，定位 `{startLine:2,endLine:2,startColumn:7,endColumn:8}`、quote="市区"；列按1基Unicode码点且end含。`tax-payment-document-kind-v1` 仅把“税收完税证明/银行税款扣缴回单/税款缴款回单”映射 tax_payment，不接受“应纳税计算单/计提凭证”；`tax-obligation-id-v1` 仅把“企业所得税/增值税”映射当前 corporate_income/vat，其他税种ID不推断。支付类别、日期、金额、税种、所属期与银行/完税身份分别定位；文档类别文字本身仍不是无误语义保证。

MCP 关键值支持：originalRefs 可加 `bindings:[{valuePath:"/classification",locator:{jsonPointer:"/registration/location/classification"}}]`，只访问该 originalId 对应原件。文本精确行绑定为 `{valuePath:"/amount",locator:{startLine:8,endLine:8},quote:"54.73",format:"decimal"}`；不得用“在页中找到金额”推断款项性质。结构原件兼容原 originalRef.locator 为 `/records/0` 时，MCP按该对象下同名字段精确核值。tax_location 检 classification；tax_payment 检 amount、obligationId 和已提供所属期/支付身份字段。若原件使用中文地区等描述，须先保留原值为原件事实，再记录映射方法及核验；不能把英文枚举写回原件伪造支持。

月度底稿从 `receipt.actualImpact.domain` 读 accounting/obligations/issues，详情分段读取。obligations 的 due、paid、difference、paymentState 各自独立；会计计提从真实会计分录/对应 accountingAccrual 取值，不把 due 当已缴。`payment_evidence_missing` 即无缴款证据，paid=0 只是已提供清单内未识别到实缴，不宣称客观上永未缴款。


