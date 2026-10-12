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

## 接入 Codex

1. 复制 `config.toml` 里的 `[mcp_servers.finance]` 段到 `%USERPROFILE%\.codex\config.toml`。
2. 设置 `FINANCE_API_BASE` 指向你的财税后端。
3. 重启 Codex，`/mcp` 应能看到 `finance` 及其工具。
4. 在会话里提出财税任务，Codex 会自动调用 `finance_query` / `voucher_create` / `invoice_issue` 等。

## 工具层（23 个）

22 个来自有数云 bundle 的 Dynamic Tools + `finance_query_catalog` / `skills_list` / `skills_read`
三个辅助工具。完整契约见 `../catalog.json`，说明见 `../ARCHITECTURE.md`。

## 业务规则层（Skill）

`skills/` 下 21 份 Markdown 与有数云原始目录结构一一对应（`catalog.json -> skill_files`）。
当前为模板，需按你的实现补全正文——**原文案在有数云服务端，无法从包中提取**。

若你的 Codex 版本不读取本地 `skills/`，可改用 MCP 工具 `skills_list` / `skills_read`
（已内置），或把规则写进仓库 `AGENTS.md`。
