import { createHmac } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readBridgePlayerActionCapability, requestBridgeKickPlayer } from './bridge.js'

const directories: string[] = []
const sessionId = '00000000-0000-4000-8000-000000000001'
const playerId = `${sessionId}:player-000001`
const secret = 'fixture-player-action-secret-0123456789abcdef'
const sign = (parts: string[]) => createHmac('sha256', secret).update(parts.join('\n')).digest('hex')
afterEach(async () => { await Promise.all(directories.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))) })

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dyson-player-action-'))
  directories.push(root)
  await Promise.all(['requests', 'receipts', 'player-requests', 'player-responses'].map(name => fs.mkdir(path.join(root, name))))
  const secretFile = path.join(root, 'secret')
  await fs.writeFile(secretFile, secret)
  const write = async (name: string, keys: string[], values: string[]) => fs.writeFile(path.join(root, name), [...keys.map((key, index) => `${key}=${values[index]}`), `hmac=${sign(values)}`, ''].join('\n'))
  const now = Date.now()
  await write('heartbeat', ['protocol', 'pluginVersion', 'processId', 'startedAtUnixMs', 'writtenAtUnixMs', 'state'], ['DYSON_CONTROL_HEARTBEAT_V1', '0.1.0', '1234', String(now - 60_000), String(now), 'ready'])
  const capability = (state = 'available', timestamp = now, pid = 1234) => write('player-actions', ['protocol', 'sessionId', 'processId', 'writtenAtUnixMs', 'state'], ['DYSON_CONTROL_PLAYER_ACTIONS_V1', sessionId, String(pid), String(timestamp), state])
  await capability()
  return { root, secretFile, capability }
}

async function respond(root: string, changes: Record<string, string> = {}) {
  for (let index = 0; index < 200; index++) {
    const file = (await fs.readdir(path.join(root, 'player-requests'))).find(name => name.endsWith('.request'))
    if (!file) { await new Promise(resolve => setTimeout(resolve, 5)); continue }
    const content = await fs.readFile(path.join(root, 'player-requests', file), 'utf8')
    const lines = content.trim().split('\n')
    const request = Object.fromEntries(lines.map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]))
    expect(request.hmac).toBe(sign(lines.slice(0, -1).map(line => line.slice(line.indexOf('=') + 1))))
    expect(request).toMatchObject({ protocol: 'DYSON_CONTROL_PLAYER_ACTION_V1', action: 'kick-player', sessionId, sessionPlayerId: 'player-000001' })
    expect(request.nonce).toMatch(/^[0-9a-f]{32}$/)
    const row: Record<string, string> = {
      protocol: 'DYSON_CONTROL_PLAYER_ACTION_RECEIPT_V1', requestId: request.requestId!, action: 'kick-player', sessionId,
      sessionPlayerId: 'player-000001', state: 'succeeded', startedAtUnixMs: String(Date.now()), finishedAtUnixMs: String(Date.now()), errorCode: 'NONE', ...changes,
    }
    const signature = changes.hmac ?? sign(Object.values(row))
    delete row.hmac
    const temporary = path.join(root, 'player-responses', `${request.requestId}.temporary`)
    await fs.writeFile(temporary, [...Object.entries(row).map(([key, value]) => `${key}=${value}`), `hmac=${signature}`, ''].join('\n'))
    await fs.rename(temporary, path.join(root, 'player-responses', `${request.requestId}.receipt`))
    return
  }
  throw new Error('Player request did not appear')
}

