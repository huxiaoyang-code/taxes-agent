# LOCAL-08 交接

> **当前状态注记（2026-10-22 最终文档轮）**：输出协议候选源码 `3a8ae7a` 已由独立 `review_output08_final` **接受**（61 回修探针 + 47 旧控制 + 3 真实临时领域场景，两项 P2 关闭）；**37 policy / 21 adapter / 18 transport 是员工自测**，不是 root 计数。该候选已随 Draft [PR #60](https://github.com/huxiaoyang-code/youshu-fork/pull/60) 提交、**未合并**；adapter / transport 模块本身已经 [PR #57](https://github.com/huxiaoyang-code/youshu-fork/pull/57) 合入 main（merge `db6020a`）。**共享 HTTP / Agent / MCP / CLI 入口仍未接线，Issue #44 保持 OPEN**。下文「回修候选 / 待 root 复审」是各自**阶段快照**，不改写历史。

- 任务单：[tasks/LOCAL-08](../tasks/LOCAL-08.md) · 契约：[FINANCE-OUTPUT-BOUNDARY](../FINANCE-OUTPUT-BOUNDARY.md)
- 一句话：纯策略模块已由 [PR #50](https://github.com/huxiaoyang-code/youshu-fork/pull/50) 合并（已审 head `f211ace`，merge / main `b42bae9`）；本阶段在分支 `codex/huxiaoyang-code/local-08-adapter` 上新增**普通工具适配层**、**MCP 出站信封校验**与策略模块的 DTO spec / 无引用摘要出口，**已审源码 head `ba5d601`**。管理者实跑三层均 exit 0；最终独审 `review_output08_final` 未参与实现，原 3 项 P2 全关，独立探针 **57/57** 通过（**不等于三套测试用例总数**）。LOCAL-02 兼容增量后三层为策略 **35/35**、适配层 **20/20**、transport **17/17**（原 34/19/16 项含义保留），新增 `period_end_check` 只读 / `asset_update` 写与固定错误映射。**独立审查又复现 2 个 P2（长阻塞码被通用 token 预算吞掉、期末检查 DTO 只验单字段不验全局一致性）已回修，回修后为策略 37/37、适配层 21/21、transport 18/18，均 exit 0；完整 55/55 属回修前 head `04c38d4`，回修后完整重跑见 LOCAL-02 交接**。当前**已提交 / 已推送，[PR #57](https://github.com/huxiaoyang-code/youshu-fork/pull/57) OPEN 并 attach，尚无 merge SHA**；**本轮为回修候选，待 root 独立增量复审**。**HTTP / Agent / MCP / CLI 仍未接线**，共享入口归 LOCAL-02（#47），Issue #44 保持 OPEN。

## 1. 基本信息

- 任务 ID / 状态：LOCAL-08 / **策略模块已合并**；适配层与 transport 已实现、已提交并推送，LOCAL-02 兼容增量已在现有可测试合约内补齐；**独立审查 2 个 P2 已回修**（策略 37/37、适配层 21/21、transport 18/18，均 exit 0），**回修候选待 root 独立增量复审**；PR [#57](https://github.com/huxiaoyang-code/youshu-fork/pull/57) OPEN 并 attach，仍**未挂载**、尚无 merge SHA；HTTP / Agent / MCP / CLI 未接线，Issue #44 保持 OPEN
- 关联 Issue：**#44**（本任务，保持 OPEN）；共享入口现归 **LOCAL-02（Issue #47，所有权未释放）**
- 负责人（人类成员 / GitHub）：`huxiaoyang-code`
- 执行员工与显式模型：本机 pi，主 / 回退均 `tokenhub/deepseek-v4.1-flash`（未切换、未启用子 agent）
- 本机管理者：成员自己的 Codex（独立审查、提交、合并由其执行）
- 分支：`codex/huxiaoyang-code/local-08-adapter`（管理者从合并后 main 建立；员工未执行任何 Git 操作）
- 目标 / 验收 / 明确不做：见任务单 §2 / §4 / 非目标

## 2. 基线与已审核 head

- 本阶段分叉基线（本阶段起点 = 最新 main）：`b42bae9ae76e54aeda63bcc4db0dc34663286b7d`
- 上一阶段已审模块 head：`f211ace5b90e6dc5f240c8bb870ffbf5eb11662b`（PR #50 合并，merge 时间 2026-10-22T09:57:25Z）
- 本阶段改动：见 §4（9 个文件）；本阶段**已审源码 head `ba5d60115e52fa13805841d9abe07006b74b2c9c`**；从 main `98977e04bd24aa293074021802191814f8c2a1d2` 合入形成 head `e8b298e42224e2e1b884f7827e4c366881d22fc9`（该次合入仅添加 PR #55 六个 backup 文件，本包 9 路径逐文件不变）
- PR：[#57](https://github.com/huxiaoyang-code/youshu-fork/pull/57) 已 OPEN 并 attach；**merge SHA 待合并后补记**，不预报已合并；本次文档修改会产生新 head，管理者合并前再核 6 个源码 / 测试文件未变
- 重验范围：本阶段 3 个套件 + 受影响领域回归（§6）；接线 PR 需在最新 main 上再重跑并补端到端集成测试
- 交接对象：后续接线任务（Agent 工具 / HTTP / MCP 后端 / 本机 UI 读取入口），以及 LOCAL-02 合并后的新工具补项

## 3. 依赖契约

- 上游依赖：已合并的 `06-workbench/server/finance-output-policy.mjs`（策略 / 引用 / 能力通道 / 安全错误投影）。
- 本阶段给下游的契约（详见 [FINANCE-OUTPUT-BOUNDARY](../FINANCE-OUTPUT-BOUNDARY.md) §10 / §11）：

```js
// 适配层（06-workbench/server/finance-model-adapter.mjs，不 import agent-tools，避免循环）
import { createFinanceModelAdapter, callModelTool, PLAIN_MODEL_TOOLS, MODEL_TOOL_INVENTORY,
         FINANCE_QUERY_AVAILABLE, FINANCE_QUERY_UNIMPLEMENTED, UNIMPLEMENTED_MODEL_TOOLS } from "./finance-model-adapter.mjs";
const adapter = createFinanceModelAdapter({ executeRaw: (name, args) => callAgentTool(name, args), policy });
const envelope = await adapter.callModelTool(name, args); // 永远是信封，不抛原始异常
adapter.policy.localRead(envelope.localRef, { channel, accountSetId, operation: envelope.operation });

// 出站校验（05-reconstruction/codex/mcp/finance-mcp/finance-model-transport.mjs，纯函数）
import { validateModelEnvelope, parseModelEnvelope, transportFailure, classifyTransportFailure } from "./finance-model-transport.mjs";
```

- 关键信封字段：`ok` / `outputPolicy` / `channel:"model"` / `operation` / `operationCategory` / `scope` / `accountSetId` / `accountSetIdSource` / `projection` / `projectionDropped` / `localRef` / `refPersistence` / `refExpiresAt` / `refUnavailable` / `applied` / `needsLocalReview` / `appliedReason` / `rawValuesIncluded:false`（+ `adapter` / `tool` / `nodeId` / 静态 `catalog`）。
- 策略模块接口变化（未接线，无兼容影响）：新增导出 `summarizeQueryResult` / `summarizeWriteResult` / `ENUM_TOKENS` / `enumTokenOf` / `PROJECTION_NUMBER_LIMIT`；`SUPPORTED_OPERATIONS` query 12→19 / write 12→13；`ERROR_CODES` allowlist 增补；数组允许期间；`inspectRawValue` 只把「当前路径祖先」当循环（共享引用 DAG 合法，真循环仍拒），预算不变。
- 下游消费者：LOCAL-02（#47，共享入口）/ 后续集成任务 / 本机 UI 读取入口。

## 4. 允许修改的文件与文件所有权

- 本阶段实际改动（**精确 9 个文件**，5 既有 + 4 新增）：

| # | 文件 | 说明 |
|---|---|---|
| 1 | `06-workbench/server/finance-output-policy.mjs` | 扩普通工具 spec、无引用摘要出口、枚举出口、错误码、DAG 遍历修正；review5 导出 `PROJECTION_NUMBER_LIMIT`、`reconciles` 必需布尔 |
| 2 | `06-workbench/test/finance-output-policy.test.mjs` | 34 → 35 项（旧 34 + LOCAL-02 兼容 1；旧断言含义未削弱） |
| 3 | `06-workbench/server/finance-model-adapter.mjs` | 新增：普通工具 → 模型信封适配层（review5 补上下文必需期间 / 可表示 ID / 真实 `projectionDropped`） |
| 4 | `06-workbench/test/finance-model-adapter.test.mjs` | 新增：真实临时库 + 真实 `callAgentTool` 验收（19 → 20 项；新增 LOCAL-02 兼容回归） |
| 5 | `05-reconstruction/codex/mcp/finance-mcp/finance-model-transport.mjs` | 新增：纯出站信封校验 / 固定错误转换（review1 内置固定登记语义） |
| 6 | `05-reconstruction/codex/mcp/finance-mcp/finance-model-transport-test.mjs` | 新增：独立测试（16 → 17 项；新增 LOCAL-02 兼容回归） |
| 7 | `docs/FINANCE-OUTPUT-BOUNDARY.md` | 契约同步 |
| 8 | `docs/tasks/LOCAL-08.md` | 任务单同步 |
| 9 | `docs/handoffs/LOCAL-08.md` | 本文件 |

- 共享受控文件：**全部未触碰**（`accounting.mjs` / `coa.mjs` / `db.mjs` / `import-storage.mjs` / `server.mjs` / `agent-tools.mjs` / MCP `tools.mjs` / `backend.mjs` / `server.mjs` / 既有其它测试 / `scripts/test-all.mjs` / `package.json` / `public/*` / 共享索引文档）。
- 共享接线改动：未申请；须等 LOCAL-02（#47）释放所有权后按独立小 PR 推进。
- 未触碰：其他 worktree、`tax-browser` 现场、真实账套数据库、用户配置、凭据、私有采集目录。

## 5. 实现摘要、关键取舍与接口变化

- **适配层（`finance-model-adapter.mjs`）**：
  - 注入 `executeRaw(name, args)`；不 import `agent-tools.mjs`；不复制业务计算 / DB / 输入业务校验 / 事务。
  - `PLAIN_MODEL_TOOLS` 把全部普通工具分成 `static`（`finance_query_catalog` / `update_plan`）/ `context`（`account_context` / `finance_context_resolve`）/ `node_query`（`finance_query`）/ `query`（7 个，含 `period_end_check`）/ `batch_query`（`book_import_batch`）/ `write`（11 个，含 `asset_update`）/ `create`（3 个）；`UNIMPLEMENTED_MODEL_TOOLS` 固定未实现清单；`tax_*` 只做**精确拒绝**（`model_tool_tax_excluded`），前缀不是放行规则。以上未知 / 未实现 / 税务均**不执行** `executeRaw`。
  - `finance_query`：operation = `finance_query:<nodeId>`（nodeId 先校验登记表），只把真实 `data` 交给 spec；**每个 node 先做必需字段形状检查**（利润表 `current` / `ytd` 全部摘要字段、资产表 `assets`/`liabilities`/`totals` 数值等），否则 `model_result_invalid`，避免 wrapper / 变形 DTO 投影出全 0；非空投影兜底检查再建引用（`summarizeQueryResult` 先算一次，空即失败，不建引用）。policy 摘要对必需数值字段 / canonical 行同样严格，缺字段不再用 0 补齐。
  - **参数快照**：`callModelTool` 在任何 `await` 前深拷贝**只含自有 data 属性**的参数快照（不执行 getter、不跟随原型、拒绝循环 / 访问器 / 别名冲突 / 超深超量），预验与 `executeRaw` 使用同一份规范化 `accountSetId`；嵌套 `payload` / `entries` 也固定。调用方在异步挂起期间改 setId / 嵌套值不再串账。
  - **查询回显校验**：普通查询与 finance_query 结果若回显另一个账套，回 `model_scope_mismatch` 且不建引用。
  - 全局上下文：无 setId → `scope:"global"`，只给 ID / 计数 / 受控枚举 / 分页字段（默认 10、上限 32、`truncated` / `nextOffset`），**不建引用、不伪造 setId**；指定 setId → 真实归属校验（列表里没有即 `account_set_not_found`）+ 该账套期间计数；分页参数在**执行前**校验。
  - 建账类写：setId **只**从真实结果取（`account_set_create` → `id`；`legacy_book_import` → `created.id`；`book_import_incremental` → `created.accountSetId` / 顶层 / `batch.accountSetId`）；无可信 ID → 未绑定摘要（`accountSetId:null` / `localRef:null` / `refUnavailable:"not_applied"|"unbound_scope"`），不造假。
  - `book_import_batch`：账套只由 `batch.accountSetId` 决定；入参 setId 只核对，不匹配 `model_scope_mismatch`。
  - 普通写：setId 执行前校验；结果回显不符 → 保留真实 `applied`、不绑定引用（`scope_mismatch`）。
  - async 语义：预验 → `await executeRaw` **一次** → 包装；写失败分 `rejected_before_execution`（applied:false）与 `unverified_result`（applied:"unknown"）；只要不是 `applied:true` 都标 `needsLocalReview:true`，写后摘要 / 引用失败只降级，不重复写。
- **策略模块扩展**：9 个普通工具 query spec + `book_import_incremental` write spec；`summarizeQueryResult` / `summarizeWriteResult`（无引用、只回白名单投影）；`ENUM_TOKENS` / `enumTokenOf`；数组白名单允许期间（与标量一致）；`inspectRawValue` 用祖先集判循环（共享引用是合法 DTO，真循环仍拒）；query 摘要的必需字段 / 类型严格校验（缺字段失败，真 0 保留）；错误码 allowlist 增补适配层固定码、`account_set_id_conflict`、`accountSetId_required/invalid`、`items_required` 与 main 已有域码。**上限与既有 28 项语义未改**。
- **transport**：严格字段白名单（未知字段 / 敏感键分别固定码、不回显键名与值）；**每个允许字段在所有适用分支都完整校验**，不适用字段拒绝；契约版本 / `adapter` / channel / `rawValuesIncluded` 校验；operation / tool / nodeId / category / scope / appliedReason / 错误码 / 目录使用**内置固定登记语义**（调用方登记表只能进一步收紧）；projection 字符串只允许固定 token 或期间；`localRef` / `refPersistence` / `refExpiresAt` / `refUnavailable` 互斥规则；写信封强制 `applied` 三态且非 true 必须 `needsLocalReview` + 固定原因；`parseModelEnvelope` 对非 JSON / 非对象 / getter / Proxy 异常只回固定码；`transportFailure` 写场景 `retriable:false`，通用连接错误保守 `outcome/writeOutcome:"unknown"`，仅可证发前失败为 `not_sent`。
- **review1 五项独立审查返工**：F1 允许键完整校验 / 固定登记语义；F2 异步参数快照与查询回显校验；F3 摘要必需字段不用 0 伪造；F4 create/result + 真实大驼峰错误码；F5 写结果未知语义与合成回环验证。均已真实回归变红到绿（详见任务单 §8.1）。
- **review3 三项定向返工**：
  - **F1 transport**：`projectionDropped` 只要出现就独立验类型 / 非负整数上限，悬空计数与缺失伴随字段都拒绝（保留受控截断契约）；`accountSetIdSource` 与分支绑定；校验通过后只返回**重建纯数据副本**，所有层级访问器 / Symbol / 非普通原型 / `toJSON` 拒绝 → 可选 `tool` getter 的 `JSON.stringify` 泄漏路径关闭；
  - **F2 策略值域**：新增 `requirePeriod` / `requireEnumToken` / `requireChoice`，期间严格 `YYYY-MM`，状态 / 分类 / 方向 / 种类 / 批次 / 追溯固定枚举；逐点审 `requireText`，自由 ASCII 不能伪装成 token；
  - **F3 adapter 数据层 scope**：按 node 核对 `data.id` / `data.account_set_id` / 列表逐行，以及普通 `account_list` / `asset_list` 行；不一致 `model_scope_mismatch` 且不建引用；聚合节点不臆造必需字段。
  - 成功 create 信封明确 `operationCategory:"create"` / `scope:"result"` / `accountSetIdSource:"result"`。
- **review4 最后副本一致性定向修正**：`validateEnvelope` 原先「先校验原对象、再快照原对象」，返回的副本未校验；现改为**先生成有界纯数据快照 → 对同一快照完整校验 → 只返回该快照**（第一遍原对象校验只用于沿用旧固定错误码），getter 不执行 / 非普通原型 / Symbol / `toJSON` / 函数 / 深度与大小上限全部保留。transport 14 → 15/15（旧顺序实跑新回归会变红）。详见任务单 §8.3。
- **review5 三项 P2 定向返工**：① scoped `account_context` 的 `start_period` 改为必需合法月份（与 global 一致，非法 / 缺失 `model_result_invalid`）；② global / scoped 上下文对超出 projection 数值上限（1e12）的 ID **明确拒绝**，不静默删 `accountSetIds`，`projectionDropped` 改为 `sanitizeProjection` 真实计数；`enterprise_account.account_set` 的 `data.id` 同属选择信息也按同一上限校验；③ 现金流 `reconciles` 改为必需布尔（缺失 / 类型错即失败，真 `false` 保留）。详见任务单 §8.4。
- 关键取舍（放弃的方案与原因）：
  - 放弃「适配层自己写一套投影」：所有成功结果统一走策略模块的白名单 spec，避免两套规则漂移；
  - 放弃「用 `policy.runWrite` 包 async 回调」：那会在写发生前就把 Promise 当结果包装；改为显式 `await` 一次 + 手写降级；
  - 放弃「用入参 `accountSetId` 给 create 绑定」：会造假 ID / 错绑账套；只认真实结果字段；
  - 放弃「全局上下文塞进某个账套引用」：那会把多个企业原文挂到一个 setId 上；全局结果不建引用；
  - 放弃「空投影当成功」：未知 node 明确拒绝；已知 node 的 DTO 变形明确 `model_result_invalid`；
  - 放弃「DAG 视作循环」：真实增量导入结果共享 `sourceTrace` 数组，视为循环会导致主工具投影全空；改为只判真循环，上限不变；
  - 放弃「直接使用调用方 args 对象」：异步挂起期间会被改成另一个账套；改为在任何 await 前做有界深快照；
  - 放弃「transport 只靠调用方登记表」：忘传就退化成只校验形状；改为内置固定登记语义，调用方只能收紧；
  - 放弃「缺失摘要字段按 0 算」：会把变形 DTO 伪装成真实报表；缺必需字段即失败；
  - 放弃「transport 回显 status / URL / 字段名」：只给固定常量，避免二次泄漏；
  - 放弃「用 `tax_` 前缀放行」：税务链路保持既有行为，适配层只拒绝不接管。
  - 放弃「把超上限账套 ID 编码成字符串 / 抬高 projection 数值上限」：那会改写 transport 的投影值域并连带放宽金额上限；改为**明确拒绝不可表示的选择信息**（`model_result_invalid`）。
- 显式限制：不持久化引用、无多用户 / 权限体系、引用跨重启失效；投影 / 本机算术是「可用数值」，不替代 `accounting.mjs` 会计口径；projection 数值上限 1e12 也是**账套选择 ID 的可表示上限**（超界明确拒绝，不静默截断）；**未挂载**，因此当前真实入口仍返回原文。

## 6. 员工自测记录（事实，已发生）

| 套件 | 命令 / 工作目录 | 结果 |
|---|---|---|
| 策略模块 | `node test/finance-output-policy.test.mjs` / `06-workbench` | `37/37 passed`，exit 0（输出协议 2 项 P2 回修后本轮实跑；原 35 项含义保留） |
| 适配层 | `node test/finance-model-adapter.test.mjs` / `06-workbench` | `21/21 passed`，exit 0（回修后本轮实跑；原 20 项含义保留） |
| transport | `node 05-reconstruction/codex/mcp/finance-mcp/finance-model-transport-test.mjs` / 仓库根 | `18/18 passed`，exit 0（回修后本轮实跑；原 17 项含义保留） |
| 领域回归 | `node test/accounting-guards.test.mjs` / `06-workbench` | `23/23 通过`，exit 0 |
| 领域回归 | `node test/accounting-derived.test.mjs` / `06-workbench` | `31/31 通过`，exit 0 |
| 领域回归 | `node test/import-incremental.test.mjs` / `06-workbench` | `49/49 通过`，exit 0 |
| HTTP / Agent 回归 | `node test/smoke.test.mjs` / `06-workbench` | `28/28 通过`，exit 0 |

- 适配层测试隔离：**先**建全新临时 `WORKBENCH_DATA_DIR`，**再**动态 import 真实 `accounting.mjs` / `agent-tools.mjs`；注入真实 `callAgentTool` 实际执行；3 个基础账套 + 建账类工具新建账套；合成敏感标记覆盖企业名 / 科目名 / 科目编码 / 摘要 / 往来 / 人员 / 资产名 / 源路径 / 企业身份 / 批次 ID / 来源系统；断言所有模型返回 / 转换错误 / 捕获日志无标记；结束删除临时目录。
- 未运行：完整 `scripts/test-all.mjs`（新套件**未登记**进该共享文件，属 LOCAL-02）。

### 6.1 LOCAL-02 兼容增量（上一轮）+ 输出协议 2 项 P2 回修（本轮，待 root 独立增量复审）

- `period_end_check` 登记只读 `query/account_set`：形状按真实 `buildPeriodEndCheck` 校验（**7 个已登记步骤唯一齐全**、状态仅 `ok` / `blocked` / `not_applicable`、每条顶层 `blocking` 归属真实 blocked 步骤、`ready` ⇔ 无阻塞）；投影只含 `period` / `ready` / 步骤状态计数 / blocked 步骤 id / 阻塞计数 / 固定阻塞码，原始标题 / 原因 / `message` / `details` / 资产名 / 科目名 / 备注不进入模型通道；未知值 fail closed。
- **P2-1（本轮回修）长阻塞码**：白名单里的 `depreciation_life_expired_underprovided`（39 字符）/ `previous_period_depreciation_pending`（36 字符）此前被通用 32 字符 token 预算丢弃（`ok:true` / `blockingCount:1` / `blockingCodes:[]` / `projectionDropped:1`）。现只给**已登记固定代码常量的精确字面量**开窄通道（`REGISTERED_CODE_LITERALS` / `isProjectionStringAllowed`），通用 token 预算与 40 字符上限均未放宽；9 个真实阻塞码逐条回归，未知码 / 未登记 37 字符串 / 41 字符串 / 中文原文仍被丢弃或拒绕。
- **P2-2（本轮回修）DTO 全局一致性**：新增纯函数 `isPeriodEndCheckConsistent`（policy 内，**不 import** 会开业务 DB 的 `period-end-controls.mjs`）；`ready:true + steps:[]`、7 个重复 `draft_vouchers`、`ready:true` + 全 blocked 且 `blocking` 非空、缺步 / 多步 / 阻塞归属错步骤均 `model_result_invalid` 且不建引用（引用池不变）；一个步骤可有多条真实原因，不机械比较条数。
- `asset_update` 登记写 `write/account_set`：显式写调用才执行，成功必须真实 `id` 才 `applied:true`，失败保留 `applied:"unknown"` + `needsLocalReview:true`；投影最小白名单不含名称 / `ledger_note` / 科目 / 备注。
- 新领域错误与 `period_end_check_failed` 在 policy / transport 两层均有固定 code → category 映射，不再落 `unknown`。
- 真实临时库验收：资产原值 1200、取得 / 起提 2026-02、借贷平衡购入凭证、真实计提 95，保留**真实封账成功**与 `period_end_check_failed` **前置拒绝**两条路；`asset_update` 正例 + `acquired_period` 非法负例；自由文本注入不泄漏。本轮新增真实 7 步正例（账套 `2026-01` 起账 → 1 期寿命导入卡片`2026-02` 取得 / `2026-01` 起提 → `2026-03` 真实购入凭证）：`blockingCount:3` / `blockingCodes:['depreciation_life_expired_underprovided','previous_period_depreciation_pending','previous_period_open']` / `projectionDropped:0` / transport 通过。
- 定向输出（本轮回修后实跑）：策略 **37/37**、适配层 **21/21**、transport **18/18**，均 exit 0；原 35 / 20 / 17 项含义未削弱。之前的完整 `npm test` **55/55 套 exit 0**（Office **21/21**、真实 **11 PDF**）属**上一轮**结果，与本轮回修后的完整重跑分开读（本节不把上一轮 55/55 当作回修后通过）。
- 边界保持：错误清洗 / 参数快照 / 引用绑定与失效 / 预算 / 写后降级 / 并发隔离未改；**未挂真实 HTTP / Agent / MCP / CLI 入口**。状态：**回修候选，待 root 独立增量复审**；仍未提交 / 未建 PR。
- 管理者实跑（事实，上一轮）：策略 **35/35**、适配层 **20/20**、transport **17/17**，均 exit 0（LOCAL-02 兼容后；原 34/19/16 项含义保留）；最终独审 `review_output08_final` 未参与实现，原 3 项 P2 全关，独立探针 **57/57** 通过（**不等于三套测试用例总数**）；transport 最后副本一致性复核通过。该 55/55 对应 head `04c38d4`；本轮回修在其后，**不沿用为回修后的完整门禁**。
- 管理者实跑（事实）：策略 **35/35**、适配层 **20/20**、transport **17/17**，均 exit 0（LOCAL-02 兼容后；原 34/19/16 项含义保留）；最终独审 `review_output08_final` 未参与实现，原 3 项 P2 全关，独立探针 **57/57** 通过（**不等于三套测试用例总数**）；transport 最后副本一致性复核通过。
- review1：F1–F5 均已真实回归变红到绿；review3：F1–F3 定向回归（transport 14/14、适配层 17/17、策略 32/32）；review4：transport 改为「快照→校验同一快照→只返回它」并新增可变反射一致性回归（旧顺序实跑 `14/15` 变红，修正后 `15/15`；适配层 17/17、策略 32/32）；review5：上下文必需期间 / 可表示 ID 与现金流 `reconciles` 必需布尔均新增回归（策略 34/34、适配层 19/19、transport 16/16）。以上四轮均已纳入已审 head `ba5d601`，旧断言一块未删。

## 7. 真实数据边界

- 是否触碰真实账套 / 凭据：**否**。
- 临时数据目录 / 合成样例：**只在新临时目录**（系统临时目录下的随机子目录）建合成账套；`git status` 无临时库 / 日志入库。
- 是否访问真实税局 / 外部系统：**否**；未启动税局浏览器 / 后端，未调用任何税务工具。
- 凭据 / 会话 / 验证码：未涉及，未记录。
- 仓库文档不写本机绝对路径 / 进程 ID / 私有日志：是。

## 8. 自动合并权限 / 协调记录

- 自动合并：按项目授权由已登记成员自己的本机 Codex 审查后执行；本文件不构成合并证据。
- 跨成员评审：本阶段未改共享入口，但属数据边界高风险面，建议按任务单 §4 的 1–12 条独立复跑 / 逐项核对；按协议可由成员本机 Codex 自审后合并，跨成员评审可选。
- 合并协调：与 LOCAL-01（#43，已合并）无文件交集；**接线必须先与共享入口所有者 LOCAL-02（#47）协调**，并按独立小 PR 推进。
- 已知限制：GitHub 不能原子锁 base；transport 测试跨目录 import 适配层（与本仓库既有 MCP 测试跨目录 import 06-workbench 的做法一致）。
- 仓库设置 / 权限变更：未触发。

## 9. 未完成项、风险与下一部分输入

- 未完成项（**均未实施，不得写成已完成**）：
  1. **共享文件接线**：`agent-tools.mjs` 改走适配层、`server.mjs` 错误分支改安全投影、MCP `backend.mjs` / `server.mjs` 接 `finance-model-transport`、本机回环读取入口；
  2. 把 3 个套件登记进 `06-workbench/scripts/test-all.mjs`；
  3. 真实 HTTP → Agent → 模型信封不含原文 + 本机通道可取原文的端到端集成测试；
  4. **LOCAL-02 新期末 / 资产补项工具（已在现有可测试边界补齐，未接线）**：`period_end_check` 只读、`asset_update` 写、资产补项最小白名单投影、新错误码固定映射均已在 adapter / transport 合约内实现并通过定向测试；真实 HTTP / Agent / MCP 入口仍未接线，待共享入口移交后做端到端。
  5. **PR #57 待合并**：最终独审（`review_output08_final`，未参与实现）已关闭原 3 项 P2、独立探针 57/57 通过，管理者三层实跑 exit 0；PR [#57](https://github.com/huxiaoyang-code/youshu-fork/pull/57) **已 OPEN 并 attach**，按已授权流程待本次文档核对后合并；**尚无 merge SHA，不写已合并**。
- 风险 / 阻塞：
  - 未接线前**本契约不生效**，当前模型入口仍原样返回企业名 / 科目名 / 凭证行；
  - 接线时若把 `localRead` 误挂到 `/agent/tools/*` 或 MCP，会立刻形成「模型取原文」的洞：接线评审必须逐条核对契约 §9；
  - 引用仅进程内；UI 进程与后端进程分离时需在同一进程内签发 channel，或另行设计（本阶段未做）；
  - 预算（256 refs / 单值 20 万节点 / 4 MiB / 累计 100 万节点 / 64 MiB / 15 分钟）是本地策略；真实大账套可能在单值字节或节点上限碰顶，接线时需用真实量级校核并记录调整依据，**不得默默调大后当成已验收**；
  - 写后降级会丢引用（`localRef:null`），本机需自行查证时只能靠 `accountSetId` + 操作原结果重建；
  - transport 的 operation / tool / nodeId / 错误码 / 目录是**模块内置固定登记语义**；调用方另传登记表只能进一步收紧，不传也不会退化成只校验形状。接线时仍建议用 `PLAIN_MODEL_TOOLS` + `FINANCE_QUERY_AVAILABLE`（含未实现 node）交叉核对，防止两层登记漂移。
- 下一部分输入：读 [FINANCE-OUTPUT-BOUNDARY](../FINANCE-OUTPUT-BOUNDARY.md) §9 / §10 / §11 / §13；**先取 LOCAL-02 的共享文件所有权确认**，再按 §9 顺序接线。LOCAL-02 兼容增量已在现有可测试合约内补齐，但**未挂真实入口**，不得写成已接线 / 已端到端验收。
- 回退：`revert` PR（禁止重写 main 历史）；适配层与 transport 未被引用，回退对既有行为零影响。

## 10. 进程 / 会话 / 日志

- 仍运行进程：本次员工侧无子进程残留。本轮文档核对全部为前台只读命令（`git log` / `git status` / `git diff --check` / 文档检查），均已结束；此结论仅限本次员工会话，不代表全仓没有其他成员正在运行的员工。
- 临时探针：核对 DTO 形状 / 循环引用 / 合成分页时跑过一次性 `node -e` 脚本，用完即弃；未建临时文件进仓库。
- 原始日志：员工输出与管理验收日志保存在本机被 Git 忽略的管理目录；版本化文档只记录脱敏摘要。
- 上下文：本阶段完成后按章程关闭本员工会话；下一部分 / 复核使用新进程、新会话（`--no-session`），只载入任务单、契约与必要源码。

---

授权继承自 [项目章程](../PROJECT-CHARTER.md) 和用户后续指示，交接不能扩大授权。
协作与文件所有权规则见 [团队协作协议](../TEAM-COLLABORATION.md)。
