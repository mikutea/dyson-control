$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$source = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\windows\configure-game.ps1'))
$tokens = $null; $parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($source, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw 'Game configuration source contains parser errors.' }
$registration = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Register-GameStartTask' }, $true)
if (-not $registration) { throw 'Game task registration helper is missing.' }
. ([ScriptBlock]::Create($registration.Extent.Text))

$taskName = 'Dyson First Install Fixture ' + [Guid]::NewGuid().ToString('N')
$marker = 'DYSON_FIRST_INSTALL_TASK_FIXTURE'
$scheduler = New-Object -ComObject 'Schedule.Service'
$scheduler.Connect()
$folder = $scheduler.GetFolder('\')
$created = $false
try {
  if (@($folder.GetTasks(1) | Where-Object { $_.Name -ceq $taskName }).Count) { throw 'Fixture task name already exists.' }
  $principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
  $action = New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -Argument '-NoProfile -NonInteractive -Command exit 0'
  $settings = New-ScheduledTaskSettingsSet -Disable
  $first = New-ScheduledTask -Action $action -Principal $principal -Settings $settings -Description $marker
  Register-GameStartTask -Name $taskName -Definition $first -RequireNewTask
  $created = $true
  $before = [string]$folder.GetTask($taskName).Xml
  $replacement = New-ScheduledTask -Action $action -Principal $principal -Settings $settings -Description ($marker + '_REPLACEMENT')
  $rejected = $false
  try { Register-GameStartTask -Name $taskName -Definition $replacement -RequireNewTask }
  catch { $rejected = $true }
  $unchanged = [string]$folder.GetTask($taskName).Xml -ceq $before
  if (-not $rejected -or -not $unchanged) { throw "First-install collision handling failed (rejected=$rejected, originalUnchanged=$unchanged)." }
  Register-GameStartTask -Name $taskName -Definition $replacement
  $updated = $folder.GetTask($taskName)
  if ([string]$updated.Definition.RegistrationInfo.Description -cne ($marker + '_REPLACEMENT') -or $updated.Enabled -or [int]$updated.State -eq 4) {
    throw 'Explicit reconfiguration did not retain a disabled, unstarted fixture task.'
  }
  'FIRST_INSTALL_TASK_FIXTURE_OK'
} finally {
  if ($created) {
    $owned = $folder.GetTask($taskName)
    if ($taskName -notmatch '^Dyson First Install Fixture [0-9a-f]{32}$' -or
        [string]$owned.Definition.RegistrationInfo.Description -notin @($marker, ($marker + '_REPLACEMENT')) -or $owned.Enabled -or [int]$owned.State -eq 4) {
      throw 'Fixture task cleanup identity differs.'
    }
    $folder.DeleteTask($taskName, 0)
    if (@($folder.GetTasks(1) | Where-Object { $_.Name -ceq $taskName }).Count) { throw 'Fixture task remains after cleanup.' }
  }
}
