# 07 · 安全观察 / Security observations

> 仅描述静态/被动证据，未做任何漏洞利用或主动扫描。

**观察**

- 响应头（`/work/` HTML）：`X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、
  `Referrer-Policy: no-referrer`。**未见** `Content-Security-Policy`
  （页面抓取中 CSP directives 为空）。证据：ev_5cf4d9b1e50fc3c9ac5368b003cd4c3095854144637c0a478fe8781101189311。
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
