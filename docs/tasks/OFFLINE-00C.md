# OFFLINE-00C：独立连续季度工程黄金

负责人 huxiaoyang-code；总包 #76、本片 #77。[本片认领](https://github.com/huxiaoyang-code/youshu-fork/issues/77#issuecomment-6378527528) / [总包认领](https://github.com/huxiaoyang-code/youshu-fork/issues/76#issuecomment-6378527676)。开发原基线 PR107 merge `bf1caa3f64fc565fbf676e65c1d42f43d24793b6`；分支 `codex/huxiaoyang-code/offline-00c-quarter-golden`。当前整合PR基线已快进为PR108 merge `f0b6d00bf3beaa3f5d03faf4eea49f3244e5c082`，仅Windows五路径变化，财务产品及本片37个fixture/test路径未变。PR107 accepted head `07de88d1f442ca5066c79c2175ac7727a4b32ccb`、prior base `b7e4aeafce833824b33e3669b1b172f9dc5de308`；[上片#81交付](https://github.com/huxiaoyang-code/youshu-fork/issues/81#issuecomment-6378504231) / [总包交付](https://github.com/huxiaoyang-code/youshu-fork/issues/76#issuecomment-6378504181)。

目标是在旧12业务黄金之外新增 QG01/QG02，各以 January–June 每月一张完整主营服务普通票，走真实材料和03B正式过账，得到6v18e、六个月未封账 as-of 试算及连续两个合法季度税期。QG01两季CSV，QG02 Q1受限XLSX、Q2CSV；只用合成企业，January新设起账/零真实初始，两季各达30万元，Q2诚实声明历史/期初依赖。原始票面VAT合法，客户raw没有分录/申报税数。

允许写入仅41路径：新夹具目录35文件；新 `06-workbench/test/offline-quarterly-golden.test.mjs` 与 `test/helpers/offline-quarterly-golden.mjs`；新 `docs/OFFLINE-QUARTERLY-GOLDEN.md`、本任务单、`docs/handoffs/OFFLINE-00C.md`；既有 `docs/handoffs/OFFLINE-04E.md` 只页首补PR107实际合并与交付事实。所有产品、旧golden/旧tests、CLI/MCP、包锁、test-all、STATE/NEXT、core/audit/batch只读；不触及#51 W3b或#106 Windows路径。产品缺陷先报告，不改独立预期迎合。

用户本轮明确方式例外：唯一继承当前模型的内置Codex实施subagent负责实施/自测，不再委派、不启动外部模型执行器、不改全局配置、不执行Git/PR；root独验/Git，最终另由未参与实现的全新上下文只读审查。前片writer和进程已停。没有读取真实客户材料、历史长文或凭据。

顺序：先静态raw/独立Decimal预期/manifest冻结并报SHA，再实现driver；预期只进入执行后的验收。主链通过后扩fresh重放、补件/事实更正/金额冲突、跨企业/跨期、公开JSON私有绑定、poison expected。读取路径全部schema/table0写；所有session/source/worker真实close/exit。完整行为与规则定位见[季度说明](../OFFLINE-QUARTERLY-GOLDEN.md)，具体自测事实与失败历史见[交接](../handoffs/OFFLINE-00C.md)。

第三阶段冻结aggregate `f1af9f102625153e42a687a95318713a72f058b20f15c5205301fea0b8673495` 上，实施/root/fresh各新套19/19、actual0，owned进程实际退出；root另独立CSV/XLSX+Decimal及实际sqlite3读回12v36e/每月余额/双季税字段，fresh26独立变异全拒。此前两次独立拒绝分别为行/cell/sale集合漏检和YTD缺Q2依赖，仅两新测试文件返工，35金融字节不变。未改产品/旧fixture，复用root同金融基线旧golden15/15实际exit0及已合04E38/旧VAT22同blob证明，不无理由全量回归。管理者最终完整head、fresh完整head审查、PR/合并由root后续登记；本任务单不预填接受。不宣称正式连续核算/结转封账/申报或会计批准，仍依赖#80/#51/#82。

回退由root另建PR删除本片新增40路径并恢复04E交接页首；产品和真实账务无回滚变更。
