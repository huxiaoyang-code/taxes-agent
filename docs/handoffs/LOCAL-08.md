# LOCAL-08 交接

- 任务单：[tasks/LOCAL-08](../tasks/LOCAL-08.md) · 契约：[FINANCE-OUTPUT-BOUNDARY](../FINANCE-OUTPUT-BOUNDARY.md)
- 一句话：新增**未接线**的独立模块 `finance-output-policy.mjs`，把普通财务工具结果分成「模型白名单摘要 + 不可猜测引用」与「本机凭能力通道取原文 / 受限算术」两条通道；首轮独立审查发现的 5 项缺陷已逐项修复，合成测试 22 → 28/28。**HTTP / Agent / MCP / CLI 未接线、未验收**，当前模型入口仍返回原文。

## 1. 基本信息

- 任务 ID / 状态：LOCAL-08 / **开发中：审查返工（review1）已交付，待同一独立 reviewer 复核（未提交、未建 PR、未合并）**
- 关联 Issue：**#44**（本任务）；并行 #43 LOCAL-01 持有共享文件
- 负责人（人类成员 / GitHub）：`huxiaoyang-code`
- 执行员工与显式模型：本机 pi，主 / 回退均 `tokenhub/deepseek-v4.1-flash`（未切换、未启用子 agent）
- 本机管理者：成员自己的 Codex（独立审查、提交、合并由其执行）
- 分支：`codex/huxiaoyang-code/local-08`（管理者已建立并核实；员工未执行任何 Git 操作）
- 目标 / 验收 / 明确不做：见任务单 §2 / §4 / 非目标

## 2. 基线与已审核 head

- 基线（分叉时 `origin/main`）：`0c4e0dd622fc35bcb5d6e6af3620c6f971b2a805`
- 已审核 head：**未验证**（工作区仅新增 5 个未提交文件）
- 合并 SHA：未合并
- 合并前最新 `origin/main` 与重验范围：待管理者在合并前核对；本包与 #43 无文件交集，若 `accounting.mjs` 返回结构变化需重跑本套件并核对 projection spec
- 交接对象：后续接线任务（Agent 工具 / HTTP / MCP 后端 / 本机 UI 读取入口）

## 3. 依赖契约

- 上游依赖：无代码依赖（模块自包含，仅用 `node:crypto`）。输入形状对齐 `accounting.mjs` 现有返回（未 import、不调用）。
- 本任务给下游的契约（详见 [FINANCE-OUTPUT-BOUNDARY](../FINANCE-OUTPUT-BOUNDARY.md)）：
  - 模型通道：`wrapQuery(operation, {accountSetId, value})`、`wrapWrite(...)`、`runWrite(...)`、`resolveForModel(ref, {accountSetId, operation})`；
  - 本机通道：`issueChannel(label)` / `releaseChannel(channel)`、`localRead(ref, {channel, accountSetId, operation})`、`localCompute(ref, {channel, accountSetId, operation, op, path})`、`revokeLocalRef(ref, {channel, accountSetId, operation})`；
  - **统一绑定规则**：凡是引用调用，`accountSetId` 与 `operation` 都必须显式给出并被核验（无缺省账套路径）；`operation` 只接受**已登记的原始字符串**；
  - 错误：`safeErrorProjection(error, {operation})`（固定 code allowlist，永不回传 `message` / `details` / `stack`）；
  - 预算：`maxRefs` / `valueNodes` / `nodeBudget` / `valueBytes` / `byteBudget` / `ttlMs` 均可配；`stats()` 暴露 `nodes` / `bytes` 占用；
  - 可接线 operation 清单：`SUPPORTED_OPERATIONS.query` / `.write`；机读边界：`MODEL_OUTPUT_CONTRACT`。
- 契约变更与兼容：新增文件，零改动既有模块，**无兼容性影响**；未接入前行为不变。
- 下游消费者：LOCAL-01 / 后续集成任务。

