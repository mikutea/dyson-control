# Shared by the standalone Windows updater and its one-shot helper.
if (-not ('DysonControl.AtomicJsonFile' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;
namespace DysonControl {
    public static class AtomicJsonFile {
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr security, uint disposition, uint attributes, IntPtr template);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool SetFileInformationByHandle(SafeFileHandle file, int kind, IntPtr info, uint size);

        public static void Replace(string source, string target) {
            source = Path.GetFullPath(source);
            target = Path.GetFullPath(target);
            if (!String.Equals(Path.GetDirectoryName(source), Path.GetDirectoryName(target), StringComparison.OrdinalIgnoreCase))
                throw new IOException("JSON replacement must stay in the same directory.");
            byte[] name = Encoding.Unicode.GetBytes(target);
            // FILE_RENAME_INFO: Flags, aligned HANDLE, DWORD byte count, WCHAR name.
            int nameOffset = IntPtr.Size == 8 ? 20 : 12;
            // Keep a UTF-16 terminator for the Win32 path conversion as well.
            int size = nameOffset + name.Length + 2;
            IntPtr info = Marshal.AllocHGlobal(size);
            try {
                Marshal.Copy(new byte[size], 0, info, size);
                // REPLACE_IF_EXISTS | POSIX_SEMANTICS keeps readers of the old file valid.
                // https://learn.microsoft.com/windows-hardware/drivers/ddi/ntifs/ns-ntifs-_file_rename_information
                Marshal.WriteInt32(info, 0, 3);
                Marshal.WriteInt32(info, nameOffset - 4, name.Length);
                Marshal.Copy(name, 0, IntPtr.Add(info, nameOffset), name.Length);
                string extended = source.StartsWith(@"\\?\") ? source : source.StartsWith(@"\\") ? @"\\?\UNC\" + source.Substring(2) : @"\\?\" + source;
                using (var file = CreateFile(extended, 0x10000, 7, IntPtr.Zero, 3, 128, IntPtr.Zero)) {
                    if (file.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
                    // FileRenameInfoEx (22), supported by the required Windows 10 release.
                    if (!SetFileInformationByHandle(file, 22, info, (uint)size))
                        throw new Win32Exception(Marshal.GetLastWin32Error());
                }
            } finally { Marshal.FreeHGlobal(info); }
        }
    }
}
'@
}

function Write-DysonAtomicJson([string]$PathValue, [object]$Value, [int]$Depth = 8) {
  $target = [IO.Path]::GetFullPath($PathValue)
  $temporary = "$target.partial-$([guid]::NewGuid().ToString('N'))"
  try {
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($Value | ConvertTo-Json -Depth $Depth) + [Environment]::NewLine)
    $stream = [IO.File]::Open($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) }
    finally { $stream.Dispose() }
    if (Test-Path -LiteralPath $target) {
      $existing = Get-Item -LiteralPath $target -Force -ErrorAction Stop
      if ($existing.PSIsContainer -or ($existing.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw "JSON replacement target must be a plain file: $target"
      }
      Set-Acl -LiteralPath $temporary -AclObject (Get-Acl -LiteralPath $target -ErrorAction Stop) -ErrorAction Stop
    }
    [DysonControl.AtomicJsonFile]::Replace($temporary, $target)
  }
  finally { Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue }
}
