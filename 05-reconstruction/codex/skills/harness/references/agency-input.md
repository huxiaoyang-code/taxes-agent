# 原始业务与直接整理输入

客户提供任意原始布局，Agent只整理原件支持的字段。原件与派生记录分开，字段合同和示例用`finance_record_contract({recordType:"实际类型"})`按需取得；本文件不维护第二套全量schema。

## 选择输入载体

`finance_workpaper`和`finance_tax_calculate`使用以下三种形状之一，不混用；正常业务优先第一种：

- 已核账套的直接资料：`{target:{accountSetId,period:"实际YYYY-MM"},originals:[{id,path,sha256?}],records:[原件支持的记录],dbPath?}`。`accountSetId`取实际已核账套，后台从`FINANCE_DATABASE_PATH`或明确`dbPath`绑定真实`enterpriseKey/databaseInstanceId`；records中的`enterpriseKey`可省略，显式冲突会拒绝。客户不需提供内部实例身份，也不用先建manifest。
- 已有原生材料：`{manifestPath:"实际绝对路径",dbPath?:"实际账库绝对路径"}`。
- 显式身份兼容资料：`{scope:{enterpriseKey,accountSetId,databaseInstanceId,period:"实际YYYY-MM",currency:"CNY"},originals:[{id,path,sha256?}],records:[原件支持的记录],dbPath?}`。工具自动保存整理输入和材料清单，不先登记来源、事实或运行图。

税费工具可用`obligationIds`选择需核税费。target/兼容scope和原件必须对应真实目标；业务记录可跨原始月份时按工具实际合同处理。月、季度和全年资料覆盖不得互相冒充。

每条记录有`id/type/date/originalRefs`；优先target路径由后台绑定记录的`enterpriseKey`，显式scope兼容路径须包含该字段。`originalRefs`使用`originalId/locator/extractionReason`关联本次原件，定位到页/表/行/字段并说明支持关系。金额使用人民币元十进制字符串，数量单位独立；不在记录中输入程序生成的`sourceRefs`。

`date`须有原件支持的真实完整日期。只有月份时不填月初月末；缺件写入报告，不生成假完整记录。产生分录的记录依真实schema提供`businessIdentity:{issuerKey,documentNumber,event}`，不得用技术占位当已核客户身份。必须有唯一主体entity，纳税身份、准则、启用日期和申报频次分别有据，不能照抄例子。

## 常见类型与容易混淆的字段

| 业务 | 实际record.type | 核对要点 |
|---|---|---|
| 期初库存 | opening_inventory | 实际盘点、数量、成本和重放起点；不是opening_stock |
| 采购 | purchase | 商品/类别、数量、原发票价税、用途、结算及认证实际日；不是goods_purchase |
| 销售 | sale | 交付、索款、发票、数量单价和税务性质；不是goods_sale |
| 退货 | sale_return | 原销售行、红字/原票、实际入库；指定采购批次用真实`lines[].originalPurchaseId`；不是sales_return |
| 收款 | collection | 原销售关联、银行账户、唯一流水身份和金额 |
| 付款 | supplier_payment | 原采购关联、银行账户、唯一流水身份和金额 |
| 费用 | expense | 实际use、gross/net/invoiceTax、inputVatTreatment、settlement和benefitPeriod |
| 合同 | contract | 法定税目、金额列示和资格；`separatelyStatedVat`为boolean，不是税额 |

销售配送费用对应有据的`use:"sales"`；`transport`指运输业务履约成本，不因单据写“运费”就选择它。采购入库运费、销售费用、资产和跨期对象须分开判断。`paid/unpaid`、抵扣资格和认证日均需事实支持，缺失不能默认。

覆盖清单、无业务和优惠资格不是消除issues的标签。不能因仅传了可计算记录就造`period_coverage.complete`，也不能因原件未提到某税费就声称不适用。汇总收付款可支持模型参考余额，却不能虚构逐笔核销、银行账户和流水编号。

## 结果与深入核对

正常结果先给金额、凭证/计算计数和规则；完整原名、分录、输入和原件留在本机review文件与索引。沿实际返回的opaque引用查看，不推测文件路径。每笔关键金额区分原生工具、模型推导和待核，遵守[报告顺序](reporting.md)。证据定位与哈希匹配不能代替业务语义复核。

## 合同披露完整度

`finance_record_contract`可发现当前全部原生类型（数量以实际返回为准），按需返回`contractCompleteness`、字段、示例和真实规则定位。`verified_fields_with_conditional_native_validation`表示已核字段说明，仍受原生条件校验；`common_schema_and_rule_references_only`表示目前只有通用结构及规则引用，专用字段未完整披露，不能解释为引擎不支持。没有示例也不等于没有算法。无法据合同安全构造输入时具体记录披露缺口，不猜参数。`inputRole:native_generated_only`仅供原生生成，不由Agent伪造。

全年工具仍使用`manifestPaths`兼容入口；同一主体事实跨月份应引用同一原件和事实文件，不把相同ID复制为不同来源版本。示例中的内部企业字段用于显式身份形状，target路径可省略；不将示例占位词当真实身份。
