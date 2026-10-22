# Windows 源码交付：安装、启动、备份与验收（W1）

> 本文对应任务 [LOCAL-06-WINDOWS](tasks/LOCAL-06-WINDOWS.md)，当前交付的是**源码分发方式的 W1**：运行时预检、显式数据目录启动、干净目录验收脚本、备份 / 恢复说明。
>
> **当前状态**：W1 受控管理验收已完成（实际运行结果见 §11），待 Git 冻结候选与 root 安排的新独审；**未 PR、未合并**。用户可照做的安装 / 启动 / 备份步骤见 §2–§8。
>
> **不是** MSI / 服务 / 自动更新器 / 完整离线安装包；**没有**修改机器 PATH、注册表、执行策略或防火墙；**不是** Windows 全新系统安装验收，也不能写成「Windows 全新系统安装已通过」。
>
> **本次只对 Node 24.15.0（Windows x64）做过完整验收。** 预检只放行 24.15.0；24.15 分支的其它 patch（例如 24.15.1）同样**未实测**，不会被自动放行。仓库 `package.json` 当前声明 `"node": ">=22.5.0"`，该范围**偏宽**：冻结源码使用的 `node:sqlite` 无 flag 导入、`readOnly`、`busy_timeout` / `timeout`、`db.isTransaction` 等 API 至少要 22.16 / 24.0 一代才齐全（这是**API 分析**，不是实测），而本包没有 22 分支的真实二进制验收。共享文件 `package.json` 不在本任务写入范围，未改声明；预检会**明确拒绝**未验版本并指出声明偏宽。

## 1. 适用范围

支持本次已验的形态：

- Windows 11 x64（本次实机 Windows 11 家庭版中文版，10.0.26200）；
- Node **24.15.0**、npm 11.12.1（npm 版本只作记录，不单独作为支持承诺）；
- 从源码目录运行现有 `06-workbench` 服务；
- 一名本机操作者、多家企业、每家一个账套（多企业批量 = 多个数据目录 / 账套，不是多租户）。

不承诺：

- Node 22 / 23 / 24 其它小版本 / 25+；其它 CPU 架构；全新操作系统；无 Node 的机器；
- 自带全部依赖的离线安装包（离线能力是**验收方法**，不是随包分发的依赖集合）；
- HTTP / 页面直接下载 XLSX / PDF（见 §9）；
- core v4 / v3→v4 迁移、LOCAL03、银行、批量新表、完整审计组件兼容（见 §12）。

## 2. 目录与数据位置

建议把「发布目录」和「数据目录」分开：

```text
<release>/                      # 只读的源码发布目录（例如解压 / 冷拷贝得到）
  06-workbench/
    package.json
    package-lock.json
    server/
    public/
    scripts/
    test/
<data>/                         # 显式数据目录（不要放在发布目录里）
  workbench.db
  workbench.db-wal
  workbench.db-shm
  *.pre-v3-*.bak                # 迁移前自动备份（如发生升级）
<backups>/                      # 本机备份目录（由 local-backup 生成）
```

- 服务只使用显式传入的 `WORKBENCH_DATA_DIR`；没有传时旧代码会回退到 `06-workbench/data`，**交付脚本不会**默认读该目录。
- 一家企业一个账套。切换企业 = 切换数据目录 / 账套，不是在同一账套里建 `bookKey`。
- 不要在服务运行时只复制 `workbench.db` 主文件：WAL 中已提交数据会丢。使用 §7 的备份命令。

### 2.1 临时目录与清理边界

预检、验收脚本与测试**都不使用系统 `TEMP` 作为可删根**，也不扫描 / 通配删除用户目录：

