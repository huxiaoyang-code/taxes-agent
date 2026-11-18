# 通用原件读取与Agent适配

仅在陌生表头、主体未核、XLS／PDF／扫描件或历史只在原件中时读取。先用 `finance_record_contract({recordType:"baseline"})` 取得当前需求与映射合同。

## 正常入口

1. `finance_baseline_materials({target,section:"structure"})` 列出授权目录的真实原件引用及实际读取状态。执行所选 `sourceInventory.items[].next.arguments`，按不透明 `originalRef` 取得结构，不凭文件名猜内容；常规已知字段仍可 `extractKnownFields:true` 批读。
2. 结构给原表头的安全标签、类型、表／页／行位置及 `md:` 字段引用，原始金额、主体名、税号和全文留本机。普通分页沿 `pagination.next`；单份原件更多结构沿 `structureNext`、PDF更多页沿 `pageNext`，不把未返回页当缺失。
3. 由Agent选择字段含义：`selections:[{id,originalId,field,locator}]`。定位支持 `fieldRef`、JSON Pointer、表格 `sheetIndex/row/column/headerRows`、文本 `page/line/start/end`；字符区间是0基、end不含。陌生标签无需先加入固定词典；原值由程序在本机重读，日期和金额不由模型重写。
4. 原文需要业务解释时，可给 `interpretation:{value,reason}`，仅限当前字段允许的枚举或布尔。返回与存储明确标为 `model_interpretation`，它不等于原件明示政策、人审或写账批准；不能用解释覆写金额、日期、业务号，不能把错误税额阶段洗成应纳。
5. 同一原件只有一个实际业务号时，程序可用真实 `business_reference` 将跨行／跨页合同或键值发票关联。出现多个业务号时保持歧义及原分组；`group`字符串不用于任意拼接。材料只包含发票或税表时，不凭它们推造成本方法或历史归集。

## 主体与原件历史

发票有购销双方。已知表头可自动识别角色；陌生布局显式指定 `ownerIdentity:{role:"buyer"|"seller"|"enterprise",name:locator,taxId?:locator}`，可放原件项或单条selection。程序和账库受信登记比对，不要求把交易对手删掉。实有登记税号时优先税号；现库没登记则明确 `taxIdAvailability:not_registered`，使用受信登记名称，不能把 `enterpriseKey` 当税号。同名跨主体、双侧同时匹配或真实矛盾仍待核。普通明细表逐行核归属，某行匹配不证明别行归属。 主体未核时，`identity.registeredNameAvailable:false` 且 `reason:registered_identity_missing` 表示账库尚无可用受信登记，先核实企业绑定；`source_owner_unmatched` 表示登记已存在但原件匹配未成。两者都不是客户没提供文件，也不能靠反复换表头或拿显示账套名自证解决。

历史只在原件里时，用 `historicalRows` 映射实际 `period`、可选 `date`、`businessReference`、科目 `code`／`accountName`、`debit`、`credit` 的原件位置。程序读取值并按实际科目与业务号关联；未知科目保留诊断，不拿它支持归类。此路径生成 `observed_history`／`source_history_inference`，不写正式凭证、不冒称账库已过账。缺少历史处理依据时保留准确缺口，不能用只读入配置或发票证明完整基线。

每项来源保留原件SHA、原始位置、实际提取器及版本；模型解释另列，派生提取件不当作独立原件。选中公式或错误单元格不可作为已核值；同文件其他普通单元格继续可用。

## 本机环境与后续消费

JSON／CSV／TXT／MD由本机读取；XLS／XLSX／PDF／DOCX及图像按实际Python包与本机OCR能力处理。显式 `FINANCE_PYTHON_PATH` 优先，其次检查本机已存在Python；不自动安装或上传原件。没有可用运行时、格式不支持及OCR未完成分别披露，不把读失败写成客户缺件。

适配后的规范事实仍由现有基线保存与 `calculationReader` 消费；账前输入的 `bindings[].locator` 可直接绑定相同格式原件，保留原件与提取过程。特殊布局需要代码时使用已授权的正常计算工具留痕；脚本执行器不是操作系统沙箱，不扩大本次原件目录或资料外发授权。旧财税计算与正式写账审核保持原流程。

仅准则／行业标签加有效历史税负时，`generationBasis:configuration_and_tax_reference`、`businessPrinciplesMissing:true` 表示业务处理原则尚未生成，保持 `needs_review`；有效税负参考继续沿用，只补受影响业务规则，不因此重读全目录或重复计算税负。无需凑最低条数或强制每类业务齐全。
