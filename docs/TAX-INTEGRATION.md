# 全国电子税务局适配层与 MCP 接口（TAX）

> 状态：**第一期只预留接口**。
> 当前代码库**没有接入任何真实电子税务局**，不会联网、不读取任何真实税务凭据，
> 也不会返回任何真实申报/核定数据。文中的「已接入地区」一律指**本地注册了适配器实现**，
> 不等于可以办理真实业务。全国支持是**产品目标**，不是现状。

本文件说明统一协议、适配器职责、地区接入矩阵的验收方式、凭据引用规则，以及人工验证状态机。

---

## 1. 分层与文件

```
MCP 客户端 (Codex)
   │  tools/call  tax_regions / tax_capabilities / tax_login_* / tax_logout / tax_info_query
   ▼
05-reconstruction/codex/mcp/finance-mcp/
   ├─ tax-tools.mjs          工具契约（名称、描述、JSON Schema）
   ├─ tools.mjs              TOOLS 汇总（原站契约 + 本地工具 + 税务工具）
   ├─ backend.mjs            MCP → HTTP 转发（POST {FINANCE_API_BASE}/agent/tools/<name>）
   ├─ server.mjs             stdio MCP 服务（税务工具走与其它工具相同的后端路径）
   └─ tax-contract-test.mjs  税务契约测试（网关单测 + 接线往返）
   ▼
06-workbench/server/
   ├─ server.mjs             HTTP 路由（`/agent/tools/<A-Za-z0-9_]+` 已覆盖 tax_*，本期无需改动）
   ├─ agent-tools.mjs        工具注册表 + 账套校验注入 + TaxError→ToolError 归一
   └─ tax-gateway.mjs        TaxGateway：适配器注册表、会话状态机、DTO 白名单、脱敏
```

`tax-gateway.mjs` 只依赖 `node:crypto`，**不读数据库、不发网络请求**。账套存在性通过构造参数
`accountSetExists` 注入（`agent-tools.mjs` 注入 `accounting.getAccountSet`），因此可以在纯本地测试里
独立构造网关。

---

## 2. 统一协议

### 2.1 地区标识（region）

- 大陆税务服务目录 = **31 个省级行政区 + 5 个计划单列市**（大连 `210200`、宁波 `330200`、
  厦门 `350200`、青岛 `370200`、深圳 `440300`），共 36 条。依据国家税务总局 12366 纳税服务平台
  的地区目录：<https://12366.chinatax.gov.cn/wap/pages/index.html>。
- **计划单列市与所在省是并列的税务服务地区**，不是省下的普通市。官方表单页明确要求这些城市
  「直接选择该市税务局，勿选所在省」：<https://12366.chinatax.gov.cn/wap/pages/form_common.html>。
  目录行给出 `kind`（`province` / `separately_planned_city`）与 `parentRegion`（归属省份，仅供参考）；
  **`parentRegion` 不是路由依据**，网关按会话绑定的 `region` 精确选择适配器。
  计划单列市的六位码是**本地路由键（GB/T 2260 区划码）**，需实地联调确认；网关不因此声明任何
  登录网址或已接入状态。
- `"CN"`：**全国产品入口**，永远出现在目录里（`nationwide.productTarget = true`），
  但 `taxTarget = false`——**它不是税务服务地区**，不能注册适配器、不能作为登录目标
  （`tax_region_not_a_tax_target`）。
- **港澳台**（`710000` / `810000` / `820000`）属于不同税务管辖体系，**不是本期同一税务系统的
  覆盖目标**。网关把它们单独放在 `outOfScope` 数组里，标注 `outOfScope: true`、`taxTarget: false`
  与各自的 `jurisdiction`（`TW` / `HK` / `MO`），**不与 province 税务目标混列**；
  以此标识调用一律 `tax_region_out_of_scope`，不创建会话。
- 目录里每个地区都给出 `configured` / `status`：`not_configured` 表示当前进程未注册该地区适配器。
  **未接入 ≠ 该地区不能办税，也 ≠ 已接入**——两者都不宣称。
- `tax_regions.sources` 原样给出上面两条官方来源链接，便于核对；网关不据此臆造任何接口信息。

