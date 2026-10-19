# TAX-SESSION-DISCOVERY · 本机登录态与真实业务取数

- 日期：2026-10-20；负责人：`huxiaoyang-code`。
- 状态：**连接前置与必要 DTO 去重修复已实现并通过验证，草稿 [PR #27](https://github.com/huxiaoyang-code/youshu-fork/pull/27)，待完整候选最终复核 / 合并；真实取数未完成**。用户已反馈“登录遇到问题，稍后说明”，当前等具体问题；不重复要求点击探索。
- 本包基线：最新 `origin/main` `17a053bfb66b482064ed92aa343ab42c41d47825`；独立分支 `codex/huxiaoyang-code/tax-session-discovery`，复用已隔离 worktree，不直接修改 main。
- 关联：`Refs #20`；[本包范围登记](https://github.com/huxiaoyang-code/youshu-fork/issues/20#issuecomment-6272100523)、[扩展文件范围登记](https://github.com/huxiaoyang-code/youshu-fork/issues/20#issuecomment-6272266944)。按业务引用 #13 / #14 / #17，总任务保持开放。已有 PR #18 / #19 不盲合并。
- 必读：[章程](../PROJECT-CHARTER.md)、[STATE](../handoffs/STATE.md)、[业务方案](../TAX-DATA-ACQUISITION-PLAN.md)、[上一包交接](../handoffs/TAX-READONLY-TOOLS.md)、[本包发现交接](../handoffs/TAX-SESSION-DISCOVERY.md)。

## 目标与完成定义

用户明确要求继续充分探索，最终是**用操作者现有本机有效登录态，实际取得当前试点企业及报税所需业务信息**，再通过本机后端与真实 agent / MCP 链重复取得。空注册工具、静态路径发现、合成响应或失败请求均不能替代该目标。

首个试点仍为当前登录公司、当前待办期间；先身份 / 授权 / 企业档案与认定，再当前事项，历史仅按结转、累计、优惠或更正依赖补查。税局缺账务资料时优先已有本地账套，缺项列清单由用户补；本包不扩建会计核心、连续导入或文件报表。

前包已交付 5 个安全工具的元信息前置能力，但真实适配器、持久业务证据、适用表单 / 规则与可提交准备包仍未交付。其 `sourceRef` 仅进程内元信息，不能当作本机可解析业务材料。本包必须按真实证据继续补齐，不能把前包 530 项合成通过再报为真实接入完成。

## 授权与实施方式

用户已授权当前企业有限只读探索；无需重复询问是否开始。自动点击浏览器 / 点击脚本路线仍禁止，用户也不希望手动点击各办税模块以配合探索。只从已加载代码和实际请求证据确定候选，不猜隐藏 URL、不批量扫描。需要登录时仅请操作者在本机官方页面完成；凭据 / 验证码不进入模型。

Codex subagent 并行实施，覆盖本包旧 pi / Claude Code 范式；不改全局 Skill。最终由**未参与实现、`fork_turns=none`** 的新独立 subagent 复核，管理者执行 Git / PR 与既有自动合并授权，不冒充 GitHub 第二账号批准。

不执行正式申报、财报报送、缴款、更正、作废、备案变更；副作用未明的签票、身份切换等不自动纳入只读白名单。

## 当前文件与会话所有权

| 唯一负责人 | 本包职责 / 文件范围 | 限制 |
|---|---|---|
| root 管理者 | 真实浏览器会话、已加载代码 / 请求观察、真实契约、安全事实摘要、Git / PR | 唯一真实会话操作者；不与其他窗口同时操作 |
| integration_path subagent | 新 `06-workbench/server/tax-browser-transport.mjs`、`tax-fujian-session.mjs`；现 `06-workbench/server/agent-tools.mjs`、`server.mjs`；`05-reconstruction/codex/mcp/finance-mcp/tax-tools.mjs`、`backend.mjs` | 6 个生产文件已冻结：专用 Edge open / probe / close、服务正常信号关闭、MCP open 60 秒时限；原真实页仍归 root，不生成 fake gateway 会话 |
| data_contract subagent | 已完成 `06-workbench/server/tax-gateway.mjs` 的 DTO 分页去重修复及 `06-workbench/test/tax-acquisition.test.mjs` 回归；新增 `06-workbench/test/tax-browser-session.test.mjs`、`05-reconstruction/codex/mcp/finance-mcp/tax-browser-session-test.mjs`；`06-workbench/package.json`、`scripts/test-all.mjs` | DTO 59/59 已通过；gateway 后续所有权交还管理者 / integration_path，data_contract 不再编辑；新通道测试只用 fake process / CDP、临时 HTTP + MCP，不启动真实 Edge |
| handoff 文档 subagent | `docs/tasks/TAX-SESSION-DISCOVERY.md`、`docs/handoffs/TAX-SESSION-DISCOVERY.md`；追加 `docs/handoffs/STATE.md`、`NEXT-SESSION.md`、`docs/tasks/README.md` | 3 个旧入口仅最小当前状态更新，保留历史；不操作 Git |
| 独立最终 review subagent | 最终候选内容审查与复验 | 未参与实现，不继承实施上下文；完成后才报告结论 |

本包已远端登记，但评论不等于技术互斥。上述 gateway 所有权移交串行执行，不同实施者不同时改同文件；新增范围由管理者核实在途工作后登记，不覆盖别的成员成果。

## 必须取得的证据

1. **当前有效会话与企业作用域**：实际响应同时通过 HTTP、业务码 / 错误字段、schema 与主体校验；菜单、无登录提示、HTTP 200 不足以证明身份。无法识别的错误码保持未知。
2. **第一遍真实契约**：记录实际方法 / 路径、正常参数、鉴权依赖类别、响应结构、业务成功条件、日期 / 分页与副作用；只传安全结构和摘要，不传凭据与业务原文。
3. **后端第二遍实际请求**：复用既有 tax-gateway / agent-tools / MCP；连接通道必须在产品后端真实可用，不能以 Codex 浏览器工具代替。重新采集的安全证据与第一遍分别保存，快照回放不通过。
4. **范围与可重复性**：企业 / 期间一致、分页完整、有界重试、身份切换后迟到结果拒绝；稳定业务键与重复 / 冲突可追溯，未知 / 无记录 / 无权限 / 部分成功 / 失败明确分类。
5. **当前业务材料**：按认定、待办 / 已报、必要历史、企业事件与官方有效规则判断事项；真实字段来源与材料缺口保留本机，未知不填零，缺资料不产生可提交状态。

真实数据只能在本机受限、Git 忽略目录保存和处理；认证头、Cookie、token、票据、验证码不得入业务产物、日志、Git 或模型。模型 / subagent 仅收结构、合成样例、安全引用、缺项和覆盖摘要。真实身份、金额与材料仅供本机可信预览。

## 当前阻塞与验收安排

原页面探索得到身份读取 HTTP 200 / code `9997`、档案查询不透明重定向，以及官方首页 reload 后实际到统一登录入口；详情在本包交接。用户已反馈登录遇到问题、稍后说明，当前等其具体问题，未取得有效企业身份，登录完成前不继续业务采集。

已实现 3 个工具：`tax_browser_open({region:'350000'})`、`tax_browser_probe({connectionId})`、`tax_browser_close({connectionId})`。本机受限临时 profile 启动专用 Edge，用户人工登录；固定已观察身份路径，安全结构 / 状态输出，不导出 Cookie、不自动点击、不创建 gateway 会话 / 真实适配器、不持久化业务证据。登录问题解决后优先经此后端专用窗口人工登录一次，继续真实 schema / 企业 / 业务采集；不会复制原窗口凭据。

管理者 `npm test` **17 套全部通过，exit 0**；独立复验 DTO **59/59**、浏览器模块 **46/46**、MCP 合成 **4/4**，额外迟到 attach / 多阶段清理失败恢复验证通过，已无代码阻塞，最终候选 head / 文档终审仍待完成。管理者另经真实 MCP → HTTP → Agent → 专用 Edge 验证 open=`needs_login`、probe=`login_required` 且 `requestPerformed=false`、close=`closed` 且 profile 清理成功；这是实机通道验证，**业务请求 0、业务成功 0、第二遍业务采集未运行**。安全证据引用见交接，草稿 PR #27 已创建，待完整候选最终复核 / 合并，不预报合并。回退通过新 revert PR，不重写 main 历史。
