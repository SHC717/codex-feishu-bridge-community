param([string]$InstallRoot=(Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'CodexFeishuBridge'))
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'Get-BridgeStatus.ps1') -Library
$config=Read-CFBDeployment $InstallRoot
if (Get-CFBPackageContext) { throw 'The outer host must be started independently by Windows Task Scheduler.' }
$taskReport=Get-CFBTaskReport $config
if (-not $taskReport.matches -or -not $taskReport.enabled) { throw 'Verified Windows supervision is required.' }
$stopPath=Join-Path $InstallRoot 'state\stop.requested'
$workerStop=Join-Path $InstallRoot 'state\worker-stop.requested'
$log=Join-Path $InstallRoot 'logs\host.jsonl'
function Write-HostEvent([string]$Event,[string]$Detail='') {
    if (Test-Path -LiteralPath $log) {
        [void](Assert-CFBRealPath $log)
        if ((Get-Item -LiteralPath $log).Length -gt 2097152) {
            $previous=$log+'.1'
            if (Test-Path -LiteralPath $previous) { [void](Assert-CFBRealPath $previous) }
            Move-Item -LiteralPath $log -Destination $previous -Force
        }
    }
    $line=@{at=[DateTime]::UtcNow.ToString('o');event=$Event;detail=$Detail;hostPid=$PID} | ConvertTo-Json -Compress
    [IO.File]::AppendAllText($log,$line+[Environment]::NewLine,[Text.UTF8Encoding]::new($false))
}
try {
    Write-HostEvent 'windows_host_started'
    while (-not (Test-Path -LiteralPath $stopPath)) {
        $config=Read-CFBDeployment $InstallRoot
        $profile=Test-CFBFeishuProfile $config.larkCliPath $config.profileName
        if ($profile.appId -cne $config.appId) { throw 'Feishu profile application changed. Refusing to reuse message/answer state.' }
        $recordPath=Join-Path $InstallRoot 'state\supervisor.json'
        $existing=$null
        if (Test-Path -LiteralPath $recordPath) { $existing=Read-CFBJson (Assert-CFBRealPath $recordPath) }
        if (Test-CFBProcessIdentity $existing $InstallRoot) {
            # If only the former Windows host died, monitor the verified live
            # supervisor instead of launching a duplicate or failing every minute.
            Write-HostEvent 'existing_supervisor_monitored' $existing.instanceId
            $owned=Get-Process -Id ([int]$existing.pid) -ErrorAction Stop
            try { $owned.WaitForExit();$code=$owned.ExitCode }
            finally { $owned.Dispose() }
        } else {
            Stop-CFBOrphanWorker $config
            if (Test-Path -LiteralPath $stopPath) { break }
            if (Test-Path -LiteralPath $workerStop) { [void](Assert-CFBRealPath $workerStop);Remove-Item -LiteralPath $workerStop -Force }
            Write-HostEvent 'supervisor_launch'
            # This child belongs to a Windows-started host. Do not spawn-and-return.
            $start=[Diagnostics.ProcessStartInfo]::new()
            $start.FileName=$config.nodePath;$start.UseShellExecute=$false;$start.CreateNoWindow=$true
            $start.WorkingDirectory=$InstallRoot
            $start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true
            $start.ArgumentList.Add((Join-Path $InstallRoot 'supervisor.mjs'))
            $start.ArgumentList.Add('--install-root');$start.ArgumentList.Add($InstallRoot)
            $child=[Diagnostics.Process]::new();$child.StartInfo=$start
            try {
                [void]$child.Start()
                $stdout=$child.StandardOutput.BaseStream.CopyToAsync([IO.Stream]::Null)
                $stderr=$child.StandardError.BaseStream.CopyToAsync([IO.Stream]::Null)
                $child.WaitForExit();$code=$child.ExitCode
                [Threading.Tasks.Task]::WaitAll(@($stdout,$stderr))
            } finally { $child.Dispose() }
        }
        Write-HostEvent 'supervisor_exit' ([string]$code)
        if (Test-Path -LiteralPath $stopPath) { break }
        Start-Sleep -Seconds 5
    }
    Write-HostEvent 'windows_host_stopped'
    exit 0
} catch {
    try { Write-HostEvent 'windows_host_failed' $_.Exception.Message } catch {}
    exit 1
}
