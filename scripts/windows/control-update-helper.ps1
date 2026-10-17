<#
.SYNOPSIS
Registers or runs one isolated SYSTEM task for a prepared Dyson Control panel-only update.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][ValidateSet('Register', 'Run')][string]$Mode,
  [Parameter(Mandatory = $true)][string]$OperationFile
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Set-StrictMode -Version 3
$managedControlDescription = 'Dyson Control managed startup task.'
$managedUpdatePrefix = 'Dyson Control one-shot control update '
$utf8 = [Text.UTF8Encoding]::new($false)

function Get-FullPath([string]$PathValue) {
  if ([string]::IsNullOrWhiteSpace($PathValue) -or -not [IO.Path]::IsPathRooted($PathValue) -or $PathValue -match '["\r\n\0]') {
    throw "Path must be an absolute plain value: $PathValue"
  }
  return [IO.Path]::GetFullPath($PathValue).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
}

function Get-PlainFile([string]$PathValue, [string]$Label) {
  $full = Get-FullPath $PathValue
  $item = Get-Item -LiteralPath $full -Force -ErrorAction Stop
  if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "$Label must be a plain file: $full" }
  return $full
}

function Get-PlainDirectory([string]$PathValue, [string]$Label) {
  $full = Get-FullPath $PathValue
  $item = Get-Item -LiteralPath $full -Force -ErrorAction Stop
  if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "$Label must be a plain directory: $full" }
  return $full
}

function Assert-ExactProperties([object]$Value, [string[]]$Expected, [string]$Label) {
  if ($null -eq $Value) { throw "$Label is missing." }
  $actual = @($Value.PSObject.Properties.Name)
  if ($actual.Count -ne $Expected.Count -or @(Compare-Object -ReferenceObject $Expected -DifferenceObject $actual -CaseSensitive).Count -ne 0) {
    throw "$Label contains unexpected fields."
  }
}

function Assert-SystemIdentity {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  if ($null -eq $identity.User -or $identity.User.Value -cne 'S-1-5-18') {
    throw 'The control update helper must run as Local SYSTEM.'
  }
}

function Test-PathEqual([string]$Left, [string]$Right) {
  return (Get-FullPath $Left).Equals((Get-FullPath $Right), [StringComparison]::OrdinalIgnoreCase)
}

function Test-PathInside([string]$Candidate, [string]$Parent) {
  $candidatePath = (Get-FullPath $Candidate) + [IO.Path]::DirectorySeparatorChar
  $parentPath = (Get-FullPath $Parent) + [IO.Path]::DirectorySeparatorChar
  return $candidatePath.StartsWith($parentPath, [StringComparison]::OrdinalIgnoreCase)
}

function Write-AtomicJson([string]$PathValue, [object]$Value) {
  $temporary = "$PathValue.partial-$([guid]::NewGuid().ToString('N'))"
  try {
    [IO.File]::WriteAllText($temporary, (($Value | ConvertTo-Json -Depth 8) + [Environment]::NewLine), $utf8)
    Move-Item -LiteralPath $temporary -Destination $PathValue -Force
  }
  finally { Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue }
}

