## 2026-10-23 LOCAL03b B2b候选

辅助分录摘要合计使用已审storedCents/centsToNumber进行整数分累加与安全转换，并显式核既有模型数值上限；超界整份摘要失败、adapter不给引用。管理者发现的浮点累加差1分P2与修前/修后证据统一见辅助交接。

八个local辅助工具使用现有模型入口单例、adapter与policy；四查询仅固定计数/六金额/期间/往来状态，四写仅技术ID、固定结果及durability。原文留进程内localRef，绑定账套/operation，支持本机read及受控compute；不增加MCP raw/read/compute工具。completed核心回放 + 新aux applied + 两层committed判applied=true；三个Count含重放与空分配，不等于新增行数。dryRun=false仍须持久证据，staged/pending/unknown保守unknown。无附录旧规则保持。具体真实入口、自测、限制与PR70历史统一见 [辅助交接](handoffs/LOCAL-03b.md)。本轮尚待管理独立验收及PR；下方历史证据不代替本轮结果。

# 财务输出边界契约 · FINANCE-OUTPUT-BOUNDARY

## 当前候选合同（2026-10-23）

负责人 `huxiaoyang-code`；分支 `codex/huxiaoyang-code/local-03a`，历史派工输入 `502640906262d6eefbe81b3460361e74ea0811b5`（不是当前候选 HEAD）；当前完整候选已本地保存为 `79a55e7d58e7d6d175997abc96ef6241afa37a14`，基线 main `47b6ec18385ef3f9f1240e12a721e46cd66f218f`，本轮文档提交后的最终 HEAD 由管理者另行锁定。双准则领域、出口、企业身份全入口已实施，当前候选已本地保存、未推送 / 未开 PR / 未合并，最终文档及不可变 HEAD 的独立接受待完成。统一入口保留 main 原 65 套逐字原序并末尾登记实际 8 套（3 个标准领域 / 迁移、身份领域 / HTTP / MCP、标准 HTTP / MCP），共 73 套；实际完整运行结果见下方“本轮完整验证”。

- 新建、legacy 首次导入与 incremental create 都必须显式稳定 `enterprise` / `source.enterpriseKey`；NFKC + trim，保留大小写，接受有限数值文本化，不从名称或来源系统造身份。同 key 换名 / 换来源不得另建账套，不同 key 同名允许。账套 / profile / 科目 / 期间 / canonical 身份在同一事务或保存点，失败原子回滚。
- 历史未绑定账套仍可读；`GET/POST /api/account-sets/:id/enterprise` 及本机 UI 支持显式确认关联。首次关联要求确认，同绑定返回 `no_change`，不强换绑、不自动合并旧重复账套。本机 UI 手工新建与确认绑定已有合成实操；一企一套不等于一企一数据目录，同一库允许多企业各有一个账套。新建 UI 已传显式身份；JSON / CSV UI 文件导入的受支持 filechooser 流程经 root 尝试后仍出现工具实际超时未受控，上传 / 预检结果未知，暂不继续该工具流程；不能由领域 / HTTP 测试代替 UI 成功。
- 真正省略 profile 默认 `small-2011-basic-v1`，精确企业准则选 `enterprise-2019-general-basic-v1`；显式空 / null / 非字符串 / 未知 profile 拒绝 `accounting_profile_unknown`，准则不合法与不匹配分别为 `accounting_standard_invalid` / `accounting_profile_standard_mismatch`，legacy profile 禁新建。历史 `legacy-small-coa-v1` 保持兼容，不能用标签转换。
- append 与已完成 create 批次先定位目标持久 profile，再归一化。旧成功批次重放保持账套 / voucher / source ID、原批次及来源指纹、attempt 与时间戳，验证 canonical / 来源证据 / batch links；重放不重算旧指纹。从未导入期初的批次允许后来合法补期初；实际导入过的期初变化仍冲突。
- 五类 CSV / XLSX / PDF 传持久 `accountingContext` 和 `reportStatus`，三表为 `complete/incomplete/legacy_compatibility`，余额 / 明细为 `not_applicable`。稳定行 ID 对齐，累计现金流保留各月诊断；新 profile 的未知 / 复合现金流不按比例凑齐，不能宣称完整。累计折旧借方净额列示（贷余额为负，零为零），折旧 magnitude、资产净值、利润、幂等及回滚合同不变。
- strict backup 识别 core schema 3 / 4 / 5 × bank 0 / 1 精确合同，未知结构 fail closed；不代表审计业务接线、现库安装或真实 restore 已完成。模型只接固定 profile / 状态 / 诊断计数，未知 fail closed，企业 key / 名称 / 明细与自由错误不出站；08 原脱敏 / 引用 / 账套隔离边界保持。

仅内部简化基础业务子集，不是完整准则或税局可上传申报文件；来源完整性仍 `unverified`，全国真实接入数 0。辅助核算 Issue #64、LOCAL06 审计 / 恢复与 Windows W2、LOCAL07 whole batch 仍未完成；不能由本候选宣称整个 LOCAL01 / 03 / 05 完成。

### 2026-10-23 独审 P2 修复后的验证边界

新增明细科目的严格归一化现调用 `addAccount` 同源 `accountProfileSemantics`，按新建选定或目标持久 profile 拒绝 `account_semantics_conflict`；已有标准科目兼容与旧成功批次指纹规则保持。修后实际命令（cwd `06-workbench`）：`node --check server/accounting.mjs` exit 0；`node test/accounting-standards.test.mjs` 38/38、`node test/import-incremental.test.mjs` 57/57、`node test/import-strict.test.mjs` 54/54、`node test/accounting-standards-http.test.mjs` 2/2、`node ../05-reconstruction/codex/mcp/finance-mcp/accounting-standards-test.mjs` 2/2，全部 exit 0，自有直接 child 均已 close。双 profile 的 legacy / incremental create / append 错类别和方向均静态拒绝、业务及批次 / 来源全表零写；合法同根明细独立金额及 completed 批次 ID / 指纹只读重放通过。

此前管理者在修前候选执行完整入口 `node scripts/test-all.mjs`，73/73 套各 exit 0，入口实际 exit 0、child close，候选 76 文件 hash 前后相同。这是修前真实历史；更早实施者 71/73、1907/1909 项及两税务定点 61 项也保持各自历史时点。P2 修后管理者已重新在 cwd `06-workbench` 实跑完整入口 `node scripts/test-all.mjs`，73/73 套全部 exit 0，入口实际 exit 0、`childCloseObserved:true`，全部源码 / 测试 hash 前后相同；本机证据为根 `.agent-runs/local03-manager-final-c1a7f4d853344f66a9614d3cfeb37914/` 的 `full.log`、`full.exit.json`、`code-after.json`，不以修前完整结果替代。

未参与实施且使用全新上下文的 `review_03_final_whole_fresh` 已完成完整差异静态审查，并在全新合成根独立复验 32 分组：双 profile 的 legacy / incremental create / append 错 category / direction 在 dry / apply 均拒绝，业务及批次 / 来源全表零写；合法自选金额 27.61 / 48.37、旧 IDs / fingerprint / attempt / timestamps 保持，探针 exit 0、DB 已关闭，未确认其他 P1 / P2。本机证据为根 `.agent-runs/review03-final-semantics-fixed-9ba01fb5199e49af82b937d9872648b1/`；最终文档与不可变 HEAD 仍待该独立审查者接受，尚未推送 / PR / 合并，不代表整个 LOCAL03（含辅助 Issue #64）或 LOCAL04 / 06 / 07 已完成。

本机 UI 手工新建与确认绑定已有合成实操；一企一套不等于一企一数据目录，同一库允许多企业各有一个账套。UI JSON / CSV 文件导入两次 filechooser 工具超时；用户已授权 CDP 合成输入，但工具明确不支持 raw CDP，实操仍未知，不能记为通过。所有本轮自有 UI 服务均已结束，不再启动浏览器重试；领域 / HTTP / MCP 通过不替代 UI 实操。内部简化报表子集、来源完整性 `unverified`、真实税局接入 0、辅助维度与 LOCAL06 / 07 未完边界保持。

### 修前实施者完整验证历史

2026-10-23 实施者实际执行 `node scripts/test-all.mjs`（cwd `06-workbench`），新 UUID 合成隔离根、TEMP / TMP / DATA 预设并传 child，显式 Office Python：完整 73 套真正执行，**71/73 套、1907/1909 项，exit 1**。仅两个税务 MCP 旧建账 fixture 漏 enterprise：`tax` 58/59 与 `tax-acquisition-mcp` 1/2；其余 71 套全部 exit 0，含批量 CLI 11/11、Office 25/25、新标准与身份 8 套。批量真实 PDF 文本、CSV / XLSX 累计折旧负号与独立 magnitude / 净值 / 利润 / 幂等 / 回滚断言均通过。

经 Issue #56 comment6359944200 精确授权，完整入口实际 close 后，仅给 `tax-contract-test.mjs` 与 `tax-acquisition-test.mjs` 的两处建账参数补固定合成 enterpriseKey；所有税务请求和旧断言原样。新 UUID 根以原正式 suite 定点重跑 **59/59 + 2/2，均 exit 0**。原完整红例保留；不能将修后定点结果改写为同一最终 hash 的 73 套全绿，该时点管理者完整入口尚待执行；后续修前完整 73/73 已实际通过，见本页 P2 验证边界。修后完整入口与 fresh 独立复验的当前结果见本页 P2 验证边界；最终文档及不可变 HEAD 的独立接受仍待完成。

首轮普通沙箱完整入口因 loopback EACCES 和硬链接权限路径失败，在旧 `tax-readonly-abandon` 的 checkpoint 等待挂起；只进入 21 套、前 20 套已返回，未跑后续。精确核验命令 / 创建时间 / 父子链后持自有 Process handles 收尾，已 wait，wrapper 记录 child close，入口终止码 4294967295、wrapper exit 1；此轮不计完整 73 套。第二轮完整入口与两套定点的直接 child 均实记 close；无本段仍运行的自有 exec / 后端服务。所有 fixture / 失败日志保留，无全局 TEMP 清理、无真实账套或税局操作。逐套日志与 hash 已交管理者；本段不执行 Git。

## 历史阶段材料

下文按原阶段与日期保留来源 / 测试记录；其“未接线 / 待后续”仅指当时版本，现状以当前候选合同为准。

>
> 银行出版窗口基于该实际main追加4套为静态65；最终65与银行fresh独审 / PR63合并待root，不能混作本包61套已通过的证据。下方候选 / OPEN / 未合并与失败条目按各自历史时点保留。

