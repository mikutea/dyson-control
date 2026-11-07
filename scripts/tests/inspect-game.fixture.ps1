# Validate the Windows inspector in its native host with fixture tasks, processes, SMB aliases and NIC counters.
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$fixtureId = [guid]::NewGuid().ToString('N')
$cleanupRoot = [IO.Path]::GetFullPath((Join-Path $tempRoot ('dyson-inspect-' + $fixtureId)))
$null = New-Item -ItemType Directory -Path $cleanupRoot
try {
  # Get the same expanded spelling that a real DSP process reports on runners with an 8.3 TEMP path.
  $root = (& node.exe -p "require('node:fs').realpathSync.native(process.argv[1])" $cleanupRoot)
  if ($LASTEXITCODE -ne 0) { throw 'Unable to resolve fixture root.' }
  $windows = (Resolve-Path (Join-Path $PSScriptRoot '..\windows')).Path
  $InspectScript = Join-Path $windows 'inspect-game.ps1'
  $ArgumentsPath = Join-Path $root 'inspect-arguments.json'
  $inputObject = [pscustomobject]@{
    gameRoot = (Join-Path $root 'game'); saveDirectory = (Join-Path $root 'Save')
    logFile = (Join-Path $root 'game.log'); managedStartScript = (Join-Path $windows 'start-game.ps1')
    startupSettingsPath = (Join-Path $root 'settings.json'); startTaskName = 'Isolated Dyson inspect'; requireProcessIdentity = $true
  }
  $null = New-Item -ItemType Directory -Path $inputObject.gameRoot,$inputObject.saveDirectory
  [IO.File]::WriteAllText($ArgumentsPath, ($inputObject | ConvertTo-Json))
  [IO.File]::WriteAllText($inputObject.startupSettingsPath, '{"schema":1,"targetUps":60,"saveName":null}')
  $startArguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + [string]$inputObject.managedStartScript + '" -GameRoot "' + [string]$inputObject.gameRoot + '" -SaveDirectory "' + [string]$inputObject.saveDirectory + '" -SettingsPath "' + [string]$inputObject.startupSettingsPath + '" -LogFile "' + [string]$inputObject.logFile + '" -ProcessPriority AboveNormal'
  $startAction = [pscustomobject]@{ Execute = (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'); Arguments = $startArguments; WorkingDirectory = [string]$inputObject.gameRoot }
  function Get-CimInstance {
    [CmdletBinding()]param([string]$ClassName, [string]$Filter)
    if ($variant -ceq 'unidentified') { return [pscustomobject]@{ ExecutablePath = $null; ProcessId = 4103 } }
    if ($variant -ceq 'separate') { return [pscustomobject]@{ ExecutablePath = (Join-Path (Join-Path ([string]$inputObject.gameRoot) 'other') 'DSPGAME.exe'); ProcessId = 4104 } }
    if (-not $DuplicateProcess) { return @() }
    $gameExe = Join-Path ([string]$inputObject.gameRoot) 'DSPGAME.exe'
    if ($UseSmbAlias) { $gameExe = '\\fixture-server\fixture-share' + $gameExe.Substring(2) }
    return @(
      [pscustomobject]@{ ExecutablePath = $gameExe; ProcessId = 4101; CommandLine = 'DSPGAME.exe' },
      [pscustomobject]@{ ExecutablePath = $gameExe; ProcessId = 4102; CommandLine = 'DSPGAME.exe' }
    )
  }
  function Get-SmbGlobalMapping {
    [CmdletBinding()]param()
    if (-not $UseSmbAlias) { return @() }
    return @([pscustomobject]@{ LocalPath = ([IO.Path]::GetPathRoot([string]$inputObject.gameRoot)).TrimEnd('\'); RemotePath = '\\fixture-server\fixture-share'; Status = 0 })
  }
  function Get-NetAdapter {
    [CmdletBinding()]param([string]$Name, [switch]$Physical)
    if (-not $Physical) { throw 'inspect must request physical adapters' }
    return @(
      [pscustomobject]@{ Name = 'Ethernet'; InterfaceGuid = [Guid]'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'; Status = 'Up' },
      [pscustomobject]@{ Name = 'Disconnected'; InterfaceGuid = [Guid]'11111111-2222-4333-8444-555555555555'; Status = 'Disconnected' }
    )
  }
  function Get-NetAdapterStatistics {
    [CmdletBinding()]param([string]$Name)
    if ($Name -cne 'Ethernet') { throw 'unexpected adapter statistics request' }
    return [pscustomobject]@{ ReceivedBytes = [UInt64]9007199254740993; SentBytes = [UInt64]9007199254740995 }
  }
  function Get-ScheduledTask {
    [CmdletBinding()]param([string]$TaskName)
    if (-not $TaskName -or $TaskName -ceq [string]$inputObject.startTaskName) { return [pscustomobject]@{ TaskName = [string]$inputObject.startTaskName; TaskPath = '\'; Actions = @($startAction) } }
    return $null
  }

  foreach ($variant in @('managed', 'unexpected', 'ambiguous', 'unidentified', 'separate')) {
    $DuplicateProcess = $variant -ceq 'ambiguous'
    $UseSmbAlias = $DuplicateProcess
    $startAction.Arguments = $startArguments
    if ($variant -ceq 'unexpected') { $startAction.Arguments += ' -Unexpected value' }
    $errorMessage = $null
    $data = $null
    try { $data = (& $InspectScript -ArgumentsPath $ArgumentsPath) | ConvertFrom-Json }
    catch { $errorMessage = $_.Exception.Message }
    switch ($variant) {
      'managed' {
        if (-not $data.tasks.startManaged -or $null -ne $data.versions.game -or $null -ne $data.versions.nebula -or $null -ne $data.versions.bepinex -or
          $data.network.sampledAtUnixMs -le 0 -or @($data.network.adapters).Count -ne 1) { throw "Managed contract/metrics failed. $errorMessage" }
        $nic = $data.network.adapters[0]
        if ($nic.id -cne 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' -or
          $nic.receivedBytes -isnot [string] -or $nic.sentBytes -isnot [string] -or
          $nic.receivedBytes -cne '9007199254740993' -or $nic.sentBytes -cne '9007199254740995') { throw 'Physical NIC identity/counters changed.' }
      }
      'unexpected' { if ($null -ne $errorMessage -or $null -eq $data -or $data.tasks.startManaged -ne $false) { throw "Unexpected argument was not rejected. $errorMessage" } }
      'ambiguous' { if ($null -ne $data -or $errorMessage -notlike '*managed instance is ambiguous*') { throw "Ambiguous process check failed. $errorMessage" } }
      'unidentified' { if ($null -ne $data -or $errorMessage -notlike '*Cannot identify a DSPGAME.exe process for restore*') { throw "Unidentified process check failed. $errorMessage" } }
      'separate' { if ($null -ne $errorMessage -or $null -eq $data -or $null -ne $data.process) { throw "Unrelated executable was not excluded. $errorMessage" } }
    }
    Write-Output "Passed Windows inspector case: $variant"
  }
} finally {
  if ([IO.Path]::GetDirectoryName($cleanupRoot) -ne $tempRoot.TrimEnd('\') -or [IO.Path]::GetFileName($cleanupRoot) -cne ('dyson-inspect-' + $fixtureId)) {
    throw 'Unexpected fixture cleanup scope.'
  }
  Remove-Item -LiteralPath $cleanupRoot -Recurse -Force
}
