# 离线发票 XLSX 合同

本片仅支持显式 `kind: invoice_xlsx`、`format: invoice-summary-xlsx-v1` 的一行一票普通 OOXML 工作簿。mapping 在原 invoice CSV 的 role/dateFormat/columns/statusLabels/redSign 上增加精确 `sheet` 名称与整数 `headerRow`。不猜列、企业、票号、日期、税额或客户业务；不接客户分录/申报数。

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
