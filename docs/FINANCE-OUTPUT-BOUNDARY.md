# 财务输出边界契约 · FINANCE-OUTPUT-BOUNDARY

- 状态：**模块已实施并通过独立审查**（`06-workbench/server/finance-output-policy.mjs`；源码冻结于模块提交 `790e8db77cac2383de7c418b429784a2048b06be`）。review1 的 5 项缺陷已修复，管理者与**不参与实现**的独立 reviewer 各自实跑 `node test/finance-output-policy.test.mjs` → **28/28、exit 0**（见 §10 / §11）。**HTTP / Agent 工具 / MCP / CLI 仍然未接线**，整体 LOCAL-08 **未完成**，Issue #44 **保持 OPEN**；模块通过 ≠ 数据边界已在真实入口生效。
- 归属：LOCAL-08（任务单 [tasks/LOCAL-08](tasks/LOCAL-08.md)，交接 [handoffs/LOCAL-08](handoffs/LOCAL-08.md)），Refs Issue #44；负责人 `huxiaoyang-code`，分支 `codex/huxiaoyang-code/local-08`。
- 本文件只描述**已经写进代码并在合成测试中验证过的契约**；未实现项明确标注「未实现」，不当作已完成。

## 1. 要解决的问题

现在 `/agent/tools/<name>`（`server.mjs` → `agent-tools.mjs` → `accounting.mjs`）把领域结果**原样**返回给模型侧：

- `finance_query` 直接把 `A.getAccountSet / listAccounts / listVouchers / getVoucher / balanceSheet / incomeStatement / cashFlowStatement / trialBalance / generalLedger` 的返回值放进 `data`，其中含企业名称、科目编码与名称、凭证摘要、往来单位、经办人、逐行凭证、明细账逐笔记录；
- 写动作返回完整凭证行等业务原文；
- 领域异常的 `message` 常内嵌科目编码 / 金额 / 账套名，`details` 可能含凭证行，`stack` 含本机路径。

模型（含本机回退模型）不需要这些原文，却会因此把账套业务数据带进模型上下文与模型侧日志。**本契约把「模型输出」与「本机操作读取」分成两条通道**，模型只拿有限数值摘要 + 一个不可猜测引用；原数据只能在本机用同一引用取回。

## 2. 双通道模型

| 通道 | 入口 | 调用者 | 能拿到什么 |
|---|---|---|---|
| 模型通道 | `wrapQuery` / `wrapWrite` / `runWrite` / `resolveForModel` | Agent 工具、MCP 后端、任何把结果送模型的地方 | 白名单 projection（有限数值 / 布尔 / 状态 token / 期间）+ `localRef` |
| 本机通道 | `localRead` / `localCompute` / `revokeLocalRef` | 本机 UI、本机回环服务、本机脚本 | 原数据、受限算术结果 |

两条通道都要求 `accountSetId` 显式给正整数（沿用既有的「绝不猜默认账套」），引用本身已绑定账套，跨账套直接用报错拒绝。

**本轮返工后：凡是引用调用，`accountSetId` 与 `operation` 都必须显式给出并被核验**，缺省、跨账套、换工具一律拒绝（§5）。本模块内**没有「不带账套的全局工具」路径**：真正全局的工具（例如后续接线里的 `account_context`）必须有自己的明确 scope 语义与独立接口，既不得伪造默认账套，也不得复用本模块的引用绕过绑定。

| API | 通道 | 必须显式提供 | 说明 |
|---|---|---|---|
| `wrapQuery` / `wrapWrite` / `runWrite` | 模型 | `operation`（已登记原始字符串）、`accountSetId` | 信封里的 `operation` 只能是登记表里的常量 |
| `resolveForModel` | 模型 | `ref` + `accountSetId` + `operation` | 只回同一份已冻结摘要 |
| `localRead` / `localCompute` / `revokeLocalRef` | 本机 | `channel` 能力对象 + `ref` + `accountSetId` + `operation` | 缺 channel 报 `channel_required` |

本机通道由**能力对象**授权，不由参数声明授权：

