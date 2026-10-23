# 任务单 · LOCAL-03a 双准则科目、报表映射与旧账套兼容迁移

## 当前候选合同（2026-10-23）

负责人 `huxiaoyang-code`；分支 `codex/huxiaoyang-code/local-03a`，历史派工输入 `502640906262d6eefbe81b3460361e74ea0811b5`（不是当前候选 HEAD）；当前完整候选已本地保存为 `79a55e7d58e7d6d175997abc96ef6241afa37a14`，基线 main `47b6ec18385ef3f9f1240e12a721e46cd66f218f`，本轮文档提交后的最终 HEAD 由管理者另行锁定。双准则领域、出口、企业身份全入口已实施，当前候选已本地保存、未推送 / 未开 PR / 未合并，最终文档及不可变 HEAD 的独立接受待完成。统一入口保留 main 原 65 套逐字原序并末尾登记实际 8 套（3 个标准领域 / 迁移、身份领域 / HTTP / MCP、标准 HTTP / MCP），共 73 套；实际完整运行结果见下方“本轮完整验证”。

- 新建、legacy 首次导入与 incremental create 都必须显式稳定 `enterprise` / `source.enterpriseKey`；NFKC + trim，保留大小写，接受有限数值文本化，不从名称或来源系统造身份。同 key 换名 / 换来源不得另建账套，不同 key 同名允许。账套 / profile / 科目 / 期间 / canonical 身份在同一事务或保存点，失败原子回滚。
- 历史未绑定账套仍可读；`GET/POST /api/account-sets/:id/enterprise` 及本机 UI 支持显式确认关联。首次关联要求确认，同绑定返回 `no_change`，不强换绑、不自动合并旧重复账套。本机 UI 手工新建与确认绑定已有合成实操；一企一套不等于一企一数据目录，同一库允许多企业各有一个账套。新建 UI 已传显式身份；JSON / CSV UI 文件导入的受支持 filechooser 流程经 root 尝试后仍出现工具实际超时未受控，上传 / 预检结果未知，暂不继续该工具流程；不能由领域 / HTTP 测试代替 UI 成功。
- 真正省略 profile 默认 `small-2011-basic-v1`，精确企业准则选 `enterprise-2019-general-basic-v1`；显式空 / null / 非字符串 / 未知 profile 拒绝 `accounting_profile_unknown`，准则不合法与不匹配分别为 `accounting_standard_invalid` / `accounting_profile_standard_mismatch`，legacy profile 禁新建。历史 `legacy-small-coa-v1` 保持兼容，不能用标签转换。
- append 与已完成 create 批次先定位目标持久 profile，再归一化。旧成功批次重放保持账套 / voucher / source ID、原批次及来源指纹、attempt 与时间戳，验证 canonical / 来源证据 / batch links；重放不重算旧指纹。从未导入期初的批次允许后来合法补期初；实际导入过的期初变化仍冲突。
- 五类 CSV / XLSX / PDF 传持久 `accountingContext` 和 `reportStatus`，三表为 `complete/incomplete/legacy_compatibility`，余额 / 明细为 `not_applicable`。稳定行 ID 对齐，累计现金流保留各月诊断；新 profile 的未知 / 复合现金流不按比例凑齐，不能宣称完整。累计折旧借方净额列示（贷余额为负，零为零），折旧 magnitude、资产净值、利润、幂等及回滚合同不变。
- strict backup 识别 core schema 3 / 4 / 5 × bank 0 / 1 精确合同，未知结构 fail closed；不代表审计业务接线、现库安装或真实 restore 已完成。模型只接固定 profile / 状态 / 诊断计数，未知 fail closed，企业 key / 名称 / 明细与自由错误不出站；08 原脱敏 / 引用 / 账套隔离边界保持。

仅内部简化基础业务子集，不是完整准则或税局可上传申报文件；来源完整性仍 `unverified`，全国真实接入数 0。辅助核算 Issue #64、LOCAL06 审计 / 恢复与 Windows W2、LOCAL07 whole batch 仍未完成；不能由本候选宣称整个 LOCAL01 / 03 / 05 完成。

### 2026-10-23 独审 P2 修复后的验证边界