### 2.2 适配器注册表

- 键为 `(region, adapterId)`；同一地区允许存在多个适配器（不同登录通道/不同协议版本），
  此时 `tax_login_start` 必须显式指定 `adapterId`，否则返回 `tax_adapter_required`。
- **只能由代码显式 `registerAdapter()` 注册**。没有环境变量、没有 HTTP 接口、没有任何
  「传入模块路径/代码字符串」的加载方式。默认注册表为空。
- 适配器必须自报 `capabilities`：
  - `resources`：本适配器**实际可查**的资源类型（`identity` / `authorized_enterprises` /
    `enterprise_profile` / `tax_assessments` / `declaration_status`）；
  - `loginMethods`：支持的登录方式（`password` / `sms` / `qrcode` / `realname` / `certificate`）；
  - `challengeActions`：本适配器自定义的人工验证动作标识（如 `sms_code`、`qrcode_scan`、`realname_confirm`）。
  声明了未定义资源/登录方式的适配器会被 `registerAdapter` 直接拒绝（`tax_adapter_invalid`）。

### 2.3 适配器职责

适配器只回答「**怎么和某一地区电子税务局说话**」，不处理会话状态机、脱敏、绑定校验。

**同步与异步**：适配器方法**可以直接返回值，也可以返回 Promise**。网关侧
`startLogin` / `getStatus` / `submitChallenge` / `logout` / `infoQuery` 都是 `async`，
一律 `await` 适配器调用——真实适配器必然是异步的，这一步不能省。
所有适配器调用都在 `try/catch` 内 `await`，**异步拒绝（rejected Promise）会被归一成结构化
`TaxError`**（`tax_login_failed` / `tax_challenge_failed` / `tax_query_failed`），
不会产生 unhandled rejection。适配器返回的 Promise 若最终被拒，同样按失败处理。

| 方法 | 职责 | 返回值 |
|---|---|---|
| `startLogin(ctx)` | 发起登录，返回首个待验证动作或直接已认证 | `{ status, challenge?, expiresAt?, failure? }`，必须显式给 `status` |
| `getStatus(ctx)` | 轮询远端会话状态 | 同上；`null` / `undefined` / `{}` 表示**无变更** |
| `submitChallenge(ctx, {action, response})` | 判定人工验证结果 | 同上，必须显式给 `status` |
| `logout(ctx)` | 结束远端会话 | 任意（错误会被吞掉并记为 `warning`） |
| `query(ctx, {resource, params})` | 拉取某类信息资源 | 原始对象/数组（网关按 DTO 白名单裁剪） |

**返回值协议约束**（违反即 `tax_adapter_protocol_error`，会话置 `failed`，**不允许让调用方无限等待**）：

- `startLogin` / `submitChallenge` 必须返回对象**且显式给出合法 `status`**；
  返回 `{}`、`null`、非对象、非法状态字符串一律协议错误。
- 任何调用把状态置为 `requires_action` 时，**必须有合法 challenge**——
  要么本轮返回带 `action` 的 challenge，要么本会话已存在待处理 challenge。
  「`requires_action` 但没有 challenge」视为协议错误。
- `getStatus` 是**唯一允许「无变更」**的调用：返回 `null` / `undefined` / `{}`，
  或只带 `expiresAt` 局部字段，都表示状态与 challenge 保持原样。这一约定是明确的，不是「猜」。
- 网关**绝不**因为「适配器没报错」就把会话置为已认证；必须显式返回 `status: "authenticated"`。

`ctx` 只包含 `{ sessionId, region, adapterId, accountSetId, enterprise, credentialRef, status }`，
**不包含**人工验证响应。未实现的方法可以省略，网关会返回 `tax_login_unsupported` /
`tax_challenge_unsupported` / `tax_query_unsupported`，而不是假装成功。

### 2.4 MCP 工具

