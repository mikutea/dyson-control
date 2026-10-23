$ErrorActionPreference = 'Stop'
$temporaryRoot = if ([string]::IsNullOrWhiteSpace($env:RUNNER_TEMP)) { $env:TEMP } else { $env:RUNNER_TEMP }
$fixture = Join-Path $temporaryRoot ('dyson-control-configure-game-' + [guid]::NewGuid().ToString('N'))
$script = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\windows\configure-game.ps1'))
$startScript = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\windows\start-game.ps1'))
$pathPolicyScript = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\windows\path-policy.ps1'))
$utf8NoBom = [Text.UTF8Encoding]::new($false)
$gameUserName = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$gameUserSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$fixtureLinks = @()

function Assert-True([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}

function Get-TaskOption([string[]]$Contents, [string]$Name) {
  $values = @()
  for ($index = 0; $index -lt ($Contents.Count - 1); $index++) {
    if ($Contents[$index].Equals($Name, [StringComparison]::OrdinalIgnoreCase)) { $values += $Contents[$index + 1] }
  }
  if ($values.Count -ne 1) { throw "Task option $Name is missing or repeated." }
  return [string]$values[0]
}

function Invoke-Prepare([string]$ConfigPath, [string]$BuildPath, [string]$Hash, [string]$OutputPath) {
  $raw = & powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $script `
    -ConfigPath $ConfigPath -BridgeBuildDirectory $BuildPath -BridgeSha256 $Hash -GameUser $gameUserName `
    -PrepareOnly -OutputDirectory $OutputPath
  if ($LASTEXITCODE -ne 0) { throw "configure-game.ps1 prepare fixture exited with $LASTEXITCODE." }
  $summary = ($raw -join "`n") | ConvertFrom-Json
  Assert-True ([bool]$summary.prepared) 'Prepare summary did not report success.'
  Assert-True (-not [bool]$summary.targetChanged) 'Prepare summary incorrectly reported a target mutation.'
  return Get-Content -LiteralPath (Join-Path $OutputPath 'plan.json') -Raw -Encoding UTF8 | ConvertFrom-Json
}

New-Item -ItemType Directory -Path $fixture | Out-Null
try {
  $game = Join-Path $fixture 'game'
  $data = Join-Path $fixture 'data'
  $save = Join-Path $fixture 'save'
  $backup = Join-Path $fixture 'backups'
  $bridge = Join-Path $fixture 'bridge'
  $private = Join-Path $fixture 'private'
  $build = Join-Path $fixture 'bridge-build'
  $pluginDirectory = Join-Path $game 'BepInEx\plugins\dyson-control'
  $configDirectory = Join-Path $game 'BepInEx\config'
  foreach ($directory in @($data, $save, $backup, $bridge, $private, $build, $pluginDirectory, $configDirectory)) {
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
  }

  $sourceDll = Join-Path $build 'DysonControlBridge.dll'
  [IO.File]::WriteAllBytes($sourceDll, [Text.Encoding]::ASCII.GetBytes('fixture-new-bridge-binary'))
  $sourceHash = (Get-FileHash -LiteralPath $sourceDll -Algorithm SHA256).Hash.ToLowerInvariant()
  $targetDll = Join-Path $pluginDirectory 'DysonControlBridge.dll'
  $targetConfig = Join-Path $configDirectory 'net.miyuo.dyson-control.bridge.cfg'
  [IO.File]::WriteAllText($targetDll, 'old-dll-sentinel', $utf8NoBom)
  [IO.File]::WriteAllText($targetConfig, 'old-config-sentinel', $utf8NoBom)
  $saveSentinel = Join-Path $save 'World.dsv'
  [IO.File]::WriteAllText($saveSentinel, 'save-must-not-move', $utf8NoBom)

  $taskName = 'Dyson Fixture ' + [guid]::NewGuid().ToString('N')
  $secretFile = Join-Path $private 'bridge-secret'
  $configuration = [ordered]@{
    host = '127.0.0.1'; port = 13020; dataDirectory = $data; mode = 'windows'; adminPasswordHash = 'fixture'
    game = [ordered]@{
      root = $game; saveDirectory = $save; backupDirectory = $backup; logFile = (Join-Path $game 'logs\server.log')
      bridgeDirectory = $bridge; bridgeSecretFile = $secretFile; startTaskName = $taskName
      address = 'fixture.invalid:8469'; serverName = 'Fixture'
    }
  }
  $configPath = Join-Path $fixture 'control.config.json'
  [IO.File]::WriteAllText($configPath, ($configuration | ConvertTo-Json -Depth 5), $utf8NoBom)

  $previousErrorPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $guardOutput = & powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $script `
    -ConfigPath $configPath -BridgeBuildDirectory $build -BridgeSha256 $sourceHash -GameUser $gameUserName 2>&1
  $guardExitCode = $LASTEXITCODE
  $ErrorActionPreference = $previousErrorPreference
  Assert-True ($guardExitCode -ne 0) 'Apply mode succeeded without ConfirmStopped.'
  Assert-True (($guardOutput -join "`n") -like '*Apply mode requires -ConfirmStopped*') 'Apply guard returned the wrong failure.'
  Assert-True ([IO.File]::ReadAllText($targetDll, $utf8NoBom) -ceq 'old-dll-sentinel') 'Apply guard changed the target DLL.'
  Assert-True ([IO.File]::ReadAllText($targetConfig, $utf8NoBom) -ceq 'old-config-sentinel') 'Apply guard changed the target config.'

  $wrongHashOutput = Join-Path $fixture 'wrong-hash-output'
  $ErrorActionPreference = 'Continue'
  $hashFailure = & powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $script `
    -ConfigPath $configPath -BridgeBuildDirectory $build -BridgeSha256 ('0' * 64) -GameUser $gameUserName `
    -PrepareOnly -OutputDirectory $wrongHashOutput 2>&1
  $hashExitCode = $LASTEXITCODE
  $ErrorActionPreference = $previousErrorPreference
  Assert-True ($hashExitCode -ne 0) 'Prepare mode accepted the wrong Bridge hash.'
  Assert-True (($hashFailure -join "`n") -like '*does not match BridgeSha256*') 'Wrong-hash guard returned the wrong failure.'
  Assert-True (-not (Test-Path -LiteralPath $wrongHashOutput)) 'Wrong-hash guard created prepare output.'

  $invalidUserOutput = Join-Path $fixture 'invalid-user-output'
  $ErrorActionPreference = 'Continue'
  $userFailure = & powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $script `
    -ConfigPath $configPath -BridgeBuildDirectory $build -BridgeSha256 $sourceHash `
    -GameUser ('.\dyson-missing-' + [guid]::NewGuid().ToString('N')) -PrepareOnly -OutputDirectory $invalidUserOutput 2>&1
  $userExitCode = $LASTEXITCODE
  $ErrorActionPreference = $previousErrorPreference
  Assert-True ($userExitCode -ne 0) 'Prepare mode accepted a nonexistent GameUser.'
  Assert-True (($userFailure -join "`n") -like '*GameUser could not be resolved*') 'Invalid GameUser guard returned the wrong failure.'
  Assert-True (-not (Test-Path -LiteralPath $invalidUserOutput)) 'Invalid GameUser guard created prepare output.'

  $firstOutput = Join-Path $fixture 'prepared-new-secret'
  $firstPlan = Invoke-Prepare $configPath $build $sourceHash $firstOutput
  Assert-True ([string]$firstPlan.mode -ceq 'prepare-only') 'Plan mode is not prepare-only.'
  Assert-True ([string]$firstPlan.bridge.secretAction -ceq 'create') 'Missing secret did not produce a create action.'
  Assert-True ([string]$firstPlan.bridge.secretCandidate -ceq 'bridge-secret.new') 'Secret candidate was not recorded by file name.'
  Assert-True (-not (Test-Path -LiteralPath $secretFile)) 'Prepare mode created the target secret.'
  Assert-True (-not (Test-Path -LiteralPath (Join-Path $data 'game-startup\settings.json'))) 'Prepare mode created target startup settings.'
  Assert-True (-not (Test-Path -LiteralPath (Join-Path $data 'save-restore'))) 'Prepare mode created the target save-restore state directory.'
  Assert-True ([IO.File]::ReadAllText($targetDll, $utf8NoBom) -ceq 'old-dll-sentinel') 'Prepare mode replaced the target DLL.'
  Assert-True ([IO.File]::ReadAllText($targetConfig, $utf8NoBom) -ceq 'old-config-sentinel') 'Prepare mode replaced the target config.'
  Assert-True ([IO.File]::ReadAllText($saveSentinel, $utf8NoBom) -ceq 'save-must-not-move') 'Prepare mode changed the save fixture.'
  Assert-True ((Get-FileHash -LiteralPath (Join-Path $firstOutput 'DysonControlBridge.dll') -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $sourceHash) 'Staged Bridge hash is wrong.'

  $expectedBridgeConfig = @(
    '[Bridge]', "ControlDirectory = $bridge", "SecretFile = $secretFile", "ExpectedSaveDirectory = $save", ''
  ) -join "`r`n"
  Assert-True ([IO.File]::ReadAllText((Join-Path $firstOutput 'net.miyuo.dyson-control.bridge.cfg'), $utf8NoBom) -ceq $expectedBridgeConfig) 'Staged Bridge config is not exact.'
  $candidateSecretPath = Join-Path $firstOutput 'bridge-secret.new'
  $acl = Get-Acl -LiteralPath $candidateSecretPath
  Assert-True ([bool]$acl.AreAccessRulesProtected) 'Staged secret still inherits ACL entries.'
  $unexpectedRules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | Where-Object {
    [string]$_.IdentityReference.Value -notin @('S-1-5-18', 'S-1-5-32-544')
  })
  Assert-True ($unexpectedRules.Count -eq 0) 'Staged secret ACL grants an unexpected identity.'
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  & (Join-Path $env:SystemRoot 'System32\icacls.exe') $candidateSecretPath '/grant:r' "*$sid`:(F)" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Unable to grant the fixture identity temporary access to inspect the staged secret.' }
  $candidateSecret = [IO.File]::ReadAllText($candidateSecretPath, $utf8NoBom)
  Assert-True ($candidateSecret -cmatch '^[0-9a-f]{64}$') 'Staged secret is not a 32-byte random hexadecimal value.'
  $planText = [IO.File]::ReadAllText((Join-Path $firstOutput 'plan.json'), $utf8NoBom)
  Assert-True (-not $planText.Contains($candidateSecret)) 'Plan leaked the staged secret value.'

  Assert-True ([string]$firstPlan.task.name -ceq $taskName) 'Plan task name does not match control.config.'
  Assert-True ([string]$firstPlan.task.description -ceq 'DYSON_CONTROL_MANAGED_GAME_START_V1') 'Plan task ownership marker is wrong.'
  Assert-True ([string]$firstPlan.task.account -ceq $gameUserName) 'Plan task account is not the explicit GameUser.'
  Assert-True ([string]$firstPlan.task.sid -ceq $gameUserSid) 'Plan task SID is not the resolved GameUser SID.'
  Assert-True ([string]$firstPlan.task.logonType -ceq 'Interactive') 'Plan task logon type is not Interactive.'
  Assert-True ([string]$firstPlan.task.runLevel -ceq 'Limited') 'Plan task run level is not Limited.'
  Assert-True (-not [bool]$firstPlan.task.startImmediately) 'Plan would start the game immediately.'
  Assert-True ([string]$firstPlan.access.principalAccount -ceq $gameUserName) 'Plan ACL principal account is wrong.'
  Assert-True ([string]$firstPlan.access.principalSid -ceq $gameUserSid) 'Plan ACL principal SID is wrong.'
  $plannedAccess = @{}
  foreach ($change in @($firstPlan.access.changes)) { $plannedAccess[[string]$change.label] = $change }
  foreach ($label in @('game.root', 'game user-data root', 'game.logFile parent', 'game.bridgeDirectory')) {
    Assert-True ([string]$plannedAccess[$label].rights -ceq 'Modify') "Plan does not grant scoped Modify for $label."
    Assert-True ([string]$plannedAccess[$label].inheritance -ceq 'children') "Plan does not propagate scoped Modify for $label."
  }
  foreach ($label in @('game.bridgeSecretFile', 'startup settings')) {
    Assert-True ([string]$plannedAccess[$label].rights -ceq 'Read') "Plan does not grant scoped Read for $label."
    Assert-True ([string]$plannedAccess[$label].inheritance -ceq 'none') "Plan unexpectedly propagates Read for $label."
  }
  foreach ($label in @('managed start script', 'managed path policy', 'managed scripts directory')) {
    Assert-True ([string]$plannedAccess[$label].rights -ceq 'ReadAndExecute') "Plan does not grant scoped ReadAndExecute for $label."
  }
  Assert-True ([string]$plannedAccess['startup settings directory'].rights -ceq 'ReadAndExecute') 'Plan does not grant startup directory ReadAndExecute.'
  Assert-True ([string]$plannedAccess['startup settings directory'].inheritance -ceq 'children') 'Plan does not propagate startup directory read access to atomic replacements.'
  Assert-True ([string]$plannedAccess['save-restore state directory'].rights -ceq 'ReadAndExecute') 'Plan does not grant save-restore state directory ReadAndExecute.'
  Assert-True ([string]$plannedAccess['save-restore state directory'].inheritance -ceq 'children') 'Plan does not propagate read access to save-restore state files.'
  Assert-True ([string]$plannedAccess['managed game-data link'].rights -ceq 'Modify') 'Plan does not grant direct Modify on the managed game-data link.'
  Assert-True ([string]$plannedAccess['managed game-data link'].inheritance -ceq 'none') 'Plan propagates the managed game-data link ACE.'
  Assert-True ([string]$firstPlan.access.rollback -like '*original SDDL*restored on failure*') 'Plan does not state the ACL rollback contract.'
  Assert-True (@($firstPlan.pathPolicy.localNtfs) -contains 'dataDirectory') 'Plan does not keep dataDirectory on local NTFS.'
  Assert-True (@($firstPlan.pathPolicy.localNtfs) -contains 'game.bridgeSecretFile') 'Plan does not keep the Bridge secret on local NTFS.'
  Assert-True (@($firstPlan.pathPolicy.localNtfs) -contains 'managed path policy') 'Plan does not keep the managed path helper on local NTFS.'
  Assert-True (@($firstPlan.pathPolicy.localNtfs) -contains 'save-restore state directory') 'Plan does not keep save-restore state on local NTFS.'
  Assert-True (@($firstPlan.pathPolicy.globalSmbEligible) -contains 'game.root') 'Plan does not identify game.root as global-SMB eligible.'
  Assert-True (@($firstPlan.pathPolicy.globalSmbEligible) -contains 'game.saveDirectory') 'Plan does not identify game.saveDirectory as global-SMB eligible.'
  Assert-True ([string]$firstPlan.pathPolicy.globalSmbRequirement -like '*Get-SmbGlobalMapping*no mapping or credentials*') 'Plan does not state the existing-global-mapping boundary.'
  Assert-True ([string]$firstPlan.pathPolicy.applyProbe -like '*SYSTEM*Interactive GameUser*create/write/read/rename/delete*') 'Plan does not state both apply-time probes.'
  $parseErrors = $null
  $tokens = [Management.Automation.PSParser]::Tokenize([string]$firstPlan.task.arguments, [ref]$parseErrors)
  Assert-True ($null -eq $parseErrors -or $parseErrors.Count -eq 0) 'Task arguments do not parse.'
  $contents = @($tokens | ForEach-Object { [string]$_.Content })
  foreach ($name in @('-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', '-File', '-GameRoot', '-SaveDirectory', '-SettingsPath', '-LogFile', '-ProcessPriority')) {
    Assert-True (@($contents | Where-Object { $_.Equals($name, [StringComparison]::OrdinalIgnoreCase) }).Count -eq 1) "Task argument $name is missing or repeated."
  }
  Assert-True ($contents.Count -eq 17) 'Task arguments contain an unexpected token.'
  Assert-True ((Get-TaskOption $contents '-ExecutionPolicy') -ceq 'Bypass') 'Task execution policy is wrong.'
  Assert-True ((Get-TaskOption $contents '-ProcessPriority') -ceq 'AboveNormal') 'Task process priority is wrong.'
  Assert-True ([IO.Path]::GetFullPath((Get-TaskOption $contents '-File')).Equals([IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\windows\start-game.ps1')), [StringComparison]::OrdinalIgnoreCase)) 'Task does not use the managed start-game.ps1.'
  Assert-True ([IO.Path]::GetFullPath((Get-TaskOption $contents '-GameRoot')).Equals($game, [StringComparison]::OrdinalIgnoreCase)) 'Task game root is wrong.'
  Assert-True ([IO.Path]::GetFullPath((Get-TaskOption $contents '-SaveDirectory')).Equals($save, [StringComparison]::OrdinalIgnoreCase)) 'Task save directory is wrong.'
  Assert-True ([IO.Path]::GetFullPath((Get-TaskOption $contents '-SettingsPath')).Equals((Join-Path $data 'game-startup\settings.json'), [StringComparison]::OrdinalIgnoreCase)) 'Task does not use the dedicated startup settings path.'
  Assert-True ([IO.Path]::GetFullPath((Get-TaskOption $contents '-LogFile')).Equals((Join-Path $game 'logs\server.log'), [StringComparison]::OrdinalIgnoreCase)) 'Task log file is wrong.'

  if (Get-Command Get-ScheduledTask -ErrorAction SilentlyContinue) {
    Assert-True ($null -eq (Get-ScheduledTask -TaskName $taskName -TaskPath '\' -ErrorAction SilentlyContinue)) 'Prepare mode registered a scheduled task.'
  }

  $retainedSecret = 'r' * 64
  [IO.File]::WriteAllText($secretFile, $retainedSecret, $utf8NoBom)
  $secondOutput = Join-Path $fixture 'prepared-retained-secret'
  $secondPlan = Invoke-Prepare $configPath $build $sourceHash $secondOutput
  Assert-True ([string]$secondPlan.bridge.secretAction -ceq 'retain') 'Existing secret did not produce a retain action.'
  Assert-True (-not (Test-Path -LiteralPath (Join-Path $secondOutput 'bridge-secret.new'))) 'Prepare mode copied or replaced an existing secret.'
  Assert-True ([IO.File]::ReadAllText($secretFile, $utf8NoBom) -ceq $retainedSecret) 'Prepare mode changed the existing secret.'

  . $pathPolicyScript
  function Get-SmbGlobalMapping {
    [pscustomobject]@{ LocalPath = 'R:'; RemotePath = '\\fixture-storage.example\server-data'; Status = 0 }
  }
  Assert-True (Test-DysonPathEquals 'R:\Servers\FixtureGame\DSPGAME.exe' '\\fixture-storage.example\server-data\Servers\FixtureGame\DSPGAME.exe') 'Healthy global SMB mapped and UNC forms were not canonicalized as equal.'
  Assert-True (-not (Test-DysonPathEquals 'R:\Servers\FixtureGame\DSPGAME.exe' '\\other-host.example\other-data\Servers\FixtureGame\DSPGAME.exe')) 'An unrelated UNC path was accepted as equivalent.'
  function Get-SmbGlobalMapping {
    [pscustomobject]@{ LocalPath = 'R:'; RemotePath = '\\fixture-storage.example\server-data'; Status = 2 }
  }
  Assert-True (-not (Test-DysonPathEquals 'R:\Servers\FixtureGame\DSPGAME.exe' '\\fixture-storage.example\server-data\Servers\FixtureGame\DSPGAME.exe')) 'An unhealthy global SMB mapping was accepted.'

  $verificationTokens = $null
  $verificationErrors = $null
  $verificationAst = [Management.Automation.Language.Parser]::ParseFile($script, [ref]$verificationTokens, [ref]$verificationErrors)
  Assert-True ($null -eq $verificationErrors -or $verificationErrors.Count -eq 0) 'configure-game.ps1 does not parse.'
  $verificationFunction = $verificationAst.Find({
    param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Wait-ExactTaskRegistration'
  }, $true)
  Assert-True ($null -ne $verificationFunction) 'Unable to locate task registration verification implementation.'
  Invoke-Expression $verificationFunction.Extent.Text
  foreach ($functionName in @('Get-FullPath', 'Get-PlainDirectory', 'Get-PlainFile', 'Write-NewFile', 'Install-AtomicFile', 'Write-AtomicText', 'Protect-SystemAdministratorsOnly', 'Split-GameUserAccessRequirements', 'New-AclSnapshot', 'Grant-GameUserAccess', 'Get-AclComparisonSddl', 'Restore-AclSnapshots', 'Assert-ExactDirectoryLink')) {
    $functionAst = $verificationAst.Find({
      param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $functionName
    }, $true)
    Assert-True ($null -ne $functionAst) "Unable to locate $functionName implementation."
    Invoke-Expression $functionAst.Extent.Text
  }
  & {
    # Model a healthy mapped share whose ACL cannot represent a local SID.
    # Local ACL grants and mapped access checks must remain distinct.
    function Get-DysonApprovedPathInfo([string]$PathValue, [string]$Label, [bool]$AllowGlobalSmb, [bool]$RequireNtfs) {
      if ($PathValue.StartsWith('R:\', [StringComparison]::OrdinalIgnoreCase)) {
        if (-not $AllowGlobalSmb) { throw 'Network path is not allowed here.' }
        return [pscustomobject]@{ Kind = 'smb-global' }
      }
      return [pscustomobject]@{ Kind = 'local-fixed' }
    }
    $split = Split-GameUserAccessRequirements @(
      [pscustomobject]@{ label = 'game.root'; path = 'R:\game'; rights = 'Modify'; inheritance = 'children' },
      [pscustomobject]@{ label = 'game user-data root'; path = 'R:\userdata'; rights = 'Modify'; inheritance = 'children' },
      [pscustomobject]@{ label = 'game.logFile parent'; path = 'R:\logs'; rights = 'Modify'; inheritance = 'children' },
      [pscustomobject]@{ label = 'game.bridgeDirectory'; path = 'C:\bridge'; rights = 'Modify'; inheritance = 'children' }
    )
    Assert-True (@($split.changes).Count -eq 1 -and $split.changes[0].label -ceq 'game.bridgeDirectory') 'Mapped share paths were included in ACL mutations.'
    Assert-True (@($split.existingAccessChecks).Count -eq 3) 'Mapped paths lost their mandatory access checks.'
    $rejected = $false
    try { Grant-GameUserAccess ([pscustomobject]@{ label = 'game.root'; path = 'R:\game' }) $gameUserSid }
    catch { $rejected = $_.Exception.Message -ceq 'Network path is not allowed here.' }
    Assert-True $rejected 'A direct ACL mutation accepted a remote share.'
  }
  # Native creation permits a disposable dangling directory link: no SMB server
  # or credentials are needed to exercise the Windows PowerShell 5.1 UNC bug.
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class DysonFixtureDirectoryLink {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool CreateSymbolicLink(string link, string target, int flags);
  public static void Create(string link, string target) {
    if (!CreateSymbolicLink(link, target, 3) && !CreateSymbolicLink(link, target, 1))
      throw new Win32Exception(Marshal.GetLastWin32Error());
  }
}
'@
  function Get-SmbGlobalMapping {
    [pscustomobject]@{ LocalPath = 'R:'; RemotePath = '\\fixture-storage.example\server-data'; Status = 0 }
  }
  $uncLink = Join-Path $fixture 'unc-document-link'
  $relativeUncLink = Join-Path $fixture 'relative-unc-document-link'
  $uncTarget = '\\fixture-storage.example\server-data\userdata'
  [DysonFixtureDirectoryLink]::Create($uncLink, $uncTarget)
  $fixtureLinks += $uncLink
  [DysonFixtureDirectoryLink]::Create($relativeUncLink, 'UNC\fixture-storage.example\server-data\userdata')
  $fixtureLinks += $relativeUncLink
  Assert-ExactDirectoryLink $uncLink $uncTarget 'SymbolicLink'
  Assert-ExactDirectoryLink $uncLink 'R:\userdata' 'SymbolicLink'
  foreach ($wrongLink in @($relativeUncLink, $uncLink)) {
    $rejectedLink = $false
    $wrongTarget = if ($wrongLink -ceq $relativeUncLink) { $uncTarget } else { '\\fixture-storage.example\server-data\other' }
    try { Assert-ExactDirectoryLink $wrongLink $wrongTarget 'SymbolicLink' } catch { $rejectedLink = $true }
    Assert-True $rejectedLink 'A relative UNC-looking link or wrong absolute target was accepted.'
  }
  $replacementSource = Join-Path $fixture 'replacement-source.bin'
  $replacementTarget = Join-Path $fixture 'replacement target.bin'
  $replacementBackup = Join-Path $fixture 'replacement-original.bin'
  [IO.File]::WriteAllBytes($replacementSource, [byte[]](0, 127, 255, 42))
  [IO.File]::WriteAllBytes($replacementBackup, [byte[]](1, 2, 3))
  Install-AtomicFile $replacementBackup $replacementTarget
  Assert-True ((Get-FileHash -LiteralPath $replacementTarget).Hash -ceq (Get-FileHash -LiteralPath $replacementBackup).Hash) 'Atomic install did not create the absent target.'
  Install-AtomicFile $replacementSource $replacementTarget
  Assert-True ((Get-FileHash -LiteralPath $replacementTarget).Hash -ceq (Get-FileHash -LiteralPath $replacementSource).Hash) 'Atomic install did not replace the existing target.'
  Install-AtomicFile $replacementBackup $replacementTarget
  Assert-True ((Get-FileHash -LiteralPath $replacementTarget).Hash -ceq (Get-FileHash -LiteralPath $replacementBackup).Hash) 'Atomic rollback did not restore the original file.'
  $replacementText = Join-Path $fixture 'replacement text.json'
  Write-AtomicText '{"version":1}' $replacementText
  Write-AtomicText '{"version":2}' $replacementText
  Assert-True ([IO.File]::ReadAllText($replacementText) -ceq '{"version":2}') 'Atomic text replacement failed.'
  $lockedTarget = [IO.File]::Open($replacementText, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
  $replacementRejected = $false
  try {
    try { Write-AtomicText '{"version":3}' $replacementText } catch { $replacementRejected = $true }
  }
  finally { $lockedTarget.Dispose() }
  Assert-True $replacementRejected 'Atomic replacement did not reject a locked destination.'
  Assert-True ([IO.File]::ReadAllText($replacementText) -ceq '{"version":2}') 'Failed atomic replacement changed the original text.'
  Assert-True (@(Get-ChildItem -LiteralPath $fixture -Filter '.dyson-control-*.tmp' -File).Count -eq 0) 'Atomic replacement left temporary files.'

  $inspectionTokens = $null
  $inspectionErrors = $null
  $inspectionAst = [Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot '..\windows\inspect-game.ps1'), [ref]$inspectionTokens, [ref]$inspectionErrors)
  foreach ($functionName in @('Test-PathEquals', 'Test-ManagedStartScript')) {
    $functionAst = $inspectionAst.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $functionName}, $true)
    Assert-True ($null -ne $functionAst) "Unable to locate $functionName inspection implementation."
    Invoke-Expression $functionAst.Extent.Text
  }
  $oldStartup = Join-Path $fixture 'installed\versions\1.0.0\scripts\windows\start-game.ps1'
  $newStartup = Join-Path $fixture 'installed\versions\1.1.0\scripts\windows\start-game.ps1'
  $unrelatedStartup = Join-Path $fixture 'other-install\versions\1.0.0\scripts\windows\start-game.ps1'
  foreach ($startup in @($oldStartup, $newStartup, $unrelatedStartup)) {
    New-Item -ItemType Directory -Path (Split-Path -Parent $startup) -Force | Out-Null
    [IO.File]::WriteAllText($startup, 'same-start-implementation', $utf8NoBom)
    [IO.File]::WriteAllText((Join-Path (Split-Path -Parent $startup) 'path-policy.ps1'), 'same-path-policy', $utf8NoBom)
  }
  Assert-True (Test-ManagedStartScript $oldStartup $newStartup) 'Panel upgrade lost the exact retained game-task implementation.'
  Assert-True (-not (Test-ManagedStartScript $unrelatedStartup $newStartup)) 'Another installation was accepted as the managed game-task source.'
  [IO.File]::WriteAllText($oldStartup, 'changed-start-implementation', $utf8NoBom)
  Assert-True (-not (Test-ManagedStartScript $oldStartup $newStartup)) 'A changed retained startup script was accepted.'
  [IO.File]::WriteAllText($oldStartup, 'same-start-implementation', $utf8NoBom)
  $oldPolicy = Join-Path (Split-Path -Parent $oldStartup) 'path-policy.ps1'
  [IO.File]::WriteAllText($oldPolicy, 'changed-path-policy', $utf8NoBom)
  Assert-True (-not (Test-ManagedStartScript $oldStartup $newStartup)) 'A changed retained path policy was accepted.'
  Remove-Item -LiteralPath $oldPolicy
  Assert-True (-not (Test-ManagedStartScript $oldStartup $newStartup)) 'A missing retained path policy was accepted.'

  $legacySddl = 'O:SYG:BAD:(A;OICI;FR;;;SY)(A;;FR;;;BA)'
  $autoInheritedSddl = 'O:SYG:BAD:AI(A;OICI;FR;;;SY)(A;;FR;;;BA)'
  Assert-True ((Get-AclComparisonSddl $legacySddl) -ceq (Get-AclComparisonSddl $autoInheritedSddl)) 'ACL comparison rejected the Windows automatic-inheritance marker.'
  foreach ($changedSddl in @(
    'O:SYG:BAD:PAI(A;OICI;FR;;;SY)(A;;FR;;;BA)',
    'O:SYG:BAD:AI(A;OICI;FW;;;SY)(A;;FR;;;BA)',
    'O:SYG:BAD:AI(D;OICI;FR;;;SY)(A;;FR;;;BA)',
    'O:SYG:BAD:AI(A;OICIID;FR;;;SY)(A;;FR;;;BA)',
    'O:SYG:BAD:AI(A;OICIIO;FR;;;SY)(A;;FR;;;BA)',
    'O:BAG:BAD:AI(A;OICI;FR;;;SY)(A;;FR;;;BA)',
    'O:SYG:SYD:AI(A;OICI;FR;;;SY)(A;;FR;;;BA)',
    'O:SYG:BAD:AI(A;OICI;FR;;;SY)(A;;FR;;;BA)(A;;FR;;;WD)',
    'O:SYG:BAD:AI(A;;FR;;;BA)(A;OICI;FR;;;SY)'
  )) {
    Assert-True ((Get-AclComparisonSddl $legacySddl) -cne (Get-AclComparisonSddl $changedSddl)) 'ACL comparison ignored a changed permission, identity, inheritance rule or ACE order.'
  }
  $aclFixture = Join-Path $fixture 'acl-fixture'
  New-Item -ItemType Directory -Path $aclFixture | Out-Null
  $aclChange = [pscustomobject]@{ label = 'ACL fixture'; path = $aclFixture; rights = 'ReadAndExecute'; inheritance = 'none' }
  $aclSnapshot = New-AclSnapshot $aclChange
  Grant-GameUserAccess $aclChange $gameUserSid
  $aclRules = @((Get-Acl -LiteralPath $aclFixture).GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier]) | Where-Object {
    [string]$_.IdentityReference.Value -ceq $gameUserSid -and $_.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow
  })
  Assert-True ($aclRules.Count -ge 1) 'GameUser ACL helper did not add a direct Allow rule.'
  Restore-AclSnapshots @($aclSnapshot)
  Assert-True ((Get-AclComparisonSddl (Get-Acl -LiteralPath $aclFixture).Sddl) -ceq (Get-AclComparisonSddl ([string]$aclSnapshot.sddl))) 'ACL helper did not restore the original permissions and identities.'

  $protectedFixture = Join-Path $fixture 'protected-secret-fixture'
  [IO.File]::WriteAllText($protectedFixture, 'sensitive', $utf8NoBom)
  $everyoneSid = [Security.Principal.SecurityIdentifier]::new('S-1-1-0')
  $protectedAcl = Get-Acl -LiteralPath $protectedFixture
  [void]$protectedAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
    $everyoneSid, [Security.AccessControl.FileSystemRights]::Read, [Security.AccessControl.AccessControlType]::Allow))
  Set-Acl -LiteralPath $protectedFixture -AclObject $protectedAcl
  $protectedChange = [pscustomobject]@{ label = 'protected secret fixture'; path = $protectedFixture; rights = 'Read'; inheritance = 'none' }
  $protectedSnapshot = New-AclSnapshot $protectedChange
  $protectedOwner = (Get-Acl -LiteralPath $protectedFixture).GetOwner([Security.Principal.SecurityIdentifier]).Value
  Protect-SystemAdministratorsOnly $protectedFixture $false
  $exactAcl = Get-Acl -LiteralPath $protectedFixture
  Assert-True ([bool]$exactAcl.AreAccessRulesProtected) 'Protected helper did not disable ACL inheritance.'
  Assert-True ($exactAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ceq $protectedOwner) 'Protected helper changed the file owner.'
  $exactRules = @($exactAcl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
  Assert-True (@($exactRules | Where-Object { [string]$_.IdentityReference.Value -ceq 'S-1-1-0' }).Count -eq 0) 'Protected helper retained explicit Everyone access.'
  foreach ($requiredSid in @('S-1-5-18', 'S-1-5-32-544')) {
    $requiredRules = @($exactRules | Where-Object {
      [string]$_.IdentityReference.Value -ceq $requiredSid -and
      $_.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
      $_.FileSystemRights -eq [Security.AccessControl.FileSystemRights]::FullControl
    })
    Assert-True ($requiredRules.Count -eq 1) "Protected helper did not retain exact FullControl for $requiredSid."
  }
  Grant-GameUserAccess $protectedChange $gameUserSid
  $gameUserRules = @((Get-Acl -LiteralPath $protectedFixture).GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier]) | Where-Object {
    [string]$_.IdentityReference.Value -ceq $gameUserSid -and $_.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow
  })
  $gameUserRights = [Security.AccessControl.FileSystemRights]0
  foreach ($rule in $gameUserRules) { $gameUserRights = $gameUserRights -bor $rule.FileSystemRights }
  Assert-True (($gameUserRights -band [Security.AccessControl.FileSystemRights]::Read) -eq [Security.AccessControl.FileSystemRights]::Read) 'Protected helper did not allow the scoped GameUser read grant.'
  Restore-AclSnapshots @($protectedSnapshot)
  Assert-True ((Get-AclComparisonSddl (Get-Acl -LiteralPath $protectedFixture).Sddl) -ceq (Get-AclComparisonSddl ([string]$protectedSnapshot.sddl))) 'Protected helper ACL did not roll back to the original permissions and identities.'

  $junctionParent = Join-Path $fixture 'junction-parent'
  $junctionTarget = Join-Path $fixture 'junction-target'
  $junctionPath = Join-Path $junctionParent 'managed-link'
  New-Item -ItemType Directory -Path $junctionParent, $junctionTarget | Out-Null
  New-Item -ItemType Junction -Path $junctionPath -Target $junctionTarget | Out-Null
  Assert-ExactDirectoryLink $junctionPath $junctionTarget 'Junction'
  $junctionChange = [pscustomobject]@{ label = 'junction fixture'; path = $junctionPath; rights = 'Modify'; inheritance = 'none' }
  $junctionSnapshot = New-AclSnapshot $junctionChange
  $junctionParentBefore = (Get-Acl -LiteralPath $junctionParent).Sddl
  $junctionTargetBefore = (Get-Acl -LiteralPath $junctionTarget).Sddl
  Grant-GameUserAccess $junctionChange $gameUserSid
  Assert-True ((Get-Acl -LiteralPath $junctionParent).Sddl -ceq $junctionParentBefore) 'Junction ACL grant changed the parent ACL.'
  Assert-True ((Get-Acl -LiteralPath $junctionTarget).Sddl -ceq $junctionTargetBefore) 'Junction ACL grant changed the target ACL.'
  Restore-AclSnapshots @($junctionSnapshot)
  Assert-True ((Get-AclComparisonSddl (Get-Acl -LiteralPath $junctionPath).Sddl) -ceq (Get-AclComparisonSddl ([string]$junctionSnapshot.sddl))) 'Junction ACL helper did not restore the link permissions and identities.'
  Assert-True ((Get-Acl -LiteralPath $junctionTarget).Sddl -ceq $junctionTargetBefore) 'Junction ACL rollback changed the target ACL.'

  $usersSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-545')
  $currentSid = [Security.Principal.SecurityIdentifier]::new($gameUserSid)
  $systemSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
  $administratorsSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
  $directoryInheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
  $atomicDirectory = Join-Path $fixture 'startup-atomic-inheritance'
  New-Item -ItemType Directory -Path $atomicDirectory | Out-Null
  $atomicDirectoryAcl = Get-Acl -LiteralPath $atomicDirectory
  $atomicDirectoryAcl.SetAccessRuleProtection($true, $false)
  foreach ($identity in @($systemSid, $administratorsSid, $currentSid)) {
    [void]$atomicDirectoryAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
      $identity, [Security.AccessControl.FileSystemRights]::FullControl, $directoryInheritance,
      [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow))
  }
  [void]$atomicDirectoryAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
    $usersSid, [Security.AccessControl.FileSystemRights]::ReadAndExecute, $directoryInheritance,
    [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow))
  Set-Acl -LiteralPath $atomicDirectory -AclObject $atomicDirectoryAcl
  $atomicTarget = Join-Path $atomicDirectory 'settings.json'
  $atomicTemporary = Join-Path $atomicDirectory 'settings.json.partial-fixture'
  $atomicBackup = Join-Path $atomicDirectory 'settings.json.backup-fixture'
  [IO.File]::WriteAllText($atomicTarget, '{"schema":1}', $utf8NoBom)
  [IO.File]::WriteAllText($atomicTemporary, '{"schema":2}', $utf8NoBom)
  [IO.File]::Replace($atomicTemporary, $atomicTarget, $atomicBackup, $true)
  $inheritedUsersRules = @((Get-Acl -LiteralPath $atomicTarget).GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | Where-Object {
    [string]$_.IdentityReference.Value -ceq 'S-1-5-32-545' -and [bool]$_.IsInherited -and
    $_.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow
  })
  $inheritedUsersRights = [Security.AccessControl.FileSystemRights]0
  foreach ($rule in $inheritedUsersRules) { $inheritedUsersRights = $inheritedUsersRights -bor $rule.FileSystemRights }
  Assert-True (($inheritedUsersRights -band [Security.AccessControl.FileSystemRights]::Read) -eq [Security.AccessControl.FileSystemRights]::Read) 'Same-directory atomic replacement did not inherit read access from the dedicated startup directory.'
  $expectedExecute = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $expectedArguments = '-NoProfile -File "fixture.ps1"'
  $expectedWorkingDirectory = $game
  $expectedAction = [pscustomobject]@{
    Execute = $expectedExecute; Arguments = $expectedArguments; WorkingDirectory = $expectedWorkingDirectory
  }
  $validTask = [pscustomobject]@{
    Description = 'DYSON_CONTROL_MANAGED_GAME_START_V1'; State = 'Ready'; Triggers = $null
    Actions = @($expectedAction); Principal = [pscustomobject]@{ UserId = $gameUserName; LogonType = 'Interactive'; RunLevel = 'Limited' }
  }
  $transientState = @{ calls = 0 }
  $transientEvidence = Join-Path $fixture 'task-registration-transient.json'
  $verifiedTask = Wait-ExactTaskRegistration {
    $transientState.calls++
    if ($transientState.calls -eq 1) {
      return [pscustomobject]@{
        Description = 'DYSON_CONTROL_MANAGED_GAME_START_V1'; State = 'Ready'; Triggers = $null
        Actions = $null; Principal = [pscustomobject]@{ UserId = $gameUserName; LogonType = 'Interactive'; RunLevel = 'Limited' }
      }
    }
    return $validTask
  } 'DYSON_CONTROL_MANAGED_GAME_START_V1' $expectedExecute $expectedArguments $expectedWorkingDirectory 'Interactive' 'Limited' `
    { param($actual, $expected) [string]$actual -ceq [string]$expected } `
    { param($principal) [string]$principal -ceq $gameUserName } $transientEvidence 3 0
  Assert-True ($verifiedTask -eq $validTask) 'Transient task registration visibility did not return the complete task.'
  Assert-True ($transientState.calls -eq 2) 'Transient task registration visibility was not retried exactly once.'
  $transientRecord = Get-Content -LiteralPath $transientEvidence -Raw -Encoding UTF8 | ConvertFrom-Json
  Assert-True (@($transientRecord.observations).Count -eq 2) 'Transient task registration evidence did not retain both observations.'
  Assert-True (-not [bool]$transientRecord.observations[0].actionComplete) 'Transient task registration evidence lost the incomplete state.'
  Assert-True ([bool]$transientRecord.observations[1].actionComplete) 'Transient task registration evidence lost the complete state.'
  Assert-True (-not ([IO.File]::ReadAllText($transientEvidence, $utf8NoBom)).Contains($expectedArguments)) 'Task registration evidence contains the task arguments.'

  $mismatchState = @{ calls = 0 }
  $mismatchEvidence = Join-Path $fixture 'task-registration-mismatch.json'
  $mismatchedAction = [pscustomobject]@{
    Execute = $expectedExecute; Arguments = '-NoProfile -File "wrong.ps1"'; WorkingDirectory = $expectedWorkingDirectory
  }
  $mismatchedTask = [pscustomobject]@{
    Description = 'DYSON_CONTROL_MANAGED_GAME_START_V1'; State = 'Ready'; Triggers = $null
    Actions = @($mismatchedAction); Principal = [pscustomobject]@{ UserId = $gameUserName; LogonType = 'Interactive'; RunLevel = 'Limited' }
  }
  $mismatchFailed = $false
  try {
    [void](Wait-ExactTaskRegistration {
      $mismatchState.calls++
      return $mismatchedTask
    } 'DYSON_CONTROL_MANAGED_GAME_START_V1' $expectedExecute $expectedArguments $expectedWorkingDirectory 'Interactive' 'Limited' `
      { param($actual, $expected) [string]$actual -ceq [string]$expected } `
      { param($principal) [string]$principal -ceq $gameUserName } $mismatchEvidence 3 0)
  }
  catch {
    $mismatchFailed = $_.Exception.Message -like '*failed post-registration verification*'
  }
  Assert-True $mismatchFailed 'A complete mismatched task registration was accepted.'
  Assert-True ($mismatchState.calls -eq 1) 'A complete mismatched task registration was retried.'
  $mismatchRecord = Get-Content -LiteralPath $mismatchEvidence -Raw -Encoding UTF8 | ConvertFrom-Json
  Assert-True (@($mismatchRecord.observations).Count -eq 1) 'Mismatch evidence did not retain the first observation.'
  Assert-True (-not [bool]$mismatchRecord.observations[0].argumentsMatch) 'Mismatch evidence did not record the argument failure.'

  $principalEvidence = Join-Path $fixture 'task-registration-principal-mismatch.json'
  $wrongPrincipalTask = [pscustomobject]@{
    Description = 'DYSON_CONTROL_MANAGED_GAME_START_V1'; State = 'Ready'; Triggers = $null
    Actions = @($expectedAction); Principal = [pscustomobject]@{ UserId = $gameUserName; LogonType = 'Interactive'; RunLevel = 'Highest' }
  }
  $principalFailed = $false
  try {
    [void](Wait-ExactTaskRegistration { return $wrongPrincipalTask } `
      'DYSON_CONTROL_MANAGED_GAME_START_V1' $expectedExecute $expectedArguments $expectedWorkingDirectory 'Interactive' 'Limited' `
      { param($actual, $expected) [string]$actual -ceq [string]$expected } `
      { param($principal) [string]$principal -ceq $gameUserName } $principalEvidence 1 0)
  }
  catch { $principalFailed = $_.Exception.Message -like '*failed post-registration verification*' }
  Assert-True $principalFailed 'Task verification accepted the wrong RunLevel.'
  $principalRecord = Get-Content -LiteralPath $principalEvidence -Raw -Encoding UTF8 | ConvertFrom-Json
  Assert-True ([string]$principalRecord.observations[0].runLevel -ceq 'mismatch') 'Task evidence did not record the RunLevel mismatch.'

  $implementation = [IO.File]::ReadAllText($script, $utf8NoBom) + [IO.File]::ReadAllText($pathPolicyScript, $utf8NoBom)
  $probeMatch = [regex]::Match($implementation, "(?ms)\`$probeSource = @'\r?\n(.*?)\r?\n'@")
  Assert-True $probeMatch.Success 'Unable to locate the disposable SYSTEM probe implementation.'
  $probeSource = $probeMatch.Groups[1].Value
  $probeTokens = $null
  $probeErrors = $null
  [void][Management.Automation.Language.Parser]::ParseInput($probeSource, [ref]$probeTokens, [ref]$probeErrors)
  Assert-True ($null -eq $probeErrors -or $probeErrors.Count -eq 0) 'The disposable SYSTEM probe script does not parse.'
  $probeId = [guid]::NewGuid().ToString('N')
  $probeScript = Join-Path $fixture 'probe-runtime.ps1'
  $probeResult = Join-Path $fixture 'probe-result.json'
  $probeSpecification = [ordered]@{
    directories = @([ordered]@{ label = 'fixture data'; path = $data })
    files = @([ordered]@{ label = 'fixture Bridge'; path = $sourceDll })
  }
  $encodedProbeSpecification = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($probeSpecification | ConvertTo-Json -Depth 5 -Compress)))
  [IO.File]::WriteAllText($probeScript, $probeSource, $utf8NoBom)
  & powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $probeScript `
    -ResultPath $probeResult -EncodedSpecification $encodedProbeSpecification -ProbeId $probeId
  Assert-True ($LASTEXITCODE -eq 0) 'The disposable path probe failed against fixture targets.'
  $probeOutcome = Get-Content -LiteralPath $probeResult -Raw -Encoding UTF8 | ConvertFrom-Json
  Assert-True ([bool]$probeOutcome.ok) 'The disposable path probe did not report success.'
  Assert-True (@(Get-ChildItem -LiteralPath $data -Force -Filter ".dyson-control-system-probe-$probeId").Count -eq 0) 'The disposable path probe left its directory behind.'

  $gameUserProbeMatch = [regex]::Match($implementation, "(?ms)\`$gameUserProbeSource = @'\r?\n(.*?)\r?\n'@")
  Assert-True $gameUserProbeMatch.Success 'Unable to locate the disposable GameUser probe implementation.'
  $gameUserProbeSource = $gameUserProbeMatch.Groups[1].Value
  $gameUserProbeTokens = $null
  $gameUserProbeErrors = $null
  $gameUserProbeAst = [Management.Automation.Language.Parser]::ParseInput($gameUserProbeSource, [ref]$gameUserProbeTokens, [ref]$gameUserProbeErrors)
  Assert-True ($null -eq $gameUserProbeErrors -or $gameUserProbeErrors.Count -eq 0) 'The disposable GameUser probe script does not parse.'

  $startTokens = $null
  $startErrors = $null
  $startAst = [Management.Automation.Language.Parser]::ParseFile($startScript, [ref]$startTokens, [ref]$startErrors)
  Assert-True ($null -eq $startErrors -or $startErrors.Count -eq 0) 'start-game.ps1 does not parse.'
  $accountSeparator = $gameUserName.IndexOf('\')
  Assert-True ($accountSeparator -gt 0 -and $accountSeparator -lt ($gameUserName.Length - 1)) 'Current Windows account is not domain-qualified.'
  $script:fixtureOwnerDomain = $gameUserName.Substring(0, $accountSeparator)
  $script:fixtureOwnerUser = $gameUserName.Substring($accountSeparator + 1)
  function Invoke-CimMethod {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][object]$InputObject, [Parameter(Mandatory = $true)][string]$MethodName)
    [pscustomobject]@{ ReturnValue = 0; Domain = $script:fixtureOwnerDomain; User = $script:fixtureOwnerUser }
  }
  try {
    foreach ($entry in @(
      [pscustomobject]@{ label = 'GameUser probe'; ast = $gameUserProbeAst },
      [pscustomobject]@{ label = 'managed start'; ast = $startAst }
    )) {
      $steamMatchFunction = $entry.ast.Find({
        param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Test-SteamProcessOwnerAndSession'
      }, $true)
      Assert-True ($null -ne $steamMatchFunction) "$($entry.label) does not define the Steam owner/session check."
      Invoke-Expression $steamMatchFunction.Extent.Text
      $matchingSession = [pscustomobject]@{ SessionId = 17 }
      $differentSession = [pscustomobject]@{ SessionId = 18 }
      Assert-True (Test-SteamProcessOwnerAndSession $matchingSession $gameUserSid 17) "$($entry.label) rejected matching Steam owner SID and SessionId."
      Assert-True (-not (Test-SteamProcessOwnerAndSession $differentSession $gameUserSid 17)) "$($entry.label) accepted same-owner Steam from another SessionId."
    }
  }
  finally { Remove-Item Function:\Invoke-CimMethod -ErrorAction SilentlyContinue }

  $gameUserProbeId = [guid]::NewGuid().ToString('N')
  $gameUserProbeScript = Join-Path $fixture 'game-user-probe-runtime.ps1'
  $gameUserProbeResult = Join-Path $fixture 'game-user-probe-result.json'
  $gameUserProbeSpecification = [ordered]@{
    expectedSid = $gameUserSid
    pathPolicyScript = $pathPolicyScript
    directories = @([ordered]@{ label = 'fixture data'; path = $data; access = 'modify' })
    files = @([ordered]@{ label = 'fixture Bridge'; path = $sourceDll })
    links = @([ordered]@{ label = 'UNC document link'; path = $uncLink; target = $uncTarget; linkType = 'SymbolicLink' })
  }
  $encodedGameUserProbeSpecification = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($gameUserProbeSpecification | ConvertTo-Json -Depth 6 -Compress)))
  [IO.File]::WriteAllText($gameUserProbeScript, $gameUserProbeSource, $utf8NoBom)
  & powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $gameUserProbeScript `
    -ResultPath $gameUserProbeResult -EncodedSpecification $encodedGameUserProbeSpecification -ProbeId $gameUserProbeId
  Assert-True ($LASTEXITCODE -eq 0) 'The disposable GameUser probe failed against fixture targets.'
  $gameUserProbeOutcome = Get-Content -LiteralPath $gameUserProbeResult -Raw -Encoding UTF8 | ConvertFrom-Json
  Assert-True ([bool]$gameUserProbeOutcome.ok) 'The disposable GameUser probe did not report success.'
  $gameUserProbeSpecification.links[0].path = $relativeUncLink
  $encodedGameUserProbeSpecification = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($gameUserProbeSpecification | ConvertTo-Json -Depth 6 -Compress)))
  & powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $gameUserProbeScript `
    -ResultPath $gameUserProbeResult -EncodedSpecification $encodedGameUserProbeSpecification -ProbeId $gameUserProbeId
  $rejectedProbe = Get-Content -LiteralPath $gameUserProbeResult -Raw -Encoding UTF8 | ConvertFrom-Json
  Assert-True (-not [bool]$rejectedProbe.ok -and [string]$rejectedProbe.error -like '*unexpected link target*') 'The GameUser probe accepted a relative UNC-looking target.'
  $gameUserProbeSpecification.links[0].path = $uncLink
  $gameUserProbeSpecification.directories[0].path = Join-Path $fixture 'missing-save-directory'
  $encodedGameUserProbeSpecification = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($gameUserProbeSpecification | ConvertTo-Json -Depth 6 -Compress)))
  & powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $gameUserProbeScript `
    -ResultPath $gameUserProbeResult -EncodedSpecification $encodedGameUserProbeSpecification -ProbeId $gameUserProbeId
  $rejectedAccess = Get-Content -LiteralPath $gameUserProbeResult -Raw -Encoding UTF8 | ConvertFrom-Json
  Assert-True (-not [bool]$rejectedAccess.ok) 'A failed GameUser directory-access check was accepted.'
  Assert-True (@(Get-ChildItem -LiteralPath $data -Force -Filter ".dyson-control-game-user-probe-$gameUserProbeId").Count -eq 0) 'The disposable GameUser probe left its directory behind.'

  foreach ($forbidden in @('New-SmbGlobalMapping', 'New-PSDrive', 'cmdkey.exe', 'PSCredential', 'AutoAdminLogon', 'DefaultPassword', 'LsaStorePrivateData', '-LogonType Password')) {
    Assert-True (-not $implementation.Contains($forbidden)) "Path support contains forbidden mapping or credential operation: $forbidden"
  }

  'CONFIGURE_GAME_FIXTURE_OK'
}
finally {
  foreach ($link in $fixtureLinks) {
    $absoluteLink = [IO.Path]::GetFullPath($link)
    if (-not $absoluteLink.StartsWith(([IO.Path]::GetFullPath($fixture) + '\'), [StringComparison]::OrdinalIgnoreCase)) { throw 'Fixture link cleanup escaped the temporary root.' }
    $linkItem = Get-Item -LiteralPath $absoluteLink -Force -ErrorAction SilentlyContinue
    if ($linkItem -and ($linkItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) { [IO.Directory]::Delete($absoluteLink, $false) }
  }
  if (Test-Path -LiteralPath $fixture) {
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    & (Join-Path $env:SystemRoot 'System32\icacls.exe') $fixture '/grant:r' "*$sid`:(F)" '/T' '/C' | Out-Null
    Remove-Item -LiteralPath $fixture -Recurse -Force
  }
}
