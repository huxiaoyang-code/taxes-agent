# -*- coding: utf-8 -*-
"""Aggregate REA evidence captured for the 有数云 / 代账 target into
categorised, plain-language reports.

Reads only the JSON artefacts produced by the REA tools in this folder.
Never re-fetches the target. Run:  python 04-report/build_report.py
"""
import json, os, collections, io, re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

def load_lines(path):
    with io.open(os.path.join(ROOT, path), encoding="utf-8") as fh:
        return [json.loads(l) for l in fh if l.strip()]

def jload(path):
    with io.open(os.path.join(ROOT, path), encoding="utf-8") as fh:
        return json.load(fh)

def write(path, text):
    full = os.path.join(ROOT, path)
    os.makedirs(os.path.dirname(full), exist_ok=True)
    with io.open(full, "w", encoding="utf-8") as fh:
        fh.write(text)
    print("wrote", path)

# ------------------------------------------------------------------ evidence
bundle  = jload("03-analysis/analyze-web-bundle.json")
page    = jload("01-capture/inspect-web-page.json")
shot    = jload("01-capture/screenshot.json")
webmcp  = jload("03-analysis/webmcp-tools.json")
exports = jload("03-analysis/export-web-scripts.json")
work    = load_lines("03-analysis/work-app-analysis.json")[-1]
fin     = load_lines("03-analysis/finance-app-analysis.json")[-1]

EV = {
    "targets":    "ev_f3601e802d4d6f03d581ba635436a115f64ba5edb35d267ba7f8f1d9bcb16837",
    "bundle":     bundle["evidence_id"],
    "page":       page["evidence_id"],
    "screenshot": shot["evidence_id"],
    "webmcp":     webmcp["evidence_id"],
    "export":     exports["evidence_id"],
    "work":       work["evidence_id"],
    "finance":    fin["evidence_id"],
}
WORK_SHA = work["subject"]["digest"]["sha256"]
FIN_SHA  = fin["subject"]["digest"]["sha256"]
WORK_BUNDLE_SHA = "098e3f59318305abace7f8f600fac22986f7102438af73c652266b716fe0265e"

# ---------------------------------------------------------------- endpoints
def collect_endpoints(analysis, base, app):
    out = []
    for n in analysis["normalized_result"]["graph"]["nodes"]:
        if n.get("kind") != "endpoint":
            continue
        for o in n.get("observations", []):
            p = o.get("properties", {}) or {}
            mech = str(p.get("mechanism"))
            val = str(p.get("value"))
            if not mech.startswith("call:"):
                continue
            if val.startswith("thread/") or val.startswith("/"):
                method = mech.split(".")[-1].upper()
                if method not in ("GET", "POST", "PUT", "DELETE", "PATCH"):
                    method = "CALL"
                # agent runtime protocol methods are not under the axios base
                b = "" if val.startswith("thread/") else base
                out.append({"app": app, "base": b, "method": method, "path": val,
                            "provenance": "REA static analysis", "evidence_id": analysis["evidence_id"]})
    return out

eps = collect_endpoints(work, "/api", "work") + collect_endpoints(fin, "/finance-api", "finance")

# literal-string endpoints found by searching the exported /work bundle
work_bundle_text = io.open(os.path.join(ROOT, "02-scripts/work/index-yoSd2Nx7.js"),
                           encoding="utf-8", errors="ignore").read()
literal_paths = sorted(set(re.findall(r'["`](/api/[a-zA-Z0-9_./{}$:-]+)["`]', work_bundle_text)))
for p in literal_paths:
    p = re.sub(r"\$\{[^}]+\}", "{id}", p)
    eps.append({"app": "work", "base": "", "method": "ANY", "path": p,
                "provenance": "literal string search of exported bundle",
                "evidence_id": WORK_BUNDLE_SHA})

seen, uniq = set(), []
for e in eps:
    k = (e["app"], e["method"], e["path"])
    if k in seen:
        continue
    seen.add(k)
    uniq.append(e)
uniq.sort(key=lambda e: (e["app"], e["path"], e["method"]))

live_eps = [{"method": r.get("method"), "url": r.get("url"), "status": r.get("status"),
             "resource_type": r.get("resource_type")}
            for r in page["normalized_result"]["network"]["requests"]]

