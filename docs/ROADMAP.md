# 路线图 · ROADMAP

> 目标：用 Codex 作客户端，把「财税工作台」业务域逐步补齐。
> 记账与报表优先，发票/申报后期自研或对接第三方。

## 状态图例
✅ 完成 ｜ 🚧 进行中 ｜ ⬜ 待办 ｜ ⏸ 暂缓

---

## P0 · 已完成

| 项 | 状态 | 位置 |
|---|---|---|
| REA 逆向分析与证据归档 | ✅ | `00-recon/`…`04-report/`、`REPORT.md` |
| Codex 契约提取与 MCP 骨架 | ✅ | `05-reconstruction/` |
| 记账（凭证/期初/期间/科目） | ✅ | `06-workbench/server/accounting.mjs` |
| 报表（试算平衡/资产负债表/利润表/明细账） | ✅ | 同上 |
| 端到端测试 | ✅ | `06-workbench/test/smoke.test.mjs` |
| 工程索引与规范 | ✅ | `docs/` |

## P1 · 记账报表增强（下一步）

| 项 | 优先级 | 说明 | 触点 |
|---|---|---|---|
| 期末自动结转损益 | 高 | 月末损益类科目结转到 3103 本年利润，自动生成凭证 | `accounting.mjs` 新增 `closePeriodWithCarryover()` |
| 固定资产折旧 / 无形资产摊销计提 | 高 | 按卡片自动计提，生成凭证 | 新增 `assets` 表 + `depreciation.mjs` |
| 现金流量表（间接法） | 中 | 由资产负债表/利润表 + 科目发生额推导 | `accounting.mjs` + `nodeId: report.cash_flow_statement` |
| 辅助核算（客户/供应商/部门/项目） | 中 | 分录挂辅助维度，报表可下钻 | `voucher_entries` 加维度字段 |
| 导入旧账（Excel） | 中 | 科目余额 + 历史凭证导入 | 对应 `legacy-book-import` 子智能体 |
| 银行流水对账 | 中 | 导入流水、匹配、自动生成凭证 | 对应 `fund.unbooked.*` |
| 打印/导出（PDF/Excel） | 低 | 报表另存 | `public/app.js` |

## P2 · 发票与申报（后期，自研或接第三方）

| 项 | 说明 | 触点 |
|---|---|---|
| 发票采集 / 查验 | 对应 `invoice_collect` `invoice_file` `invoice.detail` | `agentTool()` 分支 |
| 开票 / 红冲 | `invoice_precheck` `tax_code` `issue` `red_*`；需税局或服务商通道 | 同上 |
| 全税种申报 | `declaration_query` `tax_declaration_query`；增值税/附加税/所得税/印花税 | 同上 |
| 个税申报 | `individual-income-tax-filing` 子智能体 | 同上 |
| 规则正文 | 补全 `05-reconstruction/codex/skills/**` 21 份业务规则 | Skill 文档 |

> 合规提示：开票与申报必须通过合法通道（电子税务局 / 持牌服务商），
> 相关能力不实现则继续返回 `not_implemented`。

## P3 · 平台化

| 项 | 说明 |
|---|---|
| 多用户 / 多租户 / 权限 | 用户-账套-角色，接口鉴权 |
| 审计日志 | 凭证与关键操作留痕 |
| 前端工程化 | 视需要迁移到 React/Vue 或嵌入现有系统 |
| 部署 | 反代 + 进程守护 + 备份策略 |
| 对接有数云 API（可选） | 仅在获得授权与凭据前提下复用 |

---

## 里程碑

| 里程碑 | 内容 | 状态 |
|---|---|---|
| M1 · 证据归档 | REA 分析完成 | ✅ |
| M2 · 契约与客户端 | Codex/MCP 打通 | ✅ |
| M3 · 记账报表可用 | 本 MVP | ✅ |
| M4 · 会计闭环 | P1 全部完成，可出完整月结报表 | ⬜ |
| M5 · 财税全链路 | P2 完成 | ⬜ |
