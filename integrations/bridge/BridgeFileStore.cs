using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;

namespace DysonControl.Bridge
{
    internal sealed class BridgeFileStore
    {
        private readonly string root;
        private readonly string requests;
        private readonly string processing;
        private readonly string receipts;
        private readonly string processed;
        private readonly string rejected;
        private readonly string playerRequests;
        private readonly string playerProcessing;
        private readonly string playerResponses;
        private readonly string playerProcessed;
        private readonly string playerRejected;

        internal BridgeFileStore(string controlRoot, string secretFile)
        {
            if (string.IsNullOrWhiteSpace(controlRoot) || !Path.IsPathRooted(controlRoot) ||
                string.IsNullOrWhiteSpace(secretFile) || !Path.IsPathRooted(secretFile))
                throw new InvalidOperationException("Bridge paths must be absolute.");
            root = Path.GetFullPath(controlRoot).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            requests = Path.Combine(root, "requests");
            processing = Path.Combine(root, "processing");
            receipts = Path.Combine(root, "receipts");
            processed = Path.Combine(root, "processed");
            rejected = Path.Combine(root, "rejected");
            playerRequests = Path.Combine(root, "player-requests");
            playerProcessing = Path.Combine(root, "player-processing");
            playerResponses = Path.Combine(root, "player-responses");
            playerProcessed = Path.Combine(root, "player-processed");
            playerRejected = Path.Combine(root, "player-rejected");
            Directory.CreateDirectory(root);
            foreach (var directory in new[]
            {
                root, requests, processing, receipts, processed, rejected,
                playerRequests, playerProcessing, playerResponses, playerProcessed, playerRejected
            })
            {
                Directory.CreateDirectory(directory);
                AssertPlainDirectory(directory);
            }
            var secretInfo = new FileInfo(Path.GetFullPath(secretFile));
            if (!secretInfo.Exists || (secretInfo.Attributes & FileAttributes.ReparsePoint) != 0 || secretInfo.Length < 32 || secretInfo.Length > 2048)
                throw new InvalidOperationException("Bridge secret file is unavailable.");
            Secret = File.ReadAllText(secretInfo.FullName, new UTF8Encoding(false, true)).Trim();
            if (Secret.Length < 32 || Secret.Length > 512 || Secret.IndexOfAny(new[] { '\r', '\n', '\0' }) >= 0)
                throw new InvalidOperationException("Bridge secret is invalid.");
        }

        internal string Secret { get; }

        internal BridgeClaim TryClaimNext()
        {
            return TryClaimNext(requests, processing, processed, rejected);
        }

        internal BridgeClaim TryClaimNextPlayerAction()
        {
            return TryClaimNext(playerRequests, playerProcessing, playerProcessed, playerRejected);
        }

        private static BridgeClaim TryClaimNext(string requestsDirectory, string processingDirectory, string processedDirectory, string rejectedDirectory)
        {
            var recovered = Directory.EnumerateFiles(processingDirectory, "*.request", SearchOption.TopDirectoryOnly)
                .OrderBy(file => file, StringComparer.Ordinal).FirstOrDefault();
            if (recovered != null) return new BridgeClaim(recovered, true, processedDirectory, rejectedDirectory);
            foreach (var source in Directory.EnumerateFiles(requestsDirectory, "*.request", SearchOption.TopDirectoryOnly).OrderBy(file => file, StringComparer.Ordinal))
            {
                if ((File.GetAttributes(source) & FileAttributes.ReparsePoint) != 0) { MoveTo(source, Path.Combine(rejectedDirectory, Path.GetFileName(source))); continue; }
                var fileName = Path.GetFileName(source);
                if (!Guid.TryParseExact(Path.GetFileNameWithoutExtension(fileName), "D", out _))
                {
                    MoveTo(source, Path.Combine(rejectedDirectory, fileName));
                    continue;
                }
                var target = Path.Combine(processingDirectory, fileName);
                try { File.Move(source, target); return new BridgeClaim(target, false, processedDirectory, rejectedDirectory); }
                catch (IOException) { }
            }
            return null;
        }

        internal bool TryReadRequest(BridgeClaim claim, out BridgeRequest request, out string errorCode)
        {
            request = null;
            errorCode = "INVALID_REQUEST";
            var info = new FileInfo(claim.Path);
            if (!info.Exists || (info.Attributes & FileAttributes.ReparsePoint) != 0 || info.Length < 1 || info.Length > 4096) return false;
            string payload;
            try { payload = File.ReadAllText(info.FullName, new UTF8Encoding(false, true)); }
            catch { return false; }
            if (!BridgeProtocol.TryParseRequest(payload, Secret, out request, out errorCode)) return false;
            if (!string.Equals(Path.GetFileNameWithoutExtension(info.Name), request.RequestId, StringComparison.Ordinal))
            {
                request = null;
                errorCode = "REQUEST_ID_MISMATCH";
                return false;
            }
            return true;
        }

