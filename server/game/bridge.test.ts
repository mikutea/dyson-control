import { createHmac } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readBridgePlayers, readBridgeTelemetry, readBridgeVersions, requestBridgeSave, requestBridgeStop } from './bridge.js'

const temporaryDirectories: string[] = []
afterEach(async () => { await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))) })

function sign(secret: string, parts: string[]): string {
  return createHmac('sha256', secret).update(parts.join('\n')).digest('hex')
}

async function fixture(): Promise<{ root: string; secretFile: string; secret: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dyson-bridge-test-'))
  temporaryDirectories.push(root)
  await fs.mkdir(path.join(root, 'requests'))
  await fs.mkdir(path.join(root, 'receipts'))
  const secret = '0123456789abcdef0123456789abcdef0123456789abcdef'
  const secretFile = path.join(root, 'secret')
  await fs.writeFile(secretFile, secret)
  const startedAt = Date.now() - 1_000
  const writtenAt = Date.now()
  const heartbeatParts = ['DYSON_CONTROL_HEARTBEAT_V1', '0.1.0', '1234', String(startedAt), String(writtenAt), 'ready']
  await fs.writeFile(path.join(root, 'heartbeat'), [
    'protocol=DYSON_CONTROL_HEARTBEAT_V1', 'pluginVersion=0.1.0', 'processId=1234',
    `startedAtUnixMs=${startedAt}`, `writtenAtUnixMs=${writtenAt}`, 'state=ready', `hmac=${sign(secret, heartbeatParts)}`, ''
  ].join('\n'))
  return { root, secretFile, secret }
}

async function bridgeWorker(root: string, secret: string, tamper = false): Promise<void> {
  const requests = path.join(root, 'requests')
  for (let count = 0; count < 100; count++) {
    const file = (await fs.readdir(requests)).find((name) => name.endsWith('.request'))
    if (!file) { await new Promise((resolve) => setTimeout(resolve, 10)); continue }
    const requestId = file.slice(0, -'.request'.length)
    const started = Date.now()
    const finished = started + 25
    const parts = [
      'DYSON_CONTROL_RECEIPT_V3', requestId, 'save', 'succeeded', String(started), String(finished), 'TestWorld',
      '10', '11', '4', '638900000000000000', '5', '638900000000000001', '6', '638900000000000002',
      'true', 'true', 'true', 'NONE'
    ]
    const lines = [
      'protocol=DYSON_CONTROL_RECEIPT_V3', `requestId=${requestId}`, 'action=save', 'state=succeeded',
      `startedAtUnixMs=${started}`, `finishedAtUnixMs=${finished}`, 'saveName=TestWorld', 'saveTimeBefore=10', 'saveTimeAfter=11',
      'dsvBytes=4', 'dsvWriteTimeUtcTicks=638900000000000000', 'serverBytes=5', 'serverWriteTimeUtcTicks=638900000000000001',
      'moddsvBytes=6', 'moddsvWriteTimeUtcTicks=638900000000000002', 'dsvChanged=true', 'serverChanged=true', 'moddsvChanged=true',
      'errorCode=NONE', `hmac=${tamper ? '0'.repeat(64) : sign(secret, parts)}`, ''
    ]
    await fs.writeFile(path.join(root, 'receipts', `${requestId}.receipt`), lines.join('\n'))
    return
  }
  throw new Error('request was not observed')
}

async function writePlayers(root: string, secret: string, state: 'active' | 'inactive' | 'unavailable' = 'active'): Promise<void> {
  const writtenAt = Date.now()
  const players = state === 'active'
    ? [{ sessionPlayerId: 'player-000001', displayName: 'Fixture Player', online: true, joinedAtUnixMs: writtenAt - 1_000, location: 'planet:101' }]
    : []
  const encoded = Buffer.from(JSON.stringify(players), 'utf8').toString('base64url')
  const parts = ['DYSON_CONTROL_PLAYERS_V1', '00000000-0000-4000-8000-000000000001', String(writtenAt), '1', state, 'false', String(players.length), encoded]
  await fs.writeFile(path.join(root, 'players'), [
    'protocol=DYSON_CONTROL_PLAYERS_V1', 'sessionId=00000000-0000-4000-8000-000000000001',
    `writtenAtUnixMs=${writtenAt}`, 'sequence=1', `state=${state}`, 'truncated=false',
    `playerCount=${players.length}`, `playersJsonB64=${encoded}`, `hmac=${sign(secret, parts)}`, ''
  ].join('\n'))
}