新增明细科目的严格归一化现调用 `addAccount` 同源 `accountProfileSemantics`，按新建选定或目标持久 profile 拒绝 `account_semantics_conflict`；已有标准科目兼容与旧成功批次指纹规则保持。修后实际命令（cwd `06-workbench`）：`node --check server/accounting.mjs` exit 0；`node test/accounting-standards.test.mjs` 38/38、`node test/import-incremental.test.mjs` 57/57、`node test/import-strict.test.mjs` 54/54、`node test/accounting-standards-http.test.mjs` 2/2、`node ../05-reconstruction/codex/mcp/finance-mcp/accounting-standards-test.mjs` 2/2，全部 exit 0，自有直接 child 均已 close。双 profile 的 legacy / incremental create / append 错类别和方向均静态拒绝、业务及批次 / 来源全表零写；合法同根明细独立金额及 completed 批次 ID / 指纹只读重放通过。

此前管理者在修前候选执行完整入口 `node scripts/test-all.mjs`，73/73 套各 exit 0，入口实际 exit 0、child close，候选 76 文件 hash 前后相同。这是修前真实历史；更早实施者 71/73、1907/1909 项及两税务定点 61 项也保持各自历史时点。P2 修后管理者已重新在 cwd `06-workbench` 实跑完整入口 `node scripts/test-all.mjs`，73/73 套全部 exit 0，入口实际 exit 0、`childCloseObserved:true`，全部源码 / 测试 hash 前后相同；本机证据为根 `.agent-runs/local03-manager-final-c1a7f4d853344f66a9614d3cfeb37914/` 的 `full.log`、`full.exit.json`、`code-after.json`，不以修前完整结果替代。

未参与实施且使用全新上下文的 `review_03_final_whole_fresh` 已完成完整差异静态审查，并在全新合成根独立复验 32 分组：双 profile 的 legacy / incremental create / append 错 category / direction 在 dry / apply 均拒绝，业务及批次 / 来源全表零写；合法自选金额 27.61 / 48.37、旧 IDs / fingerprint / attempt / timestamps 保持，探针 exit 0、DB 已关闭，未确认其他 P1 / P2。本机证据为根 `.agent-runs/review03-final-semantics-fixed-9ba01fb5199e49af82b937d9872648b1/`；最终文档与不可变 HEAD 仍待该独立审查者接受，尚未推送 / PR / 合并，不代表整个 LOCAL03（含辅助 Issue #64）或 LOCAL04 / 06 / 07 已完成。

本机 UI 手工新建与确认绑定已有合成实操；一企一套不等于一企一数据目录，同一库允许多企业各有一个账套。UI JSON / CSV 文件导入两次 filechooser 工具超时；用户已授权 CDP 合成输入，但工具明确不支持 raw CDP，实操仍未知，不能记为通过。所有本轮自有 UI 服务均已结束，不再启动浏览器重试；领域 / HTTP / MCP 通过不替代 UI 实操。内部简化报表子集、来源完整性 `unverified`、真实税局接入 0、辅助维度与 LOCAL06 / 07 未完边界保持。

### 修前实施者完整验证历史

2026-10-23 实施者实际执行 `node scripts/test-all.mjs`（cwd `06-workbench`），新 UUID 合成隔离根、TEMP / TMP / DATA 预设并传 child，显式 Office Python：完整 73 套真正执行，**71/73 套、1907/1909 项，exit 1**。仅两个税务 MCP 旧建账 fixture 漏 enterprise：`tax` 58/59 与 `tax-acquisition-mcp` 1/2；其余 71 套全部 exit 0，含批量 CLI 11/11、Office 25/25、新标准与身份 8 套。批量真实 PDF 文本、CSV / XLSX 累计折旧负号与独立 magnitude / 净值 / 利润 / 幂等 / 回滚断言均通过。

经 Issue #56 comment6359944200 精确授权，完整入口实际 close 后，仅给 `tax-contract-test.mjs` 与 `tax-acquisition-test.mjs` 的两处建账参数补固定合成 enterpriseKey；所有税务请求和旧断言原样。新 UUID 根以原正式 suite 定点重跑 **59/59 + 2/2，均 exit 0**。原完整红例保留；不能将修后定点结果改写为同一最终 hash 的 73 套全绿，该时点管理者完整入口尚待执行；后续修前完整 73/73 已实际通过，见本页 P2 验证边界。修后完整入口与 fresh 独立复验的当前结果见本页 P2 验证边界；最终文档及不可变 HEAD 的独立接受仍待完成。

