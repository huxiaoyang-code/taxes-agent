# OFFLINE-04E：真实 Q2 最小计算与可信历史桥

负责人 huxiaoyang-code；认领 #81 comment6377740534 / #76 comment6377741769。基线为已合 PR105 merge `b7e4aeafce833824b33e3669b1b172f9dc5de308`。本片为 #81 的窄子能力，#81／#76 继续 OPEN，不声称新 #82 复核链、整期／全税种、八包或税局联调完成。

按用户明确例外，唯一继承模型 Codex 实施 subagent 负责实现／自测，不再委派、不启动 pi／Claude／外部执行器、不做 Git。root 负责独立验收与 Git，最终另用全新且未参与实现者审查后按既有授权整合。原 04D writer 已停写；共享 #51 W3b 41 路径继续只读，不消费未合 batch3。

当前返工精确 13 路径：原 11 路径 06-workbench/server/tax-calculation.mjs、server/tax-rule-registry.mjs；新增 server/offline-vat-q2.mjs、server/offline-vat-q2-code.mjs、server/offline-vat-q2-worker.mjs、scripts/offline-vat-q2.mjs、test/helpers/offline-vat-q2-fixture.mjs、test/offline-vat-q2.test.mjs；docs/OFFLINE-VAT-Q2.md、docs/tasks/OFFLINE-04E.md、docs/handoffs/OFFLINE-04E.md；以及 root 为真实孤立批次 P2 缺口批准的两个自有 provider：06-workbench/server/offline-ledger-snapshot.mjs、server/offline-vat-input.mjs。扩窗认领 #81 comment6378118026 / #76 comment6378119408。其他 pair／history／review／material／core／audit／batch、旧测试、包锁、test-all、STATE／NEXT 保持只读。

验收以真实 raw→03B formal prepare/execute→同源双期 read-only snapshot→worker Q1 实算→历史逐条解释→Q2 实算为主链。限定 January 2026 新设／起账、季度小规模、两季度分别达到 300000、整数元净额普通境内主营服务及票税和账税确切 1%，完整排除事项会计证据。保留所有 v1 守卫，Q2 不伪首期、不改日期、不采信客户预制分录／税数。未知／冲突／不支持历史不能泛过滤，真实 Q1 已提供不重复要求客户算前期。

金额独立断言 Q1 509873→15296.19/10197.46/5098.73，Q2 347291→10418.73/6945.82/3472.91；累计六行由本次真实两期节点相加，21/22 累计 null。另覆盖不同金额／多票、边界、重复、更正、缺件、跨企／账套／clone、January、draft／money／kind／source／batch、缓存、原生 bootstrap、实际 child 故障、CLI 发布窗和全 schema／全表／warm WAL 零写。官方 Q2 累计逐行 FAQ 未找到，工程推论须显式待会计审定；整数元限制不宣称官方舍入政策。

v1、v2 均已被 root／全新独审拒绝且未 commit／发布。v1 漏目标非零孤立 batch；v2 曾漏非法 future 日期，后又把公共合法新 batch dedup 误称 unexplained。v3 在原13窗内用完整私有 inventory 证明 created／deduplicated 及完整 header/result 计数，支持 Q1、Q2、同批跨期去重而不重复入账／计税，坏关联仍阻断；登记 #81 comment6378362939／#76 comment6378362894。历史31／36通过不冒充最终接受。

v3 实施新套38/38与VAT22/22、root独立新套38/38与VAT22/22均actual exit0／skip0；真实硬链接、所有one-shot child实际退出、全schema账表和DB/WAL零写保断言。fresh v2独立29项及v3来源9/9、21worker实际退出；最终完整HEAD仍待审查，不预写接受／PR／合并。两provider在v3未改，复用本轮旧pair26／snapshot27／history28／review15实际exit0与既有feedback20/2000证据。命令/setup失败和实际产品P2区分，详见交接。

最终13文件LF无BOM、测试前后SHA，三doc实测事实收尾后全部硬冻结；root/fresh复核完整字节。只允许root对13路径另建revert PR，无本只读层账务数据回滚。CLI exit4的failed标记为best-effort，残留诊断不能当成功或授权。与#49 SQLite备份／#51批处理／#54审计协调，不冒称本层执行其写操作；下一工程先#77真实连续两合法quarter独立golden（旧00B不足），再#82 Q2底稿确认链，均尚未完成。

具体接口、来源和限制见 [OFFLINE-VAT-Q2](../OFFLINE-VAT-Q2.md)，最终验证／拒绝证据／13 SHA冻结记录见 [本片交接](../handoffs/OFFLINE-04E.md)。
