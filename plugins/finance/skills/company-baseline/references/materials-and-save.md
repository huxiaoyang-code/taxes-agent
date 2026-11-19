# 历史税负与既有本机取数

## 按需查历史税负

需要解释跨月波动时，从实际账簿和历史申报材料核本期差异。已接收的兼容材料也可通过 `finance_baseline_materials` 的 `section:"tax"` 查询。仅比较同一税种、应纳或实缴、所属期或缴款期、本期或累计及相同税额阶段。增值税用同口径税额合计除以可比不含税销售额合计，所得税累计单列。缺资料时说明本项无法对照。

## 兼容旧材料消费者

既有流程若显式需要材料工具的候选投影，可沿原有合同读取已整理的本机观察。账套口径的日常保存和读取走 `MEMORY.md`。

```json
{
  "target": {"accountSetId": 1, "period": "2026-11"},
  "inputPath": "<审计根>/agent-materials/按需观察.json",
  "section": "overview"
}
```

## 兼容本机取数

已有计算脚本依赖 `calculationReader` 时，用 `finance_record_contract({recordType:"baseline"})` 和[宿主原件读取](material-adaptation.md)准备所需观察。调用 `finance_baseline_materials` 时选 `section:"calculation"`；已有仍适用的本期材料引用可直接传入。

```json
{
  "target": {"accountSetId": 1, "period": "2026-11"},
  "inputPath": "<审计根>/agent-materials/本期观察.json",
  "section": "calculation"
}
```

`calculationSchema.objects` 与本机 resolver 默认对象／字段集一致：`objectRef` 为不透明引用，`semanticValues` 只含受限业务枚举／布尔；`fields` 是当前对象真实规范字段名→语义类型的 map，`fieldPresence:"available"`，未列字段为 `not_available_in_bound_object`。`fieldTypes` 集中给 `jsonType/format/granularity`，不表示每个对象都有全部字段；金额、数量、单价或日期原值不回显。按实际枚举、字段组和任务范围匹配对象，不自造业务 kind 或凭相近对象代选。按返回类型／粒度区分 `date:YYYY-MM-DD` 与 `period:YYYY-MM`，不把月份默认变成月初日判日级覆盖。任务明示应处理却无匹配对象、必要字段或期间类型不明时，停相关计算，不拿历史金额、默认月数或无输入时的0兜底。已匹配对象而本期确认条件尚未成立，可按已核规则有据暂不确认并说明实际事件或证据缺口；不把计划日当实际事件，不强补所有 optional 字段。零结果须有实际对象和规则／条件依据。

沿当前 `pagination.next.arguments` 取需要的结构，使用返回的真实 `materialRefs` 和 `calculationReader`。结构描述已提交的观察。需补新原件时先在宿主本机提取，再提交新的整理件。

用正常 `finance_calculation_run` 运行 JavaScript，将 `target`、完整 `reader:calculationReader`、`materialRefs:[{materialRef,snapshotDigest}]` 及可选 `factRefs` 放进 `parameters`；不机械展开 facts 抄hash。脚本按本次对象、实际合同条件及当期适用口径计算，在本机核匹配范围、输入完整性和结果，缺口写入底稿；不能用猜测兜成数值。经桥取数可用 `sources:[]`，其他直接文件输入仍按计算器原合同提供。

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
// local.objects 中的 values 仅供本机按当期适用口径计算。
// 派生账表写入 input.outputDir，并保留 local.reader、
// local.materialRefs、local.sourceDigests 及相关 evidenceRefs。
// 不将 local、values 或 input.financeContext 输出到 stdout/stderr。
```

`input.financeContext` 由计算器父进程按实际配置装配，包含本机取数需要的账库／来源／调用根和会话绑定；不是模型填写的参数，不猜路径、不从原生环境或别家工作区补值。`calculationReader` 的 `moduleUrl`、`exportName`、`sha256`、`version` 均采用本次材料返回值；不从旧日志或相似模块猜入口。桥重新核真实调用完成状态、账库／企业／期间、当前来源和快照 SHA、reader 版本及可见 `factRef`；变化或不符时停止相关计算，重新调查，不改根或去掉 SHA 绕过。

桥只在本机返回规范字段对象 `objects:[{objectRef,values,evidenceRefs}]`，不向 MCP 注册原值读取工具，也不返回原主体／合同号。脚本可用规范金额、日期、数量／单价、枚举和布尔值按当期适用口径计算；库存需要时按实际材料选择 `opening_quantity`、`opening_unit_price`、`receipt_quantity`、`receipt_unit_price`、`issue_quantity`，原值同样仅本机消费。保存派生账表／底稿，不直接把原对象 dump 成“业务结果”。把 reader、材料及来源摘要与实际计算一起留在产物，说明缺件、适用条件与计算范围。MCP 返回执行状态、产物入口和引用，模型交付这些引用及规则；不能为了获知金额而打印原值、读取 stdout、原件／材料底稿或回读派生文件绕过模型边界。需要用户查看明细时指向本机产物。

计算器按调起它的本机权限执行。账务写入、数据披露和原件读取分别遵循实际授权。