write("03-analysis/api-endpoints.json", json.dumps({
    "note": "Statically discovered request paths. 'base' is the axios baseURL observed in each bundle "
            "(work app baseURL='/api', finance app baseURL='/finance-api'). Paths are candidates; static "
            "strings do not prove runtime execution.",
    "evidence": {"work_analysis": EV["work"], "finance_analysis": EV["finance"], "live_page": EV["page"]},
    "endpoints": uniq, "live_observed": live_eps,
}, ensure_ascii=False, indent=2))

routes = [r["value"] for r in bundle["normalized_result"]["observations"]["routes"]]
write("03-analysis/routes.json", json.dumps({
    "finance_routes_observed": routes, "work_entry": "/work/",
    "auth_redirect": "/finance/login?redirect=<original>", "evidence": EV["bundle"],
}, ensure_ascii=False, indent=2))

chunks = bundle["normalized_result"]["observations"]["chunks"]["nodes"]
write("03-analysis/chunks.json", json.dumps(
    {"chunks": chunks, "artifacts": bundle["normalized_result"]["capture"]["source_artifacts"]},
    ensure_ascii=False, indent=2))

# ------------------------------------------------------------------ reports
def tbl(rows, header):
    out = ["| " + " | ".join(header) + " |", "|" + "|".join(["---"] * len(header)) + "|"]
    for r in rows:
        out.append("| " + " | ".join(str(c).replace("|", "\\|") for c in r) + " |")
    return "\n".join(out)

# --- feature keywords observed in the /work bundle
kw = ["代账","凭证","发票","申报","税","账套","报表","客户","企业","智能","模型","会话","员工",
      "银行","对账","利润","资产","现金流","子智能体","开票","办税员","个税","社保"]
strs = re.findall(r'"([^"\\\n]{3,30})"', work_bundle_text) + re.findall(r"'([^'\\\n]{3,30})'", work_bundle_text)
feature_hits = collections.Counter(s for s in strs
                                   if any(k in s for k in kw) and not s.startswith(("http", "/", "./", "data:")))
feature_rows = [(s, c) for s, c in feature_hits.most_common(45)]

write("04-report/01-app-overview.md", u"""# 01 · 应用概览 / App overview

**观察 (observed)**：目标站点是「有数云」企业财税 SaaS，页面标题为
`有数云 - AI财税智能体与企业财税工作台 | 司书大模型`，登录页品牌标识为 `有数云 YOUSURE`、
`司书财税大模型`，登录方式为「微信扫码登录」。
证据：{page}、{screenshot}。

站点由两个独立的 Vite 构建 SPA 组成：

| 路径 | 角色 | 技术 | 证据 |
|---|---|---|---|
| `/work/` | 财税智能工作台（代账主应用，AI 会话 + 账套/凭证/申报工具） | Vite + React，单包 `index-yoSd2Nx7.js`（2.4 MB） | {work} |
| `/finance/` | 登录 / 注册开户 / 选择账套（Auth & onboarding） | Vite + React + Ant Design | {bundle}、{finance} |

未登录访问 `https://daizhang.youshu.yun/work/` 时，前端/服务端重定向到
`/finance/login?redirect=%2Fwork%2F`，说明 `/finance` 是鉴权外壳，`/work` 是业务工作台。

## 证据摘录

- 浏览器目标标题：`有数云 - AI财务数字员工`，最终 URL 为 `/finance/login?redirect=.../work/`
  （{targets}）。
- 首页 HTML `<meta name="description">`：*基于司书财税大模型的企业财税智能工作台，支持财税问答、记账报税、
  规则核验与经营分析*。
- 无障碍树根节点名称：`有数云 - AI财务数字员工`，含「司书财税大模型」「微信扫码登录」文本（{page}）。

**推断 (inferred)**：`/work/` 是被 `daizhang`（代账）业务复用的有数云 AI 工作台前端，
后端接口以 `/api` 为前缀；`/finance` 使用独立的 `/finance-api` 前缀。
两者共用同一 Sentry 项目和同一域名。
""".format(**EV))

