# 协作规范 · CONVENTIONS

## 1. 提交信息（Conventional Commits）

```
<type>(<scope>): <subject>

[body]
[footer]
```

| type | 用途 |
|---|---|
| `feat` | 新功能 |
| `fix` | 修 bug |
| `docs` | 文档/索引 |
| `refactor` | 重构（不改行为） |
| `test` | 测试 |
| `chore` | 构建/工具/依赖 |
| `analysis` | 逆向证据与报告（本项目特有） |

**scope 取值**：`workbench` `mcp` `reconstruction` `evidence` `docs` `repo`

示例：
```
feat(workbench): 支持资产负债表与利润表
fix(workbench): 修正本年利润方向导致的资产负债表不平衡
docs(index): 建立代码管理索引
analysis(evidence): 归档 /work 与 /finance 应用图
```

- 主题用祈使句、≤ 50 字、结尾不加句号。
- 破坏性变更在 footer 写 `BREAKING CHANGE: ...`。
- 一个提交只做一件事；证据归档与工程改动分开提交。

## 2. 分支

| 分支 | 用途 |
|---|---|
| `main` | 可运行主线，始终 `npm test` 通过 |
| `feat/<name>` | 功能分支 |
| `fix/<name>` | 修复分支 |

合并前：`06-workbench` 必须 `npm test` 全绿。

## 3. 版本

- 工程版本写在 `06-workbench/package.json`，遵循 SemVer。
- `0.x` 阶段：会计口径/接口发生不兼容变更时升 `minor`。
- 每次发布同步更新 [`CHANGELOG.md`](CHANGELOG.md)。

## 4. 代码风格

- ESM（`"type": "module"`）；2 空格缩进；LF；文件末尾空行。
- **后端零第三方依赖**（只用 Node 内置模块 / `node:sqlite`）；前端零构建。
- 注释用中文，解释“为什么”而非“做了什么”；领域概念保留中文原名（账套/凭证/科目）。
- 金额统一 `round2`，比较用 `EPS = 0.005`，禁止直接浮点 `===` 比较金额。
- 命名：文件小写（`accounting.mjs`）；导出函数动词开头（`createVoucher`）；数据库字段 snake_case。

## 5. 目录与文件约定

- 新增主题报告 → `04-report/NN-topic.md`，并在 `docs/INDEX.md` §5.2 登记。
- 新增分析脚本 → 放在所属阶段目录（如 `04-report/build_report.py`）。
- 新增前端产物/证据 → 只写 `02-scripts/`、`03-analysis/`，不改动原始字节。
- 运行期数据一律进 `06-workbench/data/`（已 gitignore），**不得提交**。
- 新增工具/查询能力 → 同步三处：`server.mjs` 的 `agentTool()` 与 `CATALOG_QUERIES`、
  `05-reconstruction/catalog.json`。

## 6. 文档维护

- 改结构/入口/命令 ⇒ 更新 [`INDEX.md`](INDEX.md)、[`../README.md`](../README.md)。
- 交付功能/修复 ⇒ 更新 [`CHANGELOG.md`](CHANGELOG.md)。
- 计划调整 ⇒ 更新 [`ROADMAP.md`](ROADMAP.md)。
- 分析与复刻产出 ⇒ 标注证据 ID 与“观察 / 推断 / 未知”，不得把静态结论写成运行时事实。

## 7. 不提交清单

见 [`.gitignore`](../.gitignore)：数据库、依赖、`.env`、日志、临时文件、编辑器目录。
提交前执行 `git status` 自查。
