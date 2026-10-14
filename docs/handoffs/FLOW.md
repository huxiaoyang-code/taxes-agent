# FLOW 交接

- 状态：已合并；员工会话已退出。PR [#7](https://github.com/huxiaoyang-code/youshu-fork/pull/7)，合并 SHA `03eba00c4fefd065d30f021d19f17f02d48d5d65`。
- 目标：记账/旧账导入真实规则，MCP 到临时后端的业务闭环及统一测试入口。
- 执行者：pi / 显式 tokenhub/deepseek-v4.1-flash，新会话，不继承 CORE 日志。
- 分支 / worktree：codex/workflow-acceptance / .worktrees/flow。
- 开发基线：91b623a9a75d19b1e88fe00719aee084973d2cde；验收前已重放到 TAX 合并基线 f4d9f82f2f91afafc74d2aa88288b4e1607ce9d0。
- 变更：bookkeeping 主规则及 7 个 reference、legacy-book-import 主规则及 import-rules；新增 workflow-test.mjs、test-all.mjs；npm test 为全套入口，test:smoke 保留原冒烟。
- 业务闭环：示例 CSV paths 预检与导入；独立临时账套销售/费用、资产购入凭证和卡片、折旧、结转、报表勾稽、封账保护和新期间。以业务常量独立核对金额，不直接调用领域算法作为预期。
- 管理者审查修正：区分可用与占位工具；避免重复索取既有授权；抵扣依据已核实结论；未分配利润考虑历史余额；如实说明折旧尾差和导入预检限制。
- 管理者集成：TAX 已合并，test-all 的税务契约改为必跑；任何测试文件缺失也失败，不再允许跳过后报全套通过。
- 管理者独立验证：在本 worktree 的 06-workbench 运行 node scripts/test-all.mjs，guards 23、derived 31、smoke 28、MCP 44、workflow 23、tax 59，共 208/208，exit 0。两份 Skill 用 skill-creator/scripts/quick_validate.py（Python -X utf8）检查均有效。
- 日志：本机忽略目录 .agent-runs/flow-manager-acceptance.log；pi-flow.exit 与 pi-flow-review.exit 均为 0；员工和测试子进程已结束。
- 未验证：真实账套、现有 8787 后端、网页 UI、实际 Excel 转换、真实税局登录。
- 限制：导入非幂等；CSV 非法金额仍会被转为 0，必须先核对原始金额，预检成功不是完整保证；财务报表及税务生产能力边界见 PHASE1-ACCEPTANCE。
- 技能资料由 21 增至 22 份，原站 catalog 保持冻结。
- 管理者 ACCEPT 已在合并后 main 运行 npm test：208/208，exit 0，见 STATE；今后员工新会话只读取章程、STATE、该部分交接与必要源码。
