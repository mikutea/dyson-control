# Version locks

`VersionLockStore` records exact versions that an administrator has explicitly chosen to keep. The lock file belongs in Dyson Control's private data directory and is separate from the game installation.

The existing `BepInEx/.dyson-control-packages.json` file is installed-package inventory. It records what an installer operation placed on disk, including archive hashes used by update and rollback checks. Its presence does not mean that the administrator pinned those versions. Do not use it as the version-lock file or infer locks from it.

## Identities and file format

The game uses the fixed identity `steam:1366540`. Thunderstore packages use their `Owner-Package` full name. Identity matching is case-insensitive; the store returns and writes the canonical lowercase form. Versions are exact, case-sensitive strings.

The private JSON document has its own schema:

```json
{
  "schema": 1,
  "updatedAt": "2026-10-17T00:00:00.000Z",
  "locks": [
    {
      "package": "nebula-nebulamultiplayermod",
      "version": "0.9.22",
      "lockedAt": "2026-10-17T00:00:00.000Z"
    },
    {
      "package": "steam:1366540",
      "version": "0.10.32.25780",
      "lockedAt": "2026-10-17T00:00:00.000Z"
    }
  ]
}
```

Each returned lock also carries `lockedAt`, the time that exact pin was set. Repeating the same lock preserves this time; changing the pinned version creates a new time. The store rejects malformed documents, duplicate identities and paths that are not regular files. A read error is surfaced as `VERSION_LOCK_INVALID`; it is never treated as an empty lock set. Updates use a temporary file in the same directory and rename it into place so readers see a complete old or new document.

## Integration

Create one store for the configured private lock path. To add a lock, the caller must obtain the exact currently installed version from the trusted game or package inventory and pass that value to `set`. This prevents the lock action from becoming an arbitrary version selector.

```ts
const locks = new VersionLockStore(privateVersionLockFile)
await locks.set('Nebula-NebulaMultiplayerMod', installedVersion, true)
await locks.set('Nebula-NebulaMultiplayerMod', installedVersion, false) // unlock
```

For a Thunderstore install, resolve the complete dependency plan first and check every selected package before downloading or changing files:

```ts
const plan = await updates.resolvePackagePlan(packageFullName, requestedVersion, signal)
await locks.assertPlan(plan.map((item) => ({
  package: item.packageFullName,
  version: item.version
})))
```

The check permits a plan entry whose version already equals its pin. It throws `VERSION_LOCK_CONFLICT` when the plan would change a pinned root package or dependency. A pin absent from the plan is unaffected.

The game update backend needs the same check after it resolves the exact target version and before it begins installation:

```ts
await locks.assertPlan([{ package: GAME_VERSION_LOCK_ID, version: resolvedGameVersion }])
```

Listing, locking and unlocking are storage operations. Authorization, administrator actions and UI presentation stay in the caller that wires the store into Dyson Control.
