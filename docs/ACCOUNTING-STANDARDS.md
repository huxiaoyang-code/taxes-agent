# 会计 profile 与内部报表规则（LOCAL-03a）

本文件说明 LOCAL-03a 交付的 **profile / 报表规则纯模块（阶段 A）** 与 **持久 profile + 真实领域接线（阶段 B1）**：
三个 profile 的科目与角色、内部资产负债表 / 利润表行项目、金额契约、支持范围、权威来源、错误码、
持久结构、迁移语义与下游 DTO。

> **边界声明**：本文件覆盖**内部简化报表的已核实基础业务子集**与迁移 / 领域接线；**不是**法定完整财务报表、
> 税局申报格式或税务计算实现。「登记了分录」不等于「自动算税」。B1 未接 HTTP / Agent / MCP / 导出入口，
> 未注册 `test-all`，未做 v5 备份工具兼容；**LOCAL-03a 尚未整体交付**，B2 门槛见 §11.8。

## 1. 模块与公开接口

| 模块 | 作用 | 依赖 |
|---|---|---|
| `06-workbench/server/accounting-profiles.mjs` | profile 定义、科目表、角色表、来源与支持范围 | 无 import（纯语言能力） |
| `06-workbench/server/accounting-report-rules.mjs` | 报表行项目规则、科目解析、纯计算、现金流对方分类 | 仅依赖上面的 profiles 模块 |

两个模块都不读写数据库、文件、网络、环境变量，也不启动服务；`import` 无副作用。
测试 `06-workbench/test/accounting-standard-profiles.test.mjs` 只读导入现状 `coa.mjs` 作 legacy 等值对照，
不导入 `db.mjs` / `accounting.mjs`，不建库、不起服务。

### 1.1 `accounting-profiles.mjs`

| 接口 | 契约 |
|---|---|
| `listAccountingProfiles()` | 返回冻结摘要数组，含 `id / declaredStandard / creationAllowed / legacy / coaVersion / reportMappingVersion / scope / sources` |
| `getAccountingProfile(profileId)` | 精确查找并返回**深度冻结**的可序列化描述（含 `coa` 与 `roles`）；未知 ID 抛 `accounting_profile_unknown`，**不 fallback** |
| `resolveNewAccountingProfile({ accounting_standard, profileId } = {})` | 仅选择“新建账套”可用的 profile，不创建 / 更新任何账套、不推断企业身份 |
| `getAccountingRoles(profileId)` | 返回冻结角色表；角色按 profile 解析，不依赖科目名称或编码尾号 |

`resolveNewAccountingProfile` 规则：

- 省略 `accounting_standard` 且未给 `profileId` → 默认 `small-2011-basic-v1`（小企）；
- `accounting_standard` 只接受**精确**的 `"小企业会计准则"` / `"企业会计准则"`；
  其他字符串、带空格、非字符串、`null` 一律 `accounting_standard_invalid`（空白不是默认值）；
- 显式 `profileId` 必须存在且与 `accounting_standard`（若给）一致 →
  否则 `accounting_profile_unknown` / `accounting_profile_standard_mismatch`；
- legacy profile 不可新建 → `accounting_profile_legacy_not_creatable`；
- 参数不是对象（`null` / 数组 / 标量）→ `accounting_standard_invalid`。

### 1.2 `accounting-report-rules.mjs`

| 接口 | 契约 |
|---|---|
| `getAccountingReportRules(profileId)` | 冻结、可序列化的规则描述：`profileId / reportMappingVersion / engineMode`、资产负债表与利润表的 `rowId / label / 科目规则 / 合计依赖`、往来反向列示 `reciprocal`、合法负列示 `negativePresentation`、基础现金流分类规则、`unsupported` / `requiredDetails` 清单 |
| `resolveAccountingAccountRule(profileId, account)` | 解析单个科目：`matchedRoot`、`isDetail`、`roles`、`effective`、`scope`、`statements`、`diagnostics`；名称仅展示 |
| `evaluateAccountingStatement(profileId, { kind, accounts, amounts })` | 纯计算 `balance-sheet` / `income-statement`，返回行项目、合计、往来反向余额 `reclassifications` 与 `diagnostics` |
| `classifyAccountingCashCounterpart(profileId, account)` | 单一对方科目现金交易的 `operating` / `investing` / `financing`，否则 `unknown` + `reason` |

## 2. 金额契约（阶段 B 必须遵守）

- `amounts` 为 `[{ code, netMinor }]`，`code` 唯一，`netMinor` 是**安全整数分**、**借减贷**、可正负，
  代表**各科目自身金额**，不含父级汇总重复值。
- 资产负债表输入「截至期间的**期末余额**」；利润表输入「明确时间窗内**排除结转**的损益发生净额」。
- 本模块**不查库、不选期间、不筛 posted、不计提**，也不解析货币字符串或浮点元；
  阶段 B 必须用 LOCAL-02 已验金额函数与已验证查询生成输入，不重写舍入。
- 拒绝 `NaN`、`Infinity`、字符串、非整数、`null`、重复 `code`、`amounts` 引用不存在的科目；
  累计溢出安全整数 → `amount_overflow`；**不接受隐式归 0**。
