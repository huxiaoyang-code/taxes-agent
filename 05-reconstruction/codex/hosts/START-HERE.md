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
- `--source-root` 指定已有原件目录；账前核对和处理原件的脚本需要它。适配输入及回复文件也放在该目录内。
- 需要运行 Python 计算时，加 `--python '<python.exe绝对路径>'`；JavaScript 计算无需此项。
- 处理记录默认保存在新工作区的 `finance-call-records`，可用 `--audit-dir '<绝对目录>'` 改位置。

生成器使用本仓库技能，不覆盖已有工作区、不启动模型，也不创建账套。

## 3. 在新工作区启动应用

| 应用 | 启动命令 |
|---|---|
| [Pi](pi/README.md) | `node start-pi.mjs --pi-root '<官方Pi 1.1.0包绝对目录>'` |
| [Claude Code](claude-code/README.md) | `claude --strict-mcp-config --mcp-config .mcp.json --settings .claude/settings.json` |
| [dsh](dsh/README.md) | `dsh --profile headless --patch ./finance.cordis.patch.yml --patch ./model.cordis.patch.yml '<明确任务>'` |
| [ZCode](zcode/README.md) | `zcode --cwd '<生成目录绝对路径>' --mode build` |

dsh 的 `model.cordis.patch.yml` 需按其说明另行配置；各应用的模型设置见上表链接。Pi 可先在启动命令末尾加 `--check` 检查连接，此检查不调用模型。

## 4. 开始一项业务

向 Agent 明确企业、账套、期间、资料目录和任务，例如：

> 核对这家企业本月的采购、收货、发票、流水和库存，接续上期余额，列出差异与需要向老板补问的事项。

Agent 按需读取[账前核对](../../../plugins/finance/skills/prebook-review/SKILL.md)等技能，整理原始资料，选择工具并生成报告；做账任务则核实目标账套，编制凭证并按实际审核结果入账。

先看报告里的金额、异常和缺件，再核对凭证、计算与依据。资料补齐后重新处理；写入结果不明时，先查原操作状态再继续。真实资料仅在授权范围内处理，模型服务凭据保留在本人的可信配置中。
