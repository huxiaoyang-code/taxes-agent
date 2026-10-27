# 供 Agent 使用的内部请求契约

本机启动：后端使用项目 scripts/windows-start.ps1 的显式 -DataDir 和 -Port 0，或在独立进程设置 WORKBENCH_DATA_DIR 后启动 server/server.mjs；MCP 配置 FINANCE_API_BASE 为该实际监听地址，并配置 FINANCE_DATABASE_PATH 为同目录 workbench.db。不沿用全局8787或真实库做验收，不改用户全局配置。`harness_scope_discover` 仅查询现库；首次旧账接手按[导入指引](../../legacy-book-import/SKILL.md)使用 book_import_incremental 的 create/append，确需空账套才用 account_set_create，完成后重新读取真实绑定。已建空账套可按既有约束 append，不能再 create 同企业。演示生成器预建空账套，只验证已有目标接入，不声称任意新企业bootstrap完成。

客户提交原始资料；以下对象由 Agent 调查、核对并编制，保存为任务requestFactId 选中的事实 value。字段不授予业务支持，真实模块仍逐项校验。路径均为绝对路径。target 在需要时为 `{dbPath,databaseInstanceId,enterpriseKey,accountSetId}`，必须与 Harness scope 及真实现库绑定相同。

| capabilityId | requestFactId 选中的事实 value | 关键返回 |
| --- | --- | --- |
| agency.workpaper | `{target,manifestPath:原生agency-business-materials/1文件}`；必须含独立原始资料 originals 与 Agent 整理的 agency-raw-facts/1 sources，不接受工作底稿充当原件 | domain.accounting/obligations/issues、实际sourceRefs/rule/code/dependency、nativeAssetContext；月度 YYYY-MM |
| agency.posting | `{target,manifestPath,batchId,evidenceDir,feedbackPath,correction?,ledgerReconciliation?}`；可选项与既有 agency CLI 完全相同。evidenceDir 是现有绝对归档目录，与数据库、manifest、每份原件及派生source各自的父目录均不得相等、互为祖先或子目录。例如同级 `run/data/workbench.db`、`run/originals/`、`run/work/manifest.json`及facts、`run/agency-evidence/`可隔离；`run/work/evidence/`或共同祖先`run/`不可用。manifest中相对路径按manifest目录解析。feedbackPath 为人类原始确认材料，非 Agent 编写 | prepare 的 proposal含identity、targetVersion/dependencyDigest/planDigest/archive；execute/query 的实际审计/导入来源/现账 proofDigest，unknown沿原identity查询，不能新建批次盲重试 |
| agency.annual-calculation | `{target,manifestPaths:[各月原始manifest绝对路径]}`；Harness scope=YYYY，同企业/账套/实例/币种，从真实开业月到12月所有当期原始session完整，不接受月汇总或年度数字替代 | scope=YYYY、nativeScope及domain.scope=YYYY-12、domain.dependencies/obligations/yearEndAdjustments/nextYearCarryState/issues；原始依赖或实际账务变化旧确认失效，显式重算产生新回执，不是年度关账/申报提交 |
| voucher.create | `{target,voucher:{period:"2026-03",voucher_date:"2026-03-24",summary:"有依据的实际业务",status:"draft",entries:[{code:"1122",debit:12.34,credit:0},{code:"5001",debit:0,credit:12.34}]}}`；示例科目金额不能作为客户业务规则 | 实际审计 proof，current.voucherId/period/status/entries |
| voucher.post / voucher.unpost | `{target,voucherId:真实ID,correctionOf?:{taskId:原任务,targetVersion:原版本}}` | 实际审计和当前凭证状态；封账或后期派生依赖可能阻断 |
| offline.action_plan | `{inputPath:现有offline-action-input/1文件}` | tasks/candidate/reasons/customerRequest/planVersion，不执行 |
| offline.posting | `{version:"offline-posting-input/1",inputPath,target,selected:{taskId,businessKey},confirmNewSourceBinding?:true}`；selected 来自 action_plan，不猜业务键。prepare/execute/query 由 Harness 控制，不自行构造 confirmation | status/applied/operationId/dependencyDigest/policyDigest/candidate/evidence，实际业务边界以返回为准 |
| offline.period_plan | `{version:"offline-period-plan-input/1",inputPath,target,month:"2026-03"}` | issues、实际scope和bindingDigest、可执行时manifest；不等于整期完成 |
| offline.vat_q2 | `{version:"offline-vat-q2-request/1",priorInputPath,targetInputPath,target}` | 有限税务字段 calculationReady/computation/codeBinding/limitations，不是全税申报 |
| materials.init / inspect / recover | `{path:材料Store绝对路径}` | 现有Store实际状态、scope和回执；init仅全新目录，recover仅已死锁 |
| materials.receive | `{path,configPath:原有材料映射配置文件}` | 实际规范化材料与源文件回执 |
| review.init / inspect | `{path:复核Store绝对路径}` | 具体字段复核状态，不等于Harness任务复核 |
| review.register | `{path,inputPath:现有offline-vat-input/1文件,options:{expectedJournalHead:null或当前head,supersedes:null或当前versionId}}` | 实际bundle及规则/代码/来源/总账绑定、workpaper文件 |
| review.feedback | `{path,feedback:现有offline-accountant-feedback/1对象}`，必须从实际复核包选字段及绑定；不得猜版本 | 既有Store校验的新反馈与有效性 |
| batch.start | `{target,manifestPath,outputDir,jobKey}`；沿现有批manifest合同使用真实period_plan产物，或在 `items[].periods[].harnessTasks` 绑定当前 `{storePath,taskId,capabilityId,dependencyDigest}`。Store/任务/能力/版本必须匹配，不能伪造ready或用旧执行替代新请求 | 既有runner实际stage状态、部分效果与报表产物；缺batch3按原安装/备份契约 |
| batch.status / resume | `{target,jobKey,retry?:{itemKey?,period?,stageKey?,reason}}`（retry仅resume） | 实际持久job状态；resume复核成功阶段证据，不重造队列 |

现有材料、action输入、税务复核详细原生合同仍由对应模块维护。Agent 应优先用 voucher 固定API完成已核对的企业特例分支，或在具备完整资料时转换到现有offline输入；不能假称任意业务已覆盖。原生源定位见 discover.traceReferences，不需要加载历史逆向报告。

期间能力请按 `harness_discover({domain:"period"})` 再读取选中合同。period.inspect 返回真实 stateDigest；period.impact 使用明确的 Store/task/版本 bindings。四项期间写入需要 expectedStateDigest 及真实范围授权，unpost-derived 还需原凭证ID和指纹。batch.start/resume 的 prepare 纯读，不启动job、不写账；materials/review 的 prepare 不支持并会在原生调用前拒绝。materials/review 与 offline.action_plan/offline.vat_q2 在当前 Harness 字符串范围仅支持季度，不能把月范围传入后期望自动转换。
