# OFFLINE-03B：已有账套单笔正式过账

本片把已接收原件重新计算的三类候选，逐业务接入现有公开增量导入和持久审计。只支持 `small-2011-basic-v1` 既有企业账套：未结算普通主营服务销售、当月行政服务采购未付、期末未来服务合同预付。它是准备→显式确认→单业务执行→重启查询；未实现多笔自动流水线、结转结账、税务执行、自动更正、企业新建/改绑、MCP 或客户消息。所有返回 `periodComplete=false`、`submittable=false`；#80 整项仍未完成。

本片规则仍是工程支持范围，#77 会计审定生产黄金未完成。客户提供原始发票、银行及事实依据，不提供科目、借贷金额、candidate、ready、执行回执；命令严格拒绝额外字段。旧候选上的 `authorizesExecution=false` 等字段仍保持其原意，正式授权来自本桥操作者确认。

## 输入与命令

cwd `06-workbench`：

```text
node scripts/offline-posting.mjs --input <posting-request.json> --output <NEW-result.json>
```

```json
{
  "version": "offline-posting-input/1",
  "command": "prepare",
  "inputPath": "action-input.json",
  "target": {
    "dbPath": "D:\\synthetic-example\\data\\workbench.db",
    "databaseInstanceId": "实际audit2活动实例ID",
    "accountSetId": 1,
    "enterpriseKey": "实际规范企业身份"
  },
  "selected": {
    "taskId": "prepare:invoice:后接实际64位业务hash",
    "businessKey": "invoice:后接实际64位业务hash"
  }
}
```

示例中的中文占位符必须替换成 `offline-action-plan` 从真实本机原件得出的选择。`businessKey` 仅允许既有 `invoice:<64hex>` 或 `prepayment:<64hex>`；`taskId` 必须恰为 `prepare:${businessKey}`。`inputPath` 在 CLI 中相对命令 JSON 所在目录解析；直接 API 要求调用方给出明确文件路径。DB 必须是绝对规范路径、已存在的 `workbench.db`；目录链接、junction、硬链接、缺库、零字节库均拒绝，不创建默认数据目录或账套。

`query` 使用相同字段、只把 command 改为 query；不接受 confirmation。`execute` 另加：

```json
{
  "confirmation": {
    "operationId": "prepare返回的64hex",
    "dependencyDigest": "prepare返回的64hex",
    "policyDigest": "prepare返回的64hex",
    "confirmNewSourceBinding": true
  }
}
```

`confirmNewSourceBinding` 可省略，或为布尔值。仅当固定来源还没有登记、且实际规范企业→账套及账套→企业均已唯一绑定同一企业时，首次执行须 true。它只能增加同企业来源证据，不能建立新企业绑定或改绑。后续查询/重复执行无需重复同意该瞬态条件；导入 options 固定规范化 `confirmNewBinding:true`，防止恢复请求因来源登记已出现而改变。

API `runOfflinePosting(request)` 位于 `server/offline-posting.mjs`。固定 schema 各层先拒绝 Proxy、symbol、隐藏属性、访问器及额外字段，验证不会读取其 getter/Proxy trap。每次调用新起固定 Node worker，清除继承 `NODE_OPTIONS`/`WORKBENCH_DATA_DIR`，不继承调用方已缓存的默认 DB 模块。60秒超时以 SIGKILL 只终止本次子进程，返回 `applied:'unknown'`、稳定 ID，随后应使用 query。

CLI 先以 `wx` 独占预留输出，再调用 bridge；已有输出直接拒绝，不执行写账。只有该本机 JSON 含企业、文件路径、金额与逐行证据。stdout 仅固定状态和 applied 值，stderr 不输出客户资料。输出写入/同步失败时保留已有文件，不把账务提交改报未写；固定 stdout 给出 `query_required=true`，应以相同目标和选择另开新输出查询。

## 实际准入与固定策略

worker 首先只读打开显式 DB；不静态导入 `db.mjs`/`import-incremental.mjs`。实际 audit2 活动实例、import schema5、既有账套、双向企业绑定、持久 profile/会计准则均核对；材料 `scope.accountSetId` 必须严格等于 `String(actualId)`，`01`、数值字段/别名及名称猜认都不放行。scope 企业、币种和单位必须一致。

原件链使用既有 `openOfflineActionInput`→`buildOfflineActionPlanFromFiles`，支持显式 CSV/XLSX/JSON 或既有 material store，重新读当前原件及接收状态。选中分支必须具有当前准备通过的实际 candidate。其他 blocked/missing/unsupported 分支列明业务、状态和原因；不误阻独立业务，也不静默宣称整期完成。

