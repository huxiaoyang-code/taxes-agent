# OFFLINE-01A：本机原始资料预检

Refs #78，依赖已合 OFFLINE-00 / PR86。本片只实现 CSV 发票汇总明细、CSV 银行流水与 JSON 业务事实补充的标准化及本机 CLI。它没有接入服务器、数据库、账套、模型工具或自动记账。**#78 整包尚未完成，不得关闭**。

入口（在 `06-workbench` 执行）：

```powershell
node scripts/offline-materials.mjs --config C:\local\materials-config.json --output C:\local\new-preflight.json
```

参数必须按上述顺序提供，输出必须是尚不存在的新文件。来源相对路径基于配置文件所在目录；输出相对路径基于当前工作目录。不猜文件名、表头、角色、方向或企业。拒绝覆写现有输出，也拒绝用输入/配置及其现有链接作为输出。只读取明确的配置和来源文件，只向明确的 output 写入报告；不扫描目录、不写原件。报告包含路径、原始内容、原值及金额，应保留在本机；stdout/stderr 不输出这些内容。

退出码：0＝预检产物写入（也可能资料种类缺失、status=partial）；2＝参数格式错误；3＝材料拒绝或冲突；4＝配置/文件读取/输出创建失败。stdout 仅固定状态/白名单错误类别码与来源/记录数；stderr 为空。结构/金额等非法材料拒绝时不创建输出，CLI返回如 `OFFLINE_MATERIALS_REJECTED code=amount_invalid` 的固定分类；有效结构内的同 ID 冲突会写入所有冲突记录供本机核对，并返回3。所有输出都保留 `validationOnly:true, authorizesExecution:false, completeness:"not_assessed", assessment:{issue:79,status:"not_implemented"}`，0 不代表整期业务齐全、账务正确、可以过账或税务完成。

## 输入与显式映射

配置精确字段是 `scope, sources`。每个来源精确字段是 `sourceId, kind, scope, path, mapping`，来源 scope 必须与批次完全相同。scope 示例：

```json
{"enterpriseKey":"SYNTHETIC-OWNER","accountSetId":"synthetic-book","period":"2026-Q3","currency":"CNY","unit":"yuan"}
```

period 也可为 `{"from":"2026-07","to":"2026-09"}`，包含首尾月；季度与月份范围只作为不同的显式期间表示，不隐式等同。只接受规范企业 Key，不通过名称关联。每个文件不超过5 MiB、最多100来源；CSV 复用银行解析器的20000行/40列等界限，JSON 最多1000事实。文件必须是 UTF-8（可带 BOM），不支持 GBK、XLSX、OCR、任意平台发票全量导出。常用中文列名必须在配置中登记。

发票 `kind=invoice_csv` 的 mapping 例子：

```json
{
  "format":"invoice-summary-csv-v1",
  "role":"sales",
  "dateFormat":"YYYY-MM-DD",
  "redSign":"signed_negative",
  "statusLabels":{"blue":["蓝字","正常"],"red":["红字"]},
  "columns":{
    "number":"发票号码","code":"发票代码","date":"开票日期",
    "sellerKey":"销方识别号","buyerKey":"购方识别号",
    "net":"金额","tax":"税额","gross":"价税合计","status":"状态",
    "originalNumber":"原票号码","originalCode":"原票代码",
    "originalSourceVersion":"原来源版本"
  }
}
```

仅限**每行一张票的受限汇总明细**；同一张发票多商品行不是此格式，会形成冲突而不是自动加总。code 与三个 original 列可不映射；其它列必须显式映射且存在。普通 CSV 允许额外未映射原始列，它们不会成为标准业务字段，但仍保留在原文/行中供重放。映射对象不接受未知键、不允许同一列复用。日期格式只接受既有 `YYYY-MM-DD / YYYY/MM/DD / YYYYMMDD`。支持 CSV 双引号、双引号转义、字段内逗号/换行、中文与 BOM。

role 必须是 sales 或 purchase，分别核对行的销方/购方 Key 与 scope。金额仅接受不带千分位、空格、指数或币种符号的十进制字符串（最多两位小数）；规范为两位小数，最大绝对值沿用 offline 合同 `9999999999999.99`。含税额必须精确等于净额+税额；显式0税额合法，空值不等于0。蓝字各额非负且含税额正数，不支持零额发票或作废状态，不能把空文件当整期零业务。

