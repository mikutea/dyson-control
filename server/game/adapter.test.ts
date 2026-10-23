import { createHash, createHmac } from 'node:crypto'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ControlConfig } from '../../shared/contracts.js'
import { GameAdapterError } from './errors.js'
import { createGameAdapter } from './index.js'
import { resolveWindowsScript } from './system.js'
import { SaveRestoreManager } from './save-restore.js'
import { WindowsGameAdapter } from './windows.js'
import { extractZipBuffer, GameUpdateManager, type ResolvedPackage } from './updates.js'
import { buildStoredZip } from './zip.js'

const temporaryDirectories: string[] = []
const execFileAsync = promisify(execFile)
afterEach(async () => { await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))) })

async function config(mode: 'demo' | 'windows'): Promise<ControlConfig> {
  // Windows runners may expose TEMP through an 8.3 alias. Match the real path
  // PowerShell uses, including when the fixture simulates a separate SMB path.
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `dyson-${mode}-test-`)))
  temporaryDirectories.push(root)
  const saveDirectory = path.join(root, 'userdata', 'Save')
  const backupDirectory = path.join(root, 'backups')
  await fs.mkdir(saveDirectory, { recursive: true })
  await fs.mkdir(backupDirectory)
  return {
    host: '127.0.0.1', port: 4173, dataDirectory: path.join(root, 'data'), mode, adminPasswordHash: 'test',
    game: {
      root: path.join(root, 'game'), saveDirectory, backupDirectory, logFile: path.join(root, 'game.log'),
      bridgeDirectory: path.join(root, 'bridge'), bridgeSecretFile: path.join(root, 'secret'),
      startTaskName: 'Fixture Start', address: 'fixture.example.test', serverName: 'Fixture Server'
    }
  }
}

type SteamFixtureMode = 'matching' | 'absent' | 'different-session'

async function invokeStartGameFixture(
  fixture: ControlConfig,
  settingsPath: string,
  saveDirectory: string,
  steamMode: SteamFixtureMode
): Promise<{ stdout: string; stderr: string }> {
  const argumentsPath = path.join(fixture.dataDirectory, 'start-game-arguments.json')
  const harness = path.join(fixture.dataDirectory, 'start-game-harness.ps1')
  await fs.writeFile(argumentsPath, JSON.stringify({
    gameRoot: fixture.game.root, saveDirectory, settingsPath, logFile: fixture.game.logFile
  }))
  await fs.writeFile(harness, String.raw`[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$StartScript,
  [Parameter(Mandatory = $true)][string]$ArgumentsPath,
  [Parameter(Mandatory = $true)][ValidateSet('matching', 'absent', 'different-session')][string]$SteamMode
)
$ErrorActionPreference = 'Stop'
$inputObject = Get-Content -LiteralPath $ArgumentsPath -Raw -Encoding UTF8 | ConvertFrom-Json
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$separator = $identity.Name.IndexOf('\')
if ($separator -le 0 -or $separator -ge ($identity.Name.Length - 1)) { throw 'Fixture identity is not domain-qualified.' }
$ownerDomain = $identity.Name.Substring(0, $separator)
$ownerUser = $identity.Name.Substring($separator + 1)
$fixtureSessionId = [Diagnostics.Process]::GetCurrentProcess().SessionId
function Get-CimInstance {
  [CmdletBinding()]
  param([Parameter(Position = 0)][string]$ClassName, [string]$Filter)
  if ($ClassName -cne 'Win32_Process') { throw "Unexpected fixture CIM class: $ClassName" }
  if ($Filter -ceq "Name = 'DSPGAME.exe'") { return }
  if ($Filter -cne "Name = 'steam.exe'") { throw "Unexpected fixture CIM filter: $Filter" }
  if ($SteamMode -ceq 'absent') { return }
  $sessionId = if ($SteamMode -ceq 'matching') { $fixtureSessionId } else { $fixtureSessionId + 1 }
  [pscustomobject]@{ ProcessId = 41001; SessionId = $sessionId }
}
function Invoke-CimMethod {
  [CmdletBinding()]
  param([Parameter(Mandatory = $true)][object]$InputObject, [Parameter(Mandatory = $true)][string]$MethodName)
  if ($MethodName -cne 'GetOwner') { throw "Unexpected fixture CIM method: $MethodName" }
  [pscustomobject]@{ ReturnValue = 0; Domain = $ownerDomain; User = $ownerUser }
}
& $StartScript -GameRoot ([string]$inputObject.gameRoot) -SaveDirectory ([string]$inputObject.saveDirectory) -SettingsPath ([string]$inputObject.settingsPath) -LogFile ([string]$inputObject.logFile) -ProcessPriority AboveNormal
`)
  return execFileAsync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', harness,
    '-StartScript', resolveWindowsScript('start-game.ps1'), '-ArgumentsPath', argumentsPath, '-SteamMode', steamMode
  ], { windowsHide: true })
}

function sign(secret: string, parts: string[]): string {
  return createHmac('sha256', secret).update(parts.join('\n')).digest('hex')
}

async function prepareBridge(fixture: ControlConfig, processId: number, startedAt = Date.now() - 1_000): Promise<string> {
  const secret = '0123456789abcdef0123456789abcdef0123456789abcdef'
  await fs.mkdir(path.join(fixture.game.bridgeDirectory, 'requests'), { recursive: true })
  await fs.mkdir(path.join(fixture.game.bridgeDirectory, 'receipts'), { recursive: true })
  await fs.writeFile(fixture.game.bridgeSecretFile, secret)
  const writtenAt = Date.now()
  const parts = ['DYSON_CONTROL_HEARTBEAT_V1', '0.1.0', String(processId), String(startedAt), String(writtenAt), 'ready']
  await fs.writeFile(path.join(fixture.game.bridgeDirectory, 'heartbeat'), [
    'protocol=DYSON_CONTROL_HEARTBEAT_V1', 'pluginVersion=0.1.0', `processId=${processId}`,
    `startedAtUnixMs=${startedAt}`, `writtenAtUnixMs=${writtenAt}`, 'state=ready', `hmac=${sign(secret, parts)}`, ''
  ].join('\n'))
  return secret
}

async function bridgeSaveWorker(fixture: ControlConfig, secret: string, saveName: string): Promise<void> {
  const requests = path.join(fixture.game.bridgeDirectory, 'requests')
  for (let count = 0; count < 200; count++) {
    let file: string | undefined
    for (const candidate of (await fs.readdir(requests)).filter((name) => name.endsWith('.request'))) {
      const requestId = candidate.slice(0, -'.request'.length)
      const payload = await fs.readFile(path.join(requests, candidate), 'utf8').catch(() => '')
      const receipt = await fs.lstat(path.join(fixture.game.bridgeDirectory, 'receipts', `${requestId}.receipt`)).catch(() => null)
      if (payload.includes('\naction=save\n') && !receipt) { file = candidate; break }
    }
    if (!file) { await new Promise((resolve) => setTimeout(resolve, 10)); continue }
    const requestId = file.slice(0, -'.request'.length)
    const dsv = await fs.stat(path.join(fixture.game.saveDirectory, `${saveName}.dsv`), { bigint: true })
    const server = await fs.stat(path.join(fixture.game.saveDirectory, `${saveName}.server`), { bigint: true })
    const moddsv = await fs.stat(path.join(fixture.game.saveDirectory, `${saveName}.moddsv`), { bigint: true }).catch(() => null)
    const ticks = (stat: { mtimeNs: bigint } | null) => stat ? String(621_355_968_000_000_000n + stat.mtimeNs / 100n) : '-1'
    const started = Date.now()
    const finished = started + 1
    const parts = [
      'DYSON_CONTROL_RECEIPT_V3', requestId, 'save', 'succeeded', String(started), String(finished), saveName,
      '10', '11', String(dsv.size), ticks(dsv), String(server.size), ticks(server),
      moddsv ? String(moddsv.size) : '-1', ticks(moddsv), 'true', 'true', moddsv ? 'true' : 'false', 'NONE'
    ]
    await fs.writeFile(path.join(fixture.game.bridgeDirectory, 'receipts', `${requestId}.receipt`), [
      'protocol=DYSON_CONTROL_RECEIPT_V3', `requestId=${requestId}`, 'action=save', 'state=succeeded',
      `startedAtUnixMs=${started}`, `finishedAtUnixMs=${finished}`, `saveName=${saveName}`, 'saveTimeBefore=10', 'saveTimeAfter=11',
      `dsvBytes=${dsv.size}`, `dsvWriteTimeUtcTicks=${ticks(dsv)}`, `serverBytes=${server.size}`, `serverWriteTimeUtcTicks=${ticks(server)}`,
      `moddsvBytes=${moddsv ? moddsv.size : -1}`, `moddsvWriteTimeUtcTicks=${ticks(moddsv)}`, 'dsvChanged=true', 'serverChanged=true',
      `moddsvChanged=${moddsv ? 'true' : 'false'}`, 'errorCode=NONE', `hmac=${sign(secret, parts)}`, ''
    ].join('\n'))
    return
  }
  throw new Error('Bridge save request was not observed.')
}

async function bridgeStopWorker(fixture: ControlConfig, secret: string, onQuit: () => void): Promise<void> {
  const requests = path.join(fixture.game.bridgeDirectory, 'requests')
  for (let count = 0; count < 200; count++) {
    const files = (await fs.readdir(requests)).filter((name) => name.endsWith('.request'))
    let requestFile: string | null = null
    for (const file of files) {
      const payload = await fs.readFile(path.join(requests, file), 'utf8').catch(() => '')
      const requestId = file.slice(0, -'.request'.length)
      const receipt = await fs.lstat(path.join(fixture.game.bridgeDirectory, 'receipts', `${requestId}.receipt`)).catch(() => null)
      if (payload.includes('\naction=stop\n') && !receipt) { requestFile = file; break }
    }
    if (!requestFile) { await new Promise((resolve) => setTimeout(resolve, 10)); continue }
    const requestId = requestFile.slice(0, -'.request'.length)
    const started = Date.now()
    const finished = started + 1
    const parts = ['DYSON_CONTROL_ACTION_V1', requestId, 'stop', 'succeeded', String(started), String(finished), 'NONE']
    await fs.writeFile(path.join(fixture.game.bridgeDirectory, 'receipts', `${requestId}.receipt`), [
      'protocol=DYSON_CONTROL_ACTION_V1', `requestId=${requestId}`, 'action=stop', 'state=succeeded',
      `startedAtUnixMs=${started}`, `finishedAtUnixMs=${finished}`, 'errorCode=NONE', `hmac=${sign(secret, parts)}`, ''
    ].join('\n'))
    await new Promise((resolve) => setTimeout(resolve, 20))
    onQuit()
    return
  }
  throw new Error('Bridge stop request was not observed.')
}

async function publishBridgeTelemetry(
  fixture: ControlConfig, secret: string, processId: number,
  state: 'active' | 'unavailable' = 'active'
): Promise<void> {
  const sessionId = '12345678-1234-1234-1234-123456789abc'
  const writtenAt = Date.now()
  const ups = state === 'active' ? '59.875' : '-1'
  const tps = state === 'active' ? '60' : '-1'
  const gameTick = state === 'active' ? '123456' : '-1'
  const parts = ['DYSON_CONTROL_METRICS_V1', sessionId, String(processId), String(writtenAt), state, ups, tps, gameTick]
  await fs.writeFile(path.join(fixture.game.bridgeDirectory, 'metrics'), [
    'protocol=DYSON_CONTROL_METRICS_V1', `sessionId=${sessionId}`, `processId=${processId}`,
    `writtenAtUnixMs=${writtenAt}`, `state=${state}`, `ups=${ups}`, `tps=${tps}`, `gameTick=${gameTick}`,
    `hmac=${sign(secret, parts)}`, ''
  ].join('\n'))
}

async function publishBridgeVersions(
  fixture: ControlConfig,
  secret: string,
  processId: number,
  versions = { game: '0.10.34.28470', nebula: '0.9.24.0', bepinex: '5.4.17.0', bridge: '0.1.0' }
): Promise<void> {
  const writtenAt = Date.now()
  const parts = [
    'DYSON_CONTROL_VERSIONS_V1', String(processId), String(writtenAt),
    versions.game, versions.nebula, versions.bepinex, versions.bridge
  ]
  await fs.writeFile(path.join(fixture.game.bridgeDirectory, 'versions'), [
    'protocol=DYSON_CONTROL_VERSIONS_V1', `processId=${processId}`, `writtenAtUnixMs=${writtenAt}`,
    `game=${versions.game}`, `nebula=${versions.nebula}`, `bepinex=${versions.bepinex}`, `bridge=${versions.bridge}`,
    `hmac=${sign(secret, parts)}`, ''
  ].join('\n'))
}

async function publishBridgePlayerEvents(fixture: ControlConfig, secret: string, processId: number): Promise<void> {
  const writtenAtUnixMs = Date.now()
  const sessionId = '00000000-0000-4000-8000-000000000001'
  const events = [{
    sequence: 1, type: 'join', sessionPlayerId: 'player-000001', displayName: 'Historical Player', observedAtUnixMs: writtenAtUnixMs - 100
  }]
  const eventsJsonB64 = Buffer.from(JSON.stringify(events), 'utf8').toString('base64url')
  const parts = [
    'DYSON_CONTROL_PLAYER_EVENTS_V1', sessionId, String(processId), String(writtenAtUnixMs), '1', '1', '1', eventsJsonB64
  ]
  await fs.writeFile(path.join(fixture.game.bridgeDirectory, 'player-events'), [
    'protocol=DYSON_CONTROL_PLAYER_EVENTS_V1', `sessionId=${sessionId}`, `processId=${processId}`,
    `writtenAtUnixMs=${writtenAtUnixMs}`, 'firstSequence=1', 'lastSequence=1', 'eventCount=1',
    `eventsJsonB64=${eventsJsonB64}`, `hmac=${sign(secret, parts)}`, ''
  ].join('\n'))
}

const playerSessionId = '00000000-0000-4000-8000-000000000001'
const playerSessionPlayerId = 'player-000001'
const currentPlayerId = `${playerSessionId}:${playerSessionPlayerId}`

async function publishBridgePlayers(fixture: ControlConfig, secret: string, displayName = 'Nova'): Promise<void> {
  const writtenAt = Date.now()
  const players = [{
    sessionPlayerId: playerSessionPlayerId, displayName, online: true,
    joinedAtUnixMs: writtenAt - 1_000, location: 'planet:101'
  }]
  const playersJsonB64 = Buffer.from(JSON.stringify(players), 'utf8').toString('base64url')
  const parts = ['DYSON_CONTROL_PLAYERS_V1', playerSessionId, String(writtenAt), '1', 'active', 'false', '1', playersJsonB64]
  await fs.writeFile(path.join(fixture.game.bridgeDirectory, 'players'), [
    'protocol=DYSON_CONTROL_PLAYERS_V1', `sessionId=${playerSessionId}`, `writtenAtUnixMs=${writtenAt}`,
    'sequence=1', 'state=active', 'truncated=false', 'playerCount=1', `playersJsonB64=${playersJsonB64}`,
    `hmac=${sign(secret, parts)}`, ''
  ].join('\n'))
}

async function publishBridgePlayerActionCapability(
  fixture: ControlConfig, secret: string, processId: number,
  state: 'available' | 'unavailable' = 'available', writtenAt = Date.now()
): Promise<void> {
  const parts = ['DYSON_CONTROL_PLAYER_ACTIONS_V1', playerSessionId, String(processId), String(writtenAt), state]
  await fs.writeFile(path.join(fixture.game.bridgeDirectory, 'player-actions'), [
    'protocol=DYSON_CONTROL_PLAYER_ACTIONS_V1', `sessionId=${playerSessionId}`, `processId=${processId}`,
    `writtenAtUnixMs=${writtenAt}`, `state=${state}`, `hmac=${sign(secret, parts)}`, ''
  ].join('\n'))
}

