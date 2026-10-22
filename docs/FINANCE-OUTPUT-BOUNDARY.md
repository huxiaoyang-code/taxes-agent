# 财务输出边界契约 · FINANCE-OUTPUT-BOUNDARY

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
