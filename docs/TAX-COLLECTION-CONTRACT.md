# 当前企业与待办期间的真实采集契约

> **2026-10-20 当前包：[TAX-BUSINESS-COLLECTION](tasks/TAX-BUSINESS-COLLECTION.md)** · [交接](handoffs/TAX-BUSINESS-COLLECTION.md)。基于已合并 PR #33，私有已申报期间 / 基础企业字段及严格零时间格式修复已验收，root 完整 26 / 26 套、独立原 54 + 增量 45 项通过，最终两轮真实 MCP 成功；已进入纳税人信息查询页，业务数据捕获不足，当前待办期间、完整企业档案和业务字段仍未完成。下方 PR #29 原解析与门户结果按历史阅读，不能覆盖本节新发现。

## 当前证据与范围

用户关闭旧浏览器后明确要求再次启动后端浏览器并已登录；root 通过既有后端 open / 登记接口绑定全新专用窗口。新 v2 source 4 passive + 1 active identity 成功，现有 MCP stdio → HTTP → Agent → 后端两轮各 3 fresh / 3 complete、各 6 行，身份 / 企业 / filing 投影相等、run / run 独立、无保留锁。格式修复后的最终两轮使用现有 MCP 链路与新纯采集后端，新增企业 6 字段均 present / nonempty 6 且投影相等；期间 validPair 6，缺失 / 非法 / 倒序 / 不支持均 0，起止 Midnight 各 6，distinctPeriodCount 3、alreadyFiledWithValidPeriod 6。filingPeriodsVerified true，source / run 与 run / run 均期间可比、PairEqual / MultisetEqual true；仅适用这些已申报行，不能推出当前待办或完整业务。

本机 schema 已见 userinfo 21 字段、filing 行最多 32 / 合计 34 个技术字段；`skssqq`、`skssqz`、`skssqzqz` 在 6 行全为 string，旧 `FILING_FIELDS` 未保留。此前 period missing 仅说明未采入 / 未核实，不能写成接口未返回期间。6 行 `zt` 均已申报，入口是更正 / 作废 / 财报报送，继续封锁；不能据此认为没有待办，`listNsrDbxx` 业务失败不等于空集合。`queryDj` 仅信用等级消费者，不能当完整档案。

## 私有字段、期间与比较

仅扩静态私有 `FILING_FIELDS` 期间 3 字段、`IDENTITY_FIELDS` 基础企业 6 字段，不扩个人 / agency / auth。不新增 source / run / capture 版本，不改旧文件；历史 scalar 子集仍可 load，不补齐旧证据。原值只在本机受限忽略目录，不回模型，安全 refs 也不入 Git / PR。

collect / compare 使用 strict 日历 helper 核实真实日历与起止顺序，重算已申报 `filingPeriodsVerified` / `filingPeriodCoverage`、`filingPeriodsComparable` / `filingPeriodPairsEqual` / `filingPeriodMultisetEqual`、`enterpriseBasicFieldCoverage`。缺日期历史不可比，不能 missing == missing 推 true。原 filing projection 的 `periodVerified = false` 不变，显式 `currentPendingPeriodVerified = false`；已申报期间有效也不等于当前待办期间已验，基础企业覆盖也不等于完整档案。`businessScopeVerified`、`periodVerified`、`currentPendingPeriodVerified`、`projectionComplete` 仍 false，完整 profile / full business 仍缺。

