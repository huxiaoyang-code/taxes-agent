# 本机独立产品工作 · 八包总览

状态（2026-10-22 实际）：**LOCAL-01 已验收合并**（源码 [PR #46](https://github.com/huxiaoyang-code/youshu-fork/pull/46) + 交接 PR #48，已审 head `e12e71e`、merge `1a15bcce`）；
**LOCAL-02 已验收合并**：[PR #60](https://github.com/huxiaoyang-code/youshu-fork/pull/60) 于 2026-10-22T13:34:48Z 实际 MERGED，merge `dfefae0553052474b8a9308105443714bc5d9cfb`，最终文档 head `18aa6fb8b5d36181092397504bf1b8b338d71fb9`（tree `1d2a4b8b84e763ebac5bf52801d4989b7f5b8e33` 与 merge tree 一致），Issue #47 已 CLOSED；证据在各自候选上取得（核心 `review_core02_final` 在 `bd05415fe6de080b41f0dd9f6f56fb1f57d8dae0`、输出协议 `review_output08_final` 在 `3a8ae7ab0a3ca61ed15ddc6aa112eba6c4837795`、备份 `review_backup06_final` 在精确 98a，各自独立接受；root 在精确 98a 实跑 55 / 55 套、Office 21 / 21、11 PDF、备份 22 / 22）；
**LOCAL-06 备份 PR #55 已合（当时只认 v3）、审计 A PR #58 已合，v3 / v4 扩展已随 PR #60 合并；LOCAL-05a 纯模块 PR #52 已合，Office 分支已同步 PR60 实际 main（PR60 不含 Office 接线），接线仍只在 Draft [PR #62](https://github.com/huxiaoyang-code/youshu-fork/pull/62)（OPEN 未合并）；LOCAL-08 策略 PR #50 与 adapter / transport PR #57 已合、输出协议回修已随 PR #60 合并，共享入口仍未接线（Issue #44 OPEN）；LOCAL-03 / 04 / 07 已审候选未合；Windows 交付（Issue #59）实施中不预报**。
用户 2026-10-22 新指示允许恢复本机产品方向的工作，覆盖旧「暂停本地扩建」；**税局现场仍然暂停**，真实接入数仍为 **0**，本文件不把任何税局能力写成已打通；也不预报任何审查结论 / head / merge SHA。

- 负责人（全部包）：`huxiaoyang-code`（已核实）；总载体 [Issue #20](https://github.com/huxiaoyang-code/youshu-fork/issues/20)，
  业务追踪 `Refs #13` / `Refs #14` / `Refs #17`。
- 本文件按用户原任务单的八包范围**完整映射**，不重新编号、不合并、不省略任何包（含银行对账、Excel / PDF、本机交付）；
  修正前期版本把 LOCAL-03 / LOCAL-04 / LOCAL-05 写成「连续月份编排 / 双准则 / 现金流口径」的偏离。
- 本表是**依赖顺序与范围草案**，不是并发文件锁，也不代表任何包已验收。每包开工前必须在 Issue 登记唯一负责人、
  精确文件清单、接口契约与验收标准。
- 与 [全量开发接管计划](../DEVELOPMENT-TAKEOVER-PLAN.md) 的关系：该计划中的 A2 / I1 / A3 / R1 / D1 / B1 / S1
  等差距由本路线逐包收敛；**未完成的包不得因为本表存在就被视为已交付**，
  PRD 中税局相关（T1 / F1 / P1 / P2 / V1）仍受「税局暂停、真实接入 0」约束，等用户重新授权现场。
- 状态口径：以真实 Git / PR / Issue 为准。**未合并的包一律不写「已完成」**；本表不预报审查结论、head 或 merge。

## 八包（范围与用户原任务单一致）

| 包 | 目标（对应原任务单） | 主要依赖 | 状态 |
|---|---|---|---|
| **LOCAL-01 定向增量导入与连续月份** | 首次建账与向指定已有账套追加两种入口；来源标识 / 批次 / 幂等判定 / 重复与修订冲突报告；预检与正式共用规则；开放期间追加、失败原子回滚、导入来源记录（**增量导入**） | 无（首个可开工包） | **已验收合并**：[PR #46](https://github.com/huxiaoyang-code/youshu-fork/pull/46) 已实际 MERGED，已审 head `e12e71e`、merge `1a15bcce`（北京时间 2026-10-22 17:13:24），独立审查无剩余阻塞；定向导入已实现规范企业身份唯一性，但**旧手工建账 / 旧导入全入口仍有缺口**（[Issue #61](https://github.com/huxiaoyang-code/youshu-fork/issues/61)），待 01B / 03B2 契约补齐，**不能宣称全入口已完成**（[任务单](LOCAL-01.md) · [契约](../LOCAL-IMPORT.md) · [交接](../handoffs/LOCAL-01.md)） |
| LOCAL-02 会计金额、期末完整性与连续期间 | 金额精度 / 舍入一致策略、资产卡片与总账核对、必需期末步骤与封账前置、反操作对后续期间的影响（**金额 / 期末**） | LOCAL-01 | **已验收合并**：[PR #60](https://github.com/huxiaoyang-code/youshu-fork/pull/60) 于 2026-10-22T13:34:48Z 实际 MERGED，merge `dfefae0`，最终文档 head `18aa6fb`（tree `1d2a4b8` 与 merge tree 一致），Issue #47 已 CLOSED（[Issue #47](https://github.com/huxiaoyang-code/youshu-fork/issues/47)，基线 `1a15bcce`（源码），分支 `codex/huxiaoyang-code/local-02`）：证据在各自候选上取得（核心 `bd05415`、输出 `3a8ae7a`、备份精确 98a，各自独立接受）；root 在源码 head `98a29d1c` 实跑完整 `npm test` **55 / 55 套 exit 0**、Office **21 / 21**、**11 PDF** 几何、备份 **22 / 22**（合成临时库 + 随机回环端口），最终文档 head `18aa6fb` 未重跑这些套件（[任务单](LOCAL-02.md) · [契约](../ACCOUNTING-PERIOD-INTEGRITY.md) · [交接](../handoffs/LOCAL-02.md)） |
| LOCAL-03 双准则与辅助核算 | 先两套准则的科目 / 报表映射与兼容迁移，再项目 / 部门 / 往来辅助维度贯通期初、发生额、余额与查询（**双准则 / 辅助**） | LOCAL-01、LOCAL-02 | 历史纯规则候选 `47866a32` 独审通过、root 41（旧结果，不预报新结论）；**B1 已开窗实施**（起点 `f7e69bd4`，基于 PR #60 实际 main `dfef`；Issue #56 claim 6342201837），**未验收 / 未合并**；辅助维度**未实施** |
| LOCAL-04 银行流水与对账 | 本地流水文件导入与字段映射、流水去重、与银行账匹配、人工确认 / 取消匹配、差异与未达项、对账状态与期间关联（**银行对账**；不接银行网站、不新增凭据服务） | LOCAL-01 批次语义、LOCAL-03 必要科目 / 往来契约 | 纯模块与安装 / backup 候选，A 修复 `c8f490c6` 正在独审；**未合**；bank backup 完整索引键同步与 03 契约未完成，**不报整体验收** |
| LOCAL-05 内部 Excel/PDF 与报表准确性 | 两条线：**05a** 独立 Excel/PDF 导出模块及接线（复用稳定报表 DTO）；**05b** 会计核心中的双准则映射、复杂现金流与独立金额核验（**Excel/PDF 与口径**） | 05a 可并行；05b 随 LOCAL-02 / LOCAL-03 串行 | **05a 纯模块 [PR #52](https://github.com/huxiaoyang-code/youshu-fork/pull/52) 已合；本包分支基于 `d5816078`，已无冲突同步 PR #60 实际 main（`dfefae0`）得到候选 `a9fb1bcf`（**PR #60 不含本包 Office 接线**），Draft [PR #62](https://github.com/huxiaoyang-code/youshu-fork/pull/62) OPEN 未合并，最终独立审查待 root / `review_local05`；管理者在精确 `a9fb` 实跑 `npm test` 56 / 56 exit 0（Office 21 / 21、11 PDF 几何）**；**05b 待开工**（复杂 CF + 双准则准确性属后续） |
| LOCAL-06 审计、备份恢复与本机交付 | 账务关键动作审计；SQLite 一致性备份 / 恢复；版本化迁移与回退；干净 Windows 安装 / 启动 / 升级说明及验证（**审计 / 备份 / 本机交付**） | 随每次持久化设计同步；LOCAL-01 首次迁移前先满足最小恢复条件 | **备份子包已验收合并**（[PR #55](https://github.com/huxiaoyang-code/youshu-fork/pull/55)，merge `98977e0`，已审源码 head `b2dcba3`，**当时只认 v3**）；**审计 A 已合**（Issue #54，[PR #58](https://github.com/huxiaoyang-code/youshu-fork/pull/58)，final `c923c62`、merge `e86d248`，2026-10-22T12:59:58Z，**仅原语 / 只读 CLI**，28 audit + 22 ledger 管理验证、原独审 9 组接受；实际业务接线 / 现库安装 / 恢复链未完成）；**v3 / v4 备份扩展（两份精确契约 + 唯一性键语义）已随 PR #60 合并（merge `dfefae0`），独立 `review_backup06_final` 在精确 98a 接受（自跑 22 / 22 exit 0）**；**LOCAL-06 整体仍未完成**，也不支持 v0–v2、未来 v5+ 与 bank / batch / audit 组件（[契约](../LOCAL-BACKUP.md) · [任务](LOCAL-06-BACKUP.md) · [交接](../handoffs/LOCAL-06-BACKUP.md)） |
| LOCAL-07 持久批量任务与 CLI | 多账套批量导入 / 计提 / 结转 / 结账 / 出表的持久任务状态与阶段检查点、逐账套结果、重试 / 取消边界、重启恢复、同账套互斥、去重及 CLI（**持久批量 CLI**） | LOCAL-01 / LOCAL-02 / LOCAL-06 与已稳定导出 | 模块 / CLI 历史 `11f1877f` 独审通过（**限已实现范围**），root 9 + 25（旧结果）；**B1 已开窗实施**（起点 `f7ae456f`，基于 PR #60 实际 main `dfef`；Issue #51 claim 6342202439），**未验收 / 未合并**；真实 20 家 7 阶段、共享互斥、备份恢复集成未完，**不能宣传 `<1s` 锁上限** |
| LOCAL-08 普通财务工具的数据输出边界 | 区分操作者本机查看与模型工具输出；普通财务工具的最小化摘要、受控引用、必要本机计算路径与明确错误，保持本机合法查看 / 导出能力（**普通财务模型边界**） | 独立投影 / 策略模块可并行；`agent-tools.mjs` / MCP 注册 / 后端接口串行接线 | 策略 [PR #50](https://github.com/huxiaoyang-code/youshu-fork/pull/50)、adapter / transport [PR #57](https://github.com/huxiaoyang-code/youshu-fork/pull/57) **已合**（PR57 merge `db6020a`）；**输出协议 2 项 P2 回修（`3a8ae7a`，独立 `review_output08_final` 接受）与 02 真实 DTO 兼容已随 PR #60 合并（merge `dfefae0`）**；**共享 HTTP / Agent / MCP 调用入口仍未接线，Issue #44 保持 OPEN** |

## 核心修改主线（按原任务单并行约束）

1. **LOCAL-01 / LOCAL-02 均已验收合并**（02 随 PR #60，merge `dfefae0`）；LOCAL-05 的独立导出模块（05a，已合，接线 Draft PR #62 待最终审查）、
   LOCAL-06 的备份工具（PR #55 已合，v3 / v4 扩展已随 PR #60 合并）或 LOCAL-08 的投影策略（PR #50 / #57 已合）可并行推进。
2. **LOCAL-01 → LOCAL-02 → LOCAL-03 是核心修改主线**；LOCAL-04 依赖明确契约后接入；
   LOCAL-07 完成真实本地操作集成后验收；LOCAL-06 需随每次持久化设计同步，首次迁移前先满足最小恢复条件。
3. 共享文件（`accounting.mjs` / `coa.mjs` / `db.mjs` / `server.mjs` / `agent-tools.mjs` / MCP 注册 /
   `scripts/test-all.mjs` / `package.json` / `public/*` / STATE / 任务索引）同一时刻一个任务编辑，先在远端登记精确文件清单。
   **当前 root 持 main 锁**：本 Office 最终验收合并后，`server.mjs` 共享入口计划交 Issue #44；`scripts/test-all.mjs` 计划先交 Issue #53 登记银行 4 套，53 完成后再由 #44 追加（#44 当前只代码 + 3 套件单跑）。只记录计划，**不表示已释放**。
4. 每个可独立验收的子包单独 PR；不得只交规划、工具空壳或模拟实现；不得用 mock executor 验收替代最终实际本地动作链。

## 边界与纪律

1. 产品仍是**本机单用户**；**一家企业只需要一个账套**，多企业批量处理 = 多个账套。批量 ≠ 多租户，
   不做 SaaS / 租户权限 / 对外服务；**不做一企多账簿 / `bookKey`**。
2. 每包独立 worktree + `codex/` 分支 + 唯一文件责任人；共享接线单列小 PR 并串行合并。
3. 验收证据只能是代码 + 可重复测试（合成临时库、随机回环端口），不得用真实账套 / 凭据做自动测试；
   最终代码由未参与实现、不继承实施上下文的独立 Codex subagent 审查。
4. **税局现场暂停**：本路线不启动浏览器、不访问税局后端、不把预留接口写成已接入；
   真实接入数保持 0，直到用户重新授权现场并另行验收。
5. 每包交付都要更新「任务单 + 版本化交接 + INDEX / CHANGELOG 的本包条目」，并由管理者补齐 PR / head / merge；
   任何包都不得以本表存在为理由声称已审查通过或已合并。
