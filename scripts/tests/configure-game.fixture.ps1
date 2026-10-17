$ErrorActionPreference = 'Stop'
$temporaryRoot = if ([string]::IsNullOrWhiteSpace($env:RUNNER_TEMP)) { $env:TEMP } else { $env:RUNNER_TEMP }
$fixture = Join-Path $temporaryRoot ('dyson-control-configure-game-' + [guid]::NewGuid().ToString('N'))
$script = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\windows\configure-game.ps1'))
$pathPolicyScript = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\windows\path-policy.ps1'))
$utf8NoBom = [Text.UTF8Encoding]::new($false)

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
    -ConfigPath $ConfigPath -BridgeBuildDirectory $BuildPath -BridgeSha256 $Hash -PrepareOnly -OutputDirectory $OutputPath
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
    -ConfigPath $configPath -BridgeBuildDirectory $build -BridgeSha256 $sourceHash 2>&1
  $guardExitCode = $LASTEXITCODE
  $ErrorActionPreference = $previousErrorPreference
  Assert-True ($guardExitCode -ne 0) 'Apply mode succeeded without ConfirmStopped.'
  Assert-True (($guardOutput -join "`n") -like '*Apply mode requires -ConfirmStopped*') 'Apply guard returned the wrong failure.'
  Assert-True ([IO.File]::ReadAllText($targetDll, $utf8NoBom) -ceq 'old-dll-sentinel') 'Apply guard changed the target DLL.'
  Assert-True ([IO.File]::ReadAllText($targetConfig, $utf8NoBom) -ceq 'old-config-sentinel') 'Apply guard changed the target config.'

  $wrongHashOutput = Join-Path $fixture 'wrong-hash-output'
  $ErrorActionPreference = 'Continue'
  $hashFailure = & powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $script `
    -ConfigPath $configPath -BridgeBuildDirectory $build -BridgeSha256 ('0' * 64) -PrepareOnly -OutputDirectory $wrongHashOutput 2>&1
  $hashExitCode = $LASTEXITCODE
  $ErrorActionPreference = $previousErrorPreference
  Assert-True ($hashExitCode -ne 0) 'Prepare mode accepted the wrong Bridge hash.'
  Assert-True (($hashFailure -join "`n") -like '*does not match BridgeSha256*') 'Wrong-hash guard returned the wrong failure.'
  Assert-True (-not (Test-Path -LiteralPath $wrongHashOutput)) 'Wrong-hash guard created prepare output.'

  $firstOutput = Join-Path $fixture 'prepared-new-secret'
  $firstPlan = Invoke-Prepare $configPath $build $sourceHash $firstOutput
  Assert-True ([string]$firstPlan.mode -ceq 'prepare-only') 'Plan mode is not prepare-only.'
  Assert-True ([string]$firstPlan.bridge.secretAction -ceq 'create') 'Missing secret did not produce a create action.'
  Assert-True ([string]$firstPlan.bridge.secretCandidate -ceq 'bridge-secret.new') 'Secret candidate was not recorded by file name.'
  Assert-True (-not (Test-Path -LiteralPath $secretFile)) 'Prepare mode created the target secret.'
  Assert-True (-not (Test-Path -LiteralPath (Join-Path $data 'game-startup.json'))) 'Prepare mode created target startup settings.'
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
  Assert-True ([string]$firstPlan.task.account -ceq 'SYSTEM') 'Plan task account is not SYSTEM.'
  Assert-True (-not [bool]$firstPlan.task.startImmediately) 'Plan would start the game immediately.'
  Assert-True (@($firstPlan.pathPolicy.localNtfs) -contains 'dataDirectory') 'Plan does not keep dataDirectory on local NTFS.'
  Assert-True (@($firstPlan.pathPolicy.localNtfs) -contains 'game.bridgeSecretFile') 'Plan does not keep the Bridge secret on local NTFS.'
  Assert-True (@($firstPlan.pathPolicy.localNtfs) -contains 'managed path policy') 'Plan does not keep the managed path helper on local NTFS.'
  Assert-True (@($firstPlan.pathPolicy.globalSmbEligible) -contains 'game.root') 'Plan does not identify game.root as global-SMB eligible.'
  Assert-True (@($firstPlan.pathPolicy.globalSmbEligible) -contains 'game.saveDirectory') 'Plan does not identify game.saveDirectory as global-SMB eligible.'
  Assert-True ([string]$firstPlan.pathPolicy.globalSmbRequirement -like '*Get-SmbGlobalMapping*no mapping or credentials*') 'Plan does not state the existing-global-mapping boundary.'
  Assert-True ([string]$firstPlan.pathPolicy.applyProbe -like '*SYSTEM*create/write/read/rename/delete*') 'Plan does not state the apply-time SYSTEM probe.'
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
  Assert-True ([IO.Path]::GetFullPath((Get-TaskOption $contents '-SettingsPath')).Equals((Join-Path $data 'game-startup.json'), [StringComparison]::OrdinalIgnoreCase)) 'Task does not use the fixed dataDirectory startup settings path.'
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
  $expectedExecute = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $expectedArguments = '-NoProfile -File "fixture.ps1"'
  $expectedWorkingDirectory = $game
  $expectedAction = [pscustomobject]@{
    Execute = $expectedExecute; Arguments = $expectedArguments; WorkingDirectory = $expectedWorkingDirectory
  }
  $validTask = [pscustomobject]@{
    Description = 'DYSON_CONTROL_MANAGED_GAME_START_V1'; State = 'Ready'; Triggers = $null
    Actions = @($expectedAction); Principal = [pscustomobject]@{ UserId = 'SYSTEM' }
  }
  $transientState = @{ calls = 0 }
  $transientEvidence = Join-Path $fixture 'task-registration-transient.json'
  $verifiedTask = Wait-ExactTaskRegistration {
    $transientState.calls++
    if ($transientState.calls -eq 1) {
      return [pscustomobject]@{
        Description = 'DYSON_CONTROL_MANAGED_GAME_START_V1'; State = 'Ready'; Triggers = $null
        Actions = $null; Principal = [pscustomobject]@{ UserId = 'SYSTEM' }
      }
    }
    return $validTask
  } 'DYSON_CONTROL_MANAGED_GAME_START_V1' $expectedExecute $expectedArguments $expectedWorkingDirectory `
    { param($actual, $expected) [string]$actual -ceq [string]$expected } `
    { param($principal) [string]$principal -ceq 'SYSTEM' } $transientEvidence 3 0
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
    Actions = @($mismatchedAction); Principal = [pscustomobject]@{ UserId = 'SYSTEM' }
  }
  $mismatchFailed = $false
  try {
    [void](Wait-ExactTaskRegistration {
      $mismatchState.calls++
      return $mismatchedTask
    } 'DYSON_CONTROL_MANAGED_GAME_START_V1' $expectedExecute $expectedArguments $expectedWorkingDirectory `
      { param($actual, $expected) [string]$actual -ceq [string]$expected } `
      { param($principal) [string]$principal -ceq 'SYSTEM' } $mismatchEvidence 3 0)
  }
  catch {
    $mismatchFailed = $_.Exception.Message -like '*failed post-registration verification*'
  }
  Assert-True $mismatchFailed 'A complete mismatched task registration was accepted.'
  Assert-True ($mismatchState.calls -eq 1) 'A complete mismatched task registration was retried.'
  $mismatchRecord = Get-Content -LiteralPath $mismatchEvidence -Raw -Encoding UTF8 | ConvertFrom-Json
  Assert-True (@($mismatchRecord.observations).Count -eq 1) 'Mismatch evidence did not retain the first observation.'
  Assert-True (-not [bool]$mismatchRecord.observations[0].argumentsMatch) 'Mismatch evidence did not record the argument failure.'

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
  foreach ($forbidden in @('New-SmbGlobalMapping', 'New-PSDrive', 'cmdkey.exe', 'PSCredential')) {
    Assert-True (-not $implementation.Contains($forbidden)) "Path support contains forbidden mapping or credential operation: $forbidden"
  }

  'CONFIGURE_GAME_FIXTURE_OK'
}
finally {
  if (Test-Path -LiteralPath $fixture) {
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    & (Join-Path $env:SystemRoot 'System32\icacls.exe') $fixture '/grant:r' "*$sid`:(F)" '/T' '/C' | Out-Null
    Remove-Item -LiteralPath $fixture -Recurse -Force
  }
}
