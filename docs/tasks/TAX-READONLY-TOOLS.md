# TAX-READONLY-TOOLS · 真实只读取数与申报准备工具

- 日期：2026-10-19；负责人 / GitHub：`huxiaoyang-code`。
- 状态：**工具前置包已独立验收并随 [PR #25](https://github.com/huxiaoyang-code/youshu-fork/pull/25) 合并交付**，管理者 15 套 530 项合成验证通过；真实浏览器只读尝试 3 次均未取得身份，首次业务成功 0，后端第二遍未运行。用户不希望点击探索，已改读取已加载代码 / performance 证据；当前观察已结束、Network.disable 成功，官方页保持打开，无导航 / 点击。
- 分叉基线：`158e266b3cb931b91d03a6e548a2d49dc8188481`（PR #24 merge）；分支：`codex/huxiaoyang-code/tax-readonly-tools`；独立 worktree，不修改 main。
- 认领：[Issue #20 评论](https://github.com/huxiaoyang-code/youshu-fork/issues/20#issuecomment-6270683815)；子 PR 使用 `Refs #20`，按业务引用 #13 / #14 / #17，不关闭总任务。
- 入口：[项目章程](../PROJECT-CHARTER.md)、[阶段状态](../handoffs/STATE.md)、[专项方案](../TAX-DATA-ACQUISITION-PLAN.md)、[上游任务](TAX-DATA-FIRST.md)、[现场 checkpoint](../handoffs/TAX-POSTLOGIN-CHECKPOINT.md)、[协作协议](../TEAM-COLLABORATION.md)、[本包交接](../handoffs/TAX-READONLY-TOOLS.md)。

## 当前授权与交付边界

本包按用户明确指示由 **Codex subagent 并行实施**，不调用 pi / Claude Code，不从旧本地员工范式推导阻塞。最终复核必须由**未参与实现、且不继承实施对话上下文**的独立 subagent 执行；管理者独立验收、执行 Git / PR 与已授权自动合并，不冒充另一人类成员或 GitHub 第二账号批准。本次例外不改全局 Skill。

目标是当前登录公司、当前待办期间的真实只读取数、申报准备与校验。“新公司”只表示首次接入产品。历史仅按结转、累计、优惠、更正等依赖补查；税局缺账务资料时优先读取已有本地账套，缺项由用户补。会计核心、连续导入、文件报表扩建继续暂停，只处理本专项必要阻塞。

本包**不执行正式申报、财报报送、缴款、更正、作废、备案变更**。准备包不等于可提交状态。自动点击浏览器与点击脚本禁止；不猜隐藏 URL、不批量扫描。有限只读探索已有授权，不再次询问是否开始；需重新登录时由用户在本机官方页面完成。

## 文件所有权与并行分工

远端认领与本表共同记录范围；评论不是技术互斥锁。合并前复核在途 PR 与最新 main，出现同文件未合并成果时串行协调。

| 唯一执行责任 | 文件 / 资源 | 边界 |
|---|---|---|
| 管理者 | 真实浏览器会话、Git / PR、最终整合 | 单一会话所有者；其他实施者不碰浏览器、真实数据或凭据 |
| 后端 subagent | `06-workbench/server/{tax-gateway,agent-tools,server,tax-acquisition,tax-local-boundary}.mjs`；`05-reconstruction/codex/mcp/finance-mcp/tax-tools.mjs` | 复用既有服务与注册，不提供任意 URL / 头透传；工具与精确支持边界见交接 |
| 规则 / 测试 subagent | `06-workbench/server/tax-preparation.mjs`；`06-workbench/test/{tax-acquisition,tax-preparation,server-local-boundary}.test.mjs`；`05-reconstruction/codex/mcp/finance-mcp/tax-acquisition-test.mjs`；`06-workbench/scripts/test-all.mjs`、`06-workbench/package.json` | 只用合成数据 / 安全契约，事项与规则未知时阻断就绪；测试入口共享修改由其唯一负责 |
| 文档 subagent | 本文件、`docs/handoffs/TAX-READONLY-TOOLS.md`、`docs/handoffs/STATE.md`、`docs/handoffs/TAX-POSTLOGIN-CHECKPOINT.md`、`docs/tasks/README.md` | 不改其他方案与全局 Skill，不读取真实原文 |
| 独立最终复核 subagent | 最终候选 diff、合成验证 | 不参与实现，不继承实施聊天；只报告发现与复现结果 |

## 业务信息与来源

逐类“信息—用途—来源—缺口”矩阵和证据索引在[本包交接](../handoffs/TAX-READONLY-TOOLS.md)。初始状态全部为未取得，不能用菜单可见、旧路径、HTTP 200、`Data` 或空列表证明成功。每个真实契约需记录方法、路径、参数结构、鉴权依赖类别、响应结构、业务成功条件、期间、分页及副作用；不记录凭据值。

首次必须观察真实请求与响应；第二次必须由本机后端重新实际请求。先验业务码、错误字段、企业作用域、结构与分页，再分类无记录 / 未取得 / 无权限 / 部分成功 / 失败。快照回放与合成适配器只能验逻辑，不能计入两次真实采集。

## 复用与安全契约

- 复用 tax-gateway、agent-tools、真实 agent / MCP 链、已有账套查询。默认真实适配器为空；未经验证的能力必须明确未支持。修正资源数组静默截断与覆盖表达，不能把截断当全量。
- PR #19 为 DOM 企业采集，不是 Network 业务采集器；只选择审查过的回环 / 同源等适用边界，不盲合并。现有导入会新建账套，不用导入冒充读取既有账套，也不新增一企一账套限制。
- 输入按业务能力限制，拒绝任意请求 URL / 头；读取重试限量且仅对已证实无副作用操作。识别会话过期、无权限、分页不全；异步迟到结果须重验会话及企业代次，不能写入另一企业。
- 每个申报字段关联税局证据 / 本地账套 / 用户材料 / 计算规则版本；期间、表单版本、完整性、表内表间关系、账税差异、结转和优惠条件分别校验。未知不填零，缺资料不生成可提交状态。
- 财报报送、纳税申报、缴款独立状态；税率 / 政策必须按地区及所属期核验官方有效来源，不能用模型记忆或候选待办推定全部义务。
- 真实业务处理仅在本机受限 Git 忽略目录，凭据、Cookie、token、票据、验证码不进入业务产物、日志、Git 或模型。模型及 subagent 仅得字段结构、合成样例、安全引用、缺项状态与覆盖摘要；真实身份、金额与材料仅本机可信预览。

## 验收与完成门槛

1. 代码及合成回归：覆盖未配置能力、输入拒绝、业务失败 / 无记录、分页部分成功、会话过期与切换后迟到结果、账套只读关联及材料缺口。
2. 接线：经真实 stdio MCP → 本机临时后端 → 业务工具链验收；孤立函数或聊天脚本不足以通过。
3. 真实联调：两批实际采集各有本机安全索引、企业 / 期间作用域与覆盖，差异有解释；未完成则如实标阻塞，不伪造接入。
4. 当前企业事项：认定、待办 / 已报、历史、事件与有效规则共同判断；资料不全只能返回缺项 / 待确认，不能宣布申报准备已完成。
5. 独立复核、验证、PR、已验证 head 合并及交接。代码交付与真实接入分别记状态；工具前置合并不表示整个专项完成。

管理者已实际运行 `npm test`，15 套 530 项 exit 0（原 439 项本次重跑，加本包 91 项）；独立最终复核通过候选 `64f66f94024104e3f1a57f0396360b49baabb708`，18 文件无剩余阻塞，不冒充第二账号批准。[PR #25](https://github.com/huxiaoyang-code/youshu-fork/pull/25) 于北京时间 2026-10-19 23:52:57 合并，merge `6df9404bab79e001526d30c21cccbc5679a88a80`，管理者已 fetch 核实。采集仅进程内元信息，`metadataOnly=true` / `evidencePersisted=false`；合成 MCP 链路不证明真实接入，未实现真实业务持久证据、适用规则与可提交包。回退通过新的 revert PR，不重写 main 历史。
