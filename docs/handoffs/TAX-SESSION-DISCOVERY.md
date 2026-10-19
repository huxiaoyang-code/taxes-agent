# TAX-SESSION-DISCOVERY · 登录态探索与取数发现

日期：2026-10-20。负责人：`huxiaoyang-code`；[任务单](../tasks/TAX-SESSION-DISCOVERY.md)。**连接前置通过实机通道验证，DTO 去重通过合成回归，完整候选已通过独立最终复核并随 [PR #27](https://github.com/huxiaoyang-code/youshu-fork/pull/27) 合并交付；真实企业 / 期间 / 业务资料未取得，后端第二遍业务采集未运行。** 本文仅保存安全摘要，无标签页标识、调试端口、用户名、凭据、身份 / 金额原文。

## 恢复基线与当前目标

- 分叉基线：`origin/main` `17a053bfb66b482064ed92aa343ab42c41d47825`；分支：`codex/huxiaoyang-code/tax-session-discovery`，独立 worktree。
- [Issue #20 本包范围登记](https://github.com/huxiaoyang-code/youshu-fork/issues/20#issuecomment-6272100523)已完成；文件唯一负责人见任务单，评论不等于技术互斥。
- [扩展范围登记](https://github.com/huxiaoyang-code/youshu-fork/issues/20#issuecomment-6272266944)包含服务 / MCP 生命周期接线及 3 个当前入口文档。实施阶段核对 main 当时仍为上述完整基线；PR #18 仍 Draft、head `346e1c307379e9a6bf96ef34244dee154558777f`，PR #19 仍 OPEN、head `a47a53c3e7b077edcf827ee34aa40450cc3694ff`，当时未发现新在途 PR。PR #27 合并后的主线以本节合并记录为准。
- 上包工具与限制：[TAX-READONLY-TOOLS](TAX-READONLY-TOOLS.md)。PR #25 已交付元信息工具前置，不代表真实税局已连接；其 530 项为上包合成验收，不作本包验证。
- 用户明确继续充分探索，要求现有本机有效登录态 → 企业 / 报税业务信息 → 本机后端 / MCP 可重复读取。不能交空工具替代；当前不声称完成。
- [PR #27](https://github.com/huxiaoyang-code/youshu-fork/pull/27) 已于北京时间 **2026-10-20 01:00:33**（`2026-10-19T17:00:33Z`）合并；最终 head `a07c93a3657a9aaade5d44562a85f615327a82dd`，merge `73ee241648fb70711af21f8bdae49ed2f6680ab7`。独立最终 reviewer 对完整候选 17 文件正式通过、无剩余阻塞，管理者已 fetch 核实主线且树与验收候选一致。
- 已验证代码 / 测试版本：`6f05afd07493b28da6c758ad95f243637973c128`，12 个代码 / 测试文件单独提交，随后 5 个文档纳入完整候选；不把代码提交误称为完整 PR 最终 head。
- 纯文档收尾分支 `codex/huxiaoyang-code/tax-session-handoff`，base 为上述 merge；原分叉基线 / 实施分支保留追溯，不预报收尾 PR 自身合并。

## 本轮发现及证明边界

管理者重新定位 Edge 的官方 `loginb` 页面，仅其独占真实会话。页面已加载的 `e08f`、`9dc1`、Axios、`ecd1` 静态模块用于核对请求封装；没有猜测隐藏端点，也没有自动点击办税项。

| 观察对象 | 本轮事实 | 能证明与不能证明 |
|---|---|---|
| 运行上下文 | `API_PREFIX` 原始值为空字符串；处于 top frame；fetch 为原生实现 | 可据当前已加载代码核对相对路径，不推出全站采用相同封装 |
| XHR 包装 | 为官方遥测代理，只对 2 条遥测路径改 auth；未对 `getUserInfo` 修改 | 本轮未发现该包装给身份接口补鉴权；不据此推定没有其他认证依赖 |
| Axios 请求差异 | 默认有 Accept；`data` 为 undefined 时移除 Content-Type | 修正先前 fetch 与页面封装的差异；这些差异是否决定业务成功需实际响应核对 |
| `GET /mhzx/api/mh/mhsy/getUserInfo` | 按上述 Axios 差异修正后仍 HTTP 200、code `9997`、无 identity 字段 | 未取得身份，不是业务成功；不猜测 `9997` 含义，也不能单凭该码断言过期或无权限 |
| `POST /mhzx/api/mh/nsrjbxx/v1/query`（`queryDj`） | 当前 loaded 代码与 performance 已观察；无 data；以 `redirect:manual` 读取返回 `opaqueredirect`、status 0 | 未取得企业资料；没有读取到 redirect 目标，status 0 不是正常业务状态码，不得编造目标地址 |
| 单次 fetch 异常 | 一次网络 `TypeError` | 仅记传输异常；不能归为某个业务错误码或认定权限 |
| Network 事件读取 | 一次因 30 秒超时导致 kernel reset；之后用 `timeoutMs=1`、`limit=100` 与方法 filter，实际约 42 秒返回 cursor 0、空事件 | 缓冲已丢失，不能宣称捕获了 redirect 目标或完整网络历史；请求参数超时值不等于实际返回时限 |
| 当前官方页面 | 仅 reload 官方首页，无点击办税项；随后新 inventory 确认原页面自动到 `https://tpass.fujian.chinatax.gov.cn:8443/` | 这是 reload 后页面位置事实，不是前述 opaque redirect 的已捕获目标；当前需操作者本机完成登录，不能继续业务采集 |

上述静态代码与失败请求能缩小诊断范围，但**没有证明有效企业身份、授权范围、当期待办期间或任何业务资源已可取**。不把首页 / 菜单可见当作有效登录证据，也不把重定向的独立观察倒填为已丢失 Network 事件。

## 当前会话与后端连接状态

用户已回复原官方页“登录遇到问题，稍后说明”，当前等待具体问题；不重复要求其点击探索。有效会话是继续取得企业信息所需条件，不是重新索取有限只读授权。登录问题解决后，优先通过已实现的后端专用窗口人工登录一次，重新核实有效企业作用域与实际响应，再继续有限只读发现；不复制原窗口凭据。

管理者已对原用户官方页执行 `Network.disable` 并成功返回，原页保留；该旧扩展调用实际约 417 秒，传入的 10 秒命令 / 60 秒工具超时未限制住耗时，不代表专用后端性能，期间未读取登录请求 / 凭据或新增业务。

当前原 Edge 页仅能经扩展 CDP 观察，未取得可供现有产品后端使用的调试端口。**Codex 的扩展 CDP 通道不等于产品后端已经能连接**，不能把浏览器内 fetch / XHR 称作后端第二遍采集。

专用 Edge 通道已实现：`tax_browser_open({region:'350000'})` / `tax_browser_probe({connectionId})` / `tax_browser_close({connectionId})`，并已完成下述实机 MCP 链路验证。限定本机受限临时 profile、固定官方 origin、人工登录；probe 仅允许已观察身份路径，未登录时不发业务请求，仅返回安全结构 / 状态。不导出 Cookie、不自动点击、不创建 fake gateway session / 真实适配器、不持久化业务证据。**实机连接可用不等于企业业务取数已完成**。

open 幂等返回已有安全引用，避免丢失 MCP 响应后重试重复开窗口；`cleanup_required` 保留 owner 并允许重试 close。浏览器超时关闭自有专用连接，包含迟到 attach 处理；正常 SIGINT / SIGTERM 关闭清理及 shutdown 期间新 open 拒绝已接线，MCP open 请求时限为 60 秒。这些操作只针对本工具拥有的专用连接，不接管原用户页面。

root 是唯一真实会话操作者；integration_path、data_contract 与文档实施者只收到安全结构、失败分类与合成材料，不操作真实会话，不读取原文。最终新独立 reviewer 以 `fork_turns=none` 启动，未参与实现。

## 本轮证据与资料可得性

| 证据 / 资料 | 当前状态 | 缺口 |
|---|---|---|
| 当前请求封装、身份 / 档案候选路径 | 当前已观察 | 路径与封装存在不等于成功或完整 |
| 首次真实身份 / 企业资料 | `observed_attempt_failed` | `9997`、不透明重定向或传输异常；无身份 / 企业成功结构 |
| 本机有效登录与企业作用域 | `not_acquired` | 用户反馈登录遇到问题，等待具体说明；尚未进入有效企业作用域 |
| 产品后端专用 Edge 通道 | `transport_verified` | 真实 MCP 链路 open / 未登录 probe / close 通过；业务请求 0，不能当业务采集 |
| 后端第二遍实际采集 | `backend_not_run` | 通道已验，但尚无有效企业登录与成功业务契约；没有第二批业务数据 |
| 当前认定、会计备案 / 表单、待办 / 已报 / 截止日 | `not_acquired` | 当前身份 / 期间尚未取得，不能判断全部义务 |
| 必要历史、发票、缴款与事件事实 | `not_acquired` | 尚不能据当前事项确定需要补查的范围，不盲目全模块抓取 |
| 当前账套关联与材料 / 字段缺口 | `not_acquired` | 未读取真实账套，不能宣称字段已预填或校验完成 |
| 适用官方规则 / 税率 / 优惠 | `not_acquired` | 企业及所属期未知，不用模型记忆或旧政策替代核验 |

本包实机通道安全索引为 `.agent-runs/tax-session-live-evidence.json`，管理者已核实 Git 忽略，`evidenceId=tax-session-live-20261020-01`；仅安全状态，不含端口、PID、标签页、真实 connectionId 或凭据。它是本包通道证据，不是企业业务资料或第二遍采集索引。此前原页失败尝试不与上包 3 次相加编造总数；原页请求与本次专用通道业务请求 0 分开记。

| 本次实机 MCP → HTTP → Agent → 专用 Edge | 实际结果 | 大约耗时 |
|---|---|---|
| `tax_browser_open` | `needs_login` | 4 秒 |
| `tax_browser_probe` | `login_required`，`requestPerformed=false` | 3 秒 |
| `tax_browser_close` | `closed`，临时 profile 清理成功 | 4 秒 |

本次实机验证**业务请求 0、业务成功 0、第二遍业务采集未运行**。专用 Edge 已关闭、临时后端已停止，原用户官方登录页仍保留；不把上述耗时当性能承诺。

## 待补与继续条件

1. 等用户说明当前登录问题；解决后优先在后端专用官方窗口人工登录一次并进入试点企业，确认当前身份 / 企业作用域，不沿用旧页面标识或假定登录仍有效。
2. 单一会话操作者继续从已加载代码 / 实际请求确定有限只读契约，按业务成功条件核验；副作用不明的依赖单独记录，不自动执行。
3. 复用已验证产品通道，取得成功业务结构后接到现有 tax-gateway / agent-tools / MCP 的受控真实契约，再进行独立第二遍业务请求与本机证据覆盖核对；目前不创建假 gateway 会话。
4. 合成 DTO / 去重研究只验证软件逻辑；真实业务字段及来源、缺项与规则必须在真实资料取得后按当前企业 / 期间落地。

## 实施与验证状态

data_contract 已完成既有 DTO 分页去重 key 误判修复，仅修改 `06-workbench/server/tax-gateway.mjs` 与 `06-workbench/test/tax-acquisition.test.mjs`；实施者运行 `node test/tax-acquisition.test.mjs`（工作目录 `06-workbench`），**59/59 通过**，为原 48 项加本包 11 项。gateway 后续编辑已移交管理者 / integration_path，data_contract 不再改该文件。

integration_path 的 6 个生产文件已完成冻结：2 个新模块、Agent / MCP 工具注册、`server.mjs` 正常信号关闭与 finance MCP `backend.mjs` 的 open 60 秒时限；data_contract 完成 DTO 修复、专用通道 / MCP 回归与测试入口，精确路径见[任务单](../tasks/TAX-SESSION-DISCOVERY.md)。自动回归用合成 fake process / CDP、临时 HTTP 后端与真实 stdio MCP，不启动真实 Edge；实机 Edge 验证由 root 单独执行并与合成结果区分。

| 验证 | 工作目录与命令 | 实际结果 |
|---|---|---|
| 管理者全量 | `06-workbench`：`npm test` | **17 套全部通过，exit 0** |
| DTO 回归 / 独立复验 | `06-workbench`：`node test/tax-acquisition.test.mjs` | **59/59** |
| 浏览器通道模块 / 独立复验 | `06-workbench`：`node test/tax-browser-session.test.mjs` | **46/46**，真实空临时目录 ACL 断言保留并通过 |
| 合成 MCP 链 / 独立复验 | `05-reconstruction/codex/mcp/finance-mcp`：`node tax-browser-session-test.mjs` | **4/4** |

独立审查发现并修复 SPA 同文档导航迟到、初始化失败清理 owner 丢失、open 超时恢复与 shutdown 新 open 竞态；冻结代码复验无代码阻塞，额外真实 `CdpConnection` + fake WebSocket 的迟到 attach 和多阶段 cleanup 失败恢复均通过。独立 reviewer 未参与实现、不继承实施上下文，对完整候选 `a07c93a3657a9aaade5d44562a85f615327a82dd` 的 **17 文件正式通过、无剩余阻塞**；这是独立内容审查，不冒充 GitHub 第二账号批准。PR #27 已合并。

本包已交付连接前置与必要去重修复，专项真实企业 / 期间 / 业务资料仍未取得，不能声称专项完成。真实数据和凭据留本机，模型仅接收 schema、合成样例、安全引用、缺项与覆盖摘要；正式申报、缴款、更正、作废和备案变更均不在执行范围内。
