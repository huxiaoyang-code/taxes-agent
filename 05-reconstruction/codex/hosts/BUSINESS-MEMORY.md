# 绑定企业与接续历史口径

四宿主共用同一企业记忆服务。配置生成器仍只生成文件，不建账、不读原生 Claude memory、不猜第一家企业。企业方法、不可变版本和可重建案例索引放在实际账库；生成工作区只保存本机绑定和加载规则。

## 首次绑定与启动

先按 [统一入口](START-HERE.md) 生成全新工作区，后端与 `--database` 必须是同一实际账库。账套 ID 从已有账套核实；不要把示例数字当实际身份。在生成目录运行：

```powershell
node ./start-business-session.mjs --account-set-id <实际账套ID> --period 2026-11 --prepare-only
node ./start-business-session.mjs --check
node ./business-memory-context.mjs --check
```

`--prepare-only` 显式写入记忆索引和 `.finance/business-session.json`，不启动模型；正常首次启动同样自动准备，无需先手工整理企业方法。`--check` 仅核对已有绑定和只读摘要，未绑定即报错，不建表、不初始化、也不刷新。生成器指定的资料和记录目录随会话固定。

`.finance/business-session.json` 使用 `finance-business-session/1`，由实际 DB 解析 `databaseInstanceId`、`enterpriseKey`、`accountSetId`、`period`、`currency`，并绑定绝对 `databasePath`、`sourceRoot`、`auditDir` 和工作区。每次启动和读取都会重新解析实际 DB，恢复或替换成另一账库不会因为账套数字碰巧相同就通过。不要编辑它模拟切换身份；换企业或期间生成新工作区、开新会话。旧企业的 Claude 会话不能在新工作区恢复。

已绑定工作区后，省略账套参数即可跨进程重启：

```powershell
node ./start-business-session.mjs -- --pi-root '<官方Pi 1.1.0包绝对目录>'
node ./start-business-session.mjs -- --claude-cli '<Claude 2.1.309 exe或JS入口绝对路径>'
node ./start-business-session.mjs -- --dsh-cli '<dsh包JS bin绝对路径>' --task '按已选方法处理本期并保留缺口'
node ./start-business-session.mjs -- --zcode-cli '<ZCode exe或JS入口绝对路径>'
```

只执行与所生成 `--host` 相符的一行。也可以首次把 `--account-set-id ... --period ...` 放在 `--` 前。dsh 仍需本人模型覆盖层；启动器不复制凭据。CLI 路径使用真正 exe 或 JS 入口，不使用需要 shell 插值的 cmd/bat 包装。

## 摘要、方法与本期对象

初始上下文只有 `finance-company-context/1` 固定摘要和方法目录，不含所有历史记录。随后按实际 `methodRef` 调用 `finance_method_read` 查看取数、日期/金额、去重、转换、科目角色、执行版本、依据和缺口；只有相关问题才分页 `finance_case_search`。返回的稳定 `objectRef` 用于区分同企业同主题的不同合同/对象，不能按目录行号或相似名称任选一个方法。操作边界及候选/操作者选择说明见 [业务参考](../../../plugins/finance/skills/shared/references/business-memory.md)。

方法的 `definition.applicability.objectScope` 分为 `account_set`（整账套口径）和 `business_object`（具体业务对象）。后者用保存在本机的 JSON `matchConditions`：`sourceIndex` 指向本次 `sources`，`jsonPointer` 指向字段，`operator:'equals'` 与本机 `expected` 比较。向 `finance_company_context` / `finance_method_read` 传本期获准 `sources` 后，模型只收到 `matched`、`not_matched` 或 `unresolved` 等固定状态，不回显比较私值。任何非空自由 `scope` / `conditions` 仍表示未结构化条件，即使同时存在 typed match，也保持 `unresolved`、不可执行；纯解释文字应放 `notes`，不能靠删掉真实限制或曾被选择代替适用性核实。

`finance_method_run` 再读本期来源进行匹配，不能凭上次摘要中的 `matched` 跳过。执行只给实际保存的 `methodRef`、必要的 `objectRef`、本期 `parameters` 与 `sources`，不能用另一段自由脚本替换版本。`current_parameters` 的金额、日期、数量必须来自本期，旧版本的 `default` 不能兜底。`source=constant` 则必须采用方法保存的值；调用者可不传或传同值，异值报 `finance_memory_constant_conflict`，缺保存值则 `needs_local_selection` / `executable:false`，不能由本期调用补成一个新常量。需要每期变化的输入应在方法版本中明确为 `current_parameters`；改变固定比例须另提候选并审阅新版本。

