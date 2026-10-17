using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text;
using NebulaAPI;
using NebulaAPI.GameState;
using NebulaModel.Networking;

namespace DysonControl.Bridge
{
    internal sealed class PlayerRosterPublisher : IDisposable
    {
        private readonly BridgeFileStore store;
        private readonly int processId;
        private readonly Func<bool> runtimeReady;
        private readonly PlayerSessionState state = new PlayerSessionState(NewSessionId());
        private long rosterSequence;
        private long nextPublishAt;
        private bool dirty = true;
        private bool disposed;
        private bool sessionActive;

        internal PlayerRosterPublisher(BridgeFileStore store, int processId, Func<bool> runtimeReady)
        {
            this.store = store ?? throw new ArgumentNullException(nameof(store));
            if (processId <= 0) throw new ArgumentOutOfRangeException(nameof(processId));
            this.processId = processId;
            this.runtimeReady = runtimeReady ?? throw new ArgumentNullException(nameof(runtimeReady));
            NebulaModAPI.OnMultiplayerGameStarted += OnStarted;
            NebulaModAPI.OnMultiplayerGameEnded += OnEnded;
            NebulaModAPI.OnPlayerJoinedGame += OnJoined;
            NebulaModAPI.OnPlayerLeftGame += OnLeft;
        }

        internal void Tick(long nowUnixMs)
        {
            if (disposed || (!dirty && nowUnixMs < nextPublishAt)) return;
            dirty = false;
            nextPublishAt = nowUnixMs + 2000;
            var actionsAvailable = false;
            try { actionsAvailable = PublishAuthoritative(nowUnixMs); }
            catch { PublishRoster(nowUnixMs, "unavailable", false, Array.Empty<BridgePlayer>()); }
            store.WritePlayerActions(BridgeProtocol.SerializePlayerActions(new BridgePlayerActions
            {
                SessionId = state.SessionId,
                ProcessId = processId,
                WrittenAtUnixMs = nowUnixMs,
                State = actionsAvailable ? "available" : "unavailable"
            }, store.Secret));
            PublishEvents(nowUnixMs);
        }

        internal string SessionId => state.SessionId;
        internal bool SessionMatches(string sessionId) =>
            sessionActive && string.Equals(state.SessionId, sessionId, StringComparison.Ordinal);

        internal bool TryResolveKickTarget(string sessionId, string sessionPlayerId, out PlayerKickTarget target, out string errorCode)
        {
            target = null;
            if (!SessionMatches(sessionId))
            {
                errorCode = "PLAYER_SESSION_MISMATCH";
                return false;
            }
            if (!TryGetServer(out var server))
            {
                errorCode = "GAME_NOT_READY";
                return false;
            }
            foreach (var pair in server.Players.Connected)
            {
                var data = pair.Value?.Data;
                if (data == null || !state.TryGetSessionPlayerId(data, out var currentId) ||
                    !string.Equals(currentId, sessionPlayerId, StringComparison.Ordinal)) continue;
                if (!(pair.Key is NebulaConnection connection))
                {
                    errorCode = "PLAYER_CONNECTION_UNSUPPORTED";
                    return false;
                }
                target = new PlayerKickTarget
                {
                    SessionId = state.SessionId,
                    SessionPlayerId = currentId,
                    Connection = connection,
                    Data = data
                };
                errorCode = "NONE";
                return true;
            }
            errorCode = "PLAYER_NOT_ONLINE";
            return false;
        }

        internal bool IsTargetDisconnected(PlayerKickTarget target)
        {
            if (target == null || !SessionMatches(target.SessionId) || !state.WasObservedLeft(target.Data) ||
                !TryGetServer(out var server)) return false;
            return !server.Players.Connected.ContainsKey(target.Connection);
        }

        private bool PublishAuthoritative(long nowUnixMs)
        {
            var session = NebulaModAPI.MultiplayerSession;
            if (!NebulaModAPI.IsMultiplayerActive || session == null)
            {
                sessionActive = false;
                PublishRoster(nowUnixMs, "inactive", false, Array.Empty<BridgePlayer>());
                return false;
            }
            if (!runtimeReady())
            {
                PublishRoster(nowUnixMs, "unavailable", false, Array.Empty<BridgePlayer>());
                return false;
            }
            if (!session.IsDedicated || !session.IsServer || !session.IsGameLoaded || !(session.Network is IServer server))
            {
                PublishRoster(nowUnixMs, "unavailable", false, Array.Empty<BridgePlayer>());
                return false;
            }

            sessionActive = true;

            var connected = server.Players.Connected
                .Where(pair => pair.Key != null && pair.Value != null && pair.Value.Data != null)
                .OrderBy(pair => pair.Value.Data.PlayerId)
                .Take(BridgeProtocol.MaximumPlayers + 1)
                .ToList();
            var truncated = connected.Count > BridgeProtocol.MaximumPlayers;
            if (truncated) connected.RemoveAt(connected.Count - 1);

            var rows = new List<BridgePlayer>();
            foreach (var pair in connected)
            {
                var data = pair.Value.Data;
                var entry = state.Observed(data, fallback => PlayerText.DisplayName(data.Username, fallback), nowUnixMs);
                rows.Add(new BridgePlayer
                {
                    SessionPlayerId = entry.SessionPlayerId,
                    DisplayName = entry.DisplayName,
                    JoinedAtUnixMs = entry.JoinedAtUnixMs,
                    Location = PlayerText.Location(data.LocalPlanetId, data.LocalStarId)
                });
            }
            PublishRoster(nowUnixMs, "active", truncated, rows.OrderBy(row => row.SessionPlayerId, StringComparer.Ordinal).ToList());
            return server.Players.Connected.Keys.All(connection => connection is NebulaConnection);
        }

