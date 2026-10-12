# 有数云「代账」网站解析 — REA 证据归档

- **用户给定地址**：`https://daizhang.youshu.yuork/`（**该域名不存在**，公共 DNS 全部 NXDOMAIN）
- **实际分析目标**：`https://daizhang.youshu.yun/` → 302 → `/work/`，未登录跳转 `/finance/login`
- **站点身份**：有数云（YOUSURE）· 司书财税大模型 · AI 财税智能体与企业财税工作台
- **分析工具**：REA 6.4.0（CDP 被动观察 + 静态 JavaScript 应用重建），浏览器 Chrome/155
- **分析时间**：2026-10-12
- **授权边界**：仅被动观察 + 静态分析 + 公开资源下载；**未登录、未提交表单、未做任何主动利用**

> ⚠️ 目标地址更正说明见 [`00-recon/dns-corrected-url.md`](00-recon/dns-corrected-url.md)。
> 若你本意是别的内网主机，请提供可解析的地址后重跑。

---

## 一、结论速览

| 项 | 结果 |
|---|---|
| 应用形态 | 两个独立 Vite + React SPA（`/work` 工作台、`/finance` 登录开户） |
| UI 库 | Ant Design；图表 Mermaid；公式 KaTeX；HTTP axios；监控 Sentry |
| 后端前缀 | `/api`（工作台）、`/finance-api`（鉴权/开户） |
| 业务域 | AI 会话/子智能体、账套、凭证、发票、报税申报、财务报表、计费 Token、企业微信/clawbot 接入、邀请返利 |
| 鉴权 | 同域 Cookie（axios `withCredentials: true`），微信扫码 + 短信验证码登录 |
| 发现接口 | **67** 条候选（静态），实时仅观察到 `GET /finance-api/wechat-login/status` |
| WebMCP | 0 个页面声明工具 |
| Source map | 无（`.map` 全部 404） |
| 主要缺口 | 鉴权后页面未执行；动态分包部分未覆盖（已尽量补齐下载） |

---

## 二、目录分类（产出物）

```
D:/有数云fork/
├── REPORT.md                     ← 本文件（总索引）
├── 00-recon/                     侦察证据
│   ├── dns-corrected-url.md      域名更正 + DNS 证据
│   ├── http-headers.txt          响应头摘要
│   └── index.html                /work/ 首页 HTML
├── 01-capture/                   REA 实时被动抓取
│   ├── inspect-web-page.json     DOM/无障碍/脚本/网络/存储（2.0 MB）
│   ├── screenshot.json           截图 Evidence
│   ├── screenshot.png            登录页截图（1418×802）
│   └── login-page-analysis.md    登录页可读摘要
├── 02-scripts/                   前端脚本（按应用分类）
│   ├── work/                     /work 工作台 bundle + 已补齐的动态分包
│   └── finance/                  /finance 登录应用（REA 导出 + manifest）
├── 03-analysis/                  REA 分析原始证据（JSON）
│   ├── analyze-web-bundle.json   实时 /finance 包分析
│   ├── work-app-analysis.json    /work 应用图（33 MB→11 MB）
│   ├── finance-app-analysis.json /finance 应用图（16 MB）
│   ├── webmcp-tools.json         WebMCP 清点
│   ├── export-web-scripts.json   脚本导出清单
│   ├── api-endpoints.json        接口聚合（可读版见 04-report/04）
│   ├── routes.json               路由
│   └── chunks.json               分包与指纹
├── 04-report/                    可读报告（按主题分类）
    ├── 01-app-overview.md
    ├── 02-frontend-architecture.md
    ├── 03-routes.md
    ├── 04-api-endpoints.md
    ├── 05-feature-map.md
    ├── 06-tech-stack-and-thirdparty.md
    ├── 07-security-observations.md
    ├── 08-method-and-evidence.md
    ├── 09-unknowns-and-limits.md
    └── build_report.py           由原始 JSON 重新生成以上报告

├── 05-reconstruction/           业务域复刻（Codex 作为客户端）
    ├── ARCHITECTURE.md           ★ 复刻方案与证据（先读这个）
    ├── catalog.json              从 bundle 提取的 Agent 契约
    ├── extract_catalog.py       契约提取脚本
    ├── generate_skill_stubs.py  Skill 模板生成脚本
    └── codex/                   可运行的 Codex + MCP 骨架
        ├── config.toml
        ├── README.md
        ├── skills/              5 个子智能体 / 21 份规则模板
        └── mcp/finance-mcp/     MCP Server（22 工具，已冒烟通过）

└── 06-workbench/                ★ 记账 + 报表 MVP（可运行）
    ├── README.md               启动与 API 说明
    ├── server/                 HTTP + 记账引擎 + 科目表 + SQLite
    └── public/                 网页（账套/凭证/科目/期初/报表/期间）
```

