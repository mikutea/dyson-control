using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;

namespace DysonControl.Bridge
{
    internal static class BridgeProtocol
    {
        internal const string RequestProtocol = "DYSON_CONTROL_REQUEST_V1";
        internal const string SaveReceiptProtocol = "DYSON_CONTROL_RECEIPT_V3";
        internal const string ActionReceiptProtocol = "DYSON_CONTROL_ACTION_V1";
        internal const string HeartbeatProtocol = "DYSON_CONTROL_HEARTBEAT_V1";
        internal const string PlayersProtocol = "DYSON_CONTROL_PLAYERS_V1";
        internal const string PlayerEventsProtocol = "DYSON_CONTROL_PLAYER_EVENTS_V1";
        internal const string PlayerActionsProtocol = "DYSON_CONTROL_PLAYER_ACTIONS_V1";
        internal const string PlayerActionRequestProtocol = "DYSON_CONTROL_PLAYER_ACTION_V1";
        internal const string PlayerActionReceiptProtocol = "DYSON_CONTROL_PLAYER_ACTION_RECEIPT_V1";
        internal const string MetricsProtocol = "DYSON_CONTROL_METRICS_V1";
        internal const string VersionsProtocol = "DYSON_CONTROL_VERSIONS_V1";
        internal const int MaximumPlayers = 64;
        internal const int MaximumPlayerEvents = 256;

        private static readonly string[] RequestKeys =
            { "protocol", "requestId", "createdAtUnixMs", "expiresAtUnixMs", "action", "nonce", "hmac" };
        private static readonly string[] SaveReceiptKeys =
        {
            "protocol", "requestId", "action", "state", "startedAtUnixMs", "finishedAtUnixMs",
            "saveName", "saveTimeBefore", "saveTimeAfter", "dsvBytes", "dsvWriteTimeUtcTicks",
            "serverBytes", "serverWriteTimeUtcTicks", "moddsvBytes", "moddsvWriteTimeUtcTicks",
            "dsvChanged", "serverChanged", "moddsvChanged", "errorCode", "hmac"
        };
        private static readonly string[] ActionReceiptKeys =
            { "protocol", "requestId", "action", "state", "startedAtUnixMs", "finishedAtUnixMs", "errorCode", "hmac" };
        private static readonly string[] HeartbeatKeys =
            { "protocol", "pluginVersion", "processId", "startedAtUnixMs", "writtenAtUnixMs", "state", "hmac" };
        private static readonly string[] PlayersKeys =
            { "protocol", "sessionId", "writtenAtUnixMs", "sequence", "state", "truncated", "playerCount", "playersJsonB64", "hmac" };
        private static readonly string[] PlayerEventsKeys =
            { "protocol", "sessionId", "processId", "writtenAtUnixMs", "firstSequence", "lastSequence", "eventCount", "eventsJsonB64", "hmac" };
        private static readonly string[] PlayerActionsKeys =
            { "protocol", "sessionId", "processId", "writtenAtUnixMs", "state", "hmac" };
        private static readonly string[] PlayerActionRequestKeys =
            { "protocol", "requestId", "createdAtUnixMs", "expiresAtUnixMs", "action", "sessionId", "sessionPlayerId", "nonce", "hmac" };
        private static readonly string[] PlayerActionReceiptKeys =
            { "protocol", "requestId", "action", "sessionId", "sessionPlayerId", "state", "startedAtUnixMs", "finishedAtUnixMs", "errorCode", "hmac" };
        private static readonly string[] MetricsKeys =
            { "protocol", "sessionId", "processId", "writtenAtUnixMs", "state", "ups", "tps", "gameTick", "hmac" };
        private static readonly string[] VersionsKeys =
            { "protocol", "processId", "writtenAtUnixMs", "game", "nebula", "bepinex", "bridge", "hmac" };

