[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3

$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$releaseScript = Join-Path $projectRoot 'scripts\release.mjs'
$nodeCommand = Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1
$node = $nodeCommand.Source
$package = Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
$fixtureRoot = [IO.Path]::GetFullPath((Join-Path $tempRoot ('dyson-control-release-' + [guid]::NewGuid().ToString('N'))))
if (-not $fixtureRoot.StartsWith($tempRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Fixture root escaped the system temporary directory: $fixtureRoot"
}

function Assert-ExactProperties([object]$Value, [string[]]$Expected, [string]$Label) {
  if ($null -eq $Value) { throw "$Label is missing." }
  $actual = @($Value.PSObject.Properties.Name)
  if ($actual.Count -ne $Expected.Count -or @(Compare-Object -ReferenceObject $Expected -DifferenceObject $actual -CaseSensitive).Count -ne 0) {
    throw "$Label contains unexpected fields."
  }
}

function New-BridgeFixture([string]$Directory) {
  New-Item -ItemType Directory -Path $Directory | Out-Null
  $dllPath = Join-Path $Directory 'DysonControlBridge.dll'
  [IO.File]::WriteAllBytes($dllPath, [byte[]]@(0x4d, 0x5a, 0x01, 0x00))
  $dll = Get-Item -LiteralPath $dllPath
  $dllHash = (Get-FileHash -LiteralPath $dllPath -Algorithm SHA256).Hash.ToLowerInvariant()
  $referenceNames = @(
    'BepInEx', 'AssemblyCSharp', 'UnityEngine', 'UnityEngineCore', 'Netstandard',
    'NebulaAPI', 'NebulaModel', 'NebulaWorld', 'WebSocketSharp'
  )
  $references = foreach ($name in $referenceNames) {
    [ordered]@{
      name = $name
      file = "references\$name.dll"
      assemblyVersion = '1.0.0.0'
      bytes = 1
      sha256 = ('0' * 64)
    }
  }
  $manifest = [ordered]@{
    schema = 1
    pluginVersion = [string]$package.version
    builtAtUtc = '2026-10-17T00:00:00.0000000+00:00'
    dll = [ordered]@{ file = 'DysonControlBridge.dll'; bytes = $dll.Length; sha256 = $dllHash }
    references = @($references)
  }
  $manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $Directory 'bridge-manifest.json') -Encoding UTF8
}

function Copy-DirectoryContents([string]$Source, [string]$Destination) {
  New-Item -ItemType Directory -Path $Destination | Out-Null
  Get-ChildItem -LiteralPath $Source -Force | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $Destination -Recurse
  }
}

function Assert-ReleaseFailure([string]$BridgeDirectory, [string]$OutputDirectory, [string]$ExpectedText) {
  $previousErrorAction = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $output = @(& $node $releaseScript --out-dir $OutputDirectory --bridge-dir $BridgeDirectory 2>&1 | ForEach-Object { $_.ToString() })
    $exitCode = $LASTEXITCODE
  }
  finally { $ErrorActionPreference = $previousErrorAction }
  if ($exitCode -eq 0) { throw "Release unexpectedly accepted invalid Bridge input at $BridgeDirectory" }
  if (($output -join "`n").IndexOf($ExpectedText, [StringComparison]::Ordinal) -lt 0) {
    throw "Release failed for the wrong reason. Expected '$ExpectedText'; received: $($output -join ' | ')"
  }
  if (Test-Path -LiteralPath $OutputDirectory) {
    $created = @(Get-ChildItem -LiteralPath $OutputDirectory -Force -ErrorAction SilentlyContinue)
    if ($created.Count -ne 0) { throw "Rejected release input created output files in $OutputDirectory" }
  }
}

function Get-HelperDefinitions([string]$ScriptPath) {
  $content = Get-Content -LiteralPath $ScriptPath -Raw -Encoding UTF8
  $cut = $content.IndexOf("`r`nAssert-TaskName `$TaskName", [StringComparison]::Ordinal)
  if ($cut -lt 0) { $cut = $content.IndexOf("`nAssert-TaskName `$TaskName", [StringComparison]::Ordinal) }
  if ($cut -lt 0) { throw "Unable to isolate helper definitions from $ScriptPath" }
  return [scriptblock]::Create($content.Substring(0, $cut))
}

