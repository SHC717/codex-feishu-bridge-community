param(
    [string]$InstallRoot=(Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'CodexFeishuBridge'),
    [switch]$PauseOnly,[switch]$Force
)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'Get-BridgeStatus.ps1') -Library
$config=Read-CFBDeployment $InstallRoot
if (Get-CFBPackageContext) { throw 'Run the installed stop entry in an ordinary current-user context.' }
$task=Get-CFBOwnedTask $config
# Persist intent before disabling: even a trigger racing this call must stay stopped.
foreach ($name in @('stop.requested','worker-stop.requested')) {
    $file=Join-Path $InstallRoot ('state\'+$name)
    if (Test-Path -LiteralPath $file) { [void](Assert-CFBRealPath $file) }
    [IO.File]::WriteAllText($file,[DateTime]::UtcNow.ToString('o'),[Text.UTF8Encoding]::new($false))
}
Disable-ScheduledTask -TaskName $task.TaskName -TaskPath '\' | Out-Null
$deadline=[DateTime]::UtcNow.AddSeconds(60)
do {
    $status=Get-CFBStatus $InstallRoot
    if (-not $status.supervisorRunning -and -not $status.workerRunning -and $status.taskState -ne 'Running') {
        $status | ConvertTo-Json -Depth 8;return
    }
    Start-Sleep -Milliseconds 500
} while ([DateTime]::UtcNow -lt $deadline)
if ($Force) {
    $record=Read-CFBJson (Join-Path $InstallRoot 'state\supervisor.json')
    if (Test-CFBProcessIdentity $record $InstallRoot -Worker) { Stop-Process -Id ([int]$record.workerPid) -ErrorAction Stop }
    if (Test-CFBProcessIdentity $record $InstallRoot) { Stop-Process -Id ([int]$record.pid) -ErrorAction Stop }
    # Only the previously verified owned task can be stopped, never by process name.
    Stop-ScheduledTask -TaskName $task.TaskName -TaskPath '\'
    Start-Sleep -Milliseconds 500
    Get-CFBStatus $InstallRoot | ConvertTo-Json -Depth 8;return
}
throw 'Stop intent is persistent and supervision disabled; graceful shutdown has not yet completed. No unverified process was stopped.'
