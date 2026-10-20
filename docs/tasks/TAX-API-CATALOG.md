# 任务单 · TAX-API-CATALOG

- 类型：后端能力 + 契约文档 + 测试
- 基线：`9b7bef3fd0b505ac3478345c9ed4912ff70213c0`（PR #40 合并后）
- 分支：`codex/huxiaoyang-code/tax-api-catalog`
- 交付文档：[TAX-API-CATALOG](../TAX-API-CATALOG.md) · [交接](../handoffs/TAX-API-CATALOG.md)
- Ref：用户新方向（把现成逆向结果整理进我们后端），是 Issue #20 / #13 / #14 / #17 范围内的子包

## 1. 目标

把 `etax_rea_work` 现成分析报告中**明确列举**的税局接口，整理成结构化目录，并交付真正可检索、可校验、可做调用准备的后端能力（Agent 工具 + MCP 工具），附带统一的纯响应/失败分类器。**不再次逆向、不爬站、不连接税局、不实现任意代理、不伪造真实请求。**

## 2. 非目标

- 不访问税局 / 不启停原有服务 / 不读浏览器、凭据、账套 DB、旧私有采集目录；
- 不运行 REA / AST / 脚本 / 下载；
- 不读 JS 产物与场景 JSON 原件（只用报告）；
- 不修改旧 tax-download / 浏览器现场逻辑，不添加自动点击；
- 不改全局 Skill / 配置；
- 不做 Git 提交、推送、合并。

## 3. 输入与材料

| 项 | 值 |
|---|---|
| 来源文件 | 本机现成分析报告（不在仓库内、不入 Git） |
| SHA256 | `0d2f4b8f729b34014315507510bc9aa07d35f8f8d3c04af2fe6f961e87eb4a1c` |
| 行数 / 字符 | 153 / 8,605 |
| 使用范围 | 第 1–7 节事实 + 第 8 节局限 |

材料本身不复制进 Git；只登记技术合同字段与报告行号。

## 4. 交付清单

| 文件 | 作用 |
|---|---|
| `06-workbench/server/tax-api-catalog.mjs` | 目录数据（29 模块 / 131 条目）+ 检索 + 参数校验 + 覆盖统计 + 完整度分层 |
| `06-workbench/server/tax-api-catalog-classify.mjs` | 纯结果分类器（10 类结果、严格输入校验、静态重试能力/本次建议分离、会话口径） |
| `06-workbench/server/tax-api-catalog-readiness.mjs` | 调用准备层（上下文引用 / 权限 / 合同 → 明确缺项，引用只做格式校验） |
| `06-workbench/server/agent-tools.mjs` | 注册 7 个 `tax_api_catalog_*` Agent 工具（HTTP 入口自带完整校验） |
| `06-workbench/test/tax-api-catalog.test.mjs` | 合成单测（目录诚实性 / 检索 / 校验 / 准备 / 分类 / 重试） |
| `06-workbench/test/tax-api-catalog-http.test.mjs` | 真实本机 HTTP → Agent 集成（临时库 + 临时回环端口） |
| `06-workbench/scripts/test-all.mjs` | 追加 3 套测试入口 |
| `05-reconstruction/codex/mcp/finance-mcp/tools.mjs` | 公布 7 个 MCP 工具 schema |
| `05-reconstruction/codex/mcp/finance-mcp/tax-api-catalog-test.mjs` | 真实 stdio MCP → HTTP → Agent 集成 |
| `docs/TAX-API-CATALOG.md` | 契约 + 覆盖计数 + 缺口 + 边界 |
| 本文 + `docs/handoffs/TAX-API-CATALOG.md` | 任务 / 交接 |
| `docs/INDEX.md`、`docs/handoffs/STATE.md`、`docs/handoffs/NEXT-SESSION.md`、`docs/tasks/README.md` | 仅加简短入口 |

## 5. 契约要点（验收口径）