async function writeVersions(
  root: string,
  secret: string,
  changes: Partial<{ processId: string; writtenAtUnixMs: string; game: string; nebula: string; bepinex: string; bridge: string }> = {},
  tamper = false
): Promise<void> {
  const row = {
    processId: '1234', writtenAtUnixMs: String(Date.now()), game: '0.10.34.28470',
    nebula: '0.9.24', bepinex: '5.4.17.0', bridge: '0.1.0', ...changes
  }
  const parts = ['DYSON_CONTROL_VERSIONS_V1', row.processId, row.writtenAtUnixMs, row.game, row.nebula, row.bepinex, row.bridge]
  await fs.writeFile(path.join(root, 'versions'), [
    'protocol=DYSON_CONTROL_VERSIONS_V1', `processId=${row.processId}`, `writtenAtUnixMs=${row.writtenAtUnixMs}`,
    `game=${row.game}`, `nebula=${row.nebula}`, `bepinex=${row.bepinex}`, `bridge=${row.bridge}`,
    `hmac=${tamper ? '0'.repeat(64) : sign(secret, parts)}`, ''
  ].join('\n'))
}

describe('signed Bridge version snapshots', () => {
  it('accepts fresh strict ASCII versions bound to the ready process', async () => {
    const { root, secretFile, secret } = await fixture()
    await writeVersions(root, secret)
    await expect(readBridgeVersions(root, secretFile, 1234)).resolves.toMatchObject({
      processId: 1234, game: '0.10.34.28470', nebula: '0.9.24', bepinex: '5.4.17.0', bridge: '0.1.0'
    })
  })

  it.each([
    { title: 'tampered signature', changes: {}, tamper: true, code: 'BRIDGE_SIGNATURE_INVALID' },
    { title: 'different process', changes: { processId: '9999' }, tamper: false, code: 'BRIDGE_PROCESS_MISMATCH' },
    { title: 'stale snapshot', changes: { writtenAtUnixMs: String(Date.now() - 20_000) }, tamper: false, code: 'BRIDGE_VERSIONS_STALE' },
    { title: 'non-ASCII version', changes: { game: '游戏-1' }, tamper: false, code: 'BRIDGE_VERSIONS_INVALID' },
    { title: 'overlong version', changes: { bridge: '1'.repeat(129) }, tamper: false, code: 'BRIDGE_VERSIONS_INVALID' }
  ])('rejects a $title', async ({ changes, tamper, code }) => {
    const { root, secretFile, secret } = await fixture()
    await writeVersions(root, secret, changes, tamper)
    await expect(readBridgeVersions(root, secretFile, 1234)).rejects.toMatchObject({ code })
  })

  it('requires a fresh ready heartbeat for the same process', async () => {
    const { root, secretFile, secret } = await fixture()
    await writeVersions(root, secret)
    const startedAt = Date.now() - 1_000
    const writtenAt = Date.now()
    const heartbeat = ['DYSON_CONTROL_HEARTBEAT_V1', '0.1.0', '1234', String(startedAt), String(writtenAt), 'unavailable']
    await fs.writeFile(path.join(root, 'heartbeat'), [
      'protocol=DYSON_CONTROL_HEARTBEAT_V1', 'pluginVersion=0.1.0', 'processId=1234',
      `startedAtUnixMs=${startedAt}`, `writtenAtUnixMs=${writtenAt}`, 'state=unavailable', `hmac=${sign(secret, heartbeat)}`, ''
    ].join('\n'))
    await expect(readBridgeVersions(root, secretFile, 1234)).rejects.toMatchObject({ code: 'BRIDGE_HEARTBEAT_INVALID' })
  })
})

