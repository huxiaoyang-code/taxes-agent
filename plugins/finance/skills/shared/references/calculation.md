# 自主计算与独立派生交付

Agent按业务选择Python、JavaScript、表格或已有计算器。专用工具的库存核验、精确日期、完整重放和凭证字段要求，只适用于该工具；不作为其他有依据计算的前置条件。事实不足保持未知，不补零或猜资格；需正式入账时继续走原生记账及审批控制。

`finance_calculation_run`是正常direct MCP工具，无需账套、HTTP后端连通或完整季度重放。它执行获授权的可信本机脚本并自动记录；不是对宿主所有Python/表格调用的自动拦截。绕过此工具的调用不能宣称已由它记录，宿主工作表另保留其实际公式、数据来源和版本。

## 配置与合同

为MCP进程配置`FINANCE_AUDIT_DIR`。有原件时还需设置获准原件目录`FINANCE_SOURCE_ROOT`；Python执行需`FINANCE_PYTHON_PATH`指向实际Python可执行文件绝对路径。JavaScript使用MCP本身的Node，无需Python。四宿主配置生成器可用`--source-root <目录> --python <绝对可执行文件>`写入这两个可选值；也可按宿主机制给MCP设置环境。不自动安装运行时或依赖。

按需读取工具合同后提供：

- `title`：中文业务计算名称。
- `engine`：`python`或`javascript`；`script`为实际脚本内容，不是shell命令。
- `sources`：`[{path, locator?}]`，绝对路径在获准原件目录内；纯参数计算可为`[]`。可选locator用已有`jsonPointer`或表格`row/column/headerRows/sheet`标清结构位置，不强迫全部参数服从某个业务schema。
- `parameters`：自由JSON对象，传本次真实参数、未知值及必要业务口径。不要放入凭据，也不要写原件没有的事实。历史比较期间可保留真实期间。
- `notes`：中文方法、规则出处及版本、适用条件、参数依据和缺件说明的字符串数组。这些是编写者声明，记录器不据此认定业务正确。
- `rerunOf`：可选同一记录目录中真实旧runId。必须同时提供本次完整脚本及输入；生成全新记录，旧版不被覆盖。脚本/输入版本变动时明确说明原因。
- `timeoutMs`：可选100至60000毫秒，默认30000。

实际执行时，Python通过`sys.argv[1]`、JavaScript通过`process.argv[2]`取得输入JSON文件路径，内容为：

```json
{"parameters":{"ratio":0.8,"missingCost":null},"sources":[{"index":0,"snapshotPath":"输入文件字节副本绝对路径","sha256":"实际摘要","locator":null}],"outputDir":"本次派生文件输出绝对目录"}
```

脚本读取`snapshotPath`，把中文账表、CSV、工作簿或说明文件写到`outputDir`，不修改原件或真实账库。表格库须已安装且可被所选运行时找到；不为工作簿另造统一财务数据包。比例与重分类直接写进版本化脚本或工作表公式。

JavaScript纯参数计算例子（运行后生成独立中文JSON底稿）：

```javascript
import fs from 'node:fs';
const input = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const p = input.parameters;
const amount = p.amount == null || p.ratio == null ? null : p.amount * p.ratio;
fs.writeFileSync(input.outputDir + '/计算底稿.json', JSON.stringify({分配金额: amount, 成本: p.missingCost ?? null}, null, 2));
```

金额精度、四舍五入、公式适用性及勾稽由脚本与业务复核明确，不能由该示例推断已符合法定口径。

## 输出与边界

返回`outputs`中的文件都是`derived_calculation`，可独立交付；不能冒充原件、已入账数据或`finance_quarter_review`真实账库快照。需要原生账库报告时另选该工具及`quarter-export`，它们不是通用计算的唯一交付路径。

未指定`reviewCard`时，`reviewPath`打开“计算记录与文件索引”；指定且成功时打开系统固定中文账务卡片。业务计算仍由脚本/表格完成，最终卡片由后台取数渲染，模型不另写一份重复报告。执行完成仍为`businessStatus:unreviewed`，不代表已核、已入账或已申报。

本机每次新目录保存完整请求、脚本、实际输入、来源文件字节及结构位置、运行时/记录器摘要与版本、开始结束时间、stdout/stderr、输出文件摘要和中文索引。CSV无locator时仅默认展示首行；JSON展示根结构；复杂格式没有locator时仅保存原字节并明确结构未解析。来源文件与副本、脚本和输入结束时做摘要比较，失败及变化都保留；哈希不是真实性、不可篡改或业务正确证明。