        internal bool TryReadPlayerActionRequest(BridgeClaim claim, out BridgePlayerActionRequest request, out string errorCode)
        {
            request = null;
            errorCode = "INVALID_REQUEST";
            var info = new FileInfo(claim.Path);
            if (!info.Exists || (info.Attributes & FileAttributes.ReparsePoint) != 0 || info.Length < 1 || info.Length > 4096) return false;
            string payload;
            try { payload = File.ReadAllText(info.FullName, new UTF8Encoding(false, true)); }
            catch { return false; }
            if (!BridgeProtocol.TryParsePlayerActionRequest(payload, Secret, out request, out errorCode)) return false;
            if (!string.Equals(Path.GetFileNameWithoutExtension(info.Name), request.RequestId, StringComparison.Ordinal))
            {
                request = null;
                errorCode = "REQUEST_ID_MISMATCH";
                return false;
            }
            return true;
        }

        internal bool AlreadyHandled(string requestId) =>
            File.Exists(Path.Combine(receipts, requestId + ".receipt")) ||
            File.Exists(Path.Combine(processed, requestId + ".request"));
        internal bool PlayerActionAlreadyHandled(string requestId) =>
            File.Exists(Path.Combine(playerResponses, requestId + ".receipt")) ||
            File.Exists(Path.Combine(playerProcessed, requestId + ".request"));
        internal void WriteHeartbeat(string payload) => AtomicWrite(Path.Combine(root, "heartbeat"), payload);
        internal void WritePlayers(string payload) => AtomicWrite(Path.Combine(root, "players"), payload);
        internal void WritePlayerEvents(string payload) => AtomicWrite(Path.Combine(root, "player-events"), payload, 196608);
        internal void WritePlayerActions(string payload) => AtomicWrite(Path.Combine(root, "player-actions"), payload);
        internal void WriteMetrics(string payload) => AtomicWrite(Path.Combine(root, "metrics"), payload);
        internal void WriteVersions(string payload) => AtomicWrite(Path.Combine(root, "versions"), payload);
        internal void WriteReceipt(string requestId, string payload) => AtomicWrite(Path.Combine(receipts, requestId + ".receipt"), payload);
        internal void WritePlayerActionReceipt(string requestId, string payload) => AtomicWrite(Path.Combine(playerResponses, requestId + ".receipt"), payload);

        internal void Complete(BridgeClaim claim)
        {
            MoveTo(claim.Path, Path.Combine(claim.ProcessedDirectory, Path.GetFileName(claim.Path)));
        }

        internal void Reject(BridgeClaim claim)
        {
            MoveTo(claim.Path, Path.Combine(claim.RejectedDirectory, Path.GetFileName(claim.Path)));
        }

        private static void MoveTo(string source, string target)
        {
            if (!File.Exists(source)) return;
            if (File.Exists(target)) File.Delete(source);
            else File.Move(source, target);
        }

        private static void AtomicWrite(string target, string payload, int maximumBytes = 32768)
        {
            var directory = Path.GetDirectoryName(target) ?? throw new InvalidOperationException("Bridge target has no directory.");
            AssertPlainDirectory(directory);
            var temporary = Path.Combine(directory, ".partial-" + Guid.NewGuid().ToString("N"));
            var bytes = new UTF8Encoding(false, true).GetBytes(payload);
            if (bytes.Length < 1 || bytes.Length > maximumBytes) throw new InvalidOperationException("Bridge payload size is invalid.");
            try
            {
                using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough))
                {
                    stream.Write(bytes, 0, bytes.Length);
                    stream.Flush(true);
                }
                if (File.Exists(target)) File.Replace(temporary, target, null, true);
                else File.Move(temporary, target);
            }
            finally { if (File.Exists(temporary)) File.Delete(temporary); }
        }

        private static void AssertPlainDirectory(string directory)
        {
            var info = new DirectoryInfo(directory);
            if (!info.Exists || (info.Attributes & FileAttributes.ReparsePoint) != 0)
                throw new InvalidOperationException("Bridge directory is unavailable.");
        }
    }

    internal sealed class BridgeClaim
    {
        internal BridgeClaim(string path, bool recovered, string processedDirectory, string rejectedDirectory)
        {
            Path = path;
            Recovered = recovered;
            ProcessedDirectory = processedDirectory;
            RejectedDirectory = rejectedDirectory;
        }
        internal string Path { get; }
        internal bool Recovered { get; }
        internal string ProcessedDirectory { get; }
        internal string RejectedDirectory { get; }
    }
}
