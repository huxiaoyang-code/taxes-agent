# 账前输入与工具

客户提供基础资料，Agent 用已有宿主能力本机读取，核实版本、主体、期间及字段语义后，按合同整理。原件保留原位，观察与实读依据留在获准的本机范围。

## 使用顺序

1. 核实本次获准的资料目录，并为 MCP 配置 `FINANCE_SOURCE_ROOT`。从当前会话或工作区配置确认已获准的原件根和审计根。Agent 在宿主直接读取；整理件和回复文件置于审计根 `agent-materials`。
2. 调用 `finance_record_contract`，参数 `{"recordType":"prebook"}`。读取返回的 `inputSchema`、`repliesSchema` 和说明，不要求客户制作这些内部字段。
3. 从已读取的资料生成带引用的 JSON 整理件，调用 `finance_prebook_review`：

```json
{"inputPath":"<审计根>/agent-materials/账前观察.json"}
```

4. 在本机打开工具实际返回的 `review.html`，按问题向老板核实。若有回复文件，再次调用：

```json
{"inputPath":"<相同账前输入绝对路径>","repliesPath":"<对应回复文件绝对路径>"}
```

5. 补件另存为新原件，更新适配输入及绑定，再次运行。每次结果独立保存，旧回复绑定不匹配时保持失效，不能自行改摘要使其通过。

以上路径是占位说明，实际调用必须使用当前授权目录中的真实文件。普通账前核对不要求本期凭证或完整账库，产物不是正式账簿。

## 资料与字段对应

输入外层为 `version: "finance-prebook-input/2"`，业务字段在 `facts`，原件列表在 `originals`，字段映射在 `bindings`。金额是人民币元的十进制字符串，最多两位小数；数量是非负十进制字符串，最多六位小数。不要以 `0` 代替未提供。

| 客户资料 | `facts` 中对应部分 | 关键含义 |
|---|---|---|
| 企业与期间 | `scope` | `enterpriseKey`、`period`、`periodType: monthly/quarterly`、`currency: CNY`；季度用季末月份，如 `2026-03` |
| 本期税务身份与业务声明 | `taxpayer` | `vatStatus: general/small/unknown`；普通境内范围及小规模相关选择、资格字段按原资料填写，不推定优惠 |
| 已提供资料范围 | `coverage` | 销售、发票、采购、收货、流水、库存分别为 `complete/partial/missing/not_applicable`；声明不证明客观完整 |
| 上期结转 | `opening` | 期初依据日期 `asOf`、留抵 `carryCredit`，及本期需要的进项转出 `inputVatTransferOut`、预缴 `prepaidVat`；库存期初按商品与数量，往来按 `receivables/payables` 的原业务、相对方及金额 |
| 采购与收货 | `purchases`、`receipts` | 各自的单据标识、日期、显式 `businessId`，商品／供应商及数量金额；采购、收货不是同一记录 |
| 本期销售业务 | `sales` | 包括已开票与未开票销售，按 `invoiceKind: ordinary/special/uninvoiced` 区分；净额、商品与数量来自实际资料。一般纳税人有原始 `taxAmount` 时取原值；没有税额时可提供 `vatCategory`，由后端按现有规则派生 |
| 税务进销项发票 | `invoices` | 票号、购销方向、相对方、净额／税额／价税合计、有效／作废／红字状态，购入票的抵扣声明另列 |
| 银行或现金收付 | `bankTransactions` | 账户、日期、收／支、金额、用途类别及业务关联；同额不自动匹配，垫款／借款／转账须独立识别 |
| 资金余额 | `fundsAccounts` | 银行或现金账户、期初及期末实际余额、各自日期；期初日期为期间开始前一天 |
| 期末库存盘点 | `inventoryCounts` | 商品、数量、盘点日期；缺盘点不填零，不把账面推算当实盘 |

前述内容以当前合同及后端核对范围为准。首版不自动净额处理红字业务，红字销售／发票保留需要原单复核。多对多付款分配、复杂库存批次或原件无法表达的业务，保留具体接口限制，不拼造关联来消除差异。

一般纳税人未开票销售不要求客户先计算税额。已有不含税销售净额时，按业务资料填写当前合同支持的 `vatCategory`：`goods`、`processing`、`movable_lease`、`transport`、`construction`、`real_estate_lease`、`service`、`catering`、`property_management`。后端在缺少 `taxAmount` 时调用现有原生税额规则，保留 `tax.salesTaxDerivations` 中的金额、采用类别、税率及规则来源，并标明类别适用仍待核；不接受任意输入税率或借此覆盖已有税额。缺税额也缺类别时，问询缺失的业务性质或适用依据，不要求老板交“算好的税”。类别仅有声明时仍保留业务核实事项，不能把条件派生当作资格已核。

## 来源绑定

每个 `originals` 条目含 `id`、获准原件绝对 `path`、实际 `sha256` 及 `scope:{enterpriseKey,from,through}`。主体、起止日及观察只采用实际原件依据。工具核本机原件字节摘要。

每个 `bindings` 条目以 `inputPointer` 指向 **`facts` 内部**字段，`originalId` 指向原件。将宿主实读的 `observedValue` 连同 `locator` 写进整理件。在实际可用时附 `observedContext`，记录观察对应的企业、期间及日期上下文。结构以 `inputSchema` 为准。

