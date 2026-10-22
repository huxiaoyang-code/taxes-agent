# 任务单 · LOCAL-08 财务输出边界（模型摘要 / 本机读取分道）

- 类型：新增独立后端模块 + 独立预期合成测试 + 契约文档
- 状态：**开发中 → 首轮员工交付已经独立审查，本轮为审查返工（review1）交付；待同一独立 reviewer 复核**（HTTP / Agent / MCP / CLI **未接线、未验收**）
- 负责人（人类成员 / GitHub）：`huxiaoyang-code`
- 实际分支：`codex/huxiaoyang-code/local-08`（由管理者建立，员工未执行 Git 操作）
- 关联：Issue #44（LOCAL-08）；并行任务 LOCAL-01（Issue #43）持有 `agent-tools.mjs` / `db.mjs` / MCP / `scripts/test-all.mjs` / 索引等共享文件
- 交付契约：[FINANCE-OUTPUT-BOUNDARY](../FINANCE-OUTPUT-BOUNDARY.md)；交接：[handoffs/LOCAL-08](../handoffs/LOCAL-08.md)

## 1. 基本信息

- 执行员工：本机 pi（主 / 回退模型均显式锁定 `tokenhub/deepseek-v4.1-flash`，未切换、未启用子 agent）
- 本机管理者：成员自己的 Codex（由其独立读 diff、跑验证、写 PR 正文、执行 Git）
- 分支：`codex/huxiaoyang-code/local-08`（**由管理者建立，员工不执行 Git 操作**；已核实工作区仅新增 5 个未跟踪文件）
- 基线（分叉时 `origin/main` 完整 SHA）：`0c4e0dd622fc35bcb5d6e6af3620c6f971b2a805`
- 工作目录：`<repo>/.worktrees/local-08`

## 2. 需求（用户 / 目标）

- 目标：从现有普通财务工具的结果中**分出模型输出与本机操作读取**。模型只拿默认拒绝的白名单 projection（有限数值 / 状态 / 期间）+ 不可猜测引用；原数据只能在本机凭能力通道用同一引用取回；本机可做有限受控算术。写动作结果不得伪成功，错误对象不得把 `message` / `details` / `stack` 原文带回模型。
- 服务对象：报表闭环中「模型侧驱动查询 / 记账、本机侧看原文」的边界，后续接到 `agent-tools.mjs` / `server.mjs` / MCP 上。
- 用户明确约束：
  - 本机单用户、多账套批量；**不做 SaaS / 多租户 / 权限平台 / 账户体系**；
  - 税局专项继续暂停，不读真实账套 / 用户配置 / 凭据 / 私有采集 / 其他 worktree；不操作浏览器与税局后端；
  - 自动测试只用**合成内存对象**或新临时库，不连旧后端、不绕沙箱；
  - 只允许新增 5 个文件（本任务单、交接、契约、模块、测试），**不得改** `agent-tools.mjs` / `server.mjs` / MCP / `db.mjs` / `scripts/test-all.mjs` / 索引；
  - 不执行 Git 提交 / 推送 / 合并。
- 非目标：
  - 不做引用落盘 / 跨重启持久化、不做多用户隔离与审计落库；
  - 不改 `accounting.mjs` 任何记账算法、事务、返回结构；
  - 不新增依赖、不做大规模重构；
  - 不新增 MCP 工具；不把本机读取能力暴露成模型可调用的工具。
- 已知未知：接线后真实 Agent / MCP 链路的表现未验证；`finance_query` 未实现能力的入口处理由接线任务决定。

## 3. 输入 / 输出

- 输入（既有领域结果，形状对齐 `accounting.mjs`）：`getAccountSet` / `listAccounts` / `listVouchers` / `getVoucher` / `balanceSheet` / `incomeStatement` / `cashFlowStatement` / `trialBalance` / `generalLedger` / 写动作返回（凭证、期间、期初、卡片、折旧、结转、旧账导入）。
- 输出：
  - 模型通道信封：`projection`（白名单数值 / 状态 / 期间）、`localRef`、`refPersistence`、`refExpiresAt`、`rawValuesIncluded:false`；写动作额外 `applied`（true/false/"unknown"）、`needsLocalReview`、`appliedReason`、`refUnavailable`。
  - 本机通道：`localRead` 原数据、`localCompute` 受限算术结果（sum / count / min / max）。
  - 安全错误投影：`safeErrorProjection`。