        internal static bool TryParseRequest(string payload, string secret, out BridgeRequest request, out string errorCode)
        {
            request = null;
            errorCode = "INVALID_REQUEST";
            if (!TryParseOrdered(payload, RequestKeys, 4096, out var row) || !TrySecret(secret, out var normalizedSecret) ||
                row["protocol"] != RequestProtocol || !Guid.TryParseExact(row["requestId"], "D", out var requestId) ||
                !TryPositiveInt64(row["createdAtUnixMs"], out var created) || !TryPositiveInt64(row["expiresAtUnixMs"], out var expires) ||
                expires <= created || expires - created > 120000 || (row["action"] != "save" && row["action"] != "stop") ||
                row["nonce"].Length < 16 || row["nonce"].Length > 128 || row["nonce"].Any(character => character > 127 || char.IsWhiteSpace(character)))
            {
                return false;
            }
            var expected = Hmac(normalizedSecret, RequestKeys.Take(RequestKeys.Length - 1).Select(key => row[key]));
            if (!FixedEquals(row["hmac"], expected)) { errorCode = "INVALID_SIGNATURE"; return false; }
            request = new BridgeRequest
            {
                RequestId = requestId.ToString("D").ToLowerInvariant(), CreatedAtUnixMs = created,
                ExpiresAtUnixMs = expires, Action = row["action"]
            };
            errorCode = "NONE";
            return true;
        }

        internal static bool TryParsePlayerActionRequest(string payload, string secret, out BridgePlayerActionRequest request, out string errorCode)
        {
            request = null;
            errorCode = "INVALID_REQUEST";
            if (!TryParseOrdered(payload, PlayerActionRequestKeys, 4096, out var row) || !TrySecret(secret, out var normalizedSecret) ||
                row["protocol"] != PlayerActionRequestProtocol || !TryCanonicalGuid(row["requestId"], out var requestId) ||
                !TryPositiveInt64(row["createdAtUnixMs"], out var created) || !TryPositiveInt64(row["expiresAtUnixMs"], out var expires) ||
                expires <= created || expires - created > 45000 || row["action"] != "kick-player" ||
                !TryCanonicalGuid(row["sessionId"], out var sessionId) ||
                !System.Text.RegularExpressions.Regex.IsMatch(row["sessionPlayerId"], "^player-[0-9]{6,12}$") ||
                !System.Text.RegularExpressions.Regex.IsMatch(row["nonce"], "^[0-9a-f]{32}$"))
            {
                return false;
            }
            var expected = Hmac(normalizedSecret, PlayerActionRequestKeys.Take(PlayerActionRequestKeys.Length - 1).Select(key => row[key]));
            if (!LowerHex64(row["hmac"]) || !FixedEquals(row["hmac"], expected)) { errorCode = "INVALID_SIGNATURE"; return false; }
            request = new BridgePlayerActionRequest
            {
                RequestId = requestId.ToString("D").ToLowerInvariant(),
                CreatedAtUnixMs = created,
                ExpiresAtUnixMs = expires,
                Action = row["action"],
                SessionId = sessionId.ToString("D").ToLowerInvariant(),
                SessionPlayerId = row["sessionPlayerId"]
            };
            errorCode = "NONE";
            return true;
        }

        internal static string SerializeHeartbeat(string version, int processId, long startedAt, long writtenAt, string state, string secret)
        {
            if (state != "ready" && state != "unavailable") throw new InvalidOperationException("Heartbeat state is invalid.");
            var values = new[] { HeartbeatProtocol, version, I(processId), I(startedAt), I(writtenAt), state };
            return Serialize(HeartbeatKeys, values.Concat(new[] { Hmac(secret, values) }).ToArray());
        }

        internal static string SerializePlayers(BridgePlayerSnapshot snapshot, string secret)
        {
            if (!Guid.TryParseExact(snapshot.SessionId, "D", out var parsed) || snapshot.WrittenAtUnixMs <= 0 ||
                snapshot.Sequence <= 0 || (snapshot.State != "active" && snapshot.State != "inactive" && snapshot.State != "unavailable") ||
                snapshot.Players == null || snapshot.Players.Count > MaximumPlayers ||
                (snapshot.State != "active" && (snapshot.Players.Count != 0 || snapshot.Truncated))) throw new InvalidOperationException("Player snapshot is invalid.");
            var ordered = snapshot.Players.OrderBy(player => player.SessionPlayerId, StringComparer.Ordinal).ToList();
            var json = "[" + string.Join(",", ordered.Select(SerializePlayer)) + "]";
            var encoded = Base64Url(Encoding.UTF8.GetBytes(json));
            var values = new[]
            {
                PlayersProtocol, parsed.ToString("D").ToLowerInvariant(), I(snapshot.WrittenAtUnixMs), I(snapshot.Sequence),
                snapshot.State, snapshot.Truncated ? "true" : "false", I(ordered.Count), encoded
            };
            return Serialize(PlayersKeys, values.Concat(new[] { Hmac(secret, values) }).ToArray());
        }

