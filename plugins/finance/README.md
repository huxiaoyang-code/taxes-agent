# 中国财税插件

让 Agent 按中国企业的会计与税务业务处理资料，完成账前核对、凭证编制、对账、报表、税费和内控复核，交付可检查的账表、底稿与问题清单。

## 九个主入口

可直接说明业务，例如“核对本月采购、发票和流水，列出要问老板的问题”。Claude Code 安装插件后也可用 `/finance:prebook-review`、`/finance:journal-entry` 等技能命令。

| 业务 | 能做什么 |
|---|---|
| [整期账税与申报准备](skills/tax-period/SKILL.md) | “完成本期账税”“接上次补件继续”的默认整期入口；按实际产物选择阶段，接续资料、收入成本、税费方案及交付 |
| [账套记忆](skills/company-baseline/SKILL.md) | 从实际账套和相关依据提炼少量可跨月沿用的做账口径，保存在该账套的本机 `MEMORY.md` |
| [账前整理与核对](skills/prebook-review/SKILL.md) | 接续上期账，核对采购、收货、发票、收付款与库存，列出问询及补件事项 |
| [凭证编制](skills/journal-entry/SKILL.md) | 按采购销售、费用、资产、工资等业务编制分录草稿，核对科目与计算支持 |
| [账目核对](skills/reconciliation/SKILL.md) | 已有账簿时，将结单等原件与分录逐笔核对。需要把银行 CSV 导入账套、匹配流水时，在本机银行工作台预检并确认 |
| [财务报表](skills/financial-statements/SKILL.md) | 按适用准则编制资产负债表、利润表和现金流量表，核对账表关系 |
| [差异分析](skills/variance-analysis/SKILL.md) | 比较期间或预算，拆分价格、数量、结构、跨期等影响，保留待调查原因 |
| [税费复核](skills/tax-review/SKILL.md) | 在线查阅官方政策原文，核对增值税、所得税、工资个税、印花税等适用条件，形成税费底稿与依据 |
| [内控复核](skills/internal-control-review/SKILL.md) | 对收入、采购付款、凭证和期末处理取样检查，列异常及整改建议 |

## 三份辅助参考

| 在哪项业务中使用 | 何时读取 |
|---|---|
| 凭证编制 | 计提、摊销、折旧等分录需要核实原件和计算依据时，查[凭证编制参考](skills/journal-entry-prep/SKILL.md) |
| 整期账税与申报准备 | 安排月结顺序、检查结转依赖或梳理年末未决事项时，查[月结与年度核对](skills/close-management/SKILL.md) |
| 内控复核 | 需要编制抽样底稿或为审计整理样本、证据和问题记录时，查[财务与内控复核支持](skills/audit-support/SKILL.md) |

默认 direct 服务的 `skills_list` 在每个入口的 `role` 标明主入口（`primary`）或辅助参考（`reference`）。选定业务后，将该项的 `resource` 传给 `skills_read` 读取正文。

## 整期与跨月接续

“完成这家企业本期账税”“把本季申报准备好”“接上次补件继续”先读 `tax-period/SKILL.md`，再按目标加载已有专项技能；单项税额、凭证或查询直接进入对应技能。整期交付前主动检查真实扣除、优惠、亏损及法定选择，比较本期、全年和合同全周期的税额及现金影响，区分减税与递延。补件接续以同范围实际产物和来源版本为据，`finance_period_review` 只复查已有调用记录，不把模型说完成或新一次调用成功当整期通过。

已有账套按实际绑定使用其本机 `MEMORY.md`，沿用本期适用的口径。首次接手或口径变化时按[账套记忆技能](skills/company-baseline/SKILL.md)查相关事实，再用宿主文件工具编辑受影响的条目。本期余额、合同进度及业务参数按实际资料取数，旧方法和历史税负按需查。

“做完本月账”可从同一整期入口进入[逐票抵扣比较](skills/tax-review/references/vat-planning.md)、[税款现金简报](skills/tax-review/references/tax-cash-brief.md)和[申报准备及交接](skills/tax-review/references/tax-organizer.md)。

## 账前核对：资料到做账交接

上期及本期资料 → 核对与问询 → 收到解释或补件 → 重新核对 → 交接做账。

客户提供基础资料，Agent 在宿主本机读取，按业务合同整理有来源的结果并提交文件引用。结果包含资金和库存差异、采购与票款关联、增值税条件试算、老板问询清单及交接资料。补件后重算，保留仍待核实的问题。

账前内置税务测算仅覆盖一般纳税人与小规模纳税人的增值税；其他税费使用税费复核能力。交接资料供后续编制凭证使用，正式入账仍须审核。资料要求与合成演示见[账前输入说明](skills/prebook-review/references/input-and-tools.md)。

## 做账与复核：资料到凭证、账簿和报表

明确企业、账套、期间及适用准则后，按业务编制凭证、核对账目，审核后入账，再处理折旧、结转和报表。也可依据已有资料用脚本或表格生成独立账表，保留公式、来源及采用状态。

账期复核先展示科目余额、银行和现金、税费及三张报表，再按需查看凭证、计算与规则依据。按支持格式整理的账表可生成固定中文复核卡片，明细作为附件；使用方法见[完整账期与中文复核交付](skills/shared/references/quarter-review.md)。

原生账库季度复核包目前支持 2026—2027 年自然季度的小企业会计准则账套。税费计算按已实现分支、地区、期间和资料条件使用，具体见[税费范围](skills/tax-review/references/supported-obligations.md)。本插件提供核算与复核支持，尚未接入正式申报、缴款或开票。

## 安装与连接

插件与本机后端在同一仓库。Pi、Claude Code、dsh 和 ZCode 的配置及启动见[统一入口](../../05-reconstruction/codex/hosts/START-HERE.md)。

Claude Code 也可在仓库根安装本地插件：

```sh
claude plugin marketplace add ./
claude plugin install finance@taxes-agent
```

使用插件安装方式时，按[连接说明](CONNECTORS.md)设置本机后端和账库，`TAXES_AGENT_ROOT` 指向当前仓库绝对路径。账前核对、逐票抵扣等需要读取原件的业务，还要在启动 Claude 的终端设置本次授权的原件目录。PowerShell 示例为 `$env:FINANCE_SOURCE_ROOT = (Resolve-Path '<本期原件目录>').Path`。更换目录后，退出已运行的 Claude 并从该终端重新启动，让财税服务继承新值。

运行 `claude plugin details finance@taxes-agent` 可查看技能清单，`claude mcp list` 应显示 `plugin:finance:finance` 已连接。实际读取某份原件时，服务会核验该文件是否位于获准目录内。

本地目录安装随同一仓库更新，在新会话或运行 `/reload-plugins` 后加载。若原来从 Git 市场安装，先将本机后端更新至同一版本，再运行 `claude plugin marketplace update taxes-agent` 和 `claude plugin update finance@taxes-agent`，重新启动会话。可用 `claude plugin list --json` 核对版本及实际读取目录。

Codex CLI 可按 [MCP 配置示例](../../05-reconstruction/codex/config.toml)登记同一本机服务。处理“做完本月账”时读 `tax-period/SKILL.md`，再按账套和期间选择相应工作流。

## 来源与许可

既有技能基于 Anthropic 官方 finance 插件中国化改编，并适配 small-business 的单据处理与核对方法。账套记忆是本项目新增技能。来源和修改记录见 [SOURCES.md](SOURCES.md)，许可见 [LICENSE](LICENSE)。
