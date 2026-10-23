# OFFLINE-01C / #78C 受限发票 XLSX

Refs #76/#78。base `e564ce3dbcc2a84a4fc558c4a318c88637ced5e1`。用户授权本轮唯一继承模型 Codex 实施 subagent，禁止再委派、外部执行器及 Git 写入；root 管理独立验收、全新审查与 PR。

只实施一行一票、显式 sheet/headerRow/列映射的 XLSX。真实二进制 hash、原始 OOXML 数值词法、sheet/A1 定位，经现有语义归一、重复冲突判断、原件重放和 store 原字节持久保存，接续规划/候选/选定税字段链。CSV/JSON sourceVersion 不变。不扩大现有税务或会计支持范围。

文件窗口为 offline-invoice-xlsx、material-adapters、materials、material-completeness、material-store、两 CLI（materials/vat）、package 两文件、新 XLSX 测试及本任务/合同/本流交接；核心 DB/audit/import/batch、旧测试和共享状态只读。直接固定 fflate 0.8.3/saxes 5.0.1，现有 exceljs/scripts/pdfkit 不变。

验收使用实际合成文件：金额/原 hash/定位、CSV 等价/重复冲突、原件更改及重放、真实 store 接收/重启/CAS、规划覆盖和独立银行、候选与选定税链，以及公式/错误/歧义/类型/日期/精度/损坏/解压限额失败。新套及必要旧影响套实际结果、失败历史和限制收尾记录，不预报 root/fresh 接受。

实施完成候选已冻结，最终新套19/19 exit0。六必要旧影响材料36/规划45/候选43/store32/VAT22/snapshot26实际通过；store/snapshot先沙箱EPERM后获授权实建硬链/junction通过，未改旧断言。具体金额、故障历史、命令环境、边界与未完成依赖见本流交接本片首条；尚待root最终验收/fresh独审/PR，不预报接受或合并。

回退本片可恢复原CSV/JSON-only材料入口，既有CSV/JSON回执不改变；含invoice_xlsx的新store历史需保留原件与回执并回到本片或更高reader版本读取，不能用旧reader继续写该store或删历史。无DB迁移、无默认数据写入、无需撤销真实凭证。
