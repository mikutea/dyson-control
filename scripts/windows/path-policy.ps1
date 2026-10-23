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

function Get-DysonDirectoryLinkTarget([string]$LinkPath) {
  # Windows PowerShell 5.1 drops the leading backslashes from UNC link Target
  # metadata. Read the reparse record so an absolute UNC target cannot be
  # confused with a real relative directory named "UNC".
  if (-not ('DysonControl.DirectoryLinkReader' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;
namespace DysonControl {
  public static class DirectoryLinkReader {
    [DllImport("kernel32.dll", EntryPoint = "CreateFileW", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool DeviceIoControl(SafeFileHandle handle, uint code, IntPtr input, uint inputSize, byte[] output, uint outputSize, out uint returned, IntPtr overlapped);

    public static string ReadTarget(string linkPath) {
      string fullLink = Path.GetFullPath(linkPath);
      // OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS.
      using (SafeFileHandle handle = CreateFile(fullLink, 0, 7, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero)) {
        if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
        byte[] buffer = new byte[16384];
        uint returned;
        // FSCTL_GET_REPARSE_POINT: inspect the link itself without following it.
        if (!DeviceIoControl(handle, 0x000900A8, IntPtr.Zero, 0, buffer, (uint)buffer.Length, out returned, IntPtr.Zero))
          throw new Win32Exception(Marshal.GetLastWin32Error());
        if (returned < 16) throw new IOException("Incomplete directory-link metadata.");
        uint tag = BitConverter.ToUInt32(buffer, 0);
        int end = 8 + BitConverter.ToUInt16(buffer, 4);
        int pathStart;
        bool relative = false;
        if (tag == 0xA000000C) {
          if (returned < 20) throw new IOException("Incomplete symbolic-link metadata.");
          uint flags = BitConverter.ToUInt32(buffer, 16);
          if ((flags & ~1U) != 0) throw new IOException("Unsupported symbolic-link flags.");
          relative = (flags & 1) != 0;
          pathStart = 20;
        } else if (tag == 0xA0000003) {
          pathStart = 16;
        } else throw new IOException("The path is not a supported directory link.");
        int offset = BitConverter.ToUInt16(buffer, 8);
        int length = BitConverter.ToUInt16(buffer, 10);
        if (end > returned || end < pathStart || length == 0 || (offset & 1) != 0 || (length & 1) != 0 || pathStart + offset + length > end)
          throw new IOException("Invalid directory-link target metadata.");
        string target = Encoding.Unicode.GetString(buffer, pathStart + offset, length);
        if (target.IndexOf('\0') >= 0) throw new IOException("Invalid directory-link target.");
        if (relative) {
          if (Path.IsPathRooted(target)) throw new IOException("A relative link contains a rooted target.");
          return Path.GetFullPath(Path.Combine(Path.GetDirectoryName(fullLink), target));
        }
        if (target.StartsWith(@"\??\UNC\", StringComparison.OrdinalIgnoreCase)) target = @"\\" + target.Substring(8);
        else if (target.StartsWith(@"\??\", StringComparison.Ordinal)) target = target.Substring(4);
        if (!Path.IsPathRooted(target)) throw new IOException("An absolute link contains a relative target.");
        return Path.GetFullPath(target);
      }
    }
  }
}
'@
  }
  return [DysonControl.DirectoryLinkReader]::ReadTarget($LinkPath)
}
