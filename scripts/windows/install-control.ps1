[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$SourcePath,
  [string]$InstallRoot = (Join-Path $env:ProgramFiles 'Dyson Control'),
  [string]$ConfigPath = (Join-Path $env:ProgramData 'Dyson Control\control.config.json'),
  [string]$TaskName = 'Dyson-Control',
  [string]$NodePath = '',
  [string]$NpmPath = '',
  [ValidateRange(5, 300)][int]$HealthCheckTimeoutSeconds = 30,
  [switch]$AllowNonLoopback
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3
$managedDescription = 'Dyson Control managed startup task.'

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

function Assert-InstallRoot([string]$Root) {
  if (Test-Path -LiteralPath $Root) {
    $item = Get-Item -LiteralPath $Root -Force
    if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "InstallRoot must be a plain directory: $Root" }
    return
  }
  $parent = Split-Path -Parent $Root
  $parentItem = Get-Item -LiteralPath $parent -Force -ErrorAction Stop
  if (-not $parentItem.PSIsContainer -or ($parentItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "InstallRoot parent must be a plain directory: $parent" }
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
    throw 'Run this installer from an elevated Windows PowerShell session.'
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
    'scripts\windows\configure-game.ps1'
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

function Get-ReleaseFingerprint([string]$Root) {
  $files = @()
  foreach ($relativePath in @('package.json', 'package-lock.json', 'control.config.example.json', 'release-manifest.json', 'LICENSE', 'README.md', 'GOAL.md')) {
    $candidate = Join-Path $Root $relativePath
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { $files += Get-Item -LiteralPath $candidate -Force }
  }
  foreach ($relativePath in @('dist\server', 'dist\shared', 'dist\web', 'dist\bridge', 'docs', 'scripts\windows')) {
    $directory = Join-Path $Root $relativePath
    if (Test-Path -LiteralPath $directory -PathType Container) {
      $files += Get-ChildItem -LiteralPath $directory -Recurse -Force -File
    }
  }
  $records = foreach ($file in $files | Sort-Object FullName) {
    if ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Release input contains a reparse point: $($file.FullName)" }
    $relative = $file.FullName.Substring($Root.Length).TrimStart('\').Replace('\', '/')
    $digest = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    "$relative`:$digest"
  }
  $bytes = [Text.Encoding]::UTF8.GetBytes(($records -join "`n"))
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant() }
  finally { $sha.Dispose() }
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

function Write-StagingMarker([string]$Root, [string]$InstallRootPath, [string]$Version, [string]$Fingerprint) {
  $marker = [ordered]@{
    schema = 1; product = 'dyson-control-install-staging'; installRoot = $InstallRootPath;
    version = $Version; sourceFingerprint = $Fingerprint; createdAt = [DateTime]::UtcNow.ToString('o')
  }
  [IO.File]::WriteAllText(
    (Join-Path $Root '.installing.json'),
    (($marker | ConvertTo-Json) + [Environment]::NewLine),
    [Text.UTF8Encoding]::new($false)
  )
}

function Remove-AbandonedVersionRoot(
  [string]$Root,
  [string]$InstallRootPath,
  [string]$Version,
  [string]$Fingerprint,
  [string]$NodeExecutable
) {
  $item = Get-Item -LiteralPath $Root -Force -ErrorAction Stop
  if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "Version path is not a plain directory: $Root" }
  $markerPath = Get-ExistingFile (Join-Path $Root '.installing.json') 'Abandoned install marker'
  $marker = Get-Content -LiteralPath $markerPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($marker.schema -ne 1 -or $marker.product -cne 'dyson-control-install-staging' -or
      (Get-FullPath ([string]$marker.installRoot)) -ne $InstallRootPath -or [string]$marker.version -cne $Version -or
      [string]$marker.sourceFingerprint -cne $Fingerprint) {
    throw "Version directory already exists and is not a matching abandoned install: $Root"
  }
  $expectedIndex = Get-FullPath (Join-Path $Root 'dist\server\index.js')
  $nodeName = [IO.Path]::GetFileName($NodeExecutable).Replace("'", "''")
  $processes = Get-CimInstance Win32_Process -Filter "Name = '$nodeName'" -ErrorAction Stop | Where-Object {
    -not [string]::IsNullOrWhiteSpace([string]$_.CommandLine) -and
    ([string]$_.CommandLine).IndexOf($expectedIndex, [StringComparison]::OrdinalIgnoreCase) -ge 0
  }
  if ($processes) { throw "Abandoned version directory is still in use by process $(@($processes)[0].ProcessId): $Root" }
  Remove-Item -LiteralPath $Root -Recurse -Force
}

function Write-InstallState([string]$Path, [object]$State) {
  $temporary = "$Path.partial-$([guid]::NewGuid().ToString('N'))"
  [IO.File]::WriteAllText($temporary, (($State | ConvertTo-Json -Depth 5) + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $temporary -Destination $Path
}

Assert-TaskName $TaskName
$sourceRoot = Get-ExistingDirectory $SourcePath 'SourcePath'
$installRootPath = Get-FullPath $InstallRoot
Assert-InstallRoot $installRootPath
$versionsRoot = Join-Path $installRootPath 'versions'
$statePath = Join-Path $installRootPath 'install-state.json'
if (Test-Path -LiteralPath $statePath) { throw 'Dyson Control is already installed at this InstallRoot; use upgrade-control.ps1.' }
$package = Read-SourcePackage $sourceRoot
$versionRoot = Join-Path $versionsRoot ([string]$package.version)
$configInfo = Read-ConfigPreflight $ConfigPath $versionsRoot $AllowNonLoopback.IsPresent
$nodeExecutable = Resolve-Executable $NodePath 'node.exe' 'NodePath'
Assert-Node24 $nodeExecutable
if ([string]::IsNullOrWhiteSpace($NpmPath)) {
  $besideNode = Join-Path (Split-Path -Parent $nodeExecutable) 'npm.cmd'
  if (Test-Path -LiteralPath $besideNode -PathType Leaf) { $NpmPath = $besideNode }
}
$npmExecutable = Resolve-Executable $NpmPath 'npm.cmd' 'NpmPath'
Assert-Administrator

$existingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue | Where-Object { $_.TaskName -ceq $TaskName -and $_.TaskPath -eq '\' } | Select-Object -First 1
if ($null -ne $existingTask) { throw "The exact scheduled task already exists: $TaskName" }
$sourceFingerprint = Get-ReleaseFingerprint $sourceRoot
if (Test-Path -LiteralPath $versionRoot) {
  Remove-AbandonedVersionRoot $versionRoot $installRootPath ([string]$package.version) $sourceFingerprint $nodeExecutable
}
$preexistingHealth = Get-ControlHealth (Get-HealthHost $configInfo.Host) $configInfo.Port
if ($null -ne $preexistingHealth) {
  throw "A Dyson Control process is already listening at $($preexistingHealth.Uri) (version $($preexistingHealth.Version), PID $($preexistingHealth.ProcessId))."
}

New-Item -ItemType Directory -Path $versionsRoot -Force | Out-Null
New-Item -ItemType Directory -Path $configInfo.DataDirectory -Force | Out-Null
$stageRoot = Join-Path $versionsRoot ('.install-' + [string]$package.version + '-' + [guid]::NewGuid().ToString('N'))
$registered = $false
$versionRootCreated = $false
$health = $null
try {
  Copy-Release $sourceRoot $stageRoot $package
  Install-ProductionDependencies $stageRoot $npmExecutable
  Assert-RuntimeConfig $stageRoot $nodeExecutable $configInfo.Path
  Write-StagingMarker $stageRoot $installRootPath ([string]$package.version) $sourceFingerprint
  Move-Item -LiteralPath $stageRoot -Destination $versionRoot
  $stageRoot = $null
  $versionRootCreated = $true
  $launcherPath = Write-Launcher $versionRoot $nodeExecutable $configInfo.Path $configInfo.DataDirectory

  $powerShellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $actionArguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}"' -f $launcherPath.Replace('"', '""')
  $action = New-ScheduledTaskAction -Execute $powerShellPath -Argument $actionArguments -WorkingDirectory $versionRoot
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
  $definition = New-ScheduledTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description $managedDescription
  Register-ScheduledTask -TaskName $TaskName -TaskPath '\' -InputObject $definition | Out-Null
  $registered = $true
  Start-ScheduledTask -TaskName $TaskName -TaskPath '\'
  $health = Wait-ControlHealth (Get-HealthHost $configInfo.Host) $configInfo.Port $HealthCheckTimeoutSeconds ([string]$package.version) $versionRoot $nodeExecutable

  $now = [DateTime]::UtcNow.ToString('o')
  $state = [ordered]@{
    schema = 1; product = 'dyson-control'; taskName = $TaskName; taskPath = '\';
    installRoot = $installRootPath; configPath = $configInfo.Path; dataDirectory = $configInfo.DataDirectory;
    nodePath = $nodeExecutable; npmPath = $npmExecutable; activeVersion = [string]$package.version;
    releaseKind = [string]$package.DysonReleaseKind; bridgeCandidate = $package.DysonBridge;
    createdAt = $now; updatedAt = $now
  }
  Write-InstallState $statePath $state
  Remove-Item -LiteralPath (Join-Path $versionRoot '.installing.json') -Force
  Write-Output "Installed Dyson Control $($package.version)."
  Write-Output "Task: \$TaskName"
  Write-Output "Health: $($health.Uri) (PID $($health.ProcessId))"
  if ([string]$package.DysonReleaseKind -ceq 'complete') {
    Write-Output "Release: complete; Bridge candidate retained at $versionRoot\dist\bridge (SHA-256 $($package.DysonBridge.Sha256))."
  }
  else {
    Write-Output 'Release: panel-only; no game Bridge was included or changed.'
  }
  Write-Output "Config and data preserved outside version directory: $($configInfo.Path), $($configInfo.DataDirectory)"
}
catch {
  $installError = $_
  if ($registered) {
    if ($null -eq $health) {
      $candidateHealth = Get-ControlHealth (Get-HealthHost $configInfo.Host) $configInfo.Port
      if ($null -ne $candidateHealth -and $candidateHealth.Version -ceq [string]$package.version -and
          (Test-ControlProcessIdentity $candidateHealth.ProcessId $versionRoot $nodeExecutable)) { $health = $candidateHealth }
    }
    Stop-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction SilentlyContinue
    if ($null -ne $health) { Wait-ControlProcessExit $health.ProcessId $HealthCheckTimeoutSeconds }
    Unregister-ScheduledTask -TaskName $TaskName -TaskPath '\' -Confirm:$false -ErrorAction SilentlyContinue
  }
  if ($versionRootCreated -and -not (Test-Path -LiteralPath $statePath)) {
    try { Remove-AbandonedVersionRoot $versionRoot $installRootPath ([string]$package.version) $sourceFingerprint $nodeExecutable }
    catch {
      throw "Installation failed and the inactive version directory could not be cleaned for retry. Install error: $($installError.Exception.Message) Cleanup error: $($_.Exception.Message)"
    }
  }
  throw $installError
}
finally {
  if ($null -ne $stageRoot -and (Test-Path -LiteralPath $stageRoot)) { Remove-Item -LiteralPath $stageRoot -Recurse -Force }
}
