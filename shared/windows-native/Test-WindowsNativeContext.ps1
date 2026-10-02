[CmdletBinding()]
param([string]$ExpectedUserSid,[ValidateSet('Any','Standard','Administrator')][string]$Elevation='Any',[string[]]$ExistingPath=@())
$ErrorActionPreference='Stop'
Import-Module (Join-Path $PSScriptRoot 'WindowsNative.psm1') -Force
$report=Get-WindowsNativeContext @PSBoundParameters
$report|ConvertTo-Json -Depth 8
if(-not $report.ok){exit 1}
exit 0
