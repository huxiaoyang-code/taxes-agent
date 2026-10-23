# OFFLINE-01B：本机材料接收与重验

Refs #76/#78/#79，基线 PR91 merge `0c6efe4bba9b7a62d09f434cd3fef071c917d4f8`。本片在 [原始材料标准化](OFFLINE-MATERIALS.md) 上增加本机专属材料目录和接收回执；接收回执只证明本机保存了哪些字节及映射，不证明经济事实、提供人身份、原件真实性或整期完整。固定 `authorizesExecution:false`、`completeness:not_assessed`、`authenticity:unverified`。不写账、不接核心 DB，不生成会计执行回执。

## 显式接口

在 `06-workbench` 运行，flags 次序固定，所有 output 必须是专属 store 外的尚不存在新文件：

```powershell
node scripts/offline-material-store.mjs init --store C:\local\new-store --config C:\local\scope.json --output C:\local\init-result.json
node scripts/offline-material-store.mjs receive --store C:\local\new-store --config C:\local\materials-config.json --output C:\local\receipt-result.json
node scripts/offline-material-store.mjs inspect --store C:\local\new-store --output C:\local\fresh-result.json
node scripts/offline-material-store.mjs recover-lock --store C:\local\new-store --output C:\local\recovery-result.json
```

init 配置严格只有 `{"scope":{...}}`，scope 沿用 #78 的 `enterpriseKey, accountSetId, period, currency, unit`；只支持 CNY/yuan。store 限同一企业、账套、显式期间表示、币种及单位，不把季度与等价月份范围自动视为相同。init 只创建指定新目录，父目录必须存在；已有目录即使为空也拒绝接管。中断初始化留下的未知/不完整目录不自动删除或补建。

receive 配置沿用原 `offline-materials` CLI 精确 `scope,sources`，来源精确 `sourceId,kind,scope,path,mapping`；相对来源路径基于配置目录。实际读取配置与来源字节，不接受调用方提供的 hash/records/status。支持 `invoice_csv,bank_csv,business_json`，每文件至多5 MiB、UTF-8可带BOM、每批及active来源最多100。未支持 XLSX、OCR、工资/资产/历史适配器。预检可继续使用旧 CLI，它不接收、不写账；本片 receive 在正式提交前复用同一纯标准化及跨active docId去重/冲突检查。

模块导出 `initMaterialStore(path,scope)`、`receiveMaterials(path,configPath)`、`inspectMaterialStore(path)`、`recoverMaterialStoreLock(path)`。没有默认目录、扫描外部原件目录、网络、邮件或消息动作。CLI stdout 仅固定安全状态、计数及白名单错误；stderr 为空。路径、企业、金额、原文、历史和映射只在本机 store 或显式新output。output 用 `wx` 在变更前预留，已有文件/链接不覆盖；失败时预留文件可保留 blocked诊断，不作为有效报告。

## 跨批与显式更正

相同 sourceId、标准化版本、scope、来源实际字节hash及mapping 重试，跨进程重放同一个 durable receipt，不新增有效版本或重复接收回执。不同 sourceId 的相同票据/银行业务用既有标准化稳定 docId 检查；同业务同内容标duplicate，不按金额相等推断重复。同业务矛盾内容整体拒绝本次提交，旧active和历史均保留。

已接收sourceId改变日期、金额或mapping，一律 `source_version_conflict`，不能静默覆盖。显式更正时，在该来源对象额外**成对**加入：

```json
{"supersedes":"当前64位sourceVersion","expectedSourceVersion":"同一个当前64位sourceVersion"}
```

两字段都必须精确指向当前版本；CAS错误、缺一字段、未知source或过期版本拒绝。本次新内容通过标准化和跨active冲突检查才追加新commit。历史原字节、mapping、路径、前版本及回执永久保留，active/report仅当前版本；稳定票据docId使同票更正能由 #79 的旧计划比较选择性失效。更正重试可沿用该更正的前版本字段，仍重放已持久回执。更正不自动代表原票红冲或会计更正。

