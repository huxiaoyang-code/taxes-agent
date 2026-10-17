# RC-A0 · tax-browser 草稿复审报告

日期：2026-10-17（收尾）。原件保留与旧草稿 272 项复验发生于 **2026-10-16**，2026-10-17 为本次收尾（整合 + 独立验收）。任务：[RC-A-LOGIN-DATA](tasks/RC-A-LOGIN-DATA.md) / [Issue #13](https://github.com/huxiaoyang-code/youshu-fork/issues/13)（OPEN）。
分支：`codex/huxiaoyang-code/rc-a0-review`；基线 `d0221df1d18e2bfcbd7db2cc9aa0875ab32a7fd4`（= 当前 `origin/main`，含 PR #15 报表 + PR #16 团队文档）。

> 本报告只写可核验事实。**原件 `<repo>/.worktrees/tax-browser` 与旧基线副本 `<repo>/.worktrees/rc-a0-reproduce` 均只读未改**（`<repo>` 为本地克隆根，历史负责人本机的绝对路径不写死为跨机默认）；本轮代码已由管理者提交：初轮 `866fc308cd77bbce85d23de0b641a2e05682b3a9`（`866fc30`，14 文件）为历史，收尾安全修复追加为 `0293ed21968864d7bbabb071a7a0234fb9dbfbd6`（`0293ed2`，**只追加 `server/server.mjs` 与 `test/server-local-boundary.test.mjs`，不动会计 / 报表 / MCP 业务模块**；最终代码验证 head = `0293ed2`），并开 PR [#19](https://github.com/huxiaoyang-code/youshu-fork/pull/19)（**未合并**、待跨成员复核；创建时为 draft，实时 draft/ready 以 GitHub 为准），**不伪造 head / merge**。
> 源清单 `<repo>/.agent-runs/import-strict-tax-preservation.json`（只含路径 + SHA256）。
> **本机管理者已独立验收通过（15 套 496 项 + smoke 28/28、exit 0，代码验证 head `0293ed2`）；跨成员 Codex 复核未获得，PR #19 未合并、待跨成员复核**；文档后续提交不改已提交代码，最终 PR head 以 PR 当前提交为准。
> **真实登录未验收**：企业中候选列表 ≠ 财务数据；全国真实接入 0。原稿读到的页面仅为候选，不证明身份或授权真实性。

## 1. 复审对象与快照

- 草稿原件：14 个未提交文件（6 新增 + 8 修改），基线 main `9783420a84dae2fe8a4c4b3021c07947b66fec00`，分支 `codex/tax-browser-import`。
- 逐文件 SHA256：原件 14/14 与源清单**全部一致**；只读旧副本 `rc-a0-reproduce` 14/14 亦与清单一致（见 [RC0-SNAPSHOT](handoffs/RC0-SNAPSHOT.md)）。
- 快照只复制源码 / 文档，**无 DB / 凭据 / profile / 旧日志**。

## 2. 与最新 main 的冲突矩阵（只读检查实际源码）

草稿基线 `9783420` 到最新 main `d0221df` 之间相隔 **PR #9 / #10 / #11 / #12 / #15 / #16（不止 PR #15；`#13` / `#14` 是 Issue 而非 PR）**：其中 **PR #10 IMPORT-STRICT 改了 `server/accounting.mjs`**（严格导入重写），PR #15 改了 `06-workbench/{README.md,public/app.js,public/index.html,scripts/test-all.mjs,server/server.mjs,server/report-export.mjs,server/tax-report-format.mjs,test/*}`；这些改动中若干文件与草稿 14 文件重叠。整合方式为**在当前 main 版本上择选追加**，不整文件覆盖。**基线差异必须按完整的 `9783420..d0221df` 区间说明，不能只按 PR #15 比较，也不能说 `accounting.mjs` 或根 `README.md` 自 9783420 起完全未变**（根 README 在区间内已随产品形态 / `team-skills` 等后续文档改动）。

| 文件 | 草稿改动 | 最新 main（完整 `9783420..d0221df`）现状 | 冲突判定 | 本轮整合取舍（实际） |
|---|---|---|---|---|
| `server/accounting.mjs` | 未改 | **PR #10 IMPORT-STRICT 已在 `9783420..d0221df` 区间内改动**（严格导入）；PR #15 未改 | 草稿无改动，无冲突 | **本轮未触碰**；保留已合并的严格导入 |
| `server/coa.mjs` | 未改 | 未改 | 无冲突 | 未触碰 |
| `server/db.mjs` | 新增 `tax_enterprise_bindings` 表（幂等迁移） | 未改 | 附加式，无冲突 | 原样追加；存量表零改动 |
| `package.json` | 新增 `test:taxbrowser` 脚本 | 未改 | 附加式，无冲突 | 原样追加 |
| `scripts/test-all.mjs` | 草稿版仅 7 套（缺 report-export 等） | 10 套（含 IMPORT-STRICT 与 PR #15 报表套件） | **结构性冲突**：草稿版更旧 | **不覆盖**；保留 10 套，追加 `tax-browser` + `tax-browser-security` + `tax-browser-lifecycle` + `tax-browser-ui` + `server-local-boundary`（**最终 15 套**） |
| `server/server.mjs` | 挂载 `/api/tax-browser/*`、默认回环 HOST、退出清理 | PR #15 加报表导出路由 | 同文件不同区段 | 两处并存：`buildReportExport` 路由与 tax-browser 路由/OPTIONS/信号退出均保留 |
| `public/app.js` | 新增税局对话框、改 `newSetDialog` | PR #15 加报表下载/预览 UI | 同文件不同区段 | 在含报表 UI 的当前版本上追加；`btnExportReport`/`downloadReport`/`export-data` 保留 |
| `public/index.html` | 新增 `btnTaxImport` | PR #15 加报表下载/打印按钮 | 附加式 | 追加按钮；报表按钮保留 |
| `06-workbench/README.md` | 改「税局浏览器导入」说明（草稿版删去了报表/一致性描述） | PR #15 有内部 CSV 导出与 RC-B 说明 | 文本冲突 | **保报表说明**，最小追加税局说明，不覆盖同事成果 |
| `README.md`（根） | 改文档地图（草稿版删去产品形态与 team-skills 链接） | **区间内已改**（产品形态 / `team-skills` 等后续文档，非 PR #15） | 无冲突，但草稿有回退 | 不照搬；只最小追加链接 |
| `test/*.test.mjs` | 新增 `tax-browser.test.mjs` | PR #15 新增 `report-export{,-http}.test.mjs`、`tax-report-format.test.mjs` | 文件级无重叠 | 各自保留 |

**结论**：真实冲突集中在 `scripts/test-all.mjs`（草稿版回退）与 `server/server.mjs` / `public/*`（同文件不同区段）；`package.json`、`db.mjs` 为纯追加；报表模块（`report-export.mjs`、`tax-report-format.mjs`）与草稿完全不重叠；`accounting.mjs` 虽在完整基线区间被 **PR #10 IMPORT-STRICT** 改动，但草稿与本轮均未触碰它。**PR #15 报表成果与 IMPORT-STRICT 严格导入均已保留。**

## 3. 旧草稿自带套件复现（实际数字与退出码）

| 运行（日期） | 范围 | 结果 | 退出码 | 证据 |
|---|---|---|---|---|
| 沙箱首跑 | 旧草稿全套 | 5 套失败（smoke/tax-browser/contract/workflow/tax） | 1 | 本机 `.agent-runs/rc-a0-original-tests.log/.exit`（EACCES 回环限制，见下） |
| 管理者获批复跑（**2026-10-16**） | 旧草稿全套 | **7 套 272 项**：guards 23 + derived 31 + smoke 28 + tax-browser 64 + contract 44 + workflow 23 + tax 59 | **0** | 本机 `.agent-runs/rc-a0-original-approved.log/.exit` |

- 两轮**分别保留**，不冒称一次通过：首轮失败为沙箱内 HTTP 回环（EACCES）环境限制，**不能算业务失败，也不能省略**。
- 员工历史自报 272 与管理者复跑 272 数字一致，但**以管理者复跑为准**；历史员工进程退出码**仍未知**，不与复跑 exit 0 混同。
- 旧草稿 `npm run test:taxbrowser` 单独 64 项与上表 tax-browser 份额一致。
- **日期区分**：原件保留与上述旧草稿复验实际发生于 **2026-10-16**；**2026-10-17** 是本次 A0 收尾（选择性整合 + 独立验收），两者不混为一天。

## 4. 本轮整合与本机独立验收（2026-10-17）

- 整合后 `scripts/test-all.mjs` 为 **15 套**：PR #15 的 10 套 + `tax-browser` + `tax-browser-security` + `tax-browser-lifecycle` + `tax-browser-ui` + `server-local-boundary`；保留 IMPORT-STRICT 与报表套件。**不再有 12 套或「生命周期 / UI 未纳入」的旧状态。**
- 本机管理者已独立审阅实际 diff（含 tax-browser / service / HTTP / import、`server` / `db` / `public` 接线、全部新增测试与文档）并复跑：
  - `npm test`：**15 套 496 项全部通过、exit 0**（最终 `0293ed2`）。分套：guards 23、derived 31、import-strict 54、report-export 21、report-export-http 29、tax-report-format 24、smoke 28、tax-browser 64、tax-browser-security 18、tax-browser-lifecycle 26、tax-browser-ui 24、server-local-boundary **28**、contract 44、workflow 23、tax 59。**仅 `server-local-boundary` 由初轮 13 增至 28（追加 15 项），其他分套不变。**
  - **初轮历史（保留一行，不作当前结论）**：初轮代码 `866fc30` 为 15 套 481 项、`server-local-boundary` 13 项；收尾安全修复后为 15 套 496 项、28 项。
  - 单独 `npm run test:smoke`：**28/28、exit 0**。
  - 日志：本机 `.agent-runs/rc-a0-manager-tests-v2.log/.exit`、`rc-a0-manager-smoke-v2.log/.exit`（Git 忽略，**仅本机，不作为同事前置**；初轮 `.log/.exit` 为历史）。哈希元数据 `rc-a0-verified-source-hashes-v2.json`（亦仅本机忽略、不作为同事先决）。
- 验证前后 `server` / `public` / `scripts` / `test` / `package` 共 **29 文件 SHA256 一致**；原件 14/14 仍一致；`accounting` / `coa` / 报表模块、原有主线测试、MCP **均无 diff**。
- 基线事实（既有历史，非本次）：管理者 **2026-10-16** 在 main `c2d5619` 复验 `npm test` **10 套 336 项、exit 0**（合成临时库），见 [STATE](handoffs/STATE.md)；早期员工记录 `.agent-runs/rc-a0-baseline-npm-test.log` **不得用来冒称本次管理者复验**。
- **当前状态：本机独立验收通过（15 套 496 项 + smoke 28/28、exit 0，代码验证 head `0293ed2`）；代码已提交（初轮 `866fc30` + 收尾修复 `0293ed2`）并开 PR [#19](https://github.com/huxiaoyang-code/youshu-fork/pull/19)，未合并，待跨成员 Codex 复核。** 文档后续提交不改已提交代码，最终 PR head 以 PR 当前提交为准，本报告不预报 merge。

## 5. 安全问题与修复证据

### 5.1 已确认（当前工作区已有代码 + 合成测试证据）

| # | 问题 | 修复（实际代码） | 测试证据 |
|---|---|---|---|
| S1 | HTTP 错误出口透传 `err.message` / `err.details`（含 CDP 原始错误） | `tax-browser-http.mjs` 固定 `SAFE_ERRORS` 字典 + 固定文案；未知/怪 code（`__proto__`/`constructor`…）一律 500 `tax_browser_internal`；own-property 查找 | `test/tax-browser-security.test.mjs` 18 项，注入 `SYNTHETIC_SECRET_SENTINEL`，断言响应无秘密、无 `details` |
| S2 | 未校验连接来源，远端可伪造 Host/Origin | 路由入口 `isLoopbackAddress(req.socket.remoteAddress)` 按有效 IP 判断（127/8、::1、::ffff:127.0.0.1）；**不信任 X-Forwarded-**\* | 同上：远端 socket → 403 `remote_not_local`；本机 → 200 |
| S3 | 未知路径回显 `url.pathname` | 固定 404 `not_found`，不回显 pathname | 同上：含哨兵路径的 404 不含哨兵 |
| S4 | CDP 错误携带 `details.cdpError`（页面/凭据可能外泄） | `CdpConnection` 只返回固定文案，去 `details` | `tax-browser.test.mjs` 64 项保留 + security 套件 |
| S5 | 日志拼接外部 `e.message` / `e.code` | `tax-browser.mjs` `safeErrorCode(_e, fallback)` **只返回调用方给定的固定 fallback 文案**，不读取外部异常的 code / message / details（最终实现为固定 fallback，非正则白名单） | lifecycle 测试：伪造 `tax_browser_secret123456` 等 code 不出现在日志；管理者独立探针已从 true 复验为 false |
| S6 | `READ_PAGE_SCRIPT` 未先校验来源即读取 `document` | 脚本先比对**代码内固定** allowed origin，错误来源返回 `{allowed:false}` 零 DOM 读取；兼容原 `href/title/rows` 快照格式（原 64 断言保留） | lifecycle 测试：错误 origin 零 DOM 读取 |
| S7 | stderr 调试地址正则写成 `ws//`（文件兜底掩盖） | `extractDevtoolsUrlFromStderr` 修正为 `ws://`；`isLoopbackDevtoolsUrl` 用 `URL` 严格校验（仅 `ws://127.0.0.1:<port>/<path>`，拒绝 userinfo/越界端口/根路径） | lifecycle 测试：纯匹配 + 非法地址拒绝 |
| S8 | 空闲会话 TTL 只在下次请求才过期 | 主动 TTL `unref` timer；到点自动 `expired` + 销毁候选 + kill 浏览器 + 删 profile；`destroy` 清 timer | lifecycle 测试：fakeTTL 期间不调 API 即自动过期 |
| S9 | 启动 `await launch/connect/attach` 期间 close/expire/destroy 竞态 | `#guardLate` + 每次 await 后终态复核；`#cleanup` 按捕获句柄幂等清理、先绑句柄再复核、不因 `cleaned` 漏 kill；`destroy` 后拒绝新 session/token | lifecycle 测试（启动中取消 / 迟到资源回收） |
| S10 | 临时 profile 根目录清理竞态（误删未受管目录 / 未决 launch 目录） | `destroy` 只删**自己创建的不可变自建绝对根**；**非递归、仅删空目录**；未决 launch 保留 profile，**后续定向回收**再删空根；不碰不受管哨兵（不声称根自身另做父目录检查） | lifecycle 测试：非递归空根清理 + 哨兵保留 |
| S11 | UI 迟到 `read` / `import`、`close` 失败引用、in-flight 门禁、取消后令牌竞态 | 迟到结果丢弃；失败保留待关闭 sid / 在途 close 门禁；每次 await 后生命周期校验；取消后令牌结果不触发新开 | `test/tax-browser-ui.test.mjs` 24 项 |
| S12 | 生产 `server.mjs` 本地边界（**畸形 Host / 服务存活 / 税局 config 边界 / 旧 REST 与 Agent 入口跨站读写 / 静态页**） | 默认绑 `127.0.0.1`；旧 REST `/api/*` 与 Agent `/agent/*` 在**读写前**校验回环真实 socket、回环 Host、Origin 若存在须精确同源；移除通用 JSON 与旧 OPTIONS 的**全部 CORS 放行头**；税局 OPTIONS 仍 204 且无 CORS；无 Origin 的本机 CLI/MCP 照常可用 | `test/server-local-boundary.test.mjs` **28 项**：畸形 Host 400 / 服务存活、税局 config 边界、**旧 REST 恶意 Origin 合成企业名跨站读拒绝**、跨站 JSON 与 `text/plain` 写拒绝且 DB 未变、**真实 Agent 入口拒绝**、本机同源 / 无 Origin / `localhost` 可用、跨站 OPTIONS 拒绝、静态页正常 |

**旧 REST 绕过修复（收尾发现）**：管理者实际合成探针在收尾阶段复现旧 REST CORS 绕过（恶意 `Origin` 对 `GET /api/account-sets` 返回 200 + `Access-Control-Allow-Origin: *` + 合成企业名）。已由员工修复（`0293ed2`，只追加 `server/server.mjs` 与 `test/server-local-boundary.test.mjs`），并由管理者审阅实际 diff 及全套独立重验。修复后旧 REST `/api/*` 与 Agent `/agent/*` 在读写前均校验回环真实 socket、回环 Host、Origin 若存在须精确同源；恶意 Origin 预检 403；移除通用 JSON 与旧 OPTIONS 的全部 CORS 放行头；原税局 OPTIONS 保持 204 无 CORS（浏览器预检不获授权，**不能一概写所有 OPTIONS 都 403**）；静态文件回环访问不变。

> 上述为**当前工作区的代码事实 + 合成测试**；安全套件 18 项、lifecycle 26 项、UI 24 项、`server-local-boundary` **28 项**均随 15 套 **496 项**由本机管理者复跑通过（exit 0，代码验证 head `0293ed2`）。

### 5.2 尚未完成（不预报、不冒称完成）

- **跨成员 Codex 复核尚未获得**（[团队协作协议 §8](TEAM-COLLABORATION.md)：触碰会计核心 / 共享接线 / 数据边界 → 至少另一名成员本机 Codex 独立复核）；本分支保留**待复核**，未获得前不冒称已合并。
- 改动**已提交（初轮 `866fc30` + 收尾修复 `0293ed2`）并开 PR [#19](https://github.com/huxiaoyang-code/youshu-fork/pull/19)（未合并、待跨成员复核）**；`origin/main` 仍 `d0221df`；最终 PR head 以 PR 当前提交为准，代码验证 head 用 `0293ed2`。
- 第一步**本机独立验收已通过**（15 套 496 项 + smoke 28/28），但**不能据此称 A0 已合并**。
- 真实税局登录、页面布局识别、凭据/验证码全链路：**未验收**（第二步，需用户本机）。全国真实接入 **0**。
- **Issue #13 保持 OPEN**（总任务后续部分和真实验证尚未完成；既有源码外发 / 自动合并授权仍有效，无需重问用户；跨成员复核门槛独立存在），不因本机验收关闭。

## 6. 边界与结论

- 草稿能做的：**本机官方 Edge/Chrome 人工登录后只读识别福建漳州「办税员可访问企业」并建/绑空账套**；不接全国、不抓 cookies、不造凭证 / 期初。
- 草稿不能证明的：**企业列表 ≠ 科目 / 期初 / 凭证 / 银行 / 发票**，不能据企业候选推断自动财务闭环成立。
- 本轮：**第一步本机独立验收通过**，代码已提交（初轮 `866fc30` + 收尾修复 `0293ed2`）并开 PR [#19](https://github.com/huxiaoyang-code/youshu-fork/pull/19)（未合并、待跨成员复核），但**未获跨成员复核 / 未合并**，不能称 A0 已完成或已合并；**不得因 A0 而关闭总 Issue #13**（总任务后续部分和真实验证尚未完成；既有源码外发 / 自动合并授权仍有效，无需重问用户；跨成员复核门槛独立存在，Issue #13 保持 OPEN）。
