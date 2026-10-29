# Pi 主 Agent 接入

统一生成器支持 `--host pi`，复用既有 [finance-harness.ts](../../pi/finance-harness.ts) 和中文 Harness Skill。生成 `start-pi.mjs`、`pi-host.json`、`AGENTS.md`，入口从[统一接入指引](../START-HERE.md)开始，角色是持续核算主 Agent。完整 Harness 生命周期和 `finance_delegate_parser` 保留；不是仅供解析的角色模板。

先安装自己选择的官方 `@earendil-works/pi-coding-agent@1.1.0`，明确该包绝对目录；不使用本仓库作者机器的 npm 路径。先启动显式账库的本机财税后端，再在全新输出目录运行：

```powershell
node ./start-pi.mjs --pi-root '<官方 Pi 包绝对目录>' --check
node ./start-pi.mjs --pi-root '<官方 Pi 包绝对目录>'
```

`--check` 调用既有无模型探针：通过真实 Pi 扩展加载器、SDK 和原生 MCP，核对显式 `builtin:mcp`、`builtin:tool-search`、财税扩展、解析委派登记、延迟工具激活和中文 Skill 资源读取。它不调用模型，不证明解析子 Agent 或完整账务已验收。每次探针在输出目录独占创建新的 `.pi-check-<随机标识>`，不复用已有配置；保留每次检查现场。版本锁为已验证的 1.1.0，升级须重新验证。

正常命令启动交互会话，等待操作者输入任务。显式任务也可存为 UTF-8 文本：

```powershell
node ./start-pi.mjs --pi-root '<官方 Pi 包绝对目录>' --task-file '<明确任务.txt绝对路径>' --json
```

可用 `--tools '<显式工具子集>'` 缩小该次任务的工具范围；该参数要求同时提供任务文件。默认主 Agent 包含本地读写/运行代码、原生工具搜索、全部 Harness 及 Skill 工具和解析委派。`FINANCE_MCP_PROFILE=harness` 仅限制财税 MCP 工具面，不能据此宣称文件、网络或账库隔离。Pi 本身及解析器不是会计批准者，不自动编造复核或支付授权。

模型固定本人官方 `deepseek/deepseek-flash`、低思考强度，无备用提供商。本人的 `DEEPSEEK_API_KEY` 从当前进程环境提供，入口不读取/复制原用户 auth、配置或会话，不将密钥写入生成文件；独立 `.pi-agent` 供宿主运行时使用。显式 `--offline` 禁止在线刷新模型目录，不代表推理离线；模型请求仍发送到官方 DeepSeek。原生模型身份和协议依据见[既有 Pi 指引](../../pi/README.md)。默认生成器及回归测试不调用模型，真实模型验证需当次明确授权并保留实际回执。

## 官方 DeepSeek 有限实测

2026-10-29 已经用户当次授权，通过新生成的 `start-pi.mjs` 启动官方 Pi 1.1.0 原生 CLI，使用独立合成账套、独立工作区和本人官方 `deepseek-flash`。北京时间 18:43:02.541 至 18:43:15.565，耗时 13.024 秒；6 次官方 `/chat/completions` 请求均 HTTP 200，模型错误列表为空。

实际 6 次工具调用包括原生 `tool_search`，以及发现合同、初始化 Store、登记合成原件、登记金额事实、查询状态。原生 journal 中金额字符串为 `452.19`，证据 `kind=original`、原件第 2 行、quote、空字符串 `valuePath` 及保存原件的 SHA-256 均核对成功；任务与业务执行 attempts 均为 0。此次任务预先明确了正确的标量绑定合同，不能据此与其他宿主的首次绑定错误比较准确率。

该短流程只验证新主 Agent 入口、原生工具搜索、官方模型与财税 MCP 的有限元数据协作。解析子 Agent 未在本次模型运行中调用；凭证、期间核算、真实人审、申报与付款仍未验证。请求数、输出和超时限制来自本次临时网关，不是默认启动器的统一预算产品能力。四宿主合计请求和原始证据范围见[接入实测](../README.md#官方-deepseek-实测)及 PR。

## 可选 SoL-Pi

SoL-Pi 的 ObservationPack 通过[独立显式入口](../../../../06-workbench/scripts/sol-pi-run.mjs)接入，默认 `off`；现有 `start-pi.mjs` 保持 baseline。启用前准备固定完整依赖，并通过真实无模型探针；只允许 Pi，不打开其他三项机制或 Harness² 组合。命令、归档保留、窄适配与未验证范围见 [SoL-Pi 使用说明](../../../../docs/SOL-PI-INTEGRATION.md)。
