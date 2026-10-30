# 直接业务工具使用

本机后端与MCP使用明确的数据库、服务端口、技能目录和自动记录目录。宿主生成器配置`FINANCE_MCP_PROFILE=direct`；插件目录可由`--plugin-root`选择。配置存在不证明已连接，实际工具合同和返回决定支持范围。

| 目标 | 实际直接工具 | 输入与结果要点 |
|---|---|---|
| 核实账套 | `account_context` | 显式选择实际企业账套，不保存猜测的当前账套 |
| 查账与报表 | `finance_query`、`ledger_query` | 实际nodeId、账套及期间；保留原生口径和单位 |
| 查业务记录 | `finance_record_contract` | 只取当前需要的record类型，核披露完整度、已核字段、可用例子和原生规则限制 |
| 查规则 | `finance_rules` | 中国税费及会计规则的当前来源、支持条件和边界 |
| 业务底稿 | `finance_workpaper` | 优先target:{accountSetId,period}及原件/记录，后台绑定企业实例；自动保存输入及结果，不手工登记事实/计划 |
| 税费计算 | `finance_tax_calculate` | 选定真实固定分支，缺件和未覆盖状态保留 |
| 全年计算 | `finance_annual_workpaper` | 全年同企业原始业务资料；不接受只有年度汇总冒充原件 |
| 分录及账务 | `voucher_check`、`voucher_create`等真实工具 | 明确分录、当前科目、期间和实际授权；写入保留原控制 |
| 旧账导入 | `book_import_incremental`、`book_import_batch` | 预检与正式写入分开，稳定来源与原批次查询 |

精确参数从当前工具schema读取，不在此重复维护第二套合同。数据由Agent整理，客户不需内部模板。原件、派生JSON、底稿和正式账簿分别核对，工具字段或例子不证明客户事实齐全。旧编排接口只用于兼容历史，不属于默认业务步骤。

普通业务无需模型拼内部scope或manifest。显式scope、manifestPath为兼容载体；年度仍按真实manifestPaths合同。合同仅有通用字段和规则引用时，标注披露不完整，不直接判原生算法未实现。
