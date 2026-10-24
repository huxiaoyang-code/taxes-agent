# OFFLINE-04D：同一物理只读源上的 Q1/Q2 私有上下文

本片是 Issue #81 的依赖切片：真实读取同一明确目标 DB 上的 2026-Q1 与 2026-Q2，私有持有两期原件、账务快照和同源证明；Q1 在固定的新 Node worker 中重跑现有 v1 全部守卫。Q2 只有实际 4–6 月材料、会计事实、税务业务事实和已过账账务对账，尚无 Q2 税额、累计数或申报能力。#81 保持 OPEN。

```js
import {
  openOfflineVatPairContext,
  assertOfflineVatPairContextCurrent,
  closeOfflineVatPairContext,
} from '../server/offline-vat-pair-context.mjs';
const opened = await openOfflineVatPairContext({
  version: 'offline-vat-pair-request/1',
  priorInputPath: 'D:\\synthetic\\q1\\input.json',
  targetInputPath: 'D:\\synthetic\\q2\\input.json',
  target: { dbPath: 'D:\\synthetic\\data\\workbench.db',
    databaseInstanceId: '00000000-0000-4000-8000-000000000000',
    enterpriseKey: 'SYNTHETIC-ENTERPRISE', accountSetId: 1 },
});
try {
  if (opened.receipt) await assertOfflineVatPairContextCurrent(opened.receipt);
} finally {
  if (opened.receipt) await closeOfflineVatPairContext(opened.receipt);
}
```

请求是严格普通对象，全部自有字段必须是可枚举数据属性；隐藏属性、访问器、symbol、Proxy、额外字段均拒绝。API 三个路径为绝对路径。target.accountSetId 必须为实际安全正整数，两个原件 scope.accountSetId 必须是同一整数的唯一规范十进制字符串（`01` 不接受）。scope 分别严格为 `2026-Q1` / `2026-Q2`、同企业、CNY / yuan。每期沿用 `offline-vat-input/1` 原件契约，只允许 materialsInput/materialStore 二选一；本片不消费 previousComputation。

成功结果 `status=pair_bound_prior_q1_recomputed` / `targetBinding=same_held_readonly_source`。`priorComputation` 是真实 Q1 重算；`targetDiagnostics` 独立保留完整度、unknown/unsupported、来源/金额/凭证类别诊断以及真实四月凭证对账；它不会把历史缺口改成 ready。只有实际Q1 calculationReady且January额外准入门均通过，才表示已有效提供可桥接历史证据，明确 `priorEvidenceProvided=true`、`actualQ1Recomputed=true`；失败时这两个字段均为false。`historyReadinessIntegration=not_implemented` 是操作者/工程集成阻塞。`binding` 给出两期 scope、inputDigest、ledgerDigest、bindingDigest 和关系说明，都是诊断，不能代替内部能力。Q2 的 `balances_required` / `prior_required` 在旧评估中仍给出 opening/history missing；本片保存在 `legacyHistoryIssues` 和标注 legacyHistoryGate 的原始 rows，明确 `audience=operator_engineering`、`customerActionRequired=false`，从当前材料 `issues` 中分离。实际 Q1 已持有/重算，不能据此重复向客户索取同一 Q1 原件或前期算好数字；历史准入桥仍待实现，不代表缺失客户已提供的材料。这不抹掉已核实物理同源，也不放宽旧 gate。真正 Q2 缺件/未知/不支持仍在当前 `issues` 中。两期同企业的form/establishedOn若为不同已知值，当前issues明确给出具体字段及cross_quarter_*_conflict/classification=conflict；Q2 unknown/null保留unknown。物理同源不代表原件中的企业事实已经一致。

`q2CalculationReady`、`authorizesExecution`、`periodComplete`、`submittable` 始终 false；accountantApproval 为 pending、sourceAuthenticity 为 unverified。公开诊断可以复制编辑，不能消费为授权；receipt 是本进程 WeakMap 登记的冻结 null-prototype 不透明对象，JSON/克隆/其他上下文不能替代它。

物理提供者实际打开一个 readonly SQLite 连接及文件 fd。在同一次 `withReadSnapshot` 事务内分别读取 Q1、Q2 范围，私有 WeakMap 记录 source、capture 组、两个 snapshot 的对应关系。两份配置中的 DB 路径必须实际对应这个明确目标文件，不能仅比较公开 audit instanceId 或内容 SHA。活动 audit instance、企业唯一绑定、实际整数账套、持久 profile 必须匹配。拒绝链接/硬链接/被替换路径；Q1/Q2 分别指向原库与同实例克隆时拒绝。若两份配置与 target 全部重新指向同一个克隆文件，fresh provider 无法从复制的审计行证明其官方恢复来源；本片不提供 W4 恢复来源认证。

两期 loader 都保留旧私有 raw/session/source/snapshot 守卫；每次 IPC current 前后重新核对两套原件/映射/声明/事实/receipt-store、两份真实 snapshot 及同 capture 证明，再实际 Q1 重算与 Q2 诊断。发现变化永久退休原上下文，恢复相同字节不能复活；关闭 await 实际 worker exit，超时、退出、断联均 fail closed。

代码闭包包含旧 28 模块、三个新 pair 模块与 CLI，共 32 项。新 pair-code 只有 native fs/crypto imports 和字面清单；父进程在 spawn 前捕获，worker native-only bootstrap 在动态加载应用模块前比较，加载后以及每次计算前后再次比较，父进程收到回复前后复核。观察到代码变化后进程永久要求重启；父缓存税模块或其他默认 DB 不能替代 child 的实际执行。SHA 是本机完整性检测，不是来源真实性认证；未观察到的 ABA、恶意并发所有窗口不能绝对排除，也不承诺抵抗控制本机 Node 原生模块/运行时的攻击者。

CLI：`node scripts/offline-vat-pair.mjs --input request.json --output new-diagnostic.json`。请求内路径相对请求文件解析，输出必须是新本机 JSON 文件（wx）；写入、sync 后复核请求与 context，失败尽力将产物覆盖为 failed / not_verified。stdout 仅固定状态/数量，不泄露原文、路径、SQL 或 stack。退出码 0 为本片双期绑定诊断成功，3 为阻塞/不支持诊断，2 为用法错误，4 为读取/发布拒绝；文件不是可复用授权。

旧 single-source/single-session API 保持；旧 snapshot / Q1 / prior-context 守卫未放宽。无默认 DB 导入、DDL、安装、账务/审计/batch/period 写入，无外部网络或消息。验证仅用临时合成原件/DB；新用例从原始资料经 OFFLINE-03B 公开 formal posting 实际入账，两季度分别真实业务，未预制正式分录。回退走本片 11 路径的新 revert PR，旧两文件恢复原 API 实现；无数据回滚。
