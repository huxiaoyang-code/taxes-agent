# 税局接口目录 · TAX API CATALOG

> 目的：把**现成逆向分析材料**里明确列举的税局接口，整理成后端可检索、可校验、可做调用准备的**结构化目录**。
> 本目录只做「已管理」登记与静态校验：**不联网、不访问税局、不执行任意 URL / 源码、不伪造真实请求**。
> 「目录已管理」≠「线上调用已验证」。当前线上已验证接口数为 **0**。

- 任务单：[tasks/TAX-API-CATALOG](tasks/TAX-API-CATALOG.md)
- 交接：[handoffs/TAX-API-CATALOG](handoffs/TAX-API-CATALOG.md)
- 代码：`06-workbench/server/tax-api-catalog.mjs`（目录）、`tax-api-catalog-classify.mjs`（分类器）、`tax-api-catalog-readiness.mjs`（调用准备）
- 状态：**实现 / 管理者回归完成，待最终 head 审查与 PR 合并；合并结论以 PR 与 Git 为准**。测试时序：管理者较早一次全量 44/44 套 exit 0 属基线；随后独审发现分类器把空结果族业务码与 HTTP 401/403/500 误判为 `business_empty`，员工已定向修为 `structure_unrecognized`（不重试、全局仍 `unknown`，`empty` + 2xx 保留正常），主审再次实际运行受影响三套（目录 32 / HTTP 10 / MCP 5，全部 exit 0）；**未在小修后重跑全 44 套**。

## 1. 材料与来源

| 项 | 值 |
|---|---|
| 来源 | 本机现成分析报告（`etax_rea_work`，福建电子税务局登录页逆向） |
| 报告 SHA256 | `0d2f4b8f729b34014315507510bc9aa07d35f8f8d3c04af2fe6f961e87eb4a1c` |
| 报告规模 | 153 行 / 8,605 字符 |
| 取证类别 | 报告 3 / 4.1–4.4 / 133 节为**观察**；6.1 / 6.2 / 6.3 节为**静态列举** |
| 是否入 Git | **否**。原文与 JS 产物不入仓库，只登记技术合同字段与行号 |

本次不再次逆向、不爬站、不运行 REA / AST / 脚本，不读浏览器、凭据、账套库与旧私有采集目录。

## 2. 覆盖计数（诚实口径）

`tax_api_catalog_modules` 与 `catalogStats()` 返回同样的事实。**登记数 = 报告明确列出的接口数**：29 模块 / 131 条，每条都带报告行号；不存在“报告未列出却被登记”的条目（`entriesNotListedByReport: 0`）。

| 指标 | 数量 |
|---|---|
| 模块 / 目录条目（= 报告明确列出） | 29 / 131 |
| 受影响三套测试项（小修后实测） | 目录 32 / HTTP 10 / MCP 5，全部 exit 0 |
| 含静态路径模板 / 无静态路径（通配分组或未给具体路径） | 127 / 4 |
| 其中路径为报告写出 / 按命名推断 | 127 / 0 |
| 方法已知 / 方法未知 | 24 / 107 |
| 参数结构已载明（`observed`） | 6 |
| 参数结构推断（`inferred`，报告未逐项确认） | 1 |
| 仅共享传输信封已知（`envelope_only`） | 73 |
| 参数结构未知（`unknown`） | 51 |
| 缺少已载明参数合同的条目 | 125 |
| 响应已载明 / 响应未知 | 21 / 110 |
| 身份前置条件已解析 / 未知 | 54 / 77 |
| 企业前置条件已解析 / 未知 | 0 / 131 |
| 权限前置条件已解析 / 未知 | 0 / 131 |
| 已载明参数键（`observed`，其中敏感 4 个只登记不收值） / 推断参数键（`inferred`，其中敏感 1 个） / 声明总计 | 20 / 1 / 21 |
| 用途证据：报告载明 / 按名称推断 | 80 / 51 |
| 证据类别 | 观察 24 / 静态 107 |
| 方法 | POST 15 / GET 9 / unknown 107 |
| 风险 | 只读 64 / 写 13 / 认证 53 / 未知 1 |
| 契约完整度 | full 0 / 方法+参数 6 / 方法+响应 0 / 方法 18 / 参数 0 / 仅路径 103 / 无路径 4 |
| 默认自动执行 / 线上调用已验证 | **0 / 0** |

