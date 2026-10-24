# OFFLINE-04D / Issue #81

负责人 huxiaoyang-code；认领证据：#81 comment6377399188 / #76 comment6377399551。实施基线 `80b770161859b75174bb6763eaabd13a6f095748`，隔离分支 `codex/huxiaoyang-code/offline-04d-pair`。

用户本轮明确授权一个新实施 Codex subagent，覆盖本任务旧 AGENTS/章程/local-agent-first 的执行器限制；实施者不得再委派、启动外部模型执行器或执行 Git 写。root 管理、独立验证、Git/PR；未参与实施的新上下文另审。不改全局 Skill、模型或配置，不读真实财税资料，不加载 registry 历史原件。

目标：同一真实持有 readonly 连接/fd，单次 SQLite 读快照捕获 Q1/Q2；两套实际原件与私有 session 的 source/snapshot 绑定；明确实际 target 的企业、规范整数账套、活动审计 instance/profile；固定 fresh worker 真 Q1 v1 全守卫重算，真实 Q2 4–6 月材料/ledger held。产物是下一片实际 Q2 计算的依赖，不是假 ready DTO。

仅允许 11 路径：server/offline-ledger-snapshot.mjs、server/offline-vat-input.mjs；新增 server/offline-vat-pair-context.mjs、server/offline-vat-pair-code.mjs、server/offline-vat-pair-worker.mjs、scripts/offline-vat-pair.mjs、test/helpers/offline-vat-pair-fixture.mjs、test/offline-vat-pair.test.mjs；以及本文件、docs/OFFLINE-VAT-PAIR.md、docs/handoffs/OFFLINE-04D.md（业务路径均在 06-workbench 下）。旧 tax-calculation/rules/material-completeness/history/review/core/db/audit/batch/package/test-all/STATE/NEXT 全部只读，#51 W3b 36 共享核心路径不消费未合 batch3。

验收：真实合成 Q1/Q2 各一组独立服务资料经03B公开 formal posting 到同一已有 DB；Q1 January 新设、January 启用、新零首期，季度净额>=300000、每笔整数元、原票1%且排除事项为无；手算预期只在执行后的断言出现。Q1 407191→12215.73/8143.82/4071.91；Q2 613427/原票6134.27只做票/账对账，绝不声称Q2已算。另独立金额组、clone/alias/硬链接、错企业/账套/instance/profile/quarter/01、伪receipt、双期文件/ledger/code永久失效、child timeout/exit/disconnect、CLI发布复核、全表/schema零写；旧必要定点全过。

实际已持有的Q1原件/账务和已通过守卫的重算显式标记priorEvidenceProvided/actualQ1Recomputed；旧opening/history missing仅作为工程历史准入尚未接入的legacyHistoryIssues，不重复向客户索取已供Q1或预制税额。真正Q2缺件/未知照常保留，历史gate不放宽。

非目标：Q2税额/YTD、历史gate放宽、会计师确认、期间完成、正式申报、真实税局接入、W4 restore实例来源认证。#81保持OPEN，所有authority flags false，真实性unverified、会计师pending。具体接口及限制见 [OFFLINE-VAT-PAIR](../OFFLINE-VAT-PAIR.md)；结果与失败历史见[本片交接](../handoffs/OFFLINE-04D.md)。