write("04-report/02-frontend-architecture.md", u"""# 02 · 前端架构 / Frontend architecture

## 构建与运行时（观察）

- 打包器：**Vite**（`import.meta`/ESM preload + `assets/*.js` 哈希命名），由 REA 的
  `bundle_runtime` 指纹推断，置信度 medium（{bundle}）。
- 框架：**React**（`react-vendor-*.js`，`vendor_fingerprint: React`，置信度 medium）。
- UI 组件库：**Ant Design**（`antd-vendor-*.js`、`antd-date-vendor-*.js`；DOM 中大量
  `data-rc-order` / `data-css-hash` 运行时样式标记，{page}）。
- HTTP 客户端：**axios**（`axios.create(...)`，`baseURL` / `withCredentials` 字段可见）。
- 图表/文档渲染：**Mermaid**（`mermaid.core-*.js` 动态导入）与 **KaTeX**
  （`gullet.macros.get` 调用，公式渲染）。
- 错误监控：**Sentry**（`sentry.sample_rate`、`sentry.dsc`、`traceparent`、`baggage`）。
- 可选：`xlsx`（电子表格导出，`/results/export` 相关逻辑）。

## `/finance` 已观察到的分包（观察）

{tbl}

（`scripts_observed=7`，`scripts_analyzed=7`，解析失败 0，`completeness: partial`。证据 {bundle}）

## `/work` 工作台分包（推断）

本地已保存主包 `02-scripts/work/index-yoSd2Nx7.js`（SHA-256
`{WORK_BUNDLE_SHA}`）。REA 静态分析识别出 14 个**未解析的动态导入**，
例如 `mermaid.core-DrHNId4r.js` 以及一组子智能体面板：

- `PointNativeSubagentPanel-*.js` / `PointNativeSubagentListPanel-*.js` /
  `PointNativeSubagentSummary-*.js` / `pointNativeInheritedHistory-*.js` /
  `usePointNativeSubagentOverview-*.js`。

这些分包在服务器上应当存在，但静态分析无法在单文件容器内解析；尚未下载，属未覆盖范围。
""".format(WORK_BUNDLE_SHA=WORK_BUNDLE_SHA, tbl=tbl(
    [(c["url"].split("/")[-1], c["bytes"]) for c in chunks], ["chunk", "bytes"]), **EV))

write("04-report/03-routes.md", u"""# 03 · 路由 / Routes

## `/finance` SPA 路由（观察 — 来自 REA `property:path` 检测）

{tbl}

`*` 为兜底路由。`/as/:id/*` 表明「账套(account set)」是其核心资源，按 ID 进入子应用。

## `/work` 入口与鉴权流（观察）

- 入口：`https://daizhang.youshu.yun/work/` → 302 → 同域 `/work/`（加载 Vite 应用）。
- 未登录时跳转：`/finance/login?redirect=%2Fwork%2F`。

## 后端鉴权相关路由（观察/推断）

`/finance-api` 侧另有 `current-user`、`account-sets`、`signup/*` 等账号-账套接口；
`/api` 侧为工作台业务接口。详见 `04-report/04-api-endpoints.md`。
证据：{bundle}、{finance}。
""".format(bundle=EV["bundle"], finance=EV["finance"],
           tbl=tbl([(r,) for r in routes], ["path"])))

# --- grouped endpoints
groups = collections.OrderedDict([
    ("auth / 会话", []), ("account / 账号", []), ("account-sets / 账套", []),
    ("signup / 开户", []), ("billing / 计费与发票", []), ("channels / 渠道接入", []),
    ("agent / AI 智能体", []), ("finance-jobs / 财税任务", []), ("models / 模型", []),
    ("preferences / 偏好", []), ("referral / 邀请", []), ("daily-checkin / 签到", []),
    ("wecom / 企业微信", []), ("other / 其他", []),
])
def group_of(p):
    if re.search(r"auth|login|logout|wechat|captcha|current-user", p): return "auth / 会话"
    if "signup" in p: return "signup / 开户"
    if "account-set" in p or "account-sets" in p or p.endswith("/account/account-sets"): return "account-sets / 账套"
    if p.startswith("/api/account/") or p.startswith("/finance-api/account"): return "account / 账号"
    if "billing" in p or "token" in p or "invoice" in p or "payment" in p: return "billing / 计费与发票"
    if "channel" in p: return "channels / 渠道接入"
    if "agent" in p or p.startswith("thread/") or "speech" in p or "attachments" in p: return "agent / AI 智能体"
    if "finance-job" in p or "finance/business" in p: return "finance-jobs / 财税任务"
    if "models" in p or "model-usage" in p: return "models / 模型"
    if "preferences" in p: return "preferences / 偏好"
    if "referral" in p: return "referral / 邀请"
    if "checkin" in p: return "daily-checkin / 签到"
    if "wecom" in p: return "wecom / 企业微信"
    return "other / 其他"