首轮普通沙箱完整入口因 loopback EACCES 和硬链接权限路径失败，在旧 `tax-readonly-abandon` 的 checkpoint 等待挂起；只进入 21 套、前 20 套已返回，未跑后续。精确核验命令 / 创建时间 / 父子链后持自有 Process handles 收尾，已 wait，wrapper 记录 child close，入口终止码 4294967295、wrapper exit 1；此轮不计完整 73 套。第二轮完整入口与两套定点的直接 child 均实记 close；无本段仍运行的自有 exec / 后端服务。所有 fixture / 失败日志保留，无全局 TEMP 清理、无真实账套或税局操作。逐套日志与 hash 已交管理者；本段不执行 Git。

## 历史阶段材料

下文按原阶段与日期保留来源 / 测试记录；其“未接线 / 待后续”仅指当时版本，现状以当前候选合同为准。

- 类型：会计 profile / 报表规则（阶段 A 纯模块）→ 持久迁移 + 真实接线（阶段 B1 / B2）
- 状态：**阶段 A 纯规则已实现并自测、独立接受；阶段 B1（核心领域 / 迁移 / 真实手算链）已在 worktree 实现并自测，未提交、未建 PR、未合并；B1 独审返修 R1（5 项）已实现并自测，但 fresh 独审仍拒绝其中 2 项（现金流 `min` 隐含配对、现金明细损坏 direction）；R2 已修复这 2 项并自测，尚无独立复审结论；HTTP / Agent / MCP / 导出 / v5 备份与全套注册仍属 B2**
- 基线：阶段 A `98977e04bd24aa293074021802191814f8c2a1d2`；B1 实际 main `dfefae0553052474b8a9308105443714bc5d9cfb`（LOCAL-02 #47 / PR #60 已合），合并 main 后的本地起点 `f7e69bd`
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
| A | 六个新增文件的纯 profile / 报表规则预实现与定向自测 | **已完成实现与自测；47866a3 已被独立接受 / root 41 项通过** |
| B1 | 持久 profile 迁移、核心领域接线、真实手算链、v3 / v4 迁移与旧批次兼容 | **已在 worktree 实现并自测（17 + 6 项新领域 / 迁移，B1 清单全绿）；未接入口、未改备份 / 导出 / test-all；未合并** |
| B2 | HTTP / Agent / MCP / 导出 / Office、v5 备份、全套注册、最终独审与合并 | **未开始（等 05 / 08 / 银行 #53 窗口释放）** |

阶段 A 允许在 LOCAL-02 #47 未合并前，从 root 核实的最新 main 独立 worktree **提前实现纯模块**；
**不允许**提前修改核心共享文件，也不构成阶段 B 的授权。阶段 A 不单独 PR 合并、不把 LOCAL03a 标为完成。

B1 的开窗与实际变化见 §8；精确可写文件、迁移 DDL、DTO 与 B2 待办见
[ACCOUNTING-STANDARDS](../ACCOUNTING-STANDARDS.md) §11 与本任务 §9。

## 3. 阶段 A 精确文件清单（唯一可写范围，六个新增文件）

| 文件 | 作用 |
|---|---|
| `06-workbench/server/accounting-profiles.mjs` | 三个 profile 的科目表 / 角色 / 来源 / 支持范围；新建 profile 选择与结构化拒绝 |
| `06-workbench/server/accounting-report-rules.mjs` | 报表行项目规则、科目解析、纯计算、现金流对方科目分类 |
| `06-workbench/test/accounting-standard-profiles.test.mjs` | 41 项定向回归（原 31 + 第一轮独审回修 7 + 第二轮最小回修 3；纯合成、内联 fixture，无 DB / 服务） |
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
- 往来反向余额：小企按附录第69页(4)、第70页(5)、第72页(25)(26)按明细方向列示
  `1122↔2203`、`1123↔2202`；企业仅 `2202↔1123` 可确定双向，`1122/2203` 需合同细类时
  incomplete；其他相反余额给 `account_reverse_balance_requires_detail`，不静默冲减，
  不称“期限重分类暂缓”。小企 `2221` 期末借方余额按附录第73页(28)以负号保留在本行，
  单独登记为 `negativePresentation`，不按往来反向诊断，也不扩张到其他科目 / profile。
