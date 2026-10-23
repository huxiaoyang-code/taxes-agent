# OFFLINE-04C / #81：显式 Q1 历史上下文校验器

Refs #76 / #81；认领 #81 comment6376161802，返工扩窗 #81 comment6376375135。初始base `0e89a2d107fd75ff18dc0998e89d96c3217baeb3`，#54业务在PR100 merge `e13cc43d9f95ee78599b288486ff5721b01f00e2`已合；现由root无冲突fast-forward到仅13共享docs的PR101 merge `f74460f30699c2740b2163743050b78845979885`（核心字节同e13），工作树 `offline-04c-history`。用户明确覆盖旧外部执行器限制，仅唯一当前模型 Codex 实施 subagent 实现；无 pi/Claude/TokenHub/其它模型或再委派，无 Git 写、全局配置或真实/历史资料读取。root 负责独立验收、全新未实施者审查、Git/PR/合并。

目标：每context全新固定Node worker内真实读取显式 Q1 材料配置/store、声明、事实和实际只读账套，重新调用既有 VAT v1并保留session；父WeakMap receipt只保私有IPC通道。父旧tax缓存不能执行计算；父fork前/后与worker报告31文件实际字节完全匹配。每次串行消费重新检查文件/账/代码并重算；观察 stale、worker退出/timeout后永久废止。async close等待实际退出，父disconnect关闭源。新 CLI 只写全新诊断，不序列化 authority。契约见 [OFFLINE-VAT-HISTORY](../OFFLINE-VAT-HISTORY.md)。

经root明确扩窗，精确可写 9 文件：

- 06-workbench/server/offline-vat-history-context.mjs
- 06-workbench/server/offline-vat-history-code.mjs
- 06-workbench/server/offline-vat-history-worker.mjs
- 06-workbench/scripts/offline-vat-history.mjs
- 06-workbench/test/helpers/offline-vat-history-fixture.mjs
- 06-workbench/test/offline-vat-history-context.test.mjs
- docs/OFFLINE-VAT-HISTORY.md
- docs/tasks/OFFLINE-04C.md
- docs/handoffs/OFFLINE-CLOSELOOP.md

既有 VAT、规则、loader、ledger、review/feedback、28 文件清单、core/audit/batch、旧测试/黄金、package/lock/test-all、STATE/NEXT 及 #54 核心路径均只读。API 不收 targetDb/targetScope，不把公开 snapshot digest 当实际 DB 身份；不实现 Q2/确认复用或正式执行。flags 与 limitations 必须持续明确 prior-only 和无目标库绑定。

验收：真实合成文件→现有候选→现有核心 importer→实际只读 DB；独立分值、SHA/cell/实际凭证分录/来源/规则链。strict 数据、伪造 receipt、公开篡改、原件和 store/CAS、未知/不支持、实际反过账、来源变化、截止外 Q2、逻辑只读与 warm 文件字节、复制源码热变化、新进程、实际 CLI wx 和发布窗均需 fail closed。Windows OS 阻止 held DB replacement 必须如实记未触发替换分支。

实施新套最终 **28/28 exit0、skip0**，所有child实际close；旧19项全部保留，新增late-cache真实throw/fork byte变化/parallel+async close/worker kill/真实spawn ENOENT/超时/parent disconnect及fork/worker两类已观察ABA永久latch与新进程恢复对照。首两轮 13/15、15/16、发布窗 P2、旧18项遗漏hidden/symbol/嵌套Proxy、旧19项遗漏父早缓存tax配新SHA，以及worker首稿26/26遗漏manifest mismatch后bytes恢复还能再mint的真实失败均保留；不以旧通过替代修后接受。codeBinding清单和固定错误code分开，guard只有闭锁无解锁/授正。新audit基线root实际旧VAT22/golden15/ledger27均exit0、f744核心同字节，旧基线review15通过。维护入口 flow status 仍只有既有 human-pl SHA mismatch，未读取/修改其原件。

本片实施自测不构成 root/fresh 最终接受，尚未 PR/合并。#54 PR100已实际合入上述main，#54 comment6376358168与协调comment6376400477；本片不绕正式依赖，也没有因上游已合就实现Q2或正式连续过账。#81/#76/两合法连续税期仍未完。