[广西税务局公开文件 PDF 第 100 页](https://guangxi.chinatax.gov.cn/xxgk/zfxxgk_22500/fdzdgknr/zfcg_22570/zbgg_22623/202303/P020230313613088224248.pdf#page=100) 将 `skssqq` / `skssqz` 列为税款所属期起 / 止，仅为字段语义旁证，不证明本门户日期格式、值、业务成功码或当前待办归属；`skssqzqz` 不按名称猜语义。

初次新增字段实采已取得日期，但原两格式 strict helper 对 6 行判 unsupported；root 本机确认起止各 6 / 6 为精确 `YYYY-MM-DD 00:00:00` 后，仅扩严格零时间格式及 Midnight 计数，拒非零 time、T、timezone、毫秒和空白，不输出日期原值。最终两轮新字段验收完成；root 只重启不拥有浏览器的独立 collector 加载补丁，当前登录 owner 后端 / 浏览器保留。

## 查询导航与执行门槛

实际有效菜单“纳税人信息查询”与“申报信息查询”各唯一 1 项，同源静态 handler 为 `/szc/szzh/sjswszzh/spHandler`，唯一 `cdlj` 对应公共技术 query route `/szzh/zhcx/nsrxxcx` 与 `/szzh/zhcx/sbxx/sbxxcx`。正常导航原型独审 30 项通过，所有新 JS 均 private 隔离、`safeAssetRefs = []`；已进入纳税人信息查询页，业务数据捕获不足，不预填成功。运行时完整 URL、query 值与页面引用仅本机；模型不传任意 URL、Cookie、headers、query 或 body。

root 已沿当前企业有效菜单一次正常 `Page.navigate` 进入纳税人信息查询；导航前 2 + 后 1 共 3 个 identity complete，`documentScopeVerified` / `identityProjectionMatched` true，无保留锁。初次仅被动 Network 观察：127 请求，29 超上限、74 外部跳过、6 显式副作用跳过；JSON 仅见用户消息等框架接口，企业档案业务成功证据、只读 recipe 核验与业务接口复采尚未完成。`safeAssetRefs = []`，新 JS 全本机 private 隔离，无点击或未知接口重放。首轮被静态 / 外部资源占满，正最小调整 ignored 采样为优先业务 XHR / Fetch 并暖缓存再观察，第二次结果未出，不预填成功；当前待办、完整企业资料与申报查询页仍未完成。

可信层须核官方同源、固定 handler / 唯一路由、身份与企业前后绑定，按 CDP `Frame.url` + `urlFragment` 严格 full URL 绑定，并保留 context / loader / 导航代次守卫；source v2 明确完整 URL 语义，新 save 只写 v2，active v1 在 open / lock 前拒绝，页面 fetch 前再精确检查内部 expectedFullUrl。原始 URL / fragment / 派生摘要不输出。

菜单或 handler 静态匹配只证明导航来源，不证明目标页请求纯只读。root 正常导航后先被动观察真实请求，再核实际业务成功、schema、企业 / 事项期间和副作用；只有逐项核实的固定只读 recipe 可经后端独立重新请求，不猜隐藏接口，不从菜单名或 HTTP 200 判完整成功。

| 证据等级 | 可核验依据 | 可得结论 |
|---|---|---|
| `static_candidate` | 官方加载代码的固定路由、调用点、参数和消费者 | 候选形状，不能直接执行 |
| `observed_request` | 实际请求与响应元信息 | 请求存在，不代表业务成功或完整覆盖 |
| `business_verified` | 实际业务成功、schema、企业 / 期间核验 | 仅该资源、该作用域成功，仍须后端独立复采 |

正常导航已有授权，自动点击、提交、缴款、更正、作废、备案变更和副作用不明操作禁止。真实数据 / 凭据不进模型或 Git。恢复仅 root 查本 worktree ignored `.agent-runs/TAX-COLLECTION-CHECKPOINT.json`；不写实际 refs、PID、端口或业务原值。旧 source 不复用，前包退役是 unknown_abandoned，迟到结果永久禁止消费；详细历史见[退役交接](handoffs/TAX-READONLY-ABANDON.md)，不当作请求终止证明或当前业务证据。

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

普通企业首页静态代码消费 `userinfo.user_id,user_type,reg_number,company_name,enterprise_type,taxpayerStatusCode`，并以 `reg_number` 处理企业缓存隔离；代理页另外消费 `agencyName,agencyCreditCode` 等。该静态清单本身不证明真实值已取得；本轮已见 userinfo schema，完整企业档案仍未验。代理身份、办税员或授权企业列表不等于当前选中纳税企业。

本机可信层必须建立不含原值的企业绑定引用，并持有本机实际企业标识用于比较。不能把哈希后的税号 / 姓名当作自动可外传数据；模型只收不由原值派生的随机引用及 `sameEnterprise` 等布尔结论。所有企业资源显式归属该绑定；仅靠共享 Cookie 隐式作用域时，要在前后实际校验身份并拒绝切换中的结果。

期间至少本机保留 `periodStart`、`periodEnd` 与事项关联；当前待办响应、相关官方表单或已确认所属期字段是来源。日期原值不进模型，模型只收 `periodBound`、`samePeriod` 与安全引用。当前系统月份、首页申报期限提示、下载文件名或静态页面不能替代业务所属期；同一企业可能同时有多个期间，按事项分别归属，禁止强压成一个猜测期间。

## 最小业务资源与字段覆盖

下列字段为内部语义目标，**不是未经观察的税局实际字段名**；映射必须由真实响应及前端消费者逐项确认。未取得记缺项，不填零或从静态文本补全。

| 资源 | 本机需要保存和核验 | 成功与覆盖要求 |
|---|---|---|
| 当前企业上下文 | 当前企业标识 / 名称、主体类型、登记状态、身份与授权归属 | 实际业务 schema 成功；企业绑定一致；不能以个人 / 代理身份替代 |
| 企业申报相关资料 | 税费种认定、计税 / 纳税人类型、适用登记与备案、会计准则 / 适用表单 | 每类资料都有实际来源及适用时间；菜单推荐不算认定 |
| 当前待办与已申报事项 | 事项标识 / 类别、所属期起止、期限、申报 / 缴款状态、需报表单 | 取得完整义务集合与实际分页终点；待办空不等于无申报义务 |
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
