[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$SourcePath,
  [string]$InstallRoot = (Join-Path $env:ProgramFiles 'Dyson Control'),
  [string]$TaskName = 'Dyson-Control',
  [string]$NodePath = '',
  [string]$NpmPath = '',
  [ValidateRange(5, 300)][int]$HealthCheckTimeoutSeconds = 30,
  [ValidateRange(0, 3600)][int]$OperationDrainTimeoutSeconds = 300,
  [ValidateRange(0, 2147483647)][int]$ExpectedCurrentProcessId = 0,
  [string]$UpdateStatusPath = '',
  [string]$UpdateOperationId = '',
  [switch]$AllowNonLoopback
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3
$managedDescription = 'Dyson Control managed startup task.'
$utf8NoBom = [Text.UTF8Encoding]::new($false)

function Get-FullPath([string]$PathValue) {
  if ([string]::IsNullOrWhiteSpace($PathValue) -or -not [IO.Path]::IsPathRooted($PathValue)) { throw "Path must be absolute: $PathValue" }
  return [IO.Path]::GetFullPath($PathValue).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
}

function Get-ExistingDirectory([string]$PathValue, [string]$Label) {
  $fullPath = Get-FullPath $PathValue
  $item = Get-Item -LiteralPath $fullPath -Force -ErrorAction Stop
  if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "$Label must be a plain directory: $fullPath" }
  return $fullPath
}

function Get-ExistingFile([string]$PathValue, [string]$Label) {
  $fullPath = Get-FullPath $PathValue
  $item = Get-Item -LiteralPath $fullPath -Force -ErrorAction Stop
  if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "$Label must be a plain file: $fullPath" }
  return $fullPath
}

function Test-PathInside([string]$Candidate, [string]$Parent) {
  $candidatePath = (Get-FullPath $Candidate) + [IO.Path]::DirectorySeparatorChar
  $parentPath = (Get-FullPath $Parent) + [IO.Path]::DirectorySeparatorChar
  return $candidatePath.StartsWith($parentPath, [StringComparison]::OrdinalIgnoreCase)
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
    throw 'Run this upgrader from an elevated Windows PowerShell session.'
  }
}

function Resolve-Executable([string]$ExplicitPath, [string]$CommandName, [string]$Label) {
  if (-not [string]::IsNullOrWhiteSpace($ExplicitPath)) { return Get-ExistingFile $ExplicitPath $Label }
  $command = Get-Command $CommandName -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -eq $command) { throw "$Label was not found. Pass its absolute path explicitly." }
  return Get-ExistingFile $command.Source $Label
}

function Assert-Node24([string]$Executable) {
  $version = (& $Executable -p 'process.versions.node').Trim()
  if ($LASTEXITCODE -ne 0 -or $version -notmatch '^(\d+)\.') { throw 'Unable to read the Node.js version.' }
  if ([int]$Matches[1] -lt 24) { throw "Node.js 24 or newer is required; found $version." }
}

function Assert-ObjectProperties([object]$Value, [string[]]$Expected, [string]$Label) {
  if ($null -eq $Value) { throw "$Label is missing." }
  $actual = @($Value.PSObject.Properties.Name)
  if ($actual.Count -ne $Expected.Count -or @(Compare-Object -ReferenceObject $Expected -DifferenceObject $actual -CaseSensitive).Count -ne 0) {
    throw "$Label contains unexpected fields."
  }
}

function Assert-LowerSha256([string]$Value, [string]$Label) {
  if ($Value -cnotmatch '^[0-9a-f]{64}$') { throw "$Label is not a lowercase SHA-256 value." }
}

