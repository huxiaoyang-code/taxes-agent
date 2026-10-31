# 完整季度业务入口

这是普通业务委托的轻量资料/工具入口，不运行Pi，不创建记账计划、答案分录或任务DAG。业务Agent自主调查原件、选择工具和整理输入；已支持的成本、税费、折旧与结转使用原生业务工具。程序自测只用临时目录；与PR后独立业务执行分开记录。

## 准备中性工作目录

操作者指定获准公开业务资料和全新目录。维护记录单独保存人工构造和版本信息，不复制到客户资料目录；不得复制私有oracle、金标、历史答案或维护脚本。

```powershell
node 06-workbench/scripts/quarter-workspace.mjs --materials '<公开中文资料目录>' --workspace '<全新业务目录>' --plugin-root '<中国化finance插件目录>' --maintenance-dir '<独立维护目录>' --product-head '<PR后的精确后端SHA>' --plugin-head '<PR后的精确插件SHA>'
```

该操作只复制原件和宿主配置，不初始化账套、过账或计算答案。原件不改；账库、调用记录、原件读取记录、报告和输出均位于本次隔离目录。指定SHA时要求库已提交且干净。没有给版本锁的程序开发自测会如实记录dirty状态，不能冒充PR后版本。

## 持久会话与渐进工具发现

保持同一HTTP和原生MCP进程，原生派生引用和后台本地引用才能在同一会话内继续使用。执行Agent可通过`exec_command`的PTY会话和`write_stdin`逐次输入JSON，每条完成后自行决定下一项业务；不提供业务步骤数组或模板替换。

```powershell
node 06-workbench/scripts/quarter-session.mjs --workspace '<业务目录>'
```

正常命令示例（不是业务解题步骤）：

```json
{"method":"tools/list"}
{"method":"tool_schema","name":"account_context"}
{"method":"document/read","args":{"file":"业务委托.md","offset":0,"limit":80}}
{"tool":"account_context","args":{"accountSetId":1}}
{"method":"close"}
```

默认工具清单仅名称和简介，`tool_schema`才读取选中的真实原生合同，不手工注册或提前展开全量schema。正常direct工具保留，包括必要建账、科目、期初、凭证过账、资产、折旧、损益结转、账簿和实际报告。授权隔离目录外账库/文件、季度外业务期间会被拒绝；原生人审、封账、防重复等控制不放宽。`operationId`由调用者原样提供，宿主不替换、不自动重试写入；结果未知先核查原操作。

一次性诊断可用`quarter-call.mjs --workspace ... --tool ... --arguments-file ...`，但它退出会关闭本地会话，不能用于承接上次进程内summary派生引用。

## 读取原件与调用映射

业务资料须通过`document/read`或以下等价入口读取，而不是用任意shell读取。CSV以实际首行表头和行号分页；JSON可选明确字段，XLSX需工作表/表头，复杂格式拒绝时不得宣称解析成功。读取自动保留文件字节版本、原结构、返回范围及内容摘要，不让Agent手工登记。参数调用另由`businessEvidence`保存中文参数、来源表头/值、转换及规则采用理由；初读与传参两个时点分别核查。

```powershell
node 06-workbench/scripts/quarter-read.mjs --workspace '<业务目录>' --file '购销明细.csv' --offset 0 --limit 50
```

整理CSV为工具输入允许，不能用任意模型脚本代替已支持的成本、税率、折旧或结转计算，再称原生引擎整账通过。`finance_workpaper`计算底稿与实际过账分开；需要原生逐笔草稿/FIFO时按需查询`finance_workpaper_details`。输出保留模型通道摘要，不开放任意后台JSON读取。

## 报告与工作簿

按正常合同调用`finance_quarter_review`，例如`target:{accountSetId,period:'2026-03'}`，原生账库在一致时点生成三月和季度账表、HTML与机器bundle。完整科目余额、利润、资产负债、现金流量及中文映射状态都要核对；缺项和未分类不补零或用差额造分录。只有取到本次原生`bundleRef`后才导出工作簿：

```powershell
& '<Codex bundled Node绝对路径>' 06-workbench/scripts/quarter-export.mjs --workspace '<业务目录>' --bundle '<本次账表数据.json>' --output-dir '<业务目录/输出/全新产出子目录>'
```

导出只读取本次报告的`sheets`，不重算财税算法；数字/科目代码/未知分别保留，原件等号文本不成为公式。每张实际业务表的所有列分段生成预览供视觉核验，不能只看自测样表；长文本换行，超长字段以中文定位关联连续完整内容，不丢原表头或选值。完整HTML/XLSX的中文显示不暴露技术枚举、磁盘路径或调用标识；深入核验数据完整保留。首次作者按所在环境的表格技能要求执行创建操作标记。

宿主只负责工具运输，没有启动模型。实际执行Agent是独立宿主调用者，不能据此把业务过程称为“无模型”或伪称Pi；CLI无法取得其服务token/上下文时记录未知，不用文件字节估算冒充。宿主元数据、程序自测、PR版本及独立业务验收分别保存，新运行不覆盖旧记录。

## 程序检查

可移植的宿主与报告程序回归由现有`test-all.mjs`注册。独立oracle另运行`python -m unittest discover -s 06-workbench/test -p quarter-business-oracle-test.py -v`，不为它新增执行框架。

工作簿导出是显式本机集成验收：`node --test 06-workbench/test/quarter-export.test.mjs`，需要当前操作者已安装的Codex bundled Node、Python及artifact-tool依赖。此命令不加入默认test-all，避免普通clone/CI被个人本机环境阻断；缺少运行时会明确失败，不能称已验证导出。测试用临时账表，不调用模型或真实账库，不能替代独立Agent的完整业务验收。
