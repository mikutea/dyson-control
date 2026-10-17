using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Runtime.CompilerServices;

namespace DysonControl.Bridge
{
    internal sealed class PlayerSessionState
    {
        private readonly Dictionary<object, PlayerSessionEntry> byIdentity =
            new Dictionary<object, PlayerSessionEntry>(ReferenceComparer.Instance);
        private readonly List<BridgePlayerEvent> events = new List<BridgePlayerEvent>();
        private readonly HashSet<object> observedLeft = new HashSet<object>(ReferenceComparer.Instance);
        private long nextPlayerOrdinal;
        private long nextEventSequence;

        internal PlayerSessionState(string sessionId)
        {
            Reset(sessionId);
        }

        internal string SessionId { get; private set; }
        internal IReadOnlyList<BridgePlayerEvent> Events => events;
        internal long LatestObservedAtUnixMs => events.Count == 0 ? 0 : events.Max(item => item.ObservedAtUnixMs);

        internal void Reset(string sessionId)
        {
            if (!Guid.TryParseExact(sessionId, "D", out var parsed)) throw new ArgumentException("Session ID is invalid.", nameof(sessionId));
            SessionId = parsed.ToString("D").ToLowerInvariant();
            nextPlayerOrdinal = 0;
            nextEventSequence = 0;
            byIdentity.Clear();
            observedLeft.Clear();
            events.Clear();
        }

        internal PlayerSessionEntry Joined(object identity, Func<string, string> displayName, long observedAtUnixMs)
        {
            ValidateObservation(identity, displayName, observedAtUnixMs);
            observedLeft.Remove(identity);
            if (byIdentity.TryGetValue(identity, out var existing))
            {
                existing.DisplayName = ResolveName(displayName, existing.SessionPlayerId);
                return existing;
            }
            var entry = Allocate(identity, observedAtUnixMs);
            entry.DisplayName = ResolveName(displayName, entry.SessionPlayerId);
            Append("join", entry, entry.DisplayName, observedAtUnixMs);
            return entry;
        }

        internal PlayerSessionEntry Observed(object identity, Func<string, string> displayName, long observedAtUnixMs)
        {
            ValidateObservation(identity, displayName, observedAtUnixMs);
            if (byIdentity.TryGetValue(identity, out var existing))
            {
                existing.DisplayName = ResolveName(displayName, existing.SessionPlayerId);
                return existing;
            }
            var entry = Allocate(identity, observedAtUnixMs);
            entry.DisplayName = ResolveName(displayName, entry.SessionPlayerId);
            Append("firstObserved", entry, entry.DisplayName, observedAtUnixMs);
            return entry;
        }

        internal PlayerSessionEntry Left(object identity, Func<string, string> displayName, long observedAtUnixMs)
        {
            ValidateObservation(identity, displayName, observedAtUnixMs);
            if (!byIdentity.TryGetValue(identity, out var entry))
            {
                entry = Allocate(identity, observedAtUnixMs);
                entry.DisplayName = ResolveName(displayName, entry.SessionPlayerId);
                Append("firstObserved", entry, entry.DisplayName, observedAtUnixMs);
            }
            else entry.DisplayName = ResolveName(displayName, entry.SessionPlayerId);
            Append("leave", entry, entry.DisplayName, observedAtUnixMs);
            byIdentity.Remove(identity);
            observedLeft.Add(identity);
            return entry;
        }

        internal bool TryGetSessionPlayerId(object identity, out string sessionPlayerId)
        {
            if (identity != null && byIdentity.TryGetValue(identity, out var entry))
            {
                sessionPlayerId = entry.SessionPlayerId;
                return true;
            }
            sessionPlayerId = null;
            return false;
        }

        internal bool WasObservedLeft(object identity) => identity != null && observedLeft.Contains(identity);

        internal void ClearRoster()
        {
            byIdentity.Clear();
        }

        private PlayerSessionEntry Allocate(object identity, long observedAtUnixMs)
        {
            if (nextPlayerOrdinal >= 999999999999L) throw new InvalidOperationException("Player session IDs are exhausted.");
            var entry = new PlayerSessionEntry
            {
                SessionPlayerId = "player-" + (++nextPlayerOrdinal).ToString("D6", CultureInfo.InvariantCulture),
                JoinedAtUnixMs = observedAtUnixMs
            };
            byIdentity.Add(identity, entry);
            return entry;
        }

        private void Append(string type, PlayerSessionEntry entry, string displayName, long observedAtUnixMs)
        {
            entry.DisplayName = displayName;
            events.Add(new BridgePlayerEvent
            {
                Sequence = ++nextEventSequence,
                Type = type,
                SessionPlayerId = entry.SessionPlayerId,
                DisplayName = displayName,
                ObservedAtUnixMs = observedAtUnixMs
            });
            if (events.Count > BridgeProtocol.MaximumPlayerEvents) events.RemoveRange(0, events.Count - BridgeProtocol.MaximumPlayerEvents);
        }

        private static void ValidateObservation(object identity, Func<string, string> displayName, long observedAtUnixMs)
        {
            if (identity == null || displayName == null || observedAtUnixMs <= 0)
                throw new ArgumentException("Player observation is invalid.");
        }

        private static string ResolveName(Func<string, string> displayName, string sessionPlayerId)
        {
            var resolved = displayName(sessionPlayerId);
            if (string.IsNullOrWhiteSpace(resolved)) throw new ArgumentException("Player display name is invalid.");
            return resolved;
        }

        private sealed class ReferenceComparer : IEqualityComparer<object>
        {
            internal static readonly ReferenceComparer Instance = new ReferenceComparer();
            public new bool Equals(object left, object right) => ReferenceEquals(left, right);
            public int GetHashCode(object value) => RuntimeHelpers.GetHashCode(value);
        }
    }

    internal sealed class PlayerSessionEntry
    {
        internal string SessionPlayerId;
        internal string DisplayName;
        internal long JoinedAtUnixMs;
    }
}
