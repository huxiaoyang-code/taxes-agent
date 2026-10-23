# 离线财税闭环：v1 合同与工程验收入口

关联 [#76](https://github.com/huxiaoyang-code/youshu-fork/issues/76)、[#77](https://github.com/huxiaoyang-code/youshu-fork/issues/77)。本片是 OFFLINE-00 的合同准备部分，**不是 #77 全部验收通过，也没有实现自动记账或算税**。

## 范围与准入

工程候选路径固定为福建漳州公司、小企业会计准则 `small-2011-basic-v1`、小规模增值税、季度资料包。企业适用准则、纳税人身份、实际申报频次、优惠与福建适用表式均须证据与会计核验；`small_scale_candidate` 不等于税务认定。`taxpayerStatus` 也能明确表达 `missing / unknown / conflict / unsupported`，不会把待确认企业默认为小规模。

拟优先支持服务收入与服务费用，再接工资、资产、银行与连续期间；本片只验证输入合同。存货成本、复杂红冲、特殊税务业务仍需后续明确支持矩阵。业务不在支持范围必须报告 unsupported；资料不全、未知、冲突与不适用分别保留。本期不做前端、税局登录、采集、提交或缴款。

普通客户提供票据、合同、银行流水、工资与资产等基础资料和事实问卷。不得要求客户先编凭证、指定借贷科目、填写已算好的税额。历史迁移可复用既有 `import-incremental.mjs` 的显式独立入口，但 **`business_materials` 合同不接受历史凭证载荷**；本片未实现新的迁移适配器。

## 可执行合同

权威可执行 schema 是 `06-workbench/server/offline-contracts.mjs` 的严格字段校验，版本 `offline-close-loop/1`。无未知字段透传；不隐式转换类型或填零；金额是两位小数字符串，精确转换为 BigInt 分。金额最大绝对值 9999999999999.99；拒绝浮点、指数、空白、超精度与负零。红冲金额可以为负，但必须有 `correctionOf` 的前版本和发票证据。本片只检查引用形状，不验证原票是否实际已入账。

所有文档公共字段为 `kind, version, id, scope, sourceVersion`。`scope` 精确包含 `enterpriseKey, accountSetId, period, currency`；一企一个账套，季度 `20xx-Q1..Q4`、币种 CNY。借助既有 `canonicalEnterpriseKey` 要求身份已经规范化，不按企业名称猜测。

| kind | 必需的专属字段与用途 |
| --- | --- |
| manifest | `mode, profileId, taxpayerStatus, region, evidence, facts, history, supersedes`；客户资料清单，mode 仅 business_materials |
| evidence | `category, format, locator, sourceLocation, coveragePeriod, sha256, documentDate, status`；locator 是本机登记表不透明 ID，不是路径/URL；sourceLocation 是 sheet/row/field，可为 null，行号为正整数字符串 |
| questionnaire | `facts`；业务事实，不包含会计科目；需同版本 manifest 上下文 |
| task-plan | `tasks, periodStatus`；只验证依赖和状态边界，不执行任务或认证整期完成 |
| data-request | `items, delivery`；delivery 只允许 local_only，没有邮件/消息发送动作 |
| voucher-candidate | `date, factIds, evidenceRefs, ruleId, ruleVersion, status, entries, idempotencyKey`；证据必须恰为所引用事实的来源并集，每行一侧正数另一侧为零、整体平衡；不代表已审分录或可过账许可 |
| tax-computation | `taxType, status, ruleStatus, lineage, fields, blockerCodes`；当前真实规则未启用，只接受 blocked + unknown/null，不能虚构税额零 |
| review-bundle | `resultVersion, lineage, voucherIds, taxComputationIds, unresolvedCodes, status`；有未决项不得 pending_review |
| review-decision | `bundleId, resultVersion, lineage, decision, reviewerRef, feedback`；可接受反馈/拒绝；**confirm 当前明确拒绝**，留 #82 绑定真实不可变底稿与当前版本后实现 |

`validateOfflineContract(document, { manifest })` 返回固定形状 `{valid, validationOnly:true, authorizesExecution:false, errors:[{code}]}`。无上下文的派生文档拒绝；同企业/账套/期间、输入版本与证据来源版本必须匹配。`valid` **只说明数据合同成立**，不是资料齐全、业务真实、规则适用、凭证正确、可以执行或会计确认。输出错误只有固定代码，不返回用户原值/路径/标识；函数不改输入，导入不读写文件/数据库、启动服务或访问网络。

`lineage` 精确包含 manifestId/inputVersion/ledgerVersion/ruleVersion。后续运行器必须以这四者及输出摘要形成结果版本；任一改变都使旧计算/确认失效。本片不提供持久化失效、局部重跑或幂等入账。

## 事实、零业务和历史

每条事实具有 `factId, type, state, date, amount, evidenceRefs, reasonCode`。类型包括销售、服务费、工资、银行、期初、资产、存货、不可扣除费用事实和业务范围。不可扣除费用事实只是待判断业务事实，客户不能提供 `tax_adjustment` 或最终税额；具体税务调整留内部规则处理。

| state | 金额与证据约束 |
| --- | --- |
| known | 非零金额、期间内日期、已提供同版本证据；销售/服务费还要 business 事实 |
| zero | 恰为 0.00、期间内日期、明确提供且可追溯证据；不等于整期零业务 |
| missing / unknown / unsupported | amount=null，明确 reasonCode；不能按 0 参与计算 |
| conflict | amount=null，reasonCode，至少两份证据引用；暂停冲突分支 |
| not_applicable | amount=null，reasonCode 与明确提供的证据；不是缺失的别名 |

销售与服务费的 `business` 包括 nature（service/goods/unknown）、performance（completed/not_completed/unknown）、settlement（received/paid/unpaid/unknown）、vatTreatment（unknown/missing/conflict/not_applicable）。这些字段避免把“存在销售金额”误当作“服务已履约且已收款”；未知税务处理仍阻塞真实生成。业务范围已知时 `amount=null, answer=service_company/trading_company/other`，不要求客户把业务描述编成金额。

证据 `scope.period` 是所属资料包期间，`coveragePeriod` 是来源实际覆盖期间；事实不能使用错期证据。历史依赖单列 `period, enterpriseKey, accountSetId, resultVersion, status, evidenceRefs`，available 必须前期、同企业账套、前期覆盖的 historical_return/opening_report 证据。Q2 → Q3 合成案例验证此区别；不会把缺前期历史当作零期初。真实历史是否经审定、是否连续、后期是否依赖原版本由 #79/#80 检查。

## 原始资料映射与后续依赖矩阵

以下是 #78 的显式映射目标，**解析器尚未实现**。不按文件名/文件数量推断完整度，不做 OCR。JSON 键、CSV 表头或 XLSX 表名/列由本机映射配置提供，禁止用猜测列直接记账。

| 原件 | 建议字段映射到事实 | 定位与关键缺项 |
| --- | --- | --- |
| 发票/销售 JSON、CSV、XLSX | 发票标识→factId，开票/业务日期→date，金额→amount；合同履约和收款事实→business | locator + sheet/row/field；发票与履约/结算冲突需澄清，非只补金额 |
| 银行 CSV/XLSX | 交易标识、发生日、收/付款金额、交易方向、对方/摘要 | 本片只保留 bank_activity 汇总事实，逐笔映射、来源指纹与账户核对由 #78 扩展，不能拿此合同宣称银行导入完成 |
| 工资/资产/库存表 | 业务日期、期间、金额与明确存在/不存在声明 | 缺整类材料、计量基础或适用判断分别报 missing/unknown/unsupported |
| 历史报表/申报 JSON、CSV、XLSX | 历史期间、结果版本→history；证据覆盖期→coveragePeriod | 原件保留本机；不把客户提供历史税额当作本期算法输入 |
| 签名声明/合同 PDF | 本机人工核验并转为事实 + evidence | format=pdf 只登记证据，未实施提取或 OCR |

| 任务 | 必要依赖（后续规划器必须实际验证） | 可独立推进 |
| --- | --- | --- |
| 标准化 | 企业身份、来源版本、显式字段映射 | 可逐份材料处理，冲突分支不标完成 |
| 资料评估/补件 | 企业/期间业务事实、预期材料规则、历史 | 针对事实缺口生成请求；已提供的不重复索取 |
| 自动凭证 | 合法金额、业务事实、来源证据、适用会计规则、幂等键 | 仅充分且支持的分支，复用既有核算模块 |
| 连续期间核算 | 真实期初、前期状态、凭证、期末控制 | 不虚构历史或直接累计损益代替结转 |
| 申报数字 | 已验证账务、调整、已核法规与本地表式、期间频次 | 不依赖缺少分支的税额保持 blocked |
| 复核确认 | 当前结果版本、完整底稿与未决项、会计反馈 | 更正后只重跑受影响分支、旧确认失效 |

任务状态使用 ready/blocked_missing_data/blocked_conflict/blocked_unknown/unsupported/stale/not_applicable。completed 和整期 ready_for_review 保留名称但本片拒绝，避免客户状态字段伪造执行凭据。ready 也仅是合同状态，不授予执行权。#79 将据实计算依赖状态，#80/#82 绑定实际执行回执和版本。

补件项包括 requestId/factIds/reason/affectedTasks/acceptedMaterials/alternativeEvidence。原因解释为什么需要、影响任务与可接受替代证据；本片拒绝向已 resolved 的事实再次索取材料。请求仅形成可转发本机文本/文件。

acceptedMaterials 与 alternativeEvidence 共用封闭基础材料目录：`invoice_csv/xlsx/json/pdf`、`bank_statement_csv/xlsx/json`、`bank_signed_statement_pdf`、`payroll_csv/xlsx/json`、`asset_register_csv/xlsx/json`、`inventory_record_csv/xlsx/json`、`contract_pdf/json`、`business_declaration_json/pdf`、`opening_report_csv/xlsx/json/pdf`、`historical_return_pdf/json`（斜杠表示同前缀分别取后缀，例如 invoice_csv、invoice_xlsx）。未知材料 ID、预制凭证和最终税额均拒绝；历史申报是既存原件，不是请求客户计算本期税额。reason 是本机说明文本，结构校验不充当自然语言业务审定，补件生成器仍须按目录生成事实请求。

## 规则来源登记（2026-10-24 核对；尚未启用）

由管理者核对的官方入口如下；来源核对和实际适用/会计审定是不同状态，不在运行模块内编入真实税率：

| 来源 | 当前证据与限制 |
| --- | --- |
| [财政部、税务总局公告2026年第10号](https://shanghai.chinatax.gov.cn/zzzb/zcwj/202602/t479283.html) | 官方文字来源已核；2026-01-01 至 2027-12-31 相关政策。不可直接沿用旧“≤起征点”判断；适用条款、交易类型与企业资格待完整会计核验 |
| [税务总局公告2026年第6号](https://fgk.chinatax.gov.cn/zcfgk/c100012/c5247507/content.html) | 2026-02-01 起表式调整；表栏与当地适用待复核，不把2021旧表当当前生产模板 |
| [2026-02-09更新的小规模申报表下载入口](https://shanghai.chinatax.gov.cn/tax/bsfw/xzzx/bgxz/sbzsl/202107/t459066.html) | 已找到官方附件线索；福建后续试点及2026 Q3适用表式尚未全核 |
| [财政部小企业会计准则附录](https://kjs.mof.gov.cn/zhengcefabu/201111/P020111118325852734144.pdf) | 复用 accounting-profiles.mjs 已登记来源；本片未新增会计规则批准 |

所有真实税务输出 `source_checked_accountant_pending` 或 unknown/unsupported，并保持 blocked、金额 null。仍需核对征管公告与福建本地试点、具体表栏、有效/失效日、企业资格、不同交易和历史政策。以上不是已完成的规则目录。

## 工程黄金与未完成验收

`06-workbench/test/fixtures/offline-close-loop/inputs/` 只有合成基础资料，`expectations/` 独立保存预期。产品模块不读取黄金；测试把黄金当作客户输入时会拒绝。16组覆盖非零收入/费用、组合、有证据零、更正替换、缺整类、缺字段、重复、跨企业、连续两季度、账税差异算术、不支持、未知、冲突、不适用和错期。

预期分录和 `expectedPreCloseTrialBalances` 是**工程假设的未结转试算**，不是已审生产会计结果；尤其连续期损益累计不能叫正式结账余额。每份预期有文字过程。独立测试方法逐位解析十进制、按借贷汇总核平、用商/余数复核人工保留的算术期望。个别 `syntheticArithmetic` 使用 7/100，醒目标 testOnly，纯粹测试舍入，**不是任何税率、不是申报金额、不能启用真实算法**。实际申报字段始终未知/null。

尚未完成：至少12组经会计审定的生产分录/结转余额/真实非零税额黄金、两个合法连续申报期的税务历史实测、完整税务规则/福建表式、客户试用。#77 必须保持未完成这些验收项。后续 #78 可独立开始原始资料规范化；#80/#81 的生产验收不能以本工程样例替代。

复用边界：企业身份用 enterprise-identity；会计科目与准则用 accounting-profiles；入账继续接既有 accounting/import-incremental；金额/期末控制用既有 money/period-end-controls；银行、辅助核算、报表、审计、备份继续复用原模块。纯校验模块不导入带 DB 副作用的入账模块。#49/#51/#54 的在途共享集成不在本片改动范围。

验证：在 `06-workbench` 执行 `node test/offline-contracts.test.mjs`。没有新增包或改全量入口。回退可通过仅删除本片新增文件的 revert PR；本片无 DB 迁移或运行时接线，不涉及账套回滚。
