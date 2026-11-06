$ErrorActionPreference = 'Stop'
$inspect = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\windows\inspect-game.ps1'))
$probeInput = Join-Path ([IO.Path]::GetTempPath()) ('dyson-recovery-' + [guid]::NewGuid().ToString('N') + '.json')
$folder = [IO.Path]::GetDirectoryName($probeInput)
$expectedSid = 'S-1-5-21-197-198-199-1001'
$otherSid = 'S-1-5-21-197-198-199-1002'
$inputData = [ordered]@{ checkRecoveryStart=$true; requireProcessIdentity=$true; gameRoot=(Join-Path $folder 'Fixture Game'); startTaskName='Fixture Start'
  saveDirectory=(Join-Path $folder 'Fixture Saves'); logFile=(Join-Path $folder 'fixture.log'); startupSettingsPath=(Join-Path $folder 'settings.json')
  managedStartScript=(Join-Path $folder 'start-game.ps1') }
$taskArgs = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -GameRoot "{1}" -SaveDirectory "{2}" -SettingsPath "{3}" -LogFile "{4}" -ProcessPriority AboveNormal' -f
  $inputData.managedStartScript,$inputData.gameRoot,$inputData.saveDirectory,$inputData.startupSettingsPath,$inputData.logFile
$task = [pscustomobject]@{ TaskName=$inputData.startTaskName; TaskPath='\'; Description='DYSON_CONTROL_MANAGED_GAME_START_V1'; State='Ready'; Triggers=@()
  Settings=@{ Enabled=$true }; Principal=@{ UserId=$expectedSid; LogonType='Interactive'; RunLevel='Limited' }
  Actions=@([pscustomobject]@{ Execute=(Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'); Arguments=$taskArgs; WorkingDirectory=$inputData.gameRoot }) }
$global:DysonRecoveryReadFixture = [pscustomobject]@{ tasks=@($task); game=@(); steam=@(); local=$true; denied=$false; network=0; steamReads=0 }
function Get-SmbGlobalMapping { }
function Get-NetAdapter { $global:DysonRecoveryReadFixture.network++; return @() }
function Get-ScheduledTask { if ($global:DysonRecoveryReadFixture.denied) { throw 'fixture scheduler denied' }; return $global:DysonRecoveryReadFixture.tasks }
function Get-CimInstance($ClassName, $Filter) {
  if ($ClassName -ceq 'Win32_UserAccount') { return [pscustomobject]@{ SID='S-1-5-21-197-198-199-1001'; LocalAccount=$global:DysonRecoveryReadFixture.local; Disabled=$false } }
  if ($ClassName -ceq 'Win32_Process' -and $Filter -like '*steam.exe*') { $global:DysonRecoveryReadFixture.steamReads++; return $global:DysonRecoveryReadFixture.steam }
  if ($ClassName -ceq 'Win32_Process' -and $Filter -like '*DSPGAME.exe*') { return $global:DysonRecoveryReadFixture.game }
  throw 'Unexpected fixture query.'
}
function Invoke-CimMethod($InputObject,$MethodName) {
  if ($MethodName -cne 'GetOwnerSid') { throw 'Unexpected OS query.' }
  return [pscustomobject]@{ ReturnValue=$InputObject.OwnerResult; Sid=$InputObject.OwnerSid }
}
function Get-Process { throw 'Unexpected process details.' }
function Start-ScheduledTask { throw 'Unexpected task execution.' }
function Register-ScheduledTask { throw 'Unexpected task registration.' }
function Start-Process { throw 'Unexpected process launch.' }
function Steam([int]$Session, [string]$Sid, [int]$Code = 0) { return [pscustomobject]@{ SessionId=$Session; OwnerSid=$Sid; OwnerResult=$Code } }
function Check([string]$Wanted) {
  $result = (& $inspect -ArgumentsPath $probeInput) | ConvertFrom-Json
  if ($result.state -cne $Wanted -or @($result.PSObject.Properties.Name).Count -ne 1) { throw "Expected $Wanted, got $($result.state)." }
}
try {
  [IO.File]::WriteAllText($probeInput,($inputData | ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
  Check 'steam-missing'
  $global:DysonRecoveryReadFixture.steam = @((Steam 0 $expectedSid),(Steam 2 $otherSid))
  Check 'steam-other-user'
  $global:DysonRecoveryReadFixture.steam += @((Steam 7 $expectedSid),(Steam 7 $expectedSid))
  Check 'ready'
  $global:DysonRecoveryReadFixture.steam += (Steam 9 $expectedSid)
  Check 'session-ambiguous'
  $global:DysonRecoveryReadFixture.steam = @((Steam 7 $expectedSid),(Steam 9 '' 2))
  Check 'unknown'
  $global:DysonRecoveryReadFixture.steam = @((Steam 0 $expectedSid))
  Check 'steam-missing'
  $global:DysonRecoveryReadFixture.local = $false; Check 'task-unavailable'; $global:DysonRecoveryReadFixture.local = $true
  $task.Principal.LogonType = 'ServiceAccount'; Check 'task-unavailable'; $task.Principal.LogonType = 'Interactive'
  $task.Description = 'foreign'; Check 'task-unavailable'; $task.Description = 'DYSON_CONTROL_MANAGED_GAME_START_V1'
  $task.State = 'Disabled'; Check 'task-unavailable'; $task.State = 'Ready'
  $task.Actions[0].Arguments += ' -Unknown'; Check 'task-unavailable'; $task.Actions[0].Arguments = $taskArgs
  $global:DysonRecoveryReadFixture.tasks += [pscustomobject]@{TaskName=$task.TaskName;TaskPath='\other'}
  Check 'task-unavailable'
  $global:DysonRecoveryReadFixture.tasks = @()
  Check 'task-unavailable'
  $global:DysonRecoveryReadFixture.game = @([pscustomobject]@{ ExecutablePath=(Join-Path $inputData.gameRoot 'DSPGAME.exe') })
  Check 'game-present'
  $global:DysonRecoveryReadFixture.game = @()
  if ($global:DysonRecoveryReadFixture.network) { throw 'Recovery queried unrelated network metrics.' }

  # An ordinary overview never enumerates Steam processes or users for this gate.
  $global:DysonRecoveryReadFixture.tasks = @($task); $prior = $global:DysonRecoveryReadFixture.steamReads
  $inputData.Remove('checkRecoveryStart')
  [IO.File]::WriteAllText($probeInput,($inputData | ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
  $regular = (& $inspect -ArgumentsPath $probeInput) | ConvertFrom-Json
  if ($regular.tasks.startManaged -ne $true -or $prior -ne $global:DysonRecoveryReadFixture.steamReads) { throw 'Ordinary inspection performed the recovery probe.' }
  'RECOVERY_READINESS_MOCK_OK'
} finally {
  if ([IO.File]::Exists($probeInput)) { [IO.File]::Delete($probeInput) }
}
