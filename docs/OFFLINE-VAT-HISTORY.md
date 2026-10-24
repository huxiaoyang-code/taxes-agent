# OFFLINE-04C：显式 Q1 历史上下文

Refs #76 / #81。此模块只重新核验已有 Q1 非零选定 VAT 行；不是完整 Q2 引擎，不是申报、写账或会计批准能力。既有 VAT v1、规则表、加载器、账务快照和 review 管线均未修改。

## 输入与能力边界

```js
import {
  openOfflineVatPriorContext,
  assertOfflineVatPriorContextCurrent,
  closeOfflineVatPriorContext,
} from '../server/offline-vat-history-context.mjs';

const opened = await openOfflineVatPriorContext({
  version: 'offline-vat-prior-request/1',
  priorInputPath: '/explicit/local/prior-vat-input.json',
});
try {
  if (opened.receipt) {
    const diagnostic = await assertOfflineVatPriorContextCurrent(opened.receipt);
    // diagnostic.status must still be prior_q1_recomputed at this observation.
  }
} finally {
  if (opened.receipt) await closeOfflineVatPriorContext(opened.receipt);
}
```

请求必须是恰好含 version/priorInputPath 两个 enumerable data descriptors 的 plain data。首次读值前以 top-level isProxy、Reflect.ownKeys 和 descriptors 拒绝 Proxy、accessor、null、额外字段（包括 non-enumerable/symbol）及非字符串 version/path；非法 path/version 为 Proxy 时也不递归触碰它，getter/trap计数须为0。API 的相对路径以 process.cwd() 解析。配置复用真实 `offline-vat-input/1`：显式 DB、材料文件配置或材料 receipt store、声明、原始业务会计事实和税务事实，详见 [VAT v1](OFFLINE-VAT.md)。不接受 rawInput/source/session/snapshot/calculation/ready/history/targetDb/targetScope，也不接受以公开 digest 或旧计算结果代替实际文件。

每个 open 都启动固定脚本 offline-vat-history-worker.mjs 的全新 Node 进程；父 facade 不执行税算，父进程预先缓存的 tax-calculation 模块不能参与计算。worker 内部自行调用 openVatInputFiles，并在 calculateOfflineVat 前后调用真正的 assertVatInputSessionCurrent(session, rawInput, source, snapshot)。因此校验的是注册过的内部 session；不能通过未注册 rawInput 的空检查、可替换 facade 或上传 ready 取得 receipt。仅 v1 calculationReady=true、文件/材料 store/实际只读账套均 current，且企业实际设立日期在 2026 年 1 月，worker 才保留内部 session，父进程才铸造 WeakMap receipt。既有账套须从 2026-01 启用，工程仍限 2026-Q1。

低于门槛、零销项、非零期初、prior_required、Q2、旧企业、跨企业/错账套/错期、未过账、来源指纹不符、未知或缺件等，沿 v1 返回 blocked/unsupported 或固定拒绝代码，receipt=null，并关闭只读源。后设企业限制比 v1 更窄；此桥只支持 2026 年 1 月新设。未计算金额保持 null，不能补零。

## 重验与失效

receipt 是冻结的空对象，唯一 authority 是父进程 WeakMap 中的私有 worker 通道；实际 session 和 DB 仅在该 worker 内。复制、JSON roundtrip、另一进程、伪造对象均得到 prior_receipt_untrusted。公开 diagnostic 是副本，金额、文件清单、代码摘要、flags 的修改都不能影响私有状态。

每次 consume 通过固定私有 IPC 命令在原 worker 内重新验证实际文件/材料 receipt store、实际 DB 私有文件身份和快照，再从原始输入重新执行 VAT v1，前后检查代码字节，并比较原始内部结果摘要；不是一次缓存计算。同 receipt 命令串行；close 可取消在途消费，异步等待实际 worker exit。诊断包含完整 v1 computation、材料/配置来源 hash 清单和 31 文件代码清单；v1 的 cells、calculationNodes、规则定位、原票/税事实 pointer/hash、实际 voucherId/entryId、source association/batch/fingerprint 链可追溯。

观察到资料、账或代码 stale 后，该 receipt 在本进程永久失效并关闭；恢复旧字节不能复用，必须重新 open。close 后同样拒绝。此机制不声明能发现从未观察到的 ABA 瞬时变化，也不持续监控磁盘。截止 Q1 外的独立 Q2 凭证不进入 Q1 逻辑快照。

