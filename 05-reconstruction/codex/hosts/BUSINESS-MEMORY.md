# 绑定企业、生成短基线与按需查历史

四宿主共用 `business-baseline.mjs` 的短业务基线服务。基线是特定企业、有效期间内少量有依据的做账原则；同条件沿用，变化或冲突只核相关原则。正文包含短适用信息，最多8条、600个Unicode字符，重要未决最多3项。初始企业记忆连同必要加载规则不超过1000字符，不默认注入方法目录、案例、脚本、余额或全部未完事项。

生成器只生成工作区，不建账、不生成企业原则、不读原生 memory、不猜第一家企业。企业基线、方法及不可变版本保存在实际账库；工作区只保存绑定和加载规则。

## 首次绑定与只读检查

按 [统一入口](START-HERE.md) 生成全新工作区，后端与 `--database` 必须指向同一实际账库。账套 ID 从实际已有账套核实。在生成目录运行：

```powershell
node ./start-business-session.mjs --account-set-id <实际账套ID> --period 2026-11 --prepare-only
node ./start-business-session.mjs --check
node ./business-memory-context.mjs --check
```

`--prepare-only` 写历史索引和 `.finance/business-session.json`，不调用模型；输出 `status:prepared` 仅表示技术准备，`baselineStatus:needs_generation` 仍是基线未生成。`--check` 核已有绑定及短基线，未绑定即报错；账库、索引和原件只读，不建表、不迁移、不刷新。direct／宿主基线读取经既有 `withFinanceCall` 自动保存安全来源观察，允许标准审计文件写入，不表示文件系统零写。正常启动准备技术目录，不能把这一步当业务调查。

绑定使用 `finance-business-session/1`，从实际 DB 解析 `databaseInstanceId`、`enterpriseKey`、`accountSetId`、`period`、`currency`，并固定工作区、`databasePath`、`sourceRoot` 和 `auditDir`。每次启动和读取重新核实际身份；替换成另一个账库即使账套数字相同也拒绝。换企业或期间生成新工作区，不能手改绑定或恢复另一企业会话。

只读 `WORKBENCH_DATABASE_MODE=readonly` 可以检查和读取，安全观察仍按标准调用机制留在审计文件；正常启动的目录准备、基线保存及记忆写路径会拒绝，不能另开写连接绕过。严格备份／恢复沿用账库组件控制；恢复为同一实际身份后重读版本和来源状态，另一实例继续拒绝旧绑定。

## 从账和原资料生成

Agent 先用 `finance_baseline_read({target:{accountSetId,period}})`。无有效版或需修订时，通过 `skills_read({resource:"company-baseline/SKILL.md"})` 进入 [基线生成技能](../../../plugins/finance/skills/company-baseline/SKILL.md)：

1. 优先 `finance_baseline_materials({target,extractKnownFields:true})` 有界发现并批读当前企业已核主体／已知语义原件，连同实际账套配置及代表性历史形成支持。
2. 看紧凑 overview 的支持、税费及独立 `coverage`；原样跟当前返回的 `pagination.next.arguments`／`sourceDiscovery.next.arguments`，实际页长可收缩，不手算 offset。未读相关页先补调查，不称客户缺资料；发现旁路不成为已选来源的主体缺口。
3. 游标已继承前批闭包；另行独立读取的相关材料须显式合并成单ref，再自主选重要 `supportRef` 保存，不自动全选、不只留最后一个子集。后端核来源／范围并还原真实证据。
4. 回读按 `kind/value/when/allocationBasis` 核重要业务分支及税负，不只看种类已出现；同条件同处理可去重，分支提示不要求全选或一概待核。漏字段／页／引用应继续修正，不在报告里另列后宣布完成。

材料工具直接读已有 SQLite 和获准导出；需要指定范围／字段时，仍可不带抽取标志读 `sourceInventory`，沿真实 `originalRef`、`fieldRef` 或表格数字行列补查，不依赖宿主 Read／Bash、旧 `methodRef`、预选脚本或预写基线。Agent 整理参数，不要求用户填内部 JSON 或写企业方案。行业标签不替代具体归类，不凭金额猜算法；真实分组依原件上下文／同行及同业务关系，不依 caller group。只读投影不扩大原件披露权限，不用宿主 Read／OCR／SQL／脚本绕过边界。详细定位、税负及保存参数见 [材料与保存合同](../../../plugins/finance/skills/company-baseline/references/materials-and-save.md)。

已有有效基线时直接 `finance_baseline_materials({target,section:"calculation"})` 看安全 `calculationSchema`，不重走生成或回读探针产物；结构与本机 resolver 同对象／字段集，只含受限枚举、字段类型和日期／月份格式。经 `finance_calculation_run` 的 JavaScript 消费真实材料引用／SHA及 `calculationReader`，按实际对象和期间粒度计算；无任务对象／必要输入停相关分支，不用历史金额、默认月数或0兜底。有对象而本期条件未成可有据暂不确认，可选字段空不全局待核。父进程装配 `input.financeContext`，不要求模型读原件或猜私有路径。规范原值只在本机计算并写派生底稿，保留 reader／来源摘要，不 stdout 或回读给模型；MCP 只返回执行状态及产物引用，执行成功不等于会计审定。

