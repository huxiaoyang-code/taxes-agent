# 会计 profile 与内部报表规则（LOCAL-03a 阶段 A）

本文件说明 LOCAL-03a 阶段 A 交付的**纯 profile / 报表规则模块**：三个 profile 的科目与角色、
内部资产负债表 / 利润表行项目、金额契约、支持范围、权威来源与错误码。

> **边界声明**：本文件与对应模块只覆盖**纯定义与纯计算**。阶段 A 未做持久迁移、未接线任何
> HTTP / Agent / MCP / 导出入口、未改动现有账套与历史数据，也**不是**法定完整财务报表、
> 税局申报格式或税务计算实现。「登记了分录」不等于「自动算税」。

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
| `getAccountingReportRules(profileId)` | 冻结、可序列化的规则描述：`profileId / reportMappingVersion / engineMode`、资产负债表与利润表的 `rowId / label / 科目规则 / 合计依赖`、基础现金流分类规则、`unsupported` / `requiredDetails` 清单 |
| `resolveAccountingAccountRule(profileId, account)` | 解析单个科目：`matchedRoot`、`isDetail`、`roles`、`effective`、`scope`、`statements`、`diagnostics`；名称仅展示 |
| `evaluateAccountingStatement(profileId, { kind, accounts, amounts })` | 纯计算 `balance-sheet` / `income-statement` |
| `classifyAccountingCashCounterpart(profileId, account)` | 单一对方科目现金交易的 `operating` / `investing` / `financing`，否则 `unknown` + `reason` |

## 2. 金额契约（阶段 B 必须遵守）

- `amounts` 为 `[{ code, netMinor }]`，`code` 唯一，`netMinor` 是**安全整数分**、**借减贷**、可正负，
  代表**各科目自身金额**，不含父级汇总重复值。
- 资产负债表输入「截至期间的**期末余额**」；利润表输入「明确时间窗内**排除结转**的损益发生净额」。
- 本模块**不查库、不选期间、不筛 posted、不计提**，也不解析货币字符串或浮点元；
  阶段 B 必须用 LOCAL-02 已验金额函数与已验证查询生成输入，不重写舍入。
- 拒绝 `NaN`、`Infinity`、字符串、非整数、`null`、重复 `code`、`amounts` 引用不存在的科目；
  累计溢出安全整数 → `amount_overflow`；**不接受隐式归 0**。
- 返回：`{ profileId, reportMappingVersion, engineMode, kind, complete, rows:[{ id, label, valueMinor }], totals, diagnostics }`，
  全部金额为安全整数分，返回对象深度冻结。

符号与列示约定：

- 资产负债表的资产行取借减贷有符号值；**备抵资产（累计折旧 / 累计摊销 / 减值准备）为负值**，
  原值、累计、净值分别展示，但**只有净值计入资产总计**，不会把备抵加成正资产、也不重复汇总。
- 负债 / 权益行按贷方自然方向展示为正；未分配利润 = 利润分配 + 本年利润 + **未结转损益**
  （= −Σ 损益科目借减贷）。因此结转前后同一业务**期末净资产不变**，未结转损益直接增减未分配利润。
- 利润表：收入取贷方净额（红冲可为负），费用取借方净额（红冲可为负），允许亏损。
- 生产成本按各自口径计入存货：小企 `4001`、企业 `5001`；企业 `5001` 不是收入，企业 `4001` 不是存货。

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

### 4.2 利润表

营业收入（主营 + 其他）、营业成本（主营 + 其他）、税金及附加、销售费用、管理费用、财务费用、
投资收益、营业利润、营业外收入、营业外支出、利润总额、所得税费用、净利润。
合计至少包含 `netProfit`（另含 `operatingRevenue` / `operatingProfit` / `totalProfit`）。

企业所得税费用只汇总**已记录分录**，不做纳税调整与自动算税。

## 5. 现金流对方科目分类（受限）

`classifyAccountingCashCounterpart` 只处理**单一对方科目、可解释**的基础交易：

- 资本 / 资本公积 / 盈余公积 / 本年利润 / 利润分配、借款、长期应付款、应付股利（利润）→ `financing`；
- 固定资产、在建工程、无形资产、长期待摊费用、短期投资、投资收益 → `investing`；
- 日常收入 / 成本 / 费用 / 存货 / 往来 / 税费 / 生产成本 → `operating`；
- 现金科目之间互转 → `unknown`（`counterpart_is_cash`）；应付利息 → `unknown`（分类口径不唯一）；
- 未映射科目、scope 不足、语义冲突 → `unknown` + 明确 `reason`。

**未实现**（阶段 B / LOCAL-05b 承担）：复合凭证按比例分摊、现金等价物与受限资金判定、
完整现金流量表引擎与间接法调节表。阶段 B 继续负责现金凭证筛选与金额分配验证。

## 6. legacy 分支（防历史重解释）

- `getAccountingReportRules("legacy-small-coa-v1").engineMode === "legacy-compatibility"`，
  两个报表 `rows` 与 `totals` 为空，明确由阶段 B 旧报表兼容路径承接。
