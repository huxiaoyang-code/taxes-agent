<#
.SYNOPSIS
  从源码启动本机有数工作台，显式指定 Node 路径、数据
  目录和端口。首先运行运行时预检。

.DESCRIPTION
  此脚本兼容 Windows PowerShell 5.1（不要求
  PowerShell 7 / pwsh）。绝不修改机器 PATH、注册表、执行
  策略或防火墙。

  始终绑定 HOST=127.0.0.1（仅回环）。PORT=0 让操作系统分配空闲
  端口；实际端口由服务打印。数据存储于显式
  -DataDir 中，不读取默认数据目录。

  运行时预检作为有时限的子进程运行（真实截止时间，到期终止并
  回收），避免挂起探针永久阻塞启动器。探针临时
  目录默认为 `<this workbench>\tmp\windows-delivery`；发布目录
  只读或要求工作区路径时，传入 -ScratchRoot。

  正常前台使用时服务自身不设运行时限。只有提供
  -MaxRunSeconds（验证用途）时才在到期后停止。

  进程所有权：此脚本只启动一个服务进程，记录其
  ID，并打印一行 `windows_start_service_pid=<pid>`。只能停止该 ID。
  所有停止路径（正常退出、-MaxRunSeconds 到期及异常）只使用
  本脚本自有的 System.Diagnostics.Process 句柄；绝不根据进程名
  停止其他进程。从外部终止此包装器可能留下运行中的服务；
  因此会打印 ID（包装器被终止后无法自行清理）。
  无法验证停止时，脚本报告
  `service_stop_failed` 及 `windows_start_residual_service_pid=<pid>`，
  不宣称成功。

  如果组织禁止本机脚本执行，不得绕过策略。
  改用等价手动步骤（见 docs/CODE-INDEX.md#windows）：
      $env:HOST = '127.0.0.1'
      $env:PORT = '0'
      $env:WORKBENCH_DATA_DIR = '<explicit data directory>'
      & '<node.exe>' '<release>\06-workbench\server\server.mjs'

.PARAMETER NodePath
  node.exe 的完整路径。默认使用 PATH 中的第一个 node.exe。

.PARAMETER DataDir
  显式工作台数据目录（缺失时由服务创建）。
  必填。路径是已存在文件时脚本会拒绝。

.PARAMETER Port
  回环端口，0..65535。默认 0（操作系统分配），不假定为 8787。

.PARAMETER MaxRunSeconds
  仅供验证的时限：N 秒后停止本脚本自有子进程并
  以 124 退出。默认 0 = 运行到服务退出（正常用途）。

.PARAMETER ScratchRoot
  可选、经调用者授权且专用于本次运行的工作区目录，用作
  预检探针目录的基目录。必须提供完整绝对路径：
  带驱动器的 `D:\dir` 或完整 UNC
  `\\server\share\dir`（必须同时有服务器和共享名）。在只读发布目录之外，
  在任何规范化之前按原样检查。
  相对、驱动器相对（`C:foo`）、根相对（`\foo`）、设备路径
  （`\\?\`、`//?/`）及不完整 UNC（`\\server`）会在创建任何内容前拒绝。
  参数值为空或纯空白时也会拒绝，
  不会静默回退到默认基目录。
  基目录本身绝不删除；只移除此脚本在其中创建的随机探针
  根目录，并且必须先验证至卷根目录的完整
  祖先链、真实路径和所有权清单。

.PARAMETER Help
  打印用法并以 0 退出。也可使用 Get-Help .\windows-start.ps1。

.EXAMPLE
  powershell -NoProfile -File scripts\windows-start.ps1 -NodePath C:\node.exe -DataDir D:\workbench-data -Port 0

.EXAMPLE
  powershell -NoProfile -File scripts\windows-start.ps1 -NodePath C:\node.exe -DataDir D:\workbench-data -Port 0 -MaxRunSeconds 5

.EXAMPLE
  powershell -NoProfile -File scripts\windows-start.ps1 -NodePath C:\node.exe -DataDir D:\workbench-data -Port 0 -ScratchRoot D:\workspace-scratch
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $false)]
  [string]$NodePath = "",

  [Parameter(Mandatory = $false)]
  [string]$DataDir = "",

  [Parameter(Mandatory = $false)]
  [ValidateRange(0, 65535)]
  [int]$Port = 0,

  [Parameter(Mandatory = $false)]
  [ValidateRange(0, 86400)]
  [int]$MaxRunSeconds = 0,

  [Parameter(Mandatory = $false)]
  [string]$ScratchRoot = "",

  [Parameter(Mandatory = $false)]
  [switch]$Help
)

