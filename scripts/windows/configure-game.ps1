<#
.SYNOPSIS
Prepares or applies the Windows game, Bridge, secret, and managed start-task configuration.
.DESCRIPTION
PrepareOnly writes a reviewable plan and staged files without changing the game or scheduled tasks. Apply mode requires an elevated Windows PowerShell session and ConfirmStopped. Sensitive control paths remain on local NTFS; game paths may use an existing healthy SMB global mapping after a disposable SYSTEM access probe. The script backs up owned targets, deploys the hash-pinned Bridge, preserves or creates the protected secret, and registers but does not start the SYSTEM task.
.PARAMETER ConfigPath
Private Dyson Control JSON configuration.
.PARAMETER BridgeBuildDirectory
Directory containing DysonControlBridge.dll.
.PARAMETER BridgeSha256
Expected SHA-256 of DysonControlBridge.dll.
.PARAMETER PrepareOnly
Create a plan and staged files only.
.PARAMETER OutputDirectory
New directory to create for PrepareOnly output.
.PARAMETER ConfirmStopped
Required acknowledgement for apply mode after the managed game has been stopped.
#>
[CmdletBinding()]
param(
  [string]$ConfigPath = (Join-Path $env:ProgramData 'Dyson Control\control.config.json'),
  [Parameter(Mandatory = $true)][string]$BridgeBuildDirectory,
  [Parameter(Mandatory = $true)][string]$BridgeSha256,
  [switch]$PrepareOnly,
  [string]$OutputDirectory,
  [switch]$ConfirmStopped
)

$ErrorActionPreference = 'Stop'
$managedTaskDescription = 'DYSON_CONTROL_MANAGED_GAME_START_V1'
$bridgeDllName = 'DysonControlBridge.dll'
$bridgeConfigName = 'net.miyuo.dyson-control.bridge.cfg'
$utf8NoBom = [Text.UTF8Encoding]::new($false)

function Get-FullPath([string]$PathValue, [string]$BaseDirectory = '') {
  if ([string]::IsNullOrWhiteSpace($PathValue)) { throw 'A required path is empty.' }
  if ([IO.Path]::IsPathRooted($PathValue)) { return [IO.Path]::GetFullPath($PathValue) }
  if ([string]::IsNullOrWhiteSpace($BaseDirectory)) { return [IO.Path]::GetFullPath($PathValue) }
  return [IO.Path]::GetFullPath((Join-Path $BaseDirectory $PathValue))
}

function Get-PlainFile([string]$PathValue, [string]$Label, [long]$MaximumBytes = 67108864) {
  $path = Get-FullPath $PathValue
  $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop
  if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.Length -lt 1 -or $item.Length -gt $MaximumBytes) {
    throw "$Label must be a nonempty plain file no larger than $MaximumBytes bytes: $path"
  }
  return $item.FullName
}

function Get-PlainDirectory([string]$PathValue, [string]$Label) {
  $path = Get-FullPath $PathValue
  $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop
  if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw "$Label must be a plain directory: $path"
  }
  return $item.FullName
}

$pathPolicyScript = Get-PlainFile (Join-Path $PSScriptRoot 'path-policy.ps1') 'Managed path-policy.ps1' 1048576
. $pathPolicyScript

function Assert-LocalNtfsPath([string]$PathValue, [string]$Label) {
  return Get-DysonApprovedPathInfo $PathValue $Label $false $true
}

function Assert-ManagedRuntimePath([string]$PathValue, [string]$Label) {
  return Get-DysonApprovedPathInfo $PathValue $Label $true $false
}

function Assert-Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run game configuration from an elevated Windows PowerShell session.'
  }
}

function Assert-TaskName([string]$Name) {
  if ([string]::IsNullOrWhiteSpace($Name) -or $Name.Length -gt 200 -or $Name -notmatch '^[A-Za-z0-9][A-Za-z0-9 ._-]*$') {
    throw 'game.startTaskName must use 1-200 letters, digits, spaces, dots, underscores, or hyphens.'
  }
}

function Read-ControlConfiguration([string]$PathValue) {
  $path = Get-PlainFile $PathValue 'ConfigPath' 1048576
  try { $config = Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json }
  catch { throw "ConfigPath is not valid JSON: $path" }
  if ($null -eq $config.game) { throw 'The control configuration is missing game.' }
  $base = Split-Path -Parent $path
  $required = @('root', 'saveDirectory', 'backupDirectory', 'logFile', 'bridgeDirectory', 'bridgeSecretFile', 'startTaskName')
  foreach ($name in $required) {
    if ($null -eq $config.game.PSObject.Properties[$name] -or [string]::IsNullOrWhiteSpace([string]$config.game.$name)) {
      throw "The control configuration is missing game.$name."
    }
  }
  if ([string]::IsNullOrWhiteSpace([string]$config.dataDirectory)) { throw 'The control configuration is missing dataDirectory.' }
  Assert-TaskName ([string]$config.game.startTaskName)
  return [pscustomobject]@{
    Path = $path
    DataDirectory = Get-FullPath ([string]$config.dataDirectory) $base
    GameRoot = Get-FullPath ([string]$config.game.root) $base
    SaveDirectory = Get-FullPath ([string]$config.game.saveDirectory) $base
    BackupDirectory = Get-FullPath ([string]$config.game.backupDirectory) $base
    LogFile = Get-FullPath ([string]$config.game.logFile) $base
    BridgeDirectory = Get-FullPath ([string]$config.game.bridgeDirectory) $base
    BridgeSecretFile = Get-FullPath ([string]$config.game.bridgeSecretFile) $base
    StartTaskName = [string]$config.game.startTaskName
  }
}

function New-BridgeConfiguration([object]$Config) {
  foreach ($value in @($Config.BridgeDirectory, $Config.BridgeSecretFile, $Config.SaveDirectory)) {
    if ([string]$value -match '[\r\n]') { throw 'Bridge configuration paths cannot contain line breaks.' }
  }
  return (@(
    '[Bridge]',
    "ControlDirectory = $($Config.BridgeDirectory)",
    "SecretFile = $($Config.BridgeSecretFile)",
    "ExpectedSaveDirectory = $($Config.SaveDirectory)",
    ''
  ) -join "`r`n")
}

function New-SecretValue {
  $bytes = New-Object byte[] 32
  $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $generator.GetBytes($bytes) } finally { $generator.Dispose() }
  return ([BitConverter]::ToString($bytes)).Replace('-', '').ToLowerInvariant()
}

