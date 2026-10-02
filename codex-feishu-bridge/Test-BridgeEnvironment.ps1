param(
    [string]$ExpectedUserSid,[string]$NodePath,[string]$PythonPath,[string]$PwshPath,
    [string]$LarkCliPath,[string]$CodexHome,[string]$ProfileName,
    [switch]$CheckDesktop
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Bridge-Environment.ps1')
$params = @{}
foreach ($name in @('ExpectedUserSid','NodePath','PythonPath','PwshPath','LarkCliPath','CodexHome')) {
    if ($PSBoundParameters.ContainsKey($name)) { $params[$name] = $PSBoundParameters[$name] }
}
$environment = Get-CFBEnvironment @params
$result = [ordered]@{ok=$true;environment=$environment;desktopHandshake=$null;feishu=$null;messagesSent=0;answersSubmitted=0}
if ($ProfileName) { $result.feishu = Test-CFBFeishuProfile $environment.larkCliPath $ProfileName }
if ($CheckDesktop) {
    $oldExe = $env:CODEX_FEISHU_CODEX_EXE; $oldVersion = $env:CODEX_FEISHU_CODEX_VERSION
    try {
        $env:CODEX_FEISHU_CODEX_EXE = $environment.codexExecutable
        $env:CODEX_FEISHU_CODEX_VERSION = $environment.codexVersion
        $raw = & $environment.pwshPath -NoLogo -NoProfile -NonInteractive -File (Join-Path $PSScriptRoot 'desktop-ipc-handshake.ps1')
        if ($LASTEXITCODE -ne 0) { throw 'Read-only Codex handshake failed.' }
        $result.desktopHandshake = $raw | ConvertFrom-Json
        if ($result.desktopHandshake.resultType -ne 'success' -or $result.desktopHandshake.serverIdentityVerified -ne $true) { throw 'Desktop handshake was not confirmed.' }
    } finally { $env:CODEX_FEISHU_CODEX_EXE=$oldExe; $env:CODEX_FEISHU_CODEX_VERSION=$oldVersion }
}
$result | ConvertTo-Json -Depth 8
