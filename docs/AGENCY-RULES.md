# 代账规则 Wiki

此页由 `renderAgencyRuleWiki()` 从结构化登记生成。先取按需目录或当前底稿规则轨迹，再读取一个规则详情；无需模型通读法规或挑选税率。

唯一目录：[agency-rule-catalog.mjs](../06-workbench/server/agency-rule-catalog.mjs)；地区参数复用 [agency-regional-rules.mjs](../06-workbench/server/agency-regional-rules.mjs)；实际公式仍在既有会计/税费函数。法律有效期与本实现支持期（2026—2027）分开。地区参数与国家义务/减免组合，不能相互覆盖。

## 使用入口

在 `06-workbench` 运行：

```text
node scripts/agency-business.mjs rules [filters.json]
node scripts/agency-business.mjs rule <ruleId> [revision]
node scripts/agency-business.mjs match-rules <manifest> [workbench.db]
node scripts/agency-business.mjs policy-sources [filters.json]
node scripts/agency-business.mjs policy-validate <candidate.json>
node scripts/agency-business.mjs policy-register <absolute-name.agency-policy.jsonl> <candidate.json>
node scripts/agency-business.mjs policy-list <absolute-name.agency-policy.jsonl> [filters.json]
node scripts/agency-business.mjs policy-impact <candidate.json> [enterpriseKey]
```

目录和候选列表默认20条、最多50条；候选用candidateId按需读详情，match-rules仅前5个事实ID和有界原因/问题摘要，完整追溯留在原底稿。目录筛选字段为 `ruleId/obligationId/kind/region/entityKind/from/through/offset/limit`。`match-rules` 调用真实只读底稿重放，返回 matched、missing、not_applicable、unsupported 或 conflict，matched 仅代表该实际分支，申报缴费仍由人核对。

候选只追加到显式本机文件，不进入活动目录，不接受代码、税率或参数覆盖。`policy-validate` 仅校验结构，不声称已抓取核实原文。`policy-impact` 只分析规则/地区/业务期间，未扫描账套或资料。未来政策更新需核官方效力、验证并经Git/PR更新；旧版本留历史，企业特例不得自动跨企。无需启动定时任务。

候选JSON字段：`title/source/affectedRuleIds/regions/changeKind/scope/reason/supersedesCandidateId?`。source为 `url/title/documentNumber(无文号填null)/issuer/issuedOn/publishedOn/effectiveFrom/effectiveThrough/locators`；changeKind为 amend、replace、expire、add_scope 或 clarify；scope为 `{kind:"public"}` 或 `{kind:"enterprise",enterpriseKey:"..."}`。

## 按需规则导航

