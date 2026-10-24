# 本机期末只读准入与派生计划

本片从实际原始资料和已经正式入账的业务核对一个月的期末准入，输出既有 batch v1 能验证的固定 manifest。它不执行结转、计提、报表、结账、税额计算或确认；`authorizesExecution`、`periodComplete`、`submittable` 恒为 false，任何旧 JSON 均不是执行授权。#80 与 #76 仍 OPEN，会计人工审定及业务试用 pending。

在 `06-workbench` 调用 `runOfflinePeriodPlan(request)`（`server/offline-period-plan.mjs`）。严格请求恰好如下四字段；API 路径必须绝对，CLI 的 inputPath 可相对于请求文件解析。

```json
{
  "version": "offline-period-plan-input/1",
  "inputPath": "<现有offline-action-input/1文件绝对路径>",
  "target": {
    "dbPath": "<现有workbench.db绝对路径>",
    "databaseInstanceId": "<实际活动审计实例>",
    "enterpriseKey": "<实际规范企业身份>",
    "accountSetId": 1
  },
  "month": "2026-01"
}
```

不接受 ready、分录、科目选择、预先税额、候选对象、恢复回执或 manifest 作为输入；拒绝多余/隐藏/访问器/symbol/Proxy 属性。企业与账套须已有一对一规范绑定，不能猜名称或新建、改绑。不会导入默认 db.mjs，不修改环境配置。

输出 `offline-period-plan/1` 的 status 为 `ready_for_manifest`、`blocked` 或 `needs_local_review`。ready 表示当前窄范围证据足以产生计划，绝不表示会计已审定、关期或申报完成。主字段为 month/target/scope、bindingDigest、evidence、issues、customerRequest、periodCheck、remediableSteps、notApplicable、manifest。evidence 保存实际文件 SHA/来源、逐业务 dependencyDigest/policyDigest、实际审计/来源/凭证/行号 proof 和当前代码清单；这些内容仅写本机文件，stdout 只显示受控状态。

## 准入范围

当前只支持 small-2011-basic-v1 完整默认科目库存，实际账套启用首月（非12月）；原始资料声明明确 new_zero + first_period、真实期初为零、无前期业务、工资和资产明确不适用且有声明依据，实际卡片/计提登记/总账不矛盾。不推断缺失为零，不把文件数或百分比当准入。期初余额或历史附件解析、资产/工资/必填辅助维度、后续月份、年末及已有结转/折旧来源解释尚未支持；需具体补件或本机核查，保持 blocked。Q2 首月使用真实4月日期，不改写为Q1；此能力不扩大旧 VAT v1 的 Q1 范围。

复用 openOfflineActionInput/buildOfflineActionPlanFromFiles 的真实读取、完整度矩阵、账户库存、coverage 和业务判定。关键 missing、conflict、unknown、unsupported、provided_invalid 与 not_applicable 分开保留。无日期/无法确认影响期间的未决分支保守阻断整月。已明确在其他月份的候选保持实际日期，不因它尚未入账阻断本月；本月每一候选必须通过现有 runOfflinePosting(query) 对真实持久审计、source/batch/link、normal 凭证和严格逐行分金额的恢复证明。未入账不能成为已完成，独立业务已 applied 也不能盖过整月缺项。同期间无法解释的凭证或来源/批次关系阻断。不会要求客户先做分录；本地审计、来源、待入账问题面向操作者处理。

预付款保持1123资产，本片没有自动月摊。实际负现金/银行余额转需要复核并索取资金来源事实，不补造期初或分录。三类实际过账的合成验收保留负银行阻断，ready 主验收采用无期初的未收销售+未付行政，不为测试凑资金。

## 固定 manifest 与期末检查

复用纯 buildPeriodEndCheck，不重造试算、折旧、结转金额算法。除 `profit_not_carried_forward` 外，实际 blocking 均阻断计划；待损益结转是系统后续可执行步骤，不能要求客户预先手工结转。ready 固定一个账套、一个实际月、concurrency=1：必要 carryforward(yearEnd=false) → periodCheck → 五种内部 CSV（资产负债、利润、现金流、试算、1122应收明细账）。无 imports/post；无资产计提明确 not_applicable，depreciation=false；close=false。所得 manifest 必须通过既有 validateManifest。

会计确认与期末结账分开（#83）：不能为底稿或内部报表先封账。本片只展示真实 periodCheck 的可关期状态及阻塞，不授权关期。尚未执行必要结转时，periodCheck.ready 可为 false，同时计划 ready_for_manifest；输出 remediableSteps 说明尚未执行，不伪造结转回执。尚无连续月执行、批量状态接续、修正重算/反过账、结果确认或税局行为。既有 VAT 对非 normal 凭证的拒绝守卫保留，未来结转后税计算需另做明确支持。

## 当前性、只读与本机 CLI

固定新 Node worker 隔离父进程缓存和默认 DB，实际 DatabaseSync(readOnly=true)，只使用 SELECT 与只读事务。调用前后比较全表/schema 用于检测本次零写/并发变更；返回的 ledgerDigest 另按目标账套截至本月的科目、期间、期初、凭证/分录、卡片/计提/来源关系以及全局 schema/活动实例组成。其他企业或无关审计行不进入本计划 binding；它们在调用进行中改变可能导致保守重试，之后生成的本账 binding 不变。逐业务 audit proof 由03B真实查询取得，不构造成功回执。

父进程 spawn 前实读固定代码闭包；新 worker 在加载应用前比较其初始/当前清单和父清单，加载后及调用前后重核。固定 posting worker 的 URL 不是 import，已显式纳入扫描；不依赖父缓存的会计模块。应用/原件变更、账务变更、DB路径/硬链接/实例变化均不得复用旧准入。DB逐级真实路径、单硬链接和持有fd身份重核，结束持有的只读快照后再读取当前全表核查。不能证明未被观测的检查间改后恢复、恶意并发绝对排除、Node或外部依赖字节完整性；没有引入锁、journal、DDL 或迁移。本片未接入在途batch3。

```powershell
node scripts/offline-period-plan.mjs --input <request.json> --output <NEW-plan.json>
```

CLI先wx预留新输出，现有输出直接拒绝。写文件并sync后，重读请求并重新进行实际完整只读准入；差异/输出故障返回固定错误摘要，尽力把已预留文件改为 `manifest:null`、`period_plan_publication_unverified`，不能将失败产物用于执行。底层输出彻底不可写时只能报告失败，无法承诺修复该文件。缺件清单和本地文本只生成文件，不发消息。

回退以新 revert PR 撤销这八个新增文件；本片无业务写入，不回滚/删除既有03B入账。执行器必须重新读取真实资料与账务后采用固定操作，不能信任复制的ready文件。