```js
const channel = policy.issueChannel("local_ui");            // 进程内对象，含随机 channelId
policy.localRead(ref, { channel, accountSetId: 5, operation: "finance_query:voucher.detail" }); // 通过
policy.localRead(ref, { local: true, accountSetId: 5, operation: "finance_query:voucher.detail" });   // 拒绝：channel_untrusted
policy.localRead(ref, { channel: "local", accountSetId: 5, operation: "finance_query:voucher.detail" }); // 拒绝：channel_untrusted
policy.localRead(ref, { channel, accountSetId: 5 });        // 拒绝：operation_required（缺上下文）
```

模型参数里 `local: true` / `channel: "local"` / 被 JSON 反序列化过的 `{channelId: ...}` 一律拒绝（`output_policy_channel_untrusted`），**不做静默降级**，因此「换个工具或加个参数就解引用拿原文」不成立。

`issueChannel(label)` **只**在本机进程内签能力对象（对象标识即凭据）；它不接受、也不解析任何模型输入，不提供「用字符串 / 用 JSON 反序列化结果换取能力」的入口。接线时必须由本机进程启动时签发并只留在内存里（§9）。

## 3. 模型通道允许清单（默认拒绝）

projection 只允许：**有限数值**（保留 2 位小数、绝对值 ≤ 1e12）、**布尔**、**状态 token**（`^[a-z][a-z0-9_]{0,31}$`）、**期间**（`YYYY-MM`）、**≤32 个同类标量的数组**、**≤3 层 / ≤96 节点的普通对象**。未知 operation 直接报 `output_policy_unknown_operation`；未登记字段（含自由文本、中文业务名、嵌套更深的容器）被丢弃并计入 `projectionDropped`。这不是敏感词黑名单，而是**字段白名单 + 值形状白名单**双重默认拒绝。

**operation 必须是已登记的原始字符串**（本轮返工）：先 `typeof operation === "string"`，再查表；任何查表、下标访问、字符串转换都在类型校验之后，所以 `{ toString() { return "voucher_create" } }` 这类对象既不会触发 `ToPropertyKey` 的用户代码，也不会有机会进入信封；被拒绝时错误信息只含固定文案。同一约束适用于 `runWrite`、`resolveForModel` 与 `localRead` / `localCompute` / `revokeLocalRef` 的 `operation` 参数（非字符串一律按绑定不匹配拒绝，且不做字符串转换）。

### 3.1 可返回给模型的汇总数字（查询）

| operation（Agent 工具:nodeId） | 允许字段 | 说明 |
|---|---|---|
| `finance_query:enterprise_account.account_set` | `accountSetId` `startPeriod` `taxpayerType`(small_scale/general) `accountingStandard`(small_business/enterprise) `hasDisplayName` | 只有受控枚举与期间，企业名称本身不返回 |
| `finance_query:enterprise_account.subject_system.all` | `accountCount` `leafCount` `contraCount` `byCategory.{assets,liabilities,equity,cost,profit_loss}` | 科目名称 / 编码不返回 |
| `finance_query:voucher.generated.list` / `...generated.summary` / `...draft.summary` | `voucherCount` `entryCount` `postedCount` `draftCount` `totalDebit` `totalCredit` `balanced` | 凭证行、摘要、凭证号不返回 |
| `finance_query:voucher.detail` | `voucherId` `period` `status` `lineCount` `totalDebit` `totalCredit` `balanced` | 分录行不返回 |
| `finance_query:report.balance_sheet` | `period` `assets` `liabilities` `equity` `balanced` `lineCount` `cash` `receivables` `inventory` `fixedAssetsNet` | 只给合计 + 4 个**代码常量**口径（货币资金 / 应收账款 / 存货 / 固定资产账面价值）；其余行必须本机取 |
| `finance_query:report.income_statement` | `period` `currentRevenue` `currentCost` `currentExpenses` `currentProfitBeforeTax` `currentNetProfit` `ytdRevenue` `ytdNetProfit` | `currentExpenses` = 销售 + 管理 + 财务费用合计 |
| `finance_query:report.cash_flow_statement` | `period` `operating` `investing` `financing` `netIncrease` `cashBegin` `cashEnd` `cashChange` `reconciles` `lineCount` | 分类逐行明细（按科目）不返回 |
| `finance_query:report.trial_balance` | `period` `lineCount` `openingDebit` `openingCredit` `periodDebit` `periodCredit` `closingDebit` `closingCredit` `balanced` | 逐科目行不返回 |
| `finance_query:period_end.summary` | `periodCount` `openPeriodCount` `closedPeriodCount` `period` `closingDebit` `closingCredit` `balanced` | 期间状态按计数返回 |
| `finance_query:ledger.general` | `period` `direction` `itemCount` `openingDebit` `openingCredit` `periodDebit` `periodCredit` `closingBalance` | 逐笔流水与科目名不返回；`closingBalance` 由期初 + 本期发生额**重算**，不信任最后一行 |