v1的同版本来源路径固定：同 sourceId/bytes/mapping 搬到另一originPath会报 `source_origin_conflict`，没有显式重定位事件；不要为搬迁修改业务或无意义mapping。原路径内容不同也必须显式更正。路径所有既存组件拒绝符号链接/junction，文件拒绝硬链，来源/配置不能位于store内部；不接管未知文件或自动清理损坏/未知目录。

## 提交、故障与重开

store 内 `store.json` 保存范围及本机storeId。连续 `000001-<manifest字节SHA256>` 目录是已提交journal；每目录包含严格manifest与实际原字节blob。manifest含前一提交摘要、标准化版本、sourceVersion、原路径/配置路径、mapping、scope、blobhash和supersedes。目录名SHA256是receiptId，能重复计算，**不是签名或认证**。report中的location/raw由每次标准化重算，不把保存的派生状态当可信输入。

接收用本store专属 `lock.json` 的 `wx` 排他，写完整pending目录及各文件fsync后，以新序号目录rename作为唯一active提交点。更正CAS在锁内重验。最多1000个commit；不覆写旧manifest、blob或active指针。提交前失败可能留下pending孤儿，重开检查但不计有效接收，不自动清理。提交后输出失败/响应丢失时结果未知，应先inspect核实durable receipt，再重试；inspect即使有遗留锁仍可核实完整提交。正常receive返回writerBlocked=false，释放自身锁失败则操作不能返回成功。

这保证本机进程中断时整批提交或无active变化，**没有宣称Windows断电/硬件故障持久性或 #83 通用恢复框架**。介质错误、目录损坏、断链、内部任意历史blobhash不符均整体failclosed；不跳过坏commit继续接收。未知文件保持现场并阻断。

重开逐份读取manifest和**全部历史**blob实际字节，重新检查hash、链、scope、字段及标准化版本/sourceVersion，再用active实际字节重算 `preflightMaterials`。外部active origin逐源重新读取并比hash：被替换、缺失或链接失效为 `blocked_origin_changed`，保留已核receipts/history/active诊断及staleSourceIds，**只有仍有效来源进入reports**。一个发票origin失效不抹去独立银行报告；全部失效时reports为空。失效源不能悄悄读取新字节充当旧receipt证据。

无关旧origin失效不妨碍正式补收独立合法来源；返回 `status:blocked_origin_changed`、真实 `receiveStatus:received/replayed` 和 `receiptIds`，stdout固定blocked、退出4。新回执确已保存，不应因非零退出盲目重复接收；先inspect核对。冲突仍跨全部active内部规范业务检查，不能用新增sourceId规避旧同业务的更正链。

recover-lock 是**显式、本store范围**的小恢复入口：先用独立 `recovery.guard` 排他；普通writer建锁前后都检查guard，防止两个恢复者误删后来活锁。仅严格本store锁、操作系统 `process.kill(pid,0)` 明确ESRCH证明PID不存在、字节仍相同才删除旧锁。PID复用、活PID、EPERM、不确定/未知锁均blocked。guard持有者中断留下guard则保守blocked，本片不递归恢复guard、不按年龄删锁。inspect仍可读已提交事实并标writerBlocked，不能据此授权继续写。

## #79 与未完成范围

模块返回的 `reports` 数组可直接传 `planOffline({scope,reports,declaration,previousPlan})`。它从原字节重算，保留缺材料/重复/未知/冲突，声明及实际事实的完整度仍由 #79 判断。CLI output 是接收信封，接旧规划CLI时须把其有效reports各自保存为本机报告引用；不可把整个信封当旧report。原文件后来变化须重新inspect，旧导出JSON没有持续有效性或执行权。

#77会计审定黄金、#78 XLSX/其他矩阵与路径重定位、#79正式执行回执、#80正式写账/连续核算仍未完成；#54 coordinator在另一窗口在途。本片接收成功不等于资料齐全、可以过账或整期完成，税局真实接入0。

验证入口：`node test/offline-material-store.test.mjs`（仅合成实际CSV/JSON、真实child/IPC故障窗口、实际链接/重启/并发）；相关 `node test/offline-materials.test.mjs`、`node test/offline-plan.test.mjs`。不改 package/test-all 或旧断言。自测真实结果及沙箱限制记录于 [交接](handoffs/OFFLINE-CLOSELOOP.md)，不能用本说明替代root/fresh验收。
