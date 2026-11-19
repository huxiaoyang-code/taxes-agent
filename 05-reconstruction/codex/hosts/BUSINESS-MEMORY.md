# 账套记忆

每个账套用一份本机 `MEMORY.md`。文件保存已确认、跨月适用且会影响做账决定的简短口径。会计可以直接打开文件查看，同一账套的新月份继续使用同一文件。

## 绑定与启动

先按[统一入口](START-HERE.md)生成新工作区，后端与 `--database` 指向同一实际账库。在生成目录按实际账套及本期运行：

```powershell
node ./start-business-session.mjs --account-set-id <实际账套ID> --period 2026-11 --prepare-only
node ./start-business-session.mjs --check
```

实际绑定见 `.finance/business-session.json`。其中的 `memoryPath` 为 `<账库目录>/.finance-memory/<账库文件名>/<databaseInstanceId>/<accountSetId>/MEMORY.md`。同一实际账库的同一账套跨月沿用同一路径，同目录的异名账库副本也各用自己的文件。换企业或月份时使用新工作区。只读检查可核对绑定和路径，首次有可沿用的结论时由宿主创建文件。

按所选宿主[启动](START-HERE.md#3-绑定已有账套并启动)。Claude Code 启动器给原生 `autoMemoryDirectory` 传入已绑定目录，自动记忆负责文件加载和保存。宿主 hook 只用于会话身份绑定以及恢复校验。Pi、dsh 和 ZCode 用原生文件工具按绑定路径读取和编辑同一份文件。旧生成工作区通过新版生成器重新建立。 [Claude Code 官方记忆文档](https://code.claude.com/docs/en/memory#storage-location)

## 沿用与修订

首次接手、口径变化或用户要求精简时，查相关历史和必要资料，按[账套记忆格式](../../../plugins/finance/skills/company-baseline/SKILL.md#memorymd-格式)写入并读回。各账套使用同一结构，条目取自该企业已确认的口径。新月份匹配适用条件后沿用，日期、金额、余额及业务进度按本期实际资料取数。本期判断、缺件和证据明细放在当期说明或底稿。

涉及新选择时在当前会话确认，再编辑该行，写明旧口径截止月和新口径起始月。详细分录、旧执行方法和历史税负按需查[相关参考](../../../plugins/finance/skills/shared/references/business-memory.md)。会计通过既有凭证审批和税务流程处理正式操作。账套备份需要同时考虑这份独立本机 Markdown 文件。
