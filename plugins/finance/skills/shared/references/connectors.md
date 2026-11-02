# 工具连接

插件沿用官方 `~~category` 类别引用格式：它表示已连接的工具类别，不是可执行工具名。MCP配置由插件根目录的 `.mcp.json` 提供（人读配置，不是业务资料入口）。没有连接的类别须保留缺项，不能报告为已调用。

| 类别 | 占位 | 本中国化版本的实际接入 |
|---|---|---|
| ERP/中国财税 | `~~erp` | 本机 taxes-agent 的 finance MCP，profile为`direct`；账套、凭证、查询、报表和已支持税费 |
| 规则与税费 | `~~tax tools` | 同一finance MCP的`finance_rules`、`finance_tax_calculate`、`finance_tax_summary_calculate`、`finance_record_contract` |
| 业务底稿 | `~~workpapers` | 可选`finance_workpaper`、`finance_annual_workpaper`；模型也可自主计算 |
| 自主计算记录 | `~~workpapers` | `finance_calculation_run`执行Python/JavaScript并留证；按可选`reviewCard`合同自动生成固定中文账务复核卡片 |
| 文档/表格 | `~~documents` / `~~spreadsheets` | 按宿主实际解析/表格工具及本次授权使用；模型可直接生成含公式工作簿或配套计算脚本 |
| 数据仓库/沟通 | `~~data warehouse` / `~~chat` / `~~email` | 本版本不预配；确有需要时由操作者另接，不以官方示例地址表示已经连接 |

## 运行配置

由操作者明确提供`TAXES_AGENT_ROOT`（本 taxes-agent 仓库 clone 的绝对路径，插件和后端均在其中）、`FINANCE_DATABASE_PATH`（目标SQLite绝对路径）、`FINANCE_API_BASE`（本次后端实际loopback端口地址）和`FINANCE_AUDIT_DIR`（独立本机记录目录）。`node`须满足后端运行资格。Claude通过本仓库本地marketplace原位加载插件，`TAXES_AGENT_ROOT`指向同一仓库 clone；不按`CLAUDE_PLUGIN_ROOT`或缓存位置推算后端。四宿主及direct MCP固定读取服务所属仓库的 `plugins/finance/skills`，不提供外部插件目录选项。无需设置`FINANCE_SKILLS_DIR`；遗留值只能断言当前profile对应的内置绝对根，不能改变来源。

`.mcp.json`仅连接已实现的本机服务，不含密钥，不修改用户全局配置。精确的参数、可用工具和支持状态以当前后端schema为准；正常业务无需`harness_*`、Store、事实登记或DAG。原有开票、税局登录、在线采集、申报提交和缴款未接通，本插件不把占位工具列作可用。

## 按任务选择工具

- 已有账库任务用`account_context`核实账套，`finance_query`或`ledger_query`取实际账簿。
- `finance_record_contract`按需要取得某种业务记录合同；可选`finance_workpaper`计算原件支持的业务，不先做元数据编排。
- 按需用`finance_rules`或已核官方资料取得中国规则、来源、期间和限制；可选`finance_tax_calculate`，缺件保留原生状态。工具字段缺口不证明企业事实缺失。
- `finance_tax_summary_calculate`独立处理有来源税务汇总的条件试算；按需读`finance_record_contract(recordType=tax_summary)`，输入绑定精确JSON位置，试算不等于完整账、资格或实缴已核，见[汇总条件试算](../../tax-review/references/summary-calculation.md)。
- `voucher_check`校验明确分录；凭证、资产、导入、期间等写入只通过实际业务工具及本次授权。

使用已连接工具时系统记录实际调用过程；自主计算优先使用下述记录入口，记录能力未接通或失败时如实披露。完整账期默认展示固定卡片中的余额、银行和现金、税费及报表，凭证、规则与参数按需查看，调用与原件通过本机引用深入查看；字段和回读工具以实际返回为准，不猜引用路径或内部ID。

