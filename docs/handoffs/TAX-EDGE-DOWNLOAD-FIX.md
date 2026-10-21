# 交接 · TAX-EDGE-DOWNLOAD-FIX

更新：2026-10-21。负责人 `huxiaoyang-code`。Refs #20 / #13 / #17。基线 `2bc05d3680b456ccecb7bf1a16b64107017114b1`，分支 `codex/huxiaoyang-code/tax-edge-download-fix`。先读[交付文档](../TAX-EDGE-DOWNLOAD-FIX.md)、[任务](../tasks/TAX-EDGE-DOWNLOAD-FIX.md)、[STATE](STATE.md)。

## 恢复事实

| 对象 | 已核事实 | 约束 |
|---|---|---|
| 问题 | 同企业同条件常用 Edge 可下载发票，旧后端专用 Edge 查询 / 下载失败 | 用户确认；非本机能独自复现的业务结论 |
| 版本 | 本机两者均 `155.0.4283.62` | 差异不在版本 |
| 模式 | 旧专用 `inprivate=true`，常用 `false` | 已移除差异；兼容性假说，非实测根因 |
| 官方依据 | `blockthirdpartycookies`：InPrivate 默认阻止第三方 Cookie | 仅支撑假说，**不当作税局根因** |

## 实现（仅 4 文件）

- 传输层：移除 `--inprivate`；保留 ACL 独立临时 profile、loopback CDP、退出清理。
- 诊断层：由强制 InPrivate 改为兼容旧 owned InPrivate / 新 owned normal；拒绝重复畸形 `inprivate` 与 guest / headless / unsafe。
- 测试 ×2。
- 未放宽 owner / profile / 端口 / ACL。

## 验证

- 员工自测：`browser-session` 46 + `diagnostic` 5 通过。
- 管理者回归：当前冻结代码上**实际完整运行** `test-all`，**44 / 44 套、exit 0**（经理实跑，非仅员工自报）。

## 真实验证阶段（进行中）

- root 已另开隔离后端：空白运行目录 + 随机 loopback 端口。
- 新专用 Edge 已实际启动，核对 `normal=true`、独立 profile `true`、loopback `true`、同版本。
- 旧四进程保留，用户原常用 Edge 未改。
- 新窗口**等用户人工登录**后同条件查询 / 下载复验；**当前不声明发票查询 / 下载成功**。
- 不读凭据 / 业务原值入模型。端口 / PID / ref / 本机路径**只在 ignored checkpoint，不入 Git**。
- 不自动点击 / 不猜接口 / 不申报。

## 只读审查发现的后续技术待办

- invoice observer 仅同 target / session + 主 frame / loader；普通子 frame 会增加 `requestEvents` / `subframe`，**新标签 / OOPIF 可能完全不可见**。
- **未实现** `downloadWillBegin` / `progress` 或文件接收；`downloadPerformed` 固定 `false`。
- 这些是**后续技术待办**，非企业补材料，也非已证实失败原因；本 PR **不把模式修复冒充数据链打通**。

## 状态与下一步

- **代码 + 管理者回归完成；独立内容审查进行中；真实同条件下载待用户人工反馈；PR 尚未创建。**
- 旧真实探索暂停已被用户本次「直接排查修复」授权恢复；不得再写「一律禁止复验」。
- 已有 [PR #41](https://github.com/huxiaoyang-code/youshu-fork/pull/41) 已合并（`2bc05d3`），仅作前置交接，不改其历史文档。
- 下一步：等用户人工登录后同条件复验；后续补 observer 子 frame / OOPIF 可见性与下载事件接收。
