# 显式只读账务快照（OFFLINE-04A / #81A）

本片提供本机SQLite账套的显式只读、一致读取及同进程失效校验基础。没有税额计算、余额或折旧新引擎，没有写账、正式执行回执或外部申报；`calculationReady`、`submittable`、`authorizesExecution` 固定为 `false`。#81整项仍未完成，正式写账仍依赖另一窗口的 #54 coordinator 及后续接线。

## 本机能力与导出边界

```js
import { openReadonlyLedgerSource, captureLedgerSnapshot, validateLedgerSnapshot }
  from './server/offline-ledger-snapshot.mjs';
const source = openReadonlyLedgerSource(explicitLocalDatabasePath);
try {
  const snapshot = captureLedgerSnapshot(source, {
    enterpriseKey: canonicalEnterpriseKey, accountSetId: positiveInteger,
    fromPeriod: '2026-01', toPeriod: '2026-03',
  });
  const result = validateLedgerSnapshot(source, snapshot); // current 或 stale
} finally { source.close(); }
```

`source` 是模块私有 WeakMap 登记的冻结句柄，只公开 `close()`，不给调用者数据库连接。只复用 `openAuditDatabase(path,{readOnly:true})` 打开显式路径；不导入 `db.mjs`、不读取默认库、不安装/迁移结构。捕获及重验均使用 `withReadSnapshot` 的单个读事务。输入范围恰为四个字段，企业键须规范字符串，账套ID须正安全整数，月份为1000—9999年的合法年月，按月顺序枚举，最多120个月，拒绝反向范围和额外字段。按季税算尚无接口。

捕获必须读到该企业与该账套唯一、精确的持久规范绑定。不存在/错配直接拒绝，不按显示名称猜归属。source路径及其祖先不得为符号链接或路径别名，源文件须普通单链接文件；持有只读文件描述符，开库前后和每次读取前后核对dev/ino/birthtime。已关闭句柄失效；路径消失、被换入其他文件或新增别名均拒绝继续把旧连接当该路径的当前库。仅能核对本机连接和观察到的文件身份，不能证明库的内容来自真实交易。

每个快照深冻结，并以私有 WeakMap 绑定原始source和实际捕获摘要。重验重新读取目标scope实际内容比较，返回 `current` 或 `stale`；关闭、伪造、跨source、JSON反序列化或clone直接拒绝。公开 `contentDigest`、producer/status等自述不能恢复可信能力。CLI JSON为 `exportTrust=diagnostic_only_not_restorable` 的本机诊断明细；未来税算必须在同进程从本source新捕获、重验，不能上传JSON后称已认证。`current` 只说明此次事务读内容与捕获一致，不锁住之后的写入，也不授权任何执行。

## 实际读取内容

快照保留规范企业绑定、账套全部持久元数据、精确持久profile ID及注册定义、账户清单、全部期初、目标截止月及以前的期间/完整凭证/分录。目标起月以前的凭证以 `range=prior_history` 分开，保留供未来计算核查；目标期内的posted、draft和未知状态分别计数，posted分录包含真实ID、日期、行序、科目、摘要与金额，draft完整保留且不混入posted计数。不是以当前期无凭证推导历史或余额为零。

金额保留数据库实际值，独立给出精确整数分 `debitMinor` / `creditMinor`。负值、非数值、超过两位小数或超过安全整数分时给 `null` 和 `stored_money_invalid`；不复用会舍入输入的金额解析器来修补存储证据。任何实际读取的非有限数字（含非金额字段）使捕获/重验明确拒绝，不能让JSON把Infinity/-Infinity折叠为null从而伪报current。profile缺失/未知给 `unknown`，不fallback成小企业profile。

读取实际import来源绑定、逐张来源登记、批次关联及相关批次。四张来源表分别读取，逐表列出presence和missingTables；缺一张关联表时仍保留其他可读已知事实及其变化失效，关联证据不足给unverified。缺关系表时保守保留目标账套/企业全部批次元数据，不按无法验证的期间关系丢弃已知事实。对登记凭证的完整当前行序/内容复用 `persistedVoucherFingerprint`，分别列出匹配、缺指纹、失配、非法金额或归属失配；缺来源单列。批次关联只表示登记关联存在。来源登记及指纹匹配均不证明原始文件已核验、经济事项真实或记录完整，`originalFileVerification=unverified` 始终保留。当前v5来源绑定表没有 `account_set_id`，按规范企业键关联唯一账套；凭证来源和批次关联则同时保留目标账套及跨身份异常关联。

