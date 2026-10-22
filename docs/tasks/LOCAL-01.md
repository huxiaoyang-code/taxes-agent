# 任务单 · LOCAL-01 增量导入与批次幂等

- 类型：后端领域 + 存储迁移 + 契约文档 + 测试
- 状态：**已验收合并**（源码 PR #46 已实际 MERGED；已审 head `e12e71eb29dd5fc480aeebe5f0baace94bc3a4d7`，merge `1a15bcce3bf3b1f0d390746d85be7cfd1ace7ea3`，北京时间 2026-10-22 17:13:24，管理者 fetch 核实 merge 树 = 已审 head）
- 基线：`0c4e0dd622fc35bcb5d6e6af3620c6f971b2a805`
- 分支：`codex/huxiaoyang-code/local-01`（实际分支；此前任务单误写为 `local-01-import-incremental`，已更正）
- 负责人：`huxiaoyang-code`（已核实）
- 远端载体：[Issue #43](https://github.com/huxiaoyang-code/youshu-fork/issues/43)（`Refs #20` / `Refs #13`）
- 契约文档：[LOCAL-IMPORT](../LOCAL-IMPORT.md) · 交接：[handoffs/LOCAL-01](../handoffs/LOCAL-01.md)
- 总览：[INDEPENDENT-PRODUCT-WORK](INDEPENDENT-PRODUCT-WORK.md)（八包，本包进行中）

## 1. 目标

在**不改变旧导入行为**的前提下，补齐本机连续多月记账的最小缺口：

1. 清晰区分「旧首次创建」「有企业 / 批次的首次创建」「指定已有账套追加」三种用法；
2. 企业身份以**规范 canonical `enterpriseKey`** 为范围：**一家企业一个账套**，同企业来自不同 `source.system`
   必须引导到已有账套、不得新建第二本；同一账套不得绑定另一家企业；
3. 显式批次 ID、来源凭证 ID、规范内容指纹与落库后指纹，重启后批次仍可识别；
4. 同批重试不增加账套 / 凭证，不同批相同来源凭证去重；内容修订、本批自身重复、来源凭证被本机
   反过账 / 修改 / 删除均给**结构化冲突**，绝不静默覆盖或伪报完成；
5. 预检与正式共用规则、预检不写入；单事务覆盖新增企业绑定 / 来源证据 / 批次 / 凭证 / 期间 / 科目，
   中途失败原库业务状态不变，已完成批次不被失败审计覆写；
6. 迁移前先做一致备份，新增结构在备份之后、迁移事务内建立；失败重试重新备份（不复用过期 / 损坏快照）；
   备份可实际恢复 WAL 中已提交数据；迁移记录与回退方式文档化。

## 2. 非目标

- 不改 `importAccountSet` 的签名 / 返回结构 / 默认值，不改旧 HTTP / Agent / MCP 入口语义；
- 不做完整审计体系、备份恢复体系（LOCAL-06）、批量编排与 CLI（LOCAL-07）、报表口径（R1）、双准则（A3）；
- 不接税局、不读真实账套库 / 凭据、不动 `report-export.mjs` / `tax-report-format.mjs` / `public/*` / `package.json` / 税局代码；
- **不做一企多账簿 / `bookKey` 设计**（管理者意见已撤回、从未实施）；
- 不擅自合并已有库 / 删除重复旧账套 / 自动重命名；
- 不整合 PR #19 / PR #35 分支；不做 Git 提交 / 推送 / 合并。

## 3. 精确文件清单（本包唯一改动范围）

新增：

| 文件 | 作用 |
|---|---|
| `06-workbench/server/import-incremental.mjs` | 增量导入领域逻辑（规范身份 / 批次 / 指纹 / 去重 / 状态核验 / 冲突 / 单事务落库 / 批次与来源查询） |
| `06-workbench/server/import-storage.mjs` | 新增表、v1→v2 版本化迁移、迁移前一致备份、企业绑定 / 来源证据 / 批次 / 来源追踪查询 |
| `06-workbench/test/import-incremental.test.mjs` | 领域层回归（含一企一账套、跨来源、凭证状态、迁移 / 备份 / 事务故障 / 手算两月） |
| `06-workbench/test/import-incremental-http.test.mjs` | HTTP + Agent 真实入口（临时库 + 随机回环端口 + 重启） |
| `05-reconstruction/codex/mcp/finance-mcp/import-incremental-test.mjs` | stdio MCP → HTTP → Agent 真实链路 |
| `docs/LOCAL-IMPORT.md` | 增量导入契约（DTO / 冲突码 / 幂等 / 备份回退 / 下游契约） |
| `docs/tasks/LOCAL-01.md` | 本任务单 |
| `docs/handoffs/LOCAL-01.md` | 本包版本化交接 |
| `docs/tasks/INDEPENDENT-PRODUCT-WORK.md` | 八包总览与状态 |

修改：

| 文件 | 改动 |
|---|---|
| `06-workbench/server/db.mjs` | 启动时调用 `ensureImportSchema`（导入表 / 迁移 / 备份），导出 `importSchema` |
| `06-workbench/server/server.mjs` | 只加导入接线：`POST /api/import/incremental`、`GET /api/import/batches/:id` |
| `06-workbench/server/agent-tools.mjs` | 只加导入接线：`book_import_incremental`、`book_import_batch` + 结果→错误映射 |
| `06-workbench/scripts/test-all.mjs` | 仅追加三套测试入口 |
| `05-reconstruction/codex/mcp/finance-mcp/tools.mjs` | 只加两个 MCP 工具契约（`origin: local`） |
| `docs/tasks/README.md` | 登记本包（Issue / 负责人 / 分支 / 状态）与八包入口 |
| `docs/handoffs/STATE.md`、`docs/handoffs/NEXT-SESSION.md` | 只加本包入口与本地独立路线说明 |
| `docs/DEVELOPMENT-TAKEOVER-PLAN.md` | 登记新授权的本地独立路线（税局暂停与真实接入 0 不变） |
| `docs/INDEX.md`、`docs/CHANGELOG.md` | 只加索引与变更条目 |

**2026-10-22 追加允许（仅产品形态相关表述）**：`AGENTS.md`、`docs/PROJECT-CHARTER.md`、
`docs/TEAM-COLLABORATION.md`、`docs/TEAM-PLAN.md`、`docs/REPORT-CLOSURE-PLAN.md`——
把「一家企业只需要一个账套，多企业批量 = 多个账套」写入口径，不改历史事实。

未改：`accounting.mjs`（严格校验与旧导入入口保持原样）、`coa.mjs`、`report-export.mjs`、`tax-report-format.mjs`、
`public/*`、`package.json`、税局相关模块、LOCAL-08 文件。

## 4. 验收口径

1. 三种用法区分清楚，旧入口无新增参数时行为与返回结构不变（域层 `dryRun` 缺省仍为 `false`，
   HTTP / Agent / MCP 入口缺省仍为 `dryRun=true`）。
2. 身份：规范 `source.enterpriseKey` 决定企业；**一家企业一个账套**（`import_enterprise_account_sets`
   的 `enterprise_key` 主键 + `account_set_id` UNIQUE 数据库级保证）；同企业跨来源 `create` 必须
   `enterprise_already_bound` 并给出已有 `accountSetId`，跨来源追加需 `confirmNewBinding` 且身份一致；
   同一账套绑定另一企业一律拒绝；账套名称不能充当企业身份。
3. 幂等：同批重试（含重启后）不新增账套 / 凭证；不同批相同来源凭证去重；同批 ID 内容变化拒绝。
4. 冲突：内容修订、本批自身重复、业务凭证字号冲突、身份不匹配、科目不兼容、已封账期间、期初覆盖
   全部返回结构化冲突（`code` + `message` + 明细），且不写入。
   - **期初回放边界（独审修复）**：同批身份 / 内容 / 实际落库状态一致时允许**只读回放**；
     `create` 与 `append` 都按批次记录的 `account_set_id` 核对库内实际期初，不一致给结构化冲突；
     首次正式 create 仍合法、没有期初的批次不凭空要求快照；真正的期初覆盖或内容变化不豁免。
   - **自动取号唯一性（独审修复）**：自动取号与显式编号混用时，在计划阶段按（期间, 字号）
     统一预分配号码（跳过既有号与本批显式号），预检所见 = 正式写入，同期间同字号不出现两张同号凭证。
5. 来源凭证状态：本机反过账 / 修改 / 删除后，批次回放与跨批去重都返回结构化冲突
   （`source_voucher_voucher_unposted` / `_modified` / `_missing`），删除后来源登记保留可追踪信息，
   不静默重新入账；已完成批次不被 `markBatchFailed` 覆写。
   - **逐张批次追踪（独审修复）**：跨批去重命中的来源凭证也按批次持久留痕
     （`import_batch_vouchers`），实际执行 / 批次查询 / 同批回放的逐张 DTO 字段与值一致
     （含 `action` / `status` / `state`），且始终指向既有来源凭证，不伪造第二张。
6. 校验：金额 / 日期 / 科目 / 借贷平衡复用 `normalizeImportPayload`，未降低任何规则；预检不写入（含审计表）。
7. 事务：单事务覆盖企业绑定 / 来源证据 / 批次 / 凭证 / 期间 / 科目；故障注入后业务状态完全不变、失败批次留审计、错误不被吞。
8. 迁移：**先备份、后建新结构**（备份保持迁移前结构）；迁移失败原库 schema / 业务数据不变；
   失败后新增合成业务再重试，新备份包含新业务且不复用损坏 / 过期备份；成功启动不重复备份；
   合成旧库带未 checkpoint 的 WAL 时备份一致可恢复；v1 候选库可逐级升级并回填落库指纹与批次关联。
   - 回退口径：恢复会把库/业务数据带回**备份（快照）时点**；备份时点之后新增的业务会丢失，
     必须先保护现库、停写、恢复后核对。最小回退工具**不冒充** LOCAL-06 全备份恢复体系完成。
9. 测试：只使用合成临时库与随机回环端口；HTTP / Agent / MCP 真实入口验证，核心导入不 mock。

## 5. 实际测试（本机实跑）

### 5.1 上一冻结候选（管理者独立验证）

| 命令 | 结果 |
|---|---|
| `npm test`（`06-workbench`，`scripts/test-all.mjs`） | **47 / 47 套全部 exit 0**（上一冻结候选，不是本段定向修复后的最终代码） |
| `node test/import-strict.test.mjs` | 54 / 54 通过，exit 0（上一冻结候选） |
| `node test/voucher-amount-guards.test.mjs` | 103 / 103 通过，exit 0（上一冻结候选） |

### 5.2 本次定向修复后实际运行（当前代码）

| 命令 | 结果 |
|---|---|
| `node test/import-incremental.test.mjs`（`06-workbench`） | **49 / 49** 通过，exit 0 |
| `node test/import-incremental-http.test.mjs`（`06-workbench`） | **22 / 22** 通过，exit 0 |
| `node import-incremental-test.mjs`（`05-reconstruction/codex/mcp/finance-mcp`） | **7 / 7** 通过，exit 0 |

本段只改期初回放核验与 `sourceTrace` DTO，按任务要求不重复跑无关税局套件；
**未声称最终代码又全套 47 / 47 重跑**；该受影响范围验证已由管理者与独立审查者在精确 head `e12e71e` 上各自实跑完成（见 §8）。

## 6. 先前独审修复（同一任务，2026-10-22，历史）

独立 Codex reviewer 用临时合成库复现的 3 个问题已修复并补回归（详见[交接](LOCAL-01.md)）：

1. 空账套首次 `append` 填期初后同批重试被期初保护误挡 → 回放前核对批次身份 / 内容 / 实际落库状态，
   一致才允许只读回放；库内期初被改动或换批改期初仍拒绝。
2. 自动取号与显式编号混用可落两张同号 → 计划阶段统一预分配号码，预检即公布最终号码；
   覆盖反序 / 多个自动号 / 已存在号 / 不同字与期间 / 事务失败重试，并有真实 db 重号断言。
3. 跨批去重丢逐张批次追踪 → 新增 `import_batch_vouchers`（schema **v3**）持久保存每批逐张关联
   （新建 / 去重各自留痕），查询 / 回放 / 首调统计一致并指向既有来源凭证；覆盖纯去重、混合、重启与失败原子性。
4. 文档偏离：八包总览按用户原任务单完整映射（LOCAL-03 双准则 / 辅助、LOCAL-04 银行对账、
   LOCAL-05 Excel/PDF 与口径），登记 LOCAL-05a（#45）与 LOCAL-08（#44），更正本包实际分支名。

## 7. 最后定向返工（Issue #43，2026-10-22）

独立审查者在员工进程退出后补验发现两点，已最小修复并自测：

1. **create 同批回放的期初核验缺失**：此前实际期初核验只覆盖 `append`。现在 `create` / `append` 回放都按
   `batchRecord.account_set_id` 核对当前真实期初；合法 API 改期初后 create 同批回放给
   `batch_replay_state_incomplete`（`reason=opening_balances_mismatch`），不再 `idempotent_replay`。
   首次正式 create 仍合法；没有期初的批次不核验；账套不可读给 `reason=account_set_missing`；append 原保护保留。
2. **`sourceTrace` 逐张 DTO 字段不统一**：正式执行补齐 `action`，与批次查询 / 回放使用同一组字段。
   新建、纯去重、混合批次的首调 applied 与查询全对象强比较相等；预检保留 `would_create` 计划语义；
   当前真实 `state` 核验（反过账 / 修改 / 删除）不变。

回归：领域 49 / 49、HTTP + Agent 22 / 22、MCP 7 / 7，均 exit 0（管理者与独立审查者在精确 head `e12e71e` 上分别实跑）；上一冻结候选全套 47 / 47 未在最终代码上重跑。

## 8. 验收与合并结果（已发生）

- 链路：基线 `0c4e0dd622fc35bcb5d6e6af3620c6f971b2a805` → 已审 head `e12e71eb29dd5fc480aeebe5f0baace94bc3a4d7` → [PR #46](https://github.com/huxiaoyang-code/youshu-fork/pull/46) 实际 MERGED → merge `1a15bcce3bf3b1f0d390746d85be7cfd1ace7ea3`（北京时间 **2026-10-22 17:13:24**）。管理者 `fetch` 核实 merge 完整树与已审 head 完全一致。
- 独立审查（未参与实现、`fork_turns=none`、未读员工日志）结论：**无剩余阻塞**。
- 实跑（精确 head `e12e71e`，管理者与独立审查者各自实跑）：领域 **49 / 49**、HTTP + Agent **22 / 22**、MCP **7 / 7**，均 exit 0。
- 独立合成复现：合法 API 改期初后同批回放给结构化冲突且**零写入**；首调 / 查询 / 回放 `sourceTrace` 逐张**全对象相等**；自动 + 显式取号 `[2, 1]` 顺序**不重号**。
- 文档校核：25 个文件 UTF-8、347 条相对链接、`git diff --check` 通过。
- 测试口径：**上一冻结候选** `npm test` 47 / 47 套 exit 0；**最终代码未再重跑全套 47 套**，不得写成「最终小修后 47 / 47 又跑过」。仓库**无 CI**，不冒充 GitHub 第二账号批准。

## 9. 已登记限制

见 [LOCAL-IMPORT §13](../LOCAL-IMPORT.md)：追加需重复声明账套自定义科目、自动取号凭证需显式来源 ID、
旧无企业 ID 导入入口不提供身份认定、不自动处理历史重复账套、删除凭证后来源关联保留且需人工核对、
跨来源同号业务凭证字号冲突、批次审计随账套级联删除、无批次回滚 / 批量编排 / 进度推送、不做一企多账簿。
