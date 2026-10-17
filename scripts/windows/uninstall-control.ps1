[CmdletBinding()]
param(
  [string]$InstallRoot = (Join-Path $env:ProgramFiles 'Dyson Control'),
  [string]$TaskName = 'Dyson-Control',
  [ValidateRange(5, 300)][int]$HealthCheckTimeoutSeconds = 30,
  [ValidateRange(0, 3600)][int]$OperationDrainTimeoutSeconds = 300
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3
$managedDescription = 'Dyson Control managed startup task.'

function Get-FullPath([string]$PathValue) {
  if ([string]::IsNullOrWhiteSpace($PathValue) -or -not [IO.Path]::IsPathRooted($PathValue)) { throw "Path must be absolute: $PathValue" }
  return [IO.Path]::GetFullPath($PathValue).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
}

function Get-ExistingFile([string]$PathValue, [string]$Label) {
  $fullPath = Get-FullPath $PathValue
  $item = Get-Item -LiteralPath $fullPath -Force -ErrorAction Stop
  if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "$Label must be a plain file: $fullPath" }
  return $fullPath
}

function Get-ExistingDirectory([string]$PathValue, [string]$Label) {
  $fullPath = Get-FullPath $PathValue
  $item = Get-Item -LiteralPath $fullPath -Force -ErrorAction Stop
  if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "$Label must be a plain directory: $fullPath" }
  return $fullPath
}

function Assert-TaskName([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value) -or $Value.Length -gt 120 -or $Value -notmatch '^[A-Za-z0-9](?:[A-Za-z0-9._ -]{0,118}[A-Za-z0-9])?$') {
    throw 'TaskName must contain only letters, digits, spaces, dots, underscores, and hyphens.'
  }
}

function Assert-Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this uninstaller from an elevated Windows PowerShell session.'
  }
}

function Get-HealthHost([string]$ConfiguredHost) {
  if ($ConfiguredHost -in @('0.0.0.0', '127.0.0.1', 'localhost')) { return '127.0.0.1' }
  if ($ConfiguredHost -in @('::', '::1')) { return '[::1]' }
  return $ConfiguredHost
}