---

## 三、复刻业务域（Codex 直接做客户端）

**关键发现**：`/work` 财税工作台本身就是 **OpenAI Codex app-server 的客户端**——
它连接 `POST /api/agent/runtime-ticket` 换取票据，再以
`WebSocket` 子协议 `codex-runtime-ticket.<ticket>` 连接 Codex，渲染
`agentMessage / reasoning / dynamicToolCall / collabAgentToolCall / subAgentActivity` 等原生事件。
所以「用 Codex 做客户端」不是近似方案，而是**还原它本来的架构**。

要复刻的业务域只有两层（详见 [`05-reconstruction/ARCHITECTURE.md`](05-reconstruction/ARCHITECTURE.md)）：

1. **5 个子智能体**：导入旧账 / 智能核算 / 全税种申报 / 个税申报 / 智能开票。
2. **22 个业务工具 + 21 项财务查询能力 + 21 份业务规则(Skill)**：
   `finance_query`、`voucher_create`、`invoice_issue`、`declaration_query` 等。

唯一阻塞项是**财税后端**（记账/发票/申报引擎在服务端，包里没有）。
`05-reconstruction/codex/mcp/finance-mcp/` 已提供可运行的 MCP Server 骨架，
只需实现 `backend.mjs` 接上你的后端。

---

## 四、记账 + 报表 MVP（已可运行）

按你的要求，先落地**记账与报表**，发票/申报留空返回 `not_implemented`。

```bash
cd 06-workbench && node server/server.mjs   # → http://127.0.0.1:8787/
```

- 后端：Node + `node:sqlite`（零 npm 依赖）
- 网页：账套、凭证（借贷平衡校验/过账/反过账）、科目、期初、期间结账、
  报表（科目余额表·试算平衡 / 资产负债表 / 利润表 / 明细账）
- 与 Codex 打通：`finance-mcp` 默认指向 `http://127.0.0.1:8787`，
  Codex 可用 `voucher_create` / `voucher_check` / `finance_query` 直接记账出报表
- 已用样例数据验证：试算平衡、资产负债表平衡、利润表净利润正确

详见 [`06-workbench/README.md`](06-workbench/README.md)。

---

## 五、证据台账（Evidence IDs）

| Evidence ID | 操作 | 权威性 | 说明 |
|---|---|---|---|
| `ev_f3601e802d4d6f03d581ba635436a115f64ba5edb35d267ba7f8f1d9bcb16837` | `list_browser_targets` | external-service / observed | 发现页面 `有数云 - AI财务数字员工` |
| `ev_5cf4d9b1e50fc3c9ac5368b003cd4c3095854144637c0a478fe8781101189311` | `inspect_web_page` | observed | DOM/无障碍/网络/存储 |
| `ev_8143096ed11a6dabe7f482a820efc5b9c1aceb597cbd153c81905dc11124326d` | `capture_web_screenshot` | observed | 登录页像素 |
| `ev_66f34fbf3a16eb24431d8ad24f58769b4315e27f65d8ed84227505cb819b6962` | `analyze_web_bundle` | observed→derived | /finance 路由、接口、指纹 |
| `ev_777535033dbadd0cf3825cfde692652d5cbd3ea6947ff1719b0673d25d644c84` | `analyze_javascript_application` | shipped-artifact / derived | /finance 静态应用图（subject sha256 `7d24efa8…`） |
| `ev_ad4fac8e260b2234518c88fa9d3345b023703c1cfd585f2dea8044444f2011c0` | `analyze_javascript_application` | shipped-artifact / derived | /work 静态应用图（subject sha256 `c39a1f31…`） |
| `ev_7f835b30fd5c538787813255527a00039addde094442d0096a5d1fc2d7d0754d` | `discover_webmcp_tools` | observed | 0 个工具 |
| `ev_4e3f22c872cc3ec4e6e191a213435ef41368d55324ae0dea23991120046cf2c2` | `export_web_scripts` | observed | 导出 7 个 /finance 脚本 |

---

## 六、如何阅读 / 复现

- 快速了解：先读本文件，再读 `04-report/01` → `05`。
- 接口/路由：`04-report/04-api-endpoints.md` 与 `03-analysis/api-endpoints.json`。
- 原始证据：`03-analysis/*.json`（REA 规范 Evidence，含 limitations/coverage）。
- 重新生成报告：`python 04-report/build_report.py`（只读本地 JSON，不联网）。
- 未覆盖范围：`04-report/09-unknowns-and-limits.md`。
