param([Parameter(Mandatory = $true)][string]$ArgumentsPath)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'path-policy.ps1')
$argsObject = Get-Content -LiteralPath $ArgumentsPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($null -eq $argsObject.gameRoot -or [string]::IsNullOrWhiteSpace([string]$argsObject.gameRoot)) { throw 'gameRoot is required.' }
$gameRoot = [IO.Path]::GetFullPath([string]$argsObject.gameRoot)
$gameExe = [IO.Path]::GetFullPath((Join-Path $gameRoot 'DSPGAME.exe'))
$canonicalGameExe = ConvertTo-DysonCanonicalPath $gameExe

function Get-FullPathOrNull([object]$Value) {
  if ($null -eq $Value -or [string]::IsNullOrWhiteSpace([string]$Value)) { return $null }
  return [IO.Path]::GetFullPath([string]$Value)
}

$managedStartScript = Get-FullPathOrNull $argsObject.managedStartScript
$startupSettingsPath = Get-FullPathOrNull $argsObject.startupSettingsPath
$saveDirectory = Get-FullPathOrNull $argsObject.saveDirectory
$logFile = Get-FullPathOrNull $argsObject.logFile

$matchingProcesses = @(
  Get-CimInstance Win32_Process -Filter "Name = 'DSPGAME.exe'" | Where-Object {
    if ($null -eq $_.ExecutablePath) { return $false }
    try { return (ConvertTo-DysonCanonicalPath ([string]$_.ExecutablePath)).Equals($canonicalGameExe, [StringComparison]::OrdinalIgnoreCase) }
    catch { return $false }
  }
)
if ($matchingProcesses.Count -gt 1) {
  throw "Multiple DSPGAME.exe processes match the configured game root; the managed instance is ambiguous."
}
$process = $matchingProcesses | Select-Object -First 1

$processResult = $null
if ($null -ne $process) {
  $osProcess = Get-Process -Id ([int]$process.ProcessId) -ErrorAction Stop
  $commandLine = [string]$process.CommandLine
  $upsMatch = [regex]::Match($commandLine, '(?:^|\s)"?-ups"?\s+"?(?<ups>\d+)"?(?:\s|$)', [Text.RegularExpressions.RegexOptions]::IgnoreCase)
  $saveMatch = [regex]::Match($commandLine, '(?:^|\s)"?-load"?\s+(?:"(?<save>[^"]+)"|(?<save>\S+))(?:\s|$)', [Text.RegularExpressions.RegexOptions]::IgnoreCase)
  $processResult = [ordered]@{
    pid = [int]$process.ProcessId
    startedAt = $osProcess.StartTime.ToUniversalTime().ToString('o')
    workingSetBytes = [long]$osProcess.WorkingSet64
    totalProcessorSeconds = [double]$osProcess.TotalProcessorTime.TotalSeconds
    targetUps = if ($upsMatch.Success) { [int]$upsMatch.Groups['ups'].Value } else { $null }
    selectedSave = if ($saveMatch.Success) { [string]$saveMatch.Groups['save'].Value } else { $null }
  }
}

# Stamp the CPU counter when it is read, before the remaining host/task queries.
$processSampledAtUnixMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()

# Host-wide traffic counters. Restricting the set to active physical adapters avoids
# double-counting Hyper-V/tunnel interfaces; these counters are not process-specific.
$networkResult = $null
try {
  $networkAdapters = @(
    Get-NetAdapter -Name '*' -Physical -ErrorAction Stop |
      Where-Object { [string]$_.Status -eq 'Up' } |
      Sort-Object @{ Expression = { [string]$_.InterfaceGuid } }
  )
  $networkCounters = @()
  foreach ($adapter in $networkAdapters) {
    $adapterId = ([Guid]$adapter.InterfaceGuid).ToString('D').ToLowerInvariant()
    $statistics = Get-NetAdapterStatistics -Name ([string]$adapter.Name) -ErrorAction Stop
    $networkCounters += [ordered]@{
      id = $adapterId
      receivedBytes = ([UInt64]$statistics.ReceivedBytes).ToString([Globalization.CultureInfo]::InvariantCulture)
      sentBytes = ([UInt64]$statistics.SentBytes).ToString([Globalization.CultureInfo]::InvariantCulture)
    }
  }
  $networkResult = [ordered]@{
    sampledAtUnixMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    adapters = @($networkCounters)
  }
} catch {
  # Network telemetry is optional. Process and lifecycle inspection must remain available
  # on hosts without the NetAdapter module or when a physical adapter disappears mid-read.
  $networkResult = $null
}

