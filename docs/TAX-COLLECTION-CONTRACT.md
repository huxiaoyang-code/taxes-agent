# 当前企业与待办期间的真实采集契约

> **2026-10-20 当前包：[TAX-READONLY-ABANDON](tasks/TAX-READONLY-ABANDON.md)** · [交接](handoffs/TAX-READONLY-ABANDON.md)。以 PR #32 为基线，admin-only 固定只读旧操作永久放弃能力已通过独立 37 / 37 与管理者最终 `npm test` 25 / 25 套；真实默认诊断及显式 execute 成功，`abandoned_readonly / finished`、`lockRetired = true`，所有 cleanup confirmed。其语义仍为 `unknown_abandoned`，不证明请求或 realm 终止。重新登录后的新 v2 source 已成功 4 passive + 1 active identity-after，现有 MCP stdio → HTTP → Agent → 后端两次各 3 新请求 / 3 完整响应、各 6 行、无保留锁，完整 URL v2 / `documentScopeVerified = true`，身份 / 企业 / filing 投影一致且 `independentRequests = true`。仅验证身份 / 门户申报列表，业务期间 / 完整资料仍缺，整个业务专项未完成；业务候选 prepare 已完成 3 固定只读请求，6 行全为 branch_unverified，候选 / 导航均 0、lockRetained false；具体字段缺口正按官方消费者定位，未取得所属期 / 业务页。下文 PR #29 v1 结果只作退出前历史。完整候选 head / PR 仍由 root 收尾，不预填未知提交。