- JSON 用实际 `{jsonPointer}`。值完全对应时可定位对象或集合。
- 表格用 `{row,column,sheetIndex?}`。数据按实际从 1 起的行列编号，`sheetIndex` 从 0 起。文档或 OCR 文字用 `{page,line,start?,end?}`。
- 默认 `identity`。按合同使用固定的 `decimal`、`boolean`，或用受限 `valueMap` 翻译语义枚举。金额、日期、票号和相对方取实际值。
- `empty_set` 只用于有依据为空的指定集合。可用原件明列的「无记录」等真实值。实际只有表头无数据行时，提交 `{headerRow,sheetIndex?}`、`observedValue:[]` 及 `transform:"empty_set"`。本期须覆盖整期并声明 `complete`，上期来源须覆盖结转日。零净额或自由说明不足以证明集合为空。

例如 `inputPointer:"/fundsAccounts/0/closingBalance"` 表示第一个账户期末余额。按实际来源留缺口。后端核整理件中的观察和目标字段相符，索引按 `sourceType:"agent_observation"` 追溯位置。字节摘要用于版本核查，实读值与人工批准依实际证据确认。

内部记录 `id`（包括上期应收／应付）由适配器生成，不要求客户原件自带。`declarations` 可按合同记录主体／期间、覆盖、身份及业务分类／关联的提供者说明或操作者映射，包含说明人、时间与理由；它们明确标记为声明，不冒充原件取数。分类或关联只靠声明时仍保留待核事项，上期往来 `businessId`、库存 `itemId` 也适用。客户原始银行表没有 `businessId` 时，先记录现有证据与映射，不能为了通过核对在“原件”里补造该字段。

上期余额与本期资金等金额事实必须有来源，不能通过声明填入金额。上期应收 `opening.receivables` 和应付 `opening.payables` 须分别提供；确无余额可使用有来源绑定的空数组，未提供则列 `prior_balances_missing`，不能推定无往来。销售范围和空业务数组也需相应依据；整类数据缺失与已确认没有该类业务是不同状态，空数组不能自动表示零业务。

## 问询与回复

回复文件为 `finance-prebook-replies/1`，包含 `enterpriseKey`、`period`、工具实际返回的 `inputDigest`，以及 `responses` 数组。每条回复包含实际 `issueId`、`statement`、`respondent`、UTC 时间 `respondedAt`，时间格式为 `YYYY-MM-DDTHH:mm:ss.sssZ`。真实姓名或标识和时间由实际回复提供，不能代填真人已确认。

老板说“这是上期欠款”只是一条声明。若需更正分类或关联，应找到相应证据，更新 `facts` 及其来源再运行；回复不会直接修改金额，也不会自动关闭缺证据事项。补件后输入摘要变化，旧回复列失效，系统仍保留历史结果。

## 结果含义

- `prebook.json`：本次核对、差异、税务条件和问题的完整本机结果。
- `review.html`：面向操作者的中文账前报告。
- `handoff.json`：给后续做账的业务资料、声明及未决条件。不是可直接导入的凭证文件；Agent 继续按既有工具合同整理使用。
- `evidence-index.json`：本次读取与绑定的来源索引。

总体状态 `ready_for_bookkeeping_review` 仅表示可进入做账复核，仍非会计审定、正式入账或申报；`needs_inputs` 保留具体缺件；`unsupported` 保留不支持范围。增值税子结果另保留其条件及缺件状态，不能与总体状态或其他税种完成状态混用。

税负口径为本期增值税条件应纳税额／本期不含税销售额，只在分子分母可核算时显示；不是实际缴税率或综合税负。所得税、附加等继续用 [税费核对](../../tax-review/SKILL.md) 的实际工具，不将只有进项合计视为足够算全部税费。

## 合成演示

[合成演示脚本](../scripts/demo.mjs)只生成虚构企业资料并调用真实 direct MCP，不使用模型、真实账库或税局凭据。仓库已按后端要求安装 Node 和锁定依赖后，在仓库根运行：

```powershell
node plugins/finance/skills/prebook-review/scripts/demo.mjs '<已存在父目录/全新演示目录>'
```

输出目录必须尚不存在。脚本依次运行一般纳税人缺票、仅老板回复、补件重算及小规模季度资料，保留每步中文报告和交接包。控制台与 `演示结果.json` 列出实际本机路径；`实际输入合同.json` 来自本次 MCP 查询。一般纳税人的合成数据独立预期为销项 1,300 元、进项 650 元、上期留抵 100 元，条件应纳 550 元；小规模合成普通销售 400,000 元按已声明的该期减征条件试算 4,000 元。预期金额仅用于验收，不作为工具输入。

此演示的已开票销售带原始交易税额，不表示所有输入都必须有税额。未开票业务可使用上述净额＋`vatCategory` 路径，后端自行派生并留痕；该路径的非零及缺类别用例由后端账前测试覆盖。

演示将虚构银行流水保留为 CSV，由测试侧按真实行列生成观察及受限枚举映射。其他虚构资料按实际 JSON 位置提交。产出的账前索引记录观察、原件版本及位置。