| 工具 | 关键参数 | 说明 |
|---|---|---|
| `tax_regions` | — | 接口契约 + 全国产品入口 + 大陆 31+5 目录 + 港澳台 `outOfScope` + 官方来源链接 |
| `tax_capabilities` | `region`，可选 `adapterId` | 某地区/适配器的能力声明；未接入时成功返回但 `configured=false` |
| `tax_login_start` | `region`，可选 `adapterId`/`loginMethod`/`accountSetId`/`enterprise`/`credentialRef` | 发起登录 |
| `tax_login_status` | `sessionId` | 查询状态与待处理验证动作 |
| `tax_login_challenge` | `sessionId`、`action`、`response` | 提交人工验证响应 |
| `tax_logout` | `sessionId` | 退出 |
| `tax_info_query` | `sessionId`、`resource`，可选 `params`/`region`/`accountSetId` | 查询信息资源 |

工具在 `tools.mjs` 中标注 `origin: "local"`（本地扩展，不冒充原站 catalog 契约），
描述中已写明「默认未接入」，不会出现「全国已可登录」之类的表述。

### 2.5 `tax_info_query` 的 `params` 平面白名单

`params` **不是**原样转发给适配器的透传袋。它只允许与资源本身有关的**标量**参数：

- 允许的键（平面白名单）：`period`、`startPeriod`、`endPeriod`、`taxType`、`declarationType`、
  `status`、`page`、`pageSize`；
- 值只接受字符串（≤64 字符）/ 有限数字 / 布尔；**嵌套对象或数组一律拒绝**
  （`tax_query_param_invalid`）——所以不存在「用嵌套结构绕过」的路径；
- 键名命中作用域保留模式（`accountSetId`、`account_set_id`、`region`、`enterpriseId`、
  `taxpayerId`、`sessionId`、`credentialRef`……）直接拒绝（`tax_query_param_reserved`）；
- 其余未知键拒绝（`tax_query_param_unknown`）；`params` 整体不是扁平对象则
  `tax_query_params_invalid`。

**被绑定的企业 / 账套 / 地区标识只来自会话上下文**（`ctx.enterprise` 等），
不可能通过 `params` 覆盖。跨地区、跨账套的顶层参数会被 `tax_region_mismatch` /
`tax_account_set_mismatch` 拒绝。

---

## 3. 会话状态机

```
                 startLogin
                     │
        ┌────────────┴────────────┐
        ▼                         ▼
  requires_action ──submitChallenge──► authenticated ──logout──► logged_out
        │  ▲                        │                              ▲
        │  └── challenge 更新 ──────┘                              │
        │                                                         │
        └──────── 超时 / 适配器失败 ──► expired / failed ──logout──┘
```

- 状态取值固定为 `requires_action | authenticated | expired | failed | logged_out`，
  适配器返回其它值会被记为 `tax_adapter_protocol_error` 并使会话 `failed`。
- `sessionId` 形如 `taxs_<32 位 base64url>`，由 `crypto.randomBytes(24)` 生成，**不可猜**。
- 会话**只存在于网关进程内存**，重启即失效；不写数据库、不写文件。
- 会话绑定 `region` 与 `accountSetId`（提供时必须通过本地账套校验）与可选 `enterprise`。
- `expiresAt` 用于失效判断；到期后任何查询/验证都返回 `tax_session_expired`。
- `logout` 之后该会话不能再查询（`tax_session_logged_out`）；重复退出幂等返回 `logged_out`。
- 查询时若传入与会话不一致的 `region` / `accountSetId`，直接拒绝（`tax_region_mismatch` /
  `tax_account_set_mismatch`），**不允许跨地区或跨账套读取**。

### 异步与并发下的终态保证

适配器调用是异步的，因此「调用发起」与「结果返回」之间可能发生退出/过期。网关对此有四条硬约束：

1. **`logout` 先本地终结、再通知适配器。** 进入 `logout` 后立即把会话置为 `logged_out`
   并清空 challenge / failure / credentialRef，然后才 `await adapter.logout(ctx)`（用旧 ctx）。
   因此即便远端退出很慢或失败（只记 `warning`），**本地会话在 `logout` 返回前就已不可用**：
   任何 `tax_info_query` / `tax_login_challenge` 都会拿到 `tax_session_logged_out`。
