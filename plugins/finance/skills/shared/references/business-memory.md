# 企业短基线与按需历史

企业基线是特定企业、有效期间内的少量可执行做账原则。已有账套先用 `finance_baseline_read({target:{accountSetId,period}})` 读取当前短基线；四宿主共用这一服务。正文最多8条、600个Unicode字符，初始宿主企业记忆与必要加载规则合计不超过1000字符，不装配旧方法目录、案例、脚本或全部未完事项。

短基线读取对账库／索引／原件只读，不迁移或刷新；direct／宿主读取仍按既有调用记录机制保存安全来源观察，允许标准审计文件写入。

无有效基线、需要修订或与本期实际资料冲突时，读取 [基线生成](../../company-baseline/SKILL.md)，由 Agent 实读账套、代表性历史、合同／已有底稿／历史申报导出，调查后提炼并保存，再回读用于本期。`needs_generation` 不表示已完成；目录 prepare 只初始化技术目录，不生成做账原则。用户不必先写企业方案、内部 JSON 或挑脚本。账库、账套、本期和来源目录必须与当前任务一致；没有账库的账前任务可继续，不为读基线伪建账套。

`ready` 且条件相同时沿用，不为每张新凭证重建。本期金额按 [安全计算结构与本机取数](../../company-baseline/references/materials-and-save.md#按短基线处理本期的本机取数) 进入 `section:calculation`，不重翻全部候选／facts；按实际类型、期间粒度和任务对象计算，无输入不补零，有对象而本期条件未成可有据暂不确认。政策、长期原则或关键选择变化才换版；来源修改、缺失、不可访问、过期及实际冲突只核受影响原则。旧版留档不重复注入，历史错误不自动沿用。余额和合同进度按需查原账／原工具，不塞进基线；保存不代表财税人审或改变正式写账控制。

## 需要明细、执行版本或历史解释时

只有本次业务需要具体算法、脚本、分录来源或连续性调查时，才读下列旧方法／案例工具。它们继续可用，不能用目录存在替代已生成短原则。

1. **按需方法目录**：用 `finance_company_context`，传实际 `target:{accountSetId,period}`，用 `topics`、实际返回的 `objectRef` 限定任务，按 `offset` / `limit` 分页。需要核具体业务对象时一并传本期获准 `sources`。这是按需目录，四宿主默认常驻只读短基线；目录存在不证明模型已经采用，也不证明企业原则已生成。
2. **业务方法**：从实际返回选 `methodRef`，调用 `finance_method_read`。核对适用日期与含税/不含税口径、取数参数、去重键、分摊与舍入、科目角色、生效期、版本、执行方式、对象匹配和缺口。只读本次业务所需的方法；模型固定投影不返回原科目码、比较私值、自由原文或完整脚本。需要完整内容时由操作者在获准本机界面核对。
3. **相关案例和依据**：方法有缺口、历史处理有争议或本期不同，再按主题或实际 `objectRef` 用 `finance_case_search` 分页查相关案例；已知本机对象键也可用 `objectKey`。已过账/封账且来源当前的案例优先；草稿、失败、执行未审结果、本期和未来记录不得自动成为既定历史。`ledgerFact` 与 `sourceEvidence` 分看，已过账不证明来源仍有效。保留原件引用、版本变化和未核条件，不为节省上下文抹去争议。

读取是 `live_readonly` 当前快照，不暗写索引、不重算所有财务数字。成功原生 MCP 写入后台同步目录；正常已绑定 `finance_calculation_run` 自动核scope，完整调用记录落盘后再同步，方法脚本执行也形成后续案例。Agent不手工登记事实、归属、刷新状态或维护DAG。未绑定计算保持未知，不擅归企业。

旧方法目录的 `unprepared` 由正常绑定启动初始化；`finance_memory_prepare` / 启动器 `--prepare-only` 保留为显式初始化或人工恢复，不能把其 `prepared` 当成业务基线 `ready`。目录缓存 `stale` / `refresh_required` 与方法是否可执行分开，看当前方法/证据/对象状态处理，不能要求每做一笔业务先刷新。后台同步失败不改变已执行的结果，先查原操作，禁止为了同步重做业务。

## 解释跨期口径连续性

先核方法与执行证据，再解释金额变化：

1. 比较留存 `methodRef` / 方法版本、实际脚本或原生执行版本、日期/金额口径及取数定义；不以方法标题、科目路径或金额恰好相等判断算法。已证实沿用同一方法和执行版本，可以按证据说明沿用；证据不足既不推断不同，也不硬称相同。
2. 分别核各期对应的来源/计算快照及实际输入版本，区分金额、日期、数量、资料覆盖变化与方法变更。同算法使用新输入得到不同结果，不等于改口径；同金额也不证明算法一致。
3. 历史凭证和科目路径只证明已经记录的金额与科目；`algorithm_unknown` 表示算法未核，不能据此推出全额确认、某种分摊或与现方法不同。没有旧期对应版本原件或计算证据时，不拿已变更的本期原件回算上期作为历史差异结论，明确列为未核。若用户另要假设试算，应标明采用当前资料的假设，不能冒充历史处理。
4. 交付说明引用实际采用的方法/执行版本、相关输入版本与来源当前性。把“本期真实执行及金额”“已核连续性”“历史证据缺口”分开说；工具执行正确不能替报告中无证据的历史解释背书。

## 本期对象与输入

同企业同主题可有多套方法。稳定 `objectRef` 区分业务对象，不能按摘要顺序或相似名称套用。`definition.applicability.objectScope` 为 `account_set` 时适用于整账套；`business_object` 则用已保存的 `matchConditions` 匹配本期JSON来源。例如下面仅为合成条件形状，实际比较值保存在本机：

```json
{
  "objectScope": "business_object",
  "matchConditions": [
    {"sourceIndex": 0, "jsonPointer": "/business_key", "operator": "equals", "expected": "SYNTHETIC-LEASE-A"}
  ]
}
```

`sourceIndex` 对应本次 `sources` 中的位置。context/readMethod 只回 `matched`、`not_matched`、`unresolved` 及固定条件状态，不回显本机比较私值。run会重新匹配当前文件；不匹配或无法解析时拒绝，不能只凭旧摘要。任何非空自由 `scope` / `conditions` 都仍未决，即使旁边有 typed match 或曾被选择，也不能忽略其限制变成可执行；纯说明放 `notes`。确定性资产/结转方法使用结构化 `account_set`，不会把解释文字当机器限制。

`current_parameters` 的金额、日期、数量必须显式用本期值，不能回落上期 `default`。`source=constant` 必须使用保存值，caller不同值拒绝，缺保存值的方法不可执行；固定比例等常量不能在本期参数中改写。变量明确为 `current_parameters`，改固定值要保存并审阅新版本。按本期资料核对单位、税会口径和对象，不为缺参数填旧金额或零值。

脚本的匹配字节 SHA 必须与计算器实际采用的 snapshot 一致；不能用A1匹配后读取变化成A2的文件。采用版本不符时子脚本不执行该错误版本；执行后又发生来源/版本变化或可能已有副作用时保持 `unknown`，保留结果并核原执行，不盲重做。

原生 `business_object` 当前仅支持 `finance_tax_summary_calculate` 的 originals原件绑定：实际原件全部来自已匹配来源并强制匹配SHA，bindings仅引用这些 `originalId`，不支持该对象方法的 `artifactRef` 派生分支。A1匹配但actual originals来自A2必须拒绝。其他原生对象方法在context/read为 `nativeObjectBinding:'not_supported'`、`executable:false`；不能凭摘要 matched 宣称可执行。`account_set` 原生路径不变，支持范围按原工具合同判断。

## 采用与变更

`ledger_fact` 来自现库配置；`observed_history` 是观察到的历史处理；`operator_decision` 是本机操作者明确选择的版本；`candidate` 是待审建议。历史分录中的金额不能证明完整算法；缺算法、参数或依据时明确保留 `execution_missing`、`algorithm_unknown` 等缺口。

已有有效操作者选择可跨期、换工作区或换获准来源/记录根沿用，但仍须核对本期条件、来源当前性和已保存版本。当前上下文无法访问旧根标为 `unavailable_current_context`，不冒称已重核，也不等同来源已变。已知 `changed` / `missing` 保持并阻断依赖方法，不能通过换根或刷新洗白。执行用 `finance_method_run({target,methodRef,objectRef?,parameters?,sources?})`，只能运行保存的原生工具或脚本；不能在调用中塞入另一段脚本替换版本。支持的原生方法仍保留原工具业务结果和安全产物索引，原生人审、期间、账库身份、防重复及来源授权继续生效。

需要变更时用 `finance_memory_propose` 保存候选，写清生效期、结构化适用/取数/转换/科目、执行版本、证据与原因。模型不能自行设置 `operator_decision` 或代签；操作者通过本机交互审阅入口选择实际版本。入口展示受影响版本，选择新建不可变版本，保存生效/终止期、原因、`replacementPolicy` 和 `replaces`。同一主题/对象在本期适用的选择中，仅最新 `revision` 有效；有限或回溯区间外仍按原版本范围判断。候选保存不等于采用，合成TTY测试不是真人财税批准。

只读进程 `WORKBENCH_DATABASE_MODE=readonly` 拒绝全部记忆写入口；不能另开写连接绕过。独立改删历史版本禁止；整账删除沿用原生已授权操作并级联所属记忆，不能用SQL清历史。

企业方法和案例放在本机账库；`CLAUDE.md`、`AGENTS.md` 只存加载规则，不复制企业口径。Claude 原生 auto memory 在财税工作区关闭，不能把企业历史转存 `MEMORY.md`。报告仍按 [报告顺序](reporting.md)，记忆不是政策正确、会计审定、申报或付款完成的证明。
