# 配置与启动财税 Agent

通过 Pi、Claude Code、dsh 或 ZCode 交代财税任务，Agent 使用本机后端完成账前核对、做账、对账、税费计算和报表复核。四种应用共用同一套[业务技能](../../../plugins/finance/README.md)，按已有使用习惯[选择应用](README.md)即可。

## 1. 启动本机后端

安装 Node 和所选应用，并配置本人的模型服务。Windows 下从仓库根进入工作台，替换命令中的占位路径：

```powershell
cd 06-workbench
npm ci
powershell -NoProfile -File scripts\windows-start.ps1 -NodePath '<node.exe绝对路径>' -DataDir '<明确数据目录绝对路径>' -Port 0
```

保持此终端运行，记录服务打印的实际端口。账库位于指定数据目录的 `workbench.db`；新空库需要先建账或导入。运行要求见 [Windows 运行说明](../../../docs/CODE-INDEX.md#windows)；脚本受执行策略限制时，按[启动脚本](../../../06-workbench/scripts/windows-start.ps1)开头的手动步骤运行。

## 2. 生成应用工作区

另开终端，在仓库根运行。选择实际账库和全新的输出目录，输出父目录须已存在：

```powershell
node 06-workbench/scripts/finance-host-config.mjs --host pi --node '<node.exe绝对路径>' --api-base 'http://127.0.0.1:<实际端口>' --database '<数据目录绝对路径>/workbench.db' --source-root '<获准原件绝对目录>' --out '<已存在父目录绝对路径/全新工作区>'
```

- `--host` 可选 `pi`、`claude-code`、`dsh` 或 `zcode`。
- `--source-root` 指定已有获准原件目录。Agent 在宿主中使用已有文件或脚本权限读取。
- 需要运行 Python 计算时，加 `--python '<python.exe绝对路径>'`；JavaScript 计算无需此项。
- 处理记录默认保存在新工作区的 `finance-call-records`，可用 `--audit-dir '<绝对目录>'` 改位置。由 Agent 生成的基线观察、账前整理件及回复写在审计根下的 `agent-materials`。

生成器使用本仓库技能，不覆盖已有工作区、不启动模型，也不创建账套。

## 3. 绑定已有账套并启动

处理已有企业时，在新工作区明确实际账套和本期。正常首次启动准备历史目录并读取短业务基线，操作者不用预填企业方案；可先显式绑定并做只读核对：

```powershell
node ./start-business-session.mjs --account-set-id <实际账套ID> --period 2026-11 --prepare-only
node ./start-business-session.mjs --check
```

`--prepare-only` 会写历史索引与本机会话绑定，不调用模型，也不生成业务原则；输出的 `prepared` 与 `baselineStatus` 分开看。`--check` 核已有绑定和短基线，账库／索引／原件只读，允许标准调用审计记录安全来源观察；未绑定报错，不默认选择首家企业。每个工作区固定实际账库、企业、账套、本期及来源/记录目录；换企业或期间生成新工作区。完整操作、基线生成及按需旧方法见 [企业记忆操作说明](BUSINESS-MEMORY.md)。

无有效基线时，Agent 按 [基线生成](../../../plugins/finance/skills/company-baseline/SKILL.md) 实读实际账套、代表性历史、合同／底稿和历史申报导出，调查、提炼并真实保存后再回读处理本期。短正文最多8条原则、600个Unicode字符，不用未知清单冒充完成。同条件沿用；普通新凭证不重建、不追加基线，明细与旧方法按需读取。正常MCP写入及已绑定计算继续自动留痕，Agent不逐笔prepare或维护技术状态。程序验证、真实宿主事件和冷启动模型业务分别记录，生成目录不代表模型已调查或原则已正确。

| 应用 | 启动命令 |
|---|---|
| [Pi](pi/README.md) | `node ./start-business-session.mjs -- --pi-root '<官方Pi 1.1.0包绝对目录>'` |
| [Claude Code](claude-code/README.md) | `node ./start-business-session.mjs -- --claude-cli '<Claude exe或JS入口绝对路径>'` |
| [dsh](dsh/README.md) | `node ./start-business-session.mjs -- --dsh-cli '<dsh包JS bin绝对路径>' --task '<明确任务>'` |
| [ZCode](zcode/README.md) | `node ./start-business-session.mjs -- --zcode-cli '<ZCode exe或JS入口绝对路径>'` |

dsh 的 `model.cordis.patch.yml` 需按其说明另行配置；各应用的模型设置见上表链接。Pi 原有 `node start-pi.mjs --pi-root '<官方包绝对目录>' --check` 检查连接，不调用模型。尚未建账的账前核对可使用原有未绑定入口，不能为了读取企业历史伪建账套；已知账套的正常业务通过上述绑定入口启动。

## 4. 开始一项业务

向 Agent 明确企业、账套、期间、资料目录和任务，例如：

> 完成这家企业本期账税与申报准备，核对本期采购、收货、发票、流水及库存，接续上期余额；资料不足时先完成可核部分，列出影响和补件后接续入口。

整期目标先读 [tax-period](../../../plugins/finance/skills/tax-period/SKILL.md)，再选择本次需要的阶段及账前、做账、对账、税费、报表分支；单项查询和试算使用对应技能。四宿主共用同一短路由：Pi 启动系统提示、Claude 的 `CLAUDE.md`、ZCode 的 `AGENTS.md`、dsh 显式启动包装的任务文本。dsh 包装要求操作者配置实际 `model.cordis.patch.yml`，可用 `--model-patch` 指定已有覆盖层；直接调用 dsh 时须自行带上同一入口指引。配置生成和提示装配不证明模型已经读取或正确执行技能，业务验收须查看实际工具轨迹及产物。

Agent 用宿主直接读取原始资料，按业务合同整理并提交本机文件引用，选择工具并生成报告；做账任务核实目标账套，编制凭证并按实际审核结果入账。企业先读 `finance_baseline_read` 的短原则，无有效版本或需修订则先生成。具体余额、合同进度、算法和脚本仍查原账／原工具；需要旧方法目录才读 `finance_company_context`，再按实际引用读 `finance_method_read` 或 `finance_case_search`。接续仍核同范围实际账表、底稿、来源版本及 `finance_period_review`，不能沿用上次模型自述完成。

先看报告里的金额、异常和缺件，再核对凭证、计算与依据。资料补齐后重新处理；写入结果不明时，先查原操作状态再继续。真实资料仅在授权范围内处理，模型服务凭据保留在本人的可信配置中。