- 返回：`{ profileId, reportMappingVersion, engineMode, kind, complete, rows:[{ id, label, valueMinor }], totals, reclassifications, diagnostics }`，
  全部金额为安全整数分，返回对象深度冻结。`reclassifications` 记录已确定的往来反向余额列示
  （`accountCode / matchedRoot / fromRowId / toRowId / amountMinor`），不产生错误诊断、不影响 `complete`。

符号与列示约定：

- 资产负债表的资产行取借减贷有符号值；**备抵资产（累计折旧 / 累计摊销 / 减值准备）为负值**，
  原值、累计、净值分别展示，但**只有净值计入资产总计**，不会把备抵加成正资产、也不重复汇总。
- 负债 / 权益行按贷方自然方向展示为正；未分配利润 = 利润分配 + 本年利润 + **未结转损益**
  （= −Σ 损益科目借减贷）。因此结转前后同一业务**期末净资产不变**，未结转损益直接增减未分配利润。
- 利润表：收入取贷方净额（红冲可为负），费用取借方净额（红冲可为负），允许亏损。
- 生产成本按各自口径计入存货：小企 `4001`、企业 `5001`；企业 `5001` 不是收入，企业 `4001` 不是存货。
- 往来反向余额：按每个科目自身余额方向逐项判断，**不先把同一行明细净额相加**。小企
  `1122` 贷方→`2203` 预收账款、`2203` 借方→`1122` 应收账款、`2202` 借方→`1123` 预付账款、
  `1123` 贷方→`2202` 应付账款；重分类写入 `reclassifications`，不产生错误诊断。企业
  `2202/1123` 双向同样列示；企业 `1122` 贷方 / `2203` 借方因预收款项与合同负债 / 合同资产
  需合同细类，给 `account_reverse_balance_requires_detail`，不计入合计且 `complete=false`。
  其他未定义列示行的相反余额同样给该诊断，不静默冲减资产或负债，也不把它归因于
  “流动 / 非流动期限重分类暂缓”。权益类（利润分配 / 本年利润等）的借方余额是亏损 /
  减少，仍按负值展示，不套用往来反向诊断。
- 小企应交税费 `2221` 期末借方余额按附录第73页(28)以负号列示，属**合法负列示**：
  保留在“应交税费”本行、不按往来反向诊断、不改列其他行；该规则按 profile / 科目登记在
  `balanceSheet.negativePresentation`，不扩张到未核实科目或其他 profile。合法负列示、
  备抵常规余额（有符号金额）、权益亏损 / 损益红冲与往来反向重分类分别处理，不共用一条方向规则。

## 3. 三个 profile

| profile ID | 登记准则 | 可新建 | legacy | 说明 |
|---|---|---|---|---|
| `legacy-small-coa-v1` | `null` | 否 | 是 | 派工基线 `coa.mjs` 的逐项静态快照，仅用于旧账套兼容读取 |
| `small-2011-basic-v1` | 小企业会计准则 | 是 | 否 | 小企基础业务子集（财会〔2011〕17号正文与附录） |
| `enterprise-2019-general-basic-v1` | 企业会计准则 | 是 | 否 | 企业一般业务子集（财会〔2006〕18号附录条目 + 后续指南，行项目基础取财会〔2019〕6号附件2） |

- legacy **不是第三种法定准则**：`declaredStandard` 为 `null`，旧账套原 `accounting_standard` 标签由阶段 B 账套记录保留，
  迁移不改历史科目、不改历史凭证，也不代表旧账套实际遵守小企业准则。
- profile 一旦交付，**ID 与含义固定**；阶段 B 沿用，不另造兼容别名。
- 一个 profile 只是一套**已核实的内部基础业务子集**，不代表「2026 全业务准则实现」或法定完整财务报表。

### 3.1 关键同码不同义（禁止跨 profile 混用）

| 编码 | 小企 profile | 企业 profile |
|---|---|---|
| `3001 / 3002 / 3101 / 3103 / 3104` | 实收资本 / 资本公积 / 盈余公积 / 本年利润 / 利润分配 | — |
| `4001 / 4002 / 4101 / 4103 / 4104` | `4001` 生产成本、`4101` 制造费用 | 实收资本 / 资本公积 / 盈余公积 / 本年利润 / 利润分配 |
| `5001` | 主营业务收入 | 生产成本 |
| `5301` | 营业外收入 | 研发支出 |
| `5001 / 5401 / 5602`（收入 / 成本 / 管理费） | 5001 / 5401 / 5602 | 6001 / 6401 / 6602 |
| 生产成本 | `4001` | `5001` |

角色按 profile 表解析（实收资本、资本公积、盈余公积、本年利润、利润分配、生产成本、主营 / 其他收入、
主营 / 其他成本、管理费用、默认折旧费用、固定资产、累计折旧、无形资产、累计摊销、现金根科目），
**不依赖名称或编码尾号**；同码在不同 profile 下解析到不同含义，名称不能纠正编码语义。

### 3.2 科目 scope 三态

每个预置科目都必须有可说明的 scope 状态：

- `mapped`：已核实并可直接进入内部报表行项目；
- `requires_detail`：需要持有 / 分配 / 处置 / 资本化等明细资料才能归类，**非零余额不得静默计入合计**；
- `unsupported`：本包未实现对应业务，**非零余额必须给出不完整诊断**。

每个预置科目还记录 `sourceId`（该科目的核实来源，见第 7 节），未映射科目同时记录具体 `reason`。

