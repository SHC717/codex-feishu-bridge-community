param(
    [string]$InstallRoot = (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'CodexFeishuBridge'),
    [switch]$Library
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Bridge-Environment.ps1')
. (Join-Path $PSScriptRoot 'Bridge-Task.ps1')

if (-not ('CodexFeishuBridge.NativePaths' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
namespace CodexFeishuBridge {
  public static class NativePaths {
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    public static extern SafeFileHandle CreateFileW(string path, uint access, uint share,
      IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    public static extern uint GetFinalPathNameByHandleW(SafeFileHandle file, StringBuilder path, uint size, uint flags);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode)]
    public static extern int GetCurrentPackageFullName(ref uint length, IntPtr name);
  }
}
'@
}

function Get-CFBPackageContext {
    [uint32]$length = 0
    $code = [CodexFeishuBridge.NativePaths]::GetCurrentPackageFullName([ref]$length, [IntPtr]::Zero)
    if ($code -eq 15700) { return $false }
    if ($code -in @(0, 122)) { return $true }
    throw "Cannot determine Windows package identity: $code"
}

function Get-CFBFinalPath([string]$Path) {
    $handle = [CodexFeishuBridge.NativePaths]::CreateFileW($Path, 0, 7, [IntPtr]::Zero, 3, 0x02000000, [IntPtr]::Zero)
    if ($handle.IsInvalid) {
        $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
        $handle.Dispose()
        throw "Cannot open a verification handle for '$Path' (Win32 $errorCode)"
    }
    try {
        $buffer = [Text.StringBuilder]::new(32768)
        $count = [CodexFeishuBridge.NativePaths]::GetFinalPathNameByHandleW($handle, $buffer, $buffer.Capacity, 0)
        if ($count -eq 0 -or $count -ge $buffer.Capacity) { throw "Cannot resolve final path for '$Path'" }
        $resolved = $buffer.ToString()
        if ($resolved.StartsWith('\\?\UNC\')) { $resolved = '\\' + $resolved.Substring(8) }
        elseif ($resolved.StartsWith('\\?\')) { $resolved = $resolved.Substring(4) }
        return [IO.Path]::GetFullPath($resolved).TrimEnd('\')
    } finally { $handle.Dispose() }
}

function Assert-CFBRealPath([string]$Path) {
    $expected = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    $actual = Get-CFBFinalPath $Path
    if (-not [string]::Equals($expected, $actual, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Redirected path refused: expected '$expected'; actual '$actual'"
    }
    return $actual
}

function Assert-CFBInstallRoot([string]$Root) {
    $expected = (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'CodexFeishuBridge')
    if (-not [string]::Equals([IO.Path]::GetFullPath($Root).TrimEnd('\'), $expected, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'This deployment is scoped only to the approved CodexFeishuBridge directory.'
    }
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'Windows is required.' }
}

function Get-CFBStartupLink {
    return Join-Path ([Environment]::GetFolderPath('Startup')) 'CodexFeishuBridge.lnk'
}

function Quote-CFBArgument([string]$Value) {
    if ($Value.Contains('"') -or $Value.Contains("`r") -or $Value.Contains("`n")) { throw 'Unsupported quote/newline in lifecycle argument.' }
    return '"' + $Value.TrimEnd('\') + '"'
}

function Get-CFBStartupArguments([string]$Root) {
    return '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -File ' +
        (Quote-CFBArgument (Join-Path $Root 'Start-Bridge.ps1')) + ' -InstallRoot ' + (Quote-CFBArgument $Root)
}

function Read-CFBJson([string]$Path) {
    # Permit atomic replacement while status readers hold a handle on Windows.
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read,
        ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
    $reader = [IO.StreamReader]::new($stream, [Text.Encoding]::UTF8, $true)
    try { return ($reader.ReadToEnd() | ConvertFrom-Json) }
    finally { $reader.Dispose(); $stream.Dispose() }
}

function Read-CFBDeployment([string]$Root, [switch]$ForUpdate) {
    Assert-CFBInstallRoot $Root
    [void](Assert-CFBRealPath $Root)
    $configPath = Join-Path $Root 'deployment.json'
    [void](Assert-CFBRealPath $configPath)
    $config = Read-CFBJson $configPath
    if ($config.schema -ne 2 -or $config.installRoot -ne $Root -or $config.application -ne 'CodexFeishuBridge') {
        throw 'Deployment identity is invalid.'
    }
    if ($config.deviceName -cne [Environment]::MachineName -or -not $config.expectedUserSid) { throw 'Deployment belongs to a different device or user.' }
    [void](Assert-WindowsNativeContext -ExpectedUserSid $config.expectedUserSid -ExistingPath @($Root))
    if ($config.profileName -notmatch '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$' -or $config.recipient -notmatch '^ou_[A-Za-z0-9]+$') { throw 'Invalid local bot configuration.' }
    $names = @($config.files | ForEach-Object name)
    if ($names.Count -eq 0 -or @($names | Select-Object -Unique).Count -ne $names.Count) { throw 'Invalid deployment manifest.' }
    $requiredNames = @(Get-CFBRuntimeNames)
    if ($ForUpdate -and $config.release -in @('1.0.0','1.1.0','1.1.1','1.2.0')) { $requiredNames = @($requiredNames | Where-Object { $_ -notin @('health-notifier.mjs','supervisor-health.mjs') }) }
    if ($ForUpdate -and $config.release -in @('1.0.0','1.1.0','1.1.1')) { $requiredNames = @($requiredNames | Where-Object { $_ -notin @('result-format.mjs','message-routing.mjs') }) }
    if ([bool]$config.interactionChatId -ne [bool]$config.resultChatId -or ($config.interactionChatId -and ($config.interactionChatId -cnotmatch '^oc_[A-Za-z0-9]+$' -or $config.resultChatId -cnotmatch '^oc_[A-Za-z0-9]+$' -or $config.interactionChatId -ceq $config.resultChatId))) { throw 'Invalid classification chat configuration.' }
    if ($ForUpdate -and $config.release -in @('1.0.0','1.1.0')) { $requiredNames = @($requiredNames | Where-Object { $_ -notin @('NoWindowHost.cs','Build-NoWindowHost.ps1','NoWindowHost.exe') }) }
    if ($ForUpdate -and $config.release -eq '1.0.0') { $requiredNames = @($requiredNames | Where-Object { $_ -notin @('Bridge-Task.ps1','Run-Bridge.ps1') }) }
    elseif ($config.appId -notmatch '^cli_[A-Za-z0-9]+$' -or $config.taskName -cne (Get-CFBTaskName $config.expectedUserSid)) { throw 'Missing application binding or Windows supervision identity.' }
    foreach ($required in $requiredNames) { if ($required -notin $names) { throw "Missing manifest entry: $required" } }
    foreach ($directory in @('state', 'logs')) { [void](Assert-CFBRealPath (Join-Path $Root $directory)) }
    foreach ($file in $config.files) {
        if ([IO.Path]::GetFileName($file.name) -ne $file.name) { throw 'Unsafe deployment manifest name.' }
        $path = Join-Path $Root $file.name
        [void](Assert-CFBRealPath $path)
        if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ne $file.sha256) { throw "Deployment file hash mismatch: $($file.name)" }
    }
    return $config
}

function Test-CFBProcessIdentity($Record, [string]$Root, [switch]$Worker) {
    if ($null -eq $Record) { return $false }
    $processId = if ($Worker) { $Record.workerPid } else { $Record.pid }
    $creationTicks = if ($Worker) { $Record.workerCreatedAtTicks } else { $Record.createdAtTicks }
    $entry = if ($Worker) { 'bridge-worker.mjs' } else { 'supervisor.mjs' }
    if ($null -eq $processId -or $null -eq $creationTicks -or [int]$processId -le 0) { return $false }
    try {
        $process = Get-Process -Id ([int]$processId) -ErrorAction Stop
        if ($process.StartTime.ToUniversalTime().Ticks.ToString() -ne [string]$creationTicks) { return $false }
        if (-not [string]::Equals($process.Path, $Record.nodePath, [StringComparison]::OrdinalIgnoreCase)) { return $false }
        $details = Get-CimInstance Win32_Process -Filter "ProcessId=$processId" -ErrorAction Stop
        if ($details.CommandLine -notlike ('*' + (Join-Path $Root $entry) + '*')) { return $false }
        if ($Worker -and $details.ParentProcessId -ne $Record.pid) { return $false }
        return $true
    } catch { return $false }
}

function Get-CFBStatus([string]$Root) {
    $config = Read-CFBDeployment $Root
    $linkPath = Get-CFBStartupLink
    $linkPresent = Test-Path -LiteralPath $linkPath -PathType Leaf
    $linkMatches = $false
    if ($linkPresent) {
        [void](Assert-CFBRealPath $linkPath)
        $shell = New-Object -ComObject WScript.Shell
        $shortcut = $shell.CreateShortcut($linkPath)
        $linkMatches = [string]::Equals($shortcut.TargetPath, $config.pwshPath, [StringComparison]::OrdinalIgnoreCase) -and
            $shortcut.Arguments -eq (Get-CFBStartupArguments $Root) -and
            [string]::Equals($shortcut.WorkingDirectory, $Root, [StringComparison]::OrdinalIgnoreCase)
        [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut) | Out-Null
        [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) | Out-Null
    }
    $recordPath = Join-Path $Root 'state\supervisor.json'
    $record = $null
    if (Test-Path -LiteralPath $recordPath -PathType Leaf) {
        [void](Assert-CFBRealPath $recordPath)
        $record = Read-CFBJson $recordPath
    }
    $workerRunning = Test-CFBProcessIdentity $record $Root -Worker
    $workerHealth = $null
    $healthPath = Join-Path $Root 'state\worker-health.json'
    if (Test-Path -LiteralPath $healthPath -PathType Leaf) {
        [void](Assert-CFBRealPath $healthPath)
        $workerHealth = Read-CFBJson $healthPath
    }
    $supervisorRunning = Test-CFBProcessIdentity $record $Root
    $taskReport = Get-CFBTaskReport $config
    $workerReady = $supervisorRunning -and $workerRunning -and $workerHealth.status -eq 'running' -and
        $workerHealth.pid -eq $record.workerPid -and
        ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - [long]$workerHealth.updatedAt) -lt 30000
    if ('supervisor-health.mjs' -in @($config.files | ForEach-Object name)) { $workerReady = $workerReady -and $workerHealth.health.running -and $workerHealth.health.connected -and $workerHealth.health.freshStateCount -gt 0 -and $workerHealth.health.unfreshSubscribedCount -eq 0 -and ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - [long]$workerHealth.health.metadataUpdatedAt) -lt 60000 }
    return [ordered]@{
        application = 'CodexFeishuBridge'; installRoot = $Root; realPathVerified = $true
        displayName = '飞书桥'; notificationMode = (Get-CFBCompatibility).notificationMode; taskName = $taskReport.name; taskPresent = $taskReport.present
        noConsoleStartup = $taskReport.matches; taskMatches = $taskReport.matches; autoStartEnabled = $taskReport.enabled; taskState = $taskReport.state
        release = $config.release; device = $config.deviceName; profileName = $config.profileName; codexVersion = $(if ($workerReady -and $workerHealth.health.codexVersion) { $workerHealth.health.codexVersion } else { $null }); installedAgainstCodexVersion = $config.codexVersion
        packageContext = Get-CFBPackageContext; runtimeHashesVerified = $true
        startupLink = $linkPath; startupPresent = $linkPresent; startupMatches = $linkMatches
        supervisorRunning = $supervisorRunning
        workerRunning = $workerRunning; workerReady = [bool]$workerReady
        watchedTasks = $workerHealth.health.freshStateCount; knownTasks = $workerHealth.health.knownUserThreadCount
        pendingQuestions = $workerHealth.pendingQuestions
        stopRequested = Test-Path -LiteralPath (Join-Path $Root 'state\stop.requested')
        faultNotification = $record.notification; connectionHealth = $record.connectionHealth
        phase = $record.phase; instanceId = $record.instanceId; supervisorPid = $record.pid
        workerPid = $record.workerPid; heartbeatAt = $record.heartbeatAt
        channelState = $(if ($workerReady) { 'ready' } elseif (Test-Path -LiteralPath (Join-Path $Root 'state\stop.requested')) { 'paused' } elseif ($supervisorRunning) { 'reconnecting_or_waiting_for_codex' } else { 'stopped' })
    }
}

if ($Library) { return }
Get-CFBStatus $InstallRoot | ConvertTo-Json -Depth 6