普通账簿/凭证工具仍连接该明确的本机HTTP后端：先按taxes-agent运行资格与启动说明启动所选数据目录，记录实际监听端口，再设置`FINANCE_API_BASE`。宿主生成器的`--api-base`应与它一致，`--database`应指向同一后端数据目录；不能用默认8787代替现场端口或将计算工具连到另一账库。配置、原生无模型加载、合成业务和模型测试分别核验。

本机客户端不等于模型离线；真实账库、原件与个人明细只在本次获准范围使用。完整本机结果与调用记录并不自动成为允许外发给模型的内容。

## 可选原生计算器的合同

仅选择`finance_workpaper`或`finance_tax_calculate`时，按其合同提交`{target:{accountSetId,period},originals:[{id,path}],records:[...]}`：账套ID来自实际查询，后台据`FINANCE_DATABASE_PATH`或明确`dbPath`绑定真实企业及数据库实例。记录的`enterpriseKey`可省略，显式身份冲突会拒绝；不要求客户提供内部scope或manifest。原显式scope与manifestPath保留兼容，三种载体不混合；年度工具仍用真实`manifestPaths`。同一主体事实跨期应共享同一原件/事实文件引用，不复制成不同来源版本。

`finance_record_contract`可按需发现原生类型，并明确`contractCompleteness`。`verified_fields_with_conditional_native_validation`为已核字段说明，仍受实际条件校验；`common_schema_and_rule_references_only`表示目前仅通用结构和原生规则引用，专用字段未完整披露，不表示算法未实现。没有完整示例不能直接判引擎不支持；应记录具体披露缺口，不猜字段，也不据此要求企业补造资料。原生专供生成的`inputRole:native_generated_only`不可由Agent伪造。

## 自主计算及系统记录

业务计算可自主选择Python、表格公式或已有计算器；不要求先用`finance_workpaper`、精确JSON绑定或原生季度导出。普通读算产出不要求建立账库，正式写账仍遵守现有工具控制。

`finance_calculation_run`接收`engine: python|javascript`、`script`、`sources`、`parameters`及中文`title`和字符串数组`notes`；原件以`path`和可选`locator`定位，定位可含`jsonPointer`、`row`、`column`、`headerRows`、`sheet`。Python启动前设置`FINANCE_PYTHON_PATH`为实际解释器绝对路径；文件来源须位于获准的`FINANCE_SOURCE_ROOT`。宿主继承环境，JavaScript无需Python；`sources:[]`的纯计算不要求来源根。精确字段以实际工具schema为准。系统在执行前快照获准来源，保存本次脚本/参数，每次独立输出并索引实际产物与中文计算记录页；失败也保留记录。脚本通过Python的`sys.argv[1]`或JavaScript的`process.argv[2]`读取本次`input.json`，使用其中`sources`的`snapshotPath`、`parameters`和`outputDir`。返回`reviewPath`、`recordPath`和`outputs`用于回读实际结果，默认业务状态为待复核，不因执行成功变为业务通过。复杂格式若仅留存字节而未解析，须说明并用实际文档读取能力核实表头与原值。未请求固定卡片时自动页仍是计算记录与文件索引；请求并成功生成卡片时，`reviewPath`是固定卡片入口，不要求模型另写最终 HTML。产物是派生计算，不是原生账库快照。脚本是实际执行代码，只在授权范围运行，不把该入口称作安全沙箱。

`notes`说明处理方法、适用规则与未决项；参数详情保留原始表头、实际语义、取数范围和公式。系统记录不替代业务核验，不能观测绕过入口的原生Python或手工表格操作；其他路径保留其真实公式/脚本和可得记录，不冒称完整自动记录。需要更正时可用`rerunOf`关联旧记录，保留前后结果。原件不改，派生文件不得冒充新原件，用户产物全部中文，代码标识保留。

## 固定账务复核卡片

完整账期计算可在同一次`finance_calculation_run`中声明`reviewCard`，计算脚本只输出结构化账务数据，系统在执行结束后确定性取数并渲染固定中文模板。它是可选的输出合同，不是做账前置登记，也不限制 Agent 使用何种计算方法。未声明时原有计算执行及留证继续可用；不能把任意 JSON、XLSX 或模型正文当作已支持的卡片格式。

