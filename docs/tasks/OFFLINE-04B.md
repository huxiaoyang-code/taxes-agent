# OFFLINE-04B / #81B：最小非零 VAT 选定行底稿

Refs #76 / #80 / #81。基线 PR92 merge/main `e280877ce60d75ec859ad6da2b8514fa98341c46`；分支 `codex/huxiaoyang-code/offline-04b-vat`。认领证据 issuecomment6373062873。本轮唯一当前模型实施 Codex subagent；用户明确覆盖冲突旧本地执行器规则，禁再委派/pi/Claude/TokenHub/其它外部执行器，无 Git 提交/推送/合并；root 负责独立验证、全新未实施者审查与 Git。

范围与接口见 [OFFLINE-VAT](../OFFLINE-VAT.md)。真正重放 #78/#79/#80 原始材料与会计事实，再核 #81A 私有当前真实只读已过账快照，逐业务 key/来源/批次/完整分录匹配；2026Q1新设首期季度小规模企业普通境内主营服务、逐票整元1%无尾差、全季度销售额达到300000元，计算服务列1/2/3/15/16/20/21/22。期初、历史、工资资产、业务排除、全期覆盖、会计资格均须依据；未知不当零。工程支持日期与法律期限分列。

写窗口精确七文件：新增 server/tax-rule-registry.mjs、server/tax-calculation.mjs、scripts/offline-vat.mjs、test/offline-vat.test.mjs（均在06-workbench），新增 docs/OFFLINE-VAT.md、本任务单，更新 docs/handoffs/OFFLINE-CLOSELOOP.md。其它历史/规划/候选/资料store/ledger snapshot模块只读复用。#54 另一窗口占 DB/accounting/import/audit/coordinator/batch/HTTP/MCP/package/test-all/STATE/NEXT-SESSION 等，全部只读，不扩大窗口。

验收：合成原始落盘CSV/JSON自动生成候选，测试适配通过真实核心importIncremental入临时库，独立金额/300000边界、具体unsupported/未知/冲突、资格与覆盖、全部凭证解释、draft/批次失败/来源或分录不符/持久准则错配、伪JSON snapshot、原hash变化/新版本与不相关企业、跨范围/规则日期、选定行勾稽和累计NA、CLI新wx输出/安全stdout/实际重读/无默认DB/DB及WAL零写。只跑必要影响套，不改旧断言。

输出仅selected-fields ready，不代表整表、整期或税局上传兼容。periodComplete=false/submittable=false/onlineCompatibility=unverified/accountantApproval=pending；真实性仍提供资料级别unverified。#80正式写账/连续过账、真实既存账更正、#82版本确认未完成，#81全验收未完成。实施自测和失败历史见本流交接；未预报root/fresh接受、PR或合并。
