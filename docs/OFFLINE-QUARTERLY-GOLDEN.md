# 连续法定季度离线工程黄金

OFFLINE-00C / #77 在保留旧 OFFLINE-00B 的 12 业务案例和全部旧断言的基础上，新增两套独立合成企业，覆盖真实日期的 2026-Q1、2026-Q2 两个连续法定季度税期。它补充季度工程证据；账务只是 January 起账后的六个月**未结转、未封账 as-of**，没有据此声称正式连续核算、账务更正、已申报、已缴税或人类批准完成。开发原基线是PR107 merge `bf1caa3f64fc565fbf676e65c1d42f43d24793b6`；整合PR基线已快进为PR108 merge `f0b6d00bf3beaa3f5d03faf4eea49f3244e5c082`，该次仅Windows五路径，财务产品和本片测试/夹具字节未变。

| 合成案例 | 原件 | Q1净额 / 行22 | Q2净额 / 行22 | 累计净额 / 行20 |
| --- | --- | --- | --- | --- |
| QG01 | Q1 CSV、Q2 CSV | 391257.00 / 3912.57 | 386913.00 / 3869.13 | 778170.00 / 7781.70 |
| QG02 | Q1受限XLSX、Q2 CSV | 375675.00 / 3756.75 | 387007.00 / 3870.07 | 762682.00 / 7626.82 |

每套六张全新票，January 至 June 每月一张，均为同日开始并完成履约、取得索款权、未收款、境内普通主营服务普通票。合成事实声明 2026-01-01 新设、January 起账、原始期初确为零；小规模按季资格和完整业务、账户、排除事项都有合成会计角色证据。两季分别达到30万元；Q2 明确 `opening=balances_required`、`history=prior_required`，以真实 Q1 原件和正式过账集合解释历史。原票净额为整数元，票面 VAT 恰为净额1%，不是要求客户提供计算好的分录或申报税额。

## 冻结与独立预期

夹具位于 `06-workbench/test/fixtures/offline-quarterly-golden-v1/`：`raw/QG01`、`raw/QG02` 各两季，每季八个文件；`expected/QG01.json`、`expected/QG02.json` 是静态字面量；`manifest.json` 绑定其余34个文件。全部只有合成资料及可移植相对路径。新 XLSX 是带 inline string 的最小 OOXML 原票，无宏、公式或外部链接。

在运行 driver 实现前，管理者用无产品导入的 Python Decimal，按字面量基础销售额独立预算逐票票税、价税、分录、六个月累计 as-of 和选定税行；实施者据此落静态预期，再冻结所有原件和预期。manifest SHA-256 为 `ab266912f9f47e8e856c0acfa72bcc7bc01a687e72fdbdd9c83b5298336ebd8b`；QG01 expected 为 `c22259e9a4f14806a5166239a600aa41594d1717bde194c702b6134b71811ae2`；QG02 expected 为 `4e3d76950233754cc6976951e41b8d0df4907d274c0bca7e1f4d425c38e2fe25`。测试不生成、回填或重写 expected。

预期含每张票 seller/code/number、日期、来源 SHA、CSV 物理行或 XLSX sheet/cell、会计/业务/税务事实 pointer，及独立推导。CSV 的 frozen `row` 是含表头的物理行，产品 `location.row` 是从1开始的数据序号；验收明确转换，并另核 `location.line`。XLSX 的行和单元格直接对照物理坐标。

## 真实执行链与验收

在 `06-workbench` 目录运行：

```text
node test/offline-quarterly-golden.test.mjs
```

测试为每套新起一个真实 Node 进程，核心 import 前隔离数据目录和 TEMP/TMP；只经公共 `createAccountSet` / `ensurePeriod` 初始化 January 零账及六个月份，并读取实际活动实例。之后逐季真实 raw → `openOfflineActionInput` → `buildOfflineActionPlanFromFiles` → `runOfflinePosting` prepare/execute。正式调用仅传原件路径、实际选择、显式 target 和确认摘要；从不将预期、预制分录或税行传入产品函数或 seed SQL。每套产生六张 posted 凭证、18条分录及真实来源/batch关联。

