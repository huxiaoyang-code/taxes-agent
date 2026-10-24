# OFFLINE-00C 实施交接

## 候选范围与冻结

当前是未提交/PR/合并的候选；阶段工程验收事实如下，最终完整head内容审查仍待root/fresh，不预填尚未产生的head或接受。负责人huxiaoyang-code；[任务与认领](../tasks/OFFLINE-00C.md)。开发原基线PR107 merge `bf1caa3f64fc565fbf676e65c1d42f43d24793b6`，accepted head `07de88d1f442ca5066c79c2175ac7727a4b32ccb`，prior base `b7e4aeafce833824b33e3669b1b172f9dc5de308`。所有阶段owned测试实际退出后，root已快进当前整合PR基线至PR108 merge `f0b6d00bf3beaa3f5d03faf4eea49f3244e5c082`；仅Windows五路径变化，财务产品、旧测试及本片冻结37个fixture/test路径完全未变。唯一实施subagent未再委派/外部执行器/Git，全局设置未改。

允许41路径：`06-workbench/test/fixtures/offline-quarterly-golden-v1/` 35个新文件（32raw+2expected+manifest）；新测试、helper两文件；新季度说明、本交接、任务单三文件；既有OFFLINE-04E交接仅页首事实补录。产品/旧golden/旧测试/package/test-all/STATE/NEXT/core/audit/batch均未改，与其他在途共享路径无交叠。

35个金融夹具在任何driver实现前已冻结，manifest `ab266912f9f47e8e856c0acfa72bcc7bc01a687e72fdbdd9c83b5298336ebd8b`；QG01 expected `c22259e9a4f14806a5166239a600aa41594d1717bde194c702b6134b71811ae2`；QG02 expected `4e3d76950233754cc6976951e41b8d0df4907d274c0bca7e1f4d425c38e2fe25`。之后没有修改raw/expected/manifest。预期来自root先行独立Python Decimal字面量预算，无产品导入；root随后另用stdlib CSV/ZIPXML+Decimal读取最终raw独立核对，证据位于ignored `.agent-runs/root-quarterly-raw-acceptance.json`。该事实不代替完整head验收或fresh独审。

## 执行与结果边界

两套合成原件均经真实03B prepare/execute得到六张posted凭证、18条分录和真实source/batch；六个月未封账as-of累计、各月相邻差以及fresh worker内重算的Q1/Q2全部选定税行逐字段对literal。QG01 Q1行22=3912.57、Q2=3869.13，累计20=7781.70；QG02分别3756.75、3870.07、7626.82。Q2没有伪首期、没有预制税额或SQL正向更正。完整API链、追溯、零写入和资源释放见[季度说明](../OFFLINE-QUARTERLY-GOLDEN.md)。

命令工作目录 `06-workbench`，`node test/offline-quarterly-golden.test.mjs`。第三阶段精确41文件aggregate `f1af9f102625153e42a687a95318713a72f058b20f15c5205301fea0b8673495` 冻结后：实施者、root、fresh各完整新套 **19/19、actual exit0**，没有skip；三个外层及全部owned运行实际结束。实施日志 `06-workbench/.agent-runs/implement00c-stage3-complete.log`、保留合成fixture `quarterly-golden-nKms63`；root fixture `plJ5AT`。测试每次03B正式调用均观测真实sync status0；每次04E worker实际exit/close0；session/source/DB在finally真实close，所有只读路径逐表/schema比较保持不变。默认成功清理临时合成资料，失败及`KEEP_FIXTURES=1`保留ignored证据。

root在先行Python Decimal字面量预算之外，另用stdlib CSV/ZIPXML读取最终两套原票，独立核12张票/36条预期分录/12份月末as-of/双季字段；随后不用产品或新验收helper导入，以stdlib sqlite3只读实际两个DB和Decimal读回，实际12张posted凭证36分录、每月余额、双季税字段与先行预算全部一致，主DB文件bytes0变。fresh完整19actual0之外另做26份独立内存变异，全部拒绝。这些已发生事实不等于尚未完成的最终commit完整head审查。

失败历史保留：首次新套exit1只因helper把CSV数据ordinal当物理行；第二次exit1只因helper用`sale.invoice.number`而原record实际是`sale.invoice.data.number`；第三次9/11、exit1，两个helper错误分别是未识别basis更正后的既有`conflict/posting_semantic_conflict/applied=true`语义，以及`openVatInputPairFiles`误用两个path参数（正式API接受request对象）。均修正验收调用/字段映射，没有改金融literal、产品、旧断言或skip。金额更正本来就阻断，保留明确更正依赖。入口WT无tools/flow.py的exit2为setup路径事实，root已在维护仓库按入口运行status，与本片无关。

两次独立拒绝也保留：第一阶段11/11自测actual0后，root/fresh实证发现黄金会漏掉被删除/重复的试算行、重复已算cell、缺未算cell及重复sale，拒绝该41字节版本；仅解冻两新测试，补完整唯一科目集合、行级独立汇总、100-cell契约与逐票双射。第二阶段完整17/17自测actual0后，fresh把六个YTD依赖全部截为仅Q1首项仍被接受，再拒绝；仍只改两新测试，补全节点唯一/完整、正确公式/minor、YTD精确两个有序依赖、真实Q1复制节点和scope/contentDigest provenance。最后19套同时保留两次缺陷的纯内存反例，拒绝不依赖旧contentDigest。这两次均是验收器P2，不是已接受版本；原35金融文件和产品从未解冻或迎合更改。ignored临时金额probe有过一次括号语法exit1，修正后actual0，非产品失败。

root在相同基线已实际跑旧`offline-business-golden.test.mjs` 15/15、12业务、exit0、子进程DB actualclose；产品/旧golden未变时复用。旧VAT22和04E38为同blob已合证明，无产品变更故不无理由重跑；不声称本实施者又跑过这些套。没有运行全量入口。

## 后续

root、fresh、实施第三阶段owned进程全实际退出后，统一只解冻四doc补以上事实；37个fixture/test路径持续冻结，没有为doc重跑全套。最终41路径SHA清单位于ignored `.agent-runs/offline00c-final-freeze.json`（清单含自身doc的hash，避免doc自指hash）；40文本UTF-8/LF无BOM，唯一XLSX按二进制hash。root负责最终完整head独立审查和Git/PR，最终冻结后不得并发改字节；需要修复先等所有验收进程实际退出再由root解冻。#77/#76/#85未因本片自动关闭；两合法税期工程黄金不等于正式连续核算/结转/封账/更正/申报/会计批准。仍依赖#80/#51正式账务、#82 Q2复核确认链；真实性/在线兼容unverified、会计pending、税局真实接入0。回退由root新PR删除40新增路径并恢复OFFLINE-04E页首，无真实业务DB回滚。
