# TAX-FULL-URL-BINDING · 完整文档 URL 绑定修复

日期：2026-10-20。负责人：`huxiaoyang-code`。关联总任务：Refs #20，按业务 Refs #13 / #14 / #17；不关闭总任务。状态：P1 核心已随 [PR #31](https://github.com/huxiaoyang-code/youshu-fork/pull/31) 验收合并；v2 真实源形成与复采未运行，整个税局资料采集专项未完成。

- 实施基线：PR #30 merge `846ff0a988460de0e9a1c5afa92298a7633995e8`；实施分支 `codex/huxiaoyang-code/tax-business-pages`。当前纯交接分支 `codex/huxiaoyang-code/tax-full-url-handoff`，基线为 PR #31 merge。
- 必读：[章程](../PROJECT-CHARTER.md)、[STATE](../handoffs/STATE.md)、[原采集任务](TAX-COLLECTION-REBASE.md)、[采集契约](../TAX-COLLECTION-CONTRACT.md)、[本包交接](../handoffs/TAX-FULL-URL-BINDING.md)。
- PR #31 head `57aeb06cf9236fbc7a1a75e14f737c6ca3b793f6`，merge `75eebbbfb78adfaf88be35a2e1080b5432764126`，UTC `2026-10-20T06:13:58Z`（北京时间 14:13:58）；最终 fresh 独审 13 文件 exact head / tree 通过、无阻塞，管理者已导入核对真实签名 merge 对象及树一致。

## 问题与范围

CDP 的 `Frame.url` 不含 fragment，fragment 另在 `urlFragment`。旧 source 与作用域 assert 仅摘要基础 URL，因此监听开始前发生的 fragment 切换可能被接受。纯合成独立复现已证该缺陷；它不证明真实现场发生过切换。协议依据：[Chrome DevTools Page.pdl](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/pdl/domains/Page.pdl)。旧 `documentScopeVerified = true` 不能作为完整 URL（含 fragment）绑定保证。

本包只修复完整 URL 绑定与旧源主动使用门槛：严格组合 CDP URL 与 fragment；source v2 声明 `documentUrlSemantics = 'cdp_frame_url_plus_fragment_v1'`；新存只写 v2；历史 v1 保留严格读取与比较，但在主动打开连接 / 获取锁之前拒绝；请求在页面内真正 fetch 之前精确比对内部 `expectedFullUrl`，补住 host 检查到 evaluate 执行之间的空窗。原始 URL、片段、摘要及认证 / 业务原值不输出到模型。

## 授权与文件所有权

原目标继续有效：利用本机现有登录态取得当前企业、当前待办期间的报税资料，经现有 Agent / MCP → 后端再次实际请求并核对覆盖。允许正常页面导航，禁止自动点击、正式申报、财报报送、缴款、更正、作废、备案变更及副作用不明操作。原值与凭据仅在本机，安全引用不入 Git / PR。

用户本轮已明确采用 Codex subagent 并行实施，覆盖旧员工实施范式；最终由未参与实施且 `fork_turns = none` 的新 subagent 独审。root 是唯一真实会话操作者并管理 Git / PR；代码实施者只修改以下 7 个文件，文档实施者独占本任务、本包交接、契约及 STATE / NEXT-SESSION / 任务 README 的必要入口，共 13 个候选文件，不扩大范围。

- 新增 `06-workbench/server/tax-frame-url.mjs`。
- 修改 `06-workbench/server/tax-collection-contract.mjs`、`06-workbench/server/tax-collection-local.mjs`、`06-workbench/server/tax-live-collection.mjs`。
- 修改 `06-workbench/scripts/observe-tax-navigation.mjs`。
- 修改 `06-workbench/test/tax-live-collection-integration.test.mjs`、`05-reconstruction/codex/mcp/finance-mcp/tax-live-collection-test.mjs`。

不改全局 Skill，不覆盖旧 19 项未提交成果，不关闭或重启未知归属后端 / 浏览器；真实 checkpoint、registry、业务证据与原始 `etax_rea_work` 不作为实施者输入。ignored 候选 / 恢复原型不纳本包 Git，不作为生产交付。

