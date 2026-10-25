<# Removes only one caller-validated, inactive directory directly under an installation's versions directory. #>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Directory,
  [Parameter(Mandatory = $true)][string]$VersionsRoot,
  [Parameter(Mandatory = $true)][string]$NodePath
)
$ErrorActionPreference = 'Stop'

# Windows PowerShell 5.1's recursive Remove-Item cannot reliably remove the
# long dependency paths that Node/npm can create, even when the root is short.
# The installer already requires and validates Node 24. Keep the scope checks
# and deletion in that same runtime; never shorten or remap the caller's path.
$remove = @'
const fs = require('node:fs');
const path = require('node:path');
try {
const [parentInput, targetInput] = process.argv.slice(1);
if (!path.isAbsolute(parentInput) || !path.isAbsolute(targetInput)) throw new Error('Install cleanup requires absolute paths.');
const parent = path.resolve(parentInput), target = path.resolve(targetInput);
const same = (left, right) => left.toLowerCase() === right.toLowerCase();
if (!same(path.basename(parent), 'versions') || !same(path.dirname(target), parent)) {
  throw new Error('Install cleanup must remain one direct child of the expected versions directory.');
}
const version = String.raw`\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?`;
const ownedName = new RegExp(String.raw`^(?:${version}|\.(?:install|upgrade)-${version}-[0-9a-f]{32})$`);
if (!ownedName.test(path.basename(target))) throw new Error('Install cleanup directory name is invalid.');
for (let cursor = parent; ; cursor = path.dirname(cursor)) {
  const item = fs.lstatSync(cursor);
  if (!item.isDirectory() || item.isSymbolicLink()) throw new Error('Install cleanup parent must not traverse a directory link.');
  if (same(cursor, path.dirname(cursor))) break;
}
const item = fs.lstatSync(target);
if (!item.isDirectory() || item.isSymbolicLink()) throw new Error('Install cleanup target must be a plain directory.');
fs.rmSync(target, { recursive: true, force: false, maxRetries: 2, retryDelay: 100 });
if (fs.existsSync(target)) throw new Error('Install cleanup did not remove its target.');
} catch (error) {
  console.log(error.message);
  process.exitCode = 1;
}
'@
$result = @(& $NodePath -e $remove $VersionsRoot $Directory)
if ($LASTEXITCODE -ne 0) { throw "Unable to remove the owned install directory: $Directory. $($result -join ' ')" }