1. 每条目录项有稳定 id、中文用途、方法、静态路径模板或显式未知、参数 schema 与**证据级别**、身份/企业/权限依赖、响应/错误约定、分页/下载依赖、操作风险、证据类别与报告行号。
2. **参数未知不能伪装成「无参数」，推断不能伪装成「已观察」**：`paramsEvidence` 四态 `observed` / `inferred` / `envelope_only` / `unknown`，未知与推断必有 `paramGaps`；`inferred` 参数只登记类型/依赖。
3. **凭据类参数不接受值**：`code` / `token` / `cookie` / `password` / `signature` 等 `valueAccepted=false`，绝不作为参数值提交校验，也不经 MCP 返回；需要时使用本机安全引用。
4. **登录与写接口不默认开放执行**：`autoExecutable` 恒 `false`，准备层一律 `blocked_by_policy`。
5. 检索结果必须同时呈现 `catalogManaged: true` 与 `liveCallVerified: false`；`filters` 只回显规范字段，不 `{ ...input }`。
6. 只接受固定结构条件 / 目录 id；拒绝任意 URL、源码、正则、对象/数组值；错误不回显未知键名与原文。
7. 分类器：严格校验所有已知字段类型/枚举/范围；矛盾元数据不成功；裸 HTTP 200 不是成功；零事件不是空数据；`business_empty` 由空结果族（已解析 + 结构识别 + 元数据无矛盾）或 `success` 族 + 明确空证据判出；`httpStatus` 可省略，显式提供且 success/empty 与非 2xx 冲突才 `structure_unrecognized`（不重试、不改全局会话）；单接口认证错不判全局登录失效；**不提供**仅凭调用方布尔推断全局登录的入口。
8. 重试：静态能力与本次建议分离；只有只读 + 瞬时传输失败 + 未用尽次数才建议重试；认证/无权限/成功/空/业务错误/耗尽一律不重试。
9. 超时阈值必须是本地策略（不是税局 SLA）。
10. 准备层：`accountSetId` 严格正整数；resolver 返回 `false` 也拒绝；引用与权限只做格式校验并明确 `unverified`；缺项明确 `not_ready`、登录/写 `blocked_by_policy`，合同齐备也只给 `contract_ready_adapter_missing`。
11. 覆盖计数必须精确：列出报告明确列出的接口/登记数，并单独给缺方法/参数/响应/权限/上下文的计数；不得把报告 200+ 宣称当契约数；不得编造方法/参数/可用性。
12. 测试只用临时数据库与本机回环端口，不测真实账套。

## 6. 验收命令

```bash
cd 06-workbench
node test/tax-api-catalog.test.mjs        # 32 项
node test/tax-api-catalog-http.test.mjs   # 10 项
node scripts/test-all.mjs                 # 全量（历史基线 44 套，小修后未重跑）
```

```bash
cd 05-reconstruction/codex/mcp/finance-mcp
node tax-api-catalog-test.mjs             # 5 项
```

测试时序与范围：① 管理者较早一次全量 `node scripts/test-all.mjs` exit 0、44/44 套通过（当时 catalog 为 31 项），属**基线**；② 之后独审发现分类器把空结果族业务码与 HTTP 401/403/500 误判为 `business_empty`；③ 员工定向修复为 `structure_unrecognized`（不重试、全局仍 `unknown`，`empty` + 2xx 保留正常），catalog 单测 31 → 32 项；④ 主审再次实际运行受影响的**三套**：目录 32 / HTTP 10 / MCP 5，全部 exit 0。小修**之后只改了分类器与这三套测试**，因此不声称“最终代码上重跑了全 44 套”。

## 7. 已登记限制

见 [TAX-API-CATALOG §7](../TAX-API-CATALOG.md)：签名串顺序未还原、107 条方法未知、125 条参数合同未载明（已载明参数键 20 / 推断 1 / 声明 21）、110 条响应未知、企业与权限前置条件全未知、3 个通配分组成员未列、1 条报告只给分组形态故保持路径 `unknown`、302 响应体不可读、认证前缀归属未核实、完整可调用契约 0 条、无真实适配器、目录范围等于材料范围。

## 8. 审查与冻结状态

- 本包已按独立初审逐项修复（分类器严格校验、矛盾元数据判定、检索回显、推断证据、严格正整数、会话入口、重试语义、精确参数计数、完整度分层、文档链接与边界表述）。
- 独审随后发现分类器缺陷：空结果族业务码、以及 HTTP 401/403/500 仍被误判为 `business_empty`；员工已定向修为 `structure_unrecognized`，不重试、不判全局登录失效，`empty` + 2xx 保留为正常空结果；主审已再次实际运行受影响的目录 / HTTP / MCP 三套，全部 exit 0。
- **实现 / 管理者回归完成，待最终 head 审查与 PR 合并；合并结果以对应 PR 与 Git 为准**。管理者较早一次在冻结代码上运行 `node scripts/test-all.mjs` 为 exit 0、44/44 套全部通过，那是上述小修**之前**的基线；本次未提交、未建 PR、未合并，不预报成功。
- 代码审查证据与合并证据分开记录：独审已确认参数 20 已载明 + 1 推断 = 21、127 路径已知 / 4 未知、full 0 / live 0，并已推动上述分类器修复；最终 head 审查仍在进行，合并证据待 PR 产生后再登记。
- 本交接更新只改文档；真实执行仍全部 `blocked` / `not_ready` / `adapter_missing`；不接任意 URL、不接认证/写操作、不做未知接口执行代理。
