$ErrorActionPreference='Stop'
$root=Join-Path ([IO.Path]::GetTempPath()) ('CodexWork\FeishuHostTest-'+[guid]::NewGuid().ToString('N'))
$exe=& (Join-Path $PSScriptRoot 'Build-NoWindowHost.ps1') -OutputDirectory $root
$probe=@"
param([string]`$InstallRoot)
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class ConsoleProbe { [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow(); }'
[IO.File]::WriteAllText((Join-Path `$InstallRoot 'console.json'),(@{console=([ConsoleProbe]::GetConsoleWindow().ToInt64());root=`$InstallRoot} | ConvertTo-Json))
[Console]::Out.Write(('x'*131072));[Console]::Error.Write(('y'*131072))
`$orphanStart=[Diagnostics.ProcessStartInfo]::new()
`$orphanStart.FileName=(Get-Process -Id `$PID).Path
`$orphanStart.UseShellExecute=`$false;`$orphanStart.CreateNoWindow=`$true
`$orphanStart.ArgumentList.Add('-NoProfile');`$orphanStart.ArgumentList.Add('-Command');`$orphanStart.ArgumentList.Add('Start-Sleep -Seconds 60')
`$orphan=[Diagnostics.Process]::Start(`$orphanStart)
[IO.File]::WriteAllText((Join-Path `$InstallRoot 'orphan.txt'),[string]`$orphan.Id)
Start-Sleep -Milliseconds 1500
exit 23
"@
[IO.File]::WriteAllText((Join-Path $root 'Run-Bridge.ps1'),$probe,[Text.UTF8Encoding]::new($false))
$pwsh=(Get-Process -Id $PID).Path
$start=[Diagnostics.ProcessStartInfo]::new();$start.FileName=$exe;$start.UseShellExecute=$false
$start.ArgumentList.Add($pwsh);$start.ArgumentList.Add('Run-Bridge.ps1');$start.ArgumentList.Add($root)
$process=[Diagnostics.Process]::Start($start)
try {
 if (-not $process.WaitForExit(20000)) { $process.Kill();throw 'Host or pipe drain timed out.' }
 $orphanId=[int](Get-Content -LiteralPath (Join-Path $root 'orphan.txt'))
 if (Get-Process -Id $orphanId -ErrorAction SilentlyContinue) { throw 'Child exit left an orphan process.' }
 if ($process.ExitCode -ne 23) { throw 'The child exit code was not preserved.' }
 $result=Get-Content -LiteralPath (Join-Path $root 'console.json') -Raw | ConvertFrom-Json
 if ($result.console -ne 0 -or $result.root -cne $root) { throw 'The child owns a console or received wrong arguments.' }
} finally { $process.Dispose() }
$start.ArgumentList[1]='unapproved.ps1'
$invalid=[Diagnostics.Process]::Start($start)
try { $invalid.WaitForExit();if ($invalid.ExitCode -ne 67) { throw 'Unapproved entry accepted.' } } finally {$invalid.Dispose()}
$crashProbe='param([string]$InstallRoot); [IO.File]::WriteAllText((Join-Path $InstallRoot "pid.txt"),[string]$PID); Start-Sleep -Seconds 60'
[IO.File]::WriteAllText((Join-Path $root 'Run-Bridge.ps1'),$crashProbe,[Text.UTF8Encoding]::new($false))
$start.ArgumentList[1]='Run-Bridge.ps1'
$hostProcess=[Diagnostics.Process]::Start($start)
try {
 $deadline=[DateTime]::UtcNow.AddSeconds(10)
 while (-not (Test-Path -LiteralPath (Join-Path $root 'pid.txt')) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 100 }
 $childId=[int](Get-Content -LiteralPath (Join-Path $root 'pid.txt'))
 $child=Get-Process -Id $childId -ErrorAction Stop
 try {
  $hostProcess.Kill();$hostProcess.WaitForExit()
  if (-not $child.WaitForExit(5000)) { throw 'Launcher crash left its owned child running.' }
 } finally { $child.Dispose() }
} finally { if (-not $hostProcess.HasExited) {$hostProcess.Kill()};$hostProcess.Dispose() }
[pscustomobject]@{passed=7;guiSubsystemVerified=$true;childConsoleHandle=0;streamDrainVerified=$true;exitCodeVerified=$true;invalidEntryRejected=$true;testRoot=$root}
