# 离线发票与银行 XLSX 合同

当前共同基线：[PR98](https://github.com/huxiaoyang-code/youshu-fork/pull/98) 已合，base `98e57bdfbe29e2f8716ab0768492583064cd30c1`、已审 head `a331b21abd72b94147742fd7e96fed0849e10cb6`、merge `11e47e6ce6e1fff724a3e158f9c98b48fcb8f6d3`；#77 comment6375751257 / #76 comment6375751712 / #85 comment6375752159 / #80 comment6375752731 为交付事实。三方黄金15、旧候选43/规划33/VAT22通过，12组业务、24张凭证、36份月末快照有独立验算。本片 OFFLINE-01D 仅新增受限银行 XLSX 材料入口，尚待 root 最终验收、全新独审与 PR。#54 最新 comment6375884790：R5 两文件窄修已独立接受并提交 `d1d618b5d19f31a877f94407ffcfcf10f518af15`，正进行13份文档收口和上游影响验证；完整最终候选仍待 fresh/PR/merge，正式写依赖未放行。远端 main 仍为本片 base `11e47e6`，不以旧 `87043a` 待审状态作当前接受事实。

银行入口使用 `kind: bank_xlsx`、`format: bank-xlsx-v1`；原银行 CSV 映射只增加显式 `sheet` 与 `headerRow`。复用同一受限 OOXML reader 与原 `normalizeMapping` / `normalizeBankRow`，不增加会计或税务规则、DB 或正式写账。原材料版本 `offline-materials/1`、CSV/JSON 语义与版本计算不变。银行与发票的固定 reader 分别只允许 amount/balance 和 net/tax/gross 为数值；调用者不能用 mapping 自定数值字段。

```json
{
  "format": "bank-xlsx-v1", "sheet": "银行原始流水", "headerRow": 3,
  "ownerEnterpriseKey": "SYNTHETIC-BANK-XLSX", "bankAccountId": "bank-A",
  "dateFormat": "YYYY-MM-DD", "amountMode": "amount_direction",
  "currency": "CNY", "negativeAmount": "reject",
  "directionLabels": {"inflow": ["收"], "outflow": ["付"]},
  "columns": {"date": "日期", "amount": "金额", "direction": "收付", "refId": "流水号", "balance": "余额", "currency": "币种", "summary": "摘要"}
}
```

银行映射必需 format/sheet/headerRow/ownerEnterpriseKey/bankAccountId/dateFormat/amountMode/currency/negativeAmount/columns；amount_direction 还须显式 directionLabels。columns 必需 date/amount/direction，可选 refId/balance/currency/summary，其他字段拒绝。ownerEnterpriseKey 必须等于 scope.enterpriseKey，账户必须显式给出；仅 CNY，日期、方向均不猜测。不支持 debit_credit。可选 thousandsSeparator/allowCurrencySymbol 与原 CSV 一致，只对实际文本金额按已声明选项处理；negativeAmount 可显式 reverse_direction。余额可为负。金额/余额按现有精确分值解析，科学计数、超过两位小数与溢出拒绝；数值单元格仍只认 General/0/0.00，不按显示格式变换。银行 type=n 原文先限制为可选负号、规范整数、可选1~2位小数，不允许前后空白（含换行）、币号、分组、加号、前导零或缺失整数/小数部分；此处固定拒绝 xlsx_cell_invalid，文本格式选项不能改变数值词法。date/refId/direction/currency/summary 必须是文本，数字日期和数字流水号拒绝，不重建前导零。银行适配器错误沿用固定 bank_row_invalid 等类别。

两种 XLSX 的 source.text/rawContent 都是 canonical base64 JSON 运输，SHA 是原二进制 SHA。CLI 与 store 使用既有统一 sourceText/sourceBytes 路径读取、保存原 bytes，不改其源码；每次 replay 重新解析原包而不信任报告中的 records、金额或 ready。银行 XLSX 与 CSV 的同账户/流水号和相同经济语义得到相同 docId/semanticDigest，跨格式副本只准备一份候选；不同金额为 conflict。无稳定流水号仍继承 suspected_only，不冒充稳定银行身份。银行材料计入 missingKinds 的银行槽和逐账户覆盖检查；完整期间覆盖、账户清单和实际业务补充事实仍必须显式提供。

文件模式的 openOfflineActionInput / buildOfflineActionPlanFromFiles 会实际重读来源与 receipt/origin。原文件缺失、变化、跨范围或损坏使对应银行分支失效；独立合法销售分支可保留。原件更正须现有显式 supersedes/expectedSourceVersion CAS，历史 blob 与回执保留；不偷用旧报告。具备未来服务预付事实时只从实际银行金额准备现有预付候选，缺退款等事实只请求对应缺项，已有效事实不重复索取。所有任务 authorizesExecution/periodComplete/completed=false；提供材料与候选准备均不代表正式过账或整期完成。新套与交接见 [OFFLINE-01D](tasks/OFFLINE-01D.md)。原25项测试未覆盖数值单元格被银行文本格式选项重解释的独审P2；修后增加真实XML amount/balance拒绝和实际text/CSV兼容控制，实施27/27与旧发票19/19通过，完整HEAD仍待root/fresh复验。

发票入口支持显式 `kind: invoice_xlsx`、`format: invoice-summary-xlsx-v1` 的一行一票普通 OOXML 工作簿。mapping 在原 invoice CSV 的 role/dateFormat/columns/statusLabels/redSign 上增加精确 `sheet` 名称与整数 `headerRow`。不猜列、企业、票号、日期、税额或客户业务；不接客户分录/申报数。

JSON 的 source.text/rawContent 是原文件 canonical base64 运输，fileSha256 始终原二进制 SHA256。每次重放重新解码、解 ZIP、读 OOXML，再复用相同发票语义校验；不是以缓存 CSV 或归一记录冒充原件。store blob 是原二进制，原路径变更按既有失效规则处理。location 保留 sheet、原 row 和逐字段 A1/column/header，CSV 原契约不变。

首片只接票号/代码/企业/日期/状态等文本单元格；日期按显式 dateFormat 验证。金额可为文本十进制或 OOXML 原始普通数值词法，最多两位小数；不先转浮点。数值金额只接受 General/0/0.00 内建格式。数字日期、数字票号、科学计数、亚分、复杂数字显示格式、公式（含 cached 结果）、rich text、多 run 和 `_xHHHH_` 字符串转义、错误/布尔/未知单元格类型、合并表格、映射歧义、外链、缺值与损坏均拒绝，不当零业务。样式不改变金额词法，不重建丢失前导零。

fflate 0.8.3 负责 ZIP 元数据枚举与流解压，saxes 5.0.1 负责严格 XML 语法；禁止 DTD/实体扩展，受限 OOXML 结构白名单。边界：原文件 5 MiB，ZIP 100 entries，单 entry 4 MiB/总解压 16 MiB（声明及流实际数量双核），XML 深度32/节点100000、单元格文本4096、行10000/列256、选定工作表至少一条数据。压缩输入按1024字节推进限制单次 inflate 窗口。不是完整 ZIP/OOXML 合规认证：库未公开所有 flags/CRC，不宣称全面校验所有 CRC/ZIP64/加密标志；内容不可读或不符受限语义则拒绝。密码加密 Office 容器不属于 ZIP OOXML，本片拒绝。

未选定工作表不作业务读取；全包关系禁止外部目标；有限关系/内容类型/part 路径白名单同时拒绝宏、OLE、嵌入和未知类型，不凭文件扩展名判断。默认无实际VML part的声明可保留，实际VML与图片/图表等均不支持；受限父子结构、重复关键节点、缺失关系目标拒绝。默认空slicer/timeline样式元数据可保留，实际扩展内容不支持。完整度仍由 #79 的事实覆盖、企业/期间/历史依赖判断；提供 XLSX 不等于整期完整。真实性 unverified、authorizesExecution=false；正式写账/更正/确认/申报仍依既有范围限制。本机 CLI/store 不联网或发消息。

实施、自测、失败与独立验收记录见 [任务单](tasks/OFFLINE-01C.md) 和 [交接](handoffs/OFFLINE-CLOSELOOP.md)。

本机配置沿用 `offline-materials --config` / store receive 的原路径配置，只把 source.kind 换为 `invoice_xlsx`、path 指向真实 `.xlsx`，mapping 示例（字段名对应实际表头，示例不是猜测规则）：

```json
{
  "format": "invoice-summary-xlsx-v1", "sheet": "原票", "headerRow": 3,
  "role": "sales", "dateFormat": "YYYY-MM-DD", "redSign": "signed_negative",
  "statusLabels": {"blue": ["blue"], "red": ["red"]},
  "columns": {"number": "number", "date": "date", "sellerKey": "seller", "buyerKey": "buyer", "net": "net", "tax": "tax", "gross": "gross", "status": "status"}
}
```

`node scripts/offline-materials.mjs --config <配置.json> --output <NEW.json>` 从真实文件读取；#79/#80 CLI 继续接其报告并重放原字节；`node scripts/offline-vat.mjs --input <配置.json> --output <NEW.json>` 的 materialsInput 或 materialStore 两种路径都实际重验。不是新写账入口。覆盖缺失时整期与税算仍阻断；已有独立逐票/银行候选可以保留，不标整期完成。首次来源、重收、CAS更正与跨批重复继承 [store合同](OFFLINE-MATERIAL-STORE.md)，同版原路径搬迁仍未实现。

代码依据固定安装的库 README/API 及 [fflate原项目](https://github.com/101arrowz/fflate)、[saxes原项目](https://github.com/lddubeau/saxes)；OOXML共享字符串可选、inline与关系定位的依据为 [Microsoft共享字符串文档](https://learn.microsoft.com/en-us/office/open-xml/spreadsheet/working-with-the-shared-string-table) 和 [Microsoft单元格取值文档](https://learn.microsoft.com/en-us/office/open-xml/spreadsheet/how-to-retrieve-the-values-of-cells-in-a-spreadsheet)。工程上的受限格式并非宣称全部合法XLSX都受支持。
