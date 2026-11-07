import { describe, expect, it } from 'vitest'
import type { RuntimeSample, WorldClockReading } from '../shared/contracts.js'
import { EmptyWorldTracker } from './empty-world.js'

const start = Date.UTC(2026, 9, 28, 10)
const metricsId = 'a7814e58-6816-45de-b129-a1470823dd87'
const rosterId = 'e93a23fe-7ec1-4489-b62f-01a49bdd89fe'
const anotherId = '85ff5424-1858-4071-9e12-38b2bb870b06'
function row(ms: number, tick: number, clock: Partial<WorldClockReading> = {}): RuntimeSample {
  return { sampledAt: new Date(start + ms).toISOString(), state: 'running', pid: 124, playerCount: 0, cpuPercent: null, memoryBytes: null,
    diskFreeBytes: null, networkReceiveBytesPerSecond: null, networkSendBytesPerSecond: null, ups: 60, tps: 60,
    worldClock: { gameTick: tick, sessionId: metricsId, writtenAt: start + ms, rosterSessionId: rosterId,
      rosterWrittenAt: start + ms, rosterSequence: ms + 1, ...clock } }
}
function fixture() {
  const tracker = new EmptyWorldTracker('windows', 15_000, null)
  const sample = (ms: number, tick: number, clock?: Partial<WorldClockReading>) => {
    tracker.sample(row(ms, tick, clock), 'available', true, start + ms)
    return tracker.snapshot(start + ms)
  }
  return { tracker, sample }
}

describe('empty-world observation', () => {
  it('counts two fresh signed streams, never extends a reread, and measures a stall since the last actual advance', () => {
    const f = fixture()
    const first = f.sample(0, 141)
    expect(first.current).toMatchObject({ status: 'sampling', samples: 1, tickDelta: 0 })
    f.tracker.sample(row(0, 141), 'available', true, start + 4000)
    expect(f.tracker.snapshot(start + 4000)).toEqual(first)
    f.sample(5000, 144, { rosterWrittenAt: start, rosterSequence: 1 })
    expect(f.tracker.snapshot(start + 5000)).toEqual(first)
    const growing = f.sample(15_000, 149)
    expect(growing.current).toMatchObject({ samples: 2, firstTick: 141, lastTick: 149, tickDelta: 8, durationMs: 15_000, status: 'advancing' })
    for (const ms of [30_000, 45_000, 60_000]) expect(f.sample(ms, 149).current?.status).toBe('advancing')
    expect(f.sample(75_000, 149).current).toMatchObject({ tickDelta: 8, samples: 6, status: 'stalled' })
    expect(f.sample(90_000, 152).current).toMatchObject({ tickDelta: 11, status: 'advancing' })
    // No more writes: a later HTTP query cannot convert the elapsed wall time into a longer interval.
    const later = f.tracker.snapshot(start + 120_000)
    expect(later).toMatchObject({ reason: 'gap', current: null, previous: { durationMs: 90_000, tickDelta: 11 } })
  })

  it.each(['process', 'metrics-session', 'roster-session', 'tick-reset', 'gap'] as const)('starts a new interval after %s', reason => {
    const f = fixture()
    f.sample(0, 300)
    f.sample(15_000, 310)
    const ms = reason === 'gap' ? 47_000 : 30_000
    const next = row(ms, reason === 'tick-reset' ? 1 : 320)
    if (reason === 'process') next.pid = 127
    if (reason === 'metrics-session') next.worldClock!.sessionId = anotherId
    if (reason === 'roster-session') next.worldClock!.rosterSessionId = anotherId
    f.tracker.sample(next, 'available', true, start + ms)
    expect(f.tracker.snapshot(start + ms)).toMatchObject({ previous: { samples: 2, tickDelta: 10 },
      current: { samples: 1, durationMs: 0, tickDelta: 0, status: 'sampling' } })
  })

  it.each(['online', 'unknown-count', 'paused', 'unknown-host', 'busy', 'old-sample', 'skewed-roster'] as const)('breaks on %s without inventing idle time or data', reason => {
    const f = fixture()
    f.sample(0, 0)
    f.sample(15_000, 0)
    const next = row(30_000, 90)
    if (reason === 'online') next.playerCount = 2
    if (reason === 'unknown-host') next.state = 'unknown'
    if (reason === 'paused' || reason === 'old-sample') delete next.worldClock
    if (reason === 'skewed-roster') next.worldClock!.rosterWrittenAt -= 6000
    f.tracker.sample(next, reason === 'unknown-count' ? 'unavailable' : 'available', reason !== 'busy', start + 30_000)
    expect(f.tracker.snapshot(start + 30_000)).toMatchObject({ current: null, previous: { samples: 2, tickDelta: 0, durationMs: 15_000 } })
    f.tracker.sample(row(29_000, 80), 'available', true, start + 31_000)
    expect(f.tracker.snapshot(start + 31_000).current).toBeNull()
    expect(f.sample(45_000, 100).current).toMatchObject({ samples: 1, status: 'sampling' })
  })

  it('rejects stale telemetry and signed timestamp or roster sequence reversals', () => {
    const f = fixture()
    f.sample(0, 300)
    f.tracker.sample(row(0, 300), 'available', true, start + 11_000)
    expect(f.tracker.snapshot(start + 11_000)).toMatchObject({ reason: 'clock-unavailable', current: null })
    f.sample(15_000, 301)
    expect(f.sample(18_000, 303, { rosterSequence: 1 }).current).toBeNull()
    f.sample(30_000, 304)
    expect(f.sample(32_000, 305, { writtenAt: start + 29_000 }).current).toBeNull()
  })

  it('never fabricates a Windows observation from demo or historical state', () => {
    const f = fixture()
    const previous = f.sample(0, 99).current
    const demo = new EmptyWorldTracker('demo', 15_000, previous)
    demo.sample(row(15_000, 100), 'available', true, start + 15_000)
    expect(demo.snapshot(start + 15_000)).toEqual({ source: 'demo', reason: 'demo', current: null, previous: null })
    const restarted = new EmptyWorldTracker('windows', 15_000, previous)
    expect(restarted.snapshot(start + 10_000)).toMatchObject({ current: null, previous })
    expect(restarted.snapshot(start + 8 * 24 * 3600_000).previous).toBeNull()
  })
})
