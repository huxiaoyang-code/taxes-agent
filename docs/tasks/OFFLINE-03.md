# OFFLINE-03A / #80A 原始事实分录候选

Refs #76 / #79 / #80，补充格式 Refs #78。base PR89 merge `19e861a580ebffec0b5e14eafb41ca457f9de71e`；branch `codex/huxiaoyang-code/offline-03-candidates`。本轮唯一实施subagent直接使用当前模型，用户本轮授权覆盖旧本地执行器限制；禁止再委派、pi/Claude/TokenHub及其它执行器，实施者不做Git提交/推送/合并，root管理与独立审查。

允许窗口仅8文件：新增 `06-workbench/server/offline-accounting-readiness.mjs`、`offline-voucher-rules.mjs`、`offline-bookkeeping.mjs`、`06-workbench/scripts/offline-bookkeeping.mjs`、`06-workbench/test/offline-bookkeeping.test.mjs`、`docs/OFFLINE-BOOKKEEPING.md`、本任务单；更新 `docs/handoffs/OFFLINE-CLOSELOOP.md`。禁止shared STATE/test-all/package/DB/core/import/bank/aux/audit/locks/HTTP/MCP/batch，另一窗口#54 W2b使用核心共享路径。需要扩大旧模块窗口先报root。

交付范围：从显式#79 planning-input所引#78快照和基础声明，加一种严格业务事实JSON，重验原文/映射并重新评估#79。仅small-2011-basic-v1，候选确认日仅2026年，法律起效信息另列，不把工程支持末日当法律失效日。支持同会计年度且同scope开始完成、同日权利的未结算普通主营服务销售、当月行政服务未付、期末未履约的单次短期合同预付。实际生成平衡分录，金额来自原票/银行；不接受客户预制分录或最终税额。完整schema、CLI、来源与业务边界见 [OFFLINE-BOOKKEEPING](../OFFLINE-BOOKKEEPING.md)。

验收须覆盖实际临时CSV/JSON经CLI得到三候选；独立金额/借贷平衡；具体权利/用途/合同/税属性缺项；已知矛盾、跨scope、非法金额、hash/映射变化、红字/复杂结算；同票/流水重复及合同关系去重；稳定交易key与内容/规则newVersion；不信任上传ready/completed；逐分录原字段/事实pointer/hash/规则来源；无DB网络副作用、固定安全stdout、新output拒覆盖。预付不依赖无关VAT身份，未知银行性质可精确补足，工资/资产相反性质不得覆盖。

本片不授予执行权限，不代表#80整项完成；正式生产写与连续过账/恢复等待coordinator，正式明细/aux和幂等导入后接。#77会计审定黄金、#78持久接收、#79正式执行回执、#80连续过账仍未完成。最终实施测试与失败记录见 [交接](../handoffs/OFFLINE-CLOSELOOP.md)，待root独立验证、fresh冻结审查、PR及合并，不预报完成。
