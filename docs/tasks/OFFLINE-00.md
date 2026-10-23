# OFFLINE-00 / #77 合同准备部分

关联总任务 [#76](https://github.com/huxiaoyang-code/youshu-fork/issues/76) 与子任务 [#77](https://github.com/huxiaoyang-code/youshu-fork/issues/77)。实际 base `4223ccb3ad2c1b71178f2a510ed1f196ff963f03`，分支 `codex/huxiaoyang-code/offline-00-contract`。head/PR 由管理者在冻结后登记，不预填成功。

本轮用户明确授权：Codex 内置实施 subagent 直接实现，始终只有一个写代码，不再委派；主 agent 管理、独立审查、Git/PR。不使用 pi/Claude/其他本地模型，不改全局 Skill/模型配置。此授权覆盖仓库旧执行器限制，仅本轮生效；保持独立审查。

目标是可执行且无副作用的版本化合同校验、16组合成工程样例和第二方法算术核对。普通客户输入不接收凭证/借贷科目/最终税额。输出明确 validationOnly，不把输入 valid 说成闭环可执行。金额、企业、期间、版本和来源严格；真实规则未核不算税；confirm/completed/整期ready保留给后续实际版本与执行回执。

允许文件仅：`docs/OFFLINE-CLOSELOOP.md`、本任务单、`docs/handoffs/OFFLINE-CLOSELOOP.md`、`06-workbench/server/offline-contracts.mjs`、对应测试及 `test/fixtures/offline-close-loop/**`。不改 STATE/NEXT-SESSION/package/锁文件/test-all 或共享业务模块。无持久化，无新账务引擎。

验收场景：16组输入与独立期望，严格负例覆盖精度/日期/错企业错期间/重复/缺字段/无证据零/历史污染/依赖环/伪ready与confirm/黄金误入产品；空临时目录 import 后无 DB/文件/输出；错误只固定代码；不改输入。测试命令 `node test/offline-contracts.test.mjs`。

真实会计、法规和客户业务验收仍待完成：本片不能关闭 #77。详细限制、规则来源与 #78 接口见 [合同](../OFFLINE-CLOSELOOP.md)。提交、审查、PR 与合并由管理者执行；发现问题退回实施者。
