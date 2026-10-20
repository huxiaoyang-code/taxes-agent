# TAX-DOWNLOAD-EXPLORATION · 网站取数与往期文件探索任务

更新：2026-10-21（北京时间，2026-10-20 起始探索历史保留）。负责人：`huxiaoyang-code`。Refs #20 / #13 / #14 / #17。状态：**查询 / 下载探索支撑候审；两个已 armed 窗口均零事件且现已全停；用户确认已点查询但无结果，空或报错未区分，今天停止探索。** 不推点击发生在窗内，不确认官网无数据 / 接口坏 / 登录失效。财报按用户要求暂停；真正发票 query → 下载 → 后端 MCP 复采仍未证，业务下载 / 新 query repeat 0，总专项继续。

必读：[章程](../PROJECT-CHARTER.md)、[STATE](../handoffs/STATE.md)、[主文档 / 接口目录](../TAX-DOWNLOAD-EXPLORATION.md)、[交接](../handoffs/TAX-DOWNLOAD-EXPLORATION.md)、[月度链路](../TAX-MONTHLY-DATA-CHAIN.md)、[历史查询契约](../TAX-HISTORY-COLLECTION.md)。用户最新范围优先：只探索网站取数、往期资料及复用命令，不建账、不问月份、不补会计代码。

## 授权与分工

本轮用户明确授权 Codex 实施 / 审查；root 独占真实会话、私有材料、Git / PR / 合并。实施只读安全源码与合成输入，不读真实 DB、凭据或私有运行目录，不执行 Git。最初三文档之后，root 已另授窄 helper / CLI / 测试、runner 与共享入口有限增量；不改变其他包或永久协作范式。

## 分段与当前事实

| 分段 | 已有结果 | 待办与限制 |
|---|---|---|
| E0 最新重建 | 原导航锁严格退役 / 旧链消费永久禁用，旧四进程 / 19 文件保留。最新 C81 opt-in 独审 / root 63 项后真实正常回固定门户，sourceCreated / runCreated；3 attempted / settled / performed / complete、unknown false / 企业匹配，main 1 / clear 2 / within 0、cleanup true / 无锁 | 确认当前登录有效；不复活旧 scope / history context，不把源身份核验扩大为发票企业业务绑定 |
| E1 请求发现 | 正常财务导航 ACK，前身份 1 / 1 complete / unknown 0，11 主 frame metadata 私有保存；GET `getCwbbzlList` / POST `queryZlbscjb` HTTP 200 | `observed_request_metadata`，正文 0，无企业绑定 / 消费；完整 prefix 仅本机模板 |
| E2 参数与静态关联 | actual 七键 `Lrrqq / Lrrqz / ZlbsxlDm / Skssqq / Skssqz / PageNum / PageSize`，query 唯一 `_`。组件 6,016B / 5,790 字符，唯一五键对象交集五、不全绑定。最新 25 项 shape 实测静态 `/zhcx/cwbbxxcxxq`，queryFieldSchema fields 空 / complete false | query 节点 CallExpression、非直接对象，是动态构造依赖，不能推断有 token 键；queryKeys 空 / navigationTemplateAuthorized false。parameter_property 仅语法非运行时 / 企业行映射；旧 5,789 为 AST end |
| E3 私有脚本快照 | `live_observed_private_snapshot_partial`，captured 3 / eligible 4、budgetSkipped 1、truncated true，1,326,340B 私有保存，无锁 / 清理确认 | 非完整 source；helper HTTP 0 不证明后台静默，原 JS / 值 / prefix 不进模型 / Git |
| E4 财报分支暂停 | 最新固定 Page.reload 经独审 / root 42 项后实际 request 28 / main 1 / redirect 4 / matched 2 / bodySaved 1、57B；scopeSealed / cleanup true、无锁 / ownUnknown false；响应两字段 / 无数组、认证错误 | authExpiry / authIndicator 只是本接口文本投影，不证明全局登录失效。用户确认仍登录并跳过财报，不再重试，不作其他取数前置；不推企业财报适用规则 |
| E5 详情与官网原件 | 下载 0，新财报 MCP 独立 replay 0 | 下一阶段 body → detail → download；核类型 / 完整度 / 企业期间关联、私有持久化后计成功，不扩账务 |
| E6 发票入口实际观察 | 2181 一次 nav ACK，前身份 1 complete / unknown 0；95 事件 / 15 主 frame metadata、auth 8 / external 61 / redirect 3 / subframe 0，body / scripts 0；scope_changed / 私有 artifact、cleanup true / 无锁 | 只有 scripts、POST getPublicKey 多次、GET getNewEtaxFlag HTTP 200，无发票列表 query / 开票能力证明，不重放认证链 |
| E7 最新当前快照 | 先前发票快照 4 / 5 份；observer 两次未 armed，第二次固定投影 TargetURLmatchesSnapshot false / FrameTree 未读，均零业务 / cleanup true / 无锁。重建后最新 snapshot captured 7 / eligible 9、4,034,109B、事件 44 / 拒绝 35 / 预算跳过 2、scope / cleanup true / 无锁；A16D 离线 7 sources + 38 focused funcs，parse fail 0 | 部分资产，不复用失配快照；前置拒绝不代表数据或登录状态 |
| E8 被动窗口 | observer 准确字节独审 + root 37 项通过后，120 秒与 180 秒实际窗均 armed / scopeStable / 全 scope 布尔 true，事件 / metadata / bodies 0，cleanup true / 无锁，现全部停止 | 用户已手动查询无结果，空或报错未区分；不推点击发生在记录窗内。今天停止，不请求 / 重开窗；仅用户下次明确继续后，先核作用域 + armed 再窗内人工查询 |

