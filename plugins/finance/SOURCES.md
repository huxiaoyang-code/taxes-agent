# 来源、许可与中国化修改

2026-11-17新增：`company-baseline` 为本项目原创业务入口，从实际账套、代表性历史、合同／已有底稿／历史申报导出调查并提炼短原则，保存后用于本期；不是 Anthropic 官方税务实践或中国税法背书。同步整期、凭证、税费及四宿主的生成／沿用入口，旧方法、案例和脚本仍按需使用。

上游：[anthropics/knowledge-work-plugins](https://github.com/anthropics/knowledge-work-plugins/tree/2574e29377c7173d0cecffef29a6ecbd7f8ccb5d)，固定提交`2574e29377c7173d0cecffef29a6ecbd7f8ccb5d`，原finance插件版本1.3.0。原中国化 fork 为[huxiaoyang-code/knowledge-work-plugins](https://github.com/huxiaoyang-code/knowledge-work-plugins)，仅作为历史来源；后续插件与后端统一在 [huxiaoyang-code/taxes-agent](https://github.com/huxiaoyang-code/taxes-agent) 的 `plugins/finance` 维护。本项目不代表Anthropic对中国财税规则或结果背书。

2026-10-30修改：改编原8个finance Skill的触发描述、业务工作流、模板和复核方法；将`sox-testing`更名`internal-control-review`；替换美国ASC/GAAP、工资税及SOX默认适用表述，改用实际中国会计准则和已核中国规则；新增税费核对与按需参考。保留月结日历及依赖作为可调整指导，不建立运行时DAG。连接配置改为本机中国财税MCP，移除未配置和不相关的上游服务器。报告改为金额、凭证/计算、规则优先，调用和原件可深入索引。

原文件路径：`finance/skills/{journal-entry,journal-entry-prep,reconciliation,financial-statements,variance-analysis,close-management,audit-support,sox-testing}/SKILL.md`，以及`finance/README.md`、`CONNECTORS.md`、`.mcp.json`和`.claude-plugin/plugin.json`。各改编文件保留修改声明；本目录[LICENSE](LICENSE)为上游Apache-2.0原文，不翻译。上游finance及所采用文件目录未提供额外NOTICE；此次初始中国化未改编其他插件内容。

2026-10-31修改：再次逐项核对固定基线的financial-statements、journal-entry-prep与reconciliation原文，保留资料收集、报表比较和差异、常见凭证支持、两侧余额调节及复核方法；移除原生工作底稿、JSON绑定和季度bundle作为交付必经路径。模型自主选择Python、表格或可选计算器，系统记录实际计算，派生账簿与原生入账状态分列；用户产物使用中文。

2026-11-01修改：完整账期改为系统依据明确输出合同生成固定中文复核卡片，默认科目余额、银行与现金、税费及三张报表；凭证、规则和参数按需查看，后台证据不重复铺成多份报告。保留 Agent 自主计算、原生入账控制及上游业务方法，不新增运行时 DAG。固定卡片和中国后端合同为本项目适配，不归为 Anthropic 上游实现。

中国法规、准则、税率和地区条件按需取自已核官方资料或taxes-agent可选规则服务，保留本次适用依据；引擎实现及接口能力以实际后端为准。上游通用方法不是中国税法依据；这里只引用工作方法，不从上游示例推定适用政策。

2026-11-02迁入：完整迁入原 fork 的 finance 目录（含隐藏 manifest/MCP、九个中文 Skill、共享与税务参考、许可证及测试），不迁入其他上游插件。来源为已核远端 main 提交 [`de879f81f2963547b5d92fc6d4d9db1b4487ea08`](https://github.com/huxiaoyang-code/knowledge-work-plugins/commit/de879f81f2963547b5d92fc6d4d9db1b4487ea08)，与中文内容提交 [`f8b0ea50bf0aa9318d2efe8abfab16a1a330ae24`](https://github.com/huxiaoyang-code/knowledge-work-plugins/commit/f8b0ea50bf0aa9318d2efe8abfab16a1a330ae24) 的 tree 相同；此前自主计算方法改编提交为 [`888a1f890b1035b30c13d9a3d842598b0dea6449`](https://github.com/huxiaoyang-code/knowledge-work-plugins/commit/888a1f890b1035b30c13d9a3d842598b0dea6449)。本次只统一维护、安装、默认路径及自包含测试，不改财税算法与业务方法；共享连接参考同步单仓库原位加载说明，移除外部插件目录选项。Apache-2.0 LICENSE 原文保持；测试按 LF 归一化后核对固定已核 SHA-256，不要求 clone 带上游历史对象。

2026-11-02账前适配：新增 `prebook-review`，采用 [Anthropic small-business 1.35.1](https://github.com/anthropics/knowledge-work-plugins/tree/84d8efdb6e80e2b26898e5c3109d13eddde97761/small-business) 的工作方法，固定上游提交 `84d8efdb6e80e2b26898e5c3109d13eddde97761`。核验用本地 fork 提交 `01f6af59c30e3b98fc2d4a1711440ec5ef696c0f` 的 `small-business` 与该固定提交无差异。改编来源为 `small-business/skills/{ap-processor,month-end-prep,cash-flow-snapshot,report-builder,inventory-planner}/SKILL.md`，以及这些目录中的 `reference/intake_and_extraction.md`、`matching_and_exceptions.md`、`gotchas.md`、`report_spec.md`、`close-packet-format.md`、`data_sources.md` 等按需参考。

保留单据去重、采购收货匹配、有日期资金起点、明确资料缺口和指标来源的工作方法；改为中国一般纳税人与小规模的账前核对及补件交接，使用同仓库真实 direct MCP 和后端合同。原版月结对本期已记账数据的依赖改为上期账与本期基础资料；中国增值税条件试算、回复版本绑定和报告为本项目实现，不归为上游已有能力。未迁入美国税务公式、补货预测、采购下单、催收、付款、工资执行和定时报告，也不声称完整移植上游 44 项技能。沿用同一 Apache-2.0 LICENSE 原文；所采用 small-business 路径无额外 NOTICE。

2026-11-16整期入口：新增本项目 `tax-period`，按五阶段选择既有技能与实际 direct 工具，保留单项请求边界及自主计算。`references/planning-cash.md` 适配仓库 `05-reconstruction/codex/skills/taxes-company-advisor/references/planning-cash.md` 的合法方案、税后现金与公私资金方法；原参考及许可保留。补充真实扣除/优惠/亏损/法定选择、减税与递延、本期/全年/合同全周期及租赁三口径区分。旧参考的政策核查日期只是历史线索，不代表本次验证，也未复制成默认税率。共享宿主路由、接续投影和中国业务限制是本项目实现，不属于 Anthropic 上游能力。

## 2026-11-21 三项工作流及文件归属

本项目将下表所列 Anthropic 工作流改编为中国企业的增值税规划、税款现金核对与会计交接。表中的本地路径均相对于 `plugins/finance/skills/tax-review/`。两个角色按宿主授权读取，支持委派时由宿主把角色说明、范围、所需字段和只读工具交给工作者，无委派时使用同一取数和独立复算方法。

### Portfolio Rebalance Review 与 Alts Brief

原作者及固定源为 [Anthropic / claude-for-financial-advisors，486da32be7ea606e30b6901134efacc62c1c3ed2](https://github.com/anthropics/claude-for-financial-advisors/tree/486da32be7ea606e30b6901134efacc62c1c3ed2)。根目录两份角色由上述技能调用。该提交的 [LICENSE](https://github.com/anthropics/claude-for-financial-advisors/blob/486da32be7ea606e30b6901134efacc62c1c3ed2/LICENSE) 为 Apache-2.0，已随插件保留相同的 [LICENSE](LICENSE)，SHA-256 为 `cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30`。该提交无 NOTICE。

| 固定提交内的源文件 | 本地文件 | 保留及替换 |
|---|---|---|
| `skills/portfolio-rebalance-review/SKILL.md` | [references/vat-planning.md](skills/tax-review/references/vat-planning.md) | 从目标约定、基准与数据复核，走到归类、偏离、拟定与修改、现状对比和决定。持仓／税批改为票及可选属期；投资风险指标、证券交易及账户配置带宽限于原产品。 |
| `skills/portfolio-rebalance-review/templates/drift-analysis.md` | [templates/vat-comparison.md](skills/tax-review/templates/vat-comparison.md) | 保留摘要、口径、现状、偏离、压力情景、调整前后与异常；改用税额、两种税负与付款。 |
| `skills/portfolio-rebalance-review/templates/rebalance-rationale-memo.md` | [templates/vat-decision.md](skills/tax-review/templates/vat-decision.md) | 保留行动依据、动作、成本、备选、限制、未决及审批；替换为逐票依据和真实操作回执。 |
| `agents/holdings-sanity.md` | [agents/vat-data-review.md](skills/tax-review/agents/vat-data-review.md) | 保留时点、量级、汇总、勾稽、完整性、时效、重复七类独立检查及其下游影响。 |
| `skills/alts-brief/SKILL.md` | [references/tax-cash-brief.md](skills/tax-review/references/tax-cash-brief.md) | 保留独立异源取数、近期／累计／未来承诺窗口、嵌入式头寸表、风险提示与逐字段来源；改为未用票、留抵、应补及付款简报。基金 NAV、资本催缴和绩效倍数只适用于投资业务。 |
| `agents/source-extract.md` | [agents/tax-source-extract.md](skills/tax-review/agents/tax-source-extract.md) | 保留单一来源、原字段与日期、带定位的证据、身份冲突、可达但无记录、部分结果与无连接的分流；替换为本机原件和账套读取。 |

上游外部依赖中，`partials/rules/client-data.md`、`account-only-systems.md`、`report-only-systems.md` 及 `partials/connectors/storage-examples.md` 的来源边界、汇总与明细覆盖、替代取数落实在本地 [tax-sources.md](skills/tax-review/references/tax-sources.md) 与提取角色。证券专用的 `partials/rules/fund-health.md`、`platform-analytics.md`、`providers/cais/`、`providers/schwab/` 及投资平台调用、交易与披露流程不适用于会计工作，本地使用税务机关资料、已授权账库与银行凭据。

### Tax Season Organizer

原作者及固定源为 [Anthropic / knowledge-work-plugins，0e0fcacddcc892eb92a1b7873ff9d68159c47571](https://github.com/anthropics/knowledge-work-plugins/tree/0e0fcacddcc892eb92a1b7873ff9d68159c47571/small-business/skills/tax-season-organizer)。下列上游路径相对于 `small-business/skills/`。该提交 [根 LICENSE](https://github.com/anthropics/knowledge-work-plugins/blob/0e0fcacddcc892eb92a1b7873ff9d68159c47571/LICENSE) 的 Apache-2.0 正文后附有额外文本。本地按字节保留[该提交的完整许可证原件](LICENSE.knowledge-work-plugins)，SHA-256 为 `a6946284993aeec75c7d75906064b66210c46051e562077efb30eb6dcfe72e26`。该提交的根及本包无 NOTICE。

| 固定提交内的源文件 | 本地文件 | 保留及替换 |
|---|---|---|
| `tax-season-organizer/SKILL.md` | [references/tax-organizer.md](skills/tax-review/references/tax-organizer.md) | 入口辨主体和地区、当期或年度，两条路径均含关账核对、正式数据与异常交接。美国预估税和年度付款人清单分别改为中国申报准备与全年逐期对账。 |
| `tax-prep/SKILL.md`（上游入口依赖） | [tax-period/SKILL.md](skills/tax-period/SKILL.md)、[references/tax-organizer.md](skills/tax-review/references/tax-organizer.md) | 保留先核账及已对账期间、已关账不重复关闭的路径。使用现有账前、对账及关账能力，未核范围标为条件试算。 |
| `tax-season-organizer/reference/calculation-assumptions.md` | [references/vat-calculation.md](skills/tax-review/references/vat-calculation.md) | 保留期间、累计、已付款、逾期与假设披露。US 联邦税档、SE tax、safe harbor 等改为适用中国税种、留抵、预缴和应补的条件。 |
| `tax-season-organizer/reference/connector-queries.md` | [references/tax-sources.md](skills/tax-review/references/tax-sources.md) | 原账务、薪资及支付渠道按账套、凭证、发票、税务账户、银行与导出资料分工；保留缺明细、跨源去重和本机文件替代路径。 |
| `tax-season-organizer/reference/output-formats.md` | [templates/tax-handoff.md](skills/tax-review/templates/tax-handoff.md) | 保留两类完整交付格式、假设、缺件与到期日；采用中国当期申报底稿与全年有效版本索引。 |
| `tax-season-organizer/reference/gotchas.md` | [references/tax-exceptions.md](skills/tax-review/references/tax-exceptions.md) | 保留跨源重复、身份／资料误判和条件边界；替换为属期、用途、红字、预缴、地区与生效期。 |
| `tax-season-organizer/reference/examples/quarterly-estimate.md` | [examples/period-estimate.md](skills/tax-review/examples/period-estimate.md) | 从当期资料核对到金额、选票、支付与假设，用同一组事实对照两份客户约定。 |
| `tax-season-organizer/reference/examples/year-end-1099.md` | [examples/annual-handoff.md](skills/tax-review/examples/annual-handoff.md) | 保留全年度跨账／支付来源、去重、汇总和缺件；改为年中承接、全年申报与跨年支付。 |

`small-business/shared/{artifact-style,connector-neutrality,currency-and-locale,personal-data}.md` 提供上游资料交付、来源、币种、敏感字段的约束，对应本地的来源参考、角色和交接格式。1099-NEC、W-9、美元门槛、美国到期日与商业连接器不对应中国申报义务，本地所得税继续使用已有[企业所得税分支](skills/tax-review/references/corporate-income.md)。

原有顾问与整期的政策、租赁及公私现金方法合并到[合法方案与税后现金](skills/tax-review/references/planning-cash.md)。旧技能的历史正文可在[整合前提交](https://github.com/huxiaoyang-code/taxes-agent/tree/74abad70b89252f1eda2d85e65133cbadb5149ba)中查阅。中国税法依据、示例数字、计算器及本机权限由本项目按业务另行核验。
