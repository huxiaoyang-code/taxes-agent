# 期间与税务

YYYY-MM 与 YYYY-Q1..4 含义不同，月结果不等于季度确认。offline.period_plan 返回真实执行条件与可用 manifest；batch.start/status/resume 复用现有批处理，首事实 value 包含 target、jobKey，start 另给 manifestPath/outputDir。已有安装/备份与恢复契约照常适用，不绕过缺依赖。

offline.vat_q2 仅计算既有历史/目标季度支持的 VAT 部分字段。依据资料调查税务属性、适用期、历史及业务事实；缺失则具体补件，不要求客户先算税额。以返回的计算范围和限制为准，不声称全税种、整期完成或可提交。

`agency.workpaper` 复用已有月度会计/税费算法与缺项判断；`agency.annual-calculation` 在 YYYY 容器从完整原始月 sessions 调用 buildAgencyAnnualWorkpaper，保留原生 YYYY-12、年度调整和次年承接条件。月份缺口、scope冲突、原始资料/规则/实际账簿变化均须核查；不能只交月度汇总替代原始证据。结果中的 issues、accountantApproval、periodComplete/submittable 如实报告，年度算法计算不等于年度关账流程已接通。

全国电子税务局真实接入数为 0。本 Harness 不做登录、在线采集、申报提交或缴款。核算独立分支可以执行，税务不支持或证据不足分支保留具体阻塞。
