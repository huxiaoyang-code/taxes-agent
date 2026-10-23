# 任务单 · LOCAL-06-WINDOWS 干净目录安装、启动与升级交付

> **当前状态（2026-10-23）**：服务 / 包装器生命周期窄修获独立源码审查接受（本范围无 P1 / P2）；管理者在冻结四代码哈希上实际完成纯验证 **11/11**、生产入口真实故障 **2/2**、完整正式套件 **39/39**，均 **0 skip / exit 0**。两次新的随包冷验收均 **11 阶段 pass、162 pass / 1 warn / 9 skip、exit 0**。本轮文档窄修输入 clean HEAD 为 e7205585c759716db05014806fa901d502ffaa08。最终完整 head / 三文档 / 全 PR 仍待独立接受；**未开 PR、未合并，LOCAL-06 总包未完成。**
>
> 冷验收固定业务源仍为 e86d248c2a573b12c884f311fb01952f209e2563，叠加当时四代码及三文档共 58 文件；本次三文档收口在冷验收之后。它不证明最终 core5 / 辅助核算 / 审计 / 批量整合版已升级验收。W2 upgrade-rollback 仍 w2_contract_pending / blocked。实际仅 **Node 24.15.0 / Windows x64** 已测，engines >=22.5.0 只是声明，真实税局接入 **0**。
>
> 旧删除事故 **8 目标 / 4 已证归属 / 4 未证归属与影响**、reviewer 意外目录保留、原生异常 **3221226505 根因未知**继续有效，不能据当前通过声称零影响。旧候选及旧 gate 结果见历史章节。

- 类型：Windows 源码交付 / 运行时预检 / 启动脚本 / 干净目录验收 / 备份恢复演练
- 状态：**源码窄审接受；管理者 11/11、2/2、39/39 与两次新 cold 已通过；最终完整 head / 三文档 / PR 待审，未开 PR、未合并**。
- 负责人：`huxiaoyang-code`（已核实）
- 执行分工：历史 pi 使用已核实 deepseek-v4.1-flash / tokenhub；事故前与整改后会话分开记录，见交接。当前为用户授权单一兜底文档实施者，仅收口三文档，不改代码、不测试、不启动 child / 模型 / 其它 agent、不 Git、不清理。验收由管理者实跑。
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
6. 针对固定 e86 冷源 core schema v3 的运行中一致备份与新目录恢复演练；锁定所纳入 main `47b6ec18385ef3f9f1240e12a721e46cd66f218f` 已是 core4，严格备份支持 core3 / core4，本次冷验不覆盖新版整合 / 升级链；
7. 用户文档区分固定 e86 冷源的 CSV HTTP / 纯模块 Office 契约与锁定 main 的既有 Office 下载：main47 `/export` 已支持 CSV / XLSX / PDF 附件，`/export-data` 仍仅 CSV DTO；实际页面已有格式选择与下载按钮。已有下载能力属先前独立包，不冒称本 W1 实现或冷验覆盖；
8. 所有临时目录改到 workspace 专属根 + 所有权 manifest（v2 逐项目标），任何 mkdir 前逐级核验祖先到卷根，删除前重验完整祖先链 / realpath / manifest，无法证明则保留并非零；删除入口只有一份实现供脚本与测试复用；
9. `upgrade-rollback` 只保留命令形态并恒为 `w2_contract_pending` blocked，不产生业务副作用。

### W2（等待版本契约，不在本次冒充完成）

W2 待验范围包括 v3→v4 真实升级 / 恢复链及后续整合组合；锁定 main47 已有 core4 与严格 core3 / core4 备份支持，不等于本次固定 e86 冷验覆盖了该升级链。审计组件与备份的完整兼容、LOCAL03、银行、批量引入的新表 / 版本升级同样需精确验收。每种待支持组合需上游提交与精确 schema 契约。W1 不实现通用升级 / 降级链：`upgrade-rollback` 只保留命令形态并**恒为** `w2_contract_pending` blocked（exit 2），任何 `--schema-pair` 都不解除，也不产生业务 DB / 迁移 / 依赖安装副作用。

## 3. 精确文件范围（W1 七路径）

