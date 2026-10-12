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

## 工具层（23 个）

22 个来自有数云 bundle 的 Dynamic Tools + `finance_query_catalog` / `skills_list` / `skills_read`
三个辅助工具。完整契约见 `../catalog.json`，说明见 `../ARCHITECTURE.md`。

## 业务规则层（Skill）

`skills/` 下 21 份 Markdown 与有数云原始目录结构一一对应（`catalog.json -> skill_files`）。
当前为模板，需按你的实现补全正文——**原文案在有数云服务端，无法从包中提取**。

若你的 Codex 版本不读取本地 `skills/`，可改用 MCP 工具 `skills_list` / `skills_read`
（已内置），或把规则写进仓库 `AGENTS.md`。
