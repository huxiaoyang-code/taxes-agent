# 有数云「代账 / 财税工作台」逆向分析与复刻

本仓库分两部分：**对线上站点的证据化逆向分析**，以及**独立的记账+报表复刻工程**。

| 部分 | 目录 | 说明 |
|---|---|---|
| 📊 分析归档 | `00-recon/` … `04-report/` + `REPORT.md` | REA 工具产出的证据、报告、原始脚本 |
| 🧩 复刻方案 | `05-reconstruction/` | 从 bundle 提取的 Agent 契约 + Codex/MCP 骨架 |
| ⚙️ 复刻工程 | `06-workbench/` | **可运行的记账 + 报表 MVP**（Node + SQLite） |
| 📚 工程索引 | `docs/` | 代码管理索引、规范、变更日志、路线图 |

> 目标站点身份：有数云（YOUSURE）· 司书财税大模型 · AI 财税工作台。
> 用户原始地址 `daizhang.youshu.yuork` 不存在，实际分析目标为 `daizhang.youshu.yun`
> （更正证据见 [`00-recon/dns-corrected-url.md`](00-recon/dns-corrected-url.md)）。

## 快速开始

```bash
# 记账 + 报表工作台
cd 06-workbench
npm start            # = node server/server.mjs  → http://127.0.0.1:8787/
npm test             # 端到端冒烟测试（自动建临时库，不影响 data/）

# Codex / MCP 打通（工作台需先启动）
cd 05-reconstruction/codex/mcp/finance-mcp
node smoke-test.mjs
```

## 文档地图

- **工程入口**：[`docs/INDEX.md`](docs/INDEX.md) ← 代码管理索引（从这里开始）
- 分析总报告：[`REPORT.md`](REPORT.md)
- 复刻方案：[`05-reconstruction/ARCHITECTURE.md`](05-reconstruction/ARCHITECTURE.md)
- 工作台说明：[`06-workbench/README.md`](06-workbench/README.md)
- 变更日志：[`docs/CHANGELOG.md`](docs/CHANGELOG.md) ｜ 路线图：[`docs/ROADMAP.md`](docs/ROADMAP.md)
- 协作规范：[`docs/CONVENTIONS.md`](docs/CONVENTIONS.md)

## 目录一览

```
.
├── REPORT.md                 分析总索引（结论/证据台账/如何复现）
├── docs/                     ★ 代码管理索引目录
│   ├── INDEX.md              代码与产物索引（总入口）
│   ├── CONVENTIONS.md        提交/分支/风格约定
│   ├── CHANGELOG.md          版本变更
│   └── ROADMAP.md            待办与优先级
├── 00-recon/                 侦察：域名更正、HTTP 头、首页 HTML
├── 01-capture/               REA 被动抓取：页面/DOM/网络/截图
├── 02-scripts/               前端脚本：work（工作台）/ finance（登录）
├── 03-analysis/              REA 原始证据 JSON（应用图、接口、分包）
├── 04-report/                主题报告（01…09）+ 报告生成脚本
├── 05-reconstruction/        复刻契约与 Codex MCP 骨架
└── 06-workbench/             记账 + 报表 MVP（后端 + 网页 + 测试）
```

## 合规声明

- `00-recon/`…`04-report/` 为**被动观察与静态分析**产物，未登录、未提交表单、未做任何主动利用。
- `05-reconstruction/` 与 `06-workbench/` 是**独立实现**，不复用对方源代码；工具/接口的
  *名称与契约* 属接口事实，业务规则（Skill 正文）需自行编写。
- 前端脚本（`02-scripts/`）仅作分析留档，版权归原权利人。
