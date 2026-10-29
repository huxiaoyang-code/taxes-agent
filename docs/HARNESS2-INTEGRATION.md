# Harness²：Codex 优化，原生宿主执行

本接入固定 Google Research `harness2` commit `1cfe254e8d25b15f37048c3730134686abe60335`，校验42个原始Git blob，保留其recursion、selection、reflection和Library方法。用户已明确：**优化器调用本人Codex；Pi＋DeepSeek只执行任务**。其他三宿主适配仍保留，但配置/探针、模拟传输和真实模型验收分开记录。

## 分工与边界

| 角色 | 实现 |
|---|---|
| Harness² | 调度原版Propose–Probe–Compose、选择、反思和经验积累 |
| Codex优化器 | `codex_proposer.py` → 外层 `codex-proposer-worker.mjs` → 本人 `codex exec`，负责候选、组合、选择所需输出和反思 |
| 执行器 | 原生Pi＋DeepSeek（或明确选择的其他宿主），加载候选并调用实际财税MCP |
| 执行模型relay | `budget-gateway.mjs`仅转发/记录执行器的DeepSeek请求；不生成候选、不代理Codex登录 |
| 独立评估 | 另行读取实际Store/DB/回执，不调用模型、不向候选提供判题器 |

Codex CLI复用操作者现有认证和默认model/provider，不传`--model`、不忽略本人config、不复制token或auth文件。worker只把受控合成上下文经stdin交给Codex，使用read-only sandbox、禁shell/web、apps/plugins、browser/computer、多agent、image、依赖安装与hooks能力，并在内存读取MCP列表后逐个禁用无关MCP；配置中的env/header原文不落日志。输出通过JSON schema和Markdown文件白名单后才安装。`gateway_proposer.py`已退役，调用即明确失败，绝不回退DeepSeek自我优化。

MCP逐次覆盖使用有效但禁用的stub配置，不复制原command、env、URL或header。目前仅支持已验证的`stdio`和`streamable_http`，服务器名限字母/数字/下划线/短横线；其他形式明确拒绝。带同一组flags再次读取MCP列表，确认名称集合一致且所有项`enabled=false`后才启动优化。worker传输、CLI进程或输出协议故障属于不可恢复的接入错误，Google不把它当作候选失败回退；已排队的后续优化任务同样停止，保留首次故障metadata。

当前可编辑表面仅`SKILL.md`、`tools.md`、`recovery.md`。64KiB候选文件表面限制用于限定本次允许改动的指引体积，**不是模型输入、输出或上下文能力限制**。业务算法、锁、审计、恢复和会计确认不由候选改写。

## 启动选择

`harness2-run.mjs`的`--host pi|claude-code|zcode|dsh`选择执行宿主；`--harness-improvement off|harness2`与`--runtime-efficiency off|sol-pi`默认off/off，双开拒绝。off/off只返回研究入口选择结果；日常工作继续使用原宿主启动器。SoL-Pi模块存在时显式路由，缺失明确报错。

真实循环由`harness2-google.py`启动，`--optimizer codex`为默认且唯一真实优化器；`--optimizer synthetic-fixture`仅供明确的无模型回归，不能与`--execution-mode model`组合。真实模式要求显式本人Codex路径、Node路径和独立外层context目录：

```sh
python3.12 <repo>/06-workbench/scripts/harness2-google.py \
  --upstream <pinned-source> --repo-stage <readonly-linux-source-stage> \
  --host-stage <readonly-linux-host-dependencies> --node <linux-node-ELF> \
  --work <new-linux-work> --canary <external-synthetic-canary> \
  --execution-mode model --host pi --mode seq --optimizer codex \
  --gateway-socket <executor-relay.sock> --budget-config <executor-config.json> \
  --codex-cli 'C:/absolute/path/codex.exe' --codex-node 'D:/absolute/path/node.exe' \
  --codex-work-root 'D:/absolute/owned/codex-contexts'
```

Linux原生Codex可提供其本机CLI/Node/context绝对路径。Windows Codex由可信外层worker执行，保留本人Windows认证；Google控制器通过显式宿主桥调用，不将认证复制进Linux。**这是外层优化器进程，不是给候选开放Windows Interop**。候选仍在真实bwrap `--unshare-all`内：代码与宿主依赖只读、独立work可写，无主机home、Windows挂载、WSLInterop或公网路由。Codexcontext、执行relay配置和账本都在候选可见挂载之外。

执行relay的最小配置只有`socketPath`与`ledgerPath`。默认audit/forward，不自行设置64KiB请求体、2048输出token、请求数/费用/总时限。只有操作者显式提供相应`max*`才启用限额，不清账重置旧预算。上游模型请求参数与宿主配置透传，未给输出限制不由relay插入`max_tokens`或切换thinking。固定官方DeepSeek目的地与协议/目标约束继续有效；密钥仅留在外层relay进程环境。

