# OFFLINE-02B：当前原件到候选准备与补件重规划

Refs #76 / #79。输入 `offline-action-input/1` 严格含 `scope`，可选 `profileId`、`declaration`、`accountingFacts`、`previousPlan`，以及必须二选一的 `materialsInput` / `materialStore`。后三类声明/事实/旧计划是显式本机 JSON 路径；未知声明/事实/profile 可省略或 null，不设默认身份。materialsInput 是 #78 的 `{scope,sources:[{sourceId,kind,scope,path,mapping}]}` 原件清单，支持现有 CSV/XLSX/业务 JSON。拒绝旧 ready、candidate、review 或最终金额作权威输入。

API：`openOfflineActionInput(inputPath)` 实际读取显式原件，逐源 preflight，返回私有绑定的 `rawInput`、`assertCurrent()`、`close()`、inventory 副本；`buildOfflineActionPlan(rawInput)` 是纯 façade，调用现有 `assessCompleteness`、`planOffline`、`buildOfflineCandidates`，不重复会计/税额算法。纯入口 `provenance.mode=supplied_bytes_replayed_not_live_files` 只证明给定字节重放，不宣称磁盘当前。`buildOfflineActionPlanFromFiles(session)` 在构建前后用 WeakMap 私有 payload/guard 重验；不信任公开 getter、替换 rawInput、改写 assertCurrent 或 inventory。文件模式为 `explicit_local_files_revalidated_at_call`，私有 `fileEvidence` clone 保留配置/声明/事实及原件真实路径、hash、sourceId、receipt/config定位与失败读取观测。完全不打开 DB、默认库或网络。

最小输出状态：`candidate_preparation_ready` 表示已形成候选或其明确关联资料满足当前准备条件；`needs_review`、`conflict`、`unsupported`、`provided_invalid`、`missing`、`unknown`、`not_applicable`、`blocked_not_implemented` 分开。所有任务 `authorizesExecution:false`、`periodComplete:false`、`completed:false`，真实性 unverified，没有执行回执。post/close正式链仍待接线；compute_tax/review 是**本准备 façade 尚未集成**、依赖账务结果未满足（`implementationScope=this_preparation_facade_only`），不否认既有 #81 窄VAT计算与 #82 底稿/反馈API。这些独立API须显式fresh账库流程，本入口不执行它们。

每笔稳定 taskId 锚原票/账户流水身份，任务包含 deps、状态/理由、完整原始 trace、实际候选或具体缺项。矩阵保留旧评估行和原始 trace；仅对应当前候选通过全部旧 gate 及新完整事实后，收敛原用途/性质 unknown，不隐藏真实未知、冲突、不支持、历史和整期覆盖缺项。预付款关联的尚未履约采购票是关联证据，不另作行政费用任务。客户补件包含企业期间、具体缺项、原因、影响任务、可收格式、登记替代依据和覆盖范围；内部尚未实现依赖不冒充客户资料请求。

具体补件按同业务、同字段、同覆盖合并，保留全部 requirementIds/reasonCodes/inputs 与影响任务；税身份/科目方案等企业期间共享缺项合到基础请求，不让每笔重复索取。未知问实际情况；已知false/general/退款等不适用事实明确 unsupported 并保留实际值，不诱导改成支持条件。关联未来采购采用自身原票门和对应预付的具体缺项，不索取虚构完成日或行政用途。锁是操作者诊断，不列为客户补件；已有receipt结构证据仍可见，但不成为当前候选。

税属性、账户、工资资产、期初与历史是可独立核对的上下文资料节点，其自身资料符合不依赖未填的企业准则。逐笔候选仍依赖企业准则，票据再依赖税属性，独立预付无税/历史依赖。任何 `candidate_preparation_ready` 任务均无 blockedByTasks，所有显式父节点满足；不能将已提供的税/账户资料伪改missing来传播企业准则缺失。

`dependencyDigest` 显式选择本笔语义及重复状态、匹配原业务事实、补充事实和确认依据、同 factId 冲突、同合同/供应商竞争及多付款、反向关联、关联票与原事实、局部来源坏/冲突、账户成员及无业务声明、必要声明字段与实际引用 evidence、规则及父摘要。完整来源 hash/位置 trace 保留，但不把整文件 hash/行序作为逐笔失效键。全 planVersion 随完整输出更新；changes 为 added/removed/invalidated/unchanged，旧状态从不复用为当前 ready。

CLI（cwd `06-workbench`）：`node scripts/offline-action-plan.mjs --input <config.json> --output <NEW.json>`。新 output 独占 wx，拒覆盖；stdout 仅固定安全状态/计数，stderr 空；退出码0表示规划已写出（允许阻塞），2参数错误，4输入/输出拒绝。store stale/locked/invalid 保留诊断，独立有效来源保留；锁期间不认 receipt 来源为当前候选。没有持久执行队列或正式写账。

读取上限沿用本机readLocalFile的5MiB；来源最多100个，补充事实最多1000条。来源相对materialsInput所在目录，主引用相对config所在目录；output相对cwd。文件变动（包括原缺失文件出现、坏读取修复、invalid store变有效）拒绝旧session，须重开；这是当前字节/状态重验，没有永久失效日志。`previousPlan`仅比较任务摘要，严格校验结构/全文digest，拒completed/执行回执；本地摘要不认证操作者或会计结论。

冻结后root独立验收：新套33/33、旧plan45/45、bookkeeping43/43均exit0；综合原件/store/补件/防篡改probe及同CSV双销售选择性摘要probe均PASS。后者第一销售8319.37→8329.47仅其业务摘要变化，第二1134.23、行政和预付保持业务摘要，完整来源SHA仍刷新；私有原件path/hash与实际一致，公开inventory修改不影响。最终完整HEAD的fresh独审及PR/合并仍待，不把root验收等同会计生产审定。
