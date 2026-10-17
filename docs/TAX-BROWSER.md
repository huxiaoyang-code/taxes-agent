# 税局浏览器导入（福建省漳州市）· 当前接口概述

> 状态：**RC-A0 第一步本机独立验收通过（15 套 496 项，2026-10-17，代码验证 head `0293ed2`）**；代码已提交（初轮 `866fc30` + 收尾修复 `0293ed2`）已开 PR [#19](https://github.com/huxiaoyang-code/youshu-fork/pull/19)（**未合并**、待跨成员复核）。真实登录**未验收**，全国真实接入 **0**。
> 本文描述**当前工作区代码**的接口边界，供 RC-A0 审查与 RC-1 设计使用（审查结论见 [REVIEW-TAX-BROWSER](REVIEW-TAX-BROWSER.md)，数据可得性见 [DATA-AVAILABILITY](DATA-AVAILABILITY.md)）。本文由草稿接口文档演进而来；草稿接口全文仍在**只读原件 / 副本**中，[handoffs/TAX-BROWSER](handoffs/TAX-BROWSER.md) 只是**历史交接记录**，并非接口全文迁移。**企业列表 ≠ 财务数据**，不抓 cookies/网络响应，不接收凭据。

## 1. 支持范围

| 项 | 值 |
|---|---|
| 地区 | **福建省漳州市**（region `350000` / city `350600`），代码内固定白名单 |
| 官网入口 | `https://etax.fujian.chinatax.gov.cn/` |
| 允许读取来源 | `https://etax.fujian.chinatax.gov.cn`（443）与 `https://etax.fujian.chinatax.gov.cn:8443` |
| 其他地区 | 一律 `tax_browser_region_not_supported`，不猜测、不伪造 |
| 全国目标 | 保留；**当前未实现、真实接入 0** |

## 2. 交互模型

1. 用户在网页点「打开官方登录窗口」→ 后端在本机启动**独立、可见**的 Edge/Chrome 官方窗口，直达官网入口。
2. **账号 / 密码 / 验证码 / 扫码全部由用户在该窗口完成**；本服务不接收、不转发、不存储凭据。
3. 用户登录后打开「办税员可访问企业」列表，回工作台点「我已登录，读取当前企业页」。
4. 服务在**白名单来源页面**执行一段**代码内固定**的只读 DOM 脚本，识别带标签的企业记录；可手动翻页、多次读取，按税号合并。
5. 勾选企业 → 批量新建空账套，或绑定到已有空账套。

边界：**打开窗口 ≠ 已登录**；只有识别到带标签的企业列表才返回数据，否则结构化失败（`tax_browser_layout_unrecognized` / `tax_browser_no_valid_records`），不假成功。仅覆盖用户**已翻到的页面**，不代表税局返回的全部企业。

## 3. 采集 / 不采集

| 采集（白名单） | 不采集 |
|---|---|
| 企业名称（标签「企业名称/纳税人名称/单位名称」） | cookies / token / localStorage / 密码 / HTTP 完整响应 |
| 纳税人识别号（标签配对 + 服务端严格校验） | 无标签对应的裸税号 |
| 读取计数、采集时间、不含 query/fragment 的来源 origin | 页面全文 / 浏览器原始输出（错误也不透出） |

税号严格校验 `validateTaxpayerId`：
- **18 位统一社会信用代码**：前 6 位为数字区划开头，末位为 **GB 32100-2015 校验码**（按前 17 位计算校验字符必须相等）；
- **15 位旧纳税人识别号**：仅做**格式校验**（前 6 位数字 + 后 9 位数字或字母，长度 15），**不声称能校验真实税号的真伪**。

非法一律拒绝、绝不入库；**不声称已验证所有真实税号 / 所有地区**（全国真实接入 0，当前仅福建漳州）。标签配对、校验、去重全部在**服务端**完成（可单测）。

## 4. 浏览器进程与 CDP 安全

- `spawn`（`shell:false`）启动**固定探测路径**的本机官方 Edge/Chrome（可执行文件路径**不接受请求传入**）。
- `--remote-debugging-port=0`：随机端口、仅监听 `127.0.0.1`；调试地址经 stderr `DevTools listening on ws://127.0.0.1:…` 与 profile 下 `DevToolsActivePort` 双通道获取，**不出现在任何响应**。
- `--user-data-dir=<随机临时目录> --incognito --edge-skip-compat-layer-relaunch`：不读用户常用 profile。
- CDP：Node ≥22 内置 WebSocket，零第三方依赖；只用 `Target/Runtime/Page/Browser` 少量命令，不启用 `Network`/`DOMStorage` 等域（从根上不抓 cookies/网络）。
- `isLoopbackDevtoolsUrl` 严格校验：仅 `ws://127.0.0.1:<有效端口>/<非空路径>`，拒绝 userinfo / 越界端口 / 根路径；`extractDevtoolsUrlFromStderr` 只匹配 `ws://`。
- 关闭顺序：CDP `Browser.close` → `kill()`（含 Windows `taskkill /PID <自己启动的 pid> /T /F` 兜底）→ 删除临时 profile。**绝不批量清理用户其它浏览器进程或 profile**；只删「本程序 `mkdtemp` 创建的不可变自建绝对根」——**非递归、仅删空目录**；未决 launch 保留 profile，后续定向回收再删空根，不碰不受管哨兵（不声称根自身另做父目录检查）。

## 5. 会话与清理语义

- 会话 ID `taxb_*`、登录令牌 `taxlt_*` 均为 `randomBytes(24)` 生成的 **24 字节（192 位）随机**不可猜值。
- 默认限制：并发会话 3、会话 TTL 30 分钟、单次读取超时 20 秒、启动超时 30 秒、登录令牌 TTL 10 分钟（**单次使用**）、单会话候选上限 200。
- **主动 TTL timer（`unref`）**：到点自动 `expired` + 销毁候选 + 关闭浏览器 + 删 profile，不依赖下一次请求；`destroy` 清 timer。
- 终态保护：关闭 / 浏览器退出 / TTL 过期后，读取 / 导入一律失败；**并发关闭后的迟到结果被丢弃**，不恢复数据；候选与临时 profile 均销毁。
- 启动 `await launch/connect/attach` 期间发生 close/expire/destroy：**每次 await 后做生命周期校验**，不返回已关闭会话为成功，不遗留迟到 proc/conn；失败保留待关闭 sid / 在途 close 门禁。

## 6. HTTP API（`/api/tax-browser/*`）

所有响应**不带任何 `access-control-allow-origin` 头**；OPTIONS 返回 204 且无 CORS 放行头。服务默认只绑 `127.0.0.1`（`HOST` 可覆盖）。
路由入口先做**连接来源回环校验**（`req.socket.remoteAddress` 按有效 IP：127/8、`::1`、`::ffff:127.0.0.1`），**不信任 `X-Forwarded-*`**；再做 Host 回环 + 同源 Origin（含 `localhost` 别名）校验。
错误出口用**固定安全码字典 + 固定文案**，永不透传 `err.message`/`details`；未知 / 怪 code 一律 500 `tax_browser_internal`；未知路径固定 404，不回显 pathname。浏览器模块日志同样只输出**调用方固定 fallback 文案**（`safeErrorCode(_e, fallback)` 不读取外部异常的 code/message/details）。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/config` | 只读：支持地区、浏览器探测、限制、隐私说明，并发放**一次性 `loginToken`**。不启动浏览器、不读税局 |
| POST | `/sessions` | 打开官方登录窗口；须 `application/json` + 回环 Host/Origin + 有效 `loginToken`。返回会话视图（`status:"open"` **≠ 已登录**） |
| POST | `/sessions/:sid/read` | 在白名单来源页执行固定只读脚本；返回会话视图 + 累积预览 + `newCount` |
| GET | `/sessions/:sid` | 只读状态与累积预览 |
| POST | `/sessions/:sid/import` | 只接受服务端采集结果的 `candidateIds`；HTTP 不采用客户端企业对象 / 溯源字段，候选和来源只能取自服务端会话（服务层直调会拒绝相应额外字段） |
| POST | `/sessions/:sid/close` | 销毁候选、关闭浏览器、删 profile；**不代表已从税局服务端退出** |

导入两种模式：

- `mode:"create"`：`create` 三要素（`start_period` / `accounting_standard` / `taxpayer_type`）必须显式且合法（**用户确认，非税局数据**）；同税号重复返回已绑定账套（`existing`），不重复建、不覆盖；整批一个事务，任一项失败全部回滚。建账**只含企业基本档案 + 标准科目表，不造历史凭证、不造期初**。
- `mode:"bind"`（一次一家）：`accountSetId` 必须是**空账套**（无凭证/期初/资产）；账套与税号互不重复绑定；名称变化须先 `dryRun` 预览 + `confirmNameChange:true`。

代表性失败码：`tax_browser_page_not_supported`、`tax_browser_layout_unrecognized`、`tax_browser_no_valid_records`、`tax_browser_read_timeout`、`tax_browser_session_closed`/`expired`/`not_found`、`tax_browser_login_token_invalid`。

## 7. 数据库

新增表 `tax_enterprise_bindings`（`server/db.mjs`，幂等迁移）：`account_set_id`（UNIQUE，级联删除）、`taxpayer_id`（UNIQUE）、`region`、`city`、`source`、`imported_at`。存量表与既有接口零改动。该表**只绑定企业档案，不携带任何会计数据**；当前唯一约束 = 1 账套 ↔ 1 税号，属**草稿能力限制**（见 §10）。

## 8. UI

网页顶部「🏦 税局导入企业」；新建账套对话框另有「创建后从税局导入」。地区下拉仅福建漳州并注明其他地区未支持；建账参数标注「由您本地确认，非税局返回数据」；预览可勾选/全选，错误内联呈现（`textContent`，企业名称 HTML 转义防 XSS）；create 先 `dryRun` 再确认，bind 名称变更先预览再确认。

## 9. 模块与测试

| 文件 | 职责 |
|---|---|
| `server/tax-browser.mjs` | 会话 / 浏览器 / CDP / 读取 / 关闭（不依赖 DB，依赖注入便于假浏览器测试） |
| `server/tax-import.mjs` | 导入落库（批量建账 / 绑定空账套 / 幂等 / 原子事务） |
| `server/tax-browser-http.mjs` | `/api/tax-browser/*` 接线（回环 + 同源一次性令牌 + 严格 JSON + 无 CORS + 安全错误字典） |
| `server/server.mjs` | 挂载路由；默认绑 `127.0.0.1`；退出时销毁会话与临时 profile |
| `test/tax-browser.test.mjs` | 原草稿套件 64 项（会话 / 导入 / HTTP / 生产负路径） |
| `test/tax-browser-security.test.mjs` | 安全出口 18 项（错误字典 / 回环来源 / 无 CORS / 令牌重放） |
| `test/tax-browser-lifecycle.test.mjs` | 生命周期加固 26 项（固定 fallback 日志脱敏 / 来源先验 / stderr 匹配 / 主动 TTL / 启动竞态 / 迟到 read·import / root 清理） |
| `test/tax-browser-ui.test.mjs` | UI 24 项（迟到 read/import、close 失败保留待关闭 sid / 在途 close 门禁、每次 await 后生命周期校验、取消后令牌不触发新开、新建账套返回值） |
| `test/server-local-boundary.test.mjs` | 生产本地边界 **28 项**（**畸形 Host 400 / 服务存活 / 税局 config 边界 / 旧 REST 合成企业名跨站读拒绝 / 跨站 JSON 与 text/plain 写拒绝且 DB 未变 / 真实 Agent 入口拒绝 / 本机同源·无 Origin·localhost 可用 / 跨站 OPTIONS 拒绝 / 静态页正常**） |

统一入口 `scripts/test-all.mjs` 现为 **15 套**（含上述五套）；本机管理者复跑 `npm test` **15 套 496 项、exit 0**，`npm run test:smoke` **28/28、exit 0**（代码验证 head `0293ed2`；**初轮 `866fc30` 为 15 套 481 项、`server-local-boundary` 13 项，属历史**）。

全部合成、**不访问真实税局、不启动真实浏览器**。真实浏览器链路（Edge + `--remote-debugging-port=0` + 内置 WebSocket CDP + `Browser.close` + profile 清理）曾在草稿阶段用 `about:blank` 人工联调；**真实福建账号登录与页面识别属人工验收，尚未完成**。**代码已提交（初轮 `866fc30` + 收尾修复 `0293ed2`）并开 PR [#19](https://github.com/huxiaoyang-code/youshu-fork/pull/19)（未合并）**；文档后续提交不改已提交代码，最终 PR head 以 PR 当前提交为准，代码验证 head 用 `0293ed2`。

## 10. 未实现 / 待人工验收

1. **真实福建账号验收**：需用户本机真实登录，确认「办税员可访问企业」列表页能被标签配对规则识别；布局不在已覆盖形态时按失败关闭，再据真实页面扩展。
2. 凭证生命周期、税种核定、申报等查询：未实现（沿用 TAX 网关边界）。
3. 其他地区：未支持、未接入。
4. **草稿能力限制**：`tax_enterprise_bindings` 的**全局 `taxpayer_id` 唯一**是草稿实现限制，**不是永久「一企一账套」产品要求**；RC-1 需按绑定范围（region/city/source 等）完善，RC-2 定向追加未完成。**不得因 A0 而关闭总 Issue #13**（A0 未合并、真实验证未完成，Issue #13 保持 OPEN）。