当前 `requires_detail` 示例：`1606 固定资产清理`、`1901 待处理财产损溢`、`2401 递延收益`、
`4101 / 5101 制造费用`、`5201 劳务成本`、`4301 / 5301 研发支出`。
当前 `unsupported` 示例：小企 `4401 工程施工`；企业 `1101 交易性金融资产`、`1471 存货跌价准备`、
`1511 长期股权投资`、`6701 资产减值损失`。

scope 三态描述**科目定义本身**；往来反向余额是**金额方向**问题，不改变 scope，
另以 `account_reverse_balance_requires_detail` 诊断或 `reclassifications` 列示处理。

## 4. 报表行项目（内部简化报表）

### 4.1 资产负债表

- 共同行：货币资金、应收票据、应收账款、预付（账款 / 款项）、其他应收款、存货、固定资产原价 /
  减：累计折旧 / 固定资产账面价值、在建工程、无形资产原价 / 减：累计摊销 / 无形资产账面价值、
  长期待摊费用、短期借款、应付票据、应付账款、预收（账款 / 款项）、应付职工薪酬、应交税费、
  应付利息、应付股利（利润）、其他应付款、长期借款、长期应付款、实收资本、资本公积、盈余公积、
  利润分配、本年利润、未结转损益、未分配利润、所有者权益合计、负债和所有者权益总计。
- 小企特有：短期投资、应收股利、应收利息分别列示（`1131 / 1132 / 1221` 三行）。
- 企业按已核实范围汇总：`1131 / 1132 / 1221` 合并为「其他应收款」一行。
- 合计：`assets` / `liabilities` / `equity` / `liabilitiesAndEquity`。
- 原值 / 累计折旧摊销为展示行，不进入资产总计；未使用且已核实的行项目不因「余额为 0」而阻断报表。
- 往来反向余额列示：小企行项目按附录第69页(4)、第70页(5)、第72页(25)(26)要求按明细科目余额方向分列
  （`1122` 贷方→预收账款、`2203` 借方→应收账款、`2202` 借方→预付账款、`1123` 贷方→应付账款）；
  企业只对可确定的 `2202` 借方→预付款项、`1123` 贷方→应付账款双向分列，`1122` 贷方 /
  `2203` 借方的预收款项与合同负债 / 合同资产细类未确定时给 incomplete。
  `getAccountingReportRules(...).balanceSheet.reciprocal` 暴露这些映射与未解决原因；
  `balanceSheet.negativePresentation` 单独暴露已核实的合法负列示（小企 `2221`，附录第73页(28)）。

### 4.2 利润表

营业收入（主营 + 其他）、营业成本（主营 + 其他）、税金及附加、销售费用、管理费用、财务费用、
投资收益、营业利润、营业外收入、营业外支出、利润总额、所得税费用、净利润。
合计至少包含 `netProfit`（另含 `operatingRevenue` / `operatingProfit` / `totalProfit`）。

企业所得税费用只汇总**已记录分录**，不做纳税调整与自动算税。

## 5. 现金流对方科目分类（受限）

`classifyAccountingCashCounterpart` 只处理**单一对方科目、可解释**的基础交易：

- 资本 / 资本公积 / 盈余公积 / 本年利润 / 利润分配、借款、长期应付款、应付股利（利润）→ `financing`；
- 固定资产、无形资产、短期投资、投资收益、应收股利、应收利息 → `investing`
  （普通非金融企业投资股利 / 债券利息收现）；
- `1604` 在建工程用途不明 → `unknown`（`construction-in-progress-purpose-ambiguous`）：
  可能是购建长期资产 `investing`、资本化借款利息 `financing` 或工程人员薪酬 `operating`，
  单一科目不能确定；不把在建工程统一列为投资活动；
- 日常商品 / 劳务收入、成本、存货、生产成本、应收应付 / 预收、应付职工薪酬、应交税费、
  税金及附加、销售 / 管理费用、所得税费用 → `operating`；
- 现金科目之间互转 → `unknown`（`counterpart_is_cash`）；应付利息 → `unknown`
  （`interest-payment-classification-ambiguous`）；
- 用途 / 细类不明：预付账款（可能预付工程款 `investing`）、财务费用（借款利息 `financing`
  vs 手续费 `operating`）、营业外收入 / 支出、其他应收 / 应付、长期待摊费用 → `unknown`
  + 固定 `reason`（`prepayment-purpose-ambiguous`、`finance-expense-interest-vs-fee-ambiguous`、
  `non-operating-income-purpose-ambiguous`、`non-operating-expense-purpose-ambiguous`、
  `other-receivable-purpose-ambiguous`、`other-payable-purpose-ambiguous`、
  `long-term-deferred-expense-purpose-ambiguous`）；
- 未映射科目、scope 不足、语义冲突 → `unknown` + 明确 `reason`。

**单一对方科目不是分类充足的充分条件**：同一科目可能因用途 / 合同 / 资产细类不同而归入
不同现金流类别；本包只在用途可从科目语义确定时给 `operating / investing / financing`，
否则明确 `unknown`。

**未实现**（阶段 B / LOCAL-05b 承担）：复合凭证按比例分摊、现金等价物与受限资金判定、
完整现金流量表引擎与间接法调节表。受限现金 / 现金等价物不因单一现金科目自动归入经营 /
投资 / 筹资，仍为 `unknown`；阶段 B 继续负责现金凭证筛选与金额分配验证。

