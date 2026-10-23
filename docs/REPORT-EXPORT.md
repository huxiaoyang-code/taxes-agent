# 内部报表导出 · RC-B-REPORTS

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

本包交付五类内部 CSV：资产负债表、利润表、现金流量表、科目余额表、明细账。报表只读取现有账簿，包含建账期初及已过账凭证；草稿、反过账凭证不进入金额。CSV 不是税局申报文件，下载成功也不证明账套来源完整或符合目标准则。总体任务及尚未完成的 B2、RC-3、RC-6 见 [交接](handoffs/RC-B-REPORTS.md) 与 [闭环方案](REPORT-CLOSURE-PLAN.md)。

> **当前导出状态（2026-10-22 更新；本文件所有权已追加到 Issue #45 / LOCAL-05a）**：`report-export.mjs` 的 `buildReportExport` 仍是**纯 CSV DTO** 函数（`format` 只接受 `csv`，其余抛 `report_format_unsupported`，`details: {supported:["csv"]}`）。接线分支在 CSV DTO 之上挂载了 `report-office-export.mjs`：真实下载路由 `/export` 现支持 `csv` / `xlsx` / `pdf` 三种真实附件；预览路由 `/export-data` 仍严格只返回 CSV DTO，`xlsx` / `pdf` / `yaml` / 空 `format=` 一律 400，**不静默转 CSV、不生成附件**。失败一律返回 JSON 且无 `Content-Disposition`，不产生半截文件。该接线源码冻结点 `71894a1`（分支 `codex/huxiaoyang-code/local-05-wire`）；本包分支基于 `d5816078`，**已无冲突同步 PR #60 实际 main**（merge `dfefae0553052474b8a9308105443714bc5d9cfb`，2026-10-22T13:34:48Z；Issue #47 已 CLOSED，最终文档 head `18aa6fb` 的 tree 与 merge tree 一致）得到候选 `a9fb1bcf112588f33f615523d46bff8f8bbeb50c`（**PR #60 不含本包 Office 接线**）：`server.mjs` 顶部冲突只做语义并列保留（Office 固定错误映射 + 核心 `PERIOD_GUARD_CODES`），`scripts/test-all.mjs` 末尾登记 `report-office-http`（55 → 56，原 55 个套件不变）。已建 Draft [PR #62](https://github.com/huxiaoyang-code/youshu-fork/pull/62)（**OPEN、未合并**），最终独立审查（root / `review_local05`）待做，合并后对用户主工作区生效。管理者在精确 `a9fb` 实跑 `REPORT_OFFICE_PYTHON=<已核实 Python> npm test`：**56 / 56 套 exit 0**（Office **21 / 21**、`pdfplumber geometry verified for 11 PDFs`、`report-office-http` 6 / 6、`report-export-http` 31 / 31；忽略目录相对证据名 `local-05-final-manager-test.log`，exit 文件 0）。模块细节、错误映射与验收证据见 [REPORT-OFFICE-EXPORT](REPORT-OFFICE-EXPORT.md)。
>
> 能力边界不变：五类报表均为**内部报表**，不是税局申报文件，也不是法定双准则映射或官方行次的实现；复杂现金流分类、间接法独立勾稽与双准则官方映射仍为后续任务。

## 使用与文件格式

在报表页选择账套和已登记期间，选择报表后下载；明细账还需选择科目。**PR #62 合并前**，用户主工作区的页面与下载路由仍只有 CSV——页面格式选择与三格式附件随 `a9fb1bcf` 候选（Draft PR #62），合并后才对用户生效。程序接口（三格式部分为接线分支能力）：

```text
GET /api/account-sets/:id/reports/:kind/export?period=2026-01&format=csv|xlsx|pdf
GET /api/account-sets/:id/reports/ledger/export?period=2026-01&format=csv|xlsx|pdf&code=1002
GET /api/account-sets/:id/reports/:kind/export-data?period=2026-01&code=1002    # 仅 CSV DTO
```

