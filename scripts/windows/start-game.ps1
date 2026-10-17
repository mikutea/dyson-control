[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$GameRoot,
  [Parameter(Mandatory = $true)][string]$SaveDirectory,
  [Parameter(Mandatory = $true)][string]$SettingsPath,
  [Parameter(Mandatory = $true)][string]$LogFile,
  [ValidateSet('Normal', 'AboveNormal')][string]$ProcessPriority = 'AboveNormal'
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'path-policy.ps1')
$gameRootPath = [IO.Path]::GetFullPath($GameRoot)
$saveDirectoryPath = [IO.Path]::GetFullPath($SaveDirectory)
$settingsFile = [IO.Path]::GetFullPath($SettingsPath)
$logPath = [IO.Path]::GetFullPath($LogFile)
$gameExe = [IO.Path]::GetFullPath((Join-Path $gameRootPath 'DSPGAME.exe'))
$canonicalGameExe = ConvertTo-DysonCanonicalPath $gameExe

foreach ($requiredFile in @($gameExe, $settingsFile)) {
  $item = Get-Item -LiteralPath $requiredFile -Force -ErrorAction Stop
  if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "Required plain file is invalid: $requiredFile" }
}
$saveDirectoryItem = Get-Item -LiteralPath $saveDirectoryPath -Force -ErrorAction Stop
if (-not $saveDirectoryItem.PSIsContainer -or ($saveDirectoryItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "Save directory is invalid: $saveDirectoryPath" }

$dataDirectoryPath = [IO.Path]::GetFullPath((Split-Path -Parent $settingsFile))
[void](Get-DysonApprovedPathInfo $dataDirectoryPath 'Dyson Control data directory' $false $true)
$savePathInfo = Get-DysonApprovedPathInfo $saveDirectoryPath 'Save directory' $true $false
$unfinishedRestorePath = Join-Path $dataDirectoryPath 'save-restore\active'
if ($null -ne (Get-Item -LiteralPath $unfinishedRestorePath -Force -ErrorAction SilentlyContinue)) {
  throw "An unfinished save restore transaction requires recovery before the game can start: $unfinishedRestorePath"
}

$settingsItem = Get-Item -LiteralPath $settingsFile -Force
if ($settingsItem.Length -lt 2 -or $settingsItem.Length -gt 4096) { throw 'Startup settings file size is invalid.' }
$settings = Get-Content -LiteralPath $settingsFile -Raw -Encoding UTF8 | ConvertFrom-Json
$propertyNames = @($settings.PSObject.Properties.Name | Sort-Object)
if (($propertyNames -join ',') -ne 'saveName,schema,targetUps' -or $settings.schema -ne 1) { throw 'Startup settings schema is invalid.' }
if ($settings.targetUps -isnot [int] -and $settings.targetUps -isnot [long]) { throw 'targetUps must be an integer.' }
$targetUps = [int]$settings.targetUps
if ($targetUps -lt 10 -or $targetUps -gt 240) { throw 'targetUps is outside the supported range.' }

$saveName = $null
if ($null -ne $settings.saveName) {
  $saveName = [string]$settings.saveName
  if ([string]::IsNullOrWhiteSpace($saveName) -or $saveName -in @('.', '..') -or $saveName.Length -gt 120 -or $saveName -match '[\\/:*?"<>|\x00-\x1f]') { throw 'saveName is invalid.' }
  foreach ($extension in @('.dsv', '.server')) {
    $member = Join-Path $saveDirectoryPath ($saveName + $extension)
    $item = Get-Item -LiteralPath $member -Force -ErrorAction Stop
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "Selected save member is invalid: $member" }
  }
  $optionalMember = Join-Path $saveDirectoryPath ($saveName + '.moddsv')
  if (Test-Path -LiteralPath $optionalMember) {
    $item = Get-Item -LiteralPath $optionalMember -Force -ErrorAction Stop
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "Selected save member is invalid: $optionalMember" }
  }
}