function Assert-SecretFile([string]$PathValue) {
  $path = Get-PlainFile $PathValue 'Existing Bridge secret' 2048
  $value = [IO.File]::ReadAllText($path, [Text.UTF8Encoding]::new($false, $true)).Trim()
  if ($value.Length -lt 32 -or $value.Length -gt 512 -or $value -match '[\r\n\x00]') {
    throw "The existing Bridge secret is invalid: $path"
  }
  return $path
}

function Protect-SystemAdministratorsOnly([string]$PathValue, [bool]$Directory) {
  $arguments = @($PathValue, '/inheritance:r', '/grant:r')
  if ($Directory) { $arguments += @('*S-1-5-18:(OI)(CI)(F)', '*S-1-5-32-544:(OI)(CI)(F)') }
  else { $arguments += @('*S-1-5-18:(F)', '*S-1-5-32-544:(F)') }
  & (Join-Path $env:SystemRoot 'System32\icacls.exe') @arguments | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Unable to restrict ACLs on $PathValue" }
}

function Grant-CurrentIdentityForCleanup([string]$PathValue) {
  if (-not (Test-Path -LiteralPath $PathValue)) { return }
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  & (Join-Path $env:SystemRoot 'System32\icacls.exe') $PathValue '/grant:r' "*$sid`:(F)" '/T' '/C' | Out-Null
}

function Assert-SystemRights([string]$PathValue, [Security.AccessControl.FileSystemRights]$RequiredRights, [string]$Label) {
  $acl = Get-Acl -LiteralPath $PathValue -ErrorAction Stop
  $systemSid = 'S-1-5-18'
  $administratorsSid = 'S-1-5-32-544'
  $allowed = [Security.AccessControl.FileSystemRights]0
  foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    $sid = [string]$rule.IdentityReference.Value
    if ($sid -notin @($systemSid, $administratorsSid)) { continue }
    if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Deny -and (($rule.FileSystemRights -band $RequiredRights) -ne 0)) {
      throw "$Label denies required SYSTEM access: $PathValue"
    }
    if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow) { $allowed = $allowed -bor $rule.FileSystemRights }
  }
  if (($allowed -band $RequiredRights) -ne $RequiredRights) {
    throw "$Label does not grant SYSTEM or BUILTIN\Administrators the required access: $PathValue"
  }
}

function Write-NewFile([string]$PathValue, [byte[]]$Bytes) {
  $stream = [IO.FileStream]::new($PathValue, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None, 4096, [IO.FileOptions]::WriteThrough)
  try { $stream.Write($Bytes, 0, $Bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
}

function Install-AtomicFile([string]$Source, [string]$Target) {
  $targetDirectory = Get-PlainDirectory (Split-Path -Parent $Target) 'Deployment target parent'
  $temporary = Join-Path $targetDirectory ('.dyson-control-' + [guid]::NewGuid().ToString('N') + '.tmp')
  try {
    Write-NewFile $temporary ([IO.File]::ReadAllBytes($Source))
    if (Test-Path -LiteralPath $Target) {
      [void](Get-PlainFile $Target 'Existing deployment target')
      [IO.File]::Replace($temporary, $Target, $null, $true)
    }
    else { [IO.File]::Move($temporary, $Target) }
  }
  finally { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force } }
}

function Write-AtomicText([string]$Text, [string]$Target) {
  $directory = Get-PlainDirectory (Split-Path -Parent $Target) 'Text target parent'
  $temporary = Join-Path $directory ('.dyson-control-' + [guid]::NewGuid().ToString('N') + '.tmp')
  try {
    Write-NewFile $temporary $utf8NoBom.GetBytes($Text)
    if (Test-Path -LiteralPath $Target) {
      [void](Get-PlainFile $Target 'Existing text target')
      [IO.File]::Replace($temporary, $Target, $null, $true)
    }
    else { [IO.File]::Move($temporary, $Target) }
  }
  finally { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force } }
}

function Assert-StartupSettings([string]$PathValue) {
  $path = Get-PlainFile $PathValue 'Existing startup settings' 4096
  try { $settings = Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json }
  catch { throw "Existing startup settings are invalid JSON: $path" }
  $names = @($settings.PSObject.Properties.Name | Sort-Object)
  if (($names -join ',') -cne 'saveName,schema,targetUps' -or
      ($settings.schema -isnot [int] -and $settings.schema -isnot [long]) -or [long]$settings.schema -ne 1) {
    throw "Existing startup settings have an invalid schema: $path"
  }
  if (($settings.targetUps -isnot [int] -and $settings.targetUps -isnot [long]) -or [long]$settings.targetUps -lt 10 -or [long]$settings.targetUps -gt 240) {
    throw "Existing startup settings have an invalid targetUps: $path"
  }
  if ($null -ne $settings.saveName) {
    if ($settings.saveName -isnot [string]) { throw "Existing startup settings have an invalid saveName type: $path" }
    $saveName = [string]$settings.saveName
    if ([string]::IsNullOrWhiteSpace($saveName) -or $saveName -in @('.', '..') -or $saveName.Length -gt 120 -or $saveName -match '[\\/:*?"<>|\x00-\x1f]') {
      throw "Existing startup settings have an invalid saveName: $path"
    }
  }
}

