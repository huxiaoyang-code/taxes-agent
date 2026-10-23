# 任务单 · LOCAL-06-WINDOWS 干净目录安装、启动与升级交付

> **2026-10-23 当前 W1 PS5 辅助脚本编码窄修（待管理者实跑）**：第二轮 fresh 静态门后，管理者新 gate3 已实际执行纯状态 / 路径字符串 / Office 汇总 **3/3 exit 0**；原最窄 FS 批次 **6/7 通过、1 失败，exit 1、0 skip**。唯一失败发生在 `pure-path-check.ps1` 的 `launcher_parse_failed`，早于真实 PS 路径负测；同一正式 launcher 由管理者真实 PS5 Parser 直接解析为零错误。测试把中文仓库绝对路径写入 Node 默认无 BOM UTF-8 临时 `.ps1`，PS5 的旧编码读取破坏路径；本轮为该辅助脚本显式添加 UTF-8 BOM，保持只提取纯函数 AST、不 dot-source 整个 launcher。已检查三份脚本 / 测试的生成点：仅此一处动态生成 `.ps1`，其它 helper 为 Node 脚本或复制正式 launcher。本轮仅静态检查与 Node `--check`，未执行修后 pure / FS / 真实 PS / HTTP / full / heavy / cold 或任何清理；前述 3/3、6/7 均为修前冻结源码事实，不能复用于新 hash。原 29 案例、全部断言、现场保留及唯一 manifest 清理守卫不变，两个 P2 与完整产品验收仍待管理者新 gate 实跑；未 PR、未合并。旧候选 5fc2342 的 19 用例 / 两次冷验收 / PDF 目视仅历史，旧删除事故 8 目标 / 4 已证归属 / 4 未证、reviewer 误 cwd 现场保留，native 3221226505 根因未知，W2 pending。