$runningGame = Get-CimInstance Win32_Process -Filter "Name = 'DSPGAME.exe'" | Where-Object {
  if ($null -eq $_.ExecutablePath) { return $false }
  try { return (ConvertTo-DysonCanonicalPath ([string]$_.ExecutablePath)).Equals($canonicalGameExe, [StringComparison]::OrdinalIgnoreCase) }
  catch { return $false }
} | Select-Object -First 1
if ($runningGame) { throw "The managed DSPGAME.exe is already running with PID $($runningGame.ProcessId)." }

# DSP does not expose a save-folder command-line option. The shipped GameConfig
# reads Configs/path.txt as its document root and then appends
# "Dyson Sphere Program/Save". Keep that private document root on the local NTFS
# data volume. Existing game data stays in place behind one exact directory link.
$configsPath = Join-Path $gameRootPath 'Configs'
if (-not (Test-Path -LiteralPath $configsPath)) { New-Item -ItemType Directory -Path $configsPath | Out-Null }
$configsItem = Get-Item -LiteralPath $configsPath -Force -ErrorAction Stop
if (-not $configsItem.PSIsContainer -or ($configsItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "Game Configs directory is invalid: $configsPath" }
$documentRootPath = [IO.Path]::GetFullPath((Join-Path $dataDirectoryPath 'dyson-control-documents'))
if (-not (Test-Path -LiteralPath $documentRootPath)) { New-Item -ItemType Directory -Path $documentRootPath | Out-Null }
$documentRootItem = Get-Item -LiteralPath $documentRootPath -Force -ErrorAction Stop
if (-not $documentRootItem.PSIsContainer -or ($documentRootItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "Dyson Control document root is invalid: $documentRootPath" }

function Assert-ExactDirectoryLink([string]$LinkPath, [string]$ExpectedTarget, [string]$ExpectedLinkType) {
  $item = Get-Item -LiteralPath $LinkPath -Force -ErrorAction Stop
  if (-not $item.PSIsContainer -or -not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
      -not ([string]$item.LinkType).Equals($ExpectedLinkType, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Managed game-data path is not the required $ExpectedLinkType directory link: $LinkPath"
  }
  $targets = @($item.Target)
  if ($targets.Count -ne 1 -or [string]::IsNullOrWhiteSpace([string]$targets[0])) { throw "Managed game-data link target is invalid: $LinkPath" }
  $target = [string]$targets[0]
  if (-not [IO.Path]::IsPathRooted($target)) { $target = Join-Path (Split-Path -Parent $LinkPath) $target }
  if (-not (Test-DysonPathEquals $target $ExpectedTarget)) {
    throw "Managed game-data link points to '$target', but '$ExpectedTarget' is required."
  }
}

function Ensure-ExactDirectoryLink([string]$LinkPath, [string]$ExpectedTarget, [string]$LinkType) {
  if (Test-Path -LiteralPath $LinkPath) {
    Assert-ExactDirectoryLink $LinkPath $ExpectedTarget $LinkType
    return
  }
  New-Item -ItemType $LinkType -Path $LinkPath -Target $ExpectedTarget | Out-Null
  Assert-ExactDirectoryLink $LinkPath $ExpectedTarget $LinkType
}

$managedGameDocumentPath = Join-Path $documentRootPath 'Dyson Sphere Program'
$managedSavePath = [IO.Path]::GetFullPath((Join-Path $managedGameDocumentPath 'Save'))
if (Test-DysonPathEquals $saveDirectoryPath $managedSavePath) {
  $managedGameDocumentItem = Get-Item -LiteralPath $managedGameDocumentPath -Force -ErrorAction Stop
  if (-not $managedGameDocumentItem.PSIsContainer -or ($managedGameDocumentItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw "Managed game document directory is invalid: $managedGameDocumentPath"
  }
}
elseif ($saveDirectoryItem.Name.Equals('Save', [StringComparison]::OrdinalIgnoreCase) -and $null -ne $saveDirectoryItem.Parent) {
  # Preserve the established userdata boundary (Save plus options, player key,
  # achievements, blueprints and properties) when it has the normal layout.
  $gameDocumentDirectory = Get-Item -LiteralPath $saveDirectoryItem.Parent.FullName -Force -ErrorAction Stop
  if (-not $gameDocumentDirectory.PSIsContainer -or ($gameDocumentDirectory.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw "Configured game document directory is invalid: $($gameDocumentDirectory.FullName)"
  }
  $gameDocumentInfo = Get-DysonApprovedPathInfo ([IO.Path]::GetFullPath($gameDocumentDirectory.FullName)) 'Configured game document directory' $true $false
  $gameDocumentTarget = if ($gameDocumentInfo.Kind -eq 'smb-global') { ConvertTo-DysonCanonicalPath $gameDocumentInfo.Path } else { $gameDocumentInfo.Path }
  $gameDocumentLinkType = if ($gameDocumentInfo.Kind -eq 'smb-global') { 'SymbolicLink' } else { 'Junction' }
  Ensure-ExactDirectoryLink $managedGameDocumentPath $gameDocumentTarget $gameDocumentLinkType
}
else {
  if (-not (Test-Path -LiteralPath $managedGameDocumentPath)) { New-Item -ItemType Directory -Path $managedGameDocumentPath | Out-Null }
  $managedGameDocumentItem = Get-Item -LiteralPath $managedGameDocumentPath -Force -ErrorAction Stop
  if (-not $managedGameDocumentItem.PSIsContainer -or ($managedGameDocumentItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw "Managed game document directory is invalid: $managedGameDocumentPath"
  }
  $saveTarget = if ($savePathInfo.Kind -eq 'smb-global') { ConvertTo-DysonCanonicalPath $savePathInfo.Path } else { $savePathInfo.Path }
  $saveLinkType = if ($savePathInfo.Kind -eq 'smb-global') { 'SymbolicLink' } else { 'Junction' }
  Ensure-ExactDirectoryLink (Join-Path $managedGameDocumentPath 'Save') $saveTarget $saveLinkType
}

$documentPathFile = Join-Path $configsPath 'path.txt'
$documentPathItem = Get-Item -LiteralPath $documentPathFile -Force -ErrorAction SilentlyContinue
if ($null -ne $documentPathItem -and ($documentPathItem.PSIsContainer -or ($documentPathItem.Attributes -band [IO.FileAttributes]::ReparsePoint))) {
  throw "DSP document-root file is invalid: $documentPathFile"
}
if ($null -ne $documentPathItem -and $documentPathItem.Length -gt 4096) { throw "DSP document-root file is too large: $documentPathFile" }
$documentPathBackup = "$documentPathFile.dyson-control.original"
$documentPathAbsentMarker = "$documentPathBackup.absent"
$backupItem = Get-Item -LiteralPath $documentPathBackup -Force -ErrorAction SilentlyContinue
$absentItem = Get-Item -LiteralPath $documentPathAbsentMarker -Force -ErrorAction SilentlyContinue
if ($null -ne $backupItem -and $null -ne $absentItem) { throw 'DSP path.txt backup state is ambiguous.' }
foreach ($item in @($backupItem, $absentItem)) {
  if ($null -ne $item -and ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint))) { throw "DSP path.txt backup is invalid: $($item.FullName)" }
  if ($null -ne $item -and $item.Length -gt 4096) { throw "DSP path.txt backup is too large: $($item.FullName)" }
}
if ($null -ne $absentItem -and (Get-Content -LiteralPath $documentPathAbsentMarker -Raw -Encoding UTF8) -cne 'DYSON_CONTROL_PATH_WAS_ABSENT_V1') {
  throw "DSP path.txt absence marker is invalid: $documentPathAbsentMarker"
}
$firstBinding = $null -eq $backupItem -and $null -eq $absentItem
if ($firstBinding) {
  if ($null -ne $documentPathItem) {
    $temporaryBackup = Join-Path $configsPath ('.path.txt.dyson-control-backup-' + [Guid]::NewGuid().ToString('N') + '.tmp')
    try {
      [IO.File]::WriteAllBytes($temporaryBackup, [IO.File]::ReadAllBytes($documentPathFile))
      Move-Item -LiteralPath $temporaryBackup -Destination $documentPathBackup
    }
    finally { if (Test-Path -LiteralPath $temporaryBackup) { Remove-Item -LiteralPath $temporaryBackup -Force } }
  }
  else {
    [IO.File]::WriteAllText($documentPathAbsentMarker, 'DYSON_CONTROL_PATH_WAS_ABSENT_V1', [Text.UTF8Encoding]::new($false))
  }
}

[string]$configuredDocumentRoot = ''
if ($null -ne $documentPathItem) {
  $rawConfiguredDocumentRoot = Get-Content -LiteralPath $documentPathFile -Raw -Encoding UTF8
  if ($null -ne $rawConfiguredDocumentRoot) { $configuredDocumentRoot = ([string]$rawConfiguredDocumentRoot).Trim() }
}
$bindingMatches = $false
if (-not [string]::IsNullOrWhiteSpace($configuredDocumentRoot)) {
  $bindingMatches = Test-DysonPathEquals $configuredDocumentRoot $documentRootPath
}
if (-not $bindingMatches) {
  $legacyDocumentRootPath = [IO.Path]::GetFullPath((Join-Path $configsPath 'dyson-control-documents'))
  $legacyBindingMatches = -not [string]::IsNullOrWhiteSpace($configuredDocumentRoot) -and (Test-DysonPathEquals $configuredDocumentRoot $legacyDocumentRootPath)
  if (-not $firstBinding -and -not $legacyBindingMatches) { throw "DSP Configs/path.txt changed after Dyson Control bound it. Restore the managed binding or perform an explicit recovery." }
  $temporaryPathFile = Join-Path $configsPath ('.path.txt.dyson-control-' + [Guid]::NewGuid().ToString('N') + '.tmp')
  try {
    [IO.File]::WriteAllText($temporaryPathFile, $documentRootPath, [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporaryPathFile -Destination $documentPathFile -Force
  }
  finally {
    if (Test-Path -LiteralPath $temporaryPathFile) { Remove-Item -LiteralPath $temporaryPathFile -Force }
  }
}

New-Item -ItemType Directory -Path (Split-Path -Parent $logPath) -Force | Out-Null
$arguments = @('-batchmode', '-nographics', '-nebula-server', '-ups', [string]$targetUps, '-logFile', $logPath)
if ($null -eq $saveName) { $arguments += '-load-latest' } else { $arguments += @('-load', $saveName) }
$quotedArguments = foreach ($argument in $arguments) {
  if ([string]$argument -match '"') { throw "Unsupported double quote in process argument: $argument" }
  '"{0}"' -f [string]$argument
}

$startInfo = [Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = $gameExe
$startInfo.Arguments = $quotedArguments -join ' '
$startInfo.WorkingDirectory = $gameRootPath
$startInfo.UseShellExecute = $false
$startInfo.CreateNoWindow = $true
$process = [Diagnostics.Process]::Start($startInfo)
if (-not $process) { throw 'DSPGAME.exe did not return a process handle.' }
try {
  $process.PriorityClass = [Diagnostics.ProcessPriorityClass]::$ProcessPriority
  $process.WaitForExit()
  if ($process.ExitCode -ne 0) { throw "DSPGAME.exe exited with code $($process.ExitCode). Review $logPath" }
}
catch {
  if (-not $process.HasExited) { $process.Kill(); $process.WaitForExit() }
  throw
}
