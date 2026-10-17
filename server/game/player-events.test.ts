import { createHmac } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readBridgePlayerEvents } from './bridge.js'

const directories: string[] = []
afterEach(async () => { for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true }) })

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dyson-events-'))
  directories.push(root)
  const secret = 'fixture-secret-never-use-in-production-0123456789'
  const secretFile = path.join(root, 'secret')
  await fs.writeFile(secretFile, secret)
  const at = Date.now() - 60_000
  const event = { sequence: 1, type: 'join', sessionPlayerId: 'player-000001', displayName: '工程师 🌌', observedAtUnixMs: at }
  const write = async (events: unknown[] = [event], changes: Record<string, string> = {}) => {
    const fields: Record<string, string> = { protocol: 'DYSON_CONTROL_PLAYER_EVENTS_V1', sessionId: '00000000-0000-4000-8000-000000000001', processId: '1234', writtenAtUnixMs: String(at + 100), firstSequence: events.length ? '1' : '0', lastSequence: String(events.length), eventCount: String(events.length), eventsJsonB64: Buffer.from(JSON.stringify(events)).toString('base64url'), ...changes }
    const signature = createHmac('sha256', secret).update(Object.values(fields).join('\n')).digest('hex')
    await fs.writeFile(path.join(root, 'player-events'), Object.entries({ ...fields, hmac: signature }).map(([key, value]) => `${key}=${value}`).join('\n') + '\n')
  }
  return { root, secretFile, at, event, write }
}

describe('signed player event buffers', () => {
  it('reads final historical events without a heartbeat and still binds a known game PID', async () => {
    const f = await fixture(); await f.write()
    expect((await readBridgePlayerEvents(f.root, f.secretFile)).events).toEqual([f.event])
    await expect(readBridgePlayerEvents(f.root, f.secretFile, 5678)).rejects.toMatchObject({ code: 'BRIDGE_PROCESS_MISMATCH' })
  })
  it('accepts all 256 records above the old snapshot size limit', async () => {
    const f = await fixture()
    await f.write(Array.from({ length: 256 }, (_, index) => ({ ...f.event, sequence: index + 1, displayName: '星'.repeat(42) })))
    expect((await readBridgePlayerEvents(f.root, f.secretFile)).events).toHaveLength(256)
  })
  it('rejects altered signatures and invalid sequences, times or private fields', async () => {
    const f = await fixture()
    for (const invalid of [{ ...f.event, sequence: 2 }, { ...f.event, observedAtUnixMs: f.at + 101 }, { ...f.event, displayName: '星'.repeat(43) }, { ...f.event, ipAddress: 'fixture' }]) {
      await f.write([invalid]); await expect(readBridgePlayerEvents(f.root, f.secretFile)).rejects.toMatchObject({ code: 'PLAYER_EVENTS_INVALID' })
    }
    await f.write()
    const file = path.join(f.root, 'player-events')
    await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replace('processId=1234', 'processId=1235'))
    await expect(readBridgePlayerEvents(f.root, f.secretFile)).rejects.toMatchObject({ code: 'BRIDGE_SIGNATURE_INVALID' })
  })
  it('accepts an empty initial buffer and exposes a rolled window without inventing events', async () => {
    const f = await fixture(); await f.write([])
    expect((await readBridgePlayerEvents(f.root, f.secretFile)).events).toEqual([])
    await f.write([{ ...f.event, sequence: 10 }], { firstSequence: '10', lastSequence: '10' })
    expect((await readBridgePlayerEvents(f.root, f.secretFile)).firstSequence).toBe(10)
  })
})