for e in uniq:
    groups[group_of(e["path"])].append(e)

secs = []
for g, items in groups.items():
    if not items:
        continue
    rows = [("{base}{path}".format(**e) if e["base"] else e["path"], e["method"], e["app"],
             e["provenance"]) for e in items]
    secs.append("### " + g + "\n\n" + tbl(rows, ["path", "method", "app", "provenance"]) + "\n")
write("04-report/04-api-endpoints.md", u"""# 04 · 接口清单 / API endpoints

以下路径来自 (a) REA 对两个应用包的静态分析（`{work}`、`{finance}`），以及
(b) 对已导出的 `/work` 主包做**字面字符串检索**（provenance 列注明）。
它们都是**候选**：静态字符串不代表运行时一定调用。

- `/work` 应用的 axios `baseURL = "/api"`（观察）
- `/finance` 应用的 axios `baseURL = "/finance-api"`（观察）
- 实时抓取只观察到未登录的 `GET /finance-api/wechat-login/status`（200，JSON，21 B）。
  证据 {page}。

{secs}

## 实时抓到的请求（attach 窗口内，观察）

{tbl}
""".format(secs="\n".join(secs),
           tbl=tbl([(r["method"], r["url"], r["status"], r["resource_type"]) for r in live_eps],
                   ["method", "url", "status", "type"]),
           **EV))

write("04-report/05-feature-map.md", u"""# 05 · 功能地图 / Feature map

## `/work/` 智能工作台（AI 财税 Agent）

从主包中提取到的中文界面/工具字符串（**观察**：字面字符串检索；数量为出现次数）：

{tbl}

结合接口与字符串，工作台至少包含以下能力域（**推断**，基于静态证据）：

1. **AI 会话与子智能体**：`thread/read`、`thread/resume`、`thread/turns/list`，
   `PointNativeSubagent*` 面板，模型选择、`/api/agent/runtime-ticket`、
   `/api/agent/thread-title`、附件 `/api/attachments/*`、语音 `/api/speech/iat/session`。
2. **账套管理**：账套列表/新建、账期、初始化同步、`/account/account-sets`。
3. **记账与凭证**：查询已生成/草稿凭证、读取凭证详情、银行流水入账、凭证数量。
4. **发票**：发票信息查询、智能开票、开票账套、发票抬头。
5. **税务申报**：纳税人性质（小规模/一般纳税人）、申报状态（待申报/已申报/申报失败）、
   税种核定、增值税/附加税/企业所得税/印花税/年度申报、个税申报、办税员与涉税机构登录信息。
6. **财务报表**：资产负债表、利润表、现金流量表。
7. **计费**：Token 用量、套餐、团队席位、订单、发票申请（billing 接口）。
8. **渠道接入**：企业微信（`wecom`）绑定与校验、`clawbot` 登录、签到、邀请返利。
9. **单点登录**：`POST /api/yousure/sso`（与 YOUSURE/有数云主站互通）。

## `/finance/` 登录与开户

- 微信扫码登录（`wechat-login/url`、`status`、`complete`）、图形验证码、手机号验证码登录。
- 注册开户：`signup/profile`、`signup/create-agency`（创建代账机构/agency）、`signup/defer`。
- 账套选择：`account-sets`、`account-sets/employees`。
- 邀请码：`referral/resolve`、URL 参数 `ic` / `invite` / `inviteCode`。

## 未登录可见页面

DOM 为 Ant Design 登录卡片；本地存储仅有 `appearanceTheme`（主题）。
证据：{page}、{screenshot}。
""".format(tbl=tbl(feature_rows, ["string", "count"]), **EV))

