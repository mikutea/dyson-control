param([string]$NodePath = (Get-Command node.exe).Source)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
$fixture = [IO.Path]::GetFullPath((Join-Path $tempRoot ('dyson-runtime-check-' + [guid]::NewGuid().ToString('N'))))
if (-not $fixture.StartsWith($tempRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Runtime fixture escaped the temporary directory.' }
$utf8 = [Text.UTF8Encoding]::new($false)
$previousNodeWarnings = $env:NODE_NO_WARNINGS
New-Item -ItemType Directory -Path (Join-Path $fixture 'node_modules') | Out-Null
try {
  Copy-Item -LiteralPath (Join-Path $projectRoot 'dist\server\runtime-check.js') -Destination $fixture
  Copy-Item -LiteralPath (Join-Path $projectRoot 'node_modules\node-pty') -Destination (Join-Path $fixture 'node_modules') -Recurse
  [IO.File]::WriteAllText((Join-Path $fixture 'package.json'), '{"type":"module"}', $utf8)
  $check = Join-Path $fixture 'runtime-check.js'
  # Native add-ons are loaded only inside the disposable child process.
  $env:NODE_NO_WARNINGS = '1'
  $output = @(& $NodePath $check)
  if ($LASTEXITCODE -ne 0 -or ($output -join '').Trim() -cne 'DYSON_RUNTIME_OK') { throw 'The valid native runtime did not pass.' }
  $prebuilds = Join-Path $fixture 'node_modules\node-pty\prebuilds'
  Rename-Item -LiteralPath $prebuilds -NewName 'prebuilds-disabled'
  $output = @(& $NodePath $check)
  if ($LASTEXITCODE -eq 0 -or ($output -join '').Trim() -cne 'DYSON_RUNTIME_FAILED') { throw 'Missing native binaries were not rejected.' }
  Rename-Item -LiteralPath (Join-Path $fixture 'node_modules\node-pty') -NewName 'node-pty-disabled'
  $output = @(& $NodePath $check)
  if ($LASTEXITCODE -eq 0 -or ($output -join '').Trim() -cne 'DYSON_RUNTIME_FAILED') { throw 'Missing native dependency was not rejected.' }
  Write-Output 'RUNTIME_CHECK_FIXTURE_OK: working native console, missing binary and missing dependency'
} finally {
  if ($null -eq $previousNodeWarnings) { Remove-Item Env:\NODE_NO_WARNINGS -ErrorAction SilentlyContinue }
  else { $env:NODE_NO_WARNINGS = $previousNodeWarnings }
  $resolved = [IO.Path]::GetFullPath($fixture)
  if (-not $resolved.StartsWith($tempRoot + '\', [StringComparison]::OrdinalIgnoreCase) -or (Split-Path -Leaf $resolved) -notlike 'dyson-runtime-check-*') { throw 'Runtime fixture cleanup escaped the temporary directory.' }
  Remove-Item -LiteralPath $resolved -Recurse -Force
}