        internal static string SerializeMetrics(BridgeMetrics metrics, string secret)
        {
            if (!Guid.TryParseExact(metrics.SessionId, "D", out var parsed) || metrics.ProcessId <= 0 || metrics.WrittenAtUnixMs <= 0 ||
                (metrics.State != "active" && metrics.State != "unavailable")) throw new InvalidOperationException("Metrics are invalid.");
            var active = metrics.State == "active";
            if ((active && (!FiniteNonnegative(metrics.Ups) || !FiniteNonnegative(metrics.Tps) || metrics.GameTick < 0)) ||
                (!active && (metrics.Ups != -1 || metrics.Tps != -1 || metrics.GameTick != -1))) throw new InvalidOperationException("Metrics values are invalid.");
            var values = new[]
            {
                MetricsProtocol, parsed.ToString("D").ToLowerInvariant(), I(metrics.ProcessId), I(metrics.WrittenAtUnixMs), metrics.State,
                D(metrics.Ups), D(metrics.Tps), I(metrics.GameTick)
            };
            return Serialize(MetricsKeys, values.Concat(new[] { Hmac(secret, values) }).ToArray());
        }

        internal static string SerializeVersions(BridgeVersions versions, string secret)
        {
            if (versions == null || versions.ProcessId <= 0 || versions.WrittenAtUnixMs <= 0 ||
                !ValidAsciiVersion(versions.Game) || !ValidAsciiVersion(versions.Nebula) ||
                !ValidAsciiVersion(versions.BepInEx) || !ValidAsciiVersion(versions.Bridge))
                throw new InvalidOperationException("Version snapshot is invalid.");
            var values = new[]
            {
                VersionsProtocol, I(versions.ProcessId), I(versions.WrittenAtUnixMs),
                versions.Game, versions.Nebula, versions.BepInEx, versions.Bridge
            };
            return Serialize(VersionsKeys, values.Concat(new[] { Hmac(secret, values) }).ToArray());
        }

        internal static string SerializePlayerEvents(BridgePlayerEventSnapshot snapshot, string secret)
        {
            if (snapshot == null || !Guid.TryParseExact(snapshot.SessionId, "D", out var parsed) || snapshot.ProcessId <= 0 ||
                snapshot.WrittenAtUnixMs <= 0 || snapshot.Events == null || snapshot.Events.Count > MaximumPlayerEvents)
                throw new InvalidOperationException("Player event snapshot is invalid.");
            var events = snapshot.Events.ToList();
            for (var index = 0; index < events.Count; index++)
            {
                var current = events[index];
                if (current == null || current.Sequence <= 0 ||
                    (index > 0 && current.Sequence != events[index - 1].Sequence + 1) ||
                    (current.Type != "join" && current.Type != "leave" && current.Type != "firstObserved") ||
                    !System.Text.RegularExpressions.Regex.IsMatch(current.SessionPlayerId ?? "", "^player-[0-9]{6,12}$") ||
                    string.IsNullOrWhiteSpace(current.DisplayName) || current.ObservedAtUnixMs <= 0 ||
                    current.ObservedAtUnixMs > snapshot.WrittenAtUnixMs)
                    throw new InvalidOperationException("Player event row is invalid.");
            }
            var first = events.Count == 0 ? 0 : events[0].Sequence;
            var last = events.Count == 0 ? 0 : events[events.Count - 1].Sequence;
            var json = "[" + string.Join(",", events.Select(SerializePlayerEvent)) + "]";
            var values = new[]
            {
                PlayerEventsProtocol, parsed.ToString("D").ToLowerInvariant(), I(snapshot.ProcessId), I(snapshot.WrittenAtUnixMs),
                I(first), I(last), I(events.Count), Base64Url(Encoding.UTF8.GetBytes(json))
            };
            return Serialize(PlayerEventsKeys, values.Concat(new[] { Hmac(secret, values) }).ToArray());
        }

        internal static string SerializePlayerActions(BridgePlayerActions actions, string secret)
        {
            if (actions == null || !TryCanonicalGuid(actions.SessionId, out var sessionId) || actions.ProcessId <= 0 ||
                actions.WrittenAtUnixMs <= 0 || (actions.State != "available" && actions.State != "unavailable"))
                throw new InvalidOperationException("Player actions capability is invalid.");
            var values = new[]
            {
                PlayerActionsProtocol, sessionId.ToString("D").ToLowerInvariant(), I(actions.ProcessId),
                I(actions.WrittenAtUnixMs), actions.State
            };
            return Serialize(PlayerActionsKeys, values.Concat(new[] { Hmac(secret, values) }).ToArray());
        }