`finance_query:enterprise_account.bank` 等未实现能力没有 spec，**不会**得到投影：入口层必须走自己的 `not_implemented` 响应，不得把原始结果塞进任何兜底信封。

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
| `legacy_book_import` | `dryRun` `validationOk` `blockedByValidation` `createdAccountSetId` `createdAccountCount` `createdVoucherCount` `warningCount` | `created.id` 存在；`dryRun=true` → `applied=false` |

没有正面证据时 `applied="unknown"` 且 `needsLocalReview=true`（附 `appliedReason`：`unverified_result` / `missing_voucher_id`），**绝不把「不知道」写成成功**。`runWrite` 在域函数抛错时返回 `ok:false, applied:"unknown", needsLocalReview:true` + 安全错误投影：既不当成功，也不断言未生效（是否部分写入必须由本机核对）。

**写执行与写后失败（本轮返工）**：

1. `runWrite` 先完成所有**能预先确定**的校验（operation 已登记字符串、`accountSetId` 为正整数、`execute` 是函数），**再**调用 `execute`；未登记 operation / 错账套 / 缺回调时回调**从未执行**（已用负例回归覆盖）。
2. 写已发生后，证据判定与摘要/引用任何失败都**只能降级**，不得抛给调用方（否则会被当成业务失败而重试）：
   - `applied` 来自**只读自有 data 属性**的证据读取（不遍历大数组、不触发 getter、不调用用户回调）；读不到就是 `unknown`，不会变成 `true`，也不会变成 `false`。
   - 降级时 `localRef:null` 并给固定 `refUnavailable`：`value_limit`（单值超节点/字节/深度/数组上限）、`value_invalid`（形状非法：访问器、循环、类实例、读不到）、`capacity` / `node_budget` / `byte_budget`（累计预算）、`summary_unavailable`（其他内部失败）。
   - 降级信封里**不会**出现任何异常的 `message` / `details` / `stack`，也不会出现未经白名单的原文。

### 3.3 明确不返回（永远不出模型通道）

企业 / 账套名称、纳税人识别号、科目编码与名称、凭证摘要、往来单位、经办人 / 人员、逐行凭证与分录金额、明细账逐笔流水、固定资产 / 无形资产卡片名称、源文件与导出路径、原始错误 `message` / `details` / `stack`、任何自由文本。

## 4. 哪些数字只能本机算

以下一律**不得**塞进 projection，只能通过本机通道取原数据或本机受控算术：

- 单个科目 / 单个凭证 / 单张明细行的金额与余额；
- 资产负债表除上述 4 个代码常量口径以外的行（如「预付账款」「其他应付款」）；
- 利润表未列入白名单的行（投资收益、营业外收支、所得税费用等逐项金额）；
- 现金流量表按科目分类的逐行金额；
- 明细账逐笔发生额与期末余额（`closingBalance` 之外的逐笔）；
- 任意字段求和 / 计数 / 极值（例如「按对方科目汇总」「某期间借方合计」）；
- 任何「哪些科目有余额」「有哪些凭证」这类**记录集合**本身。

本机算术接口（`localCompute`）只支持 `sum` / `count` / `min` / `max` + 受限路径：

```js
policy.localCompute(ref, { channel, accountSetId: 5, operation: "finance_query:voucher.detail", op: "sum", path: "entries.[].debit" });
// → { ok:true, channel:"local", op:"sum", matched:2, skipped:0, nodes:6, value:100, empty:false }
```

