# RC-A · 税局登录与数据接入（负责人 `huxiaoyang-code`）

- 状态：**已分配 / 待开工**
- 负责人（人类成员 / GitHub）：项目负责人 `huxiaoyang-code`
- 执行员工：pi（只允许 GLM 5.3 或 DeepSeek V4.1 Flash，主 / 回退显式锁定）
- 本机管理者：项目负责人自己的本机 Codex
- 覆盖工作包：**RC-0 / RC-1 / RC-2a / RC-2b** 及数据处理集成；协调 **RC-3**、**RC-6**
- 分支：`codex/huxiaoyang-code/rc-a-login-data`（各子任务可再细分）
- 基线：分叉时最新 `origin/main` 完整 SHA（开工时核实，最新已知 `c2d561994377d9123a1cd5b8b67dfa8a16a5d2b0` = PR #15 合并）
- 关联总任务 Issue：**[Issue #13](https://github.com/huxiaoyang-code/youshu-fork/issues/13)**（RC-A-LOGIN-DATA，assignee `huxiaoyang-code`，OPEN）；子 PR 用 `Refs #13`，**不因 A0 完成就 Closes #13**

## 1. 需求

- 目标：把「办税员账号 → 验证码 → 登录 → 授权企业 → 本地账套」打通到可出表，并按 [报表闭环补全方案](../REPORT-CLOSURE-PLAN.md) 推进 RC-0 ~ RC-2b。
- 子任务拆分：
  - **RC-A0（= RC-0 第一步）**：在新隔离工作区复审 `tax-browser` 草稿（只复制**源码 14 文件 / 补丁与基线元数据**，**不复制** DB / 凭据 / 临时 profile / 日志），先对旧草稿**准确复现其自带套件**并记录实际数字与退出码，再在**最新 main** 上选择性整合必要改动并复跑（**以实际为准**，员工自报 272 **不作为结论**，**不得覆盖**新版 `scripts/test-all.mjs`）。**注意 PR #15 已改动 `server.mjs` / `public/*` / `scripts/test-all.mjs` / `test/*`，整合时须逐项检查冲突。** 不得假定企业列表等于财务凭证。
  - **RC-A1（= RC-1）**：登录会话 / 办税员身份 → 授权企业 → 本地账套关联；含**实际账号 / 凭据入口、适配器与最少 UI**。
  - **RC-A2（= RC-2a / RC-2b）**：目标账套定向导入、数据落地与重试（幂等）、最小恢复能力。
- 用户明确约束：真实登录与验证码只由用户在本机可信界面处理；模型侧 MCP / Agent 仅收**安全引用**与**不含真实业务 / 身份原文的状态摘要**；真实数据人工验收只在用户本机完成，只回传不含原文的结果摘要。
- 非目标：不做多租户 / SaaS / 对外服务；不实现 BATCH-QUEUE 泛用批量平台；不代写 B 的报表导出模块。

## 2. 输入 / 输出建议

- 输入：`tax-browser` 草稿 14 文件（只读原件）；用户办税员账号与真实登录配合（仅 RC-0 第二步 / RC-1 验收）；官方入口 `https://etax.fujian.chinatax.gov.cn/`（仅方向，需实测）。
- 输出：`docs/REVIEW-TAX-BROWSER.md`、`docs/DATA-AVAILABILITY.md`、`docs/handoffs/RC0-SNAPSHOT.md`；RC-1/RC-2 的模块与测试（`tax-account-link.mjs` 等，见方案）。
- 建议文件范围（派工前建议，以实际任务单为准）：`06-workbench/server/tax-account-link.mjs`（新）、`tax-gateway.mjs`（仅适配器接线与凭据引用）、`db.mjs`（身份 / 绑定 / 凭据引用表）、`server.mjs`、`agent-tools.mjs`、`public/*`（最小录入界面）、`test/*.test.mjs`、MCP 契约测试。
- 依赖上游：无（首包）。
- 下游消费者：**同事 B 的 RC-4 / RC-5** 需要 RC-2/RC-3 的可出表账套与稳定 DTO；RC-6 由负责人统一串接。

## 3. 验收标准

- **RC-A0（第一步）**：快照哈希逐条核对记录；旧草稿套件复跑 + 最新 main 整合后复跑均记录**实际数字与退出码**；冲突检查（`accounting.mjs` / `server.mjs` / `db.mjs` / `package.json` / `scripts/test-all.mjs` / `public/*` / `README.md`）；安全边界审计（地区白名单仅福建漳州、税号严格校验、CDP 仅回环、临时 profile 定向清理、HTTP 回环 Host + 同源 Origin + 一次性令牌、无 CORS 头、无 fake 开关）。
- **RC-A0（第二步，需真实账号）**：真实登录验证账号 / 验证码 / 授权企业 / 实际财务数据来源，填写数据可得性矩阵；结论必须二选一：**数据链路成立**，或**不成立 / 部分成立**并写明只能做到什么。**无真实配合时先完成第一步并记录第二步为待验证，不假成功。**
- **RC-A1**：合成数据下可走通「登录 → 企业 → 账套」，异常路径（过期、验证码错误 / 超时、二次人机验证、授权撤销、企业切换与串账）均有明确错误码；所有自动测试断言**凭据与验证码不出现在任何 API / MCP 响应与日志**；结束时留下**目标账套绑定**供 RC-2 使用。
- **RC-A2a / RC-A2b**：重复导入不重复建账 / 过账（首次去重查询**先于**空账套拒绝，命中后返回已有结果）；单账套失败整批回滚；多企业批次只重试失败项且不重复已成功企业；数据不足显式标记并阻止标记可出表；崩溃后可恢复；**跨两个月连续出表**、失败恢复**不串账**、同键更正走显式冲销 / 更正；封账期间与同一绑定范围内重复建账被拒绝。
- 验证命令（仓库相对）：`Push-Location 06-workbench; npm test; npm run test:smoke; Pop-Location`（以实际套件与数字为准；原历史 262 / smoke 28 是旧基线事实，最新已知基线 `c2d5619` 为 10 套 336 项，不代表新基线）。
- 不通过：退回本机员工返工，记录阻塞项。

## 4. 文件所有权

- 本任务负责的**共享受控文件**：`06-workbench/server/db.mjs`（RC-1 / RC-2）、`server.mjs`（接线）、`agent-tools.mjs` 注册、MCP 注册同步、`public/*` 最小界面。
- `accounting.mjs` / `coa.mjs`：**RC-3 由负责人统一协调**；根据 B 的报表口径发现**另开聚焦任务**，**不得** B 和 A 各改一份 `accounting.mjs`。
- `scripts/test-all.mjs` / `package.json`：负责人负责，**不得覆盖** IMPORT-STRICT 已并入的套件。
- 新增模块归属：`tax*` 税务采集 / 登录 / 会话（`tax-gateway.mjs`、`tax-browser*.mjs`、`tax-import.mjs`）与 `import*` 数据 / 适配 / 定向导入 → **本任务（A）**；`report-export` 与 **`tax-report-format.mjs`**（`tax*` 规则的模块名专属例外）→ **同事 B**。本条与协作协议 §6 / 看板 / B 任务单保持一致。
- 共享接线改动可走**独立集成 PR** 或申请**短期文件所有权**；**不推给管理者亲写业务代码**。

## 5. 依赖 / 基线 / 阻塞路径

- 依赖：无前置（首包）。RC-A1 依赖 RC-0 结论；RC-A2 依赖 RC-A1 的目标账套绑定。
- 阻塞路径：**无真实账号 / 真实配合**时，先做 RC-0 第一步与 RC-1 适配器骨架 + 合成数据测试（可先行），记录第二步待验证。官方目标地区 / 准则未核实前记为**未知**。
- 基线更新时重验受影响范围；共享关键变更**串行合并**。

## 6. 真实数据边界

- 自动测试**只用合成数据**；不访问真实税局做自动测试；不覆盖生产库；不绕过沙箱。
- 真实登录、验证码、凭据只在用户**本机可信界面**处理，不回传原文，不进日志 / Git / PR / 模型。
- 模型侧只收安全引用与不含原文的状态摘要。

## 7. 自动合并与协调

- 负责人可对**自己派工并经本机 Codex 独立审查**的 PR 使用用户已授权的自动合并；不需要用户逐 PR 确认。
- 跨成员评审按任务风险 / 共享文件需求安排；RC-6 集成由负责人统一协调。
- **GitHub 不能原子锁 base**：与其他 PR 串行合并并重验。

## 8. 交接

- 交接对象：同事 B（RC-4 / RC-5 需要可出表账套与 DTO 契约）、最终 RC-6。
- 交接文档：[handoffs/TEMPLATE.md](../handoffs/TEMPLATE.md) 格式，含基线、已审核 head、验证命令与结果摘要、依赖契约、未完项。
- 原始日志留本机 `.agent-runs/`（Git 忽略），公开只写无敏感摘要。

---

协作规则见 [团队协作协议](../TEAM-COLLABORATION.md)；看板见 [任务看板](README.md)；完整工作包见 [报表闭环补全方案](../REPORT-CLOSURE-PLAN.md)。
