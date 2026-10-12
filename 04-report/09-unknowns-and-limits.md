# 09 · 未知与覆盖边界 / Unknowns & limits

1. **鉴权后区域未执行**：没有可用凭据，`/work` 工作台与 `account-sets` 内部页面
   从未登录进入；相关功能来自静态代码/接口，**不是运行时观察**。
2. **动态分包未获取**：`mermaid.core-*.js`、`PointNativeSubagent*` 等动态导入在
   单文件容器内无法解析，也未下载（REA `unknowns`）。文件 `03-analysis/work-app-analysis.json`。
3. **Source map 不可用**：两个应用均无 `.map`（404），无法还原原始模块名/源码。
4. **attach 窗口限制**：页面检查的 console/网络只覆盖 REA 附加之后的活动，
   之前的请求不可见（`attach_limited`）。
5. **策略过滤**：跨源（`disallowed_origin`）的脚本/资源/元数据被剔除；Cookie 值、
   存储值、请求头、WebSocket 载荷一律不保留。
6. **WebMCP**：页面未注册任何 WebMCP 工具（0）。
7. **接口基址**：`thread/read|resume|turns/list` 在静态分析中未解析出 HTTP 基址，
   可能是 Agent 运行时协议（SSE/长连接），未在运行时验证。
8. **目标 URL 不确定性**：本次以修正域名 `daizhang.youshu.yun` 为准；若用户本意是
   其他主机（例如内网别名 `daizhang.youshu.yuork`），需在能解析该名的网络中重跑。

**未做的主动行为**：未登录、未点击、未提交表单、未爆破、未做越权/注入测试。