write("04-report/06-tech-stack-and-thirdparty.md", u"""# 06 · 技术栈与第三方依赖

| 项目 | 值 | 置信度/来源 |
|---|---|---|
| 打包器 | Vite | inferred (medium), {bundle} |
| 框架 | React | inferred (medium), {bundle} |
| UI 库 | Ant Design (antd) | observed (`antd-vendor-*`, DOM rc-* markers) |
| HTTP | axios | observed (代码中 `axios.create`) |
| 图表 | Mermaid | observed (动态导入 `mermaid.core-*.js`) |
| 公式 | KaTeX | observed (`gullet.macros`) |
| 监控 | Sentry | observed |
| 表格导出 | xlsx（疑似） | inferred |

## Sentry

两个应用包中嵌入了同一 DSN：

```
https://9f2168bc410b913eec642ef141d7b8fb@o4512192744587264.ingest.us.sentry.io/4512192945389568
```

这是前端监控的**公开写入密钥**（write-only DSN），本身不构成漏洞；但说明存在
`o4512192744587264` 组织与项目 `4512192945389568`。证据：`{work}`（字面字符串）。
""".format(work=EV["work"], bundle=EV["bundle"]))

write("04-report/07-security-observations.md", u"""# 07 · 安全观察 / Security observations

> 仅描述静态/被动证据，未做任何漏洞利用或主动扫描。

**观察**

- 响应头（`/work/` HTML）：`X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、
  `Referrer-Policy: no-referrer`。**未见** `Content-Security-Policy`
  （页面抓取中 CSP directives 为空）。证据：{page}。
- 服务器：`nginx`；HTTP → HTTPS 301（`Server: nginx`）。证据：`00-recon/http-headers.txt`。
- axios 使用 `withCredentials: true`，依赖 Cookie 会话；文档 `Vary: Accept-Encoding`。
- 静态包未做混淆/去除 source map：bundle 为可读的压缩 ESM，`sourceMappingURL` **不存在**，
  `.map` 返回 404（**观察**）。
- Sentry DSN 内嵌（见 06）。

**推断**

- 由于 `/api` 与 `/finance-api` 为同域前缀、`withCredentials` 开启，鉴权大概率是
  HttpOnly Cookie + 服务端会话；前端 `user` 存于 localStorage（`user`、
  `point:pinned-thread-ids` 为命名的本地存储键，**静态发现**）。
- 未观察到 WebSocket；AI 流式输出可能走 SSE/`fetch` 流（`thread/*` 与 `/api/agent/*`）。

**未知**

- Cookie 属性（HttpOnly/Secure/SameSite）在被动抓取中被刻意剔除，未确认。
- 未枚举服务器端鉴权/越权边界。
""".format(**EV))

write("04-report/08-method-and-evidence.md", u"""# 08 · 方法与证据 / Method & evidence

## 使用的 REA 能力

| 步骤 | 工具/命令 | 产出 | Evidence ID |
|---|---|---|---|
| 目标发现 | `list_browser_targets` (CDP `127.0.0.1:9222`) | 页面 URL/标题 | `{targets}` |
| 被动页面检查 | `inspect-web-page` | DOM/无障碍/脚本/网络/存储 | `{page}` |
| 截图 | `capture-web-screenshot` | `01-capture/screenshot.png` | `{screenshot}` |
| 实时包分析 | `analyze-web-bundle --fetch-source-maps` | chunk 图、路由、接口、指纹 | `{bundle}` |
| WebMCP 清点 | `discover-webmcp-tools` | 0 个页面声明工具 | `{webmcp}` |
| 脚本导出 | `export-web-scripts` | `02-scripts/finance/` + manifest | `{export}` |
| `/work` 静态重建 | `analyze-javascript-application` | 应用图（48 接口节点/19 存储节点） | `{work}` |
| `/finance` 静态重建 | `analyze-javascript-application` | 应用图（36 接口节点/11 存储节点） | `{finance}` |

## 目标身份

- 浏览器：Chrome/155.0.8059.39（headless，CDP `127.0.0.1:9222`，REA 自有临时 profile）。
- 目标源：`https://daizhang.youshu.yun`（**注意**：用户原始 URL 的 TLD `yuork` 不存在，
  见 `00-recon/dns-corrected-url.md`）。
- `/work` 主包 SHA-256：`{WORK_BUNDLE_SHA}`。
- `/work` 目录分析 subject SHA-256：`{WORK_SHA}`。
- `/finance` 脚本目录分析 subject SHA-256：`{FIN_SHA}`。

## 复现

```
# 1) 启动可调试浏览器（REA 亦可自行 launch）
chrome --headless=new --remote-debugging-port=9222 https://daizhang.youshu.yun/work/
# 2) 目标列表
rea list-browser-targets http://127.0.0.1:9222
# 3) 被动检查 + 实时包分析
rea inspect-web-page http://127.0.0.1:9222 <targetId> --include-script-sources --format json
rea analyze-web-bundle http://127.0.0.1:9222 <targetId> --fetch-source-maps --format json
# 4) 离线静态重建
rea analyze-javascript-application 02-scripts/work --format json
rea analyze-javascript-application 02-scripts/finance --format json
```

权威性说明：实时页面/网络为 `external-service` / `observed`；静态包分析为
`shipped-artifact` / `derived`；接口与功能的语义归类为 `analyst-inference`。
""".format(WORK_SHA=WORK_SHA, FIN_SHA=FIN_SHA, WORK_BUNDLE_SHA=WORK_BUNDLE_SHA, **EV))

