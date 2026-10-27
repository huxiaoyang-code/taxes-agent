# 旧账导入模式与内部格式

> 依据：`06-workbench/server/accounting.mjs`（`CSV_COLS`、`META_KEYS`、`parseImportTexts`、
> `validateImportPayload`、`importAccountSet`）、`server/import-incremental.mjs` 与 MCP `tools.mjs`。字段名以实际工具合同为准。

## 接手时选择模式

正常接手使用 `book_import_incremental`。以下是 Agent 编制的内部请求示意，不是客户模板；示例身份、期间、路径与 profile 必须换成已核事实。`paths` 是四 CSV 的本机绝对路径，也可选择 `payload`、`texts` 或 `files`；不要混用输入载体制造歧义。

```js
book_import_incremental({
  dryRun: true,
  enterprise: { enterpriseKey: "SYNTHETIC-INTAKE-A" },
  source: { system: "synthetic-legacy-export", enterpriseKey: "SYNTHETIC-INTAKE-A" },
  batchId: "synthetic-intake-a-2026-01-v1",
  mode: "create",
  profileId: "small-2011-basic-v1",
  paths: { meta: "C:/synthetic/meta.csv", accounts: "C:/synthetic/accounts.csv",
    openings: "C:/synthetic/openings.csv", vouchers: "C:/synthetic/vouchers.csv" }
})
```

- `enterprise` 与 `source.enterpriseKey` 一致；身份稳定，不用可变账套名称代替。profile 与已核会计制度一致，不能照抄示例。
- create 仅用于尚未绑定的企业。已有账套改用 `mode:"append"` 和实际 `accountSetId`；新来源绑定只在已核实并明确确认时提供 `confirmNewBinding:true`。不能新造企业身份或第二个账套消除冲突。
- 先预检，再以相同已核请求显式 `dryRun:false`；预检不写表。记录实际状态、错误、警告、计划及来源明细，正式写入仍会核对当前账库。
- `batchId` 标识本次业务导入，重试保持不变；同批内容/身份变化拒绝。跨批去重依赖稳定来源凭证身份，`payload.vouchers[].sourceVoucherId` 可显式保留旧系统标识；不能靠换来源或换批次绕过内容修订冲突。
- 正式导入后调用 `book_import_batch({batchId:"synthetic-intake-a-2026-01-v1"})` 查询原批次。来源凭证须仍存在、属于目标账套、已过账且内容一致；有冲突先调查，不能当成已去重完成。
- append 不提供覆盖既有期初/已关账期间的通道。需要更正时走已有业务更正、复核和期间处理，不直接改数据库。辅助核算按实际 `auxiliaryAppendix` 合同提供，不把四 CSV 当作所有资产/库存/税务明细的通用迁移格式。

兼容 `legacy_book_import` 的调用必须带显式 `enterprise`，例如 `legacy_book_import({enterprise:{enterpriseKey:"SYNTHETIC-INTAKE-A"},profileId:"small-2011-basic-v1",paths,dryRun:true})`，其中 paths 为实际四 CSV 路径对象。它返回原生 `{dryRun,validation,created}`，无增量批次重放；同企业已经绑定则拒绝新建。MCP 普通财务工具返回受控模型信封，不保证直接暴露原生对象，按实际信封和本机引用读取允许的结果。

下文说明共享的 CSV/旧账 payload 解析规则及 legacy 行为；增量导入另核来源、批次、既有账套和期间约束。

## 一、四张 CSV

| 逻辑名 | 说明 | 必需列（含可识别同义词） |
|---|---|---|
| `meta` | 账套信息（两列 `键,值`） | 账套名称 `账套名称/名称/name`；纳税人性质 `纳税人性质/纳税人类型/taxpayer_type`；会计准则 `会计准则/accounting_standard`；启用期间 `启用期间/start_period` |
| `accounts` | 科目 | 科目编码 `科目编码/科目代码/编码/code`；科目名称 `科目名称/名称/name`；类别 `类别/科目类别/category`；方向 `方向/余额方向/direction` |
| `openings` | 期初余额 | 科目编码 `科目编码/科目代码/编码/code`；借方 `借方/期初借方/借方余额/debit`；贷方 `贷方/期初贷方/贷方余额/credit` |
| `vouchers` | 历史凭证分录 | 期间 `期间/会计期间/period`；日期 `日期/凭证日期/date`；字号 `字号/凭证字/word`；凭证号 `凭证号/号码/number`；摘要 `摘要/summary`；科目编码 `科目编码/科目代码/code`；借方 `借方/借方金额/debit`；贷方 `贷方/贷方金额/credit` |