## 6. legacy 分支（防历史重解释）

- `getAccountingReportRules("legacy-small-coa-v1").engineMode === "legacy-compatibility"`，
  两个报表 `rows` 与 `totals` 为空，明确由阶段 B 旧报表兼容路径承接。
- `evaluateAccountingStatement("legacy-small-coa-v1", …)` 返回 `complete: false`、`rows: []`、`totals: {}`、
  `reclassifications: []`、诊断 `legacy_engine_required`，**不返回假装算出的完整金额**。
- legacy COA 是基线 `06-workbench/server/coa.mjs` 的逐项静态快照：保留顺序、
  `code / name / category / direction` 与 `contra` 的有无和值，不纠错旧名称、不增科目、不合并、不排序；
  独立冻结，不运行时引用可变 COA 数组。
- 快照来源记录：基线提交 `98977e04bd24aa293074021802191814f8c2a1d2`、来源文件
  `06-workbench/server/coa.mjs`、SHA256 `cc49061c56eb2574d52b33708cf5b52564dad9ef30b88a669c596467989d8f2e`。
  测试直接与现状 `coa.mjs` 做完整逐项 `deepStrictEqual`，出现漂移即失败。

## 7. 权威来源

规则定义只引用 `sourceId`，不复制长篇法规原文。所有来源在 2026-10-22 核对。

页数按官方 PDF 实际页数核对：小企附录 85 页（第69/70/72/73/81页条目已逐页核对），
企业2019附件2 18 页（第2-3、4-8、15-16页条目已逐页核对）；两者不互相借用页码。
`source` 对象另记录 `pageCount`（小企附录 85、企业2019附件2 18），测试校验引用页码不超过实际页数。

| sourceId | 文件 / 文号 | 标题 | URL | 本包适用范围 |
|---|---|---|---|---|
| `mof-2011-17` | 财会〔2011〕17号 | 小企业会计准则（正文） | https://kjs.mof.gov.cn/zhengcefabu/201111/P020111118325852319878.pdf | 适用边界与报表基本要求 |
| `mof-2011-17-appendix` | 财会〔2011〕17号 | 小企业会计准则附录（科目、主要账务处理、报表） | https://kjs.mof.gov.cn/zhengcefabu/201111/P020111118325852734144.pdf | 小企基础科目与报表行项目；附录共 85 页：第69页(4)应收账款贷方→预收账款、第70页(5)预付账款贷方→应付账款、第72页(25)(26)应付账款借方→预付账款与预收账款借方→应收账款、第73页(28)应交税费借方余额负号列示、第80-82页现金流量表分类说明（第81页3.(2)⑤购建长期资产现金不含资本化借款费用与在建工程人员薪酬）；科目编号为参考编号 |
| `mof-2006-18-appendix` | 财会〔2006〕18号 | 企业会计准则应用指南附录：会计科目和主要账务处理（商务部政府法规库转录） | https://policy.mofcom.gov.cn/claw/clawContent.shtml?id=13655 | 只取已核实的基础科目条目；不整篇视为 2026 现行 |
| `mof-2023-01-cas-guide-reply` | 财政部会计司答复 | 企业会计准则科目需结合 2014 年以来应用指南 | https://www.mof.gov.cn/bd/mhwzzxly/hjs/202301/t20230104_3861971.htm | 说明 2006 附录不是唯一现行依据 |
| `mof-2019-06-appendix-2` | 财会〔2019〕6号 | 一般企业财务报表格式（适用于已执行新金融准则、新收入准则和新租赁准则的企业，附件2） | https://www.mof.gov.cn/gkml/caizhengwengao/wg201901/wg201905/201909/P020190912379331344319.pdf | 企业内部一般报表行项目基础；附件2共 18 页：资产负债表第2-3页、项目说明第4-8页（含第5页在建工程、第6-7页应付账款含预付账款贷方、第8页合同资产/合同负债），现金流量表第15-16页（购建长期资产、分配股利利润或偿付利息）；附件1 不作为 2026 默认 |
| `mof-2017-22` | 财会〔2017〕22号 | 企业会计准则第14号——收入 | https://m.mof.gov.cn/zcfb/201707/t20170719_2653110.htm | 新收入准则替代旧收入 / 建造合同处理；复杂合同业务未实现 |
| `mof-2026-07-interpretation-20` | 财会〔2026〕7号 | 企业会计准则解释第20号 | https://kjs.mof.gov.cn/zhengcefabu/202606/t20260615_3991686.htm | 含金融资产合同现金流量特征与货币缺乏可兑换性；本包不实现其分类计量与追溯调整 |
| `repo-coa-baseline` | — | 派工基线 `coa.mjs` 逐项快照 | — | 仅 legacy 兼容读取，不是新企业模板依据 |

## 8. 明确未覆盖的业务（2026 范围）

- 金融工具分类与计量（含解释第20号相关衔接与货币缺乏可兑换性）、长期股权投资；
- 租赁、递延所得税、减值计算与减值分摊、流动 / 非流动期限重分类（如一年内到期的长期借款）；
  往来反向余额列示已按基础 profile 实现，不归入此项；
- 新收入准则下的复杂合同资产负债、履约成本、退货等业务（旧工程施工模板不作为普遍现行模板）；
- 合并报表、外币折算、行业专用业务（金融 / 保险等）；
- 自动算税、纳税调整、税局申报文件与任何税局上传格式；
- 准则转换工具：新建 profile **不是**旧账套转换；legacy 不能通过标签「升级」成新 profile。