代码 guard 直接复用冻结 REVIEW_CODE_FILES 的原 28 个文件，再加 context/guard/worker 三个实际模块，共 31 个；模块加载时固定每文件字节 SHA 与整体摘要。父进程 spawn 前的实际清单、全新 worker 的加载/开算清单，以及父 spawn 后的实际清单必须完全一致；consume 前后父子也重验。这样先缓存旧税算函数、后来修改磁盘、再首次加载 history/guard 时，不会拿新 SHA 绑定父进程旧函数的执行结果；worker 实际执行新字节，异常则明确拒绝。已加载 guard 后发生变化则 prior_code_restart_required；父发现 manifest 不一致或收到 worker 的该错误时，均调用只可闭锁的 markOfflineVatHistoryCodeRestartRequired，让父 guard 永久 latch。即使字节在父处理前已恢复，观察过的不一致也不能清锁或再 mint，须新进程。此观察到的 ABA 与未观察的瞬时变化不同。没有修改旧 feedback 清单或接入旧 review 确认链。

worker 使用固定 Node 可执行文件与脚本参数，移除 NODE_OPTIONS/NODE_PATH/WORKBENCH_DATA_DIR 环境继承，不读取默认账套；stdout/stderr 丢弃，只有私有 IPC 传本机诊断。启动与命令各有固定30秒超时。错误、退出、超时都会永久作废原 receipt，不静默重建或复用确认。关闭先请求 worker 关闭源，500毫秒未退出则 SIGTERM，再500毫秒仍未退出则 SIGKILL，等待实际退出。父断开 IPC 时 worker 关闭源并退出；源码句法错误、spawn ENOENT 等同样不能挂起或留 ready。此 worker 是本地 Node 运行时，不是外部模型执行器。

顶层 code 为成功时的 null 或错误的固定白名单：prior_request_invalid、prior_input_rejected、prior_context_stale、prior_receipt_untrusted、prior_receipt_closed、prior_code_restart_required、prior_calculation_blocked、prior_calculation_unsupported、prior_january_establishment_required、prior_worker_unavailable、prior_worker_timeout。31 文件清单另置 codeBinding，不能覆盖错误 code。被捕获的任意异常 message、路径、原始材料不进入 CLI stdout/stderr。

## 尚未具备的能力

每份诊断开头的 limitations 都先列 prior_Q1_only、no_target_database_binding、no_Q2_tax_calculation、no_reusable_accountant_confirmation。targetBinding=not_verified、q2CalculationReady=false、accountantApproval=pending、periodComplete/submittable/authorizesExecution=false、sourceAuthenticity=unverified。

公开 snapshot 没有 fd/file identity。两个公开摘要、企业/账套/profile/路径相同，不能证明同一实际目标 DB。因此本片完全不收 Q2 targetDb/targetScope，不声称已将 Q1 receipt 绑定 Q2 目标库。完整 Q2 后续需要同一内部 source 捕获目标 snapshot，或另审私有身份 API；#82 尚未接入本片，不能承诺未接线的 Q2 会计确认自动失效。会计姓名和依据只是本地陈述，不认证真实身份或材料真实性。

## CLI

在 `06-workbench`：

```powershell
node scripts/offline-vat-history.mjs --input D:\explicit\prior-request.json --output D:\explicit\new-diagnostic.json
```

请求文件使用同一严格结构，priorInputPath 相对请求文件所在目录解析；配置内部路径沿加载器相对配置解析。CLI 实读请求文件并复用 readLocalFile 的有界/链接限制。输出只序列化诊断，publicationStatus=diagnostic_only，不含 receipt 或可序列化 authority；材料原值/路径只可能出现在显式本机诊断文件中。

wx 创建全新输出，不覆盖来源、配置、已有文件或已有链接。写入/sync 后、关闭输出 handle 前再核实际请求字节和内部 receipt；发布窗观察到变化则固定 exit4，已创建文件改为 publicationStatus=failed、authorizesExecution=false。若介质错误使失败诊断也不能完整写入，可能留下不可解析的 partial 文件，不能当成功 marker。没有 journal、DB/defaultdir 写入；finally await 关闭 receipt 并等待实际 worker 退出。

| CLI 退出码 | 含义 |
| --- | --- |
| 0 | 已写入 prior_q1_recomputed 的本机诊断；仍无 Q2/执行/提交权限 |
| 2 | 固定参数用法错误 |
| 3 | 已写入 blocked/unsupported/restart_required 诊断，无 receipt |
| 4 | 请求/IO/已有输出/发布窗等拒绝，固定 OFFLINE_VAT_HISTORY_REJECTED |