- 默认在 `<release>\06-workbench\tmp\windows-delivery` 下新建随机**新**目录（`tmp/` 已在 `.gitignore` 中忽略）；
- 发布目录只读时，用 `--scratch-root <绝对路径>`（启动脚本为 `-ScratchRoot`）显式指定：必须是调用者**显式授权、专用于本次任务**的目录，且**原始入参**先按绝对路径校验（不是 `resolve()` 之后再查）；
- 创建顺序：最近已存在祖先**逐级核验到卷根**（任一级是 symlink / junction / reparse point 就拒绝）→ 才 `mkdir` → 创建后再核验完整祖先链与 realpath 等于预期规范化路径；删除前重验同一链；未确认的路径不写、不枚举、不删；
- 每个根创建时写入 `.wb-scratch-<token>.json` manifest（v2）：精确绝对路径、随机运行 token、任务标识，以及**逐项登记删除目标与其 realpath**；内存记录与 manifest 双向互校（数量一致、双向包含、realpath 一致）；
- 读 / 写 manifest **之前**先核验路径本身：必须正好是内存记录推出的 `<root>/.wb-scratch-<token>.json`、在内存固定 root 与 rootReal 内、root 到卷根的完整祖先链可核验、已存在时是普通文件且不是 symlink / junction、realpath 与预期一致；核验不过直接拒绝（`manifestVerified=false`），**不会先把目标文件读进来再判断**；
- 写 manifest 用临时文件**独占创建**（`wx`：不覆盖已有 `.writing-<token>` 文件、不跟随其链接）+ rename；既有 manifest 只在确认它仍是本次运行写过的、root 内的普通文件时才更新，磁盘上损坏 / 篡改的 manifest 不会被覆盖成有效授权；
- 创建专属根**中途失败不做抢救式回滚**：已创建的部分原样保留，返回 `attempted:false / completed:false / retained:true` 与原因；不在已判不安全的路径写 manifest、不扫描、不删除；正常成功返回的 record 仍走下面的统一守卫清理；
- 祖先链核验**只在真的走到卷根时**才算通过；深度耗尽给 `path_too_deep` 拒绝，不把「没核验完」当成 ok；
- 删除只有一个入口（脚本与测试 import 同一份守卫）：目标已登记、规范化绝对路径在专属根内、realpath 与登记值一致、完整祖先链与内部项都不是 symlink / junction / reparse point；成功后才刷新剩余登记；
- 不从磁盘 manifest 导入任何删除目标：manifest 缺失 / 破坏 / 多出未登记目标一律拒绝；
- 任何不确定（未登记、路径越界、重解析点、删不掉）→ **保留目录**并以非零状态报告 `cleanup_refused` / `cleanup_failed`，不使用 best-effort 吞错后报成功；
- `cleanup.manifestVerified` 只反映**实际核验结果**：没尝试删除 / `--keep` / 失败保留时一律为 `false`；
- 名称、随机前缀、目录大小都**不是**所有权证明；`base` 本身从不被删除，也不去枚举 base 下其它目录（或读它们的 manifest）来推断“整个 base 归我”；
- 失败残留保留供诊断，**不要**改用扫 `TEMP` / 通配删除 / 目录名前缀来“补清理”。脚本默认根仍是 `<workbench>\tmp\windows-delivery`；本机管理验收改用 root 明确授权的**仓库 workspace 专属忽略目录**（相对路径 `.agent-runs/local-06-windows-gate1`，属于仓库 workspace 的 ignored 根，不是独立 worktree 内的子目录）：先核验祖先链、再新建目录并写入本次 manifest。版本化文档不记录该目录的本机绝对路径。

同一规则适用于脚本内部的重装依赖（删 `node_modules`）、Office 辅助脚本、异常路径等**每一处**删除。

## 3. 安装（用户执行）

1. 安装 Node 24.15.0（x64）。本包**不自动下载或安装 Node**。
2. 取得源码发布目录（管理者按固定提交导出，不含 `.git`、`node_modules`、`data`、`.env*`、`.npmrc`、账套库、日志、profile）。
3. 在 `06-workbench` 下安装锁定依赖：

```powershell
cd <release>\06-workbench
npm ci --ignore-scripts --no-audit --no-fund
```

依赖版本由 `package-lock.json` 固定：`exceljs@4.4.0`、`pdfkit@0.20.2` 及其传递依赖。不要用全局 `node_modules` 代替；不要提交 `node_modules`。

> `install-start` 自动验收的离线验证使用**本任务专属 npm 缓存**：先尝试 `npm ci --offline`，缓存不足时才从锁文件声明的公共 registry 下载到该缓存，再删除 `node_modules` 并用同一缓存重新 `--offline` 安装。这条证据**不等于**发布包自带全部依赖，也不代表普通用户不需要联网安装一次。

## 4. 运行时预检

启动前先跑（只读探测 + 自建临时目录，不加载业务数据库）：

```powershell
cd <release>\06-workbench
node scripts\windows-runtime-check.mjs --json
node scripts\windows-runtime-check.mjs --json --data-dir <data>
```

检查内容：