缺少已核实依据的科目编号或分类不补齐、不猜号；未覆盖的业务以 `scope` / 规则清单 / 诊断
显式暴露，不能用「其他收入 / 其他费用」兜底后声称完整。

## 9. 错误码与诊断码

抛错（`error.code`）：

| code | 场景 |
|---|---|
| `accounting_profile_unknown` | profile ID 未知 / 空 / 非字符串 |
| `accounting_standard_invalid` | 准则非精确受支持值、空白、非字符串、参数非对象 |
| `accounting_profile_standard_mismatch` | 显式 profile 与请求准则不一致 |
| `accounting_profile_legacy_not_creatable` | 用 legacy profile 新建账套 |
| `account_code_invalid` / `account_category_invalid` / `account_direction_invalid` / `account_contra_invalid` / `account_shape_invalid` | 科目输入形状非法 |
| `account_code_duplicate` | `accounts` 中 code 重复 |
| `amount_invalid` / `amount_code_duplicate` / `amount_account_missing` / `amount_overflow` | 金额非法 / 重复 / 缺科目 / 累计溢出 |
| `statement_kind_invalid` / `statement_input_invalid` / `statement_accounts_invalid` / `statement_amounts_invalid` | 报表调用参数非法 |
| `report_rule_invalid` / `report_rule_root_unknown` | 规则定义自检失败（模块内部一致性） |

计算诊断（`diagnostics[].code`，出现即 `complete: false`）：

| code | 含义 |
|---|---|
| `account_unmapped` | 非零科目未映射到本 profile 已验证根科目 / 数字明细 |
| `account_category_conflict` / `account_direction_conflict` / `account_contra_conflict` | 科目类别 / 方向 / 备抵语义与根科目冲突 |
| `account_requires_detail` | 需要明细资料才能归类（`requires_detail`） |
| `account_scope_unsupported` | 对应业务本包未实现（`unsupported`） |
| `account_scope_unknown` | 支持状态不可判定 |
| `account_out_of_statement` | 该科目不进入所请求的报表（如成本科目进利润表） |
| `account_reverse_balance_requires_detail` | 资产 / 负债 / 成本科目出现与自然方向相反的余额，且无已核实列示行（已核实合法负列示如小企 `2221` 除外）；`reason` 固定说明缺什么明细 |
| `legacy_engine_required` | legacy 账套必须走阶段 B 旧报表兼容路径 |

现金流分类 `unknown` 的 `reason`：`counterpart_unmapped`、`counterpart_is_cash`、
`counterpart_scope_requires_detail`、`counterpart_scope_unsupported`、
`interest-payment-classification-ambiguous`、`prepayment-purpose-ambiguous`、
`construction-in-progress-purpose-ambiguous`、`finance-expense-interest-vs-fee-ambiguous`、`non-operating-income-purpose-ambiguous`、
`non-operating-expense-purpose-ambiguous`、`other-receivable-purpose-ambiguous`、
`other-payable-purpose-ambiguous`、`long-term-deferred-expense-purpose-ambiguous`、
`classification_not_verified`、`legacy_engine_required`，以及科目语义冲突的对应诊断码。
往来反向余额 `account_reverse_balance_requires_detail` 的 `reason`：
`receivable-credit-balance-contract-liability-vs-advance-requires-detail`、
`advance-receipt-debit-balance-receivable-vs-contract-asset-requires-detail`、
`reverse-balance-presentation-not-defined`。

## 10. 阶段 A / 阶段 B 边界

阶段 A（本次）只交付纯模块与定向测试：**纯规则已实现并自测、第二轮独审最小回修已落地待复审、尚未接线，阶段 B 未完成**。

### 10.1 第二轮独审最小回修（待复审，不代表已通过）

- **旧错误 1（P2）**：`2221` 等资产 / 负债 / 成本反向余额曾被同一条 blanket 判断挡住；
  小企 `2221` 借方余额被置 0 且 `complete=false`。现按小企附录第73页(28)单独登记
  `negativePresentation`：输入 `1002:+90000、2221:+10000、3001:-100000`（分）得
  应交税费 `-10000`、资产 `90000`、负债和所有者权益 `90000`、`complete=true`。
  旧测试中“2221 借方应 incomplete”的错误预期已删除，改用未定义列示的 `2201` 反向余额。
- **旧错误 2（P2）**：`1604` 在建工程曾无条件 `investing`。现两 profile 均改为
  `unknown` + `construction-in-progress-purpose-ambiguous`；资本化借款利息应 `financing`、
  工程人员薪酬应 `operating`，无用途信息不能确定。`1601/1701` 等可判断正向分类保留。
- **旧错误 3（P3）**：来源元数据曾把 85 页小企附录的第80-82页挂到 18 页企业2019附件2。
  现小企附录来源记录第69/70/72/73/80-82页，企业2019附件2来源记录第2-3、4-8、15-16页；
  两者分别记录 `pageCount: 85 / 18`，测试按实际页数校验。
- **实际计数**：定向测试 `41/41` 通过、exit 0；新增 3 项回归在修复前为 `38/41`（3 项红），
  修复后 `41/41` 绿。未参与实现的独立复审尚未给出通过结论。

