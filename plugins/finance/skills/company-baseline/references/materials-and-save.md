# 材料调查、合并与保存

使用当前 `tools/list` 披露的合同。正文与本参考分别用 `skills_read({resource:"company-baseline/SKILL.md"})`、`skills_read({resource:"company-baseline/references/materials-and-save.md"})` 读取，参数名是 `resource`。

## 已有有效基线：沿用处理本期

`ready` 且适用条件未变时，以返回的 `baselineRef` 作为已存原则来源，直接按下方本期取数路径处理新资料；不为取得 `bp` 引用重翻旧 overview、重学旧口径或重算已记历史税负。只有生成、原则新增/变化或来源冲突时才走下面的生成/修订路径。

工具未投影字段不等于原件缺失；先核已存依据及对应原工具合同，仍有限制则说明实际边界。同一旧合同来源未变、前期进项已处理且无新用途或冲突时承接原结果，不重复抵扣、不无故转成本月资格未决；新票、新事项、用途变化或冲突仍核相关条件。

## 正常生成路径

1. 用实际 `target:{accountSetId,period}` 调用 `finance_baseline_read`，再优先调用 `finance_baseline_materials({target,extractKnownFields:true})`，不传 `originals`／`materialRefs`。工具从授权根有界发现当前 scope 已核主体且有已知语义的原件；陌生结构先走[通用原件适配](material-adaptation.md)，XLS／PDF／图片等实际读取能力及运行时状态由通用读取器披露，每批最多12份，物化真实读取；不要求已有方法、脚本或企业方案，不替 Agent 选择全部原则。
2. 看 `sourceDiscovery` 的 `selectedCount`／`remainingCount`、扫描边界及 `bypassed` 分类。按当前返回的 `sourceDiscovery.next.arguments` 继续，内含真实 `sourceCursor:{materialRef,snapshotDigest}`，继承已读材料闭包和已返回候选，不手抄前批引用或猜游标。普通候选余页走 `pagination.next.arguments`；实际返回 limit 可小于请求值，不能手算 offset，末页也不证明此前跳过页已读。主体、SHA、原件语义和历史关系仍由后端核验，不能用 target 自认归属。
3. 查看短 `principleSupport`、税费汇总及独立 `coverage`，按实际 `pagination.next.arguments` 完成本次需要的 overview 余页，不换查询套旧 offset。税摘要另有 `taxBurden.pagination.next` 时同样直接执行；覆盖诊断用 `section:"coverage"`，需要定位才读 `"structure"`／`"facts"`。`coverage.taxHistory` 的 `included`／`incomplete`／`not_in_supplied_materials` 分别核已包含、材料不齐及未带入；未选字段、范围未覆盖、歧义／不支持按原因补读。机器抽取事实不因明细页未展开丢失，不机械遍历全部 facts。宿主截断／另存说明输出未完整消费，应缩小范围或MCP续页完成，保持本路径不依赖原生文件读取；不能把投影读取受限写成客户缺资料。
4. 游标后批已继承前批闭包，使用当前返回的 `materialRef`／`snapshotDigest`，不重复累加同快照的分页引用。另有独立读取用于结论、税费或必要缺口时，显式传相关 `materialRefs:[{materialRef,snapshotDigest}]` 给 `finance_baseline_materials` 合并；仅同 scope、当前 SHA 可核的实际读取能合并。返回新单ref及统一支持／税费／覆盖。最多12个实际叶读取请求，不层层合并绕限；过多零碎读取可按原件批量重读，不能删税费引用凑上限。
5. 在当前完整材料结果里选择本次重要且条件适用的 `supportRef`，用 `finance_baseline_save` 保存；再用 `finance_baseline_read` 对照，确认所选原则和已核税负确实进入短文。引用遗漏／未完成调查导致的丢失要补读、合并并修正，不能在报告里另列税负后宣布基线完成。

下面只示正常入口形状，`target` 必须来自实际绑定；不让用户预填路径、selector、企业算法或预期答案：