- Node 版本是否为已验的 **24.15.0**（其它版本拒绝）；架构只放行本次实测的 **Windows x64**（arm64 未实测，同样拒绝）。`runtime.qualified` 是**版本 + 平台 + 架构三者同时满足**本次实测组合的结论（`runtime.qualifiedScope` / `qualifiedBasis`），不是“API 可能可用”或“版本号更大”；
- **版本 / 平台 / 架构不合格时先拒绝**，拒绝发生在任何目录写探针之前；
- `node:sqlite` 可无额外 flag 导入；`db.isTransaction` 在 `BEGIN` / `COMMIT` 前后正确；
- 真正只读连接拒绝写入，且源文件哈希不变；
- `timeout` / `PRAGMA busy_timeout` 有界失败（不会无限等锁）；
- 必要的 `fs` 能力（mkdir / realpath / read / write / fsync / rename / copyFile / rm）：子进程**只创建**探针文件并报回精确路径，`rm` 由父进程用专属根守卫对已登记文件执行（`limits.fsRmVerifiedThroughGuard`）；
- 可阻塞的 sqlite / fs 探针在**独立子进程**里执行，父进程用真实 deadline 强杀并回收；超时给 `runtime_probe_timeout`，不是只写在输出里的信息字段；被 deadline 杀死的残留只能由确权父根清理，清不掉就明确保留（`cleanup.retained=true`）而不是声称已清理；
- 显式数据目录（如提供）只做**只读**检查：存在时必须是目录、不是重解析点、祖先链可核验且可写；不存在时检查最近存在的父目录；**不创建目录、不写探针文件、不删任何文件**（`dataDir.writeProbe=not_performed`）。真正的写 / 删能力在下面 §9 的自有 scratch 真实 HTTP 验收里证明；
- PDF 中文字体：只检查模块固定候选（`simsun.ttc` / `simhei.ttf` / `Deng.ttf` 与显式 `REPORT_PDF_FONT`）**是否存在**（`candidate_present`），**不扫描用户字体目录**、不等于已验证可嵌入或字形完整（实际导出结果才是判据）；缺字体只报告 `pdf_font_unavailable`，不阻止纯 CSV 功能；
- `package.json` 的 Node 声明是否偏宽（当前会提示 `engines_declaration_too_wide`）。

临时根：默认 `<release>\06-workbench\tmp\windows-delivery`，或用 `--scratch-root <显式授权的绝对路径>`；清理在 `finally` 里执行，失败返回非零（`cleanup_refused` / `cleanup_failed`），不会「ok 但没清掉」。

退出码：`0` 可用；`1` 用法错误；`2` 明确拒绝（含清理失败）；`3` 预检自身内部错误。拒绝发生在数据目录创建 / 迁移之前。

输出只含白名单字段（版本 / 平台 / 架构 / 检查状态 / 稳定错误码 / 字体候选文件名 / 是否清理），不含环境变量、用户名、绝对路径或账务数据。

## 5. 启动与停止

推荐（Windows PowerShell 5.1 与 PowerShell 7 均可；脚本不要求 pwsh 7）：

```powershell
cd <release>\06-workbench
powershell -NoProfile -File scripts\windows-start.ps1 `
  -NodePath <node.exe> `
  -DataDir <data> `
  -Port 0
```

- `HOST` 固定为 `127.0.0.1`，不提供对外监听选项。
- `-Port 0` 让系统分配空闲回环端口；以本次进程 stdout 打印的 `http://127.0.0.1:<实际端口>/` 为准。**不要假定 8787，也不要连接既有 8787 服务。**
- 脚本会在 stdout 打印一行 `windows_start_service_pid=<pid>`：这是它自己创建的服务进程 id，**仅作诊断信息**。**外部强制终止包装器可能遗留该进程**；这种情况下任何手动停止都必须重新核实该进程当前的可执行路径 / 命令行、创建时间等是否仍与本次启动记录一致，身份无法确认就**保留现场并只报告**——不按该 pid 推断权限、不按 pid / 进程名批量操作、直接强杀也不行。脚本正常结束、`-MaxRunSeconds` 到期与异常路径都只用脚本**自有的 Process 句柄**停止该进程，不用 `Stop-Process -Id` / 进程名；停不掉时报 `service_stop_failed` + `windows_start_residual_service_pid=<pid>` 并退出 `3`。
- `-Help`（或 `Get-Help .\windows-start.ps1`）只打印用法并退出 0，不启动服务。
- 脚本先运行 §4 预检；预检作为**有界子进程**执行（默认 30 秒上限）：超时给 `runtime_check_timeout`（退出 `2`），已强杀但仍未回收给 `runtime_check_not_stopped`（退出 `3`）并额外打印 `windows_start_residual_precheck_pid=<pid>`；预检拒绝时退出码为 `2`，且不会创建数据库。
- 预检的探针目录默认在 `<release>\06-workbench\tmp\windows-delivery`；发布目录只读时用 `-ScratchRoot <显式授权的绝对路径>`。
- 前台运行，服务退出码原样传播；按 `Ctrl+C` 停止。普通前台服务**没有总运行时长上限**。脚本不修改机器 PATH / 注册表 / 执行策略 / 防火墙。
- `-MaxRunSeconds N` 仅是验收用的有界自停参数（到点只停止本脚本创建的进程并退出 `124`）。停止后会核验该进程确实退出；仍然存活时报 `service_stop_failed` 并退出 `3`，不会假报已停止。

若组织策略禁止执行本地 `.ps1`，**不要绕过执行策略**，改用等价手动步骤：

```powershell
$env:HOST = "127.0.0.1"
$env:PORT = "0"
$env:WORKBENCH_DATA_DIR = "<data>"
& "<node.exe>" "<release>\06-workbench\server\server.mjs"
```

