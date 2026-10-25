using System;
using System.Diagnostics;
using System.IO;
using BepInEx;
using BepInEx.Bootstrap;
using BepInEx.Configuration;
using NebulaAPI;
using NebulaWorld.GameStates;
using WebSocketSharp;

namespace DysonControl.Bridge
{
    [BepInPlugin(PluginGuid, PluginName, PluginVersion)]
    [BepInDependency("dsp.nebula-multiplayer", BepInDependency.DependencyFlags.HardDependency)]
    // A direct Nebula API dependency opts into host/client mod parity checks.
    // This server-only plugin depends on Nebula itself and sends no custom game packets.
    public sealed class DysonControlBridgePlugin : BaseUnityPlugin
    {
        public const string PluginGuid = "net.miyuo.dyson-control.bridge";
        public const string PluginName = "Dyson Control Bridge";
        public const string PluginVersion = "0.1.8";

        private ConfigEntry<string> controlDirectory;
        private ConfigEntry<string> secretFile;
        private ConfigEntry<string> expectedSaveDirectory;
        private string expectedSavePhysicalPath;
        private BridgeFileStore store;
        private PlayerRosterPublisher players;
        private MetricsPublisher metrics;
        private ActiveSave activeSave;
        private ActiveKick activeKick;
        private int processId;
        private long startedAtUnixMs;
        private long nextHeartbeatMonotonic;
        private long nextRequestPollMonotonic;
        private bool operational;