只记录有依据且能指导处理的结论。可以少于5条，不凑数；关键事实仍未知时明确生成未完成，不能把“准则未知、税期未知”排成清单宣称 `ready`。税负分税种、应纳／实缴、所属期／缴款期、本期／累计及可比口径；增值税按合计同口径税额除以合计可比销售额加权，不平均百分比，所得税累计单列。仅有累计VAT而无法形成可比区间时保留缺口，不静默 `ready`；缺资料不补零。历史区间是调查参考，不是本期倒挤目标。

## 状态、沿用和换版

| 返回状态 | 应做什么 |
|---|---|
| `needs_generation` | 没有可用短原则；按生成技能调查。技术目录存在不表示完成 |
| `ready` | 资料支持当前短原则；本期同条件沿用，具体金额仍读本期资料 |
| `needs_review` | 重要条件或冲突待核；只调查受影响规则，独立可核分支继续 |
| `stale` | 依赖来源已有变化／缺失；不能直接沿用受影响规则或用 prepare 洗白 |
| `outside_effective_period` | 本期超出保存范围；核有效期与本期适用条件，不自行延长 |

来源不可访问与来源已改分别处理，前者不能冒称已重新核验；已知变化不会因换资料根或重新准备变为当前。历史惯例与实际来源／规则冲突时先核实，不固化历史错误。普通新凭证、金额变化和执行结果由原业务工具留痕，不追加基线；长期原则或有效选择改变才换版，旧版留档不重复注入。

基线保存和 `ready` 不等于财税人审、正式入账、申报或缴款。余额、当期合同进度及本期参数仍读原账与原工具，不建第二套台账、事实登记或任务 DAG。

## 四宿主启动与生命周期

只执行与生成 `--host` 对应的一行；首次可把账套／期间参数放在 `--` 前：

```powershell
node ./start-business-session.mjs -- --pi-root '<官方Pi 1.1.0包绝对目录>'
node ./start-business-session.mjs -- --claude-cli '<Claude 2.1.309+ exe或JS入口绝对路径>'
node ./start-business-session.mjs -- --dsh-cli '<dsh包JS bin绝对路径>' --task '<明确业务任务>'
node ./start-business-session.mjs -- --zcode-cli '<ZCode exe或JS入口绝对路径>'
```

| 宿主 | 短基线装配 | 实际边界 |
|---|---|---|
| Claude Code | SessionStart `startup/resume/clear/compact` 读同一短服务，输出 `additionalContext` | 另对 fork 保守核验；不改业务库／索引／原件，安全观察按标准审计机制留痕 |
| Pi | 短基线追加到启动系统提示，保留原生 tool-search／deferred MCP | 未提供额外生命周期 hook；会话内按需重读 |
| dsh | 短基线与必要入口放在本次明确任务前 | 未声称有原生生命周期 hook；后续任务重新启动或显式读取 |
| ZCode | 工作区 AGENTS.md 要求先调用 `finance_baseline_read` | 未假设未经核实的提示注入 API；是否实际读取看工具轨迹 |

Claude 项目设置 `autoMemoryEnabled:false`，启动进程同时设置 `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`；不改用户全局设置、不迁移或删除旧 memory，不读原生 `MEMORY.md` 或 transcript。`CLAUDE.md` 只存加载规则。exec-form hook 将 Node 和脚本分别配置，避免 shell 引号改变参数。

每次新启动／clear 的会话侧文件只保存最小 `session_id→scope` 身份元数据到 `.finance/claude-session-bindings`；resume／compact 核已有映射，不保存企业原则副本。企业读取另按标准调用机制记录安全来源观察。没有映射或身份不符的旧会话拒绝恢复。SessionStart 的退出码不能独自阻止模型请求，`UserPromptSubmit` 另设身份守卫。启动器固定 MCP、项目 settings、cwd、auto memory 隔离及恢复 ID；额外 argv 不得覆盖。

```powershell
node ./start-claude.mjs --claude-cli '<实际CLI绝对路径>' --check
node ./start-claude.mjs --claude-cli '<实际CLI绝对路径>' --resume '<本工作区已绑定UUID>'
node ./start-claude.mjs --claude-cli '<实际CLI绝对路径>' -- --print --allowedTools 'mcp__finance__finance_baseline_read' '读取当前企业短基线并说明是否需要生成'
```

提示词独立放在原生 argv 的 `--` 后，避免被 `--allowedTools` 等可变长选项吞掉。`--setting-sources project` 排除用户／本地设置覆盖，组织策略仍按原生规则生效。`--no-session-persistence` 只控制 transcript，不代替 auto memory 隔离。直接运行未包装的原生 CLI 不证明已有绑定或短基线装配。

## 旧方法、案例和执行版本按需可用

