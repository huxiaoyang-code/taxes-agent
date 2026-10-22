# LOCAL-06-WINDOWS 交接

## 1. 基本信息

- 任务 ID / 状态：`LOCAL-06-WINDOWS` / **W1 受控管理验收已完成；待 Git 冻结候选与 root 随后另开窗口的新独审**（root 已授权本轮到冻结候选，本轮不追加必须重复的整套验收；未 PR、未合并）
- 负责人：`huxiaoyang-code`（已核实）
- 执行员工：本机 pi（新进程、无持久会话）；模型 `deepseek-v4.1-flash`（provider `tokenhub`），主 / 回退同锁；未使用子 agent；未执行 Git 写操作；**事故整改后的新会话**工具集不含 shell，未执行任何命令 / 测试 / 进程 / 清理；**验收由管理者实际执行**，员工只做实现与文档。事故前首轮员工确实执行过测试与清理（含越界删除，见 §8），两者不可混用
- 本机管理者：成员自己的 Codex（负责差异审查、独立复跑、Git 提交 / PR / 合并）
- 分支：`codex/huxiaoyang-code/local-06-windows-delivery`
- 关联 Issue：[#59](https://github.com/huxiaoyang-code/youshu-fork/issues/59)（`Refs #20` / `Refs #49`；审计兼容 #54，Office #45）
- 目标：源码分发方式的 Windows W1 交付（预检 / 启动 / 干净目录验收 / 备份恢复说明）
- 不做：MSI / 服务 / 自动更新器 / 机器 PATH / 注册表 / 执行策略 / 防火墙 / 全新 OS 验收 / W2 迁移

## 2. 基线与证据分层

- 基线（冷业务源）：`e86d248c2a573b12c884f311fb01952f209e2563`（PR #58 已合 main）
- 已审核 head / 合并 SHA：本包**未 PR、未合并**；本文档提交的实际 HEAD 以管理者交付记录为准（本文件不预测 SHA）
- 冷业务源：root 固定的 `e86d248…` 白名单归档（只含 `package.json` / `package-lock.json` / `server/` / `public/` / `local-backup` CLI）；51 个基线文件在复制前逐项用 Git blob 哈希与其 `ls-tree` 比对一致，源 / 目标祖先与全部条目无 junction，未带入 config / DB / `node_modules`
- 叠加层：本任务 4 个新 scripts / test 与 3 份文档共 7 个文件进入冷副本；随包工具来源 `release_cold_copy`（`optionalMissing=[]`），不用开发 worktree 脚本冒充
- 证据分层：
  - **管理者实跑（当前证据，见 §6）**：`node --check` 3/3；基础安全 pattern 7/7（此前误计 6，其余 12 不在该 pattern 内）；完整测试初次 18/19，定点修复 W2 临时目录断言后 19/19、0 skip；`install-start --require-packaged-tooling` 两次独立运行（run-a `--keep`、run-b 默认守卫清理）均 11 阶段 pass / 158 pass / 9 skip / 1 engine warning，依赖完全离线；run-b `cleanup.completed=true / manifestVerified=true` 且其精确根经管理者只读确认已不存在；W2 真实 `exit 2 / w2_contract_pending`；
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

本轮代码返修后只改这 3 份文档（状态 / 证据 / 结果 / 清理事实 / 下一步），4 个代码文件**未改动**（SHA 由管理者复核不变）。versioned 文档只用仓库相对路径与 `<release>/<data>` 占位符。

未修改：`server/*`、现有测试、`public/*`、MCP、银行 / 审计 / 备份 / 批量模块、`package.json`、`package-lock.json`、`scripts/test-all.mjs`、`06-workbench/README.md`、共享 `STATE` / 索引。

共享文件窗口（engines / `test-all` / README / 索引）**未获授权、未改动**；需 root 在现 owner 释放后另行登记。

## 5. 实现摘要与关键取舍

- **预检在 DB import 前**：只使用 `node:sqlite` + `node:fs` + `node:child_process`，不 import `db.mjs` / 业务模块。版本 / 平台 / 架构不合格时**先拒绝，不建任何目录写探针**。
- **可阻塞探针隔离**：sqlite（`isTransaction`、只读拒写、`busy_timeout`）与 fs 探测放在独立子进程，父进程用**真实 deadline**（`MAX_PROBE_MS`）强杀，超时给 `runtime_probe_timeout`；不再把 `MAX_PROBE_MS` 当“信息字段”。子进程内所有数据库 / 文件句柄都在 `finally` 关闭，早 return 不漏。
- **版本策略保守**：只放行 **24.15.0**；22.16 / 24.0 只是冻结源码 API 分析，24 其它 minor / patch（含 24.15.1）与 25+ 都拒绝并给 `runtime_version_not_qualified`。`runtime.qualified` 改为**版本 + 平台 + 架构三者合取**（`qualifiedScope` = 24.15.0 / win32 / x64），不再只绑 Node 版本。`package.json` 的 `>=22.5.0` 只作为警告 `engines_declaration_too_wide`，不改共享文件。
- **字体只报候选**：固定候选路径存在即 `candidate_present`，不称“已验证可嵌入 / 字形完整”；实际导出结果才是判据；不扫描用户字体目录。
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

## 7. 真实数据 / 安全边界

- 未触碰真实账套、真实凭据、真实税局 / 浏览器 / 旧会话；未读取用户字体目录 / 用户 npm 配置；
- 全部合成数据（Windows 交付合成公司，2026-01 / 2026-02，金额 50,000 / 11,300 / 10,000 / 1,300）；
- 网络仅用于锁文件声明的公共 registry 与官方文档；无私有 registry；lock 来源已加静态白名单校验；
- 所有服务 `127.0.0.1`，`PORT=0`；旧 8787 未探测 / 未复用；
- 子进程环境为白名单，未 dump env；日志只保留必要输出，不含凭据；
- 未修改业务模块、未自动安装审计组件、未添表、未关闭未知表校验。

## 8. 进程 / 清理事实

**员工侧（限事故整改后的新会话）**：本轮当前 pi 会话未执行任何命令、进程或删除操作，只改文件与文档；无新增临时目录、无新增残留进程。事故前首轮员工确实执行过测试与清理，见下面「首轮员工越界」。

**管理验收产生的目录**：均在 root 明确授权的**仓库 workspace 专属忽略目录**内（相对路径 `.agent-runs/local-06-windows-gate1`，位于仓库 workspace 的 ignored 根，**不是**独立 worktree 内的子目录；版本化文档不写其绝对路径），先核验祖先链再新建，各自带 manifest；脚本自身默认根仍是 `<workbench>/tmp/windows-delivery`，本轮未用该默认根做管理验收。run-a 按 `--keep` 保留其精确根；run-b 精确根由唯一删除守卫清理并核验（`completed=true / manifestVerified=true`，管理者独立只读确认已不存在）；`guard-scratch` / `test-scratch` / `test-scratch-r1` 为本次自建的 junction fixture（预期拒绝证据），保留不删。没有按前缀 / 通配 / TEMP 的删除，也不为“美观”清理早期残留。

**首轮员工越界（已停止，事实保留）**：该员工曾按 `$env:TEMP` 下 `wb-local06-*` 通配匹配递归删除，并递归统计过同前缀目录，删除前未逐项核验 manifest 所有权 / 绝对路径 / 重解析点；匹配到 8 个目标，其中 4 个可由 ignored 运行目录的结果 JSON（`destRoot` / `workbenchDir`）精确对应到其 run1–run4 失败临时根，另 4 个归属**未能核实**（0.00 MB 只是两位小数统计，不能推断为空 / 安全 / 自有）。因此可证明 4 个属于本人、4 个归属未知：既不能断言误删他人目录，也无法声称零影响。其进程随后被管理者按核实身份停止（非正常完成退出），7 个新增文件 WIP 原地保留、HEAD 仍为 `e86d248…`，未提交 / 推送 / PR / 合并。另有带通配符的 `wb-probe-*` 删除与若干手动清理，同样不满足“删除前精确目标核实”，已统一禁止。完整管理审计见仓库忽略的 `.agent-runs/local-06-windows-cleanup-audit.md`。

**代码 / 文档限制（已落地并被本次验收覆盖）**：临时写入只在 workspace 专属根（默认 `<workbench>/tmp/windows-delivery`，或显式 `--scratch-root` / `-ScratchRoot` 的授权绝对路径）；每根一份 manifest v2（逐项删除目标 + realpath）；mkdir 前与删除前核验完整祖先链 + realpath；禁止通配 / 前缀删除、禁止枚举或清理系统 TEMP、禁止用目录大小或名称推断归属；无法证明归属就保留并非零报告。这些守卫在本次 19 用例与两次冷验收中实际执行过（含 junction 拒绝回归）。

**两类未知要分开**：该越界行为本身是**已知**的（未确权即按通配递归删除）；但其 4 个目标的**归属与是否已造成实际影响仍未知 / 未证实**；而 Issue #49 的一次原生异常（`3221226505`）的**崩溃根因才是未定位**。三者不因本次测试全绿而消除；如需复盘由 root 另行安排，不在本交接扩写。

## 9. 未完成 / 未验证

已完成（管理者实跑，见 §6）：语法检查；基础守卫 pattern 7/7；完整 19 用例（初次 18/19 定点修复后 19/19、0 skip）；两次独立 `install-start --require-packaged-tooling` 冷验收（含随包工具形态、完全离线依赖、11 阶段 pass）；PDF 5 份 7 页逐页目视；W2 负验收（`w2_contract_pending`，无业务副作用）。

仍未完成：

1. **Git 冻结 7 文件候选与 root 随后另开窗口的新独审（fresh、nonefork）**；root 已授权本轮到冻结候选，本轮不追加必须重复的全套验收；本包未 PR、未合并；文档提交的实际 HEAD 以管理者交付记录为准；
2. 正式安装器 / 完整离线发行 bundle、干净 OS、其它架构、旧 Node 二进制（本轮无旧二进制，`skipped.old_node_binary`）；22.16 / 24.0 只是 API 分析，不是实测支持；
3. `package.json` engines 声明（仍 `>=22.5.0`）与 `test-all` 挂载、README / STATE / 索引更新，需共享 owner 窗口授权；
4. HTTP / 页面 XLSX / PDF 接线（仍 `400 report_format_unsupported`）；脚本自身无读图能力，人眼结论始终由人做；
5. W2：core v4 的 v3→v4 迁移 / 恢复、02 冻结 backup 新版本、03、银行、审计 B–C、批量最终契约集成；每种组合需上游提交与精确 schema 契约，**真实升级尚未完成**；
6. 阶段预算是**耗时后验**，不是中途硬总时限（无总进程 watchdog）；该局限保留，是否加强由管理者 / root 评估；
7. Issue #49 原生异常（`3221226505`）原因仍未知；本次受控运行未见同码，不声明已修复 / 无关；
8. 本轮不要求机械重复第三次全套验收；后续**若 root 安排正式发行候选 / 整合变更**，可再用 `git archive` 产物随包重新验收；本轮受控冷拷贝 + 精确哈希形态已验，因此该项**不是本轮尚欠的必做**，不自行追加重复全套测试。

## 10. 下一步

1. 管理者按交付记录给出本次文档提交的实际 HEAD，确认 4 个代码文件 SHA 未变后冻结 7 文件候选（root 已授权本轮到冻结候选，不再额外追加必须重复的验收）；
2. root 随后另开窗口做 fresh 独审（nonefork）审查该候选；通过后再 PR / 自动合并（Refs #20 / #49，不误关总任务）；
3. 后续**若 root 安排正式发行候选 / 整合变更**，才用 `git archive` 出包含新 scripts / test / docs 的产物重跑“随包完整”形态（本次为受控源文件冷拷贝 + 精确哈希核实，仍不是正式发行包）；本轮不以该重跑为前置；
4. W2 与共享窗口（engines / `test-all` / README / 索引）另行登记；
5. 先更新本交接再关闭本员工会话；下一包使用新进程、新会话。
