# 计划与核算

`harness_plan` 保存 taskId/capabilityId/factIds/dependsOn/goal，允许按事实调整；程序拒绝环、悬空引用和越界。`harness_status` 给当前阻塞和 dependencyDigest；写 execute 使用当前 dependencyDigest。offline.action_plan 复用现有候选/补件，offline.posting 复用实际 prepare/execute/query、锁、审计和稳定业务键；先 prepare，再 execute。unknown 只能先 query 原身份。

`materials.init/receive/inspect/recover` 调用现有材料 Store，首事实 value 包含 path 与必要 configPath。`review.init/register/feedback/inspect` 调用现有税务复核 Store，value 包含 path，以及必要 inputPath/options 或 feedback。各入口以实际领域校验和结果为准。

未覆盖业务：核实原始事实、可核验政策与适用条件，宿主可写必要代码并验证。保存资料/政策定位、判断理由、分录草稿、代码、验证和实际影响。`harness_treatment_register` 登记 treatmentId/reason/traceReferences/draftSourceId/applicability；traceReferences 每项 kind/locator/digest，kind 为 source/policy/rule/code/validation/artifact/execution。先将内部 JSON 分录草稿及政策、判断、代码、验证文件登记为 draftSourceId 的来源清单，traceReferences 引用该清单的实际路径与摘要，至少包含 policy 或 rule、code、validation；不是要求客户提供草稿模板。

固定 voucher.create/post/unpost 调用真实 accounting 模块，不复制算法。首事实 value 包含 target（dbPath/databaseInstanceId/enterpriseKey/accountSetId）及 voucher 或 voucherId；voucher 使用模块既有 period/voucher_date/summary/status/entries。已授权内执行，金额、平衡、期间由业务模块校验。关联处理时，首事实 value 声明 treatmentId，可选 run.treatmentId 必须与其一致，voucher.create 的 voucher 必须与登记草稿一致；这只关联提议，不代表会计已保留企业特例。不得动态加载 Agent 提供的可执行模块或 SQL 写账。