红字必须有原票号码、可空原票代码以及64位原来源版本摘要；不能引用自身票号/代码。`signed_negative` 要求净额/税额非正且总额负，`unsigned_positive` 要求原文非负且总额正，再统一转换为负值。保留 `correctionOf.verification=not_verified`：这只是明确的红字来源引用，**尚未核验原票是否存在、被接收、曾入账或已经红冲**。复杂红冲、替换旧数据与跨批生效留后续；不同内容的同一稳定票 ID 不能靠红字标记覆盖。

银行 `kind=bank_csv` 的 mapping 例子：

```json
{
  "format":"bank-csv-v1","ownerEnterpriseKey":"SYNTHETIC-OWNER",
  "bankAccountId":"bank-A","dateFormat":"YYYY/MM/DD",
  "amountMode":"amount_direction","currency":"CNY","negativeAmount":"reject",
  "directionLabels":{"inflow":["收"],"outflow":["付"]},
  "columns":{"date":"发生日期","amount":"交易金额","direction":"收支","summary":"摘要","refId":"流水号"}
}
```

本片只支持 `amount_direction`，未开放借贷两列。directionLabels 表示企业视角银行余额增加/减少，不能按“借/贷”字样猜。可选 summary/refId/balance/currency 列；可选 thousandsSeparator 与 allowCurrencySymbol 复用银行解析规则。negativeAmount 可显式设 reverse_direction，默认式写法仍要求字段存在。银行金额上限沿用现有银行模块 `999999999999.99`，输出为规范金额字符串；空/零发生额和亚分拒绝。复用 `parseBankCsv, normalizeMapping, normalizeBankRow`；不用带数据库副作用模块。由于季度需逐行校验期间并保留重复的不同语义，不直接用仅支持单月且遇重复即拒绝的 previewCsvImport。

ownerEnterpriseKey 必须与批次相同，bankAccountId 用于流水 ID 所属账户的命名空间。**这两者是操作者从对账单确认后提供的归属声明，不是程序已验证真实银行账户归属**。本片未解析银行抬头或联网验证账户，配置错误不能被本程序识别为真实身份伪造；跨企业配置声明不一致会拒绝。标准记录只成为 `bank_activity`，`accountingMeaning=unclassified_bank_activity`，不推导收入、费用、科目或发票结算。

JSON `kind=business_json`，mapping 固定 `{"format":"business-facts-json-v1"}`。文件精确结构示例：

```json
{
  "version":"business-facts/1",
  "scope":{"enterpriseKey":"SYNTHETIC-OWNER","accountSetId":"synthetic-book","period":"2026-Q3","currency":"CNY","unit":"yuan"},
  "facts":[{
    "factId":"service-1","date":"2026-07-16",
    "nature":"service","performance":"completed","settlement":"unpaid",
    "purpose":"unknown","benefitPeriod":{"state":"unknown","from":null,"to":null},
    "invoiceRef":{"sellerKey":"SYNTHETIC-OWNER","code":"0200","number":"10000001"}
  }]
}
```

这是严格基础事实补充 schema，不冒充已存在的 manifest/questionnaire。nature 是 service/goods/unknown；performance 是 completed/not_completed/unknown；settlement 是 received/paid/unpaid/unknown；purpose 是 operating_service/asset_related/inventory_related/personal/unknown。benefitPeriod 是 unknown+两个null，或 known+有序真实日期（允许跨期受益）。用途、履约、受益期未知须明确 unknown；不能仅凭票据/收款认收入，不能把采购一律归管理费用。这些事实仍为待核实客户声明，#79后续评估缺项，#80按规则决定会计处理。

invoiceRef 保留显式票据身份；能匹配本批发票时标 `referenceVerification=matched_in_batch`（不等于原件真实）；缺被引发票时仍保留规范事实、标 `referenceVerification=missing` 并列入 unresolvedReferences，供#79补件，状态partial，允许补充JSON单源独立重验。引用冲突票时该事实也标conflict；引用本身格式错误或资料scope跨企业仍拒绝。不接受预制凭证、借贷科目、最终税额、任意未知键或既存派生黄金；工资/资产明细等其他基础事实格式仍待 #78B。本片业务补充不接入旧合同的派生执行流程。

完整配置由上面三类 mapping 组合：