$ErrorActionPreference = "Stop"

# 真实时限：预检探针到期后会被终止并回收；服务
# 停止路径绝不无限等待。
$PrecheckTimeoutMilliseconds = 30000
$StopWaitMilliseconds = 5000

if ($Help) {
  Write-Output "Usage: powershell -NoProfile -File scripts\windows-start.ps1 -NodePath <node.exe> -DataDir <explicit data dir> [-Port 0] [-MaxRunSeconds 0] [-ScratchRoot <workspace dir>]"
  Write-Output "HOST is always 127.0.0.1; PORT=0 lets the OS choose and the server prints the actual port."
  Write-Output "DataDir is required for a real start. No default data directory is used."
  Write-Output "The pre-check probe directory defaults to <workbench>\tmp\windows-delivery; use -ScratchRoot for a read-only release."
  Write-Output "-ScratchRoot must be a full absolute path (drive absolute like C:\work or a complete UNC \\server\share); relative, drive-relative (C:foo), root-relative (\foo), device paths and incomplete UNC values are rejected."
  Write-Output "The service process id is printed once as windows_start_service_pid=<pid>; stop only that id."
  Write-Output "A probe the pre-check cannot stop is reported as windows_start_residual_precheck_pid=<pid>, never as cleaned."
  exit 0
}

function Fail([string]$code, [int]$exitCode) {
  [Console]::Error.WriteLine("windows_start_error: $code")
  exit $exitCode
}

function Restore-Env([string]$name, $value) {
  if ($null -eq $value) {
    Remove-Item "Env:$name" -ErrorAction SilentlyContinue
  } else {
    Set-Item "Env:$name" $value
  }
}

function Resolve-FullPath([string]$path, [string]$fallbackCode) {
  try {
    if ([System.IO.Path]::IsPathRooted($path)) {
      return [System.IO.Path]::GetFullPath($path)
    }
    return [System.IO.Path]::GetFullPath((Join-Path (Get-Location).Path $path))
  } catch {
    Fail $fallbackCode 1
    return ""
  }
}

# 检查原始输入：只检查字符串本身，不做规范化。此处只有两种形式
# 被视为“绝对路径”，在 isAbsolute / IsPathRooted 之前决定：
# * 驱动器绝对路径：C:\... 或 C:/...
# * 完整 UNC：\\server\share[...]（服务器和共享名都不能为空）
# 拒绝相对路径、驱动器相对路径（`C:foo`）、根相对路径（`\foo`、`/foo`）、
# 设备路径（`\\?\`、`\\.\`，以及 `//?/`、`//./` 和混合斜杠变体，
# 包括 `\\?\UNC\...`）和不完整 UNC（`\\server`、`\\server\`）。
# 仅用 IsPathRooted 会接受后两种形式，后续 GetFullPath 又会将其
# 补全，因此这里只用字符串检查拒绝。不访问网络。
function Test-RawAbsolutePath([string]$path) {
  if ([string]::IsNullOrWhiteSpace($path)) { return $false }
  if ($path -ne $path.Trim()) { return $false }
  if ($path -match '^[\\/]{2}[?.][\\/]') { return $false }
  if ($path -match '^[A-Za-z]:(?![\\/])') { return $false }
  if ($path -match '^[A-Za-z]:[\\/]') { return $true }
  if ($path -match '^[\\/]{2}') {
    if ($path -notmatch '^[\\/]{2}([^\\/]+)[\\/]+([^\\/]+)') { return $false }
    return (($Matches[1] + $Matches[2]) -notmatch '[<>:"|?*]')
  }
  return $false
}

