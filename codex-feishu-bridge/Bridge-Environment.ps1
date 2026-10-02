# Shared by read-only preflight, installation and deployed lifecycle entries.
$cfbNativeModule = Join-Path $PSScriptRoot '..\shared\windows-native\WindowsNative.psm1'
if (-not (Test-Path -LiteralPath $cfbNativeModule -PathType Leaf)) {
    $cfbNativeModule = Join-Path $PSScriptRoot 'WindowsNative.psm1'
}
if (-not (Test-Path -LiteralPath $cfbNativeModule -PathType Leaf)) { throw 'Shared Windows native preflight is missing. Obtain the complete codex-feishu-bridge-community repository, including shared/windows-native.' }
Import-Module $cfbNativeModule -Force

function Get-CFBRuntimeNames {
    @('bridge-worker.mjs','bridge-engine.mjs','durable-state.mjs','bridge-core.mjs',
      'result-format.mjs','message-routing.mjs','cli-transport.mjs','profile-transport.mjs','desktop-ipc-client.mjs','desktop-ipc-handshake.ps1',
      'desktop-state.mjs','desktop-turns.mjs','feishu-cards.mjs','global-desktop-watcher.mjs',
      'global-discovery-probe.mjs','list-user-threads.py','health-notifier.mjs','supervisor-health.mjs','supervisor.mjs','Start-Bridge.ps1',
      'Stop-Bridge.ps1','Get-BridgeStatus.ps1','Install-Bridge.ps1','Bridge-Environment.ps1',
      'Test-BridgeEnvironment.ps1','compatibility.json','WindowsNative.psm1','Bridge-Task.ps1','Run-Bridge.ps1','NoWindowHost.cs','Build-NoWindowHost.ps1','NoWindowHost.exe')
}
function Get-CFBCompatibility {
    Get-Content -LiteralPath (Join-Path $PSScriptRoot 'compatibility.json') -Raw | ConvertFrom-Json
}
function Test-CFBProfileName([string]$Name) {
    $Name -cmatch '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'
}
function Get-CFBCodexIdentity {
    $packages = @(Get-AppxPackage -Name OpenAI.Codex | Where-Object { -not $_.IsResourcePackage })
    if ($packages.Count -ne 1) { throw 'Exactly one current-user OpenAI.Codex package is required.' }
    $package = $packages[0]
    $version = [string]$package.Version
    if ($package.PublisherId -cne '2p2nqsd0c76g0' -or [string]$package.Architecture -ine 'X64') { throw 'Unverified Codex package identity or architecture.' }
    # App versions are informational. Reconnect probes the actual IPC protocol;
    # package publisher, architecture, final path and same-user ownership remain mandatory.
    $executable = Join-Path $package.InstallLocation 'app\ChatGPT.exe'
    $opened = Get-WindowsNativePath $executable
    if (-not $opened.matches_requested) { throw 'Codex executable path is redirected.' }
    [pscustomobject]@{ executable=$opened.final; version=$version }
}
function Resolve-CFBExistingFile([string]$ExplicitPath, [string]$DefaultPath, [string]$Label) {
    $candidate = if ($ExplicitPath) { $ExplicitPath } else { $DefaultPath }
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { throw "Required $Label is missing: $candidate. Install/locate it explicitly; this program does not download dependencies." }
    $opened = Get-WindowsNativePath $candidate
    if (-not $opened.matches_requested) { throw "$Label path is redirected." }
    $opened.final
}
function Get-CFBEnvironment {
    param([string]$ExpectedUserSid,[string]$NodePath,[string]$PythonPath,[string]$PwshPath,
          [string]$LarkCliPath,[string]$CodexHome)
    # Omitted expected SID is allowed only for read-only inventory. Installation
    # requires a SID verified independently in the user's ordinary terminal.
    $native = Assert-WindowsNativeContext -ExpectedUserSid $ExpectedUserSid
    $userProfilePath = $native.identity.profile_path
    $runtime = Join-Path $userProfilePath '.cache\codex-runtimes\codex-primary-runtime\dependencies'
    $node = Resolve-CFBExistingFile $NodePath (Join-Path $runtime 'node\bin\node.exe') 'Node'
    $python = Resolve-CFBExistingFile $PythonPath (Join-Path $runtime 'python\python.exe') 'Python'
    $pwsh = Resolve-CFBExistingFile $PwshPath (Join-Path $runtime 'native\powershell\pwsh.exe') 'PowerShell 7'
    $cli = Resolve-CFBExistingFile $LarkCliPath (Join-Path $userProfilePath '.local\bin\lark-cli.exe') 'Feishu CLI'
    $nodeVersion = (& $node --version | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 22) { throw 'Node 22 or newer is required.' }
    $pythonVersion = (& $python --version | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $pythonVersion -notmatch '^Python (\d+)\.(\d+)' -or [int]$Matches[1] -ne 3 -or [int]$Matches[2] -lt 12) { throw 'Python 3.12 or newer in Python 3 is required.' }
    $pwshVersion = (& $pwsh -NoLogo -NoProfile -NonInteractive -Command '$PSVersionTable.PSVersion.ToString()' | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $pwshVersion -notmatch '^7\.') { throw 'PowerShell 7 is required.' }
    $cliVersion = (& $cli --version | Out-String).Trim()
    $compatibility = Get-CFBCompatibility
    if ($LASTEXITCODE -ne 0 -or $cliVersion -ne ('lark-cli version ' + $compatibility.larkCliVersion)) { throw "Feishu CLI version is not verified: $cliVersion" }
    if (-not $CodexHome) { $CodexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $userProfilePath '.codex' } }
    $database = Resolve-CFBExistingFile '' (Join-Path $CodexHome $compatibility.stateDatabase) 'Codex state database'
    $validation = & $python -I (Join-Path $PSScriptRoot 'list-user-threads.py') --database $database --validate
    if ($LASTEXITCODE -ne 0) { throw 'Codex database schema preflight failed; no database changes were made.' }
    $databaseStatus = $validation | ConvertFrom-Json
    if ($databaseStatus.compatible -ne $true) { throw 'Codex database schema is incompatible.' }
    $desktop = Get-CFBCodexIdentity
    [pscustomobject]@{
        release=$compatibility.release; deviceName=[Environment]::MachineName; expectedUserSid=$native.identity.sid
        installRoot=(Join-Path $native.appdata.local.requested 'CodexFeishuBridge')
        nodePath=$node; pythonPath=$python; pwshPath=$pwsh; larkCliPath=$cli
        databasePath=$database; codexExecutable=$desktop.executable; codexVersion=$desktop.version
        versions=[pscustomobject]@{node=$nodeVersion;python=$pythonVersion;powershell=$pwshVersion;lark=$cliVersion}
        readOnly=$true
    }
}
function Invoke-CFBReadOnlyCliJson([string]$Cli,[string[]]$Arguments) {
    # A hidden Task Scheduler host may decode native stdout with a legacy code
    # page. Read JSON directly through an explicit UTF-8 pipe, never through the
    # host console. Notices are also suppressed as in the worker transport.
    $start=[Diagnostics.ProcessStartInfo]::new()
    $start.FileName=$Cli;$start.UseShellExecute=$false;$start.CreateNoWindow=$true
    $start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true
    $start.StandardOutputEncoding=[Text.UTF8Encoding]::new($false)
    $start.StandardErrorEncoding=[Text.UTF8Encoding]::new($false)
    $start.Environment['LARKSUITE_CLI_NO_UPDATE_NOTIFIER']='1'
    $start.Environment['LARKSUITE_CLI_NO_SKILLS_NOTIFIER']='1'
    foreach ($argument in $Arguments) { $start.ArgumentList.Add($argument) }
    $process=[Diagnostics.Process]::new();$process.StartInfo=$start
    try {
        [void]$process.Start()
        $stdout=$process.StandardOutput.ReadToEndAsync();$stderr=$process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(15000)) { $process.Kill();throw 'Feishu read-only CLI query timed out.' }
        $raw=$stdout.GetAwaiter().GetResult();[void]$stderr.GetAwaiter().GetResult()
        if ($process.ExitCode -ne 0) { throw 'Feishu read-only CLI query failed. Inspect this profile locally; do not copy credentials into the repository.' }
        if ($raw.Length -gt 1048576) { throw 'Unexpectedly large CLI metadata output.' }
        return ($raw | ConvertFrom-Json)
    } finally { $process.Dispose() }
}
function Test-CFBFeishuProfile([string]$Cli, [string]$ProfileName) {
    if (-not (Test-CFBProfileName $ProfileName)) { throw 'Use an explicit local CLI profile name (letters, numbers, underscore or hyphen).' }
    $profiles=@(Invoke-CFBReadOnlyCliJson $Cli @('profile','list'))
    $selected=@($profiles | Where-Object { $_.name -ceq $ProfileName })
    if ($selected.Count -ne 1 -or $selected[0].appId -notmatch '^cli_[A-Za-z0-9]+$') { throw 'This explicit Feishu profile has no unique application identity.' }
    # --dry-run cannot start a consumer, subscribe to callbacks or send messages.
    $envelope=Invoke-CFBReadOnlyCliJson $Cli @('--profile',$ProfileName,'event','consume','card.action.trigger','--as','bot','--dry-run')
    if ($envelope.ok -ne $true -or $envelope.data.decision.status -notin @('ready','allowed')) { throw 'This profile is not ready to consume card callbacks.' }
    [pscustomobject]@{profileName=$ProfileName;appId=$selected[0].appId;callbackDecision=$envelope.data.decision.status;readOnly=$true}
}

