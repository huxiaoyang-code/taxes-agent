# 交接 · LOCAL-03a 阶段 A（纯 profile / 报表规则预实现）

- 状态：**阶段 A 纯规则已实现并自测；尚未接线；阶段 B 未完成**
- 未提交、未推送、未建 PR、未合并；工作区修改保留在同一独立 worktree
- 基线：`98977e04bd24aa293074021802191814f8c2a1d2`（root 核实的最新 main，PR #55 合并后）
- 分支：`codex/huxiaoyang-code/local-03a`；worktree 目录名 `local-03a`（本机绝对路径只交 root 的 ignored 记录）
- 负责人：`huxiaoyang-code`；Issue [#56](https://github.com/huxiaoyang-code/youshu-fork/issues/56)（`Refs #20` / `#13` / `#14`）
- 任务单：[tasks/LOCAL-03a](../tasks/LOCAL-03a.md) · 契约：[ACCOUNTING-STANDARDS](../ACCOUNTING-STANDARDS.md)

## 1. 本次实际完成

六个新增文件（未改动任何既有文件）：

| 文件 | 内容 |
|---|---|
| `06-workbench/server/accounting-profiles.mjs` | 三 profile（legacy / 小企 2011 / 企业 2019 一般）科目表、17 项角色、来源、scope 三态；新建 profile 选择与结构化拒绝 |
| `06-workbench/server/accounting-report-rules.mjs` | 内部资产负债表 / 利润表行项目与合计依赖、科目解析、纯计算、现金流对方科目分类、legacy 兼容分支 |
| `06-workbench/test/accounting-standard-profiles.test.mjs` | 31 项定向回归，纯内联合成数据 |
| `docs/tasks/LOCAL-03a.md` | 任务单与阶段 A / B 边界 |
| `docs/handoffs/LOCAL-03a.md` | 本交接 |
| `docs/ACCOUNTING-STANDARDS.md` | 接口、金额契约、来源、支持 / 不支持范围、错误码 |

## 2. 测试证据（实际执行）

- 工作目录：`06-workbench`
- 命令：`node test/accounting-standard-profiles.test.mjs`
- 结果：**31 / 31 通过，exit 0**（2026-10-22）
- 性质：纯函数单测；无数据库、无临时库、无 HTTP / MCP / 服务启动、无网络、无真实账套或凭据。
- 未执行（按任务单不在阶段 A 范围）：`npm test` 全套、受影响会计 / 导入 / 报表套件、
  任何迁移 / 建账 / 过账 / 结转 / 封账 / 导出验证。

## 3. 阶段 B 可直接消费的接口

### 3.1 profile 选择

```js
import {
  listAccountingProfiles,
  getAccountingProfile,
  resolveNewAccountingProfile,
  getAccountingRoles,
} from "./accounting-profiles.mjs";
```

- `getAccountingProfile(profileId)`：深度冻结、可序列化；未知 ID 抛 `accounting_profile_unknown`（不 fallback）。
- `resolveNewAccountingProfile({ accounting_standard, profileId })`：
  省略准则 → `small-2011-basic-v1`；合法准则只有精确的「小企业会计准则」「企业会计准则」；
  legacy 不可新建（`accounting_profile_legacy_not_creatable`）；错配（`accounting_profile_standard_mismatch`）；
  非法准则 / 空白 / 非对象（`accounting_standard_invalid`）。**不做任何写入。**
- 角色键（17）：`cashRoots`（数组）、`capital`、`capitalReserve`、`surplusReserve`、`currentYearProfit`、
  `profitDistribution`、`productionCost`、`mainRevenue`、`otherRevenue`、`mainCost`、`otherCost`、
  `adminExpense`、`defaultDepreciationExpense`、`fixedAsset`、`accumulatedDepreciation`、
  `intangibleAsset`、`accumulatedAmortization`。

### 3.2 报表规则与计算

```js
import {
  getAccountingReportRules,
  resolveAccountingAccountRule,
  evaluateAccountingStatement,
  classifyAccountingCashCounterpart,
} from "./accounting-report-rules.mjs";
```

- `getAccountingReportRules(profileId)`：`engineMode` 为 `profile-rules` 或 `legacy-compatibility`；
  两个报表含 `rows[]`（`rowId / label / kind: accounts|subtotal|unclosed-profit / natural / roots / terms`）、
  `totals`（`assets / liabilities / equity / liabilitiesAndEquity` 与
  `operatingRevenue / operatingProfit / totalProfit / netProfit`）、`unsupported`、`requiredDetails`；
  `cashFlow` 含 `operatingRoots / investingRoots / financingRoots / ambiguousRoots / unsupported`。
- `resolveAccountingAccountRule(profileId, account)`：`matchedRoot / isDetail / roles / effective /
  scope / statements / compatible / diagnostics`。`statements.balanceSheet` 对损益科目为
  `{ rowId: "unclosed-profit", via: "undistributed-profit" }`。
- `evaluateAccountingStatement(profileId, { kind, accounts, amounts })`：
  返回 `{ profileId, reportMappingVersion, engineMode, kind, complete, rows, totals, diagnostics }`，深度冻结。
  legacy → `complete:false`、`rows: []`、`totals: {}`、`legacy_engine_required`。
- `classifyAccountingCashCounterpart(profileId, account)`：
  `{ accountCode, matchedRoot, category: operating|investing|financing|unknown, reason }`。

### 3.3 金额输入（阶段 B 必须遵守）

- `accounts`：账套科目形状 `{ code, category, direction, contra? }`，`code` 唯一且为 4 位以上数字。
- `amounts`：`[{ code, netMinor }]`，安全整数分、借减贷、各科目自身金额；BS 为期末余额，
  IS 为明确时间窗内排除结转的损益发生净额。
- 必须由 LOCAL-02 的金额函数与已验证查询生成，**不重写舍入**；本模块不做期间 / posted 筛选、
  不计提、不解析货币字符串或浮点元。
- 金额非法 / 重复 code / amounts 引用不存在科目 / 累计溢出安全整数 → 抛结构化错误。

### 3.4 诊断码（出现即 `complete:false`）

`account_unmapped`、`account_category_conflict`、`account_direction_conflict`、`account_contra_conflict`、
`account_requires_detail`、`account_scope_unsupported`、`account_scope_unknown`、
`account_out_of_statement`、`legacy_engine_required`。完整清单与语义见
[ACCOUNTING-STANDARDS](../ACCOUNTING-STANDARDS.md) 第 9 节。

## 4. 阶段 B 待办（未授权文件，需 root 扩大远端认领）

原任务第 7 节列出的共享 / 核心文件仍**未授权**，至少包括：
`06-workbench/server/coa.mjs`、`accounting.mjs`、`db.mjs`、`import-storage.mjs`、
`import-incremental.mjs`、`period-end-controls.mjs`（仅去硬编码 / 调新 profile，不重写已验控制）、
`server.mjs`、`agent-tools.mjs`、`05-reconstruction/codex/mcp/finance-mcp/tools.mjs`、
`scripts/test-all.mjs`（追加套件）；`money.mjs` 只读复用。

需 root 单独协调窗口：`server/report-export.mjs`、`test/report-export*.test.mjs`（仅 profile / 诊断 / 行项目透传，
不改导出格式、不接管报表所有权）。

新增测试文件（阶段 B 计划）：`accounting-standards.test.mjs`、`accounting-standards-migration.test.mjs`、
`accounting-standards-http.test.mjs`、`finance-mcp/accounting-standards-test.mjs`。
既有测试如需更新合法 fixture，仅限原任务列出的会计 / 导入 / MCP 套件，且不得删除断言或降精度。

阶段 B 的完整不可减免门槛见 [tasks/LOCAL-03a](../tasks/LOCAL-03a.md) 第 6 节：
持久 profile 迁移与一致性备份 / WAL 恢复 / 失败原子性、旧账套全 legacy 且历史不改写、
旧 create 批次重放与 append 指纹兼容、一企一账套、新建 / 导入 / 资产 / 期末检查 / 跨年结转真实接线、
HTTP / Agent / MCP / 导出诊断透传、两组完整手算连续链、受影响回归 + 全套、独立内容审查与已审 head 串行合并。

## 5. 恢复步骤

1. 先核对 Git 事实：本 worktree 分支 = `codex/huxiaoyang-code/local-03a`，基线 `98977e04…`；
   确认六个新增文件未被其他包改写（`git status --porcelain` 应只有这六个文件）。
2. 重跑定向自测：在 `06-workbench` 执行 `node test/accounting-standard-profiles.test.mjs`，期望 `31/31`、exit 0。
3. 读 [tasks/LOCAL-03a](../tasks/LOCAL-03a.md) 第 6 节与 [ACCOUNTING-STANDARDS](../ACCOUNTING-STANDARDS.md)，
   再按 root 当时最新 main 复核 LOCAL-02 交接与实际 `money.mjs` / 迁移版本接口。
4. 阶段 B 使用**新的精简员工会话**（新进程、`--no-session`，不 resume），只载入本阶段任务材料；
   共享文件必须先取得 root 明确认领。
5. 阶段 A 的测试预期是手算字面量，**不得**为了让实现通过而改写预期数字；语义冲突交员工处理，不覆写成果。

## 6. 已知限制 / 未完成

- legacy profile 的 `evaluate` 故意不计算：阶段 B 必须接入真实旧兼容报表路径并验证原值，
  在接线完成前不得对外声称 legacy 报表可用新规则。
- 现金流分类只覆盖单一对方科目、可解释的基础交易；复合凭证分摊、现金等价物 / 受限资金、
  完整现金流量表与间接法调节表未实现（归阶段 B / LOCAL-05b）。
- 未实现业务：金融工具分类计量（含财会〔2026〕7号解释第20号相关衔接与货币缺乏可兑换性）、
  长期股权投资、租赁、递延所得税、减值计算、复杂合同 / 履约成本 / 退货、合并报表、外币、行业专用业务、
  自动算税与税局申报格式。
- `requires_detail` / `unsupported` 科目在非零时只给诊断、不进入合计；阶段 B 需要设计「资料补录 → 再出报表」
  的用户路径，但**不得**据此伪造完整金额。
- 本阶段未跑全套回归，也不代表旧报表 / 旧导入行为未受影响（阶段 A 未改既有文件，但仍需阶段 B 回归证明）。

## 7. 与 LOCAL-02 #47 的关系

阶段 A 从 root 核实的最新 main 独立实现纯模块，**不占用** #47 的 `accounting.mjs` / `db.mjs` /
`import-*.mjs` / `server.mjs` / agent / MCP / `test-all` / 公共文档窗口。阶段 B 必须等 #47 合并、
员工退出、远端文件归属释放后，由 root 纳入最新 main 再开工；若出现语义冲突交员工处理，
不得覆写阶段 A 成果，也不得跳过 LOCAL-02 的新备份 / v4 兼容要求。