# 有时限的子进程：最多等待 $timeoutMs，再终止并回收。绝不
# 无限等待；子进程未回收时必须报告，不能静默遗留。
function Invoke-BoundedPrecheck([string]$exe, [string[]]$arguments, [int]$timeoutMs) {
  foreach ($item in (@($exe) + $arguments)) {
    if ($item -match '"') {
      return @{ started = $false; timedOut = $false; exited = $false; code = $null; invalid = "path_contains_quote" }
    }
  }
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $exe
  $quotedArgs = @()
  foreach ($item in $arguments) { $quotedArgs += ('"' + $item + '"') }
  $psi.Arguments = ($quotedArgs -join ' ')
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.CreateNoWindow = $true

  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $psi
  try {
    if (-not $process.Start()) {
      $process.Dispose()
      return @{ started = $false; timedOut = $false; exited = $false; code = $null; invalid = $null }
    }
  } catch {
    try { $process.Dispose() } catch { }
    return @{ started = $false; timedOut = $false; exited = $false; code = $null; invalid = "spawn_failed" }
  }

  $stdoutTask = $process.StandardOutput.ReadToEndAsync()
  $stderrTask = $process.StandardError.ReadToEndAsync()
  $finished = $process.WaitForExit($timeoutMs)
  if (-not $finished) {
    $childId = $process.Id
    try { $process.Kill() } catch { }
    $reaped = $process.WaitForExit($StopWaitMilliseconds)
    try { $process.Dispose() } catch { }
    return @{ started = $true; timedOut = $true; exited = $reaped; code = $null; invalid = $null; pid = $childId }
  }

  $stdout = ""
  try { $stdout = $stdoutTask.GetAwaiter().GetResult() } catch { $stdout = "" }
  $stderr = ""
  try { $stderr = $stderrTask.GetAwaiter().GetResult() } catch { $stderr = "" }
  $exitCode = $process.ExitCode
  try { $process.Dispose() } catch { }
  return @{ started = $true; timedOut = $false; exited = $true; code = $exitCode; stdout = $stdout; stderr = $stderr; invalid = $null }
}

# 仅通过本脚本自有 .NET 句柄停止本脚本创建的服务进程。
# 绝不回退到 Stop-Process -Id 或进程名匹配（存在 PID 复用风险）。
function Stop-OwnedService($process, [int]$waitMs) {
  if ($null -eq $process) { return @{ stopped = $true; reason = "no_child" } }
  try {
    if ($process.HasExited) { return @{ stopped = $true; reason = "already_exited" } }
  } catch { }
  try { $process.Kill() } catch { }
  $reaped = $false
  try { $reaped = $process.WaitForExit($waitMs) } catch { $reaped = $false }
  if ($reaped) { return @{ stopped = $true; reason = "killed" } }
  return @{ stopped = $false; reason = "still_running" }
}

$workbench = Split-Path -Parent $PSScriptRoot
$serverScript = Join-Path $workbench "server\server.mjs"
$checkScript = Join-Path $PSScriptRoot "windows-runtime-check.mjs"

if (-not (Test-Path -LiteralPath $serverScript -PathType Leaf)) {
  Fail "server_source_missing" 1
}
if (-not (Test-Path -LiteralPath $checkScript -PathType Leaf)) {
  Fail "runtime_check_missing" 1
}

if ([string]::IsNullOrWhiteSpace($DataDir)) {
  Fail "data_dir_required" 1
}

# 解析为绝对路径但不创建。绝不回退到默认数据目录。
$fullDataDir = Resolve-FullPath $DataDir "data_dir_invalid"

# -ScratchRoot 在任何规范化之前都必须已经是完整绝对路径：
# 此处拒绝相对/驱动器相对（`C:foo`）/根相对（`\foo`）输入、设备路径
# 及不完整 UNC，因此这些输入不能创建任何临时目录或业务数据库。
# 显式传入空值或纯空白值也会拒绝，
# 不会静默回退到默认临时根目录；只有
# “未提供参数”才表示“使用默认值”。
$scratchRootProvided = $PSBoundParameters.ContainsKey('ScratchRoot')
$fullScratchRoot = ""
if ($scratchRootProvided) {
  if (-not (Test-RawAbsolutePath $ScratchRoot)) {
    Fail "scratch_root_not_absolute" 1
  }
  $fullScratchRoot = Resolve-FullPath $ScratchRoot "scratch_root_invalid"
}

if ([string]::IsNullOrWhiteSpace($NodePath)) {
  $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($null -eq $nodeCommand) {
    $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
  }
  if ($null -eq $nodeCommand) {
    Fail "node_not_found" 1
  }
  $NodePath = $nodeCommand.Source
}

if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) {
  Fail "node_path_not_found" 1
}
$NodePath = [System.IO.Path]::GetFullPath($NodePath)