如已安装有效audit组件且有唯一活实例，读取并绑定其真实实例ID；未安装/损坏/未知结构给 `unverified`。无论是否认证，实际审计实例原始行及schema状态/问题仍入摘要，避免未知状态折叠隐藏实例更换。可选batch组件的实际实例全部行与component元数据单独保留为 `persisted_unverified`，无表给 `unknown`，不安装、不认证为可写状态，不读取其他企业job和审计事件明细来构造范围摘要。

完整度始终独立列出：实际枚举月份及缺期间、期初完整度、范围覆盖、既往历史完整度、真实交易及原文件真实性。后五项仍为 `unverified`；即使空账、三个月都有期间行或所有来源指纹匹配，也不能推出零申报、税务准备就绪或完整历史。

重验目标金额、posted/draft状态、凭证/分录内容、来源/批次、绑定/profile/账户/期初/相关期间及审计/batch实例变化均使旧产物stale或拒绝；同账套范围前历史变化也失效。无关企业业务变化、目标截止月之后凭证和期间变化不影响当前scope。审计/batch身份属于数据库级上下文，变化可使本scope失效。不能保证发现先变更后完全恢复原值的瞬态历史；这是内容一致性检查，未实现版本化执行协调器。

## CLI

在 `06-workbench` 运行，参数固定顺序且全部必填：

```powershell
node scripts/offline-ledger-snapshot.mjs --db <显式本机.db> --enterprise-key <规范企业键> --account-set-id <正整数> --from 2026-01 --to 2026-03 --output <全新本机.json>
```

唯一产物写入为显式新output（`wx`，拒覆盖）。只有output含本机明细。stdout只有固定状态及posted/draft/missingPeriods计数，错误只有固定 `USAGE_ERROR` 或 `REJECTED`；exit分别为0/2/4，不打印原始路径、企业、金额或堆栈，不写stderr。Node自身警告由运行环境决定（测试子进程显式 `NODE_NO_WARNINGS=1`）。不联网、不读取材料或税务凭据，不把诊断导出标为可提交。

## 合成验证与限制

`node test/offline-ledger-snapshot.test.mjs` 使用repo忽略目录 `.agent-runs` 下合成临时库，import前设置 `WORKBENCH_DATA_DIR` / `TEMP` / `TMP`。由实际accounting/import核心创建、导入及过账，再由实际核心补draft，故障场景只更改该合成库。官方audit/batch安装仅用于合成夹具；生产模块没有安装调用。成功默认清理，`KEEP_FIXTURES=1` 保留，失败自动保留。

验证包括独立1297.43=1284.58+12.85、期初837.19、草稿74.29；企业/月份隔离、缺3月、空账、真实来源/落库指纹、非法分值、金额/状态/profile/期初/账户/期间/来源/绑定/历史及实例变更失效、伪造和clone拒绝、同事务中间真实writer提交、main/WAL及逻辑表零写、CLI安全stdout与拒覆盖、关闭失效。

Windows本机持SQLite连接时真实文件rename报EBUSY，父目录rename报EPERM，未实际替换。测试严格检查win32及白名单errno、原文件身份与字节未变、原产物仍current，输出 `OS_BLOCKED_PATH_REPLACEMENT`；不能称已验证Windows运行中成功换入文件后的产品拦截。其他平台若实际替换成功，测试必须验证产品拒绝。

最初沙箱内held库hardlink报EPERM，不能将该沙箱边界降成通过。root随后获授权在沙箱外真实运行24/24、exit0，实际建立hardlink并确认nlink=2触发产品拒绝，移除后原产物恢复current，DB实际close。测试保留真实硬链断言，没有skip、平台通过分支或文件身份mock；受同类沙箱限制的运行须由管理者在已有授权范围下执行合成定点验证。
