# 交接 · LOCAL-01B 一企一套全入口

## 当前候选合同（2026-10-23）

负责人 `huxiaoyang-code`；分支 `codex/huxiaoyang-code/local-03a`，本段输入 `502640906262d6eefbe81b3460361e74ea0811b5`。双准则领域、出口、企业身份全入口已实施，当前候选仍未提交 / 未开 PR / 未合并，最终独立验收待管理者。统一入口保留 main 原 65 套逐字原序并末尾登记实际 8 套（3 个标准领域 / 迁移、身份领域 / HTTP / MCP、标准 HTTP / MCP），共 73 套；实际完整运行结果见下方“本轮完整验证”。

- 新建、legacy 首次导入与 incremental create 都必须显式稳定 `enterprise` / `source.enterpriseKey`；NFKC + trim，保留大小写，接受有限数值文本化，不从名称或来源系统造身份。同 key 换名 / 换来源不得另建账套，不同 key 同名允许。账套 / profile / 科目 / 期间 / canonical 身份在同一事务或保存点，失败原子回滚。
- 历史未绑定账套仍可读；`GET/POST /api/account-sets/:id/enterprise` 及本机 UI 支持显式确认关联。首次关联要求确认，同绑定返回 `no_change`，不强换绑、不自动合并旧重复账套。新建 UI 已传显式身份；JSON / CSV UI 文件导入的受支持 filechooser 流程经 root 尝试后仍出现工具实际超时未受控，上传 / 预检结果未知，暂不继续该工具流程；不能由领域 / HTTP 测试代替 UI 成功。
- 真正省略 profile 默认 `small-2011-basic-v1`，精确企业准则选 `enterprise-2019-general-basic-v1`；显式空 / null / 非字符串 / 未知 profile 拒绝 `accounting_profile_unknown`，准则不合法与不匹配分别为 `accounting_standard_invalid` / `accounting_profile_standard_mismatch`，legacy profile 禁新建。历史 `legacy-small-coa-v1` 保持兼容，不能用标签转换。
- append 与已完成 create 批次先定位目标持久 profile，再归一化。旧成功批次重放保持账套 / voucher / source ID、原批次及来源指纹、attempt 与时间戳，验证 canonical / 来源证据 / batch links；重放不重算旧指纹。从未导入期初的批次允许后来合法补期初；实际导入过的期初变化仍冲突。
- 五类 CSV / XLSX / PDF 传持久 `accountingContext` 和 `reportStatus`，三表为 `complete/incomplete/legacy_compatibility`，余额 / 明细为 `not_applicable`。稳定行 ID 对齐，累计现金流保留各月诊断；新 profile 的未知 / 复合现金流不按比例凑齐，不能宣称完整。累计折旧借方净额列示（贷余额为负，零为零），折旧 magnitude、资产净值、利润、幂等及回滚合同不变。
- strict backup 识别 core schema 3 / 4 / 5 × bank 0 / 1 精确合同，未知结构 fail closed；不代表审计业务接线、现库安装或真实 restore 已完成。模型只接固定 profile / 状态 / 诊断计数，未知 fail closed，企业 key / 名称 / 明细与自由错误不出站；08 原脱敏 / 引用 / 账套隔离边界保持。

仅内部简化基础业务子集，不是完整准则或税局可上传申报文件；来源完整性仍 `unverified`，全国真实接入数 0。辅助核算 Issue #64、LOCAL06 审计 / 恢复与 Windows W2、LOCAL07 whole batch 仍未完成；不能由本候选宣称整个 LOCAL01 / 03 / 05 完成。

### 2026-10-23 独审 P2 修复后的验证边界

新增明细科目的严格归一化现调用 `addAccount` 同源 `accountProfileSemantics`，按新建选定或目标持久 profile 拒绝 `account_semantics_conflict`；已有标准科目兼容与旧成功批次指纹规则保持。修后实际命令（cwd `06-workbench`）：`node --check server/accounting.mjs` exit 0；`node test/accounting-standards.test.mjs` 38/38、`node test/import-incremental.test.mjs` 57/57、`node test/import-strict.test.mjs` 54/54、`node test/accounting-standards-http.test.mjs` 2/2、`node ../05-reconstruction/codex/mcp/finance-mcp/accounting-standards-test.mjs` 2/2，全部 exit 0，自有直接 child 均已 close。双 profile 的 legacy / incremental create / append 错类别和方向均静态拒绝、业务及批次 / 来源全表零写；合法同根明细独立金额及 completed 批次 ID / 指纹只读重放通过。