- 文件范围（全部新增）：
  - `06-workbench/server/finance-output-policy.mjs`
  - `06-workbench/test/finance-output-policy.test.mjs`
  - `docs/FINANCE-OUTPUT-BOUNDARY.md`
  - `docs/tasks/LOCAL-08.md`
  - `docs/handoffs/LOCAL-08.md`
- 下游消费者：接线任务（Agent 工具 / HTTP / MCP 后端）、本机 UI 读取入口。

## 4. 验收标准

- 功能验收（合成数据，独立预期值）：
  1. 查询 projection 只含登记字段且数值与手算一致（资产负债表合计 / 4 个代码常量口径、凭证合计、试算平衡、利润表、现金流、明细账期末余额、期末盘点、科目与账套枚举）。
  2. 序列化模型信封**不含**任何合成敏感标记（企业名、科目名、科目编码、摘要、往来、人员、源文件路径、纳税人识别号）。
  3. `localRead` 返回**同一原对象**，且包装 / 读取前后原结果深度相等（不改记账结果）。
  4. `localCompute` 的 sum / count / min / max 与手算一致；空数组路径返回 `empty:true`；非法 op / path 报错。
  5. 写动作 `applied` 三态：有正面证据才 true；`{}` → unknown + `needsLocalReview`；缺 `voucherId` → unknown；`dryRun` → false（`dry_run`）；折旧无需计提 → false（`nothing_due`）；`runWrite` 抛错 → `ok:false, applied:"unknown"` + 安全错误。
- 边界与失败路径：引用伪造 / 畸形 / 过期 / 撤销 / 跨账套 / 换 operation / 容量上限；`channel` 伪造（`local:true`、`channel:"local"`、JSON 克隆对象、已释放通道）；错误对象敏感原值；循环引用、访问器属性、类实例、超量数组 / 节点、原型链注入、奇怪类型、自由文本与中文名。
- 本轮审查返工新增验收（对应 §8 表里 1–5 项）：
  1. operation 必须是**已登记的原始字符串**：带 `toString` 的对象 / `new String(...)` / Symbol 均拒，且不得调用 `toString`、不得把对象放进信封；
  2. `runWrite` 在未登记 operation / 错账套 / 缺回调时**从未执行回调**（负例断言 `calls === 0`）；
  3. 访问器属性不会在摘要阶段被触发（enumerable 索引 getter / 证据字段 getter），写后失败仍输出安全信封与可证实 `applied`，原始 `message` / `details` / `stack` 不出现；
  4. 单值字节预算与累计字节预算各自可挡（合成字符串验证字节与节点两种预算），撤销 / 到期后扣减；
  5. 所有引用调用（含 `resolveForModel` / `revokeLocalRef`）必须显式 `accountSetId` + `operation`，不存在缺省账套路径。
- 独立验证：预期值全部手写在测试里，不从实现反推（不是镜像实现）；敏感标记用非十六进制字符，避免与随机引用撞串。
- 验证命令与期望：

```bash
cd 06-workbench
node test/finance-output-policy.test.mjs
# 期望：28/28 passed，exit 0
```

- 不通过处理：退回同一员工修复，记录阻塞；不得删改旧断言或放宽到「只要不报错」。

## 5. 文件所有权与共享改动协商

