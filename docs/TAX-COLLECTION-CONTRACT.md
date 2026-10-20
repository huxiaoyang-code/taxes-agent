# 当前企业与待办期间的真实采集契约

> **2026-10-20 当前包：[TAX-BUSINESS-COLLECTION](tasks/TAX-BUSINESS-COLLECTION.md)** · [交接](handoffs/TAX-BUSINESS-COLLECTION.md)。当前分支 `codex/huxiaoyang-code/tax-query-data`，基线 [PR #34](https://github.com/huxiaoyang-code/youshu-fork/pull/34) merge `1c12f98bafc38d257482f35f268e7f14d2dbd156`、最终 head `3e16b3a48aaa12b8fa39b6f7d277e9a88d555c10` 已合并。门户已申报期间 / 基础企业字段已验；第二次企业资料正常导航已捕获三个 API。当前代码 HEAD `c820b7778c903b3a9dac57f31a93545efa3c7564`（tree `39e78e5115b529da17741ff9dc343b27db23f12e`）已实现两种绑定模式，恢复 / guard 七文件及末两文件 surface 修复已独审；root 最终受影响 121 项（query 72 + retire 44 + MCP 5）通过，root 最终完整 npm test 29 / 29 套 exit 0（同一 c820 版本、无代码 delta）；最终独立 delta 44 项及先前 query 72 / MCP 5 通过；query_context_refresh 退役已永久 commit，但实际 execute 的 scope 校验失败，lockRetired / realmDestructionProven / cleanupConfirmed 均 false、resumeRequired true；旧链永久不可消费，尚无 realm / finish 通过证据。原标签已跳统一认证域，具体页面 / 是否需重新登录待用户确认；已异步请用户在现有窗口进入目标企业首页并告知 root；新 source / context / run 均未建，三企业业务 / MCP 成功仍为 0；申报查询已正常导航、首遍被动捕获和本机契约诊断，尚属 observed_request + schema，未接入后端复采，当前待办期间未核实。以下历史缺项代码不意味着无界抓取完整 profile / full business，当前按报税所需选择字段和具体事项推进。

## 已验基线及状态语义

PR #34 root 最终完整 `npm test` 26 / 26 套、独立原 54 + 增量 45 项通过。用户重新登录后的门户最终 MCP → HTTP → Agent → 纯采集后端两轮各 3 fresh / 3 complete、各 6 行，企业 6 个扩展字段齐全，期间 validPair 6、distinctPeriodCount 3，6 行全部已申报；身份 / 企业 / filing 投影、source / run 与 run / run 期间对及多重集相等，独立请求 true，无保留锁。此验收只覆盖原门户资源和已申报行，不覆盖以下新 API。

`filingPeriodsVerified = true` 与当前待办的 `periodVerified` / `currentPendingPeriodVerified` 分离，后两者及 `businessScopeVerified` / `projectionComplete` 仍 false。旧私有白名单漏保留 `skssqq` / `skssqz` / `skssqzqz`，旧 period missing 仅表示未采入 / 未核实。期间采用严格日历与起止顺序，精确 `YYYY-MM-DD 00:00:00` 可接受，非零 time、T、timezone、毫秒和空白不接受；缺日期旧历史不可比，不由 missing == missing 推 true。`skssqzqz` 不凭名称推语义。基础企业字段覆盖不等于申报资料覆盖。

已申报 6 行不能当当前待办；更正 / 作废 / 财报报送入口持续封锁。`listNsrDbxx` 业务失败不能当已验证空集合；列表空也不能直接推无申报义务。

## 固定导航与 document 归属

有效菜单各唯一 1 项：纳税人信息查询 `/szc/szzh/sjswszzh/spHandler?cdlj=/szzh/zhcx/nsrxxcx`，申报信息查询 `/szc/szzh/sjswszzh/spHandler?cdlj=/szzh/zhcx/sbxx/sbxxcx`。这些是固定技术菜单目标，不能按名称证明目标页面请求只读或业务完整。

第二次企业资料捕获时 document 已确认 pathname `/szzh/zhcx/nsrxxcx`，唯一 query key 为 `ruuid`，不推其含义、不展示或版本化值。此后页面曾切至 `/szzh/zhcx/sbxx`，属于另页 scope，不是企业资料捕获页，也不凭路径前缀当作已验申报查询目标。随后 root 已正常导航进入真正申报查询 document `/szzh/zhcx/sbxx/sbxxcx`，唯一 query key 亦为 `ruuid`、无 hash；导航前后 3 个 identity 同企业核对通过，无保留锁。三种 document 分开绑定，不把前缀页、企业资料页与申报查询页等价。所有新 JS 均 quarantine，`safeAssetRefs = []`。

root 正常导航授权持续有效。可信层仍核官方同源、固定 handler / 唯一路由、身份与企业前后绑定，CDP `Frame.url` + `urlFragment` 严格 full URL 绑定，保留 context / loader / 导航代次守卫；source v2 的完整 URL 语义不变；新 save 只写 v2，active v1 在 open / lock 前拒绝，页面 fetch 前仍精确检查内部 expectedFullUrl。captureDocument 与 replayDocument 各自绑定私有 full URL，不混用。模型不接任意 URL、headers、query / body 值。正常导航原型独审 30 项通过，首轮导航前 2 + 后 1 共 3 个 identity complete、document / identity 守卫通过；这些不代替新 API 的独立业务契约与复采。

| 证据等级 | 可核验依据 | 可得结论 |
|---|---|---|
| `static_candidate` | 官方加载代码的固定路由、调用点、参数和消费者 | 候选形状，不能直接执行 |
| `observed_request` | 实际请求与响应元信息 | 请求存在，不代表业务成功或完整覆盖 |
| `business_verified` | 实际业务成功、schema、企业 / 期间核验 | 仅该资源、该作用域成功，仍须后端独立复采 |

## 企业资料接口的已观察契约

以下方法、pathname、query 键和无 body 形状来自第二次页面实际请求及本机只读安全诊断，不来自名称猜测。本次固定重放仅沿本机 immutable、已验证 template 保留捕获 query 的原顺序与原值，body 必须为 null。两条 POST 捕获的 `djxh` 均为空形状，捕获 `getUserMsg.djxh` 非空，其 `nsrsbh` / `shxydm` 与 parent 企业匹配；不得强行要求非空 helper 与空 query 字面全等，更不得把 helper 值填进 API query。后续须按下述明确绑定模式核对。不得从其他企业、旧窗口或标识别名推值，不刷新 / 修改 `t`、page 参数或补 body。document 的 `ruuid` 只参与 capture / replay 各自私有 full URL scope，不是 API 参数来源。

| 固定资源 | 方法与 pathname | 实际 query 键 / body | 已观察响应 |
|---|---|---|---|
| basic | `GET /szc/szzh/sjswszzh/sy/v1/DescribeNsrjbxx` | 仅 `t`；无 body | `Response.Error === null`、`Response.Data` 对象 |
| enterprise | `POST /szc/szzh/sjswszzh/zhcx/nsrxx/v1/DescribeNsrxxJcxx` | 仅 `djxh`，捕获为空形状；无 body | `Response.Error === null`、`Response.Data` 对象 |
| income | `POST /szc/szzh/sjswszzh/zhcx/nsrxx/v1/DescribeQysdshdxx` | `pageNum,pageSize,djxh`，其中捕获 `djxh` 为空形状；无 body | `Response.Error === null`、`Response.Data` 对象；页码 1 / 每页 10 / 总数 0 / List 0 |

income 结果只表示该次该页观察为 0，不推其他税费义务、全企业无申报义务或所有分页已验证。空 List 无自身企业 ID；本次捕获的隐式当前会话模式不能称参数企业绑定。其设计要求 `parameterEnterpriseBound = false`、会话校验通过后才可 `sessionEnterpriseBound = true`，而 `responseEnterpriseBound = false`、`obligationVerified = false` 始终保留；这些是已实现模式的约束，不是已完成复采结果。响应形状匹配和 HTTP 成功不单独证明只读语义、字段完整或全部报税资料已取得。

本机比较已确认 basic 的 `tyshxydm` / 名称与 parent 信用码 / 名称精确相等，enterprise 的 `shxydm` / 名称亦相等。basic `nsrsbh` 等于 parent `taxpayer_id`，但不等于 `reg_number`；禁止把这些标识随意视为别名。精确字段映射、绑定值和 query 值只由本机可信层持有，模型 / Git 只保留本段已核实的技术关系与布尔结论。

### 两种明确企业绑定模式（已实现，业务实采未验）

- `literal_parameter`：捕获 query 有明确非空 `djxh` 时继续按 literal 匹配，保留 immutable template 原 query 顺序 / 值及 null body；fresh helper 与该明确参数和捕获基准逐项核对，不由标识别名推值。
- `current_session`：本次两 POST 捕获 query 的 `djxh` 均为空形状，原空 query 值必须保留。以捕获 helper 的私有非空 `djxh` 及已确认四企业字段为基准，在 source refresh 和每轮前后 fresh helper 中重复核验同一基准；两个 profile 响应自身 code / name 也必须匹配。不能填入 helper 值、把空 query 当失败后自动改参数，或把会话企业绑定冒充参数绑定。

模式必须显式固定到新 immutable source / context，不能默切模式或升级旧 portal source。income 在隐式模式下仅可在会话守卫通过后记录 `sessionEnterpriseBound = true`；`parameterEnterpriseBound`、`responseEnterpriseBound`、`obligationVerified` 均为 false。两个 enum 已准确实现为 `literal_parameter` / `current_session`，空 query 增量验证已通过；仍没有实际企业资料两轮复采，不预填运行成功或绑定结果。

企业资料只读诊断 42 项合成和独立审查通过，并有 root 本机实际诊断，仅证明诊断检查。当前代码 HEAD `c820b7778c903b3a9dac57f31a93545efa3c7564`（tree `39e78e5115b529da17741ff9dc343b27db23f12e`）已实现三资源、两种绑定模式及 capture → run / run → run 投影与覆盖比较；恢复 / guard 七文件及末两文件 surface 修复已独审；root 最终受影响 121 项（query 72 + retire 44 + MCP 5）通过，root 最终完整 npm test 29 / 29 套 exit 0（同一 c820 版本、无代码 delta）；最终独立 delta 44 项及先前 query 72 / MCP 5 通过。代码验证不等于真实企业资料复采成功；尚无新 context / run，三业务请求没有成功的项目 MCP 复采结果。captureDocument 与 replayDocument 分离、新建 immutable context、不导航且不默升级旧 portal source 的设计不变；每轮完整 collect 计划 7 fresh（3 业务 + identity / getUserMsg 前后 4），目前尚未到达该阶段。

## 当前 refresh 失败与专用锁

此前两 POST 空 `djxh` 导致的 0 请求预检缺口已经通过两种模式实现 / 增量验证，不能再把它当当前阻塞。此后实际运行按发生顺序为：

| 真实阶段 | 已确认事实 | 未确认或未到达 |
|---|---|---|
| 第一次 refresh | identity phase `query_shape_invalid`；attempted / performed / complete 各 1，unknown 0；该次无保留锁 | 未到 helper、三个企业资料业务请求或 context 发布 |
| 第二次 refresh | 只增加对同一身份响应的安全结构诊断；attempted 1，发生 timeout / `cleanup_unconfirmed`；响应未确认，无 diagnosticAvailable 结果 | 不能据 performed 0 写成未发送；host 已死且 quarantine，保留 `query_context_refresh` 专用锁，没有新 context / run 或企业资料 MCP 成功 |

不能从身份响应形状失败、超时、host 已死或缺诊断推断登录过期、企业变化或请求已经终止。此前门户 / 查询页的“无锁”仅是各次捕获结束时的历史结果，不能覆盖当前专用锁。

### 专用退役已提交，显式 resume 尚未完成

恢复 / guard 实现与末两文件 surface 修复均已独审，root 已实际运行，结果必须区分：

| 实际阶段 | 已确认结果 | 限制 |
|---|---|---|
| diagnose | ownerDead / exactScope / cleanup 均 true | 只是执行前诊断，不等于后续 realm 销毁或 finish 成功 |
| execute | scope 校验失败；`retirementCommitted = true`、`lockRetired = false`、`realmDestructionProven = false`、`cleanupConfirmed = false`、`resumeRequired = true`；prepare + commit 已存在 | 旧链已永久禁止消费；没有 realm / finish 通过证据，锁未退休，不得删除事务或重建新 prepare / commit 以绕过 |
| 一次固定 loginb 正常导航 | 实际出现多次 mainframe / clear / detach / within_document 事件 | 未按成功处理，本轮失败事件不追认为销毁证明，不放开 redirect / hash 守卫 |
| 随后只读分类 | 原标签已跳统一认证域；inventory 的 tpass_login 分类覆盖整个认证域，routeCode unknown | 更窄诊断 knownOAuthPath / 已知尾 slash 路径均 false，fragmentPresent true、queryKeyCount 0、titleIndicatesLogin false；具体页面 / 是否需重登待用户确认，不推测 session 清除原因 |

已异步请用户在现有窗口进入目标企业首页并告知 root；当前等待用户确认，具体页面 / 是否需重新登录尚未确认，后续只读分类未新增 fetch / 导航。之后 root 先只读确认精确已知 portal 与稳定 scope，再按同一 prepare / commit 明确 `resume`，做**新一次**已授权正常导航以取得旧执行 realm 销毁及清理 / finish 证据。本轮失败导航和早期事件不得回填为该证明；在恢复证据通过前，不建新 source / context / run，不运行三企业业务复采。

`unknown_abandoned` / `late session effects possible` 始终保留；永久 commit、ownerDead、诊断 cleanup true、后续导航或未来清锁均不是服务端请求终止证明。owner / browser 不盲重启，不消费旧链任何迟到结果，不降低 redirect / hash / scope 守卫。用户正常页面跳转授权有效，用户确认请求已异步提出，不确定具体页面 / 是否需重登，不伪称已恢复。

### 草稿 PR 与运行版本边界

用户输入等待期间准备当前代码与真实失败状态的草稿 PR；不 ready、不 merge、不宣布本轮交付或专项完成。新版专用退役的真实运行通过独立本机 admin 完成，不是三企业业务或 MCP 复采成功。

现有纯采集 backend 不会因磁盘代码 commit 自动重载，当前未重启；browser owner 保留。只有同一事务显式 resume / finish、恢复无锁及稳定作用域均有实际证据后，实际 MCP 复采前才单独把纯采集 backend 更新到经审版本，绝不重启 browser owner。代码版本、独立 admin 运行与既有 backend 运行版本分开记录，不能把磁盘 HEAD 的测试结果当作旧后端已加载新代码。

## 申报查询的首遍观察（尚未后端接入）

root 正常导航实际进入 `/szzh/zhcx/sbxx/sbxxcx`，单一 `ruuid` query key、无 hash；前后 3 个 identity 同企业验证通过，无保留锁。被动捕获后，经 90 项合成与独立审查批准的纯本机只读诊断实际确认以下技术请求。本节等级为 `observed_request` + 响应 schema，不等于业务语义确认、新 source / candidate / active 发布或项目 Agent / MCP 后端复采。

| 已观察方法 / pathname | query / body | 响应 |
|---|---|---|
| `POST /szc/szzh/sjswszzh/zhcx/v1/DescribeSbmxcx2` | 无 query；JSON body 为下表 9 个固定一级键 | `Response.Error === null`，`Data` 对象；PageNumber 1 / PageSize 10 / Total 6 / List 6 |

| body 键 | 已观察类型 |
|---|---|
| `gzlx` | array，2 项，元素均 string |
| `pageNum,pageSize` | number |
| `sbrqq,sbrqz,skssqq,skssqz,zfbz,yzpzzlDm` | string |

body 原值只在本机 immutable 捕获模板中保存；不能以企业资料 API 的 null body 规则覆盖此 JSON body，也不能猜测默认值、重构筛选条件或推断 `gzlx` / `zfbz` 含义。此接口尚未纳入生产后端固定资源，不能把诊断读取当作重发请求。

List 的 13 个固定技术字段在六行均 present：`zsxmDmArray` 为 null、`ybtse` 为 number，其余 `nssbrq,skssqq,skssqz,gzlxDm,gzlx,zfbz,zfrq,sbuuid,yzpzzlDm,yzpzzlMc,pzxh` 为 string；未知字段及非法行计数均 0。金额仅类型 / present 计数，人员、记录 ID、日期与业务原值不输出，不返回金额合计 / 范围或 ID hash；`nssbrq` / `zfrq` 不凭名称推语义。

严格日期诊断为 validPair 6、起止 Midnight 各 6、distinctPeriodCount 2。与父 source 门户六行（3 个不同期间）的期间对及多重集比较均 **false**；双方都六行不能当成同一记录集合。这里的日期格式与比较结果不证明查询行是当前待办或已申报，`periodSemanticsVerified` / `currentPendingPeriodVerified` / `fullCollectionVerified` 仍 false。新 JS 全 quarantine，`safeAssetRefs = []`。

## 报税字段选择与资料边界

当前明确需要核实行业、登记状态、增值税企业类型、会计制度、税务机关；下表是已见安全 schema 的字段候选及对应语义，不是正式全量字段选型交付，也不据字段存在推适用资格或义务。

| 已确认资料语义 | 已见字段候选 |
|---|---|
| 登记状态 | enterprise `nsrztDm,nsrzt` |
| 行业 | enterprise `hyDm,hydl,zhymxhy` |
| 增值税企业类型 | enterprise `zzsqylxDm,zzsqylx` |
| 会计制度 | basic `kjzdzzDm,kjzdzzmc`；enterprise `kjzdzzDm,kjzdzz` |
| 纳税资格 | basic `nsrzg,nsrzgmc`；实际用途和适用性须逐项核实 |
| 税务机关 | basic `zgswjDm,zgswjmc`；enterprise `zgswjDm,zgswjMc,zgswskfjDm,zgswskfjMc` |

字段大小写按实际 schema 保留，不从近似名称猜别名。正式清单还须逐项记录来源资源、类型、是否存在 / 有值、适用性与本机绑定依据；原值留本机，模型只收静态已确认字段名和覆盖计数。资料选择按当前报税事项补缺口；人员、登录操作人、银行账号默认排除，只有明确报税需要时才另列必要字段与依据。税务机关与会计制度等资料不替代当前待办集合、事项所属期、适用表单和实际财务材料。

## 后端复采门槛与下一步

1. 等待用户确认现有窗口已进入目标企业首页，root 先只读确认精确已知 portal / 稳定 scope，再对现有 prepare + commit 明确 resume，以新一次正常导航取得 realm 销毁和 cleanup / finish 证据；不得消费失败事件、重开事务或绕过尚未退休的 query_context_refresh 锁。恢复后再核实三个资源的固定只读语义、参数来源、成功条件和企业绑定；不从菜单名、GET / POST、`Error: null` 或技术 complete 推断全业务成功。
2. 新资源按上述获准设计使用独立 source / immutable context 与固定资源契约进入项目 Agent / MCP → HTTP → 后端，两轮各计划 7 fresh 请求；按明确模式逐资源记录业务成功、参数 / 会话 / 响应企业绑定、选择字段覆盖及差异；隐式模式不得把 income 记为参数企业绑定，空 List 的响应企业绑定及义务保持未证。页面捕获、缓存、ignored 合成诊断都不算后端复采。
3. 申报查询首遍 document / 请求已观察；下一步核实其业务语义、固定只读契约及后端接入，再补当前待办集合、事项所属期和按事项必要材料；不从已申报历史期间、提醒失败或 income 空页补造当前待办。
4. 只有当前企业、当前待办期间、必要资料和事项材料有首遍成功、后端独立复采及覆盖证据后才宣布专项完成。未运行的业务资源保持 `not_run` / 未验；已经 attempted 的身份阶段按实际失败 / 响应未确认记录，不倒写未发送；按真正缺口推进，不先恢复全部旧方案。

root 独占真实会话与 Git，恢复只查本 worktree ignored checkpoint；实施者不读实际私有材料。原值、凭据、实际 refs、PID、端口、运行时完整 URL / query 值不进模型 / Git / PR；安全 refs 也不入 Git。保留登录 owner 后端 / 浏览器，不盲重启。自动点击永久禁止；提交、缴款、更正、作废、备案变更和副作用不明操作禁止。前包退役是 unknown_abandoned、迟到结果永久禁用，不当作请求终止证明或当前业务证据。

## 历史解析的安全证据索引（PR #29 时点）

输入为用户本机 `etax_rea_work`：接口分析报告、门户 / 登录脚本和大型浏览器证据 JSON。JSON 有 5 条 records，浏览器场景为 `records[1]`，其 `normalized_result.events.items` 共 1,259 项、场景 3 步。下表 ordinal 为该数组的零基下标；不记录 transaction ID、完整 URL、query 值、header、body 原值或 DOM。

输入文件定位摘要：浏览器证据 112,039,041 字节，SHA-256 `19fd6e7197c6867bc8099dc0c057487021d8c4d9a75c95d70937ddfd6a61ccbf`；技术报告 10,407 字节，SHA-256 `0d2f4b8f729b34014315507510bc9aa07d35f8f8d3c04af2fe6f961e87eb4a1c`。摘要用于版本定位，原始证据不入 Git。

| 对象 | 等级 / 来源 | 已核验安全事实 | 覆盖边界 |
|---|---|---|---|
| `/loginb/`、`/mhzx/api/mh/mhsy/index` | 实际 document | 场景包含登录门户与首页入口 | 不证明有效企业与待办期间 |
| `GET /mhzx/api/mh/mhsy/getUserInfo` | `observed_request`；ordinal 127、757 | query 仅观察到字段 `t`；两次 HTTP 成功事件存在，但未保存可读业务响应 body | 无 `business_verified` 企业证据；不能把旧错误码解释为新响应 |
| `GET /mhzx/api/mh/bqxx/getMhsydbBqxx` | `observed_request`；ordinal 131、761 | 第二次响应内容 ordinal 786，可在本机解码；`Response.Data` 字段为 `zbdw,dz,xbmh_zfwzUrl,ipcb,xbmh_dzjgUrl,bm,xbmh_jhUrl,gwba`；静态函数名 `getBqInfo` | 首页底部版权 / 门户信息，非待办，不统计企业 / 期间覆盖 |
| `POST /xxzx/api/nsrxxzx/txzx/wntj/v1/listWntj` | `observed_request`；ordinal 133、762 | query 观察到 `t`；捕获未保存请求 body 或可读业务响应；静态 `getListWntj` 无参调用，消费 `data.lx` 以选择 VAT 菜单 | 菜单推荐辅助，非待办，不证明税种认定 / 义务 / 期间 |
| `POST /xxzx/api/nsrxxzx/txzx/dbrw/v1/listNsrDbxx` | `static_candidate` | 官方 `main-listb` 的 `init → dbrw` 普通企业分支；固定 body `{Jsqd:"01"}`；静态成功条件 `data.returnCode == "1"`；消费 `ysbList,dqswsList,qtList,fxydList` | 新 JSON 未观察该请求；须实际业务页观察并核实返回后才能固定重采，不据列表名推断具体含义或完整期间 |
| `POST /mhzx/api/mh/wddb/v1/wddbquerybbsmxx` | 新解析中为 `static_candidate`；本包另有真实观察 | 官方 `main-listb` 的 `initBqsb` 调用层 data 为 `{csbz:e}`，`e` 来自页面 query 的 `db` 或默认空串；经过官方请求拦截器后 wire key 为 `Csbz`；消费 `data.dbt,wsbxxGrid,tbsl`，依赖身份及缓存 | 实际重采必须使用经过观察核实的 wire 结构 `{Csbz:e}`，不能直接发送调用层 `{csbz:e}`；缓存无请求不算复采 |
| `POST /mhzx/api/mh/nsrjbxx/v1/query` | `static_candidate` | 静态函数 `queryDj()` 无参，当前消费 `data.xyjb` | 仅此消费不足以称企业完整档案；不能沿用旧不透明跳转作为成功 |

报告中的 tpass 加密 / 认证端点、200 余静态候选、遥测、二维码及消息更新接口不纳入业务采集白名单。认证通道只保留本机有效会话，禁止导出密钥、认证票据或调用未核实的登录 / 身份切换副作用。

静态待办渲染列为 `dbzsbt,dbrwblsx,dbztDm`，另引用 `dbuuid,sfsytc,sfzdgxzt,dblj,dbztmc,blanmc,sfbhxx`；当前申报表格列为 `sbb,sbqx,zt`，另引用 `ztBm,zsxmDm,zspmDm,yyfwqdz,cddz,lybz`。这些是允许本机投影的结构候选，字段值和跳转链接不得透传模型；`sbqx` / `dbrwblsx` 为办理期限，均不能直接当作所属期。静态页面未证实期间起止字段，真实响应须另行核实。

页面分类可使用静态固定 pathname `/portal/dljg`、`/portal/fjm`、`/loginb`、`/loginb/`；它们仍是分类候选，不因匹配就声明业务成功。Vue 内部 path `/`、`/fjmqh`、`/dlmh`、`/collection`、`/zcfgxq`、`/xdjzwpt-zmhsy` 可能处于 hash，不得错误当作服务器 pathname。`/mhzx/api/mh/mhsy/index` 在证据中实际作为 document，且被多个前端未登录分支用作首页 / 认证入口；正常导航可能触发官方 SSO，不能保证原企业页面仍在，须先保留旧页并核实当前页面。

`getDbrwtstx` 静态参数含 `sfgxydzt`，其他消息详情 / `update*` 也涉及状态变化；即使名字像查询，也不得作为只读请求执行。正常导航可能触发官方页面自身行为，主动后端 recipe 仍须独立排除副作用不明操作。

## 历史门户采集与真实后端复采结果（PR #29 时点）

管理者沿已确认首页入口完成修复后的新 source：4 个被动实际请求，加 1 个主动身份复核；新 context / loader、`scopeRevision = 0`、`identityProjectionMatched = true`，新采集锁正常释放。以下结果来自本包实际运行，不倒填到上节原始解析证据。恢复只查本包 worktree 的 `.agent-runs/TAX-COLLECTION-CHECKPOINT.json`。

| 资源 / 阶段 | 已核验结果 | 覆盖边界 |
|---|---|---|
| identity | `Response.Data.userinfo` 结构及静态企业上下文字段已真实取得；新 source 与复采前后投影匹配 | 不是仅凭 code 或字段存在宣布完整企业业务授权已验证 |
| pending_tasks | `{Jsqd:"01"}` 实际匹配；本次业务状态失败，无静态预期四类列表 | 不计完整待办覆盖；未知键与原值不透传 |
| current_filing | wire `{Csbz:e}` 已实际匹配，`Data.wsbxxGrid` 为 6 行；字段异构，曾观察到行字段数最大 32，`zspmDm` 仅 4 / 6 行存在 | 仅保存已确认白名单，不把首行或部分字段当全量覆盖；`dbt` 不是独立成功码 |
| 原 MCP stdio → 隔离 HTTP → Agent → 后端第一次 collect | 3 fresh 请求均 performed / complete，6 行，`partial_observed` | 后端实际重新发送，不是 source 回放 |
| 同一链路第二次 collect | 再次 3 fresh 请求均 performed / complete，不同 run 引用，同为 6 行 | 两次合计 6 个后端实际请求，不以缓存替代 |
| source / run 及 run / run 比较 | `enterpriseEqual`、`identityProjectionEqual`、`filingProjectionEqual` 全 true，`independentRequests = true` | 仅证明白名单投影相等，不推出业务资料完整 |

两次均 `documentScopeVerified = true`、`identityProjectionMatched = true`；`businessScopeVerified`、`enterpriseVerified`、`periodVerified`、`projectionComplete` 均 false。明确缺项是 `business_period`、`full_enterprise_profile`、`full_business_fields`。`sbqx` / `dbrwblsx` 是期限，不能推算所属期。

wire 结构已由官方静态封装与实际请求共同确认：调用层 `{csbz:e}` 经 `e08f` 请求拦截器的 `qi` / `Gi` 递归把键首字母转大写，成为 `{Csbz:e}`；已大写的 `Jsqd` 不变，不存在为此添加的 `Request.Data` 包装。时间戳只在本机生成，不复制旧值。

早期 provisional 已废弃；hash 守卫缺陷、`scope_cleanup` 误拒及废弃新锁恢复仅作历史。管理者受控恢复未改旧 registry / quarantine，当前新锁已正常释放，没有历史锁阻塞。正常 bootstrap 只在匹配本次初始 frame 尚未消费且任何新文档业务请求之前有界允许两次 context clear；后续 clear、第三次 clear、任意 hash 往返仍拒绝。

管理者最终 `npm test` 23 / 23 套 exit 0，本包新增采集合成回归 54 项 exit 0。未参与实现、`fork_turns=none` 的独立 reviewer 已审当前代码无剩余阻塞，最终独审与 head 一致性核对已通过，核心 PR #29 已合并。核心“门户契约 + 真实复采”已随 PR #29 验收合并；整个专项未完成，后续已经授权沿真实官方同源业务页补期间、企业资料及完整字段，不是等待用户输入。旧 19 项未提交文件哈希均未变，旧 owner / browser / quarantine 保留。
## 沿实际申报行继续正常页面导航

官方 `main-listb` 静态消费者能证明下列导航来源，不能证明目标页面加载必然纯展示。仅由真实已观察行在本机形成链接，经官方 origin 与固定技术 route 核验后正常导航；不把运行时完整 URL、query / hash 值或业务文字传到模型，不执行点击处理函数本身。

| 静态消费者 | 条件与链接来源 | 边界 |
|---|---|---|
| `tableBtnold` | 先检查 `userinfo.relatedType` 的授权条件和地区 / 税种特殊分支；常规拼接 `(row.yyfwqdz || "") + row.cddz` 并 `window.open` | 参数来自实际申报行；不从名称猜替代链接 |
| `tableBtnold` 的简易申报分支 | 特定静态税种名称、`row.zt` 条件下读取本机缓存 `jyNsrsb`；其 `syms` 为静态指定模式时改用缓存 `sbDz` | 先本机核实原分支，不能只见 `cddz` 就跳过实际页面路由选择；不读取缓存原值到模型 |
| `tableBtnold` 的 ITS 分支 | `row.lybz` 为 ITS 时调用 `getYcxpj` 取得 ticket，向行链接加 `code` 后打开 | 该票据依赖副作用未核实，不调用、不复刻、不保存或外传认证参数 |
| `tableBtnold2` / `tabBtn2` | 待办行通常取 `row.dblj`；简易申报模式可能改用同一缓存 `sbDz` | 来自通知待办和当前申报的行结构不同，不能混用 |
| `gotogzzf` | 已申报行提供财报报送或 `/declare/correct` 等更正相关入口 | 不作为本包继续采集入口，不执行更正 / 作废 |

链接为正常导航来源不自动放行其目标页里的写接口。导航后仍只被动观察已确认读请求；出现保存草稿、预提交、签票、正式报送等动作不得自动调用。原页应保留，避免用新导航覆盖尚未持久化的首次证据。

## 企业与期间作用域

普通企业首页静态代码消费 `userinfo.user_id,user_type,reg_number,company_name,enterprise_type,taxpayerStatusCode`，并以 `reg_number` 处理企业缓存隔离；代理页另外消费 `agencyName,agencyCreditCode` 等。该静态清单本身不证明真实值已取得；本轮已见 userinfo schema，当前报税资料选择字段及后端复采仍未验。代理身份、办税员或授权企业列表不等于当前选中纳税企业。

本机可信层必须建立不含原值的企业绑定引用，并持有本机实际企业标识用于比较。不能把哈希后的税号 / 姓名当作自动可外传数据；模型只收不由原值派生的随机引用及 `sameEnterprise` 等布尔结论。所有企业资源显式归属该绑定；仅靠共享 Cookie 隐式作用域时，要在前后实际校验身份并拒绝切换中的结果。

期间至少本机保留 `periodStart`、`periodEnd` 与事项关联；当前待办响应、相关官方表单或已确认所属期字段是来源。日期原值不进模型，模型只收 `periodBound`、`samePeriod` 与安全引用。当前系统月份、首页申报期限提示、下载文件名或静态页面不能替代业务所属期；同一企业可能同时有多个期间，按事项分别归属，禁止强压成一个猜测期间。

## 最小业务资源与字段覆盖

下列资源是按已确认报税事项选择资料的检查表，不要求先抓取全部企业档案或所有历史业务。除当前节已列出的真实 schema 候选外，内部语义目标不是税局实际字段名；映射须逐项核实，缺项不填零或从静态文本补全。

| 资源 | 本机需要保存和核验 | 成功与覆盖要求 |
|---|---|---|
| 当前企业上下文 | 当前企业标识 / 名称、主体类型、登记状态、身份与授权归属 | 实际业务 schema 成功；企业绑定一致；不能以个人 / 代理身份替代 |
| 企业申报相关资料 | 税费种认定、计税 / 纳税人类型、适用登记与备案、会计准则 / 适用表单 | 每类资料都有实际来源及适用时间；菜单推荐不算认定 |
| 当前待办与已申报事项 | 事项标识 / 类别、所属期起止、期限、申报 / 缴款状态、需报表单 | 当前待办、已申报历史和义务分别举证，记录所需集合的实际分页终点；待办空不等于无申报义务 |
| 当前事项业务材料 | 表单 / 版本、所需字段、官方已有金额与数量、预填来源、缺项 | 原值本机处理；已取得 / 缺失 / 不适用有证据；税局资料不当然包含完整账务凭证 |
| 必要依赖 | 当前事项所需累计 / 结转 / 优惠、必要历史、企业事件、发票 / 已缴信息 | 先由已确认事项确定最小范围；避免无界历史 / 全模块抓取 |
| 完整性与差异 | 稳定业务键、记录数 / 页面数、重复与冲突、首末页证据、首遍与复采差异 | 分页未终止或 schema 漂移必须标记部分成功；动态变化有本机差异分类 |

税局无法提供的账务材料先列来源缺口，再评估本机既有账套；不扩大为读取真实账套做自动测试，不把缺资料状态提升为可申报。

## 两遍真实请求与安全输出

第一次运行从正常页面真实请求取得业务契约。第二次经项目 Agent / MCP → HTTP → 后端实际重新发请求；后端借助本机浏览器会话发送可接受，但调用者必须是项目后端，Codex 在浏览器内临时 fetch 不得冒充后端复采。两次独立记录运行引用、资源、请求是否实际发送、实际请求次数、业务成功 / 失败、schema 验证、企业 / 期间绑定、分页终点和字段覆盖；新运行不得使用首遍响应或仅缓存返回。

第二遍实际业务响应必须在本机重新核对与第一遍同一企业 / 同一事项期间。对每个必要资源分别记录 `matched`、`changed`、`missing`、`not_run`、`failed`，不能用总请求数掩盖核心资源缺失。动态通知或状态更新允许差异，但须本机解释；同源 serializer 相等或 HTTP 200 不足以作完整性证据。

模型可接收固定状态、资源代码、计数、经静态 allowlist 确认的字段名、随机安全证据引用和缺项代码；安全引用也不写 Git / PR。原始本机标识与调试信息不得进入模型、Git 或 PR。错误信息只能映射固定分类；未知服务端错误文本、字段名、URL、页面标题、认证参数不得直接透传。响应持久化需本机受限目录且 Git 忽略，认证材料不得混入业务快照。是否已持久化与是否实际发请求必须据实报告。

状态至少区分 `not_observed`、`observed_request`、`business_verified`、`login_required`、`forbidden`、`unknown_business_error`、`schema_mismatch`、`empty_unverified`、`partial`、`not_run`。不认识的业务码保留未知，不按 HTTP 200 或列表为空自动判成功；成功码须来自真实响应与已核实的前端消费。

最终只有在当前企业、当前待办期间、必要资源首遍成功、后端复采与覆盖核对均有实际证据后，才能宣布本专项完成。代码 / 合成验收与真实采集验收分列；未满足部分由交接明确记录。
