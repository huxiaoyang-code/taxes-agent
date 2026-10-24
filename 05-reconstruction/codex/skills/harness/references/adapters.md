# 供 Agent 使用的内部请求契约

本机启动：后端使用项目 scripts/windows-start.ps1 的显式 -DataDir 和 -Port 0，或在独立进程设置 WORKBENCH_DATA_DIR 后启动 server/server.mjs；MCP 配置 FINANCE_API_BASE 为该实际监听地址，并配置 FINANCE_DATABASE_PATH 为同目录 workbench.db。不沿用全局8787或真实库做验收，不改用户全局配置。`harness_scope_discover` 仅查询现库；新企业用已授权的现有 account_set_create，然后重新读取真实绑定。演示生成器预建空账套，只验证已有目标接入，不声称任意新企业bootstrap完成。

客户提交原始资料；以下对象由 Agent 调查、核对并编制，保存为任务首事实 value。字段不授予业务支持，真实模块仍逐项校验。路径均为绝对路径。target 在需要时为 `{dbPath,databaseInstanceId,enterpriseKey,accountSetId}`，必须与 Harness scope 及真实现库绑定相同。

| capabilityId | 首事实 value | 关键返回 |
| --- | --- | --- |
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
| batch.start | `{target,manifestPath,outputDir,jobKey}`；manifest从真实period_plan产物保存，不改内容伪造ready | 既有runner实际stage状态和报表产物；缺batch3按原安装/备份契约 |
| batch.status / resume | `{target,jobKey}` | 实际持久job状态；resume复核成功阶段证据，不重造队列 |

现有材料、action输入、税务复核详细原生合同仍由对应模块维护。Agent 应优先用 voucher 固定API完成已核对的企业特例分支，或在具备完整资料时转换到现有offline输入；不能假称任意业务已覆盖。原生源定位见 discover.traceReferences，不需要加载历史逆向报告。
