$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Get-BridgeStatus.ps1') -Library
$count=0
function Expect-Rejection([scriptblock]$Action,[string]$Reason) {
    $rejected=$false
    try { & $Action | Out-Null } catch { if ($_.Exception.Message -notlike "*$Reason*") { throw }; $rejected=$true }
    if (-not $rejected) { throw "Expected rejection: $Reason" }
    $script:count++
}
$script:packages=@([pscustomobject]@{Version='26.924.1866.0';PublisherId='2p2nqsd0c76g0';Architecture='X64';InstallLocation='D:\fixture\Codex';IsResourcePackage=$false})
$script:redirected=$false
function Get-AppxPackage { param($Name) $script:packages }
function Get-WindowsNativePath { param($Path) [pscustomobject]@{final=$Path;matches_requested=(-not $script:redirected)} }
$identity=Get-CFBCodexIdentity
if ($identity.executable -ne 'D:\fixture\Codex\app\ChatGPT.exe') { throw 'Package location did not determine executable.' };$count++
$script:packages[0].Version='99.1.0.0'
if ((Get-CFBCodexIdentity).version -cne '99.1.0.0') { throw 'A version-only update must not block the desktop.' };$count++
$script:packages[0].Version='26.924.2738.0';$script:packages[0].PublisherId='other';Expect-Rejection {Get-CFBCodexIdentity} 'identity'
$script:packages[0].PublisherId='2p2nqsd0c76g0';$script:packages[0].Architecture='ARM64';Expect-Rejection {Get-CFBCodexIdentity} 'architecture'
$script:packages[0].Architecture='X64';$script:redirected=$true;Expect-Rejection {Get-CFBCodexIdentity} 'redirected'
$script:redirected=$false;$script:packages=@($script:packages[0],$script:packages[0]);Expect-Rejection {Get-CFBCodexIdentity} 'Exactly one'
$script:packages=@();Expect-Rejection {Get-CFBCodexIdentity} 'Exactly one'
Expect-Rejection {Assert-CFBInstallRoot 'D:\someone-else\CodexFeishuBridge'} 'scoped only'
foreach($bad in @('', '--other', "invalid`nprofile", 'name space')) {
    if(Test-CFBProfileName $bad){throw 'Unsafe profile accepted'};$count++
}
Expect-Rejection {& (Join-Path $PSScriptRoot 'Install-Bridge.ps1')} 'ExpectedUserSid'
Expect-Rejection {& (Join-Path $PSScriptRoot 'Install-Bridge.ps1') -ExpectedUserSid 'S-1-5-21-1-2-3-1000' -Recipient 'not-an-open-id'} 'recipient'
Expect-Rejection {& (Join-Path $PSScriptRoot 'Install-Bridge.ps1') -ExpectedUserSid 'S-1-5-21-1-2-3-1000' -Recipient 'ou_fixture' -ProfileName '--wrong'} 'profile'
# The real UTF-8 process reader preserves Chinese metadata without a console.
$pwsh=(Get-Process -Id $PID).Path
$jsonCommand='[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);[Console]::WriteLine(''{"label":"中文测试","ok":true}'')'
$parsed=Invoke-CFBReadOnlyCliJson $pwsh @('-NoLogo','-NoProfile','-NonInteractive','-Command',$jsonCommand)
if ($parsed.label -cne '中文测试' -or $parsed.ok -ne $true) { throw 'UTF-8 metadata was corrupted.' };$count++
# Pure fixtures for profile selection. No real Feishu calls or global profile edits.
$script:fixtureProfiles=@([pscustomobject]@{name='test-local';appId='cli_fixture'})
function Invoke-CFBReadOnlyCliJson {
    param([string]$Cli,[string[]]$Arguments)
    if ($Arguments[0] -eq 'profile' -and $Arguments[1] -eq 'list') { return $script:fixtureProfiles }
    if ($Arguments[0] -ne '--profile' -or $Arguments[1] -ne 'test-local' -or $Arguments[-1] -ne '--dry-run') { throw 'Callback preflight changed profile or performed a live call.' }
    return [pscustomobject]@{ok=$true;data=[pscustomobject]@{decision=[pscustomobject]@{status='ready'}}}
}
$profile=Test-CFBFeishuProfile 'fixture-cli' 'test-local'
if ($profile.appId -cne 'cli_fixture') { throw 'Explicit profile was not bound to its application.' };$count++
$script:fixtureProfiles=@();Expect-Rejection {Test-CFBFeishuProfile 'fixture-cli' 'test-local'} 'unique application'
$script:fixtureProfiles=@([pscustomobject]@{name='test-local';appId='cli_fixture'},[pscustomobject]@{name='test-local';appId='cli_other'});Expect-Rejection {Test-CFBFeishuProfile 'fixture-cli' 'test-local'} 'unique application'

$info=[pscustomobject]@{ok=$true;data=[pscustomobject]@{chat_mode='group';chat_type='private';external=$false;chat_status='normal';owner_id='ou_fixture'}}
$members=[pscustomobject]@{ok=$true;data=[pscustomobject]@{has_more=$false;truncations=@();users=@([pscustomobject]@{member_id='ou_fixture'});bots=@([pscustomobject]@{app_id='cli_fixture'})}}
Assert-CFBPrivateChannel $info $members 'ou_fixture' 'cli_fixture';$count++
$members.data.has_more=$true;Expect-Rejection {Assert-CFBPrivateChannel $info $members 'ou_fixture' 'cli_fixture'} 'contain only';$members.data.has_more=$false
$info.data.external=$true;Expect-Rejection {Assert-CFBPrivateChannel $info $members 'ou_fixture' 'cli_fixture'} 'private group';$info.data.external=$false
Expect-Rejection {Assert-CFBPrivateChannel $info $members 'ou_fixture' 'cli_other'} 'contain only'
$members.data.users+= [pscustomobject]@{member_id='ou_other'};Expect-Rejection {Assert-CFBPrivateChannel $info $members 'ou_fixture' 'cli_fixture'} 'contain only'
[pscustomobject]@{passed=$count;filesDeployed=0;messagesSent=0}
