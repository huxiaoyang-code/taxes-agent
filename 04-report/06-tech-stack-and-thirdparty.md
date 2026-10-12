# 06 · 技术栈与第三方依赖

| 项目 | 值 | 置信度/来源 |
|---|---|---|
| 打包器 | Vite | inferred (medium), ev_66f34fbf3a16eb24431d8ad24f58769b4315e27f65d8ed84227505cb819b6962 |
| 框架 | React | inferred (medium), ev_66f34fbf3a16eb24431d8ad24f58769b4315e27f65d8ed84227505cb819b6962 |
| UI 库 | Ant Design (antd) | observed (`antd-vendor-*`, DOM rc-* markers) |
| HTTP | axios | observed (代码中 `axios.create`) |
| 图表 | Mermaid | observed (动态导入 `mermaid.core-*.js`) |
| 公式 | KaTeX | observed (`gullet.macros`) |
| 监控 | Sentry | observed |
| 表格导出 | xlsx（疑似） | inferred |

## Sentry

两个应用包中嵌入了同一 DSN：

```
https://9f2168bc410b913eec642ef141d7b8fb@o4512192744587264.ingest.us.sentry.io/4512192945389568
```

这是前端监控的**公开写入密钥**（write-only DSN），本身不构成漏洞；但说明存在
`o4512192744587264` 组织与项目 `4512192945389568`。证据：`ev_ad4fac8e260b2234518c88fa9d3345b023703c1cfd585f2dea8044444f2011c0`（字面字符串）。
