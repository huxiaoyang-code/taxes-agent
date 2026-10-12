# 04 · 接口清单 / API endpoints

以下路径来自 (a) REA 对两个应用包的静态分析（`ev_ad4fac8e260b2234518c88fa9d3345b023703c1cfd585f2dea8044444f2011c0`、`ev_777535033dbadd0cf3825cfde692652d5cbd3ea6947ff1719b0673d25d644c84`），以及
(b) 对已导出的 `/work` 主包做**字面字符串检索**（provenance 列注明）。
它们都是**候选**：静态字符串不代表运行时一定调用。

- `/work` 应用的 axios `baseURL = "/api"`（观察）
- `/finance` 应用的 axios `baseURL = "/finance-api"`（观察）
- 实时抓取只观察到未登录的 `GET /finance-api/wechat-login/status`（200，JSON，21 B）。
  证据 ev_5cf4d9b1e50fc3c9ac5368b003cd4c3095854144637c0a478fe8781101189311。

### auth / 会话

| path | method | app | provenance |
|---|---|---|---|
| /finance-api/captcha | GET | finance | REA static analysis |
| /finance-api/current-user | GET | finance | REA static analysis |
| /finance-api/login | POST | finance | REA static analysis |
| /finance-api/login/phone | POST | finance | REA static analysis |
| /finance-api/login/phone-code | POST | finance | REA static analysis |
| /finance-api/logout | POST | finance | REA static analysis |
| /finance-api/wechat-login/complete | POST | finance | REA static analysis |
| /finance-api/wechat-login/status | GET | finance | REA static analysis |
| /finance-api/wechat-login/url | GET | finance | REA static analysis |
| /api/auth/current-user | GET | work | REA static analysis |
| /api/auth/logout | POST | work | REA static analysis |
| /api/auth/wechat/status | GET | work | REA static analysis |
| /api/auth/wechat/url | GET | work | REA static analysis |
| /api/auth/welcome-bundle/claim | POST | work | REA static analysis |
| /api/channels/clawbot/login | POST | work | REA static analysis |
| /api/channels/clawbot/login/status | GET | work | REA static analysis |

### account-sets / 账套

| path | method | app | provenance |
|---|---|---|---|
| /finance-api/account-sets | GET | finance | REA static analysis |
| /finance-api/account-sets | POST | finance | REA static analysis |
| /finance-api/account-sets/employees | GET | finance | REA static analysis |
| /api/account/account-sets | GET | work | REA static analysis |
| /api/billing/token/account-set-products/orders | POST | work | REA static analysis |

### signup / 开户

| path | method | app | provenance |
|---|---|---|---|
| /finance-api/signup/create-agency | POST | finance | REA static analysis |
| /finance-api/signup/defer | POST | finance | REA static analysis |
| /finance-api/signup/profile | GET | finance | REA static analysis |

### billing / 计费与发票

| path | method | app | provenance |
|---|---|---|---|
| /api/billing/capabilities | GET | work | REA static analysis |
| /api/billing/payment-orders | GET | work | REA static analysis |
| /api/billing/payment-orders/invoice-applications | GET | work | REA static analysis |
| /api/billing/payment-orders/invoice-applications | POST | work | REA static analysis |
| /api/billing/payment-orders/invoice-profile | GET | work | REA static analysis |
| /api/billing/token/orders | POST | work | REA static analysis |
| /api/billing/token/products | GET | work | REA static analysis |
| /api/billing/token/summary | GET | work | REA static analysis |
| /api/billing/token/team-seats/orders | POST | work | REA static analysis |
| /api/billing/token/team-seats/quote | POST | work | REA static analysis |
| /api/billing/usage/conversations | GET | work | REA static analysis |

### channels / 渠道接入

| path | method | app | provenance |
|---|---|---|---|
| /api/channels/wecom/bind/phone-code | POST | work | REA static analysis |
| /api/channels/wecom/bind/verify | POST | work | REA static analysis |
| /api/channels/wecom/config | GET | work | REA static analysis |
| /api/channels/wecom/config | PUT | work | REA static analysis |
| /api/channels/wecom/validate | POST | work | REA static analysis |

### agent / AI 智能体

| path | method | app | provenance |
|---|---|---|---|
| /api/agent/model-usage/availability | GET | work | REA static analysis |
| /api/agent/runtime-ticket | ANY | work | literal string search of exported bundle |
| /api/agent/thread-title | ANY | work | literal string search of exported bundle |
| /api/attachments/ | ANY | work | literal string search of exported bundle |
| /api/attachments/raw-upload | ANY | work | literal string search of exported bundle |
| /api/attachments/{id} | ANY | work | literal string search of exported bundle |
| /api/speech/iat/session | ANY | work | literal string search of exported bundle |
| thread/read | CALL | work | REA static analysis |
| thread/resume | CALL | work | REA static analysis |
| thread/turns/list | CALL | work | REA static analysis |

### finance-jobs / 财税任务

| path | method | app | provenance |
|---|---|---|---|
| /api/finance-jobs | GET | work | REA static analysis |
| /api/finance/business-batches | GET | work | REA static analysis |

### models / 模型

| path | method | app | provenance |
|---|---|---|---|
| /api/models/available | GET | work | REA static analysis |
| /api/models/catalog | GET | work | REA static analysis |

### preferences / 偏好

| path | method | app | provenance |
|---|---|---|---|
| /api/preferences/runtime | GET | work | REA static analysis |
| /api/preferences/runtime | PUT | work | REA static analysis |

### referral / 邀请

| path | method | app | provenance |
|---|---|---|---|
| /finance-api/referral/resolve | GET | finance | REA static analysis |
| /api/referral/share | GET | work | REA static analysis |
| /api/referral/stats | GET | work | REA static analysis |

### daily-checkin / 签到

| path | method | app | provenance |
|---|---|---|---|
| /api/daily-checkin | GET | work | REA static analysis |
| /api/daily-checkin | POST | work | REA static analysis |

### other / 其他

| path | method | app | provenance |
|---|---|---|---|
| /finance-api/system/tax-deadline-config | GET | finance | REA static analysis |
| /api/account/phone | PUT | work | REA static analysis |
| /api/account/phone-code | POST | work | REA static analysis |
| /api/account/profile | PUT | work | REA static analysis |
| /api/product-control/policy | GET | work | REA static analysis |
| /api/yousure/sso | POST | work | REA static analysis |


## 实时抓到的请求（attach 窗口内，观察）

| method | url | status | type |
|---|---|---|---|
| GET | https://daizhang.youshu.yun/finance-api/wechat-login/status?state=1791789723.74170eb76835d8e0.d55fd5a34e64ad67d6aa5cfb | 200 | XHR |
| GET | https://daizhang.youshu.yun/finance-api/wechat-login/status?state=1791789723.74170eb76835d8e0.d55fd5a34e64ad67d6aa5cfb | 200 | XHR |
| GET | https://daizhang.youshu.yun/finance-api/wechat-login/status?state=1791789723.74170eb76835d8e0.d55fd5a34e64ad67d6aa5cfb | 200 | XHR |
| GET | https://daizhang.youshu.yun/finance-api/wechat-login/status?state=1791789723.74170eb76835d8e0.d55fd5a34e64ad67d6aa5cfb | 200 | XHR |
