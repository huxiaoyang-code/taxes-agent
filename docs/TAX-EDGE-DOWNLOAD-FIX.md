# 税局 Edge 查询 / 下载模式修复

更新：2026-10-21。负责人：`huxiaoyang-code`。Refs #20 / #13 / #17。基线 `2bc05d3680b456ccecb7bf1a16b64107017114b1`，分支 `codex/huxiaoyang-code/tax-edge-download-fix`。配套[任务](tasks/TAX-EDGE-DOWNLOAD-FIX.md)、[交接](handoffs/TAX-EDGE-DOWNLOAD-FIX.md)。

## 问题与假说

用户确认：**同一企业、同一条件下，本机常用 Edge 能正常下载发票；旧后端专用 Edge 的查询 / 下载失败。** 两者 Edge 版本相同（本机均为 `155.0.4283.62`），差异在启动模式：旧专用实例 `inprivate=true`，常用 Edge `inprivate=false`。

官方文档 https://learn.microsoft.com/en-us/deployedge/microsoft-edge-policies/blockthirdpartycookies 说明 **InPrivate 默认阻止第三方 Cookie**。据此形成**可信兼容性假说**：InPrivate 模式可能使税局站点第三方 Cookie / 会话关联失效，导致旧后端通道查询 / 下载失败。

**边界**：这是基于官方策略文档的假说，**不是实测税局根因**。本 PR 不做根因定论，只移除已知差异并保留可复现验证路径。

## 实现范围（仅 4 文件）

| 文件 | 改动 |
|---|---|
| 传输层（浏览器启动） | **移除 `--inprivate` 启动参数**；保留 ACL 独立临时 profile、loopback CDP 连接与退出清理，不放宽 |
| 诊断层 | 由**强制 InPrivate** 改为：**兼容旧的 owned InPrivate 与新的 owned normal**；继续拒绝重复 / 畸形 `inprivate`，以及 guest / headless / unsafe 组合 |
| 测试（2 个） | 覆盖上述模式的接受与拒绝 |

其余 owner / profile / 端口 / ACL 校验**一律不放宽**，未新增通道或权限。

## 验证（分开陈述，不混淆）

- **员工自测**：`browser-session` 46 项 + `diagnostic` 5 项通过。
- **管理者回归**：在**当前冻结代码**上已**实际完整运行** `test-all`，**44 / 44 套、exit 0**。此为管理者实跑事实，**不是仅员工自报**。

## 真实验证阶段（进行中）

- root 已另开**隔离后端**：空白运行目录 + 随机 loopback 端口。
- 新专用 Edge 已**实际启动**并核对：`normal=true`、独立 profile `true`、loopback `true`、与常用 Edge **同版本**。
- **旧四进程保留**，用户原常用 Edge **未改动**。
- 新窗口**等待用户人工登录**后，以同条件做查询 / 下载**复验**。
- **当前不声明发票查询 / 下载成功**；不读凭据 / 业务原值入模型。
- 本机端口 / PID / ref / 路径**只写入 ignored checkpoint，不入 Git**。
- 原边界不变：不自动点击、不猜接口、不申报。

## 只读审查发现的后续技术待办

另一只读审查发现（**非企业补材料，也非已证实失败原因**）：

1. 现有 invoice observer 仅匹配**同 target / session + 主 frame / loader**；普通子 frame 只会增加 `requestEvents` / `subframe`，**新标签 / OOPIF 可能完全不可见**。
2. **未实现浏览器 `downloadWillBegin` / `progress` 或文件接收**，`downloadPerformed` 固定为 `false`。

这些列为**清晰后续技术待办**。本 PR **不把模式修复冒充数据链打通**：查询 → 下载 → 后端 MCP fresh 复采仍未完成。

## 授权与状态

- 旧真实探索暂停已被用户本次「直接排查修复」指示**授权恢复**；**不得再写「一律禁止复验」**。
- 状态：**代码 + 管理者回归完成，独立内容审查进行中，真实同条件下载待用户人工反馈，PR 尚未创建**。
- 已有 [PR #41](https://github.com/huxiaoyang-code/youshu-fork/pull/41) 已合并（`2bc05d3`），作为前置交接记录，不改其历史文档。
