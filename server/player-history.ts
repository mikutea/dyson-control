import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { GameAdapter, PlayerEventBatch, PlayerHistory, PlayerHistoryEntry } from '../shared/contracts.js'

const retentionMs = 30 * 24 * 60 * 60 * 1_000
const maximumEntries = 10_000

/** Persists signed callbacks independently of browser connections and live rosters. */
export class PlayerHistoryStore {
  readonly #db: DatabaseSync
  readonly #clock: () => number
  readonly #intervalMs: number
  #timer: NodeJS.Timeout | null = null
  #sampling: Promise<void> | null = null
  #stopping = false
  #closed = false
  #status: PlayerHistory['status'] = 'waiting'
  #lastReadAt: string | null = null

  constructor(file: string, private readonly adapter: Pick<GameAdapter, 'playerEvents'>, options: { clock?: () => number; intervalMs?: number } = {}) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })
    this.#clock = options.clock ?? Date.now
    this.#intervalMs = options.intervalMs ?? 5_000
    this.#db = new DatabaseSync(file)
    this.#db.exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS player_events (id TEXT PRIMARY KEY, at INTEGER NOT NULL, entry TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS player_events_at ON player_events(at);
      CREATE TABLE IF NOT EXISTS player_sessions (session TEXT PRIMARY KEY, sequence INTEGER NOT NULL, at INTEGER NOT NULL);
    `)
    this.#prune()
  }

  start(): void {
    if (this.#timer || this.#stopping) return
    void this.sample()
    this.#timer = setInterval(() => { void this.sample() }, this.#intervalMs)
    this.#timer.unref()
  }
  stop(): void { this.#stopping = true; if (this.#timer) clearInterval(this.#timer); this.#timer = null }
  async close(): Promise<void> { if (this.#closed) return; this.stop(); await this.#sampling; this.#closed = true; this.#db.close() }

  sample(): Promise<void> {
    if (this.#stopping || this.#closed) return Promise.resolve()
    if (this.#sampling) return this.#sampling
    this.#sampling = this.#sample().finally(() => { this.#sampling = null })
    return this.#sampling
  }

  async #sample(): Promise<void> {
    try {
      const batch = await this.adapter.playerEvents()
      if (this.#stopping) return
      this.#ingest(batch)
      this.#lastReadAt = new Date(this.#clock()).toISOString()
      this.#status = 'available'
    } catch { this.#status = 'unavailable' }
  }

  read(limit = 100, offset = 0): PlayerHistory {
    this.#prune()
    const rows = this.#db.prepare('SELECT entry FROM player_events ORDER BY at DESC, rowid DESC LIMIT ? OFFSET ?').all(limit, offset) as Array<{ entry: string }>
    const count = this.#db.prepare('SELECT COUNT(*) AS count FROM player_events').get() as { count: number }
    return { entries: rows.map(row => JSON.parse(row.entry) as PlayerHistoryEntry), total: count.count, status: this.#status, lastReadAt: this.#lastReadAt }
  }

  #ingest(batch: PlayerEventBatch): void {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const previous = this.#db.prepare('SELECT sequence FROM player_sessions WHERE session = ?').get(batch.sessionId) as { sequence: number } | undefined
      const last = previous?.sequence ?? 0
      if (batch.events.length && batch.lastSequence > last) {
        if (batch.firstSequence > last + 1) {
          this.#insert({ id: `${batch.sessionId}:gap:${last + 1}:${batch.firstSequence - 1}`, sessionId: batch.sessionId, playerId: null, name: null, type: 'gap', occurredAt: new Date(batch.events[0]!.observedAtUnixMs).toISOString(), missingCount: batch.firstSequence - last - 1 })
        }
        for (const event of batch.events) {
          if (event.sequence <= last) continue
          this.#insert({ id: `${batch.sessionId}:${event.sequence}`, sessionId: batch.sessionId, playerId: `${batch.sessionId}:${event.sessionPlayerId}`, name: event.displayName, type: event.type, occurredAt: new Date(event.observedAtUnixMs).toISOString(), missingCount: null })
        }
        this.#db.prepare('INSERT OR REPLACE INTO player_sessions (session, sequence, at) VALUES (?, ?, ?)').run(batch.sessionId, batch.lastSequence, batch.writtenAtUnixMs)
      }
      this.#prune()
      this.#db.exec('COMMIT')
    } catch (error) { this.#db.exec('ROLLBACK'); throw error }
  }

  #insert(entry: PlayerHistoryEntry): void {
    const time = Date.parse(entry.occurredAt)
    if (time < this.#clock() - retentionMs) return
    this.#db.prepare('INSERT OR IGNORE INTO player_events (id, at, entry) VALUES (?, ?, ?)').run(entry.id, time, JSON.stringify(entry))
  }
  #prune(): void {
    this.#db.prepare('DELETE FROM player_events WHERE at < ?').run(this.#clock() - retentionMs)
    this.#db.prepare('DELETE FROM player_events WHERE rowid IN (SELECT rowid FROM player_events ORDER BY at DESC, rowid DESC LIMIT -1 OFFSET ?)').run(maximumEntries)
    this.#db.prepare('DELETE FROM player_sessions WHERE at < ?').run(this.#clock() - retentionMs)
  }
}
