# Dyson Control Bridge

Dyson Control Bridge is a small BepInEx plugin used by the Windows game adapter. It runs on Unity's main thread, reads the installed Nebula 0.9.22 API directly, and exchanges bounded HMAC-signed files with Dyson Control. Player actions are pinned to the installed Nebula `0.9.22.2+3cdf95c` assembly shape. A complete Windows release includes the plugin and its reference manifest; a panel-only release does not. The plugin initializes only after its private paths and secret have been configured.

The Bridge is server-only and is excluded from client exports. Its BepInEx dependency targets the Nebula runtime, not the Nebula API plugin: Nebula treats a direct API dependency (hard or soft), or an `IMultiplayerMod` implementation, as a requirement for both peers to install the plugin. The Bridge does not register custom game packets or synchronize client settings. `build-bridge.ps1` checks the compiled metadata against this handshake rule before producing a release artifact.

It provides eight surfaces:

- a fresh heartbeat bound to the current `DSPGAME.exe` PID;
- a read-only snapshot of Nebula's authoritative `Connected` players;
- a bounded join/leave event tail that preserves connections shorter than the snapshot interval;
- measured UPS and TPS from `FPSController.currentUPS` and `GameMain.gameTick`;
- signed runtime versions for the game, Nebula, BepInEx, and this Bridge;
- a signed save request and V3 receipt covering `.dsv`, `.server`, and an existing `.moddsv`;
- a signed stop request and ACTION receipt. The plugin durably writes and archives the ACTION receipt before calling `UnityEngine.Application.Quit()`. The control plane still verifies that the exact PID exits.
- a signed `player-actions` capability plus a dedicated request/receipt queue for disconnecting one exact current player connection.

Ban, whitelist, blacklist, per-player roles or permissions, player ping, and free-form player messages are not exposed. Nebula 0.9.22 has no admission-list API or player-role model. Its remote-console allow set is private, transient, protected by one global password, and does not represent persistent player permissions.

The Bridge does not call `IServer.Disconnect` for an already connected player. In this exact Nebula build, that method removes the player from `Players` before closing the socket. The normal socket-close callback then attempts the same removal, gets no player, and skips the remaining disconnect cleanup. Instead, the Bridge closes the exact current `NebulaConnection.peerSocket` asynchronously without mutating `Players`, allowing Nebula's normal `OnSocketDisconnection` path to remove the player and emit `OnPlayerLeftGame`. Success is signed only after the exact `IPlayerData` reference has produced that leave callback and the exact connection is absent from `Players.Connected`. This action disconnects the current connection only; it does not prevent the player from joining again.

## Files and protocol

The configured control root contains `requests`, `processing`, `receipts`, `processed`, and `rejected`. Player actions use separate `player-requests`, `player-processing`, `player-responses`, `player-processed`, and `player-rejected` directories so the ordinary request parser cannot claim them. The plugin also atomically replaces `heartbeat`, `players`, `player-events`, `player-actions`, `metrics`, and `versions` in that root. It rejects reparse-point directories and files. Requests and receipts use lowercase canonical UUID request IDs, a short expiry, and SHA-256 HMAC over ordered values joined with a single newline.

The heartbeat writes `ready` only while Nebula is active as a dedicated server, the server session reports the game loaded, `GameMain.data` exists, `GameMain.isRunning` is true, and the physical directory behind `GameConfig.gameSaveFolder` is the configured `ExpectedSaveDirectory`. Every other initialized runtime state writes `unavailable`. Directory identity is resolved with a Windows directory handle and `GetFinalPathNameByHandle`, so the private document-root junction created by `start-game.ps1` resolves to the same physical save directory. The TypeScript control plane deliberately accepts only `ready` as lifecycle authority.

`players` uses `DYSON_CONTROL_PLAYERS_V1`. Rows contain exactly `sessionPlayerId`, `displayName`, `online`, `joinedAtUnixMs`, and `location`, in that order. Rows are sorted by the opaque `player-000001` session ID. The timestamp is when this Bridge session first observed the connection; Nebula does not expose the original join timestamp. No endpoint, address, certificate, platform identifier, coordinates, or mecha data is written.

