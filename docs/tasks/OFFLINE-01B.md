# OFFLINE-01B / #78B：本机材料持久接收

Refs #76/#78/#79。基线/main PR91 `0c6efe4bba9b7a62d09f434cd3fef071c917d4f8`，分支 `codex/huxiaoyang-code/offline-01b-receipts`。用户本轮授权唯一当前模型实施subagent，不再委派、不调用pi/Claude/TokenHub/其他执行器，不Git提交/推送/合并；root负责独立验收与Git。

目标：显式专属目录初始化，实际CSV/JSON及显式scope/mapping接收，保留原字节与本机回执，重启逐源重验，跨批幂等，显式更正CAS及历史链；有效reports复用 #79，资料接收不视为整期完整/已过账。原外部路径stale局部隔离，内部历史损坏整体failclosed。支持范围和命令见 [合同](../OFFLINE-MATERIAL-STORE.md)。

精确六文件写窗口：`06-workbench/server/offline-material-store.mjs`、`06-workbench/scripts/offline-material-store.mjs`、`06-workbench/test/offline-material-store.test.mjs`、`docs/OFFLINE-MATERIAL-STORE.md`、本任务、`docs/handoffs/OFFLINE-CLOSELOOP.md`。旧材料/规划/记账与核心DB/import/audit/coordinator/batch/HTTP/MCP、package/test-all、STATE/NEXT-SESSION均只读。无真实资料、账套、税务凭据、网络或消息操作。

验收用独立合成金额823.47+24.70=848.17及银行196.83：实际落盘与新进程inspect、同receipt重放、跨batch/跨source稳定业务重复、缺材料请求、金额/日期/mapping冲突零active变更、更正CAS/历史保留、补件和更正后计划局部失效、银行分支不变、scope/非法材料拒绝、原路径替换局部隔离、内部blob与manifest损坏、提交前后真实child终止、实际并发与恢复guard竞争、未知/活锁保留、输出wx/安全stdout。链接/rename若沙箱EPERM保留真实失败，交root授权实跑，不skip或伪造。

未完成：#77会计审定黄金、#78 XLSX/工资资产历史适配与显式origin重定位、#79正式执行回执、#80写账/连续核算；#54 coordinator独立在途。需root按最终完整head独立验收与全新未实施者审查；实施自测不等于验收/PR/合并。不关闭#78整项。