以下仍属阶段 B，且不得用纯模块单测替代：

1. 持久 profile 字段与旧账套 `legacy` 迁移（含迁移前一致备份、WAL 恢复、失败原子性）；
2. 所有既有账套迁为 legacy、历史凭证 / 期初 / 标签 / 资产卡片 / 来源批次**不被改写**；
3. 旧成功 create 批次重放与 append 指纹兼容；
4. 一企一账套约束与新建 / 导入 / 资产 / 期末检查 / 跨年结转的真实 profile 接线；
5. HTTP / Agent / MCP 真实入口与 DTO 诊断透传，`report-export.mjs` 五类导出的 profile / 诊断协调；
6. 原任务两组完整手算连续链（真实过账 → 检查 → 结转 → 封账 → 年末 → 次年）、受影响回归与最终全套；
7. 独立内容审查、最终已审 head 串行合并与交接。

---

## 11. 阶段 B1：持久 profile、真实领域接线与旧账兼容（实现完成，未合并、未整体交付）

B1 从实际 main `dfefae0553052474b8a9308105443714bc5d9cfb`（LOCAL-02 #47 / PR #60 已合）与阶段 A 冻结 `47866a3` 出发，
在本 worktree `local-03a` 实现；**不重造**阶段 A 的三个 profile、COA 与纯规则引擎，保留其已审 API。

### 11.1 持久结构（schema v5，只加一列）

```sql
-- import-storage.mjs migration v5（迁移前一致备份 → 同一事务加列 + 记版本）
ALTER TABLE account_sets
  ADD COLUMN accounting_profile_id TEXT NOT NULL DEFAULT 'legacy-small-coa-v1';
```

- 只存**不可变 profile ID**；科目表 / 报表映射版本由该 ID 解析，不另存可互相矛盾的 `coaVersion` /
  `reportMappingVersion` 多列。
- 迁移前既有账套（小企标签、企业标签、未知标签、空账套）**一律**成为 `legacy-small-coa-v1`；
  原 `accounting_standard` 字符串原样保留，不按标签重种科目、不转换历史、不改期初 / 科目 / 卡片 / 凭证 /
  期间 / 企业绑定 / 来源 / 批次 / 指纹。
- 未知或损坏 profile **不 fallback 到新小企**：正常业务抛 `accounting_profile_unknown`；
  只读恢复核对仍可直接读原始行 / 备份。
- 没有普通更新入口；本文件与领域层都不提供“改 profile / 准则”的 API，也不做准则转换。
- 一企一账套唯一约束（`import_enterprise_account_sets`）未变。

迁移链仍为 `ensureImportSchema`：先备份（含 WAL 已提交数据）→ 备份记录 + 新结构 + 迁移版本同一事务；
失败整体回滚、重试重新备份、重复启动幂等。v3 / v4 候选可逐级升 v5。

### 11.2 建账与旧首次导入

- `createAccountSet({ name, taxpayer_type, accounting_standard, start_period, profileId? })`：
  - 省略准则（`undefined` / `null` / `""`）→ `small-2011-basic-v1`；
  - 只接受精确的「小企业会计准则」「企业会计准则」；首尾空白、其他字符串、非字符串 → `accounting_standard_invalid`；
  - 显式 `profileId` 必须存在且与准则一致 → `accounting_profile_unknown` / `accounting_profile_standard_mismatch`；
  - legacy profile 不可新建 → `accounting_profile_legacy_not_creatable`；
  - 账套、profile 科目表、首期间在**同一保存点**内写入；失败不留下半截账套。
- 旧 `importAccountSet`（无来源 / 企业 / 批次身份）返回结构不变；新建账套按 payload 准则选择新 profile，
  `validation` 新增 `profile` / `profileError`（profile 错误也以 `code: message` 进入 `errors`，不逃逸成泛 500）。
- 增量 `mode=create` 同样按准则选择新 profile；`mode=append` **不**用 payload 标签改 profile。
- 已有账套 profile 只按持久 `accounting_profile_id` 读取，普通参数不能改变它或准则。

### 11.3 增量导入：先定位目标，再严格归一化

`normalizeImportPayload(payload, context?)` 新增**内部第二参数**（不是 payload 字段）：

```js
context = { profileId, accounts? }   // 由服务端在定位 append 目标 / 已完成 create 批次后传入
```

- `importIncremental` 现在先做最小参数 / 批次读取，定位 append 账套或旧已完成 `create` 批次的目标账套，
  再以**目标实际 profile 与真实科目表**调用严格 normalize；不再在查 batch / 目标之前按新企业模板拒绝旧录入。
- 旧 `create` 重放保留企业标签 + 旧小企 COA 的合法 `5001` 收入；重放仍核验内容一致、企业绑定、
  当前凭证存在 / posted / 落库指纹、真实期初；不因“先找到 batch”跳过。
- `append` 沿目标实际科目表与同企一账套规则；payload 的准则标签不改变 profile。
- 预检与正式执行同规则，出错零业务写入；旧批次 / 来源指纹规则未改。
- 未知 profile 的目标账套 → 结构化 `accounting_profile_unknown`；`import_context_invalid` 只用于内部上下文形状错误。

### 11.4 profile 角色在真实业务中的使用