function Get-ExactTask([string]$TaskName) {
  return Get-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction SilentlyContinue |
    Where-Object { $_.TaskName -ceq $TaskName -and $_.TaskPath -eq '\' } | Select-Object -First 1
}

function Assert-GameStopped([string]$GameExecutable) {
  $running = Get-CimInstance Win32_Process -Filter "Name = 'DSPGAME.exe'" | Where-Object {
    $null -ne $_.ExecutablePath -and (Test-DysonPathEquals ([string]$_.ExecutablePath) $GameExecutable)
  } | Select-Object -First 1
  if ($null -ne $running) { throw "The managed game must be stopped; DSPGAME.exe PID $($running.ProcessId) is still running." }
}

function Quote-TaskArgument([string]$Value) {
  if ($Value -match '"') { throw "A task argument contains an unsupported double quote: $Value" }
  return '"{0}"' -f $Value
}

function Test-PathEquals([object]$Actual, [string]$Expected) {
  if ($null -eq $Actual) { return $false }
  return Test-DysonPathEquals ([string]$Actual) $Expected
}

function Test-SystemPrincipal([string]$Value) {
  if ($Value -ceq 'S-1-5-18') { return $true }
  try {
    $account = [Security.Principal.NTAccount]::new($Value)
    return $account.Translate([Security.Principal.SecurityIdentifier]).Value -ceq 'S-1-5-18'
  }
  catch { return $false }
}

function Wait-ExactTaskRegistration(
  [scriptblock]$ReadTask,
  [string]$ExpectedDescription,
  [string]$ExpectedExecute,
  [string]$ExpectedArguments,
  [string]$ExpectedWorkingDirectory,
  [scriptblock]$PathEquals,
  [scriptblock]$PrincipalMatches,
  [string]$EvidencePath,
  [int]$MaximumAttempts = 20,
  [int]$DelayMilliseconds = 250
) {
  if ($MaximumAttempts -lt 1 -or $MaximumAttempts -gt 100 -or $DelayMilliseconds -lt 0 -or $DelayMilliseconds -gt 1000) {
    throw 'Task registration verification retry limits are invalid.'
  }
  $observations = @()
  for ($attempt = 1; $attempt -le $MaximumAttempts; $attempt++) {
    $task = & $ReadTask
    $actions = @()
    if ($null -ne $task) { $actions = @($task.Actions | Where-Object { $null -ne $_ }) }
    $action = if ($actions.Count -eq 1) { $actions[0] } else { $null }
    $description = if ($null -eq $task) { '' } else { [string]$task.Description }
    $state = if ($null -eq $task) { '' } else { [string]$task.State }
    $principal = if ($null -eq $task) { '' } else { [string]$task.Principal.UserId }
    $execute = if ($null -eq $action) { '' } else { [string]$action.Execute }
    $arguments = if ($null -eq $action) { '' } else { [string]$action.Arguments }
    $workingDirectory = if ($null -eq $action) { '' } else { [string]$action.WorkingDirectory }
    $descriptionStatus = if ([string]::IsNullOrWhiteSpace($description)) { 'missing' } elseif ($description -ceq $ExpectedDescription) { 'match' } else { 'mismatch' }
    $principalStatus = if ([string]::IsNullOrWhiteSpace($principal)) { 'missing' } elseif ([bool](& $PrincipalMatches $principal)) { 'match' } else { 'mismatch' }
    $actionComplete = $null -ne $action -and -not [string]::IsNullOrWhiteSpace($execute) -and
      -not [string]::IsNullOrWhiteSpace($arguments) -and -not [string]::IsNullOrWhiteSpace($workingDirectory)
    $executeMatches = $actionComplete -and [bool](& $PathEquals $execute $ExpectedExecute)
    $argumentsMatch = $actionComplete -and $arguments -ceq $ExpectedArguments
    $workingDirectoryMatches = $actionComplete -and [bool](& $PathEquals $workingDirectory $ExpectedWorkingDirectory)
    $triggers = @()
    if ($null -ne $task) { $triggers = @($task.Triggers | Where-Object { $null -ne $_ }) }
    $observation = [ordered]@{
      attempt = $attempt
      observedAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
      taskPresent = $null -ne $task
      description = $descriptionStatus
      state = if ([string]::IsNullOrWhiteSpace($state)) { 'missing' } else { $state }
      triggerCount = $triggers.Count
      actionCount = $actions.Count
      actionComplete = $actionComplete
      executeMatches = $executeMatches
      argumentsMatch = $argumentsMatch
      workingDirectoryMatches = $workingDirectoryMatches
      principal = $principalStatus
    }
    $observations += [pscustomobject]$observation
    [IO.File]::WriteAllText($EvidencePath, ([ordered]@{ schema = 1; observations = $observations } | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))

    $incomplete = $null -eq $task -or $descriptionStatus -eq 'missing' -or [string]::IsNullOrWhiteSpace($state) -or
      $principalStatus -eq 'missing' -or $actions.Count -eq 0 -or ($actions.Count -eq 1 -and -not $actionComplete)
    if ($incomplete) {
      if ($attempt -lt $MaximumAttempts -and $DelayMilliseconds -gt 0) { Start-Sleep -Milliseconds $DelayMilliseconds }
      continue
    }
    if ($descriptionStatus -ne 'match' -or $state -eq 'Running' -or $triggers.Count -ne 0 -or
        $actions.Count -ne 1 -or -not $executeMatches -or -not $argumentsMatch -or
        -not $workingDirectoryMatches -or $principalStatus -ne 'match') {
      throw 'The managed start task failed post-registration verification.'
    }
    return $task
  }
  throw 'The managed start task remained incomplete during post-registration verification.'
}

function New-TaskArguments([object]$Config, [string]$ManagedScript, [string]$SettingsPath) {
  return @(
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', (Quote-TaskArgument $ManagedScript),
    '-GameRoot', (Quote-TaskArgument $Config.GameRoot),
    '-SaveDirectory', (Quote-TaskArgument $Config.SaveDirectory),
    '-SettingsPath', (Quote-TaskArgument $SettingsPath),
    '-LogFile', (Quote-TaskArgument $Config.LogFile),
    '-ProcessPriority', 'AboveNormal'
  ) -join ' '
}

function New-GameTask([object]$Config, [string]$ManagedScript, [string]$SettingsPath) {
  $powerShellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $arguments = New-TaskArguments $Config $ManagedScript $SettingsPath
  $action = New-ScheduledTaskAction -Execute $powerShellPath -Argument $arguments -WorkingDirectory $Config.GameRoot
  $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
  return New-ScheduledTask -Action $action -Principal $principal -Settings $settings -Description $managedTaskDescription
}

function Get-ExistingProbeDirectory([string]$PathValue, [string]$Label) {
  $candidate = Get-FullPath $PathValue
  while (-not (Test-Path -LiteralPath $candidate)) {
    $parent = Split-Path -Parent $candidate
    if ([string]::IsNullOrWhiteSpace($parent) -or $parent.Equals($candidate, [StringComparison]::OrdinalIgnoreCase)) {
      throw "No existing directory is available to probe ${Label}: $PathValue"
    }
    $candidate = $parent
  }
  return Get-PlainDirectory $candidate "SYSTEM probe directory for $Label"
}

function Invoke-SystemPathProbe([object[]]$DirectoryTargets, [object[]]$FileTargets) {
  $probeId = [guid]::NewGuid().ToString('N')
  $taskName = "Dyson Control Path Probe $probeId"
  $taskDescription = "DYSON_CONTROL_SYSTEM_PATH_PROBE_V1:$probeId"
  $temporaryRoot = Join-Path $env:SystemRoot 'Temp'
  $scriptPath = Join-Path $temporaryRoot "dyson-control-path-probe-$probeId.ps1"
  $resultPath = Join-Path $temporaryRoot "dyson-control-path-probe-$probeId.json"
  $specification = [ordered]@{ directories = @($DirectoryTargets); files = @($FileTargets) }
  $encodedSpecification = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($specification | ConvertTo-Json -Depth 5 -Compress)))
  $probeSource = @'
