param([Parameter(Mandatory = $true)][string]$ArgumentsPath)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$argsObject = Get-Content -LiteralPath $ArgumentsPath -Raw -Encoding UTF8 | ConvertFrom-Json
$outputPath = [IO.Path]::GetFullPath([string]$argsObject.outputPath)
if (Test-Path -LiteralPath $outputPath) { throw 'Archive output already exists.' }
$parent = Split-Path -Parent $outputPath
if (-not (Test-Path -LiteralPath $parent -PathType Container)) { throw 'Archive output directory does not exist.' }

$stream = [IO.File]::Open($outputPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
try {
  $archive = New-Object IO.Compression.ZipArchive($stream, [IO.Compression.ZipArchiveMode]::Create, $false)
  try {
    foreach ($item in @($argsObject.entries)) {
      $sourcePath = [IO.Path]::GetFullPath([string]$item.sourcePath)
      $entryName = ([string]$item.entryName).Replace('\', '/')
      if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) { throw "Archive source is missing: $sourcePath" }
      if ([string]::IsNullOrWhiteSpace($entryName) -or $entryName.StartsWith('/') -or $entryName.Contains('../') -or $entryName.IndexOf([char]0) -ge 0) { throw 'Archive entry name is invalid.' }
      $entry = $archive.CreateEntry($entryName, [IO.Compression.CompressionLevel]::Optimal)
      $source = [IO.File]::OpenRead($sourcePath)
      try {
        $destination = $entry.Open()
        try { $source.CopyTo($destination) } finally { $destination.Dispose() }
      } finally { $source.Dispose() }
    }
  } finally { $archive.Dispose() }
} catch {
  $stream.Dispose()
  Remove-Item -LiteralPath $outputPath -Force -ErrorAction SilentlyContinue
  throw
} finally {
  if ($null -ne $stream) { $stream.Dispose() }
}
[ordered]@{ outputPath = $outputPath; bytes = (Get-Item -LiteralPath $outputPath).Length } | ConvertTo-Json -Compress
