Set-StrictMode -Version Latest
function Initialize-WindowsNativeInterop {
 if('WindowsTools.NativeContext' -as [type]){return}
 Add-Type -TypeDefinition @'
using System;using System.Text;using System.ComponentModel;using System.Runtime.InteropServices;
namespace WindowsTools {public static class NativeContext {
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern int GetCurrentPackageFullName(ref uint size,StringBuilder name);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateFile(string name,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetFinalPathNameByHandle(IntPtr handle,StringBuilder path,uint size,uint flags);
 [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint desired,out IntPtr token);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetTokenInformation(IntPtr token,int kind,out int value,int size,out int returned);
 public static int PackageResult(){uint size=0;return GetCurrentPackageFullName(ref size,null);}
 public static int TokenValue(int kind){IntPtr token;if(!OpenProcessToken(GetCurrentProcess(),8,out token))throw new Win32Exception(Marshal.GetLastWin32Error());try{int value,length;if(!GetTokenInformation(token,kind,out value,4,out length))throw new Win32Exception(Marshal.GetLastWin32Error());return value;}finally{CloseHandle(token);}}
 public static string FinalPath(string path){IntPtr h=CreateFile(path,0,7,IntPtr.Zero,3,0x02000000,IntPtr.Zero);if(h==new IntPtr(-1))throw new Win32Exception(Marshal.GetLastWin32Error());try{var b=new StringBuilder(32768);uint n=GetFinalPathNameByHandle(h,b,(uint)b.Capacity,0);if(n==0)throw new Win32Exception(Marshal.GetLastWin32Error());if(n>=b.Capacity)throw new InvalidOperationException("FINAL_PATH_TOO_LONG");return b.ToString();}finally{CloseHandle(h);}}
}}
'@
}
function Resolve-WindowsNativeSid {
 [CmdletBinding()]param([Parameter(Mandatory=$true)][string]$Account)
 if([string]::IsNullOrWhiteSpace($Account)){throw 'WINDOWS_NATIVE_SID_UNRESOLVABLE'}
 try{if($Account -match '^S-'){return ([Security.Principal.SecurityIdentifier]::new($Account)).Value};return ([Security.Principal.NTAccount]::new($Account)).Translate([Security.Principal.SecurityIdentifier]).Value}catch{throw 'WINDOWS_NATIVE_SID_UNRESOLVABLE'}
}
function Get-WindowsNativePath {
 [CmdletBinding()]param([Parameter(Mandatory=$true)][string]$Path)
 if($Path -notmatch '^[A-Za-z]:[\\/]'){throw 'WINDOWS_NATIVE_LOCAL_ABSOLUTE_PATH_REQUIRED'}
 $requested=[IO.Path]::GetFullPath($Path).TrimEnd('\');if($requested.Length -eq 2){$requested+='\'}
 if(-not(Test-Path -LiteralPath $requested)){throw 'WINDOWS_NATIVE_PATH_MISSING'}
 Initialize-WindowsNativeInterop
 $raw=[WindowsTools.NativeContext]::FinalPath($requested)
 $final=if($raw.StartsWith('\\?\')){$raw.Substring(4)}else{$raw};$final=$final.TrimEnd('\');if($final.Length -eq 2){$final+='\'}
 [pscustomobject]@{requested=$requested;final=$final;matches_requested=($requested -ieq $final);is_reparse_point=[bool]((Get-Item -LiteralPath $requested -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)}
}
function Test-WindowsNativePolicy {
 param($Report,[string]$ExpectedUserSid,[string]$Elevation)
 $errors=New-Object System.Collections.Generic.List[object]
 if(-not $Report.package.unpackaged){$errors.Add([pscustomobject]@{code='WINDOWS_NATIVE_PACKAGED_PROCESS_REJECTED';path=$null;message='Use an independently verified ordinary Windows process.'})}
 if(-not $Report.identity.profile_matches){$errors.Add([pscustomobject]@{code='WINDOWS_NATIVE_PROFILE_IDENTITY_MISMATCH';path=$Report.identity.profile_path;message='Token SID profile, UserProfile Known Folder and USERPROFILE must agree.'})}
 if($ExpectedUserSid){
  try{$expected=([Security.Principal.SecurityIdentifier]::new($ExpectedUserSid)).Value}catch{$expected=$null;$errors.Add([pscustomobject]@{code='WINDOWS_NATIVE_EXPECTED_SID_INVALID';path=$null;message='ExpectedUserSid must be a complete SID.'})}
  if($expected -and $Report.identity.sid -cne $expected){$errors.Add([pscustomobject]@{code='WINDOWS_NATIVE_USER_MISMATCH';path=$null;message='Current token does not match the expected SID.'})}
 }
 if(($Elevation -eq 'Standard' -and $Report.identity.elevated) -or ($Elevation -eq 'Administrator' -and (-not $Report.identity.elevated -or -not $Report.identity.administrator_member))){$errors.Add([pscustomobject]@{code='WINDOWS_NATIVE_ELEVATION_MISMATCH';path=$null;message='Token elevation does not match the requested mode.'})}
 foreach($name in @('roaming','local')){$record=$Report.appdata.$name;if(-not $record.matches_requested -or -not $record.matches_environment){$errors.Add([pscustomobject]@{code='WINDOWS_NATIVE_APPDATA_REDIRECTED';path=$record.requested;message='Known Folder, environment and opened final path must agree.'})}}
 foreach($record in $Report.paths){if(-not $record.matches_requested){$errors.Add([pscustomobject]@{code='WINDOWS_NATIVE_PATH_REDIRECTED';path=$record.requested;message='The opened path resolves to a different location.'})}}
 return @($errors.ToArray())
}
function Get-WindowsNativeContext {
 [CmdletBinding()]param([string]$ExpectedUserSid,[ValidateSet('Any','Standard','Administrator')][string]$Elevation='Any',[string[]]$ExistingPath=@())
 $report=[ordered]@{schema_version=1;ok=$false;status='WINDOWS_NATIVE_CHECK_FAILED';device=$env:COMPUTERNAME;identity=$null;package=$null;appdata=[ordered]@{roaming=$null;local=$null};paths=@();errors=@();read_only=$true}
 try{
  if([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT){throw 'WINDOWS_NATIVE_WINDOWS_REQUIRED'}
  Initialize-WindowsNativeInterop
  $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
  try{$principal=[Security.Principal.WindowsPrincipal]::new($identity);$report.identity=[ordered]@{sid=$identity.User.Value;name=$identity.Name;session_id=[WindowsTools.NativeContext]::TokenValue(12);elevated=([WindowsTools.NativeContext]::TokenValue(20) -ne 0);elevation_type=[WindowsTools.NativeContext]::TokenValue(18);ui_access=([WindowsTools.NativeContext]::TokenValue(26) -ne 0);administrator_member=$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)}}finally{$identity.Dispose()}
  $package=[WindowsTools.NativeContext]::PackageResult();$report.package=[ordered]@{result=$package;unpackaged=($package -eq 15700)}
  $profileKey='Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\'+$report.identity.sid
  $registered=[Environment]::ExpandEnvironmentVariables((Get-ItemProperty -LiteralPath $profileKey -Name ProfileImagePath -ErrorAction Stop).ProfileImagePath)
  $profile=Get-WindowsNativePath ([Environment]::GetFolderPath('UserProfile'))
  $environmentProfile=[Environment]::GetEnvironmentVariable('USERPROFILE','Process')
  $report.identity.profile_path=$profile.requested
  $report.identity.profile_matches=($profile.matches_requested -and $profile.requested.TrimEnd('\') -ieq [IO.Path]::GetFullPath($registered).TrimEnd('\') -and -not [string]::IsNullOrWhiteSpace($environmentProfile) -and $profile.requested.TrimEnd('\') -ieq [IO.Path]::GetFullPath($environmentProfile).TrimEnd('\'))
  foreach($entry in @(@('roaming','ApplicationData','APPDATA'),@('local','LocalApplicationData','LOCALAPPDATA'))){
   $known=[Environment]::GetFolderPath([Environment+SpecialFolder]$entry[1]);$record=Get-WindowsNativePath $known
   $envPath=[Environment]::GetEnvironmentVariable($entry[2],'Process')
   $matches=(-not [string]::IsNullOrWhiteSpace($envPath) -and [IO.Path]::GetFullPath($envPath).TrimEnd('\') -ieq $record.requested.TrimEnd('\'))
   $record|Add-Member -NotePropertyName matches_environment -NotePropertyValue $matches;$report.appdata[$entry[0]]=$record
  }
  foreach($path in $ExistingPath){$report.paths+=Get-WindowsNativePath $path}
  $report.errors=@(Test-WindowsNativePolicy $report $ExpectedUserSid $Elevation)
  if($report.errors.Count -eq 0){$report.ok=$true;$report.status='WINDOWS_NATIVE_CHECK_PASSED'}
 }catch{$message=$_.Exception.Message;$code=if($message -match '^WINDOWS_NATIVE_[A-Z_]+$'){$message}else{'WINDOWS_NATIVE_QUERY_FAILED'};$report.errors+=[pscustomobject]@{code=$code;path=$null;message=$message}}
 [pscustomobject]$report
}
function Assert-WindowsNativeContext {
 [CmdletBinding()]param([string]$ExpectedUserSid,[ValidateSet('Any','Standard','Administrator')][string]$Elevation='Any',[string[]]$ExistingPath=@())
 $report=Get-WindowsNativeContext @PSBoundParameters
 if(-not $report.ok){throw (($report.errors|ForEach-Object{$_.code}) -join ';')}
 $report
}
Export-ModuleMember -Function Get-WindowsNativeContext,Assert-WindowsNativeContext,Get-WindowsNativePath,Resolve-WindowsNativeSid
