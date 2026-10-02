[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
$module=Import-Module (Join-Path $PSScriptRoot 'WindowsNative.psm1') -Force -PassThru
$checks=0
function Check([bool]$Value,[string]$Name){if(-not $Value){throw $Name};$script:checks++}
function Codes($Report,[string]$Expected='S-1-5-21-1-2-3-1001',[string]$Mode='Standard'){@(& $module {param($r,$e,$m)Test-WindowsNativePolicy $r $e $m} $Report $Expected $Mode|ForEach-Object{$_.code})}
function Good { [pscustomobject]@{package=[pscustomobject]@{unpackaged=$true};identity=[pscustomobject]@{sid='S-1-5-21-1-2-3-1001';elevated=$false;administrator_member=$false;profile_matches=$true;profile_path='C:\Users\Fixture'};appdata=[pscustomobject]@{roaming=[pscustomobject]@{requested='C:\Users\Fixture\AppData\Roaming';matches_requested=$true;matches_environment=$true};local=[pscustomobject]@{requested='C:\Users\Fixture\AppData\Local';matches_requested=$true;matches_environment=$true}};paths=@()} }
$r=Good;Check ((Codes $r).Count -eq 0) 'VALID_STANDARD_REJECTED'
$r=Good;$r.package.unpackaged=$false;Check ((Codes $r) -contains 'WINDOWS_NATIVE_PACKAGED_PROCESS_REJECTED') 'PACKAGE_ACCEPTED'
$r=Good;$r.identity.profile_matches=$false;Check ((Codes $r) -contains 'WINDOWS_NATIVE_PROFILE_IDENTITY_MISMATCH') 'INHERITED_OTHER_USER_ENV_ACCEPTED'
$r=Good;Check ((Codes $r 'S-1-5-21-1-2-3-1002') -contains 'WINDOWS_NATIVE_USER_MISMATCH') 'WRONG_SID_ACCEPTED'
$r=Good;Check ((Codes $r 'not-a-sid') -contains 'WINDOWS_NATIVE_EXPECTED_SID_INVALID') 'MALFORMED_EXPECTED_SID_ACCEPTED'
$r=Good;$r.identity.elevated=$true;Check ((Codes $r) -contains 'WINDOWS_NATIVE_ELEVATION_MISMATCH') 'ADMIN_ACCEPTED_AS_STANDARD'
$r=Good;Check ((Codes $r 'S-1-5-21-1-2-3-1001' 'Administrator') -contains 'WINDOWS_NATIVE_ELEVATION_MISMATCH') 'STANDARD_ACCEPTED_AS_ADMIN'
$r=Good;$r.identity.elevated=$true;$r.identity.administrator_member=$true;Check ((Codes $r 'S-1-5-21-1-2-3-1001' 'Administrator').Count -eq 0) 'ADMIN_REJECTED'
foreach($folder in @('roaming','local')){foreach($field in @('matches_requested','matches_environment')){$r=Good;$r.appdata.$folder.$field=$false;Check ((Codes $r) -contains 'WINDOWS_NATIVE_APPDATA_REDIRECTED') ('REDIRECT_ACCEPTED_'+$folder+'_'+$field)}}
$r=Good;$r.paths=@([pscustomobject]@{requested='C:\Fixture';matches_requested=$false});Check ((Codes $r) -contains 'WINDOWS_NATIVE_PATH_REDIRECTED') 'FINAL_PATH_ALIAS_ACCEPTED'
$r=Good;Check ((Codes $r '' 'Any').Count -eq 0) 'OPTIONAL_IDENTITY_INSPECTION_REJECTED'
foreach($path in @('relative.txt','\\server\share\file')){$errorText='';try{Get-WindowsNativePath $path|Out-Null}catch{$errorText=$_.Exception.Message};Check ($errorText -eq 'WINDOWS_NATIVE_LOCAL_ABSOLUTE_PATH_REQUIRED') 'UNSAFE_PATH_NOT_REJECTED_BEFORE_IO'}
$errorText='';try{Get-WindowsNativePath ('C:\__WindowsNativeMissing_'+[guid]::NewGuid().ToString('N'))|Out-Null}catch{$errorText=$_.Exception.Message};Check ($errorText -eq 'WINDOWS_NATIVE_PATH_MISSING') 'MISSING_PATH_ACCEPTED'
$path=Get-WindowsNativePath (Join-Path $PSScriptRoot 'WindowsNative.psm1');Check ($path.matches_requested) 'REAL_FINAL_PATH_NOT_VERIFIED'
Check ((Resolve-WindowsNativeSid 'S-1-5-18') -ceq 'S-1-5-18') 'SID_NORMALIZATION_FAILED'
$actual=Get-WindowsNativeContext -ExistingPath (Join-Path $PSScriptRoot 'WindowsNative.psm1')
Check ($actual.schema_version -eq 1 -and $actual.read_only -and $actual.status -in @('WINDOWS_NATIVE_CHECK_FAILED','WINDOWS_NATIVE_CHECK_PASSED')) 'REAL_REPORT_CONTRACT_FAILED'
Check (($actual.ok -and $actual.errors.Count -eq 0) -or (-not $actual.ok -and $actual.errors.Count -gt 0)) 'REAL_REPORT_FALSE_SUCCESS'
foreach($file in Get-ChildItem -LiteralPath $PSScriptRoot -File|Where-Object{$_.Extension -in '.ps1','.psm1'}){$t=$null;$e=$null;[Management.Automation.Language.Parser]::ParseFile($file.FullName,[ref]$t,[ref]$e)|Out-Null;Check ($e.Count -eq 0) ('PARSE_FAILED_'+$file.Name)}
[pscustomobject]@{status='PASS';checks=$checks;system_changes=0;files_written=0;real_context_ok=$actual.ok;real_context_errors=@($actual.errors|ForEach-Object{$_.code})}|ConvertTo-Json -Depth 4
