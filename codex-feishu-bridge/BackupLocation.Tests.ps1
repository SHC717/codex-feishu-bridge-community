
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'Get-BridgeStatus.ps1') -Library
$fixture=Join-Path ([IO.Path]::GetTempPath()) ('CodexWork\FeishuBackupTest-'+[guid]::NewGuid().ToString('N'))
$backupDir=Join-Path $fixture 'backup'
$deploymentDir=Join-Path $fixture 'deployment'
$siblingDir=Join-Path $fixture 'backup-other'
foreach ($directory in @($backupDir,$deploymentDir,$siblingDir)) { [void][IO.Directory]::CreateDirectory($directory) }
$archive=Join-Path $backupDir 'cold.zip'
$outside=Join-Path $siblingDir 'cold.zip'
$inside=Join-Path $deploymentDir 'cold.zip'
foreach ($file in @($archive,$outside,$inside)) { [IO.File]::WriteAllBytes($file,[byte[]](1,2,3)) }
$count=0
function Accept([string]$Root,[string]$Zip) {
    $actual=Resolve-CFBBackupArchive -BackupArchive $Zip -BackupRoot $Root -DeploymentRoot $deploymentDir
    if ($actual -ine (Assert-CFBRealPath $archive)) { throw 'Valid explicit backup directory was not preserved.' }
    $script:count++
}
function Reject([string]$Root,[string]$Zip,[string]$Reason) {
    $caught=$false
    try { Resolve-CFBBackupArchive -BackupArchive $Zip -BackupRoot $Root -DeploymentRoot $deploymentDir | Out-Null }
    catch { if ($_.Exception.Message -notlike "*$Reason*") { throw };$caught=$true }
    if (-not $caught) { throw "Unsafe backup path accepted: $Reason" }
    $script:count++
}
Accept $backupDir $archive
Accept ($backupDir+'\') $archive
Reject '' $archive 'explicit -BackupRoot'
Reject 'relative-backup' $archive 'local absolute'
Reject $archive $archive 'existing directory'
Reject $backupDir (Join-Path $backupDir 'missing.zip') 'existing cold-backup'
Reject $backupDir $backupDir 'existing cold-backup'
Reject $backupDir $outside 'outside the declared'
Reject $deploymentDir $inside 'outside the deployment'
Reject $fixture $inside 'outside the deployment'
Reject ([IO.Path]::GetPathRoot($archive)) $archive 'dedicated directory'
[pscustomobject]@{passed=$count;testRoot=$fixture;filesDeployed=0;messagesSent=0}
