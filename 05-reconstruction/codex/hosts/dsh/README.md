# dsh 接入

使用 DeepSeek 官方 `@deepseek-ai/dsh`，配置按 `0.2.1-rc.2` 发布包核对。该宿主仍在预览阶段，升级后应重新验证配置。适配器只生成文件，不安装宿主、不读取模型凭据，也不改 `~/.dsh` 或已有 profile。

通过仓库的多宿主配置生成器选择 `dsh`，显式指定 Node、后端、本机账库与全新输出目录。输出 `finance.cordis.patch.yml` 是 JSON 序列化的合法 YAML patch，使用官方 `@deepseek-ai/dsh-mcp-client` 的 stdio 连接；`AGENTS.md` 是入口指引，业务细节仍从 `skills_read` 读取仓库现有中文 Skill。

## 加载

先启动绑定同一显式账库的财税后端。以下 PowerShell 命令在**生成目录**运行，`dsh` 应已通过操作者选择的方式安装；不要把占位路径直接执行。

```powershell
$env:DSH_HOME = '<生成目录旁的独立 dsh-home 绝对路径>'
$env:DSH_TELEMETRY_DISABLED = '1'
$env:DSH_PERMISSION_MODE = 'workspace-write'
dsh --version
dsh --profile headless --patch ./finance.cordis.patch.yml --dump-config
```

`--dump-config` 仅组合配置，不启动模型，但会在指定的 `DSH_HOME` 初始化 profile 文件。检查输出里 finance 连接的命令、目录和四项环境变量，及 `session-log-deepseek.enabled=false`、`session-telemetry-otel.disabled=true`。必须确认 patch 没有未匹配目标警告。输出含本机路径，不作为公开业务日志上传。

准备真实任务且确认资料披露范围后，仍在生成目录启动：

```powershell
dsh --profile headless --patch ./finance.cordis.patch.yml '先读取 AGENTS.md 和 finance 的 harness/SKILL.md，再查询指定企业的实际状态；保留未完成项。'
```

launcher 的 `--profile` 和 `--patch` 必须在任务文本前。不要使用 `--from-default-profile` 更新已有工作 profile：该参数会替换目标 profile。示例使用独立 home 下自动初始化的 headless profile，不打开 Web 窗口。

模型凭据由操作者按 dsh 原生方式配置；本适配不复制 Pi、Claude 或同事的凭据，不设置默认模型或跨服务回退。关闭额外 Session-log/OTel 上传不代表模型请求不含业务资料；真实资料仍遵守项目的本机与外发授权边界。

## 边界

finance MCP 设置 `FINANCE_MCP_PROFILE=harness`，仅开放 Harness 与 Skill 工具，直接猜测其它工具名也被服务器拒绝。现有服务器默认工具集保持兼容；该 profile 不是只读模式，Harness 中已有写能力仍需业务授权与人审。

dsh 自身 shell、文件工具、插件和其它 MCP 的权限另由宿主管理；本机 shell 可以接触的文件不能靠本模板宣称隔离。这里没有迁移 Pi 的 `finance_delegate_parser`、父子进程工具限制或费用统计；默认 dsh 子 Agent 会继承宿主服务，不能当作同等受控解析器。先保留现有 Pi 适配，按原件、事实、任务和操作身份接续既有 Store，不并发操作同一任务，也不搬运宿主的私人会话历史。

## 依据与验证范围

- [dsh CLI 与配置加载](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/README.md)
- [官方 MCP 客户端](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/mcp/mcp-client/README.md)
- [本地 Skill 根目录](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/skill/skill-filesystem/README.md)
- [额外 Session-log 上传配置](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/session/session-log-deepseek/README.md)

本次已局部安装 npm 官方 `@deepseek-ai/dsh@0.2.1-rc.2`（不全局安装），实际运行 `--version`、`--help` 和独立 `DSH_HOME` 下的 `--profile headless --patch <生成文件> --dump-config`，均正常退出；原生展开后的配置经解析确认 MCP 目标环境、Skill 自定义根与两项上传关闭值生效，stderr 无未匹配 patch 警告。

这项验证没有启动 dsh 插件树、没有建立 dsh 本体的 MCP 连接，也没有执行模型。仓库的标准 stdio 测试与本体配置展开是不同证据，不能用其中一项代替另一项或完整账务验收。默认生成器和测试不调用模型、不执行税局申报或付款。
