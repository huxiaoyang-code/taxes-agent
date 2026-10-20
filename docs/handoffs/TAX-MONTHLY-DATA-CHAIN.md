# TAX-MONTHLY-DATA-CHAIN · 交接与新任务入口

> **2026-10-20 最新恢复：[TAX-HISTORY-COLLECTION 交接](TAX-HISTORY-COLLECTION.md)** · [使用契约 / 安全资料对照表](../TAX-HISTORY-COLLECTION.md) · [任务](../tasks/TAX-HISTORY-COLLECTION.md)。用户已登录完成、新链已建，固定历史查询现有 MCP 两轮各 3 fresh / 3 complete、6 行 / 2 期间，unknown 0、无保留锁，独立比较一致；受限 M1 查询子包代码与真实验证通过，本包已独立审查并随 [PR #38](https://github.com/huxiaoyang-code/youshu-fork/pull/38) 合并。完整 M1 的项目 / 稳定身份版本 / 表字段依赖和 M2–M5 仍待办，无详情 / 下载 / preparation 接线。旧链 target_absent 已本机审计退役、旧结果永久禁用，server 请求终止 unknown，owner / browser 保留；退役代码为 PR #35 的 `ebd018c2ce7b0f9abb18ecd236d07def10cadc98`，该 PR 仍独立 Draft 未合并。下文为 PR #36 文档包时点，不将当时 head、登录 / 新链状态作为当前事实。

日期：2026-10-20。负责人：`huxiaoyang-code`。Refs #20 / #13 / #14 / #17，总任务保留。

## 用户目标与本轮交付

用户确认这一期已申报完成，要打通**企业资料 → 每月应报项目 → 表单 / 资料要求 → 税局本期和必要往期支撑数据优先获取 / 下载 → 确需企业补充清单**。不继续把未报待办当唯一前置，不只补 profile。先做已确认项目与已报期的单条真实取数，再逐项扩展。

本轮只交付[主文档与能力审计](../TAX-MONTHLY-DATA-CHAIN.md)、[分阶段任务单](../tasks/TAX-MONTHLY-DATA-CHAIN.md)和采集契约 / 顶部入口，**未改源码 / 测试 / Skill，未操作浏览器，未实现新的取数或下载**。

文档基线 main `1c12f98bafc38d257482f35f268e7f14d2dbd156`，实施分支 `codex/huxiaoyang-code/tax-monthly-data-chain`。**文档包已完成独立审核并合并为 [PR #36](https://github.com/huxiaoyang-code/youshu-fork/pull/36)**：已审 head `f66f25c8cf12ace2d008f1016cf49846ca1dd63b`，tree `ff0ebd381f3683a4c97d6ce3a81aee0c4df46a51`；merge `cf924010a79d11cabc9fd5420c82eadf87807b1b`，合并时间 UTC `2026-10-20T12:37:43Z`（北京时间 2026-10-20 20:37:43）。管理者核对签名 merge 与已审 tree 一致后建立交接分支 `codex/huxiaoyang-code/tax-monthly-data-handoff`，本次仅补录本文件。**后端 M1–M5 仍待实施 / 验收**，文档合并不改变 PR #35 的 Draft 状态或实际采集失败事实。恢复先核远端和在途 PR，不把起点基线当最新 main。

## 当前能做与不能宣称的结果

- [PR #34](https://github.com/huxiaoyang-code/youshu-fork/pull/34)：门户 6 行已申报记录的基础企业字段与期间，在既有白名单内两轮 MCP 真实复采已验；不能推出完整义务、企业档案或支撑表明细。
- [PR #35](https://github.com/huxiaoyang-code/youshu-fork/pull/35) 是独立 Draft，head `379a413`，未合并，main 不含其 16 项代码变更。企业新增 3 API 只有首遍页面捕获，新资源 MCP 实际成功 0；申报查询另 6 行、13 个行字段、2 个期间仅 observed schema，与门户期间集合不同，无明细 / 附件下载及后端复采。企业所得税核定信息 `DescribeQysdshdxx` 为 0 条，不能推出无义务。
- 通用 gateway / acquisition / preparation 仍有资源分类不一致、生产 adapter 空、内存元信息、prepare fields 空、账套 identityMatched false 和保守 blocked 等边界；live / query 私有证据尚未桥接准备引擎。具体锚与矩阵见主文档，不把工具名当已接入。
- 详情、必要往期表单 / 回执、税局原件下载、持久资料追溯、技术 / 企业缺口分流仍待实现。内部 CSV 是本机派生报表，不能代替税局原件或现行适用申报模板。

## 下一部分怎么接

按任务单 **M1 → M2 → M3** 先形成一个已报期项目的查询账册、详情 / 官网确有文件、规范化私有存储与资料清单；M4 企业适用性与工作月计划可做必要合成准备，不能要求全规则平台先完成才取单项目资料。后续 M5 扩其他项目 / 连续期间。

后续如复用 PR #35，须先同步已合并 main 并保留 PR #36 的最新月度链路目标，不得回退为 currentPending 唯一前置；其候选实现仍须按实际 head 独立审核及真实证据验收。

M1 / M2 必交**单项目所需数据对照表**：逐项列项目、表版本、字段 / 资料类别、口径 / 历史窗口、已观察税局入口与契约证据、本机来源、获取状态、缺口归属和负责人 / 阻断。无官方或实际表单依据的字段待核，不按税种猜资料；真实对照表只在本机。

工作月与每事项所属期分开，verificationTarget 为 completed_period；义务候选 / 确认、已报记录、资料依赖三集合分开，旧 currentPending 标志保留原义。资料关联企业 + 账套 + 项目 + 期间 + 表版本 + 来源凭据；本期发生、期初 / 结转、本年累计、上期 / 比较期各有窗口和用途。

未实现 / 未接入 / 登录失败 / 覆盖不全进内部技术待办，**企业补充清单不能因此增加**。只有有效来源证实税局不提供 / 确实缺失、核本机仍不足且对应字段确需时才索取；每项含表字段、用途、期间、格式、已尝试来源、负责人和阻断程度。来源冲突待核，未知不能写不适用。

## 真实会话和历史隔离

用户最新确认登录失效、正重登，**尚未告知完成**。本轮不操作浏览器；后续由 root 等用户明确登录完成，再在本机核当前作用域。自动点击、猜接口、正式申报、缴款、更正、作废、备案与副作用不明操作禁止；真实数据 / 文件 / 运行参数 / nonce / 凭据不进模型或 Git，模型仅固定摘要与随机 opaque ref，refs 也不入 Git / PR。

PR #35 的旧链退役 diagnose 成功、execute scope 失败；原锁、恢复锁、prepare 与永久 commit 保留，未形成 realm / finish，新链未建，旧链永不消费。只在排查该历史时查[旧交接](TAX-BUSINESS-COLLECTION.md)及 PR；不清锁、不恢复旧结果、不将恢复全部旧方案作为新链设计前置。实施者不读真实 checkpoint / 私有证据。

## 验证和授权

本轮两个只读审计覆盖后端真实能力和业务契约；PR #36 无源码 / 测试改动，未重跑业务回归。9 文件共 153 个本地链接、`git diff --check` 及敏感信息扫描均通过；独立审查批准上述准确 head 与 PR 正文，管理者完成提交、PR 和合并。本轮 Codex subagent 文档实施 / 独审有用户明确授权，仅覆盖本轮；原章程的员工范式不因此永久变更。

## 可复制的新任务提示词

> 先读 docs/PROJECT-CHARTER.md、docs/handoffs/STATE.md、docs/TAX-MONTHLY-DATA-CHAIN.md、docs/tasks/TAX-MONTHLY-DATA-CHAIN.md 和本交接，核最新 main / PR / 所有权。用户这一期已申报完成，优先实施 M1：从已观察的固定只读申报查询契约，为一个已确认项目和已报期建立结果账册、企业 / 期间 / 申报版本绑定、私有持久结果和现有 MCP → 后端两轮实际取回；再 M2 接详情与官网确有文件，M3 桥接资料依赖与缺口分流。PR35 仍 Draft 未合并，不整包假定已交付。门户与查询各6行期间不同不混合，未知业务键不猜。规则 / 全profile / 全部旧恢复不是单项目的当然前置。工作月与所属期分开、completed_period 不污染 currentPending；未实现 / 登录失败 / 部分覆盖只进技术待办，企业补充须有有效查询和业务必要性证据。root 独占真实会话；用户正重登但尚未告知完成；实施仅用合成材料，不读真实私有材料，不点击、不猜接口、不执行业务写，不让数据 / 文件 / 参数 / nonce / 凭据进模型或 Git。按当时有效执行授权派工，管理者独审、验证、PR、合并并更新交接。
