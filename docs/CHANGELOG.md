# 变更日志 · CHANGELOG

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与
[语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Planned
- 辅助核算（客户/供应商/部门/项目）
- 导入旧账（Excel）、银行流水对账
- 打印/导出（PDF/Excel）
- 发票 / 申报工具对接

---

## [0.3.0] - 2026-10-12

### Added — P1 会计闭环
- **期末结转损益** `carryForwardProfit(setId, period, {yearEnd})`
  - 各损益科目余额结转到 `3103 本年利润`，`yearEnd=true` 再结转 `3103 → 3104`
  - 结转凭证 `kind='carryforward'`，**不计入利润表发生额**，避免重复计算
  - 同期重复结转被拒绝（`already_carried_forward`）
- **固定资产折旧 / 无形资产摊销**
  - 新增资产卡片表 `asset_cards`（直线法、残值率、使用月数、起提期间、费用科目）
  - `generateDepreciation(setId, period)`：一键计提、生成凭证、记录 `asset_depreciation_runs`
  - 同期幂等；提足/未到计提期自动跳过
- **现金流量表** `cashFlowStatement(setId, period)`
  - 直接法（按货币资金对方科目分类为经营/投资/筹资）+ 与货币资金变动勾稽
  - 附「净利润 → 经营活动净额」的**间接法补充资料**
- 凭证新增 `kind` 字段（`normal` / `carryforward` / `depreciation`），含老库自动迁移
- 网页新增「资产」页签、现金流量表、「结转本期损益」按钮
- Agent 工具新增：`carry_forward_profit`、`asset_list`、`asset_create`、`depreciation_run`；
  `finance_query` 的 `report.cash_flow_statement` 改为真实实现
- 端到端测试扩到 **22 例**（新增折旧、结转、现金流量表、勾稽等），全部通过

### Changed
- 资产负债表「未分配利润」= `3104 + 3103 + 尚未结转的本年损益`（兼容已结转/未结转两种状态）

---

## [0.2.0] - 2026-10-12

### Added
- **`06-workbench/` 记账 + 报表 MVP**（可运行）
  - 后端：Node + `node:sqlite`，零第三方依赖
  - 账套 / 标准科目表（小企业会计准则）/ 期初余额 / 期间结账
  - 凭证：多分录、借贷平衡校验、草稿 / 过账 / 反过账 / 删除
  - 报表：科目余额表（试算平衡）、资产负债表、利润表、明细账
  - 前端零构建网页（`public/`）
  - 端到端测试 `test/smoke.test.mjs`（11 用例，全部通过）
- **Codex / MCP 打通**：`/agent/tools/:name` 接口，`finance-mcp` 默认指向工作台
- **`docs/` 代码管理索引目录**：`INDEX.md`、`CONVENTIONS.md`、`CHANGELOG.md`、`ROADMAP.md`
- 根 `README.md` 项目落地页；`.gitignore` / `.gitattributes` / `.editorconfig`

### Fixed
- 资产负债表中「本年利润」方向错误导致资产 ≠ 负债 + 权益
  （改为 `本年利润 = −Σ(损益类 net)`）
- 静态资源根路径 `/` 返回 404（Windows 路径分隔符问题）

---

## [0.1.0] - 2026-10-12

### Added
- **REA 逆向分析归档**
  - 目标更正：`daizhang.youshu.yuork`（不存在）→ `daizhang.youshu.yun`
  - `00-recon/` 侦察证据；`01-capture/` 被动抓取与截图
  - `02-scripts/` 前端脚本（`work` 工作台、`finance` 登录）
  - `03-analysis/` REA 原始证据：应用图、接口、路由、分包、WebMCP
  - `04-report/` 主题报告 01–09 + `build_report.py`
  - `REPORT.md` 分析总索引与证据台账（8 个 Evidence ID）
- **`05-reconstruction/` 复刻方案**
  - 关键发现：`/work` 财税工作台是 **OpenAI Codex app-server 客户端**
  - `catalog.json`：5 子智能体 / 22 工具 / 21 查询能力 / 21 技能文件 / 协议
  - `codex/`：`config.toml`、MCP Server 骨架（22 工具）、5 份 SKILL.md 模板
  - `extract_catalog.py`、`generate_skill_stubs.py` 可复现脚本

[Unreleased]: #unreleased
[0.3.0]: #030---2026-10-12
[0.2.0]: #020---2026-10-12
[0.1.0]: #010---2026-10-12
