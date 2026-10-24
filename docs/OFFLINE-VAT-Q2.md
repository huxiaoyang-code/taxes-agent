# 离线 Q2 选定增值税字段

本能力只读合成或操作者明确指定的本机资料和账套。在固定 fresh Node worker 内用同一物理文件、held source/fd、同次 SQLite read transaction 的私有双期 snapshot，实际重新计算 Q1，再核对真实 Q2（2026-04-01 至 2026-06-30）材料、已过账凭证和历史来源。输入是基础资料及业务事实，不要求客户提供分录、前期算好税数或最终税额。旧 Q1 v1、04C prior-only、04D pair API 与 32 文件闭包保留，旧 pair 的 q2CalculationReady 仍为 false。

## API 与本机 CLI

`server/offline-vat-q2.mjs` 导出 `await runOfflineVatQ2(request)`。请求为普通对象，全部属性必须是显式可枚举数据属性，无多余、隐藏或 Symbol 字段；Proxy、getter、相对路径、字符串或非安全整数账套 ID 均拒绝。请求形状：

```json
{
  "version": "offline-vat-q2-request/1",
  "priorInputPath": "D:\\synthetic\\q1\\input.json",
  "targetInputPath": "D:\\synthetic\\q2\\input.json",
  "target": {
    "dbPath": "D:\\synthetic\\data\\workbench.db",
    "databaseInstanceId": "实际活动实例 UUID",
    "enterpriseKey": "实际企业标识",
    "accountSetId": 1
  }
}
```

两期 input 配置沿用 `offline-vat-input/1` 的真实 file-backed 材料／材料接收仓库、声明、会计事实、税务事实和显式 DB 路径。禁止 previousComputation；两期必须都指向同一 held 物理 source，不能以同 UUID 的另一份 clone 替换其中一边。两份配置全部重新指向同一克隆，无法单凭本地 UUID 证明它来自官方恢复；本能力不作来源认证。

返回 `offline-vat-q2-diagnostic/1` 纯 JSON，包含 `computation`（真实 Q2）、`priorComputation`（本次 worker 实算 Q1）、`binding`、`proof`、`inputFiles`、`codeBinding` 和顶层 `contentDigest`。成功状态为 `q2_selected_fields_calculated`；未满足范围保留 blocked／unsupported 及逐项 issues；代码变更已观察后为 restart_required。读取失败不伪造零税额。`checkOfflineVatQ2Current(request, expectedContentDigest)` 接受**顶层诊断摘要**，每次 fresh 重算并返回 current／stale／restart_required 及完整 fresh diagnostic。猜中摘要或复制 JSON 不产生任何执行权限。

低层 `tax-calculation.mjs` 的 `await calculateOfflineVatQ2(session)` 只接受真正 `openVatInputPairFiles` 产生、尚未关闭的私有 pair；它验证 pair 注册、同捕获 snapshot 产品、双边 session/raw/source/snapshot 精确 tuple，以及原始 bytes 当前性，再在函数内重算 Q1。公开 session 对象、替换 raw、snapshot JSON 或旧 Q1 结果都不能认证。该低层返回 `{priorComputation, computation, proof, inputFiles}`，正式用户入口使用上述 fresh facade。

```text
node scripts/offline-vat-q2.mjs --input request.json --output result.json
```

CLI 请求中的资料与 DB 路径相对 request 文件解析，API 只收绝对路径。输出以 `wx`、0600 创建，既有文件不覆盖；写入和 sync 后实际启动另一个 worker 再读双期、重算 Q1/Q2，并比较包含代码、原件和账务绑定的顶层摘要及 request 原 bytes。成功 exit 0；业务 blocked／unsupported 诊断 exit 3；语法 exit 2；发布窗变化／创建失败 exit 4。失败时尽力将自己已创建的输出标为 failed，但 truncate／write／sync 也可能失败；exit 4 下可能残留的诊断不能当成功或授权。输出只作诊断，不含可恢复 receipt／授权。

## 历史桥与计算范围