**参数计数口径**：`documentedParamCount` 只统计 `paramsEvidence=observed` 的字段（20），`inferredParamCount` 单列推断（1），`declaredParamCount` 为登记总数（21）；推断不得冒充已载明，敏感键同理（已载明 4 / 推断 1）。

**路径口径**：报告只给出 `passwordLogin(ForUser)` 这类分组形态时，不补造具体路径；`identity.password.enterprise_password_login_for_user` 保持 `pathTemplate=null` + `pathEvidence=unknown` 并列入缺口（完整度落在 `unknown` 层）。

**为什么 full_contract = 0**：完整可调用契约要求路径、方法、参数、响应与适用前置条件（身份 / 企业 / 权限）都有证据。当前报告没有逐条载明响应结构，也没有任何接口载明企业绑定与权限要求，所以没有任何条目满足。

报告 6.2 节自称认证平台「200+ 端点」，但实际只**分类列举**了一部分：目录已登记认证域 75 条，**其余未列名端点不视为已登记**。统计字段 `reportClaimedIdentityEndpoints` 与 `reportClaimIsNotCoverage: true` 明确区分“宣称”与“契约/覆盖”：

- 「现成材料明确列出的接口」已全部录入（131 条）；
- **不宣称**已实现全站 200+ 端点，也不宣称覆盖全部业务模块；
- 登录提交类接口（`accountLogin` 等）报告只做静态提取、未实际触发，目录按 `static` 登记。

超时阈值（只读 15s / 认证与写 30s）是**本地策略默认值**，不是税局 SLA 或官方时限（`catalogStats().timeoutNote`、`classifyOutcome().timeoutPolicy = "local_policy_default_not_tax_sla"`）。

### 2.1 目录已登记 ≠ 线上已验证

| 维度 | 数量 |
|---|---|
| 目录已登记条目（`catalogManaged`） | 131 |
| 线上调用已验证条目（`liveCallVerified`） | **0** |
| 真实适配器（`adapterBinding`） | 全部 `missing` |

本目录模块的 `liveCallVerified=0` 只描述**本次目录包**：它没有新增任何真实调用，也不代表项目此前其它子包从未有过真实查询。

## 3. 条目契约

每条目录项（`tax_api_catalog_entry` 返回）字段：

| 字段 | 说明 |
|---|---|
| `id` | 稳定技术 id（如 `portal.mhzx.home.get_user_info`），只接受目录内固定 id |
| `module` / `moduleLabel` / `service` | 域 / 模块分组；`service` ∈ `portal` / `identity` / `behavior` / `service_desk` |
| `purpose` | 中文用途；按名称推断的会写明「用途按名称推断」 |
| `purposeEvidence` | `reported` / `inferred_from_name`：用途是否仅按接口名推断 |
| `method` | `GET` / `POST` / `unknown`（报告未载明就写 unknown） |
| `pathTemplate` | 静态路径模板，不含主机、端口、动态标识与查询串；通配分组为 `null` |
| `pathEvidence` | `reported` / `inferred_from_name` / `unknown`：路径是报告写出还是按命名推断 |
| `params` | 参数键 / 位置 / 类型 / 是否必填 / 来源；**未知不等于无参数** |
| `paramsEvidence` | `observed` / `inferred` / `envelope_only` / `unknown`（`inferred` 明确标“报告未逐项确认”） |
| `sensitive` / `valueAccepted` | 凭据、会话、授权码、口令类参数只登记依赖与类型，`valueAccepted=false`：不接受参数值，也不经 MCP 返回 |
| `paramGaps` | 具体缺口说明，未知/推断参数条目必有 |
| `envelope` / `envelopeContract` | 共享传输信封（字段与请求头名，不含任何密钥或实例值） |
| `responseEvidence` / `responseNotes` | 响应证据级别与已知约定（302 响应体不可读等） |
| `errorNotes` | 错误约定；未载明即写未载明 |
| `pagination` | 分页依赖；列表接口未载明语义时标 `unknown` |
| `download` | 是否下载类接口 |
| `identityDependency` / `enterpriseDependency` / `permissionDependency` | 身份 / 企业 / 权限依赖，未知即 `unknown` |
| `risk` | `read_only` / `state_changing` / `authentication` / `unknown` |
| `evidence` / `evidenceLabel` | `observed` / `static` / `inferred` / `unknown` |
| `completenessGaps` | 缺少的证据项（`method` / `params_*` / `response` / `identity_precondition` / `enterprise_precondition` / `permission_precondition` 等） |
| `reportLines` | 报告行号 |
| `autoExecutable` | 恒为 `false`：登录与写接口永不被默认开放执行 |

