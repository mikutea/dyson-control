<#
.SYNOPSIS
Exercises real SYSTEM installation, upgrade, failed-upgrade rollback, and uninstall in an isolated temporary directory.
.DESCRIPTION
Requires an elevated Windows PowerShell session. Only unique fixture tasks and an isolated loopback instance are created. No game process or existing installation is used. The fixture directory and report are retained for inspection.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$ReleaseArchive,
  [string]$ControlUpdateArchive = '',
  [Parameter(Mandatory = $true)][string]$NodePath,
  [Parameter(Mandatory = $true)][string]$NpmPath
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Set-StrictMode -Version 3
$principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'This fixture requires an elevated Windows session.' }
$archivePath = (Resolve-Path -LiteralPath $ReleaseArchive).Path
$expected = ((Get-Content -LiteralPath ($archivePath + '.sha256') -Raw).Trim() -split '\s+')[0]
if ((Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $expected) { throw 'Release checksum mismatch.' }
$controlUpdateArchivePath = $archivePath
$controlUpdateExpected = $expected
if (-not [string]::IsNullOrWhiteSpace($ControlUpdateArchive)) {
  $controlUpdateArchivePath = (Resolve-Path -LiteralPath $ControlUpdateArchive).Path
  $controlUpdateExpected = ((Get-Content -LiteralPath ($controlUpdateArchivePath + '.sha256') -Raw).Trim() -split '\s+')[0]
  if ((Get-FileHash -LiteralPath $controlUpdateArchivePath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $controlUpdateExpected) {
    throw 'Control update release checksum mismatch.'
  }
}
$node = (Resolve-Path -LiteralPath $NodePath).Path
$npm = (Resolve-Path -LiteralPath $NpmPath).Path
$fixtureId = [guid]::NewGuid().ToString('N')
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
$root = [IO.Path]::GetFullPath((Join-Path $tempRoot ('dyson-install-fixture-' + $fixtureId)))
if (-not $root.StartsWith($tempRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Fixture escaped the temporary directory.' }
New-Item -ItemType Directory -Path $root | Out-Null
$taskName = 'Dyson-Control-Fixture-' + $fixtureId
$installRoot = Join-Path $root 'installed'
$sourceRoot = Join-Path $root 'source'
$candidateTemplateRoot = $sourceRoot
$privateRoot = Join-Path $root 'private'
New-Item -ItemType Directory -Path $privateRoot | Out-Null
$configPath = Join-Path $privateRoot 'control.config.json'
$reportPath = Join-Path $root 'fixture-report.json'
$utf8 = [Text.UTF8Encoding]::new($false)
$steps = [Collections.Generic.List[string]]::new()
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$listener.Start()
$port = ([Net.IPEndPoint]$listener.LocalEndpoint).Port
$listener.Stop()
$scope = [ordered]@{
  fixtureId = $fixtureId; taskName = $taskName; fixtureRoot = $root; installRoot = $installRoot;
  configPath = $configPath; dataDirectory = (Join-Path $privateRoot 'data'); loopbackPort = $port
}
$installed = $false
$bootstrapTaskName = $null
$helperTaskName = $null
$candidateEditor = @'
const fs = require('node:fs'); const path = require('node:path');
const root = process.argv[1], version = process.argv[2];
const packagePath = path.join(root, 'package.json');
const packageValue = JSON.parse(fs.readFileSync(packagePath, 'utf8')); packageValue.version = version;
fs.writeFileSync(packagePath, JSON.stringify(packageValue, null, 2) + '\n');
const lockPath = path.join(root, 'package-lock.json');
const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
if (!lock.packages || !lock.packages['']) throw new Error('package-lock.json is missing its root package entry.');
lock.version = version; lock.packages[''].version = version;
fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
const manifestPath = path.join(root, 'release-manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); manifest.packageVersion = version;
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
'@

function Get-FixtureHealth {
  $health = (Invoke-WebRequest -Uri "http://127.0.0.1:$port/healthz" -UseBasicParsing -TimeoutSec 5).Content | ConvertFrom-Json
  if ($health.product -cne 'dyson-control' -or -not $health.accepting) { throw 'Fixture is not accepting requests.' }
  return $health
}

function Test-FixtureListener {
  $client = [Net.Sockets.TcpClient]::new()
  try {
    $connection = $client.BeginConnect([Net.IPAddress]::Loopback, $port, $null, $null)
    if (-not $connection.AsyncWaitHandle.WaitOne(1000)) { return $false }
    try {
      $client.EndConnect($connection)
      return $client.Connected
    }
    catch { return $false }
  }
  finally { $client.Dispose() }
}

function Get-FixtureProcesses {
  return @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
    -not [string]::IsNullOrWhiteSpace([string]$_.CommandLine) -and
    ([string]$_.CommandLine).IndexOf($installRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0
  })
}

function Assert-Utf8JsonWithoutBom([string]$PathValue, [string]$Label) {
  $bytes = [IO.File]::ReadAllBytes($PathValue)
  if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
    throw "$Label must be UTF-8 without a byte-order mark."
  }
}

function New-Candidate([string]$PathValue, [string]$Version, [bool]$FailStartup) {
  $candidate = [IO.Path]::GetFullPath($PathValue)
  Copy-Item -LiteralPath $candidateTemplateRoot -Destination $candidate -Recurse
  & $node -e $candidateEditor $candidate $Version
  if ($LASTEXITCODE -ne 0) { throw "Unable to prepare fixture candidate $Version." }
  if ($FailStartup) {
    [IO.File]::WriteAllText((Join-Path $candidate 'dist\server\index.js'), "throw new Error('Intentional isolated installation fixture failure');", $utf8)
  }
  return $candidate
}

function Get-DirectoryFingerprint([string]$PathValue) {
  $rootPath = [IO.Path]::GetFullPath($PathValue).TrimEnd('\')
  $files = [Collections.Generic.List[string]]::new()
  foreach ($item in Get-ChildItem -LiteralPath $rootPath -Recurse -Force) {
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Fixture candidate contains a reparse point: $($item.FullName)" }
    if (-not $item.PSIsContainer) {
      $files.Add($item.FullName.Substring($rootPath.Length).TrimStart('\').Replace('\', '/'))
    }
  }
  $ordered = $files.ToArray()
  [Array]::Sort($ordered, [StringComparer]::Ordinal)
  $builder = [Text.StringBuilder]::new()
  foreach ($relative in $ordered) {
    $file = Join-Path $rootPath $relative.Replace('/', '\')
    $item = Get-Item -LiteralPath $file -Force
    $fileHash = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
    [void]$builder.Append($relative).Append([char]0).Append($item.Length).Append([char]0).Append($fileHash).Append("`n")
  }
  $hasher = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($hasher.ComputeHash($utf8.GetBytes($builder.ToString())))).Replace('-', '').ToLowerInvariant() }
  finally { $hasher.Dispose() }
}

function New-ReceiptToken {
  $bytes = New-Object byte[] 32
  $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $generator.GetBytes($bytes) } finally { $generator.Dispose() }
  return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function Get-Sha256Text([string]$Value) {
  $hasher = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($hasher.ComputeHash($utf8.GetBytes($Value)))).Replace('-', '').ToLowerInvariant() }
  finally { $hasher.Dispose() }
}

function Write-Utf8Json([string]$PathValue, [object]$Value) {
  [IO.File]::WriteAllText($PathValue, (($Value | ConvertTo-Json -Depth 8) + [Environment]::NewLine), $utf8)
}

function Wait-FixtureTaskAbsent([string]$Name, [int]$TimeoutSeconds) {
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  do {
    if ($null -eq (Get-ScheduledTask -TaskName $Name -TaskPath '\' -ErrorAction SilentlyContinue)) { return }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "Fixture task remained registered: $Name"
}

try {
  Expand-Archive -LiteralPath $archivePath -DestinationPath $sourceRoot
  if (-not [string]::IsNullOrWhiteSpace($ControlUpdateArchive)) {
    $candidateTemplateRoot = Join-Path $root 'control-update-source'
    Expand-Archive -LiteralPath $controlUpdateArchivePath -DestinationPath $candidateTemplateRoot
  }
  $package = Get-Content -LiteralPath (Join-Path $sourceRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $originalVersion = [string]$package.version
  $versionPrefix = ($originalVersion -split '[-+]')[0]
  $nextVersion = $versionPrefix + '-fixture.1'
  $failedVersion = $versionPrefix + '-fixture.2'
  $generator = @'
const fs = require('node:fs'); const path = require('node:path'); const crypto = require('node:crypto');
const root = process.argv[2], port = Number(process.argv[3]);
const salt = crypto.randomBytes(16), hash = crypto.scryptSync(crypto.randomBytes(32), salt, 32, {N:16384,r:8,p:1,maxmem:67108864});
const passwordHash = ['scrypt','v1',16384,8,1,salt.toString('base64url'),hash.toString('base64url')].join('$');
const gameRoot = path.join(root, 'game'); fs.mkdirSync(gameRoot, {recursive:true});
const config = {host:'127.0.0.1',port,mode:'windows',dataDirectory:path.join(root,'data'),adminPasswordHash:passwordHash,controlUpdates:{repository:'fixture-owner/fixture-repository'},game:{root:gameRoot,saveDirectory:path.join(root,'saves'),backupDirectory:path.join(root,'backups'),logFile:path.join(root,'game.log'),bridgeDirectory:path.join(root,'bridge'),bridgeSecretFile:path.join(root,'bridge.secret'),startTaskName:'Unused-Fixture-Game',address:'fixture.invalid:8469',serverName:'Isolated installer fixture'}};
fs.writeFileSync(path.join(root,'control.config.json'),JSON.stringify(config,null,2));
fs.mkdirSync(config.dataDirectory,{recursive:true}); fs.writeFileSync(path.join(config.dataDirectory,'preserved-user-file.txt'),'fixture sentinel');
'@
  $generatorPath = Join-Path $root 'generate-config.cjs'
  [IO.File]::WriteAllText($generatorPath, $generator, $utf8)
  & $node $generatorPath $privateRoot $port
  if ($LASTEXITCODE -ne 0) { throw 'Unable to generate private fixture config.' }
  $configHash = (Get-FileHash -LiteralPath $configPath -Algorithm SHA256).Hash
  $sentinelPath = Join-Path $privateRoot 'data\preserved-user-file.txt'
  $sentinelHash = (Get-FileHash -LiteralPath $sentinelPath -Algorithm SHA256).Hash
  & (Join-Path $sourceRoot 'scripts\windows\install-control.ps1') -SourcePath $sourceRoot -InstallRoot $installRoot -ConfigPath $configPath -TaskName $taskName -NodePath $node -NpmPath $npm -HealthCheckTimeoutSeconds 30
  $installed = $true
  $first = Get-FixtureHealth
  if ($first.version -cne $originalVersion) { throw 'Installed version mismatch.' }
  Assert-Utf8JsonWithoutBom (Join-Path $installRoot 'install-state.json') 'Initial install state'
  $task = Get-ScheduledTask -TaskName $taskName -TaskPath '\'
  if ($task.Principal.UserId -notin @('SYSTEM', 'S-1-5-18') -or $task.Description -cne 'Dyson Control managed startup task.') { throw 'Unexpected fixture task identity.' }
  $steps.Add('install-system-task-and-health')

  $operationId = [guid]::NewGuid().ToString()
  $operationRoot = Join-Path $privateRoot ('data\control-updates\operations\' + $operationId)
  New-Item -ItemType Directory -Path $operationRoot | Out-Null
  $nextSource = New-Candidate (Join-Path $operationRoot 'source') $nextVersion $false
  $archiveName = "dyson-control-v$nextVersion-windows-panel-only.zip"
  $candidateArchive = Join-Path $operationRoot $archiveName
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [IO.Compression.ZipFile]::CreateFromDirectory($nextSource, $candidateArchive, [IO.Compression.CompressionLevel]::Optimal, $false)
  $archiveSha256 = (Get-FileHash -LiteralPath $candidateArchive -Algorithm SHA256).Hash.ToLowerInvariant()
  $sourceFingerprint = Get-DirectoryFingerprint $nextSource
  $receiptToken = New-ReceiptToken
  if ($receiptToken.Length -ne 43) { throw 'Fixture receipt token has an unexpected length.' }
  $now = [DateTime]::UtcNow.ToString('o')
  $operationPath = Join-Path $operationRoot 'operation.json'
  $helperStatusPath = Join-Path $operationRoot 'helper-status.json'
  $handoffPath = Join-Path $operationRoot 'handoff.json'
  $record = [ordered]@{
    id = $operationId; requestId = 'fixture-prepare'; applyRequestId = $null;
    repository = 'fixture-owner/fixture-repository'; fromVersion = $originalVersion; targetVersion = $nextVersion;
    state = 'ready'; step = 'prepared'; message = 'Fixture candidate is ready.';
    releaseUrl = ('https://github.com/fixture-owner/fixture-repository/releases/tag/v' + $nextVersion);
    assetName = $archiveName; sha256 = $archiveSha256; createdAt = $now; updatedAt = $now; completedAt = $null;
    receiptHash = (Get-Sha256Text $receiptToken); receiptExpiresAt = $null; operationRoot = $operationRoot;
    archivePath = $candidateArchive; sourcePath = $nextSource; sourceFingerprint = $sourceFingerprint; helperStatusPath = $null
  }
  Write-Utf8Json $operationPath $record
  Assert-Utf8JsonWithoutBom $operationPath 'Prepared update record'

  $currentVersionRoot = Join-Path $installRoot ('versions\' + $originalVersion)
  $handoff = [ordered]@{
    schema = 1; product = 'dyson-control-control-update-handoff'; operationId = $operationId;
    repository = $record.repository; currentVersion = $originalVersion; expectedVersion = $nextVersion;
    installRoot = $installRoot; currentVersionRoot = $currentVersionRoot; taskName = $taskName;
    previousProcessId = [int]$first.processId; archivePath = $candidateArchive; archiveSha256 = $archiveSha256;
    sourcePath = $nextSource; sourceFingerprint = $sourceFingerprint;
    upgradeScriptPath = (Join-Path $currentVersionRoot 'scripts\windows\upgrade-control.ps1');
    statusPath = $helperStatusPath; createdAt = $now
  }
  Write-Utf8Json $handoffPath $handoff
  $record.applyRequestId = 'fixture-apply'
  $record.state = 'scheduled'
  $record.step = 'handoff'
  $record.message = 'Fixture SYSTEM update task is scheduled.'
  $record.helperStatusPath = $helperStatusPath
  $record.updatedAt = [DateTime]::UtcNow.ToString('o')
  Write-Utf8Json $operationPath $record

  $helperTaskName = 'Dyson-Control-Update-' + $operationId.Replace('-', '')
  $bootstrapTaskName = 'Dyson-Control-Fixture-Bootstrap-' + $fixtureId
  $scope['controlUpdateOperationId'] = $operationId
  $scope['helperTaskName'] = $helperTaskName
  $scope['bootstrapTaskName'] = $bootstrapTaskName
  $powerShellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $helperPath = Join-Path $currentVersionRoot 'scripts\windows\control-update-helper.ps1'
  $arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}" -Mode Register -OperationFile "{1}"' -f $helperPath.Replace('"', '""'), $handoffPath.Replace('"', '""')
  $action = New-ScheduledTaskAction -Execute $powerShellPath -Argument $arguments -WorkingDirectory $currentVersionRoot
  $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::FromMinutes(10)) -MultipleInstances IgnoreNew
  $definition = New-ScheduledTask -Action $action -Principal $principal -Settings $settings -Description ('Dyson Control isolated fixture bootstrap ' + $fixtureId)
  Register-ScheduledTask -TaskName $bootstrapTaskName -TaskPath '\' -InputObject $definition | Out-Null
  Start-ScheduledTask -TaskName $bootstrapTaskName -TaskPath '\'

  $helperDeadline = [DateTime]::UtcNow.AddSeconds(90)
  do {
    if (Test-Path -LiteralPath $helperStatusPath -PathType Leaf) { break }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $helperDeadline)
  if (-not (Test-Path -LiteralPath $helperStatusPath -PathType Leaf)) { throw 'The SYSTEM control update helper did not publish status.' }
  Stop-ScheduledTask -TaskName $bootstrapTaskName -TaskPath '\' -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $bootstrapTaskName -TaskPath '\' -Confirm:$false
  Wait-FixtureTaskAbsent $bootstrapTaskName 10

  do {
    $helperStatus = Get-Content -LiteralPath $helperStatusPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ([string]$helperStatus.status -in @('succeeded', 'rolledBack', 'failed')) { break }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $helperDeadline)
  Assert-Utf8JsonWithoutBom $helperStatusPath 'SYSTEM helper status'
  if ($helperStatus.schema -ne 1 -or [string]$helperStatus.product -cne 'dyson-control-control-update-result' -or
      [string]$helperStatus.operationId -cne $operationId -or [string]$helperStatus.targetVersion -cne $nextVersion -or
      [string]$helperStatus.activeVersion -cne $nextVersion -or [string]$helperStatus.installRoot -cne $installRoot -or
      [int]$helperStatus.previousProcessId -ne [int]$first.processId -or -not [bool]$helperStatus.accepting -or
      [string]$helperStatus.status -cne 'succeeded' -or [string]$helperStatus.step -cne 'complete') {
    throw "The SYSTEM control update helper did not succeed: $([string]$helperStatus.status)"
  }
  Wait-FixtureTaskAbsent $helperTaskName 15

  $receiptDeadline = [DateTime]::UtcNow.AddSeconds(30)
  $receipt = $null
  do {
    try {
      $receiptResponse = Invoke-WebRequest -Uri "http://127.0.0.1:$port/api/control-updates/$operationId/receipt" -Headers @{ 'x-update-receipt' = $receiptToken } -UseBasicParsing -TimeoutSec 5
      $receipt = ($receiptResponse.Content | ConvertFrom-Json).data
      if ([string]$receipt.state -ceq 'succeeded') { break }
    } catch { $receipt = $null }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $receiptDeadline)
  $receiptToken = $null
  if ($null -eq $receipt -or [string]$receipt.id -cne $operationId -or [string]$receipt.state -cne 'succeeded' -or [string]$receipt.step -cne 'complete') {
    throw 'The unauthenticated update receipt did not confirm a succeeded terminal operation.'
  }
  $storedReceipt = Get-Content -LiteralPath $operationPath -Raw -Encoding UTF8 | ConvertFrom-Json
  Assert-Utf8JsonWithoutBom $operationPath 'Completed update record'
  if ([string]$storedReceipt.state -cne 'succeeded' -or [string]$storedReceipt.step -cne 'complete' -or
      -not [string]$storedReceipt.receiptExpiresAt -or [DateTimeOffset]::Parse([string]$storedReceipt.receiptExpiresAt) -le [DateTimeOffset]::UtcNow -or
      $null -ne $storedReceipt.archivePath -or $null -ne $storedReceipt.sourcePath -or $null -ne $storedReceipt.sourceFingerprint -or
      (Test-Path -LiteralPath $candidateArchive) -or (Test-Path -LiteralPath $nextSource)) {
    throw 'The update receipt did not persist and clean the completed operation as expected.'
  }
  $second = Get-FixtureHealth
  if ($second.version -cne $nextVersion -or $second.processId -eq $first.processId -or [int]$helperStatus.processId -ne [int]$second.processId) { throw 'SYSTEM helper upgrade did not replace the fixture instance.' }
  if ($null -ne (Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$first.processId)" -ErrorAction SilentlyContinue)) { throw 'The pre-upgrade fixture process remains after helper success.' }
  $steps.Add('system-helper-handoff-receipt-cleanup-and-new-pid')

  $badSource = New-Candidate (Join-Path $root 'failed-source') $failedVersion $true
  $expectedFailure = $false
  try {
    & (Join-Path $sourceRoot 'scripts\windows\upgrade-control.ps1') -SourcePath $badSource -InstallRoot $installRoot -TaskName $taskName -HealthCheckTimeoutSeconds 10 -OperationDrainTimeoutSeconds 30
  } catch {
    if ($_.Exception.Message -notlike 'Upgrade failed; the prior task definition, version, and running state were restored.*') { throw }
    $expectedFailure = $true
  }
  if (-not $expectedFailure) { throw 'The intentionally broken upgrade unexpectedly succeeded.' }
  $recovered = Get-FixtureHealth
  $state = Get-Content -LiteralPath (Join-Path $installRoot 'install-state.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  Assert-Utf8JsonWithoutBom (Join-Path $installRoot 'install-state.json') 'Upgraded install state'
  if ($recovered.version -cne $nextVersion -or $state.activeVersion -cne $nextVersion) { throw 'Failed upgrade did not restore the prior version.' }
  if (Test-Path -LiteralPath (Join-Path $privateRoot 'data\.control-maintenance.json')) { throw 'Maintenance marker remained after recovery.' }
  $steps.Add('failed-startup-restores-prior-task-version-and-service')

  & (Join-Path $sourceRoot 'scripts\windows\uninstall-control.ps1') -InstallRoot $installRoot -TaskName $taskName -HealthCheckTimeoutSeconds 30 -OperationDrainTimeoutSeconds 30
  if ($null -ne (Get-ScheduledTask -TaskName $taskName -TaskPath '\' -ErrorAction SilentlyContinue)) { throw 'Fixture task remains after uninstall.' }
  if (@(Get-FixtureProcesses).Count -ne 0) { throw 'A fixture process remains after uninstall.' }
  if (Test-FixtureListener) { throw 'The fixture listener remains reachable after uninstall.' }
  if (Test-Path -LiteralPath (Join-Path $privateRoot 'data\.control-maintenance.json')) { throw 'Maintenance marker remained after uninstall.' }
  if (@(Get-ChildItem -LiteralPath (Join-Path $privateRoot 'data\uploads') -Filter '*.part' -File -ErrorAction SilentlyContinue).Count -ne 0) { throw 'A partial upload remained after uninstall.' }
  if ((Get-FileHash -LiteralPath $configPath -Algorithm SHA256).Hash -cne $configHash -or (Get-FileHash -LiteralPath $sentinelPath -Algorithm SHA256).Hash -cne $sentinelHash) { throw 'Uninstall changed private user files.' }
  if (-not (Test-Path -LiteralPath (Join-Path $installRoot ('versions\' + $originalVersion)))) { throw 'Uninstall removed retained program versions.' }
  $installed = $false
  $steps.Add('uninstall-stops-service-and-preserves-config-data-and-program-versions')
  [ordered]@{schema=1;passed=$true;releaseSha256=$expected;controlUpdateReleaseSha256=$controlUpdateExpected;originalVersion=$originalVersion;scope=$scope;cleanupVerified=$true;steps=@($steps.ToArray());completedAt=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $reportPath -Encoding UTF8
  Write-Output "Installation lifecycle fixture passed. Report: $reportPath"
} catch {
  [ordered]@{schema=1;passed=$false;releaseSha256=$expected;controlUpdateReleaseSha256=$controlUpdateExpected;scope=$scope;cleanupVerified=$false;steps=@($steps.ToArray());error=$_.Exception.Message;failedAt=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $reportPath -Encoding UTF8
  throw
} finally {
  foreach ($temporaryTask in @($bootstrapTaskName, $helperTaskName)) {
    if (-not [string]::IsNullOrWhiteSpace([string]$temporaryTask)) {
      Stop-ScheduledTask -TaskName $temporaryTask -TaskPath '\' -ErrorAction SilentlyContinue
      Unregister-ScheduledTask -TaskName $temporaryTask -TaskPath '\' -Confirm:$false -ErrorAction SilentlyContinue
    }
  }
  if ($installed) {
    try { & (Join-Path $sourceRoot 'scripts\windows\uninstall-control.ps1') -InstallRoot $installRoot -TaskName $taskName -HealthCheckTimeoutSeconds 15 -OperationDrainTimeoutSeconds 15 }
    catch { Write-Warning "Fixture cleanup needs inspection: $taskName at $root. $($_.Exception.Message)" }
  }
}