        private void Awake()
        {
            controlDirectory = Config.Bind("Bridge", "ControlDirectory", string.Empty, "Absolute private bridge directory.");
            secretFile = Config.Bind("Bridge", "SecretFile", string.Empty, "Absolute ACL-protected shared secret file.");
            expectedSaveDirectory = Config.Bind("Bridge", "ExpectedSaveDirectory", string.Empty, "Absolute physical save directory managed by Dyson Control.");
            if (string.IsNullOrWhiteSpace(controlDirectory.Value) || string.IsNullOrWhiteSpace(secretFile.Value) ||
                string.IsNullOrWhiteSpace(expectedSaveDirectory.Value))
            {
                Logger.LogError("Dyson Control Bridge requires Bridge.ControlDirectory, Bridge.SecretFile, and Bridge.ExpectedSaveDirectory.");
                return;
            }

            try
            {
                expectedSavePhysicalPath = DirectoryIdentity.ResolvePhysicalPath(expectedSaveDirectory.Value);
                store = new BridgeFileStore(controlDirectory.Value, secretFile.Value);
                using (var process = Process.GetCurrentProcess())
                {
                    processId = process.Id;
                    startedAtUnixMs = new DateTimeOffset(process.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds();
                }
                var sessionId = Guid.NewGuid().ToString("D").ToLowerInvariant();
                players = new PlayerRosterPublisher(store, processId, RuntimeReadyForPublish);
                metrics = new MetricsPublisher(store, sessionId, processId, RuntimeReadyForPublish);
                operational = true;
                var now = Now();
                var monotonic = Stopwatch.GetTimestamp();
                WriteHeartbeat(now, monotonic);
                players.Tick(now);
                metrics.Tick(now, monotonic);
                Logger.LogInfo("Dyson Control Bridge initialized; heartbeat readiness follows the dedicated loaded game state.");
            }
            catch (Exception exception)
            {
                operational = false;
                players?.Dispose();
                players = null;
                Logger.LogError("Dyson Control Bridge configuration failed: " + exception.Message);
            }
        }

        private void Update()
        {
            if (!operational) return;
            var now = Now();
            var monotonic = Stopwatch.GetTimestamp();
            try
            {
                if (monotonic >= nextHeartbeatMonotonic) WriteHeartbeat(now, monotonic);
                try { players.Tick(now); } catch (Exception exception) { Logger.LogWarning("Player snapshot unavailable: " + exception.GetType().Name); }
                try { metrics.Tick(now, monotonic); } catch (Exception exception) { Logger.LogWarning("Metrics snapshot unavailable: " + exception.GetType().Name); }

                if (activeSave != null)
                {
                    PollSave(now, monotonic);
                    return;
                }
                if (activeKick != null)
                {
                    PollKick(now, monotonic);
                    return;
                }
                if (monotonic < nextRequestPollMonotonic) return;
                nextRequestPollMonotonic = monotonic + Math.Max(1, Stopwatch.Frequency / 4);
                var claim = store.TryClaimNext();
                if (claim != null)
                {
                    ProcessClaim(claim, now, monotonic);
                    return;
                }
                var playerClaim = store.TryClaimNextPlayerAction();
                if (playerClaim != null) ProcessPlayerActionClaim(playerClaim, now, monotonic);
            }
            catch (Exception exception)
            {
                Logger.LogError("Bridge update failed: " + exception.GetType().Name);
            }
        }

        private void ProcessClaim(BridgeClaim claim, long now, long monotonic)
        {
            if (!store.TryReadRequest(claim, out var request, out var parseError))
            {
                store.Reject(claim);
                Logger.LogWarning("Rejected bridge request: " + parseError);
                return;
            }
            if (store.AlreadyHandled(request.RequestId))
            {
                store.Complete(claim);
                return;
            }
            if (claim.Recovered)
            {
                WriteFailure(request, now, "INTERRUPTED_UNCERTAIN");
                store.Complete(claim);
                return;
            }
            if (now < request.CreatedAtUnixMs - 5000 || now > request.ExpiresAtUnixMs)
            {
                WriteFailure(request, now, "REQUEST_EXPIRED");
                store.Complete(claim);
                return;
            }
            if (request.Action == "save") BeginSave(claim, request, now, monotonic);
            else ProcessStop(claim, request, now);
        }

        private void BeginSave(BridgeClaim claim, BridgeRequest request, long started, long monotonic)
        {
            try
            {
                if (!TryRuntimeReady(out var readinessError)) throw new BridgeOperationException(readinessError);
                var saveName = GameSave.LastExit;
                if (saveName != "_lastexit_" || !ValidSaveName(saveName)) throw new BridgeOperationException("SAVE_NAME_INVALID");
                var saveRoot = Path.GetFullPath(GameConfig.gameSaveFolder).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) + Path.DirectorySeparatorChar;
                var dsvPath = Under(saveRoot, saveName + GameSave.saveExt);
                var serverPath = Under(saveRoot, saveName + ".server");
                var moddsvPath = Under(saveRoot, saveName + ".moddsv");
                var before = ObserveSave(dsvPath, serverPath, moddsvPath);
                if (!GameSave.SaveCurrentGame(GameSave.LastExit)) throw new BridgeOperationException("SAVE_CALL_FAILED");

                var remainingMilliseconds = Math.Max(1, Math.Min(30000, request.ExpiresAtUnixMs - started));
                activeSave = new ActiveSave
                {
                    Claim = claim,
                    Request = request,
                    StartedAtUnixMs = started,
                    SaveName = saveName,
                    DsvPath = dsvPath,
                    ServerPath = serverPath,
                    ModdsvPath = moddsvPath,
                    Before = before,
                    Tracker = new SaveStabilityTracker(before),
                    DeadlineMonotonic = AddMilliseconds(monotonic, remainingMilliseconds),
                    NextPollMonotonic = monotonic
                };
            }
            catch (Exception exception)
            {
                var error = exception is BridgeOperationException operation ? operation.Code : "SAVE_FAILED";
                WriteSaveFailure(claim, request, started, GameSave.LastExit, error, null, null);
            }
        }

        private void ProcessPlayerActionClaim(BridgeClaim claim, long now, long monotonic)
        {
            if (!store.TryReadPlayerActionRequest(claim, out var request, out var parseError))
            {
                store.Reject(claim);
                Logger.LogWarning("Rejected player action request: " + parseError);
                return;
            }
            if (store.PlayerActionAlreadyHandled(request.RequestId))
            {
                store.Complete(claim);
                return;
            }
            if (claim.Recovered)
            {
                WriteKickFailure(claim, request, now, "INTERRUPTED_UNCERTAIN");
                return;
            }
            if (now < request.CreatedAtUnixMs - 5000 || now > request.ExpiresAtUnixMs)
            {
                WriteKickFailure(claim, request, now, "REQUEST_EXPIRED");
                return;
            }
            BeginKick(claim, request, now, monotonic);
        }

