# TAX-BUSINESS-COLLECTION · 企业资料与申报期间实采

日期：2026-10-20。负责人：`huxiaoyang-code`。Refs #20 / #13 / #14 / #17，不关闭总任务。分支 `codex/huxiaoyang-code/tax-business-collection`，基线 [PR #33](https://github.com/huxiaoyang-code/youshu-fork/pull/33) merge `f05c7a1a6a9412ab873f4b282a76ee773baff2f7`，该 PR head `9a9191f968548cbf2f5010e20f46df035f566bd6` 已审查、验证并合并。本包期间字段修复已完成独立验证与最终两轮真实 MCP，待 root 锁 head / PR 交付；已进入纳税人信息查询页，业务数据捕获不足，总任务未完成。

必读：[章程](../PROJECT-CHARTER.md)、[STATE](../handoffs/STATE.md)、[采集契约](../TAX-COLLECTION-CONTRACT.md)、[本包交接](../handoffs/TAX-BUSINESS-COLLECTION.md)。历史退役语义只查[前包交接](../handoffs/TAX-READONLY-ABANDON.md)，不恢复旧 source，不沿用前包窗口引用。

## 目标与当前证据

继续用户原目标：在本机已登录、当前企业作用域中取得当前待办所属期与报税资料，再经现有 Agent / MCP → HTTP → 后端实际重新请求并核对覆盖。本包先补此前私有白名单遗漏的已申报期间 / 基础企业字段，再沿已证实的只读查询入口取得业务证据；不能把已申报期间等同当前待办期间。

用户已关闭整个旧浏览器，明确要求重新启动后端浏览器并已登录。root 已通过既有后端 open 与登记接口绑定全新专用窗口，新 v2 source 4 passive + 1 active identity 成功。新增字段及严格零时间格式修复后，现有 MCP stdio → HTTP → Agent → 新纯采集后端最终两轮各 3 fresh 请求 / 3 complete 响应、各 6 行，身份 / 企业 / filing 投影一致，run / run 独立，无保留锁；仅核实这些已申报行的期间及基础企业覆盖。

本机 schema 诊断已见 userinfo 21 个字段，filing 行最多 32 个、合计 34 个技术字段；`skssqq`、`skssqz`、`skssqzqz` 在 6 行均为 string。此前 `FILING_FIELDS` 未保留它们，`period_missing` 只表示未采入 / 未核实，不能表述为接口没有返回。6 行 `zt` 均为已申报，其行入口为更正 / 作废 / 财报报送，持续封锁；不能从 6 行已申报推出没有待办，独立 `listNsrDbxx` 业务失败也不能当作空列表。

## 字段与语义契约