$checkArguments = @($checkScript, "--json", "--data-dir", $fullDataDir)
if ($fullScratchRoot -ne "") {
  $checkArguments += @("--scratch-root", $fullScratchRoot)
}

# 服务启动前必须完成运行时/目录预检，因此不支持的
# 运行时会在创建或迁移任何数据目录之前被拒绝。
$precheck = Invoke-BoundedPrecheck $NodePath $checkArguments $PrecheckTimeoutMilliseconds
if ($null -ne $precheck.invalid) {
  Fail ("runtime_check_invalid_argument:" + $precheck.invalid) 3
}
if (-not $precheck.started) {
  Fail "runtime_check_spawn_failed" 3
}
if (-not $precheck.exited) {
  # 已强杀但仍未回收：只报残留 pid，不假装已停止，也不无限等。
  [Console]::Error.WriteLine("windows_start_residual_precheck_pid=" + $precheck.pid)
  Fail "runtime_check_not_stopped" 3
}
if ($precheck.timedOut) {
  Fail "runtime_check_timeout" 2
}
if ($precheck.code -ne 0) {
  $code = "runtime_check_rejected"
  try {
    $parsedCheck = $precheck.stdout | ConvertFrom-Json
    if (-not [string]::IsNullOrWhiteSpace($parsedCheck.code)) { $code = $parsedCheck.code }
  } catch {
    $code = "runtime_check_rejected"
  }
  Fail ("runtime_check_rejected:" + $code) 2
}

$previousHost = $env:HOST
$previousPort = $env:PORT
$previousDataDir = $env:WORKBENCH_DATA_DIR
$child = $null
$servicePid = $null
$exitCode = 1

try {
  $env:HOST = "127.0.0.1"
  $env:PORT = [string]$Port
  $env:WORKBENCH_DATA_DIR = $fullDataDir

  # 通过句柄跟踪自有子进程。只停止此句柄/ID。
  $quoted = '"' + $serverScript.Replace('"', '\"') + '"'
  $child = Start-Process -FilePath $NodePath -ArgumentList $quoted -NoNewWindow -PassThru
  if ($null -eq $child) {
    [Console]::Error.WriteLine("windows_start_error: server_spawn_failed")
    $exitCode = 1
  } else {
    $servicePid = $child.Id
    Write-Output ("windows_start_service_pid=" + $servicePid)

    if ($MaxRunSeconds -gt 0) {
      # 仅供验证的路径：到期后只停止此子进程，并验证
      # 它确实退出，不能假设终止操作已成功。
      $finished = $child.WaitForExit($MaxRunSeconds * 1000)
      if (-not $finished) {
        $stop = Stop-OwnedService $child $StopWaitMilliseconds
        if (-not $stop.stopped) {
          [Console]::Error.WriteLine("windows_start_error: service_stop_failed")
          [Console]::Error.WriteLine("windows_start_residual_service_pid=" + $servicePid)
          $exitCode = 3
        } else {
          $exitCode = 124
        }
      } else {
        $exitCode = $child.ExitCode
      }
    } else {
      # 正常前台模式：服务拥有控制台生命周期；退出
      # 码原样传递（Ctrl+C 停止服务）。此等待
      # 刻意不设时限，因为这是服务运行过程，不是探针。
      $child.WaitForExit()
      $exitCode = $child.ExitCode
      if ($null -eq $exitCode) { $exitCode = 1 }
    }
  }
} catch {
  [Console]::Error.WriteLine("windows_start_error: server_start_failed")
  # 异常路径也只回收自有句柄；无法验证的停止
  # 应报告为残留，不得静默丢弃。
  $stop = Stop-OwnedService $child $StopWaitMilliseconds
  if (-not $stop.stopped) {
    [Console]::Error.WriteLine("windows_start_error: service_stop_failed")
    [Console]::Error.WriteLine("windows_start_residual_service_pid=" + $servicePid)
    $exitCode = 3
  } else {
    $exitCode = 1
  }
} finally {
  Restore-Env "HOST" $previousHost
  Restore-Env "PORT" $previousPort
  Restore-Env "WORKBENCH_DATA_DIR" $previousDataDir
  if ($null -ne $child) {
    # 只释放句柄，绝不向进程发送信号。上方打印的残留 PID
    # 仍是文档中唯一用于停止该进程的途径。
    try { $child.Dispose() } catch { }
  }
}

exit $exitCode
