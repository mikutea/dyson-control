import type { EmptyWorldInterval, EmptyWorldObservation, Overview, RuntimeSample, WorldClockReading } from '../shared/contracts.js'

const minute = 60_000
const retention = 7 * 24 * 60 * minute
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i
type Reason = EmptyWorldObservation['reason']
type Cursor = { clock: WorldClockReading; pid: number; readAt: number }

function freshClock(clock: WorldClockReading | null | undefined, now: number): clock is WorldClockReading {
  return Boolean(clock && uuid.test(clock.sessionId) && uuid.test(clock.rosterSessionId) &&
    Number.isSafeInteger(clock.gameTick) && clock.gameTick >= 0 && Number.isSafeInteger(clock.rosterSequence) && clock.rosterSequence > 0 &&
    [clock.writtenAt, clock.rosterWrittenAt].every(time => Number.isSafeInteger(time) && time > 0 && now - time >= -5_000 && now - time <= 10_000) &&
    Math.abs(clock.writtenAt - clock.rosterWrittenAt) <= 5_000)
}

/** Tracks only the continuous run of qualifying samples and its most recent predecessor. */
export class EmptyWorldTracker {
  readonly #maxGap: number
  #reason: Reason = 'waiting'
  #current: EmptyWorldInterval | null = null
  #previous: EmptyWorldInterval | null
  #cursor: Cursor | null = null
  #boundaryAt = 0

  constructor(private readonly source: 'windows' | 'demo', intervalMs: number, previous: EmptyWorldInterval | null) {
    // The default 15 s sampler may jitter; a missed 30 s interval starts a new observation.
    this.#maxGap = Math.min(30_000, Math.max(10_000, intervalMs + 10_000))
    this.#previous = source === 'windows' ? previous : null
    if (this.#previous) this.#boundaryAt = Date.parse(this.#previous.lastObservedAt)
  }

  get #latest(): EmptyWorldInterval | null { return this.#current ?? this.#previous }

  interrupt(reason: Reason, now: number): void {
    this.#previous = this.#latest
    this.#current = null
    this.#cursor = null
    this.#reason = reason
    this.#boundaryAt = Math.max(this.#boundaryAt, now, this.#previous ? Date.parse(this.#previous.lastObservedAt) : 0)
  }

  sample(sample: RuntimeSample, playerStatus: Overview['playerStatus'], idle: boolean, now: number): void {
    if (this.source === 'demo') return
    if (!idle) return this.interrupt('operation', now)
    if (sample.state !== 'running' || !Number.isSafeInteger(sample.pid) || sample.pid! <= 0) return this.interrupt('server-not-running', now)
    if (playerStatus !== 'available' || !Number.isSafeInteger(sample.playerCount) || sample.playerCount! < 0) return this.interrupt('roster-unavailable', now)
    if (sample.playerCount !== 0) return this.interrupt('players-online', now)
    const clock = sample.worldClock
    if (!freshClock(clock, now)) return this.interrupt('clock-unavailable', now)
    // Do not restart on a metric or roster that was published before the intervening operation or failed sample.
    if (Math.min(clock.writtenAt, clock.rosterWrittenAt) <= this.#boundaryAt) return
    const last = this.#cursor
    if (last && this.#current) {
      const before = last.clock
      const sameSession = last.pid === sample.pid && before.sessionId === clock.sessionId && before.rosterSessionId === clock.rosterSessionId
      if (sameSession) {
        if (now < last.readAt || clock.writtenAt < before.writtenAt || clock.rosterWrittenAt < before.rosterWrittenAt ||
            clock.rosterSequence < before.rosterSequence || (clock.writtenAt === before.writtenAt && clock.gameTick !== before.gameTick) ||
            (clock.rosterSequence === before.rosterSequence && clock.rosterWrittenAt !== before.rosterWrittenAt)) {
          return this.interrupt('clock-unavailable', now)
        }
        // A second HTTP read of either signed file cannot extend the interval.
        if (clock.writtenAt === before.writtenAt || clock.rosterSequence === before.rosterSequence || clock.rosterWrittenAt === before.rosterWrittenAt) {
          if (clock.gameTick < before.gameTick || now - last.readAt > this.#maxGap) this.interrupt('gap', now)
          return
        }
      }
      if (!sameSession || clock.gameTick < before.gameTick || now - last.readAt > this.#maxGap ||
          clock.writtenAt - before.writtenAt > this.#maxGap || clock.rosterWrittenAt - before.rosterWrittenAt > this.#maxGap) {
        this.#previous = this.#current
        this.#current = null
      }
    }
    const at = new Date(clock.writtenAt).toISOString()
    if (!this.#current) {
      this.#current = { startedAt: at, lastObservedAt: at, durationMs: 0, samples: 1, firstTick: clock.gameTick, lastTick: clock.gameTick,
        tickDelta: 0, lastAdvanceAt: null, status: 'sampling' }
    } else {
      const current = this.#current
      const lastAdvanceAt = clock.gameTick > current.lastTick ? at : current.lastAdvanceAt
      const tickDelta = clock.gameTick - current.firstTick
      const stalled = clock.writtenAt - Date.parse(lastAdvanceAt ?? current.startedAt) >= minute
      this.#current = { ...current, lastObservedAt: at, durationMs: clock.writtenAt - Date.parse(current.startedAt), samples: current.samples + 1,
        lastTick: clock.gameTick, tickDelta, lastAdvanceAt, status: stalled ? 'stalled' : tickDelta > 0 ? 'advancing' : 'sampling' }
    }
    this.#cursor = { clock, pid: sample.pid!, readAt: now }
    this.#reason = 'observing'
  }

  snapshot(now: number, maintenance = false): EmptyWorldObservation {
    if (this.source === 'demo') return { source: 'demo', reason: 'demo', current: null, previous: null }
    const stale = this.#cursor && (now < this.#cursor.readAt || now - Math.min(this.#cursor.readAt,
      this.#cursor.clock.writtenAt, this.#cursor.clock.rosterWrittenAt) > this.#maxGap)
    const ended = maintenance || stale
    const previous = ended ? this.#latest : this.#previous
    return { source: 'windows', reason: maintenance ? 'operation' : stale ? 'gap' : this.#reason, current: ended ? null : this.#current,
      previous: previous && Date.parse(previous.lastObservedAt) <= now + 5_000 && now - Date.parse(previous.lastObservedAt) <= retention ? previous : null }
  }
}