脚本对象匹配时实读的字节 SHA 与计算器实际采用的来源 snapshot 必须一致，不能先用合同A1匹配、再用变成A2的文件取数。计算器保存 `methodSourceVersionChecks`，方法开始记录保存 `matchedSources`，两者留在本机；`finance_calculation_method_source_changed` 表示采用版本不符，子脚本不会执行该错误版本。执行后又发生来源/版本变化或可能已产生副作用时，保留实际结果并报 `unknown`，先核原执行，不能重做来消除未知。

**原生具体对象方法的当前支持范围有限。** `business_object` 目前只支持 `finance_tax_summary_calculate` 的 `originals` 原件绑定分支，披露 `nativeObjectBinding:'matching_originals_and_digests'`：全部实际 originals 路径须来自已匹配来源，强制使用匹配字节 SHA，全部 `bindings.originalId` 只能指这些原件；该对象方法不支持 `artifactRef` 派生产物分支。以A1作为匹配来源、实际却向原生工具传A2 originals，会拒绝，不能用未取数的A1为A2背书。其他原生 `business_object` 在context/read披露 `nativeObjectBinding:'not_supported'`、`executable:false`（通常 `status:'not_supported'`），不能概称均支持。

`account_set` 原生方法的既有路径不变，VAT、季度复核等仍保留原工具安全业务结果和产物索引。确定性资产折旧/摊销与损益结转使用结构化 `objectScope:'account_set'`，解释放 `notes`，正式选择后仍按其实际条件判断。脚本返回派生产物索引；执行成功不等于已核账或已过账。

## 自动接续、来源与版本

成功的原生 MCP 写入由后台同步企业目录。已绑定会话的普通 `finance_calculation_run` 自动核实实际 scope；完整调用记录落盘后再同步历史，脚本型 `finance_method_run` 也留下可接续案例。未绑定计算保持未知，不归给第一家企业。后台同步失败不把已经执行的业务变成可重做；先核原调用/结果，不能为了刷新目录重复计算或重复写账。

`finance_company_context`、`finance_method_read`、`finance_case_search` 及 hook 的企业上下文服务只读当前实际资料，摘要标识 `snapshot:'live_readonly'`。目录缓存的 `stale` / `refresh_required` 不等于方法已失效，也不是要求 Agent 维护刷新状态；具体能否执行看当前方法、对象匹配、依据状态与生效期。`finance_memory_prepare`、启动准备和 `--prepare-only` 保留为初始化及人工恢复入口，不是每做一笔业务的前置步骤。不新增事实登记、任务 DAG 或重复计算全部财务数字。

同一实际企业账套的版本和案例可以跨期、跨工作区及不同获准 `sourceRoot` / `auditDir` 接续。新工作区仍须重新绑定本期；后端不会把当前目录没授权/没挂载的旧材料直接判为变更。`unavailable_current_context` / `evidenceCurrentlyAvailable:false` 要据实披露，不能写成已重新核原件；已明确选择的方法可在当前条件满足时继续。已经观察到的 `changed` / `missing` 会保留并阻断依赖它的方法，换目录或重新 prepare 不能洗成 `current`。重新取得正确版本或作业务更正后，再由真实核验决定后续。

**跨期解释先比方法，再比各期输入。** 核对留存的方法版本、实际脚本/原生执行版本与取数定义，之后分别看各期对应来源/计算快照、金额及日期等输入版本。已证实同版本可说明沿用；输入变了导致金额不同不等于算法变了，证据不足也不能硬称相同。历史凭证合计和科目路径只证明入账金额/科目，`algorithm_unknown` 不能推出全额确认、具体分摊或方法不同。缺旧期对应版本原件/计算证据时，不拿已变更的本期原件回算旧期作为历史差异结论，保留未核；假设试算另行标清所用资料和假设。

业务交付须与真实方法版本及证据状态一致：本期执行/金额、已核口径连续性、历史证据缺口分别表述，不能因方法运行成功而放过未经证实的历史解释。验收者应查看报告中的这些结论是否能追到对应版本和旧期证据，而不只核本期金额。

