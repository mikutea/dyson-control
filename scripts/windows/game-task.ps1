# Task names are unique only inside a Scheduler folder. Resolve the configured name across all visible folders.
function Get-DysonGameTaskSelection([string]$Name) {
  $result = [ordered]@{ state = 'missing'; task = $null; message = '' }
  if ([string]::IsNullOrWhiteSpace($Name) -or $Name.Length -gt 240 -or $Name.IndexOf([char]0) -ge 0 -or $Name -match '[*?\[\]]') {
    $result.state = 'invalid'; $result.message = 'The configured game task name is invalid.'
    return [pscustomobject]$result
  }
  try {
    $candidates = @(Get-ScheduledTask -ErrorAction Stop | Where-Object {
      [string]::Equals([string]$_.TaskName, $Name, [StringComparison]::OrdinalIgnoreCase)
    })
  } catch {
    $result.state = 'unavailable'; $result.message = 'Unable to inspect Windows task folders. Check the control service permissions.'
    return [pscustomobject]$result
  }
  if ($candidates.Count -gt 1) {
    $result.state = 'ambiguous'; $result.message = 'Multiple scheduled tasks match the configured game task name across folders or letter case. Use a unique name.'
  } elseif ($candidates.Count -eq 1) {
    if (-not [string]::Equals([string]$candidates[0].TaskName, $Name, [StringComparison]::Ordinal)) {
      $result.state = 'case-mismatch'; $result.message = 'The game task name differs from its configured spelling. Check the exact letter case.'
    } elseif ([string]::IsNullOrWhiteSpace([string]$candidates[0].TaskPath)) {
      $result.state = 'unavailable'; $result.message = 'Unable to identify the scheduled game task folder.'
    } else { $result.state = 'unique'; $result.task = $candidates[0] }
  }
  return [pscustomobject]$result
}

function Resolve-DysonGameTask([string]$Name, [switch]$RootOnly, [switch]$RequireAbsent) {
  $selection = Get-DysonGameTaskSelection $Name
  if ($selection.state -ceq 'missing') { return $null }
  if ($selection.state -cne 'unique') { throw $selection.message }
  if ($RootOnly -and $selection.task.TaskPath -cne '\') { throw 'A game task with the configured name already exists outside the root task folder. Choose a unique managed task name.' }
  if ($RequireAbsent) { throw 'A game task with the configured name already exists. A new installation cannot replace it.' }
  return $selection.task
}