describe('signed Bridge save protocol', () => {
  it('accepts the exact signed V3 receipt', async () => {
    const { root, secretFile, secret } = await fixture()
    const worker = bridgeWorker(root, secret)
    const receipt = await requestBridgeSave(root, secretFile, new AbortController().signal, 5_000)
    await worker
    expect(receipt).toMatchObject({ state: 'succeeded', saveName: 'TestWorld', dsvBytes: 4, serverBytes: 5, moddsvBytes: 6 })
  })

  it('rejects a tampered receipt', async () => {
    const { root, secretFile, secret } = await fixture()
    const worker = bridgeWorker(root, secret, true)
    await expect(requestBridgeSave(root, secretFile, new AbortController().signal, 5_000)).rejects.toMatchObject({ code: 'BRIDGE_SIGNATURE_INVALID' })
    await worker
  })
})

describe('signed Bridge player snapshots', () => {
  it('returns a canonical active snapshot bound to the current process', async () => {
    const { root, secretFile, secret } = await fixture()
    await writePlayers(root, secret)
    await expect(readBridgePlayers(root, secretFile, 1234)).resolves.toEqual([{
      id: '00000000-0000-4000-8000-000000000001:player-000001', name: 'Fixture Player', connectedAt: expect.any(String), planet: '星球 101', pingMs: null
    }])
  })

  it('does not convert an unavailable snapshot into an empty online-player list', async () => {
    const { root, secretFile, secret } = await fixture()
    await writePlayers(root, secret, 'unavailable')
    await expect(readBridgePlayers(root, secretFile, 1234)).rejects.toMatchObject({ code: 'PLAYER_SNAPSHOT_UNAVAILABLE' })
  })

  it('rejects a fresh snapshot when the Bridge heartbeat belongs to another process', async () => {
    const { root, secretFile, secret } = await fixture()
    await writePlayers(root, secret)
    await expect(readBridgePlayers(root, secretFile, 9999)).rejects.toMatchObject({ code: 'BRIDGE_PROCESS_MISMATCH' })
  })
})

async function stopWorker(root: string, secret: string, action = 'stop', state = 'succeeded', errorCode = 'NONE'): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const file = (await fs.readdir(path.join(root, 'requests'))).find(name => name.endsWith('.request'))
    if (!file) { await new Promise(resolve => setTimeout(resolve, 10)); continue }
    const request = Object.fromEntries((await fs.readFile(path.join(root, 'requests', file), 'utf8')).trim().split('\n').map(line => {
      const split = line.indexOf('='); return [line.slice(0, split), line.slice(split + 1)]
    }))
    expect(request.action).toBe('stop')
    expect(request.hmac).toBe(sign(secret, ['protocol', 'requestId', 'createdAtUnixMs', 'expiresAtUnixMs', 'action', 'nonce'].map(key => request[key]!)))
    const keys = ['protocol', 'requestId', 'action', 'state', 'startedAtUnixMs', 'finishedAtUnixMs', 'errorCode']
    const now = String(Date.now())
    const values = ['DYSON_CONTROL_ACTION_V1', request.requestId!, action, state, now, now, errorCode]
    await fs.writeFile(path.join(root, 'receipts', `${request.requestId}.receipt`), [...keys.map((key, index) => `${key}=${values[index]}`), `hmac=${sign(secret, values)}`, ''].join('\n'))
    return
  }
  throw new Error('Stop request was not observed')
}