- `path` 必须是 1–8 段普通字段名，最多一个 `[]` 数组展开段，拒绝 `__proto__` / `constructor` / `prototype`；
- 只累加有限数值（绝对值 ≤ 1e12），非数值叶子计入 `skipped`；数组 ≤512、节点 ≤1024，超出即报错；
- 结果是**本机数值**，不是会计结论：它不替代 `accounting.mjs` 的报表算法，也不改写任何记账结果。

## 5. 引用契约

| 项 | 约定 |
|---|---|
| 形状 | `finref_` + 48 位十六进制（192 位随机，`node:crypto randomBytes`），`REF_PATTERN` 只做快速失败；参数先判 `typeof === "string"` 再匹配（`RegExp.test` 会 ToString） |
| 绑定 | 账套 `accountSetId`、操作（Agent 工具名 / nodeId）、类别（`query` / `write`） |
| 调用上下文 | 每个引用 API（含 `resolveForModel` / `revokeLocalRef`）都必须显式传 `accountSetId` 与 `operation`；缺失、跨账套、换工具分别报 `output_policy_account_set_invalid` / `output_policy_ref_cross_account` / `output_policy_ref_binding_mismatch`（缺 operation 报 `output_policy_operation_required`） |
| 到期 | 默认 15 分钟（`ttlMs` 可配）；到期后模型通道与本机通道都取不到 |
| 撤销 | `revokeLocalRef(ref, { channel, accountSetId, operation })`，之后两个通道都报 `output_policy_ref_unknown`；撤销立即归还节点与字节占用 |
| 容量 | 默认最多 256 个（`maxRefs` 可配）；查询满了直接失败（`output_policy_ref_capacity_exceeded`），写满了只丢引用（`refUnavailable: "capacity"`） |
| 节点预算 | 单值 ≤200000 节点（`valueNodes` 可配）、累计 ≤1000000 节点（`nodeBudget` 可配）；查询拒绝、写降级为 `refUnavailable:"value_limit"` / `"node_budget"` |
| 字节预算 | 单值 ≤4 MiB（`valueBytes` 可配）、累计 ≤64 MiB（`byteBudget` 可配）。估算口径（按源码 `NODE_BYTE_COST = 8` 核对）= **根值固定开销 8 + 每节点 8 + 字符串 UTF-8 字节 + 键名 UTF-8 字节**；这是**保守估计，不是 JS 实际内存占用计量**（算法未因文档修订而改动）。节点数拦不住一个 8 MiB 字符串（它只是 1 个节点），所以必须单算字节；查询拒绝、写降级为 `"value_limit"` / `"byte_budget"` |
| 扣减 | 到期、撤销、`dispose()` 都走同一清理路径归还节点/字节；`stats()` 暴露 `nodes` / `bytes` 与对应预算，供接线时核对 |
| 存储 | **仅进程内**（`persistence: "process_memory"`）。进程重启即失效，这是设计而不是缺陷 |
| 解引用 | 模型侧 `resolveForModel` 只返回**建引用时同一份**已冻结 projection；换 operation / 换账套一律报错 |

**持久化条款（未实现）**：本模块不做磁盘引用。若后续确有跨重启需要，必须满足：只在本机私有目录、0600、按账套分目录、独立 TTL 与撤销、绝不通过 HTTP / Agent / MCP 暴露成通用「按引用取原文」工具、不与模型参数共享目录路径；在此之前**不要**把 ref 写进数据库或日志。

## 6. 错误投影契约

`safeErrorProjection(error, { operation })`：

```js
{ ok: false, outputPolicy: "finance-output-policy/v1", operation: "voucher_create",
  error: { code: "voucher_invalid", category: "voucher", retriable: false, messageKey: "voucher_invalid" },
  rawErrorIncluded: false }
```