只执行本次已授权的可信脚本。运行器使用明确程序及参数，`shell:false`，精简环境，不继承模型密钥、账库位置或用户目录；但脚本按当前操作系统用户权限运行，仍可能访问目录外文件、网络或创建进程，不是安全沙箱。记录器本身不调用记账接口，也不能保证任意脚本没有副作用；不得用它改原件/账库、扫描凭据或扩大资料外发授权。正式控制保持独立。

单原件上限8MiB、每次原件合计20MiB，64个来源；输出最多64个文件/20MiB，stdout和stderr各最多1MiB；超限保留失败。超时只针对直接子进程，不是后代进程或内存限制。结果路径与日志留本机，业务原文不自动在MCP返回中展开。

工具对所有获准路径统一记录为`source_snapshot`：输入文件快照，来源性质待核。路径获准、读取成功或哈希相同均不能把派生文件升级成原件；再次计算上次输出时仍保留中性输入快照，原件真实性及来源性质需依据业务材料另行判断。

## 固定账务复核卡片（可选交付，不是做账前置）

调用增加 `reviewCard:{format:"quarter-ledger/v1",dataPath:"账务.json",bankSourceIndex:1,findingsSourceIndex:2,cashSourceIndex:3}`。后三个下标均可省略，指本次 `sources` 的零基索引；`dataPath` 必须是本次 `outputDir` 下已索引的相对 JSON 文件，禁止绝对路径、回退和链接。它只适配以下明确结构，不承诺自动理解任意 JSON、CSV 或 XLSX，不约束模型选用的会计计算工具。

- `meta:{company,period:"YYYY-MM-DD 至 YYYY-MM-DD"}`：任意完整自然季度，同一年；公司为输入声明，系统不据此证明主体归属。
- `accounts:[{code,name}]`、`opening:{科目编码:{debit,credit}}`：季度期初；`balances:{月份数字字符串:{dr:{科目编码:数值},cr:{科目编码:数值},closing:{科目编码:{debit,credit}}}}`：每月发生与期末。科目有下级时，上级仅为目录，不可提供非零预汇总金额，避免重复累计；未知或缺值保持未提供。
- 可选 `vouchers:[{no,date,summary,sources:[输入引用文本],lines:[{code,debit,credit}]}]`；有凭证时核对各科目发生额，无凭证则未核，不猜配。
- 可选 `income:[{item,byMonth:{"4":数值,"5":数值,"6":数值},total}]`；`byMonth` 存在时优先且缺月不回退，第一季度兼容 `jan/feb/mar`。`balance_sheet:[{item,begin,end}]` 中 `begin` 固定是年初余额、`end` 为本季末，与科目表季度期初不同；`cashflow:[{item,amount}]` 为季度累计。标题行可给 `heading:true`，未知金额为 `null`。
- 可选 `tax_rows:[{name,code?,opening,accrued,paid,closing,basis?}]`：期初未缴、本期计提/代扣、本期缴纳、期末未缴分别保留，不能把全部科目贷方等同净计提。

金额必须为有限 JSON 数值（人民币元，最多两位小数）或 `null`，不把字符串强转数字。结构不支持、路径不符和非法数值记录卡片失败，不修改原计算结果。

银行只独立读取 `bankSourceIndex` 的已捕获 UTF-8 Markdown 快照，要求唯一表头：`交易日期|回单号|对方户名|用途摘要|收入|支出|交易后余额|关联单据`。初始余额可写 `YYYY年M月D日期初余额100.00元`；按账务期间过滤交易，期初无法确定就未提供。当前比对 `1002` 银行科目余额与指定流水；多账户分别核对仍需后续适配，主体、账户归属及材料完整性均待核，不因为差额零就宣称银行认证。模型结果中的 `bank_month.statement` 不作独立对照。

现金账面取 `1001`；`cashSourceIndex` 可指定 `{periodEnd:"YYYY-MM-DD",countedAmount:数值}` 的独立盘点输入，期间必须与季末一致。显示具体差额，盘点真实性仍待核；无输入不补零。`findingsSourceIndex` 可指定 `{findings:[{severity, finding}]}`，显示为外部复核记录，不能冒充系统自动发现。

后台在实际执行与输入校验后自动生成 `card/card.json`、固定中文 HTML；只交付一个 `reviewPath`。成功返回 `reviewCard.status:"generated"` 以及模板版本、数据/渲染器/spec/HTML完整摘要，并关联实际runId/callId；失败返回 `reviewCard.status:"failed"` 和真实错误，`reviewPath`回退技术索引，不能声称卡片已生成。脚本`status`与卡片状态分开，始终`businessStatus:"unreviewed"`。规则、参数、原字段和调用记录保留后台，点击金额按需查看；缺少逐格凭证/规则映射明确列为未提供。打印保留金额及待核事项。