操作者采用或变更方法时，在仓库根的本机交互终端运行（方法编号来自实际候选返回）：

```powershell
node 06-workbench/scripts/review-business-method.mjs --db '<实际账库绝对路径>' --account-set-id <实际账套ID> --period 2026-11 --method-ref '<实际bm:版本编号>' --source-root '<获准原件绝对目录>' --audit-dir '<该会话记录绝对目录>'
```

该入口要求本机真实 TTY，展示版本、依据和受影响的重叠版本，再收集操作者声明、理由、生效期和可选终止期。它新建选择版本，不覆写旧版本；保存 `replacementPolicy` / `replaces`。同一主题/对象在目标期间适用的选择中，只让最新 `revision` 有效；支持回溯及有限区间，区间外原有选择仍按其生效期判断。候选和模型 JSON 不能自行批准。

`WORKBENCH_DATABASE_MODE=readonly` 下所有记忆写入口（初始化、候选、选择、执行、后台同步）拒绝；读取及 `--check` 不另开写连接绕过。正常启动中的准备属于写路径，不能当作只读启动。独立改删版本/执行历史受不可变约束；确需整账删除时沿用原生账套删除及其权限/审计，记忆随所属账套级联清理，不能直接改 SQLite 清历史。

## Claude 生命周期与原生 memory

