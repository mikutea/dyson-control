# Real Task Scheduler fixture. This is exclusively for an ephemeral GitHub-hosted Windows runner.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if ($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or $env:RUNNER_OS -cne 'Windows' -or
    $env:GITHUB_RUN_ID -notmatch '^[1-9][0-9]*$' -or $env:GITHUB_RUN_ATTEMPT -notmatch '^[1-9][0-9]*$' -or
    $PSVersionTable.PSEdition -cne 'Desktop' -or $PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1) {
  throw 'This fixture requires Windows PowerShell 5.1 on an ephemeral GitHub-hosted Windows Actions runner.'
}
if ([string]::IsNullOrWhiteSpace($env:RUNNER_TEMP) -or [string]::IsNullOrWhiteSpace($env:GITHUB_WORKSPACE) -or
    -not [string]::Equals([IO.Path]::GetFullPath($PSCommandPath), [IO.Path]::GetFullPath((Join-Path $env:GITHUB_WORKSPACE 'scripts\tests\game-task-scheduler.fixture.ps1')), [StringComparison]::OrdinalIgnoreCase)) {
  throw 'The runner workspace or fixture path is unexpected.'
}
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not [Security.Principal.WindowsPrincipal]::new($identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Hosted runner administrator access is required.' }

$runnerTemp = [IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\')
if ($runnerTemp -notmatch '^[A-Za-z]:\\' -or $runnerTemp -match '["\r\n]' -or [IO.Path]::GetPathRoot($runnerTemp).TrimEnd('\') -eq $runnerTemp) { throw 'A local runner temp directory is required.' }
function Assert-PlainDirectory([string]$Directory) {
  for ($item = [IO.DirectoryInfo]::new($Directory); $null -ne $item; $item = $item.Parent) {
    if (-not $item.Exists -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Unexpected or linked runner directory.' }
  }
}
Assert-PlainDirectory $runnerTemp
$nonce = [guid]::NewGuid().ToString('N')
$folderName = 'Dyson Game Task Folder ' + $nonce
$name = 'Dyson Game Task CI ' + $nonce
$output = Join-Path $runnerTemp ('dyson-game-task-fixture-' + $nonce)
$evidencePath = Join-Path $runnerTemp ('dyson-game-task-scheduler-' + $nonce + '.json')
$fsutil = [IO.Path]::GetFullPath((Join-Path $env:SystemRoot 'System32\fsutil.exe'))
if (-not [IO.File]::Exists($fsutil) -or ((Get-Item -LiteralPath $fsutil).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'System fsutil.exe is unavailable.' }
$utf8 = [Text.UTF8Encoding]::new($false)
$invoke = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\windows\invoke-scheduled-task.ps1'))
. (Join-Path (Split-Path -Parent $invoke) 'game-task.ps1')

function New-Spec([string]$Slot,[string]$Folder,[int]$Length) {
  $folderPath = if ($Folder -ceq '\') { '\' } else { $Folder + '\' }
  $file = Join-Path $output ($Slot + '-' + $nonce + '.mark')
  return [pscustomobject]@{ slot=$Slot; folder=$Folder; taskPath=$folderPath; full=($folderPath + $name); length=$Length; file=$file
    description=('DYSON_GAME_TASK_SCHEDULER_CI_' + $nonce + '_' + $Slot); arguments=('file createnew "{0}" {1}' -f $file,$Length); attempted=$false }
}
$rootSpec = New-Spec 'root' '\' 17
$childSpec = New-Spec 'child' ('\' + $folderName) 29
$evidence = [ordered]@{ schema=1; fixture='game-task-scheduler'; runId=$env:GITHUB_RUN_ID; attempt=$env:GITHUB_RUN_ATTEMPT; fixtureId=$nonce
  distinctRegistered=$false; ambiguousRejected=$false; ambiguousMarkers=$null; caseRejected=$false; caseMarkers=$null; singleChildInvoked=$false; childMarkerBytes=0; childLastResult=$null
  rootMarkerAbsent=$false; rootTaskAbsent=$false; childTaskAbsent=$false; schedulerFolderAbsent=$false; tempDirectoryAbsent=$false; passed=$false }

function Assert([bool]$Value,[string]$Message) { if (-not $Value) { throw $Message } }
function Wait-Verified([scriptblock]$Check,[string]$Message) {
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  do { if (&$Check) { return }; Start-Sleep -Milliseconds 200 } while ([DateTime]::UtcNow -lt $deadline)
  throw $Message
}
function ChildFolder {
  $matchesByName = @($schedulerRoot.GetFolders(0) | Where-Object { [string]::Equals($_.Name,$folderName,[StringComparison]::OrdinalIgnoreCase) })
  if ($matchesByName.Count -gt 1 -or ($matchesByName.Count -and ($matchesByName[0].Name -cne $folderName -or $matchesByName[0].Path -cne $childSpec.folder))) {
    throw 'The candidate scheduler folder identity differs.'
  }
  if ($matchesByName.Count) { return $matchesByName[0] }
}
function TaskInFolder([object]$Spec) {
  $folder = if ($Spec.slot -ceq 'root') { $schedulerRoot } else { ChildFolder }
  if ($null -eq $folder) { return $null }
  $candidates = @($folder.GetTasks(1) | Where-Object { [string]::Equals($_.Name,$name,[StringComparison]::OrdinalIgnoreCase) })
  if ($candidates.Count -gt 1 -or ($candidates.Count -and ($candidates[0].Name -cne $name -or $candidates[0].Path -cne $Spec.full))) {
    throw 'Case or full path of the scheduled task differs; retaining it.'
  }
  if ($candidates.Count) { return $candidates[0] }
}
function Assert-OwnedTask([object]$Task,[object]$Spec) {
  Assert ($null -ne $Task -and $Task.Name -ceq $name -and $Task.Path -ceq $Spec.full) 'Unexpected task path or name.'
  $definition = $Task.Definition
  Assert ($definition.RegistrationInfo.Description -ceq $Spec.description -and $definition.Triggers.Count -eq 0 -and $definition.Actions.Count -eq 1) 'Unexpected description, triggers or actions.'
  $action = $definition.Actions.Item(1)
  Assert ([int]$action.Type -eq 0 -and [string]::Equals($action.Path,$fsutil,[StringComparison]::OrdinalIgnoreCase) -and
    $action.Arguments -ceq $Spec.arguments -and [string]::Equals($action.WorkingDirectory,$output,[StringComparison]::OrdinalIgnoreCase)) 'Unexpected task executable, marker path or arguments.'
  $principal = [string]$definition.Principal.UserId
  $sid = if ($principal -match '^S-1-') { [Security.Principal.SecurityIdentifier]::new($principal) } else { [Security.Principal.NTAccount]::new($principal).Translate([Security.Principal.SecurityIdentifier]) }
  Assert ($sid.Value -ceq 'S-1-5-18' -and [int]$definition.Principal.LogonType -eq 5) 'Unexpected fixture task principal.'
}
function Assert-IdleTask([object]$Task) { Assert ([int]$Task.State -notin @(2,4) -and $Task.GetInstances(0).Count -eq 0) 'Fixture task is queued or running.' }
function Register-OwnTask([object]$Spec) {
  Assert-PlainDirectory $output
  Assert ($null -eq (TaskInFolder $Spec) -and -not (Test-Path -LiteralPath $Spec.file)) 'Task name, folder, or marker is already in use.'
  $action = New-ScheduledTaskAction -Execute $fsutil -Argument $Spec.arguments -WorkingDirectory $output
  $principal = New-ScheduledTaskPrincipal -UserId 'S-1-5-18' -LogonType ServiceAccount -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::FromMinutes(1))
  $definition = New-ScheduledTask -Action $action -Principal $principal -Settings $settings -Description $Spec.description
  $Spec.attempted = $true
  Register-ScheduledTask -TaskName $name -TaskPath $Spec.taskPath -InputObject $definition -ErrorAction Stop | Out-Null
  Wait-Verified { $null -ne (TaskInFolder $Spec) } 'Registered task did not become visible.'
  $registered = TaskInFolder $Spec
  Assert-OwnedTask $registered $Spec
  Assert-IdleTask $registered
}
function Remove-OwnTask([object]$Spec) {
  $task = TaskInFolder $Spec
  if ($null -eq $task) { return }
  Assert ($Spec.attempted -and $name -ceq ('Dyson Game Task CI ' + $nonce)) 'Refusing to remove a task we did not register.'
  Assert-PlainDirectory $output
  Assert-OwnedTask $task $Spec
  Assert-IdleTask $task
  $folder = if ($Spec.slot -ceq 'root') { $schedulerRoot } else { ChildFolder }
  $folder.DeleteTask($name,0)
  Wait-Verified { $null -eq (TaskInFolder $Spec) } 'Deleted fixture task still exists.'
}
function Assert-Rejection([string]$ArgumentsPath,[string]$Expected) {
  $rejected = ''
  try { & $invoke -ArgumentsPath $ArgumentsPath | Out-Null } catch { $rejected = $_.Exception.Message }
  Assert ($rejected -like $Expected) 'Production invocation did not reject the expected task-name conflict.'
}
function Assert-NoMarker([object]$Spec) { Assert (-not (Test-Path -LiteralPath $Spec.file)) 'A rejected invocation created a marker.' }
function Create-Text([string]$File,[string]$Text) {
  $stream = [IO.File]::Open($File,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try { $bytes=$utf8.GetBytes($Text); $stream.Write($bytes,0,$bytes.Length) } finally { $stream.Dispose() }
}

$workspaceCreated=$false; $folderCreated=$false; $rootBefore=$null; $childBefore=$null
$failure=$null; $cleanup=[Collections.Generic.List[string]]::new()
$exactInput=Join-Path $output 'exact.json'; $caseInput=Join-Path $output 'case.json'
try {
  Assert (-not (Test-Path -LiteralPath $output) -and -not (Test-Path -LiteralPath $evidencePath)) 'Fixture filesystem scope already exists.'
  $acl = [Security.AccessControl.DirectorySecurity]::new()
  $acl.SetSecurityDescriptorSddlForm('D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)')
  [void][IO.Directory]::CreateDirectory($output,$acl); $workspaceCreated=$true
  Assert-PlainDirectory $output
  Assert ((Get-Acl -LiteralPath $output).AreAccessRulesProtected) 'Fixture directory ACL is unexpectedly inherited.'
  Create-Text $exactInput (([ordered]@{taskName=$name}) | ConvertTo-Json -Compress)
  Create-Text $caseInput (([ordered]@{taskName=$name.ToLowerInvariant()}) | ConvertTo-Json -Compress)
  $scheduler = New-Object -ComObject 'Schedule.Service'; $scheduler.Connect()
  $schedulerRoot = $scheduler.GetFolder('\')
  Assert ($schedulerRoot.Path -ceq '\' -and $null -eq (ChildFolder) -and $null -eq (TaskInFolder $rootSpec)) 'Runner scheduler scope already exists.'
  Assert ((Get-DysonGameTaskSelection $name).state -ceq 'missing') 'The fixture name already exists in another scheduler folder.'
  $createdFolder = $schedulerRoot.CreateFolder($folderName,$null); $folderCreated=$true
  Assert ($createdFolder.Path -ceq $childSpec.folder -and $createdFolder.GetTasks(1).Count -eq 0 -and $createdFolder.GetFolders(0).Count -eq 0) 'Created folder identity or contents differ.'
  Register-OwnTask $rootSpec; Register-OwnTask $childSpec
  $rootBefore=(TaskInFolder $rootSpec).LastRunTime; $childBefore=(TaskInFolder $childSpec).LastRunTime
  Wait-Verified { (Get-DysonGameTaskSelection $name).state -ceq 'ambiguous' } 'Scheduler did not expose two matching tasks.'
  $evidence.distinctRegistered=$true

  Assert-Rejection $exactInput '*Multiple scheduled tasks*'
  $evidence.ambiguousMarkers = @($rootSpec,$childSpec | Where-Object { Test-Path -LiteralPath $_.file }).Count
  foreach($spec in @($rootSpec,$childSpec)) { Assert-NoMarker $spec; Assert-IdleTask (TaskInFolder $spec) }
  Assert ((TaskInFolder $rootSpec).LastRunTime -eq $rootBefore -and (TaskInFolder $childSpec).LastRunTime -eq $childBefore) 'A duplicate-name task unexpectedly ran.'
  $evidence.ambiguousRejected=$true
  Remove-OwnTask $rootSpec
  Wait-Verified { $selected=Get-DysonGameTaskSelection $name; $selected.state -ceq 'unique' -and $selected.task.TaskPath -ceq $childSpec.taskPath } 'The unique child task did not become visible.'
  Assert-Rejection $caseInput '*letter case*'
  $evidence.caseMarkers = @($rootSpec,$childSpec | Where-Object { Test-Path -LiteralPath $_.file }).Count
  Assert-NoMarker $rootSpec; Assert-NoMarker $childSpec
  Assert-IdleTask (TaskInFolder $childSpec)
  Assert ((TaskInFolder $childSpec).LastRunTime -eq $childBefore) 'Case mismatch unexpectedly ran the task.'
  $evidence.caseRejected=$true

  Assert-PlainDirectory $output
  Assert-OwnedTask (TaskInFolder $childSpec) $childSpec
  $receipt = (& $invoke -ArgumentsPath $exactInput) | ConvertFrom-Json
  Assert ($receipt.invoked -eq $true -and $receipt.taskName -ceq $name) 'Invocation did not confirm the expected task.'
  Wait-Verified {
    $done=TaskInFolder $childSpec
    $null -ne $done -and [IO.File]::Exists($childSpec.file) -and $done.LastRunTime -ne $childBefore -and [int]$done.State -notin @(2,4) -and $done.GetInstances(0).Count -eq 0
  } 'The child task did not finish and produce its marker.'
  $done=TaskInFolder $childSpec; Assert-OwnedTask $done $childSpec
  $file = Get-Item -LiteralPath $childSpec.file -Force
  Assert (-not $file.PSIsContainer -and -not ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -and $file.Length -eq $childSpec.length) 'Child marker identity or length differs.'
  Assert (@([IO.File]::ReadAllBytes($childSpec.file) | Where-Object { $_ -ne 0 }).Count -eq 0 -and $done.LastTaskResult -eq 0) 'Unexpected marker contents or child task exit status.'
  Assert-NoMarker $rootSpec
  $evidence.singleChildInvoked=$true; $evidence.childMarkerBytes=$file.Length; $evidence.childLastResult=[int]$done.LastTaskResult; $evidence.rootMarkerAbsent=$true
} catch { $failure=$_.Exception.Message }
finally {
  foreach ($spec in @($rootSpec,$childSpec)) {
    if ($spec.attempted) { try { Remove-OwnTask $spec } catch { $cleanup.Add($spec.slot + ' task: ' + $_.Exception.Message) } }
  }
  if ($null -ne $schedulerRoot) {
    try {
      $evidence.rootTaskAbsent=$null -eq (TaskInFolder $rootSpec); $evidence.childTaskAbsent=$null -eq (TaskInFolder $childSpec)
      if ($folderCreated) {
        $folder=ChildFolder
        Assert ($null -ne $folder -and $folder.Path -ceq $childSpec.folder -and $folder.Name -ceq $folderName -and $folder.GetTasks(1).Count -eq 0 -and $folder.GetFolders(0).Count -eq 0) 'Refusing to remove a changed or nonempty scheduler folder.'
        $schedulerRoot.DeleteFolder($folderName,0)
      }
      Wait-Verified { $null -eq (ChildFolder) } 'Dedicated scheduler folder still exists.'
      $evidence.schedulerFolderAbsent=$true
      Assert ($evidence.rootTaskAbsent -and $evidence.childTaskAbsent) 'A task still exists after cleanup.'
      Wait-Verified { (Get-DysonGameTaskSelection $name).state -ceq 'missing' } 'Production task selection still sees a fixture task after cleanup.'
    } catch { $cleanup.Add('scheduler cleanup: ' + $_.Exception.Message) }
  }
  if ($workspaceCreated -and $cleanup.Count -eq 0) {
    try {
      Assert-PlainDirectory $output
      Assert ([IO.Path]::GetDirectoryName($output) -ceq $runnerTemp -and [IO.Path]::GetFileName($output) -ceq ('dyson-game-task-fixture-' + $nonce)) 'Unexpected marker cleanup scope.'
      foreach ($entry in @(Get-ChildItem -LiteralPath $output -Force)) {
        Assert (-not $entry.PSIsContainer -and -not ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -and $entry.FullName -cin @($exactInput,$caseInput,$rootSpec.file,$childSpec.file)) 'Unknown entry in fixture directory; retaining it.'
      }
      foreach ($file in @($exactInput,$caseInput,$rootSpec.file,$childSpec.file)) { if ([IO.File]::Exists($file)) { [IO.File]::Delete($file) } }
      [IO.Directory]::Delete($output,$false)
      $evidence.tempDirectoryAbsent=-not (Test-Path -LiteralPath $output)
      Assert $evidence.tempDirectoryAbsent 'Fixture filesystem directory remains.'
    } catch { $cleanup.Add('marker cleanup: ' + $_.Exception.Message) }
  }
}
$evidence.passed = $null -eq $failure -and $cleanup.Count -eq 0 -and $evidence.ambiguousRejected -and $evidence.caseRejected -and $evidence.singleChildInvoked -and $evidence.tempDirectoryAbsent
$evidence['cleanupErrors']=@($cleanup.ToArray())
$evidence['completedAtUtc']=[DateTimeOffset]::UtcNow.ToString('o')
$json = $evidence | ConvertTo-Json -Depth 3 -Compress
Assert-PlainDirectory $runnerTemp
Create-Text $evidencePath $json
"GAME_TASK_SCHEDULER_EVIDENCE $json"
"GAME_TASK_SCHEDULER_EVIDENCE_FILE $evidencePath"
if ($failure) { throw $failure }
if (-not $evidence.passed) { throw ('Real Scheduler fixture cleanup failed: ' + ($cleanup -join '; ')) }
'GAME_TASK_SCHEDULER_FIXTURE_OK'