`kind` 为 `balance-sheet`、`income-statement`、`cash-flow-statement`、`trial-balance`、`ledger`。`/export` 返回附件：`csv` 由 `buildReportExport` 原样生成，`xlsx` / `pdf` 由接线模块在同一 CSV DTO 上生成（不经页面前端打印，不重算金额）。`/export-data` 用于与下载一致的页面预览，只接受缺省 / `format=csv`；其他格式为 400 `report_format_unsupported`（`details: {supported:["csv"]}`），从不返回附件。原报表 REST 接口保留兼容；老接口的余额表发生额和明细账范围不能直接解释为本期发生额。

CSV 使用 UTF-8 BOM、CRLF、中文标题、金额两位小数。文件按元数据、限制、试算检查和报表主体分节，不是单一矩形数据导入模板。文本使用双引号及双引号转义；危险的公式文本（含前导空白、制表符等）加单引号，内部生成的负数金额仍为数值。文件名以报表类型、账套 ID、期间和可选科目编码组成，不携带账套名称。

历史表述：“首版仅支持 CSV；Excel / PDF 尚未实现”描述的是本包 PR #15 当时的真实状态，**现已被 2026-10-22 的接线取代**（当前随 Draft PR #62 候选，尚未合并）；不能再用它描述当前 `/export` 的实现能力，也不能反过来说内部报表已具备双准则 / 申报能力。

## 金额与范围

| 报表 | 明确口径 |
|---|---|
| 资产负债表 | 期间期初为上期末；期末为所选期末。复用现有三表算法；附两期平衡标志。|
| 利润表 | 本期发生、本年累计；损益结转凭证不重复计入收入费用。本年从当年 1 月或更晚的启用期间开始。|
| 现金流量表 | 本期与本年分类及净额；年累计相加各月流量，现金期初/期末取区间边界，不相加余额。附余额变动勾稽和比例分摊限制。|
| 科目余额表 | 每个科目的自身金额各一行，含父级直接记账和明细科目；不叠加重复的父级汇总。期间期初、本期借贷发生、本年借贷发生、期末借贷余额及合计齐全。|
| 明细账 | 本科目及编码前缀下级的所选月份逐笔记录，期间期初、本期、本年、期末汇总；记录含真实科目编码、凭证 ID、分录 ID，余额按借减贷表示。|

期间期初 = 建账期初 + 启用日至所选月前的已过账净发生额。本年累计不包含建账期初；年中启用时标记 `partial_year`，不会虚构启用前业务。余额表发生额包含已过账结转凭证，利润表和现金流按原核心规则排除结转凭证，二者用途不同。

未登记期间不被自动创建，封账期间可只读导出。`empty` 仅表示查询范围内无非零建账期初和已过账凭证，**不是已确认没有业务**。现阶段完整性始终为 `unverified`，不能将缺失来源或缺失期间解释为合法零业务。

## DTO 与错误契约

模块 `06-workbench/server/report-export.mjs` 导出：

```js
buildReportExport(setId, { kind, period, format = 'csv', code })
// => { filename, contentType, body, report }
```

该函数本身**只生成 CSV**（`format` 仅接受 `csv`，其余抛 `report_format_unsupported`）；`xlsx` / `pdf` 由 `report-office-export.mjs` 在同一 CSV DTO 上生成，见文首状态说明。

`report` 版本为 `schemaVersion: 1`：

