# 财务输出边界契约 · FINANCE-OUTPUT-BOUNDARY

- 状态分三段，**不要混读**：
  1. **纯策略模块已合并**：`06-workbench/server/finance-output-policy.mjs` 经独立审查后由 [PR #50](https://github.com/huxiaoyang-code/youshu-fork/pull/50) 合并（已审 head `f211ace5b90e6dc5f240c8bb870ffbf5eb11662b`，merge / main `b42bae9ae76e54aeda63bcc4db0dc34663286b7d`，2026-10-22T09:57:25Z）；
  2. **普通工具适配层已实现但未挂载**：`06-workbench/server/finance-model-adapter.mjs` + 真实（临时库）调用验收 `06-workbench/test/finance-model-adapter.test.mjs`；
  3. **出站信封校验已实现但未挂载**：`05-reconstruction/codex/mcp/finance-mcp/finance-model-transport.mjs` + `finance-model-transport-test.mjs`。
- **HTTP / Agent / MCP / CLI 仍全部未接线**：`agent-tools.mjs`、`server.mjs`、MCP `backend/server/tools`、`scripts/test-all.mjs` 一律未改（共享入口归 LOCAL-02 / Issue #47）。因此**当前真实模型入口仍原样返回业务原文**；本契约尚未在真实入口生效，Issue #44 **保持 OPEN**。模块 / 适配层通过 ≠ 数据边界已生效。
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
| projection | ≤96 节点、≤3 层、数组 ≤32、字符串 ≤40 且必须是 token / 期间 | 非法值丢弃并计入 `projectionDropped` |
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

**共享入口归属（当前事实）**：`agent-tools.mjs` / `server.mjs` / MCP 注册与传输 / `scripts/test-all.mjs` / `package.json` / `public/*` / 共享索引文档归 **LOCAL-02（Issue #47）**，且该任务当前在返工中；本轮**未改**其中任何文件。LOCAL-01（#43）已合并。

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
- **真实返回形状**：`finance_query` 必须回 `{ nodeId, label, data }`；适配层只把 `data` 交给 spec，并先做**每个 node 的必需字段形状检查**（例如资产表必须含 `assets` / `liabilities` / `totals` 数值），否则回 `model_result_invalid`——绝不让 wrapper 或变形 DTO 投影成「全 0 报表」。
- **全局上下文（合法全局操作）**：无 `accountSetId` 时 `scope:"global"`，只给 `accountSetCount` / `returnedCount` / `pageOffset` / `pageLimit` / `truncated` / `hasNextPage` / `nextOffset` / `accountSetIds[]` / `startPeriods[]` / `taxpayerTypes[]` / `accountingStandards[]` / `displayNameFlags[]` / `selectionRequirement` / `persisted:false`；**不伪造 `setId=0/1`**，也**不建引用**（`localRef:null`、`refUnavailable:"global_scope"`）。默认每页 10、上限 32；超页大小 / 负 offset 在**执行前**回 `model_context_page_invalid`。指定账套时做真实归属校验（不在列表里回 `account_set_not_found`），并只给该账套的期间计数等摘要。
- **create 类写动作的 setId 只能来自真实结果**：`account_set_create` 取结果 `id`；`legacy_book_import` 取 `created.id`；`book_import_incremental` 取 `created.accountSetId` / 顶层 `accountSetId` / `batch.accountSetId`（按序，全部校验正安全整数）。没有可信 ID（dry-run / 校验失败 / 未建账）时回**未绑定摘要**：`accountSetId:null`、`localRef:null`、`refUnavailable:"not_applied"|"unbound_scope"`，绝不造假 ID。
- **`book_import_batch`**：账套只由真实结果 `batch.accountSetId` 决定；入参 `accountSetId` 仅用于核对，不匹配回 `model_scope_mismatch`（绝不替换结果所属账套）。批次 ID / 来源系统 / 企业身份 / 凭证号不出投影。
- **普通写动作**：`accountSetId` 在执行前校验；若结果回显的 `account_set_id` 与入参不一致，保留真实 `applied` 但不绑定引用（`refUnavailable:"scope_mismatch"`）。
- **async 写**：先预验 → `await executeRaw` **一次** → 再包装。写失败分两相：执行前拒绝 = `applied:false` + `appliedReason:"rejected_before_execution"`；执行后异常 = `applied:"unknown"` + `needsLocalReview:true` + `refUnavailable:"outcome_unknown"`。**不重复写**。
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
- 契约校验：`outputPolicy === "finance-output-policy/v1"`、`channel === "model"`、`rawValuesIncluded === false`、`ok` 布尔；成功信封必须有 `projection` 与 `localRef`。
- `operation` 必须是**登记表成员**（登记表由调用方传入，通常来自 `PLAIN_MODEL_TOOLS` + `FINANCE_QUERY_AVAILABLE`），不拼接未验证输入；`nodeId` 同样校验登记表。
- `projection` 再校验一次形状（数值上限 / token / 期间 / 数组 / 深度 / 节点），`localRef` 必为 `finref_` 形状，`refPersistence` 仅 `process_memory` / `none`，`refExpiresAt` 必须是带引用的 ISO 时间。
- 写信封：`applied` 三态必须显式，`applied !== true` 时 `needsLocalReview` 必须为 `true`。
- 运输失败：`TRANSPORT_FAILURES` 固定常量（不可达 / 超时 / 非 JSON / 非 2xx / 非对象 / 各类信封错误）。**写场景一律 `retriable:false` + `writeOutcome:"unknown"` + `retryBlockedBy:"write_outcome_unknown"`**，避免把「可能已落库」误当成可重试；只有只读的不可达 / 超时才是 `retriable:true`。
- 校验器**不会总是拒绝**：真实适配层产出的查询 / 写 / 静态 / 全局上下文信封都能通过（已测）。

## 12. 未实现 / 未接线（明示）

- 纯策略模块：已合并（PR #50 / merge `b42bae9` / 已审 head `f211ace`），员工本轮在分支上新增 3 项测试后为 **31/31、exit 0**（既有 28 项含义保留）。
- 适配层：**已实现 + 临时库真实调用验收 12/12、exit 0**；`06-workbench/server/agent-tools.mjs` 等共享入口**未接线**。
- transport：**已实现 + 独立测试 7/7、exit 0**；MCP `backend.mjs` / `server.mjs` **未接线**，**不是** stdio 挂载验收。
- 因此：**当前真实模型入口仍原样返回原文**，本契约尚未在真实入口生效；Issue #44 保持 OPEN。
- 未做：磁盘持久化引用、多用户 / 权限体系、按用户隔离、审计落库、批量写队列、`localRead` 的 MCP / CLI 工具。
- 未验收：真实 HTTP / Agent / MCP / CLI 端到端；真实账套（禁止）；跨重启（设计上失效）。
- **LOCAL-02 返工中的新期末 / 资产补项工具不在本包实现范围**：其入口名与 DTO 尚未稳定，适配层不为它们写占位 spec，也不据草稿伪造实现；待 LOCAL-02 合并后由 root 更新基线再补（见 §13）。

## 13. 待 LOCAL-02 合并后补的入口（明确登记，不预报）

- 期末 / 资产补项相关的**新工具名与 DTO**（`agent-tools.mjs` 归 LOCAL-02）在合并前不确定，因此：
  - `PLAIN_MODEL_TOOLS` 暂不登记它们（未登记 → `model_tool_unknown`，不会误执行）；
  - 不为它们写投影 spec（`SUPPORTED_OPERATIONS` 不扩张）；
  - 合并后按真实 DTO 一次补：工具名 → operation 映射 + spec + 形状检查 + 测试，走独立小 PR。
- 共享文件接线（`agent-tools.mjs` / `server.mjs` / MCP / `scripts/test-all.mjs`）同样待 LOCAL-02 释放所有权后按 §9 推进。

## 14. 验证记录（本阶段实际发生）

| 套件 | 命令（仓库相对） | 结果 |
|---|---|---|
| 策略模块 | `cd 06-workbench && node test/finance-output-policy.test.mjs` | 31/31 passed，exit 0 |
| 适配层（真实临时库） | `cd 06-workbench && node test/finance-model-adapter.test.mjs` | 12/12 passed，exit 0 |
| 出站信封校验 | `node 05-reconstruction/codex/mcp/finance-mcp/finance-model-transport-test.mjs` | 7/7 passed，exit 0 |
| 领域回归 | `cd 06-workbench && node test/accounting-guards.test.mjs` | 23/23 通过，exit 0 |
| 领域回归 | `cd 06-workbench && node test/accounting-derived.test.mjs` | 31/31 通过，exit 0 |
| 领域回归 | `cd 06-workbench && node test/import-incremental.test.mjs` | 49/49 通过，exit 0 |
| HTTP / Agent 回归 | `cd 06-workbench && node test/smoke.test.mjs` | 28/28 通过，exit 0 |

未运行：完整 `scripts/test-all.mjs`（新套件**未登记**进该共享入口，属 LOCAL-02 文件；无意义多跑）。未验证：真实 HTTP / MCP 端到端、真实账套、跨重启。

适配层测试的隔离方式：**先**建全新临时 `WORKBENCH_DATA_DIR`，**再**动态 import 真实 `accounting.mjs` / `agent-tools.mjs`，注入真实 `callAgentTool` 实际执行（两企业以上、多账套、合成敏感标记覆盖企业名 / 科目名 / 摘要 / 往来 / 人员 / 资产名 / 源路径 / 企业身份 / 批次 ID / 来源系统）；主要写动作真实落库、手工常量核对金额、断言只执行一次；所有模型返回 / 转换错误 / 测试捕获日志均不含合成标记。
