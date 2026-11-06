$ErrorActionPreference = 'Stop'
$implementation = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\windows'))
$temporaryRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$root = Join-Path $temporaryRoot ('dyson-adopt-mock-' + [guid]::NewGuid().ToString('N'))
$utf8NoBom = [Text.UTF8Encoding]::new($false)
function Assert([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function ScriptAst([string]$File) {
  $tokens = $null; $errors = $null
  $tree = [Management.Automation.Language.Parser]::ParseFile($File, [ref]$tokens, [ref]$errors)
  if ($errors.Count) { throw 'Fixture source did not parse.' }
  return $tree
}
function Definition([object]$Tree, [string]$Name) {
  $node = $Tree.Find({ param($item) $item -is [Management.Automation.Language.FunctionDefinitionAst] -and $item.Name -ceq $Name }, $true)
  if (-not $node) { throw "Missing function: $Name" }
  return $node.Extent
}

$source = ScriptAst (Join-Path $implementation 'configure-game.ps1')
foreach ($name in @('Get-FullPath','Get-PlainFile','Assert-StartupSettings','Get-OptionalFileHash','Get-ExistingServerReview','Assert-ExistingHost','Assert-ReviewedReferences','Register-GameStartTask','Restore-GameTaskOnFailure')) {
  . ([scriptblock]::Create((Definition $source $name).Text))
}
# Every scheduler, process and identity interaction below is in-memory.
$script:tasks = @(); $script:processes = @(); $script:applied = 0; $script:enabled = 0
function Get-ScheduledTask { return $script:tasks }
function Get-CimInstance([string]$ClassName, [string]$Filter) {
  if ($Filter -like '*steam.exe*') { return [pscustomobject]@{ SessionId = 2 } }
  return $script:processes
}
function Invoke-CimMethod { return [pscustomobject]@{ ReturnValue = 0; Sid = 'fixture-sid' } }
function ConvertTo-DysonCanonicalPath([string]$Value) { return [IO.Path]::GetFullPath($Value) }
function Register-ScheduledTask { param($TaskName,$TaskPath,$InputObject,[switch]$Force)
  Assert (-not $Force) 'Adoption attempted to force replacement.'
  if ($script:tasks.Count) { throw 'Mock task collision.' }; $script:applied++
}
function Unregister-ScheduledTask { throw 'Task deletion must never be called.' }
function Start-ScheduledTask { throw 'A real task must never be started.' }
function Export-ScheduledTask { return $script:taskXml }
function Enable-ScheduledTask { $script:enabled++ }

try {
  [void][IO.Directory]::CreateDirectory($root)
  $cfg = [pscustomobject]@{ GameRoot = $root; StartTaskName = 'Mock Game'; DataDirectory = $root }
  $user = [pscustomobject]@{ Sid = 'fixture-sid' }
  Assert-ExistingHost $cfg $user
  $script:processes = @([pscustomobject]@{ ExecutablePath = $null })
  $failure = ''; try { Assert-ExistingHost $cfg $user } catch { $failure = $_.Exception.Message }
  Assert ($failure -ceq 'ADOPT_HOST_BUSY') 'An obscured DSP process was accepted.'
  $script:processes = @()
  $script:tasks = @([pscustomobject]@{ TaskName = 'mock game'; TaskPath = '\another'; State = 'Ready' })
  $failure = ''; try { Assert-ExistingHost $cfg $user } catch { $failure = $_.Exception.Message }
  Assert ($failure -ceq 'ADOPT_TASK_EXISTS') 'Non-root collision was missed.'
  $script:tasks[0].TaskPath = '\'
  $failure = ''; try { Register-GameStartTask 'Mock Game' ([pscustomobject]@{}) -RequireNewTask } catch { $failure = $_.Exception.Message }
  Assert ($failure -ceq 'Mock task collision.' -and $script:applied -eq 0) 'Late collision replaced a task.'
  $failure = ''; try { Restore-GameTaskOnFailure 'Mock Game' '' } catch { $failure = $_.Exception.Message }
  Assert ($failure -like '*retained for manual review*') 'An unverified task was not retained.'
  $original = '<Task><RegistrationInfo><Description>original</Description></RegistrationInfo><Settings><Enabled>true</Enabled></Settings></Task>'
  $script:taskXml = $original.Replace('original','other').Replace('true','false')
  $script:tasks[0].State = 'Disabled'
  $failure = ''; try { Restore-GameTaskOnFailure 'Mock Game' $original } catch { $failure = $_.Exception.Message }
  Assert ($failure -like '*Changed task definition*' -and $script:enabled -eq 0) 'Rollback enabled a foreign task.'
  $script:taskXml = $original.Replace('true','false')
  Restore-GameTaskOnFailure 'Mock Game' $original
  Assert ($script:enabled -eq 1) 'A verified original definition was not re-enabled.'
  $script:tasks = @()

  $target = Join-Path $root 'old.cfg'; [IO.File]::WriteAllText($target,'original')
  $plan = [pscustomobject]@{
    bridge = [ordered]@{ dllTarget = (Join-Path $root 'bridge.dll'); configTarget = $target; sourceSha256 = ('c' * 64); secretAction = 'create' }
    startupSettings = @{ path = (Join-Path $root 'startup.json') }; task = @{ sid='fixture-sid' }; access = @{ changes=@('one'); existingAccessChecks=@() }
    documentBinding = @{ linkType='Junction' }
  }
  $layout = [pscustomobject]@{ LinkPath=$null }
  $initial = Get-ExistingServerReview $plan $cfg $layout
  [IO.File]::WriteAllText((Join-Path $root 'bridge-secret.new'),'changing candidate')
  $same = Get-ExistingServerReview $plan $cfg $layout
  Assert ($same.reviewHash -ceq $initial.reviewHash -and $same.bridgeDll -ceq 'create' -and $same.bridgeConfig -ceq 'replace') 'Unapplied candidate changed the review.'
  [IO.File]::WriteAllText($target,'changed')
  Assert ((Get-ExistingServerReview $plan $cfg $layout).reviewHash -cne $initial.reviewHash) 'Changed Bridge config did not invalidate the review.'
  $assemblies = Join-Path $root 'BepInEx\plugins'; [void][IO.Directory]::CreateDirectory($assemblies)
  $refs = @(foreach ($index in 1..9) {
    $file = Join-Path $assemblies ("ref$index.dll"); [IO.File]::WriteAllText($file,"content$index")
    [pscustomobject]@{ file="BepInEx/plugins/ref$index.dll"; bytes=(Get-Item $file).Length; sha256=(Get-FileHash $file -Algorithm SHA256).Hash.ToLowerInvariant() }
  })
  Assert-ReviewedReferences $root $refs
  [IO.File]::WriteAllText((Join-Path $assemblies 'ref3.dll'),'newvalue')
  $failure = ''; try { Assert-ReviewedReferences $root $refs } catch { $failure = $_.Exception.Message }
  Assert ($failure -ceq 'ADOPT_PLAN_CHANGED') 'Reference changed during access probes but passed final verification.'

  # Keep the actual fixed-argument wrapper, substituting only the OS ACL boundary and configurator.
  $wrapper = Join-Path $implementation 'configure-existing-server.ps1'
  $wrapperText = [IO.File]::ReadAllText($wrapper)
  $acl = Definition (ScriptAst $wrapper) 'Get-PrivatePlanDirectory'
  $mockAcl = 'function Get-PrivatePlanDirectory([string]$Directory,[bool]$Create) { if($Create){[void][IO.Directory]::CreateDirectory($Directory)} }'
  [IO.File]::WriteAllText((Join-Path $root 'wrapper.ps1'),$wrapperText.Replace($acl.Text,$mockAcl),$utf8NoBom)
  [IO.File]::WriteAllText((Join-Path $root 'path-policy.ps1'),'# fixture',$utf8NoBom)
  $mockConfigurator = @'
param($ConfigPath,$BridgeBuildDirectory,$BridgeSha256,$GameUser,[switch]$ReviewExisting,[switch]$RequireNewTask,[switch]$PrepareOnly,$OutputDirectory,[switch]$ConfirmStopped,$ExpectedReviewHash,$ReviewedReferences)
if (-not $ReviewExisting -or -not $RequireNewTask -or $GameUser -cne 'Fixture' -or -not (Test-Path -LiteralPath $ConfigPath)) { throw 'Unexpected invocation' }
if ($PrepareOnly -and -not $ConfirmStopped -and $OutputDirectory -and -not $ExpectedReviewHash) {
  [ordered]@{prepared=$true;targetChanged=$false;privateDetails='never public';review=@{reviewHash=('a'*64);bridgeSha256=$BridgeSha256;bridgeDll='replace';bridgeConfig='create';secret='retain';startup='create';accessChanges=1;existingAccessChecks=0}} | ConvertTo-Json -Compress
} elseif ($ConfirmStopped -and -not $PrepareOnly -and -not $OutputDirectory -and $ExpectedReviewHash -ceq ('a'*64)) {
  [ordered]@{configured=$true;taskStarted=$false;savesMoved=$false;taskName='Mock Game';bridgeSha256=$BridgeSha256;privateDetails='never public'} | ConvertTo-Json -Compress
} else { throw 'Unexpected switches' }
'@
  [IO.File]::WriteAllText((Join-Path $root 'configure-game.ps1'),$mockConfigurator,$utf8NoBom)
  $request = [ordered]@{mode='prepare';planId=[guid]::NewGuid().ToString();config=@{dataDirectory=$root};bridgeDirectory=$root;bridgeSha256=('c'*64);gameUser='Fixture'}
  $arguments = Join-Path $root 'arguments.json'
  [IO.File]::WriteAllText($arguments,($request|ConvertTo-Json -Depth 4),$utf8NoBom)
  $output = & (Join-Path $root 'wrapper.ps1') -ArgumentsPath $arguments
  Assert (($output|ConvertFrom-Json).prepared -and $output -notmatch 'never public') 'Wrapper preview was not confirmed.'
  $request.mode = 'apply'; $request.reviewHash = 'a'*64
  [IO.File]::WriteAllText($arguments,($request|ConvertTo-Json -Depth 4),$utf8NoBom)
  $output = & (Join-Path $root 'wrapper.ps1') -ArgumentsPath $arguments
  Assert (($output|ConvertFrom-Json).configured -and $output -notmatch 'never public') 'Wrapper apply was not confirmed.'

  # Exercise the real prepare entry and the apply drift gate with OS identities/scheduling isolated.
  $real = [IO.File]::ReadAllText((Join-Path $implementation 'configure-game.ps1'))
  $real = $real.Replace((Definition $source 'Resolve-GameUser').Text, 'function Resolve-GameUser { return [pscustomobject]@{Account="Fixture";Sid="fixture-sid"} }')
  $global:DysonAdoptFixtureReachedApply = $false
  $real = $real.Replace((Definition $source 'Assert-Administrator').Text, 'function Assert-Administrator { $global:DysonAdoptFixtureReachedApply = $true; throw "Fixture apply reached mutation boundary." }')
  $real = $real.Replace((Definition $source 'Protect-SystemAdministratorsOnly').Text, 'function Protect-SystemAdministratorsOnly { }')
  $osFixture = @'

function Get-ScheduledTask { }
function Get-SmbGlobalMapping { }
function Get-CimInstance($ClassName, $Filter) { if ($Filter -like '*steam.exe*') { [pscustomobject]@{ SessionId=2 } } }
function Invoke-CimMethod { [pscustomobject]@{ReturnValue=0;Sid='fixture-sid'} }
function Register-ScheduledTask { throw 'Unexpected task mutation.' }
function Start-ScheduledTask { throw 'Unexpected task execution.' }
function Unregister-ScheduledTask { throw 'Unexpected task removal.' }

'@
  $real = $real.Insert($source.ParamBlock.Extent.EndOffset,$osFixture)
  [IO.File]::WriteAllText((Join-Path $root 'configure-game.ps1'),$real,$utf8NoBom)
  [IO.File]::Copy((Join-Path $implementation 'path-policy.ps1'),(Join-Path $root 'path-policy.ps1'),$true)
  [IO.File]::WriteAllText((Join-Path $root 'start-game.ps1'),'# unused fixture script',$utf8NoBom)
  function Get-SmbGlobalMapping { return @() }
  $game = Join-Path $root 'game'; $data = Join-Path $root 'control'; $save = Join-Path $root 'custom-saves'
  $pluginDir = Join-Path $game 'BepInEx\plugins'; $configDir = Join-Path $game 'BepInEx\config'
  foreach ($dir in @($pluginDir,$configDir,$data,$save,(Join-Path $root 'backups'))) { [void][IO.Directory]::CreateDirectory($dir) }
  [IO.File]::WriteAllText((Join-Path $root 'DysonControlBridge.dll'),'fixture')
  [IO.File]::WriteAllText((Join-Path $save 'World.dsv'),'unmodified world')
  $request = [ordered]@{mode='prepare';planId=[guid]::NewGuid().ToString();gameUser='Fixture';bridgeDirectory=$root
    bridgeSha256=(Get-FileHash -LiteralPath (Join-Path $root 'DysonControlBridge.dll') -Algorithm SHA256).Hash.ToLowerInvariant()
    config=@{dataDirectory=$data;game=@{root=$game;saveDirectory=$save;backupDirectory=(Join-Path $root 'backups');logFile=(Join-Path $game 'LogOutput.log')
      bridgeDirectory=(Join-Path $root 'bridge');bridgeSecretFile=(Join-Path $root 'private\secret');startTaskName='Mock Game'}}}
  [IO.File]::WriteAllText($arguments,($request|ConvertTo-Json -Depth 4),$utf8NoBom)
  $review = (& (Join-Path $root 'wrapper.ps1') -ArgumentsPath $arguments) | ConvertFrom-Json
  if (-not $review.prepared) { throw ('Fixture preview failed: ' + $review.errorCode) }
  Assert ($review.reviewHash -match '^[a-f0-9]{64}$' -and $review.secret -ceq 'create' -and $review.startup -ceq 'create') 'Real configure-game preview did not produce a review.'
  $request.mode = 'apply'; $request.reviewHash = $review.reviewHash
  [IO.File]::WriteAllText($arguments,($request|ConvertTo-Json -Depth 4),$utf8NoBom)
  $unchanged = (& (Join-Path $root 'wrapper.ps1') -ArgumentsPath $arguments) | ConvertFrom-Json
  Assert ($unchanged.errorCode -ceq 'ADOPT_CONFIG_FAILED' -and $global:DysonAdoptFixtureReachedApply) 'Unchanged plan did not reach the isolated mutation boundary.'
  $global:DysonAdoptFixtureReachedApply = $false
  [IO.File]::WriteAllText((Join-Path $configDir 'net.miyuo.dyson-control.bridge.cfg'),'changed meanwhile')
  $changed = (& (Join-Path $root 'wrapper.ps1') -ArgumentsPath $arguments) | ConvertFrom-Json
  Assert ($changed.errorCode -ceq 'ADOPT_PLAN_CHANGED' -and -not $global:DysonAdoptFixtureReachedApply) 'Real configure-game did not reject the changed target.'
  Assert ([IO.File]::ReadAllText((Join-Path $save 'World.dsv')) -ceq 'unmodified world') 'Preview or rejected apply modified a save.'
  'EXISTING_SERVER_MOCK_OK'
} finally {
  $resolved = [IO.Path]::GetFullPath($root)
  if ([IO.Path]::GetDirectoryName($resolved).TrimEnd('\') -cne $temporaryRoot.TrimEnd('\') -or [IO.Path]::GetFileName($resolved) -notmatch '^dyson-adopt-mock-[a-f0-9]{32}$') { throw 'Unexpected fixture cleanup path.' }
  if (Test-Path -LiteralPath $resolved) { Remove-Item -LiteralPath $resolved -Recurse -Force }
}
