# RC0-SNAPSHOT · tax-browser 隔离快照与复验记录

> 版本化交接（按 [handoffs/TEMPLATE](TEMPLATE.md) 必要字段精简）。只写可核验事实，不含原文 / 凭据 / 日志。

## 1. 基本信息

- 任务 ID / 状态：RC-A0（RC-0 第一步，`TAX-BROWSER-REVIEW`）— **第一步本机独立验收通过（2026-10-17，15 套 496 项 + smoke 28/28、exit 0，代码验证 head `0293ed2`）；代码已提交（初轮 `866fc30` + 收尾修复 `0293ed2`）并开 PR [#19](https://github.com/huxiaoyang-code/youshu-fork/pull/19)，未合并，待跨成员 Codex 复核**。
- 负责人：`huxiaoyang-code`；执行员工：pi（最初整合为 GLM 5.3，后续为 DeepSeek V4.1 Flash；每次主 / 回退显式锁定同一获准模型，无子 agent / 其他模型）；本机管理者：负责人本机 Codex。
- 分支：`codex/huxiaoyang-code/rc-a0-review`（隔离 worktree `<repo>/.worktrees/rc-a0-review`）。
- 关联 Issue：[#13](https://github.com/huxiaoyang-code/youshu-fork/issues/13)（OPEN，`Refs #13`，不 Closes）。
- 目标 / 不做：复审并选择性整合 tax-browser 草稿、审计安全边界、出第一步证据；**不做**功能扩展、不重做、不覆盖报表成果、不做真实登录。

## 2. 基线与已审核 head

- 基线（分叉时 `origin/main` 完整 SHA）：`d0221df1d18e2bfcbd7db2cc9aa0875ab32a7fd4`（含 PR #15 报表 + PR #16 团队文档）。
- 已审核 head：初轮 `866fc308cd77bbce85d23de0b641a2e05682b3a9`（`866fc30`，14 个已验证代码 / 测试文件）为历史；**最终代码验证 head `0293ed21968864d7bbabb071a7a0234fb9dbfbd6`（`0293ed2`）**，收尾安全修复只追加 `server/server.mjs` 与 `test/server-local-boundary.test.mjs`，不动会计 / 报表 / MCP 业务模块；分支仍为 `codex/huxiaoyang-code/rc-a0-review`。
- 合并 SHA：**未合并**（PR [#19](https://github.com/huxiaoyang-code/youshu-fork/pull/19) 开放、创建时为 draft（实时 draft/ready 以 GitHub 为准）；`origin/main` 仍 `d0221df`；**不能写开放 PR 为空 / 未建 PR**）。最终 PR head 以 PR 当前提交为准（本文件后续文档提交不改变已验证代码 head）。
- 草稿原件基线：`9783420a84dae2fe8a4c4b3021c07947b66fec00`（旧草稿原件仍 14 文件未提交 / 未 PR，属历史，不改写）。
- 交接对象：跨成员 Codex 复核（按 [团队协作协议 §8](../TEAM-COLLABORATION.md)）、后续 RC-1。

## 3. 快照内容

- **原件 14 个未提交文件**（逐条 SHA256 与 `<repo>/.agent-runs/import-strict-tax-preservation.json` **全部一致**；`<repo>` 为本地克隆根）：

| # | 路径 | SHA256 |
|---|---|---|
| 1 | `06-workbench/server/tax-browser-http.mjs` | `698A196911E6FB1ED14946185BFF54FD3D6D48279B80F53B26F292AD304D8E8A` |
| 2 | `06-workbench/server/tax-browser.mjs` | `5243DB03B4B8F67CB7135D597F320DCC0C95146A72FA1BD39D697333E3B67239` |
| 3 | `06-workbench/server/tax-import.mjs` | `764C312EF7FE9578848998BCAFD60AC20358953BE1414D4FB5D978F47C165090` |
| 4 | `06-workbench/test/tax-browser.test.mjs` | `D42DE7424892F727F55C8F6E90A66C9622A13BE022F1382BF14300BFD6F3DDD7` |
| 5 | `docs/TAX-BROWSER.md` | `4B46C898F3819DB5F33C18DE3ACF96CA5809611F85361366D5CD284CCB9ACB9F` |
| 6 | `docs/handoffs/TAX-BROWSER.md` | `8F8130F109438AAF120E30EFCEB50B1DE24803711B41B7C1408CBC0E41011C28` |
| 7 | `06-workbench/README.md` | `E23F1F50A0343E4319E40F05C187C4D79B835F6AB8B12211F1BFCABEB6875D13` |
| 8 | `06-workbench/package.json` | `286D1A967C5E11A42B503689BCC11D301590016E6910FD402530661B20452AE4` |
| 9 | `06-workbench/public/app.js` | `08A05525EAA7E5B0797634E6621436215CCAAF4CE665059E119A4C0BE5B7BD19` |
| 10 | `06-workbench/public/index.html` | `099E734263B66292D480A3A64E77EBA41345EE7F33F1A40D702ECF7529F78EB0` |
| 11 | `06-workbench/scripts/test-all.mjs` | `6DF65D03072188F743F026CDB5D5BE0C3887F52A979FD9A5B02448084CC7445C` |
| 12 | `06-workbench/server/db.mjs` | `2368116DD57A5B9DD4D04F718BFAE97A0D9A4E91AA5564231C991AEC30534BC8` |
| 13 | `06-workbench/server/server.mjs` | `EEE3DAF249585D880812DC18008F57D6450C369EB60B8B53AB759F723CE257C0` |
| 14 | `README.md`（根） | `F94A8CCCA9E2DF33F51268BC75F41AEAA32A09EC9E18A905E2FE7213734E9289` |

- 只读旧基线副本 `<repo>/.worktrees/rc-a0-reproduce`（基线 `9783420`）：14/14 亦与清单一致。
- 隔离方式：**只复制源码 / 文档**；**无 DB / 凭据 / profile / 旧日志**。
- 原件 `<repo>/.worktrees/tax-browser` **只读未改**，不重置 / 不删除 / 不重写。

## 4. 复验记录

| 项 | 结果 | 证据（本机 `.agent-runs/`，Git 忽略） |
|---|---|---|
| 原件 14/14 哈希核对 | 一致 | `import-strict-tax-preservation.json` |
| 旧草稿沙箱首跑 | 5 套失败（EACCES 回环限制） | `rc-a0-original-tests.log` / `.exit`=1（保留，不算业务失败） |
| 旧草稿管理者获批复跑（**2026-10-16**） | **7 套 272 项，exit 0** | `rc-a0-original-approved.log` / `.exit`=0 |
| 最新 main 基线（PR #15） | 10 套 336 项，exit 0（合成临时库；既有历史事实） | 见 [STATE](STATE.md) |
| **本机独立验收（2026-10-17，最终 `0293ed2`）** | **15 套 496 项，exit 0** + `npm run test:smoke` **28/28，exit 0** | `rc-a0-manager-tests-v2.log` / `.exit`、`rc-a0-manager-smoke-v2.log` / `.exit`（仅本机，不作为同事前置；初轮 `.log/.exit` 为历史） |

- **日期区分**：原件保留与旧草稿 272 项复验实际发生于 **2026-10-16**；**2026-10-17** 是本次 A0 收尾（整合 + 独立验收）。
- 分套（本机复跑，准确值，最终 `0293ed2`）：guards 23、derived 31、import-strict 54、report-export 21、report-export-http 29、tax-report-format 24、smoke 28、tax-browser 64、tax-browser-security 18、tax-browser-lifecycle 26、tax-browser-ui 24、server-local-boundary **28**、contract 44、workflow 23、tax 59，合计 **496**。**仅 `server-local-boundary` 由初轮 13 增至 28（追加 15 项），其他分套不变。初轮 `866fc30` 为 15 套 481 项、`server-local-boundary` 13 项（历史）。**
- 验证前后 `server` / `public` / `scripts` / `test` / `package` 共 **29 文件 SHA256 一致**（元数据 `rc-a0-verified-source-hashes-v2.json`，仅本机忽略、不作为同事先决）；原件 14/14 仍一致；`accounting` / `coa` / 报表模块、原有主线测试、MCP **均无 diff**。
- 员工历史自报 272 与管理者复跑一致，但**以管理者复跑为准**；历史员工进程退出码**仍未知**。
- **员工进程交接摘要**：当前本轮执行员工均已结束，管理者核实 **exit 0**：stage1-retry、http、browser、ui、docs、ui-review、runner、ui-review2、logfix、rootfix、docs-final（上一 docs-final 包进程已由管理者核实退出 0）；执行模型为**最初整合 GLM 5.3 + 后续 DeepSeek V4.1 Flash**，每次主 / 回退锁定同一获准模型，**无子 agent**。`browser-review` 被管理者**停止（exit -1）且无该次修改**，后拆为 logfix / rootfix 完成，**不算成功**；**历史草稿员工退出码仍未知**。不在每份文档堆完整模型调用历史。

## 5. 限制与未越界声明

- 已提交代码 head：初轮 `866fc30` 为历史；**最终代码验证 head `0293ed2`（收尾安全修复，只追加 `server/server.mjs` 与 `test/server-local-boundary.test.mjs`）**；**PR [#19](https://github.com/huxiaoyang-code/youshu-fork/pull/19) 开放，未合并（创建时为 draft，实时 draft/ready 以 GitHub 为准）**；后续文档提交不改已提交代码，最终 PR head 以 PR 当前提交为准，代码验证 head 用 `0293ed2`。
- **真实登录未验收**，全国真实接入 **0**；企业候选 ≠ 财务数据。**Issue #13 保持 OPEN**。
- 含共享接线与数据边界：按 [团队协作协议 §8](../TEAM-COLLABORATION.md) **待另一名成员 Codex 独立复核**，未获得复核前不冒称已合并。
- 临时数据 / 合成测试；**未触碰真实库 / 凭据 / profile / 税局**；未覆盖生产库，未绕过沙箱。

## 6. 下一步

1. 已完成：管理者提交初轮 `866fc30` 并建 PR [#19](https://github.com/huxiaoyang-code/youshu-fork/pull/19)（创建时为 draft）；收尾安全修复提交 `0293ed2` 并由管理者审阅 diff + 独立重验（15 套 496 项），已附当前 Codex 任务；文档提交推送后管理者转 ready 并按团队 §8 请求成员 `xiaoyihaishiaini` 本机 Codex 复核（**当前未获得**）。
2. **跨成员复核通过后**才进入合并门槛；最终 PR head 以 PR 当前提交为准，**不预报 merge**。
3. 第二步：用户本机真实登录 + 数据可得性矩阵逐项核对（见 [DATA-AVAILABILITY](../DATA-AVAILABILITY.md)），客观判定数据链路是否成立；真实税局登录**仍未验证**，全国真实接入 0。

## 7. 未触碰 / 回退

- 未触碰：原 `tax-browser` 现场、`rc-a0-reproduce` 副本、`accounting.mjs` / `coa.mjs` 报表模块、PR #15 报表成果与 IMPORT-STRICT。
- 回退：如需回退，开**新的 revert PR**，不建议直接丢掉已提交（`866fc30` + `0293ed2`）的成果；**禁止重写 main 历史**。
