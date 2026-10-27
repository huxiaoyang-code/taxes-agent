# 会计反馈与更正

`harness_feedback` 需要 taskId/targetVersion/dependencyDigest/decision/reason/reviewer/evidenceRefs，版本从当前 status 取得。decision 为 accept/reject/retain_enterprise_exception/propose_public_rule。必须记录真实会计反馈，不由 Agent 冒充会计。执行、待/已复核、公共规则状态分别记录；未覆盖处理即便已执行仍 uncovered，保留企业特例或公共候选由人决定。公共规则需明确适用条件并经 PR，不自动跨企业推广。

拒绝保留历史并使依赖失效。Agent 根据实际账务制定更正 DAG，使用现有 voucher.unpost 或合适的新更正凭证；首事实请求的 correctionOf={taskId,targetVersion} 指向原执行，任务 dependsOn 包含原 task，允许更正分支处理已拒绝结果。新 create 必须使用独立更正 task；不重复入账，不删历史或 SQL 改账。

`agency.posting` 更正请求加 `correction:{reason,previousEvidence:[{archivePath,archiveId}],previousSourceIds:[...]}`。archivePath/archiveId 从上次完整 prepare.proposal.identity 读取，previousSourceIds 从该 proposal.plannedVouchers[*].sourceVoucherId 读取；不能由摘要金额反推身份。仅明确撤销的原业务才加 withdrawnSourceIds，原件缺失不等于撤销。跨以前年度企业会计准则事项须有真实 `priorYearAssessment:{material:false,method:"current_period_nonmaterial",reviewer,reason}`；重大差错不在此路径内。#121 本身仍使用既有更正日期策略；窗口二的 correction.postingDate 合同需待其真实能力集成后核验，当前不宣称已实现。

人类提供的 native feedbackPath JSON 精确为 `{decision:"accept"|"reject",reviewer:"实际人类",targetVersion:"原生proposal.targetVersion",dependencyDigest:"原生proposal.dependencyDigest",planDigest:"原生proposal.planDigest"}`。一般任务授权不是这一版本的会计接受。prepare只展示/保存方案，Agent不能代写接受；测试验收者如提供模拟反馈必须明确标注 SYNTHETIC-TEST-ONLY。

已有非agency凭证需人工业务核对时，请求可加 `ledgerReconciliation:{reviewer,reason,matches:[{existingVoucherId,agencySourceVoucherId,originalBusinessIdentity:{issuerKey,documentNumber,event},reason,existingSourceSystem?,existingSourceVoucherId?}],openingCarry?:{reviewer,reason,throughPeriod}}`。matches必须逐一对应当前真实凭证及原始业务身份，日期、分录和来源由原生模块核对；不是把金额相同当同一业务。早于重放起点的已有账务须 openingCarry.throughPeriod 覆盖所有前期且小于重放月；原始期初与真实账簿必须相等。无现账匹配需求不要编造matches。未知写先query，不用reconciliation掩盖未知结果。

源、代码、事实、规则及实际账务变化使旧结果/确认失效，仅重算受影响分支。封账或派生依赖拦截时保留具体更正顺序，不绕过锁。税务具体字段复核继续使用原 accountant-review Store，Harness 任务确认不冒充申报确认。
