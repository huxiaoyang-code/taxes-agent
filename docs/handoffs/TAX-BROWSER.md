# TAX-BROWSER 草稿交接（**历史记录，非当前状态**）

> ⚠️ **历史标识**：本文件是 `tax-browser` 草稿员工在基线 `9783420` 上的**原始交接记录**，为追溯保留。**它不是当前实现状态，也不是本轮 RC-A0 的活交接，更不是接口全文迁移**（草稿接口全文仍在**只读原件 / 副本**：历史负责人本机 worktree `.worktrees/tax-browser` 及其 `docs/TAX-BROWSER.md`）。
> - 当前状态以 [RC0-SNAPSHOT](RC0-SNAPSHOT.md) 与 [REVIEW-TAX-BROWSER](../REVIEW-TAX-BROWSER.md) 为准（第一步本机独立验收通过（15 套 496 项，代码验证 head `0293ed2`）；代码已提交（初轮 `866fc30` + 收尾修复 `0293ed2`）并开 PR [#19](https://github.com/huxiaoyang-code/youshu-fork/pull/19)，未合并、待跨成员复核）。
> - 草稿原目录（历史负责人本机路径，例如 `D:/有数云fork/.worktrees/tax-browser`）**只读保留、未合并**；草稿自报数字**不作为结论**。
> - 本文的「员工阶段完成 / 待管理者审查验收」等表述均为**当时记录**；本轮审查后草稿已选择性整合；**RC-A0 第一步本机独立验收通过（2026-10-17，15 套 496 项，代码验证 head `0293ed2`），代码已提交（初轮 `866fc30` + 收尾修复 `0293ed2`）并开 PR #19（未合并、待跨成员复核，创建时为 draft、实时 draft/ready 以 GitHub 为准）**，草稿本身**未合并**。

---

原草稿交接内容（保留原文，日期与数字为当时事实）：

- 状态：**员工阶段完成，待管理者审查验收**（未提交、未合并——按任务单不做 Git 操作）。
- 基线：main `9783420`；worktree `D:/有数云fork/.worktrees/tax-browser`（**历史负责人本机绝对路径，非跨机默认**；分支未提交，改动全部留在工作区）。
- 任务：福建省漳州市真实浏览器登录税局后获取办税员可访问企业，勾选批量建账 / 新建账套后绑定导入基本信息。全国目标保留，其他地区明确未支持。
- 接口文档：`docs/TAX-BROWSER.md`（能力边界、API、安全与测试清单的完整说明）。

## 交付内容（当时）

新增（均在 `06-workbench/`，另有 `docs/TAX-BROWSER.md`）：

| 文件 | 说明 |
|---|---|
| `server/tax-browser.mjs` | 采集服务：地区白名单（仅 350000/350600）、税号严格校验、标签配对提取、页内固定只读脚本、Edge/Chrome 固定路径探测 + 随机临时 profile/incognito + CDP（仅回环）、会话/令牌/TTL/上限/终态保护与 profile 定向清理 |
| `server/tax-import.mjs` | 导入落库：批量新建空账套（事务原子）、绑定空账套（幂等、占用冲突、名称变更须显式确认）、同税号幂等不覆盖 |
| `server/tax-browser-http.mjs` | `/api/tax-browser/{config,sessions,sessions/:sid/(read\|close\|import)}`：回环 Host + 同源 Origin + 一次性 loginToken + 严格 JSON + 无 CORS 头 |
| `test/tax-browser.test.mjs` | 64 项：纯函数 + 注入假浏览器/CDP 的服务测试 + 真实 node:http 接线 + 生产 server 负路径；不访问真实税局、不启动真实浏览器 |
| `docs/TAX-BROWSER.md` | 接口与边界文档 |

修改（最小）：`server/db.mjs`（新增 `tax_enterprise_bindings` 表）、`server/server.mjs`（挂载路由 / OPTIONS 不发 CORS / 默认回环 / 信号清理）、`public/index.html` / `public/app.js`（税局导入对话框）、`scripts/test-all.mjs`（追加 tax-browser 套件）、`package.json`（`test:taxbrowser`）、`README.md`（06-workbench 与根）。未改旧测试断言；未改 TAX 网关 7 接口。

## 测试命令与结果（员工自报，当时）

```
cd 06-workbench
npm test                 # 自报 7 套 272 项全部通过（guards 23 / derived 31 / smoke 28 / tax-browser 64 / contract 44 / workflow 23 / tax 59），exit 0
npm run test:taxbrowser  # 单独 64 项
```

> ⚠️ 上述 272 为**员工自报**；**管理者后来独立复跑**（获批复验）确为 7 套 272 项、exit 0，见 [RC0-SNAPSHOT §4](RC0-SNAPSHOT.md)。历史员工进程退出码**仍未知**，不与复跑 exit 0 混同。

## 真实浏览器链路的人工验证（当时，未访问真实税局）

用 `about:blank` 对「Edge + `--remote-debugging-port=0` + 内置 WebSocket CDP + `Target/Runtime` + `Browser.close` + 临时 profile 清理」整链路做过人工联调；**不等于真实税局接入验收**。

## 明确的局限（当时，仍然有效）

1. **真实福建账号验收未做**：需人工在真实窗口登录 `https://etax.fujian.chinatax.gov.cn/`，确认「办税员可访问企业」列表页能被标签配对规则识别；布局不覆盖时按失败关闭（`tax_browser_layout_unrecognized`），不假成功。
2. `allowedOrigins` 当时只含 443/8443；统一认证跳转等其它域名需先观察再白名单化。
3. 自动测试中的「浏览器」全部是**假实现**；生产 HTTP 无任何 fake 开关或任意目标参数。
4. 会话是进程内存态，服务重启即失效。
5. 未做 MCP/Agent 工具注册（范围为 UI + HTTP API）。

## 当时验收建议（管理者）

1. `cd 06-workbench && npm test` 复跑（预期 7 套 272 项）。
2. `npm start` 后打开工作台 → 「🏦 税局导入企业」→ 「打开官方登录窗口」。
3. 真实账号人工登录 → 「我已登录，读取当前企业页」；识别失败应看到明确错误而非假数据。
4. 导入后账套下拉可见新账套、科目表已载入、无凭证/期初；`tax_enterprise_bindings` 有溯源记录。
5. 「关闭本地采集会话」后浏览器窗口关闭、临时 profile 目录被清理。

---

**后续状态请勿引用本文判断**；以 [REVIEW-TAX-BROWSER](../REVIEW-TAX-BROWSER.md)、[RC0-SNAPSHOT](RC0-SNAPSHOT.md)、[DATA-AVAILABILITY](../DATA-AVAILABILITY.md) 为准。
