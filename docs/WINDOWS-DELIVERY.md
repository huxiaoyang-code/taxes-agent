# Windows 源码交付：安装、启动、备份与验收（W1）

本文对应[任务单](tasks/LOCAL-06-WINDOWS.md)与[交接](handoffs/LOCAL-06-WINDOWS.md)，提供源码分发的预检、显式数据目录启动、干净目录验收与备份恢复说明。

> **当前状态（2026-10-23）**：服务 / 包装器生命周期窄修获独立源码审查接受（本范围无 P1 / P2）；管理者在冻结四代码哈希上实际完成纯验证 **11/11**、生产入口真实故障 **2/2**、完整正式套件 **39/39**，均 **0 skip / exit 0**。两次新的随包冷验收均 **11 阶段 pass、162 pass / 1 warn / 9 skip、exit 0**。本轮文档窄修输入 clean HEAD 为 e7205585c759716db05014806fa901d502ffaa08。最终完整 head / 三文档 / 全 PR 仍待独立接受；**未开 PR、未合并，LOCAL-06 总包未完成。**
>
> 冷验收固定业务源仍为 e86d248c2a573b12c884f311fb01952f209e2563，叠加当时四代码及三文档共 58 文件；本次三文档收口在冷验收之后。它不证明最终 core5 / 辅助核算 / 审计 / 批量整合版已升级验收。W2 upgrade-rollback 仍 w2_contract_pending / blocked。实际仅 **Node 24.15.0 / Windows x64** 已测，engines >=22.5.0 只是声明，真实税局接入 **0**。
>
> 旧删除事故 **8 目标 / 4 已证归属 / 4 未证归属与影响**、reviewer 意外目录保留、原生异常 **3221226505 根因未知**继续有效，不能据当前通过声称零影响。旧候选及旧 gate 结果见历史章节。

## 1. 适用范围

支持本次已验的形态：

- Windows 11 x64（本次实机 Windows 11 家庭版中文版，10.0.26200）；
- Node **24.15.0**、npm 11.12.1（npm 版本只作记录，不单独作为支持承诺）；
- 从源码目录运行现有 `06-workbench` 服务；
- 产品方向为一名本机操作者、多家企业、每家一个账套；一个工作台数据库可容纳多企业各自账套，不要求每企独立数据目录。锁定 main 的所有手工入口尚未统一强制一企一套，入口统一属另项任务；本项目不做多租户。

不承诺：

- Node 22 / 23 / 24 其它小版本 / 25+；其它 CPU 架构；全新操作系统；无 Node 的机器；
- 自带全部依赖的离线安装包（离线能力是**验收方法**，不是随包分发的依赖集合）；
- 固定 e86 冷验未覆盖 HTTP / 页面直接下载 XLSX / PDF；锁定 main 已有该能力，见 §8；
- 固定 e86 冷验未覆盖 core v4 / v3→v4 迁移、LOCAL03、银行、批量新表、完整审计组件兼容（见 §12）；锁定 main 的 core4 与备份支持范围见 §7。

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
- 一家企业一个账套。同一数据目录的工作台数据库可容纳多企业各自账套，切换企业时选择对应账套，不需要更换数据目录或重启服务；不在同一账套里用 `bookKey` 混装多企业。
- 不要在服务运行时只复制 `workbench.db` 主文件：WAL 中已提交数据会丢。使用 §7 的备份命令。

### 2.1 临时目录与清理边界

预检、验收脚本与测试**都不使用系统 `TEMP` 作为可删根**，也不扫描 / 通配删除用户目录：

