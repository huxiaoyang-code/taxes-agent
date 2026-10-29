# Harness² 原生宿主进程合同

`buildHostSpec(options)` 为显式选定的 Pi、Claude Code、dsh 或 ZCode 构造原生进程。选择后三者不会转交 Pi。Pi 的包路径和加载方式复用既有 launcher；其余适配固定 Claude Code 2.1.309、dsh 0.2.1-rc.2、ZCode CLI 0.16.9，启动时先读取真实 `--version`，版本不匹配即退出。

这些是执行器，不是优化器：候选、组合和反思由本人Codex外层worker负责，DeepSeek仅供执行。共用参数为 `workspace`、`nodePath`、`apiBase`、`databasePath`、`candidateDir`、`mode: "check" | "run"`、`timeoutMs`。Pi 接收 `packageRoot`；其余三者接收明确 `cliPath`。run 另需 `taskFile` 和执行模型relay的 loopback `modelBaseUrl`。数据库、任务与候选须位于同一合成 workspace；候选正文从已通过外层树验证的 `candidateDir/SKILL.md` 加载。宿主层的路径检查不取代外层树、目标身份、模型出口和操作系统隔离检查。

每次在 workspace 下独占创建 `.host-<宿主>`，放置原生配置、全新 home 与不含密钥的进程计划。不读取或复制用户 auth、会话、全局设置。系统环境采用白名单；模型子进程只持本地网关占位 key。所有进程使用 `shell:false`；Windows `.cmd`、`.bat`、`.ps1` 明确拒绝，操作者应指定其实际 `.exe` 或包内 `.js/.cjs/.mjs` 入口。没有 PATH 探索、自动安装、升级或宿主回退。

`check` 不发送任务或模型请求：先对所选 MCP 执行真实 stdio `tools/list`，逐名核对显式预期集合。产品 Harness profile 当前为 15 项；production bridge 的研究代理明确为 10 项并排除 `harness_init`，不能将两个合同混用。Claude 在本次独立 home 注册明确 finance 后运行原生 MCP health check；dsh 再实际挂载原生 profile、MCP、restricted guard 和一个未提交任务的空 Agent，核对完整 MCP 集合及允许的 Agent 工具集合；ZCode 在 build 会话固定选择 `deepseek-flash`，记录原生实际reasoning/thought/output设置，仅操作者显式指定输出上限时核验该值，并核对初始 turn/token 均为零及 finance stdio 连接的预期工具数，然后 close/EOF。个人 provider 文件按固定版本的原生 codec 稳定顺序序列化，避免锁内规范化失败后被宿主恢复为空 registry。

Claude/dsh 使用 Anthropic Messages，ZCode 使用 Chat Completions。`anthropic-codec.mjs` 将限定的文字、thinking、tool-use/result 合同转换为同一个 Chat 上游，再生成 Anthropic JSON 或 SSE 回包。模型地址分别规范为同一执行relay的 `/anthropic` 与 `/v1`。默认记录和透传，不自行设置64KiB请求体或2048token输出限制；仅操作者显式设置的限额才启用。未指定输出参数时不由宿主/relay强行降额，不擅改thinking。未知内容类型与未支持协议字段明确拒绝。

run 计划保留原生 stream JSON / JSON / app-server 帧。MCP `content[].text` 内的业务错误会被解析并保留，不能用外层 `success:true` 代替业务结果。`host_result.status=completed` 仅表示进程/协议正常完成；Store 的 operationState、resultCurrent、confirmationCurrent 及独立业务评估由外层分别核验。历史工具错误保留为 `completed_with_tool_errors`。ZCode 对额外权限请求一律 deny，不使用 yolo 或绕过审批模式。

研究工具范围包含发现、来源/事实、plan/run、状态/回执及 Skill 查询，不包含`harness_init`，供已初始化合成 `period.inspect` 使用。有限工具名不能构成 capability 级白名单；研究代理另行强制唯一目标/Store和只读期间能力。Claude 内置工具为空；dsh 用原生 agent-scoped restrict/guard；ZCode 用会话 toolAllowlist。它们均不能代替操作系统文件隔离。

默认测试只使用 fake CLI 和合成临时目录，不调用模型：

```powershell
cd 06-workbench
node test/harness2-hosts.test.mjs
node test/harness2-hosts.test.mjs --native claude-code '<原生CLI绝对路径>'
node test/harness2-hosts.test.mjs --native dsh '<lib/bin.js绝对路径>'
node test/harness2-hosts.test.mjs --native zcode '<resources/glm/zcode.cjs绝对路径>'
node test/harness2-hosts.test.mjs --bridge-probe zcode '<resources/glm/zcode.cjs绝对路径>'
node test/harness2-hosts.test.mjs --native-run dsh '<lib/bin.js绝对路径>' --out '<全新绝对合成目录>'
```

`--native` 验证产品 profile 无模型探针；`--bridge-probe` 则从实际 production `prepare → dispatch` 路径构建宿主，验证研究代理的精确 10 项工具合同。默认回归也从该路径检查三宿主的 fake-CLI 接线。`--native-run` 启动真实宿主、真实产品 MCP 和合成后端，但模型响应完全由本机脚本产生，经执行器专用relay 执行一次 `harness_discover(period.inspect)`。该测试明确标记 `mockModelTransport`、`paidModelInvoked:false`，不是付费模型验收。模型请求只保存路径、字段名、角色、block 类型及预算元数据，不新增原始工具参数日志。

原生探针默认在仓库已忽略的 `06-workbench/tmp/` 留存本机证据，也可用 `--out` 指向全新合成目录，适合 `/repo` 只读的 Linux namespace。输出目录内有 `native.stdout.jsonl`、`native.stderr.log`；mock 测试另有受控总账与摘要。普通回归仍用操作系统临时目录。Windows 沙箱中三宿主原生 mock TCP 请求都曾被 `EACCES` 拒绝，正式扩大权限的请求也被自动审批拒绝，故不能把这些失败计为 run 通过；获准 Linux namespace 的原生测试需要独立记录。

受外层监督时，内部宿主继承外层进程组，不另行 detached。内部超时会关闭本次捕获管道并退出，由拥有该进程组的外层在 finally 清理剩余后代。POSIX 回归覆盖三代进程的外层超时/取消和内层超时；Windows 尝试 `System32/taskkill.exe /T /F`，沙箱拒绝时仅停止直接子进程不能证明全部后代退出。各平台实际结果需分别记录。配置、探针和 fake-CLI 合同通过均不解除目标/OS隔离，也不替代真实模型及业务验收。Codex本人外层worker的read-only＋禁shell/web/MCP也不等于候选namespace，它是可信优化器宿主；候选仍不能看到主机home或WindowsInterop。
