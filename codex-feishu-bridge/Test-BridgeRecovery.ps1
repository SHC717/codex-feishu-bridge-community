param(
    [string]$ExpectedUserSid,[switch]$ConfirmLiveRecovery,
    [string]$InstallRoot=(Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'CodexFeishuBridge')
)
$ErrorActionPreference='Stop'
if (-not $ConfirmLiveRecovery -or -not $ExpectedUserSid) { throw 'This live recovery test briefly interrupts the bridge. Explicit -ConfirmLiveRecovery and independently verified -ExpectedUserSid are required.' }
. (Join-Path $PSScriptRoot 'Get-BridgeStatus.ps1') -Library
$config=Read-CFBDeployment $InstallRoot
if ($config.expectedUserSid -cne $ExpectedUserSid) { throw 'Expected test user does not match the installation.' }
[void](Assert-WindowsNativeContext -ExpectedUserSid $ExpectedUserSid -ExistingPath @($InstallRoot))
$status=Get-CFBStatus $InstallRoot
if (-not $status.workerReady -or -not $status.taskMatches -or -not $status.autoStartEnabled) { throw 'Live test requires a ready, verified, enabled bridge.' }
if ($status.pendingQuestions -gt 0) { throw 'Resolve pending phone questions before a recovery test.' }
$results=[Collections.Generic.List[object]]::new()
$reportRoot=Join-Path ([IO.Path]::GetTempPath()) ('CodexWork\AI-me\FeishuBridgeRepair-'+[DateTime]::Now.ToString('yyyyMMdd-HHmmss'))
[void][IO.Directory]::CreateDirectory($reportRoot);[void](Assert-CFBRealPath $reportRoot)
$reportPath=Join-Path $reportRoot 'recovery.json'
function Save-RecoveryReport {
    [IO.File]::WriteAllText($reportPath,(@{device=[Environment]::MachineName;release=$config.release;results=@($results.ToArray());observedAt=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json -Depth 7),[Text.UTF8Encoding]::new($false))
}
function Get-LiveHost {
    $log=Join-Path $InstallRoot 'logs\host.jsonl'
    $record=Get-Content -LiteralPath (Assert-CFBRealPath $log) -Encoding UTF8 | ForEach-Object { $_ | ConvertFrom-Json } | Where-Object event -eq 'windows_host_started' | Select-Object -Last 1
    if (-not $record) { return $null }
    try {
        $process=Get-Process -Id ([int]$record.hostPid) -ErrorAction Stop
        $details=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$record.hostPid) -ErrorAction Stop
        $age=(([DateTimeOffset]$record.at).UtcDateTime-$process.StartTime.ToUniversalTime()).TotalSeconds
        if ($process.Path -ine $config.pwshPath -or $details.CommandLine -notlike ('*'+(Join-Path $InstallRoot 'Run-Bridge.ps1')+'*') -or $age -lt 0 -or $age -gt 10) { return $null }
        return [pscustomobject]@{pid=$process.Id;creationTicks=$process.StartTime.ToUniversalTime().Ticks.ToString()}
    } catch { return $null }
}
function Assert-NoBridgeConsole {
    $windows=@(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and
        ($_.MainWindowTitle -ceq $config.pwshPath -or $_.ProcessName -eq 'NoWindowHost') })
    if ($windows.Count) { throw 'A visible bridge console/window was detected.' }
}
function Wait-Ready($PreviousHost=$null) {
    $deadline=[DateTime]::UtcNow.AddSeconds(150)
    do {
        $current=Get-CFBStatus $InstallRoot;$hostIdentity=Get-LiveHost;Assert-NoBridgeConsole
        $hostChanged=$null -eq $PreviousHost -or ($hostIdentity -and ($hostIdentity.pid -ne $PreviousHost.pid -or $hostIdentity.creationTicks -cne $PreviousHost.creationTicks))
        if ($current.workerReady -and $current.taskState -eq 'Running' -and $hostIdentity -and $hostChanged) { return $current }
        if ($current.stopRequested) { throw 'Unexpected persistent stop intent during recovery.' }
        Start-Sleep -Seconds 1
    } while ([DateTime]::UtcNow -lt $deadline)
    throw 'Automatic recovery was not confirmed within 150 seconds.'
}
function Add-RecoveryResult([string]$Case,[DateTime]$Started,$State) {
    $result=[pscustomobject]@{case=$Case;passed=$true;startedAt=$Started.ToString('o');readyAt=[DateTime]::UtcNow.ToString('o');seconds=[Math]::Round(([DateTime]::UtcNow-$Started).TotalSeconds,2);supervisorPid=$State.supervisorPid;workerPid=$State.workerPid;taskState=$State.taskState}
    $results.Add($result);Save-RecoveryReport;$result | ConvertTo-Json -Compress
}
$changed=$false
try {
    foreach ($case in @('worker_crash','supervisor_crash')) {
        $status=Get-CFBStatus $InstallRoot
        if ($status.pendingQuestions -gt 0) { throw 'A phone question arrived; recovery testing stopped before a further interruption.' }
        $record=Read-CFBJson (Assert-CFBRealPath (Join-Path $InstallRoot 'state\supervisor.json'))
        $worker=$case -eq 'worker_crash'
        if (-not (Test-CFBProcessIdentity $record $InstallRoot -Worker:$worker)) { throw 'Verified bridge process identity changed; no process stopped.' }
        $started=[DateTime]::UtcNow;$changed=$true
        $target=if ($worker) { [int]$record.workerPid } else { [int]$record.pid }
        Stop-Process -Id $target -ErrorAction Stop
        $recovered=Wait-Ready
        if (($worker -and $recovered.workerPid -eq $target) -or (-not $worker -and $recovered.instanceId -ceq $record.instanceId)) { throw 'Recovery did not replace the stopped instance.' }
        Add-RecoveryResult $case $started $recovered
    }
    $status=Get-CFBStatus $InstallRoot
    if ($status.pendingQuestions -gt 0) { throw 'A phone question arrived; outer-host test postponed.' }
    $hostIdentity=Get-LiveHost
    if (-not $hostIdentity) { throw 'Independent Windows host identity was not verified; no host stopped.' }
    [void](Get-CFBOwnedTask $config)
    $started=[DateTime]::UtcNow
    Stop-Process -Id $hostIdentity.pid -ErrorAction Stop
    $recovered=Wait-Ready $hostIdentity
    Add-RecoveryResult 'windows_host_crash' $started $recovered
    # The GUI launcher is now the independent scheduled-task process.
    $status=Get-CFBStatus $InstallRoot
    if ($status.pendingQuestions -gt 0) { throw 'A phone question arrived; launcher test postponed.' }
    $hostIdentity=Get-LiveHost
    $hostDetails=Get-CimInstance Win32_Process -Filter ('ProcessId='+$hostIdentity.pid)
    $launcher=Get-Process -Id $hostDetails.ParentProcessId -ErrorAction Stop
    try {
        if ($launcher.Path -ine (Get-CFBTaskExecutable $config)) { throw 'Launcher identity mismatch.' }
        $launcherDetails=Get-CimInstance Win32_Process -Filter ('ProcessId='+$launcher.Id)
        if ($launcherDetails.CommandLine -notlike ('*'+(Get-CFBTaskArguments $InstallRoot $config.pwshPath)+'*')) { throw 'Launcher arguments mismatch.' }
        $started=[DateTime]::UtcNow
        $launcher.Kill();$launcher.WaitForExit()
    } finally { $launcher.Dispose() }
    $recovered=Wait-Ready $hostIdentity
    Add-RecoveryResult 'gui_launcher_crash' $started $recovered
    $started=[DateTime]::UtcNow
    $before=Get-CFBStatus $InstallRoot
    Start-ScheduledTask -TaskName $config.taskName -TaskPath '\'
    Start-ScheduledTask -TaskName $config.taskName -TaskPath '\'
    Start-Sleep -Seconds 3
    $after=Wait-Ready
    if ($after.instanceId -cne $before.instanceId) { throw 'Repeated starts replaced the live instance.' }
    $launchers=@(Get-Process -Name NoWindowHost -ErrorAction SilentlyContinue | Where-Object Path -IEQ (Get-CFBTaskExecutable $config))
    if ($launchers.Count -ne 1) { throw 'Duplicate GUI launcher detected.' }
    Add-RecoveryResult 'repeated_start_single_instance' $started $after
    $started=[DateTime]::UtcNow
    & $config.pwshPath -NoLogo -NoProfile -NonInteractive -File (Join-Path $InstallRoot 'Stop-Bridge.ps1') -PauseOnly | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Intentional pause failed.' }
    # Longer than a full recovery-trigger interval; a pause must remain a pause.
    $pauseUntil=[DateTime]::UtcNow.AddSeconds(70)
    while ([DateTime]::UtcNow -lt $pauseUntil) {
        $paused=Get-CFBStatus $InstallRoot
        if ($paused.supervisorRunning -or $paused.workerRunning -or $paused.autoStartEnabled -or -not $paused.stopRequested) { throw 'An intentional pause was automatically undone.' }
        Start-Sleep -Seconds 2
    }
    Add-RecoveryResult 'pause_persists_beyond_minute' $started $paused
    $started=[DateTime]::UtcNow
    & $config.pwshPath -NoLogo -NoProfile -NonInteractive -File (Join-Path $InstallRoot 'Start-Bridge.ps1') | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Resume failed.' }
    $recovered=Wait-Ready
    Add-RecoveryResult 'resume' $started $recovered
    [ordered]@{ok=$true;reportPath=$reportPath;results=@($results.ToArray());finalStatus=$recovered} | ConvertTo-Json -Depth 8
} finally {
    if ($changed) {
        $final=Get-CFBStatus $InstallRoot
        if ($final.stopRequested -or -not $final.autoStartEnabled) {
            & $config.pwshPath -NoLogo -NoProfile -NonInteractive -File (Join-Path $InstallRoot 'Start-Bridge.ps1') | Out-Null
        }
    }
}
