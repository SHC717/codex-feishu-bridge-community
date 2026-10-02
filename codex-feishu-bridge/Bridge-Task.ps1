# Windows owns the outer host; this file never starts a process from Codex.
function Get-CFBTaskName([string]$Sid) {
    if ($Sid -notmatch '^S-1-5-21-\d+-\d+-\d+-\d+$') { throw 'A verified local user SID is required for the task name.' }
    return '飞书桥-' + $Sid
}
function Get-CFBLegacyTaskArguments([string]$Root) {
    '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -File ' +
        (Quote-CFBArgument (Join-Path $Root 'Run-Bridge.ps1')) + ' -InstallRoot ' + (Quote-CFBArgument $Root)
}
function Get-CFBTaskArguments([string]$Root,[string]$PwshPath) {
    (Quote-CFBArgument $PwshPath)+' '+(Quote-CFBArgument 'Run-Bridge.ps1')+' '+(Quote-CFBArgument $Root)
}
function Get-CFBTaskExecutable($Config) { Join-Path $Config.installRoot 'NoWindowHost.exe' }
function Get-CFBTaskDescription { '飞书桥 | CodexFeishuBridge | current-user supervision v2 no-console' }
function Get-CFBPrincipalSid([string]$Identity) {
    if ($Identity -match '^S-\d-') { return $Identity }
    try { return ([Security.Principal.NTAccount]::new($Identity)).Translate([Security.Principal.SecurityIdentifier]).Value }
    catch { return '' }
}
function Test-CFBTaskOwnership($Task,$Config,[switch]$AllowLegacy) {
    if ($null -eq $Task) { return $false }
    $actions=@($Task.Actions)
    if ($actions.Count -ne 1) { return $false }
    $current=$Task.Description -ceq (Get-CFBTaskDescription) -and
        [string]::Equals($actions[0].Execute,(Get-CFBTaskExecutable $Config),[StringComparison]::OrdinalIgnoreCase) -and
        $actions[0].Arguments -ceq (Get-CFBTaskArguments $Config.installRoot $Config.pwshPath)
    $legacy=$AllowLegacy -and $Task.Description -ceq '飞书桥 | CodexFeishuBridge | current-user supervision v1' -and
        [string]::Equals($actions[0].Execute,$Config.pwshPath,[StringComparison]::OrdinalIgnoreCase) -and
        $actions[0].Arguments -ceq (Get-CFBLegacyTaskArguments $Config.installRoot)
    return $Task.TaskName -ceq (Get-CFBTaskName $Config.expectedUserSid) -and $Task.TaskPath -eq '\' -and
        ($current -or $legacy) -and
        [string]::Equals($actions[0].WorkingDirectory,$Config.installRoot,[StringComparison]::OrdinalIgnoreCase) -and
        (Get-CFBPrincipalSid $Task.Principal.UserId) -ceq $Config.expectedUserSid -and
        [string]$Task.Principal.LogonType -in @('Interactive','InteractiveToken') -and
        [string]$Task.Principal.RunLevel -in @('Limited','LUA')
}
function Test-CFBTaskRecovery($Task,$Config) {
    if (-not (Test-CFBTaskOwnership $Task $Config)) { return $false }
    $logon=@($Task.Triggers | Where-Object { $_.CimClass.CimClassName -eq 'MSFT_TaskLogonTrigger' })
    $periodic=@($Task.Triggers | Where-Object { $_.CimClass.CimClassName -eq 'MSFT_TaskTimeTrigger' })
    $settings=$Task.Settings
    return @($Task.Triggers).Count -eq 2 -and $logon.Count -eq 1 -and $periodic.Count -eq 1 -and
        (Get-CFBPrincipalSid $logon[0].UserId) -ceq $Config.expectedUserSid -and $logon[0].Enabled -and
        $periodic[0].Enabled -and $periodic[0].Repetition.Interval -eq 'PT1M' -and
        -not $periodic[0].Repetition.Duration -and -not $periodic[0].EndBoundary -and
        [string]$settings.MultipleInstances -eq 'IgnoreNew' -and $settings.ExecutionTimeLimit -eq 'PT0S' -and
        $settings.StartWhenAvailable -and -not $settings.DisallowStartIfOnBatteries -and
        -not $settings.StopIfGoingOnBatteries -and -not $settings.RunOnlyIfIdle -and
        [int]$settings.RestartCount -ge 3 -and $settings.RestartInterval -eq 'PT1M'
}
function Get-CFBTaskReport($Config) {
    $task=Get-ScheduledTask -TaskName (Get-CFBTaskName $Config.expectedUserSid) -TaskPath '\' -ErrorAction SilentlyContinue
    [pscustomobject]@{ name=(Get-CFBTaskName $Config.expectedUserSid);present=($null -ne $task)
        owned=(Test-CFBTaskOwnership $task $Config);matches=(Test-CFBTaskRecovery $task $Config)
        enabled=($null -ne $task -and [bool]$task.Settings.Enabled);state=[string]$task.State }
}
function Get-CFBOwnedTask($Config) {
    $task=Get-ScheduledTask -TaskName (Get-CFBTaskName $Config.expectedUserSid) -TaskPath '\' -ErrorAction SilentlyContinue
    if (-not (Test-CFBTaskOwnership $task $Config)) { throw 'Independent supervision task is missing or not owned by this installation.' }
    return $task
}
function New-CFBTaskDefinition($Config) {
    $action=New-ScheduledTaskAction -Execute (Get-CFBTaskExecutable $Config) -Argument (Get-CFBTaskArguments $Config.installRoot $Config.pwshPath) -WorkingDirectory $Config.installRoot
    $logon=New-ScheduledTaskTrigger -AtLogOn -User $Config.expectedUserSid
    # No Duration or EndBoundary: recovery remains active after the first day.
    $recovery=New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval ([TimeSpan]::FromMinutes(1))
    $settings=New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval ([TimeSpan]::FromMinutes(1))
    $principal=New-ScheduledTaskPrincipal -UserId $Config.expectedUserSid -LogonType Interactive -RunLevel Limited
    New-ScheduledTask -Action $action -Trigger @($logon,$recovery) -Settings $settings -Principal $principal -Description (Get-CFBTaskDescription)
}
function Register-CFBTask($Config,[switch]$AllowLegacy) {
    $name=Get-CFBTaskName $Config.expectedUserSid
    $existing=Get-ScheduledTask -TaskName $name -TaskPath '\' -ErrorAction SilentlyContinue
    if ($existing -and -not (Test-CFBTaskOwnership $existing $Config -AllowLegacy:$AllowLegacy)) { throw 'Existing supervision task belongs to something else; no task was replaced.' }
    $definition=New-CFBTaskDefinition $Config
    # Keep the task disabled until the installation and shortcuts are verified.
    $definition.Settings.Enabled=$false
    Register-ScheduledTask -TaskName $name -TaskPath '\' -InputObject $definition -Force | Out-Null
    $report=Get-CFBTaskReport $Config
    if (-not $report.matches) { throw 'Independent supervision task readback failed.' }
}
function Stop-CFBOrphanWorker($Config) {
    $recordPath=Join-Path $Config.installRoot 'state\supervisor.json'
    if (-not (Test-Path -LiteralPath $recordPath)) { return }
    [void](Assert-CFBRealPath $recordPath)
    $record=Read-CFBJson $recordPath
    if (Test-CFBProcessIdentity $record $Config.installRoot) { throw 'A verified supervisor is already running.' }
    if (-not (Test-CFBProcessIdentity $record $Config.installRoot -Worker)) { return }
    # Preserve in-flight reply reconciliation and allow the owned orphan to drain.
    $workerStop=Join-Path $Config.installRoot 'state\worker-stop.requested'
    [IO.File]::WriteAllText($workerStop,[DateTime]::UtcNow.ToString('o'),[Text.UTF8Encoding]::new($false))
    $deadline=[DateTime]::UtcNow.AddSeconds(45)
    while ((Test-CFBProcessIdentity $record $Config.installRoot -Worker) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 500 }
    if (Test-CFBProcessIdentity $record $Config.installRoot -Worker) { Stop-Process -Id ([int]$record.workerPid) -ErrorAction Stop }
    if (Test-CFBProcessIdentity $record $Config.installRoot -Worker) { throw 'The owned orphan worker has not stopped.' }
}