- `code` 只取**固定 allowlist**（账套 / 科目 / 期间 / 凭证 / 结转 / 输出策略等域码），命中才回声登记表里的常量；否则 `operation_failed`（`category: "unknown"`）。
- 取值顺序是：先取自有 `code` 字符串，再取自有 `message` 字符串，**两者都只当固定 allowlist 的查表键**。所以 `new Error("period_closed")` 这类以 message 承载域码的写法仍可识别，但**回声的只有登记表常量，不回声原值**。准确表述是「读取自有 `message` 的值用于查表」，**不是「完全不读取 message」**。
- 原 `message` / `details` / `stack` 的内容**绝不输出**到返回值或日志（`rawErrorIncluded:false`，返回对象里没有任何承载原文字段的键）；`details` 只在本机进程内由调用方自己的对象持有。
- 不提供「用 ref 取原始错误」的接口，避免再造一个原文通道。

## 7. 形状 / 超量限制

| 位置 | 限制 | 超限行为 |
|---|---|---|
| 原数据遍历（形状） | 只接受普通对象 / 数组 / 标量；**拒绝循环引用、访问器属性（getter）、`Map`/`Date`/类实例** | 查询报 `output_policy_value_invalid`；写结果降级为 `localRef:null` + `refUnavailable:"value_invalid"`，`applied` 照实报 |
| 原数据遍历（大小） | ≤200000 节点 / 单值（可配 `valueNodes`）、单值 ≤4 MiB（可配 `valueBytes`）、≤32 层、单个数组 ≤5000 | 查询报 `output_policy_value_too_large` / `..._capacity_exceeded`；写结果降级为 `localRef:null` + `refUnavailable:"value_limit"` / `"byte_budget"`，`applied` 照实报 |
| 检查顺序 | **先做形状 + 节点/字节检查，再看摘要**；摘要只经 `Object.getOwnPropertyDescriptor` 读自有 data 属性（不用 `arr[i]`、不读 `arr.length`、不顺着原型链） | 因此访问器属性不会在摘要阶段被触发；形状非法时写通道直接跳过摘要 |
| projection | ≤96 节点、≤3 层、数组 ≤32、字符串 ≤40 且必须匹配 token / 期间 | 非法值丢弃并计入 `projectionDropped`，键名不合规直接丢 |
| 盘点 | `Object.keys` + `Object.getOwnPropertyDescriptor` 读取，**只取自有数据属性** | 原型链上的值不参与投影；`Object.create({...})` 原数据整体拒绝 |
| 本机算术 | ≤8 段路径、1 个 `[]`、≤512 数组、≤1024 节点 | `output_policy_path_invalid` / `output_policy_value_too_large` |

**恶意对象边界（不夸大）**：JS 反射无法完全避免触发 Proxy 陷阱（`ownKeys` / `getOwnPropertyDescriptor` 本身就是陷阱），所以本模块**不声称**“零陷阱执行”。承诺的边界是：不触发访问器 getter、不顺着原型链取值、失败即安全拒绝（查询报固定 `output_policy_value_invalid`，写结果降级为固定 `refUnavailable`），字节/节点/深度上限防止大批量持有撑爆内存。若接线层还要防“恶意对象”，必须在构造这些领域结果时就不把不可信对象传进来。

## 8. 最小 API

```js
import { FinanceOutputPolicy, safeErrorProjection, sanitizeProjection,
         measureRawValue, inspectRawValue, SUPPORTED_OPERATIONS, MODEL_OUTPUT_CONTRACT,
         OUTPUT_POLICY_VERSION, REF_PERSISTENCE, REF_PATTERN, OutputPolicyError } from "./finance-output-policy.mjs";

const policy = new FinanceOutputPolicy({
  ttlMs, maxRefs, valueNodes, nodeBudget, valueBytes, byteBudget, now,
}); // 全部可省

policy.wrapQuery(operation, { accountSetId, value });      // 查询结果 → 模型信封（含 localRef）
policy.wrapWrite(operation, { accountSetId, value });      // 已执行的写结果 → 模型信封 + applied 三态
policy.runWrite(operation, { accountSetId, execute });     // 先校验、再执行同步写动作并包装
policy.resolveForModel(ref, { accountSetId, operation });  // 模型再次解引用：只回摘要（两者都必填）
policy.issueChannel(label);                                // 本机签发能力对象（进程内）
policy.releaseChannel(channel);
policy.localRead(ref, { channel, accountSetId, operation });        // 原数据
policy.localCompute(ref, { channel, accountSetId, operation, op, path }); // 受限算术
policy.revokeLocalRef(ref, { channel, accountSetId, operation });   // 撤销（必须带账套与 operation）
policy.toSafeError(error, { operation });                  // 安全错误投影
policy.stats();   // { refs, channels, maxRefs, ttlMs, nodes, nodeBudget, bytes, byteBudget, persistence }
policy.dispose();
```

