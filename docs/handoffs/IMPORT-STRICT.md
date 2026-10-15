# IMPORT-STRICT 交接

- 状态：**管理者首审不通过（7 项阻塞）、二轮复审阻塞（CSV 辅助字段绕过），员工两轮返工自测完成，待管理者复审**。未提交、未 PR、未合并；本文件不代表管理者复审通过或 PR 合并。
- 目标：旧账导入严格校验——拒绝非法金额文本；预检与正式写入使用同一套约束，失败不落库；覆盖金额、日期/期间、凭证/期初会计约束；保持有效历史输入兼容。
- 明确不做（非目标）：幂等批次 / 重复导入识别（留给 IMPORT-IDEMPOTENCY）、批量队列、UI 重构、税局适配、多租户。
- 开发基线：`origin/main` `8279477ad3e49ef1e37cd965db3bb12d719674c9`（`docs: 固化本地执行工作范式与单机批量交接 (#9)`，PR #9 已合并）；分支 `codex/import-strict`，worktree `D:/有数云fork/.worktrees/import-strict`。
- 执行者 / 显式模型：pi / tokenhub `deepseek-v4.1-flash`（本机核实映射 DeepSeek V4.1 Flash），无其他回退 / 规划模型、无子 agent。
- 允许修改范围（实际改动）：`06-workbench/server/accounting.mjs`、`06-workbench/server/server.mjs`（仅 `listen` 回调改报实际端口）、`06-workbench/test/import-strict.test.mjs`、`06-workbench/test/smoke.test.mjs`（仅纳入子进程实际端口与退出清理）、`06-workbench/scripts/test-all.mjs`、`06-workbench/README.md`、`05-reconstruction/codex/skills/legacy-book-import/{SKILL.md,references/import-rules.md}`、`docs/PHASE1-ACCEPTANCE.md`（仅导入限制段落 + 覆盖矩阵）、`docs/handoffs/{IMPORT-STRICT.md,STATE.md,NEXT-SESSION.md}`。未改无关模块、旧断言、Skill 全局配置。

## 管理者首审阻塞项与返工修复（本轮）

1. **舍入吞负值 / 超界原值**：`parseImportAmount` 现在只允许 `number`/`string`/`null`/`undefined`；在 `r2` **之前**核对原始数值的有限性、绝对值范围与符号，返回 `negative`；调用方按 `negative` 判负。`-0.001`（JSON number/string、CSV）与“非零另一侧”的极小负值都被拒绝；`999999999999.994`/`999999999999.995` 等超界原值不再因舍入进界内被接受。
2. **重复期初与数据库覆盖语义不一致**：期初同一科目重复出现现在**预检即报错**并带行/科上下文，不再汇总；预检与 `setOpeningBalances` 覆盖语义一致，不再出现“预检 ok、正式 `opening_unbalanced`”。
3. **形状被静默吞掉 / String 强转**：`payload`、`account_set`、`accounts`/`opening_balances`/`vouchers`、集合元素、凭证 `entries` 都做形状校验；缺失集合可默认空，显式错误类型必须报错。金额数组 `[100]`/`[]`、对象、布尔被拒绝，只允许定义的类型。
4. **meta 字段 SQLite 绑定失败**：`name`/`taxpayer_type`/`accounting_standard`/`start_period` 及所有文本字段先核对类型，不允许对象/数组被 `String()` 成 `[object Object]` 或 `100` 后写入；错误时预检失败。
5. **CSV 日期/编号漏校验**：`parseImportTexts` 为每张凭证保留 `dates`（逐行原始日期）与 `numberRaw`；`parseInt` 不再吞掉 `1oops`，显式编号必须安全正整数，合法缺省编号保持默认 `1`；同凭证日期不一致报错，不再只留首行。
6. **失败不落库证据不足**：测试的 `assertNoWrite` 改为**完整内容快照**（`account_sets`/`accounts`/`opening_balances`/`periods`/`vouchers`/`voucher_entries` 全部行内容），预置既有合成账套后失败导入仍比对全量内容；新增 HTTP `/api/import/parse`、`/api/import/account-set` 与 Agent `legacy_book_import` 的少量集成回归（解析返回 payload 再提交仍拒绝、不建账）。
7. **浮点/合计一致性**：新增共享 `sumMoney`，`normalizeImportPayload`、`setOpeningBalances`、`checkVoucher` 统一末尾 `r2` 合计，避免预检与写入因累加方式不同产生不平衡；补 1000 条 0.1 累加回归。

## 第二轮复审阻塞项与返工修复

1. **CSV 辅助字段 `dates` 绕过 `date`**：`normalizeImportPayload` 现在始终先校验 `date` 本体（不再以 `Array.isArray(v.dates)` 决定是否看 `date`）；`dates` 若存在必须为数组并逐项校验，且与 `date` 已填值合并后只允许一个不同日期，否则报「日期不一致」。JSON 调用方传 `{date:'garbage',dates:[],...}` 也会因 `date` 非法而预检失败。
2. **CSV 辅助字段 `numberRaw` 掩盖 `number` 或自身类型非法**：`number` 与 `numberRaw` 各自严格校验（`numberRaw` 必须为文本、合法缺省空串保留默认 1；`number` 必须为安全正整数 number 或合法数字串）；两者同时存在且可解析时必须相等，否则报「不一致」。不再对 `numberRaw` 做 `String([1])` 强转。合法 CSV `parse -> JSON.stringify -> parse` 往返（保留 `dates` 数组与 `numberRaw` 文本）可正式导入。
3. **测试临时 HTTP 服务端口碰撞**：`server.mjs` 的 `listen` 回调改报 `server.address().port`（最少生产日志变更），`import-strict`/`smoke` 两套集成测试改用 `PORT=0`，从子进程 stdout 读取实际端口，并监听启动超时/提前退出，拆临时目录前等子进程退出，避免误连现有真实后端。