describe('signed player actions', () => {
  it('requires a fresh capability signed by the current process', async () => {
    const f = await fixture()
    await expect(readBridgePlayerActionCapability(f.root, f.secretFile, 1234)).resolves.toBe(true)
    await f.capability('unavailable')
    await expect(readBridgePlayerActionCapability(f.root, f.secretFile, 1234)).resolves.toBe(false)
    await f.capability('available', Date.now() - 20_000)
    await expect(readBridgePlayerActionCapability(f.root, f.secretFile, 1234)).rejects.toMatchObject({ code: 'BRIDGE_PLAYER_ACTIONS_STALE' })
    await f.capability('available', Date.now(), 9999)
    await expect(readBridgePlayerActionCapability(f.root, f.secretFile, 1234)).rejects.toMatchObject({ code: 'BRIDGE_PROCESS_MISMATCH' })
    await f.capability('available', Date.now() + 20_000)
    await expect(readBridgePlayerActionCapability(f.root, f.secretFile, 1234)).rejects.toMatchObject({ code: 'BRIDGE_PLAYER_ACTIONS_STALE' })
  })

  it('never publishes an action when only old queue directories remain', async () => {
    const f = await fixture()
    await f.capability('unavailable')
    await expect(requestBridgeKickPlayer(f.root, f.secretFile, playerId, new AbortController().signal, 1234)).rejects.toMatchObject({ code: 'PLAYER_ACTIONS_UNAVAILABLE' })
    await fs.rm(path.join(f.root, 'player-actions'))
    await expect(requestBridgeKickPlayer(f.root, f.secretFile, playerId, new AbortController().signal, 1234)).rejects.toMatchObject({ code: 'BRIDGE_PLAYER_ACTIONS_UNAVAILABLE' })
    expect(await fs.readdir(path.join(f.root, 'player-requests'))).toEqual([])
  })

  it('signs the exact session connection and accepts only its completed receipt', async () => {
    const f = await fixture()
    const worker = respond(f.root)
    await expect(requestBridgeKickPlayer(f.root, f.secretFile, playerId, new AbortController().signal, 1234, 3_000)).resolves.toMatchObject({ state: 'succeeded', errorCode: 'NONE' })
    await worker
    expect(await fs.readdir(path.join(f.root, 'player-requests'))).toEqual([])
  })

  it.each([
    [{ sessionId: '00000000-0000-4000-8000-000000000002' }, 'BRIDGE_RECEIPT_MISMATCH'],
    [{ sessionPlayerId: 'player-000002' }, 'BRIDGE_RECEIPT_MISMATCH'],
    [{ hmac: '0'.repeat(64) }, 'BRIDGE_SIGNATURE_INVALID'],
    [{ state: 'succeeded', errorCode: 'KICK_TIMEOUT' }, 'BRIDGE_RECEIPT_INVALID'],
  ])('rejects substituted or unverified receipts %j', async (change, code) => {
    const f = await fixture()
    const worker = respond(f.root, change)
    await expect(requestBridgeKickPlayer(f.root, f.secretFile, playerId, new AbortController().signal, 1234, 3_000)).rejects.toMatchObject({ code })
    await worker
  })

  it('returns a signed failure and never equates sending the request with success', async () => {
    const f = await fixture()
    const worker = respond(f.root, { state: 'failed', errorCode: 'PLAYER_NOT_ONLINE' })
    await expect(requestBridgeKickPlayer(f.root, f.secretFile, playerId, new AbortController().signal, 1234, 3_000)).resolves.toMatchObject({ state: 'failed', errorCode: 'PLAYER_NOT_ONLINE' })
    await worker
    await expect(requestBridgeKickPlayer(f.root, f.secretFile, playerId, new AbortController().signal, 1234, 20)).rejects.toMatchObject({ code: 'BRIDGE_RECEIPT_TIMEOUT' })
    expect(await fs.readdir(path.join(f.root, 'player-requests'))).toEqual([])
  })

  it('rejects names, native ids and malformed session ids before publishing', async () => {
    const f = await fixture()
    for (const id of ['Aurora', '1', `${sessionId}:player-1`, `${sessionId.toUpperCase()}:player-000001-extra`]) {
      await expect(requestBridgeKickPlayer(f.root, f.secretFile, id, new AbortController().signal, 1234)).rejects.toMatchObject({ code: 'PLAYER_ID_INVALID' })
    }
    expect(await fs.readdir(path.join(f.root, 'player-requests'))).toEqual([])
  })
})