param([Parameter(Mandatory = $true)][string]$ResultPath, [Parameter(Mandatory = $true)][string]$EncodedSpecification, [Parameter(Mandatory = $true)][string]$ProbeId)
$ErrorActionPreference = 'Stop'
$result = [ordered]@{ schema = 1; probeId = $ProbeId; ok = $false; checked = @(); error = $null }
$createdDirectories = @()
try {
  $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($EncodedSpecification))
  $specification = $json | ConvertFrom-Json
  foreach ($target in @($specification.directories)) {
    $directory = [IO.Path]::GetFullPath([string]$target.path)
    $item = Get-Item -LiteralPath $directory -Force -ErrorAction Stop
    if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "Probe target is not a plain directory: $directory" }
    $probeDirectory = Join-Path $directory ('.dyson-control-system-probe-' + $ProbeId)
    [IO.Directory]::CreateDirectory($probeDirectory) | Out-Null
    $createdDirectories += $probeDirectory
    $first = Join-Path $probeDirectory 'write-test.bin'
    $renamed = Join-Path $probeDirectory 'rename-test.bin'
    [IO.File]::WriteAllBytes($first, [byte[]](0x44, 0x59, 0x53, 0x4f, 0x4e))
    $read = [IO.File]::ReadAllBytes($first)
    if ($read.Length -ne 5 -or $read[0] -ne 0x44 -or $read[4] -ne 0x4e) { throw "Probe readback failed: $directory" }
    [IO.File]::Move($first, $renamed)
    [IO.File]::Delete($renamed)
    [IO.Directory]::Delete($probeDirectory, $false)
    $createdDirectories = @($createdDirectories | Where-Object { $_ -cne $probeDirectory })
    $result.checked += [ordered]@{ label = [string]$target.label; path = $directory; access = 'create-write-read-rename-delete' }
  }
  foreach ($target in @($specification.files)) {
    $file = [IO.Path]::GetFullPath([string]$target.path)
    $stream = [IO.FileStream]::new($file, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete)
    try { [void]$stream.ReadByte() } finally { $stream.Dispose() }
    $result.checked += [ordered]@{ label = [string]$target.label; path = $file; access = 'read' }
  }
  $result.ok = $true
}
catch { $result.error = $_.Exception.Message }
finally {
  foreach ($directory in @($createdDirectories | Sort-Object { $_.Length } -Descending)) {
    try {
      foreach ($name in @('write-test.bin', 'rename-test.bin')) {
        $file = Join-Path $directory $name
        if ([IO.File]::Exists($file)) { [IO.File]::Delete($file) }
      }
      if ([IO.Directory]::Exists($directory)) { [IO.Directory]::Delete($directory, $false) }
    }
    catch {
      $result.ok = $false
      $result.error = "Probe cleanup failed for $directory`: $($_.Exception.Message)"
    }
  }
  [IO.File]::WriteAllText($ResultPath, ($result | ConvertTo-Json -Depth 6 -Compress), [Text.UTF8Encoding]::new($false))
}
if (-not $result.ok) { exit 1 }
'@

  $probeError = $null
  $cleanupErrors = @()
  try {
    if ($null -ne (Get-ScheduledTask -TaskName $taskName -TaskPath '\' -ErrorAction SilentlyContinue)) {
      throw "The disposable SYSTEM probe task already exists unexpectedly: $taskName"
    }
    [IO.File]::WriteAllText($scriptPath, $probeSource, $utf8NoBom)
    Protect-SystemAdministratorsOnly $scriptPath $false
    $powerShellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $arguments = @(
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', (Quote-TaskArgument $scriptPath),
      '-ResultPath', (Quote-TaskArgument $resultPath),
      '-EncodedSpecification', $encodedSpecification,
      '-ProbeId', $probeId
    ) -join ' '
    $action = New-ScheduledTaskAction -Execute $powerShellPath -Argument $arguments -WorkingDirectory $temporaryRoot
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::FromMinutes(2)) -MultipleInstances IgnoreNew
    $definition = New-ScheduledTask -Action $action -Principal $principal -Settings $settings -Description $taskDescription
    Register-ScheduledTask -TaskName $taskName -TaskPath '\' -InputObject $definition | Out-Null
    Start-ScheduledTask -TaskName $taskName -TaskPath '\'
    $deadline = [DateTimeOffset]::UtcNow.AddSeconds(60)
    do {
      Start-Sleep -Milliseconds 200
      $task = Get-ScheduledTask -TaskName $taskName -TaskPath '\' -ErrorAction Stop
      $running = [string]$task.State -in @('Running', 'Queued')
    } while ($running -and [DateTimeOffset]::UtcNow -lt $deadline)
    if ($running) { throw 'The disposable SYSTEM path probe did not finish within 60 seconds.' }
    if (-not (Test-Path -LiteralPath $resultPath -PathType Leaf)) { throw 'The disposable SYSTEM path probe did not write a result.' }
    try { $result = Get-Content -LiteralPath $resultPath -Raw -Encoding UTF8 | ConvertFrom-Json }
    catch { throw 'The disposable SYSTEM path probe wrote invalid result JSON.' }
    if (-not [bool]$result.ok) { throw "The disposable SYSTEM path probe failed: $([string]$result.error)" }
  }
  catch { $probeError = $_ }
  finally {
    try {
      $task = Get-ScheduledTask -TaskName $taskName -TaskPath '\' -ErrorAction SilentlyContinue
      if ($null -ne $task) {
        if ([string]$task.State -in @('Running', 'Queued')) {
          Stop-ScheduledTask -TaskName $taskName -TaskPath '\' -ErrorAction Stop
          $stopDeadline = [DateTimeOffset]::UtcNow.AddSeconds(10)
          do {
            Start-Sleep -Milliseconds 100
            $task = Get-ScheduledTask -TaskName $taskName -TaskPath '\' -ErrorAction SilentlyContinue
          } while ($null -ne $task -and [string]$task.State -in @('Running', 'Queued') -and [DateTimeOffset]::UtcNow -lt $stopDeadline)
          if ($null -ne $task -and [string]$task.State -in @('Running', 'Queued')) { throw "Probe task did not stop: $taskName" }
        }
        Unregister-ScheduledTask -TaskName $taskName -TaskPath '\' -Confirm:$false -ErrorAction Stop
      }
    } catch { $cleanupErrors += $_.Exception.Message }
    foreach ($target in @($DirectoryTargets)) {
      $probeDirectory = Join-Path ([string]$target.path) ('.dyson-control-system-probe-' + $probeId)
      try {
        foreach ($name in @('write-test.bin', 'rename-test.bin')) {
          $file = Join-Path $probeDirectory $name
          if ([IO.File]::Exists($file)) { [IO.File]::Delete($file) }
        }
        if ([IO.Directory]::Exists($probeDirectory)) { [IO.Directory]::Delete($probeDirectory, $false) }
      } catch { $cleanupErrors += $_.Exception.Message }
      if (Test-Path -LiteralPath $probeDirectory) { $cleanupErrors += "Probe directory remains: $probeDirectory" }
    }
    foreach ($file in @($resultPath, $scriptPath)) {
      try { if (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file -Force -ErrorAction Stop } }
      catch { $cleanupErrors += $_.Exception.Message }
    }
    if ($null -ne (Get-ScheduledTask -TaskName $taskName -TaskPath '\' -ErrorAction SilentlyContinue)) { $cleanupErrors += "Probe task remains registered: $taskName" }
    foreach ($file in @($resultPath, $scriptPath)) { if (Test-Path -LiteralPath $file) { $cleanupErrors += "Probe file remains: $file" } }
  }
  if ($cleanupErrors.Count -gt 0) {
    $prefix = if ($null -eq $probeError) { 'SYSTEM path probe cleanup failed' } else { "SYSTEM path probe failed: $($probeError.Exception.Message); cleanup also failed" }
    throw "$prefix`: $($cleanupErrors -join '; ')"
  }
  if ($null -ne $probeError) { throw $probeError }
}

function Copy-OriginalOrRecordAbsent([string]$Source, [string]$BackupPath, [System.Collections.IDictionary]$Record, [string]$Name) {
  if (Test-Path -LiteralPath $Source) {
    $plain = Get-PlainFile $Source "Existing $Name"
    [IO.File]::Copy($plain, $BackupPath, $false)
    $Record[$Name] = [ordered]@{ existed = $true; file = [IO.Path]::GetFileName($BackupPath); sha256 = (Get-FileHash -LiteralPath $BackupPath -Algorithm SHA256).Hash.ToLowerInvariant() }
  }
  else { $Record[$Name] = [ordered]@{ existed = $false; file = $null; sha256 = $null } }
}

$configuration = Read-ControlConfiguration $ConfigPath
$buildDirectory = Get-PlainDirectory $BridgeBuildDirectory 'BridgeBuildDirectory'
$bridgeSource = Get-PlainFile (Join-Path $buildDirectory $bridgeDllName) 'Bridge DLL'
if ($BridgeSha256 -notmatch '^[0-9a-fA-F]{64}$') { throw 'BridgeSha256 must be exactly 64 hexadecimal characters.' }
$actualBridgeHash = (Get-FileHash -LiteralPath $bridgeSource -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualBridgeHash -cne $BridgeSha256.ToLowerInvariant()) { throw 'Bridge DLL SHA-256 does not match BridgeSha256.' }

$managedStartScript = Get-PlainFile (Join-Path $PSScriptRoot 'start-game.ps1') 'Managed start-game.ps1' 1048576
$startupSettingsPath = Join-Path $configuration.DataDirectory 'game-startup.json'
$bridgePluginDirectory = Join-Path $configuration.GameRoot 'BepInEx\plugins\dyson-control'
$bridgeDllTarget = Join-Path $bridgePluginDirectory $bridgeDllName
$bridgeConfigDirectory = Join-Path $configuration.GameRoot 'BepInEx\config'
$bridgeConfigTarget = Join-Path $bridgeConfigDirectory $bridgeConfigName
$bridgeConfiguration = New-BridgeConfiguration $configuration
$defaultStartupSettings = "{`"schema`":1,`"targetUps`":60,`"saveName`":null}`r`n"
$secretExists = Test-Path -LiteralPath $configuration.BridgeSecretFile
$secretAction = if ($secretExists) { 'retain' } else { 'create' }
$taskArguments = New-TaskArguments $configuration $managedStartScript $startupSettingsPath

$plan = [ordered]@{
  schema = 1
  product = 'dyson-control-game-configuration'
  mode = if ($PrepareOnly) { 'prepare-only' } else { 'apply' }
  generatedAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
  configPath = $configuration.Path
  bridge = [ordered]@{
    source = $bridgeSource; sourceSha256 = $actualBridgeHash; dllTarget = $bridgeDllTarget
    configTarget = $bridgeConfigTarget; controlDirectory = $configuration.BridgeDirectory
    secretFile = $configuration.BridgeSecretFile; secretAction = $secretAction
    expectedSaveDirectory = $configuration.SaveDirectory
  }
  startupSettings = [ordered]@{ path = $startupSettingsPath; action = if (Test-Path -LiteralPath $startupSettingsPath) { 'retain' } else { 'create-default' } }
  task = [ordered]@{
    name = $configuration.StartTaskName; path = '\'; description = $managedTaskDescription
    execute = (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe')
    arguments = $taskArguments; workingDirectory = $configuration.GameRoot; account = 'SYSTEM'; startImmediately = $false
  }
  pathPolicy = [ordered]@{
    localNtfs = @('dataDirectory', 'game.bridgeDirectory', 'game.bridgeSecretFile', 'managed start script', 'managed path policy', 'startup settings')
    globalSmbEligible = @('game.root', 'game.saveDirectory', 'game.backupDirectory', 'game.logFile')
    globalSmbRequirement = 'existing healthy Get-SmbGlobalMapping only; no mapping or credentials are created'
    applyProbe = 'disposable SYSTEM task performs create/write/read/rename/delete and read checks before business changes'
  }
  guarantees = @('game-process-must-be-stopped', 'no-save-migration', 'task-is-not-started')
}

if ($PrepareOnly) {
  if ([string]::IsNullOrWhiteSpace($OutputDirectory)) { throw 'OutputDirectory is required with -PrepareOnly.' }
  $output = Get-FullPath $OutputDirectory
  if (Test-Path -LiteralPath $output) { throw "Prepare output already exists: $output" }
  $outputParent = Get-PlainDirectory (Split-Path -Parent $output) 'Prepare output parent'
  $created = $false
  try {
    New-Item -ItemType Directory -Path $output | Out-Null
    $created = $true
    [IO.File]::Copy($bridgeSource, (Join-Path $output $bridgeDllName), $false)
    [IO.File]::WriteAllText((Join-Path $output $bridgeConfigName), $bridgeConfiguration, $utf8NoBom)
    if (-not (Test-Path -LiteralPath $startupSettingsPath)) {
      [IO.File]::WriteAllText((Join-Path $output 'game-startup.json'), $defaultStartupSettings, $utf8NoBom)
    }
    if (-not $secretExists) {
      $candidateSecretPath = Join-Path $output 'bridge-secret.new'
      [IO.File]::WriteAllText($candidateSecretPath, (New-SecretValue), $utf8NoBom)
      Protect-SystemAdministratorsOnly $candidateSecretPath $false
      $plan.bridge['secretCandidate'] = 'bridge-secret.new'
    }
    [IO.File]::WriteAllText((Join-Path $output 'plan.json'), ($plan | ConvertTo-Json -Depth 8), $utf8NoBom)
    $summary = [ordered]@{ prepared = $true; outputDirectory = $output; plan = (Join-Path $output 'plan.json'); bridgeSha256 = $actualBridgeHash; targetChanged = $false }
    $summary | ConvertTo-Json -Compress
  }
  catch {
    if ($created) {
      Grant-CurrentIdentityForCleanup $output
      Remove-Item -LiteralPath $output -Recurse -Force -ErrorAction SilentlyContinue
    }
    throw
  }
  return
}

if (-not [string]::IsNullOrWhiteSpace($OutputDirectory)) { throw 'OutputDirectory is only valid with -PrepareOnly.' }
if (-not $ConfirmStopped) { throw 'Apply mode requires -ConfirmStopped after the managed game has been stopped.' }
Assert-Administrator

foreach ($entry in @(
  @($configuration.DataDirectory, 'dataDirectory'), @($configuration.BridgeDirectory, 'game.bridgeDirectory'),
  @($configuration.BridgeSecretFile, 'game.bridgeSecretFile'), @($managedStartScript, 'managed start script'),
  @($pathPolicyScript, 'managed path policy'), @($startupSettingsPath, 'startup settings')
)) { [void](Assert-LocalNtfsPath ([string]$entry[0]) ([string]$entry[1])) }
foreach ($entry in @(
  @($configuration.GameRoot, 'game.root'), @($configuration.SaveDirectory, 'game.saveDirectory'),
  @($configuration.BackupDirectory, 'game.backupDirectory'), @($configuration.LogFile, 'game.logFile')
)) { [void](Assert-ManagedRuntimePath ([string]$entry[0]) ([string]$entry[1])) }

$gameRoot = Get-PlainDirectory $configuration.GameRoot 'game.root'
$saveDirectory = Get-PlainDirectory $configuration.SaveDirectory 'game.saveDirectory'
$dataDirectory = Get-PlainDirectory $configuration.DataDirectory 'dataDirectory'
$backupDirectory = Get-PlainDirectory $configuration.BackupDirectory 'game.backupDirectory'
$gameExecutable = Get-PlainFile (Join-Path $gameRoot 'DSPGAME.exe') 'DSPGAME.exe'
[void](Get-PlainDirectory (Join-Path $gameRoot 'BepInEx') 'BepInEx directory')
[void](Get-PlainDirectory (Join-Path $gameRoot 'BepInEx\plugins') 'BepInEx plugins directory')

$namedTasks = @(Get-ScheduledTask -TaskName $configuration.StartTaskName -ErrorAction SilentlyContinue |
  Where-Object { $_.TaskName -ceq $configuration.StartTaskName })
$nonRootTask = $namedTasks | Where-Object { $_.TaskPath -ne '\' } | Select-Object -First 1
if ($null -ne $nonRootTask) {
  throw "A scheduled task with the configured name exists outside the root task path and would make inspection ambiguous: $($nonRootTask.TaskPath)$($nonRootTask.TaskName)"
}
$existingTask = $namedTasks | Where-Object { $_.TaskPath -eq '\' } | Select-Object -First 1
if ($null -ne $existingTask -and [string]$existingTask.Description -cne $managedTaskDescription) {
  throw "The exact scheduled task already exists without the Dyson Control ownership marker: $($configuration.StartTaskName)"
}
if ($null -ne $existingTask -and [string]$existingTask.State -eq 'Running') {
  throw "The managed start task is currently running: $($configuration.StartTaskName)"
}
Assert-GameStopped $gameExecutable

$probeDirectories = [ordered]@{}
foreach ($entry in @(
  @($dataDirectory, 'dataDirectory'), @($gameRoot, 'game.root'), @($saveDirectory, 'game.saveDirectory'),
  @($backupDirectory, 'game.backupDirectory'), @($bridgePluginDirectory, 'Bridge plugin parent'),
  @($bridgeConfigDirectory, 'Bridge config parent'), @((Split-Path -Parent $configuration.LogFile), 'game.logFile parent'),
  @($configuration.BridgeDirectory, 'game.bridgeDirectory'), @((Split-Path -Parent $configuration.BridgeSecretFile), 'game.bridgeSecretFile parent')
)) {
  $probeDirectory = Get-ExistingProbeDirectory ([string]$entry[0]) ([string]$entry[1])
  $key = (ConvertTo-DysonCanonicalPath $probeDirectory).ToLowerInvariant()
  if (-not $probeDirectories.Contains($key)) { $probeDirectories[$key] = [ordered]@{ label = [string]$entry[1]; path = $probeDirectory } }
}
$probeFiles = @(
  [ordered]@{ label = 'DSPGAME.exe'; path = $gameExecutable },
  [ordered]@{ label = 'managed start script'; path = $managedStartScript },
  [ordered]@{ label = 'managed path policy'; path = $pathPolicyScript }
)
if (Test-Path -LiteralPath $startupSettingsPath) { $probeFiles += [ordered]@{ label = 'startup settings'; path = $startupSettingsPath } }
if ($secretExists) { $probeFiles += [ordered]@{ label = 'Bridge secret'; path = (Assert-SecretFile $configuration.BridgeSecretFile) } }
Invoke-SystemPathProbe @($probeDirectories.Values) $probeFiles

$backupParent = Join-Path $dataDirectory 'game-configuration-backups'
if (-not (Test-Path -LiteralPath $backupParent)) { New-Item -ItemType Directory -Path $backupParent | Out-Null }
[void](Get-PlainDirectory $backupParent 'Game configuration backup parent')
$backupRoot = Join-Path $backupParent ((Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssfffZ') + '-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $backupRoot | Out-Null
[void](Get-PlainDirectory $backupRoot 'Game configuration backup directory')
Protect-SystemAdministratorsOnly $backupRoot $true
$backupRecord = [ordered]@{ schema = 1; createdAtUtc = [DateTimeOffset]::UtcNow.ToString('o'); taskName = $configuration.StartTaskName }
Copy-OriginalOrRecordAbsent $bridgeDllTarget (Join-Path $backupRoot $bridgeDllName) $backupRecord 'bridgeDll'
Copy-OriginalOrRecordAbsent $bridgeConfigTarget (Join-Path $backupRoot $bridgeConfigName) $backupRecord 'bridgeConfig'
$taskXmlPath = Join-Path $backupRoot 'start-task.xml'
if ($null -ne $existingTask) {
  $taskXml = Export-ScheduledTask -TaskName $configuration.StartTaskName -TaskPath '\'
  [IO.File]::WriteAllText($taskXmlPath, [string]$taskXml, $utf8NoBom)
  $backupRecord['task'] = [ordered]@{ existed = $true; file = 'start-task.xml'; sha256 = (Get-FileHash -LiteralPath $taskXmlPath -Algorithm SHA256).Hash.ToLowerInvariant() }
}
else { $backupRecord['task'] = [ordered]@{ existed = $false; file = $null; sha256 = $null } }
[IO.File]::WriteAllText((Join-Path $backupRoot 'manifest.json'), ($backupRecord | ConvertTo-Json -Depth 6), $utf8NoBom)

$secretCreated = $false
$startupCreated = $false
$taskMutated = $false
$dllMutated = $false
$configMutated = $false
$existingSecretAcl = $null
$existingSecretDirectoryAcl = $null
$existingBridgeDirectoryAcl = $null
$secretDirectory = Split-Path -Parent $configuration.BridgeSecretFile
$secretDirectoryCreated = $false
$bridgeDirectoryCreated = $false
$createdRuntimeDirectories = @()
$rollbackErrors = @()
try {
  if ($null -ne $existingTask) {
    Disable-ScheduledTask -TaskName $configuration.StartTaskName -TaskPath '\' | Out-Null
    $taskMutated = $true
  }
  Assert-GameStopped $gameExecutable

  foreach ($directory in @($bridgePluginDirectory, $bridgeConfigDirectory, (Split-Path -Parent $configuration.LogFile))) {
    if (-not (Test-Path -LiteralPath $directory)) {
      New-Item -ItemType Directory -Path $directory -Force | Out-Null
      $createdRuntimeDirectories += [IO.Path]::GetFullPath($directory)
    }
    [void](Get-PlainDirectory $directory 'Required game directory')
  }
  if (-not (Test-Path -LiteralPath $configuration.BridgeDirectory)) {
    New-Item -ItemType Directory -Path $configuration.BridgeDirectory -Force | Out-Null
    $bridgeDirectoryCreated = $true
  }
  [void](Get-PlainDirectory $configuration.BridgeDirectory 'Bridge control directory')
  if (-not $bridgeDirectoryCreated) { $existingBridgeDirectoryAcl = (Get-Acl -LiteralPath $configuration.BridgeDirectory).Sddl }
  Protect-SystemAdministratorsOnly $configuration.BridgeDirectory $true

  if (-not (Test-Path -LiteralPath $secretDirectory)) {
    New-Item -ItemType Directory -Path $secretDirectory -Force | Out-Null
    $secretDirectoryCreated = $true
  }
  [void](Get-PlainDirectory $secretDirectory 'Bridge secret directory')
  if (-not $secretDirectoryCreated) { $existingSecretDirectoryAcl = (Get-Acl -LiteralPath $secretDirectory).Sddl }
  Protect-SystemAdministratorsOnly $secretDirectory $true
  if ($secretExists) {
    [void](Assert-SecretFile $configuration.BridgeSecretFile)
    $existingSecretAcl = (Get-Acl -LiteralPath $configuration.BridgeSecretFile).Sddl
    Protect-SystemAdministratorsOnly $configuration.BridgeSecretFile $false
  }
  else {
    $secretTemporary = Join-Path $secretDirectory ('.dyson-control-secret-' + [guid]::NewGuid().ToString('N') + '.tmp')
    try {
      Write-NewFile $secretTemporary $utf8NoBom.GetBytes((New-SecretValue))
      Protect-SystemAdministratorsOnly $secretTemporary $false
      [IO.File]::Move($secretTemporary, $configuration.BridgeSecretFile)
      $secretCreated = $true
    }
    finally { if (Test-Path -LiteralPath $secretTemporary) { Remove-Item -LiteralPath $secretTemporary -Force } }
  }

  Assert-SystemRights $dataDirectory ([Security.AccessControl.FileSystemRights]::Modify) 'dataDirectory'
  Assert-SystemRights $configuration.BridgeDirectory ([Security.AccessControl.FileSystemRights]::Modify) 'game.bridgeDirectory'
  Assert-SystemRights $configuration.BridgeSecretFile ([Security.AccessControl.FileSystemRights]::Read) 'game.bridgeSecretFile'
  Assert-SystemRights $managedStartScript ([Security.AccessControl.FileSystemRights]::ReadAndExecute) 'managed start script'
  Assert-SystemRights $pathPolicyScript ([Security.AccessControl.FileSystemRights]::ReadAndExecute) 'managed path policy'

  if (Test-Path -LiteralPath $startupSettingsPath) { Assert-StartupSettings $startupSettingsPath }
  else { Write-AtomicText $defaultStartupSettings $startupSettingsPath; $startupCreated = $true }

  $dllMutated = $true
  Install-AtomicFile $bridgeSource $bridgeDllTarget
  if ((Get-FileHash -LiteralPath $bridgeDllTarget -Algorithm SHA256).Hash.ToLowerInvariant() -cne $actualBridgeHash) { throw 'Deployed Bridge DLL failed SHA-256 verification.' }
  $configTemporary = Join-Path $bridgeConfigDirectory ('.dyson-control-config-' + [guid]::NewGuid().ToString('N') + '.tmp')
  try {
    Write-NewFile $configTemporary $utf8NoBom.GetBytes($bridgeConfiguration)
    $configMutated = $true
    Install-AtomicFile $configTemporary $bridgeConfigTarget
  }
  finally { if (Test-Path -LiteralPath $configTemporary) { Remove-Item -LiteralPath $configTemporary -Force } }
  if ([IO.File]::ReadAllText($bridgeConfigTarget, $utf8NoBom) -cne $bridgeConfiguration) { throw 'Deployed Bridge configuration failed exact verification.' }

  $taskDefinition = New-GameTask $configuration $managedStartScript $startupSettingsPath
  Register-ScheduledTask -TaskName $configuration.StartTaskName -TaskPath '\' -InputObject $taskDefinition -Force | Out-Null
  $taskMutated = $true
  $taskVerificationPath = Join-Path $backupRoot 'task-registration-verification.json'
  $installedTask = Wait-ExactTaskRegistration `
    { Get-ExactTask $configuration.StartTaskName } $managedTaskDescription `
    (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') $taskArguments $configuration.GameRoot `
    { param($actual, $expected) Test-PathEquals $actual $expected } `
    { param($principal) Test-SystemPrincipal $principal } $taskVerificationPath

  $summary = [ordered]@{
    configured = $true; bridgeSha256 = $actualBridgeHash; backupDirectory = $backupRoot
    taskName = $configuration.StartTaskName; taskStarted = $false; secretAction = $secretAction; savesMoved = $false
    taskVerification = $taskVerificationPath
  }
  $summary | ConvertTo-Json -Compress
}
catch {
  $applyError = $_
  if ($taskMutated) {
    try {
      if ([bool]$backupRecord.task.existed) {
        Register-ScheduledTask -TaskName $configuration.StartTaskName -TaskPath '\' -Xml ([IO.File]::ReadAllText($taskXmlPath, $utf8NoBom)) -Force | Out-Null
      }
      else { Unregister-ScheduledTask -TaskName $configuration.StartTaskName -TaskPath '\' -Confirm:$false -ErrorAction SilentlyContinue }
    } catch { $rollbackErrors += $_ }
  }
  if ($configMutated) {
    try {
      if ([bool]$backupRecord.bridgeConfig.existed) { Install-AtomicFile (Join-Path $backupRoot $bridgeConfigName) $bridgeConfigTarget }
      elseif (Test-Path -LiteralPath $bridgeConfigTarget) { Remove-Item -LiteralPath $bridgeConfigTarget -Force }
    } catch { $rollbackErrors += $_ }
  }
  if ($dllMutated) {
    try {
      if ([bool]$backupRecord.bridgeDll.existed) { Install-AtomicFile (Join-Path $backupRoot $bridgeDllName) $bridgeDllTarget }
      elseif (Test-Path -LiteralPath $bridgeDllTarget) { Remove-Item -LiteralPath $bridgeDllTarget -Force }
    } catch { $rollbackErrors += $_ }
  }
  if ($startupCreated) { try { Remove-Item -LiteralPath $startupSettingsPath -Force } catch { $rollbackErrors += $_ } }
  if ($secretCreated) { try { Remove-Item -LiteralPath $configuration.BridgeSecretFile -Force } catch { $rollbackErrors += $_ } }
  elseif ($null -ne $existingSecretAcl) {
    try { $acl = Get-Acl -LiteralPath $configuration.BridgeSecretFile; $acl.SetSecurityDescriptorSddlForm($existingSecretAcl); Set-Acl -LiteralPath $configuration.BridgeSecretFile -AclObject $acl } catch { $rollbackErrors += $_ }
  }
  if ($null -ne $existingSecretDirectoryAcl) {
    try { $acl = Get-Acl -LiteralPath $secretDirectory; $acl.SetSecurityDescriptorSddlForm($existingSecretDirectoryAcl); Set-Acl -LiteralPath $secretDirectory -AclObject $acl } catch { $rollbackErrors += $_ }
  }
  if ($null -ne $existingBridgeDirectoryAcl) {
    try { $acl = Get-Acl -LiteralPath $configuration.BridgeDirectory; $acl.SetSecurityDescriptorSddlForm($existingBridgeDirectoryAcl); Set-Acl -LiteralPath $configuration.BridgeDirectory -AclObject $acl } catch { $rollbackErrors += $_ }
  }
  elseif ($bridgeDirectoryCreated -and (Test-Path -LiteralPath $configuration.BridgeDirectory)) {
    try {
      if (@(Get-ChildItem -LiteralPath $configuration.BridgeDirectory -Force).Count -eq 0) { Remove-Item -LiteralPath $configuration.BridgeDirectory -Force }
    } catch { $rollbackErrors += $_ }
  }
  if ($secretDirectoryCreated -and (Test-Path -LiteralPath $secretDirectory)) {
    try {
      if (@(Get-ChildItem -LiteralPath $secretDirectory -Force).Count -eq 0) { Remove-Item -LiteralPath $secretDirectory -Force }
    } catch { $rollbackErrors += $_ }
  }
  foreach ($directory in @($createdRuntimeDirectories | Sort-Object { $_.Length } -Descending)) {
    try {
      if ([IO.Directory]::Exists($directory) -and [IO.Directory]::GetFileSystemEntries($directory).Length -eq 0) { [IO.Directory]::Delete($directory, $false) }
    } catch { $rollbackErrors += $_ }
  }
  if ($rollbackErrors.Count -gt 0) {
    $messages = @($rollbackErrors | ForEach-Object { $_.Exception.Message }) -join '; '
    throw "Game configuration failed: $($applyError.Exception.Message) Rollback also failed: $messages"
  }
  throw $applyError
}