| 字段 | 说明 |
|---|---|
| `kind`, `period` | 已验证报表类型、YYYY-MM 期间。|
| `accountSet` | `id`, `name`, `startPeriod`, `accountingStandard`；准则是登记值，不是认证结果。|
| `scope` | `status: 'posted'`, `periodStart`, `yearStart`（日期字符串）及 `periodStatus`。|
| `dataStatus` | `empty`, `completeness: 'unverified'`, `taxFilingReady: false`。|
| `warnings` | `{code,message}[]`，包括完整性、内部用途、映射未知，必要时空账、年中启用及现金流算法限制。|
| `checks.trialBalance` | `opening/current/ytd/closing` 各有 `balanced/debit/credit/difference`。|
| 其他 `checks` | 资产负债表期初/期末平衡；现金流本期/本年勾稽；`indirectIndependent: false`。|
| `data` | 资产负债表原结构加 `opening`；利润表 `current/ytd`；现金流原结构加 `ytd`；余额表 `period/lines/totals`；明细账见下。|

余额表每行有 `code/name/category/direction` 与 `opening_debit/opening_credit/period_debit/period_credit/ytd_debit/ytd_credit/closing_debit/closing_credit`。明细账为 `code/name/direction/period`、四口径 `{debit,credit}` 及 `items`；逐笔字段为 `entry_id/voucher_id/period/voucher_date/word/number/code/name/summary/debit/credit/balance`，按日期、凭证号、凭证 ID、分录顺序排序。

错误在生成文件前抛出，HTTP 返回结构化 JSON，不返回半成品附件：

| 错误码 | 含义 |
|---|---|
| `report_options_invalid` | 模块参数不是选项对象。|
| `account_set_not_found` | 账套不存在或 ID 非法。|
| `period_required` / `period_invalid` | 期间缺失或不符合合法 YYYY-MM。|
| `period_before_start` / `period_not_registered` | 早于启用期间 / 期间未登记。|
| `report_kind_unsupported` / `report_format_unsupported` | 报表类型 / 格式不支持。`report-export.mjs` 只接受 `format=csv`；`/export-data` 同样只接受 `csv`（其余 400），`/export` 由接线模块额外接受 `xlsx` / `pdf`。|
| `account_code_required` / `account_not_found` | 明细账科目缺失 / 不存在。|
| `report_data_invalid` | 账簿计算结果含非有限金额；拒绝输出 NaN、Infinity 或 JSON null 伪金额。|

## B0 独立金额样例

全部为合成资料，单位元。预期值直接按下列业务手算，测试不调用核心报表作为预期值生成器：

1. 2025-12 期初：银行父科目 1,000、银行子科目 200、固定资产 1,200，实收资本 2,400。12 月收现收入 300、支付管理费用 60，损益结转并年末转入未分配利润 240。
2. 2026-01：子科目收现收入 400；同一凭证借存货 120、固定资产 180，贷银行 300；支付管理费用 50；期初设备直线折旧 100（1,200 / 12，残值 0）。新增设备 180 未建卡，仅用于验证总账金额，不能据此推导其折旧已完整。
3. 2026-02：子科目收现收入 200、银行支付管理费用 20。本例只录入一月折旧，二月没有补计；这是已记账范围的报表样例，不是两个月资产计提完整性验收。

| 手算指标 | 2025-12 期末 | 2026-01 期末 | 2026-02 期末 |
|---|---:|---:|---:|
| 货币资金 | 1,440 | 1,490 | 1,670 |
| 固定资产净额 | 1,200 | 1,280 | 1,280 |
| 存货 | 0 | 120 | 120 |
| 资产 / 权益总额 | 2,640 | 2,890 | 3,070 |
| 当月净利润 | 240 | 250 | 180 |
| 当年累计净利润 | 240 | 250 | 430 |
| 当月经营现金净额 | 240 | 230 | 180 |
| 当月投资现金净额 | 0 | -180 | 0 |

二月银行父科目自身：期初借 890、本月贷 20、本年贷 370、期末借 870。子科目：期初借 600、本月借 200、本年借 600、期末借 800。父级明细账汇总两者，期初 1,490、当月借 200/贷 20、年累计借 600/贷 370、期末 1,670。所有关键数值同时验证 DTO 和下载 CSV，金额验证不止“下载 = 页面”。

## 已核实的核心边界与后续责任

