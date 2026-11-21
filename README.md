# 中国财税 Agent

在本机协助会计整理资料、做账、对账、核算税费和编制报表，一名操作者可管理多家企业，每家企业独立账套。

## 能做什么

| 能力 | 处理内容 | 交付结果 |
|---|---|---|
| 账前核对 | 接续上期账，核对采购、收货、发票、付款、资金和库存 | 中文核对报告、老板问询清单、做账交接资料 |
| 建账与做账 | 导入期初和旧账，编制凭证，审核后入账，处理折旧与月末损益结转 | 凭证、账簿、期末处理结果 |
| 对账与查账 | 核对银行流水、往来和科目余额，查询总账与明细账 | 对账结果、差额和待查事项 |
| 税费核算与政策查询 | 按资料计算税费，在线检索官方政策，核对原文条款与适用期 | 税费底稿、政策依据、条件试算、缺件说明 |
| 财务报表 | 编制资产负债表、利润表、现金流量表，复核账表与期间差异 | 中文账务复核报告、报表及明细附件 |
| 专项计算 | 按业务需要用脚本或表格完成计算，保留公式和来源 | 专项账表、计算底稿与执行记录 |

## 两条常用流程

**本期还没做账：** 上期及本期资料 → 账前核对与问询 → 补件重算 → 交接做账。

客户提供原始资料，Agent 在获准的本机宿主中读取并整理，财税工具接收有来源的整理结果。账前可做一般纳税人与小规模纳税人的增值税条件试算。

**做账：** 业务资料 → 凭证草稿与核对 → 人工审核后入账 → 账簿、报表与期末复核。

结果先看金额和异常，再查看凭证、计算与规则依据；原件和完整处理记录保存在本机。

## 怎么用

- [业务技能](plugins/finance/README.md)：按账前、凭证、对账、税费、报表等任务选择入口。
- [选择应用](05-reconstruction/codex/hosts/README.md)：使用 Pi、Claude Code、dsh 或 ZCode 发起任务，共用同一本机财税能力。
- [配置与启动](05-reconstruction/codex/hosts/START-HERE.md)：连接本机后端、明确账库和资料目录。

## 账套记忆与跨月接续

已有账套按[配置与启动](05-reconstruction/codex/hosts/START-HERE.md)生成工作区。在生成的目录运行下列命令，绑定本期并查看记忆路径。

```powershell
node ./start-business-session.mjs --account-set-id '<实际账套ID>' --period 2026-09 --prepare-only
node ./start-business-session.mjs --check
```

1. **首次接手。** 按[各宿主的启动命令](05-reconstruction/codex/hosts/START-HERE.md#3-绑定已有账套并启动)进入会话，请 Agent 核对账套和相关历史依据，按[账套记忆格式](plugins/finance/skills/company-baseline/SKILL.md#memorymd-格式)将已确认、可跨月沿用的口径写入 `memoryPath` 指向的本机 `MEMORY.md`。
2. **查看记忆。** 会计可按 `memoryPath` 打开文件。Claude Code 经启动器使用原生 Auto Memory，Pi、dsh 和 ZCode 按绑定路径用宿主文件工具读写。
3. **接着做下月。** 用同一账库和账套生成新工作区，指定下月原件目录，把 `--period` 改为下月。新工作区沿用同一份记忆和按账套保存的调用记录。旧工作区或自选记录目录按启动指南用 `--audit-dir` 接续原址。本期余额、业务金额和进项抵扣仍按本期资料核对。有新口径时，确认生效月份后更新对应条目。

绑定检查、记忆文件位置和备份说明见[账套记忆指南](05-reconstruction/codex/hosts/BUSINESS-MEMORY.md)。

当前提供本机账税处理与复核，未接入正式申报、缴款或开票；具体税种、期间和准则范围见[业务说明](plugins/finance/README.md)。开发与维护见[中文架构](docs/AGENT-ARCHITECTURE.md)、[代码索引](docs/CODE-INDEX.md)和 [Issues](https://github.com/huxiaoyang-code/taxes-agent/issues)。