完整 URL P1 已随 [PR #31](https://github.com/huxiaoyang-code/youshu-fork/pull/31) 合并，PR #32 已补交接；提交与验收见[完整 URL 交接](handoffs/TAX-FULL-URL-BINDING.md)及[当前交接](handoffs/TAX-READONLY-ABANDON.md)。CDP `Frame.url` 不含 fragment，旧 `documentScopeVerified = true` 不保证完整 URL，也不证明现场曾切换；v2 新 save 与 fetch 前绑定要求继续有效。

核心“门户契约 + 真实复采”已随 [PR #29](https://github.com/huxiaoyang-code/youshu-fork/pull/29) 于北京时间 **2026-10-20 13:44:12**（UTC `2026-10-20T05:44:12Z`）合并。最终 head `c1d663a7b107f8538e01100a37c0b1102b9c02aa`，merge `bdc6e9a1c26835889d873ea0af1c57ac35d292ce`；管理者已 fetch 核对，最终独立审查与 head 一致性核对通过。

日期：2026-10-20。适用任务：[TAX-COLLECTION-REBASE](tasks/TAX-COLLECTION-REBASE.md)。本契约描述采集与验收边界，不代表表中业务资源已经取得。全国税局尚无可据此宣布的真实接入完成结果。

## 证据等级与执行门槛

完整文档 URL 必须按 CDP `Frame.url` 与 `urlFragment` 严格组合，保留单个 `#` 的片段语义并拒绝矛盾 / 异常输入（[官方协议](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/pdl/domains/Page.pdl)）。source v2 显式声明 `documentUrlSemantics = 'cdp_frame_url_plus_fragment_v1'`，新 save 只写 v2；v1 仅保留严格历史读取 / 比较，active 在 open / lock 前拒绝。host assert 使用完整 URL，页面内请求脚本在 fetch 前还须精确比对内部 `expectedFullUrl`，避免 host → evaluate 空窗；完整 URL、fragment 及派生摘要均不输出模型。

当前退役门槛优先于下文历史通用恢复描述：旧 host 已停止，原 target 在显式 `filter: [{}]` 全包含清单中缺席；缺席、通用 CDP 错误或两次快照均不证明原 realm / renderer 销毁，现场未证明 BFCache，不猜另一页替代。独立 admin-only `abandon_readonly` 只永久放弃已审固定只读旧操作及迟到结果，默认只诊断，执行 / resume 必须显式。严格 source / scope / nonce / dead owner / PID 复用 / registry / profile 绑定；目标不可寻址只接受原 method 下精确 `-32602` / message 组合，通用错误不作 not-found。

退役先将原锁 bytes + SHA 私有归档并 fsync prepare，再永久 commit abandoned，才退役同 canonical 锁并 finished。Global OS mutex（当前 SID / SYSTEM）与持久 RECOVERY 阻挡并发 collector；host 死亡 / stdin EOF 释放 helper mutex，未完成事务须显式 resume。collector 创建锁后还须再核 mutex，竞态失败仅撤自己 nonce。commit 后历史 run 仍可 load / compare，但旧 source 不得保存新 run；旧 source 不改写 / 升级，结果 `requestTermination = 'unknown_abandoned'`，不能当作 `recovered`、`complete`、`contextDestroyed` 或新鲜证明。

已审旧 host 停止后不能续发 host 请求链、写应用文件或发布候选；残留 IIFE 至多一个固定 identity GET 与读响应，旧结果无消费者，10 秒 Abort 不证明终止。原生 fetch 可接收 `Set-Cookie`，未证现场改变身份 Cookie，不能保证会话绝对不变。旧版审计为 `operator_attested_not_loaded_bytes_proof`，旧完整加载 bytes 未归档，不伪造 loaded-bytes 证明。本次实际退役已验证原锁 bytes + SHA 私有存档，旧 source 不改写 / 升级；`realmDestructionProven = false`、`lateSessionEffectsPossible = true`、`oldResultConsumption = permanently_forbidden`。重新登录后的全新 v2 source / 两轮 MCP 门户复采已实际完成，未复用旧响应；`businessScopeVerified`、`periodVerified`、`projectionComplete` 仍 false，缺 `business_period`、`full_enterprise_profile`、`full_business_fields`。

| 等级 | 可核验依据 | 可得结论 | 执行限制 |
|---|---|---|---|
| `static_candidate` | 官方已加载代码的固定路由、调用点、参数与消费者 | 功能及请求形状候选 | 不据名称猜参数、业务码或直接批量执行；先沿已确认正常页面观察 |
| `observed_request` | 实际网络请求与对应响应元信息 | 该页面实际发过此方法 / 路径 | 请求存在、HTTP 成功均不等于企业业务成功；确认只读及参数来源后才可固定重采 |
| `business_verified` | 实际成功响应、业务码 / 错误字段、必要 schema、企业与期间校验 | 仅该资源、该作用域的实际业务成功 | 后端仍须实际重新请求，不能复用首次响应充数 |

未知路径不进入任意 URL 代理；只执行逐项核实的官方固定 recipe。模型不得提供任意 URL、Cookie、header、query 或 body。会话依赖与业务参数由本机可信通道产生，工具只收安全会话引用和明确资源标识。请求前后检查连接代次与企业作用域，身份切换、导航到登录或迟到结果一律不得混入先前企业结果。

本包独立后端接管要求本机 reader 已停止并保留 registry 的 `quarantined` 状态；新 source 显式记录 `handoffMode = quarantined_reader_new_navigation` 与 `readerStoppedConfirmed = true`，由管理员在实际确认后随新导航形成。该声明不能绕过实时状态检查：后端打开连接以及每次请求前后仍须核对 registry 为隔离状态，遇到活动旧 reader 或状态改变直接拒绝；不得靠解除 quarantine、改 lease 或重启未知后端取得权限。source 还在本机保存 document URL 摘要，与固定 frame / loader 及导航事件代次共同约束页面；摘要及原始 URL 不作为模型业务资料输出。

以下为 PR #29 当时的受控 reload 恢复契约历史，不能用于当前缺目标旧操作：新采集锁因不确定请求 / scope 清理失败保留时，默认只诊断；显式恢复仅处理匹配 `authorized_navigation` scope 的新锁，校验 dead owner / nonce、唯一绑定官方页正常 reload 后的新 loader / context clear、完整清理，再复核后删除对应新锁。不符则保留，旧 quarantine / claim 不变。此历史恢复仅解除当时互斥，不等于企业 / 期间验证成功；当前以本节 admin-only 放弃契约和本包任务 / 交接为准。

## 新解析的安全证据索引

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

## 本包门户采集与真实后端复采结果

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

普通企业首页静态代码消费 `userinfo.user_id,user_type,reg_number,company_name,enterprise_type,taxpayerStatusCode`，并以 `reg_number` 处理企业缓存隔离；代理页另外消费 `agencyName,agencyCreditCode` 等。上述为字段结构，未取得真实值；代理身份、办税员或授权企业列表不等于当前选中纳税企业。

本机可信层必须建立不含原值的企业绑定引用，并持有本机实际企业标识用于比较。不能把哈希后的税号 / 姓名当作自动可外传数据；模型只收不由原值派生的随机引用及 `sameEnterprise` 等布尔结论。所有企业资源显式归属该绑定；仅靠共享 Cookie 隐式作用域时，要在前后实际校验身份并拒绝切换中的结果。

期间至少本机保留 `periodStart`、`periodEnd` 与事项关联；当前待办响应、相关官方表单或已确认所属期字段是来源。日期原值不进模型，模型只收 `periodBound`、`samePeriod` 与安全引用。当前系统月份、首页申报期限提示、下载文件名或静态页面不能替代业务所属期；同一企业可能同时有多个期间，按事项分别归属，禁止强压成一个猜测期间。

## 最小业务资源与字段覆盖

下列字段为内部语义目标，**不是未经观察的税局实际字段名**；映射必须由真实响应及前端消费者逐项确认。未取得记缺项，不填零或从静态文本补全。

| 资源 | 本机需要保存和核验 | 成功与覆盖要求 |
|---|---|---|
| 当前企业上下文 | 当前企业标识 / 名称、主体类型、登记状态、身份与授权归属 | 实际业务 schema 成功；企业绑定一致；不能以个人 / 代理身份替代 |
| 企业申报相关资料 | 税费种认定、计税 / 纳税人类型、适用登记与备案、会计准则 / 适用表单 | 每类资料都有实际来源及适用时间；菜单推荐不算认定 |
| 当前待办与已报事项 | 事项标识 / 类别、所属期起止、期限、申报 / 缴款状态、需报表单 | 取得完整义务集合与实际分页终点；待办空不等于无申报义务 |
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
