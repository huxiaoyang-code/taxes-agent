# 任务单 · LOCAL-08 财务输出边界（模型摘要 / 本机读取分道 + 普通工具适配层）

- 类型：独立后端模块 + 适配层 + 出站信封校验 + 独立验收测试 + 契约文档
- 状态（分段，**不要混读**）：
  1. **纯策略模块已合并**：经独立审查后由 [PR #50](https://github.com/huxiaoyang-code/youshu-fork/pull/50) 合并（已审 head `f211ace5b90e6dc5f240c8bb870ffbf5eb11662b`，merge / main `b42bae9ae76e54aeda63bcc4db0dc34663286b7d`，2026-10-22T09:57:25Z）；
  2. **本阶段（适配层 + transport）已实现、已提交并推送，PR 待合并**：普通工具适配层 + 真实（临时库）调用验收 + MCP 出站信封校验；**已审源码 head `ba5d60115e52fa13805841d9abe07006b74b2c9c`**，管理者实跑策略 **34/34**、适配层 **19/19**、transport **16/16** 均 exit 0；最终独审 `review_output08_final` 未参与实现，原 3 项 P2 全关，独立探针 **57/57** 通过（**不等于原三套测试共 69 个用例**）。**HTTP / Agent / MCP / CLI 仍未接线**，共享入口（`agent-tools.mjs` / `server.mjs` / MCP 注册与传输 / `scripts/test-all.mjs`）归 **LOCAL-02（Issue #47）**，本轮未改；Issue #44 **保持 OPEN**。
  2b. **LOCAL-02 兼容增量（本轮，未提交 / 未建 PR）**：`period_end_check` 只读、`asset_update` 写已按真实 DTO 登记进现有可测试 adapter / transport 合约；投影只含固定步骤 / 状态 / 计数 / 固定阻塞码与资产最小白名单（不含 `ledger_note` / 名称 / 科目 / 任意用户文本）；新领域错误与 `period_end_check_failed` 有固定 code → category 映射。定向输出策略 **35/35**、适配层 **20/20**、transport **17/17**，均 exit 0；原 34 / 19 / 16 项含义保留。**仍未挂共享 HTTP / Agent / MCP 入口**，待 root 最终增量独审 / PR。
  3. **PR [#57](https://github.com/huxiaoyang-code/youshu-fork/pull/57) 已 OPEN 并 attach**：从 main `98977e04bd24aa293074021802191814f8c2a1d2` 合入形成 head `e8b298e42224e2e1b884f7827e4c366881d22fc9`，该次合入仅添加 PR #55 的六个 backup 文件，本包 9 路径与 `ba5d601` 逐文件不变；**尚无 merge SHA，按已授权流程待文档核对后合并**（本次文档提交产生新 head，管理者合并前再核 6 个源码 / 测试文件未变）。
  4. **历史（review1 / review3 / review4 / review5）**：四轮定向返工当时均为「已实现并自测通过、未提交 / 未推送 / 未独审」，现均已纳入已审 head `ba5d601` 并通过最终独审；问题与修复证据保留在 §8.1–§8.4，按其时点阅读，不再代表当前提交 / 审查状态。
- 负责人（人类成员 / GitHub）：`huxiaoyang-code`
- 实际分支：`codex/huxiaoyang-code/local-08-adapter`（由管理者从上述 main 建立；员工未执行任何 Git 操作）
- 交付契约：[FINANCE-OUTPUT-BOUNDARY](../FINANCE-OUTPUT-BOUNDARY.md)；交接：[handoffs/LOCAL-08](../handoffs/LOCAL-08.md)
- 关联：Issue #44（保持 OPEN）；共享入口现归 LOCAL-02（#47，所有权未释放），其新期末 / 资产补项工具**未稳定前不实现**

## 1. 基本信息

- 执行员工：本机 pi（主 / 回退模型均显式锁定 `tokenhub/deepseek-v4.1-flash`，未切换、未启用子 agent）
- 本机管理者：成员自己的 Codex（独立读 diff、跑验证、写 PR 正文、执行 Git）
- 工作目录：`<repo>/.worktrees/local-08`
- 本阶段精确可写范围：**9 个文件**（5 既有 + 4 新增），见 §5

## 2. 需求（用户 / 目标）

- 目标：在不改共享入口的前提下，把普通财务工具的结果**接到**已合并的双通道策略上：
  1. 适配层注入 `executeRaw(name, args)`（生产注入真实 `callAgentTool`），**不 import `agent-tools.mjs`**（避免循环），不复制业务计算 / DB 访问 / 输入业务校验 / 事务；
  2. 盘点本 `main` 全部普通财务工具与 `finance_query` 已实现 node，逐项标为投影 / 固定静态安全目录 / 明确未实现；未知普通工具**默认拒绝且不执行**；税务工具固定单列、不执行、不以任意 `tax_` 前缀放行未知操作；
  3. `finance_query` 真实返回 `{nodeId,label,data}`：只把 `data` 交给白名单 spec，并按真实 DTO 做必需字段形状检查，避免「wrapper 当报表 → 金额静默 0」；未知 / 未实现 node 显式安全错误且不执行；
  4. `account_context` / `finance_context_resolve` 是合法全局操作：无 setId 时单独明确 `global scope`，只给必要 ID / 计数 / 枚举，无企业名；超数量用**有界分页 / 截断**并保留选择能力；指定账套时真实校验归属；
  5. 建账类写动作（`account_set_create` / `legacy_book_import` / `book_import_incremental`）**只能**从真实结果绑定 setId；dry-run / 未建账给明确未绑定摘要；`book_import_batch` 由真实结果确定 setId，入参 setId 只核对不替换；
  6. async 写语义：**禁止** `policy.runWrite(() => callAgentTool(...))`；执行前完成可预验约束 → `await` 真实写一次 → 再包装；写后摘要 / 引用失败只降级，保留 `applied` 三态与可查证 ID，不重复写；执行前拒绝与执行后未知诚实区分；
  7. MCP transport 模块只做纯出站信封校验与固定错误转换：严格字段 / 值校验，`message`/`details`/`stack`/`path`/`API_BASE`/额外字段不穿出，非 JSON / 非 2xx / 未知错误按固定常量，写结果未知不误导重试；验证器不能设计成总拒绝有意义的成功结果；
  8. 保持策略模块本机读取 / 受限计算 / 账套+operation+TTL 绑定，`localRead` / `localCompute` 不登记为模型 / MCP 工具；`local:true` 或字符串 channel 不提供权限；4 MiB / 64 MiB 与节点上限不调大；引用跨重启失效如实记录。
- 非目标：
  - 不改 `agent-tools.mjs` / `server.mjs` / MCP `tools|backend|server` / `scripts/test-all.mjs` / `package.json` / `public/*` / `db.mjs` / `import-storage.mjs` / `accounting.mjs`；
  - 不做引用落盘 / 跨重启持久化、多用户 / 权限体系、审计落库；
  - 不新增依赖、不新增 MCP 工具、不把本机读取能力暴露成模型可调用工具；
  - 不为 LOCAL-02 尚未合并的新期末 / 资产补项工具按草稿伪造实现（登记为待补，见 §6）。
- 已知未知：真实 HTTP / MCP 挂载后的端到端表现；LOCAL-02 新工具最终入口名与 DTO。

## 3. 输入 / 输出

- 输入（既有领域结果，形状对齐 `accounting.mjs` / `agent-tools.mjs` / `import-incremental.mjs`）：查询 DTO、写结果、上下文结果、批次审计结果、导入结果。
- 输出：
  - 适配层：模型通道信封（`projection` + `localRef` + 写动作 `applied` 三态 + `refUnavailable` 降级原因），失败信封（固定 `error.code`），静态目录（代码常量 nodeId 数组）。
  - transport：`{ ok:true, envelope }` / `{ ok:false, failure:{ error:{code,retriable,messageKey}, outcome, forWrite? } }`。
- 文件范围（精确 9 个）：

| # | 文件 | 类型 |
|---|---|---|
| 1 | `06-workbench/server/finance-output-policy.mjs` | 既有（本阶段扩 spec / 出口 / 错误码 / 遍历修正；review5 导出数值上限、`reconciles` 必需布尔） |
| 2 | `06-workbench/test/finance-output-policy.test.mjs` | 既有（32 → 34 项，旧 32 项含义保留） |
| 3 | `06-workbench/server/finance-model-adapter.mjs` | **新增**（review5 补上下文必需期间 / 可表示 ID / 真实 `projectionDropped`） |
| 4 | `06-workbench/test/finance-model-adapter.test.mjs` | **新增**（真实临时库；17 → 19 项，含 review5 上下文 / 现金流回归） |
| 5 | `05-reconstruction/codex/mcp/finance-mcp/finance-model-transport.mjs` | **新增** |
| 6 | `05-reconstruction/codex/mcp/finance-mcp/finance-model-transport-test.mjs` | **新增**（15 → 16 项，含 ID 可表示性边界） |
| 7 | `docs/FINANCE-OUTPUT-BOUNDARY.md` | 既有（契约同步） |
| 8 | `docs/tasks/LOCAL-08.md` | 既有（本文件） |
| 9 | `docs/handoffs/LOCAL-08.md` | 既有（交接同步） |

## 4. 验收标准

- 适配层（真实临时库，不是 fake DTO）：
  1. **全新临时 `WORKBENCH_DATA_DIR` 先设，再动态 import 真实 `accounting.mjs` / `agent-tools.mjs`**，注入真实 `callAgentTool` 实际执行；至少两家企业各一账套（实际 3 个基础账套 + 3 个建账类工具新建账套）。
  2. 覆盖普通工具分类（投影 / 静态 / 上下文 / 写 / 建账 / 未实现 / 税务 / 未知）与 **全部 12 个已实现 `finance_query` node**；投影金额与**手算常量**一致（期初 1000/1000；V1 1000；V2 300；资产 1200×95%÷12=95；利润 1000/700 等）。
  3. 主要写实际落库、**只执行一次**（执行计数断言）；`applied` 三态正确；`legacy_book_import` 默认 dry-run 不建账套、正式建账后 setId 来自真实结果；`book_import_incremental` preview / applied / idempotent_replay / conflict 全部覆盖且不重复写；`book_import_batch` 由真实结果确定账套、入参不匹配安全拒绝。
  4. 全局与指定账套上下文：`global scope` 不伪造 setId、分页截断可继续选择、无企业名；指定账套真实归属校验。
  5. 所有模型返回、转换错误、测试捕获日志**都不含**合成敏感标记（企业名 / 科目名 / 科目编码 / 摘要 / 往来 / 人员 / 资产名 / 源路径 / 企业身份 / 批次 ID / 来源系统）。
  6. 失败路径：未知工具、税务工具、未实现工具、未知 / 未实现 node、缺账套、非法账套、非法分页都**执行前拒绝**（计数 0）；async 拒绝 / 同步抛错 / 写后投影失败都只执行 1 次，写后失败保留 `applied` 并降级引用。
  7. 引用安全：跨账套、换 operation、缺 operation、伪造 / 字符串 / 克隆 channel、伪造 ref、过期 ref 全部拒绝；本机通道仍能读原文并做受限算术（明细账 `entries.[].debit` 合计手算一致）。
  8. 保持 4 MiB 单值 / 64 MiB 累计 / 节点预算（测试用超 4 MiB 字符串验证**未调大**）。
- transport（纯函数，独立测试）：
  9. 适配层真实产出的查询 / 写 / 静态 / 上下文成功信封都能通过校验；失败信封也能通过；**不是**「总是拒绝」。
  10. 敏感 / 未知额外字段、错误契约版本、非 `model` channel、`rawValuesIncluded:true`、未登记 operation / nodeId、畸形 projection / ref / applied 全部拒绝，且不回显字段名或值。
  11. 非 JSON / 空 / 数组响应回固定码，不回声响应片段；运输失败固定常量，写场景 `retriable:false` + `writeOutcome:"unknown"`。
- 策略模块：
  12. 既有 28 项含义不削弱（实际仍全过），后续新增覆盖：数组接受期间、普通工具 DTO spec + 无引用摘要、共享引用（DAG）合法 / 真循环仍拒绝，以及 review3 的投影期间 / 状态固定值域。
- 回归：实跑领域回归（见 §8），并在报告中写清未测范围（真实 HTTP / MCP 挂载、真实账套、跨重启）。
- 验证命令与期望：

```bash
cd 06-workbench
node test/finance-output-policy.test.mjs      # 35/35 passed, exit 0
node test/finance-model-adapter.test.mjs      # 20/20 passed, exit 0

# 仓库根目录
node 05-reconstruction/codex/mcp/finance-mcp/finance-model-transport-test.mjs   # 17/17 passed, exit 0
```

- 不通过处理：退回同一员工修复，记录阻塞；不得删改旧断言或放宽到「只要不报错」。

## 5. 文件所有权与共享改动协商

- 本阶段**只改/增 §3 表格中的 9 个文件**。**未触碰**任何共享受控文件：`accounting.mjs`、`coa.mjs`、`db.mjs`、`import-storage.mjs`、`server.mjs`、`agent-tools.mjs`、MCP `tools.mjs` / `backend.mjs` / `server.mjs` 及其它既有测试、`scripts/test-all.mjs`、`package.json`、`public/*`、`docs/INDEX.md`、`docs/handoffs/STATE.md`、`docs/tasks/README.md`。
- 共享入口现归 **LOCAL-02（Issue #47，所有权未释放）**；本阶段不申请其所有权，接线（含把 3 个套件登记进 `scripts/test-all.mjs`）必须在其释放后走独立小 PR。
- 新模块归属：`finance-output-policy.mjs` 与 `finance-model-adapter.mjs` 为 LOCAL-08 独占新增/维护模块；`finance-model-transport.mjs` 是 MCP 目录下的**新增独立纯函数模块**（不属 LOCAL-02 修改范围，未改任何既有 MCP 文件）。
- 策略模块本阶段的接口变化（未接线，无兼容影响）：
  - `SUPPORTED_OPERATIONS.query` 12 → 19、`write` 12 → 13（新增普通工具 spec）；
  - 新增导出 `summarizeQueryResult` / `summarizeWriteResult` / `ENUM_TOKENS` / `enumTokenOf` / `PROJECTION_NUMBER_LIMIT`；
  - `ERROR_CODES` allowlist 增补适配层固定码与 main 已有域码；
  - 数组白名单允许「期间」（与标量规则一致）；`inspectRawValue` 改为**只把当前路径祖先集当循环**，共享引用（DAG）合法，真循环仍拒绝；节点 / 字节 / 深度 / 数组上限不变。

## 6. 依赖 / 基线 / 阻塞路径

- 前置（已完成）：纯策略模块已审并合并（PR #50 / merge `b42bae9` / 已审 head `f211ace`）。
- 阻塞路径：真实入口接线依赖 **LOCAL-02（Issue #47）** 释放共享文件（所有权尚未释放）；不因此改共享文件，也不建替代入口。
- 待 LOCAL-02 合并后补的入口（**明确登记，不预报**）：其新期末 / 资产补项工具的具体工具名与 DTO 尚未稳定 → 本阶段不写占位 spec、不登记映射（未登记即 `model_tool_unknown`，不会误执行）；合并后按真实 DTO 一次补齐映射 + spec + 形状检查 + 测试。
- 基线更新时重验范围：若后续 main 改动 `accounting.mjs` / `agent-tools.mjs` 返回结构，需重跑本阶段 3 个套件并核对投影 spec 与形状检查。

## 7. 成员 / 执行员工模型

- 人类成员：本机任务派工方；执行员工本机 pi。
- 执行员工模型：主 / 回退均 `tokenhub/deepseek-v4.1-flash`（显式锁定）。
- 是否使用其他模型 / 子 agent：**否**。
- 管理者是否独立于员工做内容审查：**由管理者在本阶段完成后执行**（本文件不代替审查结论）。
- 管理者是否直接补写业务代码 / 测试 / 交付文档：**否**（如有缺陷退回员工）。

## 8. 验证记录

- 本阶段员工自测 + 管理者 / 独审证据（**事实，已发生**）：

| 套件 | 命令（工作目录） | 结果 |
|---|---|---|
| 策略模块 | `node test/finance-output-policy.test.mjs`（`06-workbench`） | `35/35 passed`，exit 0（LOCAL-02 兼容后；review5 时点 34/34） |
| 适配层 | `node test/finance-model-adapter.test.mjs`（`06-workbench`） | `20/20 passed`，exit 0（LOCAL-02 兼容后；review5 时点 19/19） |
| transport | `node 05-reconstruction/codex/mcp/finance-mcp/finance-model-transport-test.mjs`（仓库根） | `17/17 passed`，exit 0（LOCAL-02 兼容后；review5 时点 16/16） |
| 领域回归 | `node test/accounting-guards.test.mjs`（`06-workbench`） | `23/23 通过`，exit 0（上一轮记录；review5 未重跑） |
| 领域回归 | `node test/accounting-derived.test.mjs`（`06-workbench`） | `31/31 通过`，exit 0（上一轮记录；review5 未重跑） |
| 领域回归 | `node test/import-incremental.test.mjs`（`06-workbench`） | `49/49 通过`，exit 0（上一轮记录；review5 未重跑） |
| HTTP / Agent 回归 | `node test/smoke.test.mjs`（`06-workbench`） | `28/28 通过`，exit 0（上一轮记录；review5 未重跑） |

- 未运行：完整 `scripts/test-all.mjs`（新套件未登记进该共享文件，属 LOCAL-02；无意义多跑）。
- 适配层测试隔离与数据：**先**建全新临时 `WORKBENCH_DATA_DIR`，**再**动态 import 真实模块；测试结束删除临时目录；未读旧后端、未连真实账套、未联网。
- 管理者实跑（事实）：策略 **35/35**、适配层 **20/20**、transport **17/17**，均 exit 0（LOCAL-02 兼容后；原 34/19/16 项含义保留）。
- 最终独审 `review_output08_final` **未参与实现**：原 3 项 P2 全部关闭，独立探针 **57/57** 通过（**57 为独审探针项数，不等于原三套测试共 69 个用例**）；此前 transport 最后副本一致性复核亦通过。PR [#57](https://github.com/huxiaoyang-code/youshu-fork/pull/57) **已 OPEN 并 attach**，尚无 merge SHA。上一阶段（纯策略模块）审查证据保留：首轮 22/22 审查未过 → 修复 5 项后 28/28，管理者与不参与实现的独立 reviewer 各自实跑通过，PR #50 合并。

### 8.1 review1 五项独立审查返工（历史记录）

| 项 | 修复 | 真实回归 |
|---|---|---|
| F1 | transport 每个允许键在所有适用分支完整校验；adapter 版本 / operation / tool / nodeId / category / scope / appliedReason / 错误码 / 目录内置固定语义；projection 只允许固定 token 或期间；getter / Proxy 异常固定失败 | 普通 JSON 负例覆盖成功 / 失败 / write / global / static / catalog / error；真实适配层成功与失败信封仍能通过；11/11 |
| F2 | 任何异步边界前深拷贝自有 data 属性快照；拒绝访问器 / 原型 / 别名冲突 / 超量；嵌套 payload 固定；查询回显账套不匹配不建引用 | 真实 `callAgentTool` 两账套 A/B：查询改 setId、写改 setId + 改嵌套 entries，断言实际两库行与 ref 所属；参数复用 / 原型 / 别名 / getter 负例；15/15 |
| F3 | 全部 query 摘要必需字段 / 类型严格校验；缺字段明确失败，不用 0 冒充；真 0 保留 | 真实利润表删除 `data.ytd["营业收入"]`、试算表删除 totals 字段均返回 `model_result_invalid`；真零值收入仍成功；15/15 |
| F4 | 统一 operationCategory（含 create / node_query / batch_query / unimplemented）、scope（含 result）、固定错误码映射与大驼峰真实码 | 真实 `account_set_create({})`、无效 `book_import_incremental`、缺 nodeId / voucherId、领域查询错误与 dry-run 正例全部通过 transport；11/11 |
| F5 | 写场景通用连接错误保守 `outcome/writeOutcome:unknown`；仅可证发前失败为 `not_sent`；写操作不自动重试 | 纯函数回归 + 全新合成回环服务（请求发出后断连）验证；11/11 |

- **（历史）**当时未提交 / 未推送 / 未合并，也不得把当时自测写成最终独立审查通过；现均已纳入已审 head `ba5d601`。
- 仍未完成：共享 HTTP / Agent / MCP / CLI 接线（LOCAL-02 #47 释放所有权后另行小 PR）、3 个套件登记进 `scripts/test-all.mjs`、LOCAL-02 合并后的新期末 / 资产补项工具（工具名与 DTO 稳定后按真实 DTO 补映射 + spec + 测试）。

### 8.2 review3 三项定向返工（历史记录）

| 项 | 残留复现 | 修复 | 真实回归 |
|---|---|---|---|
| F1（P1） | transport 只在 `projection` 存在时验 `projectionDropped`：真实失败写信封删 `projection` + 对象型 `projectionDropped` 仍 `ok:true` 返回原文；合法 query 信封可选 `tool` 换成 enumerable getter 被当缺省，返回原对象后 `JSON.stringify` 触发泄漏 | 每个出现的允许键独立验类型 / 值域 / 分支语义；悬空 `projectionDropped` 与缺失伴随字段拒绝；`accountSetIdSource` 与分支绑定；校验后只返回**重建的纯数据副本**，所有层级访问器 / Symbol / 非普通原型 / `toJSON` 拒绝；普通 JSON + 对象 getter 两路、success/failure/dropped 矩阵 | transport 14/14，含 dropped 对象 / 负数 / 非整数 / 超限 / 悬空、getter 不执行、返回副本可改不污染原对象 |
| F2（P1） | 摘要必需字段从 `periodOf` / 状态枚举退化为 `requireText`：`data.period='synthetic_sensitive_period'` 与 `voucher.detail.status` 任意 token 均原文泄漏 | 新增 `requirePeriod` / `requireEnumToken` / `requireChoice`；期间严格 `YYYY-MM`、状态 / 分类 / 方向 / 种类 / 批次 / 追溯固定枚举；逐点审 `requireText`；不依赖下层 transport 兜底 | 适配层 17/17：真实 ASCII 标记 / 非法月份 / 缺字段全部 `model_result_invalid`，真 0 / 普通工具仍可调用；策略 32/32 同步固定值域 |
| F3（P2） | scope 只看 wrapper；`finance_query` 请求 A 实际返回 B `data` 时 wrapper 无 id 漏过，得到 A 引用 + B 数据 | 按 node 核对可信 data 字段：账套 `data.id`、凭证 `data.account_set_id`、凭证列表 / 科目体系逐行；普通 `account_list` / `asset_list` 行也核对；不一致 `model_scope_mismatch` 且不建引用；聚合节点不臆造必需字段 | 适配层 17/17：注入 `executeRaw` 仍调真实 `callAgentTool` 走 B 库，账套 / 凭证 / 科目 / 列表均拒绝且 refs=0；试算平衡等无 scope 字段节点仍通过 |

- 三层本轮实际输出：策略 `32/32`、适配层 `17/17`、transport `14/14`，均 exit 0。
- 已通过部分未回退：调用参数有界深快照 / alias / getter / 继承拒绝；合法 create / node / batch / unimplemented / 错误码与 dry-run；真实发出后断连 unknown 不自动重试（原回归仍绿）。
- 本轮未跑整套旧领域（按任务单要求只在根因涉及真实业务接口处定向补）；**（历史）**当时未提交 / 未推送 / 未合并；现已被 review4 / review5 与最终独审覆盖。
- 仍未完成：共享 HTTP / Agent / MCP / CLI 接线（LOCAL-02 #47 释放所有权后另行小 PR）、3 个套件登记进 `scripts/test-all.mjs`、LOCAL-02 合并后的新期末 / 资产补项工具。

### 8.3 review4 最后副本一致性定向修正（历史记录）

| 项 | 残留复现 | 修复 | 真实回归 |
|---|---|---|---|
| F1（P1） | `validateEnvelope` 先 `validateEnvelopeInner(original)`，成功后再 `plainSnapshot(original)`，返回的副本未经校验；合成合法 query 对象让 `adapter` 的 `getOwnPropertyDescriptor` 前几次返回合法值、之后返回普通对象，结果仍 `ok:true` 且带回不符合固定类型的 `adapter` | 增加第二遍：先用 `plainSnapshot` 生成有界纯数据快照，再对**同一快照**完整校验并只返回它；第一遍原对象校验只用于沿用既有固定错误码，不决定返回值。getter 不执行、非普通原型 / Symbol / `toJSON` / 函数 / 深度与大小上限全部保留 | transport 15/15（14 → 15）：新增 1 项可变反射一致性回归（`adapter` 与嵌套 `projection.assets` 描述符中途换值、始终合法的可变输入返回对象可再次完整校验且逐字段合规、普通 plain JSON 正例仍通过）；旧顺序实跑该新项失败（`14/15`、exit 1），修正后 `15/15`、exit 0 |

- 三层本轮实际输出：策略 `32/32`、适配层 `17/17`、transport `15/15`，均 exit 0。
- 范围：只改 transport 校验顺序与该套件新增 1 项回归；未重构模块，未改适配层 / 策略逻辑，未触动共享入口与其他包。
- **（历史）**当时未提交 / 未推送 / 未合并；该一致性修复已在最终独审复核通过，并纳入已审 head `ba5d601`。共享入口接线、`scripts/test-all.mjs` 登记、LOCAL-02 新工具补项仍未完成。

### 8.4 review5 新鲜独审 3 个 P2 定向返工（历史记录，最终独审前最后一次定向修复）

| 项 | 复核发现 | 修复 | 真实回归 |
|---|---|---|---|
| P2-1（scoped 期间） | scoped `account_context` 的 `start_period` 仅经「可选 `periodOf`」：真实结果 `2026-13` 时 `ok:true`、`startPeriod` 被省略、`projectionDropped:0`、transport 通过；与 global 分支拒绝非法必需月份不一致 | 适配层新增 `requirePeriod`，scoped 摘要与 global 列表行都要求**合法 `YYYY-MM`**，缺失 / 非法回 `model_result_invalid`；账套 `id` 同时按可表示范围校验 | 注入 `{account_sets:[{id:1,start_period:'2026-13'}],periods:[]}` + `accountSetId:1` 拒绝且不回显 `2026-13`；缺字段同样拒绝；合法 `2026-12` 仍成功、`startPeriod` 保留并能过 transport |
| P2-2（可表示 ID） | 唯一合法正安全整数 `id=1000000000001`（>projection 数值上限 1e12）通过 ID 校验后被消毒器删除，得到 `accountSetIds:[]` / `returnedCount:1` / `truncated:false` / `projectionDropped:0`：无法选择又无提示 | 新增可表示 ID 边界（= `PROJECTION_NUMBER_LIMIT` 1e12）：global 列表 ID / scoped 账套 ID / `enterprise_account.account_set` 的 `data.id` 超界即 `model_result_invalid`；global / scoped 的 `projectionDropped` 改为 `sanitizeProjection` 真实计数，不再固定 0；不扩大为全部 DTO 重写 | 合法边界 `999999999999` / `1e12` 成功且 `accountSetIds` 完整、`projectionDropped:0`；`1000000000001` 在 global 与 scoped 均拒绝且不回显 ID；transport 新增边界回归（上限内接受、超界 `envelope_projection_invalid`） |
| P2-3（`reconciles`） | 完整合法零值现金流 DTO 删除 `reconciles` 后仍成功，`projection.reconciles=false` 并生成引用：把未知勾稽状态伪造成 `false` | 策略 spec 由 `prop(...) === true` 改为 `requireBoolean(statement,'reconciles')`；适配层现金流形状同时要求布尔 | 缺失 / 字符串 `'true'` / 数字 `1` 均 `model_result_invalid` 且不建引用、不回显字段；真实 `false` 保留并过 transport；策略层新增缺失 / 类型错失败 + 真 `false` 正例 |

- 三层本轮实际输出：策略 **34/34**（32 → 34）、适配层 **19/19**（17 → 19）、transport **16/16**（15 → 16），均 exit 0。旧断言含义未削弱，已验行为保持。
- 范围：只改 `finance-output-policy.mjs`（导出数值上限 + `reconciles` 必需布尔）、`finance-model-adapter.mjs`（上下文期间 / ID / 真实 dropped）、三个测试文件与三份交付文档；未改 transport 实现、未动共享入口。
- **（历史）**当时未提交 / 未推送 / 未合并；原 3 项 P2 已由最终独审确认关闭（探针 57/57）。共享入口接线、`scripts/test-all.mjs` 登记、LOCAL-02 新工具补项仍未完成。

### 8.5 当前验收状态

| 项 | 证据 |
|---|---|
| 已审源码 head | `ba5d60115e52fa13805841d9abe07006b74b2c9c` |
| 管理者实跑 | 策略 35/35、适配层 20/20、transport 17/17，均 exit 0（LOCAL-02 兼容增量后；原 34/19/16 项含义保留） |
| 最终独审 | `review_output08_final` 未参与实现；原 3 项 P2 关闭；独立探针 57/57 通过（不等于三套测试用例总数）。**LOCAL-02 兼容增量仍待 root 最终增量独审 / PR** |
| main 合入后复核 | main `98977e0` → head `e8b298e`，仅添加 PR #55 六个 backup 文件，本包 9 路径与已审 head 逐文件不变 |
| PR | [#57](https://github.com/huxiaoyang-code/youshu-fork/pull/57) OPEN 并 attach；尚无 merge SHA |

### 8.6 LOCAL-02 兼容增量（本轮新增）

| 项 | 实际实现 / 证据 |
|---|---|
| `period_end_check` | 登记为只读 `query` / `account_set`；形状只认固定步骤 id / 状态 / blocking 数组。投影只含 `period` / `ready` / 步骤状态计数 / blocked 步骤 id / 阻塞计数 / 固定阻塞码；原始 `title` / `reason` / `message` / `details` / 资产名 / 科目名 / 备注不进入模型通道。未知步骤 / 状态 / 阻塞码 fail closed。 |
| `asset_update` | 登记为写 `write` / `account_set` / `accountSetIdSource: argument`；只有显式写调用才执行（未知 / 只读工具不会执行）。成功必须有真实 `id` 才 `applied:true`；失败保留 `applied:"unknown"` + `needsLocalReview:true`。投影最小白名单 `assetId` / `kind` / `startPeriod` / `acquiredPeriod` / `originalCost` / `usefulLifeMonths` / `openingAccumulated` / `accumulated` / `remaining` / `ledgerStatus` / `origin`，不含名称 / `ledger_note` / 科目 / 备注。 |
| 新错误映射 | policy 与 transport 双层补齐：`acquired_period_invalid → asset`、`asset_card_affects_closed_period → asset`、`asset_card_locked_by_posted_runs → asset`、`period_end_check_failed → period_end`、`later_profit_carryforward_depends_on_period → period_end`、`profit_not_carried_forward → period_end`、`depreciation_run_stale → depreciation` 等；不再落 `unknown`。 |
| 真实正负闭环 | 适配层用真实临时库：资产原值 1200、取得 / 起提 2026-02、借贷平衡购入凭证、真实计提 95；保留**真实封账成功**（2026-01）与 `period_end_check_failed` **前置拒绝**（2026-02 未结转损益）两条路；`asset_update` 正例 + `acquired_period` 非法负例；自由文本注入不泄漏。 |
| 边界保持 | 错误清洗、参数快照、引用绑定 / 过期 / 跨账套、4 MiB / 64 MiB / 节点预算、写后降级、并发隔离原语义未改；未挂真实 HTTP / Agent / MCP / CLI 入口。 |
| 输出 | 策略 **35/35**、适配层 **20/20**、transport **17/17**，均 exit 0（实际输出）；原 34 / 19 / 16 项含义未削弱。完整 `npm test` **55/55 套 exit 0**，Office **21/21**、真实 **11 PDF** 几何通过（设 `REPORT_OFFICE_PYTHON`；日志在本 worktree 忽略目录 `.agent-runs/`）。 |

- 范围：本轮只动已登记的 6 个源码 / 测试文件（`finance-output-policy.mjs`、`finance-model-adapter.mjs`、`finance-model-transport.mjs` 及其 3 个套件）与 3 份交付文档，另补 `docs/LOCAL-BACKUP.md` 独审非阻塞项；**未改** `agent-tools.mjs` / `server.mjs` / MCP 入口 / `scripts/test-all.mjs`。
- 状态：**未提交 / 未推送 / 未建 PR / 未合并**；待 root 最终增量独审 / PR 复核。

## 9. 真实数据边界

- 是否触碰真实账套 / 凭据：**否**。测试只用**全新临时目录**里的合成账套（企业名 / 科目名 / 摘要 / 往来 / 人员 / 资产名 / 路径 / 企业身份 / 批次 ID 全部是合成标记）。
- 是否访问真实税局 / 外部系统：**否**。适配层对 `tax_*` 只做固定拒绝，不调用任何税务工具；未启动税局浏览器 / 后端。
- 凭据 / 会话 / 验证码：未涉及、未记录。
- 未覆盖生产库、未绕过沙箱：是。
- 仓库文档不写本机绝对路径、进程 ID、私有日志内容：是（用 `<repo>` 等占位）。

## 10. 验证 head

- 分叉基线（本阶段）：`b42bae9ae76e54aeda63bcc4db0dc34663286b7d`（main，PR #50 合并）
- 已审模块提交（上一阶段）：`f211ace5b90e6dc5f240c8bb870ffbf5eb11662b`
- 本阶段已审源码 head：`ba5d60115e52fa13805841d9abe07006b74b2c9c`
- 合入 main 后 head：`e8b298e42224e2e1b884f7827e4c366881d22fc9`（main `98977e0` 合入；仅新增 PR #55 六个 backup 文件，本包 9 路径不变）
- PR：[#57](https://github.com/huxiaoyang-code/youshu-fork/pull/57) OPEN 并 attach；**merge SHA 待合并后补记**（不预报已合并）
- 基线变动后的重验范围：本阶段 3 个套件 + 受影响领域回归（§8）；接线 PR 需在最新 main 上再重跑并补集成测试。

## 11. 自动合并权限 / 协调记录

- 自动合并：按项目授权由已登记成员自己的本机 Codex 审查验收后执行；**本文件不构成合并证据**。
- 跨成员评审：本阶段不触碰共享入口，但新增的是数据边界适配层（高风险面），建议管理者按 §8 独立复跑并逐项核对 §4 的 1–12 条。
- 合并协调：与 LOCAL-01（#43，已合并）无文件交集；接线阶段必须与 **LOCAL-02（#47）** 协调，且走独立小 PR。
- 当前 PR：[#57](https://github.com/huxiaoyang-code/youshu-fork/pull/57) 已 OPEN 并 attach，按已授权流程待文档核对后合入；本次文档修改会产生新 head，合并前再核 6 个源码 / 测试文件未变。
- 已知限制：GitHub 不能原子锁 base；`finance-model-transport-test.mjs` 跨目录 import 适配层（与本仓库既有 MCP 测试跨目录 import 06-workbench 的做法一致）。
- 是否触发权限 / 仓库设置变更：否。

## 12. 回退与交接

- 回退：`revert` PR（禁止重写 main 历史）；适配层与 transport **未被任何入口引用**，回退对既有行为零影响（策略模块扩 spec 也不改变未接线前的现有返回）。
- 交接文档：[handoffs/LOCAL-08](../handoffs/LOCAL-08.md)。
- 仍运行进程：本次员工侧无子进程残留（本轮全部为前台命令，已结束并核对退出码）；此结论仅限本次员工会话，不代表全仓没有其他成员正在运行的员工。
- 下一任务输入：在最新 main 上按 §9 接线（先取 LOCAL-02 释放的共享文件所有者确认），并把 3 个套件登记进 `scripts/test-all.mjs`。

---

授权继承自 [项目章程](../PROJECT-CHARTER.md) 与用户后续指示；任务单**不能扩大授权**。
协作规则见 [团队协作协议](../TEAM-COLLABORATION.md)。