- 编码：UTF-8（自动去 BOM）；GBK 需在导入时声明 `encoding: "gbk"`。
- 位置：命中 ≥2 个已知列名时按表头定位，否则按上述固定列序解析（第 1 行即数据）。
- 日期：`YYYY-MM-DD` 真实日历日，或留空（落库时取 `期间-01`）；`2026/01/10`、`2026-02-30` 被拒绝；
  同一张凭证的**每一行**原始日期都会被校验，同凭证内日期不一致会报错（不会只保留首行而漏掉后续行）；
  解析器保留逐行 `dates` 辅助字段，但 `date` 本体始终校验，`dates` 不得覆盖/替代 `date`（二者不一致即报错）。
  日期与期间不在同一月份时给 `warnings` 提示但仍允许导入。
- 凭证号：**CSV 缺省（空白单元格）保持原契约默认 `1`**；**JSON / 已解析对象省略 `number` 时导入自动取号（`nextNumber`，取该期间该字号现有最大号 +1）**——两者不是同一种缺省，文档不得统称“默认 1”。显式编号必须是安全正整数，`1oops`/`0`/`-1`/`1.5`/`1e3` 被拒绝（不再被 `parseInt` 吞掉）。
  解析器保留 `numberRaw` 辅助字段，但 `number` 与 `numberRaw` 各自严格校验，两者同时存在时必须一致，辅助字段不得掩盖另一字段的错误。
- 金额：支持千分位与 `¥`/`￥` 前缀；**非法金额文本会被严格拒绝**，不再按 0 静默处理。
  允许的写法：有限数字（JSON）、或可带前导 `¥`/`￥`、正负号、千分位与小数的十进制文本
  （如 `1000`、`1,000.50`、`¥2,000`、`-0`）；**空白/缺失按 0 处理**。
  只允许 `number`/`string`/`null`/`undefined`，数组（如 `[100]`）、对象、布尔一律拒绝。
  拒绝：垃圾文本（`abc`）、部分可解析文本（`100元`、`12abc`、`1.2.3`、`1 000`）、
  `NaN`/`Infinity`、超出 `±999999999999.99` 的金额。**负号与超界都在四舍五入之前判定**：
  `-0.001` 不会因舍入成 `-0` 而漏过，`999999999999.994` 不会因舍入进界内被接受。金额按四舍五入保留 2 位小数后写入。

- 方向：`借/借方/debit/d` → `debit`；`贷/贷方/credit/c` → `credit`。
- 类别只能是 `资产/负债/权益/成本/损益`。

以上空日期、空金额和编号默认属于解析兼容，不是业务证据。接手时核实空白确实表示无该方向金额，未知金额不得当零；缺实际业务日期不能利用月初默认补齐。保留原件和未决事项，补件或修正有依据的派生输入后再预检。

## 二、预检（dryRun）会检查什么

`validateImportPayload`（内部走 `normalizeImportPayload`）返回 `{ ok, errors, warnings, summary }`：

- 账套名称非空；启用期间匹配 `YYYY-MM` 且月份 `01-12`；
  `name`/`taxpayer_type`/`accounting_standard`/`start_period` 类型会被核对，对象/数组不会被 `String()` 成垃圾后写入 SQLite。
- 每个科目有编码与名称；方向/类别合法；重复标准科目给出 `warnings`（保留标准科目名称）；
  **新增**科目必须提供合法方向与类别（标准科目会被跳过，不强制这两列以兼容历史输入）。
- 期初余额科目存在；金额为合法有限数字、不得为负、单行不得同时填借贷；**同一科目重复出现直接报错**（数据库按期初科目覆盖写入，汇总与覆盖语义不同）；
  **单行两列都为 0 是允许的**；借方合计 = 贷方合计。
- 凭证期间为合法 `YYYY-MM` 且不早于启用期间；日期为合法 `YYYY-MM-DD` 或留空，同一凭证每一行日期都会被校验且不一致会报错；
  凭证号：CSV 空白缺省为 `1`，JSON / 对象省略 `number` 则导入自动取号，显式则必须为安全正整数；每张凭证至少两条分录；分录科目存在；金额合法、不得为负、单行不得同时填借贷、**单行分录两列都为 0 会被拒绝**（与期初不同）；整体借贷平衡。
