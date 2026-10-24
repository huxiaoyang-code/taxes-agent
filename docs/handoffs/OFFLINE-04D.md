# OFFLINE-04D 实施交接

本片基于 PR104 merge `80b770161859b75174bb6763eaabd13a6f095748`，当前只有实施候选，尚未 root 独立验收、全新独审、提交、PR 或合并。Issue #81 保持 OPEN。认领：#81 comment6377399188 / #76 comment6377399551；负责人 huxiaoyang-code。

前序事实：PR103 head `32a8fa413f86d1d9b60979cbb20700446d4617e2`，merge `71db5fa9fde95a50e51b79b96d45715cdced2208`；PR104 head `1ba902f8351e750c45a5a0d5c6e58f8c3acf8561`，merge `80b770161859b75174bb6763eaabd13a6f095748`。PR103的03B是真实本机指定账套 formal posting 子能力；PR104的03C是只读期间计划，不能称为Q1 fixed worker。Q1 fresh固定worker/prior-only来自PR102的04C：head `682405838d789ea6cef7dbd973efdada22e9afd1`、merge `0c995076bdf1e78ece6689f486b67443d4c5bc71`，其targetBinding仍not_verified。它们均不是全期/全税种/Q2完整闭环或会计师确认。

04D新增单个 held readonly source/fd、同次read事务的两期私有snapshot产品、双期file-backed session、native-only bootstrap代码闭包比较与opaque pair facade。成功双期binding与Q2材料诊断分开：Q1实际v1重算；已实际提供的Q1原件/账务及合格重算显式标记priorEvidenceProvided/actualQ1Recomputed，historyReadinessIntegration为not_implemented。旧opening/history missing保存在legacyHistoryIssues并标操作者/工程集成阻塞、customerActionRequired=false，不能重复向客户索取已供Q1原件或前期算好数字；真正Q2缺件/未知仍在当前issues中。未新增Q2税额/YTD，不改历史gate，不改旧single API。完整契约见 [OFFLINE-VAT-PAIR](../OFFLINE-VAT-PAIR.md)。

新测试只用临时合成原件和DB，从03B公开prepare/execute实际Q1/Q2入账2凭证6分录（非预制entries/预期金额输入）。Q1 407191/1%且January新设启用，实际行15/16/22为12215.73/8143.82/4071.91；Q2真实April17净613427、原票税6134.27、应收619561.27只原票/ledger对账。第二组467833/728351独立实算、原票对账；期望仅在执行后断言。只读验证覆盖全schema/全表（含audit、batch、period）及warm WAL字节，child退出/资源关闭。

失败历史保留：最初开发探针因fixture向API传相对target路径返回pair_request_invalid，改为绝对路径后真双期成功。第一轮新套实际15 passed / 3 failed、exit1、全部context关闭：测试包装自身读取proxy.request触发1次trap（API尚未触及），用WeakSet识别fixture修复；sandbox实际linkSync为EPERM，未skip，后续必须require_escalated实跑hardlink；receipt-store测试使用错误`.writer.lock`产生store_corrupt，修为实际`lock.json`。这些失败不是通过证据，不删日志/fixture。

修复后曾require_escalated实际新22组全部通过、exit0，真实Windows hardlink建立/拒绝/移除已验，无skip。随后新增Jan额外准入、父缓存默认DB0、worker观察ABA后，第一次LF候选新25/25全部通过、exit0/all contexts closed。该候选再按root要求窄澄清历史桥工程阻塞语义，并把bootstrap sentinel改为有效可执行原生文件写探针；不改实际税额计算/旧provider。历史工程阻塞语义澄清后的完整新25/25已实际通过、exit0、全部contexts closed，包含有效bootstrap应用加载sentinel未执行、非Jan的v1-ready真实Feb入账拒绝、actualQ1Recomputed条件标记、父cached默认DB0、worker观察ABA永久退休及双期CLI发布复核；日志为offline04d-final-clarified-pair.log。最后只补测试独立运行时创建ignored临时父目录及本结果文档，统一11文件LF后再次完整新25确认，再交root独立锁定冻结。无skip，真实hardlink经require_escalated实际建立/拒绝/移除。