        internal static string SerializeSaveReceipt(BridgeSaveReceipt receipt, string secret)
        {
            ValidateReceiptIdentity(receipt.RequestId, receipt.State, receipt.StartedAtUnixMs, receipt.FinishedAtUnixMs, receipt.ErrorCode);
            if (!ValidSaveName(receipt.SaveName)) throw new InvalidOperationException("Save receipt name is invalid.");
            var values = new[]
            {
                SaveReceiptProtocol, receipt.RequestId, "save", receipt.State, I(receipt.StartedAtUnixMs), I(receipt.FinishedAtUnixMs),
                receipt.SaveName, I(receipt.SaveTimeBefore), I(receipt.SaveTimeAfter), I(receipt.Dsv.Bytes), I(receipt.Dsv.Ticks),
                I(receipt.Server.Bytes), I(receipt.Server.Ticks), I(receipt.Moddsv.Bytes), I(receipt.Moddsv.Ticks),
                B(receipt.Dsv.Changed), B(receipt.Server.Changed), B(receipt.Moddsv.Changed), receipt.ErrorCode
            };
            return Serialize(SaveReceiptKeys, values.Concat(new[] { Hmac(secret, values) }).ToArray());
        }

        internal static string SerializeActionReceipt(BridgeActionReceipt receipt, string secret)
        {
            ValidateReceiptIdentity(receipt.RequestId, receipt.State, receipt.StartedAtUnixMs, receipt.FinishedAtUnixMs, receipt.ErrorCode);
            if (receipt.Action != "stop") throw new InvalidOperationException("Action receipt is invalid.");
            var values = new[]
            {
                ActionReceiptProtocol, receipt.RequestId, receipt.Action, receipt.State,
                I(receipt.StartedAtUnixMs), I(receipt.FinishedAtUnixMs), receipt.ErrorCode
            };
            return Serialize(ActionReceiptKeys, values.Concat(new[] { Hmac(secret, values) }).ToArray());
        }

        internal static string SerializePlayerActionReceipt(BridgePlayerActionReceipt receipt, string secret)
        {
            ValidateReceiptIdentity(receipt.RequestId, receipt.State, receipt.StartedAtUnixMs, receipt.FinishedAtUnixMs, receipt.ErrorCode);
            if (receipt.Action != "kick-player" || !TryCanonicalGuid(receipt.SessionId, out var sessionId) ||
                !System.Text.RegularExpressions.Regex.IsMatch(receipt.SessionPlayerId ?? "", "^player-[0-9]{6,12}$") ||
                !ValidPlayerActionErrorCode(receipt.ErrorCode))
                throw new InvalidOperationException("Player action receipt is invalid.");
            var values = new[]
            {
                PlayerActionReceiptProtocol, receipt.RequestId, receipt.Action, sessionId.ToString("D").ToLowerInvariant(),
                receipt.SessionPlayerId, receipt.State, I(receipt.StartedAtUnixMs), I(receipt.FinishedAtUnixMs), receipt.ErrorCode
            };
            return Serialize(PlayerActionReceiptKeys, values.Concat(new[] { Hmac(secret, values) }).ToArray());
        }

        private static string SerializePlayer(BridgePlayer player)
        {
            if (player == null || !System.Text.RegularExpressions.Regex.IsMatch(player.SessionPlayerId ?? "", "^player-[0-9]{6,12}$") ||
                string.IsNullOrWhiteSpace(player.DisplayName) || player.JoinedAtUnixMs <= 0 ||
                !System.Text.RegularExpressions.Regex.IsMatch(player.Location ?? "", "^(deep-space|planet:[1-9][0-9]{0,9}|star:[1-9][0-9]{0,9})$"))
                throw new InvalidOperationException("Player row is invalid.");
            return "{\"sessionPlayerId\":\"" + Json(player.SessionPlayerId) + "\",\"displayName\":\"" + Json(player.DisplayName) +
                   "\",\"online\":true,\"joinedAtUnixMs\":" + I(player.JoinedAtUnixMs) + ",\"location\":\"" + Json(player.Location) + "\"}";
        }