生成的项目 `.claude/settings.json` 设置 `autoMemoryEnabled:false`；`start-claude.mjs` 再对新进程设置 `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`。不修改用户全局设置、不迁移/删除旧 memory、不读取原生 `MEMORY.md`。`CLAUDE.md` 只写加载规则。依据见 [官方 memory](https://code.claude.com/docs/en/memory#enable-or-disable-auto-memory)。

`SessionStart` command hook 对 `startup|resume|clear|compact`（另对 fork 保守核验）调用同一只读上下文服务，输出 `hookSpecificOutput.additionalContext`。exec form 将 Node 与脚本分别配置，不靠 Windows shell 引号。每次新启动/clear 只另存最小 `session_id→实际scope` 身份元数据到 `.finance/claude-session-bindings`，不存方法、案例或 transcript；resume/compact 只核对已有映射。没有该映射的旧会话拒绝恢复，不能猜它属于当前企业。依据见 [官方 SessionStart](https://code.claude.com/docs/en/hooks#sessionstart)。

```powershell
node ./start-claude.mjs --claude-cli '<实际CLI绝对路径>' --check
node ./start-claude.mjs --claude-cli '<实际CLI绝对路径>'
node ./start-claude.mjs --claude-cli '<实际CLI绝对路径>' --resume '<本工作区已绑定会话UUID>'
node ./start-claude.mjs --claude-cli '<实际CLI绝对路径>' -- --print --allowedTools 'mcp__finance__finance_company_context' '读取当前企业摘要并保留未核项'
```

命令行提示词作为一个带引号的参数传入；启动器将它单独放在原生 argv 的 `--` 后，避免被 `--allowedTools` 等可变长工具选项吞掉。需要以前导短横线开始的文字时，可在宿主参数内再写一个 `--` 明确开始提示词。未传提示词的 `--print` 仍可从 stdin 读取，`--init-only` 不添加空提示词。

启动器固定工作目录、MCP、项目设置和恢复 ID，额外 argv 不能覆盖它们、重新打开 auto memory 或跳过权限。`--setting-sources project` 排除用户/本地设置覆盖，再显式加载已核的项目设置；组织策略仍按 Claude 原生规则生效。`--no-session-persistence` 只控制 transcript，不代替 auto memory 隔离。

SessionStart 的退出码不能独自阻止模型继续，所以另装 `UserPromptSubmit` 身份守卫：当前 DB 或恢复会话不匹配时在模型请求前拒绝。hook 不打开 `transcript_path`；不把其他企业的旧对话当成可信上下文。更改账库、目录或恢复目标后先重新启动并核对，不能在同一进程中手工改绑定。

## 四宿主实际装配边界

| 宿主 | 启动自动行为 | 会话内刷新 |
|---|---|---|
| Claude Code | 绑定→准备；SessionStart 读同一摘要 | startup/resume/clear/compact 自动重读。业务成功后的后台同步独立于 hook；hook 不迁移或写索引 |
| Pi | 绑定→准备；摘要追加到启动系统提示，保留原生 tool-search/deferred | 未接入额外生命周期 hook；会话中按业务需要读当前方法/案例，后台同步与其他宿主相同 |
| dsh | 绑定→准备；摘要和共享入口放在本次明确任务前 | 未声称有原生生命周期 hook；后续任务重新启动，或模型显式读取同一工具 |
| ZCode | 绑定→准备；工作区 AGENTS.md 要求先读摘要工具 | 未假设未经核实的上下文注入 API；摘要由模型首读 `finance_company_context`，是否实际读到用工具轨迹验收 |

直接运行未包装的原生 CLI 不能证明启动准备已发生。未建账的账前任务仍可使用原有未绑定入口；一旦需要企业历史，先核实并绑定实际账套。

## 明天先打开的阳性现场

在仓库根生成全新合成目录，再做只读检查：

```powershell
node 06-workbench/scripts/business-memory-acceptance.mjs prepare '<已存在父目录/全新合成绝对目录>'
node 06-workbench/scripts/business-memory-acceptance.mjs check '<刚生成的合成绝对目录>'
```

[该脚本](../../../06-workbench/scripts/business-memory-acceptance.mjs) 通过生产建账、已绑定宿主和真实 MCP 生成两家企业的历史计算，接到新月份、新金额、新来源/记录根。没有手工 `annotate` 归属，不调用模型、不读凭据或原生 memory；阳性现场不执行故意失败/来源篡改负例，本期方法留给实际 Agent 执行。

输出及 `model-fixture.json` 提供实际 `workspaces`、`targets`、`methods`、`currentSources` 和源码哈希；`模型任务.txt` 给合成甲企业本期目标，`独立预期.json` 留给验收者核算，不能喂给被验收 Agent。先从输出的甲工作区启动实际 Claude，交代该任务，观察它读摘要→方法→必要案例→按版本执行本期资料→交付金额与产物；乙企业应采用自己的方法，不能沿用甲口径。方法选择在夹具中使用合成 TTY 模拟，`humanApproval:false`，不是本人的真实财税批准。

`check` 只校验现场、当前方法及原件、源码哈希，不执行本期方法、不改账库。实现源码变化会拒绝旧现场，须以全新目录重新 prepare；不能把旧日志对应的源码当本次最终版本。真实模型执行轨迹、业务金额、产物与来源当前性另核，不能只看 `methodsExecutable:true`。

## R01–R14 逐点检查入口

下表是操作与证据定位，不预填验收通过。先跑上述阳性现场，再按 [独立 E2E](../../../06-workbench/test/business-memory-e2e.test.mjs)、[领域测试](../../../06-workbench/test/business-memory-domain.test.mjs)、[存储测试](../../../06-workbench/test/business-memory-storage.test.mjs) 和 [宿主测试](../../../06-workbench/test/business-memory-hosts.test.mjs) 的实际结果核对：

| 验收点 | 实际操作与应查看的结果 |
|---|---|
| R01 自动了解历史 | 新目录prepare；看实际绑定、配置/凭证/资产及生产MCP历史案例，不预填企业方案。连续性先核留存方法/实际执行版本与取数定义，不从单笔合计或科目路径猜算法；证据缺口如实列未核 |
| R02 历史状态 | E2E 查看已过账/封账、草稿、失败、本期及未来记录分别呈现；`executed_unreviewed` 不等于既定方法 |
| R03 可解释方法 | method_read 查看日期/金额、取数/去重/分摊/科目及缺口；不同对象有不同objectRef，typed match不能掩盖额外自由条件。看nativeObjectBinding明确原生对象支持范围；资产/结转为结构化account_set |
| R04 持久与恢复 | 存储/E2E 的迁移、只读和严格备份恢复；不可变版本仍在，案例可重建，不生成企业 MEMORY.md；整账删除与单版本改删分别验证 |
| R05 真实 direct MCP | E2E 真实 tools/list、读取/建议/执行、分页与错误路径；看固定投影、自动 callId、同账库范围，不靠 mock 成功 |
| R06 按存储版本执行 | 真实 Agent 用已选methodRef和新月原件；核固定constant不能被caller覆写、变量用本期值。核匹配SHA与实际snapshot一致；原生对象仅summary originals分支，A1匹配却A2实际取数或artifactRef分支拒绝 |
| R07 选择与区间 | 本机 review CLI 读完整候选并交互选择；看新旧版本/理由/生效及终止期、replaces 和最新 revision；模拟 TTY 不计真人批准 |
| R08 绑定及生命周期 | 宿主跨 Node 进程重启；实际 Claude startup/resume/clear/compact 各留 hook 轨迹，错账套/未知会话恢复拒绝；生成配置不算触发 |
| R09 原生记忆隔离 | 生成的项目 autoMemoryEnabled=false、启动进程关闭变量、CLAUDE.md 只有规则；不改全局设置、不读取原生 memory |
| R10 渐进披露/四宿主 | 初始摘要不塞全量历史；看实际方法/案例工具读取。四宿主配置分别检查，Pi/dsh/ZCode 边界按上表，不把 Claude hook 算到其他宿主 |
| R11 自动更新与只读 | 写/计算后重读，核live不写、跨根及来源状态。对齐各期输入快照与方法版本，不用变更后的本期原件回算上期作历史差异结论；报告与证据一致。核匹配→snapshot→执行后版本，后置变化/副作用保持unknown查原执行，不因刷新洗白 |
| R12 完整合成链 | 跑独立 E2E 的两企业两期、新金额/重复行、进程重启、版本/对象、来源失效、方法执行和恢复；真实宿主/模型业务另有轨迹 |
| R13 文档与版本 | 本手册、共享业务参考、架构/代码索引；核实际命令、结果文件、源码哈希、基线加未提交 diff 和未验证范围 |
| R14 原安全边界 | 原生凭证人审/期间/幂等/实际账库、来源与模型投影负例继续生效；核VAT/季度安全结果及产物保留，不把记忆或执行成功当申报完成 |

## 可复跑的合成程序验证

在仓库根运行：

```powershell
node 06-workbench/test/business-memory-hosts.test.mjs
node 06-workbench/test/finance-host-config.test.mjs
node 06-workbench/test/host-dsh.test.mjs
node 06-workbench/test/host-zcode.test.mjs
node --test 06-workbench/test/host-claude-argv.test.mjs
node --test 06-workbench/test/business-memory-storage.test.mjs
node --test 06-workbench/test/business-memory-domain.test.mjs
node --test 06-workbench/test/business-memory-e2e.test.mjs
```

`business-memory-hosts.test.mjs --prepare '<已存在父目录/全新合成目录>'` 保留基础四宿主工作区、两家合成企业与两个月范围；用于宿主绑定/错误路径验证，不代替上面的阳性模型现场。默认系统临时目录同样保留现场。独立 E2E 输出 `root/report/checks`，完整记录在该现场的 `E2E-result.json`；它包含故意失败/篡改负例，不能直接拿作干净模型阳性现场。Windows 沙箱若报 `audit_backup_invalid`，应保留失败并使用获准的合成测试环境重跑，不能跳过备份或降低校验。

程序套件运行真实 SQLite/MCP/原生业务、独立 Node hook进程及错误路径；`realClaudeLifecycleInvoked:false`、`modelInvoked:false`、`humanApproval:false` 明确边界。本轮主管理者另存了 Claude Code 2.1.309、官方 DeepSeek Flash/high 的真实 startup/resume/原生 compact/clear、argv 修复及跨企业恢复拒绝的合成轨迹，位于本机 `.agent-runs/business-memory-20261117/claude-real-*.ndjson`。其中也保留了早期失败，应逐份看事件与结果，不能将通配符下所有文件计为通过；这些历史轨迹不替代最终源码哈希上的完整业务与独立审查。最终阳性模型业务、存储引用修复后复核以及整体验收，以本轮对应报告的实际结果为准，不在此预填“最终全通过”。

首轮真实租赁模型业务轨迹 `claude-real-rental-business.ndjson` 保留为“执行/金额通过、历史解释需返工”：真实采用了保存的方法并完成本期计算，但报告中出现无充分证据的历史算法/跨期差异解释。该日志不覆盖；新增普适连续性指引后的效果须用新阳性现场、新会话和同一业务目标重测，不能给被测模型喂独立预期或用本期金额通过代替解释验收。

审查时记录实际命令、退出码、`git rev-parse HEAD` 和未提交 diff；本机未发布开发不能把基线 SHA 当成最终变更版本。存储迁移、方法执行及真实 MCP 的验证分别由其合成套件负责，宿主测试不替代这些验收。
