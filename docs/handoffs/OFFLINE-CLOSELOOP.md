# 离线闭环交接

## 2026-10-24 当前事实（优先于下方历史候选）

OFFLINE-00 已随 [PR86](https://github.com/huxiaoyang-code/youshu-fork/pull/86) 合并：已审 head `3afe123bd2ba35114ff543d676224f2111600d8a`，merge `5410be670657f5df0bdaec80c05e83de939709fd`。root 独立34/34通过、全新上下文独审接受。#77工程合同已合不等于其会计生产黄金/法规表式/客户试用验收完成。

OFFLINE-01A / #78A 在上述基线上实施，当前为未提交候选，待root独立验证/全新独审/PR，不预报合并。只新增纯发票/银行CSV及基础事实JSON标准化、本机CLI与测试/文档，未接入运行账套。字段/来源hash/重复冲突/命令/支持边界见 [OFFLINE-MATERIALS](../OFFLINE-MATERIALS.md) 和 [任务单](../tasks/OFFLINE-01.md)。仅显式新output可包含路径与原值；stdout固定状态/计数；整体not_assessed、#79未实现。银行归属是本机配置声明，原票引用未核验既存记录，均不冒充真实性认证。

实施最终自测（cwd `06-workbench`）：`node test/offline-materials.test.mjs` **36/36、exit0**；相关未改模块 `node test/offline-contracts.test.mjs` **34/34、exit0**、`node test/bank-import.test.mjs` **16/16、exit0**。实际CLI同步子进程均返回明确status、signal=null，无自有常驻进程。新增测试覆盖独立1234.57+37.04=1271.61/银行647.29，真实三文件临时落盘、hash与重放、stdout敏感标记、已有输出/输入零改动。过程中31→33→34→35→36项按新增断言扩大，未删除旧断言；未运行无关全量。

审查期间修复JSON date及invoiceRef.code/number类型强转P2：现要求规范字符串，数组/数值/空白日期全部拒绝，新增固定回归。合法单源business JSON保留事实并标referenceVerification=missing/unresolvedReferences，不再因缺本批发票当非法；真实CLI已验。错误改为固定白名单类别、纯函数数值来源/行/字段定位，CLI只给固定分类，非法材料当前不输出报告，可逐源重验；#79分支调度仍未实施。以上是实施自测，不能替代root和fresh最终head验收。

#78B的XLSX、正式接收持久化/重启、跨批幂等与文件替换失效仍未实现，#78保持未完成。共享STATE/NEXT-SESSION未改；没有真实资料/账套/凭据测试，没有常驻服务，没有DB/package/锁/全量入口变更。

下方是OFFLINE-00实施时点记录，保留其历史状态。

2026-10-24，OFFLINE-00 合同准备部分（Refs #76 / #77）。实际 base `4223ccb3ad2c1b71178f2a510ed1f196ff963f03`，branch `codex/huxiaoyang-code/offline-00-contract`。本片尚待管理者独立验证、全新上下文审查及 PR，不预报合并。

交付：9类文档的 v1 严格纯校验、16组分离的合成输入/工程期望、独立十进制/借贷/舍入测试。调用返回 validationOnly=true、authorizesExecution=false。模块不落库、不读文件、不加载黄金，不发消息。税务真实数值全部未知；确认和任务完成状态当前拒绝。

实施自测：工作目录 `06-workbench`，命令 `node test/offline-contracts.test.mjs`，最终34 / 34 通过，exit 0（包含独审指出的负借贷侧、无关历史证据替换、补件材料目录、options 错误边界四项回归）。未跑全量（新增纯模块未接线、不改依赖或共享文件）。测试只合成夹具与自动清理临时目录；没有真实资料/账套/凭据。

本轮唯一实施 subagent，禁再委派，用户授权覆盖旧本地执行器；管理者负责 Git/PR 和独审。无自有服务或常驻进程。

下一步 #78 可复用这套约束实现 CSV/XLSX/JSON 的显式字段映射、来源记录/归一化和局部重复冲突检测；应扩展逐笔银行/工资/资产等来源合同。不得读取 expectations 作为运行输入。不要将 candidate 科目/税额反向要求客户输入；历史迁移保持独立。

#77 仍未完：会计审定范围与至少12组真实分录/结转余额/税额黄金、官方2026规则完整条款与福建表式、合法连续申报期、真实业务试用。当前16组是工程合同/算术样例，未结转试算不是结账余额，7/100不是税率。#79/#80/#81/#82 依次落实规划、幂等记账、税务计算和真实版本确认；#49/#51/#54 继续按既有依赖协调。

完整说明、官方来源、现有模块复用与回退：[OFFLINE-CLOSELOOP](../OFFLINE-CLOSELOOP.md)。共享 STATE 与 NEXT-SESSION 未改，避免覆盖其他窗口。