不使用「固定 URL 代理」，也不接受 `url` / `source` / `regex` 等任意输入；检索只接受固定结构条件。

## 4. 后端与 MCP 通路

后端 `POST /agent/tools/<name>`（`server.mjs` → `agent-tools.mjs`），MCP 侧由 `finance-mcp/tools.mjs` 公布 schema：

| 工具 | 作用 |
|---|---|
| `tax_api_catalog_modules` | 模块列表 + 覆盖统计；可传 `moduleId` 看单模块条目 |
| `tax_api_catalog_search` | 分页检索：`module` / `service` / `method` / `risk` / `evidence` / `completeness` / `text` + `page` / `pageSize` |
| `tax_api_catalog_entry` | 单条合同详情 |
| `tax_api_catalog_validate` | 参数校验（必填 / 类型 / 未知字段 / 凭据与运行时地址拒绝） |
| `tax_api_catalog_prepare` | 调用准备：参数 + 上下文引用 + 权限 + 目录合同 → `not_ready` / `blocked_by_policy` / `contract_ready_adapter_missing` |
| `tax_api_catalog_classify` | 纯响应/失败分类 |
| `tax_api_catalog_outcomes` | 分类枚举与规则口径 |

检索与详情结果**始终**带 `catalogManaged: true` 与 `liveCallVerified: false`，并在 `note` 中说明区别。
`module` / `service` / `method` / `risk` / `evidence` / `completeness` 条件命中不了已知值时返回 `catalog_module_unknown` / `catalog_filter_invalid`，
不会用 0 条结果冒充「该模块没有接口」。

**只回显规范字段**：`filters` 只包含经过校验的 `module` / `service` / `method` / `risk` / `evidence` / `completeness` 枚举与
`textProvided`（布尔）/ `textLength`（整数）/ `textApplied` / `page` / `pageSize`，不会 `{ ...input }`，也不回显调用方自由文本（只告知是否用过检索词及长度）；对象/数组/嵌套值一律拒绝。错误消息不回显未知键名与原文。

Agent HTTP 入口（`POST /agent/tools/<name>`）与 MCP 共用同一套后端校验：不依赖 MCP schema 做安全边界，
直接调用 HTTP 同样拒绝额外字段、未知键名与任意值。

## 5. 统一结果分类器

枚举（`OUTCOMES`，10 项；前 9 项为任务要求）：

| id | 含义 |
|---|---|
| `not_sent` | 未发出 |
| `transport_timeout` | 传输超时 |
| `transport_failed` | 传输失败（非超时的连接/协议错误） |
| `response_unparsed` | 已收响应待解析 |
| `auth_required` | 认证要求 |
| `permission_denied` | 明确无权限 |
| `business_empty` | 业务空结果（空结果族在已解析且结构识别、元数据无矛盾时可判；`success` 族结合明确空证据也可判。`httpStatus` 可省略；显式提供且与非 2xx 冲突才 `structure_unrecognized`） |
| `success` | 成功（已解析 + 结构识别 + 成功族业务码；不要求必须提供 `httpStatus`） |
| `structure_unrecognized` | 结构不识别 |
| `business_error` | 业务错误 |

