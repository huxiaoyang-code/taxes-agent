> **2026-10-23 已合并事实（优先于下方历史候选）**：PR [#67](https://github.com/huxiaoyang-code/youshu-fork/pull/67) 已合，已审 head `8ec01c4c6855fb088278f23003d1738ccc399ac4`，merge `ef599f86b948e574aa1b796e2da21a31b7685fa6`；Issue59 已关闭。pure 11、fault 2、full 39 均 exit 0；两个固定 e86 冷源各 162 pass / 1 warn / 9 skip。14 PNG 与先前目视 7 页逐 SHA 相同，不能冒充新目视或 W2 最终升级。后续 PR68 已合 core5 整合，Windows 实际 service 5/5、skip 0、exit 0。W2 最终升级、LOCAL06 整包仍未完成；旧删除事故与未知根因结论原样保留。下方未 PR/未合表述为当时历史。
# LOCAL-06-WINDOWS 交接

> **当前状态（2026-10-23）**：服务 / 包装器生命周期窄修获独立源码审查接受（本范围无 P1 / P2）；管理者在冻结四代码哈希上实际完成纯验证 **11/11**、生产入口真实故障 **2/2**、完整正式套件 **39/39**，均 **0 skip / exit 0**。两次新的随包冷验收均 **11 阶段 pass、162 pass / 1 warn / 9 skip、exit 0**。本轮文档窄修输入 clean HEAD 为 e7205585c759716db05014806fa901d502ffaa08。最终完整 head / 三文档 / 全 PR 仍待独立接受；**未开 PR、未合并，LOCAL-06 总包未完成。**
>
> 冷验收固定业务源仍为 e86d248c2a573b12c884f311fb01952f209e2563，叠加当时四代码及三文档共 58 文件；本次三文档收口在冷验收之后。它不证明最终 core5 / 辅助核算 / 审计 / 批量整合版已升级验收。W2 upgrade-rollback 仍 w2_contract_pending / blocked。实际仅 **Node 24.15.0 / Windows x64** 已测，engines >=22.5.0 只是声明，真实税局接入 **0**。
>
> 旧删除事故 **8 目标 / 4 已证归属 / 4 未证归属与影响**、reviewer 意外目录保留、原生异常 **3221226505 根因未知**继续有效，不能据当前通过声称零影响。旧候选及旧 gate 结果见历史章节。

## 1. 基本信息与恢复边界

- 任务 LOCAL-06-WINDOWS；负责人 huxiaoyang-code；分支 codex/huxiaoyang-code/local-06-windows-delivery。
- [Issue #59](https://github.com/huxiaoyang-code/youshu-fork/issues/59)，Refs #20 / #49，审计 #54、Office #45。未开 PR、未合并。
- 本轮文档窄修输入 clean HEAD e7205585c759716db05014806fa901d502ffaa08；冷业务源 e86d248c2a573b12c884f311fb01952f209e2563。最终提交 / 合并 SHA 由管理者实际记录。
- 一台 Windows 11 10.0.26200 x64；Node 24.15.0、npm 11.12.1，其余组合未测。
- 历史 pi 使用已核实 deepseek-v4.1-flash / tokenhub。事故整改后的新 pi 会话无 shell、只实现与文档；事故前首轮员工确实测试及越界清理，不用后轮事实覆盖。
- 本次用户授权单一兜底实施者只收口三文档，未运行测试 / npm / 浏览器 / 服务，未启动 child / 模型 / 其它 agent，未清理、未 Git。四代码哈希前后不变；管理者负责运行验收、最终完整 head 独审与 Git / PR / 合并。

## 2. 冷源与证据恢复

冷副本共 58 文件：e86 白名单归档 51 文件，加当时四代码 / 三文档七路径。原基线逐项 Git blob 与 ls-tree 比对的历史确权保留；源 / 目标祖先及条目核验，不带 config / DB / node_modules。随包工具为 release_cold_copy、optionalMissing=[]，不用开发 worktree 工具冒充。三文档是冷验后收口，不冒称新版文档再次冷验。

本地 ignored 管理证据相对标识如下，不要求其它电脑存在：

- windows-w1-gate4-34ce244e344148d49aaf5efa2b5ada02：pure 11 / 退出 JSON。
- windows-w1-gate4-c93e06e454544fb7a2a5d73c19736a59：真实故障 2 / 保留 fixture。
- windows-w1-gate4-9582108241a74566bd5d3e6d676d7e14：full 39 / full.exit.json / 代码前后哈希。
- windows-w1-cold-prep-ca00015f7812466188a30de71a5fbfcc：sourceHead / 58 文件清单 / 专属缓存。
- windows-w1-manager-cold-4e9258d0c62e44a68dd24bccb8acbbe8：keep / cleanup 的原始结果、退出 JSON、manager-summary 与 manager-png-comparison.json。
- windows-w1-service-lifecycle-fresh-review-20261023.md：源码窄审无 P1 / P2，不代替最终全 PR / 三文档接受。

上述均在仓库 workspace 的 .agent-runs/ ignored 目录。跨电脑只依赖版本化文档、源码与之后实际 PR，不假定这些原始证据已同步。
## 3. 依赖契约

- 固定 e86 冷源上游：core schema v3（LOCAL-01）、`scripts/local-backup.mjs` / `server/local-backup.mjs`、`server/report-export.mjs` DTO、`server/report-office-export.mjs` 纯渲染模块、PR #58 审计独立原语。锁定所纳入 main `47b6ec18385ef3f9f1240e12a721e46cd66f218f` 已为 core4，严格备份支持 core3 / core4；本次冷验没有覆盖新版整合或升级链，后续版本须按对应合同验收；
- 本包输出：
  - `windows-runtime-check.mjs`：白名单 JSON，退出码 0 / 1 / 2 / 3；`--json`、`--data-dir`、`--scratch-root`；
  - `windows-start.ps1`：`-NodePath` / `-DataDir` / `-Port` / `-ScratchRoot`，有界预检后前台启动，传播退出码；`-MaxRunSeconds` 仅验收有界自停（退出 124）；stdout 打印 `windows_start_service_pid=<pid>`；
  - `windows-delivery-check.mjs`：结果 JSON（`<out>/windows-delivery-result.json`）、`logs/`、`artifacts/office/`，退出码 0 / 1 / 2 / 3；`--phase upgrade-rollback` 在 W1 恒为 `w2_contract_pending`；
  - `windows-delivery.test.mjs`：独立 `node:test` 用例，不依赖 npm test 挂载；
- 契约变更：无现有 DTO / 业务接口变更；只新增独立脚本与测试。

## 4. 文件所有权

W1 七路径见[任务单](../tasks/LOCAL-06-WINDOWS.md) §3。本次只写 docs/WINDOWS-DELIVERY.md、docs/tasks/LOCAL-06-WINDOWS.md、docs/handoffs/LOCAL-06-WINDOWS.md；四代码冻结不变。

未改实现、LOCAL03、银行 / 审计 / 备份 / 批量、package.json / lock、test-all、README、共享 STATE / 索引。版本文档仅相对路径及发布 / 数据占位符，精确本机证据只存 ignored 管理交付。
## 5. 实现摘要与关键取舍

- **预检在 DB import 前**：只使用 `node:sqlite` + `node:fs` + `node:child_process`，不 import `db.mjs` / 业务模块。版本 / 平台 / 架构不合格时**先拒绝，不建任何目录写探针**。
- **可阻塞探针隔离**：sqlite（`isTransaction`、只读拒写、`busy_timeout`）与 fs 探测放在独立子进程，父进程用**真实 deadline**（`MAX_PROBE_MS`）强杀，超时给 `runtime_probe_timeout`；不再把 `MAX_PROBE_MS` 当“信息字段”。子进程内所有数据库 / 文件句柄都在 `finally` 关闭，早 return 不漏。
- **版本策略保守**：只放行 **24.15.0**；22.16 / 24.0 只是冻结源码 API 分析，24 其它 minor / patch（含 24.15.1）与 25+ 都拒绝并给 `runtime_version_not_qualified`。`runtime.qualified` 改为**版本 + 平台 + 架构三者合取**（`qualifiedScope` = 24.15.0 / win32 / x64），不再只绑 Node 版本。`package.json` 的 `>=22.5.0` 只作为警告 `engines_declaration_too_wide`，不改共享文件。
- **字体只报候选**：固定候选路径存在即 `candidate_present`，不称“已验证可嵌入 / 字形完整”；实际导出结果才是判据；不扫描用户字体目录。
- **必需 PDF 产物缺失 = blocked（本轮返修）**：`runOfficeStage` 汇总五个必需报表后调 `classifyOfficeOutputs`；只要有必需 PDF 缺失（例如 `--font` 指向不存在的文件 → `pdf_font_unavailable`），`office` 阶段就抛 `blocked` 的 `StageError`（`pdf_output_required_blocked`）：阶段 `blocked`、总结果 `blocked`、退出 `2`、`cleanup.reason=blocked_residual_kept`（输出与工作根**保留**）。若同一阶段另有 `fail` 断言，则改报 `office_output_incomplete`（fail），不让 blocked 抢先把真实失败说轻。CSV / XLSX 的真实通过断言不变，不把缺字体改可选、不放宽 skip、不装字体；本工具也不会因预期 blocked/fail 再写 `internal-error.log`。
- **输出 / 发布 / scratch 入口也走前缀守卫（返修 1 + 2）**：共享的 `inspectRawAbsolutePath`（`windows-runtime-check.mjs` 导出）先看**原始字符串**：“绝对”只认**盘符绝对**或**完整 UNC**（`\\server\share`，server 与 share 均非空）；拒绝空 / 纯空白 / 首尾空白 / 相对 / drive-relative `C:foo` / root-relative `\foo`、`/foo` / **设备路径（含 `//?/`、`//./`、正反斜杠混用与 `\\?\UNC\...`）** / **缺 share 的不完整 UNC（`\\server`、`\\server\`）**。这里的判定是**纯字符串**，不 lstat、不 realpath、不连接网络 / 设备。`createScratchRecord` 也用它（原先 root-relative 能通过 `isAbsolute` 而被规范化），且把“显式空 / 空白 base”当无效入参而非“未提供”。`windows-delivery-check.mjs` 新增 `auditDirectoryRoot` / **`auditScratchBase`** / `auditInvocationPaths` / `prepareOutDir` 重写：`main` 在**任何 mkdir / 扫描 / 复制之前**校验 `--release`（真实目录、非重解析点、完整祖先链到卷根、realpath 一致，含嵌套 `06-workbench`）、`--out`（最近已存在祖先到卷根、已存在时必须是真实目录、创建后重验 realpath）、**显式或实际默认 scratch base**（根 / 最近既存祖先 / 根类型 / realpath；无效 scratch 时 `out` 也不会被创建，不再出现“out 已写、scratch 后拒”）、以及关系（`out` 与 `release` 互不包含；`out` 不得等于或包含 scratch base；`out` 可以放在 base 之内）。默认 scratch 规则不变（`<workbench>/tmp/windows-delivery`，但同样在上述前置审核内），只认自己在 base 下新建的随机根 + manifest，base 整体不算本工具所有；不放宽源 / 输出重叠约束。拒绝时**只写 stdout** 并非零（路径形式 / 关系拒绝=1，发布根 / scratch 根环境拒绝=3），不为了留日志先建未验证的 `out`。`inspectRelease` 同样先审根与 `06-workbench` 链，才扫描 / 复制。
- **冷拷贝入口自己复核（返修 2）**：`copyReleaseWhitelist(inspected, destRoot)` 作为导出的冷拷贝入口**不信任历史 `inspectRelease` 结果**：复制前重新只读核验源根 / 选定 workbench（完整绝对 / 非重解析点 / 完整祖先链 / realpath，且 workbench 真在源根内），并重算源摘要与 `inspected.digest` 比较（变化即 `copy_source_digest_changed`）；目标必须是原始完整绝对、不存在、最近既存祖先无 junction、与源根互不包含；拒绝时**不创建目标、不补删除**；目标创建后再重验 realpath。仅做根 / 祖先 / 路径关系校验，不演绎全部恶意并发 TOCTOU、不扫描系统目录。
- **`-ScratchRoot` 在 PowerShell 侧先校原始字符串（返修 1 + 2）**：`Test-RawAbsolutePath` 改为**先按字符串定性**：盘符绝对或完整 UNC（server + share）才通过，拒绝空 / 首尾空白 / 相对 / `C:foo` / `\foo` / 设备路径（含 `//?/`）/ 不完整 UNC；在任何 `Resolve-FullPath` 之前判定，不合格以 `scratch_root_not_absolute` 退出 `1`，**不建 scratch、不建业务 DB、不启动服务**；并用 `$PSBoundParameters.ContainsKey('ScratchRoot')` 区分“未提供”与“**显式空 / 空白**”（后者拒绝，不静默退回默认根）。正向绝对 scratch 仍通过。不改 `ExecutionPolicy`。
- **专属临时根 + 所有权 manifest（v2，脚本 / 测试共用一份守卫）**：守卫实现在 `windows-runtime-check.mjs` 并 export，`windows-delivery-check.mjs` 与测试 import 复用，不维护第二套。预检 / 验收 / 测试统一在 `<工作区 06-workbench>/tmp/windows-delivery` 下新建随机目录，或用 `--scratch-root` / `-ScratchRoot` 传入的**显式授权绝对路径**（原始入参先校绝对路径，不是 resolve 后再查）；`base` 本身从不被删除，也不枚举 base 下其它目录、不读它们的 manifest 来推断“整个 base 归我”。
- **创建 / 删除的祖先链**：任何 `mkdir` 之前，把最近已存在祖先**逐级核验到卷根**（有 symlink / junction / reparse point 就拒绝）；创建后再次核验完整链与 realpath 等于预期规范化路径；删除前重验同一链。未确认的路径不写、不枚举、不删。
- **删除前逐项核验（唯一入口）**：覆盖脚本 / 测试里**每一处**递归或文件删除（临时根、`node_modules` 重装、Office 辅助脚本、探针 fs 文件）：目标必须在内存与 manifest 中都登记且 realpath 一致、绝对路径在专属根内、完整祖先链到卷根与目标内部项都无 symlink / junction、realpath 一致。manifest 缺失 / 破坏 / 多出未登记目标一律拒绝，**不**从磁盘 manifest 导入删除目标。成功后刷新剩余登记，失败保留。任何不确定 → 保留 + 非零（`cleanup_refused` / `cleanup_failed`），不 best-effort 吞错报成功。名称 / 前缀 / 目录大小都不作为所有权。
- **cleanup 状态如实**：`cleanup.manifestVerified` 只在真读过并校过 manifest 且一致性通过时为 `true`；未尝试 / `--keep` / 失败保留一律 `false`（同时 `retained=true`）。内部路径 / realpath / root / manifest 不符时不得报 `ok`。
- **数据目录只读**：预检不在用户已有数据目录写 / 删探针（`dataDir.writeProbe=not_performed`）；删除 API 的真实性由自建 scratch 内“子进程只创建、父进程用同一守卫真删”的探针证明（`limits.fsRmVerifiedThroughGuard`）。runtime 的探针 + 数据目录段包在 `finally` 里，任何早返回都会尝试清理。
- **启动脚本兼容 Windows PowerShell 5.1**：未用 pwsh 7 专属语法；不调用 `Set-ExecutionPolicy`。预检改为 `System.Diagnostics.Process` 有界子进程（30 秒上限，超时杀并核验回收；`runtime_check_timeout` 退出 2 / `runtime_check_not_stopped` 退出 3，后者额外打印 `windows_start_residual_precheck_pid=`）。服务用 `Start-Process -PassThru` 跟踪句柄并打印 `windows_start_service_pid=`；正常结束 / `-MaxRunSeconds` 到期 / **异常路径**都只用**自有 Process 句柄**（`$child.Kill()`）停止，不用 `Stop-Process -Id` 也不用进程名；停不掉时报 `service_stop_failed` + `windows_start_residual_service_pid=` 并退出 3；`finally` 只释放句柄。普通前台服务无总时长上限。
- **启动脚本验收不再裸杀服务 PID**：包装器用自己的保留 Process 句柄在 `-MaxRunSeconds` 到期时停服务并退出 124；验收脚本只等这个有界结果，超过宽限就回收自有包装器句柄、把服务记为 `service_identity_unverified` 残留、保留目录并 fail。不再有 `confirmServiceIdentity` + `process.kill(servicePid)` 这个兜底：`/api/account-sets` 能返回 JSON 不能证明该 PID 属于该端口 / 该创建实例，所以不称 PID 身份验证；存活探测只用于如实报告残留。测试同语义：正常 124 成功路径额外证明“该端口不再响应”（不按 PID 猜杀）。
- **子进程 deadline / 回收**：`spawnCaptured` 每个子进程都有真实 deadline；先 SIGTERM，1 秒后 SIGKILL，再过 `KILL_GRACE_MS` 仍不 close 就按“未回收”返回并记 `fail` 断言（不再无限等 close）。`startServer` 的 `stop()` 同样有界，杀不掉登记残留进程并让总结果非零。并行稳定性阶段改用 `Promise.allSettled`：任一台启动失败都先回收已成功启动的另一台自有句柄，再如实报失败，不把服务留在后台。
- **阶段预算只是耗时后验**：`STAGE_BUDGET_MS` 在阶段 `fn` 结束后才比对实际耗时，超了判失败；它不可中途中断阶段。真正能中途生效的是子进程 `timeoutMs` + 杀宽限、HTTP `AbortSignal.timeout`、隔离探针 `MAX_PROBE_MS`；本轮不新增总进程 watchdog，局限留给管理者 / root 评估。
- **失败不可被掩盖**：任一 `fail` 断言、未回收子进程、清理失败都会把总结果置为非零；阶段耗时超出后验预算同样按失败处理（不再是“只记 code 仍 pass”）。
- **冷拷贝白名单**：`package.json` / `package-lock.json` / `server/` / `public/` / 可选新脚本 / 新测试；拒绝 `.git`、`node_modules`、`data`、`.npmrc`、`.env*`、DB/WAL/SHM、profiles / logs / tmp、符号链接。发布清洁度扫描只排除**明确已知**的专属 scratch 绝对路径（`<release>/06-workbench/tmp/windows-delivery` 与调用者显式传入的本次运行根），不再扫描其它现存 run 的 manifest 推所有权；其余 `tmp` 内容仍按 forbidden 拒绝。
- **工具来源**：`--release` 冷拷贝里有 W1 windows 脚本 / 测试就用那份（`release_cold_copy`）；缺失时显式记录 `external_tooling` / `partial_release_tooling` 作为阶段证据；`--require-packaged-tooling` 让缺失直接 fail（`packaged_tooling_incomplete`），用于最终“随包完整”验收。
- **依赖 / 网络**：先静态校验 lock `resolved` 只来自 `registry.npmjs.org` / `registry.npmmirror.com` 的 HTTPS 且带 integrity（拒绝 `file:` / `git` / 私有域 / 凭据 URL / 缺 integrity）；不再设置 `npm_config_registry`（它不能约束 lock URL）。`resolveNpm`：`.js` / `.mjs` 入口直接用 `node` 运行；其它入口（本次实际给的是 `npm.cmd`）则检查其同目录 `node_modules/npm/bin/npm-cli.js` 是否为普通文件，存在就用该 JS，找不到才 `npm_cli_not_verified`；从不执行 `.cmd` / `.bat`、不拼 `cmd.exe`（即“优先直接给 JS 路径”）。离线优先 → 缓存不足联网到专属缓存 → 守卫式删除 `node_modules` → 再离线复验；锁哈希前后一致；空 user/global npmrc + 白名单 env + `--ignore-scripts --no-audit --no-fund`。
- **真实 HTTP 业务链**：`PORT=0` + `HOST=127.0.0.1`，从本次 stdout 解析端口；新 data 空账套 → dryRun → 落库 → 重试幂等 → 次月同账套 → 重启识别批次 / 来源；独立金额与五类 CSV / DTO 断言保留不变。
- **Office（固定 e86 冷源契约）**：该旧源 HTTP 只支持 CSV，断言 `format=xlsx|pdf` 返回 `400 report_format_unsupported`；同一 DTO 调纯 `buildReportXlsx` / `buildReportPdf`，重开 XLSX 查数值，PDF 用可选 PyMuPDF **逐页**渲染 PNG（`<kind>-page-<n>.png`，页数必须完全相等）；工具缺失则诚实 skip，不用首页冒充全页。锁定 main47 的 `/export` 已支持 CSV / XLSX / PDF 附件，只有 `/export-data` 仍仅 CSV DTO；`public/index.html` 的格式选择 / 下载按钮与 `public/app.js` 下载逻辑已接线。这是先前独立包已有能力，不是本 W1 实现，也不能由旧源冷验推导新版已验。
- **备份 / 恢复**：运行中 `local-backup backup`（只读 + `VACUUM INTO`，包含 WAL 已提交）→ `verify` → `restore-new` 新目录 → 对应发布启动核对金额 / 批次 / 来源 / 外键 / 幂等；损坏快照、损坏清单、未知 schema、已存在目标均断言拒绝且原数据 / sentinel 不变。
- **失败路径 / 稳定性**：端口冲突用本包自建 listener（占位服务 0 连接）；文件冒充数据目录在启动前拒绝；10 次顺序启停 + 2 个并行独立 data / 端口，串账 0；不按 `node.exe` 名称杀进程。
- **升级阶段（W1 边界）**：`--phase upgrade-rollback` 只保留命令形态，在任何临时根 / 业务目录创建之前返回 `w2_contract_pending`（blocked，exit 2），不建业务 DB、不迁移、不安装依赖；任何 `--schema-pair` 都不解除。W1 **未**实现通用升级 / 降级链。

## 6. 当前管理验收

### 当前冻结源码与管理者实际验证

独立源码窄审确认：服务与包装器共用 owned-child close 观察，exit 仅供诊断；stop 未知抛错阻断同目录 restart / sequential；真实 HTTP 成功且 owned 服务仍有效才返回 ready；包装器端口、HTTP、断言、spawn error 与退出均进入统一有界 finally。服务由 PowerShell 保留的自有 .NET 句柄回收，管理器不按裸 PID / 名称猜杀。

| 冻结文件 | SHA256 |
|---|---|
| 06-workbench/scripts/windows-delivery-check.mjs | 0672edf7801397a21570f39fa207f933c4e686c2a0cb04eb6cc3d78bdf75eb5e |
| 06-workbench/test/windows-delivery.test.mjs | 7b486e8cabd81224dfa0c996d5956faf5b94974215647f04e12e7381397305ce |
| 06-workbench/scripts/windows-runtime-check.mjs | 41b4064a5c32d09d5d8ffd2d0cf48c66edcb4e8cf554b45e176bb3ff7998e517 |
| 06-workbench/scripts/windows-start.ps1 | d85689ead811d33e26bc106f6caf18d8deac0785ebf9bb93b1e950d28e3f01f1 |

npm / Office 生命周期保护继续有效：只有自有 child 实际 close 才标 reclaimed；timeout（即使 code 0）、spawn error、未知回收立即失败并保留，不能继续同目录安装 / 业务 / 删除。npm 只在已回收且明确 ENOTCACHED 时从离线回退在线，在线成功并回收后才守卫删除本轮 node_modules 再离线重装；其它网络 / 权限 / 完整性 / 参数错误停止。Office helper 留到渲染、探针、断言及必需 PDF 全部成功才守卫删除，blocked / fail / timeout 保留 helper、模块、输出与工作根。

管理者在全新 UUID 专属根实跑，四代码哈希前后不变：

| 验证 | 实际结果 | 范围 |
|---|---|---|
| 纯状态 / 决策 / 编排 | 11/11，0 skip，exit 0 | 生产所用入口，含 exit 不能代替 close、未知回收阻断后续 |
| 生产入口真实故障 | 2/2，0 skip，exit 0 | HTTP 503 / 拒绝、真实 spawn error；实际 close，完整 caller fixture / manifest 预期保留 |
| 完整正式套件 | 39/39，0 skip，exit 0，44.228 秒 | 原 32 项与断言保留，加 7 项；真实 PowerShell 正常链及带前置 HEAVY 缺字体真实 CLI 均执行 |
| 新随包 cold：keep | 11 阶段 pass，162 pass / 1 warn / 9 skip，exit 0 | attempted=false / completed=false / retained=true / reason=keep_requested / manifestVerified=false；实际一个根与 schema 2 manifest 保留 |
| 新随包 cold：cleanup | 11 阶段 pass，162 pass / 1 warn / 9 skip，exit 0 | attempted=true / completed=true / retained=false / manifestVerified=true；管理者只读确认 scratch 为空，无手动补删 |

真实故障用短时自有 Node HTTP 替身验证生产 startScriptProbe 控制与 finally；**不称为真实 PowerShell 故障注入**。真实 PowerShell 正常链由完整套件覆盖。两次 cold 外层记录均 reclaimed=true / timedOut=false / spawnError=null。

全新专属缓存先由完整套件 HEAVY 缺字体链实际覆盖缓存不足后的在线安装、守卫删除本轮依赖与离线重装；随后两次正常 cold 均缓存命中、networkUsed=false / offlineProven=true。网络只走固定 lock 已授权公共来源，离线复验不等于发行包自带全部依赖。

每次 cold 均检查五类 CSV / DTO 与 XLSX 金额，生成 5 PDF / 7 张逐页 PNG。两次新图全部与管理者此前实际目视的 7 页逐项 SHA256 相同（共 21 个摘要全部相等）：**新渲染与已目视样张像素文件一致**，没有声称管理者重新逐页目视新图。旧目视覆盖资产负债 / 利润 / 现金流 / 明细账各 1 页与余额表 3 页，中文分页正常，银行 61,300、利润累计 10,000。

每次 9 skip 包含 5 个机器目视标记和旧 Node / 其它架构 / 干净 OS / 完整离线 bundle 四项未测；相同 PNG 的已目视证据作补充，**不改 JSON 的 skip**。1 warn 为 engines 声明偏宽。结果仅覆盖固定 e86 冷业务源和当时随包工具；文档收口没有被冒称为再次冷验。

## 7. 历史追溯

### 历史失败、返修与旧结果

以下按发生顺序保留；“当时未跑”描述历史快照，当前验证以上表为准。

1. 首轮员工按系统 TEMP 下 wb-local06-* 通配递归删除并统计，未逐项确权或核验重解析点。匹配 8 目标：4 个由 run1–run4 结果 JSON 精确对应本人，另 4 个归属与实际影响未证；0.00 MB 不能推断为空 / 安全。另有 wb-probe-* 通配删除及手动清理，同样不合规。管理者按核实身份停止其进程，非正常完成；当时 7 文件 WIP 保留。不能断言误删他人，也不能声称零影响。run6 / run7 / run8 等旧结果不作现版依据。完整本地事故审计保存在 .agent-runs/local-06-windows-cleanup-audit.md（ignored）。
2. 旧候选 5fc23424176e4d582c4d5ec213f754caefbfe0c0：语法 3/3、基础守卫 7/7；完整初次 18/19（W2 目录期望断言失败），定点修正后新根 19/19、0 skip。两次旧 cold 各 11 阶段 / 158 pass / 1 warn / 9 skip，全离线，一 keep、一守卫清理。5 PDF / 7 页曾实际目视；W2 真实 exit 2 / w2_contract_pending，无 DB / 迁移 / 安装副作用。这些正常路径结果随后仍被独审拒绝。
3. 5fc2342 独审三项 P2：缺字体必需 PDF 缺失仍 exit 0；out / release 根与祖先 junction 漏审；PowerShell 先规范化相对 ScratchRoot 后误接受。两轮静态返修先补失败阻断与路径守卫，再修负测候选越界、scratch base 在 out 前审核、完整 UNC / 设备路径判定、冷拷贝入口复核。返修 1 员工 exit 0 但未放行运行；当时管理仅三语法通过、一字符串失败，28→29 项登记不等于已跑。后续 fixture 副本隔离、默认 cwd / scratch、PS5 BOM 与路径判定继续修正；历史未跑范围已由当前完整实跑补验。
4. 历史默认 sandbox 红、PowerShell PSAuthorization 拒绝、gate2 字符串失败、gate3 纯 3/3 / FS 6/7 均保留，不能倒写为当时通过。合 main 后曾因缺 exceljs 为 29/32 红；按固定 lock / 专属缓存离线恢复后旧 7946 对应源码 32/32、两次旧 cold 各 11 阶段 / 163 pass / 1 warn / 9 skip。163 只属于旧代码，当前 cold 使用 162。
5. 7946cd7ed071fdb4d108f0abda7f3a7bce53cdb9 最终 fresh 独审再发现两 P2：服务 stop 未知仍继续同目录启动、exit 被当作 close；launcher HTTP / 断言异常绕过统一收尾。窄修最初仅 5 项纯验证与语法检查，之后新增真实故障回归；独立源码窄审确认两条因果链已消除、无 P1 / P2。管理者已补当前 11 / 2 / 39 与两次新 cold；旧正常路径不能替代修后故障证据。
6. reviewer 自己的误 cwd harness 在仓库根建出 guard/independent-3486ff9d4580c625（自有 manifest）与空 out-target；junction 因 EPERM 未创建，无下游写入，两目录保留。review 根 .agent-runs/local-06-review-5fc234-9f62b17c 的两次缺字体 scratch 与篡改 manifest guard fixture，以及旧 gate junction / blocked fixture 均保留，不补清理；harness 已改为 import.meta 锚定。
7. Issue #49 原生异常 3221226505 根因仍未定位。已知越界删除行为、4 个目标未知归属 / 影响、未知崩溃根因是不同事实；当前通过不关闭任何一项，也不证明所有系统进程 / 历史残留已核查。

## 8. 数据、进程与清理边界

验收只用合成数据，不触真实账套、凭据、税局 / 浏览器旧会话；不读取用户字体目录或用户 npm 配置，不 dump env。网络仅固定 lock 已授权公共来源。服务只回环监听、动态端口，不复用旧服务，不按 PID / 名称扩大回收。

产品方向为本机单用户、多企业、每企一套；同一工作台 DB 可容纳多企业各自账套，不要求切换企业时换 dataDir 或重启。main47 所有手工入口尚未统一强制一企一套，入口统一属另项任务。禁止同 dataDir 多实例并发；本次两个独立 dataDir / 端口是隔离验收拓扑，不是一企一目录限制，也不推导多租户。

每次 capture 在自有 fixture 副本运行，cwd / 默认 scratch / TEMP / TMP / fallback data 明确归本轮；负测候选仅落自己 fixture。默认根真实建根与空白拒绝在副本覆盖，真实卷根仅纯路径预检。manifest v2 双向核验、完整祖先链与唯一删除守卫保持。junction、blocked、故障或回收未知现场按协议保留；未知即阻断后续安装 / 业务 / 删除。本次文档实施者没有创建或清理任何验收 fixture。

当前 cold keep 一个精确工作根保留；cleanup 由守卫清除、scratch 实际为空。历史 gate / guard / out-target / reviewer 现场仍保留，不代表全盘无残留。
## 9. 未完成与交接动作

### 未完成与下一步

- 管理者仍须锁定最终完整 head，对全 PR 和三份收口文档独立审查，再处理 PR / 自动合并与交接；源码窄审不代替最终接受。当前未开 PR、未合并，不关闭 LOCAL-06 总包。
- W2 真实升级 / 回退仍 pending / blocked。core5 / 辅助核算、LOCAL03、银行、审计 B/C、批量与 LOCAL07 检查点恢复均需精确上游提交和 schema 契约；固定 e86 业务冷源不能覆盖最终整合版。未知组件表继续拒绝备份，禁止过滤表或改版本号伪造兼容。
- engines >=22.5.0 声明仍偏宽；共享 engines / test-all / README / STATE / 索引未在本任务修改。Windows 套件仍以直接命令运行，不称已挂入 npm test。
- 其它 Node patch / 旧 Node 二进制 / 架构 / 干净 OS / 正式安装器 / 完整离线 bundle 未测；仅 Node 24.15.0 / Windows x64 已测。22.16 / 24.0 为 API 分析。
- 固定 e86 冷验的 HTTP Office 格式仍返回 400，Office 文件来自同 DTO 纯渲染模块；main47 的 HTTP / 页面下载已接线（见 §5），其整合后 W1 / W2 验收不能由旧源通过推导。真实税局接入 0，未用真实账套 / 凭据测试。
- 阶段预算为耗时后验，不能中途中断；子进程 / HTTP / 探针有真实 deadline，无总进程 watchdog。原生崩溃根因与事故未知影响继续保留。

本实施会话交付后冻结停止；管理者继续最终完整 head 审查、PR 与合并，不把三文档收口当作 LOCAL-06 全包完成。

## 2026-10-24 W2a 完整源码 bundle 候选交接

负责人 `huxiaoyang-code`；[Issue #106](https://github.com/huxiaoyang-code/youshu-fork/issues/106)；BASE `80b770161859b75174bb6763eaabd13a6f095748`，分支 `codex/huxiaoyang-code/local-06-windows-w2a`。仅五授权路径实施；root已核本机员工额度失败后启用唯一兜底实施者，独验/全新独审/Git/PR仍由root管理。当前为候选交付，未PR/未合并，不预填最终验收。

新增实际可用的 `--full-bundle` 与 `inspectReleaseBundle` → `copyReleaseWhitelist` 严格通路。manifest schema1含确切packageVersion、排序路径/bytes/SHA256与稳定bundleDigest；旧digest继续核心四目标合同。完整门要求server/public动态普通源码、package/lock、旧五项、四新增CLI与MCP/catalog七文件，保原相对结构；不能缺项再借开发脚本证明随包成功。四工具旧门、历史core-only兼容及owned清理协议保留。详见 [交付文档新增章节](../WINDOWS-DELIVERY.md)。

最终命令 `D:/node.exe --test test/windows-release-manifest.test.mjs`，cwd `06-workbench`：11/11、0 skip、约9.95秒，外层exit0/close0、timedOut=false，内部所有自有child实际exit/close。UUID `346674d2-5e5b-4d10-8946-a2716904a998` 的全新合成根在import前设置TEMP/TMP/DATA与KEEP_FIXTURES/WORKBENCH_TEST_KEEP_FIXTURES；逐祖先无alias，夹具全部保留。实际复制逐文件字节/hash、缺项与清单攻击、真实junction/hardlink、改源TOCTOU及失败现场、旧核心兼容、冷副本五CLI安全调用与MCP initialize/list已覆盖，未建默认DB、未调用税务工具或税局。

本机证据（ignored，仅交接定位）：`.agent-runs/local06-w2a-selftest-346674d2-5e5b-4d10-8946-a2716904a998.{log,exit.json}`、`.agent-runs/w2a-346674d2-5e5b-4d10-8946-a2716904a998/evidence.json`；完整清单在该root的 `1-cold/windows-release-manifest.json`。交付与五文件SHA登记为 `.agent-runs/local06-windows-w2a-delivery-20261024.md`、`local06-windows-w2a-final-files-20261024.json`。

保留失败历史：UUID `28bfdd41-954d-476a-910f-1f4c1c97043d` 首轮8/11，链接创建沙箱EPERM、batch测试误用--help；经正常审批，UUID `ee9ee23b-4449-4069-bbd5-1566ed7a0512` 10/11，真实链接组已过，batch帮助纯文本被测试误按JSON解析。最终修正测试的真实命令与输出通道假设，未改生产CLI、未skip负例、未删除历史现场。

未跑旧39全套、npm全套、完整冷安装/两最终冷链；此源码bundle不含离线依赖，不是正式安装器。W3b/W4、ledger/restore/重绑与升级回退仍后包；`w2_contract_pending`未解除，原W1历史数值与8/4/4事故/3221226505未知根因保持。root需在最新整合基线锁定完整head、独验与全新独审后处理PR/自动合并。实施者交付后FINAL STOP，无自有服务或未结束child。

### W2a R1 持久manifest消费返工（2026-10-24，未PR/未合并）

同Issue106/BASE80/原五路径；[R1认领](https://github.com/huxiaoyang-code/youshu-fork/issues/106#issuecomment-6378154681)。原五WIP开工bytes/SHA与上一交付一致，HEAD/branch通过只读元数据核对。旧实现忽略已有磁盘manifest的缺口由本轮修复；旧11/11仅覆盖当时内存清单与复制链，不能替代持久完整性证据。R1 必须消费已有磁盘manifest、受控读取并严格比实际版本/路径/bytes/hash/digest，记录原始manifestSha256防检查后或复制期间变动；无manifest构建源可生成清单，损坏发布来源不得重新签成新版本。

R1最终聚焦14/14、0 skip、exit0/实际close0、约12.37秒；原11组保留，另3组实际磁盘正向/攻击/变更保护。动态源码正向fixture旧manifest重命名保留后才用作无manifest构建源；已发布源新增源码拒绝。真实未知字段/必需项遗漏/重复/穿越/坏摘要/bytes、hash、version不符/畸形JSON/同长度工具损坏/manifest硬链接与变更全覆盖，坏证据不重写。10个内部冷副本CLI/MCP child实际exit/close、无timeout/默认DB，所有夹具保留。

新证据UUID `4ea25787-3bd0-404e-8123-3701d7b9949b`：`.agent-runs/local06-w2a-r1-selftest-4ea25787-3bd0-404e-8123-3701d7b9949b.{log,exit.json}`；`.agent-runs/w2a-r1-4ea25787-3bd0-404e-8123-3701d7b9949b/evidence.json` 及 `1-cold/windows-release-manifest.json`。新交付为 `.agent-runs/local06-windows-w2a-r1-delivery-20261024.md` / `local06-windows-w2a-r1-final-files-20261024.json`，列全部五个当前WIP文件；旧交付/证据保持，本轮无新红例。未Git/PR/合并、未跑旧39/npm全套/冷install/W4；w2_contract_pending及所有历史未完边界保持。交付后FINAL STOP，无自有运行服务/child，交root独验与全新独审。