| 规则ID | 内容 | 实际入口 | 验证范围 |
|---|---|---|---|
| agency.accounting.service | service会计及成本 | [server/agency-business-rules.mjs](../06-workbench/server/agency-business-rules.mjs)：evaluateAgencyAccounting | reviewed_baseline_selected_branches |
| agency.accounting.trade | trade会计及成本 | [server/agency-business-rules.mjs](../06-workbench/server/agency-business-rules.mjs)：evaluateAgencyAccounting | reviewed_baseline_selected_branches |
| agency.accounting.ecommerce | ecommerce会计及成本 | [server/agency-business-rules.mjs](../06-workbench/server/agency-business-rules.mjs)：evaluateAgencyAccounting | reviewed_baseline_selected_branches |
| agency.accounting.catering | catering会计及成本 | [server/agency-business-rules.mjs](../06-workbench/server/agency-business-rules.mjs)：evaluateAgencyAccounting | reviewed_baseline_selected_branches |
| agency.accounting.manufacturing | manufacturing会计及成本 | [server/agency-business-rules.mjs](../06-workbench/server/agency-business-rules.mjs)：evaluateAgencyAccounting | reviewed_baseline_selected_branches |
| agency.accounting.construction | construction会计及成本 | [server/agency-business-rules.mjs](../06-workbench/server/agency-business-rules.mjs)：evaluateAgencyAccounting | reviewed_baseline_selected_branches |
| agency.accounting.transport | transport会计及成本 | [server/agency-business-rules.mjs](../06-workbench/server/agency-business-rules.mjs)：evaluateAgencyAccounting | reviewed_baseline_selected_branches |
| agency.accounting.rental_property | rental_property会计及成本 | [server/agency-business-rules.mjs](../06-workbench/server/agency-business-rules.mjs)：evaluateAgencyAccounting | reviewed_baseline_selected_branches |
| agency.reports.profile-mapping | 账套准则及报表映射 | [server/accounting-report-rules.mjs](../06-workbench/server/accounting-report-rules.mjs)：evaluateAccountingStatement | reviewed_baseline_selected_branches |
| agency.annual.raw-calculation | 全年原件税会调整计算 | [server/agency-business.mjs](../06-workbench/server/agency-business.mjs)：buildAgencyAnnualWorkpaper | reviewed_baseline_selected_branches |
| legacy.vat.selected-q1-q2 | 独立Q1/Q2选定表栏工程规则 | [server/tax-rule-registry.mjs](../06-workbench/server/tax-rule-registry.mjs)：getVatRules/getVatQ2Rules | separate_suite |
| agency.tax.vat | 增值税 | [server/agency-tax-rules.mjs](../06-workbench/server/agency-tax-rules.mjs)：calculateAgencyObligations | reviewed_baseline_selected_branches |
| agency.tax.vat_prepayment | 增值税预缴 | [server/agency-tax-rules.mjs](../06-workbench/server/agency-tax-rules.mjs)：calculateAgencyObligations | reviewed_baseline_selected_branches |
| agency.tax.corporate_income | 企业所得税 | [server/agency-tax-rules.mjs](../06-workbench/server/agency-tax-rules.mjs)：calculateAgencyObligations | reviewed_baseline_selected_branches |
| agency.tax.business_income | 经营所得 | [server/agency-tax-rules.mjs](../06-workbench/server/agency-tax-rules.mjs)：calculateAgencyObligations | reviewed_baseline_selected_branches |
| agency.tax.salary_withholding | 工资薪金扣缴 | [server/agency-tax-rules.mjs](../06-workbench/server/agency-tax-rules.mjs)：calculateAgencyObligations | reviewed_baseline_selected_branches |
| agency.tax.other_withholding | 其他个人款项扣缴 | [server/agency-tax-rules.mjs](../06-workbench/server/agency-tax-rules.mjs)：calculateAgencyObligations | reviewed_baseline_selected_branches |
| agency.tax.urban_maintenance | 城市维护建设税 | [server/agency-tax-rules.mjs](../06-workbench/server/agency-tax-rules.mjs)：calculateAgencyObligations | reviewed_baseline_selected_branches |
| agency.tax.education_surcharge | 教育费附加 | [server/agency-tax-rules.mjs](../06-workbench/server/agency-tax-rules.mjs)：calculateAgencyObligations | reviewed_baseline_selected_branches |
| agency.tax.local_education | 地方教育附加 | [server/agency-tax-rules.mjs](../06-workbench/server/agency-tax-rules.mjs)：calculateAgencyObligations | reviewed_baseline_selected_branches |
| agency.tax.stamp | 印花税 | [server/agency-tax-rules.mjs](../06-workbench/server/agency-tax-rules.mjs)：calculateAgencyObligations | reviewed_baseline_selected_branches |
| agency.tax.property | 房产税 | [server/agency-tax-rules.mjs](../06-workbench/server/agency-tax-rules.mjs)：calculateAgencyObligations | reviewed_baseline_selected_branches |
| agency.tax.urban_land | 城镇土地使用税 | [server/agency-extended-tax-rules.mjs](../06-workbench/server/agency-extended-tax-rules.mjs)：calculateAgencyExtendedTax | selected_branches_selftested |
| agency.tax.vehicle_vessel | 车船税 | [server/agency-extended-tax-rules.mjs](../06-workbench/server/agency-extended-tax-rules.mjs)：calculateAgencyExtendedTax | selected_branches_selftested |
| agency.tax.consumption | 消费税 | [server/agency-extended-tax-rules.mjs](../06-workbench/server/agency-extended-tax-rules.mjs)：calculateAgencyExtendedTax | selected_branches_selftested |
| agency.tax.resource | 资源税 | [server/agency-extended-tax-rules.mjs](../06-workbench/server/agency-extended-tax-rules.mjs)：calculateAgencyExtendedTax | selected_branches_selftested |
| agency.tax.water_resource | 水资源税 | [server/agency-extended-tax-rules.mjs](../06-workbench/server/agency-extended-tax-rules.mjs)：calculateAgencyExtendedTax | selected_branches_selftested |
| agency.tax.environment | 环境保护税 | [server/agency-extended-tax-rules.mjs](../06-workbench/server/agency-extended-tax-rules.mjs)：calculateAgencyExtendedTax | selected_branches_selftested |
| agency.tax.deed | 契税 | [server/agency-extended-tax-rules.mjs](../06-workbench/server/agency-extended-tax-rules.mjs)：calculateAgencyExtendedTax | selected_branches_selftested |
| agency.tax.land_appreciation | 土地增值税 | [server/agency-tax-rules.mjs](../06-workbench/server/agency-tax-rules.mjs)：calculateAgencyObligations | reviewed_baseline_selected_branches |
| agency.tax.farmland_occupation | 耕地占用税 | [server/agency-extended-tax-rules.mjs](../06-workbench/server/agency-extended-tax-rules.mjs)：calculateAgencyExtendedTax | selected_branches_selftested |
| agency.tax.vehicle_purchase | 车辆购置税 | [server/agency-tax-rules.mjs](../06-workbench/server/agency-tax-rules.mjs)：calculateAgencyObligations | reviewed_baseline_selected_branches |
| agency.tax.customs | 关税及进口相关税 | [server/agency-extended-tax-rules.mjs](../06-workbench/server/agency-extended-tax-rules.mjs)：calculateAgencyExtendedTax | selected_branches_selftested |
| agency.tax.cultural_construction | 文化事业建设费 | [server/agency-tax-rules.mjs](../06-workbench/server/agency-tax-rules.mjs)：calculateAgencyObligations | reviewed_baseline_selected_branches |
| agency.tax.union_funds | 工会经费 | [server/agency-tax-rules.mjs](../06-workbench/server/agency-tax-rules.mjs)：calculateAgencyObligations | reviewed_baseline_selected_branches |
| agency.tax.tobacco | 烟叶税 | [server/agency-extended-tax-rules.mjs](../06-workbench/server/agency-extended-tax-rules.mjs)：calculateAgencyExtendedTax | selected_branches_selftested |
| agency.tax.vessel_tonnage | 船舶吨税 | [server/agency-extended-tax-rules.mjs](../06-workbench/server/agency-extended-tax-rules.mjs)：calculateAgencyExtendedTax | selected_branches_selftested |
| agency.tax.social_insurance | 社会保险 | [server/agency-tax-rules.mjs](../06-workbench/server/agency-tax-rules.mjs)：calculateAgencyObligations | reviewed_baseline_selected_branches |
| agency.tax.housing_fund | 住房公积金 | [server/agency-tax-rules.mjs](../06-workbench/server/agency-tax-rules.mjs)：calculateAgencyObligations | reviewed_baseline_selected_branches |
| agency.tax.disability_fund | 残保金 | [server/agency-tax-rules.mjs](../06-workbench/server/agency-tax-rules.mjs)：calculateAgencyObligations | reviewed_baseline_selected_branches |

## 地区参数与历史

地区参数按目录 `kind=regional_parameter` 与真实标的所在地/业务日期查询；只有列明税费和分支，不代表该地区全税种覆盖。地区详情记录来源形式、有效期及替代关系；辽宁2023起、上海2026续期均保留原版本边界。来源与有公式、金额验收和完整业务链验收是不同状态。

旧 `tax-rule-registry.mjs` 的Q1/Q2工程范围独立，不能把其整元等限制套给agency。报表复用原profile/report registry，年度只引用现全年计算入口。

缺项不会当零；实际命中/排除/冲突与catalog digest留在底稿，原件与代码仍由原审计链归档。