成功 stdout 仅固定 status/issue count；stderr 不含原始异常。诊断文件中的 blocked 状态不能因为“文件已生成”被解释成 ready。

## 合成验证与恢复

`node test/offline-vat-history-context.test.mjs`：最终 **28/28 exit0**，含真实hardlink检查、skip0及所有child实际close。原始 blueprint 独立使用 173211.00+238456.00=411667.00，真实候选交现有 importIncremental 过账后，以实际只读 DB 验 15=12350.01、16=8233.34、22=4116.67。literal 期望仅在断言，不作为产品输入。helper 在导入核心前隔离 WORKBENCH_DATA_DIR/TEMP/TMP，以子进程创建实际 DB，避免全局 DB 缓存串例；所有 child 返回并实际 close。

覆盖 strict accessor/Proxy、receipt 伪造/复制/跨进程/async close/公开副本修改、原件缺失/变化/恢复、真实 store origin/sourceVersion CAS、false/null/unknown、历史与错 scope、核心实际反过账、分录/来源指纹变化、截止外 Q2 实际凭证、主库与 warm WAL 字节不变、CLI actual child/wx/实际 hardlink、source/request 在写后变化、复制源码树中的缓存代码变化和新进程恢复。新增父先缓存旧tax→磁盘注入throw→冷首次history导入、fork时真实代码变化、parallel消费和在途close、worker实际SIGKILL、真实spawn ENOENT、实际挂起worker超时及parent disconnect释放源。实施超时回归仅在父测试进程加速固定30秒timer，不改产品timer/env；fresh另实际生产30秒约30522毫秒实测prior_worker_timeout、SIGTERM退出与DB释放，不能用加速测试冒充真实时长。热代码测试只复制必要源码闭包到忽略临时树，不复制真实 data/配置/node_modules，不改工作区产品文件。

Windows 当前持有 DB 时 rename 返回 EPERM；测试如实报告 OS 阻止替换，没有声称替换检测分支已执行。失败 open 后的源释放由实际 rename 成功验证。只读检查保证 DB 逻辑无写及 warm main/WAL 字节不变；冷只读 SQLite 可能创建零字节 WAL，不夸大为绝无文件侧效。

首轮 13/15，store 测试误用了不存在的 journalHead 参数、Windows 沙箱拒 symlink；第二轮 15/16 仅沙箱拒 hardlink。保留失败夹具，改为真实 sourceVersion/supersedes CAS，最终经允许创建本目录链接的测试命令实跑 hardlink，未 skip。root 独立发现首稿 write/sync 期间原件变化仍产出旧 computed 诊断，已加最后发布校验及 source/request 两种实际注入回归；旧失败证据未改。此前18/18覆盖仍遗漏non-enumerable额外字段，以及递归非法path/version Proxy导致trap执行；root/fresh实际复现后，新增先读ownKeys/descriptors的严格边界与独立第19项回归，修后19/19。自查同时把代码清单移到codeBinding，防止覆盖固定错误code；旧通过不作为修后接受。

旧19项仍漏 late-cache P2：fresh 在复制树先 import 原tax，再将磁盘 calculateOfflineVat 改为throw，最后首次加载history/guard，旧同进程版本仍mint并以新SHA绑定旧4071.91结果。旧19/19及早期接受均不能证明此边界，现以每context全新worker实际执行字节修复，不缩小承诺。worker首稿26/26仍漏观察ABA：spawn后改tax、worker ready报告新manifest、父处理前恢复bytes，第一次拒绝而第二次能mint。已补父guard永久latch及两项真实fork/worker观察后恢复、同父再开拒绝、新进程恢复对照。root/fresh原失败probe保留；新增31闭包与9项运行时回归，不改旧28模块。

当前基线已由root fast-forward到 `f74460f30699c2740b2163743050b78845979885`，即PR101仅13共享docs的merge；#54业务已在PR100 merge `e13cc43d9f95ee78599b288486ff5721b01f00e2` 实际合入。root在e13新audit基线实际旧VAT22/golden15/ledger27均exit0，f744核心字节相同；旧基线review15也已通过，未把它冒充新基线重跑结果。root新audit独立557983→16739.49/11159.66/5579.83、31code、严格边界与写后publication失败已报通过，仍待最终完整head独审。

回退需先await close所有已打开receipt，停止调用新 API/CLI，再按正式 revert PR 移除本片文件；没有迁移或需要撤销的账务写入。#81 整包、#76、两合法连续税期及会计生产验收均未完成。
