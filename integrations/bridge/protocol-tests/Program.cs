using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using DysonControl.Bridge;

internal static class Program
{
    private const string Secret = "0123456789abcdef0123456789abcdef0123456789abcdef";
    private static int checks;

    private static void Main()
    {
        Request("save");
        Request("stop");
        PlayerActionRequest();
        Snapshots();
        Versions();
        PlayerEvents();
        PlayerLifecycle();
        Receipts();
        FileStore();
        SaveStability();
        PhysicalDirectoryIdentity();
        Console.WriteLine("Bridge protocol checks passed: " + checks);
    }

    private static void Request(string action)
    {
        var id = action == "save" ? "11111111-2222-4333-8444-555555555555" : "22222222-3333-4444-8555-666666666666";
        var payload = RequestPayload(id, action);
        Check(BridgeProtocol.TryParseRequest(payload, Secret, out var parsed, out var error) && parsed.Action == action && error == "NONE", action + " request parses");
        Check(!BridgeProtocol.TryParseRequest(payload.Replace("action=" + action, "action=other"), Secret, out _, out _), action + " request rejects mutation");
    }

    private static void Snapshots()
    {
        var heartbeat = BridgeProtocol.SerializeHeartbeat("0.1.0", 1234, 1792040000000, 1792040002000, "ready", Secret);
        OrderedAndSigned(heartbeat, new[] { "protocol", "pluginVersion", "processId", "startedAtUnixMs", "writtenAtUnixMs", "state", "hmac" });
        var unavailableHeartbeat = BridgeProtocol.SerializeHeartbeat("0.1.0", 1234, 1792040000000, 1792040003000, "unavailable", Secret);
        Check(unavailableHeartbeat.Contains("state=unavailable\n", StringComparison.Ordinal), "heartbeat represents unavailable runtime without false readiness");

        var actions = BridgeProtocol.SerializePlayerActions(new BridgePlayerActions
        {
            SessionId = "33333333-4444-4555-8666-777777777777", ProcessId = 1234,
            WrittenAtUnixMs = 1792040002000, State = "available"
        }, Secret);
        OrderedAndSigned(actions, new[] { "protocol", "sessionId", "processId", "writtenAtUnixMs", "state", "hmac" });
        Check(actions.StartsWith("protocol=DYSON_CONTROL_PLAYER_ACTIONS_V1", StringComparison.Ordinal), "player action capability is explicit and signed");

        var players = BridgeProtocol.SerializePlayers(new BridgePlayerSnapshot
        {
            SessionId = "33333333-4444-4555-8666-777777777777", WrittenAtUnixMs = 1792040002000, Sequence = 2,
            State = "active", Truncated = false, Players = new[]
            {
                new BridgePlayer { SessionPlayerId = "player-000002", DisplayName = "星海", JoinedAtUnixMs = 1792040001000, Location = "star:2" },
                new BridgePlayer { SessionPlayerId = "player-000001", DisplayName = "Nova", JoinedAtUnixMs = 1792040000000, Location = "planet:101" }
            }
        }, Secret);
        OrderedAndSigned(players, new[] { "protocol", "sessionId", "writtenAtUnixMs", "sequence", "state", "truncated", "playerCount", "playersJsonB64", "hmac" });
        var encoded = Value(players, "playersJsonB64");
        var json = Encoding.UTF8.GetString(Convert.FromBase64String(encoded.Replace('-', '+').Replace('_', '/') + new string('=', (4 - encoded.Length % 4) % 4)));
        Check(json.StartsWith("[{\"sessionPlayerId\":\"player-000001\"", StringComparison.Ordinal), "players use canonical key and ordinal order");

        var metrics = BridgeProtocol.SerializeMetrics(new BridgeMetrics
        {
            SessionId = "33333333-4444-4555-8666-777777777777", ProcessId = 1234, WrittenAtUnixMs = 1792040002000,
            State = "active", Ups = 59.875, Tps = 60, GameTick = 123456
        }, Secret);
        OrderedAndSigned(metrics, new[] { "protocol", "sessionId", "processId", "writtenAtUnixMs", "state", "ups", "tps", "gameTick", "hmac" });
        Check(!metrics.Contains("sequence=", StringComparison.Ordinal) && metrics.Contains("ups=59.875\ntps=60\ngameTick=123456", StringComparison.Ordinal), "metrics decimals and fields are canonical");

        var unavailable = BridgeProtocol.SerializeMetrics(new BridgeMetrics
        {
            SessionId = "33333333-4444-4555-8666-777777777777", ProcessId = 1234, WrittenAtUnixMs = 1792040003000,
            State = "unavailable", Ups = -1, Tps = -1, GameTick = -1
        }, Secret);
        Check(unavailable.Contains("state=unavailable\nups=-1\ntps=-1\ngameTick=-1", StringComparison.Ordinal), "unavailable metrics use fixed sentinels");
    }