2. **迟到的结果不得复活终态会话。** `startLogin` / `getStatus` / `submitChallenge` / `infoQuery`
   在 `await` 适配器之后**重新判定终态**（含过期刷新）：
   - `startLogin`：会话在登录结果返回前就过期时抛 `tax_session_expired`，**迟到的 `authenticated`
     绝不写回会话**——尤其不能返回「已认证、但 `expiresAt` 已经过去」的僵尸会话；
   - `getStatus`：直接返回当前（终态）视图，不采纳迟到结果；
   - `submitChallenge` / `infoQuery`：抛出对应的 `tax_session_logged_out` / `tax_session_expired`
     / `tax_session_failed`，**绝不输出数据**。
   一条在等待期间被 `logout` 的查询，即使远端随后返回了「已认证」或真实数据，也不会写回会话、
   更不会出现在响应里。
3. **过期即终态，且过期状态不可被适配器翻盘。** 会话过期后是终态，之后的任何迟到结果都同样被丢弃；
   终态会话根本不会再调用适配器，因此**已过期的会话不会因为适配器给出更大的 `expiresAt` 而复活**。
   对未进入终态的会话，适配器仍可通过 `getStatus` 合理地延长 `expiresAt`（见「无变更」约定）。
4. **适配器响应里给出的 `expiresAt` 若已经过去，会话即时过期**，不会停在 `authenticated`：
   `startLogin` / `submitChallenge` 抛 `tax_session_expired`，`getStatus` 返回 `expired` 视图。
   判定发生在「采纳适配器状态之后」，所以「成功响应里带一个过期时间」同样不成立。

回归测试用**本地 deferred Promise** 复现这些交错：先挂起登录/查询/验证，再 `logout` 或让时钟越过
`expiresAt`，最后 `resolve` 迟到的「已认证」/数据，断言终态未被复活、数据未输出、
`expiresAt` 未被改写。这些用例完全在进程内构造，不涉及任何真实网络。

### 人工验证

- `challenge` 的**动作类型由适配器定义**（验证码/扫码/实名确认等），网关不预设、不枚举、不代替人工操作。
- 网关**没有任何跳过人工验证的入口**：不存在「force」「skip」「bypass」参数，也不会自动提交。
- `challengeResponse` 只透传给适配器判定：**不落库、不写文件、不回显、不写日志**。
  但它**会以「已知明文」的形式留在网关进程内存里**——这是「不回显」的实现方式：
  适配器后续任何输出里出现同一个值都会被替换成 `***`。该登记随会话终结（`logout` / 过期）清理，
  全局与每会话都有条数上限；**但这仍然不是「零留存」**，接真实系统前必须整改（见 §9）。

---

## 4. 凭据引用

- 生产调用只接受 **`credentialRef`（凭据引用）**，例如 `vault://tax/<地区>/<办税员>`。
- 请求中出现 `password` / `passwd` / `username` / `token` / `cookie` / `otp` / `credentials`
  等明文凭据字段（含嵌套），一律 `tax_plaintext_credential_rejected`，**在检查地区之前就拒绝**。
- 网关只在内存中保存 `credentialRef` 引用本身，`tax_login_status` 只返回 `hasCredentialRef: true`，
  不回显引用值；`logout` 时连同该会话登记的明文一起清除。未接入地区不会保存任何账密。
- `credentialRef` 同时被登记为「已知明文」：适配器若把它回显在 challenge 提示、白名单字段或
  错误码/错误信息里，同样会被替换成 `***`（见 §5）。
- 第一期不接入真实凭据库/密钥管理，`credentialRef` 只是一个待后续实现的约定字段。

---

## 5. 输出 DTO 白名单与脱敏

- `tax_info_query` 的响应按资源类型套用固定白名单，**只有白名单里的标量字段会输出**；
  适配器返回的 `cookies` / `access_token` / `password` / 嵌套内部结构一律丢弃。
- 敏感字段强制掩码：证件号留前 6 后 4，纳税人识别号留前 4 后 4，姓名只留首字，手机号留前 3 后 4；
  掩码之后再叠加一遍已知明文替换。
