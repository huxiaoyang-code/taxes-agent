# 任务单 · LOCAL-03a 双准则科目、报表映射与旧账套兼容迁移

- 类型：会计 profile / 报表规则（阶段 A 纯模块）→ 持久迁移 + 真实接线（阶段 B）
- 状态：**阶段 A 纯规则已实现并自测，尚未接线；阶段 B 未完成**（未提交、未建 PR、未合并）
- 基线：`98977e04bd24aa293074021802191814f8c2a1d2`（root 核实的最新 main，PR #55 合并后）
- 分支：`codex/huxiaoyang-code/local-03a`（独立 worktree，工作区名 `local-03a`）
- 负责人：`huxiaoyang-code`（已核实）
- 远端载体：[Issue #56](https://github.com/huxiaoyang-code/youshu-fork/issues/56)（`Refs #20` / `Refs #13` / `Refs #14`）
- 契约文档：[ACCOUNTING-STANDARDS](../ACCOUNTING-STANDARDS.md) · 交接：[handoffs/LOCAL-03a](../handoffs/LOCAL-03a.md)
- 总览：[INDEPENDENT-PRODUCT-WORK](INDEPENDENT-PRODUCT-WORK.md)（LOCAL-03 / 03a / 03b 拆分）

## 1. 产品边界（不可漂移）

- 本机**单用户**财税工作台：一名操作者、多家企业、**一家企业一个账套**；多企业批量 = 多个账套。
- 不做 SaaS / 多租户 / 租户权限平台 / 对外服务 / 账户体系；不做一企多账簿 / `bookKey`。
- 03b（项目 / 部门 / 往来辅助维度）始终另包，不混入本包。
- 税局上传模板、申报、真实税局取数不在本包；真实接入数仍为 0。
- 本包交付的是**内部简化报表的已核实基础业务子集**，不宣称 2026 全业务准则实现或法定完整财报。

## 2. 阶段划分

| 阶段 | 范围 | 状态 |
|---|---|---|
| A | 六个新增文件的纯 profile / 报表规则预实现与定向自测 | **已完成实现与自测（未提交、未合并）** |
| B | 持久 profile 迁移、真实业务接线、HTTP / Agent / MCP / 导出、完整手算链、回归与审查合并 | **未开始** |

阶段 A 允许在 LOCAL-02 #47 未合并前，从 root 核实的最新 main 独立 worktree **提前实现纯模块**；
**不允许**提前修改核心共享文件，也不构成阶段 B 的授权。阶段 A 不单独 PR 合并、不把 LOCAL03a 标为完成。

## 3. 阶段 A 精确文件清单（唯一可写范围，六个新增文件）

| 文件 | 作用 |
|---|---|
| `06-workbench/server/accounting-profiles.mjs` | 三个 profile 的科目表 / 角色 / 来源 / 支持范围；新建 profile 选择与结构化拒绝 |
| `06-workbench/server/accounting-report-rules.mjs` | 报表行项目规则、科目解析、纯计算、现金流对方科目分类 |
| `06-workbench/test/accounting-standard-profiles.test.mjs` | 31 项定向回归（纯合成、内联 fixture，无 DB / 服务） |
| `docs/tasks/LOCAL-03a.md` | 本任务单（阶段边界、验收、阶段 B 门槛） |
| `docs/handoffs/LOCAL-03a.md` | 可恢复交接（基线 / 分支 / 命令 / 接口 / 待办） |
| `docs/ACCOUNTING-STANDARDS.md` | profile 接口、来源、支持 / 不支持范围、错误码 |

**未改动**任何既有文件（含 `coa.mjs`、`accounting.mjs`、`db.mjs`、`import-storage.mjs`、
`import-incremental.mjs`、`money.mjs`、`period-end-controls.mjs`、`server/agent/MCP`、
`report-export`、`public/*`、`package.json` / 锁文件、`scripts/test-all.mjs`、旧测试、
`docs/handoffs/STATE.md` 与公共索引）。测试 fixture 内联在新增测试内，未新增 adapter / 脚本。

## 4. 阶段 A 交付契约（摘要，详见 ACCOUNTING-STANDARDS）

- 固定 profile ID：`legacy-small-coa-v1`、`small-2011-basic-v1`、`enterprise-2019-general-basic-v1`；
  阶段 B 沿用，不另造兼容别名。
- `accounting-profiles.mjs`：`listAccountingProfiles` / `getAccountingProfile` /
  `resolveNewAccountingProfile` / `getAccountingRoles`；共 17 项角色键；
  省略准则默认小企；未知 / 错配 / legacy 新建 / 非法准则全部结构化拒绝（`error.code`）。
- `accounting-report-rules.mjs`：`getAccountingReportRules` / `resolveAccountingAccountRule` /
  `evaluateAccountingStatement` / `classifyAccountingCashCounterpart`。
- 金额契约：`netMinor` 安全整数分、借减贷、各科目自身金额；BS 输入期末余额，IS 输入
  排除结转的时间窗发生净额；累计溢出 / 重复 code / 缺科目 / 非法金额明确拒绝。
- 小企 `3001/3002/3101/3103/3104` 对企业 `4001/4002/4101/4103/4104`；小企生产成本 `4001`
  对企业 `5001`；小企收入 / 成本 / 管理费 `5001/5401/5602` 对企业 `6001/6401/6602`；
  企业 `5001` 不列收入、企业 `4001` 不进存货；`5301` 在两 profile 含义不同。
- legacy COA 为基线 `coa.mjs` 的逐项静态快照（顺序 / 字段 / `contra` 有无），独立冻结；
  legacy `evaluate` 返回 `complete=false` + `legacy_engine_required`，不给假装完整的金额。
- scope 三态 `mapped / requires_detail / unsupported`：每个预置科目都有可说明状态与原因；
  非零未映射 / 待明细 / 未支持 / 语义冲突 → `complete=false` 且给出明确 code / 原因，
  totals 不伪报已核准完整；未使用的零余额复杂科目不阻断基础样例。

## 5. 阶段 A 验收（实际执行）

工作目录 `06-workbench`，唯一命令：

```bash
node test/accounting-standard-profiles.test.mjs
```

结果：**31 / 31 通过，exit 0**（2026-10-22，合成内联数据，无数据库、无服务、无网络）。
覆盖：

1. legacy COA 与现状 `coa.mjs` 完整逐项等值（含字段存在性 / `contra` / 顺序），profile / 嵌套对象深冻结、
   不可被污染、可序列化；未知 ID / 非法准则 / 错配 / legacy 新建全部拒绝，省略准则选新小企。
2. 两新 COA 实际不同与同码冲突；损益不按名称猜；合法数字明细、非法编码 / 后缀、方向 / 类别 / 备抵冲突、
   未映射自定义科目；每个预置科目 scope 可说明。
3. 两个新 profile 的 2025-11 / 2025-12 / 2026-01 期末余额与各时间窗损益内联快照（预期为手算数字字面量）；
   结转前（未清零损益）与结转后（本年利润 / 利润分配）输入分别计算，净资产相同；企业 5001 在产品
   三期不进收入 / 费用。
4. 反例：非零未映射 / 待明细 / 未支持不伪报完整、零余额复杂科目不阻断、备抵符号、亏损、红冲、
   父子各有自身金额不双算、安全整数溢出 / 非法金额 / 重复 code、重复调用无 mutation。
5. 现金流对方分类：小企 `3001` / 企业 `4001` → `financing`；小企 `4001` / 企业 `5001` → `operating`；
   固定资产购入 → `investing`；未知 / 现金 / 应付利息 → `unknown` + 明确 reason。
6. 生产模块 import 图纯净：profiles 无 import，rules 只依赖 profiles；无 db / 文件 / 网络 / 环境变量引用。

阶段 A **未**执行也无法替代：迁移、真实建账 / 导入 / 结转 / 封账、HTTP / Agent / MCP、
导出接线、真实连续链与全套回归。

## 6. 阶段 B 不可减免门槛

阶段 B 继续原完整 LOCAL-03a 任务（共享核心文件仍需 root 明确扩大远端认领），必须包含：

1. **持久 profile 与旧库迁移**：所有无 profile 既有账套（无论登记小企 / 企业 / 未知标签）迁为
   `legacy-small-coa-v1`；保留 `accounting_standard` 原值；空账套同样保持旧配置；profile 变更无普通更新入口，
   不做准则转换工具。
2. **迁移前后一致性与原子性**：复用 LOCAL-02 实际存在的迁移事务 / 版本 +1 / 一致性备份机制；
   备份先于新列 / 新表写入（含 WAL 已提交状态）；失败原 schema / 业务 / 版本回滚；重复启动不重复迁移；
   失败重试重新备份；不得非法降级未知更新版本；文档说明恢复会退回快照时点。
3. **历史不改写**：科目 `code/name/category/direction/contra/is_leaf`、资产卡片指定科目、
   凭证 / 分录 / 期间 / 来源 / 企业绑定 / 批次全部保留；legacy 报表走旧兼容路径并验证原值一致；
   旧自定义 / 混合科目保留原记录并给未映射 / 冲突诊断，不靠标签猜成企业新配置。
4. **旧批次兼容**：旧成功 `create` 批次重放先定位既有批次与账套再按 legacy profile 校验；
   `append` 使用目标实际 profile；payload 准则标签不改 profile；新增 profile 版本字段须向后兼容，
   不批量覆盖旧指纹。
5. **真实业务接线**：新建 / 导入 / 资产 / 期末检查 / 跨年结转全部按账套持久 profile 解析角色；
   小企 `3103 → 3104`，企业利润只结入 `4103` 再年末转 `4104`；一企一账套约束不退化；
   建账 / 科目 / 期间 / profile 同一事务。
6. **入口与导出**：`/api/meta`、账套 list / detail / create、HTTP / Agent / MCP 真实传递与返回 profile 与诊断；
   `report-export.mjs` 五类导出 profile / 诊断透传需 root 协调该文件窗口后最小接线。
7. **完整手算连续链**：原任务两组（小企 A / 企业 B）以 2025-11 建账、按月追加、真实过账 → 检查 →
   结转 → 封账 → 2025-12 `yearEnd` → 开 2026-01；结转前后三表 / 余额表 / 明细账一致，年末不改变资产 / 现金；
   另有固定资产卡片默认折旧科目、无形资产路径、亏损 / 红冲 / 重复结转 / 反操作、迁移故障注入与恢复、
   旧批次重放等合成场景。
8. **回归与审查**：受影响会计 / 导入 / 报表套件 + 一次 `npm test` 全套；未参与实现且 `fork_turns=none`
   的独立内容审查实际 diff 与固定金额结果；最终按已审 head 串行合并并交接。

**不得**以阶段 A 纯模块测试替代上述任一项。

## 7. 模型与数据边界（执行期）

- 执行者只用已核实的 tokenhub 主 / 回退模型（root 显式锁定 `deepseek-v4.1-flash` 作主与唯一回退）；
  不自行切换模型、不启动子 agent。
- 员工不执行 Git 提交 / 推送 / 合并；Git 与 PR 由 root 管理者执行。
- 无真实账套 / 税务凭据 / 私有采集数据 / 用户配置；不访问或重启税局窗口与旧后端；不读其他 worktree。
- 不用真实账套数据做自动测试；本机绝对路径 / PID 只进 root 的 ignored 记录，不入版本化文档。
- 源码 / 任务 / 合成错误按项目已核实 tokenhub 授权范围发送；不得绕过沙箱。
