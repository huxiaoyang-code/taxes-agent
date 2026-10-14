# codex/ — 用 Codex 直接驱动财税工作台

Codex 通过 MCP 调用本机记账与报表后端。账套、凭证、导入、资产和期末操作已接入，
记账与导入规则已补齐；电子税务局仅预留接口，发票和申报等入口仍明确返回未实现。

## 目录

```
codex/
├── config.toml                  # 合并进 ~/.codex/config.toml，注册 MCP Server
├── .env.example                 # 后端地址与 Skill 目录
├── skills/                      # 记账/导入规则已补齐，其余发票/申报等仍为模板
└── mcp/finance-mcp/
    ├── server.mjs               # MCP stdio Server，45 个工具入口（含未实现兼容项）
    ├── tools.mjs / tax-tools.mjs # schema、来源、真实可用状态
    ├── backend.mjs              # 财税后端 HTTP 适配器与结构化错误
    ├── smoke-test.mjs           # 当前配置后端的只读冒烟
    ├── contract-test.mjs        # 自动启动临时后端的 MCP 验收
    ├── tax-contract-test.mjs    # 税务契约与异步状态机（本地假适配器）
    ├── workflow-test.mjs        # 导入到结账的真实 MCP 闭环（临时账套）
    └── package.json
```

## 快速验证（自动启动独立临时后端）

```bash
cd 06-workbench
npm test
# 临时数据库 + 临时端口；领域回归、MCP/税务契约与完整闭环
```

## 接入 Codex（已实测）

前置：先启动工作台 `06-workbench`（`FINANCE_API_BASE` 默认就是它：`http://127.0.0.1:8787`）。

```bash
# 一条命令注册（官方 CLI，自动写入 ~/.codex/config.toml）
codex mcp add finance \
  --env FINANCE_API_BASE=http://127.0.0.1:8787 \
  --env FINANCE_SKILLS_DIR=D:/有数云fork/05-reconstruction/codex/skills \
  -- "D:\\node.exe" "D:/有数云fork/05-reconstruction/codex/mcp/finance-mcp/server.mjs"

codex mcp list          # 应看到 finance ... enabled
```

> Windows 下 `command` 用绝对路径（Codex 的 PATH 里没有 node）；也可照 `config.toml` 手工合并。

**重启 Codex 客户端**（桌面版 / IDE）后，在会话里用一句话即可驱动财税作业：

| 你说 | Codex 调用 |
|---|---|
| “查一下 2026-02 的净利润” | `finance_query(report.income_statement)` |
| “出现金流量表” | `finance_query(report.cash_flow_statement)` |
| “记一笔：2026-03-05 支付办公费 800，借管理费用贷银行存款” | `voucher_create` |
| “帮我核一下账套 1 的资产负债表平不平” | `finance_query(report.balance_sheet)` |
| “把运输车辆 2026-03 的折旧计提了” | `depreciation_run` |
| “结转 2026-01 损益” | `carry_forward_profit` |
| “把 D:/旧账 下的 4 个 CSV 导入成新账套” | `legacy_book_import`（默认仅预检） |

每次查询显式提供账套 ID 和期间。`account_context` 只列账套，不持久保存“当前账套”。
Git 合并不会自动重载已运行的工作台和 MCP；更新后需重启相应进程，再检查工具清单。

## 本地复现：导入旧账（Codex 作为客户端）

线上有数云 `/work?page=account-sets` 的“导入”由子智能体 `legacy-book-import` 完成
（逆向结论见 [`../../../04-report/10-account-set-import.md`](../../../04-report/10-account-set-import.md)）。
本地复现**只用本仓库的 `06-workbench`**，不需要有数云任何服务：

```
你的 Codex  ──MCP stdio──▶  finance-mcp  ──HTTP /agent/tools──▶  06-workbench(SQLite)
     ▲
     └─ skills_read legacy-book-import/SKILL.md（业务规则）
```

### 1) 启动后端（工作台）

```bash
cd 06-workbench
npm start            # http://127.0.0.1:8787
```

### 2) 注册 MCP（见上方“接入 Codex”）后**重启 Codex 客户端**

### 3) 让 Codex 跑一遍（直接说人话）

> 先 `skills_read` 读规则，再做预检导入：

```
先调用 finance MCP 的 skills_read 读取 legacy-book-import/SKILL.md；
然后用 legacy_book_import 预检导入
D:/有数云fork/05-reconstruction/examples/legacy-book 下的 4 个 CSV
（paths={meta,accounts,openings,vouchers}, dryRun=true），只汇报校验结果和汇总。
```

确认无误后：

```
用 dryRun=false 正式导入，然后告诉我账套 id，并查 2026-01 资产负债表是否平衡、生成了几张凭证。
```

### 4) 不想开 Codex？先验证链路

```bash
cd 05-reconstruction/codex/mcp/finance-mcp
FINANCE_API_BASE=http://127.0.0.1:8787 node import-demo.mjs
# [1] 读规则 OK  [2] 预检  [3] 正式导入 created.id  [4] 资产负债表 balanced=true
```

`import-demo.mjs` 会向配置的后端正式新增账套。仅检查代码链路请使用 `npm test` 中的临时库验收。

### Excel（.xlsx）旧账怎么办

本地工具链只吃 CSV；先用 `05-reconstruction/tools/xlsx-to-csv.py` 摊平，再让 Codex 导入：

```bash
python 05-reconstruction/tools/xlsx-to-csv.py 旧账.xlsx -o out/ --list
python 05-reconstruction/tools/xlsx-to-csv.py 旧账.xlsx -o out/ \
  --map openings=科目余额表 --map vouchers=凭证分录
```

### 关于 `paths`

`legacy_book_import` 除 `payload` / `texts` / `files`(base64) 外，额外支持 `paths`：
MCP Server（与 Codex 同机）直接读本地 CSV，免去把内容塞进 JSON。
线上有数云走的是附件管道（`artifactHandle`），本地用 `paths` 更直接。

## 工具层（45 个入口）

在原有 23 个入口上，新增资产/折旧/结转 4 个、账务管理 11 个和税务接口 7 个。
入口数量包含未实现的兼容工具，不能据此判断功能完成；`tools/list` 的状态和说明、
`finance_query_catalog` 的逐项可用状态才是依据。`update_plan` 不持久保存，
`finance_task_status` 不提供异步任务状态，发票/申报/exec 等仍返回工具错误。

`tax_regions` / `tax_capabilities` 可查看接口及配置状态；其余税务登录/取数工具在默认无适配器时
明确拒绝操作。详见 [税务契约](../../../docs/TAX-INTEGRATION.md)。原站证据
[`../catalog.json`](../catalog.json) 保持冻结，本地扩展由 `tools.mjs` / `tax-tools.mjs` 管理。

## 业务规则层（Skill）

原站映射为 21 份 Markdown（`catalog.json -> skill_files`），本地增加导入参考后共 22 份；原始映射保持冻结。
记账主规则、7 份业务参考和旧账导入主规则已按本地实现补齐；发票、企业申报、个税等仍待开发。
这些规则为本地编写，原站服务端 Skill 正文未被提取。

若你的 Codex 版本不读取本地 `skills/`，可改用 MCP 工具 `skills_list` / `skills_read`
（已内置），或把规则写进仓库 `AGENTS.md`。
