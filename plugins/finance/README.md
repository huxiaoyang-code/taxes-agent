# 中国财税插件

让 Agent 按中国企业的会计与税务业务处理资料，完成账前核对、凭证编制、对账、报表、税费和内控复核，交付可检查的账表、底稿与问题清单。

## 按业务选择技能

| 业务 | 能做什么 |
|---|---|
| [账前整理与核对](skills/prebook-review/SKILL.md) | 接续上期账，核对采购、收货、发票、收付款与库存，列出问询及补件事项 |
| [凭证编制](skills/journal-entry/SKILL.md) | 按采购销售、费用、资产、工资等业务编制分录草稿，核对科目与计算支持 |
| [账目核对](skills/reconciliation/SKILL.md) | 比对总账、往来、银行、库存和资产资料，定位差异 |
| [财务报表](skills/financial-statements/SKILL.md) | 按适用准则编制资产负债表、利润表和现金流量表，核对账表关系 |
| [差异分析](skills/variance-analysis/SKILL.md) | 比较期间或预算，拆分价格、数量、结构、跨期等影响，保留待调查原因 |
| [税费复核](skills/tax-review/SKILL.md) | 核对增值税、所得税、工资个税、印花税等适用条件，形成税费底稿与依据 |
| [内控复核](skills/internal-control-review/SKILL.md) | 对收入、采购付款、凭证和期末处理取样检查，列异常及整改建议 |
| [凭证编制参考](skills/journal-entry-prep/SKILL.md) | 为计提、摊销、折旧、工资、收入和存货处理补充资料要求与复核要点 |
| [月结与年度核对](skills/close-management/SKILL.md) | 按资料及账务依赖安排工作先后，梳理期末处理和未决事项 |
| [财务与内控复核支持](skills/audit-support/SKILL.md) | 为会计复核、内部检查或外部审计整理样本、证据及问题底稿 |

可直接用中文说明任务，例如“核对本月采购、发票和流水，列出要问老板的问题”。安装到 Claude Code 后，也可使用 `/finance:prebook-review`、`/finance:journal-entry` 等技能命令；表中最后三项由 Agent 在相关任务中按需读取。

## 账前核对：资料到做账交接

上期及本期资料 → 核对与问询 → 收到解释或补件 → 重新核对 → 交接做账。

客户提供基础资料，Agent 负责整理。结果包含资金和库存差异、采购与票款关联、增值税条件试算、老板问询清单及交接资料。补件后重算，保留仍待核实的问题。

账前内置税务测算仅覆盖一般纳税人与小规模纳税人的增值税；其他税费使用税费复核能力。交接资料供后续编制凭证使用，正式入账仍须审核。资料要求与合成演示见[账前输入说明](skills/prebook-review/references/input-and-tools.md)。

## 做账与复核：资料到凭证、账簿和报表

明确企业、账套、期间及适用准则后，按业务编制凭证、核对账目，审核后入账，再处理折旧、结转和报表。也可依据已有资料用脚本或表格生成独立账表，保留公式、来源及采用状态。

账期复核先展示科目余额、银行和现金、税费及三张报表，再按需查看凭证、计算与规则依据。按支持格式整理的账表可生成固定中文复核卡片，明细作为附件；使用方法见[完整账期与中文复核交付](skills/shared/references/quarter-review.md)。

原生账库季度复核包目前支持 2026—2027 年自然季度的小企业会计准则账套。税费计算按已实现分支、地区、期间和资料条件使用，具体见[税费范围](skills/tax-review/references/supported-obligations.md)。本插件提供核算与复核支持，尚未接入正式申报、缴款或开票。

## 安装与连接

插件与本机后端在同一仓库。Pi、Claude Code、dsh 和 ZCode 的配置及启动见[统一入口](../../05-reconstruction/codex/hosts/START-HERE.md)。

Claude Code 也可在仓库根安装本地插件：

```sh
claude plugin marketplace add .
claude plugin install finance@taxes-agent
```

使用插件安装方式时，按[连接说明](CONNECTORS.md)设置本机后端和账库，`TAXES_AGENT_ROOT` 指向当前仓库绝对路径。

## 来源与许可

基于 Anthropic 官方 finance 插件中国化改编，并适配 small-business 的单据处理与核对方法。来源和修改记录见 [SOURCES.md](SOURCES.md)，许可见 [LICENSE](LICENSE)。
