# 任务单 · LOCAL-06-WINDOWS 干净目录安装、启动与升级交付

- 类型：Windows 源码交付 / 运行时预检 / 启动脚本 / 干净目录验收 / 备份恢复演练
- 状态：**W1 受控管理验收已完成；待 Git 冻结候选与 root 随后另开窗口的新独审**（root 已授权本轮到冻结候选，本轮不追加必须重复的整套验收；未 PR、未合并；不得写成已发布 / 已合并）
- 负责人：`huxiaoyang-code`（已核实）
- 执行员工：本机 pi，模型 `deepseek-v4.1-flash`（provider `tokenhub`）；未使用子 agent；员工只做实现与文档，**验收由管理者实跑**（**事故整改后的新 pi 会话**工具集不含 shell，未执行命令 / 测试 / 进程 / 清理；事故前首轮员工确实执行过测试与清理，含越界删除，见 [交接](../handoffs/LOCAL-06-WINDOWS.md) §8）
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
- 专属临时根默认 `<workbench>/tmp/windows-delivery`，或 `--scratch-root` / `-ScratchRoot` 传入的**显式授权绝对路径**；显式 base 先按原始入参校绝对路径，最近已存在祖先逐级核验到卷根后才 `mkdir`，创建后与删除前均核验完整祖先链 + realpath（**只在真的走到卷根时算通过**，深度耗尽 `path_too_deep` 拒绝）；manifest 写精确路径 / token / 任务 / **逐项目标与 realpath** 并与内存互校：**读 / 写之前**先核验 manifest 就是内存固定 root 内的预期普通文件（非 symlink / junction、祖先链与 realpath 相符），临时文件独占创建不覆盖、不跟随链接，损坏 manifest 不得被覆盖成有效授权；创建失败一律保留已创建部分（`attempted:false / retained:true`），不做抢救式回滚；清理失败非零；
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

- 缺字体 `pdf_font_unavailable` 且 CSV / XLSX 不受阻；无网络回退；
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

退出码：`0` 成功；`1` 用法错误；`2` blocked（W2 契约未就绪）；`3` 阶段 fail / `fail` 断言 / 子进程未回收 / 清理失败。`upgrade-rollback` 在 W1 一律 `2` / `w2_contract_pending`。

## 7. 数据与安全边界

- 全部使用合成数据、临时目录、随机回环端口；不读取真实账套 / 凭据 / 用户字体目录 / 用户 npm 配置；不访问真实税局 / 浏览器 / 旧会话；
- 网络仅限锁文件声明的公共 registry 与官方文档；不使用私有 registry；
- 不修改 `server/*`、现有测试、`public/*`、MCP、银行 / 审计 / 备份 / 批量模块；不自动安装审计组件、不向 schema 添表、不关闭未知表校验；
- 发现业务缺陷给最小合成复现，不在交付脚本内绕过 / 修补；
- 版本化文档只用仓库相对路径与 `<release>/<data>` 占位，不含本机绝对路径 / 端口 / PID。

## 8. 交付证据（管理者实跑，勿与员工自述混用）

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

- 本包状态：W1 受控管理验收完成（管理者实跑），待 Git 冻结 7 文件候选与 root 随后另开窗口的独审；root 已授权本轮到冻结候选、本轮不追加必须重复测试；未 PR / 未合并；
- 上游：已合 main 的 schema v3（LOCAL-01）、备份 CLI（LOCAL-06-BACKUP）、Office 纯模块（PR #52）、审计独立原语（PR #58）；
- W2 下游等待：LOCAL02 最终 schema 与 v3/v4 备份精确契约；LOCAL03 准则 / 辅助表迁移；银行表 / 期末契约；审计 B/C 对组件表、ledger、恢复实例身份的支持；LOCAL07 持久任务 / 检查点恢复语义；
- 共享文件窗口（engines / test-all / README / 索引）需 root 在现 owner 释放后另行登记；
- 不阻塞 W1；W2 未完不能关闭 LOCAL06 总包。
