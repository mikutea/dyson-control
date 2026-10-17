# Steam game updates

Dyson Control updates Dyson Sphere Program through Valve's official SteamCMD client and app id `1366540`. The backend uses the Steam `public` branch and an existing authorized SteamCMD session. It never accepts, stores, or passes a Steam password or Steam Guard code.

## Prerequisites

Install SteamCMD separately and complete its first interactive login outside Dyson Control. Valve documents that the first login may request the account password and Steam Guard code; later commands can use the cached session by supplying only the account name. Preserve SteamCMD's `config/config.vdf` session file and restrict access to the SteamCMD directory.

Configure:

- `game.steam.executable`: absolute path to the existing `steamcmd.exe`.
- `game.steam.accountName`: the already authorized Steam account name. Do not put a password or Guard code here.
- The normal game, work, update-backup, save, bridge, and private-data paths. Work and update backups must be outside the game root and must not overlap each other.

A save or bridge directory may already be below the game root. Pass it as a protected path; the updater will reject any staged target or prior-inventory cleanup that intersects it. The built-in protected paths are `BepInEx/**`, `doorstop_config.ini`, `winhttp.dll`, `version.dll`, and `steam_appid.txt`.

The configured game root must contain the local game marker `DSPGAME.exe`, `DSPGAME_Data/`, and `steamapps/appmanifest_1366540.acf`. The appmanifest `buildid` is the installed Steam build identity. It is separate from the product version displayed by the game.

## Discovery and installation

Discovery reads the installed build from the local appmanifest, then asks SteamCMD for the current `public` branch through `app_info_print 1366540`. A login prompt, password prompt, Guard prompt, failed login, nonzero exit, timeout, or malformed app-info response makes discovery fail rather than report a latest build.

SteamCMD cannot install an arbitrary historical numeric build through `app_update`. An optional requested build therefore acts as an exact pin on the freshly discovered public build. If it differs, installation stops before a staging directory is created. The shared version-lock store is checked at the same point.

An accepted update runs the equivalent of:

```text
steamcmd.exe +force_install_dir <independent-stage> +login <accountName> +app_update 1366540 validate +quit
```

Dyson Control requires all of the following before it changes the game directory:

1. SteamCMD exits with code 0.
2. Its output contains the exact line `Success! App '1366540' fully installed.`
3. The staged `appmanifest_1366540.acf` has `StateFlags=4` and the expected public `buildid`.
4. `DSPGAME.exe`, `UnityPlayer.dll`, and `DSPGAME_Data/globalgamemanagers` are regular staged files.
5. Every staged target is a regular file, stays below the game root, and avoids all protected paths. Links and special files are rejected.

The staged regular-file inventory is the only official file list used for replacement. The first managed install does not infer or delete other files already in the game directory. Later installs may remove an obsolete official file only when that exact path came from the backend's preceding inventory. The updater never walks a live save, bridge, BepInEx, or other protected directory.

Before promotion, the Windows adapter has already saved, backed up, and stopped the server under the game-operation mutex. The Steam backend independently checks that the server remains stopped immediately before promotion.

## History and rollback

Each install gets an id beginning with `steam-update-`. Its durable record contains the source and target build ids, SHA-256 inventory, exact changed paths, and verified copies of overwritten or removed files. The public package identity is `steam:1366540`; its version is the Steam build id and its SHA-256 is the canonical staged-file-list digest. The successful install result returns the same id as both `historyId` and `backupId`.

If promotion fails, the backend restores every changed target from the adjacent verified copies. Recovery does not consult a newly changed version lock, because it is returning to the state that existed before the failed operation. An incomplete automatic recovery is retained as `rollback-failed` and must not be followed by an automatic restart.

A manual rollback is available only for the most recent completed Steam install whose recorded inventory still matches the current state. Before changing a file, the backend verifies the current hashes, verifies the selected backups, checks the target build against the shared version lock, and creates a separate protection record for the rollback attempt. A successful rollback marks the source install `rolled-back`. The rollback record is an audit and recovery record; it is never advertised as another rollback source.

Do not remove `steam-state.json`, `steam-update-*` history directories, their `steam-manifest.json` files, or `content/` backups while an install remains rollbackable.

## Authorization failures

When SteamCMD requests a password or Steam Guard code, stop the control-plane operation. Log in interactively at the SteamCMD console on the server, confirm the session was saved, close that console, and retry from Dyson Control. Never paste the password or Guard code into Dyson Control configuration, logs, job input, or command arguments.

Valve references:

- [SteamCMD](https://developer.valvesoftware.com/wiki/SteamCMD)
- [SteamPipe upload and account authentication](https://partner.steamgames.com/doc/sdk/uploading)
- [Steam builds and manifests](https://partner.steamgames.com/doc/store/application/builds)
