# 增量导入契约 · LOCAL-IMPORT（LOCAL-01 交付）

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

## LOCAL-01 历史验收与基础协议

状态：**已验收合并**。基线 `0c4e0dd622fc35bcb5d6e6af3620c6f971b2a805`，已审 head `e12e71eb29dd5fc480aeebe5f0baace94bc3a4d7`，[PR #46](https://github.com/huxiaoyang-code/youshu-fork/pull/46) 已实际 MERGED，merge `1a15bcce3bf3b1f0d390746d85be7cfd1ace7ea3`（北京时间 2026-10-22 17:13:24）。
契约范围：领域 / HTTP / Agent / MCP 入口、冲突码、持久化 schema **v3**、迁移前备份与回退口径。
基线：`0c4e0dd622fc35bcb5d6e6af3620c6f971b2a805`。任务单：[tasks/LOCAL-01](tasks/LOCAL-01.md) · 交接：[handoffs/LOCAL-01](handoffs/LOCAL-01.md)。

## 1. 为什么需要这一层

旧导入入口（`accounting.mjs` 的 `importAccountSet`、HTTP `/api/import/account-set`、Agent `legacy_book_import`、
MCP `legacy_book_import`）在 LOCAL-01 之前**总是新建账套**，没有稳定来源身份、没有批次、没有跨批去重：

- 同一份旧账重跑一次就多一个账套；
- 连续两个月只能建成两个互不相关的账套，无法接续出表；
- 同一张来源凭证被重复导入时无法识别，改了内容也无法与「另一张凭证」区分。

LOCAL-01 当时在不改变旧入口行为的前提下新增；本轮 LOCAL-01B / 03 将显式企业身份统一到所有创建入口。增量入口提供**有身份、可幂等、可追踪**的增量导入。

## 2. 产品身份口径（2026-10-22 用户澄清，覆盖旧表述）

- **一家企业只需要一个账套**；多企业批量处理 = 多个账套。批量 ≠ 多租户，产品仍是本机单用户。
- 企业身份来自调用方**显式、稳定的 canonical `source.enterpriseKey`**（如统一社会信用代码），
  **不用账套显示名称猜认**，也不按 `source.system` 各自成户。
- 同一 `enterpriseKey` 即使来自**另一个 `source.system`**，也必须**引导到已有账套**（只新增来源证据），
  **不得新建第二本**；同一账套也**不得再绑定另一家企业**。
- **不做一企多账簿 / `bookKey` 设计**（该方向已撤回、从未实施）。
- **不擅自合并已有库、不删除重复旧账套、不自动重命名**；历史遗留的重复账套需人工处理，导入层只保证新写入不产生第二本。
- 本候选不再允许无企业 ID 的新创建 / 首次导入；历史遗留未绑定账套保持可读，显式确认关联前**不得把未识别当作已验证唯一**。

## 3. 三种用法必须区分清楚

| 用法 | 入口 | 语义 | 身份记录 |
|---|---|---|---|
| 首次创建（legacy 格式，无批次） | `importAccountSet(payload, {dryRun, enterprise, profileId})`、`POST /api/import/account-set`、`legacy_book_import` | 显式 enterprise，原子创建并绑定；同企业再次创建拒绝 | 写 canonical 企业绑定，无增量批次 |
| 有企业 / 批次的首次创建 | `mode=create`（缺省） | 建账套 + 绑定规范企业身份 + 记录批次与逐张来源凭证；同企业已存在账套时**拒绝并引导追加** | 写 |
| 指定已有账套追加 | `mode=append` + `accountSetId` | 向**同一企业身份**的账套追加科目 / 期初 / 凭证，不重建账套 | 写 |

旧入口**新增 enterprise / profileId envelope 参数，返回结构保持**（`{dryRun, validation, created}`，域层缺省 `dryRun=false`，
HTTP / Agent / MCP 入口缺省 `dryRun=true`）。增量入口仍为独立函数 / 路由 / 工具；本候选收紧旧创建的企业身份输入要求，不改变 dryRun 缺省与返回形状。

## 4. 身份模型

| 概念 | 字段 / 表 | 规则 |
|---|---|---|
| 规范化企业身份 | `source.enterpriseKey` → `import_enterprise_account_sets.enterprise_key`（PK） | 稳定规范标识（如统一社会信用代码，≤128 字符）。服务端只做 Unicode NFKC + trim，**不做大小写 / 名称猜测**，调用方须提供规范形式；显式稳定 ID 的文本可以碰巧等于账套名称；禁止由产品从名称派生身份，不按文本相等拒绝。 |
| 企业 ↔ 账套 | `import_enterprise_account_sets.account_set_id`（UNIQUE） | 数据库级保证：**一家企业只有一个账套，一个账套只属一家企业**。 |
| 来源系统 | `source.system` | 来源标识（≤64 字符）；同企业可来自多个来源，但只新增来源证据，不改变账套归属。 |
| 来源证据 | `import_source_bindings (source_system, enterprise_key)`（UNIQUE） | 某来源已显式登记过该企业；新增来源需显式确认，且企业身份必须与账套既有绑定一致。 |
| 企业名称 | `source.enterpriseName` | 仅展示 / 留痕，不参与身份判定；不自动改名。 |
| 批次 | `batchId` | 调用方提供的稳定批次 ID（`^[A-Za-z0-9][A-Za-z0-9._:-]*$`，≤128）。 |
| 来源凭证 | `vouchers[i].sourceVoucherId` | 来源侧稳定凭证 ID（≤128）。**不得**用 `derived:` 前缀。缺省时按业务凭证字号推导为 `derived:<期间>/<字号>/<凭证号>`；无凭证号又无显式 ID 时拒绝。 |
| 来源内容指纹 | 服务端计算 | `sha256(canonical JSON)`，金额 2 位小数；凭证指纹含期间 / 日期 / 字号 / 编号 / 摘要 / 分录；批次指纹含模式 + 目标账套 + 来源 + 账套信息 + 科目 + 期初 + 所有来源凭证指纹（按来源凭证 ID 排序）。 |
| 落库后指纹 | `import_voucher_sources.voucher_fingerprint` | 用**数据库里的实际凭证**（含自动分配凭证号 / 分录摘要默认值）计算，用于核验来源登记与当前凭证是否仍是同一张。 |
| 批次逐张关联 | `import_batch_vouchers` | 每批处理了哪些来源凭证、各自是 `created` 还是 `deduplicated`；去重命中项也按批次留痕，但只存关联，不复制来源凭证 / 凭证。 |

自动取号凭证（`number` 缺省）在来源内容指纹中 `number` 记为 `null`，因此同批重试不会因自动编号变化被误判为「内容修订」。
自动取号的实际号码在**计划阶段统一预分配**（见 §7 第 1 条），预检的 `planned.voucherNumbers` 就是正式写入的号码。

## 5. 请求 DTO

```json
{
  "dryRun": true,
  "batchId": "2026-01-batch-1",
  "source": { "system": "local-book", "enterpriseKey": "91350000...", "enterpriseName": "示例公司" },
  "mode": "create",
  "accountSetId": null,
  "confirmNewBinding": false,
  "payload": {
    "account_set": { "name": "示例公司", "taxpayer_type": "小规模纳税人",
                     "accounting_standard": "小企业会计准则", "start_period": "2026-01" },
    "accounts": [{ "code": "5602", "name": "管理费用", "category": "损益", "direction": "debit" }],
    "opening_balances": [{ "code": "1002", "debit": 100000, "credit": 0 }],
    "vouchers": [{
      "period": "2026-01", "date": "2026-01-10", "word": "记", "number": 1,
      "summary": "销售商品", "sourceVoucherId": "SRC-0001",
      "entries": [{ "code": "1122", "debit": 11300, "credit": 0 },
                  { "code": "5001", "debit": 0, "credit": 10000 },
                  { "code": "2221", "debit": 0, "credit": 1300 }]
    }]
  }
}
```

- `dryRun` 缺省 **true**：只预检，连审计表都不写。
- `mode` 缺省：给了 `accountSetId` 就是 `append`，否则 `create`；两者矛盾时报错，不猜。
- HTTP / Agent 入口也接受 `texts`（CSV 文本）/ `files`（CSV base64，配 `encoding`）/ `meta`，与旧入口一致；
  MCP 只公布 `payload` / `texts` / `files` / `encoding` / `meta`（`paths` 只属旧工具）。
- **严格校验不降低**：金额 / 日期 / 科目 / 借贷平衡一律先走 `accounting.mjs` 的 `normalizeImportPayload`，
  增量层只加「增量语义」校验，不放松任何一条既有规则。

## 6. 响应 DTO

```json
{
  "ok": true,
  "status": "preview | applied | idempotent_replay | rejected | conflict",
  "dryRun": true,
  "mode": "append",
  "batchId": "2026-02-batch-1",
  "source": { "system": "...", "enterpriseKey": "...", "enterpriseName": "..." },
  "accountSetId": 1,
  "validation": { "ok": true, "errors": [], "warnings": [], "summary": { "...": "..." } },
  "conflicts": [{ "code": "source_voucher_voucher_unposted", "message": "...", "sourceVoucherId": "SRC-0001" }],
  "errors": [],
  "notes": ["..."],
  "planned": {
    "accountSetCreated": false, "accountSetId": 1, "bindingAction": "existing",
    "accountsToAdd": [], "openingBalances": 0,
    "vouchersToCreate": ["SRC-0002"], "vouchersDeduplicated": [],
    "voucherNumbers": [{ "sourceVoucherId": "SRC-0002", "period": "2026-02", "word": "记",
                         "action": "create", "number": 3, "autoNumbered": false }]
  },
  "created": {
    "accountSetId": 1, "accountSetCreated": false, "accountsAdded": 0,
    "openingBalancesApplied": 0, "vouchersCreated": 1, "vouchersDeduplicated": 0
  },
  "batch": { "id": "...", "status": "completed", "contentFingerprint": "<64 hex>", "attempts": 1 },
  "replayed": false,
  "sourceTrace": [{ "sourceVoucherId": "SRC-0001", "voucherId": 1, "accountSetId": 1,
                    "contentFingerprint": "<64 hex>", "action": "created",
                    "status": "created", "state": "ok" }]
}
```

`status` 与 HTTP 状态：

| status | 含义 | HTTP | Agent / MCP |
|---|---|---|---|
| `preview` | 预检通过，未写入 | 200 | 正常返回 |
| `applied` | 已在一个事务内落库 | 201 | 正常返回 |
| `idempotent_replay` | 已完成批次的同批重试，回放既有结果 | 200 | 正常返回 |
| `rejected` | 参数 / 严格校验失败，未写入 | 400 | `import_validation_failed`（isError） |
| `conflict` | 身份 / 去重 / 修订 / 凭证状态 / 封账 / 期初等**结构化冲突**，未写入 | 409 | `import_conflict`（isError，`details.conflicts` 保留结构化冲突） |

`sourceTrace[].state`：`ok` / `missing`（凭证已删除）/ `unposted`（已反过账）/ `modified`（内容被改动）/
`other_account_set` / `unverified`（历史登记缺少落库指纹）；非 `ok` 时 `status` 记为 `inconsistent`。
`sourceTrace` 的逐张 DTO 在实际执行（`applied`）、批次查询与同批回放中**使用同一组字段语义**——
`sourceVoucherId` / `voucherId` / `accountSetId` / `contentFingerprint` / `action` / `status` / `state`；
其中 `action` 是该来源凭证在**本批次**的处理方式（`created` / `deduplicated`），`status` 在 `state=ok` 时为同一动作，
非 `ok` 时为 `inconsistent`。预检 `preview` 尚未落库，另用计划语义（`status=would_create`、`action=create`），
不与实际执行的持久 DTO 混同。`voucherCount` 是该批次的逐张来源凭证数（含去重命中项，纯去重批次不会是 0）。

## 7. 幂等 / 去重 / 冲突规则

1. **同批重试**：`batchId` 与内容指纹一致且该批已完成 → `idempotent_replay`，不新增账套 / 科目 / 期初 / 凭证。
   重启（新进程）后同样识别，因为批次、逐张来源记录与批次逐张关联都持久在库里。
   - **期初回放核验覆盖 create / append**：同批回放不再套用「不得覆盖既有期初」，因为该期初正是本批首次写入的；
     但回放前会按批次记录的 `account_set_id` 核对库内**实际期初**与本批请求逐科目一致（多出 / 缺少 / 金额不同都拒绝，
     报 `batch_replay_state_incomplete`（`reason=opening_balances_mismatch`）；账套不可读时 `reason=account_set_missing`）。
     `create` 首次正式执行仍合法：它是新建账套，不受「既有期初」保护限制；只有已完成批次的回放才核验真实值。
     **没有期初的批次不进入期初核验**：不能凭空要求后期从未导入过的字段快照。换一个批次改期初仍是真正的期初覆盖，按第 11 条拒绝。
   - **自动取号同样幂等**：自动取号凭证的号码在计划阶段确定，来源内容指纹仍记 `number: null`，
     因此同批重试不会因号码差异被误判为修订。
   - **批次逐张追踪**：每批的 `created` / `deduplicated` 逐张关联持久在 `import_batch_vouchers`；
     实际执行、批次查询与同批回放返回同一份关联与同一组 DTO 字段（含 `action` / `state`），并指向既有来源凭证 / 既有凭证（不伪造第二张）；
     查询 / 回放的 `state` 始终是**当前**凭证核验结果。
2. **同批 ID、内容变化** → `batch_content_changed`（结构化冲突，绝不覆盖）。同批 ID 换来源 / 企业 / 模式 / 账套
   分别报 `batch_identity_mismatch` / `batch_mode_mismatch` / `batch_account_set_mismatch`。
3. **跨批相同来源凭证**：内容指纹一致 → 去重跳过（`vouchersDeduplicated`，同时按本批写入 `deduplicated` 关联）；
   指纹不同 → `source_voucher_content_changed`。
3a. **自动取号与显式编号混用**：按（期间, 字号）分组统一预分配，起点为既有账套该组最大号 + 1，
   并跳过本批所有显式号与已分配号。因此反序、多个自动号、已存在号、不同字号 / 期间、事务失败重试都得到确定性号码，
   同期间同字号不会出现两张同号凭证；预检的 `planned.voucherNumbers` 与正式写入一致。
4. **来源凭证状态核验（不按来源指纹伪报完成）**：去重 / 回放前核验当前本机凭证仍存在、仍属该账套、仍为 `posted`、
   落库后指纹未变；分别报 `source_voucher_voucher_missing` / `source_voucher_account_set_mismatch` /
   `source_voucher_voucher_unposted` / `source_voucher_voucher_modified` / `source_voucher_trace_unverified`。
5. **删除凭证不破坏来源关联**：`import_voucher_sources.voucher_id` 不再随凭证删除级联清除，
   登记保留（指向被删凭证 ID）。删除后重试**不会静默重新入账**，而是要求人工核对来源关联。
6. **本批自身重复**：同一 `sourceVoucherId` 出现两次 → `source_voucher_duplicate_in_batch`；
   同一 `期间 + 字号 + 凭证号` 出现两次 → `voucher_number_duplicate_in_batch`。
7. **业务凭证字号冲突**：目标账套里已有同 `期间 + 字号 + 凭证号` 的凭证 → `voucher_number_conflict`。
8. **一企一账套**：
   - `create` 时该规范企业已有账套 → `enterprise_already_bound`（带 `accountSetId` / `boundSources` / `guidance=mode=append`），**不新建第二本**；
   - `append` 时该企业已绑别的账套 → `enterprise_bound_to_other_account_set`；
   - `append` 时该账套已属别的企业 → `account_set_bound_to_other_enterprise`；
   - 该账套属同一企业但当前来源尚未登记 → `account_set_binding_confirmation_required`（显式 `confirmNewBinding=true` 且身份一致才新增来源证据）；
   - 显式稳定企业 ID 即使文本等于账套名仍合法；缺少身份时拒绝，不从名称推导。
9. **科目不兼容**：`account_incompatible`（与账套既有科目的类别或方向不一致）；真正新增明细按实际 profile 同源语义预检，错误类别 / 方向为 `account_semantics_conflict`，预检与正式均零写入。
10. **已封账期间**：`period_closed`（去重命中的凭证不写入，因此不受封账影响）。
11. **期初覆盖**：`opening_balance_overwrite_refused` / `opening_rewrite_after_posting` / `opening_rewrite_period_closed`。
12. **账套属性冲突**：`account_set_start_period_mismatch`、`accounting_standard_mismatch`。
13. **完成的批次但库内登记不一致**：`batch_replay_state_incomplete`（缺来源登记 / 缺企业绑定 / 账套不可读 / 实际期初与本批不一致，要求人工核对，不猜）。
14. **已完成批次不被失败审计覆写**：`markBatchFailed` 的更新带 `status <> 'completed'` 条件，事务失败路径也会跳过已完成批次。

## 8. 已有账套的来源绑定必须明确且可验证

- `import_enterprise_account_sets`：`enterprise_key` 主键 + `account_set_id` UNIQUE。
  因此**同企业不会再建第二本**、**同一账套也不会再绑另一企业**。
- `import_source_bindings`：`UNIQUE(source_system, enterprise_key)`；同企业可来自多个来源，但都指向同一规范账套。
- `create` 时写入「规范企业 → 新账套」与第一条来源证据。
- `append` 时：
  1. 该来源已登记该企业 → 直接使用；
  2. 该企业已绑别的账套 → 拒绝并引导到已有账套；
  3. 该账套已属别的企业 → 拒绝；
  4. 该账套属同一企业、但本来源未登记 → 需显式 `confirmNewBinding=true`，写入 `bound_by='append_confirm'` 的来源证据；
  5. 该账套尚无企业绑定（历史旧入口建的账套）→ 同样需显式确认，确认后写入规范绑定（身份从此可核验）。

## 9. 持久化、迁移前备份与回退

新增 / 变更表（`06-workbench/server/import-storage.mjs`，schema 版本 **3**）:

| 表 | 作用 |
|---|---|
| `schema_migrations` | 最小迁移记录（版本 / 时间 / 说明） |
| `schema_backups` | 迁移前备份记录（版本 / 路径 / 字节 / 完整性 / 说明） |
| `import_enterprise_account_sets` | 规范企业身份 → 唯一账套（一企一账套、一账套一企业） |
| `import_source_bindings` | 来源证据：某来源已登记过该企业（可多条，但同属一个账套） |
| `import_batches` | 批次结果（内容指纹 / 状态 / 尝试次数 / 结果摘要 / 错误） |
| `import_voucher_sources` | 逐张来源凭证追踪（跨批去重、修订判定与当前凭证状态核验） |
| `import_batch_vouchers` | 批次 → 逐张来源凭证关联（`created` / `deduplicated`），支撑批次查询与回放的逐张追踪（v3 新增，历史批次自动回填） |

- **备份在新增结构之前**：先 `VACUUM INTO` 生成单文件一致快照（包含 WAL 中尚未 checkpoint 的已提交数据），
  再用独立只读连接执行 `PRAGMA integrity_check` 并确认能读到既有业务表；验证不通过则抛
  `migration_backup_invalid` 并**拒绝迁移**。备份文件保持**迁移前结构**（不含 `schema_migrations` / `schema_backups` / 导入新表）。
- **新增结构在备份之后的迁移事务内**：`schema_migrations` / `schema_backups` 的建立、备份记录写入、
  新表 DDL、v1→v2 与 v2→v3 数据回填、版本记录写入全部在同一个 `BEGIN IMMEDIATE … COMMIT` 内；
  任一步失败即 `ROLLBACK`，原库 schema、业务数据与版本记录都不变，错误以 `migration_failed`
  （带 `details.backupPath`）抛出。
- **每次真正升级都重新备份**：不再复用「文件存在且 size>0」的旧快照（旧实现在原库又提交新业务后会复用过期快照）。
  迁移失败后重试会重新备份，且新备份包含失败后新增的已提交业务；成功启动且版本已达目标时直接返回，**不重复备份**。
  失败尝试留下的备份文件作为孤儿保留但不登记。
- **候选库兼容（v1 → v2 → v3）**：v1 的按来源绑定会回填成规范企业映射，历史来源登记会回填落库后指纹；
  v2 的历史来源登记会回填成「批次 → 逐张来源凭证」关联（历史批次按 `created`）。
  回填时若发现旧数据自相矛盾（同企业绑多账套 / 同账套绑多企业），迁移**失败并保留原库**，
  由人工核对，**不自动合并 / 删除 / 重命名**。
- **回退方式**（文档化，最小）：
  1. **先保护现库**：停后端进程（本机单用户，无并发写入），并另行复制一份当前库文件留档；
  2. 把 `schema_backups` 记录里的备份文件复制回 `workbench.db` 位置（备份是自包含单文件，不依赖原 `-wal`）；
  3. 删除残留的 `workbench.db-wal` / `workbench.db-shm`；
  4. 重新启动后端：`schema_migrations` 中无目标版本记录 → 会重新走一次迁移（并再取一次备份）；
  5. **恢复后核对**：业务表、导入批次 / 来源登记、报表金额都要逐项核对。
  **回退不是无损的**：恢复会把整个库带回**备份（快照）时点**，备份时点之后新增 / 修改的业务会丢失。
  本包的备份只是**迁移前最小条件 + 回退手段**，不提供运行中增量恢复或真实业务库备份恢复；
  完整的业务备份 / 恢复与恢复前保护属 **LOCAL-06**，不能用本包最小工具冒充 LOCAL-06 已完成。
- 本包的迁移是**纯新增表 + 导入自用表重建**，不改既有业务列；`vouchers.kind` 的历史补列逻辑保持原样。

## 10. 事务与审计边界

- `create` / `append` 的落库在**一个事务**内完成：企业绑定 + 来源证据 + 批次 + 科目 + 期初 + 期间 + 凭证 + 逐张来源记录。
  中途任一步失败 → 整体 `ROLLBACK`，业务状态不变；随后单独写一条 `status='failed'` 的批次审计
  （不含业务状态），并**重新抛出原始错误**，不吞错当成功。已完成批次不会被这条失败审计覆写。
- 批次结果与逐张来源追踪可通过 `GET /api/import/batches/<batchId>`、Agent / MCP `book_import_batch` 只读核对，
  返回的 `state` 是**当前**凭证核验结果，不只是历史登记；`action` / `voucherCount` 来自持久批次关联，
  包含去重命中项，与同批回放一致。
- 完整审计 / 变更留痕 / 备份恢复体系属 **LOCAL-06**，本包只做导入所需的最小记录。

## 11. 入口清单

| 层 | 入口 |
|---|---|
| 领域 | `importIncremental(options)`、`getImportBatch(batchId)`（`06-workbench/server/import-incremental.mjs`） |
| HTTP | `POST /api/import/incremental`、`GET /api/import/batches/<batchId>` |
| Agent | `book_import_incremental`、`book_import_batch` |
| MCP | `book_import_incremental`、`book_import_batch`（`origin: local`，schema 严格，不本地伪造执行） |
| 旧入口（不变） | `importAccountSet`、`POST /api/import/account-set`、`legacy_book_import` |

## 12. 下游契约（供后续包消费）

- **LOCAL-02 / LOCAL-03**：追加必须走 `mode=append` + `accountSetId`；每月一个 `batchId`；
  来源凭证 ID 使用来源侧稳定 ID（不要用 `derived:` 前缀）；一家企业只对应一个账套，多企业批量 = 多个账套。
- **LOCAL-06**：可复用 `import_batches`、`import_voucher_sources`（含落库指纹与当前状态核验）、
  `import_batch_vouchers`（逐张批次关联）、`import_enterprise_account_sets` / `import_source_bindings`、
  `schema_migrations` / `schema_backups` 作为审计与恢复的输入；本包不替代完整审计，也不提供业务数据恢复。
- 报表侧无需改动：导入的凭证与旧导入一致，`status='posted'`、`kind='normal'`，
  因此余额 / 试算 / 三表口径完全复用现有 `accounting.mjs`。

## 13. 已登记限制（不隐瞒）

1. **追加时必须重复声明账套自定义科目**：`normalizeImportPayload` 以「标准科目表 ∪ payload 声明的科目」判定科目是否存在，
   因此向带自定义科目的账套追加、且凭证引用这些科目时，需要在 `payload.accounts` 重复声明（类别 / 方向必须一致）。
   本包选择**不修改**该共享严格校验函数，避免降低既有规则。
2. **自动取号凭证需要显式 `sourceVoucherId`**：没有稳定来源 ID 就无法做跨批去重与修订判定，直接拒绝而不是猜。
   自动取号的**号码**在计划阶段预分配，不会产生同字号重号；但自动号不是来源身份，两者不可互相替代。
3. **旧无企业 ID 的导入入口不提供身份认定**：它建出的账套在显式绑定前无法自动认定企业身份；
   首次绑定需 `mode=append` + `confirmNewBinding=true`，之后才可核验唯一性。未识别不等于已验证唯一。
4. **不自动处理历史重复账套**：若本机已存在「同一企业多本账套」的历史数据，本包不合并 / 不删除 / 不重命名；
   迁移遇到自相矛盾的 v1 绑定会失败并要求人工核对。
5. **删除本机凭证后来源关联被保留**：重试会给 `source_voucher_voucher_missing` 冲突；
   本包不提供「解除来源关联后重新入账」的自动操作，需人工核对（完整审计 / 恢复归 LOCAL-06）。
6. **跨来源同一企业共用同一账套时，来源凭证 ID 按来源系统命名空间隔离**：不同来源的同号业务凭证仍需来源侧提供
   稳定 ID；若业务凭证字号（期间 + 字号 + 号码）已被占用，会返回 `voucher_number_conflict` 而不是覆盖。
7. **批次审计随账套删除级联删除**（`ON DELETE CASCADE`），完整留存策略属 LOCAL-06。
8. **未实现**：批次取消 / 回滚单个批次、跨账套批量编排、导入进度推送、Excel / 税局格式（属后续包）。
9. 本包不接税局、不读真实账套库、不修改报表与税局代码；真实接入数仍为 0。
10. **不做一企多账簿 / `bookKey`**；一家企业一个账套是本产品的明确口径，不是临时实现细节。
