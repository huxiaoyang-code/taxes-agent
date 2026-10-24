<#
.SYNOPSIS
  Start the local Youshu workbench from source with an explicit Node path, data
  directory and port. Runs the runtime pre-check first.

.DESCRIPTION
  This script is compatible with Windows PowerShell 5.1 (it does not require
  PowerShell 7 / pwsh). It never changes the machine PATH, registry, execution
  policy or firewall.

  It always binds HOST=127.0.0.1 (loopback only). PORT=0 asks the OS for a free
  port; the actual port is printed by the server. Data is stored under the
  explicit -DataDir; no default data directory is read.

  The runtime pre-check runs as a bounded child (real deadline, then kill and
  reap) so a hanging probe cannot block the launcher forever. The probe scratch
  directory defaults to `<this workbench>\tmp\windows-delivery`; pass
  -ScratchRoot when the release directory is read-only or when a workspace path
  is required.

  The service itself runs unbounded in normal foreground use. Only when
  -MaxRunSeconds is given (verification use) is it stopped at the bound.

  Process ownership: this script starts exactly one service process, records its
  id and prints one line `windows_start_service_pid=<pid>`. Stop only that id.
  All stop paths (normal exit, -MaxRunSeconds bound, and exception) use only this
  script's own System.Diagnostics.Process handle; nothing is stopped by process
  name. Terminating this wrapper from outside can leave that service running;
  that is why the id is printed (the wrapper cannot clean up after being
  killed). If a stop cannot be verified, the script reports
  `service_stop_failed` and `windows_start_residual_service_pid=<pid>` instead of
  claiming success.

  If your organization blocks local script execution, do not bypass the policy.
  Use the equivalent manual steps instead (see docs/CODE-INDEX.md#windows):
      $env:HOST = '127.0.0.1'
      $env:PORT = '0'
      $env:WORKBENCH_DATA_DIR = '<explicit data directory>'
      & '<node.exe>' '<release>\06-workbench\server\server.mjs'

.PARAMETER NodePath
  Full path to node.exe. Defaults to the first node.exe on PATH.

.PARAMETER DataDir
  Explicit workbench data directory (created by the server if missing).
  Required. The script refuses a path that is an existing file.

.PARAMETER Port
  Loopback port, 0..65535. Default 0 (OS-assigned). 8787 is not assumed.

.PARAMETER MaxRunSeconds
  Verification-only bound: stop this script's own child after N seconds and
  exit 124. Default 0 = run until the service exits (normal use).

.PARAMETER ScratchRoot
  Optional, caller-authorized workspace directory dedicated to this run; used as
  the base of the pre-check probe directory. Must be given as a full absolute
  path: drive-qualified like `D:\dir` or a **complete UNC**
  `\\server\share\dir` (both server and share required). Checked as-is
  **before any normalization** outside the read-only release directory.
  Relative, drive-relative (`C:foo`), root-relative (`\foo`), device paths
  (`\\?\`, `//?/`) and incomplete UNC (`\\server`) values are rejected before
  anything is created. Supplying the parameter with an empty or whitespace-only
  value is rejected too, instead of silently falling back to the default base.
  The base itself is never deleted; only the random probe
  root this script creates inside it is removed, and only after the full
  ancestor chain to the volume root, the realpath and the ownership manifest all
  verify.

.PARAMETER Help
  Print usage and exit 0. Also available as Get-Help .\windows-start.ps1.

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

# Real bounds: the pre-check probe is killed and reaped after this, the service
# stop path never waits without a limit.
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

# Raw input check: only the string itself, no normalization. Only two shapes
# count as "absolute" here, decided before isAbsolute / IsPathRooted:
#   * drive absolute: C:\... or C:/...
#   * complete UNC: \\server\share[...] (both server and share non-empty)
# Rejects relative paths, drive-relative (`C:foo`), root-relative (`\foo`, `/foo`),
# device paths (`\\?\`, `\\.\` and the `//?/`, `//./`, mixed-slash variants,
# including `\\?\UNC\...`) and incomplete UNC (`\\server`, `\\server\`).
# IsPathRooted alone would accept the last two and a later GetFullPath would
# promote them, so they are refused by string test only. No network access here.
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

# Bounded child: waits at most $timeoutMs, then kills and reaps. Never waits
# without a limit and never leaves a child unreaped without reporting it.
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

# Stop only the service process this script created, using its own .NET handle.
# Never falls back to Stop-Process -Id / process-name matching (PID reuse risk).
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

# Resolve to an absolute path without creating it. Never fall back to a default data dir.
$fullDataDir = Resolve-FullPath $DataDir "data_dir_invalid"

# -ScratchRoot must already be a **full absolute path before any normalization**:
# relative / drive-relative (`C:foo`) / root-relative (`\foo`) inputs, device paths
# and incomplete UNC are rejected here, so no scratch directory and no business DB
# can be created from them. An explicitly supplied empty / whitespace-only value is
# also rejected instead of silently falling back to the default scratch root: only
# "parameter not supplied" means "use the default".
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

# Runtime / directory pre-check must finish before the service is started, so an
# unsupported runtime is rejected before any data directory is created or migrated.
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

  # Track our own child by handle. Only this handle/id is ever stopped.
  $quoted = '"' + $serverScript.Replace('"', '\"') + '"'
  $child = Start-Process -FilePath $NodePath -ArgumentList $quoted -NoNewWindow -PassThru
  if ($null -eq $child) {
    [Console]::Error.WriteLine("windows_start_error: server_spawn_failed")
    $exitCode = 1
  } else {
    $servicePid = $child.Id
    Write-Output ("windows_start_service_pid=" + $servicePid)

    if ($MaxRunSeconds -gt 0) {
      # Verification-only path: stop only this child after the bound, and verify
      # it really exited instead of assuming the kill worked.
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
      # Normal foreground mode: the service owns the console lifetime; its exit
      # code is propagated unchanged (Ctrl+C stops the service). This wait is
      # intentionally unbounded - it is the service runtime, not a probe.
      $child.WaitForExit()
      $exitCode = $child.ExitCode
      if ($null -eq $exitCode) { $exitCode = 1 }
    }
  }
} catch {
  [Console]::Error.WriteLine("windows_start_error: server_start_failed")
  # Exception path also reclaims only our own handle; a stop that cannot be
  # verified is reported as residual instead of being silently dropped.
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
    # Release only the handle; this never signals the process. A residual pid
    # printed above stays the single documented way to stop it.
    try { $child.Dispose() } catch { }
  }
}

exit $exitCode
