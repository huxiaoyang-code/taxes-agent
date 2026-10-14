# Windows 本地启动命令（reference）

仅在本机 Windows 环境按需查阅。命令中的 `<...>` 是**占位符**，使用前必须先在当前机器上核实：
可执行文件路径、任务单绝对路径、模型 ID 与映射、可用工具与权限范围。不要照抄未核实的路径或模型名。

- 不把凭据、令牌、真实机器专属配置写入本文件或任务包。
- 「客户端本地」不代表模型离线；提示词与输出仍会发往已配置的服务，须遵守项目授权边界。
- `--tools` / `--allowedTools` 只用于收窄本次任务能力，**不是**用来绕开沙箱或审批。

## pi

```powershell
pi --provider tokenhub --model deepseek-v4.1-flash `
  --models tokenhub/deepseek-v4.1-flash `
  --thinking low --offline `
  --no-session --no-extensions --no-mcp --no-skills --no-prompt-templates --no-themes `
  --tools 'read,edit,write,powershell,grep,find,ls' `
  --mode json -p '@<ABS_TASK_PATH>'
```

- 先核实 provider、模型 ID（`tokenhub/deepseek-v4.1-flash`）与别名映射；主模型与回退均须锁定到获准模型。
- 下一部分使用新进程；`--no-session` 表示不续用会话。

## Claude Code（PowerShell）

```powershell
$env:CLAUDE_CODE_GIT_BASH_PATH='<ABS_GIT_BASH>'
$env:CLAUDE_CODE_SUBAGENT_MODEL='deepseek-v4.1-flash'
Get-Content -Raw '<ABS_TASK_PATH>' | claude -p --safe-mode `
  --model deepseek-v4.1-flash --fallback-model deepseek-v4.1-flash `
  --strict-mcp-config --no-chrome --disable-slash-commands `
  --no-session-persistence `
  --tools 'Read,Edit,Write,Bash,Grep,Glob' `
  --allowedTools 'Read' 'Edit' 'Write' 'Bash(node *)' 'Bash(npm test*)' `
  --permission-mode acceptEdits --output-format stream-json --verbose
```

- 先核实 `CLAUDE_CODE_GIT_BASH_PATH` 指向本机真实 Git Bash，子 agent 模型锁定到获准模型。
- `--no-session-persistence` 表示下一部分不复用本会话。
- 已知可用的本机 Git Bash 占位为 `C:\Program Files\Git\bin\bash.exe`，使用前仍须核实。
