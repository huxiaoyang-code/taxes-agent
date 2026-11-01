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

`reviewPath`打开的是“计算记录与文件索引”，用于查看输入、结构、脚本版本、错误和输出路径；不是自动完成的财税报告。面向业务的中文账表、方法、规则与缺件影响由脚本或表格形成实际文件，单独核对后交付。执行完成仍为`businessStatus:unreviewed`，不代表已核、已入账或已申报。

本机每次新目录保存完整请求、脚本、实际输入、来源文件字节及结构位置、运行时/记录器摘要与版本、开始结束时间、stdout/stderr、输出文件摘要和中文索引。CSV无locator时仅默认展示首行；JSON展示根结构；复杂格式没有locator时仅保存原字节并明确结构未解析。来源文件与副本、脚本和输入结束时做摘要比较，失败及变化都保留；哈希不是真实性、不可篡改或业务正确证明。

只执行本次已授权的可信脚本。运行器使用明确程序及参数，`shell:false`，精简环境，不继承模型密钥、账库位置或用户目录；但脚本按当前操作系统用户权限运行，仍可能访问目录外文件、网络或创建进程，不是安全沙箱。记录器本身不调用记账接口，也不能保证任意脚本没有副作用；不得用它改原件/账库、扫描凭据或扩大资料外发授权。正式控制保持独立。

单原件上限8MiB、每次原件合计20MiB，64个来源；输出最多64个文件/20MiB，stdout和stderr各最多1MiB；超限保留失败。超时只针对直接子进程，不是后代进程或内存限制。结果路径与日志留本机，业务原文不自动在MCP返回中展开。

工具对所有获准路径统一记录为`source_snapshot`：输入文件快照，来源性质待核。路径获准、读取成功或哈希相同均不能把派生文件升级成原件；再次计算上次输出时仍保留中性输入快照，原件真实性及来源性质需依据业务材料另行判断。