- 默认在 `<release>\06-workbench\tmp\windows-delivery` 下新建随机**新**目录（`tmp/` 已在 `.gitignore` 中忽略）；
- 发布目录只读时，用 `--scratch-root <绝对路径>`（启动脚本为 `-ScratchRoot`）显式指定：必须是调用者**显式授权、专用于本次任务**的目录，且**原始入参**先按“完整绝对路径”校验（不是 `resolve()` 之后再查）。“绝对”只认**盘符绝对**（`C:\...`）或**完整 UNC**（`\\server\share\...`，server 与 share 都非空）：相对路径、drive-relative（`C:foo`）、root-relative（`\foo`）、设备路径（`\\?\`、`\\.\` 以及 `//?/`、`//./` 等斜杠变体）与**缺 share 的不完整 UNC**（`\\server`、`\\server\`）一律拒绝；显式给出的空 / 纯空白值同样拒绝，不静默退回默认根（只有“根本不提供该参数”才走默认）。验收脚本对 `--release` / `--out` / `--scratch-root` 三个入参使用同一规则；UNC 判定是**纯字符串**，不连接网络、不访问设备；
- 输出 / 发布 / 临时根的关系在任何扫描 / 创建 / 复制**之前**核验：`--release` 必须是真实目录、不是 symlink / junction、到卷根的整条祖先链可核验且 realpath 与规范化路径一致；`--out` 的最近已存在祖先到卷根同样逐级核验（`out-alias` 这类 junction 会以 `reparse_point_in_ancestor_chain` 拒绝）；**scratch base（显式的或实际默认的 `<workbench>/tmp/windows-delivery`）同样在这一步核验**——根 / 最近已存在祖先无 reparse point，已存在时必须是真实目录且 realpath 与规范化路径一致，否则在 `out` 之前就拒绝，不会出现“out 已写、scratch 后拒”的半截现场；`out` 与 `release` 互不包含，`out` 不得等于或包含 scratch base（`out` 可以放在 base 之内，仍走同一套祖先链核验）；只认自己在 base 下新建的随机根 + manifest，base 整体**不算**本工具所有；拒绝时只写 stdout 并非零，**不为了留日志 / 记录失败先创建一个未验证的 `out`**；
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
- 预检的探针目录默认在 `<release>\06-workbench\tmp\windows-delivery`；发布目录只读时用 `-ScratchRoot <显式授权的绝对路径>`。`-ScratchRoot` 在**任何规范化之前**按完整绝对路径校验：“绝对”只认盘符绝对或**完整 UNC**（server + share）；相对路径、drive-relative（`C:foo`）、root-relative（`\foo`）、设备路径（含 `//?/` 斜杠变体）与不完整 UNC 直接以 `scratch_root_not_absolute` 退出 `1`；**显式给出的空白值也按同一码拒绝**（不被当成“未提供”而退回默认根），不创建 scratch、不创建业务 DB、不启动服务。
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
- 换一家企业时选择该企业对应账套；同一工作台数据库可保存多企业各自账套。
- 禁止多个工作台实例同时打开同一数据目录。若选择独立数据目录部署，应先停止使用原目录的实例，再以目标目录启动；本次两个独立 dataDir / 端口仅是两实例隔离验收拓扑，不是一企一目录要求。
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
- 本次固定 e86 冷源及 W1 备份 / 恢复验收只覆盖 core schema v3。锁定所纳入 main `47b6ec18385ef3f9f1240e12a721e46cd66f218f` 已为 core4，严格备份契约支持 core3 / core4；该已有能力不等于本次冷验覆盖了新版整合或升级链。未知组件表仍会被安全拒绝，**不要**通过过滤表或改版本号制造「兼容」备份。
- **回退只能回到备份时点。** 备份之后新增的账务不会自动合并；不暗示能无损降级新 schema。回退前先保护现库 / 停写，恢复后逐项核对金额、批次与来源。
- 恢复后必须用**对应发布版本**启动并核对；不要把恢复出来的新目录当成已经完成迁移。

## 8. 报表导出与 Office 文件

- 本次固定 e86 冷源的以下 HTTP 路由只支持 CSV；W1 冷验脚本固定验证该旧源契约：

```text
GET /api/account-sets/<id>/reports/<kind>/export?period=YYYY-MM[&code=1002]
GET /api/account-sets/<id>/reports/<kind>/export-data?period=YYYY-MM[&code=1002]
```

`kind`：`balance-sheet` / `income-statement` / `cash-flow-statement` / `trial-balance` / `ledger`（ledger 必须给 `code`）。

- 固定 e86 冷源的 HTTP / 页面尚无 XLSX / PDF 下载接线；其 HTTP 传 `format=xlsx|pdf` 返回 `400 report_format_unsupported`。W1 CLI 用同一报表 DTO 调用 `server/report-office-export.mjs` 纯模块生成 Office 文件，该结果不证明新版 HTTP / 页面已完成本次冷验。
- 锁定 main `47b6ec18385ef3f9f1240e12a721e46cd66f218f` 的 `/export?format=csv|xlsx|pdf` 已生成真实附件；只有 `/export-data` 仍仅接受 CSV / 缺省格式的 JSON DTO。该版本 `public/index.html` 已有 CSV / Excel / PDF 选择与“下载报表”按钮，`public/app.js` 通过 `/export` 下载文件。这是先前独立包的已有能力，不是本 W1 新实现，也未由固定 e86 冷验验证；其它发布版本须按对应源码与合同核实。
- 中文 PDF 需要可嵌入字体。可用显式环境变量：

```powershell
$env:REPORT_PDF_FONT = "<中文字体文件>"
$env:REPORT_PDF_FONT_FAMILY = "<TTC 集合中的字体族，可选>"
```

  缺字体给 `pdf_font_unavailable`（稳定错误码），CSV 仍可用；字体文件不复制进 Git。
- **必需 PDF 产物缺失不算成功**：在 `install-start` 验收里，五份报表的 PDF 都是必需产物。缺字体时 CSV / XLSX 的真实通过断言照旧保留，但 `office` 阶段会记为 **blocked**、总结果 `blocked`、退出码 `2`（`pdf_output_required_blocked`），并把输出目录与工作根**保留**供诊断；不把缺字体改成可选、不降低 skip 门槛，也不自动安装字体。
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
- 不带 `--scratch-root` 时，临时根在本脚本所属 workbench 的 `tmp/windows-delivery` 下（该**默认 base** 同样在任何 `out` 创建之前核验祖先链 / 根类型 / realpath）；显式传入时必须是调用者授权、专用于本次任务的**完整绝对路径**（原始入参先校验：`C:foo` / `\foo` / 相对路径 / 设备路径 / 不完整 UNC / 显式空白直接拒绝），守卫会先把祖先链核验到卷根才建目录。`--release` 与 `--out` 同样按完整绝对路径校验，并检查二者互不包含、`--out` 不等于 / 不包含 scratch base；scratch base 无效时 `out` 也不会被创建，`base` 整体不作为可删对象。
- `--require-packaged-tooling`：最终“随包完整”形态验收用。冷拷贝里缺 W1 的 windows 脚本 / 测试时直接 fail（`packaged_tooling_incomplete`），不允许用开发 worktree 脚本冒充随包；不带该参数时，缺失会显式记录为 `external_tooling` / `partial_release_tooling` 阶段证据。
- 发布清洁度扫描只跳过**明确已知**的专属 scratch 绝对路径（`<release>\06-workbench\tmp\windows-delivery` 与本次运行刚创建的根），不再扫描其它现存 run 的 manifest 来推断“整个 base 归我”；其它 `tmp` 内容仍按 forbidden 拒绝。
- `node test\windows-delivery.test.mjs` 默认在 `<workbench>\tmp\windows-delivery` 建临时根；需换到别的路径时设 `WINDOWS_DELIVERY_SCRATCH_ROOT=<显式授权的绝对路径>`（测试 fixture 也只在这个专属根内新建）。**所有负测的原始相对入参都从本用例自建的绝对候选目标派生**（root-relative 由自有目标去盘符、保留完整子路径），并在调用前断言“即使被旧实现规范化也只会落在本 fixture 内”，不会指向卷根或用户目录；子进程 cwd 一律显式指定为测试自己的目录，不用 `process.chdir`。**junction 拒绝回归会故意保留**它自建的 fixture（`junction-target` / `junction-link` / `junction-work`、`out-alias`、`release-alias`、`scratch-alias`、`dest-alias` 等）作为预期拒绝证据：它们不进通用的“全清”断言，也不是清理失败；不要用 unlink / 手工删除去“美化”结果。
- **当前正式套件共 39 项**，管理者带完整前置实跑 39/39、0 skip；下表为路径 / 缺字体等用例子集。缺字体真实 CLI 缺前置仍明确 skip，不得用 skip 充抵验收：