- **已知明文（本次会话提交过的人工验证响应、`credentialRef`）在所有「适配器可输出字段」上一致清除**，
  不存在「用安全键名包装秘密」的旁路：
  - `challenge` 的 `prompt` / `hint` / `action`；
  - DTO 白名单里的字符串字段与字符串数组；
  - 适配器的错误码与错误信息（错误码形态合法但命中已知明文时，直接换成通用码
    `tax_adapter_error`，不用「安全键名」把秘密带出去）；
  - `challenge` 提示与协议错误信息里回带的适配器值（如非法 `status`）。
  `expiresAt` 这类时间戳字段不能整段替换（会破坏时间语义），命中已知明文时**判为无效值丢弃**。
- **先脱敏、再截断**：challenge 提示 300 字符、DTO 标量 200 字符、字符串数组项 60 字符。
  顺序反了会把恰好跨过截断边界的秘密片段原样漏出。
- 已知明文登记覆盖**数字型响应**（`response` 是 `123456` 这样的数字时同样登记与抹除）、
  数组/对象里的标量，长度下限为 **3**——短验证码不再漏网。
- 适配器抛出的异常文本先脱敏再返回：`Bearer xxx`、JWT、`key=value` / `key: value` 形式的
  凭据，以及上列已知明文，全部替换为 `***`；不返回堆栈。

---

## 6. 错误码

| 错误码 | 含义 |
|---|---|
| `tax_region_required` / `tax_region_unknown` | 未给地区 / 地区标识非法 |
| `tax_region_not_a_tax_target` | 用了 `CN`（全国只是产品入口，不是税务服务地区）作为登录/注册目标 |
| `tax_region_out_of_scope` | 港澳台：不同税务管辖体系，不在本期大陆目录内 |
| `tax_region_not_configured` | 该地区没有已接入适配器（**默认状态**，不创建会话） |
| `tax_adapter_not_found` / `tax_adapter_required` | 指定适配器不存在 / 多适配器未指定 |
| `tax_adapter_invalid` | 适配器声明非法（注册时拒绝，含注册到 `CN`） |
| `tax_login_method_unsupported` | 适配器不支持该登录方式 |
| `tax_plaintext_credential_rejected` | 传了明文凭据字段 |
| `account_set_not_found` / `accountSetId_invalid` | 本地账套不存在 / ID 非法 |
| `tax_account_set_verification_unavailable` | 网关未接入账套校验，拒绝绑定 |
| `tax_login_unsupported` / `tax_login_failed` | 适配器未实现 startLogin / 发起登录失败（含异步拒绝） |
| `tax_session_not_found` / `tax_session_id_required` | 会话不存在 / 未提供 |
| `tax_session_not_authenticated` | 会话尚未完成人工验证 |
| `tax_session_expired` / `tax_session_failed` / `tax_session_logged_out` | 会话已失效（含迟到结果命中终态） |
| `tax_challenge_action_mismatch` / `tax_challenge_response_required` / `tax_challenge_not_expected` | 验证动作/响应问题 |
| `tax_challenge_unsupported` / `tax_challenge_failed` | 适配器未实现 / 验证失败（含异步拒绝） |
| `tax_session_already_authenticated` | 已认证会话重复提交验证 |
| `tax_resource_required` / `tax_resource_unknown` / `tax_resource_unsupported` | 资源参数问题 |
| `tax_query_unsupported` / `tax_query_failed` | 适配器未实现 query / 查询失败（含异步拒绝） |
| `tax_query_params_invalid` / `tax_query_param_reserved` / `tax_query_param_unknown` / `tax_query_param_invalid` | `params` 不是扁平对象 / 命中作用域保留名 / 未知键 / 值非标量 |
| `tax_region_mismatch` / `tax_account_set_mismatch` | 跨地区 / 跨账套读取被拒 |
| `tax_adapter_protocol_error` | 适配器返回非法状态、空对象（startLogin/submitChallenge）、或 `requires_action` 缺 challenge |

---

## 7. 地区接入矩阵（逐个验收）

新增一个地区适配器时，必须逐项补齐下表，**没有证据的行不得填「已接入」**。

地区目录以官方 12366 为准：省级行政区 + 计划单列市（大连 / 宁波 / 厦门 / 青岛 / 深圳），
来源见 <https://12366.chinatax.gov.cn/wap/pages/index.html> 与
<https://12366.chinatax.gov.cn/wap/pages/form_common.html>（后者要求计划单列市**直接选市税务局、勿选所在省**）。