- 现金流分类：`1131/1132` → `investing`；`1123`、`5603/6603`、`5301/6301`、`5711/6711`、
  `1221/2241`、`1801` 用途不明 → `unknown` + 固定 reason；`1604` 在建工程用途不明
  （购建支出 / 资本化借款利息 / 工程人员薪酬）→ `unknown` +
  `construction-in-progress-purpose-ambiguous`，不无条件列为 `investing`。单一对方科目不构成分类充足。

## 5. 阶段 A 验收（实际执行）

工作目录 `06-workbench`，唯一命令：

```bash
node test/accounting-standard-profiles.test.mjs
```

结果：**41 / 41 通过，exit 0**（2026-10-22，合成内联数据，无数据库、无服务、无网络）。
- 第一轮独审回修：新增 7 项回归，修复前 **31 / 38（7 项红）**，修复后 **38 / 38 绿**；
  原 31 项保持通过。
- 第二轮独审最小回修：新增 3 项回归，修复前 **38 / 41（3 项红）**，修复后 **41 / 41 绿**；
  同时修正旧测试中“小企 2221 借方应 incomplete”的错误预期、`1604` 无条件 `investing`
  与来源页码错挂。
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
7. 独审回修 P1：小企 `1122/2203`、`1123/2202` 双向反向余额实算，多明细不净额抵消；
   企业 `2202/1123` 可确定列示，`1122/2203` 缺合同细类 incomplete；无列示规则的相反余额
   （如 `1121` 贷方、`2201` 借方）incomplete，不静默冲减。
8. 独审回修 P2：`1131/1132` 投资收款 `investing`；`1123`、财务费用、营业外收支、
   其他应收应付、长期待摊 `unknown` + 固定 reason；现金 / 受限现金仍 `unknown`，
   正向投资分类（固定资产 / 无形资产 / 短期投资 / 投资收益）保留。
9. 第二轮独审最小回修：小企 `1002:+90000、2221:+10000、3001:-100000`（分）实算
   应交税费 `-10000`、资产 `90000`、负债和所有者权益 `90000`、`complete=true`；
   两 profile `1604` 用途不明均 `unknown` + `construction-in-progress-purpose-ambiguous`，
   `1601/1701` 等正向分类保留；来源元数据按小企附录 85 页 / 企业2019附件2 18 页
   校验页码（小企第69/70/72/73/80-82页，企业第2-3、4-8、15-16页），不再把 80-82 页错挂企业附件2。

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

## 8. 阶段 B1 实际执行记录（2026-10-22，未合并）

### 8.1 开窗与文件边界

- root 正式开窗：LOCAL-02 PR #60 已验收合并，actual main `dfefae0553052474b8a9308105443714bc5d9cfb`；
  阶段 A `47866a3278447db1c4243b9afd2aebe92ea78e55` 已独立接受 / root 41 项通过；本轮把实际 main 合入
  `local-03a` 后开工（本地起点 `f7e69bd`）。不再等待 02。
- B1 精确可写 19 文件：6 个核心（`coa.mjs`、`accounting.mjs`、`db.mjs`、`import-storage.mjs`、
  `import-incremental.mjs`、`period-end-controls.mjs`）、本包 2 个纯模块 + 1 个纯测试、2 个新领域 / 迁移测试、
  5 个旧领域测试的必要合法 fixture、本包 3 份 docs。

### 8.2 实际改动

- `import-storage.mjs`：schema **v5**，`account_sets.accounting_profile_id TEXT NOT NULL DEFAULT
  'legacy-small-coa-v1'`（只加一列，不预置多版本列）；沿用“先一致备份 → 同一事务加列 + 记版本”。
  迁移前所有账套（含企业标签 / 未知标签 / 空账套）一律 legacy，保留原 `accounting_standard`。
- `coa.mjs`：旧 `COA` 保留为兼容默认；新增 `coaForProfile(profileId)`，新建账套不再无差别读取单数组。
- `accounting.mjs`：建账 / 旧首次导入 / 增量 create 按准则选择合法新 profile（同事务写账套 / 科目 / 首期间 /
  profile）；`getAccountSet` / `listAccountSets` 增加 `accountingContext`；三表改为 profile 感知：
  新 profile 由真实已过账凭证 / 期初 + 阶段 A 规则计算，legacy 走真实旧兼容计算；三表新增 `reportStatus`
  与固定外层诊断码；`carryForwardProfit` / 资产卡片默认费用按 profile 角色；`normalizeImportPayload`
  增加内部第二参数 context；旧 `importAccountSet` 返回结构不变并带 `profileError`。
