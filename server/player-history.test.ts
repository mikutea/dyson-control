import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
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
  return { root, store, batch, open, fail: () => { failed = true }, advance: (ms: number) => { time += ms } }
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
  it('matches display names as literal Unicode text and never attributes a sequence gap to a player', async () => {
    const f = await fixture()
    f.batch.firstSequence = 4; f.batch.lastSequence = 7
    f.batch.events = ['Érin%_星港', 'Érin%X星港', 'Érin__星港', '风铃'].map((displayName, i) => ({
      ...f.batch.events[0]!, displayName, sequence: 4 + i, type: i === 1 ? 'leave' : 'join',
    }))
    await f.store.sample()
    expect(f.store.read(50, 0, { name: 'érin%_', type: 'join' }).entries.map(item => item.name)).toEqual(['Érin%_星港'])
    expect(f.store.read(50, 0, { name: '%' }).total).toBe(2)
    expect(f.store.read(50, 0, { name: '_' }).total).toBe(2)
    expect(f.store.read(50, 0, { name: 'session-a' }).total).toBe(0)
    expect(f.store.read(50, 0, { type: 'gap' }).entries).toMatchObject([{ missingCount: 3, name: null, playerId: null }])
    expect(f.store.read(50, 0, { type: 'gap', name: '星港' }).entries).toEqual([])
  })
  it('keeps pages at the same millisecond stable through simultaneous reads, late events and a service restart', async () => {
    const f = await fixture()
    const event = { ...f.batch.events[0]!, type: 'join' as const, observedAtUnixMs: f.batch.writtenAtUnixMs }
    f.batch.lastSequence = 6
    f.batch.events = Array.from({ length: 6 }, (_, i) => ({ ...event, sequence: i + 1, displayName: 'Name' + (i + 1) }))
    await Promise.all([f.store.sample(), f.store.sample()])
    const first = f.store.read(2)
    const names = (page: typeof first) => page.entries.map(row => row.name)
    expect(names(first)).toEqual(['Name6', 'Name5'])
    f.batch.firstSequence = 7; f.batch.lastSequence = 8
    f.batch.events = [{...event, sequence: 7, displayName: 'New'}, {...event, sequence: 8, displayName: 'Late', observedAtUnixMs: event.observedAtUnixMs - 50}]
    await Promise.all([f.store.sample(), f.store.sample()])
    const second = f.store.read(2, 0, { cursor: first.nextCursor! })
    expect(names(second)).toEqual(['Name4', 'Name3'])
    expect(second.total).toBe(6)
    expect(names(f.store.read(2, 0, { cursor: first.pageCursor }))).toEqual(['Name6', 'Name5'])
    await f.store.close()
    const reopened = f.open(), last = reopened.read(2, 0, { cursor: second.nextCursor! })
    expect(names(last)).toEqual(['Name2', 'Name1'])
    expect(last.nextCursor).toBeNull()
    expect(names(reopened.read(2))).toEqual(['New', 'Name6'])
    expect(names(reopened.read(2, 2))).toEqual(['Name5', 'Name4'])
    expect(names(reopened.read(2, 0, { cursor: reopened.read(2, 2).pageCursor }))).toEqual(['Name5', 'Name4'])
    f.advance(31 * 24 * 60 * 60 * 1000)
    expect(reopened.read(2, 0, { cursor: second.pageCursor })).toMatchObject({ entries: [], total: 0, nextCursor: null })
  })
  it('opens old-format databases and prevents rowid reuse when retention trims a high, backdated row', async () => {
    const f = await fixture()
    const file = path.join(f.root, 'legacy.sqlite'), old = new DatabaseSync(file), time = f.batch.writtenAtUnixMs
    old.exec('CREATE TABLE player_events (id TEXT PRIMARY KEY, at INTEGER NOT NULL, entry TEXT NOT NULL)')
    const insert = old.prepare('INSERT INTO player_events(rowid,id,at,entry) VALUES(?,?,?,?)')
    const entry = { id: '', sessionId: 'old', playerId: null, name: null, type: 'gap', occurredAt: new Date(time).toISOString(), missingCount: 1 }
    old.exec('BEGIN')
    for (let i = 1; i <= 10_000; i++) insert.run(i,'old:'+i,time,JSON.stringify({ ...entry, id: 'old:'+i }))
    insert.run(60_000,'expired',time - 31 * 24 * 60 * 60 * 1000,JSON.stringify(entry))
    old.exec('COMMIT'); old.close()
    const store = new PlayerHistoryStore(file, { playerEvents: async () => f.batch }, { clock: () => time })
    try {
      const head = store.read(1)
      expect(head.total).toBe(10_000)
      f.batch.events = [{ ...f.batch.events[0]!, sequence: 1, observedAtUnixMs: time, displayName: 'New in same millisecond' }]
      f.batch.lastSequence = 1
      await store.sample()
      expect(store.read(1)).toMatchObject({ total: 10_000, entries: [{ name: 'New in same millisecond' }] })
      expect(store.read(1, 0, { cursor: head.pageCursor })).toMatchObject({ total: 9999, entries: [{ id: 'old:10000' }] })
    } finally { await store.close() }
  })
})