## 实施提示词

> 接手 TAX-FULL-URL-BINDING，只读取本任务必读包与派发的必要源码。修复 CDP `Frame.url` / `urlFragment` 分离导致的 P1：统一严格 fullFrameUrl 组合，保留单个 `#` 分隔语义，矛盾或异常输入失败关闭，不丢片段、不靠重编码掩盖差异。source v2 显式记录完整 URL 语义；新存只写 v2，历史 v1 严格读取 / 比较仍可用，但 active 必须在 open / lock 前拒绝。assert 只在可信层返回内部完整 URL，传入页面内请求脚本，在 fetch 前精确核对 expectedFullUrl；不输出原始 URL 或派生摘要。用纯合成材料验证监听前片段切换、片段往返、组合异常、v1 拒绝时无连接 / 锁 / 请求，以及 host 到 evaluate 间改变 URL 的失败路径。不要读取真实 store / registry / checkpoint，不导航、不解锁、不 Git。将实际 diff、自测结果与限制交管理者，最终由无实施上下文的新 reviewer 独审。

## 验收与当前结果

1. 单一严格 helper 覆盖 URL 与 fragment 组合及异常 / 矛盾输入；完整 URL 变化不能被基础 URL 摘要掩盖。
2. v1 历史资料仍可严格 load / compare；任何 active v1 在 open / lock 前拒绝，不借版本兼容绕过完整绑定。
3. v2 source 记录明确语义；host assert 与页面内 fetch 前比对都包含 fragment，失败路径不发送业务请求，不泄露原值。
4. 作者采集合成 59 项、管理者 `06-workbench` 下 `npm test` 23 / 23 套均 exit 0；未参与实施、无继承上下文的独立 reviewer 审 core 7 文件无剩余阻塞，并独立 59 / 59 exit 0。首轮全量曾有 workflow 原生异常，单独与整轮复跑均 exit 0，未据此改代码。
5. 最终 fresh 独审 13 文件 exact head / tree 通过、无阻塞，PR #31 已合并；core 7 文件未变，23 / 59 验证不重复运行。验收不包括 scratch 恢复执行、真实导航或 v2 实机复采；本轮仅做合并后纯交接收尾。

## 当前恢复门槛

当前 `business_page_prepare` 锁来自后续 ignored 原型在 `identity_before` 失败；`performedCount = 0` 不等于未尝试。未导航、未形成候选。默认恢复只诊断，不 reload / unlock；只读检查经独审并以 `filter: [{}]` 全包含目标清单复核，`exactTargetMatchCount = 0`，owner 已停止、source 绑定匹配，返回 `recovery_target_ambiguous`、cleanup 成功；未 attach / read frame。锁继续保留。

缺目标不能归因 fragment，通用 CDP 错误、两次快照缺席均不能证明原 realm 已销毁。root 未关闭任何税局页，已询问用户是否手动使用或关闭窗口，尚待具体窗口协调，导航暂缓；这不是重新请求已有业务授权。若原页不可恢复，须先形成可证明终止的方案或取得用户具体窗口信息，不能猜另一页面替代、删锁或绕过锁。

恢复入口只指本 worktree 的 ignored `.agent-runs/TAX-COLLECTION-CHECKPOINT.json`，由 root 在本机核实；版本化文档不写真实引用、进程号、端口、URL 参数或业务值。旧 19 项文件最新核对全部未变；原后端 / 浏览器 / quarantine 保留。本轮另启的旧 v1 临时 HTTP 已核对身份后停止，避免继续用旧源。

P2 地域条件 / 分支输入绑定已迁移到 ignored 原型并完成其合成验证；该原型 108 项只作本机诊断研发事实，不属于本包生产成果。`candidate_only` 不能直接导航。P1 PR 已合并；真实恢复与新 v2 source / 两遍真实请求须另有现场证据，不能用本次合成通过代替。
