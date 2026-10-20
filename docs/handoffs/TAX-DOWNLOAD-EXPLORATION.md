# TAX-DOWNLOAD-EXPLORATION · 恢复与交接

更新：2026-10-21（北京时间，2026-10-20 起始探索历史保留）。负责人：`huxiaoyang-code`。Refs #20 / #13 / #14 / #17。先读[章程](../PROJECT-CHARTER.md)、[STATE](STATE.md)、[主文档 / 命令](../TAX-DOWNLOAD-EXPLORATION.md)、[任务](../tasks/TAX-DOWNLOAD-EXPLORATION.md)、[历史查询交接](TAX-HISTORY-COLLECTION.md)。

## 当前目标与恢复事实

只探索税局数据、往期资料与本机分析及复用命令，不建账、不问月份。root 独占真实会话与 Git，实施只用安全源码 / 合成 / 安全摘要。**财报接口返回 57B 认证错误，用户确认手动刷新后浏览器仍登录，现按要求暂停财报，不等待重登、不再本分支重试。** 列表成功 0 / 下载 0 / 新财报 replay 0，全部新发现隔离不可消费；优先发票 / 历史申报 / 税种认定，财报不当前置，不推导财报适用企业规则。

新门户 fresh 3 / 企业匹配已实测；已进发票入口，15 条 metadata 只有脚本 / 认证相关请求，未识别发票列表 query。最新 7 份当前脚本仅本机；observer 已独审 + root 37 项，120 秒 / 180 秒两个真实窗均 armed / scopeStable / 全 scope 布尔 true，但事件 / metadata / bodies 0，cleanup true / 无锁，现已全停。用户最新确认已手动点击查询但没有结果，空结果或报错未区分；不推点击发生在这两个窗内，不确认官网无数据 / 接口坏 / 登录失效。用户计划明天问老会计，今天停止探索，仅收尾交接 PR，不请求 / 重开窗。支撑包可先候审，不代表业务链完成。

| 恢复对象 | 已核事实 | 约束 |
|---|---|---|
| 原导航锁 | 原运行身份 performed 2 / complete 2 / unknown 0、匹配、导航 confirmed 1，cleanup 不明保锁；准确字节独审 / 独立 54 项合成后一次 operator-attested 严格退役成功 | 旧 parent / context / template / runs 永久禁消费；requestTermination unknown / realmDestructionProven false / lateSessionEffectsPossible true。settled / not-performed 0 是 root 联合推断，非原输出或 loaded-code-bytes 证明，不推全部请求终止 |
| 浏览器 / source | 较早门户 source 在财务导航后失配；最新 C81 经独审 / root 63 项后显式 openPortal 正常导航新建 source / run，3 attempted / settled / performed / complete、unknown false / 企业匹配 true，main 1 / clear 2 / within 0、cleanup true / 无锁；旧四进程 / 19 文件保留 | 当前登录实测有效，不推旧 source 复活，不恢复旧 history context；新发票发现仍隔离，不自动重复 bootstrap / 关闭文档 |
| 菜单 | financial-filing-query 1 / all-invoice 1、invoice-query 0；精确发票目标“全量发票查询”。586 节点 / 14 类别命中仅线索 | expiry 非零非负 epoch-ms-like，getter / setter 未核；时钟比较不当失效事实。精确标签 + fresh 前身份 + 两读原 URL 仅普通导航，不授业务 API 权限、不证明完整账套 |

## 本轮实际进展

