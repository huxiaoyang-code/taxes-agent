> CSV极界补充：同16路径内csvCell现以已审formatCents(storedCents(value))格式化，避免可往返的90071992547409.90被Number.toFixed(2)多舍成.91；合法100现金/100资本明细真实CSV/XLSX/PDF及HTTP分别校验。最终测试与历史完整入口边界以本段交接为准，不冒称最终完整83exit0。

> 2026-10-23 范围补充：[Issue45 comment6364132865](https://github.com/huxiaoyang-code/youshu-fork/issues/45#issuecomment-6364132865) 将同16路径的report-export微窗扩大到本模块金额聚合/加减与超界拒绝。合成1000现金明细期初900000000000.01 + 999×0.01应为900000000010，旧Number累加多0.01；修复用已审money整数分读取、原posted/期间窗口逐行聚合，期初/closing、ledger运行余额与YTD分桶均以分加减后安全转换。不能精确保分或越安全分界限时返回report_data_invalid，不生成附件。DTO/累计范围/现金边界/诊断/CSV结构及通用money/core/Office生产均不改；这属于冻结b20已存在的准确性P2，不归因于窄复合实现。

## LOCAL-05b 窄复合现金流合同（2026-10-23，实施候选）

两实际持久profile `small-2011-basic-v1` / `enterprise-2019-general-basic-v1` 复用原分类根与映射版本。现金纯单向、全部非现金发生额在相反侧、每个非现金科目只解析到1403材料或1601设备（含合法明细）、正常资产借方非备抵、各科目不能双侧有额，且整数分全额严格相等时，先整张校验，再以分项自身金额归经营 / 投资；同根重复行和同方向多个现金明细可合并，不按比例、优先级或尾差，不输出虚构银行逐笔配对。现金语义冲突同样不能通过。

合成例：材料120 + 设备180 / 银行付300，经营-120、投资-180、筹资0、净-300；期初500→期末200，unknown为空、分类与勾稽完整。同样形状按原账面金额单纯反转20/30收50，经营+20、投资+30；不宣称程序识别了退款合同或原凭证关联。只读取posted且非carryforward账簿事实，不写账簿或来源。

材料120 + 设备180 / 银行只付100 + 应付200、双向现金配对歧义、设备100含处置利得50收150、1604用途不明、未知或冲突/备抵科目仍unknown/incomplete；不会因多个根都可分类而放开。单一对方、内部划转可行区间、gross和legacy原兼容保持。后月完整不消除同年度前月诊断，跨年只重置本年度窗口。完整只指基础映射；来源completeness=unverified、taxFilingReady=false，间接法仍非独立勾稽。

分类依据沿用[财政部小企业准则正文](https://kjs.mof.gov.cn/zhengcefabu/201111/P020111118325852319878.pdf)第82–84条与[附录](https://kjs.mof.gov.cn/zhengcefabu/201111/P020111118325852734144.pdf)现金流编制说明、[财会〔2019〕6号附件2](https://www.mof.gov.cn/gkml/caizhengwengao/wg201901/wg201905/201909/P020190912379331344319.pdf)经营购货/投资长期资产分类；全额纯单向形状是本项目的窄工程判据，不是准则原文算法。未实现任意复合分配、完整法定现金流、现金等价物或真实税务接入。

本段候选的任务与实际自测记录见 [任务](tasks/LOCAL-05-CASHFLOW.md) / [交接](handoffs/LOCAL-05-CASHFLOW.md)。旧候选、未合叙述与历史验证保持原时点，双准则原03范围已随PR68/69/70/71实际合并，当前基线b20bba0；旧文不作为05b新证据。

# 会计 profile 与内部报表规则（LOCAL-03a）

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

## 历史阶段与详细规则依据

以下阶段 A / B1 的状态与自测数字按当时版本保留，不能替代当前候选验证。

> **2026-10-23 B2 出口续作检查点（实施者自测，尚未独立验收 / 提交 / 合并）**：本轮只接续 LOCAL-03a 第一段出口与模型消费，已完成五类内部 CSV / XLSX / PDF 的持久 profile、映射状态与稳定行 ID 适配。此前文中“出口 WIP 未测试”“Office / 08 未适配”是对应历史冻结点，不能作为本检查点的现状；此前 PR / main / 测试数量亦仅描述当时版本。本轮不证明 LOCAL-03 / LOCAL-05 整体完成。身份全入口、统一测试注册、公共交接与最终 fresh 独审仍待后续。全国电子税务局真实接入数仍为 0，所有样张仍是内部报表，来源完整性仍为 `unverified`。

### B2 本轮出口合同

五类 CSV DTO 与 XLSX / PDF 元数据均携带实际持久 `accountingContext`（`profileId/coaVersion/reportMappingVersion/legacy`）和 `reportStatus`（`status/complete/partialValues/diagnostics`）。三张映射报表明确区分 `complete/incomplete/legacy_compatibility`；余额表和明细账原始账簿导出使用 `not_applicable` 表示不做三表映射认证。状态不是来源完整性或申报认证。

资产负债表按稳定行 ID 配对期初 / 期末，不再靠数组位置；没有 ID 的 legacy 行按原标签兼容。启用月的上期末列保留真实建账期初。利润表按实际行 ID / 标签 / 分金额消费新 profile，legacy 继续标注其他收入 / 费用的旧折叠口径。

现金流累计合并每一个月的映射状态和诊断，末月完整不能抹掉前月未分类。新 profile 复合 / 用途未明的现金流明确为部分金额，未分类金额不补到三类净额；legacy 继续比例分摊，并保留旧口径限制。既有合成例中已分类累计净额 530、实际现金余额变动 230（差额 300 为未分类复合采购）分别保留，不能将其中一个改为另一个；在建用途未明的期初现金 1000、支出 100、次月收入 20，累计现金变动 -80、已分类累计 20，仍为 incomplete。

### B2 本轮模型消费合同

三张映射报表的模型摘要新增固定 `profile`（`small_basic_v1/enterprise_basic_v1/legacy_small_v1`）、`legacy/mappingStatus/complete/partialValues/diagnosticCount/diagnosticCounts`。计数键只来自已登记诊断码，绝不返回科目明细、企业 key / 名称、自由 reason 或原始错误。未知 profile、科目 / 映射版本、状态或诊断码均 fail closed；MCP transport 只追加三个 profile 与三个映射状态固定 token，未放宽通用 token 或敏感值规则。

08 的写结果 `applied/needsLocalReview`、真实技术 ID、未知结果禁止误导重试、引用 / 账套隔离与投影预算保持。资产负债表行数根据真实行数组计数，未换成另一硬编码常量；原金额与安全断言保留。

### B2 本轮实际验证与剩余工作

全部为新建独占工作区合成 fixture，运行前核完整祖先无 reparse，先隔离 TEMP / TMP / fallback 数据目录再导入模块。未读取真实库 / 税务凭据；未扫描清理全局 TEMP；失败日志 / fixture 保留；HTTP 子进程只按自有 child handle 结束并等待退出。

| 本轮实际命令（cwd 为 `06-workbench`） | 结果 |
|---|---|
| `node test/report-export.test.mjs` | 23/23，exit 0 |
| `node test/report-office-export.test.mjs`（显式 REPORT_OFFICE_PYTHON） | 25/25，exit 0；45 PDF 逐页几何文字重叠 / 越界均 0 |
| `node test/finance-output-policy.test.mjs` | 40/40，exit 0 |
| `node test/finance-model-adapter.test.mjs` | 21/21，exit 0 |
| `node ../05-reconstruction/codex/mcp/finance-mcp/finance-model-transport-test.mjs` | 18/18，exit 0 |
| `node test/report-export-http.test.mjs` | 31/31，exit 0 |
| `node test/report-office-http.test.mjs` | 6/6，exit 0 |
| `node test/smoke.test.mjs` | 28/28，exit 0；合法小企费用 5602，净利 -300 保留 |
| `node test/accounting-guards.test.mjs` | 23/23，exit 0 |
| `node test/accounting-period-integrity.test.mjs` | 45/45，exit 0 |

HTTP 三套首次在沙箱内因自有随机 loopback 的 `connect EACCES` 失败，获批以相同合成测试重跑后上述通过；不是删除断言或连接既有服务。Office 首次因依赖缺失不能启动，管理者按锁文件离线恢复依赖，package / lock 哈希未变。保留中间失败，不将失败说成通过。

新增独立手算样张共 2 profile × 3 月 × 5 类 × 3 格式 = 90 文件。小企 2025-11 / 12 / 次年1月净利 1600 / 800 / 600、现金 12800 / 13700 / 14500；企业净利 2500 / 1300 / 700、现金 24500 / 25900 / 26900。对所有样张核 CSV 金额、XLSX 数值单元格、PDF 中文可提取 / 页数 / 每页渲染；45 PDF 几何覆盖新增样张及既有长中文 / 巨大摘要 / 分页 / 字体等回归。代表 PNG 已打开目视检查，未声称逐页全部像素目视。样张与独立金额明细保存在本轮忽略 QA 目录，定位 / SHA256 / 失败记录见本机 `.agent-runs/local03-slice1-export-delivery-20261023.md`（非跨机器交付依赖）。

本段未重跑 / 改动备份与 contra 四个冻结文件，不拿其前轮 29/29、34/34 当本轮结果。身份 / server / tools / MCP server / UI / seed / import / test-all / 公共四文档仍属后续；未跑最终全套、未做整个候选独立验收、未建中间 PR、未提交 / 推送 / 合并。本检查点不可单独作为完整03/05合并。

---

以下保留历史阶段记录；当前本段状态以上述 2026-10-23 检查点为准。

本文件说明 LOCAL-03a 交付的 **profile / 报表规则纯模块（阶段 A）** 与 **持久 profile + 真实领域接线（阶段 B1）**：
三个 profile 的科目与角色、内部资产负债表 / 利润表行项目、金额契约、支持范围、权威来源、错误码、
持久结构、迁移语义与下游 DTO。

> **边界声明**：本文件覆盖**内部简化报表的已核实基础业务子集**与迁移 / 领域接线；**不是**法定完整财务报表、
> 税局申报格式或税务计算实现。「登记了分录」不等于「自动算税」。B1 未接 HTTP / Agent / MCP / 导出入口，
> 未注册 `test-all`，未做 v5 备份工具兼容；**LOCAL-03a 尚未整体交付**，B2 门槛见 §11.8。

## 1. 模块与公开接口

| 模块 | 作用 | 依赖 |
|---|---|---|
| `06-workbench/server/accounting-profiles.mjs` | profile 定义、科目表、角色表、来源与支持范围 | 无 import（纯语言能力） |
| `06-workbench/server/accounting-report-rules.mjs` | 报表行项目规则、科目解析、纯计算、现金流对方分类 | 仅依赖上面的 profiles 模块 |

两个模块都不读写数据库、文件、网络、环境变量，也不启动服务；`import` 无副作用。
测试 `06-workbench/test/accounting-standard-profiles.test.mjs` 只读导入现状 `coa.mjs` 作 legacy 等值对照，
不导入 `db.mjs` / `accounting.mjs`，不建库、不起服务。

### 1.1 `accounting-profiles.mjs`

| 接口 | 契约 |
|---|---|
| `listAccountingProfiles()` | 返回冻结摘要数组，含 `id / declaredStandard / creationAllowed / legacy / coaVersion / reportMappingVersion / scope / sources` |
| `getAccountingProfile(profileId)` | 精确查找并返回**深度冻结**的可序列化描述（含 `coa` 与 `roles`）；未知 ID 抛 `accounting_profile_unknown`，**不 fallback** |
| `resolveNewAccountingProfile({ accounting_standard, profileId } = {})` | 仅选择“新建账套”可用的 profile，不创建 / 更新任何账套、不推断企业身份 |
| `getAccountingRoles(profileId)` | 返回冻结角色表；角色按 profile 解析，不依赖科目名称或编码尾号 |

`resolveNewAccountingProfile` 规则：

- 省略 `accounting_standard` 且未给 `profileId` → 默认 `small-2011-basic-v1`（小企）；
- `accounting_standard` 只接受**精确**的 `"小企业会计准则"` / `"企业会计准则"`；
  其他字符串、带空格、非字符串、`null` 一律 `accounting_standard_invalid`（空白不是默认值）；
- 显式 `profileId` 必须存在且与 `accounting_standard`（若给）一致 →
  否则 `accounting_profile_unknown` / `accounting_profile_standard_mismatch`；
- legacy profile 不可新建 → `accounting_profile_legacy_not_creatable`；
- 参数不是对象（`null` / 数组 / 标量）→ `accounting_standard_invalid`。

### 1.2 `accounting-report-rules.mjs`

| 接口 | 契约 |
|---|---|
| `getAccountingReportRules(profileId)` | 冻结、可序列化的规则描述：`profileId / reportMappingVersion / engineMode`、资产负债表与利润表的 `rowId / label / 科目规则 / 合计依赖`、往来反向列示 `reciprocal`、合法负列示 `negativePresentation`、基础现金流分类规则、`unsupported` / `requiredDetails` 清单 |
| `resolveAccountingAccountRule(profileId, account)` | 解析单个科目：`matchedRoot`、`isDetail`、`roles`、`effective`、`scope`、`statements`、`diagnostics`；名称仅展示 |
| `evaluateAccountingStatement(profileId, { kind, accounts, amounts })` | 纯计算 `balance-sheet` / `income-statement`，返回行项目、合计、往来反向余额 `reclassifications` 与 `diagnostics` |
| `classifyAccountingCashCounterpart(profileId, account)` | 单一对方科目现金交易的 `operating` / `investing` / `financing`，否则 `unknown` + `reason` |

## 2. 金额契约（阶段 B 必须遵守）

- `amounts` 为 `[{ code, netMinor }]`，`code` 唯一，`netMinor` 是**安全整数分**、**借减贷**、可正负，
  代表**各科目自身金额**，不含父级汇总重复值。
- 资产负债表输入「截至期间的**期末余额**」；利润表输入「明确时间窗内**排除结转**的损益发生净额」。
- 本模块**不查库、不选期间、不筛 posted、不计提**，也不解析货币字符串或浮点元；
  阶段 B 必须用 LOCAL-02 已验金额函数与已验证查询生成输入，不重写舍入。
- 拒绝 `NaN`、`Infinity`、字符串、非整数、`null`、重复 `code`、`amounts` 引用不存在的科目；
  累计溢出安全整数 → `amount_overflow`；**不接受隐式归 0**。
- 返回：`{ profileId, reportMappingVersion, engineMode, kind, complete, rows:[{ id, label, valueMinor }], totals, reclassifications, diagnostics }`，
  全部金额为安全整数分，返回对象深度冻结。`reclassifications` 记录已确定的往来反向余额列示
  （`accountCode / matchedRoot / fromRowId / toRowId / amountMinor`），不产生错误诊断、不影响 `complete`。

符号与列示约定：

- 资产负债表的资产行取借减贷有符号值；**备抵资产（累计折旧 / 累计摊销 / 减值准备）为负值**，
  原值、累计、净值分别展示，但**只有净值计入资产总计**，不会把备抵加成正资产、也不重复汇总。
- 负债 / 权益行按贷方自然方向展示为正；未分配利润 = 利润分配 + 本年利润 + **未结转损益**
  （= −Σ 损益科目借减贷）。因此结转前后同一业务**期末净资产不变**，未结转损益直接增减未分配利润。
- 利润表：收入取贷方净额（红冲可为负），费用取借方净额（红冲可为负），允许亏损。
- 生产成本按各自口径计入存货：小企 `4001`、企业 `5001`；企业 `5001` 不是收入，企业 `4001` 不是存货。
- 往来反向余额：按每个科目自身余额方向逐项判断，**不先把同一行明细净额相加**。小企
  `1122` 贷方→`2203` 预收账款、`2203` 借方→`1122` 应收账款、`2202` 借方→`1123` 预付账款、
  `1123` 贷方→`2202` 应付账款；重分类写入 `reclassifications`，不产生错误诊断。企业
  `2202/1123` 双向同样列示；企业 `1122` 贷方 / `2203` 借方因预收款项与合同负债 / 合同资产
  需合同细类，给 `account_reverse_balance_requires_detail`，不计入合计且 `complete=false`。
  其他未定义列示行的相反余额同样给该诊断，不静默冲减资产或负债，也不把它归因于
  “流动 / 非流动期限重分类暂缓”。权益类（利润分配 / 本年利润等）的借方余额是亏损 /
  减少，仍按负值展示，不套用往来反向诊断。
- 小企应交税费 `2221` 期末借方余额按附录第73页(28)以负号列示，属**合法负列示**：
  保留在“应交税费”本行、不按往来反向诊断、不改列其他行；该规则按 profile / 科目登记在
  `balanceSheet.negativePresentation`，不扩张到未核实科目或其他 profile。合法负列示、
  备抵常规余额（有符号金额）、权益亏损 / 损益红冲与往来反向重分类分别处理，不共用一条方向规则。

## 3. 三个 profile

| profile ID | 登记准则 | 可新建 | legacy | 说明 |
|---|---|---|---|---|
| `legacy-small-coa-v1` | `null` | 否 | 是 | 派工基线 `coa.mjs` 的逐项静态快照，仅用于旧账套兼容读取 |
| `small-2011-basic-v1` | 小企业会计准则 | 是 | 否 | 小企基础业务子集（财会〔2011〕17号正文与附录） |
| `enterprise-2019-general-basic-v1` | 企业会计准则 | 是 | 否 | 企业一般业务子集（财会〔2006〕18号附录条目 + 后续指南，行项目基础取财会〔2019〕6号附件2） |

- legacy **不是第三种法定准则**：`declaredStandard` 为 `null`，旧账套原 `accounting_standard` 标签由阶段 B 账套记录保留，
  迁移不改历史科目、不改历史凭证，也不代表旧账套实际遵守小企业准则。
- profile 一旦交付，**ID 与含义固定**；阶段 B 沿用，不另造兼容别名。
- 一个 profile 只是一套**已核实的内部基础业务子集**，不代表「2026 全业务准则实现」或法定完整财务报表。

### 3.1 关键同码不同义（禁止跨 profile 混用）

| 编码 | 小企 profile | 企业 profile |
|---|---|---|
| `3001 / 3002 / 3101 / 3103 / 3104` | 实收资本 / 资本公积 / 盈余公积 / 本年利润 / 利润分配 | — |
| `4001 / 4002 / 4101 / 4103 / 4104` | `4001` 生产成本、`4101` 制造费用 | 实收资本 / 资本公积 / 盈余公积 / 本年利润 / 利润分配 |
| `5001` | 主营业务收入 | 生产成本 |
| `5301` | 营业外收入 | 研发支出 |
| `5001 / 5401 / 5602`（收入 / 成本 / 管理费） | 5001 / 5401 / 5602 | 6001 / 6401 / 6602 |
| 生产成本 | `4001` | `5001` |

角色按 profile 表解析（实收资本、资本公积、盈余公积、本年利润、利润分配、生产成本、主营 / 其他收入、
主营 / 其他成本、管理费用、默认折旧费用、固定资产、累计折旧、无形资产、累计摊销、现金根科目），
**不依赖名称或编码尾号**；同码在不同 profile 下解析到不同含义，名称不能纠正编码语义。

### 3.2 科目 scope 三态

每个预置科目都必须有可说明的 scope 状态：

- `mapped`：已核实并可直接进入内部报表行项目；
- `requires_detail`：需要持有 / 分配 / 处置 / 资本化等明细资料才能归类，**非零余额不得静默计入合计**；
- `unsupported`：本包未实现对应业务，**非零余额必须给出不完整诊断**。

每个预置科目还记录 `sourceId`（该科目的核实来源，见第 7 节），未映射科目同时记录具体 `reason`。

当前 `requires_detail` 示例：`1606 固定资产清理`、`1901 待处理财产损溢`、`2401 递延收益`、
`4101 / 5101 制造费用`、`5201 劳务成本`、`4301 / 5301 研发支出`。
当前 `unsupported` 示例：小企 `4401 工程施工`；企业 `1101 交易性金融资产`、`1471 存货跌价准备`、
`1511 长期股权投资`、`6701 资产减值损失`。

scope 三态描述**科目定义本身**；往来反向余额是**金额方向**问题，不改变 scope，
另以 `account_reverse_balance_requires_detail` 诊断或 `reclassifications` 列示处理。

## 4. 报表行项目（内部简化报表）

### 4.1 资产负债表

- 共同行：货币资金、应收票据、应收账款、预付（账款 / 款项）、其他应收款、存货、固定资产原价 /
  减：累计折旧 / 固定资产账面价值、在建工程、无形资产原价 / 减：累计摊销 / 无形资产账面价值、
  长期待摊费用、短期借款、应付票据、应付账款、预收（账款 / 款项）、应付职工薪酬、应交税费、
  应付利息、应付股利（利润）、其他应付款、长期借款、长期应付款、实收资本、资本公积、盈余公积、
  利润分配、本年利润、未结转损益、未分配利润、所有者权益合计、负债和所有者权益总计。
- 小企特有：短期投资、应收股利、应收利息分别列示（`1131 / 1132 / 1221` 三行）。
- 企业按已核实范围汇总：`1131 / 1132 / 1221` 合并为「其他应收款」一行。
- 合计：`assets` / `liabilities` / `equity` / `liabilitiesAndEquity`。
- 原值 / 累计折旧摊销为展示行，不进入资产总计；未使用且已核实的行项目不因「余额为 0」而阻断报表。
- 往来反向余额列示：小企行项目按附录第69页(4)、第70页(5)、第72页(25)(26)要求按明细科目余额方向分列
  （`1122` 贷方→预收账款、`2203` 借方→应收账款、`2202` 借方→预付账款、`1123` 贷方→应付账款）；
  企业只对可确定的 `2202` 借方→预付款项、`1123` 贷方→应付账款双向分列，`1122` 贷方 /
  `2203` 借方的预收款项与合同负债 / 合同资产细类未确定时给 incomplete。
  `getAccountingReportRules(...).balanceSheet.reciprocal` 暴露这些映射与未解决原因；
  `balanceSheet.negativePresentation` 单独暴露已核实的合法负列示（小企 `2221`，附录第73页(28)）。

### 4.2 利润表

营业收入（主营 + 其他）、营业成本（主营 + 其他）、税金及附加、销售费用、管理费用、财务费用、
投资收益、营业利润、营业外收入、营业外支出、利润总额、所得税费用、净利润。
合计至少包含 `netProfit`（另含 `operatingRevenue` / `operatingProfit` / `totalProfit`）。

企业所得税费用只汇总**已记录分录**，不做纳税调整与自动算税。

## 5. 现金流对方科目分类（受限）

`classifyAccountingCashCounterpart` 只处理**单一对方科目、可解释**的基础交易：

- 资本 / 资本公积 / 盈余公积 / 本年利润 / 利润分配、借款、长期应付款、应付股利（利润）→ `financing`；
- 固定资产、无形资产、短期投资、投资收益、应收股利、应收利息 → `investing`
  （普通非金融企业投资股利 / 债券利息收现）；
- `1604` 在建工程用途不明 → `unknown`（`construction-in-progress-purpose-ambiguous`）：
  可能是购建长期资产 `investing`、资本化借款利息 `financing` 或工程人员薪酬 `operating`，
  单一科目不能确定；不把在建工程统一列为投资活动；
- 日常商品 / 劳务收入、成本、存货、生产成本、应收应付 / 预收、应付职工薪酬、应交税费、
  税金及附加、销售 / 管理费用、所得税费用 → `operating`；
- 现金科目之间互转 → `unknown`（`counterpart_is_cash`）；应付利息 → `unknown`
  （`interest-payment-classification-ambiguous`）；
- 用途 / 细类不明：预付账款（可能预付工程款 `investing`）、财务费用（借款利息 `financing`
  vs 手续费 `operating`）、营业外收入 / 支出、其他应收 / 应付、长期待摊费用 → `unknown`
  + 固定 `reason`（`prepayment-purpose-ambiguous`、`finance-expense-interest-vs-fee-ambiguous`、
  `non-operating-income-purpose-ambiguous`、`non-operating-expense-purpose-ambiguous`、
  `other-receivable-purpose-ambiguous`、`other-payable-purpose-ambiguous`、
  `long-term-deferred-expense-purpose-ambiguous`）；
- 未映射科目、scope 不足、语义冲突 → `unknown` + 明确 `reason`。

**单一对方科目不是分类充足的充分条件**：同一科目可能因用途 / 合同 / 资产细类不同而归入
不同现金流类别；本包只在用途可从科目语义确定时给 `operating / investing / financing`，
否则明确 `unknown`。

**未实现**（阶段 B / LOCAL-05b 承担）：复合凭证按比例分摊、现金等价物与受限资金判定、
完整现金流量表引擎与间接法调节表。受限现金 / 现金等价物不因单一现金科目自动归入经营 /
投资 / 筹资，仍为 `unknown`；阶段 B 继续负责现金凭证筛选与金额分配验证。

### 5.1 同一凭证的 gross 双向现金与配对可证性（R1 + R2 返修，2026-10-22）

现金凭证不再按「整张凭证的现金净额」处理（净额 0 会被直接跳过，导致真实的两笔交易消失）：

- 现金流入 = 该凭证现金科目**借方合计**；现金流出 = 现金科目**贷方合计**，两者始终按真实借贷方向保留；
- 同一凭证的现金内部划转金额 `t` 只需吸收「超出非现金对方的现金部分」，因此
  `t ∈ [max(0, 流入 − 非现金贷方), min(流入, 流出)]`（凭证平衡保证两项下界相等）：
  - `t` 收敛为单点 → 外部现金收付金额可证：流入 − `t`、流出 − `t`；差额只能是现金科目之间的划转；
  - `t` 存在多个可能值（同一凭证同时有现金流入 / 流出，且借方与贷方都有非现金对方）→ 配对不唯一：
    不分类、不把假定金额写进经营 / 投资 / 筹资合计，按方向给 `unknown` +
    `ambiguous-cash-counterpart-pairing`（`inflow` 保留流入 gross 正数、`outflow` 保留流出 gross 负数），
    `classificationComplete=false`、`reportStatus.complete=false`；现金 `begin / end / change` 仍如实反映；
- 该方向只有一个非现金对方科目 → 按 `classifyAccountingCashCounterpart` 归类；
- 该方向有多个非现金对方科目 → `unknown` + `multi-counterpart-allocation-not-implemented`；
- 纯现金内部划转（`t` 唯一且外部金额为 0）→ 三类 0、`unknown` 空、`classificationComplete=true`；
- 绝不按比例分摊、绝不用净额 0 消除双向 gross 事实，也不靠摘要 / 名称 / 行顺序猜配对。

已验证的固定口径（合成数据 + 独立字面量）：

- 同一凭证「期初 借 1001 100 / 贷 4001 100；本期 借 1002 100 / 贷 1001 100 / 借 1601 100 / 贷 4001 100」→
  三类 0、`unknown` 保留流入 +100 / 流出 −100、`classificationComplete=false`：同一批分录既可读成
  「内部存现 + 非现金资产出资」，也可读成「现金出资 + 现金购建资产」，不得假定其中一种；
- 同一凭证「借 1002 100 / 贷 6001 100 / 借 1601 100 / 贷 1002 100」→ 同样 gross + incomplete，
  不假装知道经营 / 投资配对（R1 曾按 `min` 给出经营 +100 / 投资 -100，R2 已改正）；
- 两个**独立**凭证「借 1002 100 / 贷 6001 100」与「借 1601 100 / 贷 1002 100」→
  经营 +100 / 投资 −100、`unknown` 空、完整勾稽；
- 现金内部划转 → 三类 0、`unknown` 空、`classificationComplete=true`；部分现金 + 应收 / 应付 →
  按对方方向归类（60 / −70）；复合多类别（借 1403 120 + 借 1601 180 / 贷 1002 300）→
  `unknown -300`、不分类、`reconciles=false`。

### 5.2 现金细目的权威语义与余额（R2 返修，2026-10-22）

- 参与本期现金 gross 与期初 / 期末余额的**全部现金细目**，都必须用 profile 根科目语义校验
  类别 / 方向 / 备抵；合法自定义明细（如 `100201` 资产 / debit）通过；
- 现金 `begin / end` 按真实「借方 − 贷方」整数分事实汇总（同一科目前缀只计一次），
  **不盲信库内可能已损坏的 `direction`**：`100201` 被历史异常改成负债 / credit 时，
  借方 100 仍计为现金 100，不会翻成 −100，也不会抹为 0；
- 语义冲突 / 未映射保留 `report_account_semantics_mismatch`
  （`account-category-conflict` / `account-direction-conflict` / `account-contra-conflict`）或
  `report_account_unmapped` 诊断，`classificationComplete=false`、`reportStatus.complete=false`；
  金额事实（含可核经营 / 投资 / 筹资分类）仍保留，不静默完整；
- legacy 账套仍走旧兼容路径，不重算旧账，`legacy_profile_compatibility` 明确不完整。

## 6. legacy 分支（防历史重解释）

- `getAccountingReportRules("legacy-small-coa-v1").engineMode === "legacy-compatibility"`，
  两个报表 `rows` 与 `totals` 为空，明确由阶段 B 旧报表兼容路径承接。
- `evaluateAccountingStatement("legacy-small-coa-v1", …)` 返回 `complete: false`、`rows: []`、`totals: {}`、
  `reclassifications: []`、诊断 `legacy_engine_required`，**不返回假装算出的完整金额**。
- legacy COA 是基线 `06-workbench/server/coa.mjs` 的逐项静态快照：保留顺序、
  `code / name / category / direction` 与 `contra` 的有无和值，不纠错旧名称、不增科目、不合并、不排序；
  独立冻结，不运行时引用可变 COA 数组。
- 快照来源记录：基线提交 `98977e04bd24aa293074021802191814f8c2a1d2`、来源文件
  `06-workbench/server/coa.mjs`、SHA256 `cc49061c56eb2574d52b33708cf5b52564dad9ef30b88a669c596467989d8f2e`。
  测试直接与现状 `coa.mjs` 做完整逐项 `deepStrictEqual`，出现漂移即失败。

## 7. 权威来源

规则定义只引用 `sourceId`，不复制长篇法规原文。所有来源在 2026-10-22 核对。

页数按官方 PDF 实际页数核对：小企附录 85 页（第69/70/72/73/81页条目已逐页核对），
企业2019附件2 18 页（第2-3、4-8、15-16页条目已逐页核对）；两者不互相借用页码。
`source` 对象另记录 `pageCount`（小企附录 85、企业2019附件2 18），测试校验引用页码不超过实际页数。

| sourceId | 文件 / 文号 | 标题 | URL | 本包适用范围 |
|---|---|---|---|---|
| `mof-2011-17` | 财会〔2011〕17号 | 小企业会计准则（正文） | https://kjs.mof.gov.cn/zhengcefabu/201111/P020111118325852319878.pdf | 适用边界与报表基本要求 |
| `mof-2011-17-appendix` | 财会〔2011〕17号 | 小企业会计准则附录（科目、主要账务处理、报表） | https://kjs.mof.gov.cn/zhengcefabu/201111/P020111118325852734144.pdf | 小企基础科目与报表行项目；附录共 85 页：第69页(4)应收账款贷方→预收账款、第70页(5)预付账款贷方→应付账款、第72页(25)(26)应付账款借方→预付账款与预收账款借方→应收账款、第73页(28)应交税费借方余额负号列示、第80-82页现金流量表分类说明（第81页3.(2)⑤购建长期资产现金不含资本化借款费用与在建工程人员薪酬）；科目编号为参考编号 |
| `mof-2006-18-appendix` | 财会〔2006〕18号 | 企业会计准则应用指南附录：会计科目和主要账务处理（商务部政府法规库转录） | https://policy.mofcom.gov.cn/claw/clawContent.shtml?id=13655 | 只取已核实的基础科目条目；不整篇视为 2026 现行 |
| `mof-2023-01-cas-guide-reply` | 财政部会计司答复 | 企业会计准则科目需结合 2014 年以来应用指南 | https://www.mof.gov.cn/bd/mhwzzxly/hjs/202301/t20230104_3861971.htm | 说明 2006 附录不是唯一现行依据 |
| `mof-2019-06-appendix-2` | 财会〔2019〕6号 | 一般企业财务报表格式（适用于已执行新金融准则、新收入准则和新租赁准则的企业，附件2） | https://www.mof.gov.cn/gkml/caizhengwengao/wg201901/wg201905/201909/P020190912379331344319.pdf | 企业内部一般报表行项目基础；附件2共 18 页：资产负债表第2-3页、项目说明第4-8页（含第5页在建工程、第6-7页应付账款含预付账款贷方、第8页合同资产/合同负债），现金流量表第15-16页（购建长期资产、分配股利利润或偿付利息）；附件1 不作为 2026 默认 |
| `mof-2017-22` | 财会〔2017〕22号 | 企业会计准则第14号——收入 | https://m.mof.gov.cn/zcfb/201707/t20170719_2653110.htm | 新收入准则替代旧收入 / 建造合同处理；复杂合同业务未实现 |
| `mof-2026-07-interpretation-20` | 财会〔2026〕7号 | 企业会计准则解释第20号 | https://kjs.mof.gov.cn/zhengcefabu/202606/t20260615_3991686.htm | 含金融资产合同现金流量特征与货币缺乏可兑换性；本包不实现其分类计量与追溯调整 |
| `repo-coa-baseline` | — | 派工基线 `coa.mjs` 逐项快照 | — | 仅 legacy 兼容读取，不是新企业模板依据 |

## 8. 明确未覆盖的业务（2026 范围）

- 金融工具分类与计量（含解释第20号相关衔接与货币缺乏可兑换性）、长期股权投资；
- 租赁、递延所得税、减值计算与减值分摊、流动 / 非流动期限重分类（如一年内到期的长期借款）；
  往来反向余额列示已按基础 profile 实现，不归入此项；
- 新收入准则下的复杂合同资产负债、履约成本、退货等业务（旧工程施工模板不作为普遍现行模板）；
- 合并报表、外币折算、行业专用业务（金融 / 保险等）；
- 自动算税、纳税调整、税局申报文件与任何税局上传格式；
- 准则转换工具：新建 profile **不是**旧账套转换；legacy 不能通过标签「升级」成新 profile。

缺少已核实依据的科目编号或分类不补齐、不猜号；未覆盖的业务以 `scope` / 规则清单 / 诊断
显式暴露，不能用「其他收入 / 其他费用」兜底后声称完整。

## 9. 错误码与诊断码

抛错（`error.code`）：

| code | 场景 |
|---|---|
| `accounting_profile_unknown` | profile ID 未知 / 空 / 非字符串 |
| `accounting_standard_invalid` | 准则非精确受支持值、空白、非字符串、参数非对象 |
| `accounting_profile_standard_mismatch` | 显式 profile 与请求准则不一致 |
| `accounting_profile_legacy_not_creatable` | 用 legacy profile 新建账套 |
| `account_code_invalid` / `account_category_invalid` / `account_direction_invalid` / `account_contra_invalid` / `account_shape_invalid` | 科目输入形状非法 |
| `account_code_duplicate` | `accounts` 中 code 重复 |
| `amount_invalid` / `amount_code_duplicate` / `amount_account_missing` / `amount_overflow` | 金额非法 / 重复 / 缺科目 / 累计溢出 |
| `statement_kind_invalid` / `statement_input_invalid` / `statement_accounts_invalid` / `statement_amounts_invalid` | 报表调用参数非法 |
| `report_rule_invalid` / `report_rule_root_unknown` | 规则定义自检失败（模块内部一致性） |

计算诊断（`diagnostics[].code`，出现即 `complete: false`）：

| code | 含义 |
|---|---|
| `account_unmapped` | 非零科目未映射到本 profile 已验证根科目 / 数字明细 |
| `account_category_conflict` / `account_direction_conflict` / `account_contra_conflict` | 科目类别 / 方向 / 备抵语义与根科目冲突 |
| `account_requires_detail` | 需要明细资料才能归类（`requires_detail`） |
| `account_scope_unsupported` | 对应业务本包未实现（`unsupported`） |
| `account_scope_unknown` | 支持状态不可判定 |
| `account_out_of_statement` | 该科目不进入所请求的报表（如成本科目进利润表） |
| `account_reverse_balance_requires_detail` | 资产 / 负债 / 成本科目出现与自然方向相反的余额，且无已核实列示行（已核实合法负列示如小企 `2221` 除外）；`reason` 固定说明缺什么明细 |
| `legacy_engine_required` | legacy 账套必须走阶段 B 旧报表兼容路径 |

真实业务写入 / 结转的结构化拒绝（R1 返修新增，均在写入前整体拒绝，不落任何派生凭证）：

| code | 场景 |
|---|---|
| `account_semantics_conflict` | `addAccount` 自定义明细的类别 / 方向 / 备抵与 profile 根科目冲突（未映射编码仍允许，留给报表 `account_unmapped`） |
| `accounting_role_semantics_conflict` | 必要角色科目（本年利润 / 利润分配 / 默认折旧费用）的库内元数据与准则映射冲突 |
| `carryforward_account_semantics_conflict` | 参与损益结转 / 年末结转的科目行语义冲突（`details.conflicts[]` 含 `stage / field / accountCode / matchedRoot / reason(s)`）；期末检查同码拒绝 |

`accounting_profile_unknown` 的 `details` 只含固定 `field` 与 `reason`，**不回显**库内任意原始 profile 字符串。

现金流分类 `unknown` 的 `reason`：`counterpart_unmapped`、`counterpart_is_cash`、
`counterpart_scope_requires_detail`、`counterpart_scope_unsupported`、
`interest-payment-classification-ambiguous`、`prepayment-purpose-ambiguous`、
`construction-in-progress-purpose-ambiguous`、`finance-expense-interest-vs-fee-ambiguous`、`non-operating-income-purpose-ambiguous`、
`non-operating-expense-purpose-ambiguous`、`other-receivable-purpose-ambiguous`、
`other-payable-purpose-ambiguous`、`long-term-deferred-expense-purpose-ambiguous`、
`classification_not_verified`、`legacy_engine_required`，以及科目语义冲突的对应诊断码。
往来反向余额 `account_reverse_balance_requires_detail` 的 `reason`：
`receivable-credit-balance-contract-liability-vs-advance-requires-detail`、
`advance-receipt-debit-balance-receivable-vs-contract-asset-requires-detail`、
`reverse-balance-presentation-not-defined`。

## 10. 阶段 A / 阶段 B 边界

阶段 A（本次）只交付纯模块与定向测试：**纯规则已实现并自测、第二轮独审最小回修已落地待复审、尚未接线，阶段 B 未完成**。

### 10.1 第二轮独审最小回修（待复审，不代表已通过）

- **旧错误 1（P2）**：`2221` 等资产 / 负债 / 成本反向余额曾被同一条 blanket 判断挡住；
  小企 `2221` 借方余额被置 0 且 `complete=false`。现按小企附录第73页(28)单独登记
  `negativePresentation`：输入 `1002:+90000、2221:+10000、3001:-100000`（分）得
  应交税费 `-10000`、资产 `90000`、负债和所有者权益 `90000`、`complete=true`。
  旧测试中“2221 借方应 incomplete”的错误预期已删除，改用未定义列示的 `2201` 反向余额。
- **旧错误 2（P2）**：`1604` 在建工程曾无条件 `investing`。现两 profile 均改为
  `unknown` + `construction-in-progress-purpose-ambiguous`；资本化借款利息应 `financing`、
  工程人员薪酬应 `operating`，无用途信息不能确定。`1601/1701` 等可判断正向分类保留。
- **旧错误 3（P3）**：来源元数据曾把 85 页小企附录的第80-82页挂到 18 页企业2019附件2。
  现小企附录来源记录第69/70/72/73/80-82页，企业2019附件2来源记录第2-3、4-8、15-16页；
  两者分别记录 `pageCount: 85 / 18`，测试按实际页数校验。
- **实际计数**：定向测试 `41/41` 通过、exit 0；新增 3 项回归在修复前为 `38/41`（3 项红），
  修复后 `41/41` 绿。未参与实现的独立复审尚未给出通过结论。

以下仍属阶段 B，且不得用纯模块单测替代：

1. 持久 profile 字段与旧账套 `legacy` 迁移（含迁移前一致备份、WAL 恢复、失败原子性）；
2. 所有既有账套迁为 legacy、历史凭证 / 期初 / 标签 / 资产卡片 / 来源批次**不被改写**；
3. 旧成功 create 批次重放与 append 指纹兼容；
4. 一企一账套约束与新建 / 导入 / 资产 / 期末检查 / 跨年结转的真实 profile 接线；
5. HTTP / Agent / MCP 真实入口与 DTO 诊断透传，`report-export.mjs` 五类导出的 profile / 诊断协调；
6. 原任务两组完整手算连续链（真实过账 → 检查 → 结转 → 封账 → 年末 → 次年）、受影响回归与最终全套；
7. 独立内容审查、最终已审 head 串行合并与交接。

---

## 11. 阶段 B1：持久 profile、真实领域接线与旧账兼容（实现完成，未合并、未整体交付）

B1 从实际 main `dfefae0553052474b8a9308105443714bc5d9cfb`（LOCAL-02 #47 / PR #60 已合）与阶段 A 冻结 `47866a3` 出发，
在本 worktree `local-03a` 实现；**不重造**阶段 A 的三个 profile、COA 与纯规则引擎，保留其已审 API。

### 11.1 持久结构（schema v5，只加一列）

```sql
-- import-storage.mjs migration v5（迁移前一致备份 → 同一事务加列 + 记版本）
ALTER TABLE account_sets
  ADD COLUMN accounting_profile_id TEXT NOT NULL DEFAULT 'legacy-small-coa-v1';
```

- 只存**不可变 profile ID**；科目表 / 报表映射版本由该 ID 解析，不另存可互相矛盾的 `coaVersion` /
  `reportMappingVersion` 多列。
- 迁移前既有账套（小企标签、企业标签、未知标签、空账套）**一律**成为 `legacy-small-coa-v1`；
  原 `accounting_standard` 字符串原样保留，不按标签重种科目、不转换历史、不改期初 / 科目 / 卡片 / 凭证 /
  期间 / 企业绑定 / 来源 / 批次 / 指纹。
- 未知或损坏 profile **不 fallback 到新小企**：正常业务抛 `accounting_profile_unknown`；
  只读恢复核对仍可直接读原始行 / 备份。
- 没有普通更新入口；本文件与领域层都不提供“改 profile / 准则”的 API，也不做准则转换。
- 一企一账套唯一约束（`import_enterprise_account_sets`）未变。

迁移链仍为 `ensureImportSchema`：先备份（含 WAL 已提交数据）→ 备份记录 + 新结构 + 迁移版本同一事务；
失败整体回滚、重试重新备份、重复启动幂等。v3 / v4 候选可逐级升 v5。

### 11.2 建账与旧首次导入

- `createAccountSet({ name, taxpayer_type, accounting_standard, start_period, profileId?, enterprise })`：
  - 省略准则（`undefined` / `null` / `""`）→ `small-2011-basic-v1`；
  - 只接受精确的「小企业会计准则」「企业会计准则」；首尾空白、其他字符串、非字符串 → `accounting_standard_invalid`；
  - 显式 `profileId` 必须存在且与准则一致 → `accounting_profile_unknown` / `accounting_profile_standard_mismatch`；
  - legacy profile 不可新建 → `accounting_profile_legacy_not_creatable`；
  - 账套、profile 科目表、首期间在**同一保存点**内写入；失败不留下半截账套。
- `importAccountSet` 仍保留无批次返回形状，但本候选要求显式 `enterprise`（或一致的 envelope source 身份）；新建账套按 payload 准则选择新 profile，
  `validation` 新增 `profile` / `profileError`（profile 错误也以 `code: message` 进入 `errors`，不逃逸成泛 500）。
- 增量 `mode=create` 同样按准则选择新 profile；`mode=append` **不**用 payload 标签改 profile。
- 已有账套 profile 只按持久 `accounting_profile_id` 读取，普通参数不能改变它或准则。

### 11.3 增量导入：先定位目标，再严格归一化

`normalizeImportPayload(payload, context?)` 新增**内部第二参数**（不是 payload 字段）：

```js
context = { profileId, accounts? }   // 由服务端在定位 append 目标 / 已完成 create 批次后传入
```

- `importIncremental` 现在先做最小参数 / 批次读取，定位 append 账套或旧已完成 `create` 批次的目标账套，
  再以**目标实际 profile 与真实科目表**调用严格 normalize；不再在查 batch / 目标之前按新企业模板拒绝旧录入。
- 旧 `create` 重放保留企业标签 + 旧小企 COA 的合法 `5001` 收入；重放仍核验内容一致、企业绑定、
  当前凭证存在 / posted / 落库指纹、真实期初；不因“先找到 batch”跳过。
- `append` 沿目标实际科目表与同企一账套规则；payload 的准则标签不改变 profile。
- 预检与正式执行同规则，出错零业务写入；旧批次 / 来源指纹规则未改。
- 未知 profile 的目标账套 → 结构化 `accounting_profile_unknown`；`import_context_invalid` 只用于内部上下文形状错误。

### 11.4 profile 角色在真实业务中的使用

- 期初 / 凭证 / 资产卡片 / 损益结转 / 年末结转 / 后续期间依赖守卫全部按**持久 profile 角色**解析：
  - 小企 / legacy：损益结转 `3103`，年末 `3103 → 3104`，默认折旧费用 `5602`；
  - 企业：损益结转 `4103`，年末 `4103 → 4104`，默认折旧费用 `6602`。
- `period-end-controls.mjs` 的 `yearEndCarryStep`、`assertPeriodMutable` 年末依赖识别、
  资产核对根科目均改为 role 驱动，不再用 SQL 硬编码 `3103/3104` / `5602`。
- 必要角色缺失 / 与科目表冲突时在写入前失败（`accounting_role_missing`），不伪造分录。
- **R1 返修**：角色与结转参与科目还须通过**准则映射语义校验**（类别 / 方向 / 备抵），
  不再用库内 `direction` 直接推 `natural`：
  - 结转前扫描「声明为损益，或准则映射属于损益」的非零科目，以及 `yearEnd=true` 时本年利润前缀下的非零明细；
  - 发现冲突即在保存点**外**整体拒绝（`carryforward_account_semantics_conflict`），不产生任何结转凭证、
    不删除草稿结转、不先提交再改一行；
  - 年末结转借贷方向取准则根科目权威方向；正常创建的自定义明细在 `addAccount` 写前就拒绝冲突（`account_semantics_conflict`）。
  - 未映射（无根科目）的损益自定义科目仍按声明方向结转，报表侧同时报 `account_unmapped`：这是已知边界，不冒充已校验。
- `periodEndCheck` 新增：
  - 顶层 `accountingContext`；
  - `warnings`（固定诊断码；legacy 为 `legacy_profile_compatibility`，新 profile 登记准则不一致为
    `declared_standard_profile_mismatch`）；
  - `rules.profitAccount` / `retainedEarningsAccount` / `defaultDepreciationExpense`；
  - 原 `accountSetId / period / ready / steps / blocking / missing / rules` 与原 step id、状态语义保持。
- legacy 警告**不自动**变成封账阻塞；未知 profile / 必要角色缺失才在真正写入前失败。
  `period_end_check_failed`、`later_period_closed`、`later_year_end_carryforward_depends_on_period` 等原控制码保留。

### 11.5 报表实现（真实已过账凭证 + 期初）

- 新 profile 的三表由真实余额 / 时间窗与阶段 A `evaluateAccountingStatement` 计算，不重写规则引擎：
  - 资产负债表：截至期间的科目自身**期末余额**（借减贷），父子科目各计一次；原值 / 累计 / 净值分别展示，
    只有净值进资产总计；企业 `5001` 生产成本进存货，绝不计入营业收入；资本公积单独列示；
  - 利润表：仅**明确时间窗内、排除结转**的已过账损益发生净额；本期与本年累计分开，年中启用时起点取
    `max(账套启用期间, 当年 1 月)`；**不按库内 `category === 损益` 预过滤**（否则被错误登记成资产 / 负债的
    收入会连同金额一起消失，得到漂亮零表）：按准则映射判断是否属于利润表范围，未映射编码交给规则给
    `account_unmapped` + 金额事实；冲突科目给 `report_account_semantics_mismatch` 且 `complete=false`；
  - 现金流：按方向分类**单一非现金对方科目**的基础现金凭证（gross 双向与配对可证性见 §5.1）；
    配对不唯一时不假定类别，按方向保留 gross 事实到 `unknown`；现金细目的类别 / 方向 / 备抵
    用 profile 权威语义校验，余额按真实借减贷汇总（见 §5.2）；复合对方科目不按比例分摊、
    不猜现金等价物 / 受限现金，给 `cash_flow_classification_incomplete`，且不把未分类金额塞进
    经营 / 投资 / 筹资。
- legacy 走**真实旧兼容计算**（原 `balanceSheet` / `incomeStatement` / `cashFlowStatement` 逻辑），
  返回 `legacy_compatibility` + `complete=false`；不把阶段 A 的 `legacy_engine_required` 空值当完成。
- 保留小企 `2221` 借方余额的合法负列示；企业同输入给 incomplete；`1604` 现金流用途不明给 unknown；
  非零未知 / 需明细 / 语义冲突明确 incomplete，零余额复杂科目不阻断；不因算式碰巧平衡就宣称完整。
- 金额仍由 LOCAL-02 `money.mjs` 与已验证查询生成（净额使用整数分），未改变单笔上限、未新增浮点舍入。
- **R1 返修**：资产负债表的 `balanced` 用 `evaluation.totals` 的**整数分**比较
  （`BigInt(assets) === BigInt(liabilities) + BigInt(equity)`），不再用浮点 `===`、也不靠 epsilon 抹平真实差额：
  `0.30 = 0.10 + 0.20` → `balanced=true`；真正差 1 分（如企业 `1122` 贷方无已核实列示行）→ `balanced=false`。

### 11.6 稳定下游 DTO（B1 只产出，不改 05 / 08 入口）

- 账套（`getAccountSet`、`listAccountSets` 可解析项）与三表 / 期末检查统一新增：

```js
accountingContext = {
  declaredStandard,        // 本机原登记字符串（迁移不改）
  profileId,               // 持久 profile ID（SQL 列 accounting_profile_id）
  coaVersion,
  reportMappingVersion,
  legacy,                  // true = 兼容实现，不是第三种准则
}
```

- 三表新增 `reportStatus`：

```js
reportStatus = { status, complete, partialValues, diagnostics }
// status: complete | incomplete | legacy_compatibility
// 两个新 profile 在支持范围内 complete=true、partialValues=false
// incomplete → complete=false；如仍给出部分金额则 partialValues=true
// balanced / reconciles 仅代表算术勾稽，不替代 complete
```

- `diagnostics[]` 至少 `{ code, severity, reportKind, accountCode?, reason }`；`severity` 为 `warning/error`；
  `reason` 为固定标记，不含 SQL / 堆栈 / 文件路径 / 摘要 / 企业名。固定外层码：
  `legacy_profile_compatibility`、`declared_standard_profile_mismatch`、`report_account_unmapped`、
  `report_account_requires_detail`、`report_account_semantics_mismatch`、`cash_flow_classification_incomplete`。
  本机原始 `accountCode` 可用于定位；模型 / 导出侧只能按各自政策保留允许的码 / 计数 / 受控引用。
- **R1 返修新增可审金额事实**（只增字段，不改旧字段 / 单位）：

```js
// 资产负债表：未进入任何报表行的非零金额（语义冲突 / 待明细 / 未映射 / 超出本表）
unresolvedAmounts = [{ reportKind, accountCode, matchedRoot?, amountMinor, reasons: [诊断码...] }]
// 利润表：本期与本年累计分别给
unresolvedAmounts = { current: [...], ytd: [...] }
// 现金流未分类项增加方向标记
unknown[] = [{ code?, direction: "inflow" | "outflow", category: "unknown", reason, value }]
// reason 包含 ambiguous-cash-counterpart-pairing（同凭证双向现金配对不唯一）
// 现金细目语义冲突另给 report_account_semantics_mismatch / report_account_unmapped（含 accountCode）
```

  这些金额**绝不**写进任何报表行或合计（不漂亮归零、不误分类），只作为人工核对事实；
  同一科目同一金额的多条冲突诊断合并为一条并列出 `reasons`。legacy 分支返回空数组。
- 报表 DTO 保留旧主要字段与单位：资产负债表 `assets[] / liabilities[] / totals{assets,liabilities,equity} / balanced`；
  利润表 `current / ytd` 旧中文键；现金流 `operating / investing / financing / totals / cash / reconciles /
  supplement_indirect`。新增 `rows`（`id/label/valueMinor`）、`reclassifications`、`unknown`、
  `classificationComplete` 等**只增不改**字段。
- 结构化错误（`Error.code` + `Error.details`）：
  - `accounting_profile_unknown`：profile ID 未知 / 损坏（details 只含受控 field / reason，**R1 起不回显原始 profile 字符串**）；
  - `accounting_standard_invalid`：准则非法 / 首尾空白 / 非字符串 / 空白不是默认值；
  - `accounting_profile_standard_mismatch`：显式 profile 与准则不一致；
  - `accounting_profile_legacy_not_creatable`：legacy 新建；
  - `accounting_profile_immutable`：预留（本文件不提供普通 profile 更新入口）；
  - `accounting_role_missing`：必要角色未定义 / 对应科目不在账套科目表；
  - `accounting_role_semantics_conflict` / `account_semantics_conflict` / `carryforward_account_semantics_conflict`：
    R1 返修新增的准则语义冲突拒绝（角色科目 / 自定义明细写前 / 结转参与科目）；
  - `import_context_invalid`：内部 normalize 上下文形状错误（非 payload 输入）。
  `details` 只放受控 `field / profileId / accountCode / reason`，不回显未知原始输入。

### 11.7 B1 实际测试（cwd=`06-workbench`）

| 命令 | 结果 |
|---|---|
| `node test/accounting-standard-profiles.test.mjs` | 41 / 41 exit 0 |
| `node test/accounting-standards.test.mjs` | 28 / 28 exit 0（B1 原 17 + R1 新增 8 + R2 新增 3） |
| `node test/accounting-standards-migration.test.mjs` | 6 / 6 exit 0 |
| `node test/accounting-guards.test.mjs` | 23 / 23 exit 0 |
| `node test/accounting-derived.test.mjs` | 31 / 31 exit 0 |
| `node test/accounting-period-integrity.test.mjs` | 45 / 45 exit 0 |
| `node test/import-strict.test.mjs` | 54 / 54 exit 0 |
| `node test/import-incremental.test.mjs` | 49 / 49 exit 0 |
| `node test/voucher-amount-guards.test.mjs` | 103 / 103 exit 0 |

- `accounting-standards.test.mjs`：两家合成企业各一账套，2025-11 建账 → 12 月 → 次年 1 月真实过账 / 检查 /
  结转 / 封账；表格金额（小企 3000/1600/1600/12800/0/800/13600/2800 等，企业 5000/2500/…）全部按独立手算字面量核对；
  年末 `3103/3104`、`4103/4104`，次年利润分配保持上年数；企业 `5001` 在产品 1000 不变且不计收入；
  两准则 100 元三月卡片 33.33/33.33/33.34，第 4 月不再提；无形资产、默认费用科目、不适用 / 缺计提 / 账卡差异；
  小企 2221 负列示、企业同输入 incomplete、1604 现金流、未知非零 / 零余额、同码冲突、非法准则、
  多企业隔离、重复计提 / 结转、后期 4103→4104 依赖、失败原子性、legacy 兼容报表与旧 create 重放。
- R1 返修新增 8 项（仍全用真实 API + 独立字面量，未删旧断言）：410301 方向冲突写前拒绝且不双贷；
  利润表冲突收入不被预过滤丢弃且保留 `amountMinor=-10000`；同凭证双向现金 gross（经营 +100 / 投资 -100）；
  现金内部划转 / 部分现金 + 应收（60）/ 部分现金 + 应付（-70）；复合多类别 `unknown -300`；退款 -100 +
  负数金额拒绝；`0.30 = 0.10 + 0.20` 整数分平衡 + 真正 1 分不平；未知 profile 只回 `field/reason`。
- R2 返修（2026-10-22）新增 3 项并改写 R1 的 1 项：原“同凭证双向现金→经营 +100 / 投资 -100”改为
  “同凭证双向现金 + 双向非现金→三类 0、gross +100/−100、incomplete”；另增 R1 收入 + 资产同凭证的同一歧义；
  两个独立凭证验证可证经营 +100 / 投资 −100；现金明细 `100201` 被改成负债 / credit 后余额仍为借减贷 100、
  经营 100 保留、类别 / 方向冲突诊断 + `classificationComplete=false`（合法 `100201` 对照仍完整）。
- `accounting-standards-migration.test.mjs`：真实 v4 合成旧库（企业标签 + 旧小企 COA + 已完成 create 批次）
  与 v3 合成旧库；迁移前 v4 备份 `verify` / `restore-new` 到全新目录成功，恢复库由真实 `db.mjs` 入口升 v5；
  v4→v5 备份含 WAL 已提交批次、业务行 / 指纹 / 原标签不变、所有旧账套为 legacy；旧 create 批次**新进程**重放
  `idempotent_replay`、内容变化 `batch_content_changed`、append / 查询 / 重启一致；v3→v5 保留历史；
  故障注入整体回滚并重试重新备份；未知 profile 结构化拒绝且原始行仍可读。全部合成临时路径 + 随机临时库。
- 旧 fixture 仅做必要合法更新：`accounting-derived.test.mjs` 的“损益明细归类”用例补足资金来源（避免把
  “负货币资金”这一不真实场景当成报表规则断言），金额 / 其他断言未删、未降精度。

### 11.8 B1 未做 / 待 B2（不得据此宣称整体交付）

1. **v5 备份 / 恢复**：`local-backup.mjs` 当前仍严格只支持 v3 / v4；B1 / R2 **未修改**该文件与 CLI / 测试。
   v5 库备份会被明确拒绝，必须等银行 #53 最终结构与窗口释放后在 B2 增加 `STRUCTURE_V5` 与完整测试；
   B1 已实际验证 **v4 迁移前备份**可 `verify` / `restore-new` 并由真实入口升 v5。
2. **入口接线**：`server.mjs`、`agent-tools.mjs`、MCP `tools.mjs` 未改；`accountingContext` / `reportStatus`
   尚未进入 HTTP / Agent / MCP DTO。B2 才接真实入口与连续链。
3. **导出 / Office**：`report-export.mjs` / `report-office-export.mjs` 未改；B1 只保证核心返回值与旧主要字段兼容。
   现有 `report-export` 套件在 R1 后为 18 / 21（原 17 / 21），R2 **未重跑、未改导出源码**；已知差异为
   新 profile 行项目 / 累计折旧符号 / 复合现金流口径，登记为 B2（05 导出）适配项，未删断言。
   `report-office-export` 在本 worktree 仍缺 `exceljs` 依赖，R2 未运行、未安装依赖。
4. **08 输出边界**：新增字段 / 行项目计数差异需 08 在 B2 更新精确允许字段与未知键处理；B1 未改 08 文件。
5. **测试注册**：`scripts/test-all.mjs` 未改；B1 三套新测试尚未注册。
6. **公共交接**：`docs/handoffs/STATE.md`、`NEXT-SESSION.md`、任务索引 / INDEX / CHANGELOG 未改（归 root 释放窗口）。
7. **其他既有套件**：`smoke.test.mjs` 1 项因在新小企账套导入企业科目 `6602` 得到 incomplete 报表而失败（B2
   合法 fixture 适配）；`finance-model-adapter.test.mjs` 1 项因资产负债表行数 39 vs 旧 28 失败（B2 08 适配）；
   `local-backup.test.mjs` 初始化即因版本 5 ≠ 4 失败（B2 备份）。均**未**通过修改旧断言绕过。
8. 全程未使用真实账套 / 税局凭据 / 私有采集；真实税局接入仍为 **0**，税局现场仍暂停；
   本包仍只是内部简化基础业务子集，不宣称 2026 全准则或可申报。

## 12. B1 独审返修 R1（2026-10-22，未合并、不代表已通过复审）

触发：ec4eace 的 B1 独立审查不接受（9 套旧回归全绿不等于领域正确）。本轮的 5 项具体缺陷与最小修复：

| # | 缺陷 | 修复 |
|---|---|---|
| P1 | 年末结转信任库内 `direction` 推 `natural`：企业 `410301`（权益 / debit）参与年末后再次贷记，贷余额 100 → 200 | 结转前用准则映射校验参与科目（类别 / 方向 / 备抵），冲突写前整体拒绝；年末方向取根科目权威方向；`addAccount` 写前校验自定义明细 |
| P1 | 利润表按库内 `category === 损益` 预过滤：企业 `600101`（资产 / debit）的贷方 100 被丢弃，收入 / 利润 0 且 `complete=true` | 按准则映射判断利润表范围；冲突给 `report_account_semantics_mismatch` + `complete=false`；新增 `unresolvedAmounts` 保留金额事实 |
| P1 | 同一凭证现金净额 0 被提前 `continue`：经营入 100 / 投资出 100 全部丢失且三项 `true` | 按方向拆 gross 流入 / 流出；单方向单对方科目才分类；复合给 `unknown` + 方向 + 金额，不按比例分摊、不用净额消除诊断 |
| P2 | `balanced: totals.assets === totals.liabilities + totals.equity` 浮点比较：0.30 vs 0.10 + 0.20 → false | 用 `evaluation.totals` 整数分 `BigInt` 比较；真正 1 分不平仍为 false（不用 epsilon 抹平） |
| P3 | `accounting_profile_unknown` 的 `details.profileId` 回显未知原始字符串 | 只回固定 `field` / `reason`；仍拒绝且不 fallback |

一致性核查（同一轮）：BS / IS / CF / 结转均以准则映射为权威语义；legacy 仍走旧兼容报表路径、
不因准则标签自动换 profile（原有 legacy 断言全部保留并通过）。

已验证边界（不宣称全）：

- 多对方科目、现金与现金混合划转的**部分归属**在 R1 曾按 `min(该方向现金总额, 该方向非现金总额)` 处理；
  R2 已确认该 `min` 隐含未经证明的配对，改为「内部划转区间唯一才分类，否则保留 gross + 歧义诊断」
  （见 §5.1 / §12.1）；仍不对多对方方向做任何比例分摊。
- 未映射自定义损益科目仍按声明方向结转（报表同时报 `account_unmapped`），不因缺根科目而拒绝写入。
- 红字（负数金额）仍被金额守卫拒绝；冲销走反方向分录，不靠负值改方向。
- 利润表 / 资产负债表冲突金额**不**进入任何报表行，只以 `unresolvedAmounts` 暴露（可核金额 + 诊断原因）。
- 本包仍**未**实现：复合现金流分摊、受限资金 / 现金等价物、期限重分类、金融工具、租赁、递延所得税等（见 §8）。

实际测试（cwd=`06-workbench`，合成临时库）：`accounting-standards` **25/25**（原 17 + 新 8）、
`accounting-standards-migration` **6/6**（未知 profile 新增“不回显原值”断言）、
`accounting-standard-profiles` 41/41、`accounting-guards` 23/23、`accounting-derived` 31/31、
`accounting-period-integrity` 45/45、`import-strict` 54/54、`import-incremental` 49/49、
`voucher-amount-guards` 103/103、`local-audit` 28/28；顺带：`accounting-period-http` 18、
`import-incremental-http` 22、`report-export-http` 29、`finance-output-policy` 37 均通过。
受控未通过（未删断言）：`report-export` 18/21、`smoke` 27/28、`finance-model-adapter` 20/21、
`local-backup` 0/1（v5 拒绝）；`report-office-export` **未能运行**（本 worktree 缺 `exceljs` 依赖）。

### 12.1 B1 独审返修 R2（2026-10-22，未合并、不代表已通过复审）

触发：R1 的 5 项修复经新会话 fresh 独审仍有 2 项不接受。本轮只改 7 个路径（`accounting.mjs` 必要时
`period-end-controls.mjs`、2 个测试、3 份 docs），未碰 `db.mjs` / 纯 profile / rules / 入口 / 备份 / Office / 导出。

| # | R2 拒绝项 | 修复 |
|---|---|---|
| P1 | 同一凭证 `min(现金, 非现金)` 隐含未证明配对：企业期初 借 1001 100 / 贷 4001 100，本期同凭证 借 1002 100 / 贷 1001 100 / 借 1601 100 / 贷 4001 100，原给投资 −100 / 筹资 100 / `complete=true` / `unknown=[]`，编造了类别 | 计算内部划转 `t` 的可行区间；只有 `t` 唯一才分类，否则按方向保留真实 gross 到 `unknown` + `ambiguous-cash-counterpart-pairing`，三类 0、`classificationComplete=false`；R1 的“同凭证 1002/6001 + 1601/1002”同样改为 gross + incomplete，另用两个独立凭证验证经营 +100 / 投资 −100 |
| P2 | 现金编码分支直接按前缀归类、余额按库内 `direction` 推 `natural`：合法 `100201` 被历史改成负债 / credit 后经营 100 但现金 end/change = −100 且 `complete=true` | 参与现金 gross 与期初 / 期末的现金细目全部用 profile 权威语义校验类别 / 方向 / 备抵；余额按真实借减贷整数分汇总，不盲信损坏 `direction`；冲突 / 未映射保留诊断且 `classificationComplete=false`，金额不翻负、不抹 0 |

R2 实跑（cwd=`06-workbench`，合成临时库，TEMP/TMP 为本会话专属目录）：

| 命令 | 结果 |
|---|---|
| `node test/accounting-standards.test.mjs` | **28 / 28 exit 0**（R1 25 + 新 3；其中 R1 的 1 项按真实事实改写） |
| `node test/accounting-standards-migration.test.mjs` | **6 / 6 exit 0** |
| `node test/accounting-standard-profiles.test.mjs` | 41 / 41 exit 0 |
| `node test/accounting-guards.test.mjs` | 23 / 23 exit 0 |
| `node test/accounting-derived.test.mjs` | 31 / 31 exit 0 |
| `node test/accounting-period-integrity.test.mjs` | 45 / 45 exit 0 |
| `node test/import-strict.test.mjs` | 54 / 54 exit 0 |
| `node test/import-incremental.test.mjs` | 49 / 49 exit 0 |
| `node test/voucher-amount-guards.test.mjs` | 103 / 103 exit 0 |
| `node test/local-audit.test.mjs` | 28 / 28 exit 0 |

- R2 未重跑 R1 已实跑的 HTTP 套件、导出 / Office / smoke / adapter / backup；这些项的既有事实与
  B2 归属保留在 §11.8，不声称本轮重跑。
- 仍**未**实现：复合现金流分摊、受限资金 / 现金等价物、分录级配对证据字段、期限重分类等；
  配对不可证时如实给 gross + 歧义诊断，而不是新建 schema / 破坏指纹。
- 未提交、未推送、未合并；R2 仍需独立复审，也不代表 LOCAL-03a 整包完成。

### 12.2 B1 独审返修 R3（2026-10-23，待独立复审）

R2 独审仍发现两准则现金明细 `100201` 资产 / debit 已过账借 100、贷收入 100 后，
仅将 `contra` 改为 1，现金流仍无诊断并声称完整。原因是 `effective.contra` 已合并声明，
不能再用它验证声明与权威根科目是否冲突。领域校验现直接采用既有纯规则的
`account_contra_conflict` 诊断，输出受控 `report_account_semantics_mismatch` /
`account-contra-conflict`，两项完整性为 false；现金与经营流入仍保留真实 100 元。
未修改已审纯规则 / profile。同步修正现金流旧 `min` 注释。

新增两准则反例（含仅期初 / 期末有现金余额的情形），及合法现金明细、权威备抵根 / 明细
（显式标记与继承）、合法收入明细的正向控制；原 28 项断言保留，新增 4 项。
修复前反例实跑 **30/32、exit 1**，恰两项 contra 失败；修复后：

| 命令（cwd=`06-workbench`） | R3 实际结果 |
|---|---|
| `node test/accounting-standards.test.mjs` | 32/32，exit 0 |
| `node test/accounting-guards.test.mjs` | 23/23，exit 0 |
| `node test/accounting-derived.test.mjs` | 31/31，exit 0 |
| `node test/accounting-period-integrity.test.mjs` | 45/45，exit 0 |
| `node test/local-audit.test.mjs` | 28/28，exit 0 |

共 **159/159**。全部仅用合成库，本轮 TEMP / TMP / WORKBENCH_DATA_DIR 为工作区专属忽略目录，
祖先已核无 junction / reparse；未改全局 TEMP，未读取真实账套或税务凭据。
本轮未重跑迁移、legacy / 纯规则独立套件、导入及 HTTP / 导出 / Office / 全套；
这些项仅引用 R2 或更早证据，既有 B2 限制未解决。

本轮 pi 实际周额度 429 后，依据用户 2026-10-23 明确授权由单一兜底实现 subagent 完成本包；
实现者未承担独立审查。仅六文件范围，无 Git 写操作；待管理者独立审查 / Git。
B1 不单独合 main，B2 的入口接线、v5 备份恢复、Office / 导出适配、测试注册、公共交接
与 Issue #61 均未在本包完成；不声称整包通过或已合并。