- 本任务**只新增**上述 5 个文件；**未触碰**任何共享受控文件：`accounting.mjs`、`coa.mjs`、`db.mjs`、`server.mjs`、`agent-tools.mjs`、`05-reconstruction/codex/mcp/finance-mcp/*`、`06-workbench/scripts/test-all.mjs`、`package.json`、`public/*`、`docs/INDEX.md`、`docs/handoffs/STATE.md`、`docs/tasks/README.md`。
- 上述共享文件归并行任务 LOCAL-01（Issue #43）所有；接线（含把本套件登记进 `scripts/test-all.mjs`）必须等管理者释放后另行集成，本任务不申请短期所有权。
- 新模块归属：`finance-output-policy.mjs` 为 LOCAL-08 独占新增模块，不属 `report-export` / `tax-report-format` / `tax*` / `import*` 既有归属。
- 本轮返工的 API 形状变化（仅限本模块，未接线所以无兼容影响）：`resolveForModel` / `revokeLocalRef` 现在必须带 `accountSetId` + `operation`；`stats()` 新增 `nodes` / `nodeBudget` / `bytes` / `byteBudget`；新增 `inspectRawValue` 导出（`measureRawValue` 保留）。

## 6. 依赖 / 基线 / 阻塞路径

- 前置依赖：无（纯模块 + 合成测试可先于接线开发）。
- 可并行做前置：本模块的契约与测试**已可独立完成并自测**；**不等于**整条链路通过。
- 阻塞路径：真实入口接线依赖 LOCAL-01 释放共享文件；不因此改共享文件或建替代入口。
- 基线更新时重验范围：若 `accounting.mjs` 返回结构变化，需重跑本套件并核对 projection spec。

## 7. 成员 / 执行员工模型

- 人类成员：本机任务派工方；执行员工本机 pi。
- 执行员工模型：主 / 回退均 `tokenhub/deepseek-v4.1-flash`（显式锁定）。
- 是否使用其他模型 / 子 agent：**否**。
- 管理者是否独立于员工做内容审查：**是，待进行**（本任务单不代替审查结论）。
- 管理者是否直接补写业务代码 / 测试 / 交付文档：**否**（如有缺陷退回员工）。

## 8. 独立验证记录

- 首轮员工自测（事实）：`cd 06-workbench && node test/finance-output-policy.test.mjs` → `22/22 passed`，exit 0（合成内存对象，无数据库、无网络）。
- 首轮独立审查结论（事实）：单测 22/22 虽通过，但发现 5 项真实缺陷（见下表），首轮交付不能算验收通过。
- 本轮返工修复（review1，已逐项落地并补回归）：

| # | 严重度 | 审查发现 | 本轮修复 |
|---|---|---|---|
| 1 | P1 | `own(WRITE_SPECS, operation)` 触发 `ToPropertyKey`；`{toString(){return "voucher_create"}, enterprise: …, details:{path: …}}` 被当合法 operation，**对象原样进信封**（`JSON.stringify` 含敏感标记）；`wrapQuery` 同类问题 | operation 一律先 `typeof === "string"` 再查表；信封只放登记表常量；错误文案不含入参；`resolveForModel` / `localRead` / `localCompute` / `revokeLocalRef` 的 operation 同样只接受字符串且不做字符串转换 |
| 2 | P1 | `runWrite("unregistered_write", {execute})` 先把回调执行完（`calls=1`）才报 `unknown_operation`，有“写后包装失败被当成业务失败而重试”的风险 | 预校验（operation / `accountSetId` / `execute`）全部前移到回调之前；负例断言回调未执行，并有正例证明合法调用确实执行一次 |
| 3 | P2 | `sumField` 等用 `list[i]` 触发索引 getter；形状测量在摘要之后；写后摘要/留存失败直接外抛原文 `Error`，无 `applied` 与安全信封 | 全部改用 `getOwnPropertyDescriptor` 读自有 data 属性（包括数组长度 `length`）；**先做形状 + 预算检查再看摘要**；写后证据/摘要/引用失败只降级为固定 `refUnavailable`，`applied` 未知用 `"unknown"`（不反转为失败/伪成功）；原始 `message`/`details`/`stack` 不进安全路径；文档明确**不声称零 Proxy 陷阱** |
| 4 | P2 | 内存预算只有节点数：8 MiB 字符串被当少量节点，256 refs 可留存超量原文 | 新增单值字节预算 `valueBytes`（默认 4 MiB）与累计 `byteBudget`（默认 64 MiB），与节点预算并列；到期 / 撤销 / `dispose` 归还占用；`stats()` 增 `nodes` / `bytes` / 两个预算供核对 |
| 5 | P2 | 账套绑定契约不一致：`resolveForModel` 允许缺省账套、`revokeLocalRef` 忽略账套 / operation，但文档说两通道都要显式账套 | 统一为**凡引用调用都必须显式核验 `accountSetId` 与 `operation`**（含 resolve / revoke）；跨账套、换工具、缺省上下文均拒；全局工具必须另定 scope 语义，不得伪造默认账套（已写入契约 §2 / §9.7） |