        private static string SerializePlayerEvent(BridgePlayerEvent playerEvent) =>
            "{\"sequence\":" + I(playerEvent.Sequence) + ",\"type\":\"" + Json(playerEvent.Type) +
            "\",\"sessionPlayerId\":\"" + Json(playerEvent.SessionPlayerId) + "\",\"displayName\":\"" +
            Json(playerEvent.DisplayName) + "\",\"observedAtUnixMs\":" + I(playerEvent.ObservedAtUnixMs) + "}";

        private static string Json(string value)
        {
            var result = new StringBuilder();
            foreach (var character in value)
            {
                switch (character)
                {
                    case '\"': result.Append("\\\""); break;
                    case '\\': result.Append("\\\\"); break;
                    case '\b': result.Append("\\b"); break;
                    case '\f': result.Append("\\f"); break;
                    case '\n': result.Append("\\n"); break;
                    case '\r': result.Append("\\r"); break;
                    case '\t': result.Append("\\t"); break;
                    default:
                        if (character < 0x20) result.Append("\\u").Append(((int)character).ToString("x4", CultureInfo.InvariantCulture));
                        else result.Append(character);
                        break;
                }
            }
            return result.ToString();
        }

        private static void ValidateReceiptIdentity(string requestId, string state, long started, long finished, string errorCode)
        {
            if (!Guid.TryParseExact(requestId, "D", out var parsed) || parsed.ToString("D") != requestId ||
                (state != "succeeded" && state != "failed") || started <= 0 || finished < started ||
                string.IsNullOrWhiteSpace(errorCode) || errorCode.Any(character => character == '\r' || character == '\n' || character == '\0') ||
                (state == "succeeded" && errorCode != "NONE") || (state == "failed" && errorCode == "NONE"))
                throw new InvalidOperationException("Receipt identity is invalid.");
        }

        private static bool ValidSaveName(string value) => !string.IsNullOrEmpty(value) && value.Length <= 120 && value != "." && value != ".." && value.All(c => c >= 0x20 && "\\/:*?\"<>|".IndexOf(c) < 0);
        private static bool ValidAsciiVersion(string value) =>
            !string.IsNullOrEmpty(value) && value.Length <= 128 && value.All(character => character >= 0x21 && character <= 0x7e);
        private static bool TryParseOrdered(string payload, string[] keys, int maximumBytes, out Dictionary<string, string> values)
        {
            values = null;
            if (payload == null || Encoding.UTF8.GetByteCount(payload) > maximumBytes || payload.IndexOf('\0') >= 0 || payload.IndexOf('\ufeff') >= 0) return false;
            var lines = payload.Replace("\r\n", "\n").Split('\n').ToList();
            if (lines.Count > 0 && lines[lines.Count - 1] == "") lines.RemoveAt(lines.Count - 1);
            if (lines.Count != keys.Length) return false;
            var parsed = new Dictionary<string, string>(StringComparer.Ordinal);
            for (var index = 0; index < keys.Length; index++)
            {
                var prefix = keys[index] + "=";
                if (!lines[index].StartsWith(prefix, StringComparison.Ordinal) || lines[index].Length == prefix.Length) return false;
                parsed[keys[index]] = lines[index].Substring(prefix.Length);
            }
            values = parsed;
            return true;
        }

        private static string Serialize(string[] keys, string[] values)
        {
            if (keys.Length != values.Length || values.Any(value => string.IsNullOrEmpty(value) || value.IndexOfAny(new[] { '\r', '\n', '\0' }) >= 0))
                throw new InvalidOperationException("Protocol value is invalid.");
            return string.Join("\n", keys.Select((key, index) => key + "=" + values[index])) + "\n";
        }

        private static bool TrySecret(string value, out string secret)
        {
            secret = (value ?? "").Trim();
            return secret.Length >= 32 && secret.Length <= 512 && secret.IndexOfAny(new[] { '\r', '\n', '\0' }) < 0;
        }

        private static string Hmac(string secret, IEnumerable<string> values)
        {
            if (!TrySecret(secret, out var normalized)) throw new InvalidOperationException("Bridge secret is invalid.");
            using (var algorithm = new HMACSHA256(Encoding.UTF8.GetBytes(normalized)))
                return string.Concat(algorithm.ComputeHash(Encoding.UTF8.GetBytes(string.Join("\n", values))).Select(value => value.ToString("x2", CultureInfo.InvariantCulture)));
        }

        private static bool FixedEquals(string actual, string expected)
        {
            if (actual == null || actual.Length != 64 || !actual.All(Uri.IsHexDigit)) return false;
            var difference = 0;
            for (var index = 0; index < expected.Length; index++) difference |= char.ToLowerInvariant(actual[index]) ^ expected[index];
            return difference == 0;
        }

