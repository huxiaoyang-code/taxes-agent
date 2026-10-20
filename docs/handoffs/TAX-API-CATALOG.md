# 交接 · TAX-API-CATALOG

> 任务：[tasks/TAX-API-CATALOG](../tasks/TAX-API-CATALOG.md) · 契约：[TAX-API-CATALOG](../TAX-API-CATALOG.md)
> 分支：`codex/huxiaoyang-code/tax-api-catalog`（本包由管理者提交，员工不做 Git）
> 工作区：本机 worktree，路径见 ignored checkpoint（`.agent-runs/`），不写入版本化文档
> 基线：`9b7bef3fd0b505ac3478345c9ed4912ff70213c0`（PR #40 合并后）

## 1. 一句话结果

现成报告明确列举的税局接口已整理成 **29 模块 / 131 条** 的结构化目录，后端与 MCP 均可检索、分页、看详情、校验参数、做调用准备，并配有统一结果分类器。**本包线上已验证接口 0 个**，无真实适配器，未连接税局。

## 2. 覆盖计数（与 `catalogStats()` 同源）

| 指标 | 数量 |
|---|---|
| 模块 / 条目（= 报告明确列出） | 29 / 131 |
| 静态路径模板已知 / 无路径（通配分组或未给具体路径） | 127 / 4（路径均为报告写出；报告只给分组形态的 1 条不补造路径） |
| 方法已知 / 未知 | 24 / 107 |
| 参数：已载明 / 推断 / 仅信封 / 未知 | 6 / 1 / 73 / 51（已载明参数键 20 / 推断 1 / 声明 21；敏感键已载明 4 + 推断 1，只登记不收值） |
| 响应：已载明 / 未知 | 21 / 110 |
| 前置条件：身份已解析 / 未知 | 54 / 77 |
| 前置条件：企业已解析 / 未知 | 0 / 131 |
| 前置条件：权限已解析 / 未知 | 0 / 131 |
| 证据：观察 / 静态 | 24 / 107 |
| 方法：GET / POST / unknown | 9 / 15 / 107 |
| 风险：只读 / 写 / 认证 / 未知 | 64 / 13 / 53 / 1 |
| 契约完整度：full / 方法+参数 / 方法+响应 / 方法 / 参数 / 仅路径 / 无路径 | 0 / 6 / 0 / 18 / 0 / 103 / 4 |
| 默认自动执行 / 线上已验证 | 0 / 0 |
| 认证域已登记 / 报告自称 200+ | 75 / 200（差额不视为已登记，`reportClaimIsNotCoverage=true`） |

来源：报告 SHA256 `0d2f4b8f729b34014315507510bc9aa07d35f8f8d3c04af2fe6f961e87eb4a1c`，153 行 / 8,605 字符；原文不入 Git。

**完整可调用契约 0 条**：full_contract 要求路径+方法+参数+响应+身份/企业/权限前置条件全部有证据；本报告没有逐条响应结构，也没有任何企业绑定/权限要求，所以原先 7 条 `full_contract` 是夸大，已改为 `method_and_params_documented` 并单独列 `completenessGaps`。

## 3. 测试（时序与范围必须分开读）

| 时点 | 范围 | 结果 |
|---|---|---|
| ① 基线（较早） | `06-workbench` `node scripts/test-all.mjs` 全量 | 管理者实际运行：exit 0，**44/44 套全部通过**（含当时 31 项的 catalog 套件） |
| ② 之后独审 | 受影响面 | 独审发现分类器缺陷：空结果族业务码、以及 HTTP 401/403/500 仍被判为 `business_empty`（误判） |
| ③ 员工定向修复 | 分类器 + 三套测试 | 改为 `structure_unrecognized`，且**不重试**、全局会话仍 `unknown`；`empty` + 2xx 保留为正常空结果；catalog 单测 31 → 32 项 |
| ④ 主审再次实际运行（小修后） | 仅受影响三套 | 目录 32 项、HTTP 10 项、MCP 5 项，**全部 exit 0** |

**口径要点**：44/44 全套是第 ③ 步小修**之前**的基线；小修后只改了分类器与三套对应测试，**未再重复运行全 44 套**，因此不声称“最终代码上重跑 44 套通过”。本次文档交接更新只改文档，不改变以上任何测试结论；未在本次交接中跑测试、未读日志。

测试会启动**临时合成 HTTP 服务 / MCP stdio 服务**（临时数据库 + 本机回环端口），结束时正常关闭并清理临时目录；未使用真实账套、凭据或税局。**原浏览器与税局后端全程未被触碰**。

## 4. 行为要点（供复审）

