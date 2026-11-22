# 银行办理、历史进项与补件交接的合成验收

在仓库根运行命令，使用项目要求的 Node、已安装的工作台依赖和 Python 3 标准库。每次给 seed 或 calibrate 一个**尚不存在的路径**。脚本只向新运行目录写合成账库、原件和交接资料。三个任务分别建账。验收者保管 reviewer，向受测宿主提供生成的 host、业务资料、绑定的工作台服务和审计目录。源代码和固定数据供公开回归，正式盲测应另行设计保留样本。

## 校准验收程序

```sh
node 06-workbench/evals/product-tasks/calibrate.mjs <全新目录>
```

该程序分别运行空白态评分和真实产品调用后的评分，付款和申报均为合成资料。每组的 reviewer/办理前评分.json 和 reviewer/办理后评分.json 分开列出 expected、actual 和 passed。校准使用脚本调用产品，结果标签为 scripted_product_replay。真实人员或宿主运行的独立账务评分标签为 product_state_only。模型能力、费用和耗时须用实际宿主轨迹单独测量。公共的宿主轨迹解析器与模型比较口径见[上一级说明](../README.md)。

## 分别交给受测宿主

```sh
node 06-workbench/evals/product-tasks/seed.mjs bank <新的银行运行目录> --keep-backend
node 06-workbench/evals/product-tasks/seed.mjs vat-selection <新的进项运行目录> --keep-backend
node 06-workbench/evals/product-tasks/seed.mjs handoff <新的补件运行目录> --keep-backend
```

每次启动一个任务，从新工作区发送任务文件里的中文原文。运行结束后在输出给出的 reviewer/stop-backend.flag 路径创建空文件，控制进程会关闭该次临时后端。只需查 fixture 时可省略 --keep-backend。需要实际办理时保持同一个后端，银行草稿为该进程内十分钟有效的一次操作凭据。

| 任务 | 会计收到的资料与任务 | 程序独立核实的业务事实 |
|---|---|---|
| bank | 给出一月流水和四张有原件映射的已记账凭证。先发送 host/任务一.txt，只查账和交核对表。第二轮只保存 R1。 | 在写入前封存核对表和流水、批次、匹配数。按原始流水与凭证日期、方向、银行分录和金额复算。核对工作台草稿、银行审计事件、原操作号、四笔流水和唯一的 R1 匹配。 |
| vat-selection | 发送 host/任务.txt。九月底已确认一张、未用一张。十月和十一月分别有新票，另含决策日后才收到的票。约定写在期初文件中。 | 重算两方案各月应纳、单月及累计、年末及付款月现金。按收件日和已用记录核对逐票去向，分别验证九月申报和十月银行回执。 |
| handoff | 发送 host/任务.txt。上期工作区用真实工具完成过一次十月规划，进程已退出。当前十一月工作区得到新登记表和迟到的九月税款支付回执，十二月预算仍缺。 | 比对旧底稿与哈希、旧操作号、补件前后应纳、次月累计、付款月、实际申报及缴款，核实缺件仅影响指定期间的预算。按交接号从新工作区另起进程核对报告。 |

### 银行操作员

先等受测宿主完成只读核账。随后按下列顺序逐条运行，每次将新生成的 host/操作员-对应步骤.txt 发给受测宿主。待该步的实际动作结束后再签发下一步。操作员脚本只发草稿，受测者通过已绑定的正常产品工具办理。

```sh
node 06-workbench/evals/product-tasks/seed.mjs operator <银行运行目录> preview
node 06-workbench/evals/product-tasks/seed.mjs operator <银行运行目录> import
node 06-workbench/evals/product-tasks/seed.mjs operator <银行运行目录> confirm
node 06-workbench/evals/product-tasks/seed.mjs operator <银行运行目录> readback
```

最后一轮模拟会计未收到上一笔保存回执，使用新的只读草稿查回原匹配。这一步沿用确认动作的原操作号。评分器逐笔核对 SQLite 与原操作号，能识别重复办理、办理错笔、跳过预览和自行换用草稿。银行服务过期或意外退出时，保留该次评分及工作现场，另起全新运行目录复测。

### 补件交接的接收人

受测者完成后，将交付的操作号传给验收者的命令。它另起进程，在十一月新建的工作区通过期间复核取回十月底稿，核实报告可读并将回执写入 reviewer。

```sh
node 06-workbench/evals/product-tasks/verify-handoff.mjs <补件运行目录> <受测者交付的操作号>
```

### 读取评分

```sh
python 06-workbench/evals/product-tasks/score.py <运行目录> --output <评分文件.json>
```

可用 --call-id 指定受测者交付的交接版本。默认使用该次任务最后一份新版本。退出码 1 表示评分发现差异或缺少证据。评分器只读查询 SQLite，复算合成原件，并核对实际调用、交接文件和工作台状态。每一项列出预期和实测，未运行模型也可单独校准评分程序。
