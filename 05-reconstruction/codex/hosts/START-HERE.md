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
- `--source-root` 指定已有获准原件目录。Claude 正式更正委托允许从该目录查找和读取本期原件、交接表和登记簿。`--correction-original` 单独指定可以用来证明更正的原件。其他现场沿用已有的宿主文件权限。
- 需要运行 Python 计算时，加 `--python '<python.exe绝对路径>'`；JavaScript 计算无需此项。
- 完成账套绑定后，处理记录默认保存在 `<账库目录>/.finance-call-records/<账库文件名>/<实例编号>/<账套ID>`。同一账套的下月工作区可直接查回上月交接。未绑定的工作区使用本地 `finance-call-records`；若首次绑定前已在该目录留存资料，继续使用原址。整理件及回复写在实际记录目录的 `agent-materials`。

生成器使用本仓库技能，不覆盖已有工作区、不启动模型，也不创建账套。

正式做账委托包含“自行更正本期错账”时，在生成命令指定 `--voucher-corrections delegated` 与获准的 `--source-root`。工具在绑定本期后可跨会话接续，无需逐张确认。Claude 正式委托在新工作区的 `outputs/` 目录交付 CSV 核对表和 Markdown 说明。单纯试算、出报表使用原命令。现场原件选择、旧现场升级及实账读回见[自主更正](../../../plugins/finance/skills/reconciliation/references/voucher-correction.md)。

## 3. 绑定已有账套并启动

在新工作区指定实际账套及本期。以前生成的工作区需按当前代码重新生成，以更新启动设置和任务提示。

```powershell
node ./start-business-session.mjs --account-set-id <实际账套ID> --period 2026-11 --prepare-only
node ./start-business-session.mjs --check
```

`--prepare-only` 准备本机会话绑定，`--check` 只读显示 `auditDir` 和 `memoryPath`。接续旧工作区、绑定前留有资料的工作区或自选记录目录时，读取上期 `.finance/business-session.json` 中的 `auditDir`，在生成新工作区的命令加 `--audit-dir '<上期 auditDir 绝对路径>'`。绑定后核对新旧 `auditDir` 一致，再分页查回上期记录。每个工作区固定实际账库、企业、账套和本期，换月份用新工作区，同一账套跨月指向同一份 `MEMORY.md`。详见[账套记忆](BUSINESS-MEMORY.md)。

Claude Code 通过原生 Auto Memory 使用已绑定账套的 `MEMORY.md`。Pi、dsh 和 ZCode 使用宿主文件工具读取绑定里的 `memoryPath`。首次接手或有新口径时，按[账套记忆技能](../../../plugins/finance/skills/company-baseline/SKILL.md)核实际账和相关资料，再编辑有变化的条目。

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

Agent 用宿主直接读取原始资料，按业务合同整理并提交本机文件引用。做账任务按当前有效口径取本期余额、合同进度及其他输入，编制凭证并按实际审核结果入账。需要查旧方法时使用 `finance_company_context`，再按实际引用读 `finance_method_read` 或 `finance_case_search`。整期接续使用 `finance_period_review` 核同范围实际账表、底稿和来源版本。

先看报告里的金额、异常和缺件，再核对凭证、计算与依据。资料补齐后重新处理；写入结果不明时，先查原操作状态再继续。真实资料仅在授权范围内处理，模型服务凭据保留在本人的可信配置中。
