param([Parameter(Mandatory = $true)][string]$ArgumentsPath)
$ErrorActionPreference = 'Stop'
$argsObject = Get-Content -LiteralPath $ArgumentsPath -Raw -Encoding UTF8 | ConvertFrom-Json
$taskName = [string]$argsObject.taskName
if ([string]::IsNullOrWhiteSpace($taskName) -or $taskName.Length -gt 240 -or $taskName.IndexOf([char]0) -ge 0 -or $taskName -match '[*?\[\]]') { throw 'taskName is invalid.' }
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop | Where-Object { $_.TaskName -ceq $taskName } | Select-Object -First 1
if ($null -eq $task) { throw 'The exact scheduled task was not found.' }
Start-ScheduledTask -InputObject $task
[ordered]@{ taskName = $task.TaskName; invoked = $true } | ConvertTo-Json -Compress