| 用例 | 覆盖 |
|---|---|
| `专属临时根：relative / drive-relative / root-relative 原始 base 只在本用例自有候选目标上被拒绝且不写盘` | 三种原始入参都在 mkdir 前拒绝；候选目标在本用例 scratch 内、拒绝后不存在且父快照不变；空白 base、卷根、文件 base 同样拒绝 |
| `路径字符串边界：只认盘符绝对与完整 UNC，拒绝不完整 UNC / 设备路径（含斜杠变体）/ 相对与 drive-relative` | 纯字符串：盘符绝对与 `\\server\share` 通过；`\\server` / `\\server\` / `\\` / `//server`、`\\?\` / `\\.\` / `//?/` / `//./` / 混用斜杠、相对 / `C:foo` / `\foo` / `/foo`、空 / 空白 / 首尾空白全部拒绝且不给规范化结果 |
| `路径守卫：out / release 原始入参不是完整绝对路径时只 stdout 非零，不创建任何目录（真实 CLI，自有 cwd 与候选目标）` | 子进程 cwd 固定为本用例目录；relative / drive-relative / root-relative 的 `--out` 与相对 `--release` 都在创建 out 前拒绝，候选目标不存在、父目录快照不变（不再留 `forbidden:null`） |
| `路径守卫：out 根 / 祖先 junction 在任何写入前被拒绝（真实 CLI，自有 fixture）` | `out-alias` 与 `out-alias/escaped` 形态无写入拒绝 + `prepareOutDir` 库内直接拒绝 |
| `路径守卫：release 根 / 祖先 junction 被拒绝且不创建 out（真实 CLI + inspectRelease）` | reviewer 的 `source-alias` 形态无写入拒绝 + `inspectRelease` 直接拒绝 |
| `路径守卫：scratch base 根 / 祖先 junction 与显式空白都在 out 创建前被拒绝（真实 CLI，自有 fixture）` | scratch base 自身或祖先为 junction → `scratch_root_ancestor_refused`（`reason=reparse_point_in_ancestor_chain`）、显式空白 → `scratch_root_not_absolute`（`explicitScratchRoot=true`）；三者都**不创建 out**、不写 junction 目标；库内 `auditScratchBase` 同样拒绝，正常绝对 base 通过 |
| `冷拷贝入口：源根 / 选定 workbench / 目标 alias 与越界目标被拒绝且不写目标（自有 fixture）` | `copyReleaseWhitelist` 不信任历史 `inspectRelease`：源根 / 选定 workbench alias、目标 alias、目标祖先 junction、目标在源内、目标已存在全部拒绝且不写目标；正常绝对目标仍复制成功 |
| `Office 汇总：必需 PDF 缺失必须归类为 blocked，不得当作通过` | 纯函数分类（必需 PDF 缺失 → blocked，不混入 fail） |
| `缺字体必需 PDF：真实 install-start CLI 退出 2 / blocked，输出与工作根保留（管理者前置）` | 真实 CLI 缺字体：exit 2 / `pdf_output_required_blocked`、`office` 阶段 blocked、五个 `office.pdf.*` blocked、CSV / XLSX 仍 pass、输出与工作根保留 |
| `启动脚本：relative / drive-relative / root-relative / 空白 / 设备路径 -ScratchRoot 在规范化前被拒绝且无副作用` | fixture 副本启动器 + 运行时依赖；相对三类与设备路径误接受只落自有候选；空白误退默认只落副本默认根；UNC 与非法名称只执行 AST 提取的纯路径判定，绝不传外部 UNC 给启动链；保留非零拒绝、无服务、候选不存在、快照与哨兵不变断言 |

- 带前置的重测试（缺字体真实 CLI）需要管理者提供自己的输入，缺失时会**明确 skip**（不假报通过）：