需要明细、可执行脚本或历史解释时，再以真实 target 用 `finance_company_context` 限主题／对象分页读目录，按实际 `methodRef` 读 `finance_method_read`，有疑点再查 `finance_case_search`。这些工具不是默认常驻内容，也不代替基线生成。具体对象用实际 `objectRef`／typed match；已选方法仍核生效期、来源状态与本期参数。候选不是本机操作者选择，模型不能自批。

`finance_method_run` 只运行保存版本；本期金额／日期不能回落旧默认值，constant 不能被 caller 改写。匹配来源 SHA 必须与实际执行快照相同；后置变化或可能副作用保留 unknown 并查原执行。原生 business_object 当前仍仅支持 summary originals 绑定分支，不泛化到全部原生工具；正式凭证人审、期间、防重复及账库隔离继续生效。详细限制见 [企业记忆参考](../../../plugins/finance/skills/shared/references/business-memory.md)。

正常写入／已绑定计算的后台历史同步保持原行为；读取为当前只读快照，不要求逐笔 prepare。旧方法审阅入口 `06-workbench/scripts/review-business-method.mjs` 仍是本机真实 TTY 操作者选择，不能用模型 JSON 或合成 TTY 代替人审。旧 [business-memory-acceptance.mjs](../../../06-workbench/scripts/business-memory-acceptance.mjs) 现场预置了方法及模拟选择，只能检查旧方法接续，不能用于本轮无预设短基线冷启动验收。

## 冷启动模型验收与证据边界

在仓库根用 [短基线阳性脚本](../../../06-workbench/scripts/business-baseline-acceptance.mjs) 准备全新现场：

```powershell
node 06-workbench/scripts/business-baseline-acceptance.mjs prepare '<已存在父目录/全新合成绝对目录>'
node 06-workbench/scripts/business-baseline-acceptance.mjs check '<刚生成的合成绝对目录>'
```

`prepare` 只建立合成账与原件、绑定宿主并生成任务文本，不保存基线、不选择方法、不启动模型；`check` 核范围、源码／原件摘要及短投影，不改账库／索引／原件，正常安全观察允许写审计文件。给实际模型现场的 `模型任务-1生成甲基线.txt`，完成后以同绑定重启或 compact，再给 `模型任务-2重启后处理甲7月.txt`；乙企业使用自己的工作区及 `模型任务-乙独立冷启动.txt`。`reviewer-only`、独立预期、测试输入／源码和验收脚本仅供验收者，不能喂给被测模型。实现源码变化后需生成新现场，不沿用旧源码摘要的通过结论。

实际模型任务完成后，验收者运行 `node 06-workbench/scripts/business-baseline-acceptance.mjs assess '<该现场绝对目录>'` 核实际调用、短基线及本期计算产物；它不调用模型，也不单独证明官方模型、真实生命周期或财税政策正确。仍须审查实际 Claude 轨迹、事件、追加上下文及业务解释。

使用独立全新合成现场，至少两家企业、不同准则／计价或期间策略、数期历史和新一期业务。自然任务可写：

> 接手指定企业并处理本期业务。先从实际账库和获准资料了解应沿用的做账原则；缺少有效短基线时调查、生成并保存，随后处理本期同类新业务。资料冲突或不足时说明影响与补件，不猜未知。

给被测模型实际账库范围、资料路径与业务目标；不给预期原则／税负、测试源码、已写方法、已选脚本或独立预期。模型应实际读生成技能、账与材料、保存再回读；重启或 compact 后沿用新短版。不能用工具调用次数、配置成功或程序测试数量替代原则质量与本期业务结果。

验收逐项留实际证据：短规则是否清楚且可执行、税负口径和计算、材料缺失、历史冲突、来源修改、跨企业、只读、恢复；Claude 的真实 `startup/resume/clear/compact` 事件、模型读技能与材料、保存版本及本期金额分别记录。Claude Code 2.1.309+、官方 `deepseek-flash`、`high` 的真实合成模型调用由管理侧按已有授权执行；这里的程序测试不声称已覆盖真实模型行为。

在仓库根可复跑宿主及插件验证：

```powershell
node 06-workbench/test/business-memory-hosts.test.mjs
node 06-workbench/test/finance-host-config.test.mjs
node 06-workbench/test/host-dsh.test.mjs
node 06-workbench/test/host-zcode.test.mjs
node --test 06-workbench/test/host-claude-argv.test.mjs
node --test plugins/finance/tests/structure.test.mjs
```

后端基线、独立冷启动 E2E、旧方法存储／执行及严格恢复使用 [代码索引](../../../docs/CODE-INDEX.md) 中各自套件。`business-memory-hosts.test.mjs --prepare '<已存在父目录/全新合成目录>'` 仅保留宿主绑定现场；它不启动真实 Claude 或模型，不是真人审批，也不构成冷启动生成通过。审查记录实际命令、退出码、基线 SHA、最终 diff／源码摘要及未验证范围；配置与模拟不得预填最终验收。
