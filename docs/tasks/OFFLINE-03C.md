# OFFLINE-03C / #80 期末只读准入与固定派生计划

本片 base `71db5fa9fde95a50e51b79b96d45715cdced2208`。认领 [#80 comment6377054959](https://github.com/huxiaoyang-code/youshu-fork/issues/80#issuecomment-6377054959)，协调 [#54 comment6377055324](https://github.com/huxiaoyang-code/youshu-fork/issues/54#issuecomment-6377055324)。仅本片八个新增文件，所有 core/accounting/db/import/audit/batch/rules/旧tests/package/test-all/STATE/NEXT/03B/旧交接均只读。用户明确授权唯一继承模型实施 subagent；不再委派、不启动外部模型执行器、不做Git写。root独立验收及Git，最终需全新未实施者独审。

八路径：06-workbench/server/offline-period-plan.mjs、server/offline-period-plan-target.mjs、scripts/offline-period-plan.mjs、test/helpers/offline-period-plan-fixture.mjs、test/offline-period-plan.test.mjs，及仓库 docs/OFFLINE-PERIOD-PLAN.md、docs/tasks/OFFLINE-03C.md、docs/handoffs/OFFLINE-03C.md。接口和业务边界见[合同](../OFFLINE-PERIOD-PLAN.md)。目标为真实已入账首月的只读准入和合法固定manifest，不执行或关闭期间；#83修正明确close=false。后续连续月执行、资产工资及历史支持、批量运行/恢复、税额复算和确认未交付。

上游 [PR103](https://github.com/huxiaoyang-code/youshu-fork/pull/103) 实际已合：base `0c995076bdf1e78ece6689f486b67443d4c5bc71`，已审 head `32a8fa413f86d1d9b60979cbb20700446d4617e2`，merge `71db5fa9fde95a50e51b79b96d45715cdced2208`（2026-10-23T23:48:07Z）。旧完整head `ba92c03436870fe9af54eebd611dda54fba42973` 因仅改 voucher.kind 为carryforward仍恢复被fresh拒绝，未发布；新head要求normal，最终实施/root/fresh35均通过，root3凭证7分录各侧395128.13及fresh三kind实际污染拒绝→normal恢复，交付[#80 comment6377038444](https://github.com/huxiaoyang-code/youshu-fork/issues/80#issuecomment-6377038444)/[#76 comment6377038852](https://github.com/huxiaoyang-code/youshu-fork/issues/76#issuecomment-6377038852)。本片调用其真实query，不改03B恢复守卫。

验证命令（cwd06-workbench）：`node test/offline-period-plan.test.mjs`。使用全新合成原件→实际03B正式过账，字面金额在执行后独立断言，黄金expected从未作为运行输入。计划各次调用前后逐表/schema比较，覆盖ready与blocked；source/kind/子分污染、未解释凭证、真实资产与期初冲突、缺关键资料、重复/重排/更正、跨企业/月份/实例/profile、当前性和CLI故障。实施最终新套 **41/41、exit0、skip0**，授权实际Windows hardlink；最终进程及所有本次测试child已退出，详见[本片交接](../handoffs/OFFLINE-03C.md)。42个实际mjs清单含固定posting-target闭包，修后完整41实际重跑；不预报root/fresh/PR或合并结果，不关闭#80。必要既有posting套由root决定运行，不添加全量入口、不改旧断言。

回退：新 revert PR 删除本片八个新增文件，已有账务/来源/审计不撤销。真实会计审定、业务试用 pending，不阻塞其他可独立工程。#54/#51的在途核心窗口不属于本片，未合batch3不作依赖事实。