function Assert-CFBPrivateChannel([object]$Info,[object]$Members,[string]$Recipient,[string]$AppId) {
    if ($Info.ok -ne $true -or $Members.ok -ne $true) { throw 'Classification channel lookup failed.' }
    $chat=$Info.data;$membership=$Members.data
    if ($chat.chat_mode -cne 'group' -or $chat.chat_type -cne 'private' -or $chat.external -ne $false -or $chat.chat_status -cne 'normal' -or $chat.owner_id -cne $Recipient) { throw 'Classification channel must be an active private group owned by the recipient.' }
    if ($membership.has_more -or @($membership.truncations).Count -or @($membership.users).Count -ne 1 -or @($membership.bots).Count -ne 1 -or $membership.users[0].member_id -cne $Recipient -or $membership.bots[0].app_id -cne $AppId) { throw 'Classification channel must contain only the recipient and this application bot.' }
}
function Test-CFBClassificationChannels([string]$Cli,[string]$ProfileName,[string]$Recipient,[string]$AppId,[string]$InteractionChatId,[string]$ResultChatId) {
    if (-not $InteractionChatId -and -not $ResultChatId) { return }
    if ($InteractionChatId -cnotmatch '^oc_[A-Za-z0-9]+$' -or $ResultChatId -cnotmatch '^oc_[A-Za-z0-9]+$' -or $InteractionChatId -ceq $ResultChatId) { throw 'Provide two distinct classification channels.' }
    foreach ($chatId in @($InteractionChatId,$ResultChatId)) {
        $info=Invoke-CFBReadOnlyCliJson $Cli @('--profile',$ProfileName,'im','chats','get','--as','bot','--chat-id',$chatId,'--user-id-type','open_id')
        $members=Invoke-CFBReadOnlyCliJson $Cli @('--profile',$ProfileName,'im','+chat-members-list','--as','bot','--chat-id',$chatId,'--page-all')
        Assert-CFBPrivateChannel $info $members $Recipient $AppId
    }
}


