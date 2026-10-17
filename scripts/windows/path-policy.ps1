$ErrorActionPreference = 'Stop'

function Get-DysonGlobalSmbMappings {
  $command = Get-Command Get-SmbGlobalMapping -ErrorAction SilentlyContinue
  if ($null -eq $command) { return @() }
  return @(Get-SmbGlobalMapping -ErrorAction Stop | ForEach-Object {
    $localPath = ([string]$_.LocalPath).TrimEnd('\')
    $remotePath = ([string]$_.RemotePath).TrimEnd('\')
    $status = [string]$_.Status
    if ($localPath -match '^[A-Za-z]:$' -and $remotePath.StartsWith('\\', [StringComparison]::Ordinal) -and
        ($status -eq '0' -or $status.Equals('OK', [StringComparison]::OrdinalIgnoreCase))) {
      [pscustomobject]@{ LocalPath = $localPath.ToUpperInvariant(); RemotePath = $remotePath; Status = $status }
    }
  })
}

function Get-DysonApprovedPathInfo([string]$PathValue, [string]$Label, [bool]$AllowGlobalSmb, [bool]$RequireNtfs = $false) {
  if ([string]::IsNullOrWhiteSpace($PathValue)) { throw "$Label is empty." }
  $path = [IO.Path]::GetFullPath($PathValue)
  if ($path.StartsWith('\\', [StringComparison]::Ordinal) -or $path.StartsWith('//', [StringComparison]::Ordinal)) {
    throw "$Label must use a local drive path or the drive letter of an existing SMB global mapping; direct UNC paths are not accepted: $path"
  }
  $root = [IO.Path]::GetPathRoot($path)
  if ([string]::IsNullOrWhiteSpace($root) -or $root -notmatch '^[A-Za-z]:\\$') {
    throw "$Label is not an absolute Windows drive path: $path"
  }
  $drive = [IO.DriveInfo]::new($root)
  if (-not $drive.IsReady) { throw "$Label is on a drive that is not ready: $path" }
  if ($drive.DriveType -eq [IO.DriveType]::Fixed) {
    if ($RequireNtfs -and -not ([string]$drive.DriveFormat).Equals('NTFS', [StringComparison]::OrdinalIgnoreCase)) {
      throw "$Label must remain on a local NTFS volume: $path"
    }
    return [pscustomobject]@{ Path = $path; Kind = 'local-fixed'; LocalPath = $root.TrimEnd('\').ToUpperInvariant(); RemotePath = $null }
  }
  if (-not $AllowGlobalSmb) {
    throw "$Label must remain on a ready local NTFS volume: $path"
  }
  if ($drive.DriveType -ne [IO.DriveType]::Network) {
    throw "$Label must use a ready local fixed volume or an existing healthy SMB global mapping: $path"
  }
  $localPath = $root.TrimEnd('\').ToUpperInvariant()
  $allMappings = @(Get-DysonGlobalSmbMappings)
  $mapping = @($allMappings | Where-Object { $_.LocalPath.Equals($localPath, [StringComparison]::OrdinalIgnoreCase) })
  if ($mapping.Count -ne 1) {
    throw "$Label uses a network drive that is not one existing healthy SMB global mapping: $path"
  }
  return [pscustomobject]@{ Path = $path; Kind = 'smb-global'; LocalPath = $localPath; RemotePath = [string]$mapping[0].RemotePath }
}

function ConvertTo-DysonCanonicalPath([string]$PathValue) {
  if ([string]::IsNullOrWhiteSpace($PathValue)) { throw 'Cannot canonicalize an empty path.' }
  $path = [IO.Path]::GetFullPath($PathValue)
  $mappings = @(Get-DysonGlobalSmbMappings)
  if ($path.StartsWith('\\', [StringComparison]::Ordinal) -or $path.StartsWith('//', [StringComparison]::Ordinal)) {
    $matched = @($mappings | Where-Object {
      $remote = [string]$_.RemotePath
      $path.Equals($remote, [StringComparison]::OrdinalIgnoreCase) -or
        $path.StartsWith($remote + '\', [StringComparison]::OrdinalIgnoreCase)
    } | Sort-Object { ([string]$_.RemotePath).Length } -Descending | Select-Object -First 1)
    if ($matched.Count -ne 1) { throw "UNC path is not covered by an existing healthy SMB global mapping: $path" }
    return $path.TrimEnd('\')
  }
  $root = [IO.Path]::GetPathRoot($path)
  if ($root -match '^[A-Za-z]:\\$') {
    $localPath = $root.TrimEnd('\').ToUpperInvariant()
    $mapping = @($mappings | Where-Object { $_.LocalPath.Equals($localPath, [StringComparison]::OrdinalIgnoreCase) })
    if ($mapping.Count -eq 1) {
      $suffix = $path.Substring($root.Length).TrimStart('\')
      if ([string]::IsNullOrEmpty($suffix)) { return ([string]$mapping[0].RemotePath).TrimEnd('\') }
      return (([string]$mapping[0].RemotePath).TrimEnd('\') + '\' + $suffix).TrimEnd('\')
    }
  }
  return $path.TrimEnd('\')
}

function Test-DysonPathEquals([string]$Left, [string]$Right) {
  try {
    return (ConvertTo-DysonCanonicalPath $Left).Equals((ConvertTo-DysonCanonicalPath $Right), [StringComparison]::OrdinalIgnoreCase)
  }
  catch { return $false }
}
