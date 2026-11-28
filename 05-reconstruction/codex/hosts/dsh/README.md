# 当前直接业务接入

本页当前入口采用中国化业务 Skill＋原生 MCP，使用 `FINANCE_MCP_PROFILE=direct`。Agent自主选择工具，后台完整自动记录；不要求来源/事实登记、Store或任务DAG。生成器固定使用同仓库 `plugins/finance/skills`，无需第二次 clone，不接受外部插件路径；用 `--audit-dir` 指定本机记录目录。

接入步骤以 [统一入口](../START-HERE.md) 为准；工具结果按账本金额→凭证/计算结果→规则依据→工具调用→输入与原件展示，日常前三项、异常再展开后两项。真实写入仍遵守现有工具约束；配置、无模型协议检查和实际模型业务验收分别记录。
当前finance.cordis.patch.yml绑定direct MCP和选定技能目录；Session-log额外上传及OTel关闭，模型overlay由操作者按本人服务配置。以 --patch 显式加载，不修改全局配置或安装额外角色。

已有账套按[账套记忆](../BUSINESS-MEMORY.md)绑定，再通过 `node start-business-session.mjs -- --dsh-cli '<实际 JS 入口>' --task '<明确任务>'` 进入。dsh 按本次任务前的指引和绑定中的 `memoryPath`，用本机文件工具读取当期适用口径并在需要时编辑。

整期目标先读 `tax-period/SKILL.md`。生成的 `start-dsh.mjs` 将共享短路由置于明确任务文本前，再调用已有 CLI 的 `--profile headless --patch <finance> --patch <model> <任务>`，不假定存在 prompt 配置字段。先按下方模型设置准备本人 `model.cordis.patch.yml`，在生成目录运行 `node ./start-dsh.mjs --dsh-cli '<dsh包JS bin绝对路径>' --task '完成本期账税'`；可加 `--model-patch <已有覆盖层绝对路径>`。单项任务仍带同一边界说明。AGENTS.md 同时保留供显式阅读；直接执行原始 dsh 命令会绕过包装。程序测试仅证明包装转交的参数、技能目录及真实 MCP 读取，不声称本次运行了真实 dsh 模型。
