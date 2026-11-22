# 财税 Agent 的合成验收

所有命令从仓库根运行。程序与宿主探针可以独立执行。受测模型的运行另按操作者批准的宿主、模型、工具和预算执行。

| 要交付的业务结果 | 交给 Agent 的任务 | 验收者独立检查 |
|---|---|---|
| 凭证自主核对与更正 | 核对十月银行账，把这个月的错误处理完，把会计要用的表放到工作区。 | 比对 SQLite 的金额、客户、日期、合法缴税时差、过账状态和更正事件。读实际 CSV 复算小计。 |
| 已办核账后补办银行匹配 | 现在把刚才核实的交易匹配保存到本机工作台。 | 同一原件第一次核账时没有导入；第二次用对应操作签发的草稿。过期、未知状态和重试均要核对原操作和数据库。 |
| 客户的进项选择 | 接上九月已用和未用的票，比较十月能选的方案，按双方已约定口径建议，并告诉我年底和现金支付有什么影响。 | 从原件重新统计可抵与已用的票。核实当月、累计与年度预测，分别读回申报和付款依据。各期真实金额不能被预测覆盖。 |
| 补件后复工交接 | 上次的工作接着做。新回执放好了，请更新影响到的月份，留下下月可用的交接。 | 新进程读旧操作号、底稿和源版本。比较受影响的期间、重新出具的文件和不受影响的原记录，并核对下月带入事项。 |

运行 `node --test 06-workbench/test/{文件名}` 可分别复查 `ledger-query-views.test.mjs`、`voucher-correction-mcp.test.mjs`、`finance-delivery-check.test.mjs`、`bank-local-drafts.test.mjs`、`vat-handoff-mcp.test.mjs` 和 `direct-workpaper-posting-process.test.mjs`。完整入口为 `06-workbench` 下的 `npm test`。

银行办理、历史进项和跨进程接续各有独立的建账、自然语言任务和终态评分器。[三组产品任务](product-tasks/README.md)

## 会计评分

`node 06-workbench/evals/voucher-reconciliation/seed.mjs <全新目录>` 从公开的合成资料建账并生成工作区，完成后关闭临时后端。需要连续运行产品宿主时传入 `--keep-backend`，结束时在生成的 reviewer 目录创建 `stop-backend.flag`。本机评分者持有 reviewer 底稿。受测者只接收 host 和业务资料。仓库内固定样本供回归，对未知样本的行为评估另由独立验收者准备。

使用 `python 06-workbench/evals/voucher-reconciliation/score_trace.py <合成轨迹.jsonl> <合成账库> <账套ID> <期间> <评分.json> --gold <reviewer/gold.json> --baseline <reviewer/baseline.json> --outputs <host/outputs>`。退出码 1 表示终态与预期不符。评分文件包含实际调用、原生 Skill 与兼容技能读取、错误、会话时长和宿主可观测费用。每项人工补件判断需回到原件逐条归因，记录有依据与重复请求的原数。不同版本在同一宿主、模型、权限和重建的原件上比较；多次试验保留成功次数、总次数与费用和耗时中位数。

## 宿主与发布

运行 `node 06-workbench/scripts/claude-direct-discovery.mjs --claude-cli <绝对路径>` 使用真实 CLI 控制协议检查生成项目和 marketplace 安装，不发送用户任务。Pi 的 `start-pi.mjs --pi-root <SDK目录> --check` 读取原生 Skill、注册 MCP 并验证延迟工具搜索。dsh 和 ZCode 各有生成配置与降级路径测试。

正式授权模型行为验收后，插件安装路径可用 `claude plugin eval ./plugins/finance --no-publish` 执行九组正例与九组相邻业务反例。三项需要深入办理的请求另检查原生 `Read` 是否打开相应业务参考。默认两臂报告需逐例检查技能触发指标；只计装有插件的一臂时加 `--ablation none`。官方套件按工具选择和文本结果评分，真实账务另用上面的产品宿主、合成库和独立评分。程序、实际宿主注册和模型行为的证据分别记录。[Claude Code 插件评测](https://code.claude.com/docs/en/plugin-evals)

升级时核对插件清单版本、生成目录的 `.finance/skill-source.json` 与宿主注册名单，再从原操作号读取未完成事项。回退时选择前一已审阅的源码包和对应版本的宿主配置，重新生成独立工作区，原账套和审计目录继续用于读回。先核实原操作是否已提交，再决定是否办理剩余动作。