- 本轮员工自测（事实）：`cd <worktree>/06-workbench && node test/finance-output-policy.test.mjs` → `Finance output policy acceptance: 28/28 passed`，exit 0（旧 22 项含义保留，另增 6 项 review1 回归：operation 严格字符串 / 预校验先于执行 / 访问器与写后降级 / 字节预算 / 统一绑定 / Proxy 安全边界）。
- 工作区卫生（事实）：同目录 `node test/accounting-guards.test.mjs` → `23/23 通过`，exit 0；全量 `scripts/test-all.mjs`（44 套）**未重跑**——本包未改任何既有文件，且该入口归 LOCAL-01（#43）。
- 管理者验证：**待填写**（须自行读实际 diff、重跑命令、核对边界；未运行不得预先声称通过）。
- 本轮审查复核（同一独立 reviewer）：**待进行**；本文件不预报复核结论。
- 已审查 head / 合并：**待填写**（未提交、未建 PR、未合并）。

## 9. 真实数据边界

- 是否触碰真实账套 / 凭据：**否**。测试全程只用合成内存对象。
- 临时数据目录：**未创建**（本套件不建库、不读 `WORKBENCH_DATA_DIR`）。
- 是否访问真实税局 / 外部系统：**否**。
- 凭据 / 会话 / 验证码：未涉及。
- 未覆盖生产库、未绕过沙箱：是。

## 10. 验证 head

- 已审查的完整 head SHA：待管理者 / 复核人填写（本轮仅在分支 `codex/huxiaoyang-code/local-08` 工作区未提交）。
- 合并前基线：`0c4e0dd622fc35bcb5d6e6af3620c6f971b2a805`（本次基线）。
- 基线变动后的重验范围：待管理者核定。
- 合并 SHA：未合并。

## 11. 自动合并权限 / 协调记录

- 自动合并：按项目授权由已登记成员自己的本机 Codex 审查验收后执行；**本文件不构成合并证据**。
- 跨成员评审：纯新增模块、无共享文件改动，按协议可由成员本机 Codex 自审后合并；接线改动需另走集成 PR。
- 合并协调：与 LOCAL-01（#43）**无文件交集**，无需串行；接线任务必须串行到 LOCAL-01 之后。
- 已知限制：GitHub 不能原子锁 base。
- 是否触发权限 / 仓库设置变更：否。

## 12. 回退与交接

- 回退：`revert` PR（禁止重写 main 历史）；本模块未被任何入口引用，回退不影响既有行为。
- 交接文档：[handoffs/LOCAL-08](../handoffs/LOCAL-08.md)。
- 仍运行进程：无（本轮多次前台 `node` 测试进程均已退出，逐次核对退出码）。
- 下一任务输入：接线任务读 [FINANCE-OUTPUT-BOUNDARY](../FINANCE-OUTPUT-BOUNDARY.md) §8 / §9（最小 API + 接线清单），并在 LOCAL-01 合并后基于最新 `origin/main` 重验。

---

授权继承自 [项目章程](../PROJECT-CHARTER.md) 与用户后续指示；任务单**不能扩大授权**。
协作规则见 [团队协作协议](../TEAM-COLLABORATION.md)。
