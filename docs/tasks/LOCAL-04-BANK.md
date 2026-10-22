# 任务单 · LOCAL-04-BANK 本地银行 CSV、持久对账与余额调节

- 类型：后端领域 + 组件持久层 + 本机 CLI + 契约文档 + 测试
- 状态：**实施与自测完成，待管理者审查 / 提交 / PR / 合并**（本文件不预写 PR 编号、已审 head 或 merge）
- 基线：`257f96275031eefa484699dd71bd012e2d221e51`（含已审 PR #52 导出模块、PR #50 输出策略模块；schema 仍为 LOCAL-01 v3）
- 分支：`codex/huxiaoyang-code/local-04-bank`；工作区：`.worktrees/local-04-bank`
- 负责人：`huxiaoyang-code`（已核实）
- 远端载体：[Issue #53](https://github.com/huxiaoyang-code/youshu-fork/issues/53)（`Refs #20` / `Refs #13`）
- 契约：[LOCAL-BANK](../LOCAL-BANK.md) · 交接：[handoffs/LOCAL-04-BANK](../handoffs/LOCAL-04-BANK.md)
- 总览：[INDEPENDENT-PRODUCT-WORK](INDEPENDENT-PRODUCT-WORK.md)（八包中的 LOCAL-04）

## 1. 目标

交付本机可直接运行的银行流水与余额调节闭环：

1. CSV 预检 / 字段映射（含引号、BOM、多行字段、严格日期、整数分、方向显式映射）；
2. 批次导入落库：批次身份绑定账套 / 银行账户 / 来源 / 批次 ID / 文件摘要 / 映射与规范化版本；
   同批重试幂等、同文件重导不增流水、同稳定 ID 同内容复用、改内容结构化冲突；
3. 无银行稳定 ID 时只把同特征行保存为**待人工判定的疑似重复证据**（不误吞、不静默合并），
   由操作者逐行判定「同一笔 / 不同一笔」并给理由；
4. 从真实库的 **posted** 凭证银行科目分录生成候选（`voucher_id + entry_id + line_no`），
   人工确认 / 取消匹配；同一流水 / 同一分录只能有一个有效匹配；
5. 所有 status / 查询 / 候选 / 确认 / 对账都**读时重新核验**账务：反过账、删除、改分录 / 日期 / 期间 /
   科目 / 金额后立即失效并降级，不自动恢复；
6. 余额调节：账面 = 真实期初 + 截止日全部历史 posted 银行分录；银行截止余额由操作者声明并与
   覆盖期流水净额自校验；输出四类未达项、两边调节后余额与差额，差额不得自动补项凑平；
7. 独立 `bank_*` 组件 schema 与组件版本；已有库迁移前必须走 LOCAL-06 一致备份门槛，
   备份不可用时安全拒绝（`migration_backup_unavailable`）；新库由创建事实驱动的初始化流程建立；
8. 真实可调用 Node CLI（显式 `--db`），清晰 JSON / text 输出、稳定错误码与非零退出码。

## 2. 非目标

- 不接银行网站 / 银行 API / 银行凭据，不做自动下载对账单；
- 不做 SaaS / 多租户 / 租户权限 / 对外服务 / 账户体系（产品仍是本机单用户）；
- 不生成、修改、删除任何账务凭证 / 期初 / 期间；不自动结账、不把「银行已对平」当账务可结账；
- 不实现一对多 / 多对一自动组匹配（只返回明确的「需要人工 / 未实现」提示）；
- 不扩展外币 / 换汇 / 汇率；不实现辅助核算维度（等 LOCAL-03 稳定契约）；
- 不修改 `accounting.mjs` / `db.mjs` / `import-storage.mjs` / `coa.mjs` / `server.mjs` /
  `agent-tools.mjs` / MCP / `scripts/test-all.mjs` / `package.json` / 锁文件 / `public/*` /
  共享 STATE / 索引 / 其他 docs / local-backup / report-office / LOCAL08 模块；
- 不做 HTTP / Agent / MCP / UI 接线（共享串行窗口另开任务）；
- 不执行 Git 提交 / 推送 / 合并；不读取真实账套、银行文件或凭据。

## 3. 精确文件清单（本包唯一改动范围，共 10 个新增文件）

| 文件 | 作用 |
|---|---|
| `06-workbench/server/bank-import.mjs` | CSV 解析、字段映射、日期 / 金额 / 方向规范化、预检、指纹与限制（纯函数，无数据库副作用） |
| `06-workbench/server/bank-storage.mjs` | `bank_*` schema v1、组件版本、迁移前备份门槛、创建事实回执、CRUD / 审计 / 对账运行记录 |
| `06-workbench/server/bank-reconciliation.mjs` | 账户登记、导入落库、候选、确认 / 取消、读时失效核验、余额调节、状态汇总 |
| `06-workbench/scripts/bank-reconcile.mjs` | 本机 CLI（显式 `--db`、JSON / text、错误码与退出码、`init-db`） |
| `06-workbench/test/bank-import.test.mjs` | CSV / 映射 / 金额 / 日期 / 预检纯函数回归（15 项） |
| `06-workbench/test/bank-reconciliation.test.mjs` | 真实临时库领域回归：幂等 / 去重 / 歧义 / 候选 / 匹配 / 失效 / 余额调节（20 项） |
| `06-workbench/test/bank-reconcile-cli.test.mjs` | CLI 子进程端到端回归（9 项） |
| `docs/LOCAL-BANK.md` | 契约：表 / 函数 / CLI / 公式 / 错误码 / 限制 / 备份门槛 |
| `docs/tasks/LOCAL-04-BANK.md` | 本任务单 |
| `docs/handoffs/LOCAL-04-BANK.md` | 版本化交接（实际结果、未完成项、复验命令） |

**修改文件：无。** 需要更多文件（共享路由、共享测试总入口、UI、备份合同接线）时必须先由管理者登记。

## 4. 依赖与合同状态

| 依赖 | 状态 | 本包如何处理 |
|---|---|---|
| LOCAL-01 批次语义 / v3 schema | 已合并 | 银行组件独立 `bank_*` 命名空间，只读当前 `vouchers` / `voucher_entries` / `opening_balances` / `accounts` / `periods`，不写全局版本 |
| LOCAL-06 一致备份 | 候选待独审，**未合并** | 备份实现作为窄依赖注入；未提供时安全拒绝（`migration_backup_unavailable`）；只用失败分支 + 顺序测试，不把 fake backup 当迁移验收；新库生命周期用进程内创建事实 |
| LOCAL-02 金额 / 期末完整性 | 未合并 | 按当前真实 schema 读账；账务金额按整数分读取，非精确到分给结构化错误；合同合并后需补兼容回归 |
| LOCAL-03 双准则 / 辅助维度 | 未合并 | 首版一个银行账户绑定一个 1002 叶子科目，同科目多账户拒绝；辅助维度扩展留待合同确认 |
| 共享接线（HTTP / Agent / MCP / UI / test-all） | 未做 | 本包直接交付可调用 Node CLI 与领域 API，不等待接线即可跑业务；接线单列后续任务 |

## 5. 验收标准（对照本包实际结果）

| 验收项 | 结果 |
|---|---|
| CSV 引号 / BOM / 换行 / 重复表头 / 畸形引号 / 缺列 / 超限 | 通过（`bank-import.test.mjs`） |
| 严格日期、真实日历、期间一致、不做时区换算 | 通过 |
| 整数分、空 / 零 / 负号 / 千分位 / 超精度 / 指数 / 超界 / 双边非零 | 通过 |
| 同批跨进程重试幂等、同文件新批次不增流水并逐行追踪 | 通过（CLI 子进程） |
| 同稳定 ID 同内容复用、改内容冲突、不同 ID 同日同额保留两笔 | 通过 |
| 无稳定 ID：文件内两条都保留；交叠窗口只存待判定证据；same / distinct / 幂等 / 改判拒绝 | 通过 |
| 真实会计 API 建两企业账套 / 银行科目 / 期初 / posted / 草稿；候选只读 posted | 通过 |
| 错账套 / 账户 / 币种 / 期间 / 日期 / 金额 / 方向拒绝；多候选人工选择；组匹配明确未实现 | 通过 |
| confirm / cancel / reconfirm 跨进程持久；双重占用只成功一次；取消保留证据且幂等 | 通过 |
| 反过账后查询立即失效；重过账不自动恢复；删除 / 改金额 / 日期 / 科目 / 行号分别识别 | 通过 |
| 余额调节固定手算 140000 / 140000 / 差额 0；1 分差异暴露；跨月未达；期初贷方余额；非零差额 | 通过 |
| 覆盖不完整 / 缺来源 / 未决歧义 / 失效匹配时不得声明已对平 | 通过 |
| 事务中途数据库错误后无半笔流水；修复后同批次可重试 | 通过（触发器注入失败） |
| CLI 显式 `--db`；无参 / help / 拼错路径不创建默认库 | 通过 |
| 已有库无备份实现时安全拒绝且不建 `bank_*` 表 | 通过（exit 5） |
| 不生成 / 修改凭证与期间；审计不被业务删除级联抹掉 | 通过 |
| 既有全套回归 | `npm test` 47 / 47 套件通过，exit 0 |

## 6. 实际测试命令与结果（本次运行）

工作目录 `06-workbench`：

```
node --test test/bank-import.test.mjs          # 15 / 15 通过
node --test test/bank-reconciliation.test.mjs  # 20 / 20 通过
node --test test/bank-reconcile-cli.test.mjs   #  9 /  9 通过
node --test test/bank-import.test.mjs test/bank-reconciliation.test.mjs test/bank-reconcile-cli.test.mjs
                                               # 44 / 44 通过，exit 0
npm test                                       # 47 / 47 套件通过，exit 0
```

## 7. 未完成项（不声称整个 LOCAL-04 已交付完成）

1. 已有库迁移 / 组件升级的真实验收：等 LOCAL-06 已审备份实现合并后，补迁移前备份、WAL 已提交内容、
   迁移失败回滚、恢复新目标、银行组件 / 审计 / 来源 / 金额完整性证据；当前只用失败分支与顺序测试。
2. HTTP / Agent / MCP / UI 与 `scripts/test-all.mjs` 接线（共享串行窗口）。
3. LOCAL-02 / LOCAL-03 稳定合同合并后的真实兼容回归与版本记录；辅助核算维度下的多银行账户支持再评估。
4. 一对多 / 多对一人工组匹配（当前只有明确提示码，不自动占用分录）。
5. 外币 / 换汇、银行网站 / API 接入：明确不在本包范围。

## 8. 交付后管理者需要做

1. 阅读实际 diff（4 实现 + 3 测试 + 3 文档，无共享文件改动）；
2. 复现关键金额与失败路径（§6 命令；固定手算 140000 / 140000 / 差额 0；1 分差异 pending_review；
   已有库无备份 exit 5）；
3. 由未参与实施、不继承实施上下文的独立 Codex subagent 独审；返工仍由本员工实现；
4. 按已验证 head 提交 / 建 PR / 合并，并补真实交接与远端 Issue 关联；本文件不预写这些结果。