## 4. 允许修改的文件与文件所有权

- 实际新增（5 个，均未提交）：
  - `06-workbench/server/finance-output-policy.mjs`
  - `06-workbench/test/finance-output-policy.test.mjs`
  - `docs/FINANCE-OUTPUT-BOUNDARY.md`
  - `docs/tasks/LOCAL-08.md`
  - `docs/handoffs/LOCAL-08.md`
- 共享受控文件：**未触碰**（`accounting.mjs` / `coa.mjs` / `db.mjs` / `server.mjs` / `agent-tools.mjs` / MCP 注册 / `scripts/test-all.mjs` / `package.json` / `public/*` / 共享索引文档全部未改，归 LOCAL-01 #43）。
- 共享接线改动：未申请；接线走后续独立集成 PR（含把本套件登记进 `scripts/test-all.mjs`）。
- 未触碰：其他 worktree、`tax-browser` 现场、真实账套数据库、用户配置、凭据、私有采集目录。

## 5. 实现摘要、关键取舍与接口变化

- 实现摘要：
  - **operation 严格先验**：先 `typeof operation === "string"`，再查登记表；信封里的 `operation` 只能是登记表常量。查表 / 字符串转换 / 回调之前完成校验，`{toString(){...}}` 之类对象既不执行用户代码，也进不了信封。
  - **预校验先于写执行**：`runWrite` 先验 operation / `accountSetId` / `execute`，再调回调；未登记操作不会产生任何写入。
  - **投影白名单**：每个 operation 一个 spec 函数，按固定键名取值（键名是代码常量），再经 `sanitizeProjection` 做值形状白名单（有限数值 2 位小数 / ≤1e12、布尔、`^[a-z][a-z0-9_]{0,31}$` 状态 token、`YYYY-MM` 期间、≤32 标量数组、≤3 层 / ≤96 节点对象）；未知 operation 直接拒绝，未登记字段丢弃并计数。
  - **枚举映射**：纳税人性质 / 会计准则 / 科目类别 / 方向 / 状态映射成 ASCII token（`small_scale` / `enterprise` / `profit_loss` / `posted` 等），不把中文业务串带出。
  - **引用**：`finref_` + 192 位随机；绑定账套 + operation + 类别；TTL 15 分钟（可配）；可撤销；默认上限 256 个；**仅进程内**（`persistence: process_memory`）。
  - **能力通道**：`issueChannel` 返回冻结对象，作为 `Map` 键按**对象标识**校验；参数里 `local:true` / `channel:"local"` / JSON 克隆对象一律 `channel_untrusted`，不静默降级；签发不接受任何模型输入。
  - **写语义**：`applied` 三态（true 需正面证据 / false 需域结果显式说明 / 其余 `unknown` + `needsLocalReview`）；写完成后的证据 / 投影 / 引用失败**不反转为业务失败**，降级为 `localRef:null` + 固定 `refUnavailable`（`value_limit` / `value_invalid` / `capacity` / `node_budget` / `byte_budget` / `summary_unavailable`）。
  - **错误**：只按固定 allowlist 查表回 `code`，从不读取 `message` / `details` / `stack` 内容，`rawErrorIncluded:false`。
  - **原数据防御**：先做有界形状 + 节点/字节检查，再看摘要；全程只经 `Object.getOwnPropertyDescriptor` 读自有 data 属性（包括数组长度），不触发 getter、不读原型链、不 `JSON.stringify` 原值；访问器 / 循环 / 类实例 / 读不到的恶意对象一律安全拒绝。
  - **内存预算**：节点（单值 / 累计）+ 字节（单值 4 MiB / 累计 64 MiB，可配）四道预算并列；到期 / 撤销 / `dispose` 统一归还；`stats()` 暴露占用。