`player-events` uses `DYSON_CONTROL_PLAYER_EVENTS_V1` with this exact top-level order:

```text
protocol
sessionId
processId
writtenAtUnixMs
firstSequence
lastSequence
eventCount
eventsJsonB64
hmac
```

`eventsJsonB64` is unpadded base64url UTF-8 JSON. Each event contains exactly `sequence`, `type`, `sessionPlayerId`, `displayName`, and `observedAtUnixMs`, in that order. `type` is `join`, `leave`, or `firstObserved`. The file retains the latest 256 events as one contiguous sequence tail; an empty tail uses zero for both sequence bounds. Its atomic-write ceiling is 196608 bytes. `writtenAtUnixMs` is at least the newest retained event time.

Join and leave callbacks are keyed by the `IPlayerData` object supplied by Nebula, and the authoritative `Connected` enumeration uses that same object identity. This makes an online row and its events share one opaque `sessionPlayerId` without exposing or relying on Nebula's reusable numeric player ID. A connection already present when the Bridge loads emits `firstObserved`. A join followed by a leave between two snapshot writes remains in the event tail. Temporary enumeration or readiness failures publish an unavailable player snapshot without clearing identity or event state. Game end clears the live roster mapping but preserves the final event tail; the next multiplayer-start callback creates a new session ID and resets player IDs and event sequence state.

`player-actions` uses `DYSON_CONTROL_PLAYER_ACTIONS_V1` with this exact order:

```text
protocol
sessionId
processId
writtenAtUnixMs
state
hmac
```

It is refreshed with the player snapshot. `state=available` requires the current session to be an active loaded dedicated server, the authoritative roster to be readable, and every current connection to use the pinned `NebulaConnection` path. Every other state is `unavailable`. The control plane additionally requires a valid signature, the current game PID, the current session UUID, and a sample no older than 10 seconds; directory existence alone never enables the UI action.

A player action request uses `DYSON_CONTROL_PLAYER_ACTION_V1` with the exact ordered keys `protocol`, `requestId`, `createdAtUnixMs`, `expiresAtUnixMs`, `action`, `sessionId`, `sessionPlayerId`, `nonce`, and `hmac`. The only action is `kick-player`. Both UUIDs must be canonical lowercase, the opaque player ID must match `player-[0-9]{6,12}`, the nonce is exactly 32 lowercase hexadecimal characters, and the signed window is at most 45 seconds. The Bridge resolves the pair against the current in-memory roster; display names, Nebula numeric player IDs, and stale session IDs are never accepted as targets.

The terminal response is `player-responses/<requestId>.receipt` using `DYSON_CONTROL_PLAYER_ACTION_RECEIPT_V1` and the exact ordered keys `protocol`, `requestId`, `action`, `sessionId`, `sessionPlayerId`, `state`, `startedAtUnixMs`, `finishedAtUnixMs`, `errorCode`, and `hmac`. State is `succeeded` or `failed`; success requires `errorCode=NONE`. A claimed request recovered after interruption becomes `INTERRUPTED_UNCERTAIN` and is not replayed. The close handshake runs asynchronously and has a 30-second operation ceiling, so Unity's main thread is never blocked by the socket wait.

`metrics` uses `DYSON_CONTROL_METRICS_V1` with this exact order:

```text
protocol
sessionId
processId
writtenAtUnixMs
state
ups
tps
gameTick
hmac
```

Active UPS and TPS are finite nonnegative invariant-culture decimals. TPS is calculated from game-tick movement over a 1.5 to 10 second monotonic window. A local pause flag only invalidates the sample when the Nebula session allows pausing, matching Nebula's `FixedUpdate` patch; dedicated hosts can retain that flag while the world continues ticking. An effective pause or unavailable runtime resets the sampling baseline and writes `-1` for UPS, TPS, and game tick. The configured `-ups` target is never used as measured telemetry.