### 7.1 产品入口（不是税务服务地区）

| 地区 | 类型 | 说明 | 真实环境联调 |
|---|---|---|---|
| 全国 `CN` | `nationwide` | 产品入口/目标，`taxTarget=false`：不能注册适配器、不能登录 | 不适用 |

### 7.2 大陆税务服务地区（31 省级行政区 + 5 计划单列市）

| 地区 | 码 | 类型 | 归属 | 适配器 ID | 实现位置 | 登录方式 | 可查资源 | 人工验证 | 会话/过期验证 | 脱敏与不回显验证 | 真实环境联调 | 验收人/日期 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 北京市 | 110000 | province | — | — | — | — | — | — | — | — | 未开始 | — |
| 天津市 | 120000 | province | — | — | — | — | — | — | — | — | 未开始 | — |
| 河北省 | 130000 | province | — | — | — | — | — | — | — | — | 未开始 | — |
| 山西省 | 140000 | province | — | — | — | — | — | — | — | — | 未开始 | — |
| 内蒙古自治区 | 150000 | province | — | — | — | — | — | — | — | — | 未开始 | — |
| 辽宁省 | 210000 | province | — | — | — | — | — | — | — | — | 未开始 | — |
| 大连市 | 210200 | separately_planned_city | 210000 | — | — | — | — | — | — | — | 未开始 | — |
| 吉林省 | 220000 | province | — | — | — | — | — | — | — | — | 未开始 | — |
| 黑龙江省 | 230000 | province | — | — | — | — | — | — | — | — | 未开始 | — |
| 上海市 | 310000 | province | — | — | — | — | — | — | — | — | 未开始 | — |
| 江苏省 | 320000 | province | — | — | — | — | — | — | — | — | 未开始 | — |
| 浙江省 | 330000 | province | — | — | — | — | — | — | — | — | 未开始 | — |
| 宁波市 | 330200 | separately_planned_city | 330000 | — | — | — | — | — | — | — | 未开始 | — |
| 安徽省 | 340000 | province | — | — | — | — | — | — | — | — | 未开始 | — |
| 福建省 | 350000 | province | — | — | — | — | — | — | — | — | 未开始 | — |
| 厦门市 | 350200 | separately_planned_city | 350000 | — | — | — | — | — | — | — | 未开始 | — |
| 江西省 | 360000 | province | — | — | — | — | — | — | — | — | 未开始 | — |
| 山东省 | 370000 | province | — | — | — | — | — | — | — | — | 未开始 | — |
| 青岛市 | 370200 | separately_planned_city | 370000 | — | — | — | — | — | — | — | 未开始 | — |
| 河南省 | 410000 | province | — | — | — | — | — | — | — | — | 未开始 | — |
| 湖北省 | 420000 | province | — | — | — | — | — | — | — | — | 未开始 | — |
| 湖南省 | 430000 | province | — | — | — | — | — | — | — | — | 未开始 | — |
| 广东省 | 440000 | province | — | — | — | — | — | — | — | — | 未开始 | — |
| 深圳市 | 440300 | separately_planned_city | 440000 | — | — | — | — | — | — | — | 未开始 | — |
| 广西壮族自治区 | 450000 | province | — | — | — | — | — | — | — | — | 未开始 | — |
| 海南省 | 460000 | province | — | — | — | — | — | — | — | — | 未开始 | — |
| 重庆市 | 500000 | province | — | — | — | — | — | — | — | — | 未开始 | — |
| 四川省 | 510000 | province | — | — | — | — | — | — | — | — | 未开始 | — |
| 贵州省 | 520000 | province | — | — | — | — | — | — | — | — | 未开始 | — |
| 云南省 | 530000 | province | — | — | — | — | — | — | — | — | 未开始 | — |
| 西藏自治区 | 540000 | province | — | — | — | — | — | — | — | — | 未开始 | — |
| 陕西省 | 610000 | province | — | — | — | — | — | — | — | — | 未开始 | — |
| 甘肃省 | 620000 | province | — | — | — | — | — | — | — | — | 未开始 | — |
| 青海省 | 630000 | province | — | — | — | — | — | — | — | — | 未开始 | — |
| 宁夏回族自治区 | 640000 | province | — | — | — | — | — | — | — | — | 未开始 | — |
| 新疆维吾尔自治区 | 650000 | province | — | — | — | — | — | — | — | — | 未开始 | — |

