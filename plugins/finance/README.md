# 中国财税插件

基于 Anthropic 官方 finance 插件中国化改编，沿用插件清单、业务 Skill、连接类别和工作底稿格式。Agent自主判断并选择Python、表格公式或已有计算器；系统记录实际读取、计算和产物，本机中国财税后端还提供可选计算器与账务操作，不要求手工事实登记或运行时任务图。来源和许可见 [SOURCES.md](SOURCES.md) 与 [LICENSE](LICENSE)。

## 安装与连接

在本 taxes-agent 仓库根执行，本地 marketplace 原位加载本仓库插件：

```sh
claude plugin marketplace add .
claude plugin install finance@taxes-agent
```

本插件与后端统一维护于 [taxes-agent](https://github.com/huxiaoyang-code/taxes-agent) 的 `plugins/finance`，一次 clone 即包含全部源码。先按 [四宿主统一入口](../../05-reconstruction/codex/hosts/START-HERE.md) 或 [连接说明](CONNECTORS.md)配置明确的本机后端、账库和记录目录。Pi、Claude Code、dsh、ZCode 的宿主生成器固定使用本插件，不接受外部插件路径。Claude 使用上面的本地 marketplace 原位加载；`TAXES_AGENT_ROOT` 指向同一仓库 clone。MCP 服务固定读取所属仓库的业务技能，不从插件缓存或环境变量指定的其他目录加载。配置文件存在不代表已连接；核对实际工具和目标。

## 业务入口

| 入口 | 用途 |
|---|---|
| `/finance:journal-entry` | 凭证草稿、支持计算和科目核对 |
| `/finance:reconciliation` | 总账、往来、银行、库存及资产差异 |
| `/finance:financial-statements` | 中国适用准则报表及期间比较 |
| `/finance:variance-analysis` | 金额差异、业务驱动及待调查项 |
| `/finance:internal-control-review` | 中国企业内控资料取样与异常核对 |
| `/finance:tax-review` | 增值税抵扣、季度小规模、所得税、工资个税、印花及其他税费依据 |

名称遵守实际Skill frontmatter；`journal-entry-prep`、`close-management`、`audit-support`按相关任务自动读取。原`sox-testing`已改为`internal-control-review`，不声称SOX为中国企业普遍义务。

## 核对方式

先明确企业、账套、期间、币种和业务，再选择需要的Skill与工具。月结日历与依赖是可调整业务参考，不强制编排。已有数据不足时列具体缺件；可支持部分照常核对，不能把独立模型计算冒充原生引擎已完成。

完整账期默认交付一个系统按固定 Spec 自动取数生成的中文账务复核卡片，先看科目余额、银行和现金、税费及三张报表。凭证、规则与采用参数按需查看，调用链及输入原件保留在后台；模型不另写最终 HTML 或三份重复索引。记录未接通或失败如实说明，见 [报告顺序](skills/shared/references/reporting.md)。本版本提供本机账税核对和申报依据；不进行税局登录、正式申报、缴款或开票。

完整季度业务见[完整账期与中文复核交付](skills/shared/references/quarter-review.md)。客户提供中文原始业务资料，读取时留原表结构、调用时留参数与规则映射；模型自主计算账簿和报表，保留公式或配套脚本，按已支持的输出合同由系统生成固定卡片，工作簿作为明细附件；已有真实账库时也可选原生报表导出，无需原生bundle才能交付。固定卡片只支持明确的数据合同，不自动理解任意文件。工具未完成、未核或未分类的事项保留实际状态，不能把执行成功、勾稽相符或模型计算升级为完整账务验收。

中国会计与税务依据按需读取已核官方资料或可选规则服务，区分《小企业会计准则》与《企业会计准则》；公式实现可自主选择，规则未解决保持未解决。福建漳州是当前业务起点，具体地点、税务资格和地区参数须来自实际证据；地名不能替代市区分类或优惠资格。后端义务目录及限制见 [税费范围](skills/tax-review/references/supported-obligations.md)。

## 无模型验证

在仓库根运行 `node --test plugins/finance/tests/structure.test.mjs`，检查插件结构、许可摘要、固定上游与中文 fork 来源、业务引用、报告顺序，以及同仓库真实29项税费义务和已引用工具合同；默认实际 MCP 逐份读取全部技能与参考。测试不依赖第二仓库、`TAXES_AGENT_ROOT` 环境变量或历史 Git 对象，已纳入 `06-workbench/scripts/test-all.mjs`。仅使用合成配置和临时目录，不调用Pi或任何模型。