| 操作 | 安全结果与阶段 | 限制 / 下一步 |
|---|---|---|
| 财报普通导航 | 前身份 1 / 1 complete / unknown 0；Page.navigate ACK、scope_changed；97 事件 / 11 主 frame metadata 私有保存、正文 / 脚本 0；ownUnknown false、cleanup true、无锁 | 仅留证、未采企业财报；原门户 source 不可续用 |
| 实际接口 metadata | GET `getCwbbzlList` / POST `queryZlbscjb` HTTP 200；body actual 七键 `Lrrqq / Lrrqz / ZlbsxlDm / Skssqq / Skssqz / PageNum / PageSize`，两请求 query 唯一 `_`；GET `DescribeNsrjbxx` / `getUserInfo` 也 200 | `observed_request_metadata / schemaOnly=true`，该次无正文 / businesssuccess / 企业绑定；最新错误响应另列。不猜 timestamp / nonce / 日期筛选含义；prefix / 值仅本机不透明模板 |
| 本机脚本快照 | 准确字节独审 / 独立 38 项后真实 `live_observed_private_snapshot_partial`；scriptEvents 4 / eligible 4 / captured 3 / budgetSkipped 1、truncated true、1,326,340B 仅 ACL 私有保存，scopeStable / cleanup true、无锁，admin guard 无未确认 | 非完整 source；helper HTTP 0 / Runtime eval false / 无导航不证明后台静默，原 JS 不进 REA / 模型 |
| 实际纯 shape | 最新准确字节独审 / root 25 项后本机投影：组件 6,016B / 5,790 字符（旧 5,789 为 AST end）；唯一五键对象与实际七键交集五、不全绑定。静态 `/zhcx/cwbbxxcxxq`，queryKeys 空 / querySchemaComplete false / navtemplate false；queryFieldSchema fields 空 / complete false | 本机节点计数确认 query 为 CallExpression 而非直接对象，是动态构造依赖；不能推断 token 键或其他实际 query 字段。parameter_property 只语法非完整运行时 / 企业行映射，不再加词表猜依赖 |
| 较早被动导航 | Page.navigate ACK 但 same-document / no-op，新增请求 / 正文 0、seal 失败、cleanup true、无锁 / ownUnknown false | 这一历史零新增本身不证明登录失效；与下行最新错误响应分开 |
| 最新固定 reload | F831 经独审 / root 42 项后一次 Page.reload({})：financial_passive_quarantined；request 28 / main 1 / redirect 4 / matched 2 / bodyReads 1 / bodySaved 1、57B，无 unavailable / discard，scopeSealed / cleanup true、无锁 / ownUnknown false | queryZlbscjb 响应两字段、无数组；authExpiry / authIndicator true 只是本接口错误文本投影，其他业务 / rows 标志 false。用户确认浏览器仍登录，不能推全局失效；不出 code / 原文，bodySaved 1 非列表成功。分支已暂停 |
| 发票正常导航 | 2181 实际一次 nav ACK，前身份 1 complete / unknown 0；95 事件 / 15 主 frame metadata、auth 8 / external 61 / redirect 3 / subframe 0，body / scripts 0；scope_changed / artifact 私有保存、cleanup true / 无锁 | 只有 scripts、重复 POST getPublicKey 与 GET getNewEtaxFlag HTTP 200，未观察发票列表 query，不认开票能力 / 不重放认证链 |
| 发票当前快照 / 静态 | 较早 4 / 5 份、2,818,411B；重建当前文档后最新 captured 7 / eligible 9、4,034,109B，scriptEvents 44 / rejected 35 / budgetSkipped 2、scope / cleanup true / 无锁。A16D 最新本机 7 sources + 38 focused funcs、parse fail 0 | 部分资产 / 静态候选，不证明完整调用链；原 JS 只 ACL |
| observer 前置失败 | 两次未 armed；第一次无诊断，第二次 root 固定 guard 投影 TargetURLmatchesSnapshot false / FrameTree 未读，均零业务 / cleanup true / 无锁；随后重建当前 snapshot | 不复用失配快照，不推登录失效 / 数据空；不补猜第一次失败原因 |
| observer 两真实窗 | 准确字节独审 / root 37 项后，120 秒和 180 秒均 armed / scopeStable / 全 scope 布尔 true，事件 / metadata / bodies 0、cleanup true / 无锁，窗口全停 | 用户已查询但无结果，空或报错未区分；点击是否在窗内未知，零事件不变，不据此确认官网无数据 / 接口坏 / 登录失效。今天停止，不重开窗 |
| 验证入口 | 上一版本 40 / 40 通过。41 组首跑旧 tax-browser-session-mcp lost-response 模拟子 Node 退出 3221226505，其余 40 组过；无改动定向 4 / 4 通过，root 全 41 组重试 exit 0、41 / 41 通过 | 不删测试 / 改实现 / 预写通过，不据子进程退出猜根因。仅 static / contract-shape 用 `--expose-internals`；业务下载 / 新 query repeat 仍 0 |