### 7.3 域外（不同税务管辖体系，本期不覆盖）

| 地区 | 码 | jurisdiction | 说明 |
|---|---|---|---|
| 台湾省 | 710000 | TW | `outOfScope`：不属本期大陆税务服务目录，不建会话 |
| 香港特别行政区 | 810000 | HK | 同上 |
| 澳门特别行政区 | 820000 | MO | 同上 |

**当前整表为空：0 个地区已接入适配器（含计划单列市）。** 任何「全国都能登录」的说法都不成立。
计划单列市的六位码是本地路由键，需实地联调确认后才能作为路由依据。

### 单个地区的验收清单

1. 适配器实现放在 06-workbench/server 下（例如 `tax-adapter-<region>.mjs`），实现 §2.3 的方法。
   同步返回或返回 Promise 都可以；异步实现要以 §2.3 的返回值协议为准。
2. 在网关装配处显式注册；注册后 `tax_regions` 里该地区 `configured=true`，`summary.regionsConfigured` 计数 +1。
3. `tax_capabilities` 声明的 `resources` / `loginMethods` / `challengeActions` 与实现一致（不多报）。
4. 人工验证必须真实走通：验证码/扫码/实名确认由人完成，不得有自动通过分支。
5. 用临时数据与空闲端口跑通：未配置 → 待验证 → 已认证 → 查询 → 退出，以及过期、跨账套拒绝。
6. 计划单列市（大连/宁波/厦门/青岛/深圳）必须单独建适配器，**不能复用所在省的适配器**；
   路由按 `region` 精确匹配，不按 `parentRegion` 推断。
7. 真实凭据只经 `credentialRef` 注入，仓库、日志、报表、响应中不得出现明文。
8. 联调证据（脱敏后的请求/响应摘要、日期、执行人）补进上表后才可标「已接入」。

---

## 8. 测试

```bash
# 税务契约测试（网关单测 + MCP/后端接线往返；自动起临时后端与空闲端口，用临时数据目录）
node 05-reconstruction/codex/mcp/finance-mcp/tax-contract-test.mjs   # 59 项

# 既有 MCP ↔ HTTP 契约测试（回归，44 项）
node 05-reconstruction/codex/mcp/finance-mcp/contract-test.mjs

# 工作台回归（smoke，28 项）
node 06-workbench/test/smoke.test.mjs

# MCP 冒烟
node 05-reconstruction/codex/mcp/finance-mcp/smoke-test.mjs
```

覆盖点：默认未配置（目录为空、登录直接报错、不创建会话）、状态流转、
challenge 响应不回显、跨地区与跨账套隔离、过期、退出、不可用资源与未知资源、
明文凭据拒绝、恶意适配器错误/返回值中的凭据不泄漏、DTO 白名单与掩码、
以及 `tools/list` 与默认未配置真实后端的往返。

本轮新增的回归（针对预留接口能否真实扩展）：

- **异步适配器**：全部方法返回 Promise 的假适配器走通「登录 → 待验证 → 验证码错误重试 →
  已认证 → 查询 → 退出」，并断言异步结果不丢；异步拒绝被结构化
  （`tax_login_failed` / `tax_challenge_failed` / `tax_query_failed`），
  用例末尾统一断言**全程没有 unhandled rejection**。同步适配器仍保持可 `await` 兼容。
- **并发终态保护**：用本地 deferred Promise 先挂起 `getStatus` / `submitChallenge` / `infoQuery`，
  再 `logout` 或让时钟越过 `expiresAt`，最后 `resolve` 迟到的「已认证」或真实数据；
  断言终态（`logged_out` / `expired`）未被复活、迟到数据未输出、错误详情也不带出数据。
  另有用例确认 `logout` 即便远端很慢或失败，本地会话也**立即**不可用。
