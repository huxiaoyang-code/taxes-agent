# Q2 新鲜会计复核草稿（OFFLINE-05C）

本机从实际Q1、Q2原始资料及同一只读账源重算Q1/Q2/累计数，生成 `bundle.json`、七表 `workpaper.xlsx`、最后写入的 `manifest.json`。全部会计确认pending；真实性unverified；未登录税局、未提交；`periodComplete/submittable/authorizesExecution=false`。本片不完成#82整体；Q2反馈版本链另OFFLINE-05D，正式连续账务及既存账更正仍依赖#80/#51。

## 调用

在06-workbench运行：

```sh
node scripts/accountant-review-q2.mjs --input /absolute/q2-request.json --output /absolute/NEW_DIRECTORY
```

输入严格沿用 `offline-vat-q2-request/1`：`version/priorInputPath/targetInputPath/target`，target仅 `dbPath/databaseInstanceId/enterpriseKey/accountSetId`。CLI的输入文件及DB路径相对request所在目录解析；output相对当前目录。API `runAccountantReviewQ2(request, absoluteNewDirectory)` 要求路径已绝对化，拒绝proxy/getter/额外字段/上传previousComputation。仅绑定目标现库，不导入父进程默认账库。

输出目录必须不存在且父目录存在；不覆盖、不递归删除用户目录。CLI exit0表示选定字段可计算的完整草稿；exit3表示业务阻断但完整草稿可查看；exit2用法错误；exit4输入/运行/发布拒绝（可能留部分诊断文件，不能据此认成功）。stdout只有固定状态摘要，不输出原件或企业明细。最后manifest只表示本机草稿文件完整，非会计确认或认证。

## 内容与追溯

新版本 `offline-accountant-review-q2/1`、kind `q2_accountant_review_draft` 与旧Q1包不同。`priorComputation/computation` 分别保留实际Q1及Q2当前/累计完整字段；`periodEvidence.prior/target` 各含scope/materials/ledgerSnapshot，包含原件SHA、材料记录、实际来源/批次/凭证分录、规则原文URL与节点。累计节点以 `Q1:` 明确指向本worker实际Q1重算节点。`manifest.inputFiles.prior/target` 为两期实际读取inventory；`files` 为JSON/XLSX SHA及bytes；新manifest版本 `offline-accountant-review-q2-manifest/1`。

七表为概览、材料完整性、申报字段、计算及调整、原始来源及凭证索引、异常、待确认。200个双期字段逐项保留；未算NULL、NA、0分开。金额原值/整数分/BigInt格式化均文本，无浮点税算；所有外部值按字符串输出，无公式或外部链接。长文、XML非法字符保留JSON原值，XLSX显示明确JSON pointer与诊断。Q2原件定位使用 `manifest.json#/inputFiles/prior/i` 或 `target/i`；长文回退指明所属bundle/manifest，不沿用旧Q1数组定位。

原材料质量状态保持原值；`historyBridge`、`historyBridgeResolution` 并列说明真实Q1现库历史解释。材料完整性的opening/history行原missing状态不改；仅当本次真实Q1证明成立且priorAccountingExplained为true时，在同一行说明“本次Q1原件与账务已解释，不重复补交；不证明已结账/申报/缴款”。未解释时保留具体补件请求。已有效提供Q1且真实解释的历史不再要求客户预制前期账/税；原件缺失、业务矛盾、操作者账库/工程异常按实际原因处理，不统称客户缺资料。普通境内服务小规模选定列/行限制沿用现税算；21/22累计NA，两期表的金额及整数分列均明确显示NA，并保留实际规则URL；累计映射为工程推断，仍待会计审定。

## 新鲜度与信任边界

parent/facade/CLI仅native imports。固定fresh worker先检查expected/initial/current本地字节闭包，再载入财务模块。32路径来自实际27模块静态图加5新入口，包含bank-storage及multiline local-audit依赖；DB/backup动态分支本路径不调用。观察代码变化永久latch restart，缺失初始字节返回安全诊断；不接受public DTO/digest恢复能力。

worker私有WeakMap绑定live pair、双期raw、snapshot及完整真实计算产物摘要；每次assert重验pair、双期原件及现库、重算完整产物。渲染前后、明细后、manifest前后均核对；仅抽出的renderer是显示函数，无发布资格、无任意guard callback、无可信manifest。旧Q1 build/export原守卫保持。

文件均wx0600及sync/close，目录0700，manifest最后写。每个明细及manifest绑定本次预期bytes/SHA和实际句柄身份；发布后、worker返前、parent等待实际child退出后回传前重验。native parent的输出读取在before/held/after/named四个stat均核常规文件、nlink=1、预期size及dev/ino/birthtime身份，并核读窗mtime/ctime稳定。bundle包装器在共享reader调用前后，以named stat完整核对预期size、身份及mtime/ctime；共享reader自身提供held身份/nlink/限长校验与after读窗检查，不表示其每个stat均逐字段核对预期metadata。atime不作变化判据。观察到的变化返回publication_failed，不能把任意现有manifest散列当作成功。

publicationId只识别该次own marker。失败清理必须同时匹配本次ID、精确SHA与实际文件身份，未知或foreign文件即使字节相同也保留。CLI最终请求窗失败时调用native私有成功result能力清理；只有实际成功返回对象的WeakMap身份有效，私有目标深拷贝，不接受clone、公有digest或可变public字段授权删除。CLI请求初读与末读的before/held/after/named四个stat均完整核对常规文件、nlink=1、预期size、dev/ino/birthtime身份与读窗mtime/ctime，并核canonical路径，再核原始请求SHA；读后同inode增长或同长度改写只要被后续stat观察到即拒绝。超时、退出、断连都等实际child结束再返回，资源finally关闭。若系统错误导致残留无法移除，调用仍exit4/blocked，残留不授任何执行或确认资格；本机操作者应保留故障目录诊断后用全新目录重试。清理大小写NODE_OPTIONS/NODE_PATH/WORKBENCH_DATA_DIR；不继承父财务cache。

已安装第三方包/lock、Node及操作系统是显式信任边界；闭包不声称防护整个环境或未观察到的ABA变化。源真实性、税局上传兼容及真实人类会计接受均未验证。测试仅合成临时原件及现库，不执行税局或外部消息。

## 实际验证范围

最终完整测试入口保留35项。第五阶段完整33/33实际exit0仍因root/fresh独立CLI请求stat反例被拒绝；最终仅CLI及其测试窄修后，实施者从同一最终test字节精确提取6/35实际通过，fresh提取3/35实际通过，root另以真实增长/同长度改写两模式独验通过。未执行最终完整35项。此前金额、七表、全部定位及只读库/WAL证据按未变化的执行支路复用，阶段结果与修复记录见[交接](handoffs/OFFLINE-05C.md)。