| 文件 | 作用 |
|---|---|
| `06-workbench/scripts/windows-runtime-check.mjs` | 运行时 / 目录 / 字体预检；白名单 JSON；不加载业务 DB；隔离子进程探针；**共享的专属根 / manifest 删除守卫** |
| `06-workbench/scripts/windows-start.ps1` | 显式 Node / DataDir / Port / ScratchRoot；先跑有界预检；前台启动并传播退出码；打印本人服务 pid |
| `06-workbench/scripts/windows-delivery-check.mjs` | 冷拷贝、lock 来源校验、依赖、HTTP / Office / 备份 / 失败路径 / 稳定性；分阶段结果、阶段预算与退出码；`upgrade-rollback` 仅 blocked 占位 |
| `06-workbench/test/windows-delivery.test.mjs` | 真实隔离进程的失败路径与关键成功链；专属临时根 + manifest；子进程 deadline |
| `docs/WINDOWS-DELIVERY.md` | 用户可照做的安装 / 启动 / 数据位置 / 停止 / 备份 / 切换 / 回退 / 故障说明 |
| `docs/tasks/LOCAL-06-WINDOWS.md` | 本任务单 |
| `docs/handoffs/LOCAL-06-WINDOWS.md` | 实际环境、命令 / 退出码、证据覆盖与未完成项 |

**范围限于上述七路径；本次收口仅三份文档，四代码冻结不变。** 以下共享窗口只拟定、未获授权，未改动：

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
- 同 DTO 调纯 `buildReportXlsx` / `buildReportPdf`；重开 XLSX 查数值；PDF 提取中文 / 金额 / 页数并**逐页**渲染 PNG（工具缺失则 skip，不用首页冒充全页）；显式保留固定 e86 冷源 HTTP Office 格式返回 400 的断言，不把它套用于 main47 已接线的 `/export`。

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

当前正式套件共 **39 项**，管理者带完整前置实跑 **39/39、0 skip、exit 0**。复跑前置说明：

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

## 8. 当前证据与历史

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

## 9. 依赖、阻塞与后续

### 未完成与下一步

- 管理者仍须锁定最终完整 head，对全 PR 和三份收口文档独立审查，再处理 PR / 自动合并与交接；源码窄审不代替最终接受。当前未开 PR、未合并，不关闭 LOCAL-06 总包。
- W2 真实升级 / 回退仍 pending / blocked。core5 / 辅助核算、LOCAL03、银行、审计 B/C、批量与 LOCAL07 检查点恢复均需精确上游提交和 schema 契约；固定 e86 业务冷源不能覆盖最终整合版。未知组件表继续拒绝备份，禁止过滤表或改版本号伪造兼容。
- engines >=22.5.0 声明仍偏宽；共享 engines / test-all / README / STATE / 索引未在本任务修改。Windows 套件仍以直接命令运行，不称已挂入 npm test。
- 其它 Node patch / 旧 Node 二进制 / 架构 / 干净 OS / 正式安装器 / 完整离线 bundle 未测；仅 Node 24.15.0 / Windows x64 已测。22.16 / 24.0 为 API 分析。
- 固定 e86 冷验的 HTTP Office 格式仍返回 400，Office 文件来自同 DTO 纯渲染模块；main47 的 `/export` 与页面已有下载能力，`/export-data` 仍仅 CSV DTO。新版整合后的 W1 / W2 验收不能由旧源通过推导。真实税局接入 0，未用真实账套 / 凭据测试。
- 阶段预算为耗时后验，不能中途中断；子进程 / HTTP / 探针有真实 deadline，无总进程 watchdog。原生崩溃根因与事故未知影响继续保留。

上游固定 e86 冷源依赖为 schema v3、LOCAL-06-BACKUP CLI、PR #52 Office 纯模块与 PR #58 审计独立原语；不描述为 main47 的全部现状。产品方向为本机单用户、多企业、每企一套；一个工作台 DB 可存多企业各自账套，main47 所有手工入口尚未统一强制该方向。禁止同 dataDir 多实例并发；两独立 dataDir / 端口只属本次隔离验收，不要求每企一目录。W1 / W2 分开验收；先更新交接再结束本实施会话，之后由管理者锁定最终 head。
