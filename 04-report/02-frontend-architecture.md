# 02 · 前端架构 / Frontend architecture

## 构建与运行时（观察）

- 打包器：**Vite**（`import.meta`/ESM preload + `assets/*.js` 哈希命名），由 REA 的
  `bundle_runtime` 指纹推断，置信度 medium（ev_66f34fbf3a16eb24431d8ad24f58769b4315e27f65d8ed84227505cb819b6962）。
- 框架：**React**（`react-vendor-*.js`，`vendor_fingerprint: React`，置信度 medium）。
- UI 组件库：**Ant Design**（`antd-vendor-*.js`、`antd-date-vendor-*.js`；DOM 中大量
  `data-rc-order` / `data-css-hash` 运行时样式标记，ev_5cf4d9b1e50fc3c9ac5368b003cd4c3095854144637c0a478fe8781101189311）。
- HTTP 客户端：**axios**（`axios.create(...)`，`baseURL` / `withCredentials` 字段可见）。
- 图表/文档渲染：**Mermaid**（`mermaid.core-*.js` 动态导入）与 **KaTeX**
  （`gullet.macros.get` 调用，公式渲染）。
- 错误监控：**Sentry**（`sentry.sample_rate`、`sentry.dsc`、`traceparent`、`baggage`）。
- 可选：`xlsx`（电子表格导出，`/results/export` 相关逻辑）。

## `/finance` 已观察到的分包（观察）

| chunk | bytes |
|---|---|
| index-D9q6l-Ms.js | 128036 |
| Login-CmT9YCWA.js | 8444 |
| monitoring-sdk-H-W2b3rW.js | 424393 |
| antd-vendor-DDiEsgky.js | 1153391 |
| antd-date-vendor-BI5LfP24.js | 16770 |
| pointControls-0Xz9vSYC.js | 4401 |
| react-vendor-esBf9nI-.js | 230387 |

（`scripts_observed=7`，`scripts_analyzed=7`，解析失败 0，`completeness: partial`。证据 ev_66f34fbf3a16eb24431d8ad24f58769b4315e27f65d8ed84227505cb819b6962）

## `/work` 工作台分包（推断）

本地已保存主包 `02-scripts/work/index-yoSd2Nx7.js`（SHA-256
`098e3f59318305abace7f8f600fac22986f7102438af73c652266b716fe0265e`）。REA 静态分析识别出 14 个**未解析的动态导入**，
例如 `mermaid.core-DrHNId4r.js` 以及一组子智能体面板：

- `PointNativeSubagentPanel-*.js` / `PointNativeSubagentListPanel-*.js` /
  `PointNativeSubagentSummary-*.js` / `pointNativeInheritedHistory-*.js` /
  `usePointNativeSubagentOverview-*.js`。

这些分包在服务器上应当存在，但静态分析无法在单文件容器内解析；尚未下载，属未覆盖范围。