- `import-incremental.mjs`：先做最小批次 / 目标读取，再以目标实际 profile / 科目表严格 normalize；
  旧 create 重放不再被新企业模板提前拒绝；append 沿目标科目与一企一账套；导出 `batchFingerprint` 供迁移 / 兼容
  测试构造真实旧批次（指纹字段与排序未改）。
- `period-end-controls.mjs`：年末结转 / 后续年末依赖识别 / 资产核对根科目改为 profile 角色驱动（企业 4103→4104，
  小企与 legacy 3103→3104；默认折旧费用 6602 / 5602）；期末检查新增 `accountingContext`、`warnings`、
  `rules.profitAccount / retainedEarningsAccount / defaultDepreciationExpense`；原 step / 控制码 / 原子性保留。
- `db.mjs` 未改（迁移由 `import-storage.ensureImportSchema` 在启动时执行）；`money.mjs` 只读复用。

### 8.3 实际测试（cwd = `06-workbench`，全部合成临时库 / 无真实账套 / 无税局）

| 命令 | 结果 |
|---|---|
| `node test/accounting-standard-profiles.test.mjs` | 41 / 41 exit 0 |
| `node test/accounting-standards.test.mjs`（新增） | 17 / 17 exit 0（B1）→ R1 25 / 25 → **R2 28 / 28** |
| `node test/accounting-standards-migration.test.mjs`（新增） | 6 / 6 exit 0 |
| `node test/accounting-guards.test.mjs` | 23 / 23 exit 0 |
| `node test/accounting-derived.test.mjs` | 31 / 31 exit 0 |
| `node test/accounting-period-integrity.test.mjs` | 45 / 45 exit 0 |
| `node test/import-strict.test.mjs` | 54 / 54 exit 0 |
| `node test/import-incremental.test.mjs` | 49 / 49 exit 0 |
| `node test/voucher-amount-guards.test.mjs` | 103 / 103 exit 0 |

新领域套件覆盖原任务第 6 节两家企业三个月固定金额表、两准则 100 元三月卡片、无形资产、负列示、1604、
未知 / 零余额科目、同码冲突、多企业隔离、重复动作、后期依赖与原子性；迁移套件覆盖 v4 / v3 合成旧库、
迁移前 v4 备份 `verify` / `restore-new` + 真实 `db.mjs` 入口升 v5、旧业务行 / 指纹 / 标签不变、旧 create 批次
新进程重放 / 内容冲突 / append / 查询、故障回滚与未知 profile 结构化拒绝。详见
[ACCOUNTING-STANDARDS](../ACCOUNTING-STANDARDS.md) §11.7。

### 8.4 受控未通过 / 待 B2（不删断言、不谎称全套通过）

- `local-backup.test.mjs`：初始化断言 `IMPORT_SCHEMA_VERSION === 4` 失败（现为 5）；当前备份工具严格只支持
  v3 / v4，v5 备份 / 恢复必须等银行 #53 最终结构并在 B2 增加 `STRUCTURE_V5`。B1 未改该源码 / 测试 / CLI。
- `report-export.test.mjs`：4 项失败，原因是新 profile 行项目（累计折旧按阶段 A 为负值展示）、CSV 行集合与
  复合现金流按比例分摊（B1 明确不实现的复杂分摊）/ 混合现金凭证分类。归 B2（05 导出）适配。
- `smoke.test.mjs`：1 项失败（在新小企账套导入企业科目 `6602`，报表按新 profile 明确 incomplete，不再按名称
  猜成管理费用）。归 B2 合法 fixture 适配。
- `finance-model-adapter.test.mjs`：1 项失败（资产负债表行数 39 与新 profile 行项目，旧期望 28）。归 B2（08）。
- `accounting-period-http` 18 / 18、`import-incremental-http` 22 / 22、`report-export-http` 29 / 29、
  `finance-output-policy` 37 / 37 实际仍通过（本轮顺带实跑，记录事实）。

### 8.5 收尾

