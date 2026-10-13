# codex/ — 用 Codex 直接驱动财税工作台

这套骨架让 **Codex（CLI / IDE）本身成为客户端**，你只需补「工具后端 + 业务规则」。
有数云 `/work` 的做法等价于此，只是它额外自研了 Web UI 来渲染 Codex 事件。

## 目录

```
codex/
├── config.toml                  # 合并进 ~/.codex/config.toml，注册 MCP Server
├── .env.example                 # 后端地址与 Skill 目录
├── skills/                      # 5 个子智能体的 SKILL.md + references（21 份，待填正文）
└── mcp/finance-mcp/
    ├── server.mjs               # MCP stdio Server，23 个工具
    ├── backend.mjs              # 财税后端适配器（你要实现的唯一部分）
    ├── smoke-test.mjs           # 冒烟测试（无需后端）
    └── package.json
```

## 快速验证（不需要后端）

```bash
cd 05-reconstruction/codex/mcp/finance-mcp
node smoke-test.mjs
# 期望输出：tools (22): account_context, finance_query, ... skills_read
#          query catalog: 21 capabilities; 5 subagents
#          skill files: 21
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

### 无头自检（不打开 UI）

```bash
codex exec --skip-git-repo-check -C . --dangerously-bypass-approvals-and-sandbox \
  "只做一件事：调用 finance MCP 的 finance_query 工具，参数 nodeId=report.income_statement, accountSetId=1, period=2026-02；然后只回复净利润数字。"
# 实测输出：账套 1 在 2026-02 的净利润为 -6900。
```

## 本地复现：导入旧账（Codex 作为客户端）

线上有数云 `/work?page=account-sets` 的“导入”由子智能体 `legacy-book-import` 完成
（逆向结论见 [`../../04-report/10-account-set-import.md`](../../04-report/10-account-set-import.md)）。
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

## 工具层（23 个）

22 个来自有数云 bundle 的 Dynamic Tools + `finance_query_catalog` / `skills_list` / `skills_read`
三个辅助工具。完整契约见 `../catalog.json`，说明见 `../ARCHITECTURE.md`。

## 业务规则层（Skill）

`skills/` 下 21 份 Markdown 与有数云原始目录结构一一对应（`catalog.json -> skill_files`）。
当前为模板，需按你的实现补全正文——**原文案在有数云服务端，无法从包中提取**。

若你的 Codex 版本不读取本地 `skills/`，可改用 MCP 工具 `skills_list` / `skills_read`
（已内置），或把规则写进仓库 `AGENTS.md`。