function Assert-PackageReader(
  [string]$ScriptPath,
  [string]$ReleaseRoot,
  [string]$ExpectedKind,
  [bool]$ExpectBridge,
  [string]$CopyDestination
) {
  $definitions = Get-HelperDefinitions $ScriptPath
  & {
    param($Definitions, $SourceRoot, $Kind, $HasBridge, $Destination)
    . $Definitions -SourcePath $SourceRoot
    $sourcePackage = Read-SourcePackage $SourceRoot
    if ([string]$sourcePackage.DysonReleaseKind -cne $Kind) {
      throw "$ScriptPath read release kind '$($sourcePackage.DysonReleaseKind)' instead of '$Kind'."
    }
    if (($null -ne $sourcePackage.DysonBridge) -ne $HasBridge) {
      throw "$ScriptPath read an incorrect Bridge candidate state for $Kind."
    }
    Copy-Release $SourceRoot $Destination $sourcePackage
    if (-not (Test-Path -LiteralPath (Join-Path $Destination 'LICENSE') -PathType Leaf)) {
      throw "$ScriptPath did not copy the required LICENSE for $Kind."
    }
    if ((Test-Path -LiteralPath (Join-Path $Destination 'dist\bridge')) -ne $HasBridge) {
      throw "$ScriptPath copied an incorrect Bridge candidate state for $Kind."
    }
  } $definitions $ReleaseRoot $ExpectedKind $ExpectBridge $CopyDestination
}

