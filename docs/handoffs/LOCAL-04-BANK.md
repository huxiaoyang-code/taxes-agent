## 2026-10-23 LOCAL04B 候选交付与恢复

本片由负责人huxiaoyang-code下唯一获授权兜底实施员工实现，指定WT为local-04b-bank-entry、基线0eec7913be07dbfd8072976bbd2297d8ef05d687；员工不Git、不自审、不起其它agent/模型。A真实PR73结果紧随本节保留；B尚未提交/PR/合并。root最终决定原04是否关闭，Issue53仍OPEN。原整体仍01/02/03/05/08=5/8，04/06/07及最终整链/Windows W2未完，税局0。

已实现15银行业务工具（9query/6write）的REST/raw Agent/MCP模型入口、银行专用有界内存draft、同一页面file+paste文本/映射/预检/明确导入和人工判重/匹配/四类调节展示。详细API、金额与隐私边界见[LOCAL-BANK](../LOCAL-BANK.md)，模型协议与本机完整DTO见[输出边界](../FINANCE-OUTPUT-BOUNDARY.md)。A的partyAllocation字段本机完整保留，仅展示，模型固定状态计数；不改领域/aux/备份/核心算法。

自测真实证据（完整命令cwd/exit/close记录在根.agent-runs相应results.json，目录均本轮新UUID、祖先realpath/lstat检查、TEMP/TMP/WORKBENCH_DATA_DIR/KEEP_FIXTURES先绑定并传child）：

- 新4套：bank-local-drafts、bank-http、bank-ui-contract、MCP bank。HTTP实际REST15与raw15、MCP实际stdio15×两profile，不能以发现清单替代调用。最后新4证据根local04b-selftest-4c34791a-10fa-4c1f-a92b-111588cc3fa4，均exit0；后端/stdio有actualclose manifest，SQLite finallyclose。后续最终冻结hash与最终目标重验结果以根local04b-delivery-20261023.md为准。
- 两profile独立常量：书/单1130.00与1130.01；四类未达bookReceived30(count1)、bookPaid100(count2)、bankReceived5(count1)、bankPaid75(count2)，调节两边1060.00/1060.01、差额0、reconciled。声明close另外加1分时statementDifference=+0.01、adjusted difference=-0.01、pending_review。
- 同批/同ref缓存performed/applied=false；同文件新批true且仅新增批次追踪，稳定ID重叠文件复用4条、只新增0.03；无稳定IDdistinct后另批same显式选旧候选；跨期2026-01-31双0.07候选对应02-01银行流水，requires_manual_choice并人工选行确认；反过账真实读时失效。模型本机引用sum独立28017分。
- draft不可变/严格scope-tool/伪approved/过期/32项/2MiB/16MiB、并发write、unknown禁止重试、query重读与70次顺序撤销释放预算；16MiB缓存不足首次保留commit、再调固定拒绝且只执行1次。
- policy42/42、transport20/20（local04b-selftest-c0217c70-d712-4605-9430-225328412b3e），全份金额非整数/NaN/Infinity/正负超界与隐藏汇总字段拒整份query摘要/引用；停用含歧义往来只计数。真实银行写后造summary/ref失败，由adapter确认DB先增1，applied保留、needsLocalReview且无引用；重用ref零重复。
- adapter22/22、modelHTTP16/16、MCPentry11/11、auxiliary MCP真实28调用，全exit0，证据local04b-selftest-f3573105-78d9-4ce6-ba2c-c99d82e0fafa。旧断言全部保留，只将实际写工具18→24并验证6银行精确集合；最终测试若因新hash定点重验，在根交付注明实际新记录。
- MCP三运输故障×15均固定失败、写unknown、无raw retry；另真实DB先写后畸形响应→unknown→同ref已完成缓存回放零重复。输入模型仅accountSetId/draftRef，合成私密标记不进成功/错误/日志，原文仍可本机read/compute。

失败历史不删：首次HTTP沙箱EACCES（10872faf）后端及DB已关闭，按原命令审批后通过；MCP长测试路径导致官方migration_backup_failed（e6741d8b），缩短本轮fixture子目录后通过，未改领域/备份；compute合成预期28005误写，按实际独立20000+7000+500+500+1+2+1=28004修正（9324eca5），后追加重叠/同笔/跨期合成材料后最终28017。MCP发现schema仅声明additionalProperties未在运行拒绝approved，代理未捕获断言使测试退出1（47ed336c）：主测试child close已观察，孙后端/stdio的close回传当时未知；随后提升只读精确命令/父链查询结果空，未按PID猜杀或操作其它进程，不把该历史补称observed。修为仅银行schema执行前拒绝多字段，并代理收集错误/finally，后续全部自有child manifest与close齐备。旧adapter新探针发现已提交ref value_limit未提示复核（b5218dda），银行写单独补needsLocalReview及固定运输原因，修后通过。

页面实现/静态合同与同HTTP真链分别成立；正常页面paste与实际filechooser未操作、结果未知，不冒报UI实操通过。原CLI真实文件/映射/去重/人工确认/余额证据沿A PR73已验CLI15及root/fresh独立probe，不把本轮管理追加UI实操要求变原04永久阻塞。没有整跑员工完整88；root对最终冻结候选完整88一次与独立不同金额/stdio复验、fresh完整head审查仍是后续。员工最终29实际paths/sha256/bytes/LF无BOM及所有运行记录见根.agent-runs/local04b-final-files.json与local04b-delivery-20261023.md；冻结后无自有运行服务，不启动下一部分。

