import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { PlayerEventBatch } from '../shared/contracts.js'
import { PlayerHistoryStore } from './player-history.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dyson-player-history-'))
  let time = Date.now()
  let failed = false
  const batch: PlayerEventBatch = { sessionId: 'session-a', processId: 1234, writtenAtUnixMs: time, firstSequence: 1, lastSequence: 2, events: [
    { sequence: 1, type: 'firstObserved', sessionPlayerId: 'player-000001', displayName: 'Fixture', observedAtUnixMs: time - 100 },
    { sequence: 2, type: 'leave', sessionPlayerId: 'player-000001', displayName: 'Fixture', observedAtUnixMs: time },
  ] }
  const stores: PlayerHistoryStore[] = []
  const open = () => { const store = new PlayerHistoryStore(path.join(root, 'players.sqlite'), { playerEvents: async () => { if (failed) throw new Error('Unavailable'); return structuredClone(batch) } }, { clock: () => time }); stores.push(store); return store }
  const store = open()
  cleanups.push(async () => { for (const item of stores) await item.close(); await fs.rm(root, { recursive: true, force: true }) })
  return { store, batch, open, fail: () => { failed = true }, advance: (ms: number) => { time += ms } }
}
describe('durable player history', () => {
  it('deduplicates repeated buffers across panel restarts and namespaces connection IDs', async () => {
    const f = await fixture(); await Promise.all([f.store.sample(), f.store.sample()])
    expect(f.store.read().total).toBe(2)
    await f.store.close()
    const reopened = f.open(); await reopened.sample()
    expect(reopened.read().total).toBe(2)
    f.batch.sessionId = 'session-b'; await reopened.sample()
    expect(reopened.read().total).toBe(4)
    expect(new Set(reopened.read().entries.map(item => item.playerId)).size).toBe(2)
  })
  it('preserves history on unavailable reads without generating a leave', async () => {
    const f = await fixture(); await f.store.sample(); const entries = f.store.read().entries
    f.fail(); await f.store.sample()
    expect(f.store.read()).toMatchObject({ status: 'unavailable', entries })
  })
  it('records an explicit sequence gap only once and supports paging', async () => {
    const f = await fixture(); await f.store.sample()
    f.batch.firstSequence = 10; f.batch.lastSequence = 10
    f.batch.events = [{ ...f.batch.events[0]!, sequence: 10, type: 'join' }]
    await f.store.sample(); await f.store.sample()
    expect(f.store.read().total).toBe(4)
    expect(f.store.read().entries.find(item => item.type === 'gap')).toMatchObject({ missingCount: 7, name: null, playerId: null })
    expect(f.store.read(1, 1).entries).toHaveLength(1)
  })
  it('expires personal history after 30 days even when the last signed buffer remains on disk', async () => {
    const f = await fixture(); await f.store.sample()
    f.advance(31 * 24 * 60 * 60 * 1_000); await f.store.sample()
    expect(f.store.read().total).toBe(0)
  })
})
