using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace DysonControl.Bridge
{
    internal static class DirectoryIdentity
    {
        private const uint FileShareRead = 1;
        private const uint FileShareWrite = 2;
        private const uint FileShareDelete = 4;
        private const uint OpenExisting = 3;
        private const uint FileFlagBackupSemantics = 0x02000000;

        internal static string ResolvePhysicalPath(string path)
        {
            if (string.IsNullOrWhiteSpace(path) || !Path.IsPathRooted(path))
                throw new InvalidOperationException("Save directory must be an absolute path.");

            var fullPath = Path.GetFullPath(path);
            var directory = new DirectoryInfo(fullPath);
            if (!directory.Exists) throw new DirectoryNotFoundException("Save directory does not exist: " + fullPath);

            using (var handle = CreateFile(
                fullPath,
                0,
                FileShareRead | FileShareWrite | FileShareDelete,
                IntPtr.Zero,
                OpenExisting,
                FileFlagBackupSemantics,
                IntPtr.Zero))
            {
                if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not open save directory: " + fullPath);
                var buffer = new StringBuilder(512);
                var length = GetFinalPathNameByHandle(handle, buffer, (uint)buffer.Capacity, 0);
                if (length == 0) throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not resolve save directory: " + fullPath);
                if (length >= buffer.Capacity)
                {
                    buffer = new StringBuilder(checked((int)length + 1));
                    length = GetFinalPathNameByHandle(handle, buffer, (uint)buffer.Capacity, 0);
                    if (length == 0 || length >= buffer.Capacity)
                        throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not resolve save directory: " + fullPath);
                }
                return NormalizeFinalPath(buffer.ToString());
            }
        }

        internal static bool SamePhysicalDirectory(string left, string right)
        {
            return string.Equals(ResolvePhysicalPath(left), ResolvePhysicalPath(right), StringComparison.OrdinalIgnoreCase);
        }

        private static string NormalizeFinalPath(string value)
        {
            var normalized = value;
            if (normalized.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase)) normalized = @"\\" + normalized.Substring(8);
            else if (normalized.StartsWith(@"\\?\", StringComparison.OrdinalIgnoreCase)) normalized = normalized.Substring(4);
            return Path.GetFullPath(normalized).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern SafeFileHandle CreateFile(
            string fileName,
            uint desiredAccess,
            uint shareMode,
            IntPtr securityAttributes,
            uint creationDisposition,
            uint flagsAndAttributes,
            IntPtr templateFile);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern uint GetFinalPathNameByHandle(
            SafeFileHandle file,
            StringBuilder filePath,
            uint filePathLength,
            uint flags);
    }
}
