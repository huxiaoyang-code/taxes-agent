# 会计反馈与更正

`harness_feedback` 需要 taskId/targetVersion/dependencyDigest/decision/reason/reviewer/evidenceRefs，版本从当前 status 取得。decision 为 accept/reject/retain_enterprise_exception/propose_public_rule。必须记录真实会计反馈，不由 Agent 冒充会计。执行、待/已复核、公共规则状态分别记录；未覆盖处理即便已执行仍 uncovered，保留企业特例或公共候选由人决定。公共规则需明确适用条件并经 PR，不自动跨企业推广。

拒绝保留历史并使依赖失效。Agent 根据实际账务制定更正 DAG，使用现有 voucher.unpost 或合适的新更正凭证；首事实请求的 correctionOf={taskId,targetVersion} 指向原执行，任务 dependsOn 包含原 task，允许更正分支处理已拒绝结果。新 create 必须使用独立更正 task；不重复入账，不删历史或 SQL 改账。

源、代码、事实、规则及实际账务变化使旧结果/确认失效，仅重算受影响分支。封账或派生依赖拦截时保留具体更正顺序，不绕过锁。税务具体字段复核继续使用原 accountant-review Store，Harness 任务确认不冒充申报确认。
