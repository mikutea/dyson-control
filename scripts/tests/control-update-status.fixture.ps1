<#
.SYNOPSIS
Checks that update status and installation state stay readable during replacement.
.DESCRIPTION
Runs only file-writing functions in an isolated directory. No task, service, or game is started.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3
$fixtureRoot = Join-Path ([IO.Path]::GetTempPath()) ('dyson-update-status-' + [guid]::NewGuid().ToString('N'))
if ($fixtureRoot.Length -lt 120) { $fixtureRoot += '-' + ('x' * (119 - $fixtureRoot.Length)) }
New-Item -ItemType Directory -Path $fixtureRoot | Out-Null
$utf8 = [Text.UTF8Encoding]::new($false)
$utf8NoBom = $utf8
. (Join-Path $PSScriptRoot '..\windows\atomic-json.ps1')

Add-Type -ReferencedAssemblies 'System.Web.Extensions.dll' -TypeDefinition @'
using System;
using System.IO;
using System.Threading;
public sealed class DysonStatusReader : IDisposable {
    private readonly string path;
    private volatile bool running;
    private Thread worker;
    public long Reads, Missing, Invalid, Errors;
    public DysonStatusReader(string path) { this.path = path; }
    public void Start() {
        running = true;
        worker = new Thread(() => {
            var json = new System.Web.Script.Serialization.JavaScriptSerializer();
            while (running) {
                try {
                    using (var file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
                    using (var reader = new StreamReader(file)) {
                        var value = reader.ReadToEnd().Trim();
                        if (!value.StartsWith("{") || !value.EndsWith("}")) Interlocked.Increment(ref Invalid);
                        json.DeserializeObject(value);
                        Interlocked.Increment(ref Reads);
                    }
                } catch (FileNotFoundException) { Interlocked.Increment(ref Missing); }
                  catch (Exception) { Interlocked.Increment(ref Errors); }
            }
        });
        worker.IsBackground = true;
        worker.Start();
    }
    public void Dispose() { running = false; if (worker != null) worker.Join(); }
}
'@

$cases = @(
  @{ Script = 'control-update-helper.ps1'; Writer = 'Write-AtomicJson' },
  @{ Script = 'upgrade-control.ps1'; Writer = 'Write-ControlUpdateStatus' },
  @{ Script = 'upgrade-control.ps1'; Writer = 'Write-InstallState' }
)
$results = @()
foreach ($case in $cases) {
  $scriptPath = Join-Path $PSScriptRoot ('..\windows\' + $case.Script)
  $tokens = $null; $parseErrors = $null
  $ast = [Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$tokens, [ref]$parseErrors)
  if ($parseErrors.Count) { throw "Unable to parse $scriptPath" }
  $definitions = ($ast.EndBlock.Statements | Where-Object { $_ -is [Management.Automation.Language.FunctionDefinitionAst] } | ForEach-Object { $_.Extent.Text }) -join "`n"
  $result = & {
    param($Definitions, $Case, $Root)
    . ([scriptblock]::Create($Definitions))
    $directory = Join-Path $Root ($Case.Writer + ' ' + [char]0x72b6 + [char]0x6001 + ' state')
    New-Item -ItemType Directory -Path $directory | Out-Null
    $statusPath = Join-Path $directory 'helper-status.json'
    function Write-FixtureStatus([string]$Message) {
      if ($Case.Writer -ceq 'Write-ControlUpdateStatus') {
        $target = [pscustomobject]@{ Path = $statusPath; OperationId = '00000000-0000-4000-8000-000000000001' }
        Write-ControlUpdateStatus $target 'applying' 'installing' '1.0.1' '1.0.0' $Root 1 1 $false $Message
      } else {
        & $Case.Writer $statusPath ([ordered]@{ schema = 1; message = $Message })
      }
    }

    Write-FixtureStatus 'initial'
    if ((Get-Content -LiteralPath $statusPath -Raw | ConvertFrom-Json).message -cne 'initial') { throw 'Initial status was not written.' }
    $permissions = Get-Acl -LiteralPath $statusPath
    $permissions.SetAccessRuleProtection($true, $true)
    Set-Acl -LiteralPath $statusPath -AclObject $permissions
    $originalPermissions = (Get-Acl -LiteralPath $statusPath).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)
    $reader = [DysonStatusReader]::new($statusPath)
    $reader.Start()
    try {
      $deadline = [DateTime]::UtcNow.AddSeconds(10)
      while ($reader.Reads -eq 0 -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 10 }
      if ($reader.Reads -eq 0) { throw 'Concurrent reader did not start.' }
      for ($index = 1; $index -le 250; $index++) { Write-FixtureStatus "snapshot-$index" }
    } finally { $reader.Dispose() }
    if ((Get-Content -LiteralPath $statusPath -Raw | ConvertFrom-Json).message -cne 'snapshot-250') { throw 'Final status was not complete.' }
    $bytes = [IO.File]::ReadAllBytes($statusPath)
    if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) { throw 'Status contains a UTF-8 BOM.' }
    $original = [IO.File]::ReadAllText($statusPath)
    $permissionsPreserved = (Get-Acl -LiteralPath $statusPath).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access) -ceq $originalPermissions
    $attributes = [IO.File]::GetAttributes($statusPath)
    [IO.File]::SetAttributes($statusPath, ($attributes -bor [IO.FileAttributes]::ReadOnly))
    $rejected = $false
    try { try { Write-FixtureStatus 'must-not-replace' } catch { $rejected = $true } }
    finally { [IO.File]::SetAttributes($statusPath, $attributes) }
    $preserved = [IO.File]::ReadAllText($statusPath) -ceq $original
    $partials = @(Get-ChildItem -LiteralPath $directory -File -Filter '*.partial-*').Count
    [pscustomobject]@{
      writer = $Case.Writer; reads = $reader.Reads; missing = $reader.Missing; invalid = $reader.Invalid; errors = $reader.Errors;
      readOnlyTargetRejected = $rejected; originalPreserved = $preserved; permissionsPreserved = $permissionsPreserved; temporaryFiles = $partials
    }
  } $definitions $case $fixtureRoot
  $results += $result
}
$report = Join-Path $fixtureRoot 'result.json'
[IO.File]::WriteAllText($report, (($results | ConvertTo-Json -Depth 4) + [Environment]::NewLine), $utf8)
$results | ConvertTo-Json -Depth 4 | Write-Output
if (@($results | Where-Object { $_.reads -lt 1 -or $_.missing -ne 0 -or $_.invalid -ne 0 -or $_.errors -ne 0 -or -not $_.readOnlyTargetRejected -or -not $_.originalPreserved -or -not $_.permissionsPreserved -or $_.temporaryFiles -ne 0 }).Count) {
  throw "An update status writer failed continuous-read or failed-write preservation checks. Report: $report"
}
Write-Output "CONTROL_UPDATE_STATUS_FIXTURE_OK: continuous reads, complete JSON, preserved read-only targets and ACLs, cleaned temporary files. Report: $report"