async function bridgeKickWorker(
  fixture: ControlConfig, secret: string,
  outcome: { state: 'succeeded'; errorCode: 'NONE' } | { state: 'failed'; errorCode: string }
): Promise<void> {
  const requests = path.join(fixture.game.bridgeDirectory, 'player-requests')
  const responses = path.join(fixture.game.bridgeDirectory, 'player-responses')
  await fs.mkdir(requests, { recursive: true })
  await fs.mkdir(responses, { recursive: true })
  for (let count = 0; count < 200; count++) {
    const requestFile = (await fs.readdir(requests)).find(name => name.endsWith('.request'))
    if (!requestFile) { await new Promise(resolve => setTimeout(resolve, 10)); continue }
    const requestId = requestFile.slice(0, -'.request'.length)
    const payload = await fs.readFile(path.join(requests, requestFile), 'utf8')
    const row = Object.fromEntries(payload.trimEnd().split(/\r?\n/).map(line => {
      const separator = line.indexOf('=')
      return [line.slice(0, separator), line.slice(separator + 1)]
    }))
    const started = Math.max(Date.now(), Number(row.createdAtUnixMs))
    const finished = started + 1
    const parts = [
      'DYSON_CONTROL_PLAYER_ACTION_RECEIPT_V1', requestId, 'kick-player', row.sessionId!, row.sessionPlayerId!,
      outcome.state, String(started), String(finished), outcome.errorCode
    ]
    await fs.writeFile(path.join(responses, `${requestId}.receipt`), [
      'protocol=DYSON_CONTROL_PLAYER_ACTION_RECEIPT_V1', `requestId=${requestId}`, 'action=kick-player',
      `sessionId=${row.sessionId}`, `sessionPlayerId=${row.sessionPlayerId}`, `state=${outcome.state}`,
      `startedAtUnixMs=${started}`, `finishedAtUnixMs=${finished}`, `errorCode=${outcome.errorCode}`,
      `hmac=${sign(secret, parts)}`, ''
    ].join('\n'))
    return
  }
  throw new Error('Bridge kick request was not observed.')
}

type UpdateFixture = Pick<GameUpdateManager,
  'versions' | 'resolvePackagePlan' | 'installComponent' | 'installPackage' | 'rollbackUpdate' |
  'installedPackageVersion' | 'searchPackages' | 'updateHistory' | 'recoverInterrupted'>

function resolvedPackage(packageFullName: string, version: string, dependencies: string[] = []): ResolvedPackage {
  const separator = packageFullName.indexOf('-')
  const owner = packageFullName.slice(0, separator)
  const packageName = packageFullName.slice(separator + 1)
  return {
    owner, packageName, packageFullName, name: packageName, fullName: `${packageFullName}-${version}`, version,
    description: '', downloads: 0, dependencies, downloadUrl: `https://packages.test/${packageFullName}-${version}.zip`,
    fileSize: null, dateCreated: '2026-10-17T00:00:00.000Z'
  }
}

function updateFixture(overrides: Partial<UpdateFixture> = {}): UpdateFixture {
  return {
    recoverInterrupted: async () => undefined,
    versions: async () => [],
    installedPackageVersion: async () => null,
    resolvePackagePlan: async (packageFullName, version) => [resolvedPackage(packageFullName, version ?? '1.0.0')],
    installComponent: async (component, version) => ({ component, version: version ?? 'latest' }),
    installPackage: async (packageName, version, component) => ({
      component, package: packageName, version: version ?? 'latest', installed: [], backupId: 'fixture-update',
      backupDirectory: 'fixture', restartRequired: true
    }),
    rollbackUpdate: async (historyId) => ({
      historyId, rollbackBackupId: 'fixture-rollback', restoredPackages: [], preservedConfigFiles: 0, restartRequired: true
    }),
    searchPackages: async () => [],
    updateHistory: async () => [],
    ...overrides
  }
}

function packageCatalogFetch(packageFullName: string, packageVersions: string[], binaryName: string): typeof fetch {
  const separator = packageFullName.indexOf('-')
  const owner = packageFullName.slice(0, separator)
  const name = packageFullName.slice(separator + 1)
  const archives = new Map<string, Buffer>(packageVersions.map((version) => {
    const fullName = `${packageFullName}-${version}`
    return [`https://packages.test/${fullName}.zip`, buildStoredZip([
      { name: 'manifest.json', data: JSON.stringify({ name, version_number: version, dependencies: [] }) },
      { name: binaryName, data: `${fullName}-binary` }
    ])] as const
  }))
  const catalog = [{
    name, full_name: packageFullName, owner, package_url: `https://packages.test/project/${packageFullName}`,
    date_updated: '2026-10-17T00:00:00.000Z', rating_score: 1, categories: ['mods'], is_deprecated: false,
    versions: packageVersions.map((version) => ({
      name, full_name: `${packageFullName}-${version}`, version_number: version, dependencies: [], description: '', downloads: 1,
      download_url: `https://packages.test/${packageFullName}-${version}.zip`, file_size: archives.get(`https://packages.test/${packageFullName}-${version}.zip`)!.length,
      date_created: '2026-10-17T00:00:00.000Z', is_active: true
    }))
  }]
  return (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url === 'https://catalog.test/packages') {
      const body = JSON.stringify(catalog)
      return new Response(body, { status: 200, headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) } })
    }
    const archive = archives.get(url)
    return archive
      ? new Response(archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength) as ArrayBuffer, {
          status: 200, headers: { 'content-length': String(archive.length) }
        })
      : new Response('not found', { status: 404 })
  }) as typeof fetch
}

describe('demo adapter', () => {
  it('provides working routes and reversible actions', async () => {
    const adapter = createGameAdapter(await config('demo'))
    expect((await adapter.overview()).state).toBe('running')
    expect((await adapter.players()).length).toBeGreaterThan(0)
    expect((await adapter.mods()).length).toBeGreaterThan(0)
    expect((await adapter.saves()).some((save) => save.members.includes(`${save.name}.moddsv`))).toBe(true)
    const reports: string[] = []
    const signal = new AbortController().signal
    const backup = await adapter.run('backup', {}, (message) => reports.push(message), signal)
    await adapter.run('toggle-mod', { modId: 'factory-locator', enabled: false }, () => undefined, signal)
    await adapter.run('install-update', { component: 'nebula', version: '0.9.23' }, () => undefined, signal)
    const client = await adapter.run('create-client-package', {}, () => undefined, signal)
    expect((await adapter.download!('backup', String(backup.backupId))).fileName).toMatch(/\.zip$/)
    expect((await adapter.download!('client', String(client.packageId))).fileName).toMatch(/\.r2z$/)
    await adapter.run('restore', { backupId: backup.backupId }, () => undefined, signal)
    await adapter.run('restart', {}, () => undefined, signal)
    expect((await adapter.overview()).state).toBe('running')
    expect(reports.length).toBeGreaterThan(0)
  })
})

describe.runIf(process.platform === 'win32')('Windows save-set adapter', () => {
  it('backs up and restores dsv, server and existing moddsv together', async () => {
    const fixture = await config('windows')
    await fs.mkdir(fixture.game.root, { recursive: true })
    const original = { dsv: 'dsv-original', server: 'server-original', moddsv: 'moddsv-original' }
    for (const [extension, content] of Object.entries(original)) await fs.writeFile(path.join(fixture.game.saveDirectory, `World.${extension}`), content)
    const adapter = new WindowsGameAdapter(fixture, { inspect: async () => ({
      process: null,
      versions: { game: null, nebula: null, bepinex: null },
      tasks: { start: true, startManaged: true, configuredTargetUps: null }
    }) })
    const save = (await adapter.saves())[0]!
    expect(save.members).toEqual(['World.dsv', 'World.server', 'World.moddsv'])
    const backup = await adapter.run('backup', { saveId: save.id }, () => undefined, new AbortController().signal)
    for (const extension of Object.keys(original)) await fs.writeFile(path.join(fixture.game.saveDirectory, `World.${extension}`), `changed-${extension}`)
    const restored = await adapter.run('restore', { backupId: backup.backupId }, () => undefined, new AbortController().signal)
    expect(restored).toMatchObject({ saveName: 'World', restarted: false })
    for (const [extension, content] of Object.entries(original)) expect(await fs.readFile(path.join(fixture.game.saveDirectory, `World.${extension}`), 'utf8')).toBe(content)
    expect((await adapter.backups()).some((item) => item.reason === 'automatic-before-restore')).toBe(true)
  })
})