```json
{
  "reviewCard": {
    "format": "quarter-ledger/v1",
    "dataPath": "季度核算结果.json",
    "bankSourceIndex": 0,
    "findingsSourceIndex": 1
  }
}
```

这是附加参数片段。`dataPath`相对于本次`outputDir`；脚本需实际生成该文件。`bankSourceIndex`和`findingsSourceIndex`是本次`sources`数组从零开始的下标，不能照抄示例顺序；没有相应资料就省略，不伪造文件。当前`quarter-ledger/v1`适配完整自然季度，`meta.period`为`YYYY-MM-DD 至 YYYY-MM-DD`，起止日期须覆盖同一年的完整季度，月份和年份取实际资料。其他账期仍可自主计算和交付已有账表，不能谎称已生成此版本的固定卡片。

数据字段如下，金额使用人民币元的有限数字；未知值为`null`或保持缺失，字符串金额及非有限数字不自动猜测转换：

| 字段 | 结构与含义 |
|---|---|
| `meta` | 必需的`company`和`period`，企业与期间取本次资料 |
| `accounts` | 必需的`[{code,name}]`；点分编码表示上下级 |
| `opening` | 各科目`{code:{debit,credit}}`季度期初余额 |
| `balances` | 按实际月份键（如第二季度为`"4"`、`"5"`、`"6"`）分别含`dr:{code:金额}`、`cr:{code:金额}`和`closing:{code:{debit,credit}}` |
| `vouchers` | 可选`[{no,date,summary,sources:[文件名],lines:[{code,debit,credit}]}]`，没有凭证映射就保留缺口 |
| `income` | 可选`[{item,byMonth:{"4":金额,"5":金额,"6":金额},total}]`，月份键随实际季度改变且不补前导零；存在`byMonth`时优先使用，缺月保持未知，不回退旧值；仅第一季度且无`byMonth`时兼容`jan`、`feb`、`mar` |
| `balance_sheet` | 可选`[{item,begin,end}]`，`begin`始终为年初余额、`end`为本季末，不与科目季度期初混用 |
| `cashflow` | 可选`[{item,amount}]`，季度现金流项目 |
| `tax_rows` | 可选`[{name,code,opening,accrued,paid,closing,basis}]`；`code`与`basis`可省略，`basis`是期末余额依据，不冒充本季计提公式 |

上级有下级时，其原始余额和发生额只能为`0`或`null`，由系统汇总下级；已汇总上级值不得与明细再次相加。缺失报表显示未提供，不造空白零表。精确验证以当前后端合同为准。

银行对照来自`bankSourceIndex`所指的实际输入快照，不读取模型写入的对账单结果自证相符。当前适配中文 Markdown 流水表的交易日期、回单号、对方户名、用途摘要、收入、支出、交易后余额及关联单据，其他格式须先如实标注整理来源，不能称已独立核对原件。

库存现金账面从科目`1001`取数，缺科目不推断为零。可选`cashSourceIndex`指向本次`sources`中的独立盘点 JSON，格式为`{periodEnd:"YYYY-MM-DD",countedAmount:金额}`，`periodEnd`必须等于本季末；系统对实际快照取数，与账面余额独立核差。缺盘点资料显示未提供、未核实；快照及差额相符不证明盘点来源真实。

`findingsSourceIndex`指定已记录复核事项 JSON 的`findings`列表，系统只是展示这些事项，不冒称自动发现；未提供复核记录不等于没有问题。规则和参数选择保留在后台证据中，卡片按实际可用的引用展开；缺少逐格映射就显示缺口，不补造规则、工具调用或原件定位。

返回的`reviewCard.status`区分`generated`和`failed`。成功时包含 Spec 及 HTML 的路径和摘要，`reviewPath`指向固定卡片，业务状态仍为`unreviewed`；失败时保留实际错误，`reviewPath`仍指技术记录索引，不冒充完整卡片。脚本执行状态与卡片生成状态分别记录，不能因为卡片失败丢弃已完成计算，也不能把计算成功说成卡片或账务已通过。最终只提供实际卡片入口，模型不再生成最终 HTML；工作簿保留为明细支持。正式写账仍用原生受控能力。