- 目录 id 是唯一入口：`url` / `source` / `regex` 等任意输入一律拒绝；错误消息不回显未知键名。
- `text` 检索串含 `://`、`/`、`:`、`@` 时返回 `catalog_arbitrary_input_rejected`。
- 未知 `module` 返回 `catalog_module_unknown`（不用 0 条结果冒充「无接口」）。
- `filters` 只回显规范化条件（枚举类 `module`/`service`/`method`/`risk`/`evidence`/`completeness` + `textApplied`/`page`/`pageSize`），不再 `{ ...input }`，也不回显调用方文本；对象/数组值直接拒绝。
- 参数含 `cookie` / `token` / `signature` / `password` 等键、`Bearer …`、JWT 形态、运行时完整地址、超 512 字符值一律拒绝且不回显值；`problems.field` 只可能是目录内已载明参数名或 `null`。
- 授权码等敏感参数（`code`、`token`、`cookie`、`password`）`valueAccepted=false`：只登记依赖，不接受参数值，不经 MCP 返回。
- 分类器严格校验每个已知字段的类型/枚举/范围：`schemaRecognized: "false"` 直接 `classify_input_invalid`，不会变成成功；未知字段 → `classify_field_rejected`。
- 分类规则（含独审后的定向修复）：`success` 需成功族业务码且非矛盾元数据（不要求必须提供 `httpStatus`）；`business_empty` 可由空结果族（已解析 + 结构识别 + 元数据无矛盾）或 `success` 族 + 明确空证据判出，显式空证据由空结果族或 `success` + `emptinessEvidence` 提供，不要求两者同时具备；`httpStatus` 可省略，显式提供且 success/empty 与非 2xx 冲突、以及成功族 + 认证/无权限信号、空族 + 非零计数等矛盾元数据，一律 `structure_unrecognized` + `contradictionCodes`，**不重试**、不改 `globalSessionState`（保持 `unknown`）。
- 计算结论：裸 200 单独不能证明成功（→ `structure_unrecognized`）；`resultCount: 0` 且无显式空证据 → `structure_unrecognized`。
- 会话：`sessionScope: "call_only"`、`globalSessionState: "unknown"`；**已删除** `sessionProbe` 推断入口，真实全局校验用既有 `tax_session_verify`。
- 重试：`retryCapability`（静态能力）与 `retryAdvice`（本次建议）分离；只读 + 传输超时/失败 + 未用尽才 `allowed=true`；`success` / `business_empty` / `structure_unrecognized` / `auth_required` / `permission_denied` / 业务错误 / 耗尽一律 false。
- 超时：`timeoutPolicy = "local_policy_default_not_tax_sla"`，不是税局 SLA。
- 准备层 `readyToInvoke` 恒 `false`、`adapterBinding` 恒 `"missing"`；`accountSetId` 严格正整数（`true` 不再变成 1），resolver 返回 `false` 也拒绝；引用/权限只做格式校验并明确 `unverified`（`enterpriseOwnershipChecked` / `permissionGrantChecked` 恒 false）。

## 5. 确切缺口（下一次要补什么）

1. 认证平台信封签名串拼接顺序、SM4/SM2 细节仍未 100% 还原（报告 8 节自述）。
2. 107 条方法未知、51 条参数结构未知、1 条参数推断、73 条仅信封已知、110 条响应未知：需要新的静态/授权证据才能补。
3. 企业与权限前置条件 131 条全未知、会话要求 77 条未知：无法判断任一企业可用。
4. 3 个通配分组（entrance / general / agency-quick）与 qrcodeAuth、licence 分组以省略号结尾，成员未列全。
5. 302 响应体不可读 → 门户多接口响应/错误约定仍 `unknown`。
6. 认证域前缀 `/api/v1.0`（登录入口）与 `/sys-api/v1.0`（其余列举）归属未核实。
7. 无真实适配器、无地区接入：`adapterBinding: "missing"` 是如实状态，不是待办遗漏。
8. 目录范围 = 现成材料范围；**不等于全国 / 全站完整**，也不等于报告自称的 200+ 认证端点。
9. `/loginb/`（登录页静态资源）与 tpass `/#/login`（SPA 路由）不是接口，未登记为目录项。

## 6. 恢复与边界

- 恢复只需读本文件 + [TAX-API-CATALOG](../TAX-API-CATALOG.md) + `06-workbench/server/tax-api-catalog*.mjs`。
- 本包**没有**新增任何浏览器 / 税局 / 凭据 / 账套访问路径；没有改 `tax-download-*`、`tax-browser-*`、`tax-collection-*` 现场逻辑；没有接出任意 URL、认证/写操作或未知接口执行代理。
- 既有采集授权沿用，不需要逐项重新申请；但**今天真实探索已由用户暂停，本轮不恢复**。恢复真实接入需用户明确说继续。
- 状态：**实现 / 管理者回归完成，待最终 head 审查与 PR 合并；合并结果以对应 PR 与 Git 为准**。当前未提交、未建 PR、未合并，本次交接不预报成功。
- 证据分两层，不可混用：**代码审查证据** = 独立审查已确认参数 20 已载明 + 1 推断 = 21、127 路径已知 / 4 未知、full 0 / live 0，并由独审发现 classify 误判、员工已定向修复、主审已实际复跑受影响三套；**最终 head 审查与合并证据** = 仍待进行 / 尚不存在，合并结果以 PR 与 Git 为准。
- 新交接保持本机私有路径不入 Git，旧采集暂停、旧现场保留。

## 7. 安全摘要（机读）

见 `.agent-runs/api-catalog-safe-result.json`（ignored，不入 Git）：只含修改文件列表、计数、测试命令/通过数、已知不足；不含原始报告文本、业务原值、响应或凭据。