- B1 **不单独 PR 合并**；等 root 独审领域核心、05 / 08 / 银行 #53 实际释放并纳入最新 main 后再精确扩窗 B2。
- 未改 `server.mjs` / `agent-tools.mjs` / MCP / `test-all` / `public` / 公共交接 / 索引 / backup / report-export /
  Office；未注册测试；未操作真实账套 / 税局；真实接入仍为 0。

### 8.6 B1 独审返修 R1（2026-10-22，同模型新会话）

- 触发：ec4eace 的 B1 独立审查不接受，点名 5 项具体缺陷（年末角色方向、利润表 category 预过滤、
  双向现金流净额 0 跳过、BS 浮点平衡比较、未知 profile 回显原值）。
- 本轮可写范围收紧为 11 文件（`accounting.mjs` / `coa.mjs` / `import-incremental.mjs` / `import-storage.mjs` /
  `period-end-controls.mjs` / 3 个测试 / 3 份 docs），**未触碰** `db.mjs`、纯规则 / profile 模块、
  HTTP / Agent / MCP / 导出 / Office / test-all / package / 共享 STATE。实际只改了 5 个文件：
  `accounting.mjs`、`period-end-controls.mjs`、`accounting-standards.test.mjs`、
  `accounting-standards-migration.test.mjs`、三份 docs（`coa.mjs` / `import-*.mjs` 未改）。
- 修复内容与边界见 [ACCOUNTING-STANDARDS](../ACCOUNTING-STANDARDS.md) §5.1 / §11.4–§11.6 / §12。
- 自测：`accounting-standards` **25 / 25**（原 17 项全部保留 + 新 8 项）；`accounting-standards-migration` 6 / 6
  （原 6 项 + 未知 profile 不回显原值断言）；其余 B1 必跑 7 套全绿（41 / 23 / 31 / 45 / 54 / 49 / 103）。
- 受控未通过（未删断言、不谎称全套通过）：`report-export` 18 / 21（原 17 / 21）、`smoke` 27 / 28、
  `finance-model-adapter` 20 / 21、`local-backup` 0 / 1（v5 拒绝）仍归 B2；
  `report-office-export` 本 worktree 缺 `exceljs` 无法运行（环境限制，非本包改动）。
- 未提交、未推送、未合并；不等同于复审通过，也不代表 03 / 05b 完成。

### 8.7 B1 独审返修 R2（2026-10-22，同模型新会话，未提交 / 未复审）

- 触发：R1 的 5 项修复经 fresh 独审仍拒绝 2 项：
  1. P1 现金流 `min(现金, 非现金)` 隐含未经证明的配对（企业期初 借 1001 100 / 贷 4001 100，本期同凭证
     借 1002 100 / 贷 1001 100 / 借 1601 100 / 贷 4001 100 → 原给投资 −100 / 筹资 100 / `complete=true`）；
  2. P2 现金编码分支直接归类、余额依赖损坏 `direction`（合法 `100201` 被改成负债 / credit 后经营 100 但
     现金 end/change = −100 且 `complete=true`）。
- 本轮可写 7 路径：`accounting.mjs`、必要时 `period-end-controls.mjs`、`accounting-standards.test.mjs`、
  `accounting-standards-migration.test.mjs`、`ACCOUNTING-STANDARDS.md`、本任务单、`handoffs/LOCAL-03a.md`。
  **未碰** `db.mjs`（07）、纯 profile / rules、入口（08）、backup（53）、Office / export、
  package / test-all / 共享 docs。实际只改 `accounting.mjs`、2 个测试、3 份 docs。
- 修复：内部划转 `t` 可行区间唯一才分类，否则 gross + `ambiguous-cash-counterpart-pairing` + 不完整；
  R1 的“同凭证 1002/6001 + 1601/1002”改为 gross + incomplete，另用两个独立凭证验证经营 +100 / 投资 −100；
  参与现金 gross / 期初 / 期末的现金细目用 profile 权威语义校验，余额按真实借减贷汇总，冲突保留诊断。
- 实跑（cwd=`06-workbench`，合成临时库）：`accounting-standards` **28 / 28**、
  `accounting-standards-migration` **6 / 6**、`accounting-standard-profiles` 41 / 41、
  `accounting-guards` 23 / 23、`accounting-derived` 31 / 31、`accounting-period-integrity` 45 / 45、
  `import-strict` 54 / 54、`import-incremental` 49 / 49、`voucher-amount-guards` 103 / 103、
  `local-audit` 28 / 28，全部 exit 0。
