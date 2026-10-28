# 本机财税工作台

Node.js + SQLite 的本机单用户财税工作台，以 Agent / MCP 为主要工作入口，已有网页作为可选界面。面向一名操作者处理多家企业，每家企业一个账套。能力及限制以源码、工具契约和实际返回为准；入口存在不代表业务已实现。

## 启动与验证

在仓库根目录运行；Node 资格检查与 Windows 启动方式见[代码索引](docs/CODE-INDEX.md#windows)。

```sh
cd 06-workbench
npm ci
npm start
npm test
```

`npm test` 的套件清单由 [test-all.mjs](06-workbench/scripts/test-all.mjs) 定义，使用临时数据。服务默认数据库为 `06-workbench/data/workbench.db`；真实数据不用于自动测试。更新代码后需重启已有服务以加载变更。

MCP stdio 入口（由客户端启动）：

```sh
node 05-reconstruction/codex/mcp/finance-mcp/server.mjs
```

后端默认地址是 `http://127.0.0.1:8787`，可用 `FINANCE_API_BASE` 配置。工具注册、Skill 资源与示例命令见[代码索引](docs/CODE-INDEX.md#mcp)。

## 目录

| 路径 | 用途 |
|---|---|
| [06-workbench/server](06-workbench/server/) | HTTP、记账、报表及本机业务模块 |
| [06-workbench/public](06-workbench/public/) | 网页 |
| [06-workbench/scripts](06-workbench/scripts/) | CLI、运行和验证入口 |
| [06-workbench/test](06-workbench/test/) | 回归测试、合成 fixtures 与独立预期 |
| [05-reconstruction](05-reconstruction/) | MCP、运行时 Skills、catalog、导入示例与转换工具 |
| [docs/CODE-INDEX.md](docs/CODE-INDEX.md) | 按任务定位源码、入口与测试 |
| [企业接手与财税顾问技能包](docs/COMPANY-ADVISOR-SKILL.md) | Codex 接手历史、疑点复核、税费与现金规划；同事安装和使用入口 |

协作规则见 [AGENTS.md](AGENTS.md)；当前需求与未完工作在 [GitHub Issues](https://github.com/huxiaoyang-code/taxes-agent/issues) 跟踪。
