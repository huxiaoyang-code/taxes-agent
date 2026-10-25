# 计划与核算

`harness_plan` 保存 taskId/capabilityId/factIds/dependsOn/goal，允许按事实调整；程序拒绝环、悬空引用和越界。`harness_status` 给当前阻塞和 dependencyDigest；写 execute 使用当前 dependencyDigest。offline.action_plan 复用现有候选/补件，offline.posting 复用实际 prepare/execute/query、锁、审计和稳定业务键；先 prepare，再 execute。unknown 只能先 query 原身份。

跨期间任务可选 `externalDependencies:[{storePath,taskId,period,targetVersion,dependencyDigest}]`，绑定另一本机 Harness Store 的已有任务版本；storePath 为现存绝对目录，程序规范化并读取实际业务 proof，不以旧导出文件证明当前有效。企业/账套/数据库实例/币种必须相同，period 明确为 YYYY、YYYY-MM 或 YYYY-Qn，允许年度引用月/季及上一年度结转依赖。目标缺失、版本变化、unknown、被会计拒绝、循环或无法核查均保留具体 blocker；历史绑定不自动换到新版，父结果与确认随依赖失效。YYYY 的固定计算入口为 agency.annual-calculation；其他能力以 supportedPeriods 为准，annual_close_assess/review 关账流程尚未接通。

`agency.workpaper` 从真实原件和宿主整理事实生成月度底稿，必要资料与支持条件直接复用业务声明；issues 未解决不等于零。`agency.posting` 使用同一原始材料 manifest，先 prepare 保存原生方案与内容寻址 archive identity。首事实固定 feedbackPath 指向**人类提供**的本机 accountant-feedback.json（prepare 时可尚未存在），内容为 decision=accept/reject、reviewer、targetVersion、dependencyDigest、planDigest；三个版本值来自实际 proposal。Agent 展示方案并等待该明确人审材料，不得代写 reviewer/确认，不得将一般任务授权当成人审。本机单用户不提供额外身份认证。缺反馈、拒绝或版本不符明确未写，历史保留；人类后续提供有效接受记录仍使用原 batch/operation/archive 核查接续，不因失败换身份。程序先查询旧 identity，仅明确 not_started 才在同一 worker 原生重建 session/proposal 并要求全部绑定一致后调用已有执行入口；JSON 回执不是原生 proposal。执行后 Harness 复核仍走现有 harness_feedback，与该事前正式入账确认分开。

同一 scope/capability/业务 request 的原生写身份不随 taskId 改名。历史 unknown 即使原任务被移出计划也须 query 原 operationId；相同已执行请求改名后只核查原结果，不重复写账。无关请求可继续；新业务或更正必须有明确不同业务/来源身份，不能靠重命名制造。

`materials.init/receive/inspect/recover` 调用现有材料 Store，首事实 value 包含 path 与必要 configPath。`review.init/register/feedback/inspect` 调用现有税务复核 Store，value 包含 path，以及必要 inputPath/options 或 feedback。各入口以实际领域校验和结果为准。

未覆盖业务：核实原始事实、可核验政策与适用条件，宿主可写必要代码并验证。保存资料/政策定位、判断理由、分录草稿、代码、验证和实际影响。`harness_treatment_register` 登记 treatmentId/reason/traceReferences/draftSourceId/applicability；traceReferences 每项 kind/locator/digest，kind 为 source/policy/rule/code/validation/artifact/execution。先将内部 JSON 分录草稿及政策、判断、代码、验证文件登记为 draftSourceId 的来源清单，traceReferences 引用该清单的实际路径与摘要，至少包含 policy 或 rule、code、validation；不是要求客户提供草稿模板。

固定 voucher.create/post/unpost 调用真实 accounting 模块，不复制算法。首事实 value 包含 target（dbPath/databaseInstanceId/enterpriseKey/accountSetId）及 voucher 或 voucherId；voucher 使用模块既有 period/voucher_date/summary/status/entries。已授权内执行，金额、平衡、期间由业务模块校验。关联处理时，首事实 value 声明 treatmentId，可选 run.treatmentId 必须与其一致，voucher.create 的 voucher 必须与登记草稿一致；这只关联提议，不代表会计已保留企业特例。不得动态加载 Agent 提供的可执行模块或 SQL 写账。
