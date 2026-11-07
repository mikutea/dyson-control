$ErrorActionPreference = 'Stop'
$windows = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\windows'))
$temp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$root = Join-Path $temp ('dyson-game-task-mock-' + [guid]::NewGuid().ToString('N'))
$utf8 = [Text.UTF8Encoding]::new($false)
function Assert([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Failure([scriptblock]$Action) { try { &$Action | Out-Null; return '' } catch { return $_.Exception.Message } }
function Task([string]$Name, [string]$Folder) {
  return [pscustomobject]@{ TaskName=$Name; TaskPath=$Folder; State='Ready'; Description='DYSON_CONTROL_MANAGED_GAME_START_V1'
    Actions=@([pscustomobject]@{Execute='custom';Arguments='';WorkingDirectory=''}); Triggers=@() }
}
$global:DysonTaskSelectionFixture = [pscustomobject]@{ tasks=@(); starts=@(); registrations=0; deny=$false; lastForce=$false; xml='<Task><Settings><Enabled>true</Enabled></Settings></Task>' }
function Get-ScheduledTask { if ($global:DysonTaskSelectionFixture.deny) { throw 'synthetic denied' }; return $global:DysonTaskSelectionFixture.tasks }
function Start-ScheduledTask($InputObject) { $global:DysonTaskSelectionFixture.starts += $InputObject }
function Export-ScheduledTask { return $global:DysonTaskSelectionFixture.xml }
function Register-ScheduledTask($TaskName,$TaskPath,$InputObject,[switch]$Force) {
  if ($TaskName -cne 'Fixture Game' -or $TaskPath -cne '\') { throw 'Unexpected fixture registration.' }
  $global:DysonTaskSelectionFixture.registrations++; $global:DysonTaskSelectionFixture.lastForce=$Force.IsPresent
}
function Unregister-ScheduledTask { throw 'Unexpected task deletion.' }
function Disable-ScheduledTask { throw 'Unexpected task disable.' }
function Get-CimInstance { return @() }
function Get-SmbGlobalMapping { }
function Get-NetAdapter { }
function Get-LocalUser { }

try {
  [void][IO.Directory]::CreateDirectory($root)
  $name = 'Fixture Game'
  $game = Join-Path $root 'game'; $save = Join-Path $root 'saves'; $data = Join-Path $root 'data'
  $config = [ordered]@{dataDirectory=$data;game=@{root=$game;saveDirectory=$save;backupDirectory=(Join-Path $root 'backups');logFile=(Join-Path $game 'logs\game.log')
    bridgeDirectory=(Join-Path $root 'bridge');bridgeSecretFile=(Join-Path $root 'private\secret');startTaskName=$name}}
  foreach ($folder in @($data,$save,$config.game.backupDirectory,(Join-Path $game 'BepInEx\plugins'))) { [void][IO.Directory]::CreateDirectory($folder) }
  [IO.File]::WriteAllText((Join-Path $game 'DSPGAME.exe'),'fixture game only')
  [IO.File]::WriteAllText((Join-Path $root 'DysonControlBridge.dll'),'fixture bridge only')
  [IO.File]::WriteAllText((Join-Path $root 'start-game.ps1'),'# fixture script')
  $configPath=Join-Path $root 'config.json'; [IO.File]::WriteAllText($configPath,($config|ConvertTo-Json -Depth 4),$utf8)
  $hash = (Get-FileHash -LiteralPath (Join-Path $root 'DysonControlBridge.dll') -Algorithm SHA256).Hash.ToLowerInvariant()
  $argumentsPath = Join-Path $root 'arguments.json'
  $inputData = @{taskName=$name;startTaskName=$name;gameRoot=$game;configPath=$configPath;bridgeDirectory=$root;bridgeSha256=$hash;gameUser='Fixture'}
  [IO.File]::WriteAllText($argumentsPath,($inputData|ConvertTo-Json),$utf8)
  foreach ($script in @('game-task.ps1','path-policy.ps1','configure-new-server.ps1')) {
    [IO.File]::Copy((Join-Path $windows $script),(Join-Path $root $script))
  }
  # Isolate only Windows identity/elevation and the boundary where real ACL/task probes would begin.
  $source=Join-Path $windows 'configure-game.ps1'; $text=[IO.File]::ReadAllText($source)
  $tokens=$null; $parseErrors=$null
  $ast=[Management.Automation.Language.Parser]::ParseFile($source,[ref]$tokens,[ref]$parseErrors)
  Assert ($parseErrors.Count -eq 0) 'Configurator did not parse.'
  $mocks=@{ResolveGameUser='function Resolve-GameUser { return [pscustomobject]@{Account="Fixture";Sid="fixture-sid"} }'
    AssertAdministrator='function Assert-Administrator { }'; InvokeSystemPathProbe='function Invoke-SystemPathProbe { throw "Fixture mutation boundary reached." }'}
  foreach ($key in @('Resolve-GameUser','Assert-Administrator','Invoke-SystemPathProbe')) {
    $fn=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $key},$true)
    $text=$text.Replace($fn.Extent.Text,$mocks[$key.Replace('-','')])
  }
  [IO.File]::WriteAllText((Join-Path $root 'configure-game.ps1'),$text,$utf8)
  $configureArgs=@{ConfigPath=$configPath;BridgeBuildDirectory=$root;BridgeSha256=$hash;GameUser='Fixture'}
  $invoke=Join-Path $windows 'invoke-scheduled-task.ps1'; $inspect=Join-Path $windows 'inspect-game.ps1'
  $setup=Join-Path $windows 'inspect-server-setup.ps1'; $configure=Join-Path $root 'configure-game.ps1'

  $global:DysonTaskSelectionFixture.tasks=@((Task $name '\custom'))
  $observed=(& $inspect -ArgumentsPath $argumentsPath)|ConvertFrom-Json
  Assert ($observed.tasks.start -and -not $observed.tasks.startManaged -and $global:DysonTaskSelectionFixture.starts.Count -eq 0) 'Unique custom task was not observable without invoking it.'
  $receipt=(& $invoke -ArgumentsPath $argumentsPath)|ConvertFrom-Json
  Assert ($receipt.invoked -and $global:DysonTaskSelectionFixture.starts.Count -eq 1 -and $global:DysonTaskSelectionFixture.starts[0].TaskPath -ceq '\custom') 'Unique manual task was not invoked by its instance.'
  $setupInfo=(& $setup -ArgumentsPath $argumentsPath)|ConvertFrom-Json
  Assert $setupInfo.taskExists 'First installation missed a uniquely named non-root task.'
  $preview=Join-Path $root 'plan'
  Assert ((Failure { & $configure @configureArgs -PrepareOnly -OutputDirectory $preview }) -like '*outside the root*') 'Regular prepare accepted a non-root collision.'
  Assert ((Failure { & $configure @configureArgs -ConfirmStopped }) -like '*outside the root*') 'Regular apply accepted a non-root collision.'
  Assert ((Failure { & (Join-Path $root 'configure-new-server.ps1') -ArgumentsPath $argumentsPath }) -like '*outside the root*') 'First install passed a non-root collision to the configurator.'
  $global:DysonTaskSelectionFixture.tasks=@((Task 'Fixture Game Extra' '\'),(Task $name '\'))
  $receipt=(& $invoke -ArgumentsPath $argumentsPath)|ConvertFrom-Json
  Assert ($receipt.invoked -and $global:DysonTaskSelectionFixture.starts[1].TaskPath -ceq '\') 'A unique root task was not selected by its exact name.'
  foreach ($variant in @('duplicate','case-duplicate','wrong-case')) {
    $global:DysonTaskSelectionFixture.tasks = if ($variant -eq 'duplicate') { @((Task $name '\'),(Task $name '\other')) }
      elseif ($variant -eq 'case-duplicate') { @((Task $name '\'),(Task $name.ToLowerInvariant() '\other')) }
      else { @((Task $name.ToLowerInvariant() '\')) }
    $expected = if ($variant -eq 'wrong-case') { '*letter case*' } else { '*Multiple scheduled tasks*' }
    $observed=(& $inspect -ArgumentsPath $argumentsPath)|ConvertFrom-Json
    Assert (-not $observed.tasks.start -and -not $observed.tasks.startManaged -and $observed.tasks.startIssue -like $expected -and $null -ne $observed.versions) 'Observation lost host state or offered an ambiguous start.'
    Assert ((Failure { & $invoke -ArgumentsPath $argumentsPath }) -like $expected) 'Ambiguous invocation did not report the exact problem.'
    Assert ((Failure { & $configure @configureArgs -PrepareOnly -OutputDirectory $preview }) -like $expected) 'Prepare failed to report a name conflict.'
    Assert ((Failure { & $configure @configureArgs -ConfirmStopped }) -like $expected) 'Apply failed to report a name conflict.'
    Assert (-not (Test-Path -LiteralPath $preview) -and -not (Test-Path -LiteralPath (Join-Path $data 'game-configuration-backups'))) 'A conflict changed configuration targets.'
  }
  $global:DysonTaskSelectionFixture.tasks=@()
  Assert (-not ((& $inspect -ArgumentsPath $argumentsPath)|ConvertFrom-Json).tasks.start) 'Missing task was advertised as available.'
  Assert ((Failure { & $invoke -ArgumentsPath $argumentsPath }) -like '*not found*') 'A missing task was not identified.'
  $global:DysonTaskSelectionFixture.deny=$true
  $observed=(& $inspect -ArgumentsPath $argumentsPath)|ConvertFrom-Json
  Assert (-not $observed.tasks.start -and $observed.tasks.startIssue -like '*permissions*') 'Unreadable scheduler unexpectedly allowed startup.'
  Assert ((Failure { & $invoke -ArgumentsPath $argumentsPath }) -like '*permissions*') 'Unreadable scheduler did not block invocation.'
  Assert ($global:DysonTaskSelectionFixture.starts.Count -eq 2 -and $global:DysonTaskSelectionFixture.registrations -eq 0) 'An ambiguous task was invoked or mutated.'

  # Execute the configurator's actual final authorization and registration commands in memory.
  . (Join-Path $windows 'game-task.ps1')
  foreach ($fnName in @('Get-GameConfigurationTask','Get-ComparableTaskXml','Confirm-GameConfigurationTask','Register-GameStartTask')) {
    $fn=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $fnName},$true)
    . ([scriptblock]::Create($fn.Extent.Text))
  }
  $checkCommand = $ast.Find({param($n) $n -is [Management.Automation.Language.CommandAst] -and $n.GetCommandName() -ceq 'Confirm-GameConfigurationTask' -and $n.Extent.Text -match 'DisabledByUs:'},$true)
  $registerCommand = $ast.Find({param($n) $n -is [Management.Automation.Language.CommandAst] -and $n.GetCommandName() -ceq 'Register-GameStartTask'},$true)
  Assert ($null -ne $checkCommand -and $null -ne $registerCommand) 'Actual configuration commit was not found.'
  $commit = [scriptblock]::Create($checkCommand.Extent.Text + [Environment]::NewLine + $registerCommand.Extent.Text)
  $configuration=[pscustomobject]@{StartTaskName=$name}; $managedTaskDescription='DYSON_CONTROL_MANAGED_GAME_START_V1'; $taskDefinition=[pscustomobject]@{}
  $global:DysonTaskSelectionFixture.deny=$false; $taskXml=''; $taskMutated=$false
  $global:DysonTaskSelectionFixture.tasks=@()
  & $commit | Out-Null
  Assert ($global:DysonTaskSelectionFixture.registrations -eq 1 -and -not $global:DysonTaskSelectionFixture.lastForce) 'Initially absent task allowed forced registration.'
  $global:DysonTaskSelectionFixture.tasks=@((Task $name '\'))
  Assert ((Failure $commit) -like '*already exists*') 'A late root task could be force-replaced.'
  $taskMutated=$true; $taskXml=$global:DysonTaskSelectionFixture.xml; $global:DysonTaskSelectionFixture.tasks[0].State='Disabled'
  $global:DysonTaskSelectionFixture.xml='<Task><Settings><Enabled>false</Enabled></Settings></Task>'
  & $commit | Out-Null
  Assert ($global:DysonTaskSelectionFixture.registrations -eq 2 -and $global:DysonTaskSelectionFixture.lastForce) 'Unchanged owned task could not be explicitly reconfigured.'
  $global:DysonTaskSelectionFixture.xml='<Task><Actions/><Settings><Enabled>false</Enabled></Settings></Task>'
  Assert ((Failure $commit) -like '*definition changed*') 'Changed original definition could be replaced.'
  $global:DysonTaskSelectionFixture.tasks += (Task $name '\elsewhere')
  Assert ((Failure $commit) -like '*Multiple scheduled tasks*') 'A folder collision during access probes could be ignored.'
  Assert ($global:DysonTaskSelectionFixture.registrations -eq 2) 'A conflicting definition was registered.'
  'GAME_TASK_SELECTION_MOCK_OK'
} finally {
  $resolved=[IO.Path]::GetFullPath($root)
  if ([IO.Path]::GetDirectoryName($resolved).TrimEnd('\') -cne $temp.TrimEnd('\') -or [IO.Path]::GetFileName($resolved) -notmatch '^dyson-game-task-mock-[a-f0-9]{32}$') { throw 'Unexpected fixture cleanup scope.' }
  if (Test-Path -LiteralPath $resolved) { Remove-Item -LiteralPath $resolved -Recurse -Force }
}