    private static void Versions()
    {
        var payload = BridgeProtocol.SerializeVersions(new BridgeVersions
        {
            ProcessId = 1234,
            WrittenAtUnixMs = 1792040002000,
            Game = "0.10.34.28470",
            Nebula = "0.9.24",
            BepInEx = "5.4.17.0",
            Bridge = "0.1.0"
        }, Secret);
        OrderedAndSigned(payload, new[] { "protocol", "processId", "writtenAtUnixMs", "game", "nebula", "bepinex", "bridge", "hmac" });
        Check(payload.StartsWith("protocol=DYSON_CONTROL_VERSIONS_V1", StringComparison.Ordinal), "versions use a dedicated signed protocol");

        foreach (var invalid in new[] { "", "1 2", "\u00e9", new string('1', 129) })
        {
            var rejected = false;
            try
            {
                BridgeProtocol.SerializeVersions(new BridgeVersions
                {
                    ProcessId = 1234, WrittenAtUnixMs = 1792040002000, Game = invalid,
                    Nebula = "0.9.24", BepInEx = "5.4.17.0", Bridge = "0.1.0"
                }, Secret);
            }
            catch (InvalidOperationException) { rejected = true; }
            Check(rejected, "versions reject empty, non-ASCII, whitespace, and overlong values");
        }
    }

    private static void Receipts()
    {
        var save = BridgeProtocol.SerializeSaveReceipt(new BridgeSaveReceipt
        {
            RequestId = "44444444-5555-4666-8777-888888888888", State = "succeeded", StartedAtUnixMs = 1792040000000,
            FinishedAtUnixMs = 1792040001000, SaveName = "World", SaveTimeBefore = 10, SaveTimeAfter = 11,
            Dsv = new BridgeFileEvidence { Bytes = 100, Ticks = 638900000000000000, Changed = true },
            Server = new BridgeFileEvidence { Bytes = 200, Ticks = 638900000000000001, Changed = true },
            Moddsv = new BridgeFileEvidence(), ErrorCode = "NONE"
        }, Secret);
        OrderedAndSigned(save, new[] { "protocol", "requestId", "action", "state", "startedAtUnixMs", "finishedAtUnixMs", "saveName", "saveTimeBefore", "saveTimeAfter", "dsvBytes", "dsvWriteTimeUtcTicks", "serverBytes", "serverWriteTimeUtcTicks", "moddsvBytes", "moddsvWriteTimeUtcTicks", "dsvChanged", "serverChanged", "moddsvChanged", "errorCode", "hmac" });
        Check(save.StartsWith("protocol=DYSON_CONTROL_RECEIPT_V3", StringComparison.Ordinal), "save receipt uses V3");

        var action = BridgeProtocol.SerializeActionReceipt(new BridgeActionReceipt
        {
            RequestId = "55555555-6666-4777-8888-999999999999", Action = "stop", State = "succeeded",
            StartedAtUnixMs = 1792040000000, FinishedAtUnixMs = 1792040000001, ErrorCode = "NONE"
        }, Secret);
        OrderedAndSigned(action, new[] { "protocol", "requestId", "action", "state", "startedAtUnixMs", "finishedAtUnixMs", "errorCode", "hmac" });
        Check(action.StartsWith("protocol=DYSON_CONTROL_ACTION_V1", StringComparison.Ordinal), "stop receipt uses action protocol");

        var playerAction = BridgeProtocol.SerializePlayerActionReceipt(new BridgePlayerActionReceipt
        {
            RequestId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", Action = "kick-player",
            SessionId = "33333333-4444-4555-8666-777777777777", SessionPlayerId = "player-000001",
            State = "succeeded", StartedAtUnixMs = 1792040000000, FinishedAtUnixMs = 1792040000001, ErrorCode = "NONE"
        }, Secret);
        OrderedAndSigned(playerAction, new[] { "protocol", "requestId", "action", "sessionId", "sessionPlayerId", "state", "startedAtUnixMs", "finishedAtUnixMs", "errorCode", "hmac" });
        Check(playerAction.StartsWith("protocol=DYSON_CONTROL_PLAYER_ACTION_RECEIPT_V1", StringComparison.Ordinal), "player action receipt has a dedicated protocol");
    }