停止：在前台窗口按 `Ctrl+C`；确认退出后，下次启动同一 `<data>` 会恢复 WAL 中已提交数据。

## 6. 数据位置与切换

- 启动时显式 `-DataDir <data>`（或 `WORKBENCH_DATA_DIR`）。
- 换一家企业：先停止当前服务，使用另一个**不存在或已有对应账套**的数据目录启动。不要把两家企业指向同一目录。
- 不建议手工编辑数据库、删除 `-wal` / `-shm` 或直接改 `schema_migrations`。
- 发布目录只读；升级时新建发布目录，数据目录保持不变，先备份再切换。

## 7. 备份、恢复与回退

运行中（WAL 有已提交数据）也可以备份；工具用真正只读连接 + `VACUUM INTO` 生成单文件一致快照，不复制主库、不删 WAL。

```powershell
cd <release>\06-workbench

# 1) 备份到全新目录（目标必须不存在）
node scripts\local-backup.mjs backup --db <data>\workbench.db --out <backups>\<新备份目录>

# 2) 验证清单 / 快照 / 结构 / 内容摘要
node scripts\local-backup.mjs verify --backup <backups>\<新备份目录>

# 3) 恢复到一个全新目录（已有空目录也会被拒绝）
node scripts\local-backup.mjs restore-new --backup <backups>\<新备份目录> --target <data-restored>
```

退出码：`0` 成功；`1` 用法错误；`2` 明确拒绝（数据 / 清单 / 目标不合格）；`3` 内部失败。

注意：

- `restore-new` 只写**全新目录**；不会就地覆盖现库，也不会删除 WAL。
- 损坏清单 / 损坏快照 / 未知 schema / 已存在目标都会被拒绝；原数据与目标 sentinel 不变。
- 当前只支持已合 main 的 schema v3；未知组件表会被安全拒绝。**不要**通过过滤表或改版本号制造「兼容」备份。
- **回退只能回到备份时点。** 备份之后新增的账务不会自动合并；不暗示能无损降级新 schema。回退前先保护现库 / 停写，恢复后逐项核对金额、批次与来源。
- 恢复后必须用**对应发布版本**启动并核对；不要把恢复出来的新目录当成已经完成迁移。

## 8. 报表导出与 Office 文件

- 当前 HTTP 只支持 CSV：

```text
GET /api/account-sets/<id>/reports/<kind>/export?period=YYYY-MM[&code=1002]
GET /api/account-sets/<id>/reports/<kind>/export-data?period=YYYY-MM[&code=1002]
```

`kind`：`balance-sheet` / `income-statement` / `cash-flow-statement` / `trial-balance` / `ledger`（ledger 必须给 `code`）。

- **XLSX / PDF 目前没有 HTTP 或页面下载接线。** HTTP 传 `format=xlsx|pdf` 会得到 `400 report_format_unsupported`。纯模块 `server/report-office-export.mjs` 可由内部程序用同一报表 DTO 调用，但这不是已接线的用户下载功能，也不能据此宣称页面可下载 Office 文件。
- 中文 PDF 需要可嵌入字体。可用显式环境变量：

```powershell
$env:REPORT_PDF_FONT = "<中文字体文件>"
$env:REPORT_PDF_FONT_FAMILY = "<TTC 集合中的字体族，可选>"
```

  缺字体给 `pdf_font_unavailable`（稳定错误码），CSV 仍可用；字体文件不复制进 Git。
- 报表是**内部报表**，不是税局申报模板；数据完整性未核实，`taxFilingReady` 为 false。

## 9. 交付验收（开发 / 管理者复跑）

在 `06-workbench` 下：

```powershell
# 失败路径与关键成功链
node test\windows-delivery.test.mjs

# 干净冷拷贝 + 依赖 + 启动 + 真实 HTTP 导入 / 报表 / Office + 备份恢复 + 稳定性
node scripts\windows-delivery-check.mjs --phase install-start `
  --release <冷拷贝根> --node <node.exe> --npm <npm-cli.js> `
  --cache <本任务专属 npm 缓存> --out <新的输出目录> `
  [--scratch-root <显式授权的绝对路径>] [--require-packaged-tooling]

# W1 下恒为 blocked（w2_contract_pending）：不建业务 DB、不迁移、不安装依赖
node scripts\windows-delivery-check.mjs --phase upgrade-rollback `
  --release <发布根> --out <新的输出目录>
```

