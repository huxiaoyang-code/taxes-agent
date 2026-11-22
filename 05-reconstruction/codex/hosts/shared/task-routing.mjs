// 四宿主复用同一任务入口；配置可证明指引被装配，模型是否读取仍需实际轨迹验证。
export const PERIOD_TASK_ROUTING=[
  '整期任务入口：用户要求“做完本月账”“完成这家企业本期账税”“本期申报准备”“接上次补件继续”等整期目标时，先用skills_read({resource:"tax-period/SKILL.md"})，再按任务选择阶段和分支。遇租赁、跨期或税费方案比较时读其参考。',
  '单项任务直接进入对应技能。用银行原件核对已入账收付款时读 reconciliation/SKILL.md，用 finance_query 查凭证与明细账；有更正委托且原件证实错账时用 voucher_correct。办理银行模块的流水导入时，用 bank_import_preview 预览本机已选的导入草稿；匹配已导入流水时，用 bank_candidates 查看匹配候选。',
  '查科目明细账或核对科目余额时，用 finance_query 的 ledger.general，传入 accountSetId、period 和 params.code。查现行政策、修订或月结有疑义的法规，用 finance_rules(action=search) 搜公开政策词，再用 action=open 核官方原文、条款和适用期。接续核同企业/账套/期间的实际产物与来源，不沿用模型自述完成；缺件只阻塞相关分支。'
].join('');