```json
{
  "target": {"accountSetId": 1, "period": "2026-11"},
  "extractKnownFields": true
}
```

## 覆盖缺口决定下一步

| 返回的实际情况 | 继续动作 |
|---|---|
| 已提示字段但未选、相关页未取，或相关读取尚未合并 | 本次调查未完成，补读／续页／合并；不写成客户缺资料或待人审 |
| `sourceDiscovery.bypassed` 有主体未核／别家／无已知字段项 | 旁路项不同于所选来源；按 `coverage.sourceOwners` 和实际 `gaps` 判断所用材料，不把目录总量转成 `owner_unverified` |
| `scanLimited`、`uninspectedCount` 或 `depthTruncated` 表示发现有界 | 依本次任务核未检范围，必要时按已知原件定位补查；不声称已查全，也不把边界直接写成企业政策未知 |
| `valueState:local_only` | 原值已在本机读取，模型不回显；可用短支持判断，实际计算走下方取数桥，不当作缺件或零 |
| 同一对象的字段组不齐、尚无原生历史关联 | 补真实 `business_reference`、业务性质、履约方式、起止／验收、相关金额／税点／资产边界及对应历史；按判断选择必要字段，不因只选开票／金额就认定无方法 |
| 仅账套配置，`coverage.configurationOnly:true` | 已知会计准则可保留，历史基线尚未生成；补读历史，不填不存在的归集或成本方法 |
| 工具明确歧义、不支持、来源冲突，补查后仍无依据或需要操作者作真实业务决定 | 保留准确范围和影响，说明还缺什么及下一动作；独立可核分支继续，不猜值、不绕过投影 |

需要指定范围或补定位时，旧通道仍可用：`finance_baseline_materials({target})` 给 `sourceInventory`，按 `availableFields`／主体状态选择真实 `originalRef`，显式 `originals` 配 `extractKnownFields:true` 批读；目录也原样跟 `pagination.next.arguments`。低层 JSON 用实际 `fieldRef`，表格用已披露的数字行列／工作表。计价核 `inventory_cost`，行业标签不替代归类或计价；分类／期间支持核实际关联分录，整凭证合计不证明算法。`allocationBasis:monthly_equal` 只由实际支持产生，不能由 caller 自加。`group` 只是备注，分组依原件上下文／同行及跨源同业务引用。XLS／PDF／图片等走[原件适配](material-adaptation.md)，通用读取器与本机OCR保留原值和来源。`unsupported`／`needs_runtime`表示读取或环境限制，不能当客户没给资料；同一文件普通单元格可读，公式缓存不可当已核事实。特殊转换可用已授权的 `finance_calculation_run` 保留脚本与来源，派生文件不洗成独立原件。

## 保存前核对与回读

正常保存用当前完整闭包的真实单个 `materialRef` 和 `snapshotDigest`、最近一次 `finance_baseline_read/save` 返回的 `headRevision` 作为 `expectedRevision`、有依据的 `effectiveFrom`／可选 `effectiveTo`，以及 `principles:[{supportRef}]`；不拿当前期 `revision` 代替并发头或自行加1。短候选引用由工具绑定到原全证据，不能猜引用、拼接别家候选或自行声称已核／已审。Agent 筛选重要支持，不自动全选；相同原则及证据无需重复换版。旧 `kind/value/when/allocationBasis/evidenceRefs` 输入仍可用，只有确实需要手工选择时才使用，不让用户复制长 hash 或编内部 JSON。

保存成功和幂等均以 `savedVersion` 的 `baselineRef/revision/effectiveFrom/effectiveTo` 确认实际写入或命中版本；顶层 `baselineRef/revision/shortText` 仍是当前期适用视图。未来版 `applicableToTarget:false` 时，本期 ref 不变是正常结果，不反复重存或跨期读取；进入对应月份的新绑定会话后再召回。发生版本冲突时重读实际 `headRevision`，不绕过并发检查。