`SUPPORTED_OPERATIONS.query` / `.write` 是可接线 operation 的权威清单；`MODEL_OUTPUT_CONTRACT` 是给入口层与评审看的机读边界声明；`measureRawValue` / `inspectRawValue` 是容量测算出口（后者同时返回 `{ nodes, bytes }`）。

## 9. 接线建议清单（后续集成任务，本包不做）

**共享入口归属（当前事实）**：`agent-tools.mjs` / `server.mjs` / MCP / `scripts/test-all.mjs` 等共享文件现归 **LOCAL-02（Issue #47）**；LOCAL-01（Issue #43 / PR #46 / merge `1a15bcc`）**已验收合并，不再是等待对象**。接线走**独立小 PR**，并且**先做本包独占的新文件**——普通工具适配器 + 真实（合成数据）调用测试，用于在不改共享文件的前提下先证明适配层；**该适配器与测试尚未实施**，本文件不预报其存在。

1. **`06-workbench/server/agent-tools.mjs`（共享文件，现归 LOCAL-02 / Issue #47）**：`finance_query` 的已登记 nodeId 改为 `policy.wrapQuery(\`finance_query:${nodeId}\`, { accountSetId, value: data })`；未登记 / 未实现能力保持自己的 `not_implemented`，不要走投影兜底。传入的 operation 必须是**代码里的字符串常量**（不要把请求参数拼成 operation）。
2. **写动作**：在既有 handler 内部执行完后 `policy.wrapWrite(<工具名>, { accountSetId, value })`，或在 handler 外层用 `policy.runWrite` 包一次同步调用；不要改 `accounting.mjs` 的写入顺序、事务或返回结构。用 `runWrite` 时注意它**先校验后执行**，所以未登记工具名不会产生任何写入。
3. **`server.mjs` 错误分支**：`catch` 里把 `e` 换成 `policy.toSafeError(e, { operation })` 再返回给 `/agent/tools/*`；注意 `server.mjs` 现在会把 `e.message` / `e.details` 原样返回（会带账套名 / 科目编码），接线时一并改为安全投影。
4. **本机读取入口**：新增本机回环接口（或直接在本机 UI 进程内调用）时，`channel` 必须由该进程启动时 `issueChannel` 得到并只留在内存，不接受请求体里的 `channel` / `local` 字段；接口仅绑定 loopback 且校验 Origin（沿用 `server.mjs` 既有策略）；每个调用都要从请求体拿 `accountSetId` 与 `operation` 做绑定校验。
5. **MCP / CLI**：**不要**新增 `localRead` / `localCompute` 的 MCP 工具或命令行参数。MCP 只消费模型通道信封；需要原文时由本机 UI 处理。
6. **`06-workbench/scripts/test-all.mjs`（共享文件，现归 LOCAL-02 / Issue #47）**：追加 `node test/finance-output-policy.test.mjs` 入口；本包未改该文件。
7. **全局工具（如 `account_context`）**：若接线时真有**不绑定电子账套**的工具（例如纯会话 / 账户上下文元信息），必须自己定义明确 scope 语义与独立接口，**不得**伪造默认账套、不得跳过 `accountSetId` 校验，也不得复用本模块引用绕过绑定；本模块所有已登记 operation 都要求显式账套。
8. **回归**：接线后必须补一条「真实 HTTP → Agent → 模型信封不含敏感原文 + 本机通道可取原文」的集成测试，以及一条「写动作错误不再泄漏 message」的测试。

## 10. 未实现 / 未接线（明示）

