$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'Get-BridgeStatus.ps1') -Library
$count=0
function Check([bool]$Value,[string]$Message) { if (-not $Value) { throw $Message };$script:count++ }
# Synthetic identity; no task is registered, enabled or started by these tests.
$config=[pscustomobject]@{expectedUserSid='S-1-5-21-101-202-303-1000';installRoot='D:\fixture\bridge';pwshPath='D:\fixture\pwsh.exe'}
function Fixture {
    [pscustomobject]@{TaskName=(Get-CFBTaskName $config.expectedUserSid);TaskPath='\';Description=(Get-CFBTaskDescription)
        Principal=[pscustomobject]@{UserId=$config.expectedUserSid;LogonType='Interactive';RunLevel='Limited'}
        Actions=@([pscustomobject]@{Execute=(Get-CFBTaskExecutable $config);Arguments=(Get-CFBTaskArguments $config.installRoot $config.pwshPath);WorkingDirectory=$config.installRoot})
        Triggers=@([pscustomobject]@{CimClass=[pscustomobject]@{CimClassName='MSFT_TaskLogonTrigger'};UserId=$config.expectedUserSid;Enabled=$true},
            [pscustomobject]@{CimClass=[pscustomobject]@{CimClassName='MSFT_TaskTimeTrigger'};Enabled=$true;EndBoundary='';Repetition=[pscustomobject]@{Interval='PT1M';Duration=''}})
        Settings=[pscustomobject]@{MultipleInstances='IgnoreNew';ExecutionTimeLimit='PT0S';StartWhenAvailable=$true;DisallowStartIfOnBatteries=$false;StopIfGoingOnBatteries=$false;RunOnlyIfIdle=$false;RestartCount=3;RestartInterval='PT1M'}}
}
$legacy=Fixture;$legacy.Description='飞书桥 | CodexFeishuBridge | current-user supervision v1';$legacy.Actions[0].Execute=$config.pwshPath;$legacy.Actions[0].Arguments=Get-CFBLegacyTaskArguments $config.installRoot
Check (-not (Test-CFBTaskOwnership $legacy $config)) 'Legacy console host accepted for normal operation.'
Check (Test-CFBTaskOwnership $legacy $config -AllowLegacy) 'Verified v1 task rejected for explicit migration.'
$legacy.Actions[0].Arguments+=' -Command unexpected'
Check (-not (Test-CFBTaskOwnership $legacy $config -AllowLegacy)) 'Altered legacy task accepted for migration.'
$task=Fixture;Check (Test-CFBTaskRecovery $task $config) 'Verified recovery fixture was rejected.'
Check (-not (Test-CFBTaskOwnership $null $config)) 'Missing task accepted.'
foreach ($field in @('Execute','Arguments','WorkingDirectory')) {
    $task=Fixture;$task.Actions[0].$field='someone else';Check (-not (Test-CFBTaskOwnership $task $config)) "Foreign action $field accepted."
}
$task=Fixture;$task.Actions+=@($task.Actions[0]);Check (-not (Test-CFBTaskOwnership $task $config)) 'Extra action accepted.'
$task=Fixture;$task.Principal.UserId='S-1-5-21-101-202-303-9999';Check (-not (Test-CFBTaskOwnership $task $config)) 'Other user accepted.'
$task=Fixture;$task.Principal.RunLevel='Highest';Check (-not (Test-CFBTaskOwnership $task $config)) 'Elevated task accepted.'
$task=Fixture;$task.Principal.LogonType='ServiceAccount';Check (-not (Test-CFBTaskOwnership $task $config)) 'Service account accepted.'
$task=Fixture;$task.Description='unrelated';Check (-not (Test-CFBTaskOwnership $task $config)) 'Foreign task description accepted.'
$task=Fixture;$task.Triggers[1].Repetition.Duration='P1D';Check (-not (Test-CFBTaskRecovery $task $config)) 'One-day expiration accepted.'
$task=Fixture;$task.Triggers[1].EndBoundary='2026-12-31T00:00:00';Check (-not (Test-CFBTaskRecovery $task $config)) 'Expiring recovery accepted.'
$task=Fixture;$task.Settings.ExecutionTimeLimit='PT72H';Check (-not (Test-CFBTaskRecovery $task $config)) 'Three-day process limit accepted.'
$task=Fixture;$task.Settings.MultipleInstances='Parallel';Check (-not (Test-CFBTaskRecovery $task $config)) 'Parallel callback consumers accepted.'
$task=Fixture;$task.Settings.StopIfGoingOnBatteries=$true;Check (-not (Test-CFBTaskRecovery $task $config)) 'Battery shutdown accepted.'
$task=Fixture;$task.Triggers[0].UserId='S-1-5-21-101-202-303-9999';Check (-not (Test-CFBTaskRecovery $task $config)) 'Wrong logon user accepted.'
# Inspect the real Windows-created task definition without persistent registration.
$definition=New-CFBTaskDefinition $config
$definition=[pscustomobject]@{TaskName=(Get-CFBTaskName $config.expectedUserSid);TaskPath='\';Description=$definition.Description;Actions=$definition.Actions;Principal=$definition.Principal;Triggers=$definition.Triggers;Settings=$definition.Settings}
Check (Test-CFBTaskRecovery $definition $config) 'Windows task definition does not implement indefinite user recovery.'
# Process identity includes creation time: a reused numeric PID is not ownership.
$process=Get-Process -Id $PID
$record=[pscustomobject]@{pid=$PID;createdAtTicks='1';nodePath=$process.Path}
Check (-not (Test-CFBProcessIdentity $record $config.installRoot)) 'Reused PID with stale creation time accepted.'
$record.createdAtTicks=$process.StartTime.ToUniversalTime().Ticks.ToString()
Check (-not (Test-CFBProcessIdentity $record $config.installRoot)) 'Unrelated live process accepted as the bridge.'
# PowerShell 7 parses ISO timestamps into DateTime objects. Casting preserves
# their UTC instant; Parse(stringified DateTime) would silently apply local time.
$event='{"at":"2026-09-29T08:10:45.7082447Z"}' | ConvertFrom-Json
$instant=([DateTimeOffset]$event.at).UtcDateTime
Check ($instant.ToString('o') -ceq '2026-09-29T08:10:45.7082447Z') 'JSON event timestamp lost its UTC instant.'
[pscustomobject]@{passed=$count;tasksRegistered=0;processesStopped=0;messagesSent=0}
