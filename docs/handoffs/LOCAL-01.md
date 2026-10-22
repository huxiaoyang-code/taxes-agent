# 交接 · LOCAL-01 增量导入与批次幂等

- 任务单：[tasks/LOCAL-01](../tasks/LOCAL-01.md) · 契约：[LOCAL-IMPORT](../LOCAL-IMPORT.md)
- 负责人：`huxiaoyang-code`（已核实）；远端载体：[Issue #43](https://github.com/huxiaoyang-code/youshu-fork/issues/43)（`Refs #20` / `Refs #13`）
- 基线：`0c4e0dd622fc35bcb5d6e6af3620c6f971b2a805`
- 分支：`codex/huxiaoyang-code/local-01`（实际分支；此前文档误写为 `local-01-import-incremental`，已更正）
- 已审 head：`e12e71eb29dd5fc480aeebe5f0baace94bc3a4d7`
- PR：[#46](https://github.com/huxiaoyang-code/youshu-fork/pull/46)（**已实际 MERGED**）
- 合并提交：`1a15bcce3bf3b1f0d390746d85be7cfd1ace7ea3`（北京时间 **2026-10-22 17:13:24**）
- 状态：**已验收合并**（源码 PR #46 已合并进 main，`origin/main` 已快进到该 merge）。边界与限制照旧成立；其余七包未完成，不因本包合并标为完成。

## 0. 验收与合并结果（已发生）

- 链路：基线 `0c4e0dd622fc35bcb5d6e6af3620c6f971b2a805` → 已审 head `e12e71eb29dd5fc480aeebe5f0baace94bc3a4d7` → [PR #46](https://github.com/huxiaoyang-code/youshu-fork/pull/46) 实际 MERGED → merge `1a15bcce3bf3b1f0d390746d85be7cfd1ace7ea3`（北京时间 **2026-10-22 17:13:24**）。
- 管理者 `fetch` 后核对：merge `1a15bcc` 的**完整树与已审 head `e12e71e` 完全一致**，无额外改动混入。
- 独立审查：**未参与实现**、`fork_turns=none`、**未读员工日志**；结论**无剩余阻塞**。
- 实跑证据（精确 head `e12e71e`，管理者与独立审查者各自实跑）：领域 `import-incremental` **49 / 49**、HTTP + Agent `import-incremental-http` **22 / 22**、MCP `import-incremental-test` **7 / 7**，均 exit 0。
- 独立合成复现（不参与实现的一方自建场景）：期初经合法 API 改动后**同批回放给结构化冲突且零写入**；首调 / 查询 / 回放 `sourceTrace` 逐张 **全对象相等**；自动取号 + 显式取号 `[2, 1]` 顺序**不重号**，全部通过。
- 管理者文档校核：25 个文件 UTF-8、347 条相对链接、`git diff --check` 通过。
- 测试口径按阶段区分：**上一冻结候选**（两处定向修复之前）管理者实跑 `npm test` **47 / 47 套 exit 0**；**最终代码**只实跑上述受影响三套，**没有在最终小修后重跑全套 47 套**，不写「最终代码 47 / 47 又跑过」。
- 仓库**无 CI**（无 GitHub Actions）；本结论是本机管理者 + 独立审查者的实际运行证据，**不冒充 GitHub 第二账号批准**，也不把自动合并写成外部 review。

## 1. 最后定向返工（2026-10-22，Issue #43）

前序实现与独审修复保留不变；本轮只处理独立审查者在员工进程退出后补验发现的两点，最小改动：

1. **[P1] create 首次仅期初后，合法 API 改期初仍被同批回放伪报完成**：原实际期初核验只覆盖 `mode=append`，
   `create` 的已完成批次回放绕过了核验。
   - 修复：回放期初核验同时覆盖 `create` / `append`，按 **`batchRecord.account_set_id`** 读取当前真实期初，
     与批次请求逐科目比对；不一致给 `batch_replay_state_incomplete`（`reason=opening_balances_mismatch`，带期望 / 当前值），
     账套不可读给 `reason=account_set_missing`。
   - **首次正式 create 仍合法**：新建账套不受「既有期初」保护误挡；只有已完成批次回放才核验真实值。
   - **没有期初的批次不核验**（`normalized.opening_balances.length === 0`）：不凭空要求后期从未导入过的字段快照。
   - `append` 原有期初保护与回放核验保持不变。
   - 回归：`create` 仅期初 + 合法 `A.setOpeningBalances` 改期初 → 冲突；未改 / 恢复后 → replay；HTTP 合法 PUT 改期初 → 409、恢复并重启 → replay；
     `create` 含凭证时库内期初被改动 → 冲突；`create` 无期初批次后期合法写入期初 → 仍 replay。
2. **[P2] 同一批次首调 `sourceTrace` 缺 `action`，查询 / 回放却有**：实际执行与批次查询 / 回放的逐张 DTO 字段含义不一致。
   - 修复：正式执行 `sourceTrace` 补齐 `action: created|deduplicated`，与 `getImportBatch` / 同批回放使用同一组字段
     （`sourceVoucherId` / `voucherId` / `accountSetId` / `contentFingerprint` / `action` / `status` / `state`）。
   - 预检 `preview` 仍是计划语义（`would_create` / `create`），不与已落库 DTO 混同。
   - 回归：新建、纯去重、混合批次的**首调 applied 逐张 DTO 与批次查询全对象强比较相等**；回放与查询相等；
     反过账 / 修改 / 删除的当前 `state` 核验保留不变。

## 2. 先前独审修复（历史）

首轮修复保留不变，本轮只处理以下独立问题（优先最小变更，不做无关重构）：

1. **[P1] 填空账套期初被同批重试误挡**：先 `account_set_create` 新空账套，再 `append + confirmNewBinding=true`
   写期初 → 首次 `applied`；同批重试原本在回放判断**之前**被 `opening_balance_overwrite_refused` 误挡。
   - 修复：回放候选（批次身份 / 内容指纹 / 模式 / 账套 / 账套企业绑定 / 逐张来源登记均一致）在期初检查中
     不再套用「不得覆盖既有期初」，而是**核对库内实际期初逐科目一致**；不一致报
     `batch_replay_state_incomplete`（`reason=opening_balances_mismatch`，带期望 / 当前值）。
   - 不豁免真正覆盖：换批次改期初仍然 `opening_balance_overwrite_refused` / `opening_rewrite_after_posting`。
   - 回归：空账套有 / 无凭证两种首次填空、同批重试（领域 + HTTP + 重启 + MCP）。
2. **[P1] 自动取号与显式编号混用可落两张同号**：计划阶段按（期间, 字号）统一预分配号码
   （起点 = 既有最大号 + 1，跳过本批显式号与已分配号），正式写入使用该号码并在事务内再核一次占用；
   预检 `planned.voucherNumbers` 与结果 `sourceTrace` 行为一致，不存在「预检成功、正式无声失败」。
   - 回归：自动在前 / 显式在前（反序）/ 多个自动号 / 追加时既有号 + 本批显式号 / 不同字与期间 /
     事务失败回滚后重试；均用真实 db 断言号码集合与「无重复字号」查询为空，非仅看返回值。
3. **[P2] 跨批去重丢逐张批次追踪**：新增 schema **v3** 表 `import_batch_vouchers`
   （`batch_id, source_system, enterprise_key, source_voucher_id, account_set_id, voucher_id,
   content_fingerprint, action=created|deduplicated, created_at`，`UNIQUE(batch_id, source_voucher_id)`）。
   - 首调无论新建还是去重都写本批关联；`getImportBatch`、同批回放、首调 `sourceTrace` 都读同一份持久关联，
     作用域按批次来源 / 企业校对；去重项指向既有来源凭证 / 既有凭证，不伪造第二张；
     `voucherCount` 含去重项（纯去重批次不是 0）。历史批次由 v2→v3 迁移回填（按 `created`）。
   - 回归：跨批去重首调 + 查询 + 回放、纯去重、混合新增 + 去重、重启（HTTP 新进程）、
     失败原子性（整批回滚后失败批次无残留关联，重试才留痕）、MCP 去重批次查询。
4. **文档偏离修正**：八包总览按用户原任务单**完整映射**（LOCAL-03 双准则 / 辅助、LOCAL-04 银行对账、
   LOCAL-05 Excel/PDF 与口径，不重新编号、不遗漏）；登记 LOCAL-08（#44，独立模块修复中）与
   LOCAL-05a（#45，导出模块实施中，不声称整体完成）；本包实际分支更正为 `codex/huxiaoyang-code/local-01`；
   迁移回退口径改为「恢复会回到快照时点、备份时点后新增业务会丢失，需先保护现库 / 停写 / 恢复后核对」，
   并明确最小工具不冒充 LOCAL-06 全备份恢复完成。

## 3. 首轮返工（历史）

1. **一企一账套以规范企业身份为范围**（不再是「同一 source.system 内」）：
   - 新增 `import_enterprise_account_sets`：`enterprise_key` 主键 + `account_set_id` UNIQUE，
     由数据库保证「一家企业一个账套」与「一个账套只属一家企业」。
   - `import_source_bindings` 改为**来源证据**（`UNIQUE(source_system, enterprise_key)`）：同一企业可来自多个来源，
     但都指向同一规范账套；旧「一来源下一账套一企业」限制已被覆盖。
   - `create` 遇同企业已有账套 → `enterprise_already_bound`，`details.accountSetId` / `boundSources` / `guidance=mode=append`
     明确引导到已有账套，**不新建第二本**。
   - `append` 要求目标账套已属同一企业；同企业跨来源需 `confirmNewBinding=true` 且身份一致才登记来源证据；
     同账套绑另一企业一律拒绝。
   - `source.enterpriseKey` 只做 NFKC + trim，**不按显示名称 / 大小写猜测**；与账套名相同直接拒绝。
   - 未修改 `accounting.mjs`，旧无企业 ID 的 `importAccountSet` 兼容保留，并在契约中写明「身份未验证」边界。
2. **迁移与备份时序 / 失效**：
   - 备份在**新增结构之前**生成；`schema_migrations` / `schema_backups` 的建立、备份记录、新表 DDL、
     数据回填、版本记录全部放进**备份之后的同一迁移事务**；失败整体回滚，原库 schema / 业务数据 / 版本都不变。
   - 删除「size>0 即复用旧备份」逻辑：**每次真正升级都重新备份**，失败重试也重新备份；
     成功启动且版本已达目标才跳过备份。损坏 / 过期快照不会被复用。
   - schema v2：v1 数据回填规范企业映射与落库指纹；若旧数据自相矛盾（同企业多账套 / 同账套多企业），
     迁移失败并保留原库，交由人工核对，**不自动合并 / 删除 / 重命名**。
3. **来源凭证状态核验**（不按来源指纹伪报完成）：
   - `import_voucher_sources.voucher_id` 去掉 `vouchers` 外键（删除凭证后登记保留可追踪信息）；
     新增 `voucher_fingerprint`（落库后指纹）。
   - 去重 / 回放前核验当前凭证存在、账套一致、仍为 `posted`、内容与落库指纹一致；
     分别返回 `source_voucher_voucher_missing` / `_account_set_mismatch` / `_unposted` / `_modified` / `_trace_unverified`。
   - 删除凭证后重试**不会静默重新入账**；批次查询返回当前 `state`（`ok` / `missing` / `unposted` / `modified` / …）。
   - `markBatchFailed` 的 UPDATE 带 `status <> 'completed'`，且事务失败路径跳过已完成批次，
     **已完成批次不会被失败审计覆写**。
4. **契约与文档**：`LOCAL-IMPORT` 重写身份模型 / 冲突码 / 迁移备份 / 状态核验 / 限制；
   任务单、八包总览、任务看板、STATE / NEXT-SESSION、接管计划、INDEX / CHANGELOG 同步；
   产品入口（`AGENTS.md`、章程、团队协作、团队计划、报表闭环方案）只改「一企一账套」相关形态表述。
   MCP 两个工具的描述同步（一家企业一个账套、跨来源引导、当前状态核验）。

## 4. 实际测试与退出码（本机实跑，非自报预估）

### 4.1 上一冻结候选（管理者已独立验证，不是本段定向修复后的最终代码）

| 命令 | 工作目录 | 结果 |
|---|---|---|
| `npm test` | `06-workbench` | **47 / 47 套全部 exit 0**（含领域 / HTTP + Agent / MCP 与全部既有套件） |
| `node test/import-strict.test.mjs` | `06-workbench` | 54 / 54 通过，exit 0 |
| `node test/voucher-amount-guards.test.mjs` | `06-workbench` | 103 / 103 通过，exit 0 |

### 4.2 本次定向修复后实际运行（当前代码）

| 命令 | 工作目录 | 结果 |
|---|---|---|
| `node test/import-incremental.test.mjs` | `06-workbench` | **49 / 49** 通过，exit 0 |
| `node test/import-incremental-http.test.mjs` | `06-workbench` | **22 / 22** 通过，exit 0 |
| `node import-incremental-test.mjs` | `05-reconstruction/codex/mcp/finance-mcp` | **7 / 7** 通过，exit 0 |

本段只改期初回放核验与 `sourceTrace` DTO，按任务要求只跑受影响领域 / HTTP + Agent / MCP 三套与必要边界，
**未在最终代码上重跑无关税局套件或全套 47 套**；不声称最终代码又全套跑过。该受影响范围验证已由管理者与独立审查者在精确 head `e12e71e` 上各自实跑完成，结果见 §0。

覆盖点（本轮新增 / 加强）：

- `create` 同批回放期初：合法 `A.setOpeningBalances` 改期初 → `batch_replay_state_incomplete`；未改 / 恢复后 → `idempotent_replay`；
  HTTP 合法 PUT 改期初 → 409、恢复并重启 → 200 replay；含凭证 create 被改库内期初 → 冲突；无期初的 create 批次不凭空核验后期写入。
- `sourceTrace` 统一：新建、纯去重、混合批次的首调 applied 与批次查询逐张 DTO 全对象相等（含 `action` / `status` / `state`）；
  回放与查询相等；真实当前 `state` 核验（反过账 / 修改 / 删除）保留。

以下为先前覆盖点，保留不变：

- 填空账套首次期初：`account_set_create` 等价空账套 → `append + confirmNewBinding` 首调 `applied`；
  同批重试 `idempotent_replay` 且全库零写入；库内期初被改动 / 换批改期初仍拒绝；HTTP + 重启 + MCP 同口径。
- 自动取号：预检即公布最终号码；自动 / 显式混用在两种顺序、多个自动号、既有号、不同字期间下均无重号；
  事务失败回滚后重试号码复用；真实 db 断言号码集合 + 无重复字号。
- 跨批逐张追踪：去重 / 新建混合批次的查询、回放、首调统计一致；纯去重批次 `voucherCount` 不为 0；
  重启后可恢复；失败批次无残留关联。
- 首轮覆盖保留：一企一账套跨来源、来源凭证反过账 / 修改 / 删除、迁移备份时序与失效、事务回滚、
  旧入口兼容、预检只读、独立手算两月余额 / 利润（含「未过账不入报表」）。

手算基准（合成 Set A）：期初 1002=100000 / 1405=6000 / 3001=106000；
2026-01 净利润 8000，2026-02 当月净利润 -6000、本年累计 2000；
2026-02 资产总计 109300 = 负债 1300 + 权益 108000。

## 5. 备份与回退（本包实际留下的机制）

- 每次真正升级（含 v1→v2→v3）在迁移事务之前生成 `workbench.db.pre-v<版本>-<时间戳>.bak`（单文件自包含快照，
  含 WAL 已提交数据），并用独立只读连接做 `PRAGMA integrity_check`；验证失败拒绝迁移。
- 备份记录写入迁移事务内：只有成功迁移的备份会登记；失败尝试的备份文件保留为孤儿，重试重新备份。
- 回退：停后端 →（先另行复制现库留档）→ 用 `schema_backups` 记录里的备份覆盖 `workbench.db` →
  删除残留 `-wal` / `-shm` → 重启（会重新迁移并再备份一次）→ 恢复后逐项核对。
- **回退不是无损的**：恢复会把库带回**备份（快照）时点**，备份时点之后新增 / 修改的业务会丢失；
  恢复前必须先保护现库并停止写入。本包只是迁移前最小备份 + 回退手段，**不冒充 LOCAL-06 业务备份恢复已完成**。
- 本机若存在 v1 / v2 候选库：正常升级到 v3；若旧绑定自相矛盾，迁移失败并保留原库，需人工核对
  （不自动合并 / 删除 / 重命名）。

## 6. 未完成 / 不在本包范围

以下限制与边界**在本包合并后照旧成立**，不因合并而消失：

1. 完整审计与变更留痕、业务数据备份 / 恢复体系 —— **LOCAL-06**。
2. 批次取消 / 回滚单个批次、跨账套批量编排、进度推送 —— **LOCAL-07**。
3. 追加时仍需在 `payload.accounts` 重复声明账套自定义科目（未改共享严格校验函数）——已登记限制。
4. 删除本机凭证后不提供「解除来源关联后重新入账」的自动操作，需人工核对（LOCAL-06 承接）。
5. 历史遗留的重复账套不由本包合并 / 删除 / 重命名；旧无企业 ID 导入入口建出的账套在显式绑定前身份未验证。
6. 不做一企多账簿 / `bookKey`；税局真实接入仍为 **0**，本包不连税局、不读真实账套库、不改报表与税局代码。

## 7. 下游输入

- 下一包（LOCAL-02 精度 / 封账 / 资产一致性）可直接复用：批次事务模式、企业绑定 / 来源证据、
  来源追踪与落库指纹、`schema_migrations` / `schema_backups` 版本化与备份流程。
- 下游消费契约见 [LOCAL-IMPORT §12](../LOCAL-IMPORT.md)。

## 8. 会话与审查事实

- **员工阶段（历史快照）**：本轮及先前修复均由本机执行员工在独立 worktree 内实现并自测；员工本身**未执行 Git 提交 / 推送 / 合并**，未创建 PR，提交与合并由管理者执行。
- 管理者在**上一冻结候选**（两处定向修复之前）独立跑过全套 **47 / 47 套 exit 0**；随后补验发现期初回放核验与 `sourceTrace` 两点并退回员工最小修复。
- **最终代码**（精确 head `e12e71eb29dd5fc480aeebe5f0baace94bc3a4d7`）**未再重跑全套 47 套**；管理者与独立审查者在该 head 上各自实跑受影响领域 **49 / 49**、HTTP + Agent **22 / 22**、MCP **7 / 7**，均 exit 0。
- 独立审查者未参与实现、`fork_turns=none`、未读员工日志，独立合成复现（期初冲突零写入 / 逐张全对象相等 / 取号 `[2, 1]` 不重号）后结论**无剩余阻塞**。
- 合并已完成：[PR #46](https://github.com/huxiaoyang-code/youshu-fork/pull/46) 于北京时间 **2026-10-22 17:13:24** 合并，merge `1a15bcce3bf3b1f0d390746d85be7cfd1ace7ea3`；管理者 `fetch` 核实 merge 树与已审 head 完全一致。
- 仓库**无 CI**；自动合并授权下由管理者执行合并，证据为本机实际运行 + 独立内容审查，**不伪造 GitHub review**，不声称第二账号批准。
- 测试全部使用合成临时目录与随机回环端口，结束后清理；未连接既有后端、真实账套库或税局，真实税局接入数仍为 **0**。
