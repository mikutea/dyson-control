$ErrorActionPreference='Stop'
$source=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\windows\start-game.ps1'))
$tokens=$null;$parseErrors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($source,[ref]$tokens,[ref]$parseErrors)
if($parseErrors.Count){throw 'start-game.ps1 contains parser errors'}
$function=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Get-DysonInitialWorldArguments'},$true)
if(-not $function){throw 'First-world selector not found'}
. ([ScriptBlock]::Create($function.Extent.Text))
$tempBase=[IO.Path]::GetFullPath($env:TEMP).TrimEnd('\')
$fixture=[IO.Path]::GetFullPath((Join-Path $tempBase ('dyson-first-world-fixture-'+[guid]::NewGuid().ToString('N'))))
New-Item -ItemType Directory -Path $fixture|Out-Null
$script:checks=0
function Scenario([string]$Name,[bool]$Marker=$true){
  $root=Join-Path $fixture $Name
  $saves=Join-Path $root 'Save'
  New-Item -ItemType Directory -Path $saves|Out-Null
  if($Marker){[IO.File]::WriteAllText((Join-Path $root '.dyson-first-world.json'),'{"schema":1,"mode":"default","installationId":"first-install-11111111-1111-1111-1111-111111111111"}')}
  $documents=Join-Path $root 'Documents'
  New-Item -ItemType Directory -Path $documents|Out-Null
  return @{Root=$root;Saves=$saves;Documents=$documents}
}
function Assert([bool]$Condition,[string]$Message){if(-not $Condition){throw $Message};$script:checks++}
function MustFail([scriptblock]$Operation){$failed=$false;try{& $Operation|Out-Null}catch{$failed=$true};Assert $failed 'Unsafe first-world request was accepted'}
try{
  $s=Scenario 'ordinary' $false
  Assert ((@(Get-DysonInitialWorldArguments $s.Root $s.Saves $null $s.Documents) -join ' ') -ceq '-load-latest') 'Existing installations changed behavior'
  Assert (-not(Test-Path -LiteralPath (Join-Path $s.Documents 'options.xml'))) 'Ordinary startup created options'
  $s=Scenario 'empty-first-run'
  Assert ((@(Get-DysonInitialWorldArguments $s.Root $s.Saves $null $s.Documents) -join ' ') -ceq '-newgame-default') 'Empty first installation did not select default world'
  $options=[IO.File]::ReadAllText((Join-Path $s.Documents 'options.xml'))
  Assert ($options -ceq '<Options><CurrentVersion><VersionNumber>6</VersionNumber></CurrentVersion></Options>') 'Fresh headless startup did not seed default options with the supported format'
  Assert (Test-Path -LiteralPath (Join-Path $s.Root '.dyson-first-world-consumed.json')) 'First-world authorization was not consumed'
  Assert ((@(Get-DysonInitialWorldArguments $s.Root $s.Saves $null $s.Documents) -join ' ') -ceq '-load-latest') 'A later empty directory could create another world'
  [IO.File]::Move((Join-Path $s.Root '.dyson-first-world-consumed.json'),(Join-Path $s.Root '.dyson-first-world.json'))
  Assert ((@(Get-DysonInitialWorldArguments $s.Root $s.Saves $null $s.Documents) -join ' ') -ceq '-newgame-default') 'Explicitly restored permission did not allow one new-world attempt'
  Assert ((@(Get-DysonInitialWorldArguments $s.Root $s.Saves $null $s.Documents) -join ' ') -ceq '-load-latest') 'Restored permission was reusable without another explicit preparation'
  $s=Scenario 'existing-save'
  [IO.File]::WriteAllText((Join-Path $s.Saves 'World.dsv'),'preserve')
  Assert ((@(Get-DysonInitialWorldArguments $s.Root $s.Saves $null $s.Documents) -join ' ') -ceq '-load-latest') 'Existing saves were ignored'
  Assert ([IO.File]::ReadAllText((Join-Path $s.Saves 'World.dsv')) -ceq 'preserve') 'Existing save changed'
  Assert (-not(Test-Path -LiteralPath (Join-Path $s.Documents 'options.xml'))) 'Loading an existing save created options'
  $s=Scenario 'explicit-save'
  Assert ((@(Get-DysonInitialWorldArguments $s.Root $s.Saves 'Chosen' $s.Documents) -join ' ') -ceq '-load Chosen') 'Explicit save selection was ignored'
  Assert (-not(Test-Path -LiteralPath (Join-Path $s.Documents 'options.xml'))) 'Explicit save selection created options'
  $s=Scenario 'preserve-options'
  [IO.File]::WriteAllText((Join-Path $s.Documents 'options.xml'),'user-options-preserve-exactly')
  Assert ((@(Get-DysonInitialWorldArguments $s.Root $s.Saves $null $s.Documents) -join ' ') -ceq '-newgame-default') 'Existing options prevented authorized first-world selection'
  Assert ([IO.File]::ReadAllText((Join-Path $s.Documents 'options.xml')) -ceq 'user-options-preserve-exactly') 'Existing options were overwritten'
  $s=Scenario 'options-is-directory'
  New-Item -ItemType Directory -Path (Join-Path $s.Documents 'options.xml')|Out-Null
  MustFail {Get-DysonInitialWorldArguments $s.Root $s.Saves $null $s.Documents}
  Assert (Test-Path -LiteralPath (Join-Path $s.Root '.dyson-first-world.json')) 'Options collision consumed authorization'
  $s=Scenario 'options-write-failure'
  MustFail {Get-DysonInitialWorldArguments $s.Root $s.Saves $null (Join-Path $s.Documents 'missing-directory')}
  Assert (Test-Path -LiteralPath (Join-Path $s.Root '.dyson-first-world.json')) 'Options write failure consumed authorization'
  $s=Scenario 'orphan-sidecar'
  [IO.File]::WriteAllText((Join-Path $s.Saves 'World.server'),'preserve')
  MustFail {Get-DysonInitialWorldArguments $s.Root $s.Saves $null $s.Documents}
  Assert (Test-Path -LiteralPath (Join-Path $s.Root '.dyson-first-world.json')) 'Rejected sidecar state consumed authorization'
  $s=Scenario 'invalid-marker'
  [IO.File]::WriteAllText((Join-Path $s.Root '.dyson-first-world.json'),'{"schema":1,"mode":"unexpected"}')
  MustFail {Get-DysonInitialWorldArguments $s.Root $s.Saves $null $s.Documents}
  $s=Scenario 'duplicate-marker'
  [IO.File]::WriteAllText((Join-Path $s.Root '.dyson-first-world-consumed.json'),'already used')
  MustFail {Get-DysonInitialWorldArguments $s.Root $s.Saves $null $s.Documents}
  [ordered]@{passed=$true;checks=$checks;gameProcessesStarted=0;externalPathsWritten=0}|ConvertTo-Json -Compress
}finally{
  $resolved=[IO.Path]::GetFullPath($fixture)
  if(-not $resolved.StartsWith($tempBase+'\',[StringComparison]::OrdinalIgnoreCase) -or (Split-Path -Leaf $resolved) -notlike 'dyson-first-world-fixture-*'){throw 'Fixture cleanup path escaped its temporary root'}
  Remove-Item -LiteralPath $resolved -Recurse -Force
}