```powershell
$env:WINDOWS_DELIVERY_RELEASE_ROOT = '<已包含 W1 随包工具的冷拷贝发布根>'
$env:WINDOWS_DELIVERY_NPM_ENTRY = '<npm-cli.js 绝对路径>'
$env:WINDOWS_DELIVERY_NPM_CACHE = '<本任务专属 npm 缓存绝对路径>'
# 可选：$env:WINDOWS_DELIVERY_NODE_BINARY = '<node.exe 绝对路径>'
node test\windows-delivery.test.mjs
```

  该用例会在 `WINDOWS_DELIVERY_SCRATCH_ROOT`（或默认专属根）内自己新建 `out` 与 `--scratch-root` 子目录，成功后把 `blocked` 现场（输出目录 + CLI 自建工作根）**按协议保留**为预期证据，不自行补清理。

`install-start` 实际运行 11 个阶段：preflight / runtime / dependencies / startup / import / reports / restart / office / failure-paths / backup-restore / stability。每个阶段有一个**耗时后验上限**：`fn` 结束后才比对实际耗时，超出即按失败处理；它**不是中途硬 deadline**，不会中断正在执行的阶段。真正能中途生效的是每个子进程的 `timeoutMs` + 强杀宽限、每个 HTTP 的 `AbortSignal.timeout`、隔离子进程探针的 `MAX_PROBE_MS`；本包**没有**总进程 watchdog，这一点由管理者 / root 另行评估。它做的是：

- 按白名单从 `<release>` 冷拷贝到专属随机根，不复制 `.git` / `node_modules` / `data` / 私有配置 / DB / 日志；
- 先静态校验冻结 lock 的**来源与完整性**：只允许 `https://registry.npmjs.org/` 与 `https://registry.npmmirror.com/` 的 HTTPS `resolved`，拒绝 `file:` / `git` / 私有域 / 带凭据 URL / 缺 integrity；**不把 `npm_config_registry` 当成能约束 lock URL 的保证**（本包因此不设该变量）；
- `npm ci` 使用固定 lock；lock 哈希前后一致；空 user / global npmrc + 白名单环境 + `--ignore-scripts --no-audit --no-fund`；依赖可被真实渲染模块加载（exceljs 4.4.0 / pdfkit 0.20.2）；
- `HOST=127.0.0.1`、`PORT=0`，从本次 stdout 解析端口；新数据目录建库，`/api/account-sets` 为 `[]`，首页 / JS / CSS 可取；
- 真实 HTTP 增量导入：默认 dryRun 不落库 → 正式落库 → 同批重试幂等 → 次月追加仍同账套 → 重启后仍识别批次 / 来源；
- 独立金额：1 月银行 50,000、应收 11,300、收入 10,000；2 月银行 61,300、应收 0、收入本期 0 / 累计 10,000；
- 五类报表 CSV + DTO；`ledger` 明确 `code=1002`；同一 DTO 调纯模块生成 XLSX / PDF，重开 XLSX 查数值；PDF 提取中文 / 金额 / 页数，并在可选 PyMuPDF 可用时**逐页**渲染 PNG（缺工具则诚实 skip，不用首页冒充全页）；HTTP Office 格式的 400 断言仅对应固定 e86 冷源契约，不适用于 §8 所述锁定 main 的 `/export`；
- 缺字体：独立报告（`pdf_font_unavailable`），且**必需 PDF 产物缺失时 `office` 阶段 blocked / 总结果 blocked / exit 2**，同时保留 CSV / XLSX 的真实通过断言与输出 / 工作根；端口冲突用本包自建 listener，且不误连占位服务；非法数据目录在启动前拒绝；
- 运行中一致备份 → verify → restore-new 到新目录 → 对应发布启动核对金额 / 批次 / 来源 / 外键 / 幂等；损坏快照 / 清单、未知 schema、已存在目标各自拒绝；
- 顺序 10 次新进程启停 + 最多 2 个并行进程（各自数据目录 / 端口）串账为 0。并行阶段用 `Promise.allSettled` 收齐两台的结果：**任一台启动失败都先回收已成功启动的另一台自有句柄，再如实报失败**，不把服务留在后台；本阶段自己启动的句柄也在 `finally` 里收尾。

