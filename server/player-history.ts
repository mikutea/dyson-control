import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import type { GameAdapter, PlayerEventBatch, PlayerHistory, PlayerHistoryEntry, PlayerHistoryFilter } from '../shared/contracts.js'
import { ApiError } from './errors.js'

const retentionMs = 30 * 24 * 60 * 60 * 1_000
const maximumEntries = 10_000
const cursorSchema = z.string().max(64).regex(/^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))?$/)
  .refine(value => {
    const parts = value.split('.').map(Number)
    return parts.every(Number.isSafeInteger) && (parts.length === 1 || parts[2]! <= parts[0]!)
  })
export const playerHistoryQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100), offset: z.coerce.number().int().min(0).max(maximumEntries).default(0),
  type: z.enum(['join', 'leave', 'firstObserved', 'gap']).optional(), name: z.string().trim().max(128).optional(), cursor: cursorSchema.optional(),
}).strict().refine(query => !query.cursor || query.offset === 0)
type HistoryRow = { at: number; rowid: number; entry: string }

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
      CREATE TABLE IF NOT EXISTS player_history_position (slot INTEGER PRIMARY KEY CHECK(slot = 1), last_rowid INTEGER NOT NULL);
      INSERT INTO player_history_position(slot, last_rowid) VALUES(1, (SELECT COALESCE(MAX(rowid), 0) FROM player_events))
        ON CONFLICT(slot) DO UPDATE SET last_rowid = MAX(last_rowid, excluded.last_rowid);
    `)
    this.#db.function('fold_display_name', { deterministic: true }, name => typeof name === 'string' ? name.toLowerCase() : '')
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

  read(limit = 100, offset = 0, filter: PlayerHistoryFilter = {}): PlayerHistory {
    this.#prune()
    const current = Number(this.#db.prepare('SELECT last_rowid FROM player_history_position WHERE slot=1').get()!.last_rowid)
    const [snapshot = current, beforeAt, beforeRow] = filter.cursor ? cursorSchema.parse(filter.cursor).split('.').map(Number) : []
    if (snapshot > current) throw new ApiError(400, 'player_history_cursor_invalid', '分页位置已失效，请返回最新记录。')
    const conditions = ['rowid <= ?'], values: Array<string | number> = [snapshot]
    if (filter.type) { conditions.push("json_extract(entry, '$.type') = ?"); values.push(filter.type) }
    if (filter.name) { conditions.push("instr(fold_display_name(json_extract(entry, '$.name')), ?) > 0"); values.push(filter.name.toLowerCase()) }
    const where = 'FROM player_events WHERE ' + conditions.join(' AND ')
    const order = 'ORDER BY at DESC, rowid DESC'
    const count = this.#db.prepare('SELECT COUNT(*) AS count ' + where).get(...values) as { count: number }
    let boundary = beforeAt === undefined ? null : { at: beforeAt, rowid: beforeRow! }
    if (offset) {
      const previous = this.#db.prepare('SELECT at, rowid ' + where + ' ' + order + ' LIMIT 1 OFFSET ?').get(...values, offset - 1)
      boundary = previous ? { at: Number(previous.at), rowid: Number(previous.rowid) } : { at: 0, rowid: 0 }
    }
    const rows = this.#db.prepare('SELECT at, rowid, entry ' + where + (boundary ? ' AND (at, rowid) < (?, ?) ' : ' ') + order + ' LIMIT ?')
      .all(...values, ...(boundary ? [boundary.at, boundary.rowid] : []), limit + 1) as HistoryRow[]
    const token = (position: { at: number; rowid: number } | null) => position ? [snapshot, position.at, position.rowid].join('.') : String(snapshot)
    return { entries: rows.slice(0, limit).map(row => JSON.parse(row.entry) as PlayerHistoryEntry), total: count.count, status: this.#status, lastReadAt: this.#lastReadAt,
      pageCursor: token(boundary), nextCursor: rows.length > limit ? token(rows[limit - 1]!) : null }
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
    // Retention can delete the highest rowid. Keep new inserts above all previously issued snapshots.
    const inserted = this.#db.prepare('INSERT OR IGNORE INTO player_events (rowid, id, at, entry) SELECT last_rowid + 1, ?, ?, ? FROM player_history_position WHERE slot=1')
      .run(entry.id, time, JSON.stringify(entry))
    if (inserted.changes) this.#db.prepare('UPDATE player_history_position SET last_rowid = ? WHERE slot=1').run(inserted.lastInsertRowid)
  }
  #prune(): void {
    this.#db.prepare('DELETE FROM player_events WHERE at < ?').run(this.#clock() - retentionMs)
    this.#db.prepare('DELETE FROM player_events WHERE rowid IN (SELECT rowid FROM player_events ORDER BY at DESC, rowid DESC LIMIT -1 OFFSET ?)').run(maximumEntries)
    this.#db.prepare('DELETE FROM player_sessions WHERE at < ?').run(this.#clock() - retentionMs)
  }
}