function Get-ExactTask([object]$NameValue) {
  if ($null -eq $NameValue) { return $null }
  $name = [string]$NameValue
  if ([string]::IsNullOrWhiteSpace($name) -or $name.Length -gt 240 -or $name -match '[*?\[\]]') { return $null }
  return Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue | Where-Object { $_.TaskName -ceq $name } | Select-Object -First 1
}

function Get-ActionOption([object]$Action, [string]$Name) {
  $parseErrors = $null
  $tokens = [Management.Automation.PSParser]::Tokenize([string]$Action.Arguments, [ref]$parseErrors)
  if ($parseErrors -or -not $tokens) { return $null }
  $contents = @($tokens | ForEach-Object { [string]$_.Content })
  $values = @()
  for ($index = 0; $index -lt ($contents.Count - 1); $index++) {
    if ($contents[$index].Equals($Name, [StringComparison]::OrdinalIgnoreCase)) { $values += $contents[$index + 1] }
  }
  if ($values.Count -ne 1) { return $null }
  return $values[0]
}

function Test-PathEquals([object]$Actual, [string]$Expected) {
  if ($null -eq $Actual -or $null -eq $Expected) { return $false }
  return Test-DysonPathEquals ([string]$Actual) $Expected
}

function Test-ManagedStartScript([object]$Actual, [string]$Expected) {
  if (Test-PathEquals $Actual $Expected) { return $true }
  if ($null -eq $Actual -or [string]::IsNullOrWhiteSpace([string]$Actual)) { return $false }
  try {
    $actualPath = [IO.Path]::GetFullPath([string]$Actual)
    $expectedPath = [IO.Path]::GetFullPath($Expected)
    $actualVersion = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $actualPath))
    $expectedVersion = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $expectedPath))
    $versionsRoot = Split-Path -Parent $expectedVersion
    if ((Split-Path -Leaf $versionsRoot) -cne 'versions' -or
        -not (Test-PathEquals (Split-Path -Parent $actualVersion) $versionsRoot) -or
        -not (Test-PathEquals $actualPath (Join-Path $actualVersion 'scripts\windows\start-game.ps1')) -or
        -not (Test-PathEquals $expectedPath (Join-Path $expectedVersion 'scripts\windows\start-game.ps1'))) { return $false }
    foreach ($version in @($actualVersion, $expectedVersion)) {
      if ((Split-Path -Leaf $version) -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$') { return $false }
      foreach ($directory in @($version, (Join-Path $version 'scripts'), (Join-Path $version 'scripts\windows'))) {
        $item = Get-Item -LiteralPath $directory -Force -ErrorAction Stop
        if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { return $false }
      }
    }
    # A panel-only upgrade leaves the running game task in place. Accept its
    # retained version only while both startup implementation files are exact.
    foreach ($name in @('start-game.ps1', 'path-policy.ps1')) {
      $oldFile = Get-Item -LiteralPath (Join-Path $actualVersion ('scripts\windows\' + $name)) -Force -ErrorAction Stop
      $newFile = Get-Item -LiteralPath (Join-Path $expectedVersion ('scripts\windows\' + $name)) -Force -ErrorAction Stop
      if ($oldFile.PSIsContainer -or $newFile.PSIsContainer -or $oldFile.Length -lt 1 -or
          ($oldFile.Attributes -band [IO.FileAttributes]::ReparsePoint) -or ($newFile.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
          (Get-FileHash -LiteralPath $oldFile.FullName -Algorithm SHA256).Hash -cne (Get-FileHash -LiteralPath $newFile.FullName -Algorithm SHA256).Hash) { return $false }
    }
    return $true
  }
  catch { return $false }
}

function Test-ManagedStartArguments([object]$Action) {
  $parseErrors = $null
  $tokens = [Management.Automation.PSParser]::Tokenize([string]$Action.Arguments, [ref]$parseErrors)
  if ($parseErrors -or -not $tokens) { return $false }
  $contents = @($tokens | ForEach-Object { [string]$_.Content })
  $switches = @('-NoLogo', '-NoProfile', '-NonInteractive')
  $valueOptions = @('-ExecutionPolicy', '-File', '-GameRoot', '-SaveDirectory', '-SettingsPath', '-LogFile', '-ProcessPriority')
  if ($contents.Count -ne ($switches.Count + (2 * $valueOptions.Count))) { return $false }
  foreach ($name in @($switches + $valueOptions)) {
    if (@($contents | Where-Object { $_.Equals($name, [StringComparison]::OrdinalIgnoreCase) }).Count -ne 1) { return $false }
  }
  return (
    ([string](Get-ActionOption $Action '-ExecutionPolicy')).Equals('Bypass', [StringComparison]::OrdinalIgnoreCase) -and
    ([string](Get-ActionOption $Action '-ProcessPriority')).Equals('AboveNormal', [StringComparison]::OrdinalIgnoreCase) -and
    (Test-ManagedStartScript (Get-ActionOption $Action '-File') $managedStartScript) -and
    (Test-PathEquals (Get-ActionOption $Action '-SettingsPath') $startupSettingsPath) -and
    (Test-PathEquals (Get-ActionOption $Action '-GameRoot') $gameRoot) -and
    (Test-PathEquals (Get-ActionOption $Action '-SaveDirectory') $saveDirectory) -and
    (Test-PathEquals (Get-ActionOption $Action '-LogFile') $logFile)
  )
}

$startTask = Get-ExactTask $argsObject.startTaskName
$startManaged = $false
$configuredTargetUps = $null
if ($null -ne $startTask -and @($startTask.Actions).Count -eq 1) {
  $rawUps = Get-ActionOption (@($startTask.Actions)[0]) '-Ups'
  $parsedUps = 0
  if ($null -ne $rawUps -and [int]::TryParse([string]$rawUps, [ref]$parsedUps) -and $parsedUps -ge 10 -and $parsedUps -le 240) { $configuredTargetUps = $parsedUps }
}
if ($null -ne $startTask -and @($startTask.Actions).Count -eq 1 -and $null -ne $managedStartScript -and $null -ne $startupSettingsPath -and $null -ne $saveDirectory -and $null -ne $logFile) {
  $action = @($startTask.Actions)[0]
  $expectedPowerShell = [IO.Path]::GetFullPath((Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'))
  $startManaged = (
    (Test-PathEquals $action.Execute $expectedPowerShell) -and
    (Test-PathEquals $action.WorkingDirectory $gameRoot) -and
    (Test-ManagedStartArguments $action)
  )
}

$result = [ordered]@{
  process = $processResult
  # DSPGAME.exe reports Unity's product version, while DLL assembly versions do not
  # necessarily equal their Thunderstore package versions. Runtime versions are
  # accepted only from the current process's signed Bridge snapshot.
  versions = [ordered]@{
    game = $null
    nebula = $null
    bepinex = $null
  }
  tasks = [ordered]@{
    start = $null -ne $startTask
    startManaged = $startManaged
    configuredTargetUps = $configuredTargetUps
  }
  network = $networkResult
  sampledAtUnixMs = $processSampledAtUnixMs
}
$result | ConvertTo-Json -Depth 6 -Compress