保存前核对主要业务／计价的结论或真实缺口、已核税费是否完整合并，以及未完字段／分页／引用动作。已读／已知相关税料须带入，不能漏传后缩小已知范围；单税可比资料可按已核范围 `ready`，另一税的 `not_in_supplied_materials` 仅表未纳入，不证明另有原件或税种适用，也不认定不适用、免税或0。核当前任务和实有资料，不因通用 `nextSteps` 无限查找、凑两税或凭空转人工待核。无可用汇总或实际已供资料不完整／冲突仍是 `needs_review`。`coverage` 独立于最多3项未决，`source_not_current` 按实际状态核来源。最多24个语义项仍合并为最多8条／600字符，可少于5条、不凑数。

回读重点看 `coverage.unselectedPrincipleBranches`：`items` 是最多4个未选语义分支，按 `kind/value/when/allocationBasis` 核适用范围，不能只凭兼容的 `supportedKindsNotSelected` 为空宣称完整。`basis`／`complete` 说明比较依据及完整性，`omittedCount` 表示另有未展开项；旧版的 `retained_current_evidence_subset` 仅比较当前可核保留依据，不证明全部原材料无遗漏，也不自动要求重建。重要分支确漏时回 overview 取真实 `supportRef` 再修订，不猜引用、不为提示清零全选、不一概改为 `needs_review`。同条件同处理才去重：仅同 `when` 且双方 `monthly_equal` 的 `expense_period/benefit_period` 与 `cost_treatment/allocate_benefit_period` 视为同义；用途归类、费用当期及其他条件不互代。

税费取实际同一统计行的税种、应纳／实缴、税额阶段、所属／缴款期间、本期／累计、税额及同口径分母。税额阶段必须符合源字段，不能靠选 stage 把应补改成总应纳。增值税按合计同口径税额／合计可比不含税销售额加权，不平均月百分比；所得税累计单列、不相加。仅累计VAT不支持可比区间时保留 `tax_basis_incomplete`，缺税费引用不等于企业没有历史税负；参考不倒挤本期业务。

业务原则按真实支持范围采用：行业标签不替代业务归类，同名业务的收入／支出方向也不能仅因 `when` 相同判为冲突。销项模板 `advance_invoice_period` 仅限已核的预收并提前开票同类租赁；本期须核条件不自动构成 `policy_unverified`，确疑规则则先用 `finance_rules` 核适用期间与条件。`income_tax_period` 说明计税收入所属期，不替代实际利润额／年度税基。未决须对应实际缺口，另一明细工具授权受限不反证已有材料支持无效；仅依赖该工具才能解决的分支仍说明受限。保存不代表人审或凭证授权。只读进程不保存或迁移账库；读取不改账库／索引／原件，仍按既有机制保存安全来源观察。

## 按短基线处理本期的本机取数

已有有效短基线且条件未变时，直接读本期安全计算结构，无须重走生成或遍历全部原则／facts：

```json
{
  "target": {"accountSetId": 1, "period": "2026-11"},
  "section": "calculation"
}
```

`calculationSchema.objects` 与本机 resolver 默认对象／字段集一致：`objectRef` 为不透明引用，`semanticValues` 只含受限业务枚举／布尔；`fields` 是当前对象真实规范字段名→语义类型的 map，`fieldPresence:"available"`，未列字段为 `not_available_in_bound_object`。`fieldTypes` 集中给 `jsonType/format/granularity`，不表示每个对象都有全部字段；金额、数量、单价或日期原值不回显。按实际枚举、字段组和任务范围匹配对象，不自造业务 kind 或凭相近对象代选。按返回类型／粒度区分 `date:YYYY-MM-DD` 与 `period:YYYY-MM`，不把月份默认变成月初日判日级覆盖。任务明示应处理却无匹配对象、必要字段或期间类型不明时，停相关计算，不拿历史金额、默认月数或无输入时的0兜底。已匹配对象而本期确认条件尚未成立，可按已核规则有据暂不确认并说明实际事件或证据缺口；不把计划日当实际事件，不强补所有 optional 字段或全局降基线。零结果须有实际对象和规则／条件依据。