REA 原脚本输出及完整 prefix 输出均自动审批拒绝，未执行、不重试该目的地。安全替代只在本机 ACL 文件离线 AST，再投影已审技术结构；不输出原 JS / 值 / prefix，不从脱敏 shape 拼 URL。原静态版本实测事实保留，不用新字节回填旧证据。

既有 history PR #38 / #39 仅固定单页，两轮各 3 fresh / performed / complete、unknown 0，各 6 行 / 2 期间，不计新财报 replay。`cwbbsbxxcx / cwbbxxcxDetail / sbbdxz` 及详情 / 打印 / 下载消费者链仍 static candidate，不当文件已下载。

## 复用与接续

page / snapshot / financial-passive / invoice-observer 前置及占位集中在[主文档](../TAX-DOWNLOAD-EXPLORATION.md#本机管理员页面探索命令)，refs 不入文档。财报暂停；bootstrap fresh 3 已实机，非旧 context 恢复。invoice observer 已审 / 实测，但当前窗口全停；后续必须重核 Target URL / frame / loader 对当前 snapshot，失配先重建，再确认 armed，才让用户窗内 query。纯 shape 不是下载命令。

1. 保留用户浏览器、旧四进程与旧 19 文件；旧链永久禁用不逆转，不手动清锁、不盲目重导航。
2. 用户已确认仍登录，财报暂停；不等待重登、不把此接口认证错误推全局登录失效或财报适用规则。当前优先发票 / 历史申报 / 税种认定。
3. 用户已手动点查询但无结果，空或报错未区分；今天停止，计划明天问老会计。两个窗均已停止，不再请求 / 重开。下次只在用户明确继续后，root 先核当前 scope / 匹配快照、确认 armed，再安排窗内人工 query。不得自动点击 / 主动 API / 导航 / Runtime，不重放 getPublicKey、不恢复旧 history context。
4. 原件校验类型 / 完整度 / 企业期间来源并私有持久化后才计下载。继续不建账、不问月份，技术失败不转企业补交。
5. root 最终全 41 组重试 exit 0、41 / 41 通过，本轮支撑交付冻结候审、[PR #40](https://github.com/huxiaoyang-code/youshu-fork/pull/40) 已创建、开放候审；代码已独审，用户今日停止事实的文档仍待最终 head 审查；按用户要求今天停止探索，仅收尾支撑 PR，[PR #40](https://github.com/huxiaoyang-code/youshu-fork/pull/40) 已创建、开放候审；代码已独审，用户今日停止事实的文档仍待最终 head 审查；总专项未完成，后续须用户明确继续。内部待办是真实 invoice query → 下载完整保存 → backend MCP 独立 fresh 复采，不能转企业补资料；不预写 PR / 合并 / 业务成功。

## 新会话提示词

> 2026-10-21当前支撑包候审，总专项未完。财报按用户暂停，57B仅接口认证错误，不推浏览器全局失效/适用企业规则。C81 fresh3全完成/企业匹配、source+run创建，无锁；2181 invoice navACK有15条脚本/认证metadata，无已识别列表query，不重放getPublicKey。最新1026当前snapshot7/eligible9、4034109B、44events/35reject/2budgetskip、scope/cleanuptrue无锁；A16D离线7sources+38focused/parsefail0。observer3454已独审/root37过；两次未armed后重建当前snapshot，再120s+180s窗均armed/scopeStable/全scopebooltrue，事件metadata/bodies0、cleanuptrue无锁，现全停。用户已手动点query但无结果，空或报错未区分，不推点击在上述窗内，不确认官网无数据/接口坏/登录失效。用户计划明天问老会计、今天停止，只收尾交接PR，不请求/重开窗；下次用户明确继续后先核scope/快照+armed再人工query。41首跑40过、旧MCP lostresponse模拟子Node退出3221226505，无修改定向4/4过，root全41重试exit0/41组全过、支撑包冻结候审[PR #40](https://github.com/huxiaoyang-code/youshu-fork/pull/40)已创建开放候审，代码已独审、停止事实文档待最终head审。可先交支撑PR审合，总目标继续，内部待办真实query→下载→后端MCP fresh复采，下载/新repeat0，不转企业补资料。旧链永禁消费/旧四进程19保留，不恢复旧historycontext；不建账问月份/自动click/重启，rawJS/值/prefix只本机。
