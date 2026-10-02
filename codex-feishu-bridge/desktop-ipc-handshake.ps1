$ErrorActionPreference = 'Stop'
$cfbFailureCode = 'identity_verification_failed'
trap { [Console]::Error.WriteLine('CFB_FAILURE:' + $cfbFailureCode); exit 1 }
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class FeishuBridgePipeIdentity {
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe, out uint processId);
}
'@
. (Join-Path $PSScriptRoot 'Bridge-Environment.ps1')
$desktop = Get-CFBCodexIdentity
# Resolve the installed official package on every reconnect. Application version
# is diagnostic metadata; the live initialization response is checked below.
$expectedExecutable = $desktop.executable
$pipe = [System.IO.Pipes.NamedPipeClientStream]::new('.', 'codex-ipc',
    [System.IO.Pipes.PipeDirection]::InOut, [System.IO.Pipes.PipeOptions]::Asynchronous)
$deadline = [System.Threading.CancellationTokenSource]::new(5000)
function Read-Exact([int]$count) {
    $buffer = [byte[]]::new($count)
    $offset = 0
    while ($offset -lt $count) {
        $read = $pipe.ReadAsync($buffer, $offset, $count - $offset, $deadline.Token).GetAwaiter().GetResult()
        if ($read -eq 0) { throw 'Pipe closed before response' }
        $offset += $read
    }
    return ,$buffer
}
try {
    $cfbFailureCode = 'codex_unavailable'
    $pipe.Connect(2000)
    $cfbFailureCode = 'identity_verification_failed'
    [uint32]$serverPid = 0
    if (-not [FeishuBridgePipeIdentity]::GetNamedPipeServerProcessId($pipe.SafePipeHandle, [ref]$serverPid)) {
        throw 'Cannot verify pipe server'
    }
    $server = Get-CimInstance Win32_Process -Filter "ProcessId=$serverPid"
    $owner = Invoke-CimMethod -InputObject $server -MethodName GetOwnerSid
    if ($server.ExecutablePath -ne $expectedExecutable -or
        $owner.Sid -ne [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value) {
        throw 'Pipe server identity mismatch; no protocol data sent'
    }
    $cfbFailureCode = 'protocol_incompatible'
    $requestId = [guid]::NewGuid().ToString()
    $request = @{
        type = 'request'; requestId = $requestId; sourceClientId = 'initializing-client'
        version = 0; method = 'initialize'; params = @{ clientType = 'feishu-bridge-probe' }
    } | ConvertTo-Json -Compress -Depth 4
    $body = [System.Text.Encoding]::UTF8.GetBytes($request)
    $prefix = [System.BitConverter]::GetBytes([uint32]$body.Length)
    $pipe.Write($prefix, 0, $prefix.Length)
    $pipe.Write($body, 0, $body.Length)
    $pipe.Flush()
    for ($frame = 0; $frame -lt 30; $frame++) {
        $header = Read-Exact 4
        $length = [System.BitConverter]::ToUInt32($header, 0)
        if ($length -eq 0 -or $length -gt 16777216) { throw 'Unexpected frame size' }
        $message = [System.Text.Encoding]::UTF8.GetString((Read-Exact $length)) | ConvertFrom-Json
        # Ignore unrelated broadcasts without logging their contents.
        if ($message.type -ne 'response' -or $message.requestId -ne $requestId) { continue }
        [ordered]@{
            observedAt = (Get-Date).ToString('o'); device = $env:COMPUTERNAME
            serverPid = $serverPid; serverIdentityVerified = $true; codexVersion = $desktop.version
            declaredClientType = 'feishu-bridge-probe'
            resultType = $message.resultType; method = $message.method
            clientIdAssigned = [bool]$message.result.clientId
            threadRequestsSent = 0; answersSubmitted = 0
        } | ConvertTo-Json
        return
    }
    throw 'No matching initialization response'
} finally {
    $deadline.Cancel()
    $deadline.Dispose()
    $pipe.Dispose()
}