仅支持 2026 年一月新设、January 起账、原始期初确为零的企业（非个体或自然人），两期会计确认季度小规模资格。同企业、规范账套整数、活动实例、会计 profile 和初始账务必须一致。Q1 必须实际通过旧 v1 的所有材料、资格、完整业务、排除事项和账务守卫，再通过一月设立的额外限制。Q2 明确声明 opening=balances_required、history=prior_required 且有会计证据；全部 prior_history 凭证、entries、来源与 batch 关联必须恰为这次实际 Q1 已解释集合。不得把 Q2 改成首期、改日期或忽略 prior_history。

桥仅解决旧矩阵 opening/history **missing 且具体 reason 对应旧格式未集成**的两行；未知、冲突、不支持的外部材料仍保留。客户已经提供有效 Q1 原件时，无需再提供预先算好的前期数字；工程未支持归操作者处理。两期企业 form／establishedOn 的已知矛盾明确 conflict，unknown／null 仍为 unknown。所有当前和历史 draft、未知状态、非法 money、非 normal kind、额外业务、未解释源和 batch 行均阻断。

两季度各自销售净额 S ≥ 300000 元（包含等于）。只支持普通、境内消费、普通主营服务，各原票净额为整数元、票税确切为净额 1%，实际正式过账 VAT 与票税一致；所有排除事项有会计确认无业务。金额使用 BigInt 分计算。整数元是避免未实现舍入政策的工程限制，**不是官方舍入规则**。低于起征点、分位净额、原票税需调整、其他税种及其他业务继续 blocked／unsupported。

逐票基础业务事实保留原 schema 允许的 owner／business_operator／accountant 角色，须有有效原资料引用与真实账务匹配；不额外要求会计逐票审批。企业、整期、排除事项及资格登记的原会计确认要求仍保留。完全相同的原票副本沿用 canonical 幂等去重并保存完整 raw/hash 追溯，不重复计税／入账；同 identity 的事实矛盾继续阻断。

新 Q2 请求为目标私有 snapshot 启用 `q2-target-batch-inventory/1` 增强：同一 held 连接、同次 read transaction 捕获目标企业或账套命中的全部批次 header、来源／凭证关联及实际凭证引用；策略保存在私有 product/pair 记录中，single／pair current 重核沿用它。Q1 和旧 single／04C／04D 默认形状不变。低层 Q2 缺少此私有增强时拒绝，不能拿旧默认 pair 绕过新检查。

未关联的非零 completed 批次、缺失／损坏结果、未完成／失败／未知状态以及身份或关联矛盾，均保留为操作者工程问题并阻断；不默认零、不要求客户补算。真实公共导入入口产生、目标身份一致且严格全零、无关联的 completed append 可解释为空操作。没有业务日期的孤立 header 不能用 created_at 推成未来季度；只有完整结果和实际 posted 凭证／原始来源指纹一致、所有实际凭证期间都晚于 Q2 且无本期账户／期初变更的批次，才从 Q2 依赖中排除。企业和账套都不同的批次不混入目标摘要；只命中一边而身份矛盾的记录明确 conflict。Q1 上游问题逐因保留原 status/classification、具体字段和事实请求；未知设立日期仍 unknown，仅已知非 January 才增加 unsupported 门。

已在真实 Q1 中逐条核对的会计凭证／来源集合，和整体 Q2 税桥是否 ready 分开表示。Q1 税务排除事项未知或另一个孤立批次阻断时，既有且已核对的凭证不会又被误称未知来源；上游真实问题和未解释批次仍阻断，税额 cells 仍为空，不放宽任何计算准入。

公共导入入口的合法去重批次不新增业务或税额。created 关系必须指向同一原创建批次；deduplicated 关系可指向新批次，但须唯一匹配实际原创建 source、真实 voucher、企业／账套／来源 ID／content fingerprint 和持久凭证指纹，并通过 completed header、完整五项 result 与实际 created／dedup 数量核验。计数证明使用同私有 target inventory 的完整关联，因此同一新批重放 Q1+Q2 时，不把 Q1 的局部投影误当完整批次；坏 action、身份／指纹、结果或缺创建 source 仍阻断，由操作者处理。

| 行 | Q2 本期服务列 | 本年累计服务列 |
| --- | --- | --- |
| 1、3 | S2 | 实算 Q1 同行本期 + Q2 本期 |
| 2 | 逐票证明无专票的 0 | 实算 Q1 同行本期 + Q2 本期 |
| 15 | S2 × 3% | 实算 Q1 同行本期 + Q2 本期 |
| 16 | S2 × 2% | 实算 Q1 同行本期 + Q2 本期 |
| 20 | 15 − 16 | 实算 Q1 同行本期 + Q2 本期 |
| 21 | 有完整无本期预缴会计证据的 0 | 官方横杠，null |
| 22 | 20 − 21 | 官方横杠，null |