## 实现摘要

- 共享 `parseImportAmount`：有限 number 或可带 `¥`/`￥`、正负号、千分位、小数的十进制文本；空白/缺失按 0；拒绝垃圾/部分可解析/`NaN`/`Infinity`/超界/非 number-string 类型；归一化 2 位小数。
- `parseImportTexts` 保留原始金额文本、凭证逐行 `dates` 与 `numberRaw`，由共享校验统一核对后再归一化。
- `normalizeImportPayload`：只读、无业务写入，先核对形状/类型/原始数值，再归一化成可写入值；`validateImportPayload` 为兼容包装；`importAccountSet` 预检与正式写入共用同一归一化结果，写入仍在单个 `BEGIN ... COMMIT` 内，异常 `ROLLBACK`。
- 会计约束：账套 meta、科目（新增科目方向/类别；标准科目跳过）、期初（存在/非负/单行双向/重复/平衡；**单行两列都为 0 允许**）、凭证（期间/日期逐行与一致性/编号/分录/非负/单行双向/**单行两列都为 0 拒绝**/平衡）。
- 错误统一带 `科目第 N 行` / `期初余额第 N 行` / `凭证第 N 张（期间 字号-号）第 M 行` + 字段上下文。兼容既有英文错误关键词，旧 smoke/contract/workflow 断言不变。

## 关键取舍

- 金额小数超过 2 位按四舍五入写入（与既有 `r2` 一致），未把“多于 2 位小数”判为非法；但超界与负号在舍入前判定。
- 日期与期间不在同一月份仍只给 `warnings`；格式/真实日历日/同凭证不一致为错误。
- CSV 缺省凭证号保持原契约默认 `1`；JSON 缺省编号仍自动取号（原契约）。
- 预检失败且 `dryRun:false` 时沿用既有 `{ dryRun:true, validation, created:null }` 返回形态，`validation.ok=false` 且无任何写入。

## 自测命令与结果（员工在临时数据目录运行，退出码 0）

- `node test/import-strict.test.mjs` → **54/54 通过**，exit 0（新增/返工套件，含 HTTP/Agent 集成与辅助字段回归）。
- `node test/accounting-guards.test.mjs` → 23/23；`node test/accounting-derived.test.mjs` → 31/31。
- `npm run test:smoke` → 28/28，exit 0。
- `npm test`（= `node scripts/test-all.mjs`）→ guards 23 + derived 31 + import-strict 54 + smoke 28 + contract 44 + workflow 23 + tax 59 = **262/262，7/7 套件，exit 0**。
- `git diff --check` → 通过（exit 0）。
- 自测只用 `WORKBENCH_DATA_DIR` 临时目录与临时数据，未触碰工程 `data/`、真实账套、真实税务凭据或真实系统联网；未使用其他 worktree 成果；未触碰 `.worktrees/tax-browser`。

## 未完成项 / 风险 / 下一部分输入

- **待管理者复审**：以上测试数为员工两轮返工自测，管理者尚未复跑；PR 尚未创建 / 合并。首审 7 项阻塞与二轮 `dates`/`numberRaw` 绕过均逐条修复并补回归，等待复审确认。
- 预检（`normalizeImportPayload`）只读、不产生任何业务写入，因此不存在「预检写入回滚」；只有正式写入（`importAccountSet` 显式 `dryRun:false`）在单个 `BEGIN ... COMMIT` 内执行，异常时 `ROLLBACK`，保证失败不部分落库。
- 旧账导入每次新建账套，不修改既有账套；封账 / 既有已过账凭证等既有动态约束仍由现有事务与数据库约束负责，本部分未改变这些行为。
- 非幂等仍是已知限制；重复导入识别属 IMPORT-IDEMPOTENCY，本轮未做。
- 下一部分 `IMPORT-IDEMPOTENCY` 需要批次标识 / 去重键，输入为本交接 + 章程 + STATE。

## 仍运行进程 / 会话 / 日志

- 本机无为本任务保留的后台服务进程；测试子进程（含 HTTP 集成临时后端）均随测试结束。
- 日志与任务包在 Git 忽略目录 `.agent-runs/`（本机），不作为下一会话默认上下文。

## 上下文

- 本返工会话结束后，复审通过并由管理者合并后，下一部分须用新进程、新会话（`--no-session` / `--no-session-persistence`），只读取章程、STATE、本交接与必要源码。
- 授权继承自项目章程与用户后续指示；真实账套数据与税务凭据不发到模型服务。

## 管理者复审记录（待填写，暂不预报通过）

> 本节由管理者复审后填写：复跑的完整 SHA、命令、通过项 / 失败项、发现与结论。在填写前，本部分不得视为复审通过或已合并。