function Read-Operation([string]$PathValue) {
  $operationPath = Get-PlainFile $PathValue 'Operation file'
  $operation = Get-Content -LiteralPath $operationPath -Raw -Encoding UTF8 | ConvertFrom-Json
  Assert-ExactProperties $operation @(
    'schema', 'product', 'operationId', 'repository', 'currentVersion', 'expectedVersion', 'installRoot',
    'currentVersionRoot', 'taskName', 'previousProcessId', 'archivePath', 'archiveSha256', 'sourcePath',
    'sourceFingerprint', 'upgradeScriptPath', 'statusPath', 'createdAt'
  ) 'Control update handoff'
  if ($operation.schema -ne 1 -or $operation.product -cne 'dyson-control-control-update-handoff' -or
      [string]$operation.operationId -cnotmatch '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' -or
      [string]$operation.repository -cnotmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' -or
      [string]$operation.currentVersion -cnotmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$' -or
      [string]$operation.expectedVersion -cnotmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$' -or
      [string]$operation.archiveSha256 -cnotmatch '^[0-9a-f]{64}$' -or
      [string]$operation.sourceFingerprint -cnotmatch '^[0-9a-f]{64}$' -or
      [int]$operation.previousProcessId -lt 1 -or
      [string]$operation.taskName -cnotmatch '^[A-Za-z0-9](?:[A-Za-z0-9._ -]{0,118}[A-Za-z0-9])?$') {
    throw 'Control update handoff identity is invalid.'
  }
  $createdAt = [DateTimeOffset]::MinValue
  if (-not [DateTimeOffset]::TryParse([string]$operation.createdAt, [ref]$createdAt)) { throw 'Control update handoff timestamp is invalid.' }

  $operationRoot = Split-Path -Parent $operationPath
  $operation.installRoot = Get-PlainDirectory ([string]$operation.installRoot) 'Install root'
  $operation.currentVersionRoot = Get-PlainDirectory ([string]$operation.currentVersionRoot) 'Current version root'
  $operation.archivePath = Get-PlainFile ([string]$operation.archivePath) 'Prepared release archive'
  $operation.sourcePath = Get-PlainDirectory ([string]$operation.sourcePath) 'Prepared release source'
  $operation.upgradeScriptPath = Get-PlainFile ([string]$operation.upgradeScriptPath) 'Upgrade script'
  $operation.statusPath = Get-FullPath ([string]$operation.statusPath)
  if (-not (Test-PathEqual (Split-Path -Parent ([string]$operation.archivePath)) $operationRoot) -or
      -not (Test-PathEqual (Split-Path -Parent ([string]$operation.sourcePath)) $operationRoot) -or
      -not (Test-PathEqual (Split-Path -Parent ([string]$operation.statusPath)) $operationRoot) -or
      [IO.Path]::GetFileName([string]$operation.statusPath) -cne 'helper-status.json') {
    throw 'Prepared update paths do not remain inside the operation directory.'
  }
  if (-not (Test-PathInside ([string]$operation.currentVersionRoot) (Join-Path ([string]$operation.installRoot) 'versions')) -or
      [IO.Path]::GetFileName([string]$operation.currentVersionRoot) -cne [string]$operation.currentVersion -or
      -not (Test-PathInside ([string]$operation.upgradeScriptPath) ([string]$operation.currentVersionRoot))) {
    throw 'Installed version paths do not match the handoff identity.'
  }
  return [pscustomobject]@{ Path = $operationPath; Root = $operationRoot; Value = $operation }
}