## v1拒绝与v2窄修（尚未发布）

上述v1实施自测25通过不等于独审接受。root/独审拒绝v1，未commit、未发布，原11字节已由root保存。问题一：priorEvidenceProvided硬编码true，在Q1 exclusion unknown导致blocked或v1-ready但非January建立被额外门拒绝时，错误声称已有可桥接的有效历史证据。v2改为与actualQ1Recomputed共用priorAdmitted，只有实际Q1 calculationReady且January门通过才true；两个真实失败场景均新增false断言，正常两者true断言保留。

问题二：root真实Q1 Jan1/Q2 Feb1建立日期原件探针仍得到物理绑定成功但当前issues=[]，未暴露跨期同企业事实冲突。v2仅比较两期显式form/establishedOn：不同已知值给cross_quarter_enterprise_form_conflict或cross_quarter_establishment_date_conflict，具体taxFacts.enterprise字段、classification=conflict；目标unknown/null仍保留unknown，不误判为已知矛盾。物理同源可继续成功，质量问题独立保留，不算Q2、不放宽历史门、不让客户提供算好税额。真实Jan/Feb、不同form、unknown/null用原Q1/Q2正式入账夹具检查，全部schema/账表零写。

同时纠正本交接前序归属：PR104是03C期间计划；PR102才是04C prior-only固定worker。103/104原head/merge SHA保持准确。v2新增一组四case及旧组失败标记断言，LF候选完整 `node test/offline-vat-pair.test.mjs` 实际26/26、exit0、skip0，all contexts closed；日志 `06-workbench/.agent-runs/offline04d-v2-pair.log`。其中Windows hardlink通过require_escalated实际建立/拒绝/移除，未skip；Q1 blocked/非Jan两者false、正常两者true、Q1 Jan1/Q2 Feb1及不同form冲突、目标unknown/null保留unknown和账表零写全部通过。运行后仅回填本段实际结果，不再改源码/测试；旧六定点依据实现字节未变复用上述通过结果，无无理由重跑。root/fresh独立验收、提交/发布/合并均尚待，不预填通过。

旧影响定点实际执行：`node test/offline-vat.test.mjs` 22/22、`node test/offline-ledger-snapshot.test.mjs` 27/27、`node test/offline-vat-history-context.test.mjs` 28/28、`node test/accountant-review.test.mjs` 15/15、`node test/offline-material-store.test.mjs` 32/32，均exit0、DB/source或fixture children actualclose；snapshot/history/store使用require_escalated涵盖实际硬链接，无skip。`node test/accountant-review-feedback.test.mjs` 20/20、exit0/DB actualclose/child close observed；不跑全量入口、不改旧断言。此后仅新pair worker/test与三docs语义澄清，旧28/31闭包代码字节未再改。日志保留于`06-workbench/.agent-runs/offline04d-*.log`。

所有11文件最终验证前统一无BOM LF，最终测试进程实际exit后交root 11SHA硬冻结。实施者不做Git写；root/fresh仅在冻结后验收该字节版本，后续不得静默修改。

能力边界：q2CalculationReady/authorizesExecution/periodComplete/submittable恒false，accountantApproval pending、sourceAuthenticity unverified；本机同源/摘要不能认证现实原件真实性。两份配置/target全部新指同一克隆的fresh source无法辨认官方restore来源；原receipt不能转移到别的文件/进程。观察到源/code失效后永久退休，未观察ABA和恶意并发窗口不能绝对排除。旧范围及独立产品总包完成度不因本片自动提升，税局真实接入仍0；W3b/W4/最终Windows整链仍另交付。

回退以本片11路径的新revert PR完成，旧两provider恢复原API实现；本片只读无账务数据写入，无数据回滚。不改全局Skill/配置，不读真实资料，不发送外部消息。