既有 history PR #38 / #39 只证明固定单页，两轮各 3 fresh / performed / complete、unknown 0，各 6 行 / 2 期间，不扩大为全历史或文件。发票精确目标“全量发票查询”；历史菜单 TTL 未核，仅 fresh 身份与两读原 URL 下普通导航线索，不授权 API；“往期账套”标签不证明完整账套。

## 验收与复用交付

- 目录区分 static candidate / observed metadata / observed body / independent replay / 文件持久化；方法、键、本机来源、前置、列表详情文件依赖、分页、失败与实际次数各自有据，不据 HTTP 200 推业务成功。
- 已观测七键 schema 独立于静态绑定；source 未绑定键 / 值 / 表达式不输出。详情静态路径不是导航模板，纯 shape 函数不是下载命令。
- page / snapshot / financial-passive / invoice-observer CLI 的占位调用与前置见[主文档](../TAX-DOWNLOAD-EXPLORATION.md#本机管理员页面探索命令)。早期 bootstrap 39 项 not_live_run 仅旧版本事实，最新 opt-in **63** 项独审 / root 后真实创建新 source / run，不回填旧版本。
- 上一版本 root 40 / 40 全量通过。41 组首跑 40 组通过，旧 tax-browser-session-mcp 的 lost-response 模拟子 Node 异常退出 3221226505；无代码 / 测试改动，定向 4 / 4 通过，root 全 41 组重试 exit 0、41 / 41 通过。observer 已独审 + root 37 项 + 两个实际窗，不再是“待独审”；仅 static / contract-shape 用 `--expose-internals`。
- REA 原脚本输出与完整 prefix 输出均自动审批拒绝、未执行、不重试；只留本机不透明模板。真实 refs / PID / 私有路径 / 企业期间值 / 原异常不进文档或 Git。

财报继续暂停，不当前置；fresh 3 实测确认门户登录有效。用户确认已手动查询无结果（空或报错未区分），计划明天问老会计，今天停止；当前窗口全停，不再请求或重开。下次须用户明确继续，root 再重核文档 / 快照作用域、armed 后才安排窗内人工 query，不重放认证链、不恢复旧 history context。内部待办：真实发票请求与正文 → 详情 / 文件下载完整保存 → 后端 MCP 独立复采；不转企业补资料。当前仅收尾本轮支撑 PR 交接审核，总专项继续，root 最终全 41 组重试 exit 0 / 41 组全过，本轮支撑交付候审、[PR #40](https://github.com/huxiaoyang-code/youshu-fork/pull/40) 已创建、开放候审；代码已独审，用户今日停止事实的文档仍待最终 head 审查。无自动点击 / handler / 主动业务 POST / 写，不关闭重启、不扩账务。
