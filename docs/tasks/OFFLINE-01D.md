# OFFLINE-01D / #78D 受限银行 XLSX

Refs #76/#78，认领 #78 comment6375851534。共同基线为已合 [PR98](https://github.com/huxiaoyang-code/youshu-fork/pull/98)：base `98e57bdfbe29e2f8716ab0768492583064cd30c1`、已审 head `a331b21abd72b94147742fd7e96fed0849e10cb6`、merge `11e47e6ce6e1fff724a3e158f9c98b48fcb8f6d3`。交付 #77 comment6375751257 / #76 comment6375751712 / #85 comment6375752159 / #80 comment6375752731；三方黄金15/旧候选43/规划33/VAT22及12业务/24张凭证/36份月末快照独立验算已通过。#54 最新 comment6375884790：R5 两文件窄修已独立接受并提交 `d1d618b5d19f31a877f94407ffcfcf10f518af15`，正进行13份文档收口和上游影响验证，完整最终候选仍待 fresh/PR/merge、正式写依赖未放行。远端 main 仍 `11e47e6`，不把旧 `87043a` 待审当当前接受事实。

用户明确授权本轮唯一继承当前模型的实施 Codex subagent，覆盖旧 pi/Claude/GLM/TokenHub 限制；禁止外部模型执行器、再派子 agent、Git 写与全局配置修改。root 管理 Git/PR、独立验收及全新未实施者审查。本片使用隔离工作树 offline-01d-bank-xlsx，不加载真实/历史材料，不联系客户。

精确八文件窗口：06-workbench/server/offline-invoice-xlsx.mjs、server/offline-material-adapters.mjs、server/offline-materials.mjs、server/material-completeness.mjs、新 test/offline-bank-xlsx.test.mjs、docs/OFFLINE-XLSX.md、本任务与 own docs/handoffs/OFFLINE-CLOSELOOP.md。旧测试、规则/账务/DB/store/CLI/package/lock/test-all/STATE/NEXT 与 #54 的66路径只读。ignored .agent-runs 只放合成探针与日志。

实现固定 readInvoiceXlsx/readBankXlsx 包装同一私有受限 readMappedXlsx；数值权限固定且不可来自用户 mapping。银行 amount/balance 可为受限精确数值，其他字段必须文本，复用 bank_csv 的全部归属/方向/日期/金额校验与语义身份。映射仅 bank-xlsx-v1 + sheet/headerRow，不扩 debit_credit、猜测或缺省归属。ZIP/XML/关系/part/单元格/限额拒绝与旧发票保持一致。两 XLSX 均 base64 运输、原 binary hash，XLSX 原 sheet/row/A1/column 来源保留。

银行槽与完整度只改必要 kind 判断。通过现有统一 bytes 接口实际验证 CLI/store 接收、重开、replay/CAS、原件变化 stale；不修改这些模块。实际文件行动计划使用有效 bank_xlsx 的逐账户覆盖，现有未来服务预付候选使用银行实际金额；缺项只问对应事实，独立合法分支保留。无新会计/税务规则，无本片正式写账、DB、网络或执行授权；authorizesExecution/periodComplete/completed 保持 false。

合成测试独立数值：预付684.23、余额-315.77，销售净914.37+税9.14=923.51；更正预付685.27、余额-316.81。期望只在测试断言，不作为运行输入。ExcelJS 实际文件→读回 bytes→标准化；含中文 sheet、非首表头、长前导零 ref、文本/数值/inline、非连续第12行、公式含 cache/错误/布尔/日期序列/数字ref/科学计数/亚分/复杂格式/ZIP/XML及限额。还覆盖跨格式 identity/semantic 与单候选/conflict、非法归属/范围/映射/缺文件、固定stdout/wx、原件SHA不变、store实际blob与child重启/receipt/origin/CAS，以及公开报告篡改和文件变化拒旧session。

独审P2：原25/25未覆盖 type=n 原值带币号/千分位时被银行文本选项接受。独审原失败probe保留；实施追加两测试后在原核心实跑26通过/1失败，失败日志与合成目录保留。修复仅银行固定reader的数值路径先严格限制原十进制词法，amount/balance同时覆盖，不改变发票旧路径、实际文本选项或CSV normalization。新测试包括币号/逗号/空格分组、前后空白含LF/CRLF/tab、奇形数值拒绝及三组实际文本amount/balance与CSV兼容正例；旧科学/亚分数字现提前报固定xlsx_cell_invalid。修后实施新银行27/27、旧发票19/19均exit0，尚待root按修后完整HEAD重验/fresh复审；不以修前25接受替代。

实施必要验证及最终冻结状态见本流交接首条。只运行新银行套及必要旧受影响套，不修改旧断言或跑全量。任何实施通过不替代 root/fresh 的最终冻结验收，不声称 #78 整包或 #76 完成。#54 正式写账接线、会计生产审定、真实试用及后续闭环仍待原任务推进。

回退只撤销本片银行入口，不改变旧 CSV/JSON/发票 reader 业务；含 bank_xlsx 的新 store 历史必须保留原件/回执并使用本片或更高版本 reader，不能以旧 reader 继续写或删除历史。无 DB 迁移，无本片真实凭证需撤销。