        private void BeginKick(BridgeClaim claim, BridgePlayerActionRequest request, long started, long monotonic)
        {
            try
            {
                if (!TryRuntimeReady(out _)) throw new BridgeOperationException("GAME_NOT_READY");
                if (!players.TryResolveKickTarget(request.SessionId, request.SessionPlayerId, out var target, out var targetError))
                    throw new BridgeOperationException(targetError);
                var socket = target.Connection.peerSocket;
                if (socket == null || socket.ReadyState != WebSocketState.Open)
                    throw new BridgeOperationException("PLAYER_SOCKET_NOT_OPEN");

                var remainingMilliseconds = Math.Max(1, Math.Min(30000, request.ExpiresAtUnixMs - started));
                activeKick = new ActiveKick
                {
                    Claim = claim,
                    Request = request,
                    Target = target,
                    StartedAtUnixMs = started,
                    DeadlineMonotonic = AddMilliseconds(monotonic, remainingMilliseconds)
                };
                try { socket.CloseAsync((ushort)4000, "Removed by server administrator."); }
                catch
                {
                    activeKick = null;
                    throw new BridgeOperationException("KICK_CLOSE_FAILED");
                }
            }
            catch (Exception exception)
            {
                var error = exception is BridgeOperationException operation ? operation.Code : "KICK_CLOSE_FAILED";
                WriteKickFailure(claim, request, started, error);
            }
        }

        private void PollKick(long now, long monotonic)
        {
            var pending = activeKick;
            if (pending == null) return;
            try
            {
                if (!players.SessionMatches(pending.Target.SessionId))
                {
                    WriteKickFailure(pending.Claim, pending.Request, pending.StartedAtUnixMs, "SESSION_CHANGED");
                    return;
                }
                if (players.IsTargetDisconnected(pending.Target))
                {
                    store.WritePlayerActionReceipt(pending.Request.RequestId,
                        BridgeProtocol.SerializePlayerActionReceipt(new BridgePlayerActionReceipt
                        {
                            RequestId = pending.Request.RequestId,
                            Action = pending.Request.Action,
                            SessionId = pending.Request.SessionId,
                            SessionPlayerId = pending.Request.SessionPlayerId,
                            State = "succeeded",
                            StartedAtUnixMs = pending.StartedAtUnixMs,
                            FinishedAtUnixMs = Math.Max(pending.StartedAtUnixMs, now),
                            ErrorCode = "NONE"
                        }, store.Secret));
                    store.Complete(pending.Claim);
                    activeKick = null;
                    return;
                }
                if (monotonic >= pending.DeadlineMonotonic)
                    WriteKickFailure(pending.Claim, pending.Request, pending.StartedAtUnixMs, "KICK_TIMEOUT");
            }
            catch
            {
                WriteKickFailure(pending.Claim, pending.Request, pending.StartedAtUnixMs, "KICK_TIMEOUT");
            }
        }

        private void WriteKickFailure(BridgeClaim claim, BridgePlayerActionRequest request, long started, string errorCode)
        {
            store.WritePlayerActionReceipt(request.RequestId,
                BridgeProtocol.SerializePlayerActionReceipt(new BridgePlayerActionReceipt
                {
                    RequestId = request.RequestId,
                    Action = request.Action,
                    SessionId = request.SessionId,
                    SessionPlayerId = request.SessionPlayerId,
                    State = "failed",
                    StartedAtUnixMs = started,
                    FinishedAtUnixMs = Math.Max(started, Now()),
                    ErrorCode = errorCode
                }, store.Secret));
            store.Complete(claim);
            activeKick = null;
            Logger.LogWarning("Player kick request failed: " + errorCode);
        }

        private void PollSave(long now, long monotonic)
        {
            var pending = activeSave;
            if (pending == null || monotonic < pending.NextPollMonotonic) return;
            pending.NextPollMonotonic = monotonic + Math.Max(1, Stopwatch.Frequency / 4);
            try
            {
                var observation = ObserveSave(pending.DsvPath, pending.ServerPath, pending.ModdsvPath);
                pending.Last = observation;
                if (monotonic >= pending.DeadlineMonotonic)
                {
                    WriteSaveFailure(pending.Claim, pending.Request, pending.StartedAtUnixMs, pending.SaveName,
                        pending.Tracker.ExplainFailure(observation), pending.Before, observation);
                    return;
                }
                if (pending.Tracker.Observe(observation, monotonic, MillisecondsToTicks(750), out var stable))
                {
                    if (!TryRuntimeReady(out var readinessError))
                    {
                        WriteSaveFailure(pending.Claim, pending.Request, pending.StartedAtUnixMs, pending.SaveName,
                            readinessError, pending.Before, observation);
                        return;
                    }
                    MarkChanges(pending.Before, stable);
                    store.WriteReceipt(pending.Request.RequestId, BridgeProtocol.SerializeSaveReceipt(new BridgeSaveReceipt
                    {
                        RequestId = pending.Request.RequestId,
                        State = "succeeded",
                        StartedAtUnixMs = pending.StartedAtUnixMs,
                        FinishedAtUnixMs = Math.Max(pending.StartedAtUnixMs, now),
                        SaveName = pending.SaveName,
                        SaveTimeBefore = pending.Before.SaveTime,
                        SaveTimeAfter = stable.SaveTime,
                        Dsv = stable.Dsv,
                        Server = stable.Server,
                        Moddsv = stable.Moddsv,
                        ErrorCode = "NONE"
                    }, store.Secret));
                    store.Complete(pending.Claim);
                    activeSave = null;
                    return;
                }
            }
            catch (Exception exception)
            {
                var error = exception is BridgeOperationException operation ? operation.Code : "SAVE_VERIFY_FAILED";
                WriteSaveFailure(pending.Claim, pending.Request, pending.StartedAtUnixMs, pending.SaveName, error, pending.Before, pending.Last);
            }
        }