    private static void PlayerEvents()
    {
        var payload = BridgeProtocol.SerializePlayerEvents(new BridgePlayerEventSnapshot
        {
            SessionId = "33333333-4444-4555-8666-777777777777",
            ProcessId = 1234,
            WrittenAtUnixMs = 1792040003000,
            Events = new[]
            {
                new BridgePlayerEvent { Sequence = 8, Type = "join", SessionPlayerId = "player-000001", DisplayName = "Nova", ObservedAtUnixMs = 1792040001000 },
                new BridgePlayerEvent { Sequence = 9, Type = "leave", SessionPlayerId = "player-000001", DisplayName = "Nova", ObservedAtUnixMs = 1792040002000 }
            }
        }, Secret);
        OrderedAndSigned(payload, new[] { "protocol", "sessionId", "processId", "writtenAtUnixMs", "firstSequence", "lastSequence", "eventCount", "eventsJsonB64", "hmac" });
        Check(payload.Contains("firstSequence=8\nlastSequence=9\neventCount=2", StringComparison.Ordinal), "player event sequence window is explicit");
        var json = Decode(Value(payload, "eventsJsonB64"));
        Check(json == "[{\"sequence\":8,\"type\":\"join\",\"sessionPlayerId\":\"player-000001\",\"displayName\":\"Nova\",\"observedAtUnixMs\":1792040001000},{\"sequence\":9,\"type\":\"leave\",\"sessionPlayerId\":\"player-000001\",\"displayName\":\"Nova\",\"observedAtUnixMs\":1792040002000}]", "player events use exact canonical JSON keys");

        var empty = BridgeProtocol.SerializePlayerEvents(new BridgePlayerEventSnapshot
        {
            SessionId = "33333333-4444-4555-8666-777777777777", ProcessId = 1234,
            WrittenAtUnixMs = 1792040003000, Events = Array.Empty<BridgePlayerEvent>()
        }, Secret);
        Check(empty.Contains("firstSequence=0\nlastSequence=0\neventCount=0", StringComparison.Ordinal) && Decode(Value(empty, "eventsJsonB64")) == "[]",
            "empty event window uses zero sequence bounds");
    }

    private static void PlayerLifecycle()
    {
        Func<string, string> nova = _ => "Nova";
        var state = new PlayerSessionState("88888888-9999-4aaa-8bbb-cccccccccccc");
        var shortIdentity = new object();
        var joined = state.Joined(shortIdentity, nova, 1000);
        Check(state.TryGetSessionPlayerId(shortIdentity, out var resolvedId) && resolvedId == joined.SessionPlayerId && !state.WasObservedLeft(shortIdentity),
            "current player identity resolves to its opaque session player ID");
        var online = state.Observed(shortIdentity, nova, 1000);
        var left = state.Left(shortIdentity, nova, 1001);
        Check(joined.SessionPlayerId == online.SessionPlayerId && online.SessionPlayerId == left.SessionPlayerId && state.Events.Count == 2 &&
            state.Events[0].Type == "join" && state.Events[1].Type == "leave", "short connection retains exact join and leave with one session player ID");
        Check(!state.TryGetSessionPlayerId(shortIdentity, out _) && state.WasObservedLeft(shortIdentity),
            "leave observation removes the live identity and records exact cleanup evidence");

        var lateIdentity = new object();
        var late = state.Observed(lateIdentity, _ => "Late", 1002);
        Check(state.Events.Last().Type == "firstObserved" && state.Events.Last().SessionPlayerId == late.SessionPlayerId,
            "late Bridge load emits firstObserved with the roster session player ID");
        var eventCount = state.Events.Count;
        var afterUnavailable = state.Observed(lateIdentity, _ => "Late renamed", 1003);
        Check(afterUnavailable.SessionPlayerId == late.SessionPlayerId && state.Events.Count == eventCount,
            "temporary snapshot unavailability preserves identity and does not invent an event");

        var reusedNativeId = new object();
        var reused = state.Joined(reusedNativeId, nova, 1004);
        Check(reused.SessionPlayerId != joined.SessionPlayerId, "a reused native player ID represented by a new player-data object gets a new session player ID");
        var finalCount = state.Events.Count;
        state.ClearRoster();
        Check(state.Events.Count == finalCount, "game end preserves the final event buffer");
        state.Reset("99999999-aaaa-4bbb-8ccc-dddddddddddd");
        Check(state.Events.Count == 0 && state.SessionId == "99999999-aaaa-4bbb-8ccc-dddddddddddd", "new multiplayer session resets identity and event sequence state");

        for (var index = 0; index < 260; index++) state.Joined(new object(), _ => "Player", 2000 + index);
        Check(state.Events.Count == BridgeProtocol.MaximumPlayerEvents && state.Events[0].Sequence == 5 && state.Events.Last().Sequence == 260,
            "event buffer retains a contiguous rolling tail of 256 events");
    }

