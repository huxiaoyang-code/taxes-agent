# 税局数据与往期文件下载探索

更新：2026-10-21（北京时间；2026-10-20 起始探索历史保留）。负责人：`huxiaoyang-code`。Refs #20 / #13 / #14 / #17。配套[任务](tasks/TAX-DOWNLOAD-EXPLORATION.md)、[交接](handoffs/TAX-DOWNLOAD-EXPLORATION.md)。

## 目标与当前结论

本期探索登录后税局数据链路、必要往期资料下载与本机分析，沉淀可复用命令 / 接口；**不生成下一期账套，不要求月份，不执行账务操作。** 按「实际入口 → 列表正文 → 详情 / 表单 → 官网原件 → 私有持久化」推进，不以完整企业档案或规则引擎为前置。下载发票不等于完整账套，历史财报不等于全量凭证。

**该财报接口返回一份 57 字节认证错误；用户确认手动刷新后浏览器仍登录，现按用户要求暂停财报分支，不等待重登、不再财报重试。** 财报业务列表成功 0、新财报 MCP 独立 replay 0、官网文件下载成功 0。优先发票、历史申报、税种认定，财报不是其他取数前置；不因此推导企业财报适用规则。当前新发现均 `quarantined_unverified / enterpriseBinding=false / consumable=false`，不算完整 M2 或解除 preparation / downstreamReady 阻断。真实摘要由 root 提供，实施不读取私有材料。

最新门户重建实际 fresh 3 / 完成、企业匹配，登录有效；发票入口、私有脚本快照及被动 observer 均已实测。**两个 120 秒 / 180 秒 armed 窗的事件、metadata、body 均 0，现已全部停止。** 用户尚未确认是否查询或页面结果，root 已询问，不能推断用户未操作 / 官网无数据 / 登录失效；当前没有监听，不能让用户直接查询期待被捕获。本轮完成的是查询 / 下载探索支撑，真实发票 query → 原件下载 → 后端 MCP 独立复采仍未证实。

## 证据阶段与接口目录

`static_candidate` 为源码语法线索；`observed_request_metadata` 为真实请求方法 / 技术名 / 键 / HTTP status 已私有留证；`observed` 还需有效作用域下的业务响应；`replayed` 需独立 fresh 后端请求。HTTP 200、导航 ACK、脚本快照都不能代替业务成功或文件完整性。

