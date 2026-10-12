# 03 · 路由 / Routes

## `/finance` SPA 路由（观察 — 来自 REA `property:path` 检测）

| path |
|---|
| / |
| /account-sets |
| /login |
| /signup/onboarding |
| /init-detail |
| /as/:id/* |
| * |

`*` 为兜底路由。`/as/:id/*` 表明「账套(account set)」是其核心资源，按 ID 进入子应用。

## `/work` 入口与鉴权流（观察）

- 入口：`https://daizhang.youshu.yun/work/` → 302 → 同域 `/work/`（加载 Vite 应用）。
- 未登录时跳转：`/finance/login?redirect=%2Fwork%2F`。

## 后端鉴权相关路由（观察/推断）

`/finance-api` 侧另有 `current-user`、`account-sets`、`signup/*` 等账号-账套接口；
`/api` 侧为工作台业务接口。详见 `04-report/04-api-endpoints.md`。
证据：ev_66f34fbf3a16eb24431d8ad24f58769b4315e27f65d8ed84227505cb819b6962、ev_777535033dbadd0cf3825cfde692652d5cbd3ea6947ff1719b0673d25d644c84。
