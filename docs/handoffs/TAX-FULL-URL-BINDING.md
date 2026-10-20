# TAX-FULL-URL-BINDING · 当前交接

日期：2026-10-20。负责人：`huxiaoyang-code`。本包为完整 URL 绑定 P1 修复，不是业务采集完成声明。必读：[任务单](../tasks/TAX-FULL-URL-BINDING.md)、[契约](../TAX-COLLECTION-CONTRACT.md)、[原采集交接](TAX-COLLECTION-REBASE.md)。本包核心已随 PR #31 验收合并；本轮仅补合并后纯交接，不预填交接 PR 自身未知提交信息。

## 已合并历史与本包基线

| 包 | 可核验提交 | 结果边界 |
|---|---|---|
| [PR #29](https://github.com/huxiaoyang-code/youshu-fork/pull/29) 核心 | head `c1d663a7b107f8538e01100a37c0b1102b9c02aa`；merge `bdc6e9a1c26835889d873ea0af1c57ac35d292ce`；UTC `2026-10-20T05:44:12Z` | 门户契约及两次真实 MCP 复采的历史验收 |
| [PR #30](https://github.com/huxiaoyang-code/youshu-fork/pull/30) 文档 | head `6e322e3f435a862523f40df9f9e427f812c72390`；merge `846ff0a988460de0e9a1c5afa92298a7633995e8`；UTC `2026-10-20T05:50:46Z` | 合并后文档收尾；本包基线 |
| [PR #31](https://github.com/huxiaoyang-code/youshu-fork/pull/31) 完整 URL P1 | head `57aeb06cf9236fbc7a1a75e14f737c6ca3b793f6`；merge `75eebbbfb78adfaf88be35a2e1080b5432764126`；UTC `2026-10-20T06:13:58Z`（北京时间 14:13:58） | 最终 fresh 独审 13 文件 exact head / tree 通过、无阻塞；管理者已导入核对真实签名 merge 对象及树一致 |

实施分支 `codex/huxiaoyang-code/tax-business-pages`；当前纯交接分支 `codex/huxiaoyang-code/tax-full-url-handoff`，基线为 PR #31 merge。root 唯一操作真实会话并管理 Git；实施者仅必要代码 / 合成材料，文档单一所有权，最终由未参与实施、不继承上下文的新 subagent 独审。用户本轮明确授权该 Codex subagent 方式。

PR #29 两次原 MCP stdio → 隔离 HTTP → Agent → 后端各 3 个 fresh 请求、各 6 行，source / run 与 run / run 三项投影相等，仍是已验历史。新 P1 不证明现场曾发生 fragment 切换，但旧 `documentScopeVerified = true` 不能证明完整 URL 绑定。`businessScopeVerified`、`enterpriseVerified`、`periodVerified`、`projectionComplete` 仍 false，缺 `business_period`、`full_enterprise_profile`、`full_business_fields`。

## P1 修复与验证

CDP `Frame.url` 不包含 fragment，另有 `urlFragment`，见[官方协议](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/pdl/domains/Page.pdl)。独立纯合成审查证实旧代码只摘要基础 URL，监听开始前 fragment 切换可能被接受。

本包 7 个代码 / 测试文件已冻结：严格 fullFrameUrl 组合，保留单个 `#` 语义并拒绝矛盾异常；source v2 新增 `documentUrlSemantics = 'cdp_frame_url_plus_fragment_v1'`，新 save 只写 v2，strict load / compare 保留 v1 历史，active 在 open / lock 前拒绝 v1；assert 只在内部返回完整 URL，页面内请求脚本在 fetch 前精确比对 `expectedFullUrl`，防止 host → evaluate 空窗。URL 原值和摘要不输出。

- 作者采集合成 59 项 exit 0。
- 管理者在 `06-workbench` 运行 `npm test`，23 / 23 套 exit 0。首轮 workflow 原生异常，单独与整轮复跑均 exit 0，未据此改代码。
- 未参与实施、`fork_turns = none` 的独立 reviewer 已审 core 7 文件无剩余阻塞，并独立 59 / 59 exit 0；最终 fresh 独审 13 文件 exact head / tree 亦通过、无阻塞，PR #31 已合并。core 7 文件未变，23 / 59 不重复运行；不含 scratch 恢复执行或导航。
- 新 v2 实机 source 形成与复采尚未运行；旧 v1 源不得再主动使用。本轮另启的旧 v1 临时 HTTP 已身份核对后停止，原后端 / 浏览器保留。

## 当前真实现场与锁

后续 ignored `candidate_only` 原型实际 prepare 在 `identity_before` 失败，`performedCount = 0` 不代表未尝试；未导航、未形成候选，`business_page_prepare` 新锁保留，独审禁止盲目解锁。历史已释放的核心采集锁与当前新锁必须区分。

默认恢复诊断未 reload / unlock。经独审后，root 用 `filter: [{}]` 显式全包含目标清单复核，`exactTargetMatchCount = 0`；owner 已停止、source 绑定匹配；未 attach / read frame，返回 `recovery_target_ambiguous`、cleanup 成功。不能由目标缺席推断 realm 销毁，不能将通用 CDP 错误或两次快照缺席作销毁证明，也不能把缺目标归因 fragment。root 没有关闭任何税局页。

root 已向用户核实是否正在手动使用 / 关闭税局窗口，尚待具体窗口协调，导航暂缓。正常导航原授权仍有效，不重复申请同一授权。原页若不能恢复，须先提出可证明终止方案或取得用户具体窗口信息；不得猜别页替代、删除 / 绕过当前锁或改旧 quarantine。

恢复只由 root 在本机查本 worktree ignored `.agent-runs/TAX-COLLECTION-CHECKPOINT.json`；文档不保存实际引用、PID、端口、URL 参数、凭据及业务值。旧 19 项未提交文件最新内容哈希均未变；原 owner / browser / quarantine 保留。

ignored 候选原型已适配 v2 / full URL、v1 提前拒绝与 P2 地域条件 / 分支输入前后绑定，诊断目标清单使用显式全包含 filter，108 项合成通过。它不纳本包 Git，也不是生产成果；`candidate_only` 不能直接导航。

## 下一步与完成限制

1. P1 core 与本包文档已完成最终独审、head / tree 核对并随 PR #31 合并；当前完成纯交接收尾。已有自动合并授权仍须验收，不冒充 GitHub 第二账号批准。
2. 协调具体窗口并保留锁；满足可证明恢复 / 终止条件前不导航、不解锁。不能为通过验证任意重启原后端或关闭原页。
3. 安全恢复后重新形成 v2 source，再沿已证实同源业务页补期间、企业资料与完整字段，重新实际后端请求并按企业 / 期间核对。未执行阶段据实记 `not_run`。

用户原目标未变：现有本机登录态、当前企业 / 待办期间资料；允许正常导航，禁止自动点击、隐藏接口猜测及正式申报、财报报送、缴款、更正、作废、备案变更或副作用不明操作。原值 / 凭据仅在本机，安全引用不写 Git / PR。代码和合成验收不代表全国真实接入，整个专项仍未完成。