function Get-SourceFingerprint([string]$Root) {
  $rootPath = Get-PlainDirectory $Root 'Prepared release source'
  $files = [Collections.Generic.List[string]]::new()
  foreach ($item in Get-ChildItem -LiteralPath $rootPath -Recurse -Force) {
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Prepared release contains a reparse point: $($item.FullName)" }
    if (-not $item.PSIsContainer) {
      $relative = $item.FullName.Substring($rootPath.Length).TrimStart('\').Replace('\', '/')
      $files.Add($relative)
    }
  }
  $ordered = $files.ToArray()
  [Array]::Sort($ordered, [StringComparer]::Ordinal)
  $builder = [Text.StringBuilder]::new()
  foreach ($relative in $ordered) {
    $file = Get-PlainFile (Join-Path $rootPath $relative.Replace('/', '\')) 'Prepared release member'
    $item = Get-Item -LiteralPath $file
    $fileHash = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
    [void]$builder.Append($relative).Append([char]0).Append($item.Length).Append([char]0).Append($fileHash).Append("`n")
  }
  $hash = [Security.Cryptography.SHA256]::Create()
  try {
    $digest = $hash.ComputeHash($utf8.GetBytes($builder.ToString()))
    return ([BitConverter]::ToString($digest)).Replace('-', '').ToLowerInvariant()
  }
  finally { $hash.Dispose() }
}

function Assert-PreparedRelease([object]$Operation) {
  $archiveHash = (Get-FileHash -LiteralPath ([string]$Operation.archivePath) -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($archiveHash -cne [string]$Operation.archiveSha256) { throw 'Prepared release archive changed after validation.' }
  if ((Get-SourceFingerprint ([string]$Operation.sourcePath)) -cne [string]$Operation.sourceFingerprint) {
    throw 'Prepared release source changed after validation.'
  }
  $packagePath = Get-PlainFile (Join-Path ([string]$Operation.sourcePath) 'package.json') 'Prepared package.json'
  $manifestPath = Get-PlainFile (Join-Path ([string]$Operation.sourcePath) 'release-manifest.json') 'Prepared release-manifest.json'
  $package = Get-Content -LiteralPath $packagePath -Raw -Encoding UTF8 | ConvertFrom-Json
  $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
  Assert-ExactProperties $manifest @('schema', 'product', 'packageVersion', 'kind', 'bridge') 'Prepared release manifest'
  if ($package.name -cne 'dyson-control' -or [string]$package.version -cne [string]$Operation.expectedVersion -or
      $manifest.schema -ne 1 -or $manifest.product -cne 'dyson-control' -or
      [string]$manifest.packageVersion -cne [string]$Operation.expectedVersion -or
      [string]$manifest.kind -cne 'panel-only' -or $null -ne $manifest.bridge -or
      (Test-Path -LiteralPath (Join-Path ([string]$Operation.sourcePath) 'dist\bridge'))) {
    throw 'Prepared release is not the validated panel-only target.'
  }
}

function Read-InstallState([object]$Operation) {
  $statePath = Get-PlainFile (Join-Path ([string]$Operation.installRoot) 'install-state.json') 'Install state'
  $state = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($state.schema -ne 1 -or $state.product -cne 'dyson-control' -or [string]$state.taskPath -cne '\' -or
      [string]$state.taskName -cne [string]$Operation.taskName -or [string]$state.activeVersion -cne [string]$Operation.currentVersion -or
      -not (Test-PathEqual ([string]$state.installRoot) ([string]$Operation.installRoot))) {
    throw 'The installed state no longer matches the prepared update.'
  }
  return $state
}

function Assert-ControlTask([object]$Operation) {
  $matches = @(Get-ScheduledTask -TaskName ([string]$Operation.taskName) -ErrorAction Stop | Where-Object {
    $_.TaskName -ceq [string]$Operation.taskName -and $_.TaskPath -eq '\'
  })
  if ($matches.Count -ne 1) { throw 'The managed Dyson Control task is missing or ambiguous.' }
  $task = $matches[0]
  if ($task.Description -cne $managedControlDescription -or $task.Principal.UserId -notin @('SYSTEM', 'S-1-5-18') -or
      @($task.Actions).Count -ne 1 -or -not (Test-PathEqual ([string]$task.Actions[0].WorkingDirectory) ([string]$Operation.currentVersionRoot)) -or
      ([string]$task.Actions[0].Arguments).IndexOf((Join-Path ([string]$Operation.currentVersionRoot) 'run-control.ps1'), [StringComparison]::OrdinalIgnoreCase) -lt 0) {
    throw 'The installed startup task is not the expected SYSTEM-owned Dyson Control task.'
  }
}

function Write-HelperStatus([object]$Operation, [string]$Status, [string]$Step, [string]$ActiveVersion, [int]$ProcessId, [bool]$Accepting, [string]$Message) {
  $value = [ordered]@{
    schema = 1; product = 'dyson-control-control-update-result'; operationId = [string]$Operation.operationId;
    status = $Status; step = $Step; targetVersion = [string]$Operation.expectedVersion; activeVersion = $ActiveVersion;
    installRoot = [string]$Operation.installRoot; previousProcessId = [int]$Operation.previousProcessId;
    processId = $ProcessId; accepting = $Accepting; message = $Message; updatedAt = [DateTimeOffset]::UtcNow.ToString('o')
  }
  Write-AtomicJson ([string]$Operation.statusPath) $value
}

function Read-ExistingTerminalStatus([object]$Operation) {
  if (-not (Test-Path -LiteralPath ([string]$Operation.statusPath) -PathType Leaf)) { return $null }
  try {
    $value = Get-Content -LiteralPath ([string]$Operation.statusPath) -Raw -Encoding UTF8 | ConvertFrom-Json
    Assert-ExactProperties $value @(
      'schema', 'product', 'operationId', 'status', 'step', 'targetVersion', 'activeVersion', 'installRoot',
      'previousProcessId', 'processId', 'accepting', 'message', 'updatedAt'
    ) 'Control update result'
    $activeVersionMatches = ([string]$value.status -ceq 'succeeded' -and [string]$value.activeVersion -ceq [string]$Operation.expectedVersion) -or
      ([string]$value.status -ceq 'rolledBack' -and [string]$value.activeVersion -ceq [string]$Operation.currentVersion)
    if ($value.schema -eq 1 -and $value.product -ceq 'dyson-control-control-update-result' -and
        [string]$value.operationId -ceq [string]$Operation.operationId -and [string]$value.status -in @('succeeded', 'rolledBack') -and
        [string]$value.step -ceq 'complete' -and [string]$value.targetVersion -ceq [string]$Operation.expectedVersion -and
        $activeVersionMatches -and (Test-PathEqual ([string]$value.installRoot) ([string]$Operation.installRoot)) -and
        [int]$value.previousProcessId -eq [int]$Operation.previousProcessId -and [int]$value.processId -gt 0 -and
        [int]$value.processId -ne [int]$Operation.previousProcessId -and [bool]$value.accepting) { return $value }
  }
  catch { }
  return $null
}

$handoff = Read-Operation $OperationFile
$operation = $handoff.Value
$taskName = 'Dyson-Control-Update-' + ([string]$operation.operationId).Replace('-', '')
$taskDescription = $managedUpdatePrefix + [string]$operation.operationId

if ($Mode -ceq 'Register') {
  Assert-SystemIdentity
  [void](Read-InstallState $operation)
  Assert-ControlTask $operation
  Assert-PreparedRelease $operation
  $existingTask = Get-ScheduledTask -TaskName $taskName -TaskPath '\' -ErrorAction SilentlyContinue
  if ($null -ne $existingTask) {
    if ($existingTask.Description -cne $taskDescription -or $existingTask.Principal.UserId -notin @('SYSTEM', 'S-1-5-18') -or
        @($existingTask.Actions).Count -ne 1 -or ([string]$existingTask.Actions[0].Arguments).IndexOf($handoff.Path, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
      throw "An update task with this name exists without the expected ownership: $taskName"
    }
    if ($null -ne (Read-ExistingTerminalStatus $operation) -or [string]$existingTask.State -in @('Running', 'Queued')) {
      Write-Output "The owned one-shot SYSTEM update task is already running or complete: $taskName"
      exit 0
    }
    if (Test-Path -LiteralPath ([string]$operation.statusPath)) {
      Write-Output "The owned one-shot SYSTEM update task has already started: $taskName"
      exit 0
    }
    Start-ScheduledTask -TaskName $taskName -TaskPath '\'
    Write-Output "Started the previously registered one-shot SYSTEM update task $taskName."
    exit 0
  }
  $other = Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object { $_.Description -like "$managedUpdatePrefix*" } | Select-Object -First 1
  if ($null -ne $other) { throw "Another one-shot control update task still exists: $($other.TaskPath)$($other.TaskName)" }
  $powerShellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $selfPath = Get-PlainFile $PSCommandPath 'Control update helper'
  $arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}" -Mode Run -OperationFile "{1}"' -f $selfPath.Replace('"', '""'), $handoff.Path.Replace('"', '""')
  $action = New-ScheduledTaskAction -Execute $powerShellPath -Argument $arguments -WorkingDirectory ([string]$operation.currentVersionRoot)
  $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::FromMinutes(30)) -MultipleInstances IgnoreNew
  $definition = New-ScheduledTask -Action $action -Principal $principal -Settings $settings -Description $taskDescription
  try {
    Register-ScheduledTask -TaskName $taskName -TaskPath '\' -InputObject $definition | Out-Null
    Start-ScheduledTask -TaskName $taskName -TaskPath '\'
  }
  catch {
    Unregister-ScheduledTask -TaskName $taskName -TaskPath '\' -Confirm:$false -ErrorAction SilentlyContinue
    throw
  }
  Write-Output "Registered one-shot SYSTEM control update task $taskName."
  exit 0
}

Assert-SystemIdentity
$selfTask = Get-ScheduledTask -TaskName $taskName -TaskPath '\' -ErrorAction Stop
if ($selfTask.Description -cne $taskDescription -or $selfTask.Principal.UserId -notin @('SYSTEM', 'S-1-5-18')) {
  throw 'The running update task does not have the expected ownership marker.'
}

try {
  [void](Read-InstallState $operation)
  Assert-ControlTask $operation
  Assert-PreparedRelease $operation
  Write-HelperStatus $operation 'applying' 'installing' ([string]$operation.currentVersion) ([int]$operation.previousProcessId) $false 'The isolated SYSTEM task is applying the prepared panel-only release.'
  & ([string]$operation.upgradeScriptPath) -SourcePath ([string]$operation.sourcePath) -InstallRoot ([string]$operation.installRoot) `
    -TaskName ([string]$operation.taskName) -ExpectedCurrentProcessId ([int]$operation.previousProcessId) `
    -UpdateStatusPath ([string]$operation.statusPath) -UpdateOperationId ([string]$operation.operationId)
  if ($LASTEXITCODE -ne 0) { throw "upgrade-control.ps1 exited with code $LASTEXITCODE." }
  $terminal = Read-ExistingTerminalStatus $operation
  if ($null -eq $terminal -or [string]$terminal.status -cne 'succeeded') {
    throw 'The upgrader returned without a verified succeeded status.'
  }
}
catch {
  if ($null -eq (Read-ExistingTerminalStatus $operation)) {
    Write-HelperStatus $operation 'failed' 'complete' ([string]$operation.currentVersion) ([int]$operation.previousProcessId) $false ($_.Exception.Message.Substring(0, [Math]::Min(500, $_.Exception.Message.Length)))
  }
  throw
}
finally {
  Unregister-ScheduledTask -TaskName $taskName -TaskPath '\' -Confirm:$false -ErrorAction SilentlyContinue
}
