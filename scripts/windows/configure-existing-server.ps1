param([Parameter(Mandatory=$true)][string]$ArgumentsPath)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
. (Join-Path $PSScriptRoot 'path-policy.ps1')

function Get-PrivatePlanDirectory([string]$Directory, [bool]$Create) {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  if (-not [Security.Principal.WindowsPrincipal]::new($identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'ADOPT_PRIVATE_STORAGE' }
  [void](Get-DysonApprovedPathInfo $Directory 'Existing server plan' $false $true)
  for ($parent = [IO.DirectoryInfo]::new($Directory); $null -ne $parent; $parent = $parent.Parent) {
    if ($parent.Exists -and ($parent.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'ADOPT_PRIVATE_STORAGE' }
  }
  if ($Create) {
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetSecurityDescriptorSddlForm('D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)')
    [void][IO.Directory]::CreateDirectory($Directory, $acl)
  }
  $actual = Get-Acl -LiteralPath $Directory -ErrorAction Stop
  $allowed = @('S-1-5-18','S-1-5-32-544')
  if ($actual.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin ($allowed + $identity.User.Value)) { throw 'ADOPT_PRIVATE_STORAGE' }
  $rules = @($actual.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
  if (-not $actual.AreAccessRulesProtected -or $rules.Count -ne 2) { throw 'ADOPT_PRIVATE_STORAGE' }
  foreach ($sid in $allowed) {
    $matching = @($rules | Where-Object { $_.IdentityReference.Value -ceq $sid -and [string]$_.AccessControlType -ceq 'Allow' -and
      $_.FileSystemRights -eq [Security.AccessControl.FileSystemRights]::FullControl -and [int]$_.InheritanceFlags -eq 3 -and [int]$_.PropagationFlags -eq 0 })
    if ($matching.Count -ne 1) { throw 'ADOPT_PRIVATE_STORAGE' }
  }
}

try {
  $inputData = Get-Content -LiteralPath $ArgumentsPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($inputData.mode -notin @('prepare','apply') -or $inputData.planId -notmatch '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$') { throw 'Invalid request.' }
  $prepare = $inputData.mode -ceq 'prepare'
  $base = Join-Path $inputData.config.dataDirectory 'existing-server'
  $directory = Join-Path $base $inputData.planId
  try {
    Get-PrivatePlanDirectory $base $prepare
    if ($prepare -and (Test-Path -LiteralPath $directory)) { throw 'Plan directory already exists.' }
    Get-PrivatePlanDirectory $directory $prepare
  } catch { throw 'ADOPT_PRIVATE_STORAGE' }
  $configPath = Join-Path $directory 'config.json'
  $arguments = @{ ConfigPath = $configPath; BridgeBuildDirectory = [string]$inputData.bridgeDirectory; BridgeSha256 = [string]$inputData.bridgeSha256
    GameUser = [string]$inputData.gameUser; ReviewExisting = $true; RequireNewTask = $true }
  if ($prepare) {
    [IO.File]::WriteAllText($configPath, ($inputData.config | ConvertTo-Json -Depth 4), [Text.UTF8Encoding]::new($false))
    $arguments.PrepareOnly = $true
    $arguments.OutputDirectory = Join-Path $directory 'preview'
  } else {
    $arguments.ConfirmStopped = $true
    $arguments.ExpectedReviewHash = [string]$inputData.reviewHash
    $arguments.ReviewedReferences = @($inputData.references)
  }
  $output = & (Join-Path $PSScriptRoot 'configure-game.ps1') @arguments
  $result = $output | ConvertFrom-Json
  if ($prepare) {
    if ($result.prepared -ne $true -or $result.targetChanged -ne $false) { throw 'Unconfirmed preview.' }
    $summary = [ordered]@{ prepared = $true; targetChanged = $false }
    foreach ($field in @('reviewHash','bridgeSha256','bridgeDll','bridgeConfig','secret','startup','accessChanges','existingAccessChecks')) {
      $summary[$field] = $result.review.$field
    }
    $summary | ConvertTo-Json -Compress
  } else {
    [ordered]@{ configured = $result.configured; bridgeSha256 = $result.bridgeSha256; taskName = $result.taskName
      taskStarted = $result.taskStarted; savesMoved = $result.savesMoved } | ConvertTo-Json -Compress
  }
} catch {
  $message = $_.Exception.Message
  $known = @('ADOPT_PRIVATE_STORAGE','ADOPT_PLAN_CHANGED','ADOPT_HOST_BUSY','ADOPT_TASK_EXISTS','ADOPT_STEAM_USER','ADOPT_RESTORE_ACTIVE')
  $code = if ($message -in $known) { $message } else { 'ADOPT_CONFIG_FAILED' }
  [ordered]@{ errorCode = $code } | ConvertTo-Json -Compress
}
