# 任务单 · TAX-EDGE-DOWNLOAD-FIX

Refs #20 / #13 / #17。负责人 `huxiaoyang-code`。基线 `2bc05d3680b456ccecb7bf1a16b64107017114b1`，分支 `codex/huxiaoyang-code/tax-edge-download-fix`。[交付文档](../TAX-EDGE-DOWNLOAD-FIX.md) · [交接](../handoffs/TAX-EDGE-DOWNLOAD-FIX.md)。

## 需求

用户确认：同企业同条件下常用 Edge 能下载发票，旧后端专用 Edge 查询 / 下载失败。本机两者版本相同 `155.0.4283.62`，差异在启动模式（旧专用 `inprivate=true` vs 常用 `false`）。按官方 `blockthirdpartycookies` 文档（InPrivate 默认阻止第三方 Cookie）形成**可信兼容性假说**，据此移除已知模式差异并保留验证路径。

## 假说边界

兼容性假说，**不是实测税局根因**；不据此宣称修复已解决业务问题。

## 实现范围（仅 4 文件）

1. 传输层：移除 `--inprivate`；保留 ACL 独立临时 profile、loopback CDP、退出清理。
2. 诊断层：由强制 InPrivate 改为兼容旧 owned InPrivate / 新 owned normal；继续拒绝重复畸形 `inprivate`、guest / headless / unsafe。
3. 测试 ×2：覆盖接受与拒绝。
4. **不放宽** owner / profile / 端口 / ACL。

## 验收

- 员工自测：`browser-session` 46 项 + `diagnostic` 5 项通过。
- 管理者回归：在当前冻结代码上**实际完整运行** `test-all`，**44 / 44 套、exit 0**（经理实跑，非仅员工自报）。

## 真实验证（进行中）

- root 另开隔离后端：空白运行目录 + 随机 loopback 端口。
- 新专用 Edge 已实际启动并核对 `normal=true`、独立 profile `true`、loopback `true`、同版本。
- 旧四进程保留；用户原常用 Edge 未改。
- 新窗口等用户人工登录后同条件查询 / 下载复验；**当前不声明查询 / 下载成功**。
- 端口 / PID / ref / 本机路径只入 ignored checkpoint，不入 Git。
- 不自动点击 / 不猜接口 / 不申报。

## 后续技术待办（非本次修复）

- invoice observer 仅同 target / session + 主 frame / loader；普通子 frame 增加 `requestEvents` / `subframe`，**新标签 / OOPIF 可能不可见**。
- **未实现** `downloadWillBegin` / `progress` 或文件接收；`downloadPerformed` 固定 `false`。
- 这些是技术待办，**非企业补材料、非已证实失败原因**；本 PR 不把模式修复冒充数据链打通。

## 状态

代码 + 管理者回归完成；独立内容审查进行中；真实同条件下载待用户人工反馈；**PR 尚未创建**。旧探索暂停已由用户「直接排查修复」授权恢复。
