# 第一阶段验收（PHASE 1 ACCEPTANCE）

本文是第一期记账/报表闭环的**可复现验收说明**：命令、覆盖范围、独立预期值与能力边界。
它不替代 `docs/CAPABILITY-AUDIT-2026-10-13.md`（现状盘点）或 `docs/handoffs/STATE.md`（阶段状态），
后两者由管理者维护。核验日期：2026-10-13；开发基线：`91b623a`；管理者验收基线包含 TAX 合并 `f4d9f82`。

## 1. 验收目标

在**不接触真实账套数据、不连接 8787、不使用外部网络**的前提下，用临时后端 + stdio MCP
复现并核对以下闭环：

> 导入旧账（4 张示例 CSV，预检 → 正式导入）→ 新建临时账套并录期初 → 销售/费用凭证（校验→草稿→过账）
> → 资产购入凭证 + 资产卡片 → 计提月折旧 → 结转损益 → 报表/现金流/资产勾稽 → 结账、反结账、新期间。

同时提供单一回归入口，串起全部第一阶段测试并按退出码汇报。

## 2. 命令与工作目录

```bash
# 全套回归（推荐）：guards → derived → 原 smoke → MCP contract → workflow → tax（必跑）
cd 06-workbench
npm test                       # = node scripts/test-all.mjs
npm run test:smoke             # 只跑原工作台端到端

# 单独运行闭环验收（自建临时后端 + 临时数据目录）
cd 05-reconstruction/codex/mcp/finance-mcp
node workflow-test.mjs
```

- `06-workbench/scripts/test-all.mjs` 用 `process.execPath` + `spawnSync`（继承 stdio）顺序运行，
  失败退出码非 0；税务契约在 `tax-contract-test.mjs` 尚未合并时**明确打印跳过，不计为通过**，
  此时汇总结论是"已执行步骤通过"，**不是全套验收**。
- `workflow-test.mjs` 自己选择空闲端口、`mkdtempSync` 临时数据目录，并在结束时仅清理自身
  子进程与临时目录；工程 `06-workbench/data/` 不参与、不修改。

## 3. 覆盖矩阵

| 入口 | 位置 | 覆盖 |
|---|---|---|
| guards | `06-workbench/test/accounting-guards.test.mjs` | 期初校验/原子性、封账读写保护、期间校验 |
| derived | `06-workbench/test/accounting-derived.test.mjs` | 明细归集、结转（含零利润/年末/重算/原子性）、折旧状态一致性 |
| import-strict | `06-workbench/test/import-strict.test.mjs` | 导入严格校验（非法/合法金额、负数与超界舍入前判定、空白策略、日期逐行与不一致、凭证号、形状/类型、重复期初、科目/期初/凭证约束、预检与正式一致、完整内容快照不污染、CSV 辅助字段不得绕过 `date`/`number`、parse→JSON 往返正例、HTTP/Agent 入口集成、事务回滚） |
| smoke | `06-workbench/test/smoke.test.mjs` | 工作台端到端（账套/凭证/报表/折旧/结转/结账/Agent 工具/导入） |
| contract | `05-reconstruction/codex/mcp/finance-mcp/contract-test.mjs` | MCP 工具契约、错误路径、导入默认预检、后端不可达 |
| workflow | `05-reconstruction/codex/mcp/finance-mcp/workflow-test.mjs` | 临时账套业务闭环 + 独立预期金额勾稽 |
| tax | `05-reconstruction/codex/mcp/finance-mcp/tax-contract-test.mjs` | 税务网关契约与异步状态机（本地假适配器，已纳入必跑） |

## 4. workflow 的独立预期值（可审计）

预期值来自仓库内示例 CSV 与手写业务常量，**不是后端同源函数的输出**。

### 4.1 示例旧账（`05-reconstruction/examples/legacy-book/`，4 张 CSV）

| 指标 | 预期 |
|---|---|
| 账套名称 / 启用期间 | 逆演示贸易有限公司 / 2026-01 |
| 科目 / 期初 / 凭证 | 7 行（均已在标准科目表）/ 5 条 / 2 张 |
| 期初借=贷 | 181300 |
| 资产总计 / 负债 / 权益 | 186600 / 2600 / 184000 |
| 营业收入 / 营业成本 / 净利润 | 10000 / 6000 / 4000 |
| 试算期末借=贷 | 192600 |

### 4.2 主账套（已知期初 200000，与 4.1 独立）

| 业务 | 分录要点 | 预期 |
|---|---|---|
| 期初 | 借 1002 / 贷 3001 | 各 200000 |
| 销售 | 借 1122 11300；贷 5001 10000、2221 1300 | 收入 10000 |
| 费用 | 借 5602 2000；贷 1002 2000 | 费用 2000 |
| 资产购入 | 借 1601 60000；贷 1002 60000 | 账面原价 60000 |
| 资产卡片 | 原值 60000、残值率 5%、60 期 | 月折旧 950 |
| 折旧 | 借 5602 950；贷 1602 950 | 累计 950 |
| 结转损益 | 损益 → 3103 | 利润 7050 |
| 报表（结转前/后） | — | 资产 208350、负债 1300、权益 207050，未分配利润 7050 不翻倍 |
| 现金流（直接法） | 经营 −2000、投资 −60000 | 净额 −62000，期初 200000 / 期末 138000，勾稽成立 |