write("04-report/09-unknowns-and-limits.md", u"""# 09 · 未知与覆盖边界 / Unknowns & limits

1. **鉴权后区域未执行**：没有可用凭据，`/work` 工作台与 `account-sets` 内部页面
   从未登录进入；相关功能来自静态代码/接口，**不是运行时观察**。
2. **动态分包未获取**：`mermaid.core-*.js`、`PointNativeSubagent*` 等动态导入在
   单文件容器内无法解析，也未下载（REA `unknowns`）。文件 `03-analysis/work-app-analysis.json`。
3. **Source map 不可用**：两个应用均无 `.map`（404），无法还原原始模块名/源码。
4. **attach 窗口限制**：页面检查的 console/网络只覆盖 REA 附加之后的活动，
   之前的请求不可见（`attach_limited`）。
5. **策略过滤**：跨源（`disallowed_origin`）的脚本/资源/元数据被剔除；Cookie 值、
   存储值、请求头、WebSocket 载荷一律不保留。
6. **WebMCP**：页面未注册任何 WebMCP 工具（0）。
7. **接口基址**：`thread/read|resume|turns/list` 在静态分析中未解析出 HTTP 基址，
   可能是 Agent 运行时协议（SSE/长连接），未在运行时验证。
8. **目标 URL 不确定性**：本次以修正域名 `daizhang.youshu.yun` 为准；若用户本意是
   其他主机（例如内网别名 `daizhang.youshu.yuork`），需在能解析该名的网络中重跑。

**未做的主动行为**：未登录、未点击、未提交表单、未爆破、未做越权/注入测试。
""")

# ------------------------------------------------- login page readable view
def acc_text(nodes):
    lines = []
    for n in nodes:
        name = n.get("name")
        role = n.get("role")
        if name and role not in ("none", "generic", "StaticText"):
            lines.append(u"- `{}` {}".format(role, name))
        elif name and role == "StaticText":
            lines.append(u"  - {}".format(name))
    return "\n".join(lines)

form_nodes = [n for n in page["normalized_result"]["dom"]["nodes"]
              if n.get("node_name") in ("INPUT", "BUTTON", "FORM", "IMG", "A", "LABEL")]
form_rows = [(n["node_name"], ",".join(n.get("attribute_names", []))) for n in form_nodes]
write("01-capture/login-page-analysis.md", u"""# 登录页可读摘要（/finance/login）

- 最终 URL：`https://daizhang.youshu.yun/finance/login?redirect=https%3A%2F%2Fdaizhang.youshu.yun%2Fwork%2F`
- 标题：`有数云 - AI财务数字员工`
- DOM 节点数：{dom_total}；无障碍节点数：{acc_total}
- 本地存储键：`{ls_keys}`（值被 REA 剔除）
- 实时网络：{net}
- 证据：{page}

## 无障碍树（节选）

{acc}

## 表单/交互元素

{tbl}

## 限制

{lim}
""".format(
    dom_total=page["normalized_result"]["dom"]["total_nodes"],
    acc_total=page["normalized_result"]["accessibility"]["total_nodes"],
    ls_keys=", ".join(page["normalized_result"]["storage"]["local_storage_keys"]),
    net=len(live_eps),
    page=EV["page"],
    acc=acc_text(page["normalized_result"]["accessibility"]["nodes"]),
    tbl=tbl(form_rows, ["node", "attribute names"]),
    lim="\n".join("- " + str(x) for x in page["limitations"]),
))

print("OK")