function Get-ControlHealth([string]$HostName, [int]$Port) {
  $uri = "http://${HostName}:$Port/healthz"
  try {
    $response = Invoke-WebRequest -Uri $uri -UseBasicParsing -TimeoutSec 2
    if ($response.StatusCode -ne 200) { return $null }
    $body = $response.Content | ConvertFrom-Json
    if ($body.product -cne 'dyson-control' -or [string]$body.version -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$') { return $null }
    $processId = [int]$body.processId
    if ($processId -lt 1 -or $body.accepting -isnot [bool]) { return $null }
    $maintenanceToken = if ($null -eq $body.maintenanceToken) { $null } else { [string]$body.maintenanceToken }
    return [pscustomobject]@{
      Uri = $uri; Version = [string]$body.version; ProcessId = $processId;
      Accepting = [bool]$body.accepting; MaintenanceToken = $maintenanceToken
    }
  }
  catch { return $null }
}

function Test-ControlProcessIdentity([int]$ProcessId, [string]$VersionRoot, [string]$NodeExecutable) {
  try {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop | Select-Object -First 1
    if ($null -eq $process -or [string]::IsNullOrWhiteSpace([string]$process.ExecutablePath) -or [string]::IsNullOrWhiteSpace([string]$process.CommandLine)) { return $false }
    if ((Get-FullPath ([string]$process.ExecutablePath)) -ne (Get-FullPath $NodeExecutable)) { return $false }
    $expectedIndex = Get-FullPath (Join-Path $VersionRoot 'dist\server\index.js')
    return ([string]$process.CommandLine).IndexOf($expectedIndex, [StringComparison]::OrdinalIgnoreCase) -ge 0
  }
  catch { return $false }
}

function Wait-ControlHealth(
  [string]$HostName,
  [int]$Port,
  [int]$TimeoutSeconds,
  [string]$ExpectedVersion,
  [string]$VersionRoot,
  [string]$NodeExecutable,
  [int]$ExcludedProcessId = 0
) {
  $uri = "http://${HostName}:$Port/healthz"
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  do {
    $health = Get-ControlHealth $HostName $Port
    if ($null -ne $health -and $health.Accepting -eq $true -and $null -eq $health.MaintenanceToken -and
        $health.Version -ceq $ExpectedVersion -and $health.ProcessId -ne $ExcludedProcessId -and
        (Test-ControlProcessIdentity $health.ProcessId $VersionRoot $NodeExecutable)) { return $health }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "Dyson Control $ExpectedVersion did not become healthy from the expected task process at $uri within $TimeoutSeconds seconds."
}

function New-ControlMaintenance([string]$DataDirectory) {
  $token = [guid]::NewGuid().ToString('N')
  $path = Join-Path $DataDirectory '.control-maintenance.json'
  if (Test-Path -LiteralPath $path) { throw "A Dyson Control maintenance marker already exists: $path" }
  $temporary = "$path.partial-$token"
  $value = [ordered]@{
    schema = 1; product = 'dyson-control-maintenance'; token = $token;
    requestedByProcessId = $PID; createdAt = [DateTime]::UtcNow.ToString('o')
  }
  try {
    [IO.File]::WriteAllText($temporary, (($value | ConvertTo-Json) + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
    [IO.File]::Move($temporary, $path)
  }
  finally { Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue }
  return [pscustomobject]@{ Path = $path; Token = $token }
}

function Wait-ControlMaintenance(
  [object]$Lease,
  [string]$HostName,
  [int]$Port,
  [int]$TimeoutSeconds,
  [string]$ExpectedVersion,
  [string]$VersionRoot,
  [string]$NodeExecutable,
  [int]$ExpectedProcessId = 0,
  [int]$ExcludedProcessId = 0
) {
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  do {
    $health = Get-ControlHealth $HostName $Port
    $processMatches = $null -ne $health -and (($ExpectedProcessId -gt 0 -and $health.ProcessId -eq $ExpectedProcessId) -or
      ($ExpectedProcessId -eq 0 -and $health.ProcessId -ne $ExcludedProcessId))
    if ($processMatches -and $health.Version -ceq $ExpectedVersion -and
        $health.Accepting -eq $false -and $health.MaintenanceToken -ceq [string]$Lease.Token -and
        (Test-ControlProcessIdentity $health.ProcessId $VersionRoot $NodeExecutable)) { return $health }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $deadline)
  $processLabel = if ($ExpectedProcessId -gt 0) { "PID $ExpectedProcessId" } else { 'the expected task process' }
  throw "Dyson Control $processLabel did not acknowledge maintenance token $($Lease.Token) within $TimeoutSeconds seconds."
}

function Remove-ControlMaintenance([object]$Lease) {
  if (-not (Test-Path -LiteralPath $Lease.Path)) { return }
  $path = Get-ExistingFile ([string]$Lease.Path) 'Maintenance marker'
  $value = Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($value.schema -ne 1 -or $value.product -cne 'dyson-control-maintenance' -or [string]$value.token -cne [string]$Lease.Token) {
    throw "Refusing to remove a maintenance marker owned by another operation: $path"
  }
  Remove-Item -LiteralPath $path -Force
}

function Wait-ControlMaintenanceReleased(
  [string]$HostName,
  [int]$Port,
  [int]$TimeoutSeconds,
  [string]$ExpectedVersion,
  [string]$VersionRoot,
  [string]$NodeExecutable,
  [int]$ExpectedProcessId
) {
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  do {
    $health = Get-ControlHealth $HostName $Port
    if ($null -ne $health -and $health.ProcessId -eq $ExpectedProcessId -and $health.Version -ceq $ExpectedVersion -and
        $health.Accepting -eq $true -and $null -eq $health.MaintenanceToken -and
        (Test-ControlProcessIdentity $health.ProcessId $VersionRoot $NodeExecutable)) { return $health }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "Dyson Control PID $ExpectedProcessId did not resume accepting work after maintenance within $TimeoutSeconds seconds."
}

function Wait-ControlProcessExit([int]$ProcessId, [int]$TimeoutSeconds) {
  if ($ProcessId -lt 1) { return }
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  do {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $process) { return }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "Dyson Control process $ProcessId did not exit within $TimeoutSeconds seconds."
}

function Get-ControlActivity([string]$DataDirectory, [string]$NodeExecutable) {
  $probe = @'
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const dataDirectory = path.resolve(process.argv[1]);
const databasePath = path.join(dataDirectory, 'control.sqlite');
let outstandingJobs = 0;
if (fs.existsSync(databasePath)) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    database.exec('PRAGMA busy_timeout = 2000');
    const table = database.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'jobs'").get();
    if (table) outstandingJobs = Number(database.prepare("SELECT COUNT(*) AS count FROM jobs WHERE state IN ('queued', 'running')").get().count);
  } finally { database.close(); }
}
const uploads = path.join(dataDirectory, 'uploads');
const activeUploads = fs.existsSync(uploads) ? fs.readdirSync(uploads).filter((name) => name.endsWith('.part')).length : 0;
process.stdout.write(JSON.stringify({ outstandingJobs, activeUploads }));
'@
  $encodedProbe = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($probe))
  $bootstrap = "eval(Buffer.from(process.argv.splice(1,1)[0],'base64').toString('utf8'))"
  $output = & $NodeExecutable -e $bootstrap $encodedProbe $DataDirectory
  if ($LASTEXITCODE -ne 0) { throw "Unable to inspect the Dyson Control persistent queue (Node exit code $LASTEXITCODE)." }
  try { return ([string]($output -join '') | ConvertFrom-Json) }
  catch { throw 'The Dyson Control persistent queue probe returned invalid output.' }
}

function Wait-ControlIdle([string]$DataDirectory, [string]$NodeExecutable, [int]$TimeoutSeconds) {
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  $requiredSamples = if ($TimeoutSeconds -eq 0) { 1 } else { 2 }
  $idleSamples = 0
  $activity = $null
  do {
    $activity = Get-ControlActivity $DataDirectory $NodeExecutable
    if ([int]$activity.outstandingJobs -eq 0 -and [int]$activity.activeUploads -eq 0) {
      $idleSamples += 1
      if ($idleSamples -ge $requiredSamples) { return }
    }
    else { $idleSamples = 0 }
    if ([DateTime]::UtcNow -ge $deadline) { break }
    Start-Sleep -Milliseconds 250
  } while ($true)
  throw "Refusing to stop Dyson Control while $($activity.outstandingJobs) queued/running job(s) and $($activity.activeUploads) active upload transaction(s) remain."
}

Assert-TaskName $TaskName
$installRootPath = Get-ExistingDirectory $InstallRoot 'InstallRoot'
$statePath = Get-ExistingFile (Join-Path $installRootPath 'install-state.json') 'install-state.json'
$state = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($state.schema -ne 1 -or $state.product -ne 'dyson-control' -or [string]$state.taskName -cne $TaskName -or [string]$state.taskPath -ne '\') {
  throw 'The install state does not identify the requested managed task.'
}
if ((Get-FullPath ([string]$state.installRoot)) -ne $installRootPath) { throw 'InstallRoot does not match install-state.json.' }
Assert-Administrator

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop | Where-Object { $_.TaskName -ceq $TaskName -and $_.TaskPath -eq '\' } | Select-Object -First 1
if ($null -eq $task -or $task.Description -cne $managedDescription) {
  throw 'Refusing to remove a task that is not owned by Dyson Control.'
}

$nodeExecutable = Get-ExistingFile ([string]$state.nodePath) 'Installed Node.js executable'
$dataDirectory = Get-ExistingDirectory ([string]$state.dataDirectory) 'Dyson Control data directory'
$configPath = Get-ExistingFile ([string]$state.configPath) 'Dyson Control configuration'
$config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
$healthHost = Get-HealthHost ([string]$config.host)
$health = Get-ControlHealth $healthHost ([int]$config.port)
$versionRoot = Get-ExistingDirectory (Join-Path (Join-Path $installRootPath 'versions') ([string]$state.activeVersion)) 'Active version directory'
if ($null -ne $health) {
  if ($health.Version -cne [string]$state.activeVersion -or -not (Test-ControlProcessIdentity $health.ProcessId $versionRoot $nodeExecutable)) {
    throw "The current listener at $($health.Uri) is not the installed Dyson Control $($state.activeVersion) task process."
  }
}
if ($task.State -eq 'Running' -and $null -eq $health) {
  $health = Wait-ControlHealth $healthHost ([int]$config.port) $HealthCheckTimeoutSeconds `
    ([string]$state.activeVersion) $versionRoot $nodeExecutable
}

$wasRunning = $task.State -eq 'Running' -or $null -ne $health
$maintenanceLease = $null
$taskStopped = $false
$unregistered = $false
$rollbackHealth = $null
try {
  if ($null -ne $health) {
    $maintenanceLease = New-ControlMaintenance $dataDirectory
    $health = Wait-ControlMaintenance $maintenanceLease $healthHost ([int]$config.port) $HealthCheckTimeoutSeconds `
      ([string]$state.activeVersion) $versionRoot $nodeExecutable ([int]$health.ProcessId)
  }
  Wait-ControlIdle $dataDirectory $nodeExecutable $OperationDrainTimeoutSeconds
  Stop-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction SilentlyContinue
  $taskStopped = $true
  if ($null -ne $health) { Wait-ControlProcessExit $health.ProcessId $HealthCheckTimeoutSeconds }
  Unregister-ScheduledTask -TaskName $TaskName -TaskPath '\' -Confirm:$false
  $unregistered = $true
  if ($null -ne $maintenanceLease) {
    Remove-ControlMaintenance $maintenanceLease
    $maintenanceLease = $null
  }
  Write-Output "Removed managed scheduled task: \$TaskName"
  Write-Output "Program versions were preserved: $installRootPath"
  Write-Output "Configuration was preserved: $($state.configPath)"
  Write-Output "Data was preserved: $($state.dataDirectory)"
}
catch {
  $uninstallError = $_
  $rollbackError = $null
  try {
    if (-not $unregistered -and $taskStopped -and $wasRunning) {
      Start-ScheduledTask -TaskName $TaskName -TaskPath '\'
      if ($null -ne $maintenanceLease) {
        $rollbackHealth = Wait-ControlMaintenance $maintenanceLease $healthHost ([int]$config.port) $HealthCheckTimeoutSeconds `
          ([string]$state.activeVersion) $versionRoot $nodeExecutable
      }
      else {
        $rollbackHealth = Wait-ControlHealth $healthHost ([int]$config.port) $HealthCheckTimeoutSeconds `
          ([string]$state.activeVersion) $versionRoot $nodeExecutable
      }
    }
  }
  catch { $rollbackError = $_ }
  if ($null -ne $rollbackError) {
    throw "Uninstall failed and the prior task did not become healthy. Uninstall error: $($uninstallError.Exception.Message) Recovery error: $($rollbackError.Exception.Message)"
  }
  throw $uninstallError
}
finally {
  if ($null -ne $maintenanceLease) {
    Remove-ControlMaintenance $maintenanceLease
    $maintenanceLease = $null
    if ($null -ne $rollbackHealth) {
      [void](Wait-ControlMaintenanceReleased $healthHost ([int]$config.port) $HealthCheckTimeoutSeconds `
        ([string]$state.activeVersion) $versionRoot $nodeExecutable ([int]$rollbackHealth.ProcessId))
    }
    elseif (-not $taskStopped -and $null -ne $health) {
      [void](Wait-ControlMaintenanceReleased $healthHost ([int]$config.port) $HealthCheckTimeoutSeconds `
        ([string]$state.activeVersion) $versionRoot $nodeExecutable ([int]$health.ProcessId))
    }
  }
}
