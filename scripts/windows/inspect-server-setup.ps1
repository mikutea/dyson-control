param([Parameter(Mandatory=$true)][string]$ArgumentsPath)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$inputData=Get-Content -LiteralPath $ArgumentsPath -Raw -Encoding UTF8|ConvertFrom-Json
if([string]$inputData.taskName -notmatch '^[A-Za-z0-9][A-Za-z0-9 ._-]{0,199}$'){throw 'Invalid game task name'}
$root=[IO.Path]::GetFullPath([string]$inputData.gameRoot)
$running=@(Get-CimInstance Win32_Process -Filter "Name='DSPGAME.exe'"|Where-Object{
  $_.ExecutablePath -and [string]::Equals([IO.Path]::GetFullPath($_.ExecutablePath),(Join-Path $root 'DSPGAME.exe'),[StringComparison]::OrdinalIgnoreCase)
}).Count -gt 0
$steamUsers=@{}
foreach($process in @(Get-CimInstance Win32_Process -Filter "Name='steam.exe'"|Where-Object{$_.SessionId -gt 0})){
  $owner=Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid -ErrorAction Stop
  if($owner.ReturnValue -eq 0){$steamUsers[[string]$owner.Sid]=$true}
}
$users=@(Get-LocalUser|Where-Object{$_.Enabled -and $_.SID.Value -notmatch '-(?:501|503|504)$'}|ForEach-Object{
  [ordered]@{name=$_.Name;activeSteam=$steamUsers.ContainsKey([string]$_.SID.Value)}
})
[ordered]@{taskExists=[bool](Get-ScheduledTask -TaskName ([string]$inputData.taskName) -TaskPath '\' -ErrorAction SilentlyContinue);running=$running;gameUsers=$users}|ConvertTo-Json -Depth 4 -Compress