    private static void FileStore()
    {
        var fixture = Path.Combine(Path.GetTempPath(), "dyson-bridge-tests-" + Guid.NewGuid().ToString("N"));
        var root = Path.Combine(fixture, "control");
        var secretFile = Path.Combine(fixture, "secret");
        Directory.CreateDirectory(fixture);
        File.WriteAllText(secretFile, Secret, new UTF8Encoding(false));
        try
        {
            var store = new BridgeFileStore(root, secretFile);
            var versions = BridgeProtocol.SerializeVersions(new BridgeVersions
            {
                ProcessId = 1234, WrittenAtUnixMs = 1792040002000, Game = "0.10.34.28470",
                Nebula = "0.9.24", BepInEx = "5.4.17.0", Bridge = "0.1.0"
            }, Secret);
            store.WriteVersions(versions);
            Check(File.ReadAllText(Path.Combine(root, "versions"), Encoding.UTF8) == versions, "versions are published atomically");
            store.WritePlayerEvents(new string('e', 196608));
            Check(new FileInfo(Path.Combine(root, "player-events")).Length == 196608, "player-events has its dedicated 196608-byte atomic-write ceiling");
            var oversizedRejected = false;
            try { store.WritePlayerEvents(new string('e', 196609)); }
            catch (InvalidOperationException) { oversizedRejected = true; }
            Check(oversizedRejected, "player-events rejects payloads above its dedicated ceiling");
            var id = "66666666-7777-4888-8999-aaaaaaaaaaaa";
            File.WriteAllText(Path.Combine(root, "requests", id + ".request"), RequestPayload(id, "save"), new UTF8Encoding(false));
            var claim = store.TryClaimNext();
            Check(claim != null && store.TryReadRequest(claim, out var request, out _) && request.RequestId == id, "file store claims a filename-bound request");
            store.Complete(claim);
            Check(store.AlreadyHandled(id), "processed request is an idempotency tombstone without a receipt");

            File.WriteAllText(Path.Combine(root, "requests", id + ".request"), RequestPayload(id, "save"), new UTF8Encoding(false));
            var duplicate = store.TryClaimNext();
            Check(duplicate != null && store.TryReadRequest(duplicate, out _, out _) && store.AlreadyHandled(id), "duplicate request is recognized from processed tombstone");
            store.Complete(duplicate);

            var other = "77777777-8888-4999-8aaa-bbbbbbbbbbbb";
            File.WriteAllText(Path.Combine(root, "requests", other + ".request"), RequestPayload(id, "save"), new UTF8Encoding(false));
            var mismatch = store.TryClaimNext();
            Check(mismatch != null && !store.TryReadRequest(mismatch, out _, out var error) && error == "REQUEST_ID_MISMATCH", "request payload id must equal its filename");
            store.Reject(mismatch);

            var playerId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
            File.WriteAllText(Path.Combine(root, "player-requests", playerId + ".request"),
                PlayerActionPayload(playerId, "33333333-4444-4555-8666-777777777777", "player-000001"), new UTF8Encoding(false));
            Check(store.TryClaimNext() == null, "ordinary request queue does not consume player actions");
            var playerClaim = store.TryClaimNextPlayerAction();
            BridgePlayerActionRequest playerRequest = null;
            Check(playerClaim != null && store.TryReadPlayerActionRequest(playerClaim, out playerRequest, out _) &&
                playerRequest.RequestId == playerId && playerRequest.SessionPlayerId == "player-000001", "player action queue claims and parses its dedicated request");
            store.WritePlayerActionReceipt(playerId, BridgeProtocol.SerializePlayerActionReceipt(new BridgePlayerActionReceipt
            {
                RequestId = playerId, Action = "kick-player", SessionId = "33333333-4444-4555-8666-777777777777",
                SessionPlayerId = "player-000001", State = "failed", StartedAtUnixMs = 1792040000000,
                FinishedAtUnixMs = 1792040000001, ErrorCode = "KICK_TIMEOUT"
            }, Secret));
            store.Complete(playerClaim);
            Check(store.PlayerActionAlreadyHandled(playerId) && File.Exists(Path.Combine(root, "player-processed", playerId + ".request")),
                "player action receipt and tombstone are isolated from ordinary receipts");
        }
        finally
        {
            var resolved = Path.GetFullPath(fixture);
            if (!resolved.StartsWith(Path.GetFullPath(Path.GetTempPath()), StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Unsafe fixture cleanup path.");
            Directory.Delete(resolved, true);
        }
    }

    private static void SaveStability()
    {
        var before = Observation(10, Evidence(100, 1000), Evidence(200, 1001), Evidence(300, 1002));
        var tracker = new SaveStabilityTracker(before);
        var missingMod = Observation(11, Evidence(110, 1100), Evidence(210, 1101), new BridgeFileEvidence());
        Check(!tracker.Observe(missingMod, 0, 750, out _) && tracker.ExplainFailure(missingMod) == "MODDSV_MISSING", "existing moddsv cannot disappear");
        var unchangedMod = Observation(11, Evidence(110, 1100), Evidence(210, 1101), Evidence(300, 1002));
        Check(!tracker.Observe(unchangedMod, 0, 750, out _) && tracker.ExplainFailure(unchangedMod) == "MODDSV_UNCHANGED", "existing moddsv must change");
        var complete = Observation(11, Evidence(110, 1100), Evidence(210, 1101), Evidence(310, 1102));
        Check(!tracker.Observe(complete, 0, 750, out _), "first complete save sample starts stability window");
        Check(!tracker.Observe(complete, 400, 750, out _), "second complete save sample is not yet stable");
        Check(tracker.Observe(complete, 800, 750, out var stable) && stable.SaveTime == 11, "three complete samples over stability window succeed");

        var corruptModBefore = Observation(30, Evidence(100, 3000), Evidence(200, 3001), Evidence(0, 3002));
        var corruptModTracker = new SaveStabilityTracker(corruptModBefore);
        var corruptModStillMissing = Observation(31, Evidence(101, 3100), Evidence(201, 3101), new BridgeFileEvidence());
        Check(!corruptModTracker.Observe(corruptModStillMissing, 0, 10, out _) &&
            corruptModTracker.ExplainFailure(corruptModStillMissing) == "MODDSV_MISSING",
            "an existing zero-length moddsv is still an existing member and cannot disappear");

        var noModBefore = Observation(20, Evidence(100, 2000), Evidence(200, 2001), new BridgeFileEvidence());
        var noModTracker = new SaveStabilityTracker(noModBefore);
        var pairOnly = Observation(21, Evidence(101, 2100), Evidence(201, 2101), new BridgeFileEvidence());
        noModTracker.Observe(pairOnly, 0, 10, out _);
        noModTracker.Observe(pairOnly, 5, 10, out _);
        Check(noModTracker.Observe(pairOnly, 10, 10, out _), "save without pre-existing moddsv requires the stable dsv and server pair");
    }

    private static void PhysicalDirectoryIdentity()
    {
        if (!OperatingSystem.IsWindows()) return;
        var fixture = Path.Combine(Path.GetTempPath(), "dyson-bridge-path-" + Guid.NewGuid().ToString("N"));
        var target = Path.Combine(fixture, "target");
        var alias = Path.Combine(fixture, "alias");
        Directory.CreateDirectory(target);
        try
        {
            var start = new ProcessStartInfo("cmd.exe") { UseShellExecute = false, CreateNoWindow = true };
            start.ArgumentList.Add("/d");
            start.ArgumentList.Add("/c");
            start.ArgumentList.Add("mklink");
            start.ArgumentList.Add("/J");
            start.ArgumentList.Add(alias);
            start.ArgumentList.Add(target);
            using var process = Process.Start(start) ?? throw new InvalidOperationException("Could not create directory fixture junction.");
            process.WaitForExit();
            if (process.ExitCode != 0) throw new InvalidOperationException("Could not create directory fixture junction.");
            Check(DirectoryIdentity.SamePhysicalDirectory(target, alias), "physical save directory identity follows the private document-root junction");
        }
        finally
        {
            if (Directory.Exists(alias)) Directory.Delete(alias, false);
            var resolved = Path.GetFullPath(fixture);
            if (!resolved.StartsWith(Path.GetFullPath(Path.GetTempPath()), StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Unsafe fixture cleanup path.");
            Directory.Delete(resolved, true);
        }
    }

    private static BridgeSaveObservation Observation(long saveTime, BridgeFileEvidence dsv, BridgeFileEvidence server, BridgeFileEvidence moddsv) =>
        new BridgeSaveObservation { SaveTime = saveTime, Dsv = dsv, Server = server, Moddsv = moddsv };
    private static BridgeFileEvidence Evidence(long bytes, long ticks) => new BridgeFileEvidence { Bytes = bytes, Ticks = ticks };

    private static string RequestPayload(string id, string action)
    {
        var values = new[] { "DYSON_CONTROL_REQUEST_V1", id, "1792040000000", "1792040060000", action, "abcdefghijklmnop" };
        return "protocol=" + values[0] + "\nrequestId=" + values[1] + "\ncreatedAtUnixMs=" + values[2] +
            "\nexpiresAtUnixMs=" + values[3] + "\naction=" + values[4] + "\nnonce=" + values[5] + "\nhmac=" + Sign(values) + "\n";
    }

    private static void PlayerActionRequest()
    {
        const string id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
        const string sessionId = "abcdefab-cdef-4abc-8def-abcdefabcdef";
        var payload = PlayerActionPayload(id, sessionId, "player-000001");
        Check(BridgeProtocol.TryParsePlayerActionRequest(payload, Secret, out var parsed, out var error) &&
            parsed.RequestId == id && parsed.SessionId == sessionId && parsed.SessionPlayerId == "player-000001" && error == "NONE",
            "signed player action request binds exact session and player identity");
        Check(!BridgeProtocol.TryParsePlayerActionRequest(payload.Replace("sessionPlayerId=player-000001", "sessionPlayerId=player-000002"), Secret, out _, out var signatureError) &&
            signatureError == "INVALID_SIGNATURE", "player action rejects signed-field mutation");
        Check(!BridgeProtocol.TryParsePlayerActionRequest(payload.Replace(sessionId, sessionId.ToUpperInvariant()), Secret, out _, out _),
            "player action requires a canonical lowercase session UUID");
        Check(!BridgeProtocol.TryParsePlayerActionRequest(payload.Replace("nonce=0123456789abcdef0123456789abcdef", "nonce=0123456789ABCDEF0123456789ABCDEF"), Secret, out _, out _),
            "player action requires a lowercase 32-hex nonce");
    }

    private static string PlayerActionPayload(string id, string sessionId, string sessionPlayerId)
    {
        var values = new[]
        {
            "DYSON_CONTROL_PLAYER_ACTION_V1", id, "1792040000000", "1792040030000", "kick-player",
            sessionId, sessionPlayerId, "0123456789abcdef0123456789abcdef"
        };
        return "protocol=" + values[0] + "\nrequestId=" + values[1] + "\ncreatedAtUnixMs=" + values[2] +
            "\nexpiresAtUnixMs=" + values[3] + "\naction=" + values[4] + "\nsessionId=" + values[5] +
            "\nsessionPlayerId=" + values[6] + "\nnonce=" + values[7] + "\nhmac=" + Sign(values) + "\n";
    }

    private static void OrderedAndSigned(string payload, string[] keys)
    {
        var lines = payload.TrimEnd('\n').Split('\n');
        Check(lines.Length == keys.Length && keys.Select((key, index) => lines[index].StartsWith(key + "=", StringComparison.Ordinal)).All(value => value), "ordered fields: " + keys[0]);
        var values = lines.Take(lines.Length - 1).Select(line => line.Substring(line.IndexOf('=') + 1)).ToArray();
        Check(lines.Last() == "hmac=" + Sign(values), "valid signature: " + Value(payload, "protocol"));
    }

    private static string Value(string payload, string key) => payload.Split('\n').Single(line => line.StartsWith(key + "=", StringComparison.Ordinal)).Substring(key.Length + 1);
    private static string Decode(string encoded) => Encoding.UTF8.GetString(Convert.FromBase64String(encoded.Replace('-', '+').Replace('_', '/') + new string('=', (4 - encoded.Length % 4) % 4)));
    private static string Sign(string[] values)
    {
        using var hmac = new HMACSHA256(Encoding.UTF8.GetBytes(Secret));
        return string.Concat(hmac.ComputeHash(Encoding.UTF8.GetBytes(string.Join("\n", values))).Select(value => value.ToString("x2")));
    }
    private static void Check(bool value, string label) { if (!value) throw new InvalidOperationException(label); checks++; }
}
