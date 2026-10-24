# OFFLINE-04E 实施交接

> PR107实际已合：[PR #107](https://github.com/huxiaoyang-code/youshu-fork/pull/107)，prior base `b7e4aeafce833824b33e3669b1b172f9dc5de308`、accepted head `07de88d1f442ca5066c79c2175ac7727a4b32ccb`、merge/main `bf1caa3f64fc565fbf676e65c1d42f43d24793b6`；实际交付 [#81 comment6378504231](https://github.com/huxiaoyang-code/youshu-fork/issues/81#issuecomment-6378504231) / [#76 comment6378504181](https://github.com/huxiaoyang-code/youshu-fork/issues/76#issuecomment-6378504181)。下文未提交等为合并前候选历史，后续季度golden见 [OFFLINE-00C](OFFLINE-00C.md)。

## 当前候选与边界

负责人 huxiaoyang-code；认领 #81 comment6377740534／#76 comment6377741769。当前是 v3 实施候选，未 commit／发布；root 的 Git／最终完整 HEAD 审查／PR／合并尚待，不预填接受。基线 PR105 已合 merge `b7e4aeafce833824b33e3669b1b172f9dc5de308`，实际前 base `80b770161859b75174bb6763eaabd13a6f095748`、head `894e66101b2bdcbc0f3d5b3752d5a0e75aca350b`；本片最终 head 由 root 后续给出。

本片精确 13 路径：06-workbench/server/{tax-calculation.mjs,tax-rule-registry.mjs,offline-vat-q2.mjs,offline-vat-q2-code.mjs,offline-vat-q2-worker.mjs,offline-ledger-snapshot.mjs,offline-vat-input.mjs}；06-workbench/scripts/offline-vat-q2.mjs；06-workbench/test/helpers/offline-vat-q2-fixture.mjs；06-workbench/test/offline-vat-q2.test.mjs；docs/OFFLINE-VAT-Q2.md、docs/tasks/OFFLINE-04E.md、本文件。两个 provider 扩窗登记 #81 comment6378118026／#76 comment6378119408，合法公共 dedup 返工登记 #81 comment6378362939／#76 comment6378362894。共享 W3b 41 路径、core／audit／batch、旧测试、package／test-all、STATE／NEXT 和全局配置均未改，不消费未合 batch3。

用户明确例外下唯一继承模型 Codex 实施 subagent 只实施／自测，未再委派、启动外部执行器或操作 Git；root 管理／独验／Git，最终审查者须全新且未参与实现。只用临时合成原件与实际公共正式导入，未加载真实原件／凭据。回退由 root 另建这 13 路径的 revert PR；本只读层无账务数据回滚。

## 实现与接口

`runOfflineVatQ2(request)`、`checkOfflineVatQ2Current(request, 顶层diagnostic.contentDigest)` 为 stateless fresh-worker 入口；低层 `calculateOfflineVatQ2(realPairSession)` 验证真正 private pair、双 session/raw/source/snapshot 精确 tuple，并在本次 worker 内重算 Q1。CLI 用 wx 创建诊断，写入／sync 后再 fresh 重算核对完整绑定；exit 4 下尽力标 failed，失败文件可能残留，不能当成功或授权。完整请求／返回及官方依据定位见 [OFFLINE-VAT-Q2](../OFFLINE-VAT-Q2.md)。

同 held 物理 source/fd/connection、同 read transaction 的 target-only private batch inventory 捕获孤立及完整关联，single/pair current 重核继承策略；旧 Q1／single／04C／04D 默认 shape、v1 guard 和旧 pair Q2ready=false 保留。非零孤立、未知／失败／坏 result、身份和来源矛盾阻断且归操作者；真实公共严格全零 noop 可解释。只有完整合法实际 future voucher 日期／月份／来源证明的批次才从 Q2 依赖排除，合法 Q3 不无谓 stale，created_at 不冒充业务季。

created 必须同原创建 batch；deduplicated 可跨 batch，但必须完整匹配真实创建 source/voucher/企业/账套/来源 ID/content fp/persisted fp，且 completed header 五项 result 与全部真实 action 数量一致。内部完整 inventory 证明支持 Q1／Q2 单独及同批跨期 dedup，不拿 Q1 投影的局部数量比完整批次；实际账务不增加，不重复计税。所有坏 action／身份／指纹／结果／缺创建来源仍阻断。已经核对的 Q1 会计解释与整体税桥 ready 分开，上游 unknown/conflict/missing/unsupported 和具体事实请求保留；未知设立日期不误判非 January。

范围仍仅 January 2026 新设／起账、季度小规模、两季度各 >=300000、普通境内主营服务、整数元净额、原票与实际账 VAT 确切 1%、完整会计排除确认。Q2 保持 Apr–Jun；本期1/2/3/15/16/20/21/22，累计仅1/2/3/15/16/20由本 worker 的真实 Q1 本期+Q2，本年累计21/22官方横杠为 null。累计为栏义的工程推论、待会计审定，未找到直接逐行 Q2 FAQ；整数元是工程避舍入限制。基础票事实保留 owner/business_operator/accountant 合法角色，企业／期间／资格／排除事项原会计门不变。

## 最终字节的实际验证

v3 实现／测试先统一 LF 无 BOM 并冻结，阶段 manifest `06-workbench/.agent-runs/offline04e-v3-final-before-sha.json` 与 `offline04e-v3-final-after-tests-sha.json` 全 13 SHA 一致。所有实施／root／fresh owned 产品进程均实际退出后，仅开放三 doc 收尾；其余 10 文件保持阶段字节，不再跑产品。最终三 doc 回填后全 13 SHA 见 `06-workbench/.agent-runs/offline04e-v3-final-frozen-sha.json`，实施者硬冻结停止全部写入；root／fresh 仍须核最终完整 bytes。

- 实施实际 `node test/offline-vat-q2.test.mjs`：38 passed／0 failed，exit 0、skip 0，all one-shot children exited；require_escalated 真硬链接，日志 `06-workbench/.agent-runs/offline04e-v3-final-q2.log`。新 dedup 正反例、金额／多票／边界、补正／重复／原资料、私有入口、实际 ledger/source/batch 故障、代码缓存／bootstrap、真实 child error/exit/disconnect/timeout、CLI 发布窗、全 schema／全表／DB 与 warm WAL 零写均保断言。
- 实施实际 `node test/offline-vat.test.mjs`：22/22、exit 0、skip 0、DB actualclose，日志 `offline04e-v3-final-vat-corrected.log`。首次误用不存在的 offline-vat-calculation.test.mjs 为 MODULE_NOT_FOUND/exit 1，未导入产品，原日志保留；这是命令 setup 错误。
- 复用 v2-final 实际已通过的 pair26／snapshot27／history28／review15，均 exit 0、skip 0；日志 `offline04e-v2-final-{pair,snapshot,history,review}.log`。v3 两 provider 和这些默认接口字节未变，仅新 Q2 来源解释逻辑与新测试改变，VAT 已重跑。旧 feedback20（2000真实有效回执）沿用 `offline04e-old-feedback.log` 的实际通过证据。snapshot/history 的 Windows held DB 路径替换被 sharing 阻止，记录 OS_BLOCKED，不冒称该替换分支已实际执行。
- root 独立完整新套 38 passed／0 failed、exit 0、skip 0、所有 one-shot child 实际退出；VAT22 exit 0，日志 `root04e-v3-new.log`／`root04e-v3-vat.log`。root 独立 raw 金额 Q1 541219／Q2 386473，Q2税3864.73／YTD9276.92，公共单期及混合 dedup 后始终2 vouchers/6 entries；公共 empty 合法、四类孤立／结果故障令旧 current stale。真实 Q3净419153/税4191.53由03B正式导入后Q2摘要不变，坏日期／跨月拒绝；Q1 cause、parent cache/default DB0、永久restart、bootstrap sentinel、真实CLI相对路径/wx/固定stdout及全schema表零写实际通过。
- fresh v2 独立29项及 v3 dedup来源9/9已实际通过；v3 21个 worker 实际退出。上述局部审查和 v2 历史通过不等于最终完整 HEAD 接受，仍待最终审查。

## 已拒绝候选与失败事实

v1 自测31通过后仍被 root／全新独审拒绝：completed 非零孤立 header 无任何 voucher/source 关联，被旧 provider 漏掉而 ready、旧摘要 current。完整拒绝字节 `.agent-runs/root-rejected-v1`，独立证据 `.agent-runs/root-orphan-batch-evidence.json`、`.agent-runs/review-offline04e-independent/orphan-batch-evidence.json`。扩为13路径后补 private inventory。早期真实 IPC disconnect 回收缺口亦已修；初轮测试含重复副本误预期、eval字符串等 setup/断言问题及 sandbox hardlink EPERM，失败日志保留，不将无害 canonical 重复称产品漏洞；最终硬链接真实重跑而非skip。

v2 的36通过不能代替最终接受。其间实际发现 future period=2026-13/date=2026-13-17且持久指纹重写仍被排除，证据 `06-workbench/.agent-runs/offline04e-v2-invalid-future-before.json`；补合法日历日期／月份一致校验及四个真实SQL反例。之后 root 公共新 batch 合法 dedup 返回0 created/1 dedup、仍2v6e，Q2却误报 unexplained；这是来源解释 P2，v2再次拒绝，字节 `.agent-runs/root-rejected-v2`，证据 `.agent-runs/root-public-dedup-evidence.json`。v3以完整私有计数证明修复，不删除来源检查。

root private/quality 初次共用 fixture 并行触发 input_changed，串行通过；root batch probe 的 SQL null违反NOT NULL、future helper 的字母数字invoiceID非法均为setup错误，修helper后独立通过，不算产品故障。04D历史两项诊断返工（priorEvidenceProvided不随准入、跨期企业矛盾漏诊）在其v2修后才合PR105，不是整包完成。

## 未完成依赖

calculationReady／reviewReady／q2CalculationReady 仅为窄字段工程计算；authorizesExecution／periodComplete／submittable=false，会计 pending，真实性与在线兼容 unverified。JSON/hash不是认证或可恢复权限；未观察ABA与恶意并发窗口不能绝对排除。新 #82 Q2复核确认链未接入，#81／#76及八包仍未整体完成，税局真实接入0。

协调 #49 SQLite备份、#51批处理、#54审计的已合接口，不重复实现，本层不执行其写操作。下一工程先回 #77补两个真实连续合法季度的独立golden（旧00B明确不构成两个合法税期），再接 #82 Q2底稿／确认链；两项均待完成，不预报完成。
