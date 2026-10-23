# LOCAL-06-WINDOWS 交接

> **2026-10-23 当前 W1 PS5 辅助脚本编码窄修（待管理者实跑）**：第二轮 fresh 静态门后，管理者新 gate3 已实际执行纯状态 / 路径字符串 / Office 汇总 **3/3 exit 0**；原最窄 FS 批次 **6/7 通过、1 失败，exit 1、0 skip**。唯一失败发生在 `pure-path-check.ps1` 的 `launcher_parse_failed`，早于真实 PS 路径负测；同一正式 launcher 由管理者真实 PS5 Parser 直接解析为零错误。测试把中文仓库绝对路径写入 Node 默认无 BOM UTF-8 临时 `.ps1`，PS5 的旧编码读取破坏路径；本轮为该辅助脚本显式添加 UTF-8 BOM，保持只提取纯函数 AST、不 dot-source 整个 launcher。已检查三份脚本 / 测试的生成点：仅此一处动态生成 `.ps1`，其它 helper 为 Node 脚本或复制正式 launcher。本轮仅静态检查与 Node `--check`，未执行修后 pure / FS / 真实 PS / HTTP / full / heavy / cold 或任何清理；前述 3/3、6/7 均为修前冻结源码事实，不能复用于新 hash。原 29 案例、全部断言、现场保留及唯一 manifest 清理守卫不变，两个 P2 与完整产品验收仍待管理者新 gate 实跑；未 PR、未合并。旧候选 5fc2342 的 19 用例 / 两次冷验收 / PDF 目视仅历史，旧删除事故 8 目标 / 4 已证归属 / 4 未证、reviewer 误 cwd 现场保留，native 3221226505 根因未知，W2 pending。


## 1. 基本信息