- R2 **未重跑** R1 已实跑的 HTTP / 导出 / Office / smoke / adapter / backup；
  这些项仍保留既有事实与 B2 归属（v5 backup、Office / export、smoke、adapter 未接线），不声称已修复。
- 未提交、未推送、未合并；R2 不等同于复审通过，也不代表 LOCAL-03a 整包完成。

### 8.8 B1 独审返修 R3（2026-10-23，待独立复审）

- 两准则现金 `100201` 的 contra 冲突漏诊断：领域校验采纳现成纯规则 `account_contra_conflict`；
  现金与经营流入 100 元保留、受控诊断并明确不完整，已审纯规则 / profile 不变。
- 本轮只改登记六文件（领域控制、accounting 旧 min 注释、领域测试、本任务与两份文档）。
  合法备抵根 / 明细继承及显式声明、合法现金 / 收入明细不误拒；新增 4 项，原 28 项保留。
- 反例修复前 30/32、exit 1（恰两项 contra 失败）；修复后实跑（cwd=`06-workbench`）：
  `node test/accounting-standards.test.mjs` 32/32、`node test/accounting-guards.test.mjs` 23/23、
  `node test/accounting-derived.test.mjs` 31/31、`node test/accounting-period-integrity.test.mjs` 45/45、
  `node test/local-audit.test.mjs` 28/28，共 159/159，五套 exit 0。详细证据见
  [ACCOUNTING-STANDARDS §12.2](../ACCOUNTING-STANDARDS.md) 与 [交接 §11](../handoffs/LOCAL-03a.md)。
- 仅合成数据，TEMP / TMP / WORKBENCH_DATA_DIR 专属工作区忽略目录且祖先无 reparse。
  migration / legacy / 纯规则独立套件、导入、HTTP / 导出 / Office / 全套未在 R3 重跑，旧结果不冒充新证据。
- pi 实际周额度 429 后按用户明确授权由单一兜底实现 subagent 完成，本包不自审、无 Git 写；
  待独立审查。B1 不单独合 main；B2 / v5 备份恢复 / 入口 / Office / Issue #61 等未完成。


## B2 第一冻结段检查点（2026-10-23，实施者自测，未独立验收）

本次按 root 串行调度在严格备份与 contra 修复后暂停实施会话，保留出口 / 模型 WIP。
不是 LOCAL-03a 完成交付，不可单独合并到 main；身份全入口、最终整合、fresh 独审仍待后续。

- local-backup 新增独立 STRUCTURE_V5，只在 v4 上新增既有 accounting_profile_id 列；v3/v4 合同不放宽，银行 bank1 精确合同保持。
- 本轮 local-backup.test.mjs 最终 29/29、exit 0，core3/4/5 × bank0/1 六组合均真实 backup→verify→restore-new、逐表行与 ID/指纹一致、恢复旧版后真实入口升级 v5 并再次备份 / 恢复。
- 旧版本合成结构从真实迁移前快照调用 ensureImportSchema(targetVersion:3/4) 生成；迁移登记与一致备份由真实迁移入口产生。业务行由当前真实入口生成后复制，非真实历史账套。
- v5 profile 错列 / 类型 / NOT NULL / 默认值 / 伪抬版本、既有 FK / 唯一索引 / rowid / 表结构坏例继续拒绝；三个核心版本的 bank1 缺表 / 未知版本 / 多余索引 / 触发器 / 三个 partial UNIQUE 谓词变体均拒绝，重算文件摘要也不放行。实际硬链接 / junction 已在获批合成目录执行，没有 skip。
- period-end-controls.accountRows 补 contra，同源 helper 得到实际字段。双标准收入 contra 污染新反例：修前 32/34 exit 1，修后 34/34 exit 0，拒绝结转与期末检查、凭证零写、现金 100 元保留；合法备抵 / 明细原回归通过。
- accounting 的新 profile 资产负债表展示行补稳定 id。report-export / report-office-export / finance-output-policy 及相关测试已有 WIP，尚未完成自测、金额跨月验证或 Office 样张渲染。不得把这些 WIP 当作已接受合同。
- 未改身份入口、server/agent/MCP 入口、UI、seed/import、test-all、银行生产模块与公共交接四文档；未跑最终全套，未执行 Git 写操作。后续先完成出口与模型验证，再按完整 B2 门槛整合。