New-Item -ItemType Directory -Path $fixtureRoot | Out-Null
try {
  $bridgeRoot = Join-Path $fixtureRoot 'bridge'
  New-BridgeFixture $bridgeRoot

  $extraBridgeRoot = Join-Path $fixtureRoot 'bridge-extra'
  Copy-DirectoryContents $bridgeRoot $extraBridgeRoot
  Set-Content -LiteralPath (Join-Path $extraBridgeRoot 'private-reference.dll') -Value 'must not ship' -Encoding ASCII
  Assert-ReleaseFailure $extraBridgeRoot (Join-Path $fixtureRoot 'extra-output') 'Bridge input must contain exactly DysonControlBridge.dll and bridge-manifest.json.'

  $tamperedBridgeRoot = Join-Path $fixtureRoot 'bridge-tampered'
  Copy-DirectoryContents $bridgeRoot $tamperedBridgeRoot
  [IO.File]::WriteAllBytes((Join-Path $tamperedBridgeRoot 'DysonControlBridge.dll'), [byte[]]@(0x4d, 0x5a, 0x02, 0x00))
  Assert-ReleaseFailure $tamperedBridgeRoot (Join-Path $fixtureRoot 'tampered-output') 'Bridge manifest does not match DysonControlBridge.dll.'

  $releaseOutput = Join-Path $fixtureRoot 'complete-output'
  New-Item -ItemType Directory -Path $releaseOutput | Out-Null
  & $node $releaseScript --out-dir $releaseOutput --bridge-dir $bridgeRoot
  if ($LASTEXITCODE -ne 0) { throw "Complete release command failed with exit code $LASTEXITCODE." }

  $archive = @(Get-ChildItem -LiteralPath $releaseOutput -Filter 'dyson-control-v*-windows.zip' -File)
  if ($archive.Count -ne 1 -or $archive[0].Name -like '*-panel-only.zip') { throw 'Expected exactly one complete release ZIP.' }
  $checksumPath = "$($archive[0].FullName).sha256"
  $expectedArchiveHash = ((Get-Content -LiteralPath $checksumPath -Raw).Trim() -split '\s+')[0]
  $actualArchiveHash = (Get-FileHash -LiteralPath $archive[0].FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualArchiveHash -cne $expectedArchiveHash) { throw 'Complete release checksum does not match the archive.' }

  $expanded = Join-Path $fixtureRoot 'complete-expanded'
  Expand-Archive -LiteralPath $archive[0].FullName -DestinationPath $expanded
  $files = @(Get-ChildItem -LiteralPath $expanded -Recurse -File | ForEach-Object {
    $_.FullName.Substring($expanded.Length + 1).Replace('\', '/')
  })
  foreach ($file in $files) {
    $allowed = $file -in @('package.json', 'package-lock.json', 'control.config.example.json', 'LICENSE', 'README.md', 'GOAL.md', 'release-manifest.json') `
      -or $file.StartsWith('dist/server/', [StringComparison]::Ordinal) `
      -or $file.StartsWith('dist/shared/', [StringComparison]::Ordinal) `
      -or $file.StartsWith('dist/web/', [StringComparison]::Ordinal) `
      -or $file -in @('dist/bridge/DysonControlBridge.dll', 'dist/bridge/bridge-manifest.json') `
      -or ($file.StartsWith('scripts/windows/', [StringComparison]::Ordinal) -and $file.EndsWith('.ps1', [StringComparison]::OrdinalIgnoreCase)) `
      -or ($file.StartsWith('docs/', [StringComparison]::Ordinal) -and $file.EndsWith('.md', [StringComparison]::OrdinalIgnoreCase))
    if (-not $allowed) { throw "Complete release allowlist audit rejected $file" }
    if ($file -match '(^|/)(node_modules|\.data|state|coverage|backups?|userdata|validation|fixtures?|tests?|temp|tmp)(/|$)' `
        -or $file -match '(^|/)control\.config\.json$' `
        -or $file -match '(\.test\.|\.spec\.|\.log$|\.sqlite3?$|\.db$|\.env(?:\.|$))') {
      throw "Complete release contains forbidden path $file"
    }
  }
  $bridgeFiles = @($files | Where-Object { $_.StartsWith('dist/bridge/', [StringComparison]::Ordinal) } | Sort-Object)
  if ($files -notcontains 'LICENSE') { throw 'Complete release is missing the required LICENSE.' }
  $expectedBridgeFiles = @('dist/bridge/bridge-manifest.json', 'dist/bridge/DysonControlBridge.dll') | Sort-Object
  if (@(Compare-Object -ReferenceObject $expectedBridgeFiles -DifferenceObject $bridgeFiles -CaseSensitive).Count -ne 0) {
    throw "Complete release contains an unexpected Bridge file set: $($bridgeFiles -join ', ')"
  }

  $releaseManifest = Get-Content -LiteralPath (Join-Path $expanded 'release-manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  Assert-ExactProperties $releaseManifest @('schema', 'product', 'packageVersion', 'kind', 'bridge') 'Release manifest'
  Assert-ExactProperties $releaseManifest.bridge @('dll', 'manifest', 'pluginVersion', 'bytes', 'sha256') 'Release Bridge identity'
  if ($releaseManifest.schema -ne 1 -or $releaseManifest.product -cne 'dyson-control' -or
      [string]$releaseManifest.packageVersion -cne [string]$package.version -or $releaseManifest.kind -cne 'complete') {
    throw 'Complete release manifest has the wrong identity.'
  }
  $packagedDll = Join-Path $expanded 'dist\bridge\DysonControlBridge.dll'
  $packagedHash = (Get-FileHash -LiteralPath $packagedDll -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($packagedHash -cne [string]$releaseManifest.bridge.sha256 -or
      (Get-Item -LiteralPath $packagedDll).Length -ne [long]$releaseManifest.bridge.bytes) {
    throw 'Complete release manifest does not bind the packaged Bridge DLL.'
  }
  if ((Get-FileHash -LiteralPath (Join-Path $expanded 'dist\bridge\bridge-manifest.json') -Algorithm SHA256).Hash -cne
      (Get-FileHash -LiteralPath (Join-Path $bridgeRoot 'bridge-manifest.json') -Algorithm SHA256).Hash) {
    throw 'Complete release changed the sanitized Bridge build manifest.'
  }

  $panelRoot = Join-Path $fixtureRoot 'panel-derived'
  Copy-DirectoryContents $expanded $panelRoot
  Remove-Item -LiteralPath (Join-Path $panelRoot 'dist\bridge') -Recurse -Force
  $panelManifest = [ordered]@{
    schema = 1
    product = 'dyson-control'
    packageVersion = [string]$package.version
    kind = 'panel-only'
    bridge = $null
  }
  $panelManifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $panelRoot 'release-manifest.json') -Encoding UTF8

  $scriptNames = @('install-control.ps1', 'upgrade-control.ps1')
  foreach ($scriptName in $scriptNames) {
    $scriptPath = Join-Path $projectRoot "scripts\windows\$scriptName"
    $scriptSlug = [IO.Path]::GetFileNameWithoutExtension($scriptName)
    Assert-PackageReader $scriptPath $expanded 'complete' $true (Join-Path $fixtureRoot "$scriptSlug-complete-copy")
    Assert-PackageReader $scriptPath $panelRoot 'panel-only' $false (Join-Path $fixtureRoot "$scriptSlug-panel-copy")
  }

  Write-Output 'Release fixture passed: complete allowlist/hash, invalid Bridge rejection, and complete/panel-only installer reads.'
}
finally {
  $resolvedFixture = [IO.Path]::GetFullPath($fixtureRoot)
  if (-not $resolvedFixture.StartsWith($tempRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to clean fixture outside the system temporary directory: $resolvedFixture"
  }
  if (Test-Path -LiteralPath $resolvedFixture) { Remove-Item -LiteralPath $resolvedFixture -Recurse -Force }
}