Codex优化记录和DeepSeek执行账本分别保存。Codex若未在机器事件中给出实际模型名，就记录`modelSelection=inherited, actualModel=null`，不采信模型自报名称。Codex CLI/订阅账单未知保留null；Google的`Reply.cost_usd`数值占位不能报告为免费。执行token有实际usage才记录，配置了价格才给显式估算，不把两种认证来源的费用混成一个准确账单。

## 一次完整循环及验收

当前任务为合成企业A的2026-01 `period.inspect`。执行始终经原生MCP和实际Store/DB，不用模型自述代替回执，保留`executed / resultCurrent / confirmationCurrent`，会计review保持pending。

原版`k=1`仍有3个改进阶段和3次候选执行，另需1次基线；不是只调用一次私有`_run_stage`。本入口一次只跑`agg`或`seq`一种，单线程调度。每个阶段使用Codex产生修改，候选由真实执行宿主运行；k=1只有一个最终候选，使用上游`trivial_selection`，不额外花模型请求假装比较单个候选。之后由Codex反思、原版Library持久化经验，最后独立评估。

验收必须同时满足：所有原版阶段无失败回退；候选文件确实被对应原生宿主加载；实际Store证明任务执行且结果当前有效；选择/反思/Library文件可追溯；独立评估通过，未伪造人审。`cycle.json`分别列出optimizer和executor证据。流程pass依据真实执行证据；历史工具错误不再一票否决，但innerErrorCount/nativeStatus原样保留，zeroObservedErrors单独标注，qualityVerified=false。原生退出失败、timeout、错误目标、stale结果或人审accepted仍不能pass。只证明完整流程连通，不证明跨企业泛化、整账完成或效率收益；heldout为空仍保留false。

完成缓存严格绑定method、执行宿主、execution-mode、优化器参数及CLI字节、执行relay配置摘要、Node/source-stage/host-stage、起始快照、基线和可信assessor字节；任何改变都在preflight或新模型调用前拒绝，不能把synthetic结果冒充model。相同配置已完成循环直接复用原制品，不新增模型请求。只有操作者显式给出optimizer/executor timeout才为相应模型阶段设置deadline，不默认压成30/120秒。

同一运行ID的已交付基线可以按原manifest绑定复用；来源、源码、stage、宿主或基线改变后拒绝旧实验，不静默复制旧确认。超时、取消和缺交付物保留unknown，恢复先query原run ID，不能换ID盲重试。

## 测试用例与证据

| 测试 | 范围 |
|---|---|
| `harness2-codex-proposer.test.mjs` | 真实worker＋fake CLI：继承模型/认证配置、禁无关工具、100KB上下文、候选文件白名单、exit23、EOF取消；不调用模型 |
| `harness2-upstream.test.py` | 固定42blob、伪造pyc拒绝、原版agg/seq/选择/反思/Library；模型和执行为明确fixture |
| `harness2-model-path.test.mjs` | 真实Pi CLI/MCP/DB/Google循环；Codex使用独立fake CLI，DS仅模拟执行响应；另验同配置零调用复用及mode/host/execution-mode/relay/CLI/assessor改变拒绝；不能当成真实Codex/DS验收 |
| `harness2-budget.test.mjs` | 执行relay默认透传、大请求和模型参数；只有显式限额启用才测试预算停止 |
| `harness2-hosts.test.mjs` | 宿主/实际production bridge探针、精确研究工具集合、协议与进程合同；原生模型另验 |
| `harness2-assessment.test.mjs` | 合成终态判据矩阵：保留历史错误但以实际执行证据判流程；失败/错目标/stale/已批准拒绝，真实Store/DB IO由完整循环另验 |
| boundary/research-mcp/recovery/launcher | 默认关闭、文件/目标/能力边界、原intent恢复及子进程退出码 |

Node合同套件在`test-all.mjs`登记。Linux真实核心运行`python3.12 test/harness2-upstream.test.py --upstream <pinned-source>`；明确无模型完整循环需`--execution-mode synthetic-native --optimizer synthetic-fixture`。模型路径fixture需独立配置文件，与真实模型循环分开。当前实际命令、已审tree/head、外部模型结果和未验证范围只写对应PR，不预填通过。

模型模式依赖Linux namespace、Python3.12/3.13和ELF Node；新stage由`harness2-stage.mjs`按白名单生成，不带默认data、home、Git、工作树或assessor。外层Codex可在本人Windows宿主运行，凭据不复制；Windows原生宿主全进程树清理和其他宿主真实模型范围必须各自采证。

## 数据与发布

本产品仍是本机单用户多企业工作台，每企业账套独立。只用批准的合成资料与临时库测试，真实账套/税务凭据不发送给模型或写日志/Git。研究MCP在后端限定唯一合成目标、Store和只读期间任务，拒绝feedback批准、写capability、其他数据库及跨Store依赖；候选不能替代这些强制规则。

候选只形成待审制品，经PR与全新上下文独立审查后发布，不自动覆盖全局Skill、模型或宿主配置。停止研究后使用原日常启动器，不删除原件、Store、审计、历史确认或备份。真实模型能力/效果必须根据实际证据报告，模拟或确定性测试不能冒充。