- 期初 / 凭证 / 资产卡片 / 损益结转 / 年末结转 / 后续期间依赖守卫全部按**持久 profile 角色**解析：
  - 小企 / legacy：损益结转 `3103`，年末 `3103 → 3104`，默认折旧费用 `5602`；
  - 企业：损益结转 `4103`，年末 `4103 → 4104`，默认折旧费用 `6602`。
- `period-end-controls.mjs` 的 `yearEndCarryStep`、`assertPeriodMutable` 年末依赖识别、
  资产核对根科目均改为 role 驱动，不再用 SQL 硬编码 `3103/3104` / `5602`。
- 必要角色缺失 / 与科目表冲突时在写入前失败（`accounting_role_missing`），不伪造分录。
- `periodEndCheck` 新增：
  - 顶层 `accountingContext`；
  - `warnings`（固定诊断码；legacy 为 `legacy_profile_compatibility`，新 profile 登记准则不一致为
    `declared_standard_profile_mismatch`）；
  - `rules.profitAccount` / `retainedEarningsAccount` / `defaultDepreciationExpense`；
  - 原 `accountSetId / period / ready / steps / blocking / missing / rules` 与原 step id、状态语义保持。
- legacy 警告**不自动**变成封账阻塞；未知 profile / 必要角色缺失才在真正写入前失败。
  `period_end_check_failed`、`later_period_closed`、`later_year_end_carryforward_depends_on_period` 等原控制码保留。

### 11.5 报表实现（真实已过账凭证 + 期初）

- 新 profile 的三表由真实余额 / 时间窗与阶段 A `evaluateAccountingStatement` 计算，不重写规则引擎：
  - 资产负债表：截至期间的科目自身**期末余额**（借减贷），父子科目各计一次；原值 / 累计 / 净值分别展示，
    只有净值进资产总计；企业 `5001` 生产成本进存货，绝不计入营业收入；资本公积单独列示；
  - 利润表：仅**明确时间窗内、排除结转**的已过账损益发生净额；本期与本年累计分开，年中启用时起点取
    `max(账套启用期间, 当年 1 月)`；
  - 现金流：只分类**单一非现金对方科目**的基础现金凭证；复合对方科目不按比例分摊、不猜现金等价物 /
    受限现金，给 `cash_flow_classification_incomplete`，且不把未分类金额塞进经营 / 投资 / 筹资。
- legacy 走**真实旧兼容计算**（原 `balanceSheet` / `incomeStatement` / `cashFlowStatement` 逻辑），
  返回 `legacy_compatibility` + `complete=false`；不把阶段 A 的 `legacy_engine_required` 空值当完成。
- 保留小企 `2221` 借方余额的合法负列示；企业同输入给 incomplete；`1604` 现金流用途不明给 unknown；
  非零未知 / 需明细 / 语义冲突明确 incomplete，零余额复杂科目不阻断；不因算式碰巧平衡就宣称完整。
- 金额仍由 LOCAL-02 `money.mjs` 与已验证查询生成（净额使用整数分），未改变单笔上限、未新增浮点舍入。

### 11.6 稳定下游 DTO（B1 只产出，不改 05 / 08 入口）

- 账套（`getAccountSet`、`listAccountSets` 可解析项）与三表 / 期末检查统一新增：

```js
accountingContext = {
  declaredStandard,        // 本机原登记字符串（迁移不改）
  profileId,               // 持久 profile ID（SQL 列 accounting_profile_id）
  coaVersion,
  reportMappingVersion,
  legacy,                  // true = 兼容实现，不是第三种准则
}
```

- 三表新增 `reportStatus`：

```js
reportStatus = { status, complete, partialValues, diagnostics }
// status: complete | incomplete | legacy_compatibility
// 两个新 profile 在支持范围内 complete=true、partialValues=false
// incomplete → complete=false；如仍给出部分金额则 partialValues=true
// balanced / reconciles 仅代表算术勾稽，不替代 complete
```

- `diagnostics[]` 至少 `{ code, severity, reportKind, accountCode?, reason }`；`severity` 为 `warning/error`；
  `reason` 为固定标记，不含 SQL / 堆栈 / 文件路径 / 摘要 / 企业名。固定外层码：
  `legacy_profile_compatibility`、`declared_standard_profile_mismatch`、`report_account_unmapped`、
  `report_account_requires_detail`、`report_account_semantics_mismatch`、`cash_flow_classification_incomplete`。
  本机原始 `accountCode` 可用于定位；模型 / 导出侧只能按各自政策保留允许的码 / 计数 / 受控引用。
- 报表 DTO 保留旧主要字段与单位：资产负债表 `assets[] / liabilities[] / totals{assets,liabilities,equity} / balanced`；
  利润表 `current / ytd` 旧中文键；现金流 `operating / investing / financing / totals / cash / reconciles /
  supplement_indirect`。新增 `rows`（`id/label/valueMinor`）、`reclassifications`、`unknown`、
  `classificationComplete` 等**只增不改**字段。
- 结构化错误（`Error.code` + `Error.details`）：
  - `accounting_profile_unknown`：profile ID 未知 / 损坏（details 只含受控 field / profileId / reason）；
  - `accounting_standard_invalid`：准则非法 / 首尾空白 / 非字符串 / 空白不是默认值；
  - `accounting_profile_standard_mismatch`：显式 profile 与准则不一致；
  - `accounting_profile_legacy_not_creatable`：legacy 新建；
  - `accounting_profile_immutable`：预留（本文件不提供普通 profile 更新入口）；
  - `accounting_role_missing`：必要角色未定义 / 对应科目不在账套科目表；
  - `import_context_invalid`：内部 normalize 上下文形状错误（非 payload 输入）。
  `details` 只放受控 `field / profileId / accountCode / reason`，不回显未知原始输入。

