param([string]$InstallRoot=(Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'CodexFeishuBridge'))
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'Get-BridgeStatus.ps1') -Library
$config=Read-CFBDeployment $InstallRoot
if (Get-CFBPackageContext) { throw 'Run the installed start entry in an ordinary current-user context.' }
$task=Get-CFBOwnedTask $config
if (-not (Test-CFBTaskRecovery $task $config)) { throw 'The supervision task needs repair; startup was not changed.' }
foreach ($name in @('stop.requested','worker-stop.requested')) {
    $file=Join-Path $InstallRoot ('state\'+$name)
    if (Test-Path -LiteralPath $file) { [void](Assert-CFBRealPath $file);Remove-Item -LiteralPath $file -Force }
}
Enable-ScheduledTask -TaskName $task.TaskName -TaskPath '\' | Out-Null
Start-ScheduledTask -TaskName $task.TaskName -TaskPath '\'
$deadline=[DateTime]::UtcNow.AddSeconds(45)
do {
    Start-Sleep -Milliseconds 500
    $status=Get-CFBStatus $InstallRoot
    if ($status.workerReady) { $status | ConvertTo-Json -Depth 8;return }
} while ([DateTime]::UtcNow -lt $deadline)
$status | ConvertTo-Json -Depth 8
if (-not $status.supervisorRunning) { throw 'Windows supervision was enabled, but a supervisor was not confirmed. Inspect this bridge host log.' }
# Waiting for a closed/disconnected Codex is a real state, not a successful channel.