        private void WriteSaveFailure(
            BridgeClaim claim,
            BridgeRequest request,
            long started,
            string saveName,
            string errorCode,
            BridgeSaveObservation before,
            BridgeSaveObservation after)
        {
            var receipt = new BridgeSaveReceipt
            {
                RequestId = request.RequestId,
                State = "failed",
                StartedAtUnixMs = started,
                FinishedAtUnixMs = Math.Max(started, Now()),
                SaveName = ValidSaveName(saveName) ? saveName : "_unavailable_",
                SaveTimeBefore = before?.SaveTime ?? -1,
                SaveTimeAfter = after?.SaveTime ?? -1,
                Dsv = after?.Dsv ?? new BridgeFileEvidence(),
                Server = after?.Server ?? new BridgeFileEvidence(),
                Moddsv = after?.Moddsv ?? new BridgeFileEvidence(),
                ErrorCode = errorCode
            };
            if (before != null && after != null) MarkChanges(before, after);
            store.WriteReceipt(request.RequestId, BridgeProtocol.SerializeSaveReceipt(receipt, store.Secret));
            store.Complete(claim);
            activeSave = null;
            Logger.LogWarning("Save request failed: " + errorCode);
        }

        private void ProcessStop(BridgeClaim claim, BridgeRequest request, long started)
        {
            if (!TryRuntimeReady(out var readinessError))
            {
                WriteFailure(request, started, readinessError);
                store.Complete(claim);
                return;
            }
            var finished = Math.Max(started, Now());
            store.WriteReceipt(request.RequestId, BridgeProtocol.SerializeActionReceipt(new BridgeActionReceipt
            {
                RequestId = request.RequestId,
                Action = "stop",
                State = "succeeded",
                StartedAtUnixMs = started,
                FinishedAtUnixMs = finished,
                ErrorCode = "NONE"
            }, store.Secret));
            store.Complete(claim);
            UnityEngine.Application.Quit();
        }

        private void WriteFailure(BridgeRequest request, long started, string errorCode)
        {
            var finished = Math.Max(started, Now());
            var payload = request.Action == "stop"
                ? BridgeProtocol.SerializeActionReceipt(new BridgeActionReceipt
                {
                    RequestId = request.RequestId, Action = "stop", State = "failed",
                    StartedAtUnixMs = started, FinishedAtUnixMs = finished, ErrorCode = errorCode
                }, store.Secret)
                : BridgeProtocol.SerializeSaveReceipt(new BridgeSaveReceipt
                {
                    RequestId = request.RequestId, State = "failed", StartedAtUnixMs = started,
                    FinishedAtUnixMs = finished, SaveName = "_unavailable_", ErrorCode = errorCode
                }, store.Secret);
            store.WriteReceipt(request.RequestId, payload);
        }

        private void WriteHeartbeat(long now, long monotonic)
        {
            var state = RuntimeReadyForPublish() ? "ready" : "unavailable";
            var writtenAt = Math.Max(startedAtUnixMs, now);
            store.WriteVersions(BridgeProtocol.SerializeVersions(new BridgeVersions
            {
                ProcessId = processId,
                WrittenAtUnixMs = writtenAt,
                Game = GameConfig.gameVersion.ToFullString(),
                Nebula = Chainloader.PluginInfos["dsp.nebula-multiplayer"].Metadata.Version.ToString(),
                BepInEx = typeof(BaseUnityPlugin).Assembly.GetName().Version.ToString(),
                Bridge = PluginVersion
            }, store.Secret));
            store.WriteHeartbeat(BridgeProtocol.SerializeHeartbeat(
                PluginVersion, processId, startedAtUnixMs, writtenAt, state, store.Secret));
            nextHeartbeatMonotonic = monotonic + Stopwatch.Frequency * 2;
        }

