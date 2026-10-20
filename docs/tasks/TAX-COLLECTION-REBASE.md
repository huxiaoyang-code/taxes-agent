# TAX-COLLECTION-REBASE · 真实税局采集重整

核心“门户契约 + 真实复采”已随 [PR #29](https://github.com/huxiaoyang-code/youshu-fork/pull/29) 于北京时间 **2026-10-20 13:44:12**（UTC `2026-10-20T05:44:12Z`）合并。最终 head `c1d663a7b107f8538e01100a37c0b1102b9c02aa`，merge `bdc6e9a1c26835889d873ea0af1c57ac35d292ce`；管理者已 fetch 核对，最终独立审查与 head 一致性核对通过。

日期：2026-10-20。负责人：`huxiaoyang-code`。本包“门户契约 + 真实复采”已验收并随 PR #29 合并；整个企业报税资料采集专项仍未完成。

- 基线：`0345046ce40b644f26d4ea52adb362d040533bc2`；独立分支：`codex/huxiaoyang-code/tax-collection-rebase`。
- 关联总任务：Refs #20，按业务 Refs #13 / #14 / #17；不关闭总任务，不盲合并旧 PR。
- [本包实际范围登记](https://github.com/huxiaoyang-code/youshu-fork/issues/20#issuecomment-6283451754)已完成；登记不等于技术互斥，合并前仍核对在途共享变更。
- 必读：[项目章程](../PROJECT-CHARTER.md)、[STATE](../handoffs/STATE.md)、[采集契约](../TAX-COLLECTION-CONTRACT.md)、[本包交接](../handoffs/TAX-COLLECTION-REBASE.md)。旧任务记录用于追溯，用户本次新解析与新约束优先。

## 目标与有效授权

用本机现有有效登录态取得当前企业、当前待办期间的报税相关企业资料与业务信息。先由已确认页面 / 请求建立真实业务证据，再经项目现有 Agent / MCP → 后端独立发出实际请求，核对资源、企业与期间覆盖。工具存在、页面可见、HTTP 200、静态候选、合成测试通过或快照回放均不能代替完成。

本次用户明确要求 Codex subagent 并行实施，覆盖旧 pi / Claude Code 实施范式；最终由未参与实现、`fork_turns=none` 的新独立 subagent 审查。管理者执行 Git / PR，沿用 `huxiaoyang-code` 已有验收后自动合并授权，不冒充 GitHub 第二账号批准。

允许正常页面导航；禁止自动点击。只使用已确认页面、加载代码及实际请求，不猜隐藏接口。禁止正式申报、财报报送、缴款、更正、作废、备案变更及副作用不明操作；标记已读、更新状态等写操作不得因位于查询页面而混入白名单。真实数据仅在本机处理，凭据与业务原值不得进入模型、Git、PR 或日志。

## 恢复与新证据结论

当前恢复只查本包 worktree 的 `.agent-runs/TAX-COLLECTION-CHECKPOINT.json`，据实核对引用、进程及窗口，不从版本化文档拼接运行标识。旧 19 项未提交文件哈希均未改变；旧 owner / browser / 登录态 / quarantine 保留，不盲目重启原后端。旧代码按需审查复用，恢复全部旧探索不是前置条件。

用户新解析目录 `etax_rea_work` 是首要依据。大型 JSON 先由本机脚本解析，禁止直接读取原文或回传对象 / DOM / 响应片段。只输出固定分类、计数、无参数静态官方路径和已由静态代码确认的字段名。报告也先本机扫描敏感项。

输入解析的浏览器场景为 3 步、1,259 个事件，主要覆盖门户与认证；本包随后真实运行的结果不得倒填到原输入。版权接口 `getMhsydbBqxx` 与菜单推荐 `listWntj` 不计待办；`listNsrDbxx` 已实际观察但业务状态失败、缺预期列表。当前申报 `wddbquerybbsmxx` 的真实 wire `{Csbz:e}` 已匹配，详见契约证据表。

## 文件与会话所有权

| 责任人 | 范围 | 限制 |
|---|---|---|
| root 管理者 | 真实浏览器 / 后端现场、最小 checkpoint、安全运行摘要、Git / PR 与整合 | 唯一真实会话操作者，避免并发导航和请求；不覆写旧窗口成果 |
| backend_collection subagent | 经管理者明确派发的后端采集、Agent / MCP 接线及相关合成回归文件 | 仅接收安全结构 / 合成材料，不读取真实凭据和业务原值；共享文件单一编辑者 |
| collection_contract subagent | 原负责本任务、采集契约、交接及三份状态索引；管理者已将最终六份文档所有权交给 backend_collection，原作者已停写。仍保留其指定合成集成 / 恢复测试成果 | 真实 store / MCP / 临时锁但 fake CDP，不读真实 registry，不操作真实浏览器 / 后端，不 Git |
| 最终独立 reviewer | 完整候选 diff、验收与边界审查 | 未参与实现，不继承实施上下文；发现问题退回实施者 |

生产与测试文件精确清单由管理者在实际派工 / PR 中登记；未经交接不增加同文件并发编辑。三份共享状态索引仅由文档实施者按管理者现场结果最小更新，管理者负责整合。

## 执行提示词

> 接手 TAX-COLLECTION-REBASE，先读章程、STATE、本任务、采集契约和最小现场 checkpoint。以用户新页面解析为主要证据；保留旧未提交代码与登录窗口，不重启未知归属后端。先本机安全提取结构，再由唯一真实会话操作者沿已确认页面正常导航、观察实际业务请求。严禁自动点击、隐藏接口猜测及任何申报 / 缴款 / 更正 / 作废 / 备案变更；发现可能标记已读或更新状态的接口立即排除。先证明当前企业及待办期间，再最小读取企业资料、认定、当前待办 / 已报、表单与材料缺项；历史仅补当前事项的必要依赖。把已确认只读请求固定到现有 Agent / MCP 后端，经后端重新实际请求，以独立运行证据核对同一企业、期间、分页和字段覆盖。原始业务数据与认证只留本机；模型只收固定状态、计数、schema、安全引用和缺项。不能把版权、菜单推荐、HTTP 200、静态路径或合成测试计为真实业务成功。按唯一文件所有权实施并自测，不 Git；最终交给无实施上下文的新独立 reviewer，管理者验收后执行 PR / 自动合并。

## 验收与未完成处理

1. 企业绑定有真实成功证据，个人 / 代理身份与当前企业明确区分；期间来自当前业务响应，不用系统日期或申报截止提示推算。
2. 每个必要资源保存请求来源等级、只读判断、固定方法 / 路径、参数形状、schema、业务成功条件、分页终点与企业 / 期间绑定；原值仅本机。
3. 首次实际采集与 Agent / MCP 后端再次实际采集各有独立安全证据。第二遍不得复用首遍响应或缓存冒充重发；真实请求次数、成功资源数与未运行项分列。
4. 本机核对同主体 / 同期间、稳定业务键、记录与字段覆盖、分页完整性；动态变更不强求字节相同，但必须解释差异。未知、空列表、无权限、未登录、部分成功和失败不得混同。
5. 缺企业、期间、义务清单或关键资料时状态为未完成，列精确缺口。合成测试只证明实现逻辑；不得在真实数据上运行自动回归。
6. 管理者记录实际验证命令、目录、退出码和完整候选 head；独立 reviewer 通过后才按已有授权开 / 合 PR。合并 SHA 与交接随后据实补录，回退使用新的 revert PR。

当前新 source 已实际成功：4 个被动请求 + 1 个主动身份复核，新 context / loader、`scopeRevision = 0`、`identityProjectionMatched = true`，新锁正常释放。原 MCP stdio → 隔离 HTTP → Agent → 后端两次各发出 3 个 fresh 请求，均 performed / complete，合计 6 个实际请求，形成不同 run 引用；source / run 及 run / run 的 `enterpriseEqual`、`identityProjectionEqual`、`filingProjectionEqual` 均 true，`independentRequests = true`，各有 6 行。

行字段异构，曾观察到行字段数最大 32，`zspmDm` 仅 4 / 6 行存在。`documentScopeVerified = true`，但 `businessScopeVerified`、`enterpriseVerified`、`periodVerified`、`projectionComplete` 均 false；仍缺 `business_period`、`full_enterprise_profile`、`full_business_fields`。早期 provisional 已废弃，`scope_cleanup` 与废弃新锁恢复仅是历史，当前无该锁阻塞。后续已授权沿真实同源业务页补期间与资料，不是等待用户输入。

管理者最终 `npm test` **23 / 23 套 exit 0**，本包新增合成回归 **54 项 exit 0**。未参与实现、`fork_turns=none` 的独立 reviewer 已审当前代码无剩余阻塞，最终独审与 head 一致性核对已通过，核心 PR #29 已合并。实际 PR / head / merge 已补录；本轮只做合并后交接收尾。安全引用可由工具返回模型，但不写 Git / PR；凭据、业务原值、原始本机标识及调试信息不进入模型或 Git。本次六份文档最终所有权已由管理者从 collection_contract 交接给 backend_collection，原文档实施者已停写。
