# 综合分析：可选只读步骤

在当期相关账务和税费分支已有可用数据时，发现 `analysis.comprehensive`。它是可选 DAG 步骤，适合会计和用户查看、复核；不要求先关账或宣称整期完成。用 `dependsOn` 绑定本 Store 必需的核算/税费任务，跨期任务用已有 `externalDependencies` 的真实版本。缺失的独立分支可以保留缺项草稿；不要把必要依赖伪装成已完成。月度 CNY 为一期调用范围；历史可跨年，但原生 agency 的年份/行业/税种限制保留。季/年分析编排一期未支持。

步骤提示词：

> 核实企业、账套、实例及分析期间。读取当前和所选历史的原生账表、相关原件/税费底稿、未决任务与复核状态。只根据已提供事实形成风险疑点、缺项/期限/政策提醒、具体异常应对，以及老板已提供方案的可分析比较。每项写明 scope、期间、事实、精确证据引用、未解释部分、需补证、建议动作和待复核状态。收款、收入、开票、应纳、计提与实缴分开；历史应收回收不按本期收入处理。缺资料、冲突和不支持明确标示，不补零；异常不认定违法，不虚构业务或倒推账目。提交当前版本给会计和用户复核；上游变化后先看状态、重绑重算再复核。

内部请求（由 Agent 核实编制，客户不需最终指标/分录）：

```js
{
  target: {dbPath:"<absolute existing workbench.db>", databaseInstanceId:"<actual>", enterpriseKey:"<actual>", accountSetId:1},
  historyPeriods:["2026-01"],
  manifestPaths:["<absolute existing agency-business-materials/1 manifest>"],
  contextPath:"<absolute analysis-context/1 JSON, optional>"
}
```

只必须提供真实 target；其他三项按资料可用性选择。historyPeriods 最多24个不重复、启用期间之后且不晚于当前的月份；当前月份自动纳入。manifestPaths 最多25份、各期唯一、仅属于所选历史/当期，直接用现有原件 manifest，不传预计算报告或模型自报金额。没有原件底稿时税费/发票保留缺项。原生利润表及现金流报告的 unsupported/不完整状态原样保留，账簿映射完整不证明业务覆盖或原件真实性。资金一期读取已过账账面银行凭证；真实银行账户全集、流水和对账须用既有银行能力核实，不能把账面零收款称无真实资金活动。

选中该能力时返回 `supportingFileSchemas.contextPath`，与执行时的 JSON Schema 是同一合同；结构错误返回具体字段和非敏感诊断，不需要为补字段调查源码。原件重放利润比较还要求原生 accounting 非 incomplete、无未决税费损益依赖、覆盖及账簿口径一致；否则显示 comparison-gap，完整差额为 null。

可选 `analysis-context/1`：`{version,scope,collectionMappings?,reminders?,ownerPlan?}`，scope 是完整 Harness 月度 scope。它是由原件提取的说明文件，不授予人审/写账/税务权限。登记请求、原件及派生事实时复用既有 source/facts evidence；将实际使用的来源与推导事实纳入 task.factIds。不要仅把 providedBy 标签当老板授权。

- `collectionMappings:[{receiptVoucherId,originVoucherId,amount:"202.00",reason,sourceRefs:[{path:"<原件绝对路径>",locator:"<具体页/行/字段>"}]}]`：实际凭证必须属于本账套，原应收早于回款，金额不超出原借方及回款贷方。仅支持简单两行银行借/应收贷凭证；混合凭证、超额和冲突保留未解释，不按比例分摊。提供核销原件仍不证明真实性/语义已审定；未映射的应收贷方只列回款候选，不认定来自历史某期。
- `reminders:[{kind:"missing|conflict|unsupported|deadline|policy_condition",content,period,requestedEvidence,dueDate?:"YYYY-MM-DD"}]`：仅所选期间。日期是提供的待核事项，不由模型猜当前法定期限。
- `ownerPlan:{providedBy:"owner",owner,futurePeriod:"YYYY-MM",sourceRefs:[{path,locator}],assumptions:["明确假设"],scenarios:[{name,collections:[{originVoucherId,amount:"100.00"}]}]}`：至少两个老板实际提出的方案，最多8个。原始老板指示与核销材料单独保存，不能以 context 自引充当原件。路径/原件摘要和定位会被记录；语义和实际授权仍待复核。

规划一期只比较未来回收已确认应收本金的方案。逐笔核对实际应收借方、已提供历史回款分配和未分配应收贷方；冲突/缺项方案的现金及利润值保持 null。条件包括无新增履约、折扣、坏账转回、利息和外汇；需要实际核实。满足这些条件时只显示预计回款现金与权责发生新增收入/税前利润为零。**税费影响、税后现金始终 unsupported/null**：现有回款模型不能核实原税点、历史申报与缴款，不提供随填税率的税务规划。新投资、成本方案、融资、组织形式及广行业税种规划一期未支持，保留明确缺口。

结果每条 finding 自带 scope、内容、facts、evidenceRefs、missingOrUncertain、suggestedActions、review；调查项另有 responseOptions，列已有依据、未决问题、补证和可选步骤。可选原件底稿提供税费、发票/履约/跨期线索；同口径且原件覆盖可用时比较原件重放与账簿利润差额，差额原因仍待调查。不要把差额直接定性漏报或违法。

调用沿用 `harness_plan` / `harness_run`，从默认摘要的 details 用 `harness_receipt_read` 读取 `/receipt/actualImpact/findings` 或 `/receipt/actualImpact/metrics`。会计逐条查看后用既有 `harness_feedback` 绑定真实 task targetVersion/dependencyDigest；一期反馈为整份分析任务，单项 review.pending 是原始草稿快照，查看是否已复核须以当前 task 的 reviewState/confirmationCurrent 为准。若只接受部分结论，保留其余未决说明，不把整份接受当成问题解决或业务入账。

`harness_status` 重读来源、账务和固定规则/代码。已知字节变化即使使新材料无法解析，也使旧结果永久失效；暂时无法读取为不可核验，不能展示为当前有效。恢复旧字节不复活旧确认，须显式重算/重新反馈。保留历史回执；外部正式回复、申报更正、缴款和写账仍走既有工具、权限和确认流程。

账表分析的原生快照截止当期，所选历史不混入未来凭证。有 agency 底稿时，沿用其原生资产上下文的全账套目标摘要；同企未来期变化可能保守地使分析过期，仍须重算，不能裁掉摘要以保持旧确认。其他企业账务不进入本企业结果。

合成验证：`node test/comprehensive-analysis.test.mjs`（工作目录 06-workbench）。它验证真实 stdio MCP 与临时账库，不是模型自主分析、真实会计审定或真实企业试用。