- 关键取舍（放弃的方案与原因）：
  - 放弃「敏感词黑名单」：漏一个词就泄漏，改为字段 + 值形状双白名单；
  - 放弃「工具只返回引用、模型通过另一工具解引用」：那正是「换工具拿原文」的洞，改为模型解引用只回同一份摘要，而且也要显式带账套 + operation；
  - 放弃用字符串 token 表示 channel：会被模型参数伪造，改为进程内对象标识；
  - 放弃把引用写入 SQLite / 日志：当前无跨重启需求，落盘会扩大边界；已在契约中写明未来持久化的前置条件（未实现）；
  - 放弃「写结果超量即抛错」：那等于把已发生的写入报成失败，改为降级丢引用并保留真实 `applied`；也不再因降级而抛原始异常（避免调用方当成业务失败而重试）；
  - 放弃「节点数就够当内存预算」：节点数拦不住大字符串，单加字节预算而不改节点预算（两者并列）；
  - 不承诺「零 Proxy 陷阱」：JS 反射无法做到，只承诺不触发 getter / 不读原型链 / 失败即安全拒绝。
- 接口 / 行为变化：**无对外影响**（新增文件，未被任何入口 import）；模块内部 API 形状变化（`resolveForModel` / `revokeLocalRef` 必须带 `accountSetId` + `operation`，`stats()` 新增节点/字节字段，新增 `inspectRawValue` 导出）。
- 显式限制：不持久化、无多用户 / 权限体系、引用跨重启失效；projection / 本机算术是「可用数值」，不替代 `accounting.mjs` 会计口径；未实现的 `finance_query` 能力没有 spec，入口须自己回 `not_implemented`，不得兜底投影。

## 6. 管理者验证记录

- 审查人（本机管理者）：**待填写**
- 实际 diff 阅读范围：**待填写**（员工侧确认：`git status --short` 仅 5 个未跟踪文件，无既有文件修改）
- 首轮员工自测（事实）：工作目录 `<repo>/06-workbench`，命令 `node test/finance-output-policy.test.mjs` → `22/22 passed`，`exit=0`。
- 首轮独立审查（事实）：发现 5 项真实缺陷（operation 未强制原始字符串 / runWrite 先执行后报错 / `list[i]` 触发 getter 且写后失败外抛原文 / 内存预算只有节点数 / 账套绑定契约不一致），首轮交付**未验收通过**。
- 本轮返工（review1）已逐项修复并补 6 条不依赖实现自证的回归（详见任务单 §8 表）。
- 本轮员工自测（事实）：同目录 `node test/finance-output-policy.test.mjs` → `Finance output policy acceptance: 28/28 passed`，`exit=0`；无数据库、无 HTTP、无网络、无临时库。
- 工作区卫生（事实）：同目录 `node test/accounting-guards.test.mjs` → `23/23 通过`，`exit=0`；全量 `scripts/test-all.mjs`（44 套）**未重跑**（本包未改既有文件，且该入口归 LOCAL-01 #43）。
- 管理者验证命令 / 结果 / 退出码：**待填写**（未运行不得声称通过；`scripts/test-all.mjs` 未含本套件）
- 同一 reviewer 复核：**待进行**；本文件不预报复核结论、head 或合并。
- 未验证范围与原因：真实 HTTP / Agent / MCP / CLI 链路（未接线）；真实账套（禁止）；跨重启行为（设计上失效）。
- 结论：**待填写「通过 / 退回返工」**；当前阻塞项仍是「未接线、无端到端证据」，属既定范围而非缺陷。

## 7. 真实数据边界

- 是否触碰真实账套 / 凭据：**否**。
- 临时数据目录 / 合成样例：**未创建目录**；测试只用内存对象，含合成敏感标记（`合成机密企业名称甲`、`合成机密科目名称乙`、`ZC-998877`、`合成机密摘要丙`、`合成机密往来单位丁`、`合成机密经办人戊`、`D:/合成机密路径/凭证明细.zip`、`91350000SECRETX01`）以及 review1 回归新增的 `synthetic_sensitive_summary` / `synthetic_sensitive_status` / `synthetic_sensitive_proxy`，断言这些串不出模型信封、不出安全错误投影。
- 是否访问真实税局 / 外部系统：**否**。
- 凭据 / 会话 / 验证码：未涉及，未记录。
- 未覆盖生产库、未绕过沙箱：是。