- `--npm` 的解析规则（`resolveNpm`）：传 `.js` / `.mjs` 入口时直接用 `node` 运行；传其它入口（本次实际传的是 `npm.cmd`）时，检查其同目录下 `node_modules/npm/bin/npm-cli.js` 是否为普通文件，存在就用该 JS 路径运行，找不到才以 `npm_cli_not_verified` 拒绝。**任何情况下都不执行 `.cmd` / `.bat`、不拼 `cmd.exe` 命令行**；因此最稳妥的做法是直接把 `npm-cli.js` 路径传进来。
- 不带 `--scratch-root` 时，临时根在本脚本所属 workbench 的 `tmp/windows-delivery` 下；显式传入时必须是调用者授权、专用于本次任务的**绝对路径**（原始入参先校验绝对路径），守卫会先把祖先链核验到卷根才建目录。
- `--require-packaged-tooling`：最终“随包完整”形态验收用。冷拷贝里缺 W1 的 windows 脚本 / 测试时直接 fail（`packaged_tooling_incomplete`），不允许用开发 worktree 脚本冒充随包；不带该参数时，缺失会显式记录为 `external_tooling` / `partial_release_tooling` 阶段证据。
- 发布清洁度扫描只跳过**明确已知**的专属 scratch 绝对路径（`<release>\06-workbench\tmp\windows-delivery` 与本次运行刚创建的根），不再扫描其它现存 run 的 manifest 来推断“整个 base 归我”；其它 `tmp` 内容仍按 forbidden 拒绝。
- `node test\windows-delivery.test.mjs` 默认在 `<workbench>\tmp\windows-delivery` 建临时根；需换到别的路径时设 `WINDOWS_DELIVERY_SCRATCH_ROOT=<显式授权的绝对路径>`（测试 fixture 也只在这个专属根内新建）。**junction 拒绝回归会故意保留**它自建的 fixture（`junction-target` / `junction-link` / `junction-work` 等）作为预期拒绝证据：它们不进通用的“全清”断言，也不是清理失败；不要用 unlink / 手工删除去“美化”结果。

`install-start` 实际运行 11 个阶段：preflight / runtime / dependencies / startup / import / reports / restart / office / failure-paths / backup-restore / stability。每个阶段有一个**耗时后验上限**：`fn` 结束后才比对实际耗时，超出即按失败处理；它**不是中途硬 deadline**，不会中断正在执行的阶段。真正能中途生效的是每个子进程的 `timeoutMs` + 强杀宽限、每个 HTTP 的 `AbortSignal.timeout`、隔离子进程探针的 `MAX_PROBE_MS`；本包**没有**总进程 watchdog，这一点由管理者 / root 另行评估。它做的是：

- 按白名单从 `<release>` 冷拷贝到专属随机根，不复制 `.git` / `node_modules` / `data` / 私有配置 / DB / 日志；
- 先静态校验冻结 lock 的**来源与完整性**：只允许 `https://registry.npmjs.org/` 与 `https://registry.npmmirror.com/` 的 HTTPS `resolved`，拒绝 `file:` / `git` / 私有域 / 带凭据 URL / 缺 integrity；**不把 `npm_config_registry` 当成能约束 lock URL 的保证**（本包因此不设该变量）；
- `npm ci` 使用固定 lock；lock 哈希前后一致；空 user / global npmrc + 白名单环境 + `--ignore-scripts --no-audit --no-fund`；依赖可被真实渲染模块加载（exceljs 4.4.0 / pdfkit 0.20.2）；
- `HOST=127.0.0.1`、`PORT=0`，从本次 stdout 解析端口；新数据目录建库，`/api/account-sets` 为 `[]`，首页 / JS / CSS 可取；
- 真实 HTTP 增量导入：默认 dryRun 不落库 → 正式落库 → 同批重试幂等 → 次月追加仍同账套 → 重启后仍识别批次 / 来源；
- 独立金额：1 月银行 50,000、应收 11,300、收入 10,000；2 月银行 61,300、应收 0、收入本期 0 / 累计 10,000；
- 五类报表 CSV + DTO；`ledger` 明确 `code=1002`；同一 DTO 调纯模块生成 XLSX / PDF，重开 XLSX 查数值；PDF 提取中文 / 金额 / 页数，并在可选 PyMuPDF 可用时**逐页**渲染 PNG（缺工具则诚实 skip，不用首页冒充全页）；HTTP XLSX / PDF 明确未接线；
- 缺字体独立报告；端口冲突用本包自建 listener，且不误连占位服务；非法数据目录在启动前拒绝；
- 运行中一致备份 → verify → restore-new 到新目录 → 对应发布启动核对金额 / 批次 / 来源 / 外键 / 幂等；损坏快照 / 清单、未知 schema、已存在目标各自拒绝；
- 顺序 10 次新进程启停 + 最多 2 个并行进程（各自数据目录 / 端口）串账为 0。并行阶段用 `Promise.allSettled` 收齐两台的结果：**任一台启动失败都先回收已成功启动的另一台自有句柄，再如实报失败**，不把服务留在后台；本阶段自己启动的句柄也在 `finally` 里收尾。