沿当前 `pagination.next.arguments`／`sourceDiscovery.next.arguments` 取所需结构，使用返回的真实材料引用和 reader。明确非 overview 且无引用时会从授权范围实读已知字段；若显式 `extractKnownFields:false` 返回 `material_reference_required`，执行其恢复 next，不把 inventory 当事实结构。无 section 的旧 inventory／显式原件通道仍可按需补查。结构用于编写实际计算，不另写探针再尝试回读派生产物给模型。

用正常 `finance_calculation_run` 运行 JavaScript，将 `target`、完整 `reader:calculationReader`、`materialRefs:[{materialRef,snapshotDigest}]` 及可选 `factRefs` 放进 `parameters`；不机械展开 facts 抄hash。脚本按本次对象、实际合同条件及已读短原则计算，在本机核匹配范围、输入完整性和结果，缺口写入底稿；不能用猜测兜成数值。经桥取数可用 `sources:[]`，其他直接文件输入仍按计算器原合同提供。

本期产物固定命名为 `本期业务结果.json`、`本期业务底稿.html`，不在文件名编码金额、分类判定、诊断值或验收状态。交付实际产物、所用原则和必要未决，不另写探针或回读产物向模型回灌原值；工具执行状态不证明全业务通过。

以下是嵌入实际计算脚本的取数调用，不是业务算法或独立完成证明：

```javascript
import {readFileSync} from 'node:fs';
const input = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const {target, reader, materialRefs, factRefs} = input.parameters;
const resolveFacts = (await import(reader.moduleUrl))[reader.exportName];
const local = await resolveFacts({
  target,
  materialRefs,
  expectedReaderSha256: reader.sha256,
  ...(factRefs ? {factRefs} : {})
}, input.financeContext);
if (local.scopeVerified !== true || local.version !== reader.version) {
  throw new Error('baseline_local_scope_not_verified');
}
// local.objects 中的 values 仅供本机按当前短原则计算。
// 派生账表写入 input.outputDir，并保留 local.reader、
// local.materialRefs、local.sourceDigests 及相关 evidenceRefs。
// 不将 local、values 或 input.financeContext 输出到 stdout/stderr。
```

`input.financeContext` 由计算器父进程按实际配置装配，包含本机取数需要的账库／来源／调用根和会话绑定；不是模型填写的参数，不猜路径、不从原生环境或别家工作区补值。`calculationReader` 的 `moduleUrl`、`exportName`、`sha256`、`version` 均采用本次材料返回值；不从旧日志或相似模块猜入口。桥重新核真实调用完成状态、账库／企业／期间、当前来源和快照 SHA、reader 版本及可见 `factRef`；变化或不符时停止相关计算，重新调查，不改根或去掉 SHA 绕过。

桥只在本机返回规范字段对象 `objects:[{objectRef,values,evidenceRefs}]`，不向 MCP 注册原值读取工具，也不返回原主体／合同号。脚本可用规范金额、日期、数量／单价、枚举和布尔值按已读原则计算；库存需要时按实际材料选择 `opening_quantity`、`opening_unit_price`、`receipt_quantity`、`receipt_unit_price`、`issue_quantity`，原值同样仅本机消费。保存派生账表／底稿，不直接把原对象 dump 成“业务结果”。把 reader、材料及来源摘要与实际计算一起留在产物，说明缺件、适用条件与计算范围。MCP 返回执行状态、产物入口和引用，模型交付这些引用及规则；不能为了获知金额而打印原值、读取 stdout、原件／材料底稿或回读派生文件绕过模型边界。需要用户查看明细时指向本机产物。

本机取数及计算不追加基线，也不授予 SQL 写账、凭证批准、原件更改或额外资料外发权限。计算器继续是可信本机脚本执行器，不是操作系统安全沙箱。