function Read-ReleaseIdentity([string]$Root, [object]$Package) {
  $manifestPath = Get-ExistingFile (Join-Path $Root 'release-manifest.json') 'release-manifest.json'
  $release = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
  Assert-ObjectProperties $release @('schema', 'product', 'packageVersion', 'kind', 'bridge') 'Release manifest'
  if ($release.schema -ne 1 -or $release.product -cne 'dyson-control' -or
      [string]$release.packageVersion -cne [string]$Package.version -or [string]$release.kind -cnotin @('complete', 'panel-only')) {
    throw 'release-manifest.json does not match this Dyson Control package.'
  }

  $bridgeRoot = Join-Path $Root 'dist\bridge'
  if ([string]$release.kind -ceq 'panel-only') {
    if ($null -ne $release.bridge -or (Test-Path -LiteralPath $bridgeRoot)) {
      throw 'A panel-only release must not contain Bridge artifacts.'
    }
    return [pscustomobject]@{ Kind = 'panel-only'; Bridge = $null }
  }

  Assert-ObjectProperties $release.bridge @('dll', 'manifest', 'pluginVersion', 'bytes', 'sha256') 'Release Bridge identity'
  if ([string]$release.bridge.dll -cne 'dist/bridge/DysonControlBridge.dll' -or
      [string]$release.bridge.manifest -cne 'dist/bridge/bridge-manifest.json' -or
      [string]$release.bridge.pluginVersion -cne [string]$Package.version -or
      [long]$release.bridge.bytes -lt 2 -or [long]$release.bridge.bytes -gt (16 * 1024 * 1024)) {
    throw 'Release Bridge identity is invalid.'
  }
  Assert-LowerSha256 ([string]$release.bridge.sha256) 'Release Bridge hash'
  $bridgeDirectory = Get-ExistingDirectory $bridgeRoot 'Release Bridge directory'
  $children = @(Get-ChildItem -LiteralPath $bridgeDirectory -Force)
  if ($children.Count -ne 2 -or @($children | Where-Object { $_.PSIsContainer -or ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $_.Name -notin @('DysonControlBridge.dll', 'bridge-manifest.json') }).Count -ne 0) {
    throw 'Release Bridge directory must contain exactly the DLL and sanitized manifest.'
  }
  $dllPath = Get-ExistingFile (Join-Path $bridgeDirectory 'DysonControlBridge.dll') 'Release Bridge DLL'
  $bridgeManifestPath = Get-ExistingFile (Join-Path $bridgeDirectory 'bridge-manifest.json') 'Release Bridge build manifest'
  $dll = Get-Item -LiteralPath $dllPath
  $dllHash = (Get-FileHash -LiteralPath $dllPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($dll.Length -ne [long]$release.bridge.bytes -or $dllHash -cne [string]$release.bridge.sha256) {
    throw 'Release Bridge DLL does not match release-manifest.json.'
  }
  $signature = New-Object byte[] 2
  $stream = [IO.File]::OpenRead($dllPath)
  try { $read = $stream.Read($signature, 0, 2) }
  finally { $stream.Dispose() }
  if ($read -ne 2 -or $signature[0] -ne 0x4d -or $signature[1] -ne 0x5a) {
    throw 'Release Bridge DLL is not a bounded PE file.'
  }
  $build = Get-Content -LiteralPath $bridgeManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
  Assert-ObjectProperties $build @('schema', 'pluginVersion', 'builtAtUtc', 'dll', 'references') 'Bridge build manifest'
  Assert-ObjectProperties $build.dll @('file', 'bytes', 'sha256') 'Bridge build manifest DLL'
  $builtAt = [DateTimeOffset]::MinValue
  if ($build.schema -ne 1 -or [string]$build.pluginVersion -cne [string]$Package.version -or
      -not [DateTimeOffset]::TryParse([string]$build.builtAtUtc, [ref]$builtAt) -or
      [string]$build.dll.file -cne 'DysonControlBridge.dll' -or [long]$build.dll.bytes -ne $dll.Length -or
      [string]$build.dll.sha256 -cne $dllHash) {
    throw 'Bridge build manifest does not match the packaged DLL.'
  }
  Assert-LowerSha256 ([string]$build.dll.sha256) 'Bridge build manifest DLL hash'
  $expectedReferenceNames = @(
    'BepInEx', 'AssemblyCSharp', 'UnityEngine', 'UnityEngineCore', 'Netstandard',
    'NebulaAPI', 'NebulaModel', 'NebulaWorld', 'WebSocketSharp'
  )
  if (@($build.references).Count -ne $expectedReferenceNames.Count) {
    throw 'Bridge build manifest reference set is incomplete.'
  }
  $referenceNames = @()
  foreach ($reference in @($build.references)) {
    Assert-ObjectProperties $reference @('name', 'file', 'assemblyVersion', 'bytes', 'sha256') 'Bridge reference evidence'
    Assert-LowerSha256 ([string]$reference.sha256) 'Bridge reference hash'
    $referenceName = [string]$reference.name
    $referenceFile = [string]$reference.file
    if ($expectedReferenceNames -cnotcontains $referenceName -or
        [string]::IsNullOrWhiteSpace($referenceFile) -or $referenceFile.Length -gt 240 -or
        [IO.Path]::IsPathRooted($referenceFile) -or $referenceFile -match '[\\/]{2,}' -or $referenceFile -match '[\\/]$' -or
        $referenceFile -match '(^|[\\/])(?:\.|\.\.)([\\/]|$)' -or
        $referenceFile -match '[:\r\n\0]' -or $referenceFile -notmatch '^[A-Za-z0-9._ \\/-]+$' -or
        [string]$reference.assemblyVersion -notmatch '^\d+(?:\.\d+){1,3}$' -or
        [long]$reference.bytes -le 0 -or [long]$reference.bytes -gt (1024 * 1024 * 1024)) {
      throw 'Bridge reference evidence contains an unsafe path or value.'
    }
    $referenceNames += $referenceName
  }
  if (@(Compare-Object -ReferenceObject $expectedReferenceNames -DifferenceObject $referenceNames -CaseSensitive).Count -ne 0 -or
      @($referenceNames | Select-Object -Unique).Count -ne $expectedReferenceNames.Count) {
    throw 'Bridge build manifest reference names are invalid.'
  }
  return [pscustomobject]@{
    Kind = 'complete'
    Bridge = [pscustomobject]@{ PluginVersion = [string]$release.bridge.pluginVersion; Bytes = [long]$dll.Length; Sha256 = $dllHash }
  }
}

function Read-SourcePackage([string]$Root) {
  foreach ($relativePath in @(
    'package.json', 'package-lock.json', 'control.config.example.json', 'release-manifest.json', 'LICENSE',
    'dist\server\index.js', 'dist\server\admin.js', 'dist\shared\contracts.js', 'dist\web\index.html',
    'scripts\windows\install-control.ps1', 'scripts\windows\upgrade-control.ps1', 'scripts\windows\uninstall-control.ps1',
    'scripts\windows\configure-game.ps1', 'scripts\windows\remove-install-directory.ps1'
  )) {
    [void](Get-ExistingFile (Join-Path $Root $relativePath) "Release file $relativePath")
  }
  $package = Get-Content -LiteralPath (Join-Path $Root 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($package.name -ne 'dyson-control' -or [string]$package.version -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$') {
    throw 'SourcePath is not a versioned Dyson Control release.'
  }
  $release = Read-ReleaseIdentity $Root $package
  Add-Member -InputObject $package -NotePropertyName DysonReleaseKind -NotePropertyValue ([string]$release.Kind)
  Add-Member -InputObject $package -NotePropertyName DysonBridge -NotePropertyValue $release.Bridge
  return $package
}

function Read-InstallState([string]$StatePath, [string]$ExpectedRoot, [string]$ExpectedTaskName) {
  $path = Get-ExistingFile $StatePath 'install-state.json'
  $state = Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($state.schema -ne 1 -or $state.product -ne 'dyson-control' -or [string]$state.taskName -cne $ExpectedTaskName -or [string]$state.taskPath -ne '\') {
    throw 'The install state does not identify the requested managed task.'
  }
  if ((Get-FullPath ([string]$state.installRoot)) -ne $ExpectedRoot) { throw 'InstallRoot does not match install-state.json.' }
  if ([string]$state.activeVersion -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$') { throw 'The active version in install-state.json is invalid.' }
  return $state
}

function Read-ConfigPreflight([string]$PathValue, [string]$VersionsRoot, [bool]$PermitNonLoopback) {
  $fullPath = Get-ExistingFile $PathValue 'ConfigPath'
  $config = Get-Content -LiteralPath $fullPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ([string]::IsNullOrWhiteSpace([string]$config.host)) { throw 'The configuration host is missing.' }
  if (-not $PermitNonLoopback -and [string]$config.host -notin @('127.0.0.1', '::1', 'localhost')) {
    throw 'The control service must bind to loopback unless -AllowNonLoopback is explicitly supplied.'
  }
  $port = [int]$config.port
  if ($port -lt 1 -or $port -gt 65535) { throw 'The configuration port is invalid.' }
  $dataDirectory = Get-FullPath ([string]$config.dataDirectory)
  if (Test-PathInside $dataDirectory $VersionsRoot) { throw 'dataDirectory must be outside the version directory.' }
  if (Test-Path -LiteralPath $dataDirectory) {
    $dataItem = Get-Item -LiteralPath $dataDirectory -Force
    if (-not $dataItem.PSIsContainer -or ($dataItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "dataDirectory must be a plain directory: $dataDirectory" }
  }
  return [pscustomobject]@{ Path = $fullPath; Host = [string]$config.host; Port = $port; DataDirectory = $dataDirectory }
}

function Copy-Release([string]$Source, [string]$Destination, [object]$Package) {
  New-Item -ItemType Directory -Path $Destination -ErrorAction Stop | Out-Null
  foreach ($file in @('package.json', 'package-lock.json', 'control.config.example.json', 'release-manifest.json', 'LICENSE', 'README.md', 'GOAL.md')) {
    $sourceFile = Join-Path $Source $file
    if (Test-Path -LiteralPath $sourceFile -PathType Leaf) { Copy-Item -LiteralPath $sourceFile -Destination (Join-Path $Destination $file) }
  }
  New-Item -ItemType Directory -Path (Join-Path $Destination 'dist') | Out-Null
  foreach ($directory in @('server', 'shared', 'web')) {
    Copy-Item -LiteralPath (Join-Path $Source "dist\$directory") -Destination (Join-Path $Destination 'dist') -Recurse
  }
  if ([string]$Package.DysonReleaseKind -ceq 'complete') {
    Copy-Item -LiteralPath (Join-Path $Source 'dist\bridge') -Destination (Join-Path $Destination 'dist') -Recurse
  }
  $docsDirectory = Join-Path $Source 'docs'
  if (Test-Path -LiteralPath $docsDirectory -PathType Container) { Copy-Item -LiteralPath $docsDirectory -Destination $Destination -Recurse }
  New-Item -ItemType Directory -Path (Join-Path $Destination 'scripts') | Out-Null
  Copy-Item -LiteralPath (Join-Path $Source 'scripts\windows') -Destination (Join-Path $Destination 'scripts') -Recurse
}

function Install-ProductionDependencies([string]$VersionRoot, [string]$NpmExecutable) {
  Push-Location -LiteralPath $VersionRoot
  try {
    & $NpmExecutable ci --omit=dev --ignore-scripts --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed with exit code $LASTEXITCODE." }
  }
  finally { Pop-Location }
}

function Assert-RuntimeConfig([string]$VersionRoot, [string]$NodeExecutable, [string]$PrivateConfigPath) {
  & $NodeExecutable (Join-Path $VersionRoot 'dist\server\admin.js') validate-config $PrivateConfigPath
  if ($LASTEXITCODE -ne 0) { throw "Dyson Control rejected the configuration at $PrivateConfigPath." }
}

function ConvertTo-SingleQuotedLiteral([string]$Value) { return "'" + $Value.Replace("'", "''") + "'" }

function Write-Launcher([string]$VersionRoot, [string]$NodeExecutable, [string]$PrivateConfigPath, [string]$DataDirectory) {
  $launcherPath = Join-Path $VersionRoot 'run-control.ps1'
  $nodeLiteral = ConvertTo-SingleQuotedLiteral $NodeExecutable
  $indexLiteral = ConvertTo-SingleQuotedLiteral (Join-Path $VersionRoot 'dist\server\index.js')
  $versionLiteral = ConvertTo-SingleQuotedLiteral $VersionRoot
  $configLiteral = ConvertTo-SingleQuotedLiteral $PrivateConfigPath
  $stdoutLiteral = ConvertTo-SingleQuotedLiteral (Join-Path $DataDirectory 'control.stdout.log')
  $stderrLiteral = ConvertTo-SingleQuotedLiteral (Join-Path $DataDirectory 'control.stderr.log')
  $content = @"
`$ErrorActionPreference = 'Stop'
`$env:DYSON_CONTROL_CONFIG = $configLiteral
Set-Location -LiteralPath $versionLiteral
& $nodeLiteral $indexLiteral 1>> $stdoutLiteral 2>> $stderrLiteral
exit `$LASTEXITCODE
"@
  Set-Content -LiteralPath $launcherPath -Value $content -Encoding UTF8
  return $launcherPath
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
      Uri = $uri; Product = [string]$body.product; Version = [string]$body.version; ProcessId = $processId;
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
    [IO.File]::WriteAllText($temporary, (($value | ConvertTo-Json) + [Environment]::NewLine), $utf8NoBom)
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

function Write-InstallState([string]$Path, [object]$State) {
  $temporary = "$Path.partial-$([guid]::NewGuid().ToString('N'))"
  [IO.File]::WriteAllText($temporary, (($State | ConvertTo-Json -Depth 5) + [Environment]::NewLine), $utf8NoBom)
  Move-Item -LiteralPath $temporary -Destination $Path -Force
}

function Initialize-UpdateStatusTarget([string]$PathValue, [string]$OperationId) {
  if ([string]::IsNullOrWhiteSpace($PathValue) -and [string]::IsNullOrWhiteSpace($OperationId)) { return $null }
  if ([string]::IsNullOrWhiteSpace($PathValue) -or
      $OperationId -cnotmatch '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') {
    throw 'UpdateStatusPath and a valid UpdateOperationId must be supplied together.'
  }
  $fullPath = Get-FullPath $PathValue
  $parent = Get-ExistingDirectory (Split-Path -Parent $fullPath) 'Update status parent'
  if ((Get-FullPath (Split-Path -Parent $fullPath)) -ne $parent -or [IO.Path]::GetFileName($fullPath) -cne 'helper-status.json') {
    throw 'UpdateStatusPath must name helper-status.json in an existing plain directory.'
  }
  if (Test-Path -LiteralPath $fullPath) { [void](Get-ExistingFile $fullPath 'Update status file') }
  return [pscustomobject]@{ Path = $fullPath; OperationId = $OperationId }
}

function Write-ControlUpdateStatus(
  [object]$Target,
  [string]$Status,
  [string]$Step,
  [string]$TargetVersion,
  [string]$ActiveVersion,
  [string]$InstallRootValue,
  [int]$PreviousProcessId,
  [int]$ProcessId,
  [bool]$Accepting,
  [string]$Message
) {
  if ($null -eq $Target) { return }
  $temporary = "$($Target.Path).partial-$([guid]::NewGuid().ToString('N'))"
  $value = [ordered]@{
    schema = 1; product = 'dyson-control-control-update-result'; operationId = [string]$Target.OperationId;
    status = $Status; step = $Step; targetVersion = $TargetVersion; activeVersion = $ActiveVersion;
    installRoot = $InstallRootValue; previousProcessId = $PreviousProcessId; processId = $ProcessId;
    accepting = $Accepting; message = $Message; updatedAt = [DateTimeOffset]::UtcNow.ToString('o')
  }
  try {
    [IO.File]::WriteAllText($temporary, (($value | ConvertTo-Json -Depth 5) + [Environment]::NewLine), $utf8NoBom)
    Move-Item -LiteralPath $temporary -Destination $Target.Path -Force
  }
  finally { Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue }
}

Assert-TaskName $TaskName
$updateStatusTarget = Initialize-UpdateStatusTarget $UpdateStatusPath $UpdateOperationId
$sourceRoot = Get-ExistingDirectory $SourcePath 'SourcePath'
$installRootPath = Get-ExistingDirectory $InstallRoot 'InstallRoot'
$versionsRoot = Join-Path $installRootPath 'versions'
$statePath = Join-Path $installRootPath 'install-state.json'
$state = Read-InstallState $statePath $installRootPath $TaskName
$oldVersionRoot = Get-ExistingDirectory (Join-Path $versionsRoot ([string]$state.activeVersion)) 'Active version directory'
$package = Read-SourcePackage $sourceRoot
$newVersion = [string]$package.version
if ($newVersion -eq [string]$state.activeVersion) { throw "Version $newVersion is already active." }
$newVersionRoot = Join-Path $versionsRoot $newVersion
if (Test-Path -LiteralPath $newVersionRoot) { throw "Version directory already exists: $newVersionRoot" }
$configInfo = Read-ConfigPreflight ([string]$state.configPath) $versionsRoot $AllowNonLoopback.IsPresent
if ([string]::IsNullOrWhiteSpace($NodePath)) { $NodePath = [string]$state.nodePath }
if ([string]::IsNullOrWhiteSpace($NpmPath)) { $NpmPath = [string]$state.npmPath }
$nodeExecutable = Resolve-Executable $NodePath 'node.exe' 'NodePath'
$npmExecutable = Resolve-Executable $NpmPath 'npm.cmd' 'NpmPath'
Assert-Node24 $nodeExecutable
Assert-Administrator

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop | Where-Object { $_.TaskName -ceq $TaskName -and $_.TaskPath -eq '\' } | Select-Object -First 1
if ($null -eq $task -or $task.Description -cne $managedDescription) { throw 'Refusing to upgrade a task that is not owned by Dyson Control.' }
$healthHost = Get-HealthHost $configInfo.Host
$oldHealth = Get-ControlHealth $healthHost $configInfo.Port
if ($null -ne $oldHealth -and ($oldHealth.Version -cne [string]$state.activeVersion -or
    -not (Test-ControlProcessIdentity $oldHealth.ProcessId $oldVersionRoot $nodeExecutable))) {
  throw "The current listener at $($oldHealth.Uri) is not the installed Dyson Control $($state.activeVersion) task process."
}
if ($task.State -eq 'Running' -and $null -eq $oldHealth) {
  $oldHealth = Wait-ControlHealth $healthHost $configInfo.Port $HealthCheckTimeoutSeconds ([string]$state.activeVersion) $oldVersionRoot $nodeExecutable
}
if ($ExpectedCurrentProcessId -gt 0 -and ($null -eq $oldHealth -or [int]$oldHealth.ProcessId -ne $ExpectedCurrentProcessId)) {
  throw "The running Dyson Control process does not match expected PID $ExpectedCurrentProcessId."
}

$rollbackRoot = Join-Path (Join-Path $installRootPath 'rollback') ((Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ') + '-' + [string]$state.activeVersion)
New-Item -ItemType Directory -Path $rollbackRoot -ErrorAction Stop | Out-Null
$taskXmlPath = Join-Path $rollbackRoot 'scheduled-task.xml'
$stateBackupPath = Join-Path $rollbackRoot 'install-state.json'
Export-ScheduledTask -TaskName $TaskName -TaskPath '\' | Set-Content -LiteralPath $taskXmlPath -Encoding UTF8
Copy-Item -LiteralPath $statePath -Destination $stateBackupPath

$stageRoot = Join-Path $versionsRoot ('.upgrade-' + $newVersion + '-' + [guid]::NewGuid().ToString('N'))
$taskSwitched = $false
$taskStopped = $false
$oldWasRunning = $task.State -eq 'Running' -or $null -ne $oldHealth
$maintenanceLease = $null
$newHealth = $null
$newPausedHealth = $null
$rollbackHealth = $null
$stateUpdated = $false
$upgradeError = $null
$rollbackError = $null
try {
  Copy-Release $sourceRoot $stageRoot $package
  Install-ProductionDependencies $stageRoot $npmExecutable
  Assert-RuntimeConfig $stageRoot $nodeExecutable $configInfo.Path
  Move-Item -LiteralPath $stageRoot -Destination $newVersionRoot
  $stageRoot = $null
  $launcherPath = Write-Launcher $newVersionRoot $nodeExecutable $configInfo.Path $configInfo.DataDirectory

  $maintenanceLease = New-ControlMaintenance $configInfo.DataDirectory
  if ($null -ne $oldHealth) {
    $oldHealth = Wait-ControlMaintenance $maintenanceLease $healthHost $configInfo.Port $HealthCheckTimeoutSeconds `
      ([string]$state.activeVersion) $oldVersionRoot $nodeExecutable ([int]$oldHealth.ProcessId)
  }
  Wait-ControlIdle $configInfo.DataDirectory $nodeExecutable $OperationDrainTimeoutSeconds
  Stop-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction SilentlyContinue
  $taskStopped = $true
  if ($null -ne $oldHealth) { Wait-ControlProcessExit $oldHealth.ProcessId $HealthCheckTimeoutSeconds }
  $powerShellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $actionArguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}"' -f $launcherPath.Replace('"', '""')
  $action = New-ScheduledTaskAction -Execute $powerShellPath -Argument $actionArguments -WorkingDirectory $newVersionRoot
  Set-ScheduledTask -TaskName $TaskName -TaskPath '\' -Action $action | Out-Null
  $taskSwitched = $true
  Start-ScheduledTask -TaskName $TaskName -TaskPath '\'
  $excludedProcessId = if ($null -eq $oldHealth) { 0 } else { [int]$oldHealth.ProcessId }
  Write-ControlUpdateStatus $updateStatusTarget 'applying' 'healthCheck' $newVersion $newVersion $installRootPath `
    $ExpectedCurrentProcessId 0 $false 'The candidate task started; exact version, root, PID, and maintenance health are being verified.'
  $newPausedHealth = Wait-ControlMaintenance $maintenanceLease $healthHost $configInfo.Port $HealthCheckTimeoutSeconds `
    $newVersion $newVersionRoot $nodeExecutable 0 $excludedProcessId

  $updated = [ordered]@{
    schema = 1; product = 'dyson-control'; taskName = $TaskName; taskPath = '\';
    installRoot = $installRootPath; configPath = $configInfo.Path; dataDirectory = $configInfo.DataDirectory;
    nodePath = $nodeExecutable; npmPath = $npmExecutable; activeVersion = $newVersion;
    releaseKind = [string]$package.DysonReleaseKind; bridgeCandidate = $package.DysonBridge;
    previousVersion = [string]$state.activeVersion; rollbackDefinition = $taskXmlPath;
    createdAt = [string]$state.createdAt; updatedAt = [DateTime]::UtcNow.ToString('o')
  }
  Write-InstallState $statePath $updated
  $stateUpdated = $true
  Remove-ControlMaintenance $maintenanceLease
  $maintenanceLease = $null
  $newHealth = Wait-ControlMaintenanceReleased $healthHost $configInfo.Port $HealthCheckTimeoutSeconds `
    $newVersion $newVersionRoot $nodeExecutable ([int]$newPausedHealth.ProcessId)
  Write-ControlUpdateStatus $updateStatusTarget 'succeeded' 'complete' $newVersion $newVersion $installRootPath `
    $ExpectedCurrentProcessId ([int]$newHealth.ProcessId) ([bool]$newHealth.Accepting) 'The exact target version is accepting requests from the managed installation root and a replacement process.'
  Write-Output "Upgraded Dyson Control from $($state.activeVersion) to $newVersion."
  Write-Output "Health: $($newHealth.Uri) (PID $($newHealth.ProcessId))"
  if ([string]$package.DysonReleaseKind -ceq 'complete') {
    Write-Output "Release: complete; Bridge candidate retained at $newVersionRoot\dist\bridge (SHA-256 $($package.DysonBridge.Sha256))."
  }
  else {
    Write-Output 'Release: panel-only; no game Bridge was included or changed. Any already deployed game Bridge remains untouched.'
  }
  Write-Output "Rollback task definition: $taskXmlPath"
  Write-Output "Previous version retained: $oldVersionRoot"
}
catch {
  $upgradeError = $_
  try {
    Write-ControlUpdateStatus $updateStatusTarget 'applying' 'rollback' $newVersion ([string]$state.activeVersion) $installRootPath `
      $ExpectedCurrentProcessId 0 $false 'The target did not reach a verified healthy state; automatic recovery is running.'
  }
  catch { }
  try {
    if ($taskSwitched) {
      if ($null -eq $newPausedHealth -and $null -eq $newHealth) {
        $candidateHealth = Get-ControlHealth $healthHost $configInfo.Port
        if ($null -ne $candidateHealth -and (Test-ControlProcessIdentity $candidateHealth.ProcessId $newVersionRoot $nodeExecutable)) {
          $newPausedHealth = $candidateHealth
        }
      }
      Stop-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction SilentlyContinue
      $candidateProcessId = if ($null -ne $newHealth) { [int]$newHealth.ProcessId } elseif ($null -ne $newPausedHealth) { [int]$newPausedHealth.ProcessId } else { 0 }
      if ($candidateProcessId -gt 0) { Wait-ControlProcessExit $candidateProcessId $HealthCheckTimeoutSeconds }
      $oldXml = Get-Content -LiteralPath $taskXmlPath -Raw -Encoding UTF8
      Register-ScheduledTask -TaskName $TaskName -TaskPath '\' -Xml $oldXml -Force | Out-Null
    }
    if ($stateUpdated) {
      $savedState = Get-Content -LiteralPath $stateBackupPath -Raw -Encoding UTF8 | ConvertFrom-Json
      Write-InstallState $statePath $savedState
      $stateUpdated = $false
    }
    if (($taskStopped -or $taskSwitched) -and $oldWasRunning) {
      Start-ScheduledTask -TaskName $TaskName -TaskPath '\'
      if ($null -ne $maintenanceLease) {
        $excludedRollbackProcessId = if ($null -ne $newHealth) { [int]$newHealth.ProcessId } elseif ($null -ne $newPausedHealth) { [int]$newPausedHealth.ProcessId } else { 0 }
        $rollbackHealth = Wait-ControlMaintenance $maintenanceLease $healthHost $configInfo.Port $HealthCheckTimeoutSeconds `
          ([string]$state.activeVersion) $oldVersionRoot $nodeExecutable 0 $excludedRollbackProcessId
      }
      else {
        $rollbackHealth = Wait-ControlHealth $healthHost $configInfo.Port $HealthCheckTimeoutSeconds `
          ([string]$state.activeVersion) $oldVersionRoot $nodeExecutable
      }
    }
  }
  catch { $rollbackError = $_ }
  if ($null -ne $rollbackError) {
    throw "Upgrade failed and rollback did not become healthy. Upgrade error: $($upgradeError.Exception.Message) Rollback error: $($rollbackError.Exception.Message)"
  }
  if ($taskStopped -or $taskSwitched) {
    throw "Upgrade failed; the prior task definition, version, and running state were restored. $($upgradeError.Exception.Message)"
  }
  throw $upgradeError
}
finally {
  if ($null -ne $stageRoot -and (Test-Path -LiteralPath $stageRoot)) {
    try { & (Join-Path $PSScriptRoot 'remove-install-directory.ps1') -Directory $stageRoot -VersionsRoot $versionsRoot -NodePath $nodeExecutable }
    catch {
      if ($null -ne $upgradeError) { throw "Upgrade failed: $($upgradeError.Exception.Message) Staging cleanup also failed: $($_.Exception.Message)" }
      throw
    }
  }
  if ($null -ne $maintenanceLease) {
    Remove-ControlMaintenance $maintenanceLease
    $maintenanceLease = $null
    if ($null -ne $rollbackHealth) {
      $rollbackHealth = Wait-ControlMaintenanceReleased $healthHost $configInfo.Port $HealthCheckTimeoutSeconds `
        ([string]$state.activeVersion) $oldVersionRoot $nodeExecutable ([int]$rollbackHealth.ProcessId)
    }
    elseif (-not $taskStopped -and $null -ne $oldHealth) {
      [void](Wait-ControlMaintenanceReleased $healthHost $configInfo.Port $HealthCheckTimeoutSeconds `
        ([string]$state.activeVersion) $oldVersionRoot $nodeExecutable ([int]$oldHealth.ProcessId))
    }
  }
  if ($null -ne $upgradeError -and $null -eq $rollbackError -and $null -ne $rollbackHealth -and [bool]$rollbackHealth.Accepting) {
    try {
      $restoredState = Read-InstallState $statePath $installRootPath $TaskName
      $restoredTask = Get-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction Stop
      if ([string]$restoredState.activeVersion -cne [string]$state.activeVersion -or
          $restoredTask.Description -cne $managedDescription -or $restoredTask.Principal.UserId -notin @('SYSTEM', 'S-1-5-18')) {
        throw 'Restored install state or task ownership could not be verified.'
      }
      Write-ControlUpdateStatus $updateStatusTarget 'rolledBack' 'complete' $newVersion ([string]$state.activeVersion) $installRootPath `
        $ExpectedCurrentProcessId ([int]$rollbackHealth.ProcessId) ([bool]$rollbackHealth.Accepting) 'The prior version, task definition, install state, and accepting health were restored.'
    }
    catch { }
  }
}