- 类型：Windows 源码交付 / 运行时预检 / 启动脚本 / 干净目录验收 / 备份恢复演练
- 状态：**PS5 辅助脚本 BOM 窄修完成，待修后新 gate；修前 pure 3/3、FS 6/7 exit 1；两个 P2 与 full / heavy / cold 仍待验收，未 PR、未合并**。历史验收不证明当前 WIP。
- 负责人：`huxiaoyang-code`（已核实）
- 历史执行员工（下述为前轮事实，本轮为用户授权单一兜底实现会话，仅纯语法检查，无模型 / 子 agent / Git 写入）：本机 pi，模型 `deepseek-v4.1-flash`（provider `tokenhub`）；未使用子 agent；员工只做实现与文档，**验收由管理者实跑**（**事故整改后的新 pi 会话**工具集不含 shell，未执行命令 / 测试 / 进程 / 清理；事故前首轮员工确实执行过测试与清理，含越界删除，见 [交接](../handoffs/LOCAL-06-WINDOWS.md) §8）
- 本机管理者：成员自己的 Codex（负责差异审查、独立复跑、Git 与合并）
- 分支：`codex/huxiaoyang-code/local-06-windows-delivery`
- 基线：`e86d248c2a573b12c884f311fb01952f209e2563`（PR #58 审计独立原语已合 main）
- 远端载体：[Issue #59](https://github.com/huxiaoyang-code/youshu-fork/issues/59)（`Refs #20` / `Refs #49`；审计兼容关联 #54，Office 关联 #45）
- 用户文档：[WINDOWS-DELIVERY](../WINDOWS-DELIVERY.md) · 交接：[handoffs/LOCAL-06-WINDOWS](../handoffs/LOCAL-06-WINDOWS.md)
- 总览：[INDEPENDENT-PRODUCT-WORK](INDEPENDENT-PRODUCT-WORK.md)

## 1. 一个可独立交付的结果

实现**源码分发方式**的 Windows 交付包：有界运行时预检、显式数据目录启动脚本、干净目录验收脚本及可复跑证据、安装 / 升级 / 回退说明。

不做：MSI / Windows 服务 / 自动更新器 / 机器 PATH / 注册表 / 执行策略 / 防火墙修改；不做全新 OS 验收；不把「冷拷贝 + 合成数据通过」写成「Windows 全新系统安装通过」。

## 2. W1 / W2 边界

### W1（本次可独立完成）

1. 运行时 / 目录 / 字体预检；预检在任何业务 DB import 前完成；版本 / 平台 / 架构不合格时**先拒绝**，可阻塞探针在有真实 deadline 的隔离子进程里跑；
2. 固定白名单冷拷贝；锁定依赖的离线优先安装（缓存不足时可授权联网到专属缓存，再离线复验）；lock 来源限定为公共 registry HTTPS + integrity；
3. 独立数据目录下真实 HTTP 导入 / 出 CSV；
4. 基于同一 HTTP report DTO 的真实 Office 文件（纯模块渲染）；PDF 可选工具逐页导出 PNG，缺工具则诚实 skip；
5. 启动失败、端口冲突、非法目录、重复启停的诊断；包装器与服务子的有界启停与本人进程回收；
6. 针对当前已合 schema v3 的运行中一致备份与新目录恢复演练；
7. 用户文档必须标出 **Office 仍无 HTTP / 页面下载接线**；
8. 所有临时目录改到 workspace 专属根 + 所有权 manifest（v2 逐项目标），任何 mkdir 前逐级核验祖先到卷根，删除前重验完整祖先链 / realpath / manifest，无法证明则保留并非零；删除入口只有一份实现供脚本与测试复用；
9. `upgrade-rollback` 只保留命令形态并恒为 `w2_contract_pending` blocked，不产生业务副作用。

### W2（等待版本契约，不在本次冒充完成）

core v4 正式整合后的 v3→v4 迁移 / 恢复；审计组件与备份的完整兼容；LOCAL03、银行、批量引入的新表 / 版本升级。每种待支持组合需上游提交与精确 schema 契约。W1 不实现通用升级 / 降级链：`upgrade-rollback` 只保留命令形态并**恒为** `w2_contract_pending` blocked（exit 2），任何 `--schema-pair` 都不解除，也不产生业务 DB / 迁移 / 依赖安装副作用。

## 3. 精确文件范围（仅新增 7 个文件）

| 文件 | 作用 |
|---|---|
| `06-workbench/scripts/windows-runtime-check.mjs` | 运行时 / 目录 / 字体预检；白名单 JSON；不加载业务 DB；隔离子进程探针；**共享的专属根 / manifest 删除守卫** |
| `06-workbench/scripts/windows-start.ps1` | 显式 Node / DataDir / Port / ScratchRoot；先跑有界预检；前台启动并传播退出码；打印本人服务 pid |
| `06-workbench/scripts/windows-delivery-check.mjs` | 冷拷贝、lock 来源校验、依赖、HTTP / Office / 备份 / 失败路径 / 稳定性；分阶段结果、阶段预算与退出码；`upgrade-rollback` 仅 blocked 占位 |
| `06-workbench/test/windows-delivery.test.mjs` | 真实隔离进程的失败路径与关键成功链；专属临时根 + manifest；子进程 deadline |
| `docs/WINDOWS-DELIVERY.md` | 用户可照做的安装 / 启动 / 数据位置 / 停止 / 备份 / 切换 / 回退 / 故障说明 |
| `docs/tasks/LOCAL-06-WINDOWS.md` | 本任务单 |
| `docs/handoffs/LOCAL-06-WINDOWS.md` | 实际环境、命令 / 退出码、证据覆盖与未完成项 |

**未修改任何现有文件。** 以下共享窗口只拟定、未获授权，未改动：

- `06-workbench/package.json`（engines 与可选脚本入口）
- `package-lock.json`（仅 root 包 engines 同步或必要依赖元数据）
- `scripts/test-all.mjs`（新增套件挂载）
- `06-workbench/README.md`、共享 `STATE` / 索引

因此本包当前以直接命令运行，不写成已挂入 `npm test` 的全套覆盖：

```powershell
node scripts\windows-runtime-check.mjs --json
node scripts\windows-delivery-check.mjs ...
node test\windows-delivery.test.mjs
```

## 4. 运行时核实结论

现有 `package.json` 声明 `>=22.5.0` **不足以作为交付支持承诺**；本次实际只对 Node **24.15.0** 做资格验证。

| 必需 API / 行为 | 冻结源码使用 | 交付含义 |
|---|---|---|
| 无额外 flag 导入 `node:sqlite` | db / import-storage / backup | 22.5 首次引入不等于无 flag；22.13 / 23.4 才解除 flag |
| `DatabaseSync({readOnly:true})` 真实只读 | import-storage、backup、审计 | 22.16 官方参数表确认；必须有拒写 / 源 hash 不变探针 |
| `DatabaseSync` 的 `timeout` | backup busy_timeout | 22.16 / 24.0 添加；保留有界锁等待测试 |
| `db.isTransaction` | PR58 `local-audit.mjs` | 22.16 / 24.0；旧版本 `undefined` 会误判事务 |
| fs mkdir / realpath / read / write / fsync / rename / copyFile / rm | db / backup | 已见调用未抬高 22.16；新增脚本实际用法需扫描 |

推论：API 层面对 Node 22 分支至少 22.16、24 分支至少 24.0；**这不是已测支持矩阵**。本次只把 24.15.0（Windows x64）作为已验组合，预检显式拒绝 22.x、24 非 24.15.0（包括 24.15.1 等其它 patch）、25+，以及非 x64 架构（arm64 同样未实测、同样拒绝），并提示 `package.json` 声明偏宽。`runtime.qualified` 是**版本 + 平台 + 架构三个维度同时命中**已验组合的合取结论（`runtime.qualifiedScope` = 24.15.0 / win32 / x64），不是只看版本号，也不是“API 可能可用”。若要正式支持 22.16 下限或 arm64，必须另有该真实二进制的相同验收。

不自动下载 / 安装 Node。

## 5. 验收门槛

### 5.1 运行时预检

- 在业务 DB import 前运行；版本不合格时**不做任何目录写探针**；
- 版本 / 平台 / 架构 / sqlite / isTransaction / 只读拒写 / busy_timeout / fs / 显式数据目录；可阻塞探针放在有真实 deadline 的隔离子进程，超时强杀；
- 数据目录只做**只读**检查（显式目标 + 祖先链 + 可写性），不枚举驱动器 / home，**不在用户数据目录写删探针**；真实写 / 删能力由自有 scratch 的真探针与实际 HTTP 验收证明；
- 缺 PDF 字体独立报告（`candidate_present` 仅表示文件存在，不等于可嵌入 / 字形完整；实际导出才是判据），不阻止 CSV；
- 专属临时根默认 `<workbench>/tmp/windows-delivery`，或 `--scratch-root` / `-ScratchRoot` 传入的**显式授权绝对路径**；显式 base 先按**原始入参**校“完整绝对路径”（“绝对”只认盘符绝对或**完整 UNC**（server + share）；相对 / `C:foo` / `\foo` / 设备路径（含 `//?/` 斜杠变体）/ 缺 share 的不完整 UNC / 显式空白一律拒绝，不是 resolve 后再查），最近已存在祖先逐级核验到卷根后才 `mkdir`，创建后与删除前均核验完整祖先链 + realpath（**只在真的走到卷根时算通过**，深度耗尽 `path_too_deep` 拒绝）；`-ScratchRoot` 在 PowerShell 侧同样先校原始字符串，**不得先 `GetFullPath` 规范化**，并用 `$PSBoundParameters` 区分“未提供”与“显式空白”（后者拒绝）；manifest 写精确路径 / token / 任务 / **逐项目标与 realpath** 并与内存互校：**读 / 写之前**先核验 manifest 就是内存固定 root 内的预期普通文件（非 symlink / junction、祖先链与 realpath 相符），临时文件独占创建不覆盖、不跟随链接，损坏 manifest 不得被覆盖成有效授权；创建失败一律保留已创建部分（`attempted:false / retained:true`），不做抢救式回滚；清理失败非零；
- **输出 / 发布 / scratch 入口同样先审路径**（任何扫描 / 创建 / 复制之前）：`--release` 必须是不经 resolve 即完整的绝对路径、真实目录、非重解析点、完整祖先链到卷根无 junction、realpath 与规范化路径一致（含嵌套 `06-workbench`）；`--out` 的最近已存在祖先到卷根逐级核验，已存在时必须是真实目录；**显式或实际默认 scratch base 也在 `out` 创建前审根 / 祖先 / 根类型 / realpath**，无效 scratch 时 `out` 也不创建；`out` 与 `release` 互不包含，`out` 不得等于或包含 scratch base（只认自己在 base 下新建的随机根 + manifest，base 整体不算本工具所有）。校验失败只写 stdout 并非零，**不为了记录失败先写未验证的 out**；冷拷贝入口 `copyReleaseWhitelist` 自行重验源根 / 选定 workbench（含重算摘要）/ 目标完整绝对与祖先无 junction / 目标不存在且不重叠源，拒绝不写目标；
- 只输出白名单字段；拒绝时不产生业务 DB。

### 5.2 干净目录与依赖

- 白名单冷拷贝，不带 `.git` / `.npmrc` / `.env*` / `node_modules` / data / DB / WAL / SHM / profiles / logs / tmp / 备份 / 模型或 Git 配置；
- 至少一次中文与空格路径；
- 先静态校验 lock：`resolved` 只允许 `registry.npmjs.org` / `registry.npmmirror.com` 的 HTTPS 且带 integrity，拒绝 `file:` / `git` / 私有域 / 凭据 URL；不把 `npm_config_registry` 当约束保证；
- `npm ci` 使用固定 lock；lock 哈希前后一致；专属缓存；空 user / global npmrc；必要环境白名单；`--ignore-scripts --no-audit --no-fund`；不执行 `.cmd` / `.bat`、不拼 `cmd.exe`：`--npm` 给 `.js` / `.mjs` 直接 `node` 运行，给其它入口（本次实际给 `npm.cmd`）时用其同目录 `node_modules/npm/bin/npm-cli.js`，找不到才 `npm_cli_not_verified`；
- 离线优先；缓存不足时授权联网到专属缓存，再删除 `node_modules`（走同一守卫：manifest 登记 + 完整祖先链 + realpath）后离线复验；不得从已有 `node_modules` 复制冒充；
- 依赖可被真实渲染模块加载；记录实际 node / npm 版本。

### 5.3 启动 / 导入 / 金额 / 报表

- 所有启动 `HOST=127.0.0.1`，验收 `PORT=0` 并从本次 stdout 解析端口；不探测 / 复用 8787；
- 新数据目录 `/api/account-sets` 为 `[]`；首页 / JS / CSS 可取；未访问税局；
- 真实 HTTP 增量导入：默认 dryRun 不落库 → 显式 `dryRun:false` → 同批重试幂等 → 次月同企业同账套 → 重启后仍识别批次 / 来源；
- 独立金额：1 月银行 50,000 / 应收 11,300 / 收入 10,000；2 月银行 61,300 / 应收 0 / 收入本期 0、累计 10,000；
- 五类报表 CSV + DTO；ledger `code=1002`；
- 同 DTO 调纯 `buildReportXlsx` / `buildReportPdf`；重开 XLSX 查数值；PDF 提取中文 / 金额 / 页数并**逐页**渲染 PNG（工具缺失则 skip，不用首页冒充全页）；**HTTP XLSX / PDF 未接线**必须显式断言。

### 5.4 失败路径 / 备份 / 稳定性

- 缺字体 `pdf_font_unavailable`：**必需 PDF 产物缺失不得算成功**——`office` 阶段 blocked、总结果 blocked、退出 `2`（`pdf_output_required_blocked`），保留输出目录与工作根；同时 CSV / XLSX 的真实通过断言保持不变，不把缺字体改为可选、不放宽 skip、不自动装字体；无网络回退；
- 非法数据目录在启动前拒绝，文件不变；
- 端口冲突由本包新建 listener 模拟，启动非零退出，占位服务 0 连接；
- 运行中备份（含 WAL 已提交业务）→ verify → restore-new 新目录 → 对应发布启动核对金额 / 批次 / 来源 / 外键 / 幂等；
- 损坏清单 / 损坏快照、未知 schema、已存在目标各自拒绝，原数据 / sentinel 不变；
- 顺序 10 次新进程启停，每次真实 HTTP 读与退出回收；另最多 2 个进程并行、各自独立 data + 随机端口，串账为 0；
- 不按 `node.exe` 名称全杀；只停本人创建且已跟踪的进程句柄（包装器自报 `windows_start_service_pid=`）。包装器的正常 / 异常 / 有界自停路径都只用**自有 Process 句柄**停止，验收脚本**取消对服务 PID 的裸 `process.kill` 兜底**：它只等这个有界包装器自行回收，超过宽限就记 `service_identity_unverified` 残留、保留目录并 fail（`/api/account-sets` 还能返回 JSON 不能证明该 PID 属于该端口 / 该实例，因此不称“PID 身份验证”）；杀不掉时按硬截止报残留并非零，不无限等 close；测试在外层终止包装器时只报已记录的服务 PID，不用裸 PID 猜杀；并行阶段任一启动失败先用 `allSettled` 回收已启动的自有句柄再报失败；
- 任一 `fail` 断言 / 未回收子进程 / 清理失败都使总结果非零；阶段**耗时超出后验预算**同样按失败处理（不中断执行中的阶段）。

### 5.5 超时 / 日志

readiness 15 秒、每个 HTTP 10 秒、每个子进程各自 deadline（npm 5 分钟、suite 2 分钟、Office 2 分钟）、稳定性阶段最多 10 分钟；这些是**中途生效的 deadline**。阶段预算（`STAGE_BUDGET_MS`）则是**耗时后验**：阶段 `fn` 结束后才比对实际耗时、超出判失败，不中断执行中的阶段；本包没有总进程 watchdog，这一局限已记录。stdout / stderr 单流上限 1 MiB；记录阶段、序号、开始 / 结束、pid（仅本机）、退出码 / signal、Node / OS / arch、固定源码 / lock 摘要与是否清理。不记录整个 env、凭据或实际用户路径到 versioned 文档。

## 6. 复跑命令

```powershell
cd 06-workbench

node scripts\windows-runtime-check.mjs --json
node scripts\windows-runtime-check.mjs --json --scratch-root <显式授权的绝对路径>

node test\windows-delivery.test.mjs

node scripts\windows-delivery-check.mjs --phase install-start `
  --release <冷拷贝根> --node <node.exe> --npm <npm-cli.js> `
  --cache <授权缓存> --out <专属新输出目录> [--scratch-root <显式授权的绝对路径>] [--require-packaged-tooling]

# W1：恒为 w2_contract_pending（exit 2）；不建 DB / 不迁移 / 不装依赖
node scripts\windows-delivery-check.mjs --phase upgrade-rollback `
  --release <发布根> --out <专属新输出目录>
```

退出码：`0` 成功；`1` 用法错误；`2` blocked（W2 契约未就绪 / 必需 PDF 产物缺失）；`3` 阶段 fail / `fail` 断言 / 子进程未回收 / 清理失败 / 发布根路径被拒。`upgrade-rollback` 在 W1 一律 `2` / `w2_contract_pending`。

当前窄修后的新增 / 变动用例（测试文件静态计数 **29 个**；旧 gate2 字符串失败及上一冻结源码新 gate 字符串 1/1 通过均为前轮事实，本轮新增纯状态回归未执行，当前源码用例**未实跑**）的前置说明：

- 纯守卫 / 真实 CLI 负向用例（relative / drive-relative / root-relative 的 base 与 `--out` / `--release`（候选目标均为本用例自有 fixture 内目标）、路径字符串边界（不完整 UNC / 设备路径 / 斜杠变体）、out / release / scratch 的根与祖先 junction、冷拷贝入口的源 / 目标 alias 与越界目标、`Office` 汇总分类、启动脚本 `-ScratchRoot` 原始路径与空白拒绝）**不需要额外前置**，跑 `node test\windows-delivery.test.mjs` 即可（junction 用例在系统不允许建 junction 时明确 skip，并保留已有 fixture）；所有子进程 cwd 均由用例显式指定为自有目录，不使用 `process.chdir`；
- 缺字体真实 CLI 用例需要管理者自己的输入；三个变量缺一个就**明确 skip**（不假报通过）：

```powershell
$env:WINDOWS_DELIVERY_RELEASE_ROOT = '<已包含 W1 随包工具的冷拷贝发布根>'
$env:WINDOWS_DELIVERY_NPM_ENTRY = '<npm-cli.js 绝对路径>'
$env:WINDOWS_DELIVERY_NPM_CACHE = '<本任务专属 npm 缓存绝对路径>'
# 可选：$env:WINDOWS_DELIVERY_NODE_BINARY = '<node.exe 绝对路径>'
node test\windows-delivery.test.mjs
```

  该用例使用真实的 `install-start` + 不存在的 `--font`，断言 exit `2` / `blocked` / `pdf_output_required_blocked`、`office` 阶段 blocked、五个 `office.pdf.*` blocked、CSV / XLSX 仍 pass、输出与工作根**保留**；所有临时根仍从 `WINDOWS_DELIVERY_SCRATCH_ROOT`（或默认专属根）派生，blocked 现场按协议保留不自行清理。任何下载只允许既授权公共来源 + empty npmrc + `--ignore-scripts` + 白名单 env。

## 7. 数据与安全边界

- 全部使用合成数据、临时目录、随机回环端口；不读取真实账套 / 凭据 / 用户字体目录 / 用户 npm 配置；不访问真实税局 / 浏览器 / 旧会话；
- 网络仅限锁文件声明的公共 registry 与官方文档；不使用私有 registry；
- 不修改 `server/*`、现有测试、`public/*`、MCP、银行 / 审计 / 备份 / 批量模块；不自动安装审计组件、不向 schema 添表、不关闭未知表校验；
- 发现业务缺陷给最小合成复现，不在交付脚本内绕过 / 修补；
- 版本化文档只用仓库相对路径与 `<release>/<data>` 占位，不含本机绝对路径 / 端口 / PID。

## 8. 交付证据（历史 + 本轮层级，勿混用）

> **证据分层**：下面 §8 的结果（19 用例 / 两次冷验收 / PDF 目视 / W2 负验收）**只对应已被独审拒绝的旧候选 `5fc2342`**。两轮管理静态复核返修已改 4 个代码文件 + 1 个测试与 3 份文档，但**尚未实际运行**；不得把旧结果当成返修后的回归，也不得冒称新回归已通过。缺字体真实 CLI 用例必须由管理者提供完整前置真正执行，不能以 skip 充抵缺字体验收。本轮新增用例与前置见 §6。

- 环境：Windows 11 10.0.26200 x64（一台主机）；Node v24.15.0；npm 11.12.1；冷业务源基线 `e86d248…`；
- **执行者**：以下均由**本机管理者**实际执行；**事故整改后的新 pi 会话**工具集不含 shell，未执行命令 / 测试 / 进程 / 清理。该限定只适用整改后的新会话——事故前首轮员工确实执行过测试与清理（含越界删除，见 [交接](../handoffs/LOCAL-06-WINDOWS.md) §8），不用「员工未执行」覆盖历史。不得写成员工自测；
- 冷源与组成：`e86d248` 白名单归档的 51 个基线文件逐项 Git blob 哈希与 `ls-tree` 一致（无 junction，未带入 config / DB / `node_modules`）；叠加本任务 7 个文件后随包工具为 `release_cold_copy`（`optionalMissing=[]`）；
- 代码形态：`node --check` 3/3 通过；基础安全 pattern 实际选中 7 个纯守卫用例（此前误计 6）7/7 通过，其余 12 个不在该 pattern 内；完整测试初次 18/19（唯一失败为 W2 临时目录期望断言），只定点修该断言后在全新 scratch 复跑 19/19、0 skip；初次失败记录保留；
- 冷验收：`install-start --require-packaged-tooling` 两次独立运行（run-a `--keep` 保留根、run-b 默认守卫清理）均 11 阶段 pass、158 pass / 9 skip / 1 engine warning，依赖完全离线（`networkUsed=false` / `offlineProven=true`）；run-b `cleanup.completed=true / manifestVerified=true`，管理者独立确认其精确根已不存在；
- PDF：5 份共 7 页由管理者用 Poppler 逐页渲染并实际查看，中文 / 金额 / 表格 / 跨页续表与页脚无视觉阻塞（合成样本）；脚本自身 `office.pdf.*.visual_inspection` 仍为 skipped，由独立视觉证据补充，结果 JSON 未改写；
- W2：`--phase upgrade-rollback` 真实退出 `2` / `w2_contract_pending`，无业务 DB / 迁移 / 依赖副作用，带 `--schema-pair` 不解除；真实升级尚未完成；
- 旧运行目录（`run6` / `run7` / `run8` 等，旧代码）**已作废**，不作当前结果；
- 未验：正式安装器发行包 / 其它架构 / 干净 OS / 旧 Node 二进制 / 完整离线 bundle；HTTP / 页面 Office 下载；03 / 02 冻结 backup 新版本 / 银行 / 审计 B–C / 批量最终契约集成（含 W2 升级）；engines 声明仍 `>=22.5.0` 待共享 owner 窗口；Issue #49 根因未定位；阶段预算只是耗时后验的局限保留；junction fixture 按规则故意保留。

`install-start` 与 `upgrade-rollback` 的可复跑命令见 §6；详细结果见 [交接](../handoffs/LOCAL-06-WINDOWS.md) §6。

## 9. 依赖 / 阻塞 / 下游

- 本包状态：旧候选 `5fc2342` 被独立独审拒绝（3 项 P2：缺字体仍 exit 0、输出 / 发布入口 junction 漏审、启动脚本先规范化相对 `-ScratchRoot`）；其后两轮管理静态复核返修（返修 1 员工 exit 0 但未被放行运行；返修 2 修负测越界目标、scratch base 前置审核、完整 UNC / 设备路径判定、冷拷贝入口前置与文档诚实）**只改 7 文件范围内的实现与文档，管理仅实跑三语法通过与一字符串失败，其余尚未实跑**，待管理者审 diff 后创建全新 UUID gate 根重跑后才谈重新冻结候选；未 PR / 未合并；
- 上游：已合 main 的 schema v3（LOCAL-01）、备份 CLI（LOCAL-06-BACKUP）、Office 纯模块（PR #52）、审计独立原语（PR #58）；
- W2 下游等待：LOCAL02 最终 schema 与 v3/v4 备份精确契约；LOCAL03 准则 / 辅助表迁移；银行表 / 期末契约；审计 B/C 对组件表、ledger、恢复实例身份的支持；LOCAL07 持久任务 / 检查点恢复语义；
- 共享文件窗口（engines / test-all / README / 索引）需 root 在现 owner 释放后另行登记；
- 不阻塞 W1；W2 未完不能关闭 LOCAL06 总包。

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
