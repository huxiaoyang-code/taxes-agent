# OFFLINE-02B / #79B

Refs #76 / #79；认领 issuecomment6374952382。base PR96 merge `2414c512e6ec0cd58e94a6d9a6895b2ddbb50944`，branch `codex/huxiaoyang-code/offline-02b-action-plan`。

目标：实际原件/receipt store → 三业务候选准备 → 具体客户补件 → 重验并仅使受影响任务及后继失效。DTO/API/状态先按 [合同](../OFFLINE-ACTION-PLAN.md) 固定，再实施。不得重复税额/会计算法，不要求客户先做分录或税额。

唯一实施 subagent 使用继承模型，禁止再委派/外部执行器/Git写/全局配置。用户授权覆盖旧执行方式；root负责Git、独立验证及全新未实施者审查。只可新增 server/offline-action-input.mjs、server/offline-action-plan.mjs、scripts/offline-action-plan.mjs、test/offline-action-plan.test.mjs（均在06-workbench）、docs/OFFLINE-ACTION-PLAN.md、本文，修改docs/handoffs/OFFLINE-CLOSELOOP.md，共7文件。旧planner/readiness/candidates/store/VAT/review/测试、核心/DB/import/audit/batch/HTTP/MCP/package/test-all/STATE/NEXT全部只读。#54正式写依赖尚未合并，不绕过。

验收：独立新金额三候选与已提供字段不重复索取；benefitBasis/refund缺项及补回局部失效；同JSON改单笔/重排、同CSV改单票隔离；缺税属性只阻票据、缺整期覆盖允许单笔；同合同多支付/反向关系/已知工资资产矛盾传播；原件/坏映射/跨范围/store stale或锁/坏来源/伪previous实际重验；wx与固定stdout/stderr；模块树不读DB。所有夹具在.agent-runs合成，不碰真实资料。实施结果待root/fresh，不自称PR完成。

实施冻结验证（cwd `06-workbench`）：`node test/offline-action-plan.test.mjs` **33/33 exit0**；必要旧 `node test/offline-plan.test.mjs` **45/45 exit0**、`node test/offline-bookkeeping.test.mjs` **43/43 exit0**。三业务独立2946.17（净2917.00+税29.17）/590.19/337.83，真实CSV/JSON/XLSX/receipt store；缺一个字段只一个请求、补回0，共享tax/profile合并，getter/负面读取、坏同源关联票、DAG不变式均实际断言。夹具保留 `06-workbench/.agent-runs/action-plan-synthetic-*`，无真实资料/DB/网络/常驻进程。初轮20及随后25/26/28/29/31/32是各时点通过，不替代修后33。root动态探针已通过但最终冻结root/fresh验收、PR和合并仍待，不关闭#79。

root依赖准备历史：原沙箱 `npm ci` exit1（Exit handler never called），随后同WT获授权 `npm ci --offline --ignore-scripts --no-audit --no-fund` 212packages/exit0。实施未安装依赖或借用其它WT。原始失败/修复事实及PR96已合精确信息见[本流交接](../handoffs/OFFLINE-CLOSELOOP.md)。所有任务只准备；#81已有窄VAT和#82已有底稿/反馈API，本façade未编排它们，正式写账/整期完成仍不成立。

root冻结后最终验证已实际完成：新套33/33 exit0（session46817实际结束），旧plan45/45及bookkeeping43/43 exit0，日志在06-workbench/.agent-runs/root-*-regression.log；manager-action-probe.mjs与manager-same-source-probe.mjs均PASS exit0，对应acceptance索引保留。同CSV两销售共4候选，第一8319.37→8329.47仅该业务task摘要变，第二1134.23及行政/预付不变且完整source SHA刷新；私有inventory真实path/hash、公开副本修改隔离、纯字节/文件模式通过。本条只补三文档，产品/测试保持冻结；最终完整HEAD fresh独审、PR及合并仍待。全部7文件曾另做逐文件空白检查；此前git diff --check仅覆盖tracked差异，不冒充新文件已获cached检查。