| 事实与源码依据 | 本包处理 | 剩余工作 |
|---|---|---|
| `createAccountSet` 始终加载同一 `COA`，准则字段未切换科目表。| 输出登记准则并警告映射未核实。| RC-3 明确目标准则并验证相应科目、行次。|
| `balanceSheet` 按本地前缀归并，`incomeStatement` 按名称/前缀及其他收支兜底。| 复用算法，独立验证本例关键金额，不宣称完整官方映射。| RC-3 / B2 核对官方行次和全部目标业务。|
| `cashFlowStatement` 以现金净变动按对方科目绝对金额比例分摊。| 保留并显式警告；简单同向混合采购已独立验证。| 复杂双向混合凭证分类仍可能失真，即使总额勾稽通过。|
| 间接法末行直接使用直接法经营净额。| `indirectIndependent: false`，CSV 同样标明。| RC-3 实现、核验真正独立的间接法勾稽。|
| 建资产卡片不生成购买凭证，卡片与总账无自动一致性校验。| 验证建卡不增加总账资产、折旧过账/反过账影响恰为 100。| RC-3 补齐卡片与总账及连续期间计提完整性。|
| 缺少来源完整性/连续期间证明。| 保留 `unverified`，空账不会标“完整”。| RC-2 / RC-3 / RC-6 串接来源证据、完整性门槛和连续期间闭环。|

现金流反例：借银行 100、借固定资产 60、贷借款 160，原比例法可能把 100 分成投资流入 27.27、筹资流入 72.73。这种分配不能从混合凭证推导真实现金对应关系；测试只证明净变动为 100 并有显式警告，**不把该分类当正确会计结论**。缺口记录不是 RC-3 完成证据。

税局模板的官方来源、已核实的法定结构和未核实的真实上传格式单列在 [TAX-REPORT-FORMAT](TAX-REPORT-FORMAT.md)。B2 仍未完成；当前拒绝声称可申报的输出只是保护措施，不能代替合法成功路径和实际格式验证。

## 验证

在 `06-workbench` 运行 `node test/report-export.test.mjs`。该套 21 项测试在本轮 Subagent 自验全部通过；临时库通过 `WORKBENCH_DATA_DIR` 隔离，在退出时关闭并清理，不使用真实数据。涵盖跨月/跨年、父子科目、贷方余额、年中启用、已过账范围、年结/折旧、混合现金流、五类 CSV 金额、中文/公式防护、空账、异常请求、封账只读、账套隔离、失衡信号及非有限金额拒绝。完整回归和 HTTP 下载结果由管理者在待提交版本复验并登记 [交接](handoffs/RC-B-REPORTS.md)。

**2026-10-22 接线后的 HTTP 证据（独立审查，冻结 head `71894a1`）**：`node test/report-export-http.test.mjs` **31/31、exit 0**（原 `format=xlsx` 必 400 的失效断言已**替换**为真正不支持的 `yaml`，并新增 `/export-data` 严格 CSV 与 `/export` 真实 XLSX 两条回归）；`node test/report-office-http.test.mjs` **6/6、exit 0**（五类 × 三格式真实下载、XLSX 重开与独立手算金额、PDF 魔数 / 嵌入字体 / 文本 / 页数、失败无附件、下载后全库快照不变）。两者均为真实 `server.mjs` 子进程 + 临时合成库 + 随机回环端口。页面层由 root 在真实 IAB 分别选择三格式并点击，均显示“已生成并开始下载”；**未检查浏览器保存位置，也未新增 PDF 几何**（该轮几何仍只指模块轮 11 PDF）。**预整合与最终同步轮（精确 `a9fb`）**：已在末尾登记 `report-office-http` 后由管理者实跑全套 `npm test`：**56 / 56 套 exit 0**，含本文件相关套件 `report-export` 21/21、`report-export-http` 31/31、`report-office-http` 6/6、`office-export` 21/21（含 `pdfplumber geometry verified for 11 PDFs`）；PR #62 的最终独立审查与合并仍待。