累计 1/2/3/15/16/20 是根据官方“本年累计”栏义作的**工程推论，待会计审定**。未找到官方直接逐行说明 Q2=Q1+Q2 的 FAQ，不能伪称有该逐行 FAQ。Q1 已缴不是 Q2 预缴；不机械累加所有 cells。货物列、未支持行、其他税种保持 null。每个已算 cell 引用规则及计算节点；累计节点依赖本 worker 真实 Q1 本期节点与 Q2 节点，可经业务 trace 回到真实 voucher/entry ID、源关联、原件 hash 及会计事实。

## 只读官方依据与适用日期

2026-10-24 已只读核对下列页面，不以记忆替代规则；不声称已获会计审定：

- [增值税法](https://zhejiang.chinatax.gov.cn/art/2024/12/26/art_25716_84101.html)：2026-01-01 施行；第 7、11、14、17 条销售额和简易计税，第 23 条达到起征点全额计税，第 28、30 条纳税义务及核定计税期间。
- [财政部 税务总局公告 2026 年第 10 号](https://liaoning.chinatax.gov.cn/art/2026/1/30/art_5869_7749.html)：第一部分季度起征点和第三（三）6 的 3% 减按 1%，适用 2026-01-01 至 2027-12-31；不动产及土地等排除范围不纳本工程。
- [国家税务总局公告 2026 年第 6 号](https://fgk.chinatax.gov.cn/zcfgk/c100012/c5247507/content.html)：一至三，2026-02-01 起暂用既有表并按调整说明填写，不能据此误把 Q1 一月业务排除。
- [2026-02-09 更新的填写说明](https://shanghai.chinatax.gov.cn/tax/bsfw/xzzx/bgxz/sbzsl/202107/t459066.html)：调整一（三）、（六），原说明二（五）、（六）、（十八）、（二十三），对应第 1、2、3、15、16、21 行。
- [官方空表](https://12366.chinatax.gov.cn/bzds/003/003.html)：20=15−16、22=20−21，21/22 的本年累计横杠映射 null。

## 可信度、资源与后续边界

native-only 独立 32 文件 inventory 在金融模块动态 import 前核对 parent expected／worker initial／current 代码闭包；不预载旧 history-code 或 review-store 来产生新闭包。父进程 cached tax/default DB 不参与 worker 的实际税计算。子进程去除 NODE_OPTIONS、NODE_PATH、默认数据目录，最终关闭实际 source。正常成功等 actual close；timeout／退出／IPC 断连对自己 spawn 且 stdio 全 ignore 的实际 child 等真实 exit，spawn error 无 exit 时等真实 close。Windows parent 主动断开 IPC 可没有 close，不能据此遗漏回收或伪称 close 已发生。观察到代码改变后本进程永久要求 restart，恢复 bytes 不恢复可用性；未观察到的 ABA 及恶意并发窗口不能绝对排除。

同 input／rule／账务可重放稳定 contentDigest，补正、资料 hash、原件 basis、账务、规则／代码改变令旧摘要失效。无账务、审计、batch、锁、迁移或在线写入。本机绑定和摘要不认证真实世界原件。calculationReady／reviewReady／q2CalculationReady 可独立 true，authorizesExecution／periodComplete／submittable 始终 false；accountantApproval=pending，真实性与在线兼容均 unverified。新的 #82 Q2 复核确认链尚未接入，旧反馈确认逻辑不变；#81／#76 全包仍未完成，税局真实接入 0。与 #49 SQLite 备份、#51 批处理、#54 审计的已合领域及持久存储接口协调，不重复实现这些能力；本只读层不执行备份、批处理或审计写入，不消费未合 W3b batch3。

后续先回 #77 补两个真实连续合法季度的独立 golden；旧 00B 不构成两个合法税期。再衔接 #82 Q2 底稿与确认链，以上依赖尚未完成。当前 13 路径交付与实际验证记录见 [OFFLINE-04E 交接](handoffs/OFFLINE-04E.md)。
