# 本机会计复核草稿（OFFLINE-05A）

本片为 #82 的新鲜草稿导出，不完成反馈、驳回、更正或重新确认。它复用 #81 的受限 VAT 计算：2026Q1 新设首期季度小规模企业、普通境内主营服务、逐票净额整元且原始 1% 与实际账相符、季度销售达到 30 万元，服务列 1/2/3/15/16/20/21/22。其它字段未算，21/22 累计为不适用 NA。所有确认 pending，periodComplete/submittable/authorizesExecution=false。未登录税局，未提交或缴款，原件真实性 unverified。

## 本机命令

在 `06-workbench` 执行：

```powershell
node scripts/accountant-review.mjs --input <offline-vat-input.json> --output <NEW_DIRECTORY>
```

输入沿用 [OFFLINE-VAT](OFFLINE-VAT.md) 的 `offline-vat-input/1`，显式指定 scope、profileId、declaration、accountingFacts、taxFacts、db，且 materialsInput/materialStore 二选一；路径相对输入配置。没有默认账库。previousComputation 仍只是旧本机比较摘要，不能恢复会计批准。不能输入保存的 VAT JSON、review bundle 或 expectation 作为原始输入。

`NEW_DIRECTORY` 必须不存在，父目录须已存在。输出仅保存在本机：

| 文件 | 含义 |
| --- | --- |
| bundle.json | 计算、完整度、声明/事实、来源字段追溯和真实账快照的诊断草稿；不嵌原件 rawContent/base64 |
| workpaper.xlsx | 七张可读工作表，所有外部内容为字符串，无公式或执行超链接 |
| manifest.json | 最后写入的 `complete_draft` 标记；包含两文件实际写入内容的字节长度/SHA256、草稿标识、输入实际路径/sourceId/hash/version/receipt 映射和显示界限诊断 |

`complete_draft` 表示草稿文件写齐，不能解释为税算通过、会计已确认、整期完成或已申报。税算缺项、未知、冲突或不支持时仍可输出明确草稿，其选定派生税额为 null；实际来源/store 失效、格式错误或私有快照不成立则直接拒绝。

stdout 只有固定状态与计数，stderr 不输出自由错误或明细：成功写出且选定税算可算 exit0；成功写出阻断/不支持草稿 exit3；参数错 exit2；读取、验证或写出拒绝 exit4。任何非零不能推断没有本机输出；失败目录保留诊断现场，不递归清理或覆盖。没有有效 manifest 的目录不可标为完整发布。响应丢失时须检查 manifest JSON、两文件长度/hash 及 pending 状态，不能据 stdout 缺失自动重用旧批准，也不能向已有目录重试覆盖。

## 数据与私有能力

`openVatInputFiles(inputPath)` 从实际文件或 fresh store inspect 构造 rawInput，显式只读打开 source 并捕获 snapshot，返回 `{rawInput, source, snapshot, assertCurrent, close}`。调用者必须 finally close。它保持 VAT CLI 原来的 sourceText(kind,bytes)、二进制原 hash、文件/store/ledger 再读语义，不导入默认 DB、不安装迁移、不写账。store 的 originPath/sourceId/sourceVersion/receiptId 来自本次真实 inspect.active；原文件模式路径和 version 来自本次读取/preflight。

`createAccountantReview(rawInput, source, snapshot)` 内部重新调用税算及材料完整度，不接受调用者提供的计算结果。返回递归冻结的 bundle，WeakMap 绑定原始输入摘要、私有 source/snapshot 和重新计算摘要。`assertAccountantReviewCurrent`、`buildAccountantReviewWorkbook`、`exportAccountantReview` 只接受此同进程对象；JSON clone、跨企业/账套/期、已关闭 source、账变化和原始输入变化均拒绝。

文件 loader 自建 rawInput 在返回前绑定完整读取时摘要，建包前改嵌套来源原文及其 SHA、声明或 taxFacts 也拒绝。私有 guard 不通过公开 session.assertCurrent 调用，外部改 facade 或改返回 inventory 副本不能替换它。rawInput 到私有 guard 的关联留在 WeakMap，导出省略 inputSession 仍会自动重验实际文件。显式 inputSession 必须属于同一 rawInput/source/snapshot。

纯内存原始字节 API 可与真实私有账库能力组合使用，它重放材料并核账，manifest 明确标 `in_memory_raw_input_and_private_ledger_only`，没有文件监测保证。它不认证经济事实或会计声明。文件 API 则在渲染前后及最终 manifest 前再读原文件/store/账库，标明实际文件重验。该保证是发布前读取时点的状态，不是文件系统和数据库之间的跨系统事务或未来不变承诺。公共 hash 只是本地内容比较，无法恢复 capability、真实性或批准。

## 工作簿与可追溯性

七表：概览、材料完整性、申报字段、计算及调整、原始来源及凭证索引、异常、待确认。

概览首屏明确“会计复核草稿、未登录税局、未提交/缴款、未获确认”，列计算 version/inputHash/ruleVersion/ruleDigest/ledgerSnapshotDigest 与草稿 contentDigest，附中文状态对照。材料完整性每个 assessment 项目一行，显示真实质量 status、reason、补件原始事实/可接受依据及 JSON pointer；有效材料仍须会计准入核对。申报表保留全部 25 行、两列、两期间（100 单元），明确计算/阻断/未算/NA，未计算不能当 0。

每个金额由字段节点→计算公式/依赖/规则 URL→逐票业务→真实 voucher/entry ID→原始 SHA 与实际 sheet/cell 或 JSON pointer 查找。索引还保留实际账库的凭证/分录、来源关联/指纹/批次及资格/覆盖声明。JSON pointer 相对于 bundle.json；实际输入文件映射相对于 manifest.json#/inputFiles。规则 URL 只作为文本，未创建 hyperlink。

已计算金额保整数分，并用 BigInt 转固定两位文本；没有浮点重算或 round2。0.00、null 与官方累计 NA 分开显示，日期/前导零/中文/负号按原文本保留，`=+-@` 开头内容不会转公式。列宽、冻结首行、换行便于查看。超过 Excel 32767 个 UTF-16 code unit 或 XML 不可表示控制符时，不悄悄截断/清除；单元格提供本机完整 JSON pointer，异常表和 manifest.displayDiagnostics 明列长度/位置/原因，原始内容完整留 JSON。超过 Excel 行数直接拒绝，没有伪造完整工作簿。

## 发布与验收边界

先在内存渲染，再 mkdir 新目录，两明细文件均 wx 写入/sync/close，随后再验当前输入/账库，最后 wx 写/sync/close manifest。渲染或 mkdir 失败没有新成功目录；明细写或最终重验失败保留已写明细、没有成功 manifest。manifest 自身写失败仅清理自己创建的 marker，不删除其它现存路径。没有通用队列、恢复锁、会计 approve 或业务执行端点。

验收仅使用 `.agent-runs` 下专属合成原 CSV/XLSX/JSON 与临时账库，先自动候选，再经现有核心的测试适配过账。输入不读取旧税算 fixture 或生产账套作为运行数据。新套覆盖独立整数分、所有计算字段/节点、来源与原票 A1、字符串/注入/长文/非法控制符、clone/跨 scope、建包前后输入变更、账变更、真实写失败窗口、manifest/拒覆盖和 DB/WAL/逻辑表零写，所有 child/source/db 实际结束。正式连续写账、既存账更正、结构化会计反馈和版本确认链仍待 #54/#80/#82，真实税局接入 0。