规则：

1. **严格类型校验**：所有已知字段必须是布尔 / 非负整数 / 固定枚举，`httpStatus` 100–599，`retryAttempt` 0–10，`elapsedMs` 0–3 600 000。
   `schemaRecognized: "false"` 这类字符串或对象真值不会被当成 true，直接 `classify_input_invalid`；未知字段 `classify_field_rejected`。
2. **矛盾元数据不成功**：如成功族 + 认证/无权限信号、成功族 + 非 2xx 状态、成功族 + 非零计数却声明空证据、
   空族 + 非零计数、业务码族缺失却无业务码、显式 `responseReceived=false` 却带 `bodyParsed` / `schemaRecognized` /
   业务码 / 结果计数等响应证据，一律 `structure_unrecognized` 并在 `contradictionCodes` 列出固定原因码（`success_family_on_non_2xx_status` / `response_absent_with_response_evidence` 等）；
   这类矛盾**不得**据此判全局登录失效。显式 `responseReceived=false` 且无其他响应证据时按 `transport_failed` 归因（不是“收到待解析”）；
   省略 `responseReceived` 保持旧兼容行为。
3. **HTTP 200 不等于成功**：`httpStatus` 只作为元数据，`httpStatusIsSuccessAlone` 恒为 `false`。裸 200 只能落到 `structure_unrecognized`。
4. **零事件不等于空数据**：`resultCount === 0` 但没有显式空证据时判 `structure_unrecognized`，不判 `business_empty`。
   显式空证据由空结果族业务码，或 `success` 族 + `emptinessEvidence` 提供（不要求两者同时具备）。
   `httpStatus` 可省略；只有显式提供且 success/empty 与之冲突（非 2xx）时才判 `structure_unrecognized`，不误判为空业务数据、不重试、不改 `globalSessionState`（继续保持 `unknown`）。
   裸 `httpStatus: 200` 单独不能证明成功，也不单独构成空证据。
5. **不提供全局会话推断入口**：分类结果带 `sessionScope: "call_only"` 与 `globalSessionState: "unknown"`；
   已删除仅凭调用方布尔 `sessionProbe` 就输出 `login_required` 的入口。真实全局会话校验使用既有 `tax_session_verify` 的可靠证据，
   本目录模块不接入实网、也不从单接口结果推断登录失效。
6. **只收安全元数据**：输入只允许布尔 / 计数 / 枚举（`requestIssued` `phase` `transportError` `httpStatus` `bodyParsed`
   `schemaRecognized` `businessCodeFamily` `businessCodePresent` `resultCount` `emptinessEvidence` `authSignal`
   `permissionSignal` `elapsedMs` `retryAttempt`）；出现 `body` / `message` / `raw` / `url` / `businessCode`
   等字段直接 `classify_field_rejected`，**错误原文不回流模型**。
7. **静态重试能力与本次建议分开**：`retryCapability` 只表示该类风险原则上能否重试（只读可用，认证/写/未知不可用）；
   `retryAdvice` 才是本次建议，只有「只读 + 传输超时/传输失败 + 未用尽次数」才 `allowed=true`。
   `success` / `business_empty` / `auth_required` / `permission_denied` / `business_error` / `structure_unrecognized` / `not_sent`
   以及次数耗尽一律 `allowed=false`。超时只说明未在阈值内收到，不猜无权限、不判全局登录失效。
8. **超时是本地策略**：`timeoutMs` 只读 15s / 认证与写 30s，`timeoutPolicy = "local_policy_default_not_tax_sla"`，不是税局 SLA。
9. 汇总 `aggregateOutcomes` 只做计数与分组，不给全局会话结论。

## 6. 调用准备层

`tax_api_catalog_prepare` 校验：

