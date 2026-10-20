# TAX-COLLECTION-REBASE · 门户真实复采与继续入口

核心“门户契约 + 真实复采”已随 [PR #29](https://github.com/huxiaoyang-code/youshu-fork/pull/29) 于北京时间 **2026-10-20 13:44:12**（UTC `2026-10-20T05:44:12Z`）合并。最终 head `c1d663a7b107f8538e01100a37c0b1102b9c02aa`，merge `bdc6e9a1c26835889d873ea0af1c57ac35d292ce`；管理者已 fetch 核对，最终独立审查与 head 一致性核对通过。

日期：2026-10-20。负责人 `huxiaoyang-code`；[任务单](../tasks/TAX-COLLECTION-REBASE.md)、[采集契约](../TAX-COLLECTION-CONTRACT.md)。**本包门户只读资料与两次实际后端复采已验收并随 PR #29 合并；整个企业报税资料采集专项仍未完成。** 本文不含真实企业、期间、金额、凭据、运行引用、端口、进程或标签页标识。

## 当前已核验与恢复入口

- 分支 `codex/huxiaoyang-code/tax-collection-rebase`，分叉基线 `0345046ce40b644f26d4ea52adb362d040533bc2`；合并前重新核对最新 main 与在途共享变更。
- [Issue #20 本包实际范围登记](https://github.com/huxiaoyang-code/youshu-fork/issues/20#issuecomment-6283451754)已完成；评论不等于技术互斥，总任务 #20 / #13 / #14 / #17 保持开放。
- 最新本机恢复记录为本包 worktree 的 `.agent-runs/TAX-COLLECTION-CHECKPOINT.json`。先按该记录核实新 source、两次 run、当前 owner 与窗口；不从版本化文档拼接运行引用，不复制 registry / profile / 凭据或日志。
- 旧 19 个未提交文件的哈希全部保持不变，旧后端与登录窗口保留；未盲目重启、未恢复全部旧探索。旧 reader claim / quarantine 保持原样。
- 用户本次授权 Codex subagent 并行实施，最终由未参与实现且 `fork_turns=none` 的新 subagent 复核；管理者执行 Git / PR 与已有验收后自动合并授权，不冒充第二 GitHub 账号批准。

## 新解析与实际契约

用户本机 `etax_rea_work` 已由脚本安全解析：大型 JSON 共 5 条 records，浏览器场景 3 步、1,259 个事件；该输入主要描述登录门户。固定路径、源文件摘要、record ordinal 与静态字段见采集契约，原始 JSON / DOM / 响应 / 参数未进入模型或 Git。

`getMhsydbBqxx` 是门户底部版权，`listWntj` 是菜单推荐，均不能计为待办。真正的当前申报列表来自已观察 `wddbquerybbsmxx`；调用层 `{csbz:e}` 经官方 `e08f` / `qi` / `Gi` 拦截器把首字母转大写，wire 为 `{Csbz:e}`，不是 `Request.Data` 包装。该 wire 结构已在真实请求中匹配，原值只在本机处理。通知待办 `listNsrDbxx` 虽已观察，但本次没有预期四类列表，不统计完整待办覆盖。

## 本包真实结果

| 阶段 | 实际结果 | 证明范围 |
|---|---|---|
| 修复版正常导航形成新 source | 4 个被动请求，加 1 个主动身份复核；`identityProjectionMatched = true`，`scopeRevision = 0`，正确识别两次 initial clear，采集锁正常释放 | 新 source 已发布并本机持久化；是修复后的新记录，不是旧 provisional |
| 现有 MCP → HTTP → Agent → 后端第一次 collect | 3 个独立 fresh 请求，均 performed / complete；结果 `partial_observed`，6 行清单 | `documentScopeVerified = true`、`identityProjectionMatched = true`；完整企业业务作用域 / 期间仍未证实 |
| 同一链路第二次 collect | 再次实际发出 3 个 fresh 请求，均 performed / complete；不同 run 引用，仍 6 行 | 两次共 6 个实际后端请求，未以 source 回放或缓存代替 |
| source 与 run、两次 run 的本机比较 | `enterpriseEqual`、`identityProjectionEqual`、`filingProjectionEqual` 均 true；实际 compare 的 `independentRequests = true` | 白名单身份 / 清单投影相等，不推出所有业务字段或期间已完整 |
| 保留的限制 | 两次均 `businessScopeVerified = false`、`enterpriseVerified = false`、`periodVerified = false`、`projectionComplete = false` | 缺 `business_period`、`full_enterprise_profile`、`full_business_fields`，后续沿已授权同源业务页补齐 |

真实源响应当前申报列表为 **6 行，行字段异构**；曾观察到行字段数最大 32，`zspmDm` 仅 4 / 6 行存在。本包仅保存已确认白名单投影，不称全部字段已解释或覆盖。身份响应有 21 个字段，已核实的企业字段只用于本机前后比较；这不代替完整税费种认定 / 会计备案 / 表单 / 期间绑定。`sbqx` 与 `dbrwblsx` 是期限，不能推算所属期。

全程无自动点击、无正式申报 / 缴款 / 更正 / 作废 / 备案变更。认证、业务原值、原始本机标识与调试信息只留本机受限忽略目录，不进入模型、Git 或 PR；随机安全引用可由工具返回模型，但不写 Git / PR。

## 审查修复与历史记录

早期 source 因独立 P1 的被动采集期 hash 往返作用域漏洞仅标 provisional，不再用于当前运行。修复版曾因正常启动的双 context clear 被误拒为 scope_cleanup，并保留本包新锁；管理者随后显式受控 reload 恢复，仅释放该废弃新锁，`registrationChanged = false`、`browserClosed = false`。这些是历史诊断，**不是当前阻塞**。

实机证据确认两次 clear 均早于初始新主 frame。最终 bootstrap 仅在该初始 frame 尚未消费、任一新文档业务请求之前有界允许两次 clear；frame / 业务请求后的 clear、reply 前后任意 hash 往返均拒绝。完整 `observe → TaxCollectionStore → reload` 正反回归保留，修复后重新正常观察所得新 source 与上述两次实际 MCP 复采才是当前证据。

## 验证与最终验收

以下为实施者合成验证：独立临时目录、真实 schema / store 暂存发布回读 / profile 文件锁 / Agent / HTTP / stdio MCP，CDP 为合成传输；不使用真实 registry、登录态或业务数据做自动回归。

| 工作目录 | 命令 | 实际结果 |
|---|---|---|
| `06-workbench` | `node --test test/tax-live-collection-integration.test.mjs` | 15 / 15，exit 0 |
| `06-workbench` | `node ../05-reconstruction/codex/mcp/finance-mcp/tax-live-collection-test.mjs` | 13 / 13，exit 0 |
| `06-workbench` | `node --test test/tax-collection-observation.test.mjs` | 6 / 6，exit 0 |
| `06-workbench` | `node --test test/tax-collection-recovery.test.mjs` | 13 / 13，exit 0 |
| `06-workbench` | `node --test test/tax-browser-inventory.test.mjs test/tax-browser-diagnostic.test.mjs` | 合计 7 / 7，exit 0 |

同一冻结代码合计 **54 项 exit 0**，涵盖真实 store 完整持久链、双 clear / 任一业务请求门槛、reply 前后 hash 往返、私有字段泄漏、非法 recipe / source、独立 fresh proof、串企 / scope 变化、过期、错误响应、保留锁与显式恢复。管理者最终 `npm test` **23 / 23 套 exit 0**；未参与实现且 `fork_turns=none` 的独立 reviewer 已审当前代码无剩余阻塞，最终独审与 head 一致性核对已通过，核心 PR #29 已合并。实际 PR / head / merge 已补录；本轮只做合并后交接收尾。旧 19 项未提交文件哈希均未改变，旧 owner / browser / quarantine 保留。

安全引用可由工具返回模型，但不写 Git / PR；原始本机标识、调试信息、业务原值与凭据不进入模型或 Git。核心门户采集锁已正常释放，没有其历史废弃锁阻塞；后续原型锁状态另见下文。

## 合并后当前后续阶段

本次纯交接分支为 `codex/huxiaoyang-code/tax-collection-handoff`，基线为上述 PR #29 merge；管理者另开交接 PR，不改已冻结生产 / 测试代码。核心 EOF 空行仅为独立审查记录的非阻塞样式项，不据此宣称 `diff --check` 全绿。

新 source 刷新成功，实际 4 passive + 1 active identity verify。`candidate_only` 忽略目录原型经独立审查、49 项合成通过后，管理者真实 prepare 在 `identity_before` 失败；performed 计数 0 不等于未尝试。没有导航、没有 candidates，新 `business_page_prepare` scope 锁保留，当前正在审查安全诊断 / 受控 reload 恢复。

该锁属于后续原型，不是核心历史废弃锁复发，不推翻核心两次 MCP 六个实际请求及比较结论；合成通过也不提升原型实际取数状态。仍只从本机 checkpoint 恢复，不写实际 refs / PID / 端口，不盲解除锁或重启原 owner / browser。
## 后续工作与收尾

1. 核心 PR #29 已验收合并；本次仅补实际合并与当前后续状态，由管理者另开交接 PR。整个采集专项保持未完成，回退仍使用新的 revert PR，不重写 main。
2. 后续已授权从本机已观察行链接的静态消费者与已确认官方同源页面继续正常导航，先证明期间和完整企业业务作用域，再补税费种认定、备案 / 表单、当前义务与必要业务材料；不是等待用户输入，不猜隐藏接口，不调用带状态写入 / 票据副作用的依赖。
3. 补充资源逐项形成实际请求契约和本机证据，再经现有 MCP 后端独立复采；分别验证分页、稳定业务键、完整字段与企业 / 期间绑定。门户投影相等不代替后续业务覆盖。
4. 旧现场继续保留，不盲改旧窗口或后端。每部分验收 / PR 合并 / 交接后再结束其实施会话，下一部分用新会话载入最小任务包；真实资料不进入模型或 Git。