- 形状：`account_set` 必须是对象，`accounts`/`opening_balances`/`vouchers` 必须是数组且元素为对象，`entries` 必须是对象数组；
  集合缺失（`undefined`/`null`）按空处理，显式错误类型必须报错，不会被静默丢弃。
- 金额文本非法（垃圾/部分可解析/`NaN`/`Infinity`/超界/极小负值）直接报错，不再按 0 吞掉。
- `summary` 统计账套名、启用期间、科目数、期初条数、凭证数、分录数。

错误带上下文（第几行 / 第几张凭证 / 第几条分录 / 哪个字段）。预检失败时 `importAccountSet` 不落库（`dryRun` 语义），错误逐条列出，不要忽略。

预检与正式写入复用静态校验；预检本身只读。企业身份、既有凭证和期间状态仍可能在两次调用之间变化，正式写入须重新核对；预检通过不等于业务已确认或保证未来写入成功。

## 三、legacy 正式导入行为

- 只有显式 `dryRun=false` 才落库；落库在单个事务内完成，失败回滚。
- 正式写入使用预检同一套归一化结果（金额 2 位小数、日期归一化），预检通过后不会因同一静态约束再失败。
- 已存在于标准科目表的科目跳过，不覆盖；仅新增缺失科目。
- 期初余额整体写入；历史凭证按 `期间|字号|凭证号` 分组，每条凭证作为一张已过账凭证导入
  （`kind='normal'`、`status='posted'`）。
- 只新建尚未绑定企业的账套，不追加到已有账套；同一企业重复新建返回身份冲突。没有 `book_import_incremental` 的稳定批次重放与来源凭证去重，不把拒绝重复建账等同于可恢复的批次结果。

## 四、示例数据集（仓库内可复现）

`05-reconstruction/examples/legacy-book/`（4 张 CSV，独立编造、不含真实企业信息）：

- `meta.csv`：账套名称 `逆演示贸易有限公司`，小规模纳税人，小企业会计准则，启用期间 `2026-01`。
- `accounts.csv`：1002 银行存款、1122 应收账款、1405 库存商品、2221 应交税费、3001 实收资本、
  5001 主营业务收入、5401 主营业务成本（均已在标准科目表中）。
- `openings.csv`：借 1002 120000、1122 11300、1405 50000；贷 2221 1300、3001 180000（借=贷=181300）。
- `vouchers.csv`：2 张凭证——销售商品（借 1122 11300 / 贷 5001 10000、2221 1300）、
  结转成本（借 5401 6000 / 贷 1405 6000）。

导入后（2026-01）可核对：资产总计 186600、负债合计 2600、所有者权益合计 184000，
净利润 4000，试算借=贷=192600。可用 `node 05-reconstruction/codex/mcp/finance-mcp/workflow-test.mjs`
做端到端复现（临时后端 + stdio MCP，不触碰工程 `data/`）。

## 五、失败与重试

- 预检失败：按实际错误定位行/字段，核对原件，修正派生 CSV/JSON 或补件后重新预检；保留原件与旧版本，不跳过错误。
- 非法金额/非法日期直接报错；空白仍有上述兼容默认，须在接手核验中识别，不能借此掩盖未知事实。
- 正式导入失败：先在 `account_context` 查询是否已创建账套，用 `finance_query` 核对已落库内容；
  增量入口另查原 `book_import_batch`。未知结果不能换企业/来源/批次盲重试；legacy 没有批次重放，查明结果后再决定后续动作。
- legacy 原生 `created` 是本次新账套；增量结果按其实际返回和批次查询确定。重新发现真实目标绑定，不猜后续 `accountSetId`。

## 六、不做

- 不自动推断任意 Excel 账表结构，不做列语义映射之外的猜测，不做金蝶/用友模板适配。
- 不通过未实现的 `exec` 解析 Excel；宿主可用 `tools/xlsx-to-csv.py` 或其他实际可用工具转换并核验，保留未识别内容。
- 不使用原站附件上传流程；增量去重仅限实际来源/内容/当前凭证校验范围，不承诺自动识别跨来源的同一经济业务。