## 8. 自动合并权限 / 协调记录

- 自动合并：按项目授权由已登记成员自己的本机 Codex 审查后执行；本文件不构成合并证据。
- 跨成员评审：纯新增模块、无共享文件改动，按协议可由成员本机 Codex 自审后合并；接线需另走集成 PR。
- 合并协调：与 LOCAL-01（#43）无文件交集，无需串行；**接线必须等 LOCAL-01 释放共享文件**。
- 已知限制：GitHub 不能原子锁 base。
- 仓库设置 / 权限变更：未触发。

## 9. 未完成项、风险与下一部分输入

- 未完成项：
  1. HTTP / Agent / MCP / CLI 接线（`agent-tools.mjs`、`server.mjs` 错误分支、MCP 只消费模型信封、本机回环读取入口）；
  2. 本套件登记进 `06-workbench/scripts/test-all.mjs`（共享文件，属 LOCAL-01）；
  3. 集成测试：真实 HTTP → Agent → 信封不含敏感原文 + 本机通道可取原文；写错误不再泄漏 `message`；
  4. `finance_query` 未实现能力的入口行为（应回自己的 `not_implemented`，不走投影兜底）。
- 风险 / 阻塞：
  - 未接线前**本契约不生效**，当前模型入口仍原样返回企业名 / 科目名 / 凭证行；本模块不能代替整体边界验收；
  - 若接线时把 `localRead` 误挂到 `/agent/tools/*` 或 MCP，会立刻形成「模型取原文」的洞：接线评审必须逐条核对契约 §9；
  - 引用仅进程内，UI 进程与后端进程分离时需在同一进程内签发 channel，或另行设计（本包未做）；
  - 预算（256 refs / 单值 20 万节点 / 4 MiB / 累计 100 万节点 / 64 MiB / 15 分钟）是本地策略；真实大账套可能在单值字节或节点上限上碰顶，接线时需用真实量级数据校核并记录调整依据，不得默默调大后当成已验收；
  - 写后降级会丢引用（`localRef:null`），本机需自行查证时只能靠 `accountSetId` + 操作原结果重建；这是有意的安全取舍。
- 下一部分输入：读 [FINANCE-OUTPUT-BOUNDARY](../FINANCE-OUTPUT-BOUNDARY.md) §8（最小 API）与 §9（接线建议清单）、本任务单 §4；在 LOCAL-01 合并后的最新 `origin/main` 上重验。
- 回退：`revert` PR（禁止重写 main 历史）；未被引用，回退对既有行为零影响。

## 10. 进程 / 会话 / 日志

- 仍运行进程：无。本轮前台多次运行 `node test/finance-output-policy.test.mjs`（连续 3 次结果一致，均 `28/28`、`exit=0`），另跑 `node test/accounting-guards.test.mjs`（`23/23`、`exit=0`）；全部已结束，无后台进程。
- 临时探针：核对文档示例 / 恶意上下文 / Proxy 边界时在本机 worktree 与系统临时目录跑过一次性 `node` 脚本，**用完即删**（`git status` 仍只有 5 个未跟踪交付文件）。
- 原始日志：本机终端输出，未落盘到仓库；`.agent-runs/` 未新增文件。
- 上下文：本包完成后按章程关闭本员工会话；下一部分 / 复核使用新进程、新会话（`--no-session`），只载入任务单、契约文档与必要源码。

---

授权继承自 [项目章程](../PROJECT-CHARTER.md) 和用户后续指示，交接不能扩大授权。
协作与文件所有权规则见 [团队协作协议](../TEAM-COLLABORATION.md)。