        private bool TryGetServer(out IServer server)
        {
            server = null;
            var session = NebulaModAPI.MultiplayerSession;
            if (!runtimeReady() || !NebulaModAPI.IsMultiplayerActive || session == null || !session.IsDedicated ||
                !session.IsServer || !session.IsGameLoaded || !(session.Network is IServer current)) return false;
            server = current;
            return true;
        }

        private void PublishRoster(long nowUnixMs, string snapshotState, bool truncated, IReadOnlyList<BridgePlayer> rows)
        {
            rosterSequence++;
            store.WritePlayers(BridgeProtocol.SerializePlayers(new BridgePlayerSnapshot
            {
                SessionId = state.SessionId,
                WrittenAtUnixMs = nowUnixMs,
                Sequence = rosterSequence,
                State = snapshotState,
                Truncated = truncated,
                Players = rows
            }, store.Secret));
        }

        private void PublishEvents(long nowUnixMs)
        {
            store.WritePlayerEvents(BridgeProtocol.SerializePlayerEvents(new BridgePlayerEventSnapshot
            {
                SessionId = state.SessionId,
                ProcessId = processId,
                WrittenAtUnixMs = Math.Max(nowUnixMs, state.LatestObservedAtUnixMs),
                Events = state.Events.ToList()
            }, store.Secret));
        }

        private void OnStarted()
        {
            state.Reset(NewSessionId());
            sessionActive = true;
            rosterSequence = 0;
            dirty = true;
            TryPublishEvents(Now());
        }

        private void OnEnded()
        {
            sessionActive = false;
            state.ClearRoster();
            dirty = true;
            TryPublishEvents(Now());
        }

        private void OnJoined(IPlayerData data)
        {
            if (disposed || data == null) return;
            var now = Now();
            try
            {
                state.Joined(data, fallback => PlayerText.DisplayName(data.Username, fallback), now);
                TryPublishEvents(now);
            }
            catch { }
            finally { dirty = true; }
        }

        private void OnLeft(IPlayerData data)
        {
            if (disposed || data == null) return;
            var now = Now();
            try
            {
                state.Left(data, fallback => PlayerText.DisplayName(data.Username, fallback), now);
                TryPublishEvents(now);
            }
            catch { }
            finally { dirty = true; }
        }

        private void TryPublishEvents(long nowUnixMs)
        {
            try { PublishEvents(nowUnixMs); }
            catch { }
        }

        private static string NewSessionId() => Guid.NewGuid().ToString("D").ToLowerInvariant();
        private static long Now() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

        public void Dispose()
        {
            if (disposed) return;
            disposed = true;
            NebulaModAPI.OnMultiplayerGameStarted -= OnStarted;
            NebulaModAPI.OnMultiplayerGameEnded -= OnEnded;
            NebulaModAPI.OnPlayerJoinedGame -= OnJoined;
            NebulaModAPI.OnPlayerLeftGame -= OnLeft;
        }
    }

    internal sealed class PlayerKickTarget
    {
        internal string SessionId;
        internal string SessionPlayerId;
        internal NebulaConnection Connection;
        internal IPlayerData Data;
    }

    internal static class PlayerText
    {
        internal static string DisplayName(string value, string fallback)
        {
            var source = (value ?? string.Empty).Normalize(NormalizationForm.FormC);
            var result = new StringBuilder();
            var elements = StringInfo.GetTextElementEnumerator(source);
            var scalars = 0;
            while (elements.MoveNext())
            {
                var element = elements.GetTextElement();
                if (element.Any(character => char.IsControl(character))) continue;
                var count = element.Length == 2 && char.IsSurrogatePair(element, 0) ? 1 : element.Length;
                if (scalars + count > 64 || Encoding.UTF8.GetByteCount(result + element) > 128) break;
                result.Append(element);
                scalars += count;
            }
            var normalized = result.ToString().Trim();
            return normalized.Length == 0 ? "Player " + fallback : normalized;
        }

        internal static string Location(int planetId, int starId)
        {
            if (planetId > 0) return "planet:" + planetId.ToString(CultureInfo.InvariantCulture);
            if (starId > 0) return "star:" + starId.ToString(CultureInfo.InvariantCulture);
            return "deep-space";
        }
    }
}
