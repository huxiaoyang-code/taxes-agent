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

## 读取失败时自主恢复

先区分参数错误、某份原件未读入与真实缺资料。`invalid_arguments`／`finance_input_invalid` 的 `details.problems` 给当前合同允许的字段位置、校验原因和修正提示；对照实际 `tools/list` 修正请求，不重复提交同一无效参数。未知动态键不会原样回显。

单份原件失败不作废其他已读材料。`sourceFailures` 给安全摘要和指向 `coverage` 的真实 `next`，完整诊断按需续页；根据其中的 `code/stage/recoverable/originalRef` 调查相关来源，不猜文件路径、不把失败计数写成客户缺件。先继续有证据的部分；可恢复的编码、旧系统导出或布局问题，由Agent选现有本机方法解决。

内置读取确有障碍、需要脚本读取历史行时：

1. 沿失败回执的真实导航调用 `finance_record_contract({recordType:"baseline_adaptation"})`，取得 `reference`、完整 `outputSchema` 和执行边界。该合同仅在需要恢复时加载，普通映射不必展开。完整schema含共享 `$defs/$ref`，不要截取子树当作独立schema。
2. 使用已有、实际绑定当前账库／企业／账套／本期的会话。`--prepare-only` 通过正常宿主入口完成绑定，不手写会话文件。用现有 `finance_calculation_run`，填写真实 `title/engine/script`，来源使用 `sources:[{originalRef}]`；不构造缺脚本的计算请求，也不要求客户先转成内部JSON。
3. 脚本从 `input.sources[].snapshotPath` 读取执行器实际采用的获准字节，按文件实际编码和结构选择解析方法。只输出支持当前判断所需的少量历史行到 `input.outputDir/baseline-history.json`，原值与完整正文不写stdout/stderr或回灌模型。产物版本为 `finance-baseline-history-adaptation/1`，最多40行；每行含 `id/sourceIndex`、`period/businessReference/debit/credit` 和 `owner.name`，可附实际 `date/code/accountName/owner.taxId`。每个值均附原件定位；以当前完整schema为准。
4. 适配产物的位置只允许三种互斥形式：数字 `sheetIndex?/row/column`、同记录的 `jsonPointer`，或 `page/line/start?/end?`。每行的企业身份与所有值必须来自同一原件记录，不能用总表抬头替另一行作证；缺日日期就省略，保留月粒度。普通原生映射的 `fieldRef/headerRows` 等参数不套进此产物。宏、外链、加密及主体冲突等既有准入限制不能借脚本适配绕过。
5. 成功执行后，取真实MCP回执的 `_meta.financeCall.callId`，调用 `finance_baseline_materials({target,adaptation:{callId,output:"baseline-history.json"}})`。这是有执行证据的脚本观察，不能自证原值已原生核验、账库已过账、政策或人审。再经正常 `materialRefs` 合并独立读取的合同／业务材料及税费依据；只有不同原件SHA、实际同一业务号和已核条件共证，才会形成可保存的历史推断。重复引用同一物理行不增加证据，失配或无共证的观察不强推成业务原则。

交付前核恢复的实际作用：成功材料是否保留、所选行及业务号是否与独立依据关联、保存闭包是否包含恢复回执、来源或脚本产物改变后哪些规则受影响。执行成功和生成JSON不是完成判据。需要独立验收时，审阅者从正常入口与获准原件自行适配，不以作者预填映射或预期答案代替实际结果。

同一失败没有新增依据时，不盲目循环或重写整套工具。缺少授权、不可取得的运行时或需要真实业务决定时，说明影响并只暂停相关支路；保留已完成部分和准确缺口。

## 本机环境与后续消费

JSON／CSV／TXT／MD由本机读取；XLS／XLSX／PDF／DOCX及图像按实际Python包与本机OCR能力处理。显式 `FINANCE_PYTHON_PATH` 优先，其次检查本机已存在Python；不自动安装或上传原件。没有可用运行时、格式不支持及OCR未完成分别披露，不把读失败写成客户缺件。

适配后的规范事实仍由现有基线保存与 `calculationReader` 消费；账前输入的 `bindings[].locator` 可直接绑定原生读取支持的格式，保留原件与提取过程。上述脚本历史适配入口不等于账前消费者也能直接接受任意派生JSON。脚本执行器不是操作系统沙箱，不扩大本次原件目录或资料外发授权。旧财税计算与正式写账审核保持原流程。

仅准则／行业标签加有效历史税负时，`generationBasis:configuration_and_tax_reference`、`businessPrinciplesMissing:true` 表示业务处理原则尚未生成，保持 `needs_review`；有效税负参考继续沿用，只补受影响业务规则，不因此重读全目录或重复计算税负。无需凑最低条数或强制每类业务齐全。
