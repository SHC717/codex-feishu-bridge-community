param([Parameter(Mandatory)][string]$OutputDirectory)
$ErrorActionPreference='Stop'
$compiler=Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler -PathType Leaf)) { throw 'The existing Windows .NET Framework compiler is required; no dependencies are installed.' }
[void][IO.Directory]::CreateDirectory($OutputDirectory)
$destination=Join-Path $OutputDirectory 'NoWindowHost.exe'
if (Test-Path -LiteralPath $destination) { throw 'Use a new build directory; existing artifacts are never overwritten.' }
& $compiler /nologo /target:winexe /platform:x64 /optimize+ ("/out:"+$destination) (Join-Path $PSScriptRoot 'NoWindowHost.cs')
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $destination)) { throw 'No-window host compilation failed.' }
$bytes=[IO.File]::ReadAllBytes($destination);$pe=[BitConverter]::ToInt32($bytes,0x3c)
if ([BitConverter]::ToUInt16($bytes,$pe+24+68) -ne 2) { throw 'The launcher must use the Windows GUI subsystem.' }
$destination