- `evaluateAccountingStatement("legacy-small-coa-v1", …)` 返回 `complete: false`、`rows: []`、`totals: {}`、
  诊断 `legacy_engine_required`，**不返回假装算出的完整金额**。
- legacy COA 是基线 `06-workbench/server/coa.mjs` 的逐项静态快照：保留顺序、
  `code / name / category / direction` 与 `contra` 的有无和值，不纠错旧名称、不增科目、不合并、不排序；
  独立冻结，不运行时引用可变 COA 数组。
- 快照来源记录：基线提交 `98977e04bd24aa293074021802191814f8c2a1d2`、来源文件
  `06-workbench/server/coa.mjs`、SHA256 `cc49061c56eb2574d52b33708cf5b52564dad9ef30b88a669c596467989d8f2e`。
  测试直接与现状 `coa.mjs` 做完整逐项 `deepStrictEqual`，出现漂移即失败。

## 7. 权威来源

规则定义只引用 `sourceId`，不复制长篇法规原文。所有来源在 2026-10-22 核对。

| sourceId | 文件 / 文号 | 标题 | URL | 本包适用范围 |
|---|---|---|---|---|
| `mof-2011-17` | 财会〔2011〕17号 | 小企业会计准则（正文） | https://kjs.mof.gov.cn/zhengcefabu/201111/P020111118325852319878.pdf | 适用边界与报表基本要求 |
| `mof-2011-17-appendix` | 财会〔2011〕17号 | 小企业会计准则附录（科目、主要账务处理、报表） | https://kjs.mof.gov.cn/zhengcefabu/201111/P020111118325852734144.pdf | 小企基础科目与报表行项目；科目编号为参考编号 |
| `mof-2006-18-appendix` | 财会〔2006〕18号 | 企业会计准则应用指南附录：会计科目和主要账务处理（商务部政府法规库转录） | https://policy.mofcom.gov.cn/claw/clawContent.shtml?id=13655 | 只取已核实的基础科目条目；不整篇视为 2026 现行 |
| `mof-2023-01-cas-guide-reply` | 财政部会计司答复 | 企业会计准则科目需结合 2014 年以来应用指南 | https://www.mof.gov.cn/bd/mhwzzxly/hjs/202301/t20230104_3861971.htm | 说明 2006 附录不是唯一现行依据 |
| `mof-2019-06-appendix-2` | 财会〔2019〕6号 | 一般企业财务报表格式（附件2：已执行新金融 / 收入 / 租赁准则） | https://www.mof.gov.cn/gkml/caizhengwengao/wg201901/wg201905/201909/P020190912379331344319.pdf | 企业内部一般报表行项目基础；附件1 不作为 2026 默认 |
| `mof-2017-22` | 财会〔2017〕22号 | 企业会计准则第14号——收入 | https://m.mof.gov.cn/zcfb/201707/t20170719_2653110.htm | 新收入准则替代旧收入 / 建造合同处理；复杂合同业务未实现 |
| `mof-2026-07-interpretation-20` | 财会〔2026〕7号 | 企业会计准则解释第20号 | https://kjs.mof.gov.cn/zhengcefabu/202606/t20260615_3991686.htm | 含金融资产合同现金流量特征与货币缺乏可兑换性；本包不实现其分类计量与追溯调整 |
| `repo-coa-baseline` | — | 派工基线 `coa.mjs` 逐项快照 | — | 仅 legacy 兼容读取，不是新企业模板依据 |

## 8. 明确未覆盖的业务（2026 范围）

- 金融工具分类与计量（含解释第20号相关衔接与货币缺乏可兑换性）、长期股权投资；
- 租赁、递延所得税、减值计算与减值分摊、期末期限重分类；
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
| `legacy_engine_required` | legacy 账套必须走阶段 B 旧报表兼容路径 |

现金流分类 `unknown` 的 `reason`：`counterpart_unmapped`、`counterpart_is_cash`、
`counterpart_scope_requires_detail`、`counterpart_scope_unsupported`、
`interest-payment-classification-ambiguous`、`classification_not_verified`、`legacy_engine_required`，
以及科目语义冲突的对应诊断码。

## 10. 阶段 A / 阶段 B 边界

阶段 A（本次）只交付纯模块与定向测试：**纯规则已实现并自测、尚未接线，阶段 B 未完成**。
以下仍属阶段 B，且不得用纯模块单测替代：

1. 持久 profile 字段与旧账套 `legacy` 迁移（含迁移前一致备份、WAL 恢复、失败原子性）；
2. 所有既有账套迁为 legacy、历史凭证 / 期初 / 标签 / 资产卡片 / 来源批次**不被改写**；
3. 旧成功 create 批次重放与 append 指纹兼容；
4. 一企一账套约束与新建 / 导入 / 资产 / 期末检查 / 跨年结转的真实 profile 接线；
5. HTTP / Agent / MCP 真实入口与 DTO 诊断透传，`report-export.mjs` 五类导出的 profile / 诊断协调；
6. 原任务两组完整手算连续链（真实过账 → 检查 → 结转 → 封账 → 年末 → 次年）、受影响回归与最终全套；
7. 独立内容审查、最终已审 head 串行合并与交接。