- 目录合同：静态路径、方法、参数结构（`observed` / `inferred` / `envelope_only` / `unknown` 分别给不同缺项码）、响应结构、是否仅静态列举（`not_observed_live`）；
- 参数：与目录合同逐项比对，参数值不回显；凭据/授权码类参数只登记不接受值；`problems.field` 只可能取目录内已载明参数名或 `null`，**不回显任意键名**；
- 上下文引用：`accountSetId`（**严格正整数**：只接受 number 安全整数或纯十进制数字串，`true` 不再变成 1）、`enterpriseRef`、`loginSessionRef`、`period`、`permissions`；
- 账套存在性：调用方注入 resolver，**约定必须同步返回布尔**。返回 `true` 才算核实；返回 `false` 或抛错一律 `account_set_not_found`；返回非布尔为 `account_set_unverified`；未注入也是 `account_set_unverified`；
- 引用与权限：`enterpriseRef` / `loginSessionRef` / `period` / `permissions` / `operatorConfirmed` **只做格式校验**，`contextVerification` 明确 `userDeclaredRefsFormatOnly` / `userDeclaredPermissionsFormatOnly`，且 `enterpriseOwnershipChecked` / `loginSessionValidityChecked` / `permissionGrantChecked` 恒为 `false`——不声称已检查企业归属、会话有效性或权限授予；
- 策略：`authentication` / `state_changing` / `unknown` 风险一律 `blocked_by_policy`。

结论状态：

| 状态 | 含义 |
|---|---|
| `blocked_by_policy` | 登录/写/未知风险，Agent 不得自动执行 |
| `not_ready` | 存在明确缺项（合同或上下文），不能发起调用 |
| `contract_ready_adapter_missing` | 合同与上下文齐备，但仍**没有真实适配器**、从未线上验证 |

`readyToInvoke` 恒为 `false`，`adapterBinding` 恒为 `"missing"`；保留未来适配器接入口，但不实现代理、不接受任意 URL、不执行登录/写操作。
`transport.retryCapability` 是静态能力，`transport.retryAdvice.allowed` 恒为 `false`（本层未发请求，不产生重试建议）。

## 7. 已知缺口（明确未完成）

1. 认证平台信封的**签名串拼接顺序**与业务字段：报告自述未 100% 还原；SM4/SM2 流程只有观察结论。
2. 绝大多数端点只有路径：方法未知（107 条）、参数结构未知（51 条）、参数推断（1 条）或仅信封已知（73 条）；响应未知 110 条。
3. 前置条件几乎全缺：企业绑定 131 条全部 `unknown`、权限要求 131 条全部 `unknown`、会话要求 77 条 `unknown`。
4. 完整可调用契约（路径+方法+参数+响应+前置条件）**0 条**；最高档只有 6 条 `method_and_params_documented`。
5. 3 个通配分组（`/auth/entrance/*`、`/auth/general/*`、`/auth/agency/quick/*`）成员未列出；
   另有 1 条（`identity.password.enterprise_password_login_for_user`）报告只写 `passwordLogin(ForUser)` 分组形态、无独立路径，保持 `pathEvidence=unknown` 而不补造。
6. `qrcodeAuth` 分组与 licence 分组报告以省略号结尾，成员未列全。
7. 报告 302 响应体不可读，门户多接口的响应结构为 unknown。
8. 认证域前缀在报告中同时出现 `/api/v1.0`（登录入口）与 `/sys-api/v1.0`（其余列举）两种写法，归属未核实，每条认证条目都带该提示。
9. 无任何真实适配器、无地区接入、无线上验证证据；不实现任意代理，不连接税局。
10. 目录范围 = 现成材料范围，不等于全国 / 全站完整覆盖；报告自称的 200+ 认证端点为**宣称**，不是已登记契约数。

## 8. 恢复与边界

- 既有采集授权沿用，不需要逐项重新申请：本轮**没有**发起任何真实探索，是因为用户已暂停当日真实探索，需要用户明确说继续才恢复；
- 恢复真实接入/采集时必须由用户明确授权继续，并遵守既有安全边界（不把原始材料、凭据、响应与业务原值进仓库 / 模型）；
- 本目录的 `liveCallVerified=0` 只说明**本包从未发起真实调用**，不是对项目历史真实查询的整体断言。
