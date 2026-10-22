# 交接 · LOCAL-03a 阶段 A（纯 profile / 报表规则）→ 阶段 B1（持久 profile + 真实领域 / 迁移）

- 状态：**阶段 A 47866a3 已独立接受 / root 41 项；阶段 B1 已在 worktree 实现并自测（17 + 6 项新领域 / 迁移，
  B1 清单全绿）；B1 独审返修 R1（5 项具体缺陷）已实现并自测（新 8 项）但仍未独立复审；
  未提交、未推送、未建 PR、未合并；HTTP / Agent / MCP / 导出 / v5 备份 / test-all / 全套仍属 B2**
- 阶段 A 基线：`98977e04bd24aa293074021802191814f8c2a1d2`；B1 实际 main
  `dfefae0553052474b8a9308105443714bc5d9cfb`（LOCAL-02 #47 / PR #60 已合），本地合入后起点 `f7e69bd`
- 分支：`codex/huxiaoyang-code/local-03a`；worktree 目录名 `local-03a`（本机绝对路径只交 root 的 ignored 记录）
- 负责人：`huxiaoyang-code`；Issue [#56](https://github.com/huxiaoyang-code/youshu-fork/issues/56)（`Refs #20` / `#13` / `#14`）
- 任务单：[tasks/LOCAL-03a](../tasks/LOCAL-03a.md) · 契约：[ACCOUNTING-STANDARDS](../ACCOUNTING-STANDARDS.md)

> 下文 §1–§7 是阶段 A 的历史记录（保留不覆盖）；B1 实际变化、测试与待办见 §8。

## 1. 本次实际完成

六个新增文件（未改动任何既有文件）：

| 文件 | 内容 |
|---|---|
| `06-workbench/server/accounting-profiles.mjs` | 三 profile（legacy / 小企 2011 / 企业 2019 一般）科目表、17 项角色、来源、scope 三态；新建 profile 选择与结构化拒绝 |
| `06-workbench/server/accounting-report-rules.mjs` | 内部资产负债表 / 利润表行项目与合计依赖、科目解析、纯计算、现金流对方科目分类、legacy 兼容分支 |
| `06-workbench/test/accounting-standard-profiles.test.mjs` | 41 项定向回归（原 31 + 第一轮独审回修 7 + 第二轮最小回修 3），纯内联合成数据 |
| `docs/tasks/LOCAL-03a.md` | 任务单与阶段 A / B 边界 |
| `docs/handoffs/LOCAL-03a.md` | 本交接 |
| `docs/ACCOUNTING-STANDARDS.md` | 接口、金额契约、来源、支持 / 不支持范围、错误码 |

## 2. 测试证据（实际执行）

- 工作目录：`06-workbench`
- 命令：`node test/accounting-standard-profiles.test.mjs`
- 结果：**41 / 41 通过，exit 0**（2026-10-22）
- 第一轮独审回修先红后绿：新增 7 项回归在修复前为 **31 / 38（7 项红）**，修复后 **38 / 38 绿**；
  原 31 项保持通过。
- 第二轮独审最小回修先红后绿：新增 3 项回归在修复前为 **38 / 41（3 项红）**，修复后
  **41 / 41 绿**。同时修正旧错误：
  1. 小企 `2221` 借方余额曾被 blanket 反向判断置 0 且 `complete=false`；现按小企附录第73页(28)
     以负号保留在本行，旧测试“`2221` 借方应 incomplete”的错误预期已删除，改用 `2201` 未定义反向余额。
  2. `1604` 在建工程曾无条件 `investing`；现两 profile 均 `unknown` +
     `construction-in-progress-purpose-ambiguous`（资本化借款利息应 `financing`、工程人员薪酬应 `operating`）。
  3. 来源元数据曾把 85 页小企附录的 80-82 页挂到 18 页企业2019附件2；现分别记录
     小企第69/70/72/73/80-82页与企业第2-3、4-8、15-16页，并以 `pageCount: 85 / 18` 校验
     （按官方 PDF 实际页数与条目逐页核对）。
  以上均为本轮员工自测事实，**不代表独立复审已通过**。
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
  `balanceSheet.reciprocal` 含往来反向列示映射与未解决原因；
  `cashFlow` 含 `operatingRoots / investingRoots / financingRoots / ambiguousRoots / unsupported`。
- `resolveAccountingAccountRule(profileId, account)`：`matchedRoot / isDetail / roles / effective /
  scope / statements / compatible / diagnostics`。`statements.balanceSheet` 对损益科目为
  `{ rowId: "unclosed-profit", via: "undistributed-profit" }`。
- `evaluateAccountingStatement(profileId, { kind, accounts, amounts })`：
  返回 `{ profileId, reportMappingVersion, engineMode, kind, complete, rows, totals,
  reclassifications, diagnostics }`，深度冻结。`reclassifications` 记录已确定的往来反向余额列示
  （`accountCode / matchedRoot / fromRowId / toRowId / amountMinor`），不产生错误诊断。
  legacy → `complete:false`、`rows: []`、`totals: {}`、`reclassifications: []`、`legacy_engine_required`。
- `classifyAccountingCashCounterpart(profileId, account)`：
  `{ accountCode, matchedRoot, category: operating|investing|financing|unknown, reason }`。

### 3.3 金额输入（阶段 B 必须遵守）

- `accounts`：账套科目形状 `{ code, category, direction, contra? }`，`code` 唯一且为 4 位以上数字。
- `amounts`：`[{ code, netMinor }]`，安全整数分、借减贷、各科目自身金额；BS 为期末余额，
  IS 为明确时间窗内排除结转的损益发生净额。
- 必须由 LOCAL-02 的金额函数与已验证查询生成，**不重写舍入**；本模块不做期间 / posted 筛选、
  不计提、不解析货币字符串或浮点元。
- 金额非法 / 重复 code / amounts 引用不存在科目 / 累计溢出安全整数 → 抛结构化错误。

### 3.4 往来反向余额与现金流分类（第一轮 + 第二轮独审回修）

- 资产负债表按每个科目自身余额方向逐项判断，不先把同一行明细净额相加。小企
  `1122` 贷方→`2203` 预收账款、`2203` 借方→`1122` 应收账款、`2202` 借方→`1123` 预付账款、
  `1123` 贷方→`2202` 应付账款；重分类写入 `reclassifications`，`complete` 保持 true。
- 小企 `2221` 期末借方余额按附录第73页(28)以负号列示：保留在“应交税费”本行，
  不按往来反向诊断、不改列其他行；`getAccountingReportRules(SMALL).balanceSheet.negativePresentation`
  暴露该 profile / 科目规则。合法负列示、备抵常规余额、亏损红冲与往来重分类分开处理。
- 企业仅 `2202` 借方→预付款项、`1123` 贷方→应付账款可确定列示；`1122` 贷方 / `2203` 借方
  涉及预收款项与合同负债 / 合同资产细类，给 `account_reverse_balance_requires_detail` 且
  `complete=false`。其他未定义列示行的相反余额同样 incomplete，不静默冲减，也不称“期限重分类暂缓”。
- 现金流：`1131/1132` → `investing`；`1123`、`5603/6603`、`5301/6301`、`5711/6711`、
  `1221/2241`、`1801` 用途不明 → `unknown` + 固定 reason；`1604` 在建工程用途不明
  （购建支出 / 资本化借款利息 / 工程人员薪酬）→ `unknown` +
  `construction-in-progress-purpose-ambiguous`，两 profile 均不无条件列为 `investing`。
  单一对方科目不构成分类充足；现金 / 受限现金 / 现金等价物仍 `unknown`，
  `1601/1701` 等可判断正向分类保留。

### 3.5 诊断码（出现即 `complete:false`）

`account_unmapped`、`account_category_conflict`、`account_direction_conflict`、`account_contra_conflict`、
`account_requires_detail`、`account_scope_unsupported`、`account_scope_unknown`、
`account_out_of_statement`、`account_reverse_balance_requires_detail`、`legacy_engine_required`。
完整清单与语义见 [ACCOUNTING-STANDARDS](../ACCOUNTING-STANDARDS.md) 第 9 节。

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

1. 先核对 Git 事实：本 worktree 分支 = `codex/huxiaoyang-code/local-03a`；阶段 A 基线 `98977e04…`；
   B1 已把 actual main `dfefae0…` 合入（本地起点 `f7e69bd`）。确认 `git status --porcelain` 只有 B1 清单内文件。
2. 重跑 B1 定向自测（cwd `06-workbench`）：
   `node test/accounting-standard-profiles.test.mjs`（41）、`node test/accounting-standards.test.mjs`（16）、
   `node test/accounting-standards-migration.test.mjs`（6），以及 §8.3 的受影响旧套件。
3. 读 [tasks/LOCAL-03a](../tasks/LOCAL-03a.md) §8、[ACCOUNTING-STANDARDS](../ACCOUNTING-STANDARDS.md) §11，
   再按 root 当时最新 main 复核 LOCAL-02 / LOCAL-05 / LOCAL-08 / 银行 #53 的实际接口。
4. B2 使用**新的精简员工会话**（新进程、`--no-session`，不 resume），只载入本阶段任务材料；
   共享文件必须先取得 root 明确扩窗。
5. 阶段 A / B1 的测试预期是手算字面量，**不得**为了让实现通过而改写预期数字；语义冲突交员工处理，不覆写成果。

## 6. 已知限制 / 未完成

- legacy profile 的 `evaluate` 故意不计算：阶段 B 必须接入真实旧兼容报表路径并验证原值，
  在接线完成前不得对外声称 legacy 报表可用新规则。
- 现金流分类只覆盖单一对方科目、可解释的基础交易；用途 / 细类不明的科目明确 `unknown`
  + 固定 reason，不冒充 `operating / investing / financing`。复合凭证分摊、现金等价物 /
  受限资金、完整现金流量表与间接法调节表未实现（归阶段 B / LOCAL-05b）。
- 往来反向余额只列示已核实配对；企业预收款项 / 合同负债、合同资产细类，以及其他未定义
  列示行的相反余额给 incomplete，不伪造完整。流动 / 非流动期限重分类（如一年内到期的长期借款）
  仍未实现，与上述往来反向余额列示不是同一事项。
- 未实现业务：金融工具分类计量（含财会〔2026〕7号解释第20号相关衔接与货币缺乏可兑换性）、
  长期股权投资、租赁、递延所得税、减值计算、复杂合同 / 履约成本 / 退货、合并报表、外币、行业专用业务、
  自动算税与税局申报格式。
- `requires_detail` / `unsupported` 科目在非零时只给诊断、不进入合计；阶段 B 需要设计「资料补录 → 再出报表」
  的用户路径，但**不得**据此伪造完整金额。
- 本阶段未跑全套回归，也不代表旧报表 / 旧导入行为未受影响（阶段 A 未改既有文件，但仍需阶段 B 回归证明）。
- **第二轮独审最小回修待复审**：小企 `2221` 合法负列示、两 profile `1604` 用途不明、来源页码
  错挂三项已修复并通过 `41/41`；仍需未参与实现的独立审查者对最新 diff、固定金额与来源页码
  实际文件页数复审。独立复审尚未给出通过结论。

## 7. 与 LOCAL-02 #47 的关系

阶段 A 从 root 核实的最新 main 独立实现纯模块，**不占用** #47 的 `accounting.mjs` / `db.mjs` /
`import-*.mjs` / `server.mjs` / agent / MCP / `test-all` / 公共文档窗口。阶段 B 必须等 #47 合并、
员工退出、远端文件归属释放后，由 root 纳入最新 main 再开工；若出现语义冲突交员工处理，
不得覆写阶段 A 成果，也不得跳过 LOCAL-02 的新备份 / v4 兼容要求。

## 8. 阶段 B1 实际交接待审（2026-10-22，未合并）

### 8.1 事实

- root 正式开窗：actual main `dfefae0553052474b8a9308105443714bc5d9cfb`（LOCAL-02 PR #60 已验收合并），
  阶段 A `47866a3278447db1c4243b9afd2aebe92ea78e55` 已独立接受 / root 41；本轮把实际 main 合入本 worktree 后开工，
  本地起点 `f7e69bd`（`merge: accepted LOCAL02 main for standards B1`）。
- 员工只做实现 / 自测 / 文档，不执行 Git 提交 / 推送 / 合并；Git 与独审归 root。
- 全部测试使用合成临时库 / 随机临时路径 / 新子进程；**未使用真实账套、税局凭据、私有采集或旧后端**；
  真实税局接入仍为 **0**。

### 8.2 实际改动文件（均在 B1 认领 19 文件内）

```text
M  06-workbench/server/accounting.mjs
M  06-workbench/server/coa.mjs
M  06-workbench/server/import-incremental.mjs
M  06-workbench/server/import-storage.mjs
M  06-workbench/server/period-end-controls.mjs
M  06-workbench/test/accounting-derived.test.mjs        # 仅必要合法 fixture（费用补资金来源）
A  06-workbench/test/accounting-standards.test.mjs
A  06-workbench/test/accounting-standards-migration.test.mjs
M  docs/tasks/LOCAL-03a.md
M  docs/handoffs/LOCAL-03a.md
M  docs/ACCOUNTING-STANDARDS.md
```

- `06-workbench/server/accounting-profiles.mjs`、`accounting-report-rules.mjs`、
  `test/accounting-standard-profiles.test.mjs` 保持阶段 A 已审内容未改。
- **未改**：`server.mjs`、`agent-tools.mjs`、MCP、`scripts/test-all.mjs`、`public/*`、package / 锁、
  公共 STATE / NEXT-SESSION / 任务索引 / INDEX / CHANGELOG、`local-backup.mjs` / CLI / 测试、
  `report-export.mjs`、`report-office-export.mjs`、`money.mjs`、`db.mjs`（迁移由 import-storage 执行）。
- `import-incremental.mjs` 额外导出 `batchFingerprint`（不改变指纹字段 / 排序），供迁移测试构造真实旧批次。

### 8.3 关键实现（细节见 `docs/ACCOUNTING-STANDARDS.md` §11）

- schema **v5**：`account_sets.accounting_profile_id TEXT NOT NULL DEFAULT 'legacy-small-coa-v1'`；
  迁移前一致备份 → 同事务加列 + 记版本；旧库所有账套一律 legacy，保留原 `accounting_standard` 与全部业务行 / 指纹。
- 建账 / 旧首次导入 / 增量 create 按准则选新 profile，同事务写账套 / 科目 / 首期间 / profile；
  非法 / 错配 / legacy 新建结构化拒绝；append 的 payload 标签不改 profile。
- `normalizeImportPayload(payload, context?)` 的内部 context 由服务端在定位 append 目标 / 旧已完成 create 批次后传入；
  先定位再严格归一化，旧 create 重放不再被新企业模板提前拒绝 5001 收入；旧指纹规则不变。
- 结转 / 年末 / 资产默认费用 / 期末检查 role 驱动：小企 / legacy `3103→3104`、`5602`；企业 `4103→4104`、`6602`；
  `period-end-controls` 不再硬编码 3103 / 3104 判断后续年末依赖；必要角色缺失写入前失败。
- 新 profile 三表由真实已过账余额 / 时间窗 + 阶段 A 规则计算；legacy 走真实旧兼容计算；
  三表新增 `accountingContext` / `reportStatus` / 固定外层诊断码；旧主要字段与单位不变。
- 现金流新 profile 只分类单一非现金对方科目，复合凭证给 `cash_flow_classification_incomplete`，
  不实现按比例分摊（B2 / 05b）。

### 8.4 实跑测试（cwd=`06-workbench`）

| 命令 | 结果 |
|---|---|
| `node test/accounting-standard-profiles.test.mjs` | 41 / 41 exit 0 |
| `node test/accounting-standards.test.mjs` | 17 / 17 exit 0 |
| `node test/accounting-standards-migration.test.mjs` | 6 / 6 exit 0 |
| `node test/accounting-guards.test.mjs` | 23 / 23 exit 0 |
| `node test/accounting-derived.test.mjs` | 31 / 31 exit 0 |
| `node test/accounting-period-integrity.test.mjs` | 45 / 45 exit 0 |
| `node test/import-strict.test.mjs` | 54 / 54 exit 0 |
| `node test/import-incremental.test.mjs` | 49 / 49 exit 0 |
| `node test/voucher-amount-guards.test.mjs` | 103 / 103 exit 0 |

顺带实跑（未列入 B1 必跑清单，只记录事实）：`accounting-period-http` 18 / 18、
`import-incremental-http` 22 / 22、`report-export-http` 29 / 29、`finance-output-policy` 37 / 37 均通过。

迁移证据（`accounting-standards-migration.test.mjs`）：v4 合成旧库先由已合 `local-backup` 生成备份并
`verify` / `restore-new` 到全新目录，恢复库由真实 `db.mjs` 入口升 v5 后 legacy 报表值 / 状态正确；
v4→v5 备份含 WAL 已提交批次、业务行 / 指纹 / 原标签不变；旧 create 批次在新进程中 `idempotent_replay`、
内容变化 `batch_content_changed`、append / 查询重启一致；v3→v5 与故障回滚 / 重试重新备份通过。

### 8.5 未通过 / 待 B2（未删断言、未谎称全套通过）

| 套件 | 实际结果 | 原因 / owner |
|---|---|---|
| `local-backup.test.mjs` | 初始化失败（`5 !== 4`），0 / 1 | 当前备份严格只支持 v3 / v4；v5 结构与完整备份 / 恢复待银行 #53 后 B2 增加 `STRUCTURE_V5`；B1 未改该文件 |
| `report-export.test.mjs` | 17 / 21 | 新 profile 行项目（累计折旧按阶段 A 为负值展示）、CSV 行集合、复合现金流分摊 / 混合现金分类；归 B2（05） |
| `smoke.test.mjs` | 27 / 28 | 新小企账套导入企业科目 `6602` 后报表明确 incomplete；归 B2 合法 fixture 适配 |
| `finance-model-adapter.test.mjs` | 20 / 21 | 资产负债表行数 39 vs 旧 28；归 B2（08 更新精确允许字段 / 计数） |

- **v5 备份工具当前明确拒绝**，B1 不宣称 03 整体可交付；v5 备份 / 恢复与银行 bank1 兼容矩阵在 B2 完成。
- 未接 HTTP / Agent / MCP / 导出 / Office；未注册 `test-all`；未改公共交接 / 索引。
- 原权威来源、2026 解释与受限基础业务范围保持；不宣称全准则或税局可申报。

### 8.6 下一步

1. root 独审 B1 实际 diff、固定金额与迁移证据；保留成果，不单独合并。
2. 等 05 / 08 / 银行 #53 实际释放并纳入最新 main 后，按 B1 精确清单扩窗 B2；
   员工不自行合 main、不抢锁。
3. B2 至少：入口接线、输出边界、五类导出 / Office 元数据与不完整提示、`local-backup` 精确 v3 / v4 / v5、
   真实 HTTP / Agent / MCP 连续链与失败路径、测试注册与公共交接；之后才谈 03 整体完成。

## 9. B1 独审返修 R1（2026-10-22，同模型新会话，未提交 / 未复审）

### 9.1 事实

- root 核实：上一员工进程退出 0，但最后一次 assistant 回复 `stopReason=error`（tokenhub 4000008，thinking
  历史参数不全），**不是实现完成**；`git status` 干净、HEAD 仍为 `ec4eace68f2a08d167dcb7eadd7d2acc55c45e58`，
  未产生 WIP，因此不恢复旧会话、不读原始日志，用同一已核模型（deepseek-v4.1-flash）全新 `no-session` 继续。
- 本包可写范围本轮为 11 文件（原 19 文件内的子集，`db.mjs` 已释放给 07，本轮未碰）。

### 9.2 实际改动（均为 11 文件内）

```text
M  06-workbench/server/accounting.mjs
M  06-workbench/server/period-end-controls.mjs
M  06-workbench/test/accounting-standards.test.mjs
M  06-workbench/test/accounting-standards-migration.test.mjs
M  docs/ACCOUNTING-STANDARDS.md
M  docs/tasks/LOCAL-03a.md
M  docs/handoffs/LOCAL-03a.md
```

- **未改**：`coa.mjs`、`import-storage.mjs`、`import-incremental.mjs`、`db.mjs`、`accounting-profiles.mjs`、
  `accounting-report-rules.mjs`（阶段 A 已审纯模块保持原样）、HTTP / Agent / MCP / 导出 / Office /
  test-all / package / 公共 STATE。

### 9.3 修复要点（细节见 [ACCOUNTING-STANDARDS](../ACCOUNTING-STANDARDS.md) §12）

1. 年末 / 损益结转前用**准则映射**校验参与科目（类别 / 方向 / 备抵），冲突在保存点外整体拒绝
   （`carryforward_account_semantics_conflict`）；方向取根科目权威语义；`addAccount` 写前拒绝冲突
   （`account_semantics_conflict`）；必要角色同时做语义校验（`accounting_role_semantics_conflict`）。
2. 利润表不再用库内 `category === 损益` 预过滤（按准则映射判断范围），冲突给
   `report_account_semantics_mismatch` + `complete=false`，并以 `unresolvedAmounts` 保留可审金额。
3. 现金流按 gross 方向拆分（流入 = 现金借方、流出 = 现金贷方），单方向单对方科目才分类；复合或多类别
   给 `unknown` + `direction` + `value`；不按比例分摊、不用净额 0 消除诊断。
4. 资产负债表 `balanced` 用整数分 `BigInt` 比较（不用浮点 `===`，不用 epsilon）。
5. `accounting_profile_unknown` 的 `details` 只回 `field` / `reason`，不再回显库内任意原始 profile 字符串。

### 9.4 实跑（cwd=`06-workbench`，合成临时库，TEMP/TMP 为本会话专属目录）

| 命令 | 结果 |
|---|---|
| `node test/accounting-standards.test.mjs` | **25 / 25 exit 0**（原 17 + R1 新 8） |
| `node test/accounting-standards-migration.test.mjs` | **6 / 6 exit 0**（加严未回显原值断言） |
| `node test/accounting-standard-profiles.test.mjs` | 41 / 41 |
| `node test/accounting-guards.test.mjs` | 23 / 23 |
| `node test/accounting-derived.test.mjs` | 31 / 31 |
| `node test/accounting-period-integrity.test.mjs` | 45 / 45 |
| `node test/import-strict.test.mjs` | 54 / 54 |
| `node test/import-incremental.test.mjs` | 49 / 49 |
| `node test/voucher-amount-guards.test.mjs` | 103 / 103 |
| `node test/local-audit.test.mjs` | 28 / 28 |
| `accounting-period-http` / `import-incremental-http` / `report-export-http` / `finance-output-policy` | 18 / 22 / 29 / 37 全通过 |

受控未通过（未删断言，仍归 B2）：`report-export` 18 / 21（原 17 / 21）、`smoke` 27 / 28、
`finance-model-adapter` 20 / 21、`local-backup` 0 / 1（v5 拒绝）；`report-office-export` 本 worktree 缺
`exceljs` 依赖无法运行（环境限制，如实记录，未安装依赖、未改 package）。

### 9.5 未完成 / 下一步

- 仍**未提交、未推送、未建 PR、未合并**，也未通过独立复审；root 需在 freeze 后做
  `review_standards03_final` 复审并决定后续。
- 仍属 B2：入口接线、导出 / Office 适配、v5 备份、测试注册、公共交接；复合现金流分摊 /
  受限资金 / 期限重分类等业务边界未变（见 [ACCOUNTING-STANDARDS](../ACCOUNTING-STANDARDS.md) §8 / §12）。
- 真实账套 / 税局 / 凭据全程未使用；真实税局接入仍为 0。
