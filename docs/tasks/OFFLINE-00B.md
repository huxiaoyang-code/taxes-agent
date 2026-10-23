# OFFLINE-00B — 独立业务黄金与真实域API验收

Refs #76 / #77 / #85。base `98e57bdfbe29e2f8716ab0768492583064cd30c1`。用户明确允许当前唯一实施Codex subagent；不调用pi/Claude/TokenHub、不再委派、无Git/PR操作、无全局设置更改。

初始只写新增 `06-workbench/test/fixtures/offline-business-golden-v1/raw/**`、`expected/**`、`test/helpers/offline-business-golden-reference.mjs`、`test/offline-business-golden.test.mjs`、`docs/OFFLINE-BUSINESS-GOLDEN.md`、本任务及own OFFLINE-CLOSELOOP交接。实际黄金发现产品缺陷后，管理者在#77 comment6375643868/#80 comment6375644345扩认领唯一产品文件 `server/offline-bookkeeping.mjs`，仅修行政服务benefit月份门。其余server/旧test/16旧fixtures/package/lock/test-all/STATE/NEXT/#54核心只读。

完成范围：12个独立合成业务raw与产品执行前冻结的literal expected；独立BigInt参考；实际CSV/XLSX/businessJSON→产品候选→现有importIncremental→真实逐月trialBalance及可信snapshot/VAT。历史期初由显式test prerequisite设置，声明不伪称newzero。原件/预期相互隔离，逐笔来源、规则、真实voucher/entry ID和VAT推导可核验。详见 [业务黄金说明](../OFFLINE-BUSINESS-GOLDEN.md)。

实施状态：首轮12/14、第二轮13/15，exit1（10/12业务通过）；G04/G06发现产品跨月行政benefit span错误，保持黄金并向root报告，获得上述窄授权后修completion月份门。修后新增套15/15、exit0（12/12业务全部通过），G04六种边界及G05持久receipt新进程reopen通过。未改旧套bookkeeping43/43、action-plan33/33、VAT22/22均exit0。root已报告独立Python Decimal核完全部12逐凭证、36个月快照及来源SHA通过；root已独立复跑新15及旧43/33/22均exit0/skip0；另用S469271+行政617.29实际域API核到税14078.13/9385.42/4692.71及未结账试算474581.00，各项通过。全新未实施者最终独审、Git/PR仍待root安排。没有自行宣称会计批准或#77/#85完成。
