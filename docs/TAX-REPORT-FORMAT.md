# 税局报表参考结构与上传适配边界

本模块提供有来源和版本的参考结构、完整行号金额的独立校验，以及税局导出准备情况检查。**它尚不能生成福建电子税务局可上传文件，不代表 RC-B 的 B2 / RC-5 完成。** 当前所有上传请求均结构化拒绝；普通内部报表导出与税局导出是不同能力。

## 已核实的原始结构

来源：[《财政部关于印发〈小企业会计准则〉的通知》及附录，商务部法规库转载](https://policy.mofcom.gov.cn/claw/clawContent.shtml?id=2909)。文号为财会〔2011〕17号，发布日期 2011-10-18，实施日期 2013-01-01。本次检索日期为 2026-10-15；引用其附录第三部分的三张财务报表及编制说明。

| 目录 ID（均以 `cn-small-enterprise-2011-` 开头） | 表号 | 必填行次 | 月报金额列 | 年报金额列 |
|---|---|---|---|---|
| `balance-sheet` | 会小企01表 | 1–53 | `end` 期末余额、`beginning` 年初余额 | 同月报 |
| `income-statement` | 会小企02表 | 1–32 | `yearToDate` 本年累计金额、`currentMonth` 本月金额 | `currentYear` 本年累计金额、`previousYear` 上年金额 |
| `cash-flow` | 会小企03表 | 1–22 | 同利润表 | 同利润表 |

统一参考版本为 `2011-17-original`，原表金额单位为元。本应用使用 `currency: "CNY"`、`unit: "元"`，最多两位小数，单个金额绝对值不超过 `999999999999.99`。**两位小数及上限是应用契约，未作为福建上传规范核实。** 金额按整数分运算，无误差容忍或隐式舍入；允许负金额但仍须通过原表勾稽规则。

目录逐行保留原始表名、行次、金额列及明确的加减勾稽等式。利润表仍含“营业税金及附加”“营业税”等 2011 原始名称，**不能把这个快照当成已核实的现行税局字段**。资料页面标注的法规效力也不构成 2026 年电子税务局具体文件兼容性证据。本实现未声称已核对所有后续修订。

资产负债表按附录的汇总、固定资产净值及资产负债权益平衡校验；利润表校验营业利润、利润总额、净利润等式；现金流量表校验经营、投资、筹资净额及期末现金余额。全部等式适用于每个金额列。缺少行或金额时停止公式校验，不补零。来源中的增列项目（例如中外合作经营已归还投资）及季度列报不在此固定参考结构范围内。

原始附录也列有合计大于等于“其中”项的关系，但本模块尚未核实其在有符号组成和冲回情况下的适用边界，**不将这些大小关系作为无条件拒绝规则**。例如财务费用为 -150 元、其中利息费用为 -100 元时，不能仅因 -150 小于 -100 就拒绝整表。其他费用、收入及存货的其中项比较也保留为待核实项。通过校验不证明其中项业务归类正确或其余组成均非负；后续需结合科目及冲回语义独立核实。

## 模块接口

模块：`06-workbench/server/tax-report-format.mjs`。所有函数同步、无数据库和网络访问，不读凭据、不更改账套、不上传和申报。

### `listTaxReportTemplates()`

返回三个可 JSON 序列化的目录快照，包括 `id`、`version`、`source`、`rows`、`columns`、`formulas`、`scope` 和限制。`kind` 为 `statutory_reference`，`uploadCompatibility` 固定为 `unverified`，`uploadFormats` 为空，`accountMapping` 为 `incomplete`。返回快照的修改不会影响内部目录或导出门槛。

### `validateReferenceReport(templateId, report)`

输入示意（`rows` 实际必须显式提供模板全部行）：

```js
{
  templateVersion: '2011-17-original',
  periodType: 'monthly', // annual 时 period 为 YYYY
  period: '2026-02',
  currency: 'CNY',
  unit: '元',
  columns: ['end', 'beginning'],
  rows: [{ line: 1, amounts: { end: '100.00', beginning: '50.00' } }]
}
```

金额可为有限 JavaScript 数值或严格十进制文本，拒绝空值、布尔、对象、指数文本、千分位、空白、非法尾缀、超精度和超界。不接受隐式强制转换。文本推荐用于需要保留精确小数的数据。

返回 `{ valid, templateId, templateVersion, scope: "reference_structure_only", uploadCompatibility: "unverified", errors }`。错误含稳定 `code`、说明及必要的 `line`/`column`；不回显输入金额。主要错误码为 `template_unsupported`、`template_version_unsupported`、`period_type_unsupported`、`period_invalid`、`currency_unsupported`、`unit_unsupported`、`columns_invalid`、`line_invalid`、`line_duplicate`、`line_missing`、`row_columns_invalid`、`amount_invalid`、`formula_mismatch`。

`valid: true` 仅表示显式行号数据通过该原始参考结构和表内勾稽，**不证明原始凭证、会计归类、跨表关系、准则适用或税局上传兼容性**。本函数不把本地报表的不完整汇总映射为官方行号。

### `assessTaxReportReadiness(setId, options)`

`options` 字段为 `period`、`region`、`accountingStandard`、`templateId`、`templateVersion`、`format`。当前地区仅登记 `CN-FJ` 的待核实状态，准则使用仓库标准名称 `小企业会计准则`。其他地区或准则返回明确阻碍。`period` 为 YYYY-MM 或 YYYY，不能用任意日期区间代替官方月报/年报。

返回 `ready: false`、`checkedAccountData: false`、`scope: "configuration_only"`、`supportedUploadFormats: []` 及 `blockers`。参数不合法时追加对应输入阻碍；即便参数完整，仍固定包含：

- `tax_template_unverified`：缺少官方上传模板及版本核实。
- `tax_format_unsupported`：尚无经过验证的上传文件格式。
- `account_mapping_incomplete`：本地账套到完整官方行次的映射及独立金额验收尚未完成。

这里只检查配置，调用层须独立验证账套存在，并从账套实际信息读取准则；调用参数本身不是企业准则的证明。此接口不读取或返回真实业务数据。

### `buildTaxReportExport(setId, options)`

当前固定抛出 `Error`，`code: "tax_template_unverified"`、`statusCode: 422`，`details` 为准备情况结果。未知输入不会产生可上传文件；调用方传入 `verified`、自定义模板或适配器不会解除门槛。未来新增真实适配器须经代码审查和独立验收，不由请求参数开关控制。

## 福建实际上传仍待核实

本次公开检索尝试访问[福建税务官网](https://fujian.chinatax.gov.cn/)及其[表格下载目录](https://fujian.chinatax.gov.cn/bsfw/bgxzx/)，工具返回 `Internal Error`；未取得足以验证导入的官方空白文件或文件规范。**这不是不支持导入的结论**。不得推定其接受 CSV、XLS、XLSX、XML，亦不得自行假设 sheet 名、隐藏字段、单元格坐标或模板版本。

后续适配需要：

1. 目标企业采用的准则、申报地区、期间及月/季/年频次。小企业规模不等于必然采用小企业会计准则，准则第二、三条明确范围、例外和选择规则。
2. 来自官方公开来源或用户本机授权取得的**空白**导入模板、取得日期和版本证据；登记文件摘要、字段、单位、精度及必填/校验规则。
3. 有完整源数据覆盖的本地科目/明细到官方行号映射；缺失明细显式阻碍，不把未知填零。
4. 合成数据的独立预期金额、逐字段映射和文件结构验收；随后由获授权操作者在目标系统验证兼容性。

用户本机真实账号、验证码、账套及申报数据不得进入模型或 GitHub。生成文件与正式提交是两个动作，本模块不包含真实提交。

## 合成验证

在 `06-workbench` 目录运行 `node test/tax-report-format.test.mjs`。24 项合成测试包含三张表的独立非零样例、负利润及负现金流、负财务费用与负利息费用、有符号子项、比较列、分级合计、分位精度、缺行、重复行、非法金额、版本/地区/准则错误、目录快照修改及 `verified` 等绕过尝试；不访问实际账套和税务服务。