此前管理者在修前候选执行完整入口 `node scripts/test-all.mjs`，73/73 套各 exit 0，入口实际 exit 0、child close，候选 76 文件 hash 前后相同。这是修前真实历史；本 P2 修后完整 73 套与最终 fresh 审查仍待管理者执行，不能以旧完整结果替代。更早实施者 71/73、两税务定点 61 项也仍是历史证据。

UI JSON / CSV 文件导入两次 filechooser 工具超时；用户已授权 CDP 合成输入，但工具明确不支持 raw CDP，实操仍未知，不能记为通过。所有本轮自有 UI 服务均已结束，不再启动浏览器重试；领域 / HTTP / MCP 通过不替代 UI 实操。内部简化报表子集、来源完整性 `unverified`、真实税局接入 0、辅助维度与 LOCAL06 / 07 未完边界保持。

### 修前实施者完整验证历史

2026-10-23 实施者实际执行 `node scripts/test-all.mjs`（cwd `06-workbench`），新 UUID 合成隔离根、TEMP / TMP / DATA 预设并传 child，显式 Office Python：完整 73 套真正执行，**71/73 套、1907/1909 项，exit 1**。仅两个税务 MCP 旧建账 fixture 漏 enterprise：`tax` 58/59 与 `tax-acquisition-mcp` 1/2；其余 71 套全部 exit 0，含批量 CLI 11/11、Office 25/25、新标准与身份 8 套。批量真实 PDF 文本、CSV / XLSX 累计折旧负号与独立 magnitude / 净值 / 利润 / 幂等 / 回滚断言均通过。

经 Issue #56 comment6359944200 精确授权，完整入口实际 close 后，仅给 `tax-contract-test.mjs` 与 `tax-acquisition-test.mjs` 的两处建账参数补固定合成 enterpriseKey；所有税务请求和旧断言原样。新 UUID 根以原正式 suite 定点重跑 **59/59 + 2/2，均 exit 0**。原完整红例保留；不能将修后定点结果改写为同一最终 hash 的 73 套全绿，该时点管理者完整入口尚待执行；后续修前完整 73/73 已实际通过，见本页 P2 验证边界。修后完整入口与最终 fresh 内容审查仍待执行。

首轮普通沙箱完整入口因 loopback EACCES 和硬链接权限路径失败，在旧 `tax-readonly-abandon` 的 checkpoint 等待挂起；只进入 21 套、前 20 套已返回，未跑后续。精确核验命令 / 创建时间 / 父子链后持自有 Process handles 收尾，已 wait，wrapper 记录 child close，入口终止码 4294967295、wrapper exit 1；此轮不计完整 73 套。第二轮完整入口与两套定点的直接 child 均实记 close；无本段仍运行的自有 exec / 后端服务。所有 fixture / 失败日志保留，无全局 TEMP 清理、无真实账套或税局操作。逐套日志与 hash 已交管理者；本段不执行 Git。

## 验收与恢复输入

关联 Issue #61 / #56。实现输入为 `5026409` 身份检查点，不恢复旧 `22dc0fd`；该本地保存提交不是本候选合并提交。HTTP / Agent / MCP 均转发显式企业身份与 profile，JSON / CSV 导入 UI 的工具超时未受控，上传 / 预检结果仍未知。主要验收包含缺失 / 错误身份零写、同企重复 / 跨 system 拒绝另套、不同 key 同名、历史绑定确认与强换绑拒绝、成功旧批 replay 原 ID / 指纹 / 时间戳不变以及 HTTP / MCP 真实链路。

旧源码 schema4 → 当前 schema5 的已留历史证据：原 setID=1 / voucherID=1 / sourceVoucherId=`OLD-EXACT-SOURCE-001`，净利 50、cash 1050 不变；批次指纹 `b78fcbb11c9e9d569c9cedec415374dde3214024872c39b65388973aeba11430`，来源指纹 `fa01031056778e7eb4e0137d41e44fa63824c63335ff5f6ece6405dd0c5d1fdf`。这是第二段实测历史证据，本段未再次运行该旧源码 probe；不得冒充本轮全套的新结果。

员工只实施 / 自测，不执行 Git；管理者依据冻结 hash 做最终独立审查 / 提交 / PR / 合并，再补真实 merge 交接。本候选未合并前 Issue #61 不标完成。