- 仅扩静态私有 `FILING_FIELDS` 的 3 个期间字段与 `IDENTITY_FIELDS` 的 6 个基础企业字段，不扩个人、agency 或认证字段。不新增 source / run / capture 版本，不改旧文件；旧 scalar 子集仍 load，不补齐历史证据。原值只存本机受限忽略目录。输出仅固定状态、覆盖计数和核对布尔值，安全引用也不入 Git / PR。
- 严格核实真实日历日期与起止顺序，拒绝宽松日期自动归一、缺值或反序。`skssqzqz` 语义不得仅凭名字猜测。新增 `filingPeriodsVerified` / coverage 仅描述这些已申报行；`periodVerified` 始终保留“当前待办期间已核实”的语义，不能因已申报期间有效而置 true。
- 初次新增字段实采已取得期间，但旧 helper 的两种严格格式对 6 行均判 unsupported；本机固定格式计数确认后，仅新增精确 `YYYY-MM-DD 00:00:00` 与 Midnight 计数，拒绝非零 time、T、timezone、毫秒及空白，不把日期原值送模型 / Git。
- collect / compare 使用 strict 日历 helper 重算 `filingPeriodsVerified`、`filingPeriodCoverage`、`filingPeriodsComparable`、`filingPeriodPairsEqual`、`filingPeriodMultisetEqual` 与 `enterpriseBasicFieldCoverage`。缺日期的旧历史不可比，不能由 missing == missing 推 true；原 filing projection 的 `periodVerified = false` 不变，并显式输出 `currentPendingPeriodVerified = false`。
- 基础企业字段覆盖不等于完整档案；`queryDj` 只消费信用等级，不能据此宣称 full profile。`businessScopeVerified`、`periodVerified`、`projectionComplete` 及完整企业档案状态继续按缺项处理。
- [广西税务局官方招标文件](https://guangxi.chinatax.gov.cn/xxgk/zfxxgk_22500/fdzdgknr/zfcg_22570/zbgg_22623/202303/P020230313613088224248.pdf#page=100) 的接口出参把 `skssqq` / `skssqz` 解释为所属期起 / 止（PDF 第 100 页）；仅作字段语义旁证，不能推出本门户 wire 格式、值、成功码或当前待办归属。

## 正常导航契约

实际有效菜单已发现“纳税人信息查询”与“申报信息查询”，各唯一 1 项；同源静态 handler 为 `/szc/szzh/sjswszzh/spHandler`，其唯一 `cdlj` 对应公共技术 query route `/szzh/zhcx/nsrxxcx` 与 `/szzh/zhcx/sbxx/sbxxcx`。正常导航原型独审 30 项通过，所有新 JS 均隔离在 private、`safeAssetRefs = []`；已进入纳税人信息查询页，业务数据捕获不足，不能按菜单名称假定目标页或后台请求只读。

root 已沿当前企业有效菜单一次正常 `Page.navigate` 进入纳税人信息查询；导航前 2 + 后 1 共 3 个 identity complete，`documentScopeVerified` / `identityProjectionMatched` true，无保留锁。初次仅被动 Network 观察：127 请求，29 超上限、74 外部跳过、6 显式副作用跳过；JSON 仅见用户消息等框架接口，企业档案业务成功证据、只读 recipe 核验与业务接口复采尚未完成。`safeAssetRefs = []`，新 JS 全本机 private 隔离，无点击或未知接口重放。首轮被静态 / 外部资源占满，正最小调整 ignored 采样为优先业务 XHR / Fetch 并暖缓存再观察，第二次结果未出，不预填成功；当前待办、完整企业资料与申报查询页仍未完成。

完整运行时 URL、query 值、原始菜单 / 响应及页面引用均只在本机；模型不接任意 URL 输入。仅由本机可信层核验官方同源、固定 handler、唯一静态路由及绑定后正常导航，保留身份 / 企业 / full URL + fragment / context / loader 前后守卫。无需也不得执行点击脚本或 handler 函数。导航后先被动观察真实请求，再逐项核实只读 recipe、业务成功 schema 与企业 / 期间归属，才可后端复采。

## 实施提示词与所有权

> 先读本任务、契约及必要源码，不读真实 checkpoint / profile / raw / evidence。以合成材料扩私有期间 3 字段和企业 6 字段，严格日历与起止顺序；仅新增已申报 filingPeriodsVerified / coverage / 基础企业覆盖统计，保留当前待办 periodVerified 和整体缺项，不把历史行补字段当作待办已验。原值与派生摘要不回模型，不扩大个人 / agency / auth 字段。另一个导航实施者仅实现已审菜单的同源固定 handler 正常导航，保留身份、企业和完整文档守卫，不点击、不猜接口、不走已申报更正 / 作废 / 报送分支。作者自测、管理者验证、无实施上下文独审与真实 MCP / 页面验收分列，尚未运行据实记未验。不要 Git 或操作真实会话。

root 独占真实会话与 Git / PR；字段 / 导航代码由各自获派实施者维护，文档实施者独占本任务、交接、契约及 STATE / NEXT-SESSION / 任务 README 顶部，共 6 文档，不改旧任务 / 交接、core 或全局 Skill。用户明确授权本轮 Codex subagent 实施与独立最终审查，最终审查者不参与实施、不继承实施上下文，不冒充 GitHub 第二账号批准。

## 验收与下一步

1. root 最终完整 `npm test` 26 / 26 套通过，独立原 54 项 + 增量 45 项通过，作者 190 项定向通过；覆盖白名单、隐私输出、日期严格性、历史兼容与状态语义，不以技术请求完成判全业务成功。
2. 最终两轮新增企业 6 字段均 present / nonempty 6，投影相等；期间 validPair 6，缺失 / 非法 / 倒序 / 不支持均 0，起止 Midnight 各 6、distinctPeriodCount 3、alreadyFiledWithValidPeriod 6。`filingPeriodsVerified = true`，source / run 与 run / run 的 `filingPeriodsComparable`、PairEqual、MultisetEqual 均 true，身份 / 企业 / filing 投影相等，独立请求 true。只适用这 6 行已申报记录。
3. `currentPendingPeriodVerified`、`periodVerified`、`businessScopeVerified`、`projectionComplete` 仍 false，完整 profile / full business 仍缺。已进入纳税人信息查询页，业务数据捕获不足；后续优先业务 XHR / Fetch 并暖缓存观察，核实只读契约后再实际后端复采，不预填第二次结果，可在后续包继续。
4. 当前待办期间、必要业务资料与完整覆盖有首遍和后端独立证据后才可宣布专项完成；菜单发现、6 行已申报、字段补全或合成通过均不够。

新字段真实验收已由 root 另启仅采集后端完成，仅重启不拥有浏览器的独立 collector 加载格式补丁；拥有用户新登录浏览器的现有后端 / 浏览器保留、不重启。恢复仅由 root 查本 worktree ignored `.agent-runs/TAX-COLLECTION-CHECKPOINT.json`；文档不存实际 refs、PID、端口、URL 值或业务原值。正常导航已有授权；自动点击、提交、缴款、更正、作废、备案变更与副作用不明操作禁止，真实数据 / 凭据不进模型 / Git。