        private bool RuntimeReadyForPublish()
        {
            try { return TryRuntimeReady(out _); }
            catch { return false; }
        }

        private bool TryRuntimeReady(out string errorCode)
        {
            errorCode = "GAME_NOT_READY";
            var session = NebulaModAPI.MultiplayerSession;
            if (!NebulaModAPI.IsMultiplayerActive || session == null || !session.IsDedicated || !session.IsServer ||
                !session.IsGameLoaded || GameMain.data == null || !GameMain.isRunning) return false;
            try
            {
                if (!string.Equals(DirectoryIdentity.ResolvePhysicalPath(GameConfig.gameSaveFolder), expectedSavePhysicalPath,
                    StringComparison.OrdinalIgnoreCase))
                {
                    errorCode = "SAVE_DIRECTORY_MISMATCH";
                    return false;
                }
            }
            catch
            {
                errorCode = "SAVE_DIRECTORY_UNAVAILABLE";
                return false;
            }
            errorCode = "NONE";
            return true;
        }

        private static BridgeSaveObservation ObserveSave(string dsvPath, string serverPath, string moddsvPath)
        {
            return new BridgeSaveObservation
            {
                SaveTime = GameStatesManager.LastSaveTime,
                Dsv = ObserveFile(dsvPath),
                Server = ObserveFile(serverPath),
                Moddsv = ObserveFile(moddsvPath)
            };
        }

        private static BridgeFileEvidence ObserveFile(string path)
        {
            var info = new FileInfo(path);
            info.Refresh();
            if (!info.Exists) return new BridgeFileEvidence();
            if ((info.Attributes & FileAttributes.ReparsePoint) != 0 || (info.Attributes & FileAttributes.Directory) != 0)
                throw new BridgeOperationException("SAVE_FILE_INVALID");
            return new BridgeFileEvidence { Bytes = info.Length, Ticks = info.LastWriteTimeUtc.Ticks };
        }

        private static void MarkChanges(BridgeSaveObservation before, BridgeSaveObservation after)
        {
            after.Dsv.Changed = Changed(before.Dsv, after.Dsv);
            after.Server.Changed = Changed(before.Server, after.Server);
            after.Moddsv.Changed = Changed(before.Moddsv, after.Moddsv);
        }

        private static bool Changed(BridgeFileEvidence before, BridgeFileEvidence after) =>
            before.Bytes != after.Bytes || before.Ticks != after.Ticks;

        private static bool ValidSaveName(string value) =>
            !string.IsNullOrEmpty(value) && value.Length <= 120 && value != "." && value != ".." &&
            value.IndexOfAny(Path.GetInvalidFileNameChars()) < 0;

        private static string Under(string root, string fileName)
        {
            var path = Path.GetFullPath(Path.Combine(root, fileName));
            if (!path.StartsWith(root, StringComparison.OrdinalIgnoreCase)) throw new BridgeOperationException("SAVE_PATH_INVALID");
            return path;
        }

        private static long AddMilliseconds(long monotonic, long milliseconds)
        {
            var ticks = MillisecondsToTicks(milliseconds);
            return monotonic > long.MaxValue - ticks ? long.MaxValue : monotonic + ticks;
        }

        private static long MillisecondsToTicks(long milliseconds)
        {
            return checked((long)Math.Ceiling(milliseconds * (double)Stopwatch.Frequency / 1000d));
        }

        private static long Now() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

        private void OnDestroy()
        {
            operational = false;
            players?.Dispose();
            players = null;
            metrics = null;
        }

        private sealed class ActiveSave
        {
            internal BridgeClaim Claim;
            internal BridgeRequest Request;
            internal long StartedAtUnixMs;
            internal string SaveName;
            internal string DsvPath;
            internal string ServerPath;
            internal string ModdsvPath;
            internal BridgeSaveObservation Before;
            internal BridgeSaveObservation Last;
            internal SaveStabilityTracker Tracker;
            internal long DeadlineMonotonic;
            internal long NextPollMonotonic;
        }

        private sealed class ActiveKick
        {
            internal BridgeClaim Claim;
            internal BridgePlayerActionRequest Request;
            internal PlayerKickTarget Target;
            internal long StartedAtUnixMs;
            internal long DeadlineMonotonic;
        }

        private sealed class BridgeOperationException : Exception
        {
            internal BridgeOperationException(string code) : base(code) { Code = code; }
            internal string Code { get; }
        }
    }
}