> 2026-10-23 LOCAL04A 实际已合并：[PR73](https://github.com/huxiaoyang-code/youshu-fork/pull/73) 于 `2026-10-23T12:46:13Z` MERGED；已审 head `c7cc65fc09f956bf7f4f4eec6bcda95148e24d0f`，merge `0eec7913be07dbfd8072976bbd2297d8ef05d687`。root 六正式领域43/CLI15/bankbackup5/auxbank/auxbackup/两安装序全 exit0、DB/child actualclose、15 hash不变；独立两profile 2219.05/2202.05/2223.09，联合恢复后相同并各续7分。全新独审完整 c7 接受，无确认P1/P2；独立6265.81/6259.73/6268.97，两安装序/held写锁/联合恢复各续13分、party状态与entry_unavailable及五严格负例全0/actualclose/hash同。A 未跑完整84（旧83逐字原序末追加1），B最终完整入口由root验收。Issue53仍OPEN；01/02/03/05/08=5/8，04/06/07与最终整链/Windows W2未完；真实税局0，页面filechooser/paste实操未知。A员工已冻结停止，无自有运行服务。

# LOCAL04A 银行与辅助组件整合候选（2026-10-23）

负责人huxiaoyang-code，基线为PR72实际merge `1621a58620738b3adcc4345425de8df41136da30`，分支 `codex/huxiaoyang-code/local-04a-bank-aux`；[Issue53精确17路径认领](https://github.com/huxiaoyang-code/youshu-fork/issues/53#issuecomment-6364708982)内实际改15路径，两份旧auxiliary整合测试只跑未改。沿章程用户唯一兜底实施授权；本实施者未调用其它agent/模型、未Git、未自审。PR72真实结果已补[LOCAL05交接](LOCAL-05-CASHFLOW.md)。本A只自测完成，待root独立验收、全新未实施者审查及PR；Issue53保持开放，LOCAL04整体尚未完成。下方旧候选状态按原时点保留。

## 本片结果与B复用字段

银行安装门仍在实际dbPath对应连接的BEGIN IMMEDIATE内按backup→verify→DDL执行，空components支持core3/4/5；非空只接受core5与唯一auxiliary@1。注入的create/verify仍须满足原强返回合同；随后固定调用官方local-backup.verifyBackup，对实际快照摘要/结构/清单/组件重新验证，清单与create/verify返回必须同一份，再用官方assertSupportedDatabaseConnection和assertBackupSourceConnection核持锁源连接registry、content与components。注入服务提供的同名assert、弱true或伪ok不能绕门；错误固定为migration_backup_invalid，未知组件/未来版本/损坏与已含bank的未安装矛盾均拒。没有扩共享backup API，也没有sourceConnection参数。

候选candidates[]与匹配match/matches[]新增`partyAllocation`，按真实accountSetId+entryId消费已审entryPartyAllocation；已安装时`installed:true`并完整保留status(unknown/ambiguous/confirmed)、partyId、partyActive、inactivePartyIds、allocations、unassigned、accountSetId、entryId。未安装固定`{installed:false,status:'not_installed',accountSetId,entryId}`，不自动安装；已装但原分录已删除固定`{installed:true,status:'entry_unavailable',accountSetId,entryId}`，保留原match snapshot与失效原因。已有aux结构/版本未知或损坏给aux_structure_invalid，不catch成未安装。

这些字段仅展示当前账务辅助分配。confirmed且partyActive=false仍如实展示，不能称银行对方已核实；同名不同ID、其它账套不能冒领。分配/改名/停用不进入候选筛选、人工确认依据、银行snapshot版本或失效机制，不自动写或绑定；原反过账等账务变更仍refresh失效一次。CLI JSON直接携带同一DTO，REST/raw Agent、页面和MCP/模型接线留给B，不声称已实现。

## 实际自测与边界

统一冻结六套命令cwd均为`06-workbench`，执行`node test/<下表文件>.mjs`；六入口均exit0、signal=null、自有直接child实际close，9份源/测试/登记before-after SHA256全部相同。所有业务import前设置专属UUID根TEMP/TMP/WORKBENCH_DATA_DIR与两个KEEP开关并传child，祖先逐层realpath/lstat核无alias/reparse，只用合成数据；DB均finally/退出关闭、自有CLI及两场景child等待实际close。未启动服务或税局浏览器，未操作真实库/凭据，未全局扫描清理TEMP。

| 正式套 | 实际结果 |
|---|---|
| bank-reconciliation.test | 43/43；原1400、1分差、COMMIT busy、回滚未知态、caller BEGIN、fresh文件保护断言保持 |
| bank-reconcile-cli.test | 15/15 |
| local-bank-backup-integration.test | 5/5；实际core3/4/5 × bank0/1、WAL与恢复/索引故障保持 |
| auxiliary-bank-integration.test | 两profile原1130与scope/辅助分配全过 |
| auxiliary-backup-integration.test | bank0/1两模式、WAL、真实restore/续写及9种schema篡改和坏snapshot全过 |
| local-bank-aux-integration.test | aux→bank与bank→aux两序；每序small/enterprise及持久历史legacy各真实CLI流程；12严格安装负例全过 |

新增整合套每个profile通过真实核心posted+银行CLI登记/文件导入/候选/显式确认/取消/对账，独立常量为起1000、共收200付100、企收银未50/企付银未30/银收企未20/银付企未10：账1120、单1110、两侧调整1130、差0。联合backup→verify→restore-new后两正式profile及legacy再次真实CLI得到1130，随后各续导入0.01，查真实bank_transactions三行1分及FK通过。安装第二组件前的官方备份恢复回原组件集合并真实续写；重复安装幂等。legacy是历史持久profile夹具，不作为可新建用户profile。

新套同时核unknown→ambiguous→confirmed→inactive/改名，候选和匹配实际DTO同scope/真实entryId、同名不同ID与跨套负例、读前后全表不变、snapshot不变与无辅助变更失效；反过账只失效一次。未安装aux仍能返回候选且不建aux对象；未知/未来aux视图明确拒绝，DB不变。安装负例为同basename同schema异content、未知源组件、未来aux、缺trigger、清单漏/重/未知/未来组件、陈旧content、假hash、verify失败、同源陈旧但官方仍有效备份；全部原库字节/业务/DDL不变且无活动事务。旧正式测试已有的DDL回滚/未知态等不机械重复。

旧领域shape-only mock已升级为从官方真实core备份复制出的完整fixture，包装realBackupService仍做原故障注入；没有删改旧金额、不变量或故障目的。首轮领域42/43唯一失败是Windows symlink/junction EPERM，原失败日志保留；原命令获批真实重跑43/43，不skip。其余首四旧套及新整合先后均exit0；最后统一六套再次全部exit0/hash同。没有运行完整84入口；test-all仅保留原83逐字原序并末尾追加新整合套为静态84，待B真实接线后最终整入口验收。

本机忽略证据：根`.agent-runs/local04a-self-e22c0a7c-9ad7-420f-965e-b2b068ce27a5/`内run/results、六log、before/after；失败历史与最终实际路径SHA256/bytes/LF无BOM、语法检查、child关闭见根`.agent-runs/local04a-delivery-20261023.md`和`local04a-final-files.json`。没有预猜A的PR/head/merge或提前关闭Issue53。原01/02/03/05/08=5/8，04/06/07、最终整链/Windows W2仍未完，税局0、UI file input未知。

> **2026-10-23 最终出版候选补记（优先于下方历史阶段）**：银行源修复候选冻结为 `a38b2815d353c1f5749c5c3081ec6bdbd180ace0`，员工定向150/150 exit0（import16 / reconciliation43 / CLI14 / integration5 / backup22 / 07 persistence39 / CLI11），root源修复定向43/43+14/14 exit0。本窗口以实际main原61逐字原序保留，仅末尾追加银行4套，静态登记65；**最终全65、fresh独审与PR63合并仍待root，PR63仍Draft**。只是LOCAL04银行CLI组件候选，profile / 辅助实际入口与UI整合未完。
>
> 创建保护：O_EXCL保留创建fd、私有不可变receipt / marker身份与seed，SQLite打开前文件对象预检；真实连接hook在核心DDL / WAL / migration前见证，银行安装拒绝未见证连接。已有库仍须备份并验证；调用方BEGIN拒绝保留回执，确认提交后消费，银行release使用 `preserveDatabase` 保留库文件。通用guard仅复用已审Windows / Node24边界，不承诺绝对抗恶意同进程 / 物理伪造或Linux保护。旧core3 P1替换场景确有核心pre-v4备份；旧95/60绿测不覆盖后来fresh P1，原红与环境失败按下文原文保留。源码9路径冻结，本轮只登记与文档、未重跑财务套件、未自审、无Git写。

# 交接 · LOCAL-04-BANK 本地银行 CSV、持久对账与余额调节

- 状态：原 56 项银行包已独审并合入冻结核；**2026-10-22 追加「现库安装 / 组件备份」子包，真实集成验收完成；随后 #53 独审 2 项 P2 分窗回修：A 窗（索引键语义 + 回滚失败状态）完成，第二轮独审 P2（调用方外层事务 / 事务未建立 vs 已确认回滚）也已完成，银行 A 最终 `950b7d6` 的独立复审已被 root 记录接受；B 窗已同步已合核心 main 并补齐备份侧银行组件索引键语义，自测完成，工作区未提交**；待 root 读 diff、复现、冻结、独审、提交 / PR / 合并。**不声称最终已通过**。本文件不预写 PR、head、merge。
- 第二轮回修基线：`c8f490c6b4d4e0f4bdaa9acf378defa900334e80`；B 窗开工时工作区已实际包含银行 A `950b7d6` 与核心 PR #60 merge `dfefae0`（含备份严格索引修复 `75b448d`）。
- B 窗边界与结果：只改 13 文件 claim 的子集，**不改** `bank-reconciliation.mjs`、核心 / DB / import / HTTP / Agent / MCP / public / `scripts/test-all.mjs` / package；详见 §10。
- A 窗回修基线：`06d1bd185f68ea4f3c49f20e6cf98f6cdce613a2`；当时只改登记的 9 文件，**未改** `server/local-backup.mjs` / `test/local-backup.test.mjs`（已交 #47）；该缺口已在 B 窗补齐。
- 子包基线：`ce4078222c9e5fb8508c9fe24a9183f17d46ea28`（银行 91f07eb + 核心 bd05415 + 备份 3399500 冻结组合并入最新 main `db6020a`）；子包结果见 §7。
- 本轮返工基线（冻结 head）：`46e0fc0ecb74703cc8482aab9a1cf3f85839f232`；原分页 / 截止日 / 事务 / CSV 四项及大数据真实探针已独审通过，本轮只收敛结构门槛及必要测试文档，仍只改原 10 个文件。
- 上一轮阻塞审查基线：`e2545216226b87262508d8a94f38426415670d8c`；基线 `257f96275031eefa484699dd71bd012e2d221e51`；分支 `codex/huxiaoyang-code/local-04-bank`；工作区 `.worktrees/local-04-bank`
- 远端载体：[Issue #53](https://github.com/huxiaoyang-code/youshu-fork/issues/53)（`Refs #20` / `Refs #13`）
- 任务单：[tasks/LOCAL-04-BANK](../tasks/LOCAL-04-BANK.md) · 契约：[LOCAL-BANK](../LOCAL-BANK.md)
- 执行模型：按管理者派工锁定的授权模型（GLM 5.3 / DeepSeek V4.1 Flash 范围内的显式锁定），未启动其他模型或员工子 agent。

## 1. 本次实际交付（原 56 项包历史记录）

> 2026-10-22 现库安装 / 备份子包的实际边界与测试见 §7；下列是原银行包首轮交付历史。

只新增 10 个文件，未修改任何共享文件：

```
06-workbench/server/bank-import.mjs
06-workbench/server/bank-storage.mjs
06-workbench/server/bank-reconciliation.mjs
06-workbench/scripts/bank-reconcile.mjs
06-workbench/test/bank-import.test.mjs
06-workbench/test/bank-reconciliation.test.mjs
06-workbench/test/bank-reconcile-cli.test.mjs
docs/LOCAL-BANK.md
docs/tasks/LOCAL-04-BANK.md
docs/handoffs/LOCAL-04-BANK.md
```

`git status` 只显示以上 10 个文件（首轮审查修复改其中 7 个：4 实现 + 3 测试；本轮结构契约复审收敛再改
4 实现文件中的 `bank-storage.mjs` + 2 个测试 + 3 文档，仍不新增 / 不越界）；无 `data/`、无临时库、无日志、
无 `package.json` / 锁文件 / `test-all.mjs` 改动。

## 2. 关键设计决定（审查重点）

1. **模块零默认库副作用**：三个 `server/bank-*.mjs` 都不 import `db.mjs` / `accounting.mjs`，
   所有数据库访问通过显式注入的 `DatabaseSync`。CLI 普通命令只打开 `--db`；只有 `init-db` 在
   「确认目标文件不存在 + 文件名 `workbench.db`」后设置 `WORKBENCH_DATA_DIR` 并调用产品真实建库入口。
2. **创建事实回执**：`claimFreshDatabase()` 只在目标文件不存在时创建空文件并发放进程内回执；
   `ensureBankSchema()` 只在回执匹配时允许免备份建 `bank_*`。回执不落盘、不跨进程，
   因此 CLI 独立调用无法把已有库伪装成新库；也没有 `--force` 之类的旁路参数。
3. **已有库迁移安全拒绝**：`bank_*` 加入已有库前必须有注入的 LOCAL-06 备份实现
   （`createBackup` + `verifyBackup`）。未提供 → `migration_backup_unavailable`（exit 5），
   不建任何银行表、不动业务数据 / 全局版本。备份失败 / 校验失败分别给 `migration_backup_failed` /
   `migration_backup_invalid`。只有校验 ok 后 DDL 才发生，且 DDL 在单事务内，失败整体回滚。
4. **无稳定 ID 优先不误吞**：同特征行不自动判重，而是整行保存为 `bank_ambiguities` 待人工判定；
   同一文件内两条完全相同的记录作为两笔都保留；只有「本批之前已存在的同特征流水」才触发歧义。
   文件级幂等依赖「文件内容摘要 + 映射指纹 + 行顺序」，不同文件交叠行一律成为待判定证据。
5. **匹配只来自 posted 分录**，候选不是已匹配；多候选全部列出由人工选择；组匹配只返回提示码，
   不自动把合计凑数当成匹配。
6. **读时失效核验**：所有读路径与 `confirm` / `reconcile` 都重新核验 `confirmed` 匹配与当前账务是否一致；
   失效在事务内写一次审计并标记对账运行 stale；原样重新过账不恢复失效匹配，必须重新确认。
   观测边界（没有账务修订号 / 事件流）已在契约 §9 明确写出。
7. **余额调节不凑数**：账面截止 = 真实期初 + 截止日全部历史 posted 银行分录；对账单期初 / 期末由
   操作者声明并与覆盖期流水净额自校验；调节后两边与差额按契约公式输出；差额非 0、覆盖不完整、
   未决歧义、失效匹配都降级为 `pending_review` / `incomplete`，不生成 / 修改任何凭证。

## 2.1 首轮独立审查 5 项阻塞的修复（上一轮）

审查基线为冻结 head `e2545216226b87262508d8a94f38426415670d8c`。复现方式：把该 head 的 4 个实现文件
导出到临时目录的独立副本，再对同一复现脚本双重运行（冻结 head / 修复后），全部使用真实临时 SQLite、
真实建库入口、真实建账套 / 期初 / posted 凭证 / 导入 / 确认 / 对账路径，金额用独立手算常量（分）。
复现脚本与旧副本均在忽略目录，不入库。冻结 head 上 29 / 51 项断言失败，修复后 51 / 51 通过。

| # | 阻塞现象（冻结 head 真实结果） | 根因 | 修复位置 |
|---|---|---|---|
| 1 | 501 笔×100 分全确认后返回调节后 50200 / 50200 且 `reconciled`，最后 1 笔被两侧重复列未达；反过账后 `refresh` checked=500 / `invalidated[]`；候选占用漏 1；批次数 200 封顶；歧义 500 封顶；>500 已复核失效匹配掩盖后续未复核 | 内部业务判定直接使用展示分页（`listMatches` 默认 500、`listBatches` 200、`listAmbiguities` 500）并先分页后过滤 | `bank-storage.mjs` 新增 `BANK_SCHEMA_CONTRACT` 之外的完整读取 / 聚合 API（`listAllMatches` 键集游标分块、`listMatchesForTransactionIds`、`listConfirmedMatchSides`、`countBatchesByStatus`、`countMatchesByStatus`、`countTransactionMatchStates`、`countPendingAmbiguities*`、`countUnresolvedInvalidatedMatches` / `listUnresolvedInvalidatedMatches`）；`bank-reconciliation.mjs` 的失效核验、候选占用、流水视图、对账未达项、状态计数全部改用上述能力，展示分页只留给输出 |
| 2 | 1/31 账面收款 1000.00 + 2/1 银行收款（容差 1 天已确认）→ 1/31 未达项 0、调节后 1000 / 0、差额 1000 | 未达项只看「有没有匹配」，不看两侧是否在 asOf 前都已发生 | `reconcileBank` 改用 `listConfirmedMatchSides` 取双方日期：只有凭证日期与流水日期都 `<= asOf` 才从截止日未达项消除；跨日匹配合法、不回写账务；`book.matchedEntryCount` 改为同口径 |
| 3 | v1 库插入 `version=2` 后 `ensureBankSchema` 返回 success 且 `registerBankAccount` 能写；删除 `bank_reconcile_runs` 后初始化仍 success；CLI 同因旁路 | 存储 `from >= 目标` 直接放行、领域只看 `< 1`、CLI 只看版本号 | 新增 `BANK_SCHEMA_CONTRACT` + `bankSchemaContract(db)` + `assertBankSchemaReady(db)`：未来版本 / 矛盾版本 / 缺表 / 缺列 / 主键 / UNIQUE / 索引签名 / 外键动作 / 额外 `bank_*` 表均在业务写前拒绝；`ensureBankSchema`、CLI `ensureBankReady`、`resolveBankScope`、`registerBankAccount` 共用同一门槛；拒绝时不做 DDL / 写入（不用 `CREATE IF NOT EXISTS` 修补），只做结构核对、不扫全表内容；仍为组件 v1 |
| 4 | 合成触发器让 `reconcile_computed` 审计插入失败后，runs 变 `[{id:1,stale:1},{id:2,stale:0}]`（旧结果被误废弃） | 旧记录 stale、新运行记录、审计三步不在同一事务 | `reconcileBank` 把三步包在 `inTransaction`（嵌套自动用 SAVEPOINT）；插 run 失败与插 audit 失败两路都有回归 |
| 5 | 合法表头 + 201 行 `2026-01-10,bad,in` 抛 `Assignment to constant variable.`；重复流水号路径不封顶 | `errorsTruncated` 用 `const` 却在行级循环里赋值；重复 refId 直接 `push` | `previewCsvImport` 改用有界 `addError`：CSV 解析 / 缺列 / 期间 / 行级错误 / 文件内重复流水号共用 `maxErrors=200` 总上限，超过只置 `errorsTruncated=true`，不抛错也不误报 ok |

新增回归用例（均在冻结 head 上失败、修复后通过）：

- `bank-import.test.mjs`：「预检错误总上限…」
- `bank-reconciliation.test.mjs`：「内部判定不被展示分页截断…」、「批次与待决歧义真实数量…」、
  「余额调节按截止日 asOf 判定未达项…」、「对账结果持久化原子…」、「组件结构 / 版本契约…」、
  「失效匹配复核计数先过滤再限条…」
- `bank-reconcile-cli.test.mjs`：「CLI 组件结构契约损坏…」（子进程，exit 5、无写入、不重建表）

本轮改动仍限于原 10 个文件：4 个实现 + 3 个测试修改；3 个文档更新。未改共享核心 / backup / 其他员工文件，
未新增依赖，未完成「已有库安装 / 备份恢复」闭环（见 §4）。

## 2.2 结构契约复审收敛（本轮 3 项 P2，返工基线 `46e0fc0`）

原分页 / 截止日 / 事务 / CSV 四项与大数据真实探针已独审通过；本轮只修结构门槛，未改业务语义。

| # | 返工前真实表现（冻结 head `46e0fc0`） | 根因 | 修复位置 |
|---|---|---|---|
| 1 | 把 `idx_bank_matches_active_txn` 重建为同名同列同 UNIQUE/partial 但 `WHERE status='cancelled'` 后，`bankSchemaContract` 仍 ok、`ensureBankSchema` 返回 already-initialized | 索引契约只比较名字 / 列 / unique / partial 标志，未比较部分索引的实际 `WHERE` 谓词 | `bank-storage.mjs`：`indexSignatures` 读 `sqlite_master.sql` 提取谓词，`canonicalCondition` 规范化后**整体相等**比对；`BANK_SCHEMA_CONTRACT` 为 `idx_bank_matches_active_txn` / `idx_bank_matches_active_entry` / `idx_bank_txn_ref` 写明谓词；错谓词一律 `bank_schema_corrupt`，产品 DDL 的空白 / 引号写法不误判 |
| 2 | `bank_audit_events` 重建时仅增加 `account_set_id REFERENCES account_sets(id) ON DELETE CASCADE` 并恢复原索引后 contract 仍 ok；真实删除账套后审计行 1→0 | 外键只找必需项，不拒绝额外 / 重复约束，且按目标表覆盖会让重复约束不可见 | 按表比较完整外键**多重集**（列组 + 目标 + `ON DELETE` / `ON UPDATE`）；缺项给 `bank_schema_foreign_key_missing`，额外 / 重复逐条给 `bank_schema_foreign_key_unexpected`；契约未列外键的表（含 audit / reconcile-runs）实际也必须无外键 |
| 3 | `ALTER TABLE bank_component_migrations RENAME COLUMN version TO broken_version` 后 `bankSchemaContract` 直接抛 `ERR_SQLITE_ERROR: no such column: version` | 先 `SELECT version` 再验证版本表形状 | 先验证 `version` 列存在再读版本；形状坏给 `bank_schema_version_table_corrupt`（最终 `bank_schema_corrupt`）；`bankSchemaVersion` / `bankSchemaState` 与领域只读 / 写入入口、CLI `status` 均结构化**非写入拒绝**，不显示原始 SQL；正常未来版本仍 `bank_schema_future_version` |

真实红 / 绿证据（临时探针，真实临时 SQLite，探针在系统临时目录不入库）：

```
冻结 head 46e0fc0：错索引谓词 contractOk=true / ensure=already-initialized；
                   audit 额外 FK contractOk=true，真实删除账套后 audit 1→0；
                   版本表改名后 contract 抛 ERR_SQLITE_ERROR(no such column: version)
返工实现：       错索引谓词 contractOk=false / bank_schema_corrupt / ensure 拒绝；
                   audit 额外 FK contractOk=false / bank_schema_corrupt；
                   版本表改名后 contract 返回 ok=false / bank_schema_corrupt（不抛原始 SQL）
```

新增回归用例（均在冻结 head 上失败、返工后通过）：

- `bank-reconciliation.test.mjs`：「部分索引契约核对真实 WHERE 谓词…」、「外键契约比较完整集合…」、
  「版本表形状缺失…」（冻结 head 实测 3 / 3 失败）
- `bank-reconcile-cli.test.mjs`：「CLI 版本表形状损坏…」（冻结 head 实测 exit 3 而非 5；返工后 exit 5、
  无写入、不显示 SQLite 错误）

## 3. 实际验证与关键业务输出（本次运行）

环境：Windows，Node v24.15.0，`node:sqlite`。全部合成临时目录 / 合成 CSV。工作目录 `06-workbench`。

| 命令 | 结果 |
|---|---|
| `node --test test/bank-import.test.mjs` | 16 / 16 通过 |
| `node --test test/bank-reconciliation.test.mjs` | 29 / 29 通过 |
| `node --test test/bank-reconcile-cli.test.mjs` | 11 / 11 通过 |
| 三套合并 | 56 / 56 通过，exit 0（约 11.1s） |
| `npm test` | 上一轮 47 / 47 套件通过；**本轮未重跑**（只改银行包内文件，未动上游共享代码，按任务边界只跑定向 3 套） |

原 52 项用例（16 / 26 / 10）保留未删弱，本轮新增 4 个用例（3 领域 + 1 CLI）；新增用例已在冻结 head
`46e0fc0` 上先红、返工后绿（见 §2.2）。

固定手算（领域与 CLI 两处独立断言，常量写在测试里，不用被测公式生成）：

- 账面期初 80000、未达收 30000 / 未达付 10000 → 账面截止 100000；
- 银行期初 80000、未达收 50000 / 未达付 10000 → 银行截止 120000；
- 调节后账面 = 100000 + 50000 − 10000 = 140000；调节后银行 = 120000 + 30000 − 10000 = 140000；差额 0，状态 `reconciled`。
- 银行付款改 10001、声明截止仍 120000 → 计算期末 119999（声明与计算差 1 分）、
  调节后账面 139999 / 调节后银行 140000、差额 −1、状态 `pending_review`，问题码含
  `statement_balance_mismatch` 与 `adjusted_balance_difference`。

其他实际证据：同批重试与同文件新批次均不增流水；同稳定 ID 改金额整批回滚且既有流水不变；
文件内两条同特征记录保留两笔；交叠文件只产生 1 条 `pending` 歧义且批次 `pending_review`；
反过账后匹配立即 `invalidated`（`voucher_unposted`）且审计只记一次；重过账后仍失效；
SQL 改金额 / 日期 / 科目 / 行号 / 删分录分别识别；触发器注入第 3 行失败后 0 笔流水、
批次 `failed`，修复后同批次重试成功并保留尝试次数；删除账套后审计事件仍在。

## 4. 未完成项 / 下一步（不得视为整体已完成）

1. ~~已有库迁移与升级验收~~：**已由 §7 子包完成**（真实 create + verify、WAL 已提交内容、失败回滚、
   backup → verify → restore-new、银行流水 / 批次 / 确认取消 / 未达金额完整性）。仍不包含原位覆盖恢复与通用版本回退。
2. **03 双准则 / 1002 叶子科目尚未复验**：本包只接受 `1002` 或其显式明细作为资产类借方叶子科目，
   且首版一个银行账户绑一个叶子科目；LOCAL-03 双准则与辅助维度合并后必须重新验，不能声称已完成 03 依赖。
3. **共享接线**：HTTP / Agent / MCP / UI 与 `scripts/test-all.mjs`（三套件登记）另开共享串行窗口；
   本包不碰这些文件。
4. **LOCAL-02 / LOCAL-03 稳定合同**：合并后补真实兼容回归与版本记录；辅助核算维度下
   「同科目多银行账户」支持需按合同重新评估。
5. 组匹配（一对多 / 多对一）仍未实现，只返回 `group_match_requires_manual` / `unsupported_group_match`。
6. 外币 / 换汇、银行网站 / API：不在范围。
7. **结构契约的边界**：部分索引谓词按规范化文本整体相等比较（逻辑等价但写法不同会被保守拒绝）；
   外键按完整集合比较；版本表形状损坏只给结构化拒绝，不做自动修复 / 补迁。仍不做内容 / 行数 / 哈希校验。
8. **备份层索引键语义（B 窗已补齐）**：B 窗已把银行组件全部 19 条索引（PK / UNIQUE / 命名 / 自动）接入
   逐键比对（`seqno` / collation / 方向 / 表达式 / rowid / `origin` / `partial` / 真实谓词）与主键
   `rowidAlias` / 复合主键语义；`create`（源库）/ `verify`（快照）/ `restore-new`（恢复目标）三入口一致拒绝，
   原集成用例中「备份仍放行」的显式断言已改为拒绝。仍不支持未来 bank v2+、batch / audit、原位覆盖 / 版本回退。
9. **回滚未知态需调用者处置**：不自动重试、不自动重开事务、不关闭全局连接或强杀服务；未知态连接对银行
   读写与 `ensureBankSchema` 统一 `bank_connection_state_unknown`，必须先确认回滚成功 / 丢弃连接再
   `recoverBankConnectionState`。

## 5. 管理者复验建议

- 先读 `server/bank-storage.mjs` 的备份门槛、`BANK_SCHEMA_CONTRACT` / `bankSchemaContract` / `assertBankSchemaReady`
  与完整读取 API，再读 `server/bank-reconciliation.mjs` 的失效核验 / 候选 / 对账三段；CLI 只做参数与输出封装。
- 复现固定金额与 1 分差异（命令见契约 §13 与任务单 §6）；复现已有库无备份时 exit 5 且无 `bank_*`。
- 重跑冻结 head 与本头的差异重点：501 笔全确认后的调节后 50100 / 50100（不是 50200）、反过账后 checked=501 /
  `invalidated` 长度 1、候选 `available=false`、201 批次 / 501 歧义的**真实计数**、跨日 asOf 未达项 1000 / 1000、
  结构损坏（未来版本 / 缺表）exit 5 且无写入、对账插 run / 插 audit 失败后全组件快照不变；
  本轮新增：同名同列同 UNIQUE/partial 的错索引谓词被拒、audit / reconcile-runs 额外或重复 FK 被拒、
  版本表改名后 `bank_schema_corrupt`（不是 `ERR_SQLITE_ERROR`）且 CLI 不显示原始 SQL。
- 检查三套测试是否真的只用合成临时目录（`mkdtempSync` + `rmSync`），以及是否没有读真实库 / 凭据。
- 关注点：文件级幂等的边界（换行 / 编码变化不算同文件）、未决歧义对批次与对账状态的降级、
  失效审计只写一次、旧匹配记录保留、`bank_*` 不写全局版本、额外 `bank_*` 表会被契约拒绝。

## 6. 现场与边界

- 未执行 Git 提交 / 推送 / 合并；工作区只有原 10 个文件（4 实现 + 3 测试 + 3 文档）的改动，无新增文件。
- 复现脚本、冻结 head 临时副本、合成临时库全在忽略目录 / 系统临时目录，未入库；未读取真实账套、银行文件、
  凭据、税局窗口 / 后端 / 私有采集资料；未启动浏览器。
- 未修改共享 STATE / 索引 / 其他 docs / backup 候选 / 其他员工文件；本包状态由管理者在收口时统一登记。
- 复验可使用相对路径与合成值；不要把本机绝对路径 / PID / 原始日志写入 Git。

## 7. 2026-10-22 子包交接：现库安装 / 组件备份真实整合

### 7.1 工作区与边界

- 基线 `ce4078222c9e5fb8508c9fe24a9183f17d46ea28`；分支 `codex/huxiaoyang-code/local-04-bank`，工作区 `.worktrees/local-04-bank`。
- 只动远端 53 + 47 已登记的 10 文件边界：本轮实际修改 `server/bank-storage.mjs`、`server/local-backup.mjs`、
  `test/bank-reconciliation.test.mjs`、`test/bank-reconcile-cli.test.mjs`，新增 `test/local-bank-backup-integration.test.mjs`，
  并更新本包三份文档（`docs/LOCAL-BANK.md` / `docs/tasks/LOCAL-04-BANK.md` / 本文件）。
  `scripts/bank-reconcile.mjs` 与 `test/local-backup.test.mjs` 未改（无需改 / 47 冻结的 20 项保持原样）。
- **未修改**：`accounting.mjs` / `db.mjs` / `import-storage.mjs` / 其他组件 / `server.mjs` / Agent / MCP /
  `scripts/test-all.mjs` / `package.json` / `docs/LOCAL-BACKUP.md` 及其他公共 backup docs。
- 未执行 Git 提交 / 推送 / 合并；未读取真实账套 / 凭据 / 税局；未启动浏览器。

### 7.2 实现要点

1. **真实安装备份目录**：`ensureBankSchema` 分配全新 `<dataDir>/bank-component-backups/pre-bank-v1-*`，
   不再把已有 `dataDir` 直接当 `outDir`。
2. **真实字段与绑定校验**：create 必须 `ok` + `backupDir` + `backupMeta.snapshotBytes/sha256`；
   verify 必须 `ok` + `status='ok'`，摘要与 create 一致，并绑定源文件名 / 核心 schema 版本 / 迁移前无组件。
   `true` / `integrity:'ok'` / 仅 `{ok:true}` mock 全部拒绝。
3. **连接路径绑定**：`PRAGMA database_list` 核对真实连接文件 = `dbPath`，否则 `database_handle_mismatch`。
4. **排他安装**：已有库备份 + DDL + 记录在同一个 `BEGIN IMMEDIATE` 内；其他连接在窗口内提交写入会收到
   `SQLITE_BUSY`；DDL 后自检失败整体回滚，失败备份保留但不登记为成功证据。
5. **结构契约扩展**：`BANK_SCHEMA_CONTRACT` 增加列类型 / NOT NULL / 默认值和额外索引拒绝；
   新增 `BANK_COMPONENT_STRUCTURE` 供 backup 使用。`bankSchemaContract` **不拒绝**合成测试触发器
   （原有注入失败回归保留）；备份验证器拒绝任何未登记 / 引用 `bank_*` 的 trigger 或 view。
6. **backup 可选 bank v1**：完整 10 表 + 版本内容 + 类型 / 默认值 / NOT NULL / PK / UNIQUE / 索引签名与
   真实 partial 谓词 / 外键完整集合与动作 / 无未知对象；manifest 可选 `components[]` 绑定 name / version /
   tables / structureDigest / contentDigest / rows；create / verify / restore-new 三层重算比对。
7. **旧备份兼容**：无 bank 的 v3 / v4 备份清单保持无 `components`，继续原样 verify / restore-new，不升级。
8. **拒绝边界**：未知 / 半套 / 未来 / 错报组件、额外 `bank_*` 或 audit / batch 未知表、清单漏报 / 错报均拒绝；
   被拒备份不生成恢复目标。

### 7.3 实际自测（全部合成临时库）

工作目录 `06-workbench`；stdout 全文保存在本工作区 `.agent-runs/`（未提交）：

```
node --test test/bank-import.test.mjs                        # 16 / 16, exit 0
node --test test/bank-reconciliation.test.mjs                # 29 / 29, exit 0
node --test test/bank-reconcile-cli.test.mjs                 # 11 / 11, exit 0
node --test test/local-backup.test.mjs                       # 20 / 20, exit 0
node --test test/local-bank-backup-integration.test.mjs      # 4 / 4 场景, exit 0
```

`git diff --check` exit 0；改动范围仅上述子包边界文件（无 `data/`、无临时库、无日志、无共享入口 / package / 其他 docs）。

五套合计 **80 / 80**（A 窗后 89 / 89，见 §8.4）。集成场景包含：core4 + 遗留 WAL 安装前备份可还原原核心；安装后固定手算
1120 / 1110 / 四类未达 50/30/20/10 / 调节双方 1130 / 差额 0 / 不生成调整凭证；backup → verify →
restore-new 后 4 流水 / 1 批次 / 2 确认 / 运行记录保留；取消匹配与反过账后 stale / invalidation 可见；
双账套隔离；已安装重跑幂等；core3 兼容不升级；create / verify / DDL 失败回滚；错 DBPath 不写；
安装期间外部写入被排他拒绝；17 个结构篡改 + 6 个清单错报子项重算快照摘要后仍拒绝且不生成恢复目标。

基线漂移说明：核心 import schema 已到 v4，原银行测试中两处 `schema_migrations` 静态期望从 `[1,2,3]` / `3`
更新为 `[1,2,3,4]` / `4`，断言语义仍是「银行组件不得写全局迁移版本」。

### 7.4 未完成 / 后续依赖（不得声称整体完成）

1. 只支持 core v3 / v4 + 可选 bank v1；audit / batch 组件、原位覆盖恢复、通用版本回退、HTTP / Agent / MCP 接线未交付。
2. `scripts/test-all.mjs` / `package.json` / 公共 backup 三文档未改；新集成套件尚未注册总入口，
   公共 backup docs 需后续专门同步本包新增的 components 兼容事实。
3. 本子包**不合并**：LOCAL02 正式合入并同步最终修复前，只作为预整合；最终合并仍必须由 root 同步 02 正式 main。
4. 不得据此声称 LOCAL04 整体 / LOCAL03 科目往来已完成；上游整合后 root 需全量回归（本包只跑影响面五套）。
5. 未把「mock 备份成功」当真实验收：新增集成套件全部使用真实 `server/local-backup.mjs`；失败分支另外使用
   可控包装器注入故障，且断言原库无半套 DDL / 版本 / 数据。

### 7.5 管理者复验建议

- 先读 `server/bank-storage.mjs` 的 `runBackupGate` / `ensureBankSchema` / `BANK_COMPONENT_STRUCTURE`，
  再读 `server/local-backup.mjs` 的 `inspectComponent` / `componentStructureDigest` / `componentBindingProblems`
  与 manifest components 校验；最后看集成测试的四类场景与篡改矩阵。
- 复验命令即 §7.3；重点核对：安装备份目录为全新子目录、失败时原库无 `bank_*` / 版本变化、
  恢复后金额 1130 / 1130 / 0、core3 不升级、篡改项全部 `structure_invalid` 或 `component_*` 且无恢复目标。
- 独立审查由未参与实施 / 本规划的审查者执行；员工不执行 Git 写。

## 8. 2026-10-22 A 窗：#53 独审 2 项 P2 回修交接

### 8.1 工作区与边界

- 回修基线：head `06d1bd185f68ea4f3c49f20e6cf98f6cdce613a2`；分支 / 工作区不变。
- 本窗只改登记的 9 文件：`06-workbench/server/bank-storage.mjs`、
  `06-workbench/server/bank-reconciliation.mjs`、`06-workbench/scripts/bank-reconcile.mjs`、
  `06-workbench/test/bank-reconciliation.test.mjs`、`06-workbench/test/bank-reconcile-cli.test.mjs`、
  `06-workbench/test/local-bank-backup-integration.test.mjs`、`docs/LOCAL-BANK.md`、任务单、本交接。
- 禁止且未改：`server/local-backup.mjs` / `test/local-backup.test.mjs`（核心备份两文件已交 #47）、
  共享 core / `scripts/test-all.mjs`、`docs/05`、`docs/08`；未读其他 worktree 的 WIP / 日志。
- 未接 HTTP / Agent / MCP / UI；未跑全 55 套（已知 02 输出兼容候选未同步，不越界修）；未执行 Git 写、未用真实数据 / 税局。

### 8.2 P2-1 索引键语义（不只比列名）

- 回修前：`idx_bank_txn_ref` 最后键改 `bank_ref_id COLLATE NOCASE`（列名 / UNIQUE / partial / WHERE 不变）时
  `bankSchemaContract` 仍 ok，备份 verify / restore 也 ok；恢复库上真实导入 `Ref-A` / `ref-a` 第二笔 UNIQUE 失败，
  正常结构下两笔都成功。
- 回修后：`indexSignatures` 改读 `pragma_index_xinfo`（seqno 顺序 + `coll` + `desc` + 是否表达式 / rowid），
  并核对 `origin`（命名 `c`、自动 `pk` / `u`）；契约对全部 19 条索引固定「普通列 + BINARY + 升序 + 非表达式」；
  `COLLATE NOCASE` / `RTRIM` / `DESC` / 表达式 / 额外唯一约束 / 命名与自动索引互顶都是 `bank_schema_corrupt`
  且不写入；健康结构 import `Ref-A` + `ref-a` 两条都成功。
- 旧断言未删弱；新增领域 2 + CLI 1 + 集成 1 用例。

### 8.3 P2-2 回滚失败不得冒充已回滚

- 回修前：真实 DELETE-journal 读事务使安装 `COMMIT` 实际 `database is locked`（正常 `ROLLBACK` 后
  `isTransaction=false`、bank 表 0）；再仅注入 `ROLLBACK` 抛 I/O 错误，仍报「原库已回滚」，
  而 `db.isTransaction=true`、同连接内 10 张 bank 表 / 版本行未提交；fresh `inTransaction` 同样吞错。
- 回修后状态机（固定错误 / 标志，不回显原始 SQL / 路径）：
  - 已确认回滚：原错误上抛；`ensureBankSchema` 给 `bank_migration_failed` + `rolledBack:true`；
  - 已确认整体放弃：`bank_transaction_discarded` + `rolledBack:true`（内层 SAVEPOINT 失败但外层回滚成功 /
    被调用方吞掉时外层绝不 `COMMIT`）；
  - 回滚失败 / 未知：`bank_transaction_rollback_failed` + `rolledBack:false` + `transactionActive`，
    连接标未知 → 后续银行读写与 `ensureBankSchema` 给 `bank_connection_state_unknown`；
    恢复只能 `recoverBankConnectionState`（仍在事务中给 `bank_connection_recovery_refused`）或丢弃连接；
  - 导入失败审计只在确认回滚的连接上写；未知态 `auditRecorded=false` + `auditFailure` 明说未写入，
    不伪造已留痕，也不能在该连接上成功复用。
- 新增领域 5 用例（真实 COMMIT_BUSY、单点 ROLLBACK 注入、fresh 分支、嵌套 SAVEPOINT、导入审计）。

### 8.4 本窗实际测试（`06-workbench`，合成临时库）

```
node --test test/bank-import.test.mjs                     # 16 / 16
node --test test/bank-reconciliation.test.mjs             # 36 / 36（29 → 36）
node --test test/bank-reconcile-cli.test.mjs              # 12 / 12（11 → 12）
node --test test/local-backup.test.mjs                    # 20 / 20（未回退）
node --test test/local-bank-backup-integration.test.mjs   # 5 / 5（4 → 5）
                                                          # 合计 89 / 89，exit 0
```

root 在 06d 管理的 16 + 29 + 11 + 20 + 4 = **80** 对应回修前 head，仍成立；本窗新增 7 领域 + 1 CLI + 1 集成用例。
`ROLLBACK` 失败是**单点注入**，不声称实测真实磁盘故障；真实 COMMIT busy 用 DELETE-journal 读事务实测
（产品 WAL 路径当前无此失败）。绿测不等于独审通过。

### 8.5 后续（B 窗新会话，不继续扩大本窗）

1. root 冻结本窗后做独立复审；本窗不写已提交 / 已合 / 最终通过。
2. B 窗已完成：在 root 同步已合核心（PR #60 merge `dfefae0`）后，把 `local-backup.mjs` 银行组件校验改为
   读 `BANK_COMPONENT_STRUCTURE.indexes[].keys` / `origin` / `partial` / 真实谓词与 `rowidAlias`，
   并把集成用例中「备份层仍放行」的显式断言改为拒绝（结果见 §10）。
3. 仍未接 HTTP / Agent / MCP / test-all；LOCAL-02 / 03 正式合同同步后须补兼容回归。

## 9. 2026-10-22 第二轮独审 P2：调用方外层事务下的「未开始」不得冒充已回滚

### 9.1 工作区与边界

- 回修基线：head `c8f490c6b4d4e0f4bdaa9acf378defa900334e80`；分支 / 工作区不变。
- 仍只在登记的 9 文件范围内改动，实际改动 **7 个**（`server/bank-storage.mjs`、
  `server/bank-reconciliation.mjs`、`scripts/bank-reconcile.mjs`、`test/bank-reconciliation.test.mjs`、
  三份文档）；另外两个登记的测试文件（CLI / 集成）只重跑未改；**禁止且未改**
  `server/local-backup.mjs` / `test/local-backup.test.mjs`、共享 core / `scripts/test-all.mjs`、
  `docs/05` / `docs/08`；未读其他 worktree 的 WIP / 日志。
- 未接 HTTP / Agent / MCP / UI，未跑全 55 套，未执行 Git 写，未用真实账号 / 税据。

### 9.2 回修前真实表现（独立复现）

真实产品新库 + 有效创建回执，调用方先 `BEGIN IMMEDIATE` 并插 1 条合成 `account_sets`，再
`await ensureBankSchema(...receipt)`：

- 返回 `bank_migration_failed` + `rolledBack:true` / `transactionState:'rolled_back'`，消息称「已确认回滚」；
  但 `db.isTransaction=true`、未提交行仍在、`bank_*` 表 0，且根本没执行 `ROLLBACK`；
- `bankConnectionState` 返回 `writable:true` / `transactionActive:false`，与实际活动外层事务矛盾；
- 创建回执被消耗 → 调用方结束后重试落到已有库备份门槛（`migration_backup_unavailable`）；
- 现库分支同一场景给 `migration_lock_failed`；调用方事务里导入只抛原始 `ERR_SQLITE_ERROR`；
  `BEGIN` / `SAVEPOINT` 没建立时无结构化错误，无法与「已确认回滚」区分。

### 9.3 回修后语义（固定错误 / 标志，不回显原始 SQL / 路径）

| 场景 | 结果 |
|---|---|
| 连接上已有调用方事务 / 保存点（安装与银行写入） | `bank_transaction_conflict` + `started:false` / `rolledBack:false` / `transactionState:'external_transaction'` / `transactionActive:true` / `bankManaged:false`；不开事务、不提交 / 不回滚调用方事务；拒绝发生在消耗回执 / 分配备份目录 / DDL 之前 |
| 银行自己的未结束嵌套层（`txnDepth>0`） | 同一错误码 + `bankManaged:true` / `transactionState:'bank_transaction_active'` |
| `BEGIN` / `SAVEPOINT` 没建立起来 | `bank_transaction_begin_failed` + `started:false` / `rolledBack:false` / `transactionState:'not_started'`；不拉黑连接 |
| 嵌套保存点没建立、外层已确认回滚 | `bank_transaction_discarded` + `rolledBack:true`（整层放弃，不提交半成品） |
| 已确认回滚 / 回滚失败未知 | 保持 A 窗语义（`bank_migration_failed(rolledBack:true)` / `bank_transaction_rollback_failed` + 未知连接） |
| `bankConnectionState` | `transactionState` = `clean` / `external_transaction` / `rollback_unconfirmed`；`transactionActive` 来自 `db.isTransaction`；`writable` 只表示银行可自行开事务并提交；新增 `externalTransaction` / `bankManagedTransaction` |
| 调用方事务中的导入失败审计 | 不写进调用方事务，`auditRecorded:false` + 固定 `auditFailure`（调用方事务仍在进行…），不冒充回滚失败 |
| CLI | 两个新错误码映射 exit 5；子进程无法制造调用方事务，故无对应 CLI 用例（不伪造） |

保持：本库管理的嵌套事务成功 / 外层整层放弃、真实 `COMMIT` busy 四象限、单点 `ROLLBACK` 注入结论不变；
未用「自动关闭用户连接」解决，未知态仍需显式恢复 / 丢弃。

### 9.4 本窗实际测试（`06-workbench`，合成临时库）

```
node --test test/bank-reconciliation.test.mjs             # 40 / 40（36 → 40）
node --test test/bank-reconcile-cli.test.mjs              # 12 / 12（断言未改）
node --test test/local-bank-backup-integration.test.mjs   # 5 / 5
                                                          # 受影响三套 57 / 57，exit 0
```

`bank-import` 16 与 `local-backup` 20 本轮内容未改、**未重跑**。
新增领域 4 用例先红后绿：用冻结 head `c8f490c` 的三份实现文件临时替换（非 Git 写，跑后已恢复）
跑同一 4 个用例 → **4 / 4 失败**（`bank_migration_failed(rolledBack:true)` / `migration_lock_failed` /
原始 `ERR_SQLITE_ERROR` / BEGIN 失败无结构化错误）；本轮实现下 **4 / 4 通过**。绿测不等于独审通过。

### 9.5 未完成 / A 未完成 B 边界（不得声称整体完成）

1. 本包仍**不是** LOCAL-04 整体完成：HTTP / Agent / MCP / UI 与 `scripts/test-all.mjs` 未接；
   LOCAL-02 / LOCAL-03 正式合同同步后需补兼容回归；组匹配 / 外币 / 银行网站 / API 仍不做。
2. **A 窗未完成项已由 B 窗补齐**：`local-backup.mjs` 现按银行组件全部 19 条索引逐键比对 collation / 方向 /
   表达式 / rowid / `origin` / `partial` / 真实谓词，并核对 `rowidAlias` / 复合主键；源库 / 快照 / 恢复目标三入口一致拒绝
   （见 §10）。仍不支持未来 bank v2+ / batch / audit / 原位覆盖。
3. 调用方事务不做嵌套安装 / 写银行数据；需调用方先提交或回滚自己的事务再重试；未知态仍需显式
   `recoverBankConnectionState` 或丢弃连接。
4. root 冻结本窗后仍需独立复审；本文件不写已提交 / PR / 已合 / 最终通过。

## 10. 2026-10-22 B 窗：同步已合核心并补齐备份侧银行组件索引键语义

### 10.1 边界与基线

- root 已正式开窗，确认银行 A 最终 `950b7d6` 的独立复审接受，无新阻塞；远端 Issue #53 / #49 已发布 13 路径正式 claim。
- 工作区实际 HEAD 含核心 PR #60 merge `dfefae0`（含备份严格唯一性键修复 `75b448d`）；未自行 Git merge / commit。
- 允许 13 路径：`server/local-backup.mjs`、`test/local-backup.test.mjs`、`server/bank-storage.mjs`、
  `scripts/bank-reconcile.mjs`、`test/bank-reconciliation.test.mjs`、`test/bank-reconcile-cli.test.mjs`、
  `test/local-bank-backup-integration.test.mjs`、`docs/LOCAL-BANK.md`、`docs/tasks/LOCAL-04-BANK.md`、本文件、
  `docs/LOCAL-BACKUP.md`、`docs/tasks/LOCAL-06-BACKUP.md`、`docs/handoffs/LOCAL-06-BACKUP.md`。
- **不改** `bank-reconciliation.mjs`（A 审完保持）、核心 / db / import / coaprofile / HTTP / Agent / MCP / public /
  `scripts/test-all.mjs` / package / 共享 STATE；03B1 WIP 未读取 / 未复制；未用真实账套 / 税局。
- 实际改动 **9 文件**（claim 的子集）：`server/local-backup.mjs`、`server/bank-storage.mjs`、
  `test/local-bank-backup-integration.test.mjs`、`docs/LOCAL-BANK.md`、`docs/tasks/LOCAL-04-BANK.md`、本文件、
  `docs/LOCAL-BACKUP.md`、`docs/tasks/LOCAL-06-BACKUP.md`、`docs/handoffs/LOCAL-06-BACKUP.md`；
  未改 `test/local-backup.test.mjs`、`scripts/bank-reconcile.mjs`、`test/bank-reconciliation.test.mjs`、
  `test/bank-reconcile-cli.test.mjs`（只重跑）。

### 10.2 实际变化

1. **合并冲突的真实解决（只在本清单文件内）**：核心 `75b448d` 把完整唯一性键模型接入结构校验后，
   银行表被并入 `effectiveStructure` 但 `unique` 仍是旧空数组，导致**健康 bank 备份被 `unexpected_unique_index` 误拒**
   （集成基线 1 / 5）。`BANK_COMPONENT_STRUCTURE` 每表补上对象形状的 `unique`（从同一份
   `BANK_SCHEMA_CONTRACT.indexes` 静态派生）与显式 `rowidAlias`，不丢掉任一已审合同，也不从当前库动态生成期望。
2. **备份侧逐键校验**：core `unique` 模型支持带名字 / `partial` / `where` 的条目；组件索引改用完整
   `pragma_index_xinfo` 事实（`seqno` / collation / 方向 / 表达式 / rowid / `origin` / 真实谓词），
   全部 19 条索引逐条比对；额外 / 缺失 / 命名与自动索引互相顶替都拒绝，不针对具体索引名特判。
3. **rowidAlias / 复合主键**：`INTEGER PRIMARY KEY` 表按真实 rowid 别名核对（不另建主键索引、逐行相等）；
   `bank_accounts` / `bank_batches` 复合主键按真实自动主键索引的键列与 `BINARY` 升序语义核对。
4. **三入口一致**：`createBackup`（源库）、`verifyBackup`（快照）、`restoreNew`（恢复目标）都走同一结构校验；
   被拒备份不得生成恢复目标。
5. **兼容**：清单格式 / `formatVersion` / `components[].structureDigest` 口径未改；旧 core v3 / v4 与旧 bank
   内部候选备份保持可读，不要求重生成 / 升级；到实际业务打开才按产品入口迁移。
6. **旧合同保持**：10 表列 / 类型 / null / default、外键完整集合 / 动作、版本行、未知 trigger / view、
   安装前 backup + verify、DBPath / 句柄一致、`BEGIN IMMEDIATE` 排他、fresh 回执、失败审计 / 回滚未知态均未回退。

### 10.3 本窗实际测试（工作目录 `06-workbench`，合成临时库）

```
node test/local-backup.test.mjs                          # 22 / 22（核心 22 项含义未变）
node test/bank-import.test.mjs                           # 16 / 16
node test/bank-reconciliation.test.mjs                   # 40 / 40
node test/bank-reconcile-cli.test.mjs                    # 12 / 12
node test/local-bank-backup-integration.test.mjs         # 5 / 5（断言更新，不删旧断言）
                                                         # 合计 95 / 95，exit 0
```

集成用例新增：源库 / 快照 / 恢复目标三入口对 `NOCASE` / `RTRIM` / `DESC` / 表达式 / 错误 partial 谓词 /
额外唯一索引 / 命名与自动索引互顶 / `INTEGER PRIMARY KEY DESC`（rowid 别名被破坏）全部拒绝，
快照同时重算清单字节数与 sha256（摘要自洽）仍拒绝且不生成恢复目标；健康库 `backup → verify → restore-new`
后真实 `Ref-A` / `ref-a` 两笔继续导入成功；与真实 DDL 同义重建不被误拒。
**未跑**全量 suite（代码只改备份 / 银行契约与文档；整合面全量由 root 冻结后执行，不为无源码变化的套件重复全量）。
原 stdout 存在本工作区 `.agent-runs/`（未提交）。

### 10.4 未完成 / 边界

- 仍为 **core v3 / v4 + 可选 bank v1**；未来 v5+、bank v2+、batch / audit 与其它未登记组件仍拒绝。
- 无 UI / 共享模型入口 / HTTP / Agent / MCP 接线；`scripts/test-all.mjs` 四个银行套件登记由 root 后续独立短窗完成。
- LOCAL-03 双准则 / 辅助维度 / 往来合同未在本窗验收；不声称 LOCAL-04 整体或 03 科目往来已完成。
- 不宣称已提交 / 已建 PR / 已合 / 最终通过；待 root 冻结、独立复审与 Git 收尾。


## 2026-10-23 fresh P1 回修自测交付候选（未合并）

实施身份为 huxiaoyang-code 的本轮用户授权兜底实现会话；基线 `7ca2e319610086f25769fe744256841b21b56c2b`。按 Issue #53 的 8→9 路径窗口，仅修改银行 storage / CLI、三套银行测试、银行三文档与 `database-open-guard.mjs` 的保留数据库 release 窄选项；没有 Git 写操作，没有使用 pi / Claude / 其他模型或子 agent。

修复事实：O_EXCL 保留读写创建 fd，私有不可变创建身份 / marker 身份 / seed 字节与回执对象绑定；打开 SQLite 前检查实际路径对象及创建 fd，真实核心入口仍由通用 actual-connection hook 在任何核心 DDL / WAL / migration 前核验。手工核心夹具在真实连接上先调用 preDDL 核验再建 schema；ensure 拒绝未见证连接。篡改回执与克隆不转入现库安装；安装确认提交后消费，调用方 BEGIN 拒绝保留回执，异常由显式 release 收尾。银行 release 始终 preserveDatabase，保留库文件、不用只读 SQLite 反查是否可删；默认07 release不变。

真实 init-db core3/4 有业务库的替换 / 同 inode 填充矩阵拒绝后，旧业务字节、凭证行、迁移版本不变，WAL / SHM / 核心迁移或银行备份目录不新增。相同内容的新 marker 对象保留；回执字段 / 克隆 / 不同路径 / junction 拒绝；测试 loader 的 open / fstat 单点故障保留现场、关闭自有句柄。没有生产故障绕过开关。旧 core3 P1 的真实证据有核心 pre-v4 备份，不能误写为完全无备份。

工作目录 `06-workbench`，最终命令与实际退出码：

| 命令 | 实际结果 | exit |
| --- | --- | --- |
| `node test/bank-import.test.mjs` | 16/16 | 0 |
| `node test/bank-reconciliation.test.mjs` | 43/43 | 0 |
| `node test/bank-reconcile-cli.test.mjs` | 14/14 | 0 |
| `node test/local-bank-backup-integration.test.mjs` | 5/5 | 0 |
| `node test/local-backup.test.mjs` | 22/22 | 0 |
| `node test/local-batch-persistence.test.mjs` | 39/39 | 0 |
| `node test/local-batch-cli.test.mjs` | 11/11 | 0 |

合计定向 150/150；没有跑全量总入口。银行旧 rollback-confirmed / unknown / caller BEGIN / 严格索引断言保留；user_version 的旧“等于0”改为“等于安装前创建守卫已写的nonce”，保留银行组件不改全局版本的语义。

失败如实保留：初轮领域 39/40（原0值断言与新种子nonce冲突）；新增CLI hook初轮两次有 Windows --import 路径及hook换行构造错误，随后修正；CLI第三/五轮真实负测暴露 readonly probe与release探测生成 WAL sidecar；第四轮 seed读回遇到只写fd，改为真实O_EXCL的 `wx+`。没有删弱旧断言。银行junction首轮42/43、默认07 persistence首轮38/39、backup首轮21/22均为沙箱拒绝链接构造，获自动批准的 require_escalated 合成fixture命令后完整套件通过，没有skip。07CLI首轮10/11为未设置 REPORT_OFFICE_PYTHON，设置已验证的内置Python后11/11；环境红日志没有覆盖删除。

所有 fixture 为新建唯一 workspace 专属根，TEMP / TMP / fallback WORKBENCH_DATA_DIR 先设在该根；祖先 reparse 校验，清理只针对当次明确自有目录。PDF回归使用已验证Python，仅合成产物。未触税局、真实账套、全局TEMP、旧fixture、共享配置；只持有本会话子进程句柄。具体日志与 SHA256 记录在 root `.agent-runs/local04-fresh-fallback-delivery.md`。

本条只交付待审核候选，不声明已提交 / 已合并 / LOCAL-04整体完成。下一步由 root 阅读 diff、独立 fresh reviewer 验收新 guard 增量和银行调用方、运行最终影响验证、执行 Git / PR；共享 test-all 银行四套登记与最终出版另开新会话。

## 2026-10-23 首次读页前纯文件核验 P2 窄修（待最终独审）

本条补充并限定前述历史候选结论。冻结旧候选 `ac3fe2943872ab9a4ac97c2b1763b9abf53d6c74` 的独立复现明确拒绝：在银行 `assertPristineCreationFiles` 返回后、readOnly SQLite 连接核验前，同 inode 填充普通已关闭 WAL 业务库，拒绝码正确且主库字节不变，但首次读页 `PRAGMA application_id` 会生成 0 字节 WAL / 32768 字节 SHM。constructor 和 `PRAGMA database_list` 本身没有生成 sidecar；未观察到业务 DDL、迁移或银行备份。这是拒绝过程的文件污染 P2，不能写成已证业务损坏，也不能用旧 150 项或旧候选 65 入口成功解除它。

本轮仅修改守卫、银行 CLI 测试和银行三文档（Issue #53 comment6357702843 的五路径窗口）。守卫在 connectionFacts 首次 SQL 前，用新开的纯文件只读 fd 核验页头魔数、application_id 与 nonce；db-init 还要求实际大小和完整 4096 字节种子一致。新读取 fd 的 fstat 必须与私有创建身份及保留创建句柄、路径身份匹配；finally 仅关闭本次自有读取句柄。07 创建 fd 仍可为只写 `wx`，不要求改为读写。stamp 的种子验证也先做同样纯文件核验。原 marker、创建身份与实际 SQLite 连接核验继续保留，银行失败 release 继续 preserveDatabase；没有扩改 storage、生产故障开关或协议。

正式 CLI 新增精确预检后同 inode WAL 注入用例，原 14 项及业务断言保留。旧源码下该新用例 exit 1，失败于新增 WAL 断言；新源码下 exit 0，拒绝 `fresh_database_foreign_content`，主库字节、业务行 991、迁移版本 3 和 user_version 73 保持，拒绝时无 WAL / SHM / DDL / 迁移或备份目录。独立 SQL 验证安排在 sidecar 断言之后，避免把测试自身读取所建文件误算成被测入口行为。

本轮在 `06-workbench` 的受影响自测实际通过，均 exit 0：`node test/bank-reconciliation.test.mjs` 43/43、`node test/bank-reconcile-cli.test.mjs` 15/15、`node test/local-bank-backup-integration.test.mjs` 5/5、`node test/local-backup.test.mjs` 22/22、`node test/local-batch-persistence.test.mjs` 39/39、`node test/local-batch-cli.test.mjs` 11/11，合计 135 项。junction 用获批准的真实合成构造验证，没有 skip。07 CLI 首轮 10/11 exit 1 是本次漏设 `REPORT_OFFICE_PYTHON`；补设指定内置 Python 后完整 11/11 exit 0，初轮日志保留。纯文件自有探针另有正常只写创建 fd 成功、读取 EIO、短读三组：后两组在任何 SQLite SQL 前拒绝，读取 fd 关闭，创建 fd 未误关，主库不变且无 sidecar。

全部 TEMP / TMP / fallback DATA 在本轮新建 workspace 专属根内，事先核验祖先无 reparse point，只用合成 fixture 与自有子进程；未扫描清理全局 TEMP、未读取真实账套或税局凭据。日志、命令和最终五路径 SHA256 见管理者本机忽略目录 `.agent-runs/bank-narrow-wal-p2-delivery-20261023.md`。本次实现未执行 Git 写操作，未运行新候选全 65 入口，未声明最终独审接受、PR ready / 合并或 LOCAL-04 整体完成。边界仅闭合已实证时序及同根因文件内容检查，不承诺检查后无限持续恶意物理并发改写；下一步由管理者冻结新 head、fresh 独审和最终回归验收。