        private static bool TryCanonicalGuid(string value, out Guid parsed) =>
            Guid.TryParseExact(value, "D", out parsed) && parsed.ToString("D") == value;

        private static bool LowerHex64(string value) =>
            value != null && System.Text.RegularExpressions.Regex.IsMatch(value, "^[0-9a-f]{64}$");

        private static bool ValidPlayerActionErrorCode(string value) => new[]
        {
            "NONE", "GAME_NOT_READY", "PLAYER_SESSION_MISMATCH", "PLAYER_NOT_ONLINE",
            "PLAYER_CONNECTION_UNSUPPORTED", "PLAYER_SOCKET_NOT_OPEN", "KICK_CLOSE_FAILED",
            "KICK_TIMEOUT", "SESSION_CHANGED", "REQUEST_EXPIRED", "INTERRUPTED_UNCERTAIN"
        }.Contains(value, StringComparer.Ordinal);

        private static bool TryPositiveInt64(string value, out long parsed) => long.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out parsed) && parsed > 0 && I(parsed) == value;
        private static bool FiniteNonnegative(double value) => !double.IsNaN(value) && !double.IsInfinity(value) && value >= 0;
        private static string Base64Url(byte[] bytes) => Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        private static string I(long value) => value.ToString(CultureInfo.InvariantCulture);
        private static string D(double value) => value.ToString("0.###", CultureInfo.InvariantCulture);
        private static string B(bool value) => value ? "true" : "false";
    }

    internal sealed class BridgeRequest { internal string RequestId; internal long CreatedAtUnixMs; internal long ExpiresAtUnixMs; internal string Action; }
    internal sealed class BridgeFileEvidence { internal long Bytes = -1; internal long Ticks = -1; internal bool Changed; }
    internal sealed class BridgeSaveReceipt
    {
        internal string RequestId; internal string State; internal long StartedAtUnixMs; internal long FinishedAtUnixMs;
        internal string SaveName; internal long SaveTimeBefore = -1; internal long SaveTimeAfter = -1;
        internal BridgeFileEvidence Dsv = new BridgeFileEvidence(); internal BridgeFileEvidence Server = new BridgeFileEvidence();
        internal BridgeFileEvidence Moddsv = new BridgeFileEvidence(); internal string ErrorCode;
    }
    internal sealed class BridgeActionReceipt { internal string RequestId; internal string Action; internal string State; internal long StartedAtUnixMs; internal long FinishedAtUnixMs; internal string ErrorCode; }
    internal sealed class BridgePlayerActionRequest
    {
        internal string RequestId; internal long CreatedAtUnixMs; internal long ExpiresAtUnixMs; internal string Action;
        internal string SessionId; internal string SessionPlayerId;
    }
    internal sealed class BridgePlayerActionReceipt
    {
        internal string RequestId; internal string Action; internal string SessionId; internal string SessionPlayerId;
        internal string State; internal long StartedAtUnixMs; internal long FinishedAtUnixMs; internal string ErrorCode;
    }
    internal sealed class BridgePlayer { internal string SessionPlayerId; internal string DisplayName; internal long JoinedAtUnixMs; internal string Location; }
    internal sealed class BridgePlayerSnapshot { internal string SessionId; internal long WrittenAtUnixMs; internal long Sequence; internal string State; internal bool Truncated; internal IReadOnlyList<BridgePlayer> Players; }
    internal sealed class BridgePlayerEvent { internal long Sequence; internal string Type; internal string SessionPlayerId; internal string DisplayName; internal long ObservedAtUnixMs; }
    internal sealed class BridgePlayerEventSnapshot { internal string SessionId; internal int ProcessId; internal long WrittenAtUnixMs; internal IReadOnlyList<BridgePlayerEvent> Events; }
    internal sealed class BridgePlayerActions { internal string SessionId; internal int ProcessId; internal long WrittenAtUnixMs; internal string State; }
    internal sealed class BridgeMetrics { internal string SessionId; internal int ProcessId; internal long WrittenAtUnixMs; internal string State; internal double Ups; internal double Tps; internal long GameTick; }
    internal sealed class BridgeVersions { internal int ProcessId; internal long WrittenAtUnixMs; internal string Game; internal string Nebula; internal string BepInEx; internal string Bridge; }
}