退出码：`0` 全过；`1` 用法错误或 `--out` / `--release` / `--scratch-root` 路径形式 / 关系被拒；`2` blocked（W2 契约未就绪 / 必需 PDF 产物缺失）；`3` 任一阶段 fail，或任一 `fail` 断言 / 未回收子进程 / 清理失败 / 发布根路径被拒。**首个失败不会被后续成功覆盖。** 结果写入 `<out>\windows-delivery-result.json`，子进程原始输出只写 `<out>\logs\`（stdout / stderr 各自上限 1 MiB），阶段含序号、开始 / 结束、耗时 / 预算、pid（仅本机）、退出码 / signal。

自动验收**不能**代表：

- 旧 Node 二进制真实运行（本轮无可用旧二进制，`skipped.old_node_binary`）；
- 其它架构 / 全新 OS / 完整离线包（均有 skipped 标记）；
- 人眼 PDF 目视（`office.pdf.*.visual_inspection` 仍为 `skipped`：脚本只能逐页导出 PNG，没有读图能力；本次验收的目视结论由管理者独立查看补充，见 §11，结果 JSON 未被改写）；
- 真实税局 / 浏览器 / 凭据 / 真实账套（全部合成数据，`tax` 请求 0）。

## 10. 故障排查

| 现象 / 稳定码 | 处理 |
|---|---|
| `runtime_version_not_qualified` / `runtime_arch_unsupported` | 当前 Node 不是已验的 24.15.0，或不是已验的 Windows x64；换成已验组合或等待后续版本验收。不要仅因版本号更大 / 架构看起来兼容就当已支持。 |
| `engines_declaration_too_wide` | 仓库声明仍为 `>=22.5.0`；以预检结论为准，勿把声明当支持承诺。 |
| `data_dir_not_directory` / `data_dir_not_writable` / `data_dir_is_reparse_point` / `data_dir_ancestor_refused` | 显式数据目录被文件 / 重解析点占用、不可写，或祖先链核验不过；换目录 / 修权限。预检不会创建目录，也不在数据目录里写删探针（`dataDir.writeProbe=not_performed`）。 |
| `EADDRINUSE` / 启动即退出 | 端口被占用；用 `-Port 0` 或换端口。不要连接占位服务。 |
| `pdf_font_unavailable` | 设 `REPORT_PDF_FONT` 指向可嵌入中文字体；CSV 不受影响。 |
| `pdf_output_required_blocked` | `install-start` 里五份报表 PDF 是必需产物：缺字体时 `office` 阶段 blocked、总结果 blocked、**退出 `2`**，但 CSV / XLSX 已真实通过；输出目录与工作根保留供诊断。装上可用字体后重跑，不要为了“先过”把它改成可选或降低 skip。 |
| `out_not_absolute` / `out_path_refused` / `out_is_reparse_point` / `out_inside_release` / `out_contains_release` / `out_contains_scratch_root` | `--out` 必须是不经 `resolve()` 就已经完整的绝对路径（相对 / `C:foo` / `\foo` / 设备路径 / 不完整 UNC 不行），祖先链不能有 symlink / junction，且不得与 `--release` 相互包含、不得等于或包含 scratch base。拒绝时只写 stdout、不创建 out。 |
| `release_not_absolute` / `release_is_reparse_point` / `release_ancestor_refused` / `release_workbench_refused` / `release_missing` | `--release` 必须是真实目录：不能是 junction 本身、祖先链不能有重解析点、realpath 必须与规范化路径一致。扫描 / 复制一律在这些校验之后。 |
| `copy_source_*` / `copy_destination_*` / `copy_source_digest_changed` | 冷拷贝入口的独立复核：源根 / 选定 workbench 不是真实目录、经 junction 逃逸、与源摘要不符，或目标不是完整绝对路径 / 已存在 / 是重解析点 / 祖先链有 junction / 与源根重叠时拒绝。拒绝不创建目标，也不补删除。 |
| `dependency_cache_missing` | 本任务离线缓存缺项；按授权来源补齐缓存，或按 §3 联网安装一次。不要从已有 `node_modules` 复制冒充安装。 |
| `out_exists` / `target_exists` / `schema_unsupported` / `snapshot_*` / `manifest_*` | 严格拒绝，按提示换新目录 / 换对应版本；不要改库或过滤表。 |
| `scratch_root_not_absolute` / `scratch_root_is_filesystem_root` / `scratch_root_is_reparse_point` / `scratch_root_realpath_mismatch` / `scratch_root_ancestor_refused` / `scratch_root_verification_failed` | 专属临时根参数 / 默认 base 不合格：不是**完整**绝对路径（相对 / drive-relative `C:foo` / root-relative `\foo` / 设备路径（含斜杠变体）/ 不完整 UNC / 显式空白都不行）、指向卷根、本身是重解析点、祖先链里有 symlink / junction、realpath 与规范化路径不符，或创建后校验不过。换一个显式授权的工作区内绝对路径；不要绕过守卫去手建目录。scratch base 不合格时 `out` 也不会被创建。 |
| `scratch_root_unavailable` / `scratch_root_not_directory` | 预检 / 验收的专属临时根建不了（发布目录只读等）或被文件 / 重解析点占用；用 `--scratch-root` / `-ScratchRoot` 指定显式授权的绝对路径。 |
| `runtime_probe_timeout` | 隔离探针超过真实 deadline 被杀；先排查系统锁 / 杀软，不要靠调大超时掩盖。残留只能由确权父根处理，清不掉时 `cleanup.retained=true` 且非零。 |
| `runtime_check_timeout` / `runtime_check_not_stopped` | 启动脚本的有界预检超时 / 已强杀但仍未回收；退出码 `2` / `3`，后者同时打印 `windows_start_residual_precheck_pid=`，不要假报已就绪。 |
| `service_stop_failed` / `windows_start_residual_service_pid=` | 包装器只用自有 Process 句柄停服务，停不掉就报残留并退出 `3`；该 pid 仅作诊断，需要人工停止时必须先重新核实其可执行路径 / 命令行、创建时间等仍与本次启动记录一致，身份确认不了就保留现场并只报告，**不要**按进程名全杀，也不按 pid 批量强杀。 |
| `service_identity_unverified` | 验收脚本**不用裸 PID 停服务**：包装器没在有界宽限内自行停掉服务时，只回收自有的包装器句柄，把服务记为未核实残留、保留目录并让结果非零，由管理者定点核验。“`/api/account-sets` 还能返回 JSON” 不能证明该 PID 就属于该端口 / 该创建实例，因此不存在“PID 身份验证后裸杀”这个兜底。 |
| `path_too_deep` | 祖先链超过固定深度仍没走到卷根：按拒绝处理，不要当成已核验通过，也不要绕过守卫改路径。 |
| `cleanup_refused` / `cleanup_failed` | 删除前核验不通过或删不掉：目录被保留，按 manifest 与提示人工处理；不要改用扫 TEMP / 通配删除 / 目录名前缀“补清理”。 `cleanup.manifestVerified=false` 表示本次没有完成 manifest 核验（未尝试 / `--keep` / 失败保留）。 |
| `w2_contract_pending` | W1 的 `upgrade-rollback` 恒为 blocked（exit 2）；需要上游版本契约与已登记配对后才另行交付。 |
| `npm_cli_not_verified` / `lock_source_not_allowed` | `--npm` 优先直接给已验证的 `npm-cli.js`（`.js` / `.mjs` 用 `node` 运行）；给的是其它入口时脚本会找其同目录 `node_modules/npm/bin/npm-cli.js`，找不到才拒绝，且从不执行 `.cmd` / `.bat`、不拼 `cmd.exe`。lock 来源必须在公共 registry 白名单内且有 integrity。 |
| 原生异常 / 进程崩溃 | 保留首次失败输出与阶段序号；不要按 `node.exe` 名称全杀，也不要装调试器 / 开全局转储。Issue #49 曾见一次无完整堆栈的 `3221226505`，原因**未定位**；零复现不代表已修复。 |

## 11. 验收证据与未完成项

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

### 历史失败、返修与旧结果

以下按发生顺序保留；“当时未跑”描述历史快照，当前验证以上表为准。

1. 首轮员工按系统 TEMP 下 wb-local06-* 通配递归删除并统计，未逐项确权或核验重解析点。匹配 8 目标：4 个由 run1–run4 结果 JSON 精确对应本人，另 4 个归属与实际影响未证；0.00 MB 不能推断为空 / 安全。另有 wb-probe-* 通配删除及手动清理，同样不合规。管理者按核实身份停止其进程，非正常完成；当时 7 文件 WIP 保留。不能断言误删他人，也不能声称零影响。run6 / run7 / run8 等旧结果不作现版依据。完整本地事故审计保存在 .agent-runs/local-06-windows-cleanup-audit.md（ignored）。
2. 旧候选 5fc23424176e4d582c4d5ec213f754caefbfe0c0：语法 3/3、基础守卫 7/7；完整初次 18/19（W2 目录期望断言失败），定点修正后新根 19/19、0 skip。两次旧 cold 各 11 阶段 / 158 pass / 1 warn / 9 skip，全离线，一 keep、一守卫清理。5 PDF / 7 页曾实际目视；W2 真实 exit 2 / w2_contract_pending，无 DB / 迁移 / 安装副作用。这些正常路径结果随后仍被独审拒绝。
3. 5fc2342 独审三项 P2：缺字体必需 PDF 缺失仍 exit 0；out / release 根与祖先 junction 漏审；PowerShell 先规范化相对 ScratchRoot 后误接受。两轮静态返修先补失败阻断与路径守卫，再修负测候选越界、scratch base 在 out 前审核、完整 UNC / 设备路径判定、冷拷贝入口复核。返修 1 员工 exit 0 但未放行运行；当时管理仅三语法通过、一字符串失败，28→29 项登记不等于已跑。后续 fixture 副本隔离、默认 cwd / scratch、PS5 BOM 与路径判定继续修正；历史未跑范围已由当前完整实跑补验。
4. 历史默认 sandbox 红、PowerShell PSAuthorization 拒绝、gate2 字符串失败、gate3 纯 3/3 / FS 6/7 均保留，不能倒写为当时通过。合 main 后曾因缺 exceljs 为 29/32 红；按固定 lock / 专属缓存离线恢复后旧 7946 对应源码 32/32、两次旧 cold 各 11 阶段 / 163 pass / 1 warn / 9 skip。163 只属于旧代码，当前 cold 使用 162。
5. 7946cd7ed071fdb4d108f0abda7f3a7bce53cdb9 最终 fresh 独审再发现两 P2：服务 stop 未知仍继续同目录启动、exit 被当作 close；launcher HTTP / 断言异常绕过统一收尾。窄修最初仅 5 项纯验证与语法检查，之后新增真实故障回归；独立源码窄审确认两条因果链已消除、无 P1 / P2。管理者已补当前 11 / 2 / 39 与两次新 cold；旧正常路径不能替代修后故障证据。
6. reviewer 自己的误 cwd harness 在仓库根建出 guard/independent-3486ff9d4580c625（自有 manifest）与空 out-target；junction 因 EPERM 未创建，无下游写入，两目录保留。review 根 .agent-runs/local-06-review-5fc234-9f62b17c 的两次缺字体 scratch 与篡改 manifest guard fixture，以及旧 gate junction / blocked fixture 均保留，不补清理；harness 已改为 import.meta 锚定。
7. Issue #49 原生异常 3221226505 根因仍未定位。已知越界删除行为、4 个目标未知归属 / 影响、未知崩溃根因是不同事实；当前通过不关闭任何一项，也不证明所有系统进程 / 历史残留已核查。

### 未完成与下一步

- 管理者仍须锁定最终完整 head，对全 PR 和三份收口文档独立审查，再处理 PR / 自动合并与交接；源码窄审不代替最终接受。当前未开 PR、未合并，不关闭 LOCAL-06 总包。
- W2 真实升级 / 回退仍 pending / blocked。core5 / 辅助核算、LOCAL03、银行、审计 B/C、批量与 LOCAL07 检查点恢复均需精确上游提交和 schema 契约；固定 e86 业务冷源不能覆盖最终整合版。未知组件表继续拒绝备份，禁止过滤表或改版本号伪造兼容。
- engines >=22.5.0 声明仍偏宽；共享 engines / test-all / README / STATE / 索引未在本任务修改。Windows 套件仍以直接命令运行，不称已挂入 npm test。
- 其它 Node patch / 旧 Node 二进制 / 架构 / 干净 OS / 正式安装器 / 完整离线 bundle 未测；仅 Node 24.15.0 / Windows x64 已测。22.16 / 24.0 为 API 分析。
- 本次固定 e86 冷验的 Office 文件来自同 DTO 纯渲染模块，HTTP Office 格式的 400 仅属该旧源契约；锁定 main 的 HTTP / 页面下载已接线（§8），该版本整合后的 W1 / W2 验收尚不能由旧源通过推导。真实税局接入 0，未用真实账套 / 凭据测试。
- 阶段预算为耗时后验，不能中途中断；子进程 / HTTP / 探针有真实 deadline，无总进程 watchdog。原生崩溃根因与事故未知影响继续保留。

## 12. W2：等待版本契约的升级 / 回退

upgrade-rollback 在 W1 一律 w2_contract_pending / blocked / exit 2，不建业务 DB、不迁移、不安装依赖；任何 schema-pair 不解除。手工回退仅能按 §7 回到备份时点，升级后新增业务不会自动合并。

真实 W2 尚未实现：需旧发布真实入口建数据 → 运行中一致备份 / verify → restore-new 到升级副本 → 停旧发布自有测试进程 → 新发布迁移副本 → 核对金额 / 来源 / 迁移与备份记录 → 重启确认不重复迁移。旧数据保留、不被新发布打开；失败保留副本，再从升级前已验证备份恢复到另一新目录，用旧发布核对。

未知组件被备份拒绝是当前安全边界，不得过滤表制造兼容。最终 core5 / 辅助核算、审计、银行、批量组合需各自提交与 schema 契约，不能从本次 e86 冷源验证推导。

## 2026-10-24 W2a 完整源码发布清单候选（待管理验收）

本片基线为 `80b770161859b75174bb6763eaabd13a6f095748`，负责人 `huxiaoyang-code`，认领 [Issue #106](https://github.com/huxiaoyang-code/youshu-fork/issues/106)。新增完整**源码** bundle，不包含 Node、npm 缓存或 `node_modules`，不代表完整离线发行包，也不代表 W4 或 Windows 最终验收完成。

`install-start` 新增 `--full-bundle`。`--release` 必须指向同时含 `06-workbench` 与 `05-reconstruction` 的根，保留仓库相对结构。原 `--require-packaged-tooling` 仍只检查 runtime/start/delivery/test 四工具；完整门由 `--full-bundle` 单独启用。原默认核心发布路径继续可用，缺工具的旧 core-only 来源不会自动成为完整 bundle。

```powershell
node scripts/windows-delivery-check.mjs --phase install-start --release <完整源码根> --node <node.exe> --npm <npm入口> --cache <授权缓存> --out <新输出目录> --scratch-root <授权专属根> --full-bundle --require-packaged-tooling
```

也可直接调用 `inspectReleaseBundle(sourceRoot)`，再将其返回对象传给 `copyReleaseWhitelist(inspected, newDestination, { fullBundle: true })`；携带 `bundleManifest` 的对象即使不传第三参数也强制走完整校验。`inspectRelease(sourceRoot, { fullBundle: true })` 等价于完整检查。`validateReleaseManifest` 只校验清单结构，真实复制还会重新检查来源和实际字节，不能仅凭自造清单获得复制授权。

完整白名单为 `06-workbench/server`、`public` 递归普通文件，package/lock，旧五项（local-backup、Windows runtime/start/delivery 及原交付测试），另加 bank-reconcile/local-auxiliary/local-audit/local-batch 四 CLI；MCP 仅复制 `05-reconstruction/catalog.json` 与 `codex/mcp/finance-mcp` 下 server/backend/tools/tax-tools/finance-model-transport/package 六文件。所有项目均必需，server/public 的后续普通源码按实际枚举纳入，不固定历史文件数。不扫描或复制白名单外的账套、配置、会话、依赖和整个 `05-reconstruction`。

schemaVersion 1 / kind `local-product-source-bundle` 清单包含确切 packageVersion、按路径排序的 `files[{path,bytes,sha256}]` 与稳定总摘要 `digest`；总摘要为 `{schemaVersion,kind,packageVersion,files}` 按该顺序 JSON 序列化的 SHA256。未知字段、重复或大小写冲突路径、穿越、ADS、尾部点/空格、未知工具路径及不合法摘要拒绝。返回值 `digest` 继续保持旧核心四目标合同；完整总摘要另为 `bundleDigest`，不能混用。复制根生成 `windows-release-manifest.json`，正式 install-start 另将同份清单写入 out/artifacts 并记录两个摘要。

源与目标的原始绝对路径、完整祖先链、realpath、互不包含和目标不存在均在目标创建前核验。逐文件以自有 fd 读取，核对读取前后普通文件身份和 nlink=1；重解析点与普通文件硬链接拒绝。缺项、旧检查后变更或清单与实际内容不符在冷副本创建前失败。复制时独占新建文件，逐项核对字节，再重验完整源/目标与两个摘要；中途变更失败保留现场，无补删或回滚宣称。既有 scratch 所有权与清理协议保持。

实施者聚焦命令（cwd `06-workbench`）：`D:/node.exe --test test/windows-release-manifest.test.mjs`，最终 **11/11、0 skip、exit 0 且实际 close 0**。新 UUID `346674d2-5e5b-4d10-8946-a2716904a998` 在 import 前隔离 TEMP/TMP/DATA 与双 KEEP；所有夹具保留。覆盖实际完整复制/逐项摘要、每个固定必需项缺失、同长度错误内容、未知清单字段/路径与重复/穿越、未来 server 源码动态纳入、真实 junction/hardlink、复制中改源保留、旧核心兼容；五 CLI 从冷副本走帮助或显式缺库只读失败路径，MCP 从冷副本实际 stdio initialize/tools/list，无税务调用、无默认库。

首轮 **8/11**：junction/hardlink 为沙箱 EPERM，batch 测试误用 `--help`；正常审批重跑 **10/11** 时真实链接组已通过，但测试误把 batch 的 help 纯文本当 JSON。修正测试对既有命令/输出通道的假设后才得到上述最终结果，历史红例均保留，未删改旧套断言。未运行旧39全套、npm全套、冷安装、两条最终冷链或升级回退；`w2_contract_pending` 仍保持。W3b/W4 及最终完整 head 的管理独验、全新独审、PR/合并另行完成；旧 W1 数值、删除事故8/4/4与原生3221226505根因未知事实保持。

### W2a R1：消费磁盘持久清单（2026-10-24，待管理验收）

上一候选的完整检查只从现有文件重建内存清单，未消费冷根已有 `windows-release-manifest.json`；因此持久清单损坏、缺项或发布文件同长度损坏可能被重新签成新源。原11组通过不能证明这条发布后完整性合同，旧结果按其实际覆盖范围保留。

R1 区分两类输入：无 manifest 的源码构建来源可按白名单生成清单；已有 manifest 的发布来源先用同一 fd、完整祖先/realpath、普通文件与 nlink=1 守卫读取磁盘证据，严格解析验证，再核对确切版本、排序路径/bytes/SHA256与总摘要和实际完整白名单一致。异常直接拒绝，不忽略或重写证据。检查返回 `manifestSha256`（构建来源为 null），复制前后继续核验该原始文件摘要；manifest 读取期间或复制期间变化也失败并保留现场。动态新增源码正向仅适用于无manifest构建源；已发布来源增加未登记源码同样拒绝。核心digest、bundleDigest与原CLI参数/四工具门保持。

R1 同一聚焦命令最终 **14/14、0 skip，exit0/实际close0**，约12.37秒；原11组断言保留，动态正向夹具的旧manifest仅重命名保留于本次证据根，明确成为源码构建来源。新增正确磁盘manifest冷源再复制、未知字段/缺必需项/重复/穿越/坏摘要/错误bytes或hash/版本不符/畸形JSON、发布工具同长度损坏、发布后多出源码、manifest硬链接及检查后/复制中改manifest，均实际拒绝且不重新签写坏证据。UUID `4ea25787-3bd0-404e-8123-3701d7b9949b` 全新隔离根、原10个冷副本CLI/MCP child均实际exit/close，夹具全保留。本轮无新红例；上一候选及更早失败现场不动。仍未跑旧39套/npm全套/冷安装/W4/最终两冷链或升级回退，待root独验与全新独审，不声明已PR或已合并。

### W2a R2：默认聚焦命令布局（2026-10-24，待管理验收）

R1 的通过证据使用显式外部 fixture 根。旧测试默认把目标放进 REPO 下，而受测source正是REPO，违反产品源目标互不包含守卫，不能把当时14/14推导为无环境变量命令可用。R2只修测试与三文档，生产script与基线 `e9b096373d5ef7fbf7bdc7498740ad0ec77a480c` 字节保持相同，不放宽守卫。

现在默认根仍为当前 `06-workbench/tmp/w2a/<完整新UUID>`；先检查真实仓库完整白名单，逐项核对真实路径、普通文件、bytes/hash后在本人根内建立完整源码 `source` 子目录，再由生产复制入口创建同根兄弟冷副本。source和cold互不包含，真实完整源码版本/hash与原仓库一致，没有用空壳源，也不依赖仓库外默认目录或系统TEMP。路径由当前测试模块推导，适用于普通checkout与worktree；显式 `WINDOWS_RELEASE_MANIFEST_TEST_ROOT` 仍支持调用者授权的绝对新UUID根。全部夹具保留，默认根也不事后补删。

在 `06-workbench` 下直接运行 `D:/node.exe --test test/windows-release-manifest.test.mjs` 即可；PowerShell若曾设置覆盖变量，先执行 `Remove-Item Env:WINDOWS_RELEASE_MANIFEST_TEST_ROOT -ErrorAction SilentlyContinue`。覆盖变量是可选项。测试在业务相关import前仍隔离TEMP/TMP/DATA与双KEEP并检查完整祖先。无manifest构建/持久manifest、全部14组坏例和guard、五CLI及MCP断言保留。

本轮实际两命令：清除覆盖变量后的默认命令 **14/14、0 skip、exit0/close0**，约21.73秒，默认根UUID `9bbfced2-d55c-4850-9216-f05f7441ba7b`；另显式外部新根UUID `f8f6a7d7-5190-41e7-b204-a99705218d20` 同命令 **14/14、0 skip、exit0/close0**，约13.57秒。各10个内部自有child均实际exit/close、无timeout，无默认库/真实库/税务调用；真实junction/hardlink正常审批执行。本轮无新红例，旧失败与旧交付保留。仍未跑旧39/npm全套/冷安装/W4/最终两冷链或升级回退，不解除 `w2_contract_pending`，不声明已PR或已合并。