- 模块本身：**已实施 + review1 五项缺陷修复 + 独立审查通过**。管理者与不参与实现的独立 reviewer 各自在已审模块提交 `790e8db77cac2383de7c418b429784a2048b06be` 上实跑 `cd 06-workbench && node test/finance-output-policy.test.mjs` → `28/28 passed`、exit 0（合成内存对象，无库、无网络）。
- HTTP / Agent 工具 / MCP / CLI：**未接线**，因此当前实际返回给模型的仍是原始结果；本契约**尚未在真实入口生效**，模块通过**不等于**整体数据边界完成，Issue #44 保持 OPEN。
- 未做：磁盘持久化引用、多用户 / 权限体系、按用户隔离、审计落库、批量写队列、自动把 `finance_query` 全量 nodeId 纳入（未实现能力不需要投影）。
- 未验收：没有真实账套、没有真实模型调用链路的端到端证据；真实账套数据与凭据始终不进入模型服务。
- 引用只在进程内有效，进程重启后旧 ref 全部失效；上限（256 refs / 100 万节点 / 64 MiB / 15 分钟 / 单值 20 万节点 / 4 MiB）是本地策略，不是对外 SLA。

## 11. 本轮独立审查发现与修复（LOCAL-08 review1）

独立审查在首轮员工交付（22/22 通过）之后指出 5 项真实缺陷，本轮已逐项修复并补独立回归（不依赖实现自证）：

| # | 发现 | 修复 |
|---|---|---|
| 1 | `own(WRITE_SPECS, operation)` 会触发 `ToPropertyKey`，`{toString(){return "voucher_create"}}` 能被当成 operation，且对象被原样放进信封（`JSON.stringify` 带敏感属性） | operation 一律**先判原始字符串再查表**；信封只放登记表常量；`resolveForModel` / `localRead` / `localCompute` / `revokeLocalRef` 的 operation 同样只接受字符串且不转换 |
| 2 | `runWrite("unregistered_write", …)` 先把回调执行完，才在包装阶段抛 `unknown_operation` | 所有可预确定的校验（operation / `accountSetId` / `execute`）移到回调之前；负例断言回调**从未执行** |
| 3 | `sumField` 等用 `list[i]` 触发索引 getter；形状测量在摘要之后；写后失败直接外抛原文 `Error` | 全部改为 `getOwnPropertyDescriptor` 读自有 data 属性（含长度），**先做形状 + 预算检查再看摘要**；写后证据/摘要/引用失败只降级为固定 `refUnavailable` + 可证实 `applied`，原始 `message`/`details`/`stack` 不出安全路径；并明确不声称“零 Proxy 陷阱” |
| 4 | 内存预算只有节点数：一个 8 MiB 字符串只算 5 个节点，256 个引用可留存超量原文 | 增加**单值字节预算（`valueBytes`）与累计字节预算（`byteBudget`）**，与节点预算并列；到期 / 撤销 / `dispose` 都归还占用；`stats()` 暴露 `nodes` / `bytes` 供核对 |
| 5 | `resolveForModel` 允许缺省账套，`revokeLocalRef` 忽略账套 / operation，与文档“两通道都显式账套”不一致 | 统一为**凡引用调用都显式核验 `accountSetId` + `operation`**；跨账套 / 换工具 / 缺省上下文分别拒绝；全局工具必须另设 scope 语义，不得伪造默认账套 |

验证（均为**已实际发生**的运行，非预报）：员工侧 `cd 06-workbench && node test/finance-output-policy.test.mjs` → `28/28 passed`，exit 0（合成内存对象，无库、无网络）；同目录 `node test/accounting-guards.test.mjs` → `23/23`，exit 0。review1 后**管理者**与**不参与实现的独立 reviewer** 各自在同一已审模块提交 `790e8db` 上实跑同一命令 → `28/28 passed`、exit 0，结论为 **5 项缺陷已修复、模块审查通过**。

边界说明：**模块仍未接线**，所以不声明整体数据边界完成；Issue #44 保持 OPEN；PR 与 merge 仍待管理者执行（本文件不预知未来提交，也不写未来 SHA）。