```json
{
  "scope":{"enterpriseKey":"SYNTHETIC-OWNER","accountSetId":"synthetic-book","period":"2026-Q3","currency":"CNY","unit":"yuan"},
  "sources":[
    {"sourceId":"invoices-1","kind":"invoice_csv","scope":{"enterpriseKey":"SYNTHETIC-OWNER","accountSetId":"synthetic-book","period":"2026-Q3","currency":"CNY","unit":"yuan"},"path":"invoice.csv","mapping":"替换为上面的发票 mapping 对象"},
    {"sourceId":"bank-1","kind":"bank_csv","scope":{"enterpriseKey":"SYNTHETIC-OWNER","accountSetId":"synthetic-book","period":"2026-Q3","currency":"CNY","unit":"yuan"},"path":"bank.csv","mapping":"替换为上面的银行 mapping 对象"},
    {"sourceId":"facts-1","kind":"business_json","scope":{"enterpriseKey":"SYNTHETIC-OWNER","accountSetId":"synthetic-book","period":"2026-Q3","currency":"CNY","unit":"yuan"},"path":"business.json","mapping":{"format":"business-facts-json-v1"}}
  ]
}
```

上面是需填入两个 mapping 对象的结构模板，未替换的字符串会被拒绝。可执行的三文件合成案例由测试临时生成，测试结束删除，无真实资料或大夹具包。

## 可追溯结果和限制

纯函数 `preflightMaterials({scope,sources})` 的每个 source 使用 `sourceId, kind, scope, text, fileSha256, mapping`，不接收路径或调用方伪造的 sourceVersion。`normalizeMaterial` 为纯适配器入口。hash 必须由可信本机读取边界计算；纯函数另校验它与 UTF-8 text 字节摘要相同，但不声称证明文件出处、真实企业归属或内容真实性。CLI 从实际读取的字节计算 hash，再严格 UTF-8 解码，保留 BOM 与原文用于重放。

sourceVersion 由规则版本、类别、scope、文件摘要、显式 mapping 摘要共同决定，映射变化也使其改变；batchVersion 由 sourceId/sourceVersion 集合形成。每条 record 含 scope/sourceId/sourceVersion/docId/fileSha256/semanticDigest、标准 data、raw 与 CSV 记录号/物理起始行/列号/表头或 JSON pointer。报告保留 source 的完整 rawContent、mapping 与本机路径，可重放相同规范化结果；无银行摘要截断。来源有任何结构性错误时整个批次不产生标准 records，避免部分成功误用。

结构拒绝不是 missing 或 unsupported 的别名。纯批次函数返回白名单错误码、已定位来源的0起 sourceIndex、可定位行的1起 row/line，以及金额/日期失败的固定 field 名，不回显原值。CLI当前只给固定错误类别、不输出这些来源索引，也不生成非法材料的报告。发票、银行或基础JSON均可放入单来源配置预检，成功者得到独立报告；基础JSON的缺票引用明确保留missing。后续调用者亦可逐源调用纯 `normalizeMaterial(source)` 独立获取标准化行，并用 `safeMaterialError(error, sourceIndex)` 保留数值定位；该单源层不核验跨源引用或重复，需要再用批次预检。#79尚未实现独立分支调度，不能以整批拒绝推断各源都无效，也不能以missingKinds推断整期业务是否完整。

发票 docId 按企业账套+销方+代码+号码；银行稳定流水号按银行账户命名空间，缺稳定号只使用行语义摘要作为疑似重复信号。相同稳定 ID+相同语义保留所有记录并标 duplicate；不同内容标 conflict，所有冲突版本保留。不同发票 ID 即使同金额也保持不同。无 ID 银行相同行只标 suspected_duplicate，同摘要但不同金额/日期/方向不是强重复。JSON factId 同样检测重复/冲突。所有判断仅限本批，不是跨批幂等或接收回执。

不同factId即使引用同一invoiceRef，其履约/结算等业务事实是否矛盾本片尚未评估，留#79检查；duplicateStatus只描述文档身份层重复/冲突，unique不代表业务一致或事实已核实。

缺任一类别列入 missingKinds、status=partial；三类都有也只是 preflight_only。缺字段、空文件、空事实列表、错身份/错期、亚分/超界、未知格式或未知输入字段拒绝。**#79 尚未实现**：不评估预期材料集合、历史连续、业务实质和整期完整度，不生成自动补件计划。

#78B 留项：XLSX、工资/资产/历史等支持矩阵、正式接收与持久化/重启、跨批幂等、文件替换及旧版本失效、银行账户/原票既存引用核验。#80/#81/#82 的凭证/税务/会计确认都不在本片。无新依赖、无 package/test-all/数据库/旧合同修改。删除新增模块和文档即可回退，没有账套迁移。

验证：`node test/offline-materials.test.mjs`，合成36项（含真实CLI子进程与JSON严格类型回归）；相关合同回归 `node test/offline-contracts.test.mjs` 和 `node test/bank-import.test.mjs`。不跑无关全量，产品不读取 expectations。
