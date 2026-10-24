# LOCAL-05 CSV 币种与金额单位补齐

负责人 `huxiaoyang-code`；[Issue #114](https://github.com/huxiaoyang-code/youshu-fork/issues/114)，Refs #45 / #14 / #20。本窄修基线为 `3b83eb12a096b31dcbfbf646552500ed6ba44cec`。

当前阶段为实施与两条完整原套自测已完成，源码已停止写入，自有测试与服务进程均已结束；管理者独立验收、全新未参与实施者的最终内容审查、已审 head、PR 与合并尚未发生，不把基线写成已审 head。总任务 #14 / #20 保持开放，#45 原历史完成事实不改写。

## 实现范围

仅修改 `06-workbench/server/report-export.mjs`、`06-workbench/test/report-export.test.mjs`、`06-workbench/test/report-export-http.test.mjs` 与本交接。公共 CSV 元数据新增两条记录：`币种,人民币(CNY)` 与 `金额单位,元`，统一覆盖资产负债表、利润表、现金流量表、科目余额表、明细账。生产改动仅在公共 `toCsv` 元数据数组；金额、DTO、财务算法、原业务列头与业务行次序、安全转义、Office 模块及依赖均未修改。

两条既有测试套保留原断言，各新增两种持久 profile × 五类报表的十组检查。使用合成期初 1000 元、收入 123.45 元与费用 23.45 元，独立预期净利润 / 经营现金净增加额 100 元、银行余额 1100 元。模块及 HTTP 分别使用独立 RFC4180 解析器，按记录键断言币种 / 金额单位各一条、标题、期间、持久 profile 与独立金额；模块同时核对原业务列头，HTTP 核对实际生产 server 的随机回环端口下载、附件头、BOM、CRLF 与内容长度。旧中文、逗号、双引号、换行及公式注入断言保持。

HTTP 收尾在发出停止信号后，最多等待 10 秒的真实 `exit` 与 `close`；超时则强制停止并最多再等待 5 秒 `close`，保留超时失败。启动错误不能冒充 `exit`。数据库保持在 `finally` 关闭，输出真实关闭事件；失败与本轮保留变量启用的夹具均保留。

## 自测证据

工作目录均为 `06-workbench`，Node `v24.15.0`。每次运行都有独占新 UUID 临时根，并显式设置 `TEMP`、`TMP`、`WORKBENCH_DATA_DIR`、`KEEP_FIXTURES=1` 与 `WORKBENCH_TEST_KEEP_FIXTURES=1`；只使用合成数据，不连接既有后端、真实账套、凭据或税局。逐套的实际命令、时间、退出码、信号及 `close` 在本 worktree 忽略目录中留存。

- 首轮 `.agent-runs/csv-selftest-c8ae522ad75e43988d4fd2f8f5c06c2b/`：`node test/report-export.test.mjs` 在首个既有 1000 科目精度用例超过本轮 wrapper 设置的 120 秒上限，实际 `SIGKILL` / `exit` / `close`，未到统计，不能声称其数据库 `finally` 已执行；失败现场保留。随后 `node test/report-export-http.test.mjs` 为 0/41、exit 1 / close 1，所有请求为沙箱 `connect EACCES 127.0.0.1`；内层 server 实际 `SIGTERM` / `exit` / `close`，数据库 `finally` 关闭已输出。
- 第二轮 `.agent-runs/csv-selftest-r1-1d7530d376f0432aa10fde46541818d2/`：通过正常沙箱提升运行同一合成回环验收，单套有界上限 900 秒。`node test/report-export-http.test.mjs` 于 UTC 09:22:40.347 至 09:22:42.546 实际 41/41 通过，exit 0 / close 0；内层 server 真实 `SIGTERM` / `exit` / `close`，`dbClosed:true`。`node test/report-export.test.mjs` 于 UTC 09:22:42.547 至 09:29:18.554 实际 36/36 通过，exit 0 / close 0，数据库 `finally` 关闭后正常输出完整统计。两个 suite 都未超时，完整保留旧断言并分别新增十组。模块套保留夹具时沿用旧日志文字 `Failed fixture retained`，本轮实际 36/36 且 exit 0，不把该保留提示当失败。

未跑无关全套、Office 全套或冷安装。本次依赖为管理者提供并核实的开发依赖副本，不构成最终 Windows 冷链证据。管理者后续负责受影响 persistence / restore-binding 代表验收；本段不预报结果。

## 消费者与恢复边界

源码盘点确认：Office 入口从 `buildReportExport` 读取 DTO，现有 Office 测试按标签查 CSV 元数据，没有固定元数据行索引。批量报表 `buildReportSnapshots` 按实际 CSV 字节计算 `csvHash`；恢复重建 `verifyRestoreReportRebuild` 仍严格比较当前 DTO / CSV 与既存快照证据。

本次增加元数据会改变新 CSV 产物的字节、长度与 hash。旧版 CSV 快照在新版恢复重建时可能因字节不同而拒绝，错误仍为 `restore_report_evidence_changed`；必须保留原产物和历史 hash，由操作者人工复核后另建当前版本报表任务。不得回写历史 hash、自动覆盖旧产物、放松恢复 guard 或把旧产物改称新版已通过。XLSX / PDF DTO 与既有算法不因本窄修改变；最终 Windows bundle / 冷链须在实际纳入本窄修合并后重新冻结验证。

## 后续与回退

实施者不执行 Git 提交、推送或合并。管理者核对四路径差异、实际测试和最新 main，锁定完整最终 head，并由未参与实现、全新上下文审查者接受后按既有授权合并；发生后的 head / PR / merge 由后续交接补录。若需回退，管理者通过新的 revert PR 撤销本窄修，保留历史产物与证据。

本机单用户、一企一套、多企业批量的产品边界保持；内部报表不等于法定完整报表或税局申报文件，全国税局真实接入仍为 0。LOCAL-06 / LOCAL-07、最终 Windows 与最终整链的未完成项不由本次窄修宣称完成。
