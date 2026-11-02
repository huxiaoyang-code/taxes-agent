# 来源、许可与中国化修改

上游：[anthropics/knowledge-work-plugins](https://github.com/anthropics/knowledge-work-plugins/tree/2574e29377c7173d0cecffef29a6ecbd7f8ccb5d)，固定提交`2574e29377c7173d0cecffef29a6ecbd7f8ccb5d`，原finance插件版本1.3.0。原中国化 fork 为[huxiaoyang-code/knowledge-work-plugins](https://github.com/huxiaoyang-code/knowledge-work-plugins)，仅作为历史来源；后续插件与后端统一在 [huxiaoyang-code/taxes-agent](https://github.com/huxiaoyang-code/taxes-agent) 的 `plugins/finance` 维护。本项目不代表Anthropic对中国财税规则或结果背书。

2026-10-30修改：改编原8个finance Skill的触发描述、业务工作流、模板和复核方法；将`sox-testing`更名`internal-control-review`；替换美国ASC/GAAP、工资税及SOX默认适用表述，改用实际中国会计准则和已核中国规则；新增税费核对与按需参考。保留月结日历及依赖作为可调整指导，不建立运行时DAG。连接配置改为本机中国财税MCP，移除未配置和不相关的上游服务器。报告改为金额、凭证/计算、规则优先，调用和原件可深入索引。

原文件路径：`finance/skills/{journal-entry,journal-entry-prep,reconciliation,financial-statements,variance-analysis,close-management,audit-support,sox-testing}/SKILL.md`，以及`finance/README.md`、`CONNECTORS.md`、`.mcp.json`和`.claude-plugin/plugin.json`。各改编文件保留修改声明；本目录[LICENSE](LICENSE)为上游Apache-2.0原文，不翻译。上游finance及所采用文件目录未提供额外NOTICE；此次初始中国化未改编其他插件内容。

2026-10-31修改：再次逐项核对固定基线的financial-statements、journal-entry-prep与reconciliation原文，保留资料收集、报表比较和差异、常见凭证支持、两侧余额调节及复核方法；移除原生工作底稿、JSON绑定和季度bundle作为交付必经路径。模型自主选择Python、表格或可选计算器，系统记录实际计算，派生账簿与原生入账状态分列；用户产物使用中文。

2026-11-01修改：完整账期改为系统依据明确输出合同生成固定中文复核卡片，默认科目余额、银行与现金、税费及三张报表；凭证、规则和参数按需查看，后台证据不重复铺成多份报告。保留 Agent 自主计算、原生入账控制及上游业务方法，不新增运行时 DAG。固定卡片和中国后端合同为本项目适配，不归为 Anthropic 上游实现。

中国法规、准则、税率和地区条件按需取自已核官方资料或taxes-agent可选规则服务，保留本次适用依据；引擎实现及接口能力以实际后端为准。上游通用方法不是中国税法依据；这里只引用工作方法，不从上游示例推定适用政策。

2026-11-02迁入：完整迁入原 fork 的 finance 目录（含隐藏 manifest/MCP、九个中文 Skill、共享与税务参考、许可证及测试），不迁入其他上游插件。来源为已核远端 main 提交 [`de879f81f2963547b5d92fc6d4d9db1b4487ea08`](https://github.com/huxiaoyang-code/knowledge-work-plugins/commit/de879f81f2963547b5d92fc6d4d9db1b4487ea08)，与中文内容提交 [`f8b0ea50bf0aa9318d2efe8abfab16a1a330ae24`](https://github.com/huxiaoyang-code/knowledge-work-plugins/commit/f8b0ea50bf0aa9318d2efe8abfab16a1a330ae24) 的 tree 相同；此前自主计算方法改编提交为 [`888a1f890b1035b30c13d9a3d842598b0dea6449`](https://github.com/huxiaoyang-code/knowledge-work-plugins/commit/888a1f890b1035b30c13d9a3d842598b0dea6449)。本次只统一维护、安装、默认路径及自包含测试，不改财税算法与业务方法；共享连接参考同步单仓库原位加载说明，移除外部插件目录选项。Apache-2.0 LICENSE 原文保持；测试按 LF 归一化后核对固定已核 SHA-256，不要求 clone 带上游历史对象。

2026-11-02账前适配：新增 `prebook-review`，采用 [Anthropic small-business 1.35.1](https://github.com/anthropics/knowledge-work-plugins/tree/84d8efdb6e80e2b26898e5c3109d13eddde97761/small-business) 的工作方法，固定上游提交 `84d8efdb6e80e2b26898e5c3109d13eddde97761`。核验用本地 fork 提交 `01f6af59c30e3b98fc2d4a1711440ec5ef696c0f` 的 `small-business` 与该固定提交无差异。改编来源为 `small-business/skills/{ap-processor,month-end-prep,cash-flow-snapshot,report-builder,inventory-planner}/SKILL.md`，以及这些目录中的 `reference/intake_and_extraction.md`、`matching_and_exceptions.md`、`gotchas.md`、`report_spec.md`、`close-packet-format.md`、`data_sources.md` 等按需参考。

保留单据去重、采购收货匹配、有日期资金起点、明确资料缺口和指标来源的工作方法；改为中国一般纳税人与小规模的账前核对及补件交接，使用同仓库真实 direct MCP 和后端合同。原版月结对本期已记账数据的依赖改为上期账与本期基础资料；中国增值税条件试算、回复版本绑定和报告为本项目实现，不归为上游已有能力。未迁入美国税务公式、补货预测、采购下单、催收、付款、工资执行和定时报告，也不声称完整移植上游 44 项技能。沿用同一 Apache-2.0 LICENSE 原文；所采用 small-business 路径无额外 NOTICE。