# Community packaging: the installer supplies an explicit local backup directory.
# ZIP contents are still verified against every stopped deployment file by Install-Bridge.
function Resolve-CFBBackupArchive {
    param([string]$BackupArchive,[string]$BackupRoot,[string]$DeploymentRoot)
    if ([string]::IsNullOrWhiteSpace($BackupRoot)) { throw 'Updating requires an explicit -BackupRoot directory.' }
    foreach ($path in @($BackupRoot,$BackupArchive,$DeploymentRoot)) {
        if ($path -notmatch '^[A-Za-z]:[\\/]') { throw 'Backup and deployment paths must be local absolute paths.' }
    }
    if (-not (Test-Path -LiteralPath $BackupRoot -PathType Container)) { throw 'BackupRoot must be an existing directory.' }
    if (-not (Test-Path -LiteralPath $BackupArchive -PathType Leaf)) { throw 'Updating requires an existing cold-backup ZIP file.' }
    $root=Assert-CFBRealPath $BackupRoot
    $archive=Assert-CFBRealPath $BackupArchive
    $deployment=Assert-CFBRealPath $DeploymentRoot
    if ($root -ieq ([IO.Path]::GetPathRoot($root)).TrimEnd('\')) { throw 'BackupRoot must be a dedicated directory, not a drive root.' }
    foreach ($candidate in @($root,$archive)) {
        if ($candidate -ieq $deployment -or $candidate.StartsWith($deployment+'\',[StringComparison]::OrdinalIgnoreCase)) {
            throw 'Backup must be outside the deployment directory.'
        }
    }
    if (-not $archive.StartsWith($root+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Backup archive is outside the declared backup root.' }
    return $archive
}