只读 snapshot 将候选、逐票材料 hash/行/cell/事实、持久 source/batch、voucher/entry ID 与静态字面量串联。`trialBalance.period_debit/credit` 实际是累计发生额，本测试核对六个月累计、零初始、期末 as-of 和各月相邻差；未涉及科目一律断言为零。每月必须完整且唯一覆盖初始科目集合，三个业务科目各恰一行；全部报告行以独立整数分汇总，对照报告总额和静态预期。随后 04E facade 在 fresh worker 内以同 held source、同 read transaction 的私有双期重新计算 Q1/Q2，核对两期 `services` 列的1/2/3/15/16/20/21/22行、规则版本和计算节点。每季输出必须完整唯一覆盖25行×两列×两栏的100个cell；货物列、其他未算行均为 null；累计21/22必须 `not_applicable`、横杠/null。

每季三笔sale和reconciled business按原票identity、businessKey、voucherId一一覆盖，不能重复首票而遗漏其他票。全部计算节点ID完整唯一，公式/minor及依赖对照独立字面量；累计六行各自绑定唯一`ytd_<row>`，精确依赖本次真实Q1对应节点和Q2本期对应节点，核两端、累计和及顺序。Q1复制节点的全部内容、依赖前缀、scope/contentDigest provenance必须等于本worker真实prior；公开摘要不替代这条证明。

附加控制覆盖：真实新进程重开及六次原确认重放不新增凭证；资料缺失 blocked、补件重读恢复；非金额 basis 更正使旧 diagnostic digest stale 但税数不变；已正式入账的旧 operation 遇语义更正明确返回 `conflict/posting_semantic_conflict/applied=true`，不能重复入账。金额更正与旧 posted 原件不匹配时阻断，需要显式账务更正依赖，本片没有用 SQL 伪造正向更正。跨企业、交换季度和公开 JSON 冒充私有 pair 均拒绝；poison expected 只使验收断言失败，重新实际执行的候选、试算及税行不变。

所有只读阶段前后比较全部 schema/table；初始化和正式过账外无 SQL 写入。测试观察正式过账 sync 子进程实际 exit0，以及每次 facade worker 实际 exit/close0；action session、source、默认 DB 和私有 pair 都在 finally 调用真实 close。成功清理临时合成目录，`KEEP_FIXTURES=1` 可保留；失败保留 ignored `.agent-runs` 证据。

第三阶段代码冻结后，实施者、root和fresh分别完整运行新套 **19/19，actual exit0**；三个运行及其owned子进程均实际结束。管理者另以stdlib CSV/ZIPXML+Decimal核最终raw及先行预算，并以sqlite3只读实际两套DB、独立Decimal核12张凭证36条分录、逐月余额和双季字段，主DB bytes不变；fresh另以26份独立内存变异全部拒绝。原旧golden由root在同金融基线实际跑15/15、exit0，旧VAT22/04E38按产品相同blob复用。两个较早自测通过版本曾因验收器漏检被独立拒绝：缺/重试算行、cell或sale，以及累计节点缺Q2依赖；只修两份新test/helper，35份原件/预期始终未改。最终完整head审查及PR事实由root后续登记，以上工程结果不等于人类会计批准。

## 规则与未完成边界

复用已合 [OFFLINE-VAT-Q2](OFFLINE-VAT-Q2.md) 在2026-10-24核对的官方依据和规则闭包：Q1 `offline-vat-selected/1`，Q2 `offline-vat-selected-q2/1`。增值税法自2026-01-01施行；2026年第10号公告相关减征适用2026-01-01至2027-12-31；2026年第6号公告自2026-02-01起暂用既有表，不能排除Q1一月业务。具体官方 URL、生效日期及行次定位见该文“只读官方依据与适用日期”，本片没有重新声称核定新政策。

累计1/2/3/15/16/20按官方“本年累计”栏义作 Q1+Q2 的工程推论，**待人类会计审定**；没有官方逐行 Q2 FAQ 的新证据。合成 `accountant` role 不等于真实会计批准，产品 `accountantApproval=pending`、真实性/在线兼容 unverified、`periodComplete/submittable/authorizesExecution=false`。正式连续账务、结转封账及更正继续依赖 #80/#51；Q2复核确认链依赖 #82。#77/#76/#85 不因本测试自动关闭，税局真实接入仍为0。