关键勾稽断言：资产卡原值=总账 1601=60000，资产卡累计=总账 1602=950；封账后反过账/新增凭证
被拒且账簿快照（试算/报表/凭证集合）不变；反结账后可继续录入；登记 2026-02 后报表/试算与 2026-01 一致。

## 5. 通过标准

- `npm test` / `node scripts/test-all.mjs`：已执行步骤通过、退出码 0；税务契约尚未合并时明确跳过、
  不计为通过，该结论为"已执行步骤通过"而非全套验收。
- `node workflow-test.mjs`：23/23 通过、退出码 0。
- 任何金额/平衡/状态/原子性断言失败即整体失败，**不得删改旧断言或伪造通过**。

## 6. 能力边界（本阶段明确不承诺）

| 类别 | 状态 |
|---|---|
| 记账、三大报表、试算、明细账 | ✅ 可用 |
| 折旧/摊销、结转损益、封账/反结账、期间登记 | ✅ 可用 |
| 旧账导入（JSON/4 CSV、UTF-8/GBK、预检+事务、本机 `paths`） | ✅ 可用，**非幂等**，每次新建账套 |
| Excel→CSV | ⚠️ 需单独运行 `05-reconstruction/tools/xlsx-to-csv.py`；`exec` 未实现 |
| 发票采集/查验/开票/红冲、银行流水、工资与个税计算、全税种申报、辅助核算、正式导出 | ⬜ 未实现，工具返回 `not_implemented` |
| 电子税务局 | 7 个接口已预留，真实地区接入数 0；见 TAX-INTEGRATION.md |
| 完整会计准则适配、正式申报、报表文件导出 | ⬜ 未承诺 |

- 发票/银行/工资入账只能基于**用户提供的已核实结构化数据**手工记账；源系统采集与自动计算尚不支持。
- 资产购入凭证与卡片分别创建；卡片本身不增加固定资产账面原价。
- 具体记账规则见 `05-reconstruction/codex/skills/bookkeeping/SKILL.md` 及 7 份 reference，
  导入规则见 `05-reconstruction/codex/skills/legacy-book-import/`。

## 7. 本次实测结果

管理者最终复核：2026-10-14，main `03eba00c4fefd065d30f021d19f17f02d48d5d65`，在 `06-workbench` 运行 `npm test`，6 套 208 项全部通过、exit 0。本轮文档交付只更新说明，不改变业务算法。

环境：Windows，Node v24.15.0（`node:sqlite` 内置）。数据目录在系统临时目录，后端端口为随机空闲端口。

| 命令 | 工作目录 | 结果 |
|---|---|---|
| `node workflow-test.mjs` | `05-reconstruction/codex/mcp/finance-mcp` | 23/23 通过，退出码 0 |
| `node scripts/test-all.mjs` | `06-workbench` | 管理者独立验证 guards 23/23、derived 31/31、smoke 28/28、contract 44/44、workflow 23/23、tax 59/59，共 208/208，exit 0 |

> 独立预期值由 `workflow-test.mjs` 内对示例 CSV 的原始列算术 + 手写业务常量给出；
> 结论只覆盖上述命令与场景，不覆盖第 6 节未实现能力。

已知导入限制的状态（当前）：IMPORT-STRICT 严格校验（拒绝非法金额文本与极小负值/超界原值，预检与正式写入同一套约束，失败不落库；预检只读无写入、仅正式写入事务回滚）已在 PR [#10](https://github.com/huxiaoyang-code/youshu-fork/pull/10) 于 2026-10-15 合并，merge SHA `67f5e4541fd05878e3d681638dcb95a9c33b799b`。
管理者复验：在 `D:/有数云fork/.worktrees/import-strict/06-workbench` 运行 `npm test` 7 套 262/262（guards 23 + derived 31 + import-strict 54 + smoke 28 + contract 44 + workflow 23 + tax 59）、`npm run test:smoke` 28/28，均 exit 0；验证后文件 SHA256 锁定（提交前后内容相同），最终验证提交 `aa9f08d33baace25fccf8f4e704de2dbc09d4731`。
管理者原沙箱内测试最初因本机 HTTP fetch 失败未通过、另一次审批因额度耗尽未执行（非安全拒绝），用户要求继续后审批获准的全套复验通过；不隐藏该过程，也不将其记为业务代码错误。
过程历史：管理者首审不通过（7 项阻塞）+ 二轮复审阻塞（CSV 辅助字段 `dates`/`numberRaw` 绕过），员工两轮返工逐条修复（金额舍入前校验、重复期初规则、形状/meta 类型校验、CSV 日期/编号逐行校验、完整内容快照、HTTP/Agent 集成、共享金额合计、测试临时 HTTP 服务 `PORT=0` 防端口碰撞）。
上表共 208 项的记录仍是基线提交 `03eba00` 的**历史验收事实**（6 套），不随新分支自动更新；IMPORT-STRICT 合并后仓库共 7 套 262 项（锚定合并提交 `67f5e45`），导入仍是**非幂等**——每次新建账套，不修改既有账套，重复导入识别属后续 IMPORT-IDEMPOTENCY。

当前工具清单共 45 个入口：31 个 available（包含 7 个税务接口）、1 个 limited、13 个 unavailable。全国真实税务连接为 0；会话和凭据生产要求见 [税务接口说明](TAX-INTEGRATION.md)。

两份主 Skill 已通过 `skill-creator/scripts/quick_validate.py` 格式检查；本轮未验收网页 UI、真实 Excel 文件转换或现有业务库。已有运行进程不会因合并自动重载，使用新增能力需要重启工作台及 MCP。