describe('signed Bridge stop protocol', () => {
  it('publishes a signed stop request and accepts its matching acknowledgement', async () => {
    const { root, secretFile, secret } = await fixture()
    const worker = stopWorker(root, secret)
    await expect(requestBridgeStop(root, secretFile, new AbortController().signal, 2_000, 1234)).resolves.toMatchObject({ state: 'succeeded', errorCode: 'NONE' })
    await worker
    expect(await fs.readdir(path.join(root, 'requests'))).toEqual([])
  })
  it('preserves a signed failure and rejects a receipt for another action', async () => {
    const { root, secretFile, secret } = await fixture()
    let worker = stopWorker(root, secret, 'stop', 'failed', 'GAME_NOT_READY')
    await expect(requestBridgeStop(root, secretFile, new AbortController().signal, 2_000, 1234)).resolves.toMatchObject({ state: 'failed', errorCode: 'GAME_NOT_READY' })
    await worker
    worker = stopWorker(root, secret, 'save')
    await expect(requestBridgeStop(root, secretFile, new AbortController().signal, 2_000, 1234)).rejects.toMatchObject({ code: 'BRIDGE_RECEIPT_MISMATCH' })
    await worker
  })
  it('removes an unclaimed request on timeout or cancellation without retrying it', async () => {
    const { root, secretFile } = await fixture()
    await expect(requestBridgeStop(root, secretFile, new AbortController().signal, 50, 1234)).rejects.toMatchObject({ code: 'BRIDGE_RECEIPT_TIMEOUT' })
    expect(await fs.readdir(path.join(root, 'requests'))).toEqual([])
    const controller = new AbortController()
    const pending = requestBridgeStop(root, secretFile, controller.signal, 2_000, 1234)
    const assertion = expect(pending).rejects.toThrow('Fixture cancelled')
    const timer = setTimeout(() => controller.abort(new Error('Fixture cancelled')), 50)
    try { await assertion } finally { clearTimeout(timer) }
    expect(await fs.readdir(path.join(root, 'requests'))).toEqual([])
  })
})

async function writeMetrics(root: string, secret: string, overrides: Record<string, string> = {}, tampered = false): Promise<void> {
  const row = { protocol: 'DYSON_CONTROL_METRICS_V1', sessionId: '00000000-0000-4000-8000-000000000001', processId: '1234', writtenAtUnixMs: String(Date.now()), state: 'active', ups: '59.8', tps: '60', gameTick: '123456', ...overrides }
  await fs.writeFile(path.join(root, 'metrics'), [...Object.entries(row).map(([key, value]) => `${key}=${value}`), `hmac=${tampered ? '0'.repeat(64) : sign(secret, Object.values(row))}`, ''].join('\n'))
}

describe('signed Bridge game telemetry', () => {
  it('reads measured UPS/TPS only when bound to a fresh game heartbeat', async () => {
    const { root, secretFile, secret } = await fixture()
    await writeMetrics(root, secret)
    await expect(readBridgeTelemetry(root, secretFile, 1234)).resolves.toMatchObject({ ups: 59.8, tps: 60, gameTick: 123456, processId: 1234 })
    await writeMetrics(root, secret, { state: 'unavailable', ups: '-1', tps: '-1', gameTick: '-1' })
    await expect(readBridgeTelemetry(root, secretFile, 1234)).resolves.toBeNull()
  })
  it.each([
    [{ processId: '9999' }, 'BRIDGE_PROCESS_MISMATCH'],
    [{ writtenAtUnixMs: '1' }, 'BRIDGE_METRICS_STALE'],
    [{ ups: 'NaN' }, 'BRIDGE_METRICS_INVALID'],
    [{ tps: '-1' }, 'BRIDGE_METRICS_INVALID'],
    [{ gameTick: '1.5' }, 'BRIDGE_NUMBER_INVALID'],
    [{ state: 'unavailable' }, 'BRIDGE_METRICS_INVALID'],
  ])('rejects invalid metrics %j', async (overrides, code) => {
    const { root, secretFile, secret } = await fixture()
    await writeMetrics(root, secret, overrides)
    await expect(readBridgeTelemetry(root, secretFile, 1234)).rejects.toMatchObject({ code })
  })
  it('rejects an altered telemetry signature', async () => {
    const { root, secretFile, secret } = await fixture()
    await writeMetrics(root, secret, {}, true)
    await expect(readBridgeTelemetry(root, secretFile, 1234)).rejects.toMatchObject({ code: 'BRIDGE_SIGNATURE_INVALID' })
  })
})
