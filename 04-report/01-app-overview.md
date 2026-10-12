# 01 · 应用概览 / App overview

**观察 (observed)**：目标站点是「有数云」企业财税 SaaS，页面标题为
`有数云 - AI财税智能体与企业财税工作台 | 司书大模型`，登录页品牌标识为 `有数云 YOUSURE`、
`司书财税大模型`，登录方式为「微信扫码登录」。
证据：ev_5cf4d9b1e50fc3c9ac5368b003cd4c3095854144637c0a478fe8781101189311、ev_8143096ed11a6dabe7f482a820efc5b9c1aceb597cbd153c81905dc11124326d。

站点由两个独立的 Vite 构建 SPA 组成：

| 路径 | 角色 | 技术 | 证据 |
|---|---|---|---|
| `/work/` | 财税智能工作台（代账主应用，AI 会话 + 账套/凭证/申报工具） | Vite + React，单包 `index-yoSd2Nx7.js`（2.4 MB） | ev_ad4fac8e260b2234518c88fa9d3345b023703c1cfd585f2dea8044444f2011c0 |
| `/finance/` | 登录 / 注册开户 / 选择账套（Auth & onboarding） | Vite + React + Ant Design | ev_66f34fbf3a16eb24431d8ad24f58769b4315e27f65d8ed84227505cb819b6962、ev_777535033dbadd0cf3825cfde692652d5cbd3ea6947ff1719b0673d25d644c84 |

未登录访问 `https://daizhang.youshu.yun/work/` 时，前端/服务端重定向到
`/finance/login?redirect=%2Fwork%2F`，说明 `/finance` 是鉴权外壳，`/work` 是业务工作台。

## 证据摘录

- 浏览器目标标题：`有数云 - AI财务数字员工`，最终 URL 为 `/finance/login?redirect=.../work/`
  （ev_f3601e802d4d6f03d581ba635436a115f64ba5edb35d267ba7f8f1d9bcb16837）。
- 首页 HTML `<meta name="description">`：*基于司书财税大模型的企业财税智能工作台，支持财税问答、记账报税、
  规则核验与经营分析*。
- 无障碍树根节点名称：`有数云 - AI财务数字员工`，含「司书财税大模型」「微信扫码登录」文本（ev_5cf4d9b1e50fc3c9ac5368b003cd4c3095854144637c0a478fe8781101189311）。

**推断 (inferred)**：`/work/` 是被 `daizhang`（代账）业务复用的有数云 AI 工作台前端，
后端接口以 `/api` 为前缀；`/finance` 使用独立的 `/finance-api` 前缀。
两者共用同一 Sentry 项目和同一域名。