每笔只使用规则既有固定科目：销售1122/5001/2221、行政5602/2202、预付1123/1002。逐项核对实际 name/category/direction/contra 与默认 profile 一致、`is_leaf=1` 且没有以该 code 为前缀的子科目。2221 必须实际可用为默认叶科目；有细项不能自动猜选 VAT 明细。当前所用科目存在任何项目/部门/往来必需辅助维度即阻断；不创建科目或辅助实体。只对本笔所用科目建立固定策略，不把无关账表变化混入请求语义；未来账套专属科目/辅助政策属于后续工作。

启用期间取实际既有账套 `start_period`，不是业务月；不改变账套启用期间。已封账月禁止首次执行。已完成业务可以在随后封账后核对其持久证明，不重复入账。

## 稳定身份、请求语义与恢复

operationId 与 batchId 都是以下有序值的 SHA-256（64hex，满足 audit 技术 ID 长度）：`['offline-posting/1', actualDatabaseInstanceId, canonicalEnterpriseKey, actualAccountSetId, businessKey]`。不含金额、日期、period、contentVersion、合同、供应商、策略或规则版本。来源系统固定为现有 `VAT_SOURCE_SYSTEM = offline-bookkeeping-candidates-v1`；sourceVoucherId 恰为 candidate.businessKey。

导入 options 为单笔 `mode:'append', dryRun:false`、明确实际账套与固定来源，payload 仅桥从 candidate 生成，内部 `offlinePosting` 绑定 `taskId`、该业务 `task.dependencyDigest` 和 `policyDigest`。不使用整文件hash、整plan摘要或整个candidate.contentVersion作任务语义，故同JSON重排、局部补件、增独立业务不会误阻原业务；同身份改金额、完成日、合同事实、仅依据basis或实际策略变化仍用原ID，明确冲突。新身份本身变掉的更正不在本片自动关联范围，不能声称覆盖全部更正。

真正审计 requestDigest 按当前领域公式验证：`auditCanonicalDigest(['audit-request-v1','import.append',{domainRequestDigest:auditResultDigest(importOptions)}])`。只读恢复先调用公开 `queryOperation`，再只读核 `audit_operations` 的实际 request/action/actor/target/attempt 绑定（公开query不返回这些绑定字段），并组合现有 public storage `getBatch/getVoucherSource/listBatchVouchers/persistedVoucherFingerprint`。只在固定attempt1、正确来源/账套/指纹、completed batch且attempts1、唯一created link、当前posted凭证与逐行实际分录都一致时返回 recovered。实际stored分录必须有限、非负、≤2位小数且精确按分等于本次重算各行；不能用会舍入的指纹把子分/Infinity损坏当作恢复成功。凭证分类必须严格为 `kind==='normal'`（三类支持候选都是正常业务凭证），日期/期间/字号/摘要/行序也直接核对。持久指纹不包含kind，因此不能仅凭指纹忽略会影响报表归类的分类更改。

只读查询使用显式 readOnly 连接和一致读事务，不导入默认 DB、不安装迁移。正常首次执行通过重验后才动态载入既有 core，并调用：

```js
withRequestMetadata({ operationId, actor: 'cli' },
  () => IM.importIncremental(options));
```

不调用私有 prepare/execute 审计授权，不SQL写 journal，不新增恢复锁或业务表。执行成功返回实际业务 `value{ok,status,created,batch,sourceTrace,...}`，另通过公开 `IM.getImportBatch` 得到实际batchEvidence。重启恢复返回本桥新核实的 evidence，`originalResponseReplayed:false`；不冒充原响应/原resultDigest。现有 coordinator 重启无rebuild会audit_result_unavailable，因此桥绝不盲目再次调用导入来恢复。

只有 official operation not_found、对应batch/source也均不存在、原件与目标重新验证后才能第一次公开导入。pending/unknown/unavailable/failed/任意证据矛盾均停下，不复写、不更换ID、不增加attempt。已有来源或batch而无本桥匹配operation时要求本机核对，不能换命名空间补写。

读取当前原件前先查持久operation。已commit但当前原件缺失/不再可重建时仍保留 `applied:true` 和稳定ID，status为needs_local_review；这只说明历史提交事实，不表示当前材料已通过。完整材料可重建但语义变更则conflict。commit后原件/策略变化会给 `posting_applied_input_stale`；回执IO丢失或进程结束无法证明结果时给unknown并要求query。每项资源关闭独立尽力，不让close异常覆盖已知提交事实；进程退出不等于宣称每项close均成功。

本机 JSON 的 scope/target、当前candidate及 `inputEvidence` 保留原件SHA/路径/字段位置、确认事实与规则来源；`evidence.entries` 中实际entryId/lineNo通过candidateEntryIndex一一对应candidate.entries的sourceFields/factSources/ruleSources。上传JSON和公开摘要都不是执行能力或真实性认证。

