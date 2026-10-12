# 08 · 方法与证据 / Method & evidence

## 使用的 REA 能力

| 步骤 | 工具/命令 | 产出 | Evidence ID |
|---|---|---|---|
| 目标发现 | `list_browser_targets` (CDP `127.0.0.1:9222`) | 页面 URL/标题 | `ev_f3601e802d4d6f03d581ba635436a115f64ba5edb35d267ba7f8f1d9bcb16837` |
| 被动页面检查 | `inspect-web-page` | DOM/无障碍/脚本/网络/存储 | `ev_5cf4d9b1e50fc3c9ac5368b003cd4c3095854144637c0a478fe8781101189311` |
| 截图 | `capture-web-screenshot` | `01-capture/screenshot.png` | `ev_8143096ed11a6dabe7f482a820efc5b9c1aceb597cbd153c81905dc11124326d` |
| 实时包分析 | `analyze-web-bundle --fetch-source-maps` | chunk 图、路由、接口、指纹 | `ev_66f34fbf3a16eb24431d8ad24f58769b4315e27f65d8ed84227505cb819b6962` |
| WebMCP 清点 | `discover-webmcp-tools` | 0 个页面声明工具 | `ev_7f835b30fd5c538787813255527a00039addde094442d0096a5d1fc2d7d0754d` |
| 脚本导出 | `export-web-scripts` | `02-scripts/finance/` + manifest | `ev_4e3f22c872cc3ec4e6e191a213435ef41368d55324ae0dea23991120046cf2c2` |
| `/work` 静态重建 | `analyze-javascript-application` | 应用图（48 接口节点/19 存储节点） | `ev_ad4fac8e260b2234518c88fa9d3345b023703c1cfd585f2dea8044444f2011c0` |
| `/finance` 静态重建 | `analyze-javascript-application` | 应用图（36 接口节点/11 存储节点） | `ev_777535033dbadd0cf3825cfde692652d5cbd3ea6947ff1719b0673d25d644c84` |

## 目标身份

- 浏览器：Chrome/155.0.8059.39（headless，CDP `127.0.0.1:9222`，REA 自有临时 profile）。
- 目标源：`https://daizhang.youshu.yun`（**注意**：用户原始 URL 的 TLD `yuork` 不存在，
  见 `00-recon/dns-corrected-url.md`）。
- `/work` 主包 SHA-256：`098e3f59318305abace7f8f600fac22986f7102438af73c652266b716fe0265e`。
- `/work` 目录分析 subject SHA-256：`c39a1f31c3d037ecf46ae27afc306ca2fa0104ae9c90d212be4fe3664e500210`。
- `/finance` 脚本目录分析 subject SHA-256：`7d24efa8bd28d0a09d635d6c3137be8b3272e75c8659d137b375e3b2631af343`。

## 复现

```
# 1) 启动可调试浏览器（REA 亦可自行 launch）
chrome --headless=new --remote-debugging-port=9222 https://daizhang.youshu.yun/work/
# 2) 目标列表
rea list-browser-targets http://127.0.0.1:9222
# 3) 被动检查 + 实时包分析
rea inspect-web-page http://127.0.0.1:9222 <targetId> --include-script-sources --format json
rea analyze-web-bundle http://127.0.0.1:9222 <targetId> --fetch-source-maps --format json
# 4) 离线静态重建
rea analyze-javascript-application 02-scripts/work --format json
rea analyze-javascript-application 02-scripts/finance --format json
```

权威性说明：实时页面/网络为 `external-service` / `observed`；静态包分析为
`shipped-artifact` / `derived`；接口与功能的语义归类为 `analyst-inference`。