- 任务 ID / 状态：`LOCAL-06-WINDOWS` / **PS5 辅助脚本 BOM 窄修完成，待修后新 gate；修前 pure 3/3、FS 6/7 exit 1；两个 P2 与 full / heavy / cold 仍待验收，未 PR、未合并**。
- 本轮冻结 head：`5fc23424176e4d582c4d5ec213f754caefbfe0c0`（被拒候选）；冷业务基线：`e86d248c2a573b12c884f311fb01952f209e2563`
- 负责人：`huxiaoyang-code`（已核实）
- 历史执行员工（下述为前轮事实，本轮为用户授权单一兜底实现会话，仅纯语法检查，无模型 / 子 agent / Git 写入）：本机 pi（新进程、无持久会话）；模型 `deepseek-v4.1-flash`（provider `tokenhub`），主 / 回退同锁；未使用子 agent；未执行 Git 写操作；**事故整改后的新会话**工具集不含 shell，未执行任何命令 / 测试 / 进程 / 清理；**验收由管理者实际执行**，员工只做实现与文档。事故前首轮员工确实执行过测试与清理（含越界删除，见 §8），两者不可混用
- 本机管理者：成员自己的 Codex（负责差异审查、独立复跑、Git 提交 / PR / 合并）
- 分支：`codex/huxiaoyang-code/local-06-windows-delivery`
- 关联 Issue：[#59](https://github.com/huxiaoyang-code/youshu-fork/issues/59)（`Refs #20` / `Refs #49`；审计兼容 #54，Office #45）
- 目标：源码分发方式的 Windows W1 交付（预检 / 启动 / 干净目录验收 / 备份恢复说明）
- 不做：MSI / 服务 / 自动更新器 / 机器 PATH / 注册表 / 执行策略 / 防火墙 / 全新 OS 验收 / W2 迁移

## 2. 基线与证据分层

- 基线（冷业务源）：`e86d248c2a573b12c884f311fb01952f209e2563`（PR #58 已合 main）
- 已审核 head / 合并 SHA：本包**未 PR、未合并**；冻结候选 `5fc2342…` 已被独立独审**拒绝**（`changes requested`，3 项 P2），两轮管理静态返修在其上继续；实际交付 HEAD 以管理者记录为准（本文件不预测 SHA）
- 冷业务源：root 固定的 `e86d248…` 白名单归档（只含 `package.json` / `package-lock.json` / `server/` / `public/` / `local-backup` CLI）；51 个基线文件在复制前逐项用 Git blob 哈希与其 `ls-tree` 比对一致，源 / 目标祖先与全部条目无 junction，未带入 config / DB / `node_modules`
- 叠加层：本任务 4 个新 scripts / test 与 3 份文档共 7 个文件进入冷副本；随包工具来源 `release_cold_copy`（`optionalMissing=[]`），不用开发 worktree 脚本冒充
- 证据分层：
  - **历史（只覆盖被拒旧候选 `5fc2342`）**：管理者实跑 `node --check` 3/3；基础安全 pattern 7/7；完整测试 19/19、0 skip；`install-start --require-packaged-tooling` 两次独立运行（run-a `--keep`、run-b 默认守卫清理）均 11 阶段 pass / 158 pass / 9 skip / 1 engine warning，依赖完全离线；W2 真实 `exit 2 / w2_contract_pending`；PDF 5 份 7 页逐页目视。这些结果**不得**当作本轮修复后的回归；
  - **两轮管理静态返修（实现 + 文档）**：员工只改实现与文档，**未执行任何命令 / 测试 / 进程 / 清理**；当轮返修后新增 / 变动的用例（见 §6）静态计数曾为 28 个；当前窄修新增一个纯状态用例后为 29 个，除管理 gate2 字符串一项失败外，其余新用例**未实跑**；
  - **员工自述（限事故整改后的新会话）**：本地 pi 新会话工具集不含 shell，未执行任何命令 / 测试 / 进程 / 清理，只做实现与文档修改。**不得把 §6 结果写成员工自测**；事故前首轮员工确实执行过测试与清理（含越界删除，见 §8），该限定只适用于整改后的新会话；
  - **旧代码运行目录**（`run6` / `run7` / `run8` 等，前一位员工在旧版本上留下）只对当时那版文件有效，**已作废**，不作当前结果；
  - 本次形态是受控源文件冷拷贝 + 精确哈希核实，**不是**正式安装器发行包，也不是新 OS 实测；本机只有一台 Node 24.15.0 / win32 / x64 主机，22.16 / 24.0 仅为 API 分析。

## 3. 依赖契约

- 上游：已合 main 的 schema v3（LOCAL-01）、`scripts/local-backup.mjs` / `server/local-backup.mjs`、`server/report-export.mjs` DTO、`server/report-office-export.mjs` 纯渲染模块、PR #58 审计独立原语；
- 本包输出：
  - `windows-runtime-check.mjs`：白名单 JSON，退出码 0 / 1 / 2 / 3；`--json`、`--data-dir`、`--scratch-root`；
  - `windows-start.ps1`：`-NodePath` / `-DataDir` / `-Port` / `-ScratchRoot`，有界预检后前台启动，传播退出码；`-MaxRunSeconds` 仅验收有界自停（退出 124）；stdout 打印 `windows_start_service_pid=<pid>`；
  - `windows-delivery-check.mjs`：结果 JSON（`<out>/windows-delivery-result.json`）、`logs/`、`artifacts/office/`，退出码 0 / 1 / 2 / 3；`--phase upgrade-rollback` 在 W1 恒为 `w2_contract_pending`；
  - `windows-delivery.test.mjs`：独立 `node:test` 用例，不依赖 npm test 挂载；
- 契约变更：无现有 DTO / 业务接口变更；只新增独立脚本与测试。

## 4. 实际修改文件与所有权

仅这 7 个文件（既有未跟踪 WIP，本轮原地修改）：

1. `06-workbench/scripts/windows-runtime-check.mjs`
2. `06-workbench/scripts/windows-start.ps1`
3. `06-workbench/scripts/windows-delivery-check.mjs`
4. `06-workbench/test/windows-delivery.test.mjs`
5. `docs/WINDOWS-DELIVERY.md`
6. `docs/tasks/LOCAL-06-WINDOWS.md`
7. `docs/handoffs/LOCAL-06-WINDOWS.md`

本轮代码返修实际改动了 **4 个代码文件 + 3 份文档**（第 1–4 项代码、5–7 项文档）；上一轮“只改 3 份文档、代码 SHA 不变”的记载**不再适用**，代码 SHA 已变，由管理者重新记录。versioned 文档只用仓库相对路径与 `<release>/<data>` 占位符。

未修改：`server/*`、现有测试、`public/*`、MCP、银行 / 审计 / 备份 / 批量模块、`package.json`、`package-lock.json`、`scripts/test-all.mjs`、`06-workbench/README.md`、共享 `STATE` / 索引。

共享文件窗口（engines / `test-all` / README / 索引）**未获授权、未改动**；需 root 在现 owner 释放后另行登记。

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
- **Office**：HTTP 仍只支持 CSV，断言 `format=xlsx|pdf` 返回 `400 report_format_unsupported`；同一 DTO 调纯 `buildReportXlsx` / `buildReportPdf`，重开 XLSX 查数值，PDF 用可选 PyMuPDF **逐页**渲染 PNG（`<kind>-page-<n>.png`，页数必须完全相等）；工具缺失则诚实 skip，不用首页冒充全页。HTTP / 页面 Office 下载**未接线**。
- **备份 / 恢复**：运行中 `local-backup backup`（只读 + `VACUUM INTO`，包含 WAL 已提交）→ `verify` → `restore-new` 新目录 → 对应发布启动核对金额 / 批次 / 来源 / 外键 / 幂等；损坏快照、损坏清单、未知 schema、已存在目标均断言拒绝且原数据 / sentinel 不变。
- **失败路径 / 稳定性**：端口冲突用本包自建 listener（占位服务 0 连接）；文件冒充数据目录在启动前拒绝；10 次顺序启停 + 2 个并行独立 data / 端口，串账 0；不按 `node.exe` 名称杀进程。
- **升级阶段（W1 边界）**：`--phase upgrade-rollback` 只保留命令形态，在任何临时根 / 业务目录创建之前返回 `w2_contract_pending`（blocked，exit 2），不建业务 DB、不迁移、不安装依赖；任何 `--schema-pair` 都不解除。W1 **未**实现通用升级 / 降级链。

## 6. 验证记录（管理者实跑）

## 6. 验证记录（旧候选历史 + 管理局部验证与本轮未跑范围）

> **本节前半只覆盖已被独审拒绝的旧候选 `5fc2342`，不是本轮修复后的结果。** 本轮（独审返修）新增 / 改动的代码与用例**未实跑**，待管理者先审 cleanup / 路径 / 进程 diff 再在全新自有根验收。

环境：Windows 11 家庭版中文版 10.0.26200 x64（一台主机）；Node `v24.15.0`；npm `11.12.1`；冷业务源基线 `e86d248…`。以下命令与结果由**本机管理者**执行；**事故整改后的新 pi 会话**无执行权限（工具集限定 read/edit/write/grep/find/ls）。事故前首轮员工确实执行过测试与清理（含越界删除，见 §8），不能据本节反推「员工从未执行」。

- 语法：`node --check` 3 个脚本全部 exit 0；
- 基础安全 pattern：按批准命令实际选中 7 个纯守卫用例（此前误计 6），7/7 通过；其余 12 个用例不在该 pattern 内，不能写成 6/6 也不是 13 skip；
- 完整测试（19 用例）：初次 18 pass / 1 fail，唯一失败是 W2 用例的临时目录期望断言（首轮循环提前预期了第二次 `out` 目录）；只定点修该断言（补精确初始 manifest / tmp 基线与逐轮累计 `out`，未放松业务副作用检查），在全新 test scratch 复跑 **19/19 pass、0 skip**；初次 stdout / stderr / 退出码保留；
- `install-start --require-packaged-tooling`：
  - run-a（`--keep`）：11 阶段全 pass、158 通过断言 / 9 明确 skip / 1 engine warning；`preflight.tooling_source=release_cold_copy`、`optionalMissing=[]`；精确根保留，未额外清理；
  - run-b（默认守卫清理，全新 out / scratch）：同样 11 pass / 158 / 9 / 1；`cleanup.attempted=true / completed=true / manifestVerified=true / retained=false / reason=null`；管理者独立只读确认该精确根不存在；
  - 两次依赖安装完全离线（`networkUsed=false`、`offlineProven=true`），这不等于发布包自带全部依赖；
- PDF：本次运行的 `artifacts/office/` 下 5 份共 7 页（资产负债 1 / 利润 1 / 现金流 1 / 明细账 1 / 科目余额 3），管理者用 Poppler 计页后 `pdftoppm -r85 -png` 逐页渲染并实际查看 7 页：中文 / 金额 / 表格 / 跨页续表表头 / 页脚均可读，无截断 / 重叠 / 方块字；银行期末 61,300、利润当期 0 / 累计 10,000、余额表借贷 61,300（合成样本）。该次运行留有 PDF 哈希与 7 张 PNG 清单；脚本 JSON 中的 manual visual skip 由这份独立视觉证据补充，**未改写历史 JSON**；
- W2 负验收：`--phase upgrade-rollback` 真实 CLI `exit 2 / blocked / w2_contract_pending`，`stages=[]`，`businessDbTouched` / `dependenciesInstalled` / `migrationsRun` 均为 false，`cleanup` 为 `no_scratch_created`；输出目录只有 `artifacts/`、`logs/` 两个空目录和结果 JSON（`prepareOutDir` 对任何阶段都先建这两个子目录），无业务 scratch / DB / 迁移；带 `--schema-pair` 不解除，完整测试也验证了这一点；
- 残留与 fixture：两次完整测试与基础守卫各留 1 个本次自建 junction fixture（`guard-scratch` / `test-scratch` / `test-scratch-r1`），各有自己的 manifest，属预期拒绝证据，保留不删；run-a 精确根保留，run-b 根已由守卫清理；管理运行均已退出，完整测试 `residuals=[]` 断言通过（不据此声明所有系统未知进程均已核查）。

可复跑命令（默认 scratch 仍是 `06-workbench/tmp/windows-delivery`；不指向系统 TEMP。本次管理验收用的是 root 明确授权的仓库 workspace 专属忽略目录，相对 `.agent-runs/local-06-windows-gate1`）：

```powershell
cd 06-workbench
node scripts\windows-runtime-check.mjs --json
node test\windows-delivery.test.mjs
node scripts\windows-delivery-check.mjs --phase install-start `
  --release <冷拷贝根> --node <node.exe> --npm <npm-cli.js> `
  --cache <本任务专属 npm 缓存> --out <新的输出目录> `
  [--scratch-root <显式授权的绝对路径>] [--require-packaged-tooling]
node scripts\windows-delivery-check.mjs --phase upgrade-rollback `
  --release <发布根> --out <新的输出目录>
```

以上结果不覆盖：正式安装器发行包 / 其它架构 / 干净 OS / 旧 Node 二进制 / 完整离线 bundle，以及 HTTP / 页面 Office 下载。

### 6.1 两轮管理静态返修新增 / 变动的用例（均未实跑）

当前窄修测试文件静态计数：**29 个 `test(...)` 用例**（含本轮新增纯状态保留决策回归，未执行）（含需管理者前置、缺前置明确 skip 的缺字体真实 CLI 用例）。下列只是新增 / 变动的子集：

| 用例 | 需要的输入 |
|---|---|
| `专属临时根：relative / drive-relative / root-relative 原始 base 只在本用例自有候选目标上被拒绝且不写盘` | 无（三种 raw 入参均从本用例 fixture 内绝对目标派生，误规范化落点已先断言） |
| `路径字符串边界：只认盘符绝对与完整 UNC，拒绝不完整 UNC / 设备路径（含斜杠变体）/ 相对与 drive-relative` | 无（纯字符串；不连网、不碰设备） |
| `路径守卫：out / release 原始入参不是完整绝对路径时只 stdout 非零，不创建任何目录（真实 CLI，自有 cwd 与候选目标）` | 无（真 CLI + `upgrade-rollback` 无副作用阶段；子进程 cwd 显式指定） |
| `路径守卫：out 根 / 祖先 junction 在任何写入前被拒绝（真实 CLI，自有 fixture）` | 系统允许建 junction（否则明确 skip） |
| `路径守卫：release 根 / 祖先 junction 被拒绝且不创建 out（真实 CLI + inspectRelease）` | 同上 |
| `路径守卫：scratch base 根 / 祖先 junction 与显式空白都在 out 创建前被拒绝（真实 CLI，自有 fixture）` | 同上；验证无效 scratch 时 out 不被创建 |
| `冷拷贝入口：源根 / 选定 workbench / 目标 alias 与越界目标被拒绝且不写目标（自有 fixture）` | 同上；验证 `copyReleaseWhitelist` 自己复核，不写目标 |
| `Office 汇总：必需 PDF 缺失必须归类为 blocked，不得当作通过` | 无（纯函数） |
| `缺字体必需 PDF：真实 install-start CLI 退出 2 / blocked，输出与工作根保留（管理者前置）` | `WINDOWS_DELIVERY_RELEASE_ROOT` / `WINDOWS_DELIVERY_NPM_ENTRY` / `WINDOWS_DELIVERY_NPM_CACHE`（可选 `WINDOWS_DELIVERY_NODE_BINARY`）；不得以 skip 充抵验收 |
| `启动脚本：relative / drive-relative / root-relative / 空白 / 设备路径 -ScratchRoot 在规范化前被拒绝且无副作用` | WinPS 5.1（否则 skip） |

可复跑命令（所有临时根仍从 `WINDOWS_DELIVERY_SCRATCH_ROOT` 或默认 `<workbench>/tmp/windows-delivery` 派生）：

```powershell
cd 06-workbench
node test\windows-delivery.test.mjs
# 带管理者前置时，缺字体真实 CLI 用例才会执行，否则明确 skip
$env:WINDOWS_DELIVERY_RELEASE_ROOT = '<包含 W1 随包工具的冷拷贝根>'
$env:WINDOWS_DELIVERY_NPM_ENTRY = '<npm-cli.js 绝对路径>'
$env:WINDOWS_DELIVERY_NPM_CACHE = '<同既授权公共 lock 的专属缓存>'
node test\windows-delivery.test.mjs
node --check scripts\windows-runtime-check.mjs
node --check scripts\windows-delivery-check.mjs
```

本轮（返修 2）改动要点（待管理者复核 diff）：

1. 负测不再指向卷根 / WORKBENCH：所有 relative / drive-relative / root-relative raw 入参从本用例**自有绝对候选目标**派生（root-relative = 自有目标去盘符、保留完整子路径），并在调用前断言“即使被旧实现按 cwd 规范化，也只落在本 fixture 内”；不再有 `forbidden:null`；纯函数 `createScratchRecord` 负测同样使用自有 fixture；子进程 cwd 一律显式指定为测试自有目录，不用 `process.chdir`；拒绝后只核对准确候选目标与父目录快照，不扫描卷根 / 用户目录；
2. `auditInvocationPaths` 新增并复用 `auditScratchBase`：在任何 `out` mkdir 之前验证显式或实际默认 scratch 的根 / 最近既存祖先 / 根类型 / realpath；无效 scratch 时 `out` 不创建；
3. `inspectRawAbsolutePath` / `Test-RawAbsolutePath` 改为字符串级先定性“盘符绝对或完整 UNC”，拒绝不完整 UNC / 设备路径（含斜杠变体）/ 显式空白（PS 用 `$PSBoundParameters` 区分未提供）；
4. `copyReleaseWhitelist` 自行重验源根 / 选定 workbench（含摘要重算）/ 目标完整绝对与祖先 / 目标不存在且不重叠源；拒绝不写目标；
5. 文档记录未实跑、`5fc234` 被独审拒绝的记录、旧事故 / 限制与缺字体前置不可 skip 充抵。

## 7. 真实数据 / 安全边界

- 未触碰真实账套、真实凭据、真实税局 / 浏览器 / 旧会话；未读取用户字体目录 / 用户 npm 配置；
- 全部合成数据（Windows 交付合成公司，2026-01 / 2026-02，金额 50,000 / 11,300 / 10,000 / 1,300）；
- 网络仅用于锁文件声明的公共 registry 与官方文档；无私有 registry；lock 来源已加静态白名单校验；
- 所有服务 `127.0.0.1`，`PORT=0`；旧 8787 未探测 / 未复用；
- 子进程环境为白名单，未 dump env；日志只保留必要输出，不含凭据；
- 未修改业务模块、未自动安装审计组件、未添表、未关闭未知表校验。

## 8. 进程 / 清理事实

**员工侧（限事故整改后的新会话）**：历史返修 pi 会话未执行任何命令、进程或删除操作，只改文件与文档；无新增临时目录、无新增残留进程。事故前首轮员工确实执行过测试与清理，见下面「首轮员工越界」。

**管理验收产生的目录**：均在 root 明确授权的**仓库 workspace 专属忽略目录**内（相对路径 `.agent-runs/local-06-windows-gate1`，位于仓库 workspace 的 ignored 根，**不是**独立 worktree 内的子目录；版本化文档不写其绝对路径），先核验祖先链再新建，各自带 manifest；脚本自身默认根仍是 `<workbench>/tmp/windows-delivery`，本轮未用该默认根做管理验收。run-a 按 `--keep` 保留其精确根；run-b 精确根由唯一删除守卫清理并核验（`completed=true / manifestVerified=true`，管理者独立只读确认已不存在）；`guard-scratch` / `test-scratch` / `test-scratch-r1` 为本次自建的 junction fixture（预期拒绝证据），保留不删。没有按前缀 / 通配 / TEMP 的删除，也不为“美观”清理早期残留。

**首轮员工越界（已停止，事实保留）**：该员工曾按 `$env:TEMP` 下 `wb-local06-*` 通配匹配递归删除，并递归统计过同前缀目录，删除前未逐项核验 manifest 所有权 / 绝对路径 / 重解析点；匹配到 8 个目标，其中 4 个可由 ignored 运行目录的结果 JSON（`destRoot` / `workbenchDir`）精确对应到其 run1–run4 失败临时根，另 4 个归属**未能核实**（0.00 MB 只是两位小数统计，不能推断为空 / 安全 / 自有）。因此可证明 4 个属于本人、4 个归属未知：既不能断言误删他人目录，也无法声称零影响。其进程随后被管理者按核实身份停止（非正常完成退出），7 个新增文件 WIP 原地保留、HEAD 仍为 `e86d248…`，未提交 / 推送 / PR / 合并。另有带通配符的 `wb-probe-*` 删除与若干手动清理，同样不满足“删除前精确目标核实”，已统一禁止。完整管理审计见仓库忽略的 `.agent-runs/local-06-windows-cleanup-audit.md`。

**代码 / 文档限制（已落地；旧候选验收覆盖，返修后的代码仅管理三语法通过与一字符串失败，其余未实跑）**：临时写入只在 workspace 专属根（默认 `<workbench>/tmp/windows-delivery`，或显式 `--scratch-root` / `-ScratchRoot` 的授权绝对路径）；每根一份 manifest v2（逐项删除目标 + realpath）；mkdir 前与删除前核验完整祖先链 + realpath；禁止通配 / 前缀删除、禁止枚举或清理系统 TEMP、禁止用目录大小或名称推断归属；无法证明归属就保留并非零报告。旧候选的 19 用例与两次冷验收实际执行过这些守卫（含 junction 拒绝回归）；两轮静态返修新增 / 变动的用例（自有候选目标上的 relative / drive-relative / root-relative 拒绝、路径字符串边界（不完整 UNC / 设备路径变体）、out / release / **scratch base** 根与祖先 junction、冷拷贝入口源 / 目标 alias、缺字体 blocked 保留、`-ScratchRoot` 原始路径与空白拒绝）除管理 gate2 字符串一项失败外，其余**未实跑**。

**本轮新增测试的保留行为**：out / release / scratch / 冷拷贝入口的 junction 用例的 fixture（junction 只指向测试自己在同一自有根内建的目标）按预期拒绝后**保留不删**，不进通用 after 的“全清”断言；缺字体真实 CLI 用例在 blocked 时会保留 `out` 与 CLI 自建工作根（含 manifest）作为证据，同样保留不补清理；纯字符串 / 裸路径拒绝用例不建任何目录，其自有 fixture 仍走共享守卫正常清理。

**独立独审（reviewer）现场与它自己的事故（事实保留，不由本次员工处理）**：reviewer 在观察到的 review 根（相对仓库 workspace：`.agent-runs/local-06-review-5fc234-9f62b17c`）下留下了两次缺字体运行的 scratch 根、一个故意篡改 manifest 的 guard fixture，均保留未删。

reviewer 另有一次**自己的工具事故**：首个 boundary harness 错用 `process.cwd()` 并从仓库根启动，在仓库 workspace 根下建出了 `guard/independent-3486ff9d4580c625`（含自己的 manifest）与一个空 `out-target`；随后 junction 创建因 EPERM 失败，未产生链接或下游写入。两个目录**保留未删**（未做任何手工清理），harness 已改为 `import.meta` 锚定。因此本轮**不得**声称“全部无意外目录 / 已彻底清理”；这里只记事实与相对路径，不写本机绝对路径。

**两类未知要分开**：该越界行为本身是**已知**的（未确权即按通配递归删除）；但其 4 个目标的**归属与是否已造成实际影响仍未知 / 未证实**；而 Issue #49 的一次原生异常（`3221226505`）的**崩溃根因才是未定位**。三者不因本次测试全绿而消除；如需复盘由 root 另行安排，不在本交接扩写。

## 9. 未完成 / 未验证

已完成（**旧候选 `5fc2342`，已被独审拒绝；不得当成本轮结果**，管理者实跑，见 §6）：语法检查；基础守卫 pattern 7/7；完整 19 用例；两次独立 `install-start --require-packaged-tooling` 冷验收；PDF 5 份 7 页逐页目视；W2 负验收。

仍未完成：

1. **两轮静态返修的全部验证**：返修 1 的 3 项 P2 与返修 2 的 5 项静态门槛均已写入代码，历史员工未执行测试；管理已有三语法通过与一字符串失败，尚需管理者先审 diff（重点：新增路径守卫 / scratch base 前置 / 冷拷贝入口 / 负测 fixture 落点），再在**全新 UUID gate 自有根（不得复用 gate2）**跑批准验证（含静态计数 28 用例、`node --check` 3/3、缺字体真实 CLI 的 exit 2 + 保留现场、完整随包冷验收、两月 HTTP / 5 报表 / 备份恢复 / 重复启动），之后才能重新冻结 7 文件候选；本包未 PR、未合并；
2. 正式安装器 / 完整离线发行 bundle、干净 OS、其它架构、旧 Node 二进制（本轮无旧二进制，`skipped.old_node_binary`）；22.16 / 24.0 只是 API 分析，不是实测支持；
3. `package.json` engines 声明（仍 `>=22.5.0`）与 `test-all` 挂载、README / STATE / 索引更新，需共享 owner 窗口授权；
4. HTTP / 页面 XLSX / PDF 接线（仍 `400 report_format_unsupported`）；脚本自身无读图能力，人眼结论始终由人做；
5. W2：core v4 的 v3→v4 迁移 / 恢复、02 冻结 backup 新版本、03、银行、审计 B–C、批量最终契约集成；每种组合需上游提交与精确 schema 契约，**真实升级尚未完成**；
6. 阶段预算是**耗时后验**，不是中途硬总时限（无总进程 watchdog）；该局限保留，是否加强由管理者 / root 评估；
7. Issue #49 原生异常（`3221226505`）原因仍未知；本次受控运行未见同码，不声明已修复 / 无关；
8. 旧候选曾记录“本轮不要求机械重复第三次全套验收”，但该结论**只对那版代码成立**；本轮（独审返修）改了 4 个代码文件 / 1 个测试，**必须**由管理者在全新自有根重跑完整验证后才能重新冻结候选（见上条 1），不能沿用旧结论。
9. 保留的未知边界：原生 `3221226505` 未定位；非新 OS，仅 24.15.0 / win32 / x64；W2 真实升级仍 blocked；旧事故 8 个目标中 4 个归属未证；reviewer 事故的 `guard/independent-xxxx` 与空 `out-target` 保留未删。

## 10. 下一步

1. 管理者先审本轮 diff（重点：`auditScratchBase` / `copyReleaseWhitelist` / 原始路径判定 / 测试 fixture 落点），必要时退回继续修；不接受“未实跑就先冻结候选”；
2. 通过静态审核后，在**全新 UUID gate 自有根（不得复用 gate2）**重跑批准验证：`node --check` 3 个脚本；完整测试（静态计数 28 用例）；带完整前置的缺字体真实 CLI（预期 exit 2 / blocked / 保留输出与工作根，不得跳过）；完整 `install-start --require-packaged-tooling` 随包冷验收（两月 HTTP / 5 报表 / 备份恢复 / 重复启动）；W2 仍 `w2_contract_pending`；
3. 真实结果另行返回文档（不得预先写成已通过），再冻结候选 / PR / 自动合并（Refs #20 / #49，不误关总任务）；
4. W2 与共享窗口（engines / `test-all` / README / 索引）另行登记；
5. 先更新本交接再关闭本员工会话；下一包使用新进程、新会话。

本次安全隔离实现：每次 capture 自建独立所有权 fixture，复制 launcher / runtime / delivery 及需要的工具文件，默认 cwd 与默认 scratch 均归副本；所有 child 显式配置自有 TEMP / TMP / fallback data / scratch，业务数据参数只允许 suite 自有 fixture。非零、超时或未回收 child 的 fixture 保留并记录原因；无按 PID / name 扩大回收。默认根真实建根覆盖与显式空白 base 均在副本独立 child，真实卷根只经过与建根函数共用的纯预检，不触 FS。mixed-device 使用“两分隔符 + ? + 分隔符”；原 `?.` 名称另按非法 UNC host 拒绝。未增加删除入口：manifest v2 双向核对和唯一 rmSync 保持。缺字体 exit 2 / CSV-XLSX 可用、入口祖先 mkdir 前审核与 copy 再核验的原修复保持，尚待新门后的真实验收。

本次兜底实际只运行三项 `node --check`（均 exit 0）与 PowerShell Parser 静态解析（0 errors），未 dot-source / 执行 launcher，未跑字符串测试、Windows FS 负测、full、heavy 或冷验收，未清理任何目录。


## 2026-10-23 npm / Office 生命周期 P2 窄修（待独立验收）

本次按 Issue #59 已认领的窄范围，只改交付检查脚本、正式测试与本任务三份文档；runtime / PowerShell launcher 冻结只读，业务代码、依赖及 lock、共享 test-all 未改。主线仍为本机单用户多账套；冷业务源 e86 的边界不因本次修改改变，W2 真实升级仍 `w2_contract_pending`，未 PR / 未合并。

修前管理门对应旧七 SHA：pure 3、FS 7、runtime 7、service 5、remaining 6，共 28 个非 HEAVY 用例，均 exit 0 / skipped 0；这些是修前结果，不能充当当前新哈希通过。此前字符串 / PowerShell / junction 失败与旧候选被拒记录均保留，不被本段覆盖。

本次控制流：只有自有 child 的 `close` 才标记 `reclaimed=true`；未启动、timeout（即使 code 0 且已 close）、hard deadline、未回收或回收未知均立即终止，先留日志和失败事实，再抛阶段错误，不继续同目录安装 / 写业务产物 / 删除。npm 只在明确已回收且以 `npm error code ENOTCACHED`（兼容 `npm ERR!`）报告的离线缓存缺失时回退在线；网络 / 权限 / 完整性 / 参数错误均停止并保留。在线安装成功且确认回收后才允许 manifest 守卫删除本轮 node_modules，再离线重装；每一步异常都停止，后续成功不能覆盖前序失败。

Office helper 只写一次，留到全部渲染、探针、断言及必需 PDF 产物检查成功后，才经原 manifest 守卫删除；失败、timeout、未知回收及缺字体 blocked 均保留 helper / 模块 / 工作根 / 输出 / manifest。可选 Python 不存在（ENOENT 且无 pid）仍诚实 unavailable；其它生命周期异常立即失败，不能转为可选 skip。

本次实际验证（实施者执行）：`D:/node.exe --check scripts/windows-delivery-check.mjs` 与 `--check test/windows-delivery.test.mjs` 均 exit 0；定向 pattern `^(子进程生命周期：|依赖安装决策：|Office helper 生命周期：)` 实际 3/3、exit 0、skipped 0。三个纯用例驱动生产所用安装编排与成功清理门，覆盖各步骤 code 0 + 异常 flags、正常缓存缺失 / 命中、非缓存错误、清理拒绝，以及 online / remove / reinstall 的实际回调次数与顺序；未启动真实 npm 或服务，不创建或清理 fixture。原 29 项业务用例及其断言保留，现静态登记共 32 项；原用例本轮未重跑。

未测：真实超时回收 / spawnError 故障注入、Windows FS / 服务链、HEAVY 缺字体、full、npm 在线 / 离线冷验收、PDF 逐页视觉检查、干净 OS / 其它架构及 W2。须管理者在新哈希独立门与全新自有根验收后再决定后续，不以纯决策通过冒充完整交付。未触旧 fixture、系统 TEMP、真实账套或凭据；未按 PID / name 回收，未启动模型 / 子 agent。

旧事故事实继续有效：曾按通配删除 8 个目标，4 个可证本人、4 个归属与实际影响未知，不能据本次结果宣称零影响；原生异常 `3221226505` 根因仍未知；reviewer 自己的意外目录仍保留。上述事实不因当前纯测试通过而关闭。
