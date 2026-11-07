param([Parameter(Mandatory = $true)][string]$ArgumentsPath)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'game-task.ps1')
$argsObject = Get-Content -LiteralPath $ArgumentsPath -Raw -Encoding UTF8 | ConvertFrom-Json
$taskName = [string]$argsObject.taskName
$task = Resolve-DysonGameTask $taskName
if ($null -eq $task) { throw 'The exact scheduled task was not found.' }
Start-ScheduledTask -InputObject $task -ErrorAction Stop
[ordered]@{ taskName = $task.TaskName; invoked = $true } | ConvertTo-Json -Compress