> **2026-10-23 当前整合候选（优先于下方各阶段快照）**：[Issue #44 精确窗口](https://github.com/huxiaoyang-code/youshu-fork/issues/44#issuecomment-6357299894) 登记整体31文件；本轮只允许其中11文件的入口登记与交接。已冻结24文件源候选 `b3b68db8b8db0af398376ee752646783e0bb4b7b` 无冲突纳入 [PR #65](https://github.com/huxiaoyang-code/youshu-fork/pull/65) 的 main merge `97384868ca1cb7a3f07bf561fedac666c7674eb3`，整合起点 `c764278a9e41a3ce502e662ffa56b0dc18ab307a`。PR65 已审 head 为 `37bcb286041f76d85c01ff5f6078727497570425`。
>
> 统一测试入口原59套完整保留并保持顺序，末尾仅追加 `local-batch-persistence.test.mjs` 与 `local-batch-cli.test.mjs`，当前静态登记 **61套**；银行4套尚未 main，本轮不登记。此前24文件候选的8套 **131/131 exit 0** 是既有受影响验证证据，不代表当前31文件候选已完成全61套验证。**最终61套、fresh独立审查、PR与合并均待 root**；本轮仅入口语法 / 静态计数 / diff检查，无业务或正式测试修改、无财务测试重跑。Issue #44 保持 OPEN。旧55套子进程成功而统一入口整体exit1、后续56/59成功均保留原时点，不覆盖历史。

# 财务输出边界契约 · FINANCE-OUTPUT-BOUNDARY

> **2026-10-23 修复与正式补证候选（最新，未独审 / 未提交 / 未合并）**：范围由 21 增为精确 24 路径（[Issue #44 登记](https://github.com/huxiaoyang-code/youshu-fork/issues/44#issuecomment-6357131464)），新增 transport 源码 / 测试与 adapter 测试，仅联动非法写结果复核语义。保留已提交写的 `applied:true` 与可证技术 ID，非法 DTO 的 getter 不执行、无原文引用并标记 `needsLocalReview:true`；transport 只在无引用且 `refUnavailable` 为 `value_invalid` / `summary_unavailable` 时允许该组合，其余写三态约束保持。正式新增真实单次 19 元写后污染 DTO、17 / 23 元容量对照；真实 MCP → 自有代理 → 生产 HTTP → SQLite 提交后的 drop / timeout / partial body / bad JSON / 非 2xx / 非法信封，每种仅一次转发与一条凭证（借贷分别同额 61–66）；HTTP 两账套并发各 31 / 47 元、同一 stdio MCP 客户端两账套并发各 37 / 53 元，均核对金额 / 引用归属 / 最终各一条凭证。恢复 raw 预检精确来源 `MCP-SRC-0001` 与重开失败精确月份 `2026-02`。资源 / null / method 对象 / 未知 method 仅固定错误；协议缺陷属于既有代码，本包未将其写成新回归。历史接线窗口是 55 套子进程 exit 0、统一入口整体 exit 1；后来的 56/56、59/59 保持各自时点，不代表本次候选已过最终集成。

> **2026-10-22 统一测试入口登记窗口注记（最新；不改写下方历史阶段）**：远端正式授权把 `06-workbench/scripts/test-all.mjs` 的**唯一写归属**改判给 LOCAL-08（[Issue #53 comment 6344168123](https://github.com/huxiaoyang-code/youshu-fork/issues/53#issuecomment-6344168123)、[Issue #44 comment 6344169272](https://github.com/huxiaoyang-code/youshu-fork/issues/44#issuecomment-6344169272)、[PR #63 comment 6344170064](https://github.com/huxiaoyang-code/youshu-fork/pull/63#issuecomment-6344170064)）。精确范围扩为 **19 路径** = 补漏窗口 18 路径 + `06-workbench/scripts/test-all.mjs`。该文件**原 56 套逐字保留**，只在数组末尾追加 `finance-model-entry` / `finance-model-http` / `finance-model-entry-mcp` 三套，实际总数 **59**；银行 4 套**不在本窗口**登记（后续由另一本机 pi 基于 08 实际 main 并集进 PR #63）。本窗口实跑：`node scripts/test-all.mjs`（`06-workbench`，设 `REPORT_OFFICE_PYTHON`）**59/59 套 exit 0**，新三套 **15/15 / 14/14 / 8/8**。历史链条按原文保留：17 路径接线窗口 **55/56**（旧 raw 形状断言失败）→ 18 路径补漏窗口（单一兼容补漏）**56/56** → 本窗口 19 路径 **59/59**。未改任何源码 / 测试文件、未改共享 STATE / tasks README / master；未做 Git 写，Issue #44 保持 OPEN。细节见新增 **§16**。

> **2026-10-22 兼容测试补漏窗口注记（历史阶段；不改写下方历史阶段）**：按 Issue #44 独占增补授权（[comment 6343989046](https://github.com/huxiaoyang-code/youshu-fork/issues/44#issuecomment-6343989046)），精确范围扩为 **18 路径** = 接线窗口 17 路径 + `05-reconstruction/codex/mcp/finance-mcp/tax-contract-test.mjs`。该文件**只改**普通 `account_context` 往返的旧 raw 形状断言：先经同一模型通道在临时库建 1 个合成账套，再断言真实信封与 `projection` 的账套业务事实（真实 ID / 起始期间 / 受控枚举 / 名称存在标记、不回企业名），全部税务 fake adapter / 缺省未配置 / 未实现工具断言保留。本窗口实跑：`tax-contract-test.mjs` **59/59 exit 0**；`node scripts/test-all.mjs` **56/56 套 exit 0**（接线窗口的 **55/56** 记录保留在 §15.6 / §15.7，不覆盖）。未改税务源码 / server / finance 模型代码 / 另外 5 套 MCP 测试 / `scripts/test-all.mjs`；未做 Git 写，Issue #44 保持 OPEN。契约差异见新增 **§15.9**。

> **2026-10-22 接线窗口注记（历史阶段；不改写下方历史阶段）**：本窗口把已合并的 policy / adapter / transport **真正接到**普通财务工具的 Agent / HTTP / MCP 入口，并新增本机引用读取 / 计算接口；细节见新增 **§15**。精确改动 17 个路径 = 源码 6（1 新 + 5 改）、测试 8（3 新 + 5 旧 MCP 迁移）、文档 3；`scripts/test-all.mjs` **未改**（归 Issue #53 先登记银行套件）。三套新套件实测：入口 **15/15**、真实 HTTP **14/14**、MCP 端到端 **8/8**，均 exit 0；受影响旧 MCP 五套全部 exit 0（contract **46/46**、workflow **23/23**、import-incremental **7/7**、accounting-period **5/5**、smoke **28/28**）。完整 `node scripts/test-all.mjs` 在本机候选上为 **55 套子进程 exit 0、1 套失败；统一入口整体 exit 1（55/56）**：唯一失败是 `tax-contract-test.mjs` 仍断言 `account_context` 的 raw `account_sets` 旧形状（当时不在 17 路径内，已作为范围外必需迁移上报 root，**未擅改**；同一业务能力由三套新套件的真实 HTTP / MCP 用例覆盖；**已由上面的补漏窗口修复**）。本窗口未执行 Git 写操作；Issue #44 仍 OPEN。

> **当前状态注记（2026-10-22 最终文档轮）**：输出协议候选源码 `3a8ae7ab0a3ca61ed15ddc6aa112eba6c4837795` 已由独立 `review_output08_final` **接受**（**61** 回修探针 + **47** 旧控制 + **3** 真实临时领域场景，两项 P2 均已关闭）；其中 **37 policy / 21 adapter / 18 transport 为员工自测**，不是 root 计数。该候选已随 LOCAL-02 的 Draft [PR #60](https://github.com/huxiaoyang-code/youshu-fork/pull/60) 提交，**未合并**，尚无 merge SHA；adapter / transport 模块本身已经 [PR #57](https://github.com/huxiaoyang-code/youshu-fork/pull/57) 合入 main（merge `db6020a`）。**共享 HTTP / Agent / MCP / CLI 入口仍未接线**，Issue #44 保持 OPEN。下方四段状态与 §14 各轮的「未提交 / 待审」是各自**阶段快照**，与本节事实不冲突，不改写历史。

- 状态分四段，**不要混读**：
  1. **纯策略模块已合并**：`06-workbench/server/finance-output-policy.mjs` 经独立审查后由 [PR #50](https://github.com/huxiaoyang-code/youshu-fork/pull/50) 合并（已审 head `f211ace5b90e6dc5f240c8bb870ffbf5eb11662b`，merge / main `b42bae9ae76e54aeda63bcc4db0dc34663286b7d`，2026-10-22T09:57:25Z）；
  2. **适配层 + 出站信封校验已实现、已提交并推送，PR 待合并**：`06-workbench/server/finance-model-adapter.mjs` + 真实（临时库）调用验收 `06-workbench/test/finance-model-adapter.test.mjs`；`05-reconstruction/codex/mcp/finance-mcp/finance-model-transport.mjs` + `finance-model-transport-test.mjs`。**已审源码 head `ba5d60115e52fa13805841d9abe07006b74b2c9c`**；原三层为策略 **34/34**、适配层 **19/19**、transport **16/16**，均 exit 0；LOCAL-02 兼容增量后本轮为策略 **35/35**、适配层 **20/20**、transport **17/17**（原 34/19/16 项含义保留）。最终独审 `review_output08_final` **未参与实现**，原 3 项 P2 全部关闭，独立探针 **57/57** 通过（**57 是独审探针项数，不等于三套测试用例总数**），此前 transport 最后副本一致性复核亦通过；LOCAL-02 兼容增量仍待 root 最终增量独审 / PR；
  3. **HTTP / Agent / MCP / CLI 仍全部未接线**：`agent-tools.mjs`、`server.mjs`、MCP `backend/server/tools`、`scripts/test-all.mjs` 一律未改（共享入口归 LOCAL-02 / Issue #47）。因此**当前真实模型入口仍原样返回业务原文**；本契约尚未在真实入口生效，Issue #44 **保持 OPEN**。模块 / 适配层通过 ≠ 数据边界已生效；
  4. **PR [#57](https://github.com/huxiaoyang-code/youshu-fork/pull/57) 已 OPEN 并 attach**：从 main `98977e04bd24aa293074021802191814f8c2a1d2` 合入形成 head `e8b298e42224e2e1b884f7827e4c366881d22fc9`——该次合入仅添加 PR #55 的六个 backup 文件，本包 9 路径与 `ba5d601` 逐文件完全不变。当前**已提交 / 已推送，等待文档核对后按已授权流程合并**；**尚无 merge SHA，不预报已合并**。本次文档提交会产生新 head，管理者合并前再核对 6 个源码 / 测试文件未变。
- **历史（review1 / review3 / review4 / review5）**：四轮定向返工当时均为「已实现并自测通过、未提交 / 未推送 / 未独审」，现均已纳入已审 head `ba5d601` 并通过最终独审；各轮问题与修复证据保留在 §14.1–§14.4，按其时点阅读，不再代表当前提交 / 审查状态。
- 归属：LOCAL-08（[任务单](tasks/LOCAL-08.md)、[交接](handoffs/LOCAL-08.md)），Refs Issue #44；负责人 `huxiaoyang-code`；分支 `codex/huxiaoyang-code/local-08-adapter`（由管理者从上述 main 建立）。
- 本文件只描述**已经写进代码并在合成 / 临时库测试中验证过的契约**；未实现项一律标注「未实现」。

## 1. 要解决的问题

`/agent/tools/<name>`（`server.mjs` → `agent-tools.mjs` → `accounting.mjs`）把领域结果原样返回给模型侧：

- `finance_query` 直接把 `A.getAccountSet / listAccounts / listVouchers / getVoucher / balanceSheet / incomeStatement / cashFlowStatement / trialBalance / generalLedger` 的返回值放进 `data`，其中含企业名称、科目编码与名称、凭证摘要、往来单位、经办人、逐行凭证、明细账逐笔记录；
- 写动作返回完整凭证行等业务原文；
- 领域异常的 `message` 常内嵌科目编码 / 金额 / 账套名，`details` 可能含凭证行，`stack` 含本机路径。

模型（含本机回退模型）不需要这些原文，却会因此把账套业务数据带进模型上下文与模型侧日志。**本契约把「模型输出」与「本机操作读取」分成两条通道**：模型只拿有限数值摘要 + 不可猜测引用；原数据只能在本机用同一引用取回。

## 2. 双通道模型（策略模块，已合并）

| 通道 | 入口 | 调用者 | 能拿到什么 |
|---|---|---|---|
| 模型通道 | `wrapQuery` / `wrapWrite` / `runWrite` / `resolveForModel` | Agent 工具、MCP 后端、任何把结果送模型的地方 | 白名单 projection（有限数值 / 布尔 / 状态 token / 期间）+ `localRef` |
| 本机通道 | `localRead` / `localCompute` / `revokeLocalRef` | 本机 UI、本机回环服务、本机脚本 | 原数据、受限算术结果 |

两条通道都要求 `accountSetId` 显式给正整数（沿用既有的「绝不猜默认账套」），引用本身已绑定账套，跨账套直接用报错拒绝。

**凡是引用调用，`accountSetId` 与 `operation` 都必须显式给出并被核验**，缺省、跨账套、换工具一律拒绝（§5）。策略模块内**没有「不带账套的全局工具」路径**：真正全局的工具必须有自己的明确 scope 语义与独立接口，既不得伪造默认账套，也不得复用本模块的引用绕过绑定。适配层据此把 `account_context` / `finance_context_resolve` 做成**单独的 global scope 结果**（无引用，见 §10）。

本机通道由**能力对象**授权，不由参数声明授权：

```js
const channel = policy.issueChannel("local_ui");            // 进程内对象，含随机 channelId
policy.localRead(ref, { channel, accountSetId: 5, operation: "finance_query:voucher.detail" }); // 通过
policy.localRead(ref, { local: true, accountSetId: 5, operation: "finance_query:voucher.detail" });   // 拒绝：channel_untrusted
policy.localRead(ref, { channel: "local", accountSetId: 5, operation: "finance_query:voucher.detail" }); // 拒绝：channel_untrusted
policy.localRead(ref, { channel, accountSetId: 5 });        // 拒绝：operation_required
```

模型参数里 `local: true` / `channel: "local"` / 被 JSON 反序列化过的 `{channelId: ...}` 一律拒绝（`output_policy_channel_untrusted`），**不做静默降级**。`issueChannel(label)` 只在本机进程内签发能力对象（对象标识即凭据），不接受、也不解析任何模型输入。接线时必须由本机进程启动时签发并只留在内存里（§9）。

## 3. 模型通道允许清单（默认拒绝）

projection 只允许：**有限数值**（2 位小数、绝对值 ≤ 1e12）、**布尔**、**状态 token**（`^[a-z][a-z0-9_]{0,31}$`）、**期间**（`YYYY-MM`）、**≤32 个同类标量的数组**（数值 / 布尔 / 状态 token / 期间）、**≤3 层 / ≤96 节点的普通对象**。未知 operation 直接报 `output_policy_unknown_operation`；未登记字段（自由文本、中文业务名、更深嵌套）被丢弃并计入 `projectionDropped`。这不是敏感词黑名单，而是**字段白名单 + 值形状白名单**双重默认拒绝。

`operation` 必须是**已登记的原始字符串**：先 `typeof operation === "string"`，再查表；任何查表、下标访问、字符串转换都在类型校验之后，所以 `{ toString() { return "voucher_create" } }` 既不会触发 `ToPropertyKey` 的用户代码，也不可能进入信封。同一约束适用于 `runWrite`、`resolveForModel` 与 `localRead` / `localCompute` / `revokeLocalRef` 的 `operation`。

### 3.1 可返回给模型的汇总数字（查询）

`finance_query`（operation = `finance_query:<nodeId>`）：

> 摘要字段的必需性：每个 node 的投影 spec 只读**真实 DTO 的必需字段/类型**；缺字段、类型不符或必需 canonical 行缺失时明确失败（`model_result_invalid` / `output_policy_value_invalid`），**不用 0 或空对象伪造真实数值**。真实的 0 仍正常保留。
>
> **值域（review3）**：每个投影字段同时校验「缺失」与「自己的固定值域」。期间（`period` / `startPeriod`）一律严格 `YYYY-MM`；凭证状态 `draft|posted`、期间状态 `open|closed`、科目分类五类、方向 `debit|credit`、资产种类 `fixed|intangible`、批次状态 / 导入模式 / 追溯状态一律固定枚举或固定集合。自由 ASCII 小写串（例如 `synthetic_sensitive_period` / `synthetic_sensitive_status`）不再被当作安全 token；未登记值即失败，不用 0 / 空值冒充。`taxpayerType` / `accountingStandard` 在库内允许自由文本，未登记值降级为受控 `unknown`（不回显原值），期间与状态不做这种降级。
>
> **必需布尔（review5）**：现金流 `reconciles` 是真实 DTO 的必需布尔。缺失或类型错（字符串 / 数字）一律失败（适配层 `model_result_invalid`、策略层 `output_policy_value_invalid`），**不得**用 `=== true` 把未知投影成 `false`；真实的 `false`（勾稽不平）是业务状态，原样保留。

| operation | 允许字段 |
|---|---|
| `finance_query:enterprise_account.account_set` | `accountSetId` `startPeriod` `taxpayerType`(small_scale/general) `accountingStandard`(small_business/enterprise) `hasDisplayName` |
| `finance_query:enterprise_account.subject_system.all` | `accountCount` `leafCount` `contraCount` `byCategory.{assets,liabilities,equity,cost,profit_loss}` |
| `finance_query:voucher.generated.list` / `...generated.summary` / `...draft.summary` | `voucherCount` `entryCount` `postedCount` `draftCount` `totalDebit` `totalCredit` `balanced` |
| `finance_query:voucher.detail` | `voucherId` `period` `status` `lineCount` `totalDebit` `totalCredit` `balanced` |
| `finance_query:report.balance_sheet` | `period` `assets` `liabilities` `equity` `balanced` `lineCount` `cash` `receivables` `inventory` `fixedAssetsNet`（后 4 项是**代码常量口径**） |
| `finance_query:report.income_statement` | `period` `currentRevenue` `currentCost` `currentExpenses` `currentProfitBeforeTax` `currentNetProfit` `ytdRevenue` `ytdNetProfit` |
| `finance_query:report.cash_flow_statement` | `period` `operating` `investing` `financing` `netIncrease` `cashBegin` `cashEnd` `cashChange` `reconciles` `lineCount` |
| `finance_query:report.trial_balance` | `period` `lineCount` `openingDebit` `openingCredit` `periodDebit` `periodCredit` `closingDebit` `closingCredit` `balanced` |
| `finance_query:period_end.summary` | `periodCount` `openPeriodCount` `closedPeriodCount` `period` `closingDebit` `closingCredit` `balanced` |
| `finance_query:ledger.general` | `period` `direction` `itemCount` `openingDebit` `openingCredit` `periodDebit` `periodCredit` `closingBalance`（**重算**，不信任最后一行） |

普通（非 `finance_query`）只读工具在同一套白名单下新增了 spec（`SUPPORTED_OPERATIONS.query` 现为 19 项，前 12 项语义不变）：

| operation | 允许字段 |
|---|---|
| `voucher_check` | `checkOk` `errorCount` `totalDebit` `totalCredit` `balanced` |
| `account_list` | 与 `subject_system.all` 相同（计数 + 枚举，不含编码/名称） |
| `opening_balance_get` | `itemCount` `totalDebit` `totalCredit` `balanced` |
| `period_list` | `periodCount` `openPeriodCount` `closedPeriodCount` |
| `ledger_query` | 与 `ledger.general` 相同（明细账只给合计与重算余额） |
| `asset_list` | `cardCount` `fixedCount` `intangibleCount` `totalOriginalCost` `totalAccumulated` `totalRemaining` |
| `book_import_batch` | `batchStatus` `batchMode` `accountSetId` `traceCount` `okTraceCount` `inconsistentTraceCount` `voucherCount` `accountSetCreated` `vouchersCreated` `vouchersDeduplicated`（批次 ID / 来源系统 / 企业身份 / 凭证号不返回） |

`finance_query:enterprise_account.bank` 等 11 项未实现能力没有 spec，**不会**得到投影：适配层直接回固定 `model_node_not_implemented`，不执行后端、不兜底投影。

### 3.2 可返回给模型的写结果状态

`applied` 三态，只有**正面业务证据**才是 `true`：

| operation | 允许字段 | `applied=true` 的证据 |
|---|---|---|
| `voucher_create` | `voucherId` `period` `status` `lineCount` `totalDebit` `totalCredit` `balanced` | `id` 为正整数且 `status ∈ {draft,posted}` |
| `voucher_post` / `voucher_unpost` | 同上 | `id` 存在且状态分别是 `posted` / `draft` |
| `voucher_delete` | `deletedVoucherId` | `deleted` 为正整数 |
| `period_set_status` | `period` `status` | `status ∈ {open,closed}` |
| `opening_balance_set` | `itemCount` | 返回 `items` 数组 |
| `account_create` | `accountCount` | 返回 `items` 数组 |
| `account_set_create` | `accountSetId` `startPeriod` | `id` 为正整数 |
| `asset_create` | `assetId` `kind` `startPeriod` `usefulLifeMonths` `originalCost` | `id` 为正整数 |
| `depreciation_run` | `voucherId` `runCount` `totalAmount` `period` | 凭证 `id` 存在；`voucher=null` 且 `runs=[]` → `applied=false`（`nothing_due`） |
| `carry_forward_profit` | `voucherId` `yearEndVoucherId` `profit` `revenue` `expense` | 任一结转凭证 `id` 存在 |
| `legacy_book_import` | `dryRun` `validationOk` `blockedByValidation` `createdAccountSetId` `createdAccountCount` `createdVoucherCount` `warningCount` | `created.id` 存在；`dryRun=true` → `applied=false`（`dry_run`） |
| `book_import_incremental` | `status` `accountSetId` `accountSetCreated` `accountsAdded` `openingBalancesApplied` `vouchersCreated` `vouchersDeduplicated` `replayed` `conflictCount` `errorCount` `validationOk` `batchStatus` `plannedAccountSetCreated` `plannedVouchers` `plannedVouchersDeduplicated` | `status="applied"` 且 `created.accountSetId` 为正整数；`status="idempotent_replay"` → `applied=false`（`idempotent_replay`，本次未写）；`status="preview"` → `applied=false`（`dry_run`） |

没有正面证据时 `applied="unknown"` 且 `needsLocalReview=true`（附 `appliedReason`），**绝不把「不知道」写成成功**。`runWrite` / 适配层在域函数抛错时返回 `ok:false, applied:"unknown", needsLocalReview:true` + 安全错误投影：既不当成功，也不断言未生效。

**写执行与写后失败**：

1. 所有**能预先确定**的校验（operation 已登记字符串、`accountSetId` 为正整数、`execute` 是函数、账套内工具缺 setId）都在执行前完成；未登记 operation / 错账套 / 缺回调时回调**从未执行**。
2. 写已发生后，证据判定与摘要 / 引用任何失败都**只能降级**，不得抛给调用方：
   - `applied` 来自**只读自有 data 属性**的证据读取（不遍历大数组、不触发 getter、不调用用户回调）；读不到就是 `unknown`；
   - 降级时 `localRef:null` 并给固定 `refUnavailable`：`value_limit` / `value_invalid` / `capacity` / `node_budget` / `byte_budget` / `summary_unavailable`；适配层额外用到 `scope_mismatch` / `unbound_scope` / `not_applied` / `not_executed` / `outcome_unknown`；
   - 降级信封里**不会**出现任何异常的 `message` / `details` / `stack`。

### 3.3 明确不返回（永远不出模型通道）

企业 / 账套名称、纳税人识别号、科目编码与名称、凭证摘要、往来单位、经办人 / 人员、逐行凭证与分录金额、明细账逐笔流水、固定资产 / 无形资产卡片名称、源文件与导出路径、批次 ID / 来源系统 / 企业身份、原始错误 `message` / `details` / `stack`、任何自由文本。

## 4. 哪些数字只能本机算

- 单个科目 / 单个凭证 / 单张明细行的金额与余额；
- 资产负债表除 4 个代码常量口径以外的行（如「预付账款」「其他应付款」）；
- 利润表未列入白名单的行（投资收益、营业外收支、所得税费用等逐项金额）；
- 现金流量表按科目分类的逐行金额；
- 明细账逐笔发生额与期末余额（`closingBalance` 之外的逐笔）；
- 任意字段求和 / 计数 / 极值、以及「哪些科目有余额」「有哪些凭证」这类**记录集合**本身。

本机算术接口（`localCompute`）只支持 `sum` / `count` / `min` / `max` + 受限路径：路径 1–8 段、最多一个 `[]` 展开、拒绝 `__proto__` / `constructor` / `prototype`；只累加有限数值（|x| ≤ 1e12），数组 ≤512、节点 ≤1024。结果是**本机数值**，不是会计结论，也不改写任何记账结果。

## 5. 引用契约

| 项 | 约定 |
|---|---|
| 形状 | `finref_` + 48 位十六进制（192 位随机，`node:crypto randomBytes`）；参数先判 `typeof === "string"` 再匹配 |
| 绑定 | 账套 `accountSetId`、操作（Agent 工具名 / nodeId）、类别（`query` / `write`） |
| 调用上下文 | 每个引用 API（含 `resolveForModel` / `revokeLocalRef`）都必须显式传 `accountSetId` 与 `operation`；缺失、跨账套、换工具分别报 `output_policy_account_set_invalid` / `output_policy_ref_cross_account` / `output_policy_ref_binding_mismatch`（缺 operation 报 `output_policy_operation_required`） |
| 到期 | 默认 15 分钟（`ttlMs` 可配）；到期后两个通道都取不到 |
| 撤销 | `revokeLocalRef(ref, { channel, accountSetId, operation })`，之后两通道都报 `output_policy_ref_unknown`；撤销立即归还节点与字节占用 |
| 容量 | 默认最多 256 个（`maxRefs` 可配）；查询满了直接失败，写满了只丢引用（`refUnavailable:"capacity"`） |
| 节点预算 | 单值 ≤200000 节点（`valueNodes` 可配）、累计 ≤1000000 节点（`nodeBudget` 可配） |
| 字节预算 | 单值 ≤4 MiB（`valueBytes` 可配）、累计 ≤64 MiB（`byteBudget` 可配）。估算口径 = **根值固定开销 8 + 每节点 8 + 字符串 UTF-8 字节 + 键名 UTF-8 字节**，是**保守估计，不是 JS 实际内存计量** |
| 存储 | **仅进程内**（`persistence: "process_memory"`）。进程重启即失效，这是设计而不是缺陷；**跨重启失效如实记录**，不做磁盘引用 |

**持久化条款（未实现）**：不做磁盘引用。若后续确有跨重启需要，必须满足：只在本机私有目录、0600、按账套分目录、独立 TTL 与撤销、绝不通过 HTTP / Agent / MCP 暴露成通用「按引用取原文」工具、不与模型参数共享目录路径。

## 6. 错误投影契约

```js
{ ok: false, outputPolicy: "finance-output-policy/v1", operation: "voucher_create",
  error: { code: "voucher_invalid", category: "voucher", retriable: false, messageKey: "voucher_invalid" },
  rawErrorIncluded: false }
```

- `code` 只取**固定 allowlist**，命中才回声登记表里的常量；否则 `operation_failed`（`category: "unknown"`）。
- 取值顺序：先取自有 `code` 字符串，再取自有 `message` 字符串，**两者都只当固定 allowlist 的查表键**。因此 `new Error("period_closed")` 这类以 message 承载域码的写法仍可识别，但**回声的只有登记表常量**。准确表述是「读取自有 `message` 的值用于查表」，**不是「完全不读取 message」**。
- 原 `message` / `details` / `stack` 的内容**绝不输出**到返回值或日志（`rawErrorIncluded:false`，返回对象里没有任何承载原文字段的键）。
- 适配层新增的固定码：`model_tool_unknown` / `model_tool_tax_excluded` / `model_tool_not_implemented` / `model_node_unknown` / `model_node_not_implemented` / `model_arguments_invalid` / `model_context_page_invalid` / `model_scope_mismatch` / `model_result_invalid`；并把 main 已有域码（`import_validation_failed` / `import_conflict` / `batch_not_found` / `posted_voucher_requires_unpost` / `status_invalid` / `opening_unbalanced` / `original_cost_invalid` 等）加入 allowlist，只回声常量。

## 7. 形状 / 超量限制

| 位置 | 限制 | 超限行为 |
|---|---|---|
| 原数据遍历（形状） | 只接受普通对象 / 数组 / 标量；**拒绝真正的循环引用、访问器属性（getter）、`Map`/`Date`/类实例**；**允许共享引用（DAG）**——同一对象出现在两个兄弟字段是合法 DTO（例如增量导入结果的 `created.sourceTrace` 与顶层 `sourceTrace`） | 查询报 `output_policy_value_invalid`；写结果降级为 `localRef:null` + `refUnavailable:"value_invalid"`，`applied` 照实报 |
| 原数据遍历（大小） | ≤200000 节点 / 单值、单值 ≤4 MiB、≤32 层、单个数组 ≤5000 | 查询报 `output_policy_value_too_large` / `..._capacity_exceeded`；写结果降级为 `localRef:null` + `refUnavailable:"value_limit"` / `"byte_budget"`，`applied` 照实报 |
| 检查顺序 | **先做形状 + 节点/字节检查，再看摘要**；摘要只经 `Object.getOwnPropertyDescriptor` 读自有 data 属性 | 访问器属性不会在摘要阶段被触发；形状非法时写通道直接跳过摘要 |
| projection | ≤96 节点、≤3 层、数组 ≤32、字符串 ≤40 且必须是 token / 期间 / **已登记固定代码常量的精确字面量**（§14.7） | 非法值丢弃并计入 `projectionDropped` |
| 本机算术 | ≤8 段路径、1 个 `[]`、≤512 数组、≤1024 节点 | `output_policy_path_invalid` / `output_policy_value_too_large` |

**恶意对象边界（不夸大）**：JS 反射无法完全避免触发 Proxy 陷阱（`ownKeys` / `getOwnPropertyDescriptor` 本身就是陷阱），所以**不声称**“零陷阱执行”。承诺的边界是：不触发访问器 getter、不顺着原型链取值、失败即安全拒绝、字节/节点/深度上限防止大批量持有撑爆内存。

## 8. 最小 API

```js
import { FinanceOutputPolicy, safeErrorProjection, sanitizeProjection,
         measureRawValue, inspectRawValue, summarizeQueryResult, summarizeWriteResult,
         SUPPORTED_OPERATIONS, MODEL_OUTPUT_CONTRACT, ENUM_TOKENS, enumTokenOf,
         OUTPUT_POLICY_VERSION, REF_PERSISTENCE, REF_PATTERN, OutputPolicyError } from "./finance-output-policy.mjs";

const policy = new FinanceOutputPolicy({ ttlMs, maxRefs, valueNodes, nodeBudget, valueBytes, byteBudget, now });

policy.wrapQuery(operation, { accountSetId, value });      // 查询结果 → 模型信封（含 localRef）
policy.wrapWrite(operation, { accountSetId, value });      // 已执行的写结果 → 模型信封 + applied 三态
policy.runWrite(operation, { accountSetId, execute });     // 仅限**同步**回调；async 写必须走适配层
policy.resolveForModel(ref, { accountSetId, operation });  // 模型解引用：只回同一份摘要
policy.issueChannel(label);                                  // 本机签发能力对象（进程内）
policy.releaseChannel(channel);
policy.localRead(ref, { channel, accountSetId, operation });
policy.localCompute(ref, { channel, accountSetId, operation, op, path });
policy.revokeLocalRef(ref, { channel, accountSetId, operation });
policy.toSafeError(error, { operation });
policy.stats();   // { refs, channels, maxRefs, ttlMs, nodes, nodeBudget, bytes, byteBudget, persistence }
policy.dispose();
```

新增出口：

- `summarizeQueryResult(operation, value)` / `summarizeWriteResult(operation, value)`：**无引用摘要**，只回白名单 projection（写结果另含 `applied` / `needsLocalReview` / `appliedReason`）。用于没有可信账套绑定的场景（全局上下文、批次未绑定、create 未建账）；不创建引用、不回原文。
- `ENUM_TOKENS` / `enumTokenOf(name, raw)`：受控枚举词表出口（taxpayer / standard / category / direction / status / mode / batchStatus），未登记值返回 `undefined`，不回显原值。
- `SUPPORTED_OPERATIONS` 现为 query 19 / write 13；`MODEL_OUTPUT_CONTRACT` 仍是给入口层与评审看的机读边界声明。

**`runWrite` 只接受同步回调**：`callAgentTool` 是 async，禁止 `policy.runWrite(() => callAgentTool(...))`（回调返回 Promise，写还没发生就被当成功包装）。异步写统一走适配层（§10）。

## 9. 接线建议清单（后续集成任务，本包不做）

> 本节的 1–8 项已由 **§15** 的接线窗口实现；下方保留为当时的建议清单，实际实现契约以 §15 为准。

**共享入口归属（当前事实）**：`agent-tools.mjs` / `server.mjs` / MCP 注册与传输 / `scripts/test-all.mjs` / `package.json` / `public/*` / 共享索引文档归 **LOCAL-02（Issue #47）**，其共享所有权尚未释放；本轮**未改**其中任何文件。LOCAL-01（#43）已合并。

1. **`06-workbench/server/agent-tools.mjs`**：`finance_query` 改为 `adapter.callModelTool(...)` 或至少 `policy.wrapQuery(...)`，未实现 node 保持自己的 `not_implemented`；operation 必须是**代码里的字符串常量**（适配层已保证）。
2. **写动作**：异步写必须用 `createFinanceModelAdapter({ executeRaw: callAgentTool })`，**不要**用 `policy.runWrite` 包 async 回调；不要改 `accounting.mjs` 的写入顺序、事务或返回结构。
3. **`server.mjs` 错误分支**：`catch` 里改用安全投影（`policy.toSafeError` / 适配层信封的 `error`），现在会原样返回 `e.message` / `e.details`（带账套名 / 科目编码）。
4. **本机读取入口**：新增本机回环接口（或本机 UI 进程内调用）时，`channel` 必须由该进程启动时 `issueChannel` 得到并只留在内存，不接受请求体里的 `channel` / `local` 字段；接口仅绑定 loopback 且校验 Origin；每次调用都要从请求体拿 `accountSetId` 与 `operation` 做绑定校验。
5. **MCP / CLI**：**不要**新增 `localRead` / `localCompute` 的 MCP 工具或命令行参数。MCP 只消费模型通道信封，并且必须先用 `finance-model-transport.mjs` 校验；需要原文时由本机 UI 处理。
6. **`06-workbench/scripts/test-all.mjs`（共享）**：追加
   `node test/finance-output-policy.test.mjs && node test/finance-model-adapter.test.mjs`，
   以及 `node 05-reconstruction/codex/mcp/finance-mcp/finance-model-transport-test.mjs`。
7. **全局工具（`account_context` / `finance_context_resolve`）**：已有适配层实现（§10），接线时直接复用，不要另造默认账套或把全局原文塞进单账套引用。
8. **回归**：接线后必须补「真实 HTTP → Agent → 模型信封不含敏感原文 + 本机通道可取原文」与「写动作错误不再泄漏 message」的集成测试；本包的适配层测试**不能**代替它。

## 10. 适配层契约（已实现，未挂载）

文件：`06-workbench/server/finance-model-adapter.mjs`（不 import `agent-tools.mjs`，避免循环；不复制业务计算 / DB 访问 / 输入业务校验 / 事务）。

```js
import { createFinanceModelAdapter, callModelTool, PLAIN_MODEL_TOOLS,
         FINANCE_QUERY_AVAILABLE, FINANCE_QUERY_UNIMPLEMENTED, MODEL_TOOL_INVENTORY,
         UNIMPLEMENTED_MODEL_TOOLS, TAX_TOOL_PREFIX } from "./finance-model-adapter.mjs";

const adapter = createFinanceModelAdapter({
  executeRaw: (name, args) => callAgentTool(name, args), // 生产由接线方注入
  policy: new FinanceOutputPolicy(),                     // 可省；需复用本机 channel 时显式传
});
const envelope = await adapter.callModelTool("finance_query", { accountSetId: 5, nodeId: "report.balance_sheet", period: "2026-01" });
adapter.policy.localRead(envelope.localRef, { channel, accountSetId: 5, operation: envelope.operation });
```

- 普通工具清单（`PLAIN_MODEL_TOOLS`）分 6 类：
  - `static`：`finance_query_catalog`（固定静态安全目录，来自代码常量）、`update_plan`（**只**把入参计划转成状态 / 计数，不回显文本、不落库、不执行工具）；
  - `context`：`account_context` / `finance_context_resolve`（见下）；
  - `node_query`：`finance_query`（operation 由已登记 nodeId 决定）；
  - `query`：`voucher_check` / `account_list` / `opening_balance_get` / `period_list` / `ledger_query` / `asset_list`；
  - `batch_query`：`book_import_batch`；
  - `write`：`voucher_create` / `voucher_post` / `voucher_unpost` / `voucher_delete` / `period_set_status` / `opening_balance_set` / `account_create` / `asset_create` / `depreciation_run` / `carry_forward_profit`；
  - `create`：`account_set_create` / `legacy_book_import` / `book_import_incremental`。
- `UNIMPLEMENTED_MODEL_TOOLS`（`declaration_query` / `exec` / `finance_task_status` / `invoice_*`）**不执行**，回固定 `model_tool_not_implemented`；`tax_*` 一律回 `model_tool_tax_excluded`（前缀只用于精确拒绝，**不是**放行规则）；其它未知工具回 `model_tool_unknown`。均不调用 `executeRaw`。
- **未知 / 未实现 node 不执行**：`model_node_unknown` / `model_node_not_implemented`。
- **真实返回形状**：`finance_query` 必须回 `{ nodeId, label, data }`；适配层只把 `data` 交给 spec，并先做**每个 node 的必需字段形状检查**（例如利润表必须含 `current` / `ytd` 的全部摘要字段，资产表必须含 `assets` / `liabilities` / `totals` 数值），否则回 `model_result_invalid`——绝不让 wrapper 或变形 DTO 投影成「全 0 报表」。
- **数据层归属核对（review3）**：wrapper（`{nodeId,label,data}`）**没有**账套字段，只核对 wrapper 会漏掉「请求 A 却拿到 B 的 data」。适配层按具体 node 的已知可信字段核对：账套节点 `data.id`、凭证节点 `data.account_set_id`、凭证列表 / 科目体系逐行 `account_set_id`；普通只读工具中带 `account_set_id` 的行（`account_list` / `asset_list`）同样核对。任一可信字段与请求账套不一致 → `model_scope_mismatch`，**不创建引用**；字段存在但类型不对 → `model_result_invalid`。报表 / 试算 / 明细账 / 期末等聚合 DTO 没有账套字段，**不臆造必需字段**（否则会误拒全部合法聚合节点）。
- **全局上下文（合法全局操作）**：无 `accountSetId` 时 `scope:"global"`，只给 `accountSetCount` / `returnedCount` / `pageOffset` / `pageLimit` / `truncated` / `hasNextPage` / `nextOffset` / `accountSetIds[]` / `startPeriods[]` / `taxpayerTypes[]` / `accountingStandards[]` / `displayNameFlags[]` / `selectionRequirement` / `persisted:false`；**不伪造 `setId=0/1`**，也**不建引用**（`localRef:null`、`refUnavailable:"global_scope"`）。默认每页 10、上限 32；超页大小 / 负 offset 在**执行前**回 `model_context_page_invalid`。指定账套时做真实归属校验（不在列表里回 `account_set_not_found`），并只给该账套的期间计数等摘要。
- **上下文必需字段与可表示 ID（review5）**：global 账套列表与 scoped 账套摘要都要求每行 `id` 为正安全整数、`start_period` 为**合法 `YYYY-MM`**；非法 / 缺失一律 `model_result_invalid`，不再「可选 `periodOf`」后静默省略。账套选择信息（`accountSetIds[]` / scoped `accountSetId`）必须能进入 projection：projection 的有限数值上限是 **1e12**，超过上限的 ID 无法表示 → **明确拒绝**（`model_result_invalid`），绝不静默删成 `accountSetIds:[]`（那样 `returnedCount>0` 却无法选择）。`finance_query:enterprise_account.account_set` 的 `data.id` 同属选择信息，按同一上限校验。两分支的 `projectionDropped` 都使用 `sanitizeProjection` 的**真实丢弃计数**，不再固定 0。**未扩大为全部 DTO 重写**：凭证 / 资产等内部流水 ID 仍按既有 spec 处理。
- **create 类写动作的 setId 只能来自真实结果**：`account_set_create` 取结果 `id`；`legacy_book_import` 取 `created.id`；`book_import_incremental` 取 `created.accountSetId` / 顶层 `accountSetId` / `batch.accountSetId`（按序，全部校验正安全整数）。没有可信 ID（dry-run / 校验失败 / 未建账）时回**未绑定摘要**：`accountSetId:null`、`localRef:null`、`refUnavailable:"not_applied"|"unbound_scope"`，绝不造假 ID。成功绑定时信封明确 `operationCategory:"create"`、`scope:"result"`、`accountSetIdSource:"result"`。
- **`book_import_batch`**：账套只由真实结果 `batch.accountSetId` 决定；入参 `accountSetId` 仅用于核对，不匹配回 `model_scope_mismatch`（绝不替换结果所属账套）。批次 ID / 来源系统 / 企业身份 / 凭证号不出投影。
- **普通写动作**：`accountSetId` 在执行前校验；若结果回显的 `account_set_id` 与入参不一致，保留真实 `applied` 但不绑定引用（`refUnavailable:"scope_mismatch"`）。
- **参数快照（防异步串账）**：`callModelTool` 在任何 `await` 前先把调用参数深拷贝为**只含自有 data 属性**的稳定快照（拒绝访问器 / 非普通原型 / 循环 / 超深超量；`accountSetId` 与 `account_set_id` 冲突直接拒绝），预验与 `executeRaw` 使用同一份规范化账套值；嵌套 `payload` / `entries` 也保持调用瞬间的值。查询结果回显的账套与预验不一致时回 `model_scope_mismatch` 且**不建引用**。
- **async 写**：先预验 → `await executeRaw` **一次** → 再包装。写失败分两相：执行前拒绝 = `applied:false` + `appliedReason:"rejected_before_execution"`；执行后异常 = `applied:"unknown"` + `appliedReason:"unverified_result"`。两者只要不是 `applied:true` 都标 `needsLocalReview:true`；**不重复写**。
- 信封附加字段：`adapter`（版本）、`tool`、`scope`、`nodeId`、`accountSetIdSource`（`argument` / `result`）、`operationCategory`。全部是代码常量或已校验值。

## 11. 出站信封校验（transport，已实现，未挂载）

文件：`05-reconstruction/codex/mcp/finance-mcp/finance-model-transport.mjs`。纯函数，**不打开业务 DB、不发网络请求、不 import 服务端模块**，供后续 MCP `backend.mjs` / `server.mjs` 使用。

```js
import { validateModelEnvelope, parseModelEnvelope, transportFailure,
         classifyTransportFailure, createModelEnvelopeValidator, TRANSPORT_FAILURES } from "./finance-model-transport.mjs";

const checked = validateModelEnvelope(data, { operations, tools, nodeIds });
// → { ok:true, envelope } | { ok:false, failure:{ error:{ code, retriable:false, messageKey }, outcome, ... } }
const parsed = parseModelEnvelope(responseText, registries); // 非 JSON / 非对象 → 固定错误码
const failure = transportFailure("backend_timeout", { forWrite: true }); // retriable:false + writeOutcome:"unknown"
```

- 严格字段白名单：未知字段回 `envelope_unexpected_field`；`message` / `details` / `stack` / `path` / `raw` / `apiBase` / 企业名等敏感键回 `envelope_sensitive_field`；两者都**不回显字段名或值**。
- **每个允许键在所有适用分支都完整校验**：成功查询信封不接受 `appliedReason`、`error`、`catalog`、`accountSetIdSource` 等不适用字段；失败信封如带 `projection` / `appliedReason` / 目录也按同一规则校验；非写失败不接受引用字段；不适用字段直接拒绝，而不是“键名在白名单就放行”。**`projection` / `projectionDropped` 各自独立校验**：`projectionDropped` 只要是出现的键就验「非负整数 ≤ 1e6」，且必须有 `projection` 伴随（悬空计数直接拒绝）；`projection` 存在时 `projectionDropped` 必须同时存在（受控截断契约）。`accountSetIdSource` 与分支语义绑定：`argument` 只用于 `write`，`result` 只用于 `create` / `batch`。
- **纯数据快照（review3 / review4）**：校验通过后**只返回重建的普通对象 / 数组副本**，绝不返回原对象。所有层级（信封顶层 / `error` / `catalog` / `projection` 嵌套与数组）拒绝访问器属性、Symbol 键、非普通原型、函数 / BigInt；因此合法 query 信封把可选 `tool` 换成 enumerable getter 时，旧实现“视为缺省后返回原对象、JSON.stringify 触发 getter”的泄漏路径已关闭：getter 一次都不会执行，且结果是固定拒绝码或纯数据副本。
- **校验对象 = 返回对象（review4）**：`validateEnvelope` 先用 `plainSnapshot` 生成**有界纯数据快照**，再对**这份即将返回的同一快照**重新完整校验并只返回它（第一遍在原对象上的校验仅用于沿用既有固定错误码，不决定返回值）。因此原对象在多次反射读取之间变化（例如 `getOwnPropertyDescriptor` 先返回合法值、之后返回普通对象）只会让快照校验失败被拒，**不会出现「校验 A、返回 B」**；返回的每个字段都是校验过的值。
- 契约校验：`outputPolicy === "finance-output-policy/v1"`、`adapter === "finance-model-adapter/v1"`、`channel === "model"`、`rawValuesIncluded === false`、`ok` 布尔；成功信封必须有 `projection` 与 `localRef`。
- `operation` / `tool` / `nodeId` / `operationCategory` / `scope` / `appliedReason` / 错误码 / 目录都使用**模块内置固定登记语义**；调用方另传登记表只能进一步收紧，**不传也不会退化成“只校验形状”**。operation 与 category/scope/tool/nodeId 必须互相一致；错误码必须命中固定 code → category 映射（含 `nodeId_required` / `voucherId_required` 等真实大驼峰码），任意码被拒绝。
- `projection` 再校验一次形状（数值上限 / **固定受控 token 或期间** / 数组 / 深度 / 节点；任意 ASCII 业务串不能伪装成状态），嵌套敏感键同样拒绝；`localRef` 必为 `finref_` 形状，`refPersistence` 仅 `process_memory` / `none`，`refExpiresAt` 必须是带引用的 ISO 时间，引用与降级原因互斥。
- 写信封：`applied` 三态必须显式，`applied !== true` 时 `needsLocalReview` 必须为 `true` 并带固定 `appliedReason`；`applied:true` 不接受 `appliedReason`。
- 运输失败：`TRANSPORT_FAILURES` 固定常量（不可达 / 超时 / 非 JSON / 非 2xx / 非对象 / 各类信封错误）。**通用连接错误（如 unreachable）不能证明未发送，写场景按 `outcome:"unknown"` + `writeOutcome:"unknown"` + `retryBlockedBy:"write_outcome_unknown"` 保守处理**；只有可证发前失败（`backend_not_configured`）才是 `outcome/writeOutcome:"not_sent"`。写场景一律 `retriable:false`；只有只读的不可达 / 超时才是 `retriable:true`。
- `parseModelEnvelope` / `validateModelEnvelope` 对 getter、Proxy `ownKeys` / `getPrototypeOf` 等反射异常一律转换固定失败码，不抛出原始 message。
- 校验器**不会总是拒绝**：真实适配层产出的查询 / 写 / 静态 / 全局上下文信封都能通过（已测）。

## 12. 未实现 / 未接线（明示）

> **接线窗口更新（2026-10-22）**：下列“未接线 / 当前真实模型入口仍原样返回原文”已被 **§15** 取代——普通工具的 Agent / HTTP / MCP 入口与本机引用接口已实际接线并通过真实链路测试；本节保留为接线前的阶段快照，不改写历史。仍未做的部分（`scripts/test-all.mjs` 登记、范围外旧测试迁移、引用持久化、审计 / 批量）见 §15.7。

- 纯策略模块：已合并（PR #50 / merge `b42bae9` / 已审 head `f211ace`）；review5 后为 **34/34、exit 0**，LOCAL-02 兼容整合后补新工具 spec 为 **35/35、exit 0**（既有 34 项含义保留）。
- 适配层：**已实现 + 临时库真实调用验收 20/20、exit 0**（含 review5 与 LOCAL-02 `period_end_check` / `asset_update` 回归）；`06-workbench/server/agent-tools.mjs` 等共享入口**未接线**。
- transport：**已实现 + 独立测试 17/17、exit 0**（含 review5 与 LOCAL-02 新工具 / 新错误码回归）；MCP `backend.mjs` / `server.mjs` **未接线**，**不是** stdio 挂载验收。
- 因此：**当前真实模型入口仍原样返回原文**，本契约尚未在真实入口生效；Issue #44 保持 OPEN。
- 未做：磁盘持久化引用、多用户 / 权限体系、按用户隔离、审计落库、批量写队列、`localRead` 的 MCP / CLI 工具。
- 未验收：真实 HTTP / Agent / MCP / CLI 端到端；真实账套（禁止）；跨重启（设计上失效）。
- **LOCAL-02 名下的新期末 / 资产补项工具不在本包实现范围**：其入口名与 DTO 尚未稳定，适配层不为它们写占位 spec，也不据草稿伪造实现；待 LOCAL-02 合并后由 root 更新基线再补（见 §13）。

## 13. LOCAL-02 新期末 / 资产补项工具的兼容补齐（已实现，未挂共享入口）

LOCAL-02 的 `period_end_check` / `asset_update` 已在**现有可测试适配层 / transport 合约内**按真实 DTO 补齐，不依赖尚未移交的 HTTP / Agent / MCP 入口：

- `period_end_check` 登记为**只读 query**（`scope: account_set`）：模型的 DTO 形状按真实 `buildPeriodEndCheck` 校验——**7 个已登记步骤唯一齐全**（该工具不传 `skip`，没有“合法子集”或 `skipped` 状态）、状态只有 `ok` / `blocked` / `not_applicable`、每条顶层 `blocking` 都带产生它的 `step`、`ready` ⇔ 没有 blocked 步骤且没有阻塞项。缺步骤 / 重复步骤 / `ready:true` + 空步骤或全 blocked / blocked 步骤没有阻塞 / 阻塞归属到未阻塞或未知步骤，一律 `model_result_invalid` 且**不建引用**（条目数不等于步骤数：一个步骤可以有多条真实原因，多个步骤也可共用同一个码）。模型投影只含期间、`ready`、步骤状态计数、blocked 步骤 id、阻塞计数与固定阻塞码。标题 / 原因 / `message` / `details` / 资产名 / 科目名 / 备注等任意用户文本不进入投影（未知步骤 / 状态 / 阻塞码 fail closed）。
- `asset_update` 登记为**写动作**（`category: write`、`scope: account_set`、`accountSetIdSource: argument`）：只有显式写调用才执行，未知 / 只读工具不会因名称相似被当成写；成功必须真实结果含卡片 `id` 才给 `applied:true`，失败保留 `applied:"unknown"` / `needsLocalReview:true`，不伪造成功。
- `asset_update` 投影按业务所需最小白名单：`assetId` / `kind` / `startPeriod` / `acquiredPeriod` / `originalCost` / `usefulLifeMonths` / `openingAccumulated` / `accumulated` / `remaining` / `ledgerStatus` / `origin`；**不投影**名称、`ledger_note`、科目编码 / 账户、备注等自由文本。
- 新期间 / 资产校验错误与 `period_end_check_failed` 在 policy 与 transport 两层都有固定 code → category 映射（如 `acquired_period_invalid → asset`、`asset_card_affects_closed_period → asset`、`period_end_check_failed → period_end`、`profit_not_carried_forward → period_end`、`depreciation_run_stale → depreciation`），不再落到 `unknown` 掩盖可指导动作的错误；错误仍只回声已登记 code，不带 `message` / `details` / `stack`。
- 原有边界未放宽：错误清洗、参数快照、引用绑定 / 过期 / 跨账套失效、4 MiB / 64 MiB / 节点预算、写后降级与并发隔离均保持原语义。
- **仍未做**：把适配器接到 `agent-tools.mjs` / `server.mjs` / MCP `backend.mjs` / `server.mjs` / CLI；`scripts/test-all.mjs` 登记仍归 LOCAL-02 共享入口协调；真实 HTTP / MCP 端到端与真实账套未验收。
  - **接线窗口更新**：前两项已在 **§15** 完成（真实 HTTP / MCP 端到端已验收）；`scripts/test-all.mjs` 本包仍**未登记**（§15.7），真实账套仍禁止。

## 14. 验证记录（本阶段实际发生）

| 套件 | 命令（仓库相对） | 结果 |
|---|---|---|
| 策略模块 | `cd 06-workbench && node test/finance-output-policy.test.mjs` | 37/37 passed，exit 0（输出协议回修后本轮实跑；原 35 项含义保留） |
| 适配层（真实临时库） | `cd 06-workbench && node test/finance-model-adapter.test.mjs` | 21/21 passed，exit 0（输出协议回修后本轮实跑；原 20 项含义保留） |
| 出站信封校验 | `node 05-reconstruction/codex/mcp/finance-mcp/finance-model-transport-test.mjs` | 18/18 passed，exit 0（输出协议回修后本轮实跑；原 17 项含义保留） |
| 领域回归 | `cd 06-workbench && node test/accounting-guards.test.mjs` | 23/23 通过，exit 0（上一轮记录，review5 未重跑） |
| 领域回归 | `cd 06-workbench && node test/accounting-derived.test.mjs` | 31/31 通过，exit 0（上一轮记录，review5 未重跑） |
| 领域回归 | `cd 06-workbench && node test/import-incremental.test.mjs` | 49/49 通过，exit 0（上一轮记录，review5 未重跑） |
| HTTP / Agent 回归 | `cd 06-workbench && node test/smoke.test.mjs` | 28/28 通过，exit 0（上一轮记录，review5 未重跑） |

未运行：完整 `scripts/test-all.mjs`（新套件**未登记**进该共享入口，属 LOCAL-02 文件；无意义多跑）。未验证：真实 HTTP / MCP 端到端、真实账套、跨重启。

适配层测试的隔离方式：**先**建全新临时 `WORKBENCH_DATA_DIR`，**再**动态 import 真实 `accounting.mjs` / `agent-tools.mjs`，注入真实 `callAgentTool` 实际执行（两企业以上、多账套、合成敏感标记覆盖企业名 / 科目名 / 摘要 / 往来 / 人员 / 资产名 / 源路径 / 企业身份 / 批次 ID / 来源系统）；主要写动作真实落库、手工常量核对金额、断言只执行一次；所有模型返回 / 转换错误 / 测试捕获日志均不含合成标记。

### 14.1 独立审查 review1 五项修复（历史记录）

| 项 | 问题 | 修复 / 回归 |
|---|---|---|
| F1 | transport 即使拿到完整登记表，仍允许 adapter / appliedReason / error.message 等任意原文穿过 | 每个允许键在所有分支完整校验；adapter 版本、operation / tool / nodeId / category / scope / appliedReason / 错误码 / 目录内置固定语义；projection 字符串只允许固定 token 或期间；getter / Proxy 异常固定失败；普通 JSON 负例全覆盖 |
| F2 | 预验 A、异步 executeRaw 读被调用方改成 B，查询引用可读到 B 的 raw | 在任何 await 前深拷贝自有 data 属性快照（拒绝访问器 / 原型 / 别名冲突 / 超量），预验与执行共用同一规范化 `accountSetId`；嵌套 payload 同样固定；查询结果回显账套不匹配不建引用；真实 A/B 两库行与 ref 所属已断言 |
| F3 | 真实利润表删除 `data.ytd["营业收入"]` 后仍成功且 `ytdRevenue:0` | 全部 query 摘要的必需字段/类型严格校验；缺字段明确 `model_result_invalid`，真 0 保留；真实结果删 ytd / trial totals 字段回归 |
| F4 | 真实 `account_set_create({})` / 无效增量导入的 `create` + `result` 与 `nodeId_required` / `voucherId_required` 被 transport 误拒 | 两层统一 operationCategory（含 create / node_query / batch_query / unimplemented）、scope（含 result）、固定错误码映射与大驼峰真实码；legacy dry-run applied:false / needsLocalReview:true 保留正例 |
| F5 | `classifyTransportFailure('unreachable', {forWrite:true})` 同时给出 `outcome:not_sent` 与 `writeOutcome:unknown` | 通用连接错误无法证明未发送，写场景保守 `outcome/writeOutcome:unknown`；仅 `backend_not_configured` 为可证发前 `not_sent`；合成回环服务验证请求发出后断连按 unknown 处理 |

（历史记录）本项修复当时尚未提交 / 未推送 / 未独审；现况见文首状态段与 §14.5。

### 14.2 第三轮定向返工 review3（历史记录）

| 项 | 复核发现 | 修复 / 回归 |
|---|---|---|
| F1 | transport 仅在 `projection` 存在时才验 `projectionDropped`；真实失败写信封删 `projection`、把 `projectionDropped` 换成对象后仍 `ok:true` 返回原文；合法 query 信封的可选 `tool` 换成 enumerable getter 被视为缺省并返回原对象，`JSON.stringify` 触发 getter 泄漏 | `projectionDropped` 出现的任何分支都独立校验类型 / 非负整数上限，悬空计数与缺失伴随字段都拒绝（保留受控截断计数）；校验通过后**只返回重建的纯数据副本**，所有层级访问器 / Symbol / 非普通原型 / `toJSON` 一律拒绝；普通 JSON 与对象 getter 两路，并按 success / failure / dropped 分支做可选键矩阵 |
| F2 | 摘要必需字段从 `periodOf` / 状态枚举退化为 `requireText`，sanitizer 接受小写 token：`data.period='synthetic_sensitive_period'` 与 `voucher.detail.status` 任意业务 token 均原文泄漏 | 新增 `requirePeriod` / `requireEnumToken` / `requireChoice`；每个投影字段同时校验缺失与自己的固定值域（`YYYY-MM`、固定枚举 / 集合），逐点审 `requireText` 调用；真实适配器注入 ASCII 标记 / 非法月份 / 缺字段 / 真零正例回归 |
| F3 | scope 核对只看 wrapper；`finance_query` 请求 A 实际返回 B 的 `data` 时 wrapper 无 id 漏过，得到 A 绑定引用 + B 数据 | 按 node 核对可信 data 字段（账套 `data.id`、凭证 `data.account_set_id`、列表逐行）；不一致固定 `model_scope_mismatch` 且不建引用；聚合节点不臆造必需字段；真实 `callAgentTool` A/B 两库注入覆盖 |

三层测试：策略 **32/32**、适配层 **17/17**、transport **14/14**（review3 时点），均 exit 0（本轮实际输出）。**（历史）**当时未提交 / 未推送 / 未独审；后续已由 review4 / review5 与最终独审覆盖，现况见文首状态段与 §14.5。共享入口接线（LOCAL-02）、`scripts/test-all.mjs` 登记与 LOCAL-02 新工具补项**仍未完成**。

### 14.3 第四轮定向修正 review4：最后副本一致性（历史记录）

| 项 | 复核发现 | 修复 / 回归 |
|---|---|---|
| F1 | 最终副本顺序不一致：`validateEnvelope` 先 `validateEnvelopeInner(original)`，成功后再对 `original` 做 `plainSnapshot`，**返回的副本本身没有校验**。合成复现：合法 query 对象让 `adapter` 的 `getOwnPropertyDescriptor` 前几次返回合法版本串、之后返回普通对象，结果仍 `ok:true` 且返回了不符合固定类型的 `adapter` | 新增第二遍：先生成**有界纯数据快照**，再对**同一快照**完整校验并只返回该快照（第一遍原对象校验只保留既有固定错误码，不决定返回值）。getter 仍不执行、非普通原型 / Symbol / `toJSON` / 函数 / 深度与大小上限全部保留。回归：`adapter`、嵌套 `projection.assets` 的描述符中途换值都被拒或只返回校验过的值；始终合法的可变输入返回对象再次完整校验仍通过且等于返回值；普通 plain JSON 正例不受影响 |

本项三层实际输出：策略 **32/32**、适配层 **17/17**、transport **15/15**（14 → 15，新增 1 项可变反射一致性回归），均 exit 0。已用旧顺序实跑确认新回归会**变红**（`14/15`、exit 1），恢复修正后 `15/15`、exit 0。**（历史）**当时未提交 / 未推送 / 未独审；该一致性复核现仍通过，并已纳入已审 head `ba5d601`。共享入口接线（LOCAL-02 #47）与 LOCAL-02 新期末 / 资产补项工具仍**未完成**。

### 14.4 第五轮定向返工 review5（历史记录，最终独审前最后一次定向修复）

| 项 | 复核发现 | 修复 / 回归 |
|---|---|---|
| P2-1 scoped 上下文期间 | `account_context({accountSetId:1})` 的真实结果 `start_period:'2026-13'` 只经「可选 `periodOf`」处理，反而 `ok:true`、`startPeriod` 被省略、`projectionDropped:0`，与 global 分支「非法必需月份拒绝」不一致 | scoped 摘要改用 `requirePeriod`（必需且严格 `YYYY-MM`），非法 / 缺失一律 `model_result_invalid`；账套 `id` 同时按可表示范围校验。回归：真实注入 `2026-13` / 缺字段均失败且不回显原值；合法 `2026-12` 仍成功且 `startPeriod` 保留 |
| P2-2 全局上下文 ID | 唯一合法正安全整数 `id=1000000000001`（>1e12）通过 ID 校验后被投影消毒器当超界数值删除，得到 `accountSetIds:[]`、`returnedCount:1`、`truncated:false`、`projectionDropped:0`：既无法选择又无提示 | 新增可表示 ID 边界（= projection 数值上限 1e12）：global 列表 ID / scoped 账套 ID / `enterprise_account.account_set` 的 `data.id` 超界即 `model_result_invalid`，不静默删除；global / scoped 的 `projectionDropped` 改为 `sanitizeProjection` 真实计数，不再固定 0。合法边界 `999999999999` / `1e12` 仍成功且能通过 transport；transport 新增 boundary 回归（上限内接受、超界 `envelope_projection_invalid`） |
| P2-3 现金流 `reconciles` | 完整合法零值现金流 DTO 删掉 `reconciles` 后仍成功，`projection.reconciles=false` 并生成引用：把未知勾稽状态伪造成 `false` | 策略 spec 改为 `requireBoolean(statement,"reconciles")`，适配层形状检查同时要求布尔；缺失 / 字符串 / 数字均 `model_result_invalid` 且不建引用，真正 `false` 之业务状态原样保留。策略层新增缺失 / 类型错失败与真 `false` 正例回归 |

三层本轮实际输出：策略 **34/34**（32 → 34：新增现金流布尔回归 + 数值上限边界）、适配层 **19/19**（17 → 19：新增上下文期间 / ID 回归 + 现金流布尔回归）、transport **16/16**（15 → 16：新增 ID 可表示性边界），均 exit 0（实际输出）。已验行为未回退：旧 32 / 17 / 15 项断言含义未削弱。本轮**未重跑**四套领域回归（与 review5 根因无直接关系，不声称重跑）。**（历史）**当时未提交 / 未推送 / 未独审；此后原 3 项 P2 已由最终独审确认关闭（§14.5）。共享入口接线（LOCAL-02 #47）、`scripts/test-all.mjs` 登记、LOCAL-02 新期末 / 资产补项工具仍**未完成**。

### 14.5 当前验收状态（管理者实跑 + 最终独审）

| 项 | 证据 |
|---|---|
| 已审源码 head | `ba5d60115e52fa13805841d9abe07006b74b2c9c` |
| 管理者实跑 | 策略 **35/35**、适配层 **20/20**、transport **17/17**，均 exit 0（LOCAL-02 兼容整合后） |
| 最终独审 | `review_output08_final` 未参与实现；原 3 项 P2 全部关闭；独立探针 **57/57** 通过（**57 为独审探针项数，不等于三套测试用例总数**）。LOCAL-02 兼容增量仍需 root 最终增量独审 / PR 复核 |
| 合入 main 后复核 | 从 main `98977e04bd24aa293074021802191814f8c2a1d2` 合入形成 head `e8b298e42224e2e1b884f7827e4c366881d22fc9`；该次合入仅添加 PR #55 的六个 backup 文件，本包 9 路径与已审 head 逐文件不变 |
| PR | [#57](https://github.com/huxiaoyang-code/youshu-fork/pull/57) **OPEN 并 attach**；尚无 merge SHA，不预报已合并 |

仍未包含：共享 HTTP / Agent / MCP / CLI 接线、`scripts/test-all.mjs` 登记、真实 HTTP 端到端与真实账套验收。

### 14.6 LOCAL-02 兼容增量（本轮新增，未挂共享入口）

- 新增策略 spec：`period_end_check` 只读、`asset_update` 写；`SUPPORTED_OPERATIONS.query/write` 只追加，不改变已登记 operation 的投影语义。
- 适配层：`PLAIN_MODEL_TOOLS` 登记 `period_end_check → query/account_set`、`asset_update → write/account_set`；`MODEL_TOOL_INVENTORY` 自动纳入，未知工具仍默认拒绝且不执行。
- transport：固定登记表追加 `period_end_check`（query）与 `asset_update`（write），并补齐新领域错误码与期末检查固定 token / 阻塞码；校验器仍只接受已登记 code，未知值拒绝。
- 定向验收（实际输出）：策略 **35/35**、适配层 **20/20**、transport **17/17**，均 exit 0。适配层用真实临时库完成资产 `1200` 原值、`2026-02` 取得 / 起提、借贷平衡购入凭证与真实计提，并保留**真实封账成功**与 `period_end_check_failed` **前置拒绝**两条路。
- 完整 `npm test`（设 `REPORT_OFFICE_PYTHON`）：**55/55 套 exit 0**；Office **21/21**、真实 **11 PDF** 几何通过（外部 poppler + pdfplumber）。日志在本 worktree 忽略目录 `.agent-runs/`。
- 未做 / 待 root：真实共享入口接线、真实 HTTP / MCP 端到端、`scripts/test-all.mjs` 登记确认；本轮只证明现有可测试边界与真实 DTO 兼容。

### 14.7 输出协议独立审查 2 项 P2 回修（本轮，待 root 复审）
独立审查在该 head（`04c38d4`）上复现两个 P2，均已修复并补先红后绿的定向回归；**此前 55/55 绿测试不能代表这两项已通过**。

| 项 | 复核发现 | 修复 / 回归 |
|---|---|---|
| P2-1 长阻塞码被通用预算吞掉 | 真实域码 `depreciation_life_expired_underprovided`（39 字符）与 `previous_period_depreciation_pending`（36 字符）虽在阻塞码白名单里，却仍被通用 `PROJ_TOKEN_RE`（最多 32 字符）丢弃：真实响应为 `ok:true` / `blockingCount:1` / `blockingCodes:[]` / `projectionDropped:1`，模型只看到“有 1 个阻塞却没有码”，transport 侧却仍通过（其自有 token 表已含这两条） | 不动通用 token 预算（32 字符）与 40 字符长度上限，只给**已登记固定代码常量的精确字面量**开窄通道（`REGISTERED_CODE_LITERALS` + `isProjectionStringAllowed`，sanitize 的标量与数组两路共用）；策略 / 适配层 / transport 三层都要求同一批已登记码，未知码仍 fail closed。回归：19 个真实阻塞码**逐个**（非只两个示例）都完整投影且 `projectionDropped:0`；两条长码同时出现、同一码多条原因仍完整；未登记 37 字符 token / 41 字符串 / 中文原文仍被丢弃或拒绝 |
| P2-2 只验单字段不验 DTO 全局一致性 | `ready:true` + `steps:[]` + `blocking:[]`、`ready:true` + 七个重复 `draft_vouchers`、`ready:true` + 全 blocked 且 `blocking` 非空，都被投影成功、建了引用并通过 transport | 新增纯函数 `isPeriodEndCheckConsistent`（policy 内，**不 import** 会打开业务 DB 的 `period-end-controls.mjs`）：7 个已登记步骤唯一齐全、状态值域、每条 `blocking` 归属真实 blocked 步骤、`ready` ⇔ 无阻塞、每个 blocked 步骤至少一条原因（不机械比较原因数 = 步骤数）；策略层据此 fail closed，适配层在同一判定上直接报 `model_result_invalid` 且不建引用。回归：真实临时库 7 步 DTO（长码 + 多条原因）正例对照 + 上述矛盾 / 缺步 / 重复 / 错归属 7 条真负例，均不建引用、引用池不变 |

本轮回修后三层实际输出：策略 **37/37**（35 → 37）、适配层 **21/21**（20 → 21）、transport **18/18**（17 → 18），均 exit 0；原 35 / 20 / 17 项含义全部保留，snapshot 引用 / 过期 / 跨账套 / 预算 / 并发隔离未回退。真实正例使用真实 API 建库：`2026-02` 取得、`2026-01` 起提的 1 期寿命卡片 + `2026-03` 真实购入凭证，期末检查返回 `blockingCount:3` / `blockingCodes:['depreciation_life_expired_underprovided','previous_period_depreciation_pending','previous_period_open']` / `projectionDropped:0`。

未改变：共享 HTTP / Agent / MCP / CLI 接线、真实 HTTP 端到端、`scripts/test-all.mjs` 归属、真实账套验收。状态：**回修候选，待 root 独立增量复审**。

## 15. 接线窗口契约（LOCAL-08 Entry，本窗口候选）

本节是本窗口**实际接线**后的生效契约；§9 的 1–8 项建议已被本节实现，历史段落不改写。版本标记：`finance-model-entry/v1` + `finance-model-adapter/v1` + transport v1。未提交 / 未推送 / 未合并，Issue #44 保持 OPEN。

### 15.1 入口与路由（精确行为）

| 入口 | 行为 |
|---|---|
| `06-workbench/server/finance-model-entry.mjs`（新） | 进程级组装层：注入 raw `callAgentTool`（默认真实）；复用**一个** `FinanceOutputPolicy` 实例；暴露 `callModelTool` / `readLocalReference` / `computeLocalReference` / `revokeLocalReference` / `stats`。模块底部创建默认单例，HTTP 与直接模型调用共用同一引用池。 |
| `06-workbench/server/agent-tools.mjs` | 只**新增** `callAgentModelTool`（动态 import 组装层，避免静态循环）；raw `callAgentTool` / `HANDLERS` / `NOT_IMPLEMENTED` 语义与错误不变，不在 raw 内递归适配，也未在 raw 内脱敏。 |
| `06-workbench/server/server.mjs` | 新增 `POST /agent/model-tools/<name>`：仅 POST + `application/json` + JSON 对象 body；name 只允许 `[A-Za-z0-9_]+`（否则 404 `model_tool_unknown`）；成功 / 业务失败一律 HTTP 200 + 信封（`ok:false` 由 MCP 转 isError）；任何意外异常只回 500 `model_entry_failed`。新增 `POST /api/finance-output/read` 与 `/compute`：同形校验，只回固定 `output_policy_*` 码（未知 500 `finance_output_failed`），不回 message / details / 引用值。既有 `POST /agent/tools/<name>` 与 `/api/*` 完全不变；外层 catch 只对这两类新路径做固定码收敛。 |
| MCP `backend.mjs` | 普通财务工具**固定** `POST /agent/model-tools/<name>`；税务 / 目录工具仍 `POST /agent/tools/<name>`（专用超时不变）。模型通道任何失败（参数、网络、超时、非 2xx、响应体读取失败、非 JSON、信封不合规）都**绝不回退** raw：只抛 `ModelTransportError`（固定 `failure`，不含片段 / 地址 / 原文）。`backendInfo()` 不再回显 `API_BASE`。 |
| MCP `server.mjs` | 删除本地 `finance_query_catalog` / `financeQuery` 分支与 `LOCAL_QUERIES` / `queryStatus` 依赖，普通工具统一经后端模型通道；schema 前置拒绝仍保留（只回字段名 / 枚举 / 类型，不回参数值）；`skills_list` / `skills_read` 仍是本机资源读取，失败只回 `skill_not_found`；模型信封结果**再校验一次**后才交给模型，校验失败按写场景保守给 `writeOutcome:unknown`；`envelope.ok === false` → `isError`；税务分支、协议握手、`tools/list`、`isError` 分类未改。 |
| MCP `tools.mjs` | 新增 `MODEL_PLAIN_TOOL_NAMES`（27）/ `MODEL_WRITE_TOOL_NAMES`（14）并与适配层交叉核对；普通工具描述追加「摘要信封 + 本机引用」语义与 `modelOutput:"summary_envelope"`；`account_context` / `finance_context_resolve` 如实登记 `limit`（1–32，默认 10）/ `offset`（≥0）分页字段；`update_plan` 描述不再声称回显 / 持久化；`finance_query_catalog` 描述改为静态目录。**不登记** `localRead` / `localCompute` / raw / 任意 URL 工具。 |

### 15.2 本机引用与能力对象生命周期

- 能力对象由 `policy.issueChannel("local_ui")` 在**组装层闭包内**签发，每进程一个；不导出、不序列化到 HTTP / 模型 / 日志 / MCP。
- `/api/finance-output/read|compute` 请求必须显式带 `ref` / `accountSetId` / `operation`；`accountSetId` 只接受正安全整数或纯数字字符串（拒绝布尔 / 隐式转换）；请求体出现 `channel` 或 `local`（无论值）一律 `output_policy_channel_untrusted`；调用方提供的 channel 永远不被解析。
- `compute` 仅既有 `sum` / `count` / `min` / `max` + 受限 `path`；不新增解释器、不读文件、不新增公网配置。
- 引用只在本进程内存：换 `accountSetId` / 换或缺 `operation` / 篡改或未知 ref / 伪造 channel / 过期 / 已撤销 / 进程重启后旧 ref 全部拒绝且不回显原值。预算保持默认 15 分钟 TTL、256 refs、单值 200000 节点 / 4 MiB、累计 1000000 节点 / 64 MiB，**未调大**；`localRead` / `localCompute` 不登记为模型或 MCP 工具。

### 15.3 注册表覆盖（按实际 registry 枚举核对）

- 模型通道普通工具 **27** 个，与适配层 `PLAIN_MODEL_TOOLS` **逐名一致、无漂移**；写动作子集 **14** 个（运输失败只给 `writeOutcome:unknown`）。
- `finance_query`：已实现 node **12**（`enterprise_account.account_set` / `enterprise_account.subject_system.all` / `voucher.generated.list` / `voucher.generated.summary` / `voucher.draft.summary` / `voucher.detail` / `report.balance_sheet` / `report.income_statement` / `report.cash_flow_statement` / `period_end.summary` / `report.trial_balance` / `ledger.general`），明确未实现 **11**；未知 / 未实现 node 固定拒绝且**执行计数为 0**；只把真实 `{nodeId,label,data}` 的 `data` 交给白名单 spec，不二次投影。
- 税务沿用既有精确注册集合走 raw 通道（7 个税务业务工具 + 目录类），**不按 `tax_` 前缀放行未知名称**；未实现 / 未知税务名在 MCP schema 或 `unknown_tool` 处拒绝，不转发后端。
- 上下文无 setId 时为 `global` scope（只给 ID / 计数 / 枚举，单列 `refUnavailable:"global_scope"`，不建引用）；`limit`/`offset` 有界分页仍能选到最后一页；指定账套时真实校验归属并按 `account_set` 绑定。

### 15.4 错误面（模型通道固定输出）

- HTTP：无效 JSON / 非对象 body → 400 `request_body_invalid`；错误 method → 405；非 JSON content-type → 415；未知工具名 → 404 `model_tool_unknown`；入口意外异常 → 500 `model_entry_failed`；本机引用错误 → 400 + `output_policy_*`（未知则 500 `finance_output_failed`）。
- MCP：schema 前置拒绝 `invalid_arguments`（只含字段名 / 枚举 / 类型）；未知工具 `unknown_tool`；未实现 `not_implemented`；领域错误信封 `error.code` + 固定 `messageKey` / `retriable` / `outcome`；运输失败 `backend_unreachable` / `backend_timeout` / `backend_http_error` / 信封校验固定码；`details` 只用于既有工具名 / schema 字段名，绝不携带响应片段、地址、路径、SQL、栈或请求参数值。
- 调试模式只回 `{configured, timeoutMs, hasToken}`，不回 `API_BASE` / 原始错误 / 路径。

### 15.5 写三态与不重复

- 执行前拒绝：`applied:false` + 固定 `appliedReason`（例如 `dry_run` / 前置校验失败），有证据未执行。
- 写已发生：`applied:true` + 真实 ID（`account_set_create` / 首次导入的 setId 只取真实结果，不用入参覆盖）。
- 已发请求但结果不能确认：`applied:"unknown"` + `needsLocalReview:true`，运输层 `retriable:false`，**不得自动重试**。
- `await` 原始写**仅一次**；未使用 `policy.runWrite` 包 async。已提交后摘要过大 / 引用满 / 投影失败只安全降级（保留能证实的 `applied` 与技术 ID），不报“肯定失败”诱导重复操作。
- 本包不实现任务级幂等 / 批量锁 / 跨重启恢复；相同账套重复写仍受既有领域约束。

### 15.6 本窗口实跑证据（事实）

| 范围 | 命令 / 工作目录 | 结果 |
|---|---|---|
| 新入口 | `node test/finance-model-entry.test.mjs` / `06-workbench` | **15/15**，exit 0 |
| 新 HTTP | `node test/finance-model-http.test.mjs` / `06-workbench` | **14/14**，exit 0 |
| 新 MCP 端到端 | `node 05-reconstruction/codex/mcp/finance-mcp/finance-model-entry-test.mjs` / 仓库根 | **8/8**，exit 0 |
| 旧 MCP 迁移 | contract / workflow / import-incremental / accounting-period / smoke | **46/46**、**23/23**、**7/7**、**5/5**、**28/28**，均 exit 0 |
| 已合并三套 | policy / adapter / transport | **37/37**、**21/21**、**18/18**，均 exit 0 |
| 本机回归 | smoke / server-local-boundary / import-incremental-http / accounting-period-http / report-export-http / voucher-amount-guards / report-office-http | **28/28**、**30/30**、**22/22**、**18/18**、**31/31**、**103/103**、**6/6**，均 exit 0 |
| 统一入口 | `node scripts/test-all.mjs` / `06-workbench`（设 `REPORT_OFFICE_PYTHON`） | 接线窗口当时为 **55 套子进程 exit 0、1 套失败；统一入口整体 exit 1（55/56）**；唯一失败 `tax-contract-test.mjs` 的旧形状断言（见 §15.7）。补漏窗口重跑为 **56/56**，见 §15.9 |

隔离方式：三套新套件先建全新临时 `WORKBENCH_DATA_DIR`，再动态 import；HTTP / MCP 用 `PORT=0` / 空闲 loopback 端口自建后端；故障注入用独立测试后端与进程内代理，不加生产查询参数后门。合成敏感标记覆盖企业名 / 科目名与编码 / 摘要 / 往来 / 人员 / 资产名 / 备注 / 源路径 / 企业身份 / 来源系统 / 批次 ID，并逐值检查 HTTP body/headers、MCP text/structuredContent、stderr/stdout/debug 与捕获错误。

### 15.7 明确未做 / 范围外

- `scripts/test-all.mjs` 未改：本包三套新测试**尚未登记**（按协调先由 #53 登记银行套件，再由 44 追加本包三套）。
- `05-reconstruction/codex/mcp/finance-mcp/tax-contract-test.mjs` 在接线窗口**不在 17 路径内**，当时失败点是把普通工具 `account_context` 当作仍返回 raw `account_sets`（新契约下是模型信封 `projection.accountSetIds`）；**已在补漏窗口按最小迁移完成**（普通工具往返只断言模型信封 + 真实账套业务事实，保留“既有工具仍可用、未实现仍 not_implemented”核对），见 §15.9。本节保留接线窗口的 **55/56** 事实，不改写成当时已通过。
- 未触碰：`public/app.js` / `public/index.html`（本机 UI 仍走 `/api/*` 读原文）、`accounting.mjs` / `db.mjs` / `coa.mjs` / `import-storage.mjs`、税务模块与税局进程、审计存储、批量调度、`package.json` / 锁文件、全局 loopback/Host/Origin 策略。
- 已知限制：不隔离拥有本机代码执行权限的程序；本机 `/api/*` 与 raw `/agent/tools/*` 仍可读原值（本包受控出口是模型工具注册与固定路由）；引用不落盘 / 不跨重启；MCP 普通工具响应由详细 DTO 迁移为信封（业务核对搬到本机 raw + 引用通道），**没有**本机 raw MCP 开关或自动回退；全国真实税局接入仍为 0。

### 15.8 下游合同（03B2 / LOCAL-06 / LOCAL-07）

- **03B2**：`accountingContext` 的 `{declaredStandard,profileId,coaVersion,reportMappingVersion,legacy}`、`reportStatus` 的 `{status,complete,partialValues,diagnostics}`、期末检查 warnings/rules 与 profile 结构化错误，将来必须按已知枚举 / 固定码登记进 policy / adapter / transport；模型不回传原登记字符串 / 科目原值 / 任意 reason 文本；未知形状 fail closed，不把 `incomplete` / `legacy_compatibility` 说成完整报表。
- **LOCAL-06 审计**：模型错误投影不得吞掉本机审计所需的失败 / 未知结果；业务审计仍由领域层记录稳定 `operationId` / `attempt` / `actor` / 固定 `outcome` / `code`，本包不新增审计 DB、不重复记同一次动作、不记录原 payload / 引用原值 / 金额 / 路径 / 栈 / channel 能力；写已提交但输出失败不得记成业务回滚。
- **LOCAL-07 批量**：继续复用真实领域动作，模型摘要不是成功提交的唯一证据；`unknown` 进入核对 / 恢复边界，不能自动重跑已发写；batch/job/status 未登记前拒绝；持久队列 / 并发锁 / 重启检查点属 07，本包内存引用不写入批次状态当持久凭证。每个新动作 / 新错误都需同步扩展显式 allowlist 与整合测试。

### 15.9 兼容测试补漏（18 路径，本窗口事实）

- 范围：接线窗口 17 路径 + `05-reconstruction/codex/mcp/finance-mcp/tax-contract-test.mjs`（= **18**）。唯一代码改动在该文件 partB 的普通 `account_context` 往返用例。
- 旧断言（已删除）：`assert.ok(Array.isArray(ctx.data.account_sets))` —— 新契约下普通工具回模型信封，raw 账套数组不再穿越模型通道。
- 新断言（契约含义）：
  1. 临时库经同一模型通道 `account_set_create` 建 1 个合成账套，`applied:true` 且 `accountSetId` 为真实正整数；
  2. `account_context {}` 的真实信封：`ok:true` / `channel:"model"` / `tool:"account_context"` / `operation:"account_context"` / `operationCategory:"context"` / `scope:"global"` / `accountSetId:null` / `rawValuesIncluded:false` / `localRef:null` / `refPersistence:"none"` / `refUnavailable:"global_scope"`，且 `structuredContent` 与 text 信封一致；
  3. `projection` 的账套业务事实：`accountSetCount` / `returnedCount` / `accountSetIds`（与真实建账 ID 一致）/ `startPeriods` / `taxpayerTypes`（受控 token）/ `accountingStandards`（受控 token）/ `displayNameFlags`（名称存在标记，非名称）/ `pageOffset` / `pageLimit` / `truncated` / `hasNextPage` / `selectionRequirement:"explicit_account_set_id"` / `persisted:false` / `projectionDropped:0`；
  4. 旧 raw 形状消失：信封无 `account_sets` / `note`，text 无企业名原文；未实现工具（`declaration_query`）仍 `not_implemented`。
- 保持：税务 fake adapter / 网关状态机 / 缺省未配置 / 跨区域与跨账套隔离 / 凭据脱敏 / 未实现声明等 **58 条其余断言原样保留，未跳过、未放宽**。
- 实跑（本窗口，exit 0）：`node tax-contract-test.mjs`（MCP 目录）**59/59 通过**；`node scripts/test-all.mjs`（`06-workbench`，设 `REPORT_OFFICE_PYTHON`，56 套）**56/56 通过**。前次 **55/56** 为接线窗口事实，§15.6 / §15.7 保留不改。
- 未改：税务源码 / 网关、`06-workbench/server/*` 源码、另外 5 套 MCP 测试、`scripts/test-all.mjs`（归 #53）、`package.json` / lock、全局配置。

## 16. 统一测试入口登记（LOCAL-08 `test-all` 唯一写归属，19 路径）

### 16.1 授权与归属变更（事实）

- 远端正式授权：[Issue #53 comment 6344168123](https://github.com/huxiaoyang-code/youshu-fork/issues/53#issuecomment-6344168123) / [Issue #44 comment 6344169272](https://github.com/huxiaoyang-code/youshu-fork/issues/44#issuecomment-6344169272) / [PR #63 comment 6344170064](https://github.com/huxiaoyang-code/youshu-fork/pull/63#issuecomment-6344170064)：`06-workbench/scripts/test-all.mjs` 由 LOCAL-08 独占写入，用于登记本包三套测试。
- 精确 **19 路径** = 补漏窗口 **18** 路径 + `06-workbench/scripts/test-all.mjs`。本窗口**只新增这一处入口登记**，其余 18 路径为继承内容，本窗口未再改任何源码 / 测试文件。
- 银行 4 套**不在本窗口登记**：后续由另一本机 pi 在 08 实际 main 之上并集进 PR #63，本包不代为登记、不代为合并。

### 16.2 入口登记的实际改动

- 原 **56 个套件**的名字 / 文件路径 / 工作目录 / 顺序**逐字保留**，未重排、未删减、未改断言；
- 仅在数组**末尾追加** 3 条（`cwd` 与前序同名套件保持一致）：

| 套件名 | 文件 | 工作目录 |
|---|---|---|
| `finance-model-entry` | `06-workbench/test/finance-model-entry.test.mjs` | `06-workbench` |
| `finance-model-http` | `06-workbench/test/finance-model-http.test.mjs` | `06-workbench` |
| `finance-model-entry-mcp` | `05-reconstruction/codex/mcp/finance-mcp/finance-model-entry-test.mjs` | MCP 目录 |

- 汇总语义未改：缺文件即失败、子进程非 0 即失败、任一失败则进程 `exitCode=1`；**未**加过滤 / 跳过 / 白名单 / 只跑子集开关，也未把本包三套设成可选。

### 16.3 实跑证据（本窗口，真实退出）

| 范围 | 命令 / 工作目录 | 结果 |
|---|---|---|
| 统一入口（59 套） | `node scripts/test-all.mjs` / `06-workbench`（设 `REPORT_OFFICE_PYTHON`） | **59/59 套通过，exit 0** |
| 新登记：Agent 组装层 | 同上（`finance-model-entry`） | **15/15** |
| 新登记：真实 HTTP | 同上（`finance-model-http`） | **14/14** |
| 新登记：MCP 端到端 | 同上（`finance-model-entry-mcp`） | **8/8** |
| 输出协议三套 | 同上（`finance-output-policy` / `finance-model-adapter` / `finance-model-transport-mcp`） | **37/37** / **21/21** / **18/18** |
| Office 真实导出 | 同上（`report-office-export` / `report-office-http`） | **21/21**（含 **11 PDF** 的 pdfplumber 几何校验）/ **6/6** |
| 税务契约 | 同上（`tax`） | **59/59** |

- 隔离：`node_modules` 按现有 lock 离线安装（未改 lock、未装新依赖）；统一入口内各套件自建临时库与本会话独占临时根（`TEMP` / `TMP` 已指向该根）、`PORT=0` / 空闲 loopback 与 stdio MCP；不连 8787、旧后端、税局浏览器、真实账套 / 凭据；Office 使用获准 python runtime（`REPORT_OFFICE_PYTHON`）。
- 记录位置：原始日志写入被 Git 忽略的 `.agent-runs/`，**不进版本化源码**；版本化文档只记录脱敏计数。

### 16.4 历史保留（不改写、不预报）

- **17 路径**（接线窗口）：统一入口 **55/56**，唯一失败为范围外 `tax-contract-test.mjs` 的 `account_context` 旧 raw 形状断言（§15.6 / §15.7 保留原文）。
- **18 路径**（补漏窗口）：**单一兼容补漏**（只改该测试文件的信封 + 真实账套事实断言）后 **56/56**（§15.9 保留原文）。
- **19 路径**（本窗口）：登记本包三套后 **59/59**。
- 三份记录按各自时点读取；本窗口不把 55/56 改写成通过，也不把任一旧记录当作本次结果。

### 16.5 明确未做 / 已知限制（不缩小原有限制）

- 入口登记 ≠ 引用持久化 / 审计落库 / 批量恢复完成：模型输出最小化仍只覆盖投影与引用通道，**不得**当作审计留痕或跨重启持久恢复已完成的证据（§12、§15.2、§15.5、§15.7 原限制全部保持）。
- **Issue #61「全入口一企业一账套」仍另包未完成**，本包不虚报完成。
- **03B2 / LOCAL-06 / LOCAL-07 后续兼容仍必需**：新动作 / 新枚举 / 新错误须同步扩展 policy / adapter / transport 显式 allowlist 与真实入口整合测试（§15.8 不变）。
- 银行 4 套（#53）未在本窗口登记；跨窗口并集、最终独立审查与合并由管理者在 PR #63 处理。本文件不构成「已合并」或「已独审」证据；管理者与最终独立审查者不是同一人。
- 未触碰：`public/*`、`accounting.mjs` / `db.mjs` / `coa.mjs` / `import-storage.mjs`、税务模块与税局进程、审计 / 备份 / 批量模块、`package.json` / lock、系统或全局配置、共享 `STATE` / `tasks README` / master 文档。


## 2026-10-23 正式补证修复候选（精确 24 路径窗口）

本轮基于既有 19 路径 WIP 保留实施，先增 policy 源码 / 测试至 21，再经 Issue #44 [comment 6357131464](https://github.com/huxiaoyang-code/youshu-fork/issues/44#issuecomment-6357131464) 明确增加 `finance-model-transport.mjs` / `finance-model-transport-test.mjs` / `finance-model-adapter.test.mjs`，合计 24。实际本轮只必要修改其中 14 路径；其余原 WIP 冻结。统一入口 `test-all.mjs` 原 56 + 3 未再修改。本轮为用户授权额度不足后的单一兜底实施会话；管理者与最终 fresh 独审另行进行，未把实施自测当独审结论。

- 真实 `voucher_create` 单次 19 元提交后装配 enumerable getter 污染 DTO：getter 执行 0 次、数据库凭证数恰增 1、重读借方 19，`applied:true`、真实 `voucherId`、`needsLocalReview:true`、无引用、固定 `value_invalid`。保留原假 ID 边界例并增强精确 ID 断言。容量对照只设测试实例 `maxRefs:1`，真实 17 / 23 元各写一次、数据库恰增 2；第二次 `applied:true` 且真实 ID 保留、`refUnavailable:capacity`，无需把容量不足当结果非法。默认预算未改。
- 非法 DTO 的技术 ID 白名单复用自有 data 属性读取，涵盖凭证创建 / 过账 / 反过账 / 删除、资产创建 / 更新、折旧的嵌套凭证、结转的凭证与年末凭证、建账 / 导入创建的账套 ID；不遍历被拒 DTO，不执行 getter。纯 policy 正控逐类核对 ID，反控 getter / 继承 ID 不得成为可证 ID。真实写证明仍为上述 19 元场景；其他新增 ID 类型本轮只做纯 policy 控制。
- transport 窄联动：`applied:true` + `needsLocalReview:true` 只允许在 `localRef:null` / `refPersistence:none` 且 `refUnavailable:value_invalid|summary_unavailable`。正控两种降级原因；负控容量 / 单值预算 / 节点预算 / 未绑定 / 有引用及 unknown 未复核均拒绝；不允许附 `appliedReason`。既有非法 DTO 的空投影 / 无需复核预期按此增强，其他写三态与税务专用语义保持。
- 正式 MCP 代理套先等待生产 HTTP 的 `applied:true`，才 drop / 延迟到客户端超时 / partial body 断流 / bad JSON / 非 2xx / 非法信封。各模式一条合成凭证，借贷各同额 61 / 62 / 63 / 64 / 65 / 66；分别核对一次转发、同标记仅一条数据库凭证、真实 ID 与金额。请求前 schema 拒绝零转发；故障返回 `writeOutcome:unknown`、`retriable:false`，不重试、不 raw fallback、不泄露合成标记。原独立假后端控制仍保留并准确称“收完请求断连”。
- 真实 HTTP 两个新账套并发各写一张 31 / 47 元凭证；同一 stdio 客户端两个新账套并发各写一张 37 / 53 元凭证。并发读账簿、核对余额 / 条数、原值引用 ID / 金额 / 操作 / 账套归属、跨账套引用拒绝，最终每账套仅一张凭证。
- 资源 list/read 失败、JSON null、method 对象与未知 method 固定错误且进程继续 ping；不反射路径 / 栈 / 原始 method。该协议问题是既有代码缺陷。raw 预检恢复精确 `['MCP-SRC-0001']`；raw 重开失败恢复精确 `2026-02`，模型固定错误断言同时保留。

本轮实际自测（均等待真实退出，cwd 仓库根，命令为 `node <相应脚本路径>`）：policy **39/39**、entry **15/15**、adapter **21/21**、transport **18/18**、HTTP **15/15**、MCP 新入口 **11/11**、MCP accounting-period **5/5**、MCP import-incremental **7/7**，均 **exit 0**。最初沙箱内 HTTP fetch 失败，正常申请权限后使用自有 loopback 复验成功；实现中的临时预期不一致 / 窄契约冲突已修正并重跑，不隐去早期失败。本轮未跑统一 59 套，最终精确候选整合验证和 fresh 独审仍由管理者执行。

所有数据均合成；独占 workspace TEMP / TMP / fallback data，创建前核对已存在祖先无 junction；只回收持有句柄的自有子进程，未扫删系统 TEMP、未按裸 PID 杀进程。未访问真实税局 / 账套 / 凭据；无生产测试 hook、无默认预算扩大。尚未覆盖穷尽并发调度、所有容量组合与真实网络设施；本机引用仍为进程内，不代表跨重启持久化。Issue #61 全入口一企业一账套仍属后包。历史 55 套子进程 exit 0、统一入口整体 exit 1 与后续 56 / 59 通过分别保留时点。本候选未提交 / 未发布 / 未合并。
