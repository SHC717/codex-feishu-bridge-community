param(
    [string]$ExpectedUserSid,[string]$ProfileName,[string]$Recipient,
    [string]$NodePath,[string]$PythonPath,[string]$PwshPath,[string]$LarkCliPath,[string]$CodexHome,
    [int]$SingletonPort=49873,[switch]$Update,[string]$BackupArchive,[string]$BackupRoot,[switch]$StartNow,
    [switch]$MigrateLegacy,[string]$LegacyAppId,
    [string]$InteractionChatId,[string]$ResultChatId
)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'Get-BridgeStatus.ps1') -Library
if ([string]::IsNullOrWhiteSpace($ExpectedUserSid)) { throw 'ExpectedUserSid is required. Verify it independently in an ordinary Windows terminal first (whoami /user).' }
if ($Recipient -notmatch '^ou_[A-Za-z0-9]+$') { throw 'A verified recipient open_id for this exact Feishu application is required.' }
if (-not (Test-CFBProfileName $ProfileName)) { throw 'An explicit local Feishu CLI profile name is required.' }
if ($SingletonPort -lt 1024 -or $SingletonPort -gt 65535) { throw 'Invalid singleton port.' }
$environment=Get-CFBEnvironment -ExpectedUserSid $ExpectedUserSid -NodePath $NodePath -PythonPath $PythonPath -PwshPath $PwshPath -LarkCliPath $LarkCliPath -CodexHome $CodexHome
$profile=Test-CFBFeishuProfile $environment.larkCliPath $ProfileName
if ([bool]$InteractionChatId -ne [bool]$ResultChatId -or ($InteractionChatId -and ($InteractionChatId -cnotmatch '^oc_[A-Za-z0-9]+$' -or $ResultChatId -cnotmatch '^oc_[A-Za-z0-9]+$' -or $InteractionChatId -ceq $ResultChatId))) { throw 'Provide two distinct valid classification chat IDs together.' }
$InstallRoot=$environment.installRoot
Assert-CFBInstallRoot $InstallRoot
$sourceRoot=[IO.Path]::GetFullPath($PSScriptRoot)
if ($sourceRoot -ieq $InstallRoot) { throw 'Install from a source checkout outside the deployed directory.' }
[void](Assert-CFBRealPath $sourceRoot)
[void](Assert-CFBRealPath ([IO.Path]::GetDirectoryName($InstallRoot)))
$sharedSource=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\shared\windows-native\WindowsNative.psm1'))
if (-not (Test-Path -LiteralPath $sharedSource -PathType Leaf)) { throw 'Obtain the complete codex-feishu-bridge-community checkout; shared/windows-native is included and required.' }
$buildRoot=Join-Path ([IO.Path]::GetTempPath()) ('CodexWork\FeishuBridgeBuild-'+[guid]::NewGuid().ToString('N'))
$launcher=& (Join-Path $sourceRoot 'Build-NoWindowHost.ps1') -OutputDirectory $buildRoot
$manifest=@()
foreach ($name in (Get-CFBRuntimeNames)) {
    $source=if ($name -eq 'NoWindowHost.exe') { $launcher } elseif ($name -eq 'WindowsNative.psm1') { $sharedSource } else { Join-Path $sourceRoot $name }
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Missing runtime source: $name" }
    [void](Assert-CFBRealPath $source)
    $manifest += [pscustomobject]@{name=$name;sha256=(Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash;source=$source}
}
$taskConfig=[pscustomobject]@{expectedUserSid=$environment.expectedUserSid;installRoot=$InstallRoot;pwshPath=$environment.pwshPath}
$existingTask=Get-ScheduledTask -TaskName (Get-CFBTaskName $ExpectedUserSid) -TaskPath '\' -ErrorAction SilentlyContinue
if ($existingTask -and -not (Test-CFBTaskOwnership $existingTask $taskConfig -AllowLegacy:$Update)) { throw 'Existing Windows supervision task is not owned by this bridge.' }
if ($existingTask -and [string]$existingTask.State -eq 'Running') { throw 'Pause this bridge before updating its task or files.' }
$linkPath=Get-CFBStartupLink
[void](Assert-CFBRealPath ([IO.Path]::GetDirectoryName($linkPath)))
$linkOwned=$false
$hasDeployment=(Test-Path -LiteralPath $InstallRoot) -and @(Get-ChildItem -LiteralPath $InstallRoot -Force).Count -gt 0
if ($hasDeployment) {
    if (-not $Update) { throw 'Target is not empty. Review the owned installation and explicitly use -Update.' }
    [void](Assert-CFBRealPath $InstallRoot)
    $currentConfig=Read-CFBJson (Assert-CFBRealPath (Join-Path $InstallRoot 'deployment.json'))
    if ($currentConfig.application -cne 'CodexFeishuBridge' -or $currentConfig.installRoot -ine $InstallRoot) { throw 'Existing deployment identity is invalid.' }
    if ($currentConfig.schema -eq 1) {
        if (-not $MigrateLegacy -or $LegacyAppId -cne $profile.appId) { throw 'Schema 1 requires reviewed -MigrateLegacy and independently verified -LegacyAppId matching this profile.' }
        # The early on-host deployment used precisely this 18-file whitelist.
        $legacyNames=@('bridge-worker.mjs','bridge-engine.mjs','durable-state.mjs','bridge-core.mjs','cli-transport.mjs','desktop-ipc-client.mjs','desktop-ipc-handshake.ps1','desktop-state.mjs','desktop-turns.mjs','feishu-cards.mjs','global-desktop-watcher.mjs','global-discovery-probe.mjs','list-user-threads.py','supervisor.mjs','Start-Bridge.ps1','Stop-Bridge.ps1','Get-BridgeStatus.ps1','Install-Bridge.ps1')
        $recorded=@($currentConfig.files | ForEach-Object name)
        if ($recorded.Count -ne 18 -or @($recorded | Select-Object -Unique).Count -ne 18 -or @($recorded | Where-Object { $_ -notin $legacyNames }).Count) { throw 'Unrecognized schema 1 runtime manifest.' }
        foreach ($entry in $currentConfig.files) {
            $file=Assert-CFBRealPath (Join-Path $InstallRoot $entry.name)
            if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $entry.sha256) { throw 'Legacy runtime hash mismatch.' }
        }
    } else {
        $currentConfig=Read-CFBDeployment $InstallRoot -ForUpdate
        if ($currentConfig.profileName -cne $ProfileName) { throw 'Do not silently change the local Feishu profile on an existing deployment.' }
        if ($currentConfig.appId) {
            if ($currentConfig.appId -cne $profile.appId) { throw 'Do not reuse state with a different Feishu application.' }
        } elseif (-not $MigrateLegacy -or $LegacyAppId -cne $profile.appId) { throw 'The old unbound profile requires reviewed -MigrateLegacy and independently verified -LegacyAppId.' }
    }
    if (-not $InteractionChatId -and $currentConfig.interactionChatId) { $InteractionChatId=$currentConfig.interactionChatId;$ResultChatId=$currentConfig.resultChatId }
    if ($currentConfig.recipient -cne $Recipient) { throw 'Do not reuse message/answer state with a different recipient.' }
    $recordPath=Join-Path $InstallRoot 'state\supervisor.json'
    if (Test-Path -LiteralPath $recordPath) {
        $record=Read-CFBJson (Assert-CFBRealPath $recordPath)
        if ((Test-CFBProcessIdentity $record $InstallRoot) -or (Test-CFBProcessIdentity $record $InstallRoot -Worker)) { throw 'Pause this bridge before updating.' }
    }
    if (Test-Path -LiteralPath $linkPath) {
        [void](Assert-CFBRealPath $linkPath)
        $shell=New-Object -ComObject WScript.Shell
        try {
            $link=$shell.CreateShortcut($linkPath)
            try {
                $linkOwned=$link.TargetPath -ieq $currentConfig.pwshPath -and $link.Arguments -ceq (Get-CFBStartupArguments $InstallRoot) -and $link.WorkingDirectory -ieq $InstallRoot
            } finally { [Runtime.InteropServices.Marshal]::FinalReleaseComObject($link) | Out-Null }
        } finally { [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) | Out-Null }
        if (-not $linkOwned) { throw 'Existing Startup shortcut is not owned by this deployment.' }
    }
    $backup=Resolve-CFBBackupArchive -BackupArchive $BackupArchive -BackupRoot $BackupRoot -DeploymentRoot $InstallRoot
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip=[IO.Compression.ZipFile]::OpenRead($backup)
    try {
        $files=@(Get-ChildItem -LiteralPath $InstallRoot -File -Recurse)
        $entries=@($zip.Entries | Where-Object { $_.Name })
        if ($entries.Count -ne $files.Count) { throw 'Cold-backup entry count does not match the stopped deployment.' }
        foreach ($file in $files) {
            [void](Assert-CFBRealPath $file.FullName)
            $relative=$file.FullName.Substring($InstallRoot.Length+1).Replace('\','/')
            $matching=@($entries | Where-Object { $_.FullName -ceq $relative })
            if ($matching.Count -ne 1 -or $matching[0].Length -ne $file.Length) { throw 'Cold-backup contents do not match the deployment.' }
            $stream=$matching[0].Open();$hasher=[Security.Cryptography.SHA256]::Create()
            try { $hash=[BitConverter]::ToString($hasher.ComputeHash($stream)).Replace('-','') }
            finally { $stream.Dispose();$hasher.Dispose() }
            if ($hash -ne (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash) { throw 'Cold-backup bytes do not match the deployment.' }
        }
    } finally { $zip.Dispose() }
} elseif ((Test-Path -LiteralPath $linkPath) -or $existingTask) { throw 'Startup/task exists without a verified owned deployment. No files changed.' }
Test-CFBClassificationChannels $environment.larkCliPath $ProfileName $Recipient $profile.appId $InteractionChatId $ResultChatId
# All identity, source, ownership and cold-backup checks precede persistent writes.
foreach ($directory in @($InstallRoot,(Join-Path $InstallRoot 'state'),(Join-Path $InstallRoot 'logs'))) {
    [void][IO.Directory]::CreateDirectory($directory);[void](Assert-CFBRealPath $directory)
}
foreach ($entry in $manifest) {
    $destination=Join-Path $InstallRoot $entry.name
    if (Test-Path -LiteralPath $destination) { [void](Assert-CFBRealPath $destination) }
    Copy-Item -LiteralPath $entry.source -Destination $destination -Force
    [void](Assert-CFBRealPath $destination)
    if ((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash -ne $entry.sha256) { throw "Deployed hash mismatch: $($entry.name)" }
}
$config=[ordered]@{
    schema=2;application='CodexFeishuBridge';displayName='飞书桥';release=$environment.release
    installRoot=$InstallRoot;sourceRoot=$sourceRoot;deviceName=$environment.deviceName;expectedUserSid=$environment.expectedUserSid
    nodePath=$environment.nodePath;pythonPath=$environment.pythonPath;pwshPath=$environment.pwshPath;larkCliPath=$environment.larkCliPath
    codexExecutable=$environment.codexExecutable;codexVersion=$environment.codexVersion;databasePath=$environment.databasePath
    profileName=$ProfileName;appId=$profile.appId;recipient=$Recipient;singletonPort=$SingletonPort
    interactionChatId=$InteractionChatId;resultChatId=$ResultChatId
    taskName=(Get-CFBTaskName $environment.expectedUserSid)
    files=@($manifest | Select-Object name,sha256);installedAt=[DateTime]::UtcNow.ToString('o')
}
$configPath=Join-Path $InstallRoot 'deployment.json'
if (Test-Path -LiteralPath $configPath) { [void](Assert-CFBRealPath $configPath) }
[IO.File]::WriteAllText($configPath,($config | ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
[void](Assert-CFBRealPath $configPath)
Register-CFBTask ([pscustomobject]$config) -AllowLegacy:$Update
$shell=New-Object -ComObject WScript.Shell
try {
    foreach ($entry in @(@{name='启动飞书桥.lnk';script='Start-Bridge.ps1'},@{name='暂停飞书桥.lnk';script='Stop-Bridge.ps1'})) {
        $path=Join-Path $InstallRoot $entry.name
        if (Test-Path -LiteralPath $path) { [void](Assert-CFBRealPath $path) }
        $shortcut=$shell.CreateShortcut($path)
        try {
            $shortcut.TargetPath=Join-Path $InstallRoot 'NoWindowHost.exe'
            $shortcut.Arguments=(Quote-CFBArgument $environment.pwshPath)+' '+(Quote-CFBArgument $entry.script)+' '+(Quote-CFBArgument $InstallRoot)
            $shortcut.WorkingDirectory=$InstallRoot;$shortcut.WindowStyle=7;$shortcut.Description='飞书桥：当前用户后台提醒与问答';$shortcut.Save()
        } finally { [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut) | Out-Null }
        [void](Assert-CFBRealPath $path)
    }
} finally { [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) | Out-Null }
# Remove only the inspected owned one-shot Startup entry after task readback.
if ($linkOwned) { Remove-Item -LiteralPath $linkPath -Force }
if ($StartNow) {
    & (Join-Path $InstallRoot 'Start-Bridge.ps1') -InstallRoot $InstallRoot | Out-Null
} else {
    # Ready for next logon or the next minute trigger; no intentional pause left.
    foreach ($name in @('stop.requested','worker-stop.requested')) {
        $path=Join-Path $InstallRoot ('state\'+$name)
        if (Test-Path -LiteralPath $path) { [void](Assert-CFBRealPath $path);Remove-Item -LiteralPath $path -Force }
    }
    Enable-ScheduledTask -TaskName $config.taskName -TaskPath '\' | Out-Null
}
$status=Get-CFBStatus $InstallRoot
if (-not $status.taskMatches -or -not $status.autoStartEnabled) { throw 'Windows supervision readback failed.' }
[ordered]@{success=$true;deployedFileCount=$manifest.Count;legacyMigrated=[bool]$MigrateLegacy;status=$status} | ConvertTo-Json -Depth 8