| 资源 | 方法 / 技术路径 / 参数键 | 来源、前置与依赖 | 覆盖、失败与实际重放 |
|---|---|---|---|
| 历史申报固定查询 | POST `/szc/szzh/sjswszzh/zhcx/v1/DescribeSbmxcx2`；body 九键 `gzlx / pageNum / pageSize / sbrqq / sbrqz / skssqq / skssqz / zfbz / yzpzzlDm` | [PR #38](https://github.com/huxiaoyang-code/youshu-fork/pull/38)，[PR #39](https://github.com/huxiaoyang-code/youshu-fork/pull/39) 交接；值来自已核私有模板，fresh 前后身份和有效 context 守卫 | 两轮各 1 业务 + 2 身份，performed / complete 各 3、unknown 0，各 6 行 / 2 期间、固定单页闭合且比较一致；不证明全历史 / 详情 / 更正版本 / 文件。旧 context 失效或退役不复用 |
| 财报 `getCwbbzlList` | GET、HTTP 200；query 唯一键 `_`；完整 prefix 只在本机不透明模板 | `observed_request_metadata`；来自正常财务 menu 跳转的实际自动请求，原 URL / 参数值只在可信层 | 正文 0，businesssuccess / schema / 企业绑定 / 覆盖未知；新财报独立 replay 0、下载 0 |
| 财报 `queryZlbscjb`（已暂停） | POST、HTTP 200；body 恰七键 `Lrrqq / Lrrqz / ZlbsxlDm / Skssqq / Skssqz / PageNum / PageSize`，query 唯一键 `_`；prefix 仅本机模板 | `observed_request_metadata / schemaOnly=true`；键来自实际 POST 顶层 Object.keys，值仅私有原请求。后续保存 57B 接口认证错误响应 | 两字段、无数组；错误文本投影 `authExpiry / authIndicator=true`，permission / queryCondition / success / rowsContainer false，不证明浏览器全局登录失效。用户确认仍登录、要求跳过；业务列表成功 / replay 均 0。不猜日期 / 分页 / timestamp / nonce 语义 |
| 同次身份相关请求 | GET `DescribeNsrjbxx` / GET `getUserInfo`，均 HTTP 200 | 仅实际自动请求 metadata，不替代 helper 前身份核验 | 正文 0，不证明返回当前企业字段；独立 replay 0 |
| 详情静态路径 | `/zhcx/cwbbxxcxxq`，`static_candidate` | exact `this.$router.resolve`、直接 path literal 通过守卫；query 实际 AST 节点为 `CallExpression`，非直接对象，`queryKeys=[] / querySchemaComplete=false / navigationTemplateAuthorized=false`；新增 queryFieldSchema 也 fields 空 / complete false | 动态构造调用依赖待解析或实际详情导航观察；不能推断存在 token 键。未执行 resolve / window.open，不构成导航模板或已核详情 HTTP API |
| 其他静态财报线索 | `cwbbsbxxcx / cwbbxxcxDetail / sbbdxz`，仅 `static_candidate` | 本机加载代码候选，详情 / 打印 / 下载消费者链仍需真实响应关联 | 不升级为 observed、replayed 或文件成功 |
| 发票入口与自动请求 | 精确 menu“全量发票查询”实际正常导航 ACK；新 15 条主 frame metadata 只有 scripts、重复 POST `getPublicKey` 与 GET `getNewEtaxFlag` HTTP 200 | fresh 门户 source / 前身份 1 complete、unknown 0 后按实际原 URL 跳转；95 事件 / auth 8 / external 61 / redirect 3 / subframe 0，body / scripts 0；scope_changed、artifact 私有保存、cleanup true / 无锁 | 不是发票列表 query，不证明开票能力；`getPublicKey` 属认证线索，不独立重放。业务 query / 发票下载尚无成功，当前发票 document 不借旧门户 source 授权消费 |

完整 prefix 外发投影与 REA `include_script_sources:true` 均被自动审批拒绝，**未执行、不重试该目的地**。原 URL / 源码 / 参数值只在 ACL 本机文件与不透明模板中；不通过 Git / 模型输出补全路径。

每个新增目录项仍需登记：方法 / 路径、参数键及本机来源；登录 / 企业 / 文档前置；列表 → 详情 → 文件依赖；只读语义；分页 / 覆盖窗口；业务成功条件 / schema / 类型 / 字节与完整性；业务与身份各自 attempted / performed / complete / unknown / fresh 轮次；失败分类、锁 / 会话恢复和独立重放次数。未知如实保留，不猜标识或参数值，不把技术失败转成企业补交。

## 实际探索与验证快照

| 操作 | 已核结果 | 限制 |
|---|---|---|
| 正常财务入口导航 | 前身份 performed 1 / complete 1 / unknown 0；Page.navigate ACK、scope_changed；97 事件、11 条主 frame metadata，正文 / 脚本 0；own unknown false、cleanup true、无锁 | 原门户 source 随文档变化失配，没有财报企业绑定，不自动重 bootstrap |
| 本机脚本快照 | `live_observed_private_snapshot_partial`；eligible 4 / captured 3 / budgetSkipped 1、truncated true、1,326,340 字节仅 ACL 私有保存；scopeStable / cleanup true、无锁 | 不完整 source；helper HTTP 0 / Runtime eval false / 无导航不证明网页后台静默；原 JS 不进 REA / 模型 |
| 本机纯 AST 投影 | 业务组件 6,016 字节 / 5,790 字符，旧 5,789 是 AST end；唯一最大对象 5 键 / 交集 5 / exact case 0。最新 shape 经独审 / root 25 项后实际 queryFieldSchema fields 空 / complete false，query 节点确为 CallExpression | body 不全绑定，query 是动态调用依赖；不再扩词表猜构造。parameter_property 仅函数参数成员语法关联，非完整运行时数据流或企业行映射 |
| 财报被动观察历史步骤 | 较早 Page.navigate ACK 但 same-document / no-op，新增请求 / 正文 0、seal 失败、cleanup true / 无锁 / ownUnknown false | 当时零新增不作为登录失效证据；已由下行独立 reload 实测替代当前进展 |
| 最新固定 Page.reload 实测 | 准确字节独审 / root 42 项后一次 `Page.reload({})`：`financial_passive_quarantined`；request 28 / main 1 / redirect 4 / matched 2 / bodyReads 1 / bodySaved 1、57B，无 unavailable / discard；scopeSealed / cleanup true、无锁 / ownUnknown false | 接口认证错误，bodySaved 1 不等于列表成功；用户确认浏览器仍登录并暂停此分支，不再财报重试，不当其他取数前置 |
| 最新 opt-in 门户重建 | C81 经独审 / root **63 / 63** 后真实 openPortal sourceCreated / runCreated，attempted / settled / performed / complete 各 3、unknown false / 企业匹配 true；main 1 / clear 2 / within 0、cleanup true / 无锁 | 正常固定门户导航与 fresh 3 证明当前登录有效；没有恢复旧 history context，也不把源身份绑定扩大到跨域发票发现 |
| 发票脚本快照与离线分析 | 较早快照 4 / 5 份、2,818,411B；刷新当前文档快照后最新 captured 7 / eligible 9、4,034,109B、scriptEvents 44 / rejected 35 / budgetSkipped 2，scope / cleanup true / 无锁。A16D 最新本机离线 7 sources + 38 focused functions、parse failure 0 | 均为部分资产，原 JS 仅 ACL；旧分析部分 AST limit，不能据静态集合推完整调用链或发票业务成功 |
| observer 前置失败与重建 | 已独审 / root 37 项通过。先两次未 armed，第一次无诊断；第二次固定 guard 投影 TargetURLmatchesSnapshot false、FrameTree 未读；均零业务、cleanup true / 无锁。随后重建上述当前 snapshot | 不能把前置 scope 拒绝当用户没查询、无数据或登录失效，不复用失配快照 |
| observer 两个真实窗 | 120 秒和 180 秒均 armed、scopeStable / 全部 scope 布尔 true；事件 / metadata / bodies 全 0，cleanup true / 无锁。窗口现已全停 | 用户 manual state 回复 pending；未证明发生有效 query，也不能证明未操作 / 无数据 / 失效。不追加主动请求或认证链重放 |
| 验证入口 | 上一版本 40 / 40 全量通过。41 组首跑 40 组通过，旧 tax-browser-session-mcp 的 lost-response 模拟子 Node 异常退出 3221226505；未改实现或测试，定向重跑 4 / 4 通过。root 随后全 41 组重试 exit 0、41 / 41 全部通过 | 不删测试 / 不据一次子进程退出猜根因；observer 37 / bootstrap 63 的独审与 root 合成不代替全量最终结果或发票业务成功 |

## 本机管理员页面探索命令

以下在 `06-workbench` 运行，尖括号只为占位；真实引用由 root 本机替换，不入 Git。财报示例只保留契约，当前暂停；发票 observer 已独审 / 实测，但窗口现已关闭，不能直接复用旧监听。均为本机管理员窄入口，不注册 HTTP / MCP，不接受任意 URL、body、profile 或凭据。

| 命令 | 前置与实际状态 |
|---|---|
| [explore-tax-download-page.mjs](../06-workbench/scripts/explore-tax-download-page.mjs) | 有效登录、quarantined 注册、fresh source / 企业前身份、完整门户文档与 loader；隔离读已知 menu key、精确查询标签、两读同原 URL。已实测财务跳转留 metadata；旧门户 source 不可续用。未知 TTL 仅普通导航线索、不授业务 API 权限 |
| [snapshot-tax-download-page.mjs](../06-workbench/scripts/snapshot-tax-download-page.mjs) | 已审导航 artifact、当前注册 / 浏览器 / target / 完整文档守卫；只读 V8 已加载脚本，原 JS 直接 ACL 私有保存。已实测部分快照，不继承旧 source 企业消费授权 |
| [observe-tax-financial-page.mjs](../06-workbench/scripts/observe-tax-financial-page.mjs) | 财报分支现已按用户要求暂停，不运行此命令。保留窄接口：同链 snapshot + navigation artifact、当前财报文档、两个实际 endpoint 私有模板；内部固定 `Page.reload({})`，不接 URL。将来用户明确继续时须重新核当前 source / snapshot 作用域，不复用旧 refs |
| [observe-tax-invoice-page.mjs](../06-workbench/scripts/observe-tax-invoice-page.mjs) | 已独审 / root 37 项 / 两个实际窗；同链 invoice snapshot + navigation artifact，当前 Target URL / frame / loader 必须与快照一致，变更先重建快照。CLI 固定 120 秒，先确认 invoice_observer_armed，再在活跃窗内安排用户人工查询；现有窗口已全停。仅监听，不 Runtime / 导航 / 主动 API / click；raw JSON 仅 ACL、输出计数 / 不透明引用，零事件不判数据为空 |

```powershell
node scripts/explore-tax-download-page.mjs --help
node scripts/explore-tax-download-page.mjs --source-ref "<LOCAL_SOURCE_REF>" --target financial_report
node scripts/explore-tax-download-page.mjs --source-ref "<LOCAL_SOURCE_REF>" --target invoice
node scripts/snapshot-tax-download-page.mjs --artifact-ref "<LOCAL_PAGE_ARTIFACT_REF>"
node scripts/observe-tax-financial-page.mjs --snapshot-ref "<LOCAL_SNAPSHOT_REF>" --navigation-artifact-ref "<LOCAL_NAVIGATION_ARTIFACT_REF>"
node scripts/observe-tax-invoice-page.mjs --snapshot-ref "<LOCAL_INVOICE_SNAPSHOT_REF>" --navigation-artifact-ref "<LOCAL_INVOICE_NAVIGATION_ARTIFACT_REF>"
```

页面 CLI help / 非法参数退出 0 / 2，执行失败 1；探索结果退出 0 只说明命令结束。snapshot / passive / observer 仅对应 quarantine 状态退出 0，其余 1；armed 只证明监听已准备、不是查询成功，退出 0 也不证明业务成功。输出仅固定状态 / 计数 / 布尔及不透明引用，`safeAssetRefs=[]`。纯静态 shape 是本机语法分析函数，不是下载命令，不执行 JS / handler；requestAuthorized / readOnlyVerified / enterpriseBinding / consumable 均 false。

早期后备 bootstrap 39 项 / not_live_run 仍为历史版本事实；最新 [bootstrap CLI](../06-workbench/scripts/bootstrap-tax-portal-source.mjs) 增加显式 `--open-portal`，63 项独审 / root 合成后本次已真实固定门户正常导航并完成 fresh 3 / source + run 创建。必须 root 核当前注册、确认 reader 停止后显式执行，不能任意导航、自动重复或恢复旧 context：

```powershell
node scripts/bootstrap-tax-portal-source.mjs --registration-ref "<LOCAL_REGISTRATION_REF>" --registration-root "<LOCAL_REGISTRATION_ROOT>" --page-ref "<LOCAL_PAGE_REF>"
node scripts/bootstrap-tax-portal-source.mjs --registration-ref "<LOCAL_REGISTRATION_REF>" --registration-root "<LOCAL_REGISTRATION_ROOT>" --page-ref "<LOCAL_PAGE_REF>" --bootstrap-and-persist --confirm-reader-stopped
node scripts/bootstrap-tax-portal-source.mjs --registration-ref "<LOCAL_REGISTRATION_REF>" --registration-root "<LOCAL_REGISTRATION_ROOT>" --page-ref "<LOCAL_PAGE_REF>" --bootstrap-and-persist --confirm-reader-stopped --open-portal
```

## 恢复与下一阶段

原导航锁已 operator-attested 严格退役，旧 parent / context / template / runs 永久禁止消费；requestTermination 仍 unknown / realmDestructionProven false / lateSessionEffectsPossible true。settled / not-performed 0 是 root 联合推断，非原输出或 loaded-code-bytes 证明。latest-scope 守卫已修正；root 旧四进程存活、旧 19 文件保留，不记 PID / 私有引用，不据此复用旧 scope。详见[交接](handoffs/TAX-DOWNLOAD-EXPLORATION.md)。

财报继续按用户要求暂停，不推适用规则；优先发票 / 历史申报 / 税种认定。当前 observer 窗口已全停，root 已问用户是否未点、已有结果或空 / 错误，尚无回复；不替用户作答。收到 manual state 后，先核当前文档 / 快照、按需重建匹配作用域，再 armed 新窗，才安排窗内人工查询，不自动点击或重放认证链，不恢复旧 history context。

本轮仅完成查询 / 下载探索支撑候审，root 全 41 组重试已 exit 0、41 / 41 通过；本轮支撑文档冻结候审，尚无新 PR。等待用户答复期间可提交、审核合并支撑 PR，总专项目标继续，不声称下载链完成。内部待办为：捕获真实发票 query 与响应、核详情 / 官网原件与完整保存、后端 MCP 独立 fresh 复采。技术缺口不转企业补资料；业务下载 / 新 MCP query repeat 均 0，不关闭 / 重启，不扩会计实现。