`versions` uses `DYSON_CONTROL_VERSIONS_V1` with the ordered keys `protocol`, `processId`, `writtenAtUnixMs`, `game`, `nebula`, `bepinex`, `bridge`, and `hmac`. The game value comes from `GameConfig.gameVersion.ToFullString()`, rather than the executable's Unity version metadata. The control plane requires a matching ready heartbeat and PID, a valid signature, and a sample no older than 10 seconds. Offline Steam build identifiers remain separate from the running game's displayed version.

Requests use `DYSON_CONTROL_REQUEST_V1` and permit only `save` or `stop`. The request ID in the signed payload must exactly equal the lowercase UUID filename. Save results use `DYSON_CONTROL_RECEIPT_V3`; stop results use `DYSON_CONTROL_ACTION_V1`. A claimed request left in `processing` after interruption receives a terminal `INTERRUPTED_UNCERTAIN` failure and is never replayed. Existing receipts and archived request files in `processed` are both idempotency tombstones.

A save always calls `GameSave.SaveCurrentGame(GameSave.LastExit)`, whose installed value is `_lastexit_`. `saveTimeBefore` and `saveTimeAfter` come directly from `NebulaWorld.GameStates.GameStatesManager.LastSaveTime`. After the call returns, `Update()` polls without blocking the Unity thread. It signs success only after `LastSaveTime` advances and the complete `.dsv`/`.server` pair remains identical for three samples over at least 750 ms. If `.moddsv` existed before the call, including a zero-length corrupt member, the resulting `.moddsv` must be present, nonempty, changed, and stable with the pair. A save request times out after at most 30 seconds and never converts a missing, partial, unchanged, unstable, or path-rebound output into success.

## Build

The build reads the local game installation as compile-time references. It does not copy or redistribute DSP, Unity, BepInEx, or Nebula assemblies.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File .\scripts\build-bridge.ps1 `
  -DysonServerRoot 'C:\GameServers\DSP\server'
```

The script first runs the independent protocol and file fixtures, including request filename binding, ordinary/player queue isolation, signed player-action capability and receipt ordering, processed tombstones, save-set stability, corrupt existing `.moddsv`, player-event rollover and lifecycle identity, the dedicated event-file size ceiling, and a real directory-junction identity check. It then compiles the plugin for .NET Framework 4.7.2 and writes `dist\bridge\DysonControlBridge.dll` plus `bridge-manifest.json`. The manifest records the plugin hash plus the assembly version, size, and SHA-256 hash of every local reference, including `websocket-sharp.dll`. A successful build proves source and reference compatibility; it does not prove that the plugin loaded in the game or that save, stop, player, event, telemetry, or disconnect behavior passed a real server drill.

## Configuration and deployment boundary

The generated BepInEx configuration has exactly three required private absolute paths:

```ini
[Bridge]
ControlDirectory = C:\ProgramData\Dyson Control\bridge
SecretFile = C:\ProgramData\Dyson Control\private\bridge-secret
ExpectedSaveDirectory = D:\DysonData\Save
```

Missing or invalid configuration fails initialization with a clear log entry and never publishes a false-ready heartbeat. The secret is a random value of 32 to 512 characters stored in an ACL-protected regular file. The game account needs modification access to the control directory. The Dyson Control service needs to publish requests and read receipts and snapshots. Neither identity should receive broader game-tree access through the Bridge setup.

Install or replace the DLL only while the exact managed game process is stopped. Keep the previous DLL and configuration as a rollback pair. After restart, acceptance requires a fresh signed heartbeat with the expected PID, valid player and metrics snapshots, a protected real-save test, a controlled stop test, restart recovery, an external Nebula client join, and a controlled disconnect proving both the client's disconnection and its removal from the server roster. Record the tested build, environment and client connection path in the deployment acceptance record.

The supported Windows deployment entry point is [`configure-game.ps1`](game-configuration.md). Its prepare-only mode creates a reviewable plan and staged files without changing the game or task. Apply mode verifies the explicit DLL SHA-256, preserves the previous DLL/config/task XML, retains an existing valid secret, and registers the marker-owned SYSTEM start task without starting it.
