# OFFLINE-03C 实施交接

基线、认领及八文件所有权见[任务单](../tasks/OFFLINE-03C.md)，运行接口和真实边界见[合同](../OFFLINE-PERIOD-PLAN.md)。PR103实际base/head/merge及旧kind拒绝修复事实已在任务单记录；旧拒绝head未发布，本片依赖已合normal恢复proof。当前仅实施候选，root冻结验收、fresh最终完整head独审、PR/合并均待，不预报通过。#80/#76 OPEN，人工会计审定和业务试用 pending。

本片通过真实原件action读取和03B query证明目标月已实际入账业务，严格首月new_zero/first_period、无工资资产且实际库存相符；纯period check生成必要损益结转→期末检查→五CSV派生计划。close=false，底稿不强迫先封账；manifest仅计划且恒无执行授权/整期完成/可申报。缺coverage/账户/期初历史/未知业务和实际矛盾保持具体阻塞，未解释同期间凭证或来源关系阻断。负银行预付款不伪造资金，三类actualposted仍可blocked；预付留1123不摊销。Q2真实日期保留，不扩大VAT旧Q1/non-normal范围。

代码扫描与实际worker启动/调用前后重核；原件与实际账库身份/快照重核；全库零写内部比较与目标作用域计划依赖分开。跨企实际变更不改变目标binding。CLI wx预留，写后重读请求与全流程fresh check，失败尽力写manifest:null。没有默认DB导入、核心写域调用、DDL、journal或新锁；在途batch3不接入。

开发失败记录保留在忽略目录：首次缺.agent-runs父目录的测试启动失败已补自身临时目录；matrix缺requestedFields导致新门抛错已使用旧材料提示回退；duplicate真实输入按旧03B语义冲突阻断，未放松持久证明；首次沙箱hardlink EPERM后使用获准escalated实际建立链接，不skip。第二轮Q2测试误造4月31日已更正为4月30日，不改产品日期；尾部代码清单断言发现固定posting-target URL不属于ES import扫描，已显式追加其闭包入口，不以旧35条不含target清单声称完整。旧失败日志保留，不删除旧断言。

实施最终验证：cwd `06-workbench`，`node test/offline-period-plan.test.mjs > .agent-runs/period-plan-final-2.log 2>&1`，**41/41、exit0、skip0**；授权 require_escalated 在合成临时目录实际创建Windows hardlink，没有跳过权限断言。42个实际本地mjs代码闭包已包含固定posting-target的39依赖，新scanner之后完整新套真实重跑。两类业务ready实际2凭证5分录、各侧1179.96，净891.37/VAT8.91/应收900.28，行政票1月8日/实际完成1月19日279.68；三类实际3凭证7分录另有预付153.29留1123且负银行被阻断。零业务明确无活动可计划，无结转/计提伪回执。Q2真实4月、跨企摘要不变、原件/请求/代码发布变更、真实sync故障与实际硬链接全部通过。最终自测进程已实际退出，所有本次spawnSync测试child均已退出并关闭自身DB，无自有常驻任务。

末次自查将aux需求、规范绑定与来源绑定原始行加入相关账务摘要；新增第41项实际来源绑定删除阻断。第一次误按v1读取来源绑定account_set_id导致新套首项失败，日志period-plan-final.log保留；已按真实v2 enterprise_key修正，再完整41实际通过，不是沿用旧40结论。没有改旧断言/运行无关全量；03B旧核心字节未改，必要旧35由管理者安排独立验证。

根与fresh尚未在活动字节验证；现在交出8SHA硬冻结，停止全部产品/测试/文档写入，问题先报root再解冻，禁止验证中静默改动。无实施Git写、无二次委派/外部模型执行器，所有测试仅临时合成资料。

未完成：执行manifest、跨月真实接续、历史/工资/资产/年末/必填aux支持、结转后VAT重算与正式更正、批量恢复及人工审定。不能用本片ready文件宣称这些能力已完成。回退使用新revert PR撤新增文件，不改既有03B账务；没有可回滚的本片业务效果。