describe('Windows adapter fixture behavior', () => {
  it('exposes package search and update history from the update manager', async () => {
    const fixture = await config('windows')
    const searches: string[] = []
    const catalog = [{
      package: 'starfi5h-FactoryLocator', name: 'FactoryLocator', owner: 'starfi5h', description: 'Find factories',
      latestVersion: '1.3.12', installedVersion: null, downloads: 42, ratingScore: 7, updatedAt: null,
      packageUrl: 'https://example.test/package', dependencies: [], isCoreComponent: false
    }]
    const history = [{
      id: 'update-1', operation: 'install' as const, createdAt: '2026-10-15T00:00:00.000Z', state: 'installed' as const,
      packages: [{ package: 'starfi5h-FactoryLocator', version: '1.3.12', sha256: 'a'.repeat(64) }],
      changeCount: 1, canRollback: true
    }]
    const adapter = new WindowsGameAdapter(fixture, {
      updates: updateFixture({
        searchPackages: async (query = '') => { searches.push(query); return catalog },
        updateHistory: async () => history
      })
    })

    await expect(adapter.modCatalog('factory')).resolves.toEqual(catalog)
    await expect(adapter.updateHistory()).resolves.toEqual(history)
    expect(searches).toEqual(['factory'])
  })

  it('reports a running server player count as unavailable when the Bridge snapshot is missing', async () => {
    const fixture = await config('windows')
    await fs.mkdir(fixture.game.root, { recursive: true })
    const adapter = new WindowsGameAdapter(fixture, { inspect: async () => ({
      process: {
        pid: 4242, startedAt: new Date(Date.now() - 5_000).toISOString(), workingSetBytes: 1024,
        totalProcessorSeconds: 1, targetUps: 60, selectedSave: null
      },
      versions: { game: null, nebula: null, bepinex: null },
      tasks: { start: true, startManaged: true, configuredTargetUps: null }
    }) })
    const overview = await adapter.overview()
    expect(overview).toMatchObject({ state: 'running', playerCount: null, playerStatus: 'unavailable', maxPlayers: null })
    expect(overview.metrics).toMatchObject({ ups: null, tps: null })
    await expect(adapter.players()).rejects.toMatchObject({ code: 'BRIDGE_DIRECTORY_INVALID' })
  })

  it('reports only signed telemetry from the exact running process', async () => {
    const fixture = await config('windows')
    await fs.mkdir(fixture.game.root, { recursive: true })
    const processId = 4242
    const adapter = new WindowsGameAdapter(fixture, { inspect: async () => ({
      process: {
        pid: processId, startedAt: new Date(Date.now() - 5_000).toISOString(), workingSetBytes: 1024,
        totalProcessorSeconds: 1, targetUps: 60, selectedSave: null
      },
      versions: { game: null, nebula: null, bepinex: null },
      tasks: { start: true, startManaged: true, configuredTargetUps: null }
    }) })
    const secret = await prepareBridge(fixture, processId)
    await publishBridgeTelemetry(fixture, secret, processId)

    expect((await adapter.overview()).metrics).toMatchObject({ ups: 59.875, tps: 60 })
    await publishBridgeTelemetry(fixture, secret, processId, 'unavailable')
    expect((await adapter.overview()).metrics).toMatchObject({ ups: null, tps: null })
  })

  it('reports runtime versions only from the current process signed Bridge snapshot', async () => {
    const fixture = await config('windows')
    await fs.mkdir(fixture.game.root, { recursive: true })
    const processId = 4242
    const adapter = new WindowsGameAdapter(fixture, { inspect: async () => ({
      process: {
        pid: processId, startedAt: new Date(Date.now() - 5_000).toISOString(), workingSetBytes: 1024,
        totalProcessorSeconds: 1, targetUps: 60, selectedSave: null
      },
      versions: { game: '2021.3.16.27754', nebula: '9.9.9-assembly', bepinex: '9.9.9-assembly' },
      tasks: { start: true, startManaged: true, configuredTargetUps: null }
    }) })
    const secret = await prepareBridge(fixture, processId)
    await publishBridgeVersions(fixture, secret, processId)

    expect((await adapter.overview()).versions).toEqual({
      game: '0.10.34.28470', nebula: '0.9.24.0', bepinex: '5.4.17.0'
    })
    await publishBridgeVersions(fixture, secret, processId + 1)
    expect((await adapter.overview()).versions).toEqual({ game: 'unknown', nebula: 'unknown', bepinex: 'unknown' })
  })

  it('does not treat executable or assembly metadata as verified versions while stopped', async () => {
    const fixture = await config('windows')
    await fs.mkdir(fixture.game.root, { recursive: true })
    const adapter = new WindowsGameAdapter(fixture, { inspect: async () => ({
      process: null,
      versions: { game: '2021.3.16.27754', nebula: '0.9.24.0', bepinex: '5.4.17.0' },
      tasks: { start: true, startManaged: true, configuredTargetUps: null }
    }) })
    expect((await adapter.overview()).versions).toEqual({ game: 'unknown', nebula: 'unknown', bepinex: 'unknown' })
  })

  it('uses exact installed Thunderstore package versions in the component manager and locks', async () => {
    const fixture = await config('windows')
    await fs.mkdir(fixture.game.root, { recursive: true })
    const processId = 4242
    let supplied: { game: string; nebula: string; bepinex: string } | null = null
    const installed = new Map([
      ['nebula-nebulamultiplayermod', '0.9.24'],
      ['xiaoye97-bepinex', '5.4.17']
    ])
    const adapter = new WindowsGameAdapter(fixture, {
      inspect: async () => ({
        process: { pid: processId, startedAt: new Date().toISOString(), workingSetBytes: 1024, totalProcessorSeconds: 1, targetUps: 60, selectedSave: null },
        versions: { game: 'Unity', nebula: 'assembly-nebula', bepinex: 'assembly-bepinex' },
        tasks: { start: true, startManaged: true, configuredTargetUps: null }
      }),
      updates: updateFixture({
        installedPackageVersion: async packageName => installed.get(packageName.toLowerCase()) ?? null,
        versions: async current => { supplied = current; return [] }
      })
    })
    const secret = await prepareBridge(fixture, processId)
    await publishBridgeVersions(fixture, secret, processId)

    await adapter.versions()
    expect(supplied).toEqual({ game: '0.10.34.28470', nebula: '0.9.24', bepinex: '5.4.17' })
    await expect(adapter.run('set-version-lock', {
      component: 'nebula', locked: true
    }, () => undefined, new AbortController().signal)).resolves.toMatchObject({
      package: 'nebula-NebulaMultiplayerMod', version: '0.9.24', locked: true
    })
  })

  it.each([true, false])('discovers an existing component manifest without update history only when enabled=%s', async enabled => {
    const fixture = await config('windows')
    const nebula = path.join(fixture.game.root, 'BepInEx', enabled ? 'plugins' : 'disabled-plugins', 'nebula-NebulaMultiplayerMod')
    await fs.mkdir(nebula, { recursive: true })
    await fs.writeFile(path.join(nebula, 'manifest.json'), '\uFEFF' + JSON.stringify({
      author_name: 'nebula', name: 'NebulaMultiplayerMod', version_number: '0.9.22', dependencies: []
    }))
    let supplied: { game: string; nebula: string; bepinex: string } | null = null
    const adapter = new WindowsGameAdapter(fixture, {
      inspect: async () => ({
        process: null,
        versions: { game: null, nebula: '0.9.22.2', bepinex: null },
        tasks: { start: true, startManaged: true, configuredTargetUps: null }
      }),
      updates: updateFixture({
        installedPackageVersion: async () => null,
        versions: async current => { supplied = current; return [] }
      })
    })
    await adapter.versions()
    expect(supplied).toEqual({ game: 'unknown', nebula: enabled ? '0.9.22' : 'unknown', bepinex: 'unknown' })
    const lock = adapter.run('set-version-lock', { component: 'nebula', locked: true }, () => undefined, new AbortController().signal)
    if (enabled) {
      await expect(lock).resolves.toMatchObject({ package: 'nebula-NebulaMultiplayerMod', version: '0.9.22', locked: true })
    } else {
      await expect(lock).rejects.toMatchObject({ code: 'VERSION_UNKNOWN' })
    }
  })

  it('reads the last signed player event batch after the game has stopped', async () => {
    const fixture = await config('windows')
    await fs.mkdir(fixture.game.root, { recursive: true })
    const processId = 4242
    const adapter = new WindowsGameAdapter(fixture, { inspect: async () => ({
      process: null,
      versions: { game: null, nebula: null, bepinex: null },
      tasks: { start: true, startManaged: true, configuredTargetUps: null }
    }) })
    const secret = await prepareBridge(fixture, processId)
    await publishBridgePlayerEvents(fixture, secret, processId)

    await expect(adapter.playerEvents()).resolves.toMatchObject({
      processId, firstSequence: 1, lastSequence: 1,
      events: [{ sequence: 1, type: 'join', sessionPlayerId: 'player-000001', displayName: 'Historical Player' }]
    })
  })

  it('exposes player actions only from a fresh signed capability for the current process', async () => {
    const fixture = await config('windows')
    await fs.mkdir(fixture.game.root, { recursive: true })
    const processId = 4242
    const adapter = new WindowsGameAdapter(fixture, { inspect: async () => ({
      process: {
        pid: processId, startedAt: new Date(Date.now() - 30_000).toISOString(), workingSetBytes: 1024,
        totalProcessorSeconds: 1, targetUps: 60, selectedSave: null
      },
      versions: { game: null, nebula: null, bepinex: null },
      tasks: { start: true, startManaged: true, configuredTargetUps: null }
    }) })
    const secret = await prepareBridge(fixture, processId, Date.now() - 30_000)
    await publishBridgePlayers(fixture, secret)
    await publishBridgePlayerActionCapability(fixture, secret, processId)
    expect((await adapter.overview()).capabilities.playerActions).toBe(true)

    await publishBridgePlayerActionCapability(fixture, secret, processId, 'available', Date.now() - 20_000)
    expect((await adapter.overview()).capabilities.playerActions).toBe(false)
  })

  it('rejects kick requests while stopped before creating a Bridge request', async () => {
    const fixture = await config('windows')
    await fs.mkdir(fixture.game.root, { recursive: true })
    const adapter = new WindowsGameAdapter(fixture, { inspect: async () => ({
      process: null,
      versions: { game: null, nebula: null, bepinex: null },
      tasks: { start: true, startManaged: true, configuredTargetUps: null }
    }) })

    await expect(adapter.run('kick-player', { playerId: currentPlayerId }, () => undefined, new AbortController().signal))
      .rejects.toMatchObject({ code: 'GAME_NOT_RUNNING' })
    await expect(fs.readdir(path.join(fixture.game.bridgeDirectory, 'player-requests'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects a player id from an old session before creating a Bridge request', async () => {
    const fixture = await config('windows')
    await fs.mkdir(fixture.game.root, { recursive: true })
    const processId = 4242
    const adapter = new WindowsGameAdapter(fixture, { inspect: async () => ({
      process: { pid: processId, startedAt: new Date().toISOString(), workingSetBytes: 1024, totalProcessorSeconds: 1, targetUps: 60, selectedSave: null },
      versions: { game: null, nebula: null, bepinex: null },
      tasks: { start: true, startManaged: true, configuredTargetUps: null }
    }) })
    const secret = await prepareBridge(fixture, processId)
    await publishBridgePlayers(fixture, secret)

    await expect(adapter.run('kick-player', {
      playerId: `11111111-1111-4111-8111-111111111111:${playerSessionPlayerId}`
    }, () => undefined, new AbortController().signal)).rejects.toMatchObject({ code: 'PLAYER_SESSION_STALE' })
    await expect(fs.readdir(path.join(fixture.game.bridgeDirectory, 'player-requests'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('kicks a current-session player only after a valid signed Bridge receipt', async () => {
    const fixture = await config('windows')
    await fs.mkdir(fixture.game.root, { recursive: true })
    const processId = 4242
    const adapter = new WindowsGameAdapter(fixture, { inspect: async () => ({
      process: { pid: processId, startedAt: new Date().toISOString(), workingSetBytes: 1024, totalProcessorSeconds: 1, targetUps: 60, selectedSave: null },
      versions: { game: null, nebula: null, bepinex: null },
      tasks: { start: true, startManaged: true, configuredTargetUps: null }
    }) })
    const secret = await prepareBridge(fixture, processId)
    await publishBridgePlayers(fixture, secret)
    await publishBridgePlayerActionCapability(fixture, secret, processId)
    const worker = bridgeKickWorker(fixture, secret, { state: 'succeeded', errorCode: 'NONE' })

    await expect(adapter.run('kick-player', { playerId: currentPlayerId }, () => undefined, new AbortController().signal))
      .resolves.toEqual({ playerId: currentPlayerId, kicked: true })
    await worker
  })

  it('reports a signed Bridge kick failure without claiming the player was removed', async () => {
    const fixture = await config('windows')
    await fs.mkdir(fixture.game.root, { recursive: true })
    const processId = 4242
    const adapter = new WindowsGameAdapter(fixture, { inspect: async () => ({
      process: { pid: processId, startedAt: new Date().toISOString(), workingSetBytes: 1024, totalProcessorSeconds: 1, targetUps: 60, selectedSave: null },
      versions: { game: null, nebula: null, bepinex: null },
      tasks: { start: true, startManaged: true, configuredTargetUps: null }
    }) })
    const secret = await prepareBridge(fixture, processId)
    await publishBridgePlayers(fixture, secret)
    await publishBridgePlayerActionCapability(fixture, secret, processId)
    const worker = bridgeKickWorker(fixture, secret, { state: 'failed', errorCode: 'NEBULA_DISCONNECT_FAILED' })

    await expect(adapter.run('kick-player', { playerId: currentPlayerId }, () => undefined, new AbortController().signal))
      .rejects.toMatchObject({ code: 'PLAYER_KICK_FAILED', message: expect.stringContaining('NEBULA_DISCONNECT_FAILED') })
    await worker
  })

  it('rejects an unavailable player-action capability before waiting for a request receipt', async () => {
    const fixture = await config('windows')
    await fs.mkdir(fixture.game.root, { recursive: true })
    const processId = 4242
    const adapter = new WindowsGameAdapter(fixture, { inspect: async () => ({
      process: { pid: processId, startedAt: new Date().toISOString(), workingSetBytes: 1024, totalProcessorSeconds: 1, targetUps: 60, selectedSave: null },
      versions: { game: null, nebula: null, bepinex: null },
      tasks: { start: true, startManaged: true, configuredTargetUps: null }
    }) })
    const secret = await prepareBridge(fixture, processId)
    await publishBridgePlayers(fixture, secret)
    await publishBridgePlayerActionCapability(fixture, secret, processId, 'unavailable')

    await expect(adapter.run('kick-player', { playerId: currentPlayerId }, () => undefined, new AbortController().signal))
      .rejects.toMatchObject({ code: 'PLAYER_ACTIONS_UNAVAILABLE' })
    await expect(fs.readdir(path.join(fixture.game.bridgeDirectory, 'player-requests'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('derives host network rates from two stable physical-adapter counter samples', async () => {
    const fixture = await config('windows')
    await fs.mkdir(fixture.game.root, { recursive: true })
    let sampledAt = 100_000
    let inspectionIndex = 0
    const samples = [
      { sampledAtUnixMs: 1_000, adapters: [{ id: 'ethernet', receivedBytes: '1000', sentBytes: '500' }] },
      { sampledAtUnixMs: 3_000, adapters: [{ id: 'ethernet', receivedBytes: '1800', sentBytes: '1100' }] }
    ]
    const adapter = new WindowsGameAdapter(fixture, {
      clock: () => sampledAt,
      inspect: async () => ({
        process: null,
        versions: { game: null, nebula: null, bepinex: null },
        tasks: { start: true, startManaged: true, configuredTargetUps: null },
        network: samples[Math.min(inspectionIndex++, samples.length - 1)]
      })
    })
    expect((await adapter.overview()).metrics).toMatchObject({
      networkReceiveBytesPerSecond: null, networkSendBytesPerSecond: null
    })
    sampledAt += 2_500
    expect((await adapter.overview()).metrics).toMatchObject({
      networkReceiveBytesPerSecond: 400, networkSendBytesPerSecond: 300
    })
  })

  it('applies target UPS only for the managed start script and exposes unsupported settings as null', async () => {
    const fixture = await config('windows')
    await fs.mkdir(fixture.game.root, { recursive: true })
    const inspect = async (managed: boolean) => ({
      process: null,
      versions: { game: null, nebula: null, bepinex: null },
      tasks: { start: true, startManaged: managed, configuredTargetUps: managed ? null : 60 }
    })
    const managed = new WindowsGameAdapter(fixture, { inspect: () => inspect(true) })
    expect(await managed.settings()).toMatchObject({ maxPlayers: null, autosaveMinutes: null, targetUps: 60, readOnlyFields: ['maxPlayers', 'autosaveMinutes'] })
    const result = await managed.run('write-settings', {
      settings: { serverName: 'Managed', maxPlayers: null, targetUps: 75, autosaveMinutes: null, backupKeep: 3, address: 'managed.example.test' }
    }, () => undefined, new AbortController().signal)
    expect(result).toMatchObject({ restartRequired: false, unsupportedFields: ['maxPlayers', 'autosaveMinutes'] })
    expect(JSON.parse(await fs.readFile(path.join(fixture.dataDirectory, 'game-startup', 'settings.json'), 'utf8'))).toEqual({ schema: 1, targetUps: 75, saveName: null })

    const secondFixture = await config('windows')
    await fs.mkdir(secondFixture.game.root, { recursive: true })
    const unmanaged = new WindowsGameAdapter(secondFixture, { inspect: () => inspect(false) })
    await expect(unmanaged.run('write-settings', {
      settings: { serverName: 'Old task', maxPlayers: null, targetUps: 75, autosaveMinutes: null, backupKeep: 3, address: 'old.example.test' }
    }, () => undefined, new AbortController().signal)).rejects.toMatchObject({ code: 'UNSUPPORTED_SETTING' })
  })

  it('records actual settings before writes and rollbacks without replacing the current startup save', async () => {
    const fixture = await config('windows')
    await fs.mkdir(fixture.game.root, { recursive: true })
    await fs.mkdir(path.join(fixture.dataDirectory, 'game-startup'), { recursive: true })
    await fs.writeFile(path.join(fixture.dataDirectory, 'game-startup', 'settings.json'), JSON.stringify({ schema: 1, targetUps: 60, saveName: 'World-A' }))
    await fs.writeFile(path.join(fixture.game.saveDirectory, 'World-B.dsv'), 'world-b-dsv')
    await fs.writeFile(path.join(fixture.game.saveDirectory, 'World-B.server'), 'world-b-server')
    const adapter = new WindowsGameAdapter(fixture, { inspect: async () => ({
      process: null,
      versions: { game: null, nebula: null, bepinex: null },
      tasks: { start: true, startManaged: true, configuredTargetUps: null }
    }) })

    const written = await adapter.run('write-settings', {
      settings: { serverName: 'Changed Server', maxPlayers: null, targetUps: 75, autosaveMinutes: null, backupKeep: 7, address: 'changed.example.test' }
    }, () => undefined, new AbortController().signal)
    const original = (await adapter.settingsHistory())[0]!
    expect(written).toMatchObject({ historyId: original.id })
    expect(original).toMatchObject({
      operation: 'write', settings: { serverName: 'Fixture Server', targetUps: 60, backupKeep: 20, address: 'fixture.example.test' }
    })

    const worldB = (await adapter.saves()).find(save => save.name === 'World-B')!
    const backup = await adapter.run('backup', { saveId: worldB.id }, () => undefined, new AbortController().signal)
    await adapter.run('restore', { backupId: backup.backupId }, () => undefined, new AbortController().signal)
    const rolledBack = await adapter.run('rollback-settings', { historyId: original.id }, () => undefined, new AbortController().signal)

    expect(rolledBack).toMatchObject({ restoredFromHistoryId: original.id, settings: { serverName: 'Fixture Server', targetUps: 60 } })
    expect(JSON.parse(await fs.readFile(path.join(fixture.dataDirectory, 'game-startup', 'settings.json'), 'utf8'))).toEqual({
      schema: 1, targetUps: 60, saveName: 'World-B'
    })
    expect((await adapter.settingsHistory()).map(entry => entry.operation)).toEqual(['rollback', 'write'])
    expect((await adapter.settingsHistory())[0]!.settings).toMatchObject({ serverName: 'Changed Server', targetUps: 75 })
  })

  it('restores the first settings file and discards unused history when the startup write fails', async () => {
    const fixture = await config('windows')
    await fs.mkdir(fixture.game.root, { recursive: true })
    const adapter = new WindowsGameAdapter(fixture, { inspect: async () => ({
      process: null,
      versions: { game: null, nebula: null, bepinex: null },
      tasks: { start: true, startManaged: true, configuredTargetUps: null }
    }) })
    await adapter.settings()
    const startupPath = path.join(fixture.dataDirectory, 'game-startup', 'settings.json')
    await fs.rm(startupPath)
    await fs.mkdir(startupPath)

    await expect(adapter.run('write-settings', {
      settings: { serverName: 'Should Not Persist', maxPlayers: null, targetUps: 75, autosaveMinutes: null, backupKeep: 7, address: 'failed.example.test' }
    }, () => undefined, new AbortController().signal)).rejects.toMatchObject({ code: 'SETTINGS_PATH_INVALID' })

    expect(JSON.parse(await fs.readFile(path.join(fixture.dataDirectory, 'game-settings.json'), 'utf8'))).toEqual({
      schema: 1, serverName: 'Fixture Server', backupKeep: 20, address: 'fixture.example.test'
    })
    await expect(adapter.settingsHistory()).resolves.toEqual([])
  })

  it('selects the restored save for managed startup and bounds automatic backup retention', async () => {
    const fixture = await config('windows')
    await fs.mkdir(fixture.game.root, { recursive: true })
    await fs.writeFile(path.join(fixture.game.saveDirectory, 'World.dsv'), 'original-dsv')
    await fs.writeFile(path.join(fixture.game.saveDirectory, 'World.server'), 'original-server')
    const adapter = new WindowsGameAdapter(fixture, { inspect: async () => ({
      process: null,
      versions: { game: null, nebula: null, bepinex: null },
      tasks: { start: true, startManaged: true, configuredTargetUps: null }
    }) })
    const save = (await adapter.saves())[0]!
    const backup = await adapter.run('backup', { saveId: save.id }, () => undefined, new AbortController().signal)
    await adapter.run('write-settings', {
      settings: { serverName: 'Fixture', maxPlayers: null, targetUps: 60, autosaveMinutes: null, backupKeep: 1, address: 'fixture.example.test' }
    }, () => undefined, new AbortController().signal)

    for (let attempt = 0; attempt < 2; attempt++) {
      await fs.writeFile(path.join(fixture.game.saveDirectory, 'World.dsv'), `changed-dsv-${attempt}`)
      await fs.writeFile(path.join(fixture.game.saveDirectory, 'World.server'), `changed-server-${attempt}`)
      const restored = await adapter.run('restore', { backupId: backup.backupId }, () => undefined, new AbortController().signal)
      expect(restored).toMatchObject({ saveName: 'World', startupSelectionApplied: true, restarted: false })
    }

    const startup = JSON.parse(await fs.readFile(path.join(fixture.dataDirectory, 'game-startup', 'settings.json'), 'utf8'))
    expect(startup).toEqual({ schema: 1, targetUps: 60, saveName: 'World' })
    const backups = await adapter.backups()
    expect(backups.filter((item) => item.reason === 'automatic-before-restore')).toHaveLength(1)
    expect(backups.some((item) => item.id === backup.backupId && item.reason === 'manual')).toBe(true)
  })

  it('waits through a slow restored-game start for the configured startup budget', async () => {
    const fixture = await config('windows')
    await fs.mkdir(fixture.game.root, { recursive: true })
    for (const extension of ['dsv', 'server', 'moddsv']) {
      await fs.writeFile(path.join(fixture.game.saveDirectory, `World.${extension}`), `original-${extension}`)
    }
    let running = false
    let processId = 4242
    let lateReady = Promise.resolve()
    const adapter = new WindowsGameAdapter(fixture, {
      lifecycleTimeoutMs: 500,
      startupTimeoutMs: 200_000,
      pollIntervalMs: 5,
      inspect: async () => ({
        process: running ? { pid: processId, startedAt: new Date(Date.now() - 1_000).toISOString(), workingSetBytes: 1024, totalProcessorSeconds: 1, targetUps: 60, selectedSave: 'World' } : null,
        versions: { game: null, nebula: null, bepinex: null },
        tasks: { start: true, startManaged: true, configuredTargetUps: 60 }
      }),
      runScript: async <T>() => {
        running = true
        processId += 1
        lateReady = (async () => {
          await new Promise(resolve => setTimeout(resolve, 1_250))
          await prepareBridge(fixture, processId)
        })()
        return {} as T
      }
    })
    const backup = await adapter.run('backup', { saveId: (await adapter.saves())[0]!.id }, () => undefined, new AbortController().signal)
    for (const extension of ['dsv', 'server', 'moddsv']) {
      await fs.writeFile(path.join(fixture.game.saveDirectory, `World.${extension}`), `changed-${extension}`)
    }
    running = true
    const secret = await prepareBridge(fixture, processId)
    // Compress explicit abort deadlines 100x: readiness arrives after the old
    // 75-second allowance but within the configured 200-second startup budget.
    const nativeTimeout = AbortSignal.timeout.bind(AbortSignal)
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(milliseconds => nativeTimeout(Math.max(1, Math.ceil(milliseconds / 100))))
    const workers = Promise.all([
      bridgeSaveWorker(fixture, secret, 'World'),
      bridgeStopWorker(fixture, secret, () => { running = false })
    ])
    try {
      await expect(adapter.run('restore', { backupId: backup.backupId }, () => undefined, new AbortController().signal))
        .resolves.toMatchObject({ saveName: 'World', restarted: true })
      for (const extension of ['dsv', 'server', 'moddsv']) {
        await expect(fs.readFile(path.join(fixture.game.saveDirectory, `World.${extension}`), 'utf8')).resolves.toBe(`original-${extension}`)
      }
    } finally {
      timeout.mockRestore()
      await workers
      await lateReady
    }
  })

  it('pins both saves protected by one running restore when backupKeep is one', async () => {
    const fixture = await config('windows')
    await fs.mkdir(fixture.game.root, { recursive: true })
    for (const [name, value] of [['WorldA', 'target-original'], ['WorldB', 'running-current']] as const) {
      await fs.writeFile(path.join(fixture.game.saveDirectory, `${name}.dsv`), `${value}-dsv`)
      await fs.writeFile(path.join(fixture.game.saveDirectory, `${name}.server`), `${value}-server`)
    }
    let running = false
    const processId = 4242
    const adapter = new WindowsGameAdapter(fixture, {
      lifecycleTimeoutMs: 500,
      pollIntervalMs: 5,
      inspect: async () => ({
        process: running ? { pid: processId, startedAt: new Date(Date.now() - 5_000).toISOString(), workingSetBytes: 1024, totalProcessorSeconds: 1, targetUps: 60, selectedSave: 'WorldB' } : null,
        versions: { game: null, nebula: null, bepinex: null },
        tasks: { start: true, startManaged: true, configuredTargetUps: null }
      }),
      runScript: async <T>() => { running = true; return {} as T }
    })
    const target = (await adapter.saves()).find(save => save.name === 'WorldA')!
    const backup = await adapter.run('backup', { saveId: target.id }, () => undefined, new AbortController().signal)
    await adapter.run('write-settings', {
      settings: { serverName: 'Fixture', maxPlayers: null, targetUps: 60, autosaveMinutes: null, backupKeep: 1, address: 'fixture.example.test' }
    }, () => undefined, new AbortController().signal)
    await fs.writeFile(path.join(fixture.game.saveDirectory, 'WorldA.dsv'), 'target-overwritten-dsv')
    await fs.writeFile(path.join(fixture.game.saveDirectory, 'WorldA.server'), 'target-overwritten-server')
    running = true
    const secret = await prepareBridge(fixture, processId)
    const workers = Promise.all([
      bridgeSaveWorker(fixture, secret, 'WorldB'),
      bridgeStopWorker(fixture, secret, () => { running = false })
    ])
    const restored = await adapter.run('restore', { backupId: backup.backupId }, () => undefined, new AbortController().signal)
    await workers

    expect(restored.automaticBackups).toHaveLength(2)
    const automatic = (await adapter.backups()).filter(item => item.reason === 'automatic-before-restore')
    expect(automatic.map(item => item.saveName).sort()).toEqual(['WorldA', 'WorldB'])
    const targetProtection = automatic.find(item => item.saveName === 'WorldA')!
    const currentProtection = automatic.find(item => item.saveName === 'WorldB')!
    await expect(fs.readFile(path.join(fixture.game.backupDirectory, targetProtection.id, 'WorldA.dsv'), 'utf8')).resolves.toBe('target-overwritten-dsv')
    await expect(fs.readFile(path.join(fixture.game.backupDirectory, currentProtection.id, 'WorldB.dsv'), 'utf8')).resolves.toBe('running-current-dsv')
  })

  it('rejects restore while stopped when the configured task is not managed', async () => {
    const fixture = await config('windows')
    await fs.mkdir(fixture.game.root, { recursive: true })
    await fs.writeFile(path.join(fixture.game.saveDirectory, 'World.dsv'), 'dsv')
    await fs.writeFile(path.join(fixture.game.saveDirectory, 'World.server'), 'server')
    const managed = new WindowsGameAdapter(fixture, { inspect: async () => ({
      process: null,
      versions: { game: null, nebula: null, bepinex: null },
      tasks: { start: true, startManaged: true, configuredTargetUps: null }
    }) })
    const backup = await managed.run('backup', { saveId: (await managed.saves())[0]!.id }, () => undefined, new AbortController().signal)
    const unmanaged = new WindowsGameAdapter(fixture, { inspect: async () => ({
      process: null,
      versions: { game: null, nebula: null, bepinex: null },
      tasks: { start: true, startManaged: false, configuredTargetUps: 60 }
    }) })
    await expect(unmanaged.run('restore', { backupId: backup.backupId }, () => undefined, new AbortController().signal))
      .rejects.toMatchObject({ code: 'RESTORE_START_UNSUPPORTED' })
  })

  it('keeps the game stopped when interrupted restore state contains an unknown live hash', async () => {
    const fixture = await config('windows')
    await Promise.all([fs.mkdir(fixture.game.root, { recursive: true }), fs.mkdir(path.join(fixture.dataDirectory, 'game-startup'), { recursive: true })])
    const source = path.join(path.dirname(fixture.dataDirectory), 'restore-source')
    await fs.mkdir(source)
    await fs.writeFile(path.join(fixture.game.saveDirectory, 'World.dsv'), 'before-dsv')
    await fs.writeFile(path.join(fixture.game.saveDirectory, 'World.server'), 'before-server')
    await fs.writeFile(path.join(source, 'World.dsv'), 'after-dsv')
    await fs.writeFile(path.join(source, 'World.server'), 'after-server')
    const startupPath = path.join(fixture.dataDirectory, 'game-startup', 'settings.json')
    await fs.writeFile(startupPath, `${JSON.stringify({ schema: 1, targetUps: 60, saveName: 'Before' }, null, 2)}\n`)
    const digest = (value: string) => createHash('sha256').update(value).digest('hex')
    const interrupted = new SaveRestoreManager({
      saveDirectory: fixture.game.saveDirectory,
      dataDirectory: fixture.dataDirectory,
      startupSettingsPath: startupPath,
      afterPromotion: count => { if (count === 1) throw new Error('simulated interruption') }
    })
    await expect(interrupted.replace({
      saveName: 'World',
      members: [
        { fileName: 'World.dsv', sourcePath: path.join(source, 'World.dsv'), sha256: digest('after-dsv') },
        { fileName: 'World.server', sourcePath: path.join(source, 'World.server'), sha256: digest('after-server') }
      ],
      startupSettings: { schema: 1, targetUps: 60, saveName: 'World' }
    }, async () => undefined)).rejects.toThrow('simulated interruption')
    await fs.writeFile(path.join(fixture.game.saveDirectory, 'World.server'), 'unknown-external-content')
    let startCalls = 0
    const adapter = new WindowsGameAdapter(fixture, {
      inspect: async () => ({
        process: null,
        versions: { game: null, nebula: null, bepinex: null },
        tasks: { start: true, startManaged: true, configuredTargetUps: null }
      }),
      runScript: async <T>() => { startCalls++; return {} as T }
    })
    await expect(adapter.run('start', {}, () => undefined, new AbortController().signal))
      .rejects.toMatchObject({ code: 'SAVE_RESTORE_RECOVERY_CONFLICT' })
    expect(startCalls).toBe(0)
    await expect(fs.lstat(path.join(fixture.dataDirectory, 'save-restore', 'active'))).resolves.toMatchObject({})
  })

  it('marks runtime-requested backups as scheduled automatic backups', async () => {
    const fixture = await config('windows')
    await fs.mkdir(fixture.game.root, { recursive: true })
    await fs.writeFile(path.join(fixture.game.saveDirectory, 'World.dsv'), 'current-dsv')
    await fs.writeFile(path.join(fixture.game.saveDirectory, 'World.server'), 'current-server')
    const adapter = new WindowsGameAdapter(fixture, { inspect: async () => ({
      process: null,
      versions: { game: null, nebula: null, bepinex: null },
      tasks: { start: true, startManaged: true, configuredTargetUps: null }
    }) })

    const result = await adapter.run('backup', { automatic: true }, () => undefined, new AbortController().signal)
    expect((await adapter.backups()).find((backup) => backup.id === result.backupId)?.reason).toBe('automatic-scheduled')
  })

  it('saves, backs up, stops, writes and rolls back mod configuration before restarting', async () => {
    const fixture = await config('windows')
    const configRoot = path.join(fixture.game.root, 'BepInEx', 'config')
    const configPath = path.join(configRoot, 'server.cfg')
    await fs.mkdir(configRoot, { recursive: true })
    await fs.writeFile(configPath, '[General]\nValue = one\n[Auth]\nPassword = private\n')
    await fs.writeFile(path.join(fixture.game.saveDirectory, 'World.dsv'), 'current-dsv')
    await fs.writeFile(path.join(fixture.game.saveDirectory, 'World.server'), 'current-server')
    const processId = 4242
    let running = true
    const adapter = new WindowsGameAdapter(fixture, {
      lifecycleTimeoutMs: 1_000,
      pollIntervalMs: 5,
      inspect: async () => ({
        process: running ? { pid: processId, startedAt: new Date().toISOString(), workingSetBytes: 1024, totalProcessorSeconds: 0, targetUps: 60, selectedSave: 'World' } : null,
        versions: { game: null, nebula: null, bepinex: null },
        tasks: { start: true, startManaged: true, configuredTargetUps: null }
      }),
      runScript: async <T>(_name: string, input: unknown) => {
        if ((input as { taskName?: unknown }).taskName === fixture.game.startTaskName) running = true
        return {} as T
      }
    })
    const initial = (await adapter.modConfigs())[0]!
    const secret = await prepareBridge(fixture, processId)
    let workers = Promise.all([
      bridgeSaveWorker(fixture, secret, 'World'),
      bridgeStopWorker(fixture, secret, () => { running = false })
    ])
    const reports: string[] = []
    const written = await adapter.run('write-mod-config', {
      configId: initial.id,
      content: initial.content.replace('Value = one', 'Value = two'),
      expectedRevision: initial.revision
    }, (message) => reports.push(message), new AbortController().signal)
    await workers

    expect(written).toMatchObject({ configId: initial.id, wasRunning: true, restarted: true, automaticBackupId: expect.any(String) })
    expect(running).toBe(true)
    expect(await fs.readFile(configPath, 'utf8')).toContain('Value = two')
    expect(await fs.readFile(configPath, 'utf8')).toContain('Password = private')
    expect(reports.indexOf('正在停止服务器')).toBeLessThan(reports.indexOf('正在执行模组配置保存'))
    expect((await adapter.backups()).some((backup) => backup.reason === 'automatic-before-mod-config-write')).toBe(true)

    const changed = (await adapter.modConfigs())[0]!
    workers = Promise.all([
      bridgeSaveWorker(fixture, secret, 'World'),
      bridgeStopWorker(fixture, secret, () => { running = false })
    ])
    const rolledBack = await adapter.run('rollback-mod-config', {
      historyId: String(written.historyId), expectedRevision: changed.revision
    }, () => undefined, new AbortController().signal)
    await workers

    expect(rolledBack).toMatchObject({ configId: initial.id, wasRunning: true, restarted: true, automaticBackupId: expect.any(String) })
    expect(await fs.readFile(configPath, 'utf8')).toContain('Value = one')
    expect((await adapter.modConfigHistory(initial.id)).map((entry) => entry.operation)).toEqual(['rollback', 'write'])
    expect((await adapter.backups()).some((backup) => backup.reason === 'automatic-before-mod-config-rollback')).toBe(true)
  })

  it('restores the prior mod configuration and server state when restart with a change fails', async () => {
    const fixture = await config('windows')
    const configRoot = path.join(fixture.game.root, 'BepInEx', 'config')
    const configPath = path.join(configRoot, 'server.cfg')
    await fs.mkdir(configRoot, { recursive: true })
    await fs.writeFile(configPath, '[General]\nValue = original\n[Auth]\nPassword = private\n')
    await fs.writeFile(path.join(fixture.game.saveDirectory, 'World.dsv'), 'current-dsv')
    await fs.writeFile(path.join(fixture.game.saveDirectory, 'World.server'), 'current-server')
    const processId = 4242
    let running = true
    let startAttempts = 0
    const adapter = new WindowsGameAdapter(fixture, {
      lifecycleTimeoutMs: 1_000,
      pollIntervalMs: 5,
      inspect: async () => ({
        process: running ? { pid: processId, startedAt: new Date().toISOString(), workingSetBytes: 1024, totalProcessorSeconds: 0, targetUps: 60, selectedSave: 'World' } : null,
        versions: { game: null, nebula: null, bepinex: null },
        tasks: { start: true, startManaged: true, configuredTargetUps: null }
      }),
      runScript: async <T>() => {
        startAttempts++
        if (startAttempts === 1) throw new Error('fixture changed-config start failure')
        running = true
        return {} as T
      }
    })
    const initial = (await adapter.modConfigs())[0]!
    const secret = await prepareBridge(fixture, processId)
    const workers = Promise.all([
      bridgeSaveWorker(fixture, secret, 'World'),
      bridgeStopWorker(fixture, secret, () => { running = false })
    ])

    await expect(adapter.run('write-mod-config', {
      configId: initial.id,
      content: initial.content.replace('Value = original', 'Value = changed'),
      expectedRevision: initial.revision
    }, () => undefined, new AbortController().signal)).rejects.toMatchObject({ code: 'MOD_CONFIG_START_FAILED' })
    await workers

    expect(startAttempts).toBe(2)
    expect(running).toBe(true)
    expect(await fs.readFile(configPath, 'utf8')).toBe('[General]\nValue = original\n[Auth]\nPassword = private\n')
  })

  it('normalizes process CPU across logical processors', async () => {
    const fixture = await config('windows')
    await fs.mkdir(fixture.game.root, { recursive: true })
    let sampledAt = 100_000
    let processorSeconds = 20
    const adapter = new WindowsGameAdapter(fixture, {
      logicalProcessorCount: 4,
      clock: () => sampledAt,
      inspect: async () => ({
        process: { pid: 4242, startedAt: new Date(90_000).toISOString(), workingSetBytes: 1024, totalProcessorSeconds: processorSeconds, targetUps: 60, selectedSave: null },
        versions: { game: null, nebula: null, bepinex: null },
        tasks: { start: true, startManaged: true, configuredTargetUps: null }
      })
    })
    expect((await adapter.overview()).metrics.cpuPercent).toBeNull()
    sampledAt += 2_500
    processorSeconds += 5
    expect((await adapter.overview()).metrics.cpuPercent).toBe(50)
  })

  it('refuses to disable a package required by another enabled package', async () => {
    const fixture = await config('windows')
    const plugins = path.join(fixture.game.root, 'BepInEx', 'plugins')
    await fs.mkdir(path.join(plugins, 'libs-Shared-1.0.0'), { recursive: true })
    await fs.mkdir(path.join(plugins, 'mods-Feature-1.0.0'), { recursive: true })
    await fs.writeFile(path.join(plugins, 'libs-Shared-1.0.0', 'manifest.json'), JSON.stringify({
      name: 'Shared', version_number: '1.0.0', dependencies: []
    }))
    await fs.writeFile(path.join(plugins, 'mods-Feature-1.0.0', 'manifest.json'), JSON.stringify({
      name: 'Feature', version_number: '1.0.0', dependencies: ['libs-Shared-1.0.0']
    }))
    const adapter = new WindowsGameAdapter(fixture, { inspect: async () => ({
      process: null,
      versions: { game: null, nebula: null, bepinex: null },
      tasks: { start: true, startManaged: true, configuredTargetUps: null }
    }) })
    const dependency = (await adapter.mods()).find((mod) => mod.name === 'libs-Shared')!
    await expect(adapter.run('toggle-mod', { modId: dependency.id, enabled: false }, () => undefined, new AbortController().signal))
      .rejects.toMatchObject({ code: 'MOD_DEPENDENCY_ACTIVE' })
  })

  it('saves, backs up and stops before toggling a complete mod package, then restarts', async () => {
    const fixture = await config('windows')
    const packageName = 'owner-Feature-1.0.0'
    const plugin = path.join(fixture.game.root, 'BepInEx', 'plugins', packageName)
    const patcher = path.join(fixture.game.root, 'BepInEx', 'patchers', packageName)
    await Promise.all([
      fs.mkdir(plugin, { recursive: true }), fs.mkdir(patcher, { recursive: true }),
      fs.writeFile(path.join(fixture.game.saveDirectory, 'World.dsv'), 'current-dsv'),
      fs.writeFile(path.join(fixture.game.saveDirectory, 'World.server'), 'current-server')
    ])
    await Promise.all([
      fs.writeFile(path.join(plugin, 'manifest.json'), JSON.stringify({ author_name: 'owner', name: 'Feature', version_number: '1.0.0', dependencies: [] })),
      fs.writeFile(path.join(plugin, 'plugin.dll'), 'plugin'), fs.writeFile(path.join(patcher, 'patcher.dll'), 'patcher')
    ])
    const processId = 4242
    let running = true
    const adapter = new WindowsGameAdapter(fixture, {
      lifecycleTimeoutMs: 1_000,
      pollIntervalMs: 5,
      inspect: async () => ({
        process: running ? { pid: processId, startedAt: new Date().toISOString(), workingSetBytes: 1024, totalProcessorSeconds: 0, targetUps: 60, selectedSave: 'World' } : null,
        versions: { game: null, nebula: null, bepinex: null },
        tasks: { start: true, startManaged: true, configuredTargetUps: null }
      }),
      runScript: async <T>() => { running = true; return {} as T }
    })
    const mod = (await adapter.mods()).find(item => item.name === 'owner-Feature')!
    const secret = await prepareBridge(fixture, processId)
    const workers = Promise.all([
      bridgeSaveWorker(fixture, secret, 'World'),
      bridgeStopWorker(fixture, secret, () => { running = false })
    ])

    await expect(adapter.run('toggle-mod', { modId: mod.id, enabled: false }, () => undefined, new AbortController().signal))
      .resolves.toMatchObject({ modId: mod.id, enabled: false, wasRunning: true, restarted: true, automaticBackupId: expect.any(String) })
    await workers
    expect(running).toBe(true)
    await expect(fs.lstat(plugin)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.readFile(path.join(fixture.game.root, 'BepInEx', 'disabled-plugins', packageName, 'plugin.dll'), 'utf8')).resolves.toBe('plugin')
    await expect(fs.lstat(patcher)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.readFile(path.join(fixture.game.root, 'BepInEx', 'disabled-patchers', packageName, 'patcher.dll'), 'utf8')).resolves.toBe('patcher')
  })

  it('reverses a complete mod toggle and restores the running state when the first restart fails', async () => {
    const fixture = await config('windows')
    const packageName = 'owner-Feature-1.0.0'
    const plugin = path.join(fixture.game.root, 'BepInEx', 'plugins', packageName)
    const patcher = path.join(fixture.game.root, 'BepInEx', 'patchers', packageName)
    await Promise.all([
      fs.mkdir(plugin, { recursive: true }), fs.mkdir(patcher, { recursive: true }),
      fs.writeFile(path.join(fixture.game.saveDirectory, 'World.dsv'), 'current-dsv'),
      fs.writeFile(path.join(fixture.game.saveDirectory, 'World.server'), 'current-server')
    ])
    await Promise.all([
      fs.writeFile(path.join(plugin, 'manifest.json'), JSON.stringify({ author_name: 'owner', name: 'Feature', version_number: '1.0.0', dependencies: [] })),
      fs.writeFile(path.join(plugin, 'plugin.dll'), 'plugin'), fs.writeFile(path.join(patcher, 'patcher.dll'), 'patcher')
    ])
    const processId = 4242
    let running = true
    let startAttempts = 0
    const adapter = new WindowsGameAdapter(fixture, {
      lifecycleTimeoutMs: 1_000,
      pollIntervalMs: 5,
      inspect: async () => ({
        process: running ? { pid: processId, startedAt: new Date().toISOString(), workingSetBytes: 1024, totalProcessorSeconds: 0, targetUps: 60, selectedSave: 'World' } : null,
        versions: { game: null, nebula: null, bepinex: null },
        tasks: { start: true, startManaged: true, configuredTargetUps: null }
      }),
      runScript: async <T>() => {
        startAttempts++
        if (startAttempts === 1) throw new Error('fixture first start failed')
        running = true
        return {} as T
      }
    })
    const mod = (await adapter.mods()).find(item => item.name === 'owner-Feature')!
    const secret = await prepareBridge(fixture, processId)
    const workers = Promise.all([
      bridgeSaveWorker(fixture, secret, 'World'),
      bridgeStopWorker(fixture, secret, () => { running = false })
    ])

    await expect(adapter.run('toggle-mod', { modId: mod.id, enabled: false }, () => undefined, new AbortController().signal))
      .rejects.toMatchObject({ code: 'UPDATE_START_ROLLED_BACK' })
    await workers
    expect(startAttempts).toBe(2)
    expect(running).toBe(true)
    await expect(fs.readFile(path.join(plugin, 'plugin.dll'), 'utf8')).resolves.toBe('plugin')
    await expect(fs.readFile(path.join(patcher, 'patcher.dll'), 'utf8')).resolves.toBe('patcher')
    await expect(fs.lstat(path.join(fixture.game.root, 'BepInEx', 'disabled-plugins', packageName))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.lstat(path.join(fixture.game.root, 'BepInEx', 'disabled-patchers', packageName))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects enabling a mod with unavailable dependencies before stopping the running server', async () => {
    const fixture = await config('windows')
    const packageName = 'owner-Feature-1.0.0'
    const plugin = path.join(fixture.game.root, 'BepInEx', 'disabled-plugins', packageName)
    await fs.mkdir(plugin, { recursive: true })
    await fs.writeFile(path.join(plugin, 'manifest.json'), JSON.stringify({
      author_name: 'owner', name: 'Feature', version_number: '1.0.0', dependencies: ['owner-Missing-1.0.0']
    }))
    let running = true
    const adapter = new WindowsGameAdapter(fixture, { inspect: async () => ({
      process: running ? { pid: 4242, startedAt: new Date().toISOString(), workingSetBytes: 1024, totalProcessorSeconds: 0, targetUps: 60, selectedSave: 'World' } : null,
      versions: { game: null, nebula: null, bepinex: null },
      tasks: { start: true, startManaged: true, configuredTargetUps: null }
    }) })
    const mod = (await adapter.mods()).find(item => item.name === 'owner-Feature')!

    await expect(adapter.run('toggle-mod', { modId: mod.id, enabled: true }, () => undefined, new AbortController().signal))
      .rejects.toMatchObject({ code: 'MOD_DEPENDENCY_MISSING' })
    expect(running).toBe(true)
    await expect(fs.readdir(path.join(fixture.game.bridgeDirectory, 'requests'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.readFile(path.join(plugin, 'manifest.json'), 'utf8')).resolves.toContain('owner-Missing-1.0.0')
  })

  it('reports manifestless plugin directories as protected and only classifies the exact Bridge DLL as server-only', async () => {
    const fixture = await config('windows')
    const plugins = path.join(fixture.game.root, 'BepInEx', 'plugins')
    const bridge = path.join(plugins, 'dyson-control-bridge')
    const unrelated = path.join(plugins, 'network-bridge-helper')
    await Promise.all([fs.mkdir(bridge, { recursive: true }), fs.mkdir(unrelated, { recursive: true })])
    await fs.writeFile(path.join(bridge, 'DysonControlBridge.dll'), 'bridge')
    await fs.writeFile(path.join(unrelated, 'NetworkBridge.dll'), 'unrelated')
    const adapter = new WindowsGameAdapter(fixture, { inspect: async () => ({
      process: null,
      versions: { game: null, nebula: null, bepinex: null },
      tasks: { start: true, startManaged: true, configuredTargetUps: null }
    }) })

    const mods = await adapter.mods()
    const exact = mods.find(mod => mod.name === 'DysonControlBridge')!
    const other = mods.find(mod => mod.name === 'network-bridge-helper')!
    expect(exact).toMatchObject({ version: 'unknown', enabled: true, required: true, side: 'server', sideSource: 'builtin' })
    expect(other).toMatchObject({ version: 'unknown', enabled: true, required: true, side: 'unknown', sideSource: 'unverified' })
    await expect(adapter.run('toggle-mod', { modId: exact.id, enabled: false }, () => undefined, new AbortController().signal))
      .rejects.toMatchObject({ code: 'REQUIRED_MOD' })
    await expect(adapter.run('remove-mod', { modId: exact.id, expectedVersion: exact.version }, () => undefined, new AbortController().signal))
      .rejects.toMatchObject({ code: 'REQUIRED_MOD' })
  })

  it('removes and restores a self-contained mod with its patcher while preserving config', async () => {
    const fixture = await config('windows')
    const packageName = 'owner-Example-1.2.3'
    const plugin = path.join(fixture.game.root, 'BepInEx', 'plugins', packageName)
    const patcher = path.join(fixture.game.root, 'BepInEx', 'patchers', packageName)
    const configPath = path.join(fixture.game.root, 'BepInEx', 'config', 'owner.Example.cfg')
    await Promise.all([
      fs.mkdir(plugin, { recursive: true }), fs.mkdir(patcher, { recursive: true }), fs.mkdir(path.dirname(configPath), { recursive: true })
    ])
    await Promise.all([
      fs.writeFile(path.join(plugin, 'manifest.json'), JSON.stringify({ author_name: 'owner', name: 'Example', version_number: '1.2.3', dependencies: [] })),
      fs.writeFile(path.join(plugin, 'plugin.dll'), 'plugin'), fs.writeFile(path.join(patcher, 'patcher.dll'), 'patcher'),
      fs.writeFile(configPath, 'Password = private\n')
    ])
    const adapter = new WindowsGameAdapter(fixture, { inspect: async () => ({
      process: null,
      versions: { game: null, nebula: null, bepinex: null },
      tasks: { start: true, startManaged: true, configuredTargetUps: null }
    }) })
    const mod = (await adapter.mods()).find(item => item.name === 'owner-Example')!

    const removed = await adapter.run('remove-mod', { modId: mod.id, expectedVersion: mod.version }, () => undefined, new AbortController().signal)
    expect(removed).toMatchObject({ modId: mod.id, version: '1.2.3', wasRunning: false, restarted: false, automaticBackupId: null })
    await expect(fs.lstat(plugin)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.lstat(patcher)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.readFile(configPath, 'utf8')).resolves.toContain('private')
    expect(await adapter.modRemovalHistory()).toEqual([expect.objectContaining({ id: removed.historyId, canRestore: true })])

    const restored = await adapter.run('restore-removed-mod', { historyId: removed.historyId }, () => undefined, new AbortController().signal)
    expect(restored).toMatchObject({ historyId: removed.historyId, wasRunning: false, restarted: false })
    await expect(fs.readFile(path.join(plugin, 'plugin.dll'), 'utf8')).resolves.toBe('plugin')
    await expect(fs.readFile(path.join(patcher, 'patcher.dll'), 'utf8')).resolves.toBe('patcher')
    expect((await adapter.modRemovalHistory())[0]).toMatchObject({ canRestore: false })
  })

  it('blocks mod removal when the version is stale or an enabled package depends on it', async () => {
    const fixture = await config('windows')
    const plugins = path.join(fixture.game.root, 'BepInEx', 'plugins')
    await fs.mkdir(path.join(plugins, 'libs-Shared-1.0.0'), { recursive: true })
    await fs.mkdir(path.join(plugins, 'mods-Feature-1.0.0'), { recursive: true })
    await fs.writeFile(path.join(plugins, 'libs-Shared-1.0.0', 'manifest.json'), JSON.stringify({
      author_name: 'libs', name: 'Shared', version_number: '1.0.0', dependencies: []
    }))
    await fs.writeFile(path.join(plugins, 'mods-Feature-1.0.0', 'manifest.json'), JSON.stringify({
      author_name: 'mods', name: 'Feature', version_number: '1.0.0', dependencies: ['libs-Shared-1.0.0']
    }))
    const adapter = new WindowsGameAdapter(fixture, { inspect: async () => ({
      process: null,
      versions: { game: null, nebula: null, bepinex: null },
      tasks: { start: true, startManaged: true, configuredTargetUps: null }
    }) })
    const dependency = (await adapter.mods()).find(mod => mod.name === 'libs-Shared')!

    await expect(adapter.run('remove-mod', { modId: dependency.id, expectedVersion: '0.9.0' }, () => undefined, new AbortController().signal))
      .rejects.toMatchObject({ code: 'MOD_VERSION_CHANGED' })
    await expect(adapter.run('remove-mod', { modId: dependency.id, expectedVersion: dependency.version }, () => undefined, new AbortController().signal))
      .rejects.toMatchObject({ code: 'MOD_DEPENDENCY_ACTIVE' })
    await expect(fs.readFile(path.join(plugins, 'libs-Shared-1.0.0', 'manifest.json'), 'utf8')).resolves.toContain('Shared')
  })

  it('saves, backs up and stops before mod removal, then restores files if restart fails', async () => {
    const fixture = await config('windows')
    const plugin = path.join(fixture.game.root, 'BepInEx', 'plugins', 'owner-Example-1.2.3')
    await fs.mkdir(plugin, { recursive: true })
    await fs.writeFile(path.join(plugin, 'manifest.json'), JSON.stringify({ author_name: 'owner', name: 'Example', version_number: '1.2.3', dependencies: [] }))
    await fs.writeFile(path.join(plugin, 'plugin.dll'), 'plugin')
    await fs.writeFile(path.join(fixture.game.saveDirectory, 'World.dsv'), 'current-dsv')
    await fs.writeFile(path.join(fixture.game.saveDirectory, 'World.server'), 'current-server')
    const processId = 4242
    let running = true
    let startAttempts = 0
    const adapter = new WindowsGameAdapter(fixture, {
      lifecycleTimeoutMs: 1_000,
      pollIntervalMs: 5,
      inspect: async () => ({
        process: running ? { pid: processId, startedAt: new Date().toISOString(), workingSetBytes: 1024, totalProcessorSeconds: 0, targetUps: 60, selectedSave: 'World' } : null,
        versions: { game: null, nebula: null, bepinex: null },
        tasks: { start: true, startManaged: true, configuredTargetUps: null }
      }),
      runScript: async <T>() => {
        startAttempts++
        if (startAttempts === 1) throw new Error('fixture changed-mod start failure')
        running = true
        return {} as T
      }
    })
    const mod = (await adapter.mods()).find(item => item.name === 'owner-Example')!
    const secret = await prepareBridge(fixture, processId)
    const workers = Promise.all([
      bridgeSaveWorker(fixture, secret, 'World'),
      bridgeStopWorker(fixture, secret, () => { running = false })
    ])

    await expect(adapter.run('remove-mod', { modId: mod.id, expectedVersion: mod.version }, () => undefined, new AbortController().signal))
      .rejects.toMatchObject({ code: 'MOD_REMOVAL_START_FAILED' })
    await workers

    expect(startAttempts).toBe(2)
    expect(running).toBe(true)
    await expect(fs.readFile(path.join(plugin, 'plugin.dll'), 'utf8')).resolves.toBe('plugin')
    expect((await adapter.modRemovalHistory())[0]).toMatchObject({ canRestore: false })
    expect((await adapter.backups()).some(backup => backup.reason === 'automatic-before-mod-removal')).toBe(true)
  })

  it('exports exact package versions from BOM-prefixed installed manifests', async () => {
    const fixture = await config('windows')
    const nebula = path.join(fixture.game.root, 'BepInEx', 'plugins', 'nebula-NebulaMultiplayerMod')
    await fs.mkdir(nebula, { recursive: true })
    await fs.writeFile(path.join(nebula, 'manifest.json'), '\uFEFF' + JSON.stringify({
      author_name: 'nebula', name: 'NebulaMultiplayerMod', version_number: '0.9.24', dependencies: ['xiaoye97-BepInEx-5.4.17']
    }))
    const adapter = new WindowsGameAdapter(fixture, {
      inspect: async () => ({
        process: null,
        versions: { game: null, nebula: '0.9.24', bepinex: '5.4.21.0' },
        tasks: { start: true, startManaged: true, configuredTargetUps: null }
      }),
      updates: updateFixture({ installedPackageVersion: async (packageName) => packageName === 'xiaoye97-BepInEx' ? '5.4.17' : null })
    })
    const result = await adapter.run('create-client-package', {}, () => undefined, new AbortController().signal)
    const download = await adapter.download('client', String(result.packageId))
    const extracted = path.join(path.dirname(fixture.dataDirectory), 'client-extracted')
    await extractZipBuffer(await fs.readFile(download.path), extracted)
    const profile = JSON.parse(await fs.readFile(path.join(extracted, 'export.r2x'), 'utf8')) as { mods: Array<{ name: string; version: { major: number; minor: number; patch: number } }> }
    expect(profile.mods).toContainEqual({ name: 'xiaoye97-BepInEx', version: { major: 5, minor: 4, patch: 17 }, enabled: true })
    expect(profile.mods).not.toContainEqual(expect.objectContaining({ name: 'xiaoye97-BepInEx', version: { major: 5, minor: 4, patch: 21 } }))
  })

  it('exports only administrator-confirmed mod sides and requires confirmation again after an upgrade', async () => {
    const fixture = await config('windows')
    const plugin = path.join(fixture.game.root, 'BepInEx', 'plugins', 'owner-Feature-1.0.0')
    await fs.mkdir(plugin, { recursive: true })
    const writeManifest = (version: string) => fs.writeFile(path.join(plugin, 'manifest.json'), JSON.stringify({
      author_name: 'owner', name: 'Feature', version_number: version, dependencies: []
    }))
    await writeManifest('1.0.0')
    const adapter = new WindowsGameAdapter(fixture, {
      inspect: async () => ({
        process: null,
        versions: { game: null, nebula: null, bepinex: null },
        tasks: { start: true, startManaged: true, configuredTargetUps: null }
      }),
      updates: updateFixture({ installedPackageVersion: async packageName => packageName === 'xiaoye97-BepInEx' ? '5.4.17' : null })
    })
    const initial = (await adapter.mods()).find(mod => mod.name === 'owner-Feature')!
    expect(initial).toMatchObject({ version: '1.0.0', side: 'unknown', sideSource: 'unverified' })
    await expect(adapter.run('create-client-package', {}, () => undefined, new AbortController().signal))
      .rejects.toMatchObject({ code: 'MOD_SIDE_UNCONFIRMED' })

    await expect(adapter.run('set-mod-side', {
      modId: initial.id, expectedVersion: initial.version, side: 'client'
    }, () => undefined, new AbortController().signal)).resolves.toEqual({ modId: initial.id, version: '1.0.0', side: 'client' })
    expect((await adapter.mods()).find(mod => mod.id === initial.id)).toMatchObject({ side: 'client', sideSource: 'administrator' })
    const exported = await adapter.run('create-client-package', {}, () => undefined, new AbortController().signal)
    const extracted = path.join(path.dirname(fixture.dataDirectory), 'side-client-extracted')
    await extractZipBuffer(await fs.readFile((await adapter.download('client', String(exported.packageId))).path), extracted)
    const profile = JSON.parse(await fs.readFile(path.join(extracted, 'export.r2x'), 'utf8')) as { mods: Array<{ name: string }> }
    expect(profile.mods).toContainEqual(expect.objectContaining({ name: 'owner-Feature' }))

    await writeManifest('1.1.0')
    const upgraded = (await adapter.mods()).find(mod => mod.id === initial.id)!
    expect(upgraded).toMatchObject({ version: '1.1.0', side: 'unknown', sideSource: 'unverified' })
    await expect(adapter.run('set-mod-side', {
      modId: initial.id, expectedVersion: '1.0.0', side: 'both'
    }, () => undefined, new AbortController().signal)).rejects.toMatchObject({ code: 'MOD_CHANGED' })
    await expect(adapter.run('create-client-package', {}, () => undefined, new AbortController().signal))
      .rejects.toMatchObject({ code: 'MOD_SIDE_UNCONFIRMED' })
  })

  it('stops before protecting and restoring a running save, then restarts the selected save', async () => {
    const fixture = await config('windows')
    await fs.mkdir(fixture.game.root, { recursive: true })
    await fs.writeFile(path.join(fixture.game.saveDirectory, 'World.dsv'), 'original-dsv')
    await fs.writeFile(path.join(fixture.game.saveDirectory, 'World.server'), 'original-server')
    let running = false
    const processId = 4242
    const adapter = new WindowsGameAdapter(fixture, {
      inspect: async () => ({
        process: running ? { pid: processId, startedAt: new Date(Date.now() - 5_000).toISOString(), workingSetBytes: 1024, totalProcessorSeconds: 1, targetUps: 60, selectedSave: 'World' } : null,
        versions: { game: null, nebula: null, bepinex: null },
        tasks: { start: true, startManaged: true, configuredTargetUps: null }
      }),
      runScript: async <T>(_name: string, input: unknown) => {
        const taskName = String((input as { taskName?: unknown }).taskName)
        if (taskName === fixture.game.startTaskName) running = true
        return { taskName } as T
      }
    })
    const save = (await adapter.saves())[0]!
    const backup = await adapter.run('backup', { saveId: save.id }, () => undefined, new AbortController().signal)
    await fs.writeFile(path.join(fixture.game.saveDirectory, 'World.dsv'), 'changed-dsv')
    await fs.writeFile(path.join(fixture.game.saveDirectory, 'World.server'), 'changed-server')
    running = true
    const secret = await prepareBridge(fixture, processId)
    const workers = Promise.all([
      bridgeSaveWorker(fixture, secret, 'World'),
      bridgeStopWorker(fixture, secret, () => { running = false })
    ])
    const reports: string[] = []
    const restored = await adapter.run('restore', { backupId: backup.backupId }, (message) => reports.push(message), new AbortController().signal)
    await workers
    expect(restored).toMatchObject({ saveName: 'World', startupSelectionApplied: true, restarted: true })
    expect(running).toBe(true)
    expect(reports.indexOf('正在停止服务器')).toBeLessThan(reports.indexOf('正在完整备份存档 World'))
    expect(await fs.readFile(path.join(fixture.game.saveDirectory, 'World.dsv'), 'utf8')).toBe('original-dsv')
    expect(JSON.parse(await fs.readFile(path.join(fixture.dataDirectory, 'game-startup', 'settings.json'), 'utf8'))).toEqual({ schema: 1, targetUps: 60, saveName: 'World' })
  })

  it('waits for a signed Bridge heartbeat from the exact process started by the task', async () => {
    const fixture = await config('windows')
    await fs.mkdir(fixture.game.root, { recursive: true })
    let running = false
    const processId = 4242
    const adapter = new WindowsGameAdapter(fixture, {
      lifecycleTimeoutMs: 500,
      pollIntervalMs: 10,
      inspect: async () => ({
        process: running ? { pid: processId, startedAt: new Date().toISOString(), workingSetBytes: 1024, totalProcessorSeconds: 0, targetUps: 60, selectedSave: 'World' } : null,
        versions: { game: null, nebula: null, bepinex: null },
        tasks: { start: true, startManaged: true, configuredTargetUps: null }
      }),
      runScript: async <T>() => { running = true; return {} as T }
    })
    await prepareBridge(fixture, processId + 1)
    const publishReady = new Promise<void>((resolve, reject) => {
      setTimeout(() => { prepareBridge(fixture, processId).then(() => resolve(), reject) }, 30)
    })
    await expect(adapter.run('start', {}, () => undefined, new AbortController().signal))
      .resolves.toMatchObject({ state: 'running', pid: processId, bridgeReady: true })
    await publishReady
  })

  it('recovers interrupted package work before invoking the managed start task', async () => {
    const fixture = await config('windows')
    await fs.mkdir(fixture.game.root, { recursive: true })
    const processId = 4242
    let running = false
    const order: string[] = []
    const adapter = new WindowsGameAdapter(fixture, {
      lifecycleTimeoutMs: 500,
      pollIntervalMs: 5,
      inspect: async () => ({
        process: running ? { pid: processId, startedAt: new Date().toISOString(), workingSetBytes: 1024, totalProcessorSeconds: 0, targetUps: 60, selectedSave: 'World' } : null,
        versions: { game: null, nebula: null, bepinex: null },
        tasks: { start: true, startManaged: true, configuredTargetUps: null }
      }),
      updates: updateFixture({ recoverInterrupted: async () => { order.push('recover') } }),
      runScript: async <T>() => { order.push('start-task'); running = true; return {} as T }
    })
    await prepareBridge(fixture, processId)

    await expect(adapter.run('start', {}, () => undefined, new AbortController().signal))
      .resolves.toMatchObject({ state: 'running', pid: processId })
    expect(order).toEqual(['recover', 'start-task'])
  })

  it('allows save loading to exceed the stop deadline while still waiting for the exact signed process', async () => {
    const fixture = await config('windows')
    await fs.mkdir(fixture.game.root, { recursive: true })
    const processId = 4242
    let running = false
    const reports: string[] = []
    const adapter = new WindowsGameAdapter(fixture, {
      lifecycleTimeoutMs: 20,
      startupTimeoutMs: 1_000,
      pollIntervalMs: 5,
      inspect: async () => ({
        process: running ? { pid: processId, startedAt: new Date().toISOString(), workingSetBytes: 1024, totalProcessorSeconds: 0, targetUps: 60, selectedSave: 'World' } : null,
        versions: { game: null, nebula: null, bepinex: null },
        tasks: { start: true, startManaged: true, configuredTargetUps: null }
      }),
      runScript: async <T>() => { running = true; return {} as T }
    })
    await prepareBridge(fixture, processId + 1)
    const publishReady = new Promise<void>((resolve, reject) => {
      setTimeout(() => { prepareBridge(fixture, processId).then(() => resolve(), reject) }, 100)
    })
    await expect(adapter.run('start', {}, message => reports.push(message), new AbortController().signal))
      .resolves.toMatchObject({ pid: processId, bridgeReady: true })
    await publishReady
    expect(reports).toContain('游戏进程已启动，正在等待存档加载和 Bridge 就绪')
  })

  it('does not invoke the managed start task when interrupted package recovery fails', async () => {
    const fixture = await config('windows')
    await fs.mkdir(fixture.game.root, { recursive: true })
    let startCalls = 0
    const adapter = new WindowsGameAdapter(fixture, {
      inspect: async () => ({
        process: null,
        versions: { game: null, nebula: null, bepinex: null },
        tasks: { start: true, startManaged: true, configuredTargetUps: null }
      }),
      updates: updateFixture({
        recoverInterrupted: async () => { throw new GameAdapterError('UPDATE_RECOVERY_FAILED', 'fixture recovery failed') }
      }),
      runScript: async <T>() => { startCalls++; return {} as T }
    })

    await expect(adapter.run('start', {}, () => undefined, new AbortController().signal))
      .rejects.toMatchObject({ code: 'UPDATE_RECOVERY_FAILED' })
    expect(startCalls).toBe(0)
  })

  it('reports a Bridge-specific timeout when a started process never publishes its own ready heartbeat', async () => {
    const fixture = await config('windows')
    await fs.mkdir(fixture.game.root, { recursive: true })
    let running = false
    const processId = 4242
    const adapter = new WindowsGameAdapter(fixture, {
      lifecycleTimeoutMs: 40,
      pollIntervalMs: 5,
      inspect: async () => ({
        process: running ? { pid: processId, startedAt: new Date().toISOString(), workingSetBytes: 1024, totalProcessorSeconds: 0, targetUps: 60, selectedSave: 'World' } : null,
        versions: { game: null, nebula: null, bepinex: null },
        tasks: { start: true, startManaged: true, configuredTargetUps: null }
      }),
      runScript: async <T>() => { running = true; return {} as T }
    })
    await prepareBridge(fixture, processId + 1)
    await expect(adapter.run('start', {}, () => undefined, new AbortController().signal))
      .rejects.toMatchObject({ code: 'GAME_START_BRIDGE_TIMEOUT' })
  })

  it('stops through a signed Bridge receipt and waits for the exact process to exit', async () => {
    const fixture = await config('windows')
    await fs.mkdir(fixture.game.root, { recursive: true })
    await fs.writeFile(path.join(fixture.game.saveDirectory, 'World.dsv'), 'current-dsv')
    await fs.writeFile(path.join(fixture.game.saveDirectory, 'World.server'), 'current-server')
    const processId = 4242
    let running = true
    let exited = false
    const invokedScripts: string[] = []
    const adapter = new WindowsGameAdapter(fixture, {
      lifecycleTimeoutMs: 500,
      pollIntervalMs: 5,
      inspect: async () => ({
        process: running ? { pid: processId, startedAt: new Date().toISOString(), workingSetBytes: 1024, totalProcessorSeconds: 0, targetUps: 60, selectedSave: 'World' } : null,
        versions: { game: null, nebula: null, bepinex: null },
        tasks: { start: true, startManaged: true, configuredTargetUps: null }
      }),
      runScript: async <T>(name: string) => { invokedScripts.push(name); return {} as T }
    })
    const secret = await prepareBridge(fixture, processId)
    const workers = Promise.all([
      bridgeSaveWorker(fixture, secret, 'World'),
      bridgeStopWorker(fixture, secret, () => { exited = true; running = false })
    ])

    await expect(adapter.run('stop', {}, () => undefined, new AbortController().signal))
      .resolves.toMatchObject({ state: 'stopped', signedReceipt: true, requestId: expect.any(String) })
    await workers
    expect(exited).toBe(true)
    expect(invokedScripts).toEqual([])
  })

  it.each([
    { title: 'Nebula', action: 'install-update' as const, input: { component: 'nebula', version: '2.0.0' }, packageName: 'nebula-NebulaMultiplayerMod' },
    { title: 'BepInEx', action: 'install-update' as const, input: { component: 'bepinex', version: '2.0.0' }, packageName: 'xiaoye97-BepInEx' },
    { title: 'a mod', action: 'install-mod' as const, input: { package: 'mods-Feature', version: '2.0.0' }, packageName: 'mods-Feature' }
  ])('checks the complete resolved $title plan against version locks before stopping', async ({ action, input, packageName }) => {
    const fixture = await config('windows')
    await Promise.all([fs.mkdir(fixture.game.root, { recursive: true }), fs.mkdir(path.join(fixture.dataDirectory, 'game-startup'), { recursive: true })])
    const lockedAt = '2026-10-17T00:00:00.000Z'
    await fs.writeFile(path.join(fixture.dataDirectory, 'version-locks.json'), `${JSON.stringify({
      schema: 1, updatedAt: lockedAt, locks: [{ package: 'libs-shared', version: '1.0.0', lockedAt }]
    })}\n`)
    let running = true
    let resolvedWhileRunning = false
    let operationCalled = false
    const adapter = new WindowsGameAdapter(fixture, {
      inspect: async () => ({
        process: running ? { pid: 4242, startedAt: new Date().toISOString(), workingSetBytes: 1024, totalProcessorSeconds: 0, targetUps: 60, selectedSave: 'World' } : null,
        versions: { game: null, nebula: '1.0.0', bepinex: '1.0.0' },
        tasks: { start: true, startManaged: true, configuredTargetUps: null }
      }),
      updates: updateFixture({
        resolvePackagePlan: async (requestedPackage, version) => {
          resolvedWhileRunning = running
          expect(requestedPackage).toBe(packageName)
          return [resolvedPackage('libs-Shared', '2.0.0'), resolvedPackage(requestedPackage, version!)]
        },
        installComponent: async () => { operationCalled = true; throw new Error('installation must not run') },
        installPackage: async () => { operationCalled = true; throw new Error('installation must not run') }
      })
    })

    await expect(adapter.run(action, input, () => undefined, new AbortController().signal))
      .rejects.toMatchObject({ code: 'VERSION_LOCK_CONFLICT' })
    expect(resolvedWhileRunning).toBe(true)
    expect(operationCalled).toBe(false)
    expect(running).toBe(true)
    expect((await adapter.backups()).filter(item => item.reason.startsWith('automatic-before-'))).toEqual([])
  })

  it('checks an explicit Steam target lock before stopping even with an update test override', async () => {
    const fixture = await config('windows')
    await Promise.all([fs.mkdir(fixture.game.root, { recursive: true }), fs.mkdir(path.join(fixture.dataDirectory, 'game-startup'), { recursive: true })])
    const lockedAt = '2026-10-17T00:00:00.000Z'
    await fs.writeFile(path.join(fixture.dataDirectory, 'version-locks.json'), `${JSON.stringify({
      schema: 1, updatedAt: lockedAt, locks: [{ package: 'steam:1366540', version: '100', lockedAt }]
    })}\n`)
    let inspectCalls = 0
    let operationCalled = false
    const adapter = new WindowsGameAdapter(fixture, {
      inspect: async () => {
        inspectCalls++
        return {
          process: { pid: 4242, startedAt: new Date().toISOString(), workingSetBytes: 1024, totalProcessorSeconds: 0, targetUps: 60, selectedSave: 'World' },
          versions: { game: '100', nebula: null, bepinex: null }, tasks: { start: true, startManaged: true, configuredTargetUps: null }
        }
      },
      updates: updateFixture({ installComponent: async () => { operationCalled = true; return {} } })
    })
    await expect(adapter.run('install-update', { component: 'game', version: '200' }, () => undefined, new AbortController().signal))
      .rejects.toMatchObject({ code: 'VERSION_LOCK_CONFLICT' })
    expect(inspectCalls).toBe(0)
    expect(operationCalled).toBe(false)
  })

  it('rejects a game update without a configured backend before stopping the running server', async () => {
    const fixture = await config('windows')
    await fs.mkdir(fixture.game.root, { recursive: true })
    let inspectCalls = 0
    const adapter = new WindowsGameAdapter(fixture, {
      inspect: async () => {
        inspectCalls++
        return {
          process: { pid: 4242, startedAt: new Date().toISOString(), workingSetBytes: 1024, totalProcessorSeconds: 0, targetUps: 60, selectedSave: 'World' },
          versions: { game: '100', nebula: null, bepinex: null }, tasks: { start: true, startManaged: true, configuredTargetUps: null }
        }
      }
    })
    await expect(adapter.run('install-update', { component: 'game' }, () => undefined, new AbortController().signal))
      .rejects.toMatchObject({ code: 'UPDATE_BACKEND_REQUIRED' })
    expect(inspectCalls).toBe(0)
    expect((await adapter.backups()).filter(item => item.reason === 'automatic-before-update')).toEqual([])
  })

  it('saves, backs up, stops, installs and restarts an update for a running server', async () => {
    const fixture = await config('windows')
    await fs.mkdir(fixture.game.root, { recursive: true })
    await fs.writeFile(path.join(fixture.game.saveDirectory, 'World.dsv'), 'current-dsv')
    await fs.writeFile(path.join(fixture.game.saveDirectory, 'World.server'), 'current-server')
    let running = true
    let installedWhileStopped = false
    const processId = 4242
    const adapter = new WindowsGameAdapter(fixture, {
      inspect: async () => ({
        process: running ? { pid: processId, startedAt: new Date(Date.now() - 5_000).toISOString(), workingSetBytes: 1024, totalProcessorSeconds: 1, targetUps: 60, selectedSave: 'World' } : null,
        versions: { game: '0.10.1', nebula: '0.9.23', bepinex: '5.4.21.0' },
        tasks: { start: true, startManaged: true, configuredTargetUps: null }
      }),
      runScript: async <T>(_name: string, input: unknown) => {
        const taskName = String((input as { taskName?: unknown }).taskName)
        if (taskName === fixture.game.startTaskName) running = true
        return { taskName } as T
      },
      updates: updateFixture({
        installComponent: async (component, version) => {
          installedWhileStopped = !running
          return { component, version: version ?? 'latest', restartRequired: true }
        }
      })
    })
    const secret = await prepareBridge(fixture, processId)
    const workers = Promise.all([
      bridgeSaveWorker(fixture, secret, 'World'),
      bridgeStopWorker(fixture, secret, () => { running = false })
    ])
    const result = await adapter.run('install-update', { component: 'nebula', version: '0.9.24' }, () => undefined, new AbortController().signal)
    await workers
    expect(installedWhileStopped).toBe(true)
    expect(running).toBe(true)
    expect(result).toMatchObject({ component: 'nebula', version: '0.9.24', wasRunning: true, restarted: true, restartRequired: false, automaticBackupId: expect.any(String) })
    expect((await adapter.backups()).filter((backup) => backup.reason === 'automatic-before-update')).toHaveLength(1)
  })

  it.each([
    {
      title: 'installs a mod', action: 'install-mod' as const,
      input: { package: 'soarqin-UXAssist', version: '1.3.10' }, reason: 'automatic-before-mod-install'
    },
    {
      title: 'rolls back an update', action: 'rollback-update' as const,
      input: { historyId: 'update-fixture' }, reason: 'automatic-before-update-rollback'
    }
  ])('$title only after saving, backing up and stopping, then restarts', async ({ action, input, reason }) => {
    const fixture = await config('windows')
    await fs.mkdir(fixture.game.root, { recursive: true })
    await fs.writeFile(path.join(fixture.game.saveDirectory, 'World.dsv'), 'current-dsv')
    await fs.writeFile(path.join(fixture.game.saveDirectory, 'World.server'), 'current-server')
    let running = true
    let operationRanWhileStopped = false
    const processId = 4242
    const adapter = new WindowsGameAdapter(fixture, {
      inspect: async () => ({
        process: running ? {
          pid: processId, startedAt: new Date(Date.now() - 5_000).toISOString(), workingSetBytes: 1024,
          totalProcessorSeconds: 1, targetUps: 60, selectedSave: 'World'
        } : null,
        versions: { game: null, nebula: '0.9.23', bepinex: '5.4.21.0' },
        tasks: { start: true, startManaged: true, configuredTargetUps: null }
      }),
      runScript: async <T>(_name: string, raw: unknown) => {
        const taskName = String((raw as { taskName?: unknown }).taskName)
        if (taskName === fixture.game.startTaskName) running = true
        return { taskName } as T
      },
      updates: updateFixture({
        installPackage: async (packageName, version, component) => {
          operationRanWhileStopped = !running
          expect({ packageName, version, component }).toEqual({
            packageName: 'soarqin-UXAssist', version: '1.3.10', component: 'mod'
          })
          return {
            component, package: packageName, version: version!, installed: [], backupId: 'mod-update',
            backupDirectory: 'fixture', restartRequired: true
          }
        },
        rollbackUpdate: async (historyId) => {
          operationRanWhileStopped = !running
          expect(historyId).toBe('update-fixture')
          return {
            historyId, rollbackBackupId: 'rollback-protection', restoredPackages: [],
            preservedConfigFiles: 0, restartRequired: true
          }
        }
      })
    })
    const secret = await prepareBridge(fixture, processId)
    const workers = Promise.all([
      bridgeSaveWorker(fixture, secret, 'World'),
      bridgeStopWorker(fixture, secret, () => { running = false })
    ])
    const result = await adapter.run(action, input, () => undefined, new AbortController().signal)
    await workers

    expect(operationRanWhileStopped).toBe(true)
    expect(running).toBe(true)
    expect(result).toMatchObject({ wasRunning: true, restarted: true, restartRequired: false, automaticBackupId: expect.any(String) })
    expect((await adapter.backups()).filter((backup) => backup.reason === reason)).toHaveLength(1)
  })

  it.each(['UPDATE_ROLLBACK_FAILED', 'STEAM_UPDATE_ROLLBACK_FAILED', 'STEAM_ROLLBACK_RECOVERY_FAILED'])(
    'does not restart after an incomplete update recovery reports %s', async (errorCode) => {
    const fixture = await config('windows')
    await fs.mkdir(fixture.game.root, { recursive: true })
    await fs.writeFile(path.join(fixture.game.saveDirectory, 'World.dsv'), 'current-dsv')
    await fs.writeFile(path.join(fixture.game.saveDirectory, 'World.server'), 'current-server')
    let running = true
    const invokedTasks: string[] = []
    const processId = 4242
    const adapter = new WindowsGameAdapter(fixture, {
      inspect: async () => ({
        process: running ? { pid: processId, startedAt: new Date(Date.now() - 5_000).toISOString(), workingSetBytes: 1024, totalProcessorSeconds: 1, targetUps: 60, selectedSave: 'World' } : null,
        versions: { game: null, nebula: '0.9.23', bepinex: '5.4.21.0' },
        tasks: { start: true, startManaged: true, configuredTargetUps: null }
      }),
      runScript: async <T>(_name: string, input: unknown) => {
        const taskName = String((input as { taskName?: unknown }).taskName)
        invokedTasks.push(taskName)
        if (taskName === fixture.game.startTaskName) running = true
        return { taskName } as T
      },
      updates: updateFixture({
        installComponent: async () => { throw new GameAdapterError(errorCode, 'fixture rollback failure') }
      })
    })
    const secret = await prepareBridge(fixture, processId)
    const workers = Promise.all([
      bridgeSaveWorker(fixture, secret, 'World'),
      bridgeStopWorker(fixture, secret, () => { running = false })
    ])
    await expect(adapter.run('install-update', { component: 'nebula', version: '0.9.24' }, () => undefined, new AbortController().signal))
      .rejects.toMatchObject({ code: errorCode })
    await workers
    expect(running).toBe(false)
    expect(invokedTasks).toEqual([])
  })

  it.each([
    {
      title: 'a component update', packageName: 'nebula-NebulaMultiplayerMod', binaryName: 'NebulaMultiplayerMod.dll',
      action: 'install-update' as const, input: { component: 'nebula', version: '0.9.24' }, component: 'nebula' as const
    },
    {
      title: 'a mod install', packageName: 'soarqin-UXAssist', binaryName: 'UXAssist.dll',
      action: 'install-mod' as const, input: { package: 'soarqin-UXAssist', version: '1.3.10' }, component: 'mod' as const
    }
  ])('restores real files and the installed-package lock when the first restart after $title fails', async ({ packageName, binaryName, action, input, component }) => {
    const fixture = await config('windows')
    await fs.mkdir(fixture.game.root, { recursive: true })
    await fs.writeFile(path.join(fixture.game.saveDirectory, 'World.dsv'), 'current-dsv')
    await fs.writeFile(path.join(fixture.game.saveDirectory, 'World.server'), 'current-server')
    const oldVersion = component === 'nebula' ? '0.9.23' : '1.3.9'
    const newVersion = component === 'nebula' ? '0.9.24' : '1.3.10'
    const operationIds = ['fixture-old-install', 'fixture-new-install', 'fixture-start-recovery']
    let running = false
    const updates = new GameUpdateManager({
      gameRoot: fixture.game.root,
      workDirectory: path.join(fixture.dataDirectory, 'fixture-update-work'),
      backupDirectory: path.join(fixture.dataDirectory, 'fixture-update-history'),
      catalogUrl: 'https://catalog.test/packages',
      fetch: packageCatalogFetch(packageName, [newVersion, oldVersion], binaryName),
      operationId: () => operationIds.shift()!,
      isGameRunning: async () => running
    })
    if (component === 'nebula') await updates.installComponent(component, oldVersion, () => undefined, new AbortController().signal)
    else await updates.installPackage(packageName, oldVersion, component, () => undefined, new AbortController().signal)

    const binaryPath = path.join(fixture.game.root, 'BepInEx', 'plugins', packageName, binaryName)
    const installedLockPath = path.join(fixture.game.root, 'BepInEx', '.dyson-control-packages.json')
    await expect(fs.readFile(binaryPath, 'utf8')).resolves.toBe(`${packageName}-${oldVersion}-binary`)
    running = true
    const processId = 4242
    let startAttempts = 0
    const reports: string[] = []
    const adapter = new WindowsGameAdapter(fixture, {
      updates,
      lifecycleTimeoutMs: 1_000,
      pollIntervalMs: 5,
      inspect: async () => ({
        process: running ? { pid: processId, startedAt: new Date(Date.now() - 5_000).toISOString(), workingSetBytes: 1024, totalProcessorSeconds: 1, targetUps: 60, selectedSave: 'World' } : null,
        versions: { game: null, nebula: component === 'nebula' ? oldVersion : null, bepinex: '5.4.21.0' },
        tasks: { start: true, startManaged: true, configuredTargetUps: null }
      }),
      runScript: async <T>(_name: string, raw: unknown) => {
        const taskName = String((raw as { taskName?: unknown }).taskName)
        if (taskName === fixture.game.startTaskName) {
          startAttempts++
          if (startAttempts === 1) throw new Error('fixture first start failed')
          running = true
        }
        return { taskName } as T
      }
    })
    const secret = await prepareBridge(fixture, processId)
    const workers = Promise.all([
      bridgeSaveWorker(fixture, secret, 'World'),
      bridgeStopWorker(fixture, secret, () => { running = false })
    ])

    await expect(adapter.run(action, input, message => reports.push(message), new AbortController().signal))
      .rejects.toMatchObject({ code: 'UPDATE_START_ROLLED_BACK' })
    await workers
    expect(startAttempts).toBe(2)
    expect(running).toBe(true)
    await expect(fs.readFile(binaryPath, 'utf8')).resolves.toBe(`${packageName}-${oldVersion}-binary`)
    const installedLock = JSON.parse(await fs.readFile(installedLockPath, 'utf8')) as { packages: Array<{ package: string; version: string }> }
    expect(installedLock.packages).toContainEqual(expect.objectContaining({ package: packageName, version: oldVersion }))
    expect(reports).toContainEqual(expect.stringContaining('已恢复安装前版本并重新启动服务器'))
  })

  it('stops the exact process left by a failed first start before rolling the installation back', async () => {
    const fixture = await config('windows')
    await fs.mkdir(fixture.game.root, { recursive: true })
    await fs.writeFile(path.join(fixture.game.saveDirectory, 'World.dsv'), 'current-dsv')
    await fs.writeFile(path.join(fixture.game.saveDirectory, 'World.server'), 'current-server')
    const processId = 4242
    let running = true
    let stopCount = 0
    let startAttempts = 0
    let rollbackWhileStopped = false
    const adapter = new WindowsGameAdapter(fixture, {
      lifecycleTimeoutMs: 1_000,
      pollIntervalMs: 5,
      inspect: async () => ({
        process: running ? { pid: processId, startedAt: new Date().toISOString(), workingSetBytes: 1024, totalProcessorSeconds: 0, targetUps: 60, selectedSave: 'World' } : null,
        versions: { game: null, nebula: '0.9.23', bepinex: null }, tasks: { start: true, startManaged: true, configuredTargetUps: null }
      }),
      runScript: async <T>(_name: string, raw: unknown) => {
        const taskName = String((raw as { taskName?: unknown }).taskName)
        if (taskName === fixture.game.startTaskName) {
          startAttempts++
          running = true
          if (startAttempts === 1) throw new Error('fixture start left a process running')
        }
        return { taskName } as T
      },
      updates: updateFixture({
        installComponent: async () => ({ backupId: 'installed-update', restartRequired: true }),
        rollbackUpdate: async historyId => {
          expect(historyId).toBe('installed-update')
          rollbackWhileStopped = !running
          return { historyId, rollbackBackupId: 'recovery-protection', restartRequired: true }
        }
      })
    })
    const secret = await prepareBridge(fixture, processId)
    const workers = Promise.all([
      bridgeSaveWorker(fixture, secret, 'World'),
      (async () => {
        await bridgeStopWorker(fixture, secret, () => { stopCount++; running = false })
        await bridgeStopWorker(fixture, secret, () => { stopCount++; running = false })
      })()
    ])
    await expect(adapter.run('install-update', { component: 'nebula', version: '0.9.24' }, () => undefined, new AbortController().signal))
      .rejects.toMatchObject({ code: 'UPDATE_START_ROLLED_BACK' })
    await workers
    expect(stopCount).toBe(2)
    expect(rollbackWhileStopped).toBe(true)
    expect(startAttempts).toBe(2)
    expect(running).toBe(true)
  })

  it('does not rollback or start again when process inspection fails after the first start', async () => {
    const fixture = await config('windows')
    await fs.mkdir(fixture.game.root, { recursive: true })
    await fs.writeFile(path.join(fixture.game.saveDirectory, 'World.dsv'), 'current-dsv')
    await fs.writeFile(path.join(fixture.game.saveDirectory, 'World.server'), 'current-server')
    const processId = 4242
    let running = true
    let inspectionUnavailable = false
    let rollbackCalled = false
    let startAttempts = 0
    const adapter = new WindowsGameAdapter(fixture, {
      lifecycleTimeoutMs: 1_000,
      pollIntervalMs: 5,
      inspect: async () => {
        if (inspectionUnavailable) throw new Error('fixture inspection unavailable')
        return {
          process: running ? { pid: processId, startedAt: new Date().toISOString(), workingSetBytes: 1024, totalProcessorSeconds: 0, targetUps: 60, selectedSave: 'World' } : null,
          versions: { game: null, nebula: '0.9.23', bepinex: null }, tasks: { start: true, startManaged: true, configuredTargetUps: null }
        }
      },
      runScript: async <T>() => {
        startAttempts++
        inspectionUnavailable = true
        throw new Error('fixture first start failed')
      },
      updates: updateFixture({
        installComponent: async () => ({ backupId: 'installed-update', restartRequired: true }),
        rollbackUpdate: async () => { rollbackCalled = true; return {} }
      })
    })
    const secret = await prepareBridge(fixture, processId)
    const workers = Promise.all([
      bridgeSaveWorker(fixture, secret, 'World'),
      bridgeStopWorker(fixture, secret, () => { running = false })
    ])
    await expect(adapter.run('install-update', { component: 'nebula', version: '0.9.24' }, () => undefined, new AbortController().signal))
      .rejects.toMatchObject({ code: 'UPDATE_START_RECOVERY_FAILED' })
    await workers
    expect(rollbackCalled).toBe(false)
    expect(startAttempts).toBe(1)
    expect(running).toBe(false)
  })

  it.each(['UPDATE_ROLLBACK_FAILED', 'STEAM_UPDATE_ROLLBACK_FAILED', 'STEAM_ROLLBACK_RECOVERY_FAILED'])(
    'keeps the server stopped when automatic start-failure recovery reports %s', async (errorCode) => {
      const fixture = await config('windows')
      await fs.mkdir(fixture.game.root, { recursive: true })
      await fs.writeFile(path.join(fixture.game.saveDirectory, 'World.dsv'), 'current-dsv')
      await fs.writeFile(path.join(fixture.game.saveDirectory, 'World.server'), 'current-server')
      const processId = 4242
      let running = true
      let startAttempts = 0
      const adapter = new WindowsGameAdapter(fixture, {
        inspect: async () => ({
          process: running ? { pid: processId, startedAt: new Date().toISOString(), workingSetBytes: 1024, totalProcessorSeconds: 0, targetUps: 60, selectedSave: 'World' } : null,
          versions: { game: null, nebula: '0.9.23', bepinex: null }, tasks: { start: true, startManaged: true, configuredTargetUps: null }
        }),
        runScript: async <T>() => { startAttempts++; throw new Error('fixture first start failed') },
        updates: updateFixture({
          installComponent: async () => ({ backupId: 'installed-update', restartRequired: true }),
          rollbackUpdate: async () => { throw new GameAdapterError(errorCode, 'fixture automatic recovery failed') }
        })
      })
      const secret = await prepareBridge(fixture, processId)
      const workers = Promise.all([
        bridgeSaveWorker(fixture, secret, 'World'),
        bridgeStopWorker(fixture, secret, () => { running = false })
      ])
      await expect(adapter.run('install-update', { component: 'nebula', version: '0.9.24' }, () => undefined, new AbortController().signal))
        .rejects.toMatchObject({ code: 'UPDATE_START_RECOVERY_FAILED' })
      await workers
      expect(startAttempts).toBe(1)
      expect(running).toBe(false)
    }
  )

  it('stops a process left by a failed restored-version start', async () => {
    const fixture = await config('windows')
    await fs.mkdir(fixture.game.root, { recursive: true })
    await fs.writeFile(path.join(fixture.game.saveDirectory, 'World.dsv'), 'current-dsv')
    await fs.writeFile(path.join(fixture.game.saveDirectory, 'World.server'), 'current-server')
    const processId = 4242
    let running = true
    let stopCount = 0
    let startAttempts = 0
    const adapter = new WindowsGameAdapter(fixture, {
      lifecycleTimeoutMs: 1_000,
      pollIntervalMs: 5,
      inspect: async () => ({
        process: running ? { pid: processId, startedAt: new Date().toISOString(), workingSetBytes: 1024, totalProcessorSeconds: 0, targetUps: 60, selectedSave: 'World' } : null,
        versions: { game: null, nebula: '0.9.23', bepinex: null }, tasks: { start: true, startManaged: true, configuredTargetUps: null }
      }),
      runScript: async <T>() => {
        startAttempts++
        if (startAttempts === 2) running = true
        throw new Error('fixture start failed')
      },
      updates: updateFixture({
        installComponent: async () => ({ backupId: 'installed-update', restartRequired: true }),
        rollbackUpdate: async historyId => ({ historyId, rollbackBackupId: 'recovery-protection', restartRequired: true })
      })
    })
    const secret = await prepareBridge(fixture, processId)
    const workers = Promise.all([
      bridgeSaveWorker(fixture, secret, 'World'),
      (async () => {
        await bridgeStopWorker(fixture, secret, () => { stopCount++; running = false })
        await bridgeStopWorker(fixture, secret, () => { stopCount++; running = false })
      })()
    ])
    await expect(adapter.run('install-update', { component: 'nebula', version: '0.9.24' }, () => undefined, new AbortController().signal))
      .rejects.toMatchObject({ code: 'UPDATE_RECOVERY_START_FAILED' })
    await workers
    expect(startAttempts).toBe(2)
    expect(stopCount).toBe(2)
    expect(running).toBe(false)
  })

  it.runIf(process.platform === 'win32')('recognizes only the exact managed start-task contract', async () => {
    const fixture = await config('windows')
    await fs.mkdir(fixture.game.root, { recursive: true })
    await fs.mkdir(path.join(fixture.dataDirectory, 'game-startup'), { recursive: true })
    const startupSettingsPath = path.join(fixture.dataDirectory, 'game-startup', 'settings.json')
    await fs.writeFile(startupSettingsPath, JSON.stringify({ schema: 1, targetUps: 60, saveName: null }))
    const argumentsPath = path.join(fixture.dataDirectory, 'inspect-arguments.json')
    await fs.writeFile(argumentsPath, JSON.stringify({
      gameRoot: fixture.game.root,
      saveDirectory: fixture.game.saveDirectory,
      logFile: fixture.game.logFile,
      managedStartScript: resolveWindowsScript('start-game.ps1'),
      startupSettingsPath,
      startTaskName: fixture.game.startTaskName
    }))
    const harness = path.join(fixture.dataDirectory, 'inspect-harness.ps1')
    await fs.writeFile(harness, `
[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$InspectScript, [Parameter(Mandatory = $true)][string]$ArgumentsPath, [switch]$AddUnexpected, [switch]$DuplicateProcess, [switch]$UseSmbAlias)
$inputObject = Get-Content -LiteralPath $ArgumentsPath -Raw -Encoding UTF8 | ConvertFrom-Json
$startArguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + [string]$inputObject.managedStartScript + '" -GameRoot "' + [string]$inputObject.gameRoot + '" -SaveDirectory "' + [string]$inputObject.saveDirectory + '" -SettingsPath "' + [string]$inputObject.startupSettingsPath + '" -LogFile "' + [string]$inputObject.logFile + '" -ProcessPriority AboveNormal'
if ($AddUnexpected) { $startArguments += ' -Unexpected value' }
$startAction = [pscustomobject]@{ Execute = (Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'); Arguments = $startArguments; WorkingDirectory = [string]$inputObject.gameRoot }
function Get-CimInstance {
  [CmdletBinding()]param([string]$ClassName, [string]$Filter)
  if (-not $DuplicateProcess) { return @() }
  $gameExe = Join-Path ([string]$inputObject.gameRoot) 'DSPGAME.exe'
  if ($UseSmbAlias) { $gameExe = '\\\\fixture-server\\fixture-share' + $gameExe.Substring(2) }
  return @(
    [pscustomobject]@{ ExecutablePath = $gameExe; ProcessId = 4101; CommandLine = 'DSPGAME.exe' },
    [pscustomobject]@{ ExecutablePath = $gameExe; ProcessId = 4102; CommandLine = 'DSPGAME.exe' }
  )
}
function Get-SmbGlobalMapping {
  [CmdletBinding()]param()
  if (-not $UseSmbAlias) { return @() }
  return @([pscustomobject]@{ LocalPath = ([IO.Path]::GetPathRoot([string]$inputObject.gameRoot)).TrimEnd('\'); RemotePath = '\\\\fixture-server\\fixture-share'; Status = 0 })
}
function Get-NetAdapter {
  [CmdletBinding()]param([string]$Name, [switch]$Physical)
  if (-not $Physical) { throw 'inspect must request physical adapters' }
  return @(
    [pscustomobject]@{ Name = 'Ethernet'; InterfaceGuid = [Guid]'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'; Status = 'Up' },
    [pscustomobject]@{ Name = 'Disconnected'; InterfaceGuid = [Guid]'11111111-2222-4333-8444-555555555555'; Status = 'Disconnected' }
  )
}
function Get-NetAdapterStatistics {
  [CmdletBinding()]param([string]$Name)
  if ($Name -cne 'Ethernet') { throw 'unexpected adapter statistics request' }
  return [pscustomobject]@{ ReceivedBytes = [UInt64]9007199254740993; SentBytes = [UInt64]9007199254740995 }
}
function Get-ScheduledTask {
  [CmdletBinding()]param([string]$TaskName)
  if ($TaskName -ceq [string]$inputObject.startTaskName) { return [pscustomobject]@{ TaskName = [string]$inputObject.startTaskName; Actions = @($startAction) } }
  return $null
}
& $InspectScript -ArgumentsPath $ArgumentsPath
`)
    const invoke = async (unexpected: boolean) => {
      const { stdout } = await execFileAsync('powershell.exe', [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', harness,
        '-InspectScript', resolveWindowsScript('inspect-game.ps1'), '-ArgumentsPath', argumentsPath,
        ...(unexpected ? ['-AddUnexpected'] : [])
      ], { windowsHide: true })
      return JSON.parse(stdout.trim()) as {
        tasks: { startManaged: boolean }
        versions: { game: null; nebula: null; bepinex: null }
        network: { sampledAtUnixMs: number; adapters: Array<{ id: string; receivedBytes: string; sentBytes: string }> }
      }
    }
    const managed = await invoke(false)
    expect(managed.tasks.startManaged).toBe(true)
    expect(managed.versions).toEqual({ game: null, nebula: null, bepinex: null })
    expect(managed.network.sampledAtUnixMs).toBeGreaterThan(0)
    expect(managed.network.adapters).toEqual([{
      id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      receivedBytes: '9007199254740993', sentBytes: '9007199254740995'
    }])
    expect((await invoke(true)).tasks.startManaged).toBe(false)
    await expect(execFileAsync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', harness,
      '-InspectScript', resolveWindowsScript('inspect-game.ps1'), '-ArgumentsPath', argumentsPath, '-DuplicateProcess', '-UseSmbAlias'
    ], { windowsHide: true })).rejects.toMatchObject({
      stderr: expect.stringContaining('managed instance is ambiguous')
    })
  })

  it.runIf(process.platform === 'win32')('binds DSP Configs/path.txt to the configured managed save directory before launch', async () => {
    const fixture = await config('windows')
    await fs.mkdir(fixture.game.root, { recursive: true })
    await fs.mkdir(path.join(fixture.dataDirectory, 'game-startup'), { recursive: true })
    await fs.mkdir(path.join(fixture.game.root, 'Configs'))
    await fs.writeFile(path.join(fixture.game.root, 'Configs', 'path.txt'), '')
    const userDataRoot = path.dirname(fixture.game.saveDirectory)
    await fs.writeFile(path.join(userDataRoot, 'options.xml'), 'existing-options')
    await fs.writeFile(path.join(userDataRoot, 'player.key'), 'existing-player-key')
    await fs.mkdir(path.join(userDataRoot, 'Blueprint'))
    await fs.writeFile(path.join(userDataRoot, 'Blueprint', 'existing.txt'), 'existing-blueprint')
    await fs.copyFile(path.join(process.env.SystemRoot!, 'System32', 'where.exe'), path.join(fixture.game.root, 'DSPGAME.exe'))
    const settingsPath = path.join(fixture.dataDirectory, 'game-startup', 'settings.json')
    await fs.writeFile(settingsPath, JSON.stringify({ schema: 1, targetUps: 60, saveName: null }))
    await expect(invokeStartGameFixture(fixture, settingsPath, fixture.game.saveDirectory, 'matching')).rejects.toMatchObject({
      stderr: expect.stringContaining('DSPGAME.exe exited with code')
    })
    const configs = path.join(fixture.game.root, 'Configs')
    const documentRoot = await fs.readFile(path.join(configs, 'path.txt'), 'utf8')
    const expectedDocumentRoot = path.join(fixture.dataDirectory, 'dyson-control-documents')
    expect(path.resolve(documentRoot)).toBe(expectedDocumentRoot)
    const gameDocument = await fs.lstat(path.join(expectedDocumentRoot, 'Dyson Sphere Program'))
    expect(gameDocument.isSymbolicLink()).toBe(true)
    expect(path.resolve(await fs.realpath(path.join(expectedDocumentRoot, 'Dyson Sphere Program')))).toBe(path.resolve(userDataRoot))
    expect(path.resolve(await fs.realpath(path.join(expectedDocumentRoot, 'Dyson Sphere Program', 'Save')))).toBe(path.resolve(fixture.game.saveDirectory))
    await expect(fs.readFile(path.join(expectedDocumentRoot, 'Dyson Sphere Program', 'options.xml'), 'utf8')).resolves.toBe('existing-options')
    await expect(fs.readFile(path.join(expectedDocumentRoot, 'Dyson Sphere Program', 'player.key'), 'utf8')).resolves.toBe('existing-player-key')
    await expect(fs.readFile(path.join(expectedDocumentRoot, 'Dyson Sphere Program', 'Blueprint', 'existing.txt'), 'utf8')).resolves.toBe('existing-blueprint')
    await expect(fs.readFile(path.join(configs, 'path.txt.dyson-control.original'), 'utf8')).resolves.toBe('')
  })

  it.runIf(process.platform === 'win32')('blocks the direct managed start script while a save restore journal is active', async () => {
    const fixture = await config('windows')
    await Promise.all([
      fs.mkdir(fixture.game.root, { recursive: true }),
      fs.mkdir(path.join(fixture.dataDirectory, 'save-restore', 'active'), { recursive: true }),
      fs.mkdir(path.join(fixture.dataDirectory, 'game-startup'), { recursive: true })
    ])
    await fs.copyFile(path.join(process.env.SystemRoot!, 'System32', 'where.exe'), path.join(fixture.game.root, 'DSPGAME.exe'))
    const settingsPath = path.join(fixture.dataDirectory, 'game-startup', 'settings.json')
    await fs.writeFile(settingsPath, JSON.stringify({ schema: 1, targetUps: 60, saveName: null }))
    await expect(execFileAsync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', resolveWindowsScript('start-game.ps1'),
      '-GameRoot', fixture.game.root, '-SaveDirectory', fixture.game.saveDirectory, '-SettingsPath', settingsPath,
      '-LogFile', fixture.game.logFile, '-ProcessPriority', 'AboveNormal'
    ], { windowsHide: true })).rejects.toMatchObject({
      stderr: expect.stringContaining('unfinished save restore transaction requires recovery')
    })
  })

  it.runIf(process.platform === 'win32')('requires Steam ownership in the same Windows session before changing the game binding', async () => {
    const fixture = await config('windows')
    await fs.mkdir(fixture.game.root, { recursive: true })
    await fs.mkdir(path.join(fixture.dataDirectory, 'game-startup'), { recursive: true })
    await fs.copyFile(path.join(process.env.SystemRoot!, 'System32', 'where.exe'), path.join(fixture.game.root, 'DSPGAME.exe'))
    const settingsPath = path.join(fixture.dataDirectory, 'game-startup', 'settings.json')
    await fs.writeFile(settingsPath, JSON.stringify({ schema: 1, targetUps: 60, saveName: null }))
    for (const steamMode of ['absent', 'different-session'] as const) {
      await expect(invokeStartGameFixture(fixture, settingsPath, fixture.game.saveDirectory, steamMode)).rejects.toMatchObject({
        stderr: expect.stringContaining('No running Steam client is owned by the current GameUser in interactive session')
      })
    }
    await expect(fs.lstat(path.join(fixture.game.root, 'Configs'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.runIf(process.platform === 'win32')('binds an arbitrary save directory without moving it', async () => {
    const fixture = await config('windows')
    const customSaveDirectory = path.join(path.dirname(fixture.dataDirectory), 'custom-save-location')
    const configs = path.join(fixture.game.root, 'Configs')
    const originalDocumentRoot = path.join(path.dirname(fixture.dataDirectory), 'previous-documents')
    await fs.mkdir(customSaveDirectory)
    await fs.mkdir(configs, { recursive: true })
    await fs.mkdir(path.join(fixture.dataDirectory, 'game-startup'), { recursive: true })
    await fs.writeFile(path.join(configs, 'path.txt'), originalDocumentRoot)
    await fs.copyFile(path.join(process.env.SystemRoot!, 'System32', 'where.exe'), path.join(fixture.game.root, 'DSPGAME.exe'))
    const settingsPath = path.join(fixture.dataDirectory, 'game-startup', 'settings.json')
    await fs.writeFile(settingsPath, JSON.stringify({ schema: 1, targetUps: 60, saveName: null }))
    await expect(invokeStartGameFixture(fixture, settingsPath, customSaveDirectory, 'matching')).rejects.toMatchObject({
      stderr: expect.stringContaining('DSPGAME.exe exited with code')
    })

    const documentRoot = path.join(fixture.dataDirectory, 'dyson-control-documents')
    expect(path.resolve(await fs.readFile(path.join(configs, 'path.txt'), 'utf8'))).toBe(documentRoot)
    expect(await fs.readFile(path.join(configs, 'path.txt.dyson-control.original'), 'utf8')).toBe(originalDocumentRoot)
    const saveJunction = path.join(documentRoot, 'Dyson Sphere Program', 'Save')
    expect((await fs.lstat(saveJunction)).isSymbolicLink()).toBe(true)
    expect(path.resolve(await fs.realpath(saveJunction))).toBe(path.resolve(customSaveDirectory))
  })

  it('resolves Windows scripts from both source and compiled module depths', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dyson-script-path-test-'))
    temporaryDirectories.push(root)
    const script = path.join(root, 'scripts', 'windows', 'fixture.ps1')
    await fs.mkdir(path.dirname(script), { recursive: true })
    await fs.writeFile(script, '# fixture')
    expect(resolveWindowsScript('fixture.ps1', path.join(root, 'server', 'game'))).toBe(script)
    expect(resolveWindowsScript('fixture.ps1', path.join(root, 'dist', 'server', 'game'))).toBe(script)
  })
})