- **地区目录**：31 省级行政区 + 5 计划单列市（`kind` / `parentRegion` 齐全）、
  `CN` 只是产品入口（不能注册适配器、不能登录）、港澳台单列 `outOfScope` 且带
  `jurisdiction`（`TW` / `HK` / `MO`）、目录如实给出两条官方 12366 来源链接。
- **计划单列市独立路由**：深圳 `440300` 与广东 `440000` 各注册一个适配器，
  断言会话按 `region` 精确选择适配器、两地区数据互不串号、跨区读取被拒。
- **`params` 平面白名单**：`accountSetId` / `account_set_id` / `region` / `enterpriseId` /
  `taxpayerId` / `sessionId` 等作用域字段、未知键、以及 `{ filter: { accountSetId } }` 这类
  嵌套绕过、非标量取值全部被拒且**不触达适配器**；合法标量参数原样透传；
  绑定企业标识只来自会话上下文。
- **协议错误**：`startLogin` / `submitChallenge` 返回 `{}`、`null`、非对象或非法状态一律
  `tax_adapter_protocol_error` 且会话 `failed`（不是无限等待）；
  `requires_action` 无 challenge 同样协议错误；`getStatus` 的「无变更」约定
  （`null` / `undefined` / `{}` / 仅 `expiresAt`）被显式验证。
- **迟到登录与过期时间语义**：`async startLogin` 比会话 TTL 还慢时，迟到的 `authenticated`
  不写回会话、`expiresAt` 不被改写，而是抛 `tax_session_expired`；
  适配器响应里给出的 `expiresAt` 若已经过去，`startLogin` / `submitChallenge` 抛
  `tax_session_expired`、`getStatus` 返回 `expired`——**不会停在「已认证但已过期」**；
  已过期会话的 `expiresAt` 也不会被适配器延长复活。
- **脱敏边界**：适配器用 `challenge.prompt` / `hint` / `action`、DTO 白名单字符串与数组、
  错误码/错误信息、协议错误信息（非法 `status`）回显验证响应或 `credentialRef` 时一律替换为 `***`；
  数字型响应与 **3 位短验证码**同样覆盖；秘密恰好跨过截断边界时也不漏（脱敏先于截断）；
  `expiresAt` 命中已知明文时判为无效值。
- **明文暂存生命周期**：会话 `logout` / 过期即清理该会话登记的明文，清理之后的迟到输出
  仍由终态保护拦下（不因清理而泄漏）；全局与每会话暂存都有条数上限，
  反复提交（700 次）不会无界累积。

测试用的假适配器**只在测试进程内构造并注入**，不进入生产默认网关，
也不通过任何普通 API 暴露「注册适配器 / 加载模块」的能力。

---

## 9. 第一期明确未做的事

- 未接入任何真实电子税务局，未验证任何地区的网址、协议或统一登录方式；
  文中的地区编码只是标识，不含任何具体接口信息。计划单列市的六位码是本地路由键，
  需实地联调确认。
- 未实现真实登录自动化、验证码识别、扫码/实名对接（人工验证保留给人）。
- 未实现税额计算、申报表生成、缴款等业务逻辑；`declaration_query` 等原站工具仍为 `not_implemented`。
- 未接入凭据管理系统，`credentialRef` 仅有约定语义。
- **人工验证响应的内存暂存不是「零留存」**：为了把适配器后续输出里的同一个值抹掉，网关必须把它
  作为「已知明文」留在进程内存里（随会话终结清理、全局 500 条 / 每会话 50 条上限）。
  这是本期为了「绝不回显」而做的折中，**接真实电子税务局之前必须整改**：改成不依赖明文暂存的
  设计（例如适配器只回传判定结果、由适配器侧保证不回显；或用一次性 HMAC / 摘要比对），
  并在真实联调中验证。
- **会话对象不做过期回收**：`logout` / 过期的会话仍留在进程内存的会话表里（只清掉它登记的明文），
  进程重启即全部消失。会话数量长期只增不减，接真实系统前需要一并整改（定期回收 + 上限）。
- 未提供适配器热加载/配置化注册（这是有意为之的安全取舍）。
- 未对港澳台做任何接入设计：它们属于不同税务管辖体系，本期只在目录里标注 `outOfScope`。
