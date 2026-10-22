# 任务单 · LOCAL-08 财务输出边界（模型摘要 / 本机读取分道 + 普通工具适配层）

- 类型：独立后端模块 + 适配层 + 出站信封校验 + 独立验收测试 + 契约文档
- 状态（分两段，**不要混读**）：
  1. **纯策略模块已合并**：经独立审查后由 [PR #50](https://github.com/huxiaoyang-code/youshu-fork/pull/50) 合并（已审 head `f211ace5b90e6dc5f240c8bb870ffbf5eb11662b`，merge / main `b42bae9ae76e54aeda63bcc4db0dc34663286b7d`，2026-10-22T09:57:25Z）；
  2. **本阶段（适配层）已实现并自测通过，未挂载**：普通工具适配层 + 真实（临时库）调用验收 + MCP 出站信封校验 + 契约 / 任务单 / 交接更新。**HTTP / Agent / MCP / CLI 仍未接线**，共享入口（`agent-tools.mjs` / `server.mjs` / MCP 注册与传输 / `scripts/test-all.mjs`）归 **LOCAL-02（Issue #47，返工中）**，本轮未改。Issue #44 **保持 OPEN**。
  3. **review1 五项独立审查返工已完成并自测通过（未提交 / 未合并）**：F1 transport 允许键校验、F2 参数快照防串账、F3 摘要必需字段、F4 真实错误码 / create+result、F5 写结果未知语义。最终独立审查、PR、合并仍由管理者后续执行。
- 负责人（人类成员 / GitHub）：`huxiaoyang-code`
- 实际分支：`codex/huxiaoyang-code/local-08-adapter`（由管理者从上述 main 建立；员工未执行任何 Git 操作）
- 交付契约：[FINANCE-OUTPUT-BOUNDARY](../FINANCE-OUTPUT-BOUNDARY.md)；交接：[handoffs/LOCAL-08](../handoffs/LOCAL-08.md)
- 关联：Issue #44（保持 OPEN）；共享入口现归 LOCAL-02（#47），其新期末 / 资产补项工具**未稳定前不实现**

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
| 1 | `06-workbench/server/finance-output-policy.mjs` | 既有（本阶段扩 spec / 出口 / 错误码 / 遍历修正） |
| 2 | `06-workbench/test/finance-output-policy.test.mjs` | 既有（28 → 31 项，旧 28 项含义保留） |
| 3 | `06-workbench/server/finance-model-adapter.mjs` | **新增** |
| 4 | `06-workbench/test/finance-model-adapter.test.mjs` | **新增**（真实临时库） |
| 5 | `05-reconstruction/codex/mcp/finance-mcp/finance-model-transport.mjs` | **新增** |
| 6 | `05-reconstruction/codex/mcp/finance-mcp/finance-model-transport-test.mjs` | **新增** |
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
  12. 既有 28 项含义不削弱（实际仍全过），新增 3 项覆盖：数组接受期间、普通工具 DTO spec + 无引用摘要、共享引用（DAG）合法 / 真循环仍拒绝。
- 回归：实跑领域回归（见 §8），并在报告中写清未测范围（真实 HTTP / MCP 挂载、真实账套、跨重启）。
- 验证命令与期望：

```bash
cd 06-workbench
node test/finance-output-policy.test.mjs      # 31/31 passed, exit 0
node test/finance-model-adapter.test.mjs      # 15/15 passed, exit 0

# 仓库根目录
node 05-reconstruction/codex/mcp/finance-mcp/finance-model-transport-test.mjs   # 11/11 passed, exit 0
```

- 不通过处理：退回同一员工修复，记录阻塞；不得删改旧断言或放宽到「只要不报错」。

## 5. 文件所有权与共享改动协商

- 本阶段**只改/增 §3 表格中的 9 个文件**。**未触碰**任何共享受控文件：`accounting.mjs`、`coa.mjs`、`db.mjs`、`import-storage.mjs`、`server.mjs`、`agent-tools.mjs`、MCP `tools.mjs` / `backend.mjs` / `server.mjs` 及其它既有测试、`scripts/test-all.mjs`、`package.json`、`public/*`、`docs/INDEX.md`、`docs/handoffs/STATE.md`、`docs/tasks/README.md`。
- 共享入口现归 **LOCAL-02（Issue #47，返工中）**；本阶段不申请其所有权，接线（含把 3 个套件登记进 `scripts/test-all.mjs`）必须在其释放后走独立小 PR。
- 新模块归属：`finance-output-policy.mjs` 与 `finance-model-adapter.mjs` 为 LOCAL-08 独占新增/维护模块；`finance-model-transport.mjs` 是 MCP 目录下的**新增独立纯函数模块**（不属 LOCAL-02 修改范围，未改任何既有 MCP 文件）。
- 策略模块本阶段的接口变化（未接线，无兼容影响）：
  - `SUPPORTED_OPERATIONS.query` 12 → 19、`write` 12 → 13（新增普通工具 spec）；
  - 新增导出 `summarizeQueryResult` / `summarizeWriteResult` / `ENUM_TOKENS` / `enumTokenOf`；
  - `ERROR_CODES` allowlist 增补适配层固定码与 main 已有域码；
  - 数组白名单允许「期间」（与标量规则一致）；`inspectRawValue` 改为**只把当前路径祖先集当循环**，共享引用（DAG）合法，真循环仍拒绝；节点 / 字节 / 深度 / 数组上限不变。

## 6. 依赖 / 基线 / 阻塞路径

- 前置（已完成）：纯策略模块已审并合并（PR #50 / merge `b42bae9` / 已审 head `f211ace`）。
- 阻塞路径：真实入口接线依赖 **LOCAL-02（Issue #47）** 释放共享文件（当前返工中）；不因此改共享文件，也不建替代入口。
- 待 LOCAL-02 合并后补的入口（**明确登记，不预报**）：其新期末 / 资产补项工具的具体工具名与 DTO 尚未稳定 → 本阶段不写占位 spec、不登记映射（未登记即 `model_tool_unknown`，不会误执行）；合并后按真实 DTO 一次补齐映射 + spec + 形状检查 + 测试。
- 基线更新时重验范围：若后续 main 改动 `accounting.mjs` / `agent-tools.mjs` 返回结构，需重跑本阶段 3 个套件并核对投影 spec 与形状检查。

## 7. 成员 / 执行员工模型

- 人类成员：本机任务派工方；执行员工本机 pi。
- 执行员工模型：主 / 回退均 `tokenhub/deepseek-v4.1-flash`（显式锁定）。
- 是否使用其他模型 / 子 agent：**否**。
- 管理者是否独立于员工做内容审查：**由管理者在本阶段完成后执行**（本文件不代替审查结论）。
- 管理者是否直接补写业务代码 / 测试 / 交付文档：**否**（如有缺陷退回员工）。

## 8. 验证记录

- 本阶段员工自测（**事实，已发生**）：

| 套件 | 命令（工作目录） | 结果 |
|---|---|---|
| 策略模块 | `node test/finance-output-policy.test.mjs`（`06-workbench`） | `31/31 passed`，exit 0 |
| 适配层 | `node test/finance-model-adapter.test.mjs`（`06-workbench`） | `15/15 passed`，exit 0 |
| transport | `node 05-reconstruction/codex/mcp/finance-mcp/finance-model-transport-test.mjs`（仓库根） | `11/11 passed`，exit 0 |
| 领域回归 | `node test/accounting-guards.test.mjs`（`06-workbench`） | `23/23 通过`，exit 0 |
| 领域回归 | `node test/accounting-derived.test.mjs`（`06-workbench`） | `31/31 通过`，exit 0 |
| 领域回归 | `node test/import-incremental.test.mjs`（`06-workbench`） | `49/49 通过`，exit 0 |
| HTTP / Agent 回归 | `node test/smoke.test.mjs`（`06-workbench`） | `28/28 通过`，exit 0 |

- 未运行：完整 `scripts/test-all.mjs`（新套件未登记进该共享文件，属 LOCAL-02；无意义多跑）。
- 适配层测试隔离与数据：**先**建全新临时 `WORKBENCH_DATA_DIR`，**再**动态 import 真实模块；测试结束删除临时目录；未读旧后端、未连真实账套、未联网。
- 独立审查 / 管理者验证 / PR / 合并：**由管理者在本阶段交付后执行**（本文件不写未来 SHA、不预报 PR）。
- 上一阶段（纯策略模块）审查证据保留：首轮 22/22 审查未过 → 修复 5 项后 28/28，管理者与不参与实现的独立 reviewer 各自实跑通过，PR #50 合并。

### 8.1 review1 五项独立审查返工（本轮实际发生）

| 项 | 修复 | 真实回归 |
|---|---|---|
| F1 | transport 每个允许键在所有适用分支完整校验；adapter 版本 / operation / tool / nodeId / category / scope / appliedReason / 错误码 / 目录内置固定语义；projection 只允许固定 token 或期间；getter / Proxy 异常固定失败 | 普通 JSON 负例覆盖成功 / 失败 / write / global / static / catalog / error；真实适配层成功与失败信封仍能通过；11/11 |
| F2 | 任何异步边界前深拷贝自有 data 属性快照；拒绝访问器 / 原型 / 别名冲突 / 超量；嵌套 payload 固定；查询回显账套不匹配不建引用 | 真实 `callAgentTool` 两账套 A/B：查询改 setId、写改 setId + 改嵌套 entries，断言实际两库行与 ref 所属；参数复用 / 原型 / 别名 / getter 负例；15/15 |
| F3 | 全部 query 摘要必需字段 / 类型严格校验；缺字段明确失败，不用 0 冒充；真 0 保留 | 真实利润表删除 `data.ytd["营业收入"]`、试算表删除 totals 字段均返回 `model_result_invalid`；真零值收入仍成功；15/15 |
| F4 | 统一 operationCategory（含 create / node_query / batch_query / unimplemented）、scope（含 result）、固定错误码映射与大驼峰真实码 | 真实 `account_set_create({})`、无效 `book_import_incremental`、缺 nodeId / voucherId、领域查询错误与 dry-run 正例全部通过 transport；11/11 |
| F5 | 写场景通用连接错误保守 `outcome/writeOutcome:unknown`；仅可证发前失败为 `not_sent`；写操作不自动重试 | 纯函数回归 + 全新合成回环服务（请求发出后断连）验证；11/11 |

- 本轮未提交、未推送、未合并；不得把本次自测写成最终独立审查通过。
- 仍未完成：共享 HTTP / Agent / MCP / CLI 接线（LOCAL-02 #47 释放所有权后另行小 PR）、3 个套件登记进 `scripts/test-all.mjs`、LOCAL-02 合并后的新期末 / 资产补项工具（工具名与 DTO 稳定后按真实 DTO 补映射 + spec + 测试）。

## 9. 真实数据边界

- 是否触碰真实账套 / 凭据：**否**。测试只用**全新临时目录**里的合成账套（企业名 / 科目名 / 摘要 / 往来 / 人员 / 资产名 / 路径 / 企业身份 / 批次 ID 全部是合成标记）。
- 是否访问真实税局 / 外部系统：**否**。适配层对 `tax_*` 只做固定拒绝，不调用任何税务工具；未启动税局浏览器 / 后端。
- 凭据 / 会话 / 验证码：未涉及、未记录。
- 未覆盖生产库、未绕过沙箱：是。
- 仓库文档不写本机绝对路径、进程 ID、私有日志内容：是（用 `<repo>` 等占位）。

## 10. 验证 head

- 分叉基线（本阶段）：`b42bae9ae76e54aeda63bcc4db0dc34663286b7d`（main，PR #50 合并）
- 已审模块提交（上一阶段）：`f211ace5b90e6dc5f240c8bb870ffbf5eb11662b`
- 本阶段 head / PR / merge SHA：**由管理者提交后补记**（本文件不写自引用 SHA、不预报未来提交）
- 基线变动后的重验范围：本阶段 3 个套件 + 受影响领域回归（§8）；接线 PR 需在最新 main 上再重跑并补集成测试。

## 11. 自动合并权限 / 协调记录

- 自动合并：按项目授权由已登记成员自己的本机 Codex 审查验收后执行；**本文件不构成合并证据**。
- 跨成员评审：本阶段不触碰共享入口，但新增的是数据边界适配层（高风险面），建议管理者按 §8 独立复跑并逐项核对 §4 的 1–12 条。
- 合并协调：与 LOCAL-01（#43，已合并）无文件交集；接线阶段必须与 **LOCAL-02（#47）** 协调，且走独立小 PR。
- 已知限制：GitHub 不能原子锁 base；`finance-model-transport-test.mjs` 跨目录 import 适配层（与本仓库既有 MCP 测试跨目录 import 06-workbench 的做法一致）。
- 是否触发权限 / 仓库设置变更：否。

## 12. 回退与交接

- 回退：`revert` PR（禁止重写 main 历史）；适配层与 transport **未被任何入口引用**，回退对既有行为零影响（策略模块扩 spec 也不改变未接线前的现有返回）。
- 交接文档：[handoffs/LOCAL-08](../handoffs/LOCAL-08.md)。
- 仍运行进程：无（本轮全部为前台命令，已结束并核对退出码）。
- 下一任务输入：在最新 main 上按 §9 接线（先取 LOCAL-02 释放的共享文件所有者确认），并把 3 个套件登记进 `scripts/test-all.mjs`。

---

授权继承自 [项目章程](../PROJECT-CHARTER.md) 与用户后续指示；任务单**不能扩大授权**。
协作规则见 [团队协作协议](../TEAM-COLLABORATION.md)。
