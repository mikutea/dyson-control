param([Parameter(Mandatory=$true)][string]$ArgumentsPath)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
. (Join-Path $PSScriptRoot 'game-task.ps1')
$inputData=Get-Content -LiteralPath $ArgumentsPath -Raw -Encoding UTF8|ConvertFrom-Json
$config=Get-Content -LiteralPath ([string]$inputData.configPath) -Raw -Encoding UTF8|ConvertFrom-Json
[void](Resolve-DysonGameTask ([string]$config.game.startTaskName) -RootOnly -RequireAbsent)
# The established configurator verifies the logged-in Windows/Steam owner, probes access,
# backs up its targets, protects the Bridge secret, and registers a task without starting it.
& (Join-Path $PSScriptRoot 'configure-game.ps1') -ConfigPath ([string]$inputData.configPath) `
  -BridgeBuildDirectory ([string]$inputData.bridgeDirectory) -BridgeSha256 ([string]$inputData.bridgeSha256) `
  -GameUser ([string]$inputData.gameUser) -ConfirmStopped -RequireNewTask
