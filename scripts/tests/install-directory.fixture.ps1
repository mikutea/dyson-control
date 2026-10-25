<# Exercises real long-path cleanup and preservation of files outside the exact install directory. #>
[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$NodePath)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$helper = Join-Path $PSScriptRoot '..\windows\remove-install-directory.ps1'
$node = (Resolve-Path -LiteralPath $NodePath).Path
$temporary = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
$root = Join-Path $temporary ('dyson-directory-fixture-' + [guid]::NewGuid().ToString('N'))
$versions = Join-Path $root 'versions'
$stageName = '.install-0.0.0-fixture-' + [guid]::NewGuid().ToString('N')
$stage = Join-Path $versions $stageName
$keep = Join-Path $root 'preserve'
$setup = @'
const fs=require('node:fs'),path=require('node:path');const [root,versions,stage,keep]=process.argv.slice(1);
if(fs.existsSync(root))throw Error('Fixture root already exists.');
fs.mkdirSync(versions,{recursive:true});fs.mkdirSync(keep);fs.writeFileSync(path.join(keep,'sentinel.txt'),'must be preserved');
const leaf=path.join(stage,'node_modules','deep-'+ 'x'.repeat(100),'nested-'+ 'x'.repeat(100),'sentinel.txt');
if(leaf.length<=300)throw Error('Fixture must exercise a path beyond 300 characters.');
fs.mkdirSync(path.dirname(leaf),{recursive:true});fs.writeFileSync(leaf,'remove only this tree');
console.log(leaf.length);
'@
$longest = & $node -e $setup $root $versions $stage $keep
if ($LASTEXITCODE -ne 0) { throw 'Unable to create long-path cleanup fixture.' }
$checks = [Collections.Generic.List[string]]::new()
function Assert-Preserved {
  & $node -e "const fs=require('node:fs'),p=require('node:path');if(fs.readFileSync(p.join(process.argv[1],'sentinel.txt'),'utf8')!=='must be preserved')throw Error('Outside file changed');" $keep
  if ($LASTEXITCODE -ne 0) { throw 'An outside fixture file changed.' }
}
function Assert-Rejected([string]$Target, [string]$Parent, [string]$ExpectedMessage) {
  $failure = $null
  try { & $helper -Directory $Target -VersionsRoot $Parent -NodePath $node }
  catch { $failure = $_.Exception.Message }
  if ([string]::IsNullOrWhiteSpace($failure) -or -not $failure.Contains($ExpectedMessage)) { throw "Expected scoped rejection was not observed: $ExpectedMessage" }
  Assert-Preserved
}
try {
  & $helper -Directory $stage -VersionsRoot $versions -NodePath $node
  if (Test-Path -LiteralPath $stage) { throw 'The long dependency tree remains.' }
  Assert-Preserved
  $checks.Add('removes-over-300-character-dependencies-and-preserves-sibling-data')

  Assert-Rejected $keep $versions 'one direct child'
  Assert-Rejected $versions $versions 'one direct child'
  $checks.Add('rejects-outside-path-and-versions-root')

  $wrongName = Join-Path $versions ('xinstall-0.0.0-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $wrongName | Out-Null
  Assert-Rejected $wrongName $versions 'directory name is invalid'
  $checks.Add('rejects-non-owned-directory-name')

  & $node -e "require('node:fs').symlinkSync(process.argv[1],process.argv[2],'junction')" $keep $stage
  if ($LASTEXITCODE -ne 0) { throw 'Unable to create target junction fixture.' }
  Assert-Rejected $stage $versions 'plain directory'
  & $node -e "require('node:fs').unlinkSync(process.argv[1])" $stage
  if ($LASTEXITCODE -ne 0) { throw 'Unable to unlink fixture junction.' }
  $checks.Add('rejects-target-junction-without-touching-referent')

  $linked = Join-Path $root 'linked'
  $physical = Join-Path $root 'physical'
  & $node -e "const fs=require('node:fs'),p=require('node:path');fs.mkdirSync(p.join(process.argv[1],'versions',process.argv[3]),{recursive:true});fs.symlinkSync(process.argv[1],process.argv[2],'junction');" $physical $linked $stageName
  if ($LASTEXITCODE -ne 0) { throw 'Unable to create parent junction fixture.' }
  Assert-Rejected (Join-Path $linked ('versions\' + $stageName)) (Join-Path $linked 'versions') 'parent must not traverse'
  if (-not (Test-Path -LiteralPath (Join-Path $physical ('versions\' + $stageName)))) { throw 'Linked parent referent was removed.' }
  $checks.Add('rejects-linked-ancestor')

  & $node -e "const fs=require('node:fs'),p=require('node:path');fs.mkdirSync(process.argv[1]);fs.symlinkSync(process.argv[2],p.join(process.argv[1],'outside-link'),'junction');" $stage $keep
  if ($LASTEXITCODE -ne 0) { throw 'Unable to create nested junction fixture.' }
  & $helper -Directory $stage -VersionsRoot $versions -NodePath $node
  if (Test-Path -LiteralPath $stage) { throw 'Nested-link stage remains.' }
  Assert-Preserved
  $checks.Add('removes-nested-junction-without-following-it')

  [ordered]@{passed=$true;maximumPathCharacters=[int]$longest;checks=@($checks.ToArray())} | ConvertTo-Json -Depth 4
} finally {
  # Resolve and bound the explicit fixture path inside Node before recursive deletion.
  & $node -e "const fs=require('node:fs'),p=require('node:path');const base=p.resolve(process.argv[1]),target=p.resolve(process.argv[2]);if(p.dirname(target).toLowerCase()!==base.toLowerCase()||!/^dyson-directory-fixture-[a-f0-9]{32}$/.test(p.basename(target))||fs.lstatSync(target).isSymbolicLink())throw Error('Unsafe fixture cleanup');fs.rmSync(target,{recursive:true});" $temporary $root
  if ($LASTEXITCODE -ne 0) { throw 'Scoped fixture cleanup failed.' }
}