退出码：`0` 全过；`1` 用法错误；`2` blocked（W2 契约未就绪 / 前置条件）；`3` 任一阶段 fail，或任一 `fail` 断言 / 未回收子进程 / 清理失败。**首个失败不会被后续成功覆盖。** 结果写入 `<out>\windows-delivery-result.json`，子进程原始输出只写 `<out>\logs\`（stdout / stderr 各自上限 1 MiB），阶段含序号、开始 / 结束、耗时 / 预算、pid（仅本机）、退出码 / signal。

自动验收**不能**代表：

- 旧 Node 二进制真实运行（本轮无可用旧二进制，`skipped.old_node_binary`）；
- 其它架构 / 全新 OS / 完整离线包（均有 skipped 标记）；
- 人眼 PDF 目视（`office.pdf.*.visual_inspection` 仍为 `skipped`：脚本只能逐页导出 PNG，没有读图能力；本次验收的目视结论由管理者独立查看补充，见 §11.2，结果 JSON 未被改写）；
- 真实税局 / 浏览器 / 凭据 / 真实账套（全部合成数据，`tax` 请求 0）。

## 10. 故障排查

| 现象 / 稳定码 | 处理 |
|---|---|
| `runtime_version_not_qualified` / `runtime_arch_unsupported` | 当前 Node 不是已验的 24.15.0，或不是已验的 Windows x64；换成已验组合或等待后续版本验收。不要仅因版本号更大 / 架构看起来兼容就当已支持。 |
| `engines_declaration_too_wide` | 仓库声明仍为 `>=22.5.0`；以预检结论为准，勿把声明当支持承诺。 |
| `data_dir_not_directory` / `data_dir_not_writable` / `data_dir_is_reparse_point` / `data_dir_ancestor_refused` | 显式数据目录被文件 / 重解析点占用、不可写，或祖先链核验不过；换目录 / 修权限。预检不会创建目录，也不在数据目录里写删探针（`dataDir.writeProbe=not_performed`）。 |
| `EADDRINUSE` / 启动即退出 | 端口被占用；用 `-Port 0` 或换端口。不要连接占位服务。 |
| `pdf_font_unavailable` | 设 `REPORT_PDF_FONT` 指向可嵌入中文字体；CSV 不受影响。 |
| `dependency_cache_missing` | 本任务离线缓存缺项；按授权来源补齐缓存，或按 §3 联网安装一次。不要从已有 `node_modules` 复制冒充安装。 |
| `out_exists` / `target_exists` / `schema_unsupported` / `snapshot_*` / `manifest_*` | 严格拒绝，按提示换新目录 / 换对应版本；不要改库或过滤表。 |
| `scratch_root_not_absolute` / `scratch_root_is_filesystem_root` / `scratch_root_ancestor_refused` / `scratch_root_verification_failed` | 专属临时根参数不合格：不是绝对路径、指向卷根、祖先链里有 symlink / junction、或创建后 realpath 与预期不符。换一个显式授权的工作区内绝对路径；不要绕过守卫去手建目录。 |
| `scratch_root_unavailable` / `scratch_root_not_directory` | 预检 / 验收的专属临时根建不了（发布目录只读等）或被文件占用；用 `--scratch-root` / `-ScratchRoot` 指定显式授权的绝对路径。 |
| `runtime_probe_timeout` | 隔离探针超过真实 deadline 被杀；先排查系统锁 / 杀软，不要靠调大超时掩盖。残留只能由确权父根处理，清不掉时 `cleanup.retained=true` 且非零。 |
| `runtime_check_timeout` / `runtime_check_not_stopped` | 启动脚本的有界预检超时 / 已强杀但仍未回收；退出码 `2` / `3`，后者同时打印 `windows_start_residual_precheck_pid=`，不要假报已就绪。 |
| `service_stop_failed` / `windows_start_residual_service_pid=` | 包装器只用自有 Process 句柄停服务，停不掉就报残留并退出 `3`；该 pid 仅作诊断，需要人工停止时必须先重新核实其可执行路径 / 命令行、创建时间等仍与本次启动记录一致，身份确认不了就保留现场并只报告，**不要**按进程名全杀，也不按 pid 批量强杀。 |
| `service_identity_unverified` | 验收脚本**不用裸 PID 停服务**：包装器没在有界宽限内自行停掉服务时，只回收自有的包装器句柄，把服务记为未核实残留、保留目录并让结果非零，由管理者定点核验。“`/api/account-sets` 还能返回 JSON” 不能证明该 PID 就属于该端口 / 该创建实例，因此不存在“PID 身份验证后裸杀”这个兜底。 |
| `path_too_deep` | 祖先链超过固定深度仍没走到卷根：按拒绝处理，不要当成已核验通过，也不要绕过守卫改路径。 |
| `cleanup_refused` / `cleanup_failed` | 删除前核验不通过或删不掉：目录被保留，按 manifest 与提示人工处理；不要改用扫 TEMP / 通配删除 / 目录名前缀“补清理”。 `cleanup.manifestVerified=false` 表示本次没有完成 manifest 核验（未尝试 / `--keep` / 失败保留）。 |
| `w2_contract_pending` | W1 的 `upgrade-rollback` 恒为 blocked（exit 2）；需要上游版本契约与已登记配对后才另行交付。 |
| `npm_cli_not_verified` / `lock_source_not_allowed` | `--npm` 优先直接给已验证的 `npm-cli.js`（`.js` / `.mjs` 用 `node` 运行）；给的是其它入口时脚本会找其同目录 `node_modules/npm/bin/npm-cli.js`，找不到才拒绝，且从不执行 `.cmd` / `.bat`、不拼 `cmd.exe`。lock 来源必须在公共 registry 白名单内且有 integrity。 |
| 原生异常 / 进程崩溃 | 保留首次失败输出与阶段序号；不要按 `node.exe` 名称全杀，也不要装调试器 / 开全局转储。Issue #49 曾见一次无完整堆栈的 `3221226505`，原因**未定位**；零复现不代表已修复。 |

## 11. 本次 W1 受控验收证据与未完成项

实际环境：Windows 11 10.0.26200 x64（一台主机）；Node v24.15.0；npm 11.12.1；冷业务源基线 `e86d248c2a573b12c884f311fb01952f209e2563`。

**执行者**：以下结果由**本机管理者**实际执行。**事故整改后的新 pi 会话**只做实现与文档修改，工具集不含 shell，**没有**执行命令 / 测试 / 进程 / 清理；这段「员工未执行」只描述整改后的新会话——事故前的首轮员工确实执行过测试与清理（含越界删除，见 §11.4 与交接 §8），不能用它覆盖历史。本节结果不得读成「员工自测通过」。

### 11.1 冷源与包组成

- 冷业务源为 root 固定的 `e86d248…` 归档，只含 `package.json` / `package-lock.json` / `server/` / `public/` / `local-backup` CLI；51 个基线文件在复制前逐项用 Git blob 哈希与其 `ls-tree` 比对一致，源 / 目标祖先与全部条目无 junction，未带入 config / DB / `node_modules`；
- 本任务的 4 个新 scripts / test 与 3 份文档作为叠加层（共 7 个文件）进入冷副本，随包工具来源为 `release_cold_copy`（`optionalMissing=[]`），不用开发 worktree 脚本冒充；
- 这是**受控源文件冷拷贝 + 精确哈希核实**，不是正式安装器发行包，也不是新 OS 实测。

### 11.2 实际运行结果

- 语法：3 个 `node --check` 全部通过。
- 基础安全 pattern：按批准命令实际选中 7 个纯守卫用例（此前误计为 6），**7/7 通过**；其余 12 个用例不在该 pattern 内（不能写成 6/6，也不是 13 skip）。
- 完整测试套件（19 用例）：初次 `18/19`，唯一失败是 W2 用例的临时目录期望断言（首轮循环提前预期了第二次 `out` 目录）；只对该断言定点修复后，在全新 test scratch 复跑 **19/19 通过、0 skip**。初次失败的结果、stdout / stderr 与退出码保留，不被后续通过覆盖。
- 完整冷验收 `install-start --require-packaged-tooling`，两次独立运行：
  - run-a（`--keep`）：11 阶段全部 pass，158 条通过断言 / 9 条明确 skip / 1 条 engine warning；精确根保留，未额外清理；
  - run-b（默认守卫清理）：同样 11 阶段 pass / 158 pass / 9 skip / 1 warn，`cleanup.attempted=true / completed=true / manifestVerified=true / retained=false`；管理者独立只读确认该次精确根已不存在；
  - 两次的依赖安装**完全离线**（`networkUsed=false`、`offlineProven=true`）；这不等于发布包自带全部依赖。
- 两次运行都以 root 明确授权的**仓库 workspace 专属忽略目录**（相对路径 `.agent-runs/local-06-windows-gate1`，位于仓库 workspace 的 ignored 根，不是独立 worktree 子目录）作为专属根 / 输出根：先核验祖先链与目标位置不存在 → 新建该专属目录 → 再写入该目录内本次 manifest；版本化文档不记录其本机绝对路径。脚本自身默认根仍是 `<workbench>\tmp\windows-delivery`。
- 11 阶段包含真实 HTTP 启动、两月增量合成导入 / 重试 / 报表、重启、Office、非法目录与端口冲突、运行中 backup / verify / restore-new / 回退旧程序副本、10 次顺序启动 + 2 个独立 data 并行。
- 5 份 PDF 共 7 页（资产负债 1 / 利润 1 / 现金流 1 / 明细账 1 / 科目余额 3）：管理者用 Poppler 计页后逐页渲染 PNG 并**实际查看全部 7 页**，中文 / 金额 / 表格 / 跨页续表表头 / 页脚均可读，无截断 / 重叠 / 方块字；银行期末 61,300、利润当期 0 / 累计 10,000、余额表借贷 61,300（合成样本）。该次运行的 `artifacts/office/` 下留有 PDF 哈希与 7 张 PNG 清单。
- W2 负验收：`--phase upgrade-rollback` 真实 CLI 返回 `exit 2 / status blocked / code w2_contract_pending`，`stages=[]`，`businessDbTouched` / `dependenciesInstalled` / `migrationsRun` 均为 false，`cleanup` 为 `no_scratch_created`；输出目录里只有 `artifacts/`、`logs/` 两个空目录和结果 JSON，无业务 scratch / 业务 DB / 迁移。带 `--schema-pair` 同样不解除。**真实升级尚未完成。**
- 基础守卫与完整测试各自留下本次运行的 junction fixture（预期拒绝证据，带自有 manifest），按规则保留不删。

### 11.3 脚本自身仍不能代表的部分

- 人眼 PDF 目视：脚本只导出逐页 PNG，`office.pdf.*.visual_inspection` 仍为 `skipped`（脚本没有读图能力）。本次结论来自管理者独立查看，**没有**改写结果 JSON 里的 skip 记录；
- 旧 Node 二进制 / 其它架构 / 全新 OS / 正式安装器与完整离线发行包：未验（均有 skip 标记）；
- 真实税局 / 浏览器 / 凭据 / 真实账套：全部为合成数据，税局请求 0。

### 11.4 旧运行记录不作当前结果

首轮员工在事故整改前实际执行过测试与清理（含按 `TEMP` 通配的越界删除，事实与归属见交接 §8），不是「员工从未执行」。其在旧版本代码上留下的运行目录（含 `run6` / `run7` / `run8` 等）只对当时那版文件有效，**已作废**，不得当作当前候选结果引用；它们只是本机忽略目录里的历史诊断材料。

### 11.5 未完成 / 不在 W1

1. Git 冻结候选与 root 随后另开窗口的新独审（本包**未 PR、未合并**）；root 已授权本轮到冻结候选，本轮**不追加必须重复**的整套验收；
2. `package.json` engines 声明（现仍 `>=22.5.0`）与 `test-all` 挂载、README / STATE / 索引更新：需共享 owner 窗口授权，本轮未改；
3. 干净 OS、其它架构、旧 Node 二进制、正式安装器 / 完整离线发行 bundle；
4. HTTP / 页面 XLSX / PDF 接线（仍返回 `400 report_format_unsupported`）；
5. W2 的 v3→v4 迁移 / 回退、02 冻结 backup 新版本、03、银行、审计 B–C、批量最终契约集成（见 §12）；
6. 真实税局、真实账套、真实凭据；
7. 阶段预算仍是**耗时后验**，不是中途硬总时限（无总进程 watchdog）；该局限保留，是否加强由管理者 / root 评估；
8. Issue #49 的原生异常（`3221226505`）原因**未定位**；本次受控运行未见同码，不代表已修复或已排除。

## 12. W2：等待版本契约的升级 / 回退

W1 **不实现**通用升级 / 降级链：`--phase upgrade-rollback` 只保留命令形态，一律返回 `w2_contract_pending`（blocked，exit `2`），**不建业务 DB、不迁移、不安装依赖**；任何用户提供的 `--schema-pair` 都不得解除。手工回退仍只能按 §7 回到备份时点。

以下任一项都**不能**用 W1 通过来宣布整体升级可用；每种组合需要上游提交与精确 schema 契约，W2 另行实现与验收：

- core v4 正式整合后的 v3→v4 迁移 / 恢复；
- 审计组件（B/C）对组件表、ledger、恢复实例身份的完整兼容；
- LOCAL03 准则 / 辅助表迁移；
- 银行表 / 期末契约；
- LOCAL07 持久任务 / 检查点在备份恢复中的语义；
- 批量引入新增表 / 版本升级。

W2 演练要求（尚未实现、尚无可运行代码）：旧发布真实入口建数据 → 运行中一致备份且 verify → restore-new 到 `data-upgrade` → 停旧发布测试进程 → 新发布打开副本走真实迁移 → 核对金额 / 来源 / 迁移记录 / 备份记录 → 重启确认不重复迁移；原 `data-old` 保留且不被新版本打开。迁移失败不回写旧库，保留失败副本诊断，再从升级前已验证备份恢复到又一个新目录，以旧发布启动逐项核对。回退只到备份时点；升级后新增业务不会自动合并。

**未知组件被备份拒绝是当前安全边界，交付工具不得过滤这些表来生成「兼容」备份。**
