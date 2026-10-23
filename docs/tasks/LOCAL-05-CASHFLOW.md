> CSV极界补充：同16路径内csvCell现以已审formatCents(storedCents(value))格式化，避免可往返的90071992547409.90被Number.toFixed(2)多舍成.91；合法100现金/100资本明细真实CSV/XLSX/PDF及HTTP分别校验。最终测试与历史完整入口边界以本段交接为准，不冒称最终完整83exit0。

> 2026-10-23 范围补充：[Issue45 comment6364132865](https://github.com/huxiaoyang-code/youshu-fork/issues/45#issuecomment-6364132865) 将同16路径的report-export微窗扩大到本模块金额聚合/加减与超界拒绝。合成1000现金明细期初900000000000.01 + 999×0.01应为900000000010，旧Number累加多0.01；修复用已审money整数分读取、原posted/期间窗口逐行聚合，期初/closing、ledger运行余额与YTD分桶均以分加减后安全转换。不能精确保分或越安全分界限时返回report_data_invalid，不生成附件。DTO/累计范围/现金边界/诊断/CSV结构及通用money/core/Office生产均不改；这属于冻结b20已存在的准确性P2，不归因于窄复合实现。

# LOCAL-05b 可确定的全额复合现金流

负责人huxiaoyang-code；Issue45 / Refs20；基线PR71 merge `b20bba0e969c77b4f91b5e93b278cc5a9140ad54`；分支 `codex/huxiaoyang-code/local-05b-cashflow`。唯一实施fallback按用户额度不足时例外授权执行，不Git、不另派agent、不自审。精确16路径由[认领comment](https://github.com/huxiaoyang-code/youshu-fork/issues/45#issuecomment-6363958923)登记。

目标：两持久profile仅全额纯单向材料1403 / 设备1601复合收付，保留真实歧义与legacy。实现合同见[准则文档](../ACCOUNTING-STANDARDS.md)，出口仍消费同DTO，Office生产模块和累计算法不改。

验收：两profile显式不同合成企业，期初1000；2025-11经营-120/投资-180/净-300/现金700；12月+20/+30/+50/现金750，YTD-100/-150/-250；2026-01-12.01/-18.02/-30.03/现金719.97，YTD仅新年。另31.27/68.74、顺序/明细/重复根/多现金明细、draft/posted/unposted/重过账只计一次、所有表读前后相同。真实未知覆盖部分结算、处置损益、双侧和语义冲突，1604跨月/跨年不抹诊断。

CSV/XLSX/PDF各自对独立字面常量验证，至少18现金流文件；ExcelJS重开，PDF真实提取、Poppler渲染及pdfplumber几何，代表页由root目视。正式四套与语法通过后冻结源码/测试，再跑当前真实完整总入口。所有命令使用新UUID合成根、import前TEMP/TMP/DATA、KEEP_FIXTURES=1、传child、祖先realpath/lstat核无链接；DB finallyclose、自有child真实close；失败现场保留。没有真实账套/税局/凭据。

仅本任务16路径可改；禁止aux/DDL/写入/导入/期间/备份/银行/batch/audit/model/transport/CLI/MCP/public/package/lock/test-all及Office生产模块。必要扩窗先报管理者。自测证据及失败历史见[交接](../handoffs/LOCAL-05-CASHFLOW.md)。本片待root独立验收、全新上下文独审与PR自动合并；04/06/07和最终整链仍未完成。