## 代码绑定与限制

public facade只静态加载Node内建模块，提供共享closure scanner。父进程每次spawn前实读本地字面量 `.mjs` ESM传递闭包，固定私有transport envelope携带expectedCode和原request；公开request不接受expectedCode。fresh worker静态加载native-only facade，应用import/DB打开前必须把自身实际闭包与父pre-spawn清单完全比较，没有expected的直接worker命令不得执行应用。加载后、执行前及commit后worker重验，父spawn返回后再次实读比较。父postcheck发现变化保留stable ID并返回unknown/query_required语义，不能把可能commit改报false；加载后才首次hash不能证明已执行代码，不能用该方式替代父pre-spawn绑定。policy摘要使用规范相对模块路径+SHA，等字节换安装目录不变。实际闭包39文件（均位于server）：

```text
accounting-profiles.mjs accounting-report-rules.mjs accounting.mjs
auxiliary-accounting.mjs auxiliary-import.mjs auxiliary-storage.mjs
bank-import.mjs bank-storage.mjs customer-data-request.mjs
database-open-guard.mjs db.mjs enterprise-identity.mjs
import-incremental.mjs import-storage.mjs local-audit-coordinator.mjs
local-audit-operation.mjs local-audit-storage.mjs local-audit.mjs
local-backup.mjs local-batch-storage.mjs material-completeness.mjs money.mjs
offline-accounting-readiness.mjs offline-action-input.mjs offline-action-plan.mjs
offline-bookkeeping.mjs offline-contracts.mjs offline-invoice-xlsx.mjs
offline-ledger-snapshot.mjs offline-material-adapters.mjs offline-material-store.mjs
offline-materials.mjs offline-posting-target.mjs offline-posting.mjs
offline-task-planner.mjs offline-voucher-rules.mjs period-end-controls.mjs
tax-calculation.mjs tax-rule-registry.mjs
```

该机制不证明 Node 二进制/外部包字节，不观察两次检查之间改后恢复的ABA，不防同进程恶意注入或物理层伪造。已观察到pre/post清单变化必停；测试真实在worker脚本已parse、首次capture前持续改worker自身或bookkeeping文件，两者均拒绝，不能把这种持续变化写作未观察ABA。fresh worker排除父进程旧db缓存；实际库还核规范路径、持有只读fd的dev/ino/birthtime/nlink及core实际路径/活动实例。它不新建或重写既有DB标记，不承诺抵御操作者在检查间主动替换后恢复文件。CLI输入/输出仅本机文件；没有网络、常驻服务或后台重试。

## 验证与回退

所有自动夹具均为临时合成原件/SQLite，不使用真实账套、凭据或生产黄金。新增套 `node test/offline-posting.test.mjs`；hardlink用真实Windows文件系统，受限沙箱EPERM是实际失败，不能skip。正式故障使用合成DB触发器：业务失败回滚且持久failed；失败登记再失败留下pending/unknown；删除故障后仍不重试。真实关闭stdout管道导致worker在commit后exit5，新进程query恢复，凭证与成功审计不增。

首轮失败保留：根probe发现ID初稿77字符超audit64上限；实施首例合成采购票号含字母被材料层拒；行政初稿把业务月当启用期间被现有import明确拒；hardlink在受限沙箱EPERM。分别改为namespace入64hex、规范数字合成票号、实际账套启用期间，并在获授权的非沙箱合成目录实际运行链接断言。31/32项通过仍未覆盖bootstrap自脚本parse→hash持续替换；按root要求补父pre/post绑定与两项真实启动窗回归，修后34/34。未弱化旧断言或绕守卫。

旧34/34不构成最终接受：fresh对完整候选head `ba92c03436870fe9af54eebd611dda54fba42973`明确REJECT P2，实际probe `06-workbench/.agent-runs/review-offline03b/kind.mjs`在销售posted后只把kind改carryforward仍得recovered，而该分类会使利润表排除业务。该head未发布/PR/合并。窄修仅在原实际恢复门追加kind严格normal，并新增当前policy下全新合成fixture：三类候选各实际applied，再分别改carryforward/depreciation/unknown；query和execute都精确拒绝为posting_stored_entries_inconsistent，dependency/policy/operation均与原确认相同，排除代码漂移冲突假通过；改回normal各自recovered且不增凭证/审计。修后实施 `node test/offline-posting.test.mjs` **35/35、exit0、skip0**，真实hardlink断言通过。最终root冻结验收与全新独审仍待，不用旧34结果代替。

本片未接默认主入口/package/test-all，停止使用新CLI即可停止新增桥写入。已真实写入的业务不能删审计/换ID重放；需按未来明确更正政策或现有人工核对流程处理。撤代码由root走新revert PR，不重写main历史。