### 11.7 B1 实际测试（cwd=`06-workbench`）

| 命令 | 结果 |
|---|---|
| `node test/accounting-standard-profiles.test.mjs` | 41 / 41 exit 0 |
| `node test/accounting-standards.test.mjs` | 17 / 17 exit 0 |
| `node test/accounting-standards-migration.test.mjs` | 6 / 6 exit 0 |
| `node test/accounting-guards.test.mjs` | 23 / 23 exit 0 |
| `node test/accounting-derived.test.mjs` | 31 / 31 exit 0 |
| `node test/accounting-period-integrity.test.mjs` | 45 / 45 exit 0 |
| `node test/import-strict.test.mjs` | 54 / 54 exit 0 |
| `node test/import-incremental.test.mjs` | 49 / 49 exit 0 |
| `node test/voucher-amount-guards.test.mjs` | 103 / 103 exit 0 |

- `accounting-standards.test.mjs`：两家合成企业各一账套，2025-11 建账 → 12 月 → 次年 1 月真实过账 / 检查 /
  结转 / 封账；表格金额（小企 3000/1600/1600/12800/0/800/13600/2800 等，企业 5000/2500/…）全部按独立手算字面量核对；
  年末 `3103/3104`、`4103/4104`，次年利润分配保持上年数；企业 `5001` 在产品 1000 不变且不计收入；
  两准则 100 元三月卡片 33.33/33.33/33.34，第 4 月不再提；无形资产、默认费用科目、不适用 / 缺计提 / 账卡差异；
  小企 2221 负列示、企业同输入 incomplete、1604 现金流、未知非零 / 零余额、同码冲突、非法准则、
  多企业隔离、重复计提 / 结转、后期 4103→4104 依赖、失败原子性、legacy 兼容报表与旧 create 重放。
- `accounting-standards-migration.test.mjs`：真实 v4 合成旧库（企业标签 + 旧小企 COA + 已完成 create 批次）
  与 v3 合成旧库；迁移前 v4 备份 `verify` / `restore-new` 到全新目录成功，恢复库由真实 `db.mjs` 入口升 v5；
  v4→v5 备份含 WAL 已提交批次、业务行 / 指纹 / 原标签不变、所有旧账套为 legacy；旧 create 批次**新进程**重放
  `idempotent_replay`、内容变化 `batch_content_changed`、append / 查询 / 重启一致；v3→v5 保留历史；
  故障注入整体回滚并重试重新备份；未知 profile 结构化拒绝且原始行仍可读。全部合成临时路径 + 随机临时库。
- 旧 fixture 仅做必要合法更新：`accounting-derived.test.mjs` 的“损益明细归类”用例补足资金来源（避免把
  “负货币资金”这一不真实场景当成报表规则断言），金额 / 其他断言未删、未降精度。

### 11.8 B1 未做 / 待 B2（不得据此宣称整体交付）

1. **v5 备份 / 恢复**：`local-backup.mjs` 当前仍严格只支持 v3 / v4；B1 **未修改**该文件与 CLI / 测试。
   v5 库备份会被明确拒绝，必须等银行 #53 最终结构与窗口释放后在 B2 增加 `STRUCTURE_V5` 与完整测试；
   B1 已实际验证 **v4 迁移前备份**可 `verify` / `restore-new` 并由真实入口升 v5。
2. **入口接线**：`server.mjs`、`agent-tools.mjs`、MCP `tools.mjs` 未改；`accountingContext` / `reportStatus`
   尚未进入 HTTP / Agent / MCP DTO。B2 才接真实入口与连续链。
3. **导出 / Office**：`report-export.mjs` / `report-office-export.mjs` 未改；B1 只保证核心返回值与旧主要字段兼容。
   现有 `report-export` 套件有 4 项因新 profile 行项目 / 累计折旧符号 / 复合现金流口径差异失败，
   已登记为 B2（05 导出）适配项，未删断言、未改导出源码。
4. **08 输出边界**：新增字段 / 行项目计数差异需 08 在 B2 更新精确允许字段与未知键处理；B1 未改 08 文件。
5. **测试注册**：`scripts/test-all.mjs` 未改；B1 三套新测试尚未注册。
6. **公共交接**：`docs/handoffs/STATE.md`、`NEXT-SESSION.md`、任务索引 / INDEX / CHANGELOG 未改（归 root 释放窗口）。
7. **其他既有套件**：`smoke.test.mjs` 1 项因在新小企账套导入企业科目 `6602` 得到 incomplete 报表而失败（B2
   合法 fixture 适配）；`finance-model-adapter.test.mjs` 1 项因资产负债表行数 39 vs 旧 28 失败（B2 08 适配）；
   `local-backup.test.mjs` 初始化即因版本 5 ≠ 4 失败（B2 备份）。均**未**通过修改旧断言绕过。
8. 全程未使用真实账套 / 税局凭据 / 私有采集；真实税局接入仍为 **0**，税局现场仍暂停；
   本包仍只是内部简化基础业务子集，不宣称 2026 全准则或可申报。
