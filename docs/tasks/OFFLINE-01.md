# OFFLINE-01：原始资料标准化（Issue #78）

负责人 huxiaoyang-code。A片 base `5410be670657f5df0bdaec80c05e83de939709fd`（PR86 已合），分支 `codex/huxiaoyang-code/offline-01-adapters`。本片是 **#78A 实施候选，待管理验收/全新独审/PR**；不关闭#78，不把XLSX/正式接收等后续范围标完成。

授权：用户明确指定唯一实施 subagent 继承模型，禁止再委派、pi/Claude/其他模型执行器；只实现与合成自测，不提交/推送/合并/发Issue。root 管理、独立验证及 Git/PR；最终独审者必须未参与实施、使用新上下文。该项目本轮授权覆盖仓库旧执行器条款，不改全局Skill。

文件窗口仅新增：`06-workbench/server/offline-material-adapters.mjs`、`server/offline-materials.mjs`、`scripts/offline-materials.mjs`、`test/offline-materials.test.mjs`、`docs/OFFLINE-MATERIALS.md`、本任务单；允许更新 `docs/handoffs/OFFLINE-CLOSELOOP.md`。不修改 core/db/package/锁/test-all/STATE/NEXT-SESSION/旧合同；共享状态由#51窗口拥有。

A片目标：纯标准化+本机显式路径只读CLI预检，从发票CSV、银行CSV和严格基础事实JSON形成标准records及来源定位报告。受限一票一行发票格式，不支持任意平台导出；显式企业角色、列映射、银行方向；金额到分、真实日期/范围/企业核验；保存非零税额与明确0，不将空值补零。发票/银行稳定ID重复与更正冲突保留全部版本；银行无ID只疑似重复，不推导收入费用。JSON用途/受益期/履约未知保留unknown，拒绝客户科目/凭证/最终税额。

产物只写显式新output，拒绝覆写、输出路径已存在即拒绝，stdout仅固定状态/计数；纯adapter来源hash边界和银行归属声明局限写在[使用合同](../OFFLINE-MATERIALS.md)。整体 `completeness:not_assessed`，#79未实现、不可过账或标整期完成。

验收：独立非零1234.57+37.04=1271.61、银行647.29；有效引号/中文/BOM/换行；明确0与空缺；非法日期/亚分/超界/跨企业/跨期；同额不同ID、相同ID重复、不同内容冲突、红字符号与原票引用；银行只基础收付；JSON事实/用途受益期；实际CLI落盘、UTF-8与文件hash、可重放、stdout敏感内容不泄露、错误与已有输出不改原件。测试仅临时合成文件，不读真实财税资料、数据库或凭据。

自测命令在 `06-workbench`：`node test/offline-materials.test.mjs`（36项，含JSON严格类型回归）；`node test/offline-contracts.test.mjs`（34项）；`node test/bank-import.test.mjs`（16项，现有纯解析影响回归）。最终结果见交接，未运行无关全量或登记test-all。

B片仍未实现：XLSX、工资/资产/历史等适配、正式接收持久化/重启、跨批幂等、替换来源导致存量失效以及引用原票/银行账户的既存状态核验。#79资料评估、#80自动凭证、#81税务及#82真实版本确认另有任务；本片不实现会计引擎。
