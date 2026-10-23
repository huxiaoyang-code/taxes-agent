# OFFLINE-05A：会计复核草稿导出

Refs #76 / #82。基线 main `6465a00e415c47d720d499e59faf233afd36708f`，分支 `codex/huxiaoyang-code/offline-05a-review`。唯一当前模型实施 subagent；用户授权覆盖旧本地执行器限制，禁止再委派与 Git 写操作。root 负责独立验收、全新审查与 Git。

范围：抽取现有 VAT 显式原文件/store/只读账库 loader；重新计算生成私有能力约束的复核 bundle；导出本机 JSON、七表 XLSX、最后发布完整 manifest。只接受原始输入与同进程私有账快照，不接受上传税算 JSON 恢复可信身份。缺项/未知/冲突/不支持保留分类和 null，所有会计确认始终 pending，整期/申报/执行均 false。

写窗口：`06-workbench/server/offline-vat-input.mjs`、`server/accountant-review.mjs`、`server/accountant-review-export.mjs`、`scripts/offline-vat.mjs`（只抽取 loader）、`scripts/accountant-review.mjs`、`test/accountant-review.test.mjs`、`docs/OFFLINE-REVIEW.md`、本文及 `docs/handoffs/OFFLINE-CLOSELOOP.md`。其它模块/旧测试/package/共享核心/STATE/NEXT 只读。真实资料、账套、凭据禁止读取或测试。

验收：合成原文件→材料重放→自动候选→现有核心测试适配过账→fresh 私有 snapshot→导出；独立整数分预期，ExcelJS/ZIP 读回，零/null/NA 与字符串/中文/前导零/日期/注入文本，完整追溯，无公式。覆盖克隆伪造/跨 scope/来源和账变更/拒覆盖/部分失败无完成标记，DB/WAL 零写，实际关闭。定点新套及旧 VAT22/XLSX19，不运行无关全量。

本片不完成结构化反馈、驳回、更正、重新确认或正式写账；这些仍依赖 #54 及后续 #80/#82。公共摘要只用于本机版本比较，hash 不构成认证。

## 实施收尾

新套最终 `node test/accountant-review.test.mjs` 15/15 exit0，旧VAT22/22与XLSX19/19 exit0；所有实际child/source/db关闭，失败历史与精确限制见专属交接。只合成原件及临时DB，无真实数据、Git写操作、再委派或外部执行器。实施冻结；root/fresh最终验收、PR与合并尚待，不能把本片草稿当#82确认链完成。
