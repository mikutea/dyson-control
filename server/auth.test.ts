import { describe, expect, it } from 'vitest'
import { ApiError } from './errors.js'
import { LoginGuard, SESSION_MAX_AGE_SECONDS, SessionStore } from './auth.js'

describe('bounded authentication state', () => {
  it('evicts the oldest session and invalidates expired sessions', () => {
    let now = 1_000
    const invalidated: string[] = []
    const sessions = new SessionStore({ maxSessions: 2, now: () => now, onInvalidate: (token) => invalidated.push(token) })
    const first = sessions.create()
    const second = sessions.create()
    const third = sessions.create()

    expect(sessions.has(first)).toBe(false)
    expect(sessions.has(second)).toBe(true)
    expect(sessions.has(third)).toBe(true)
    expect(invalidated).toEqual([first])

    now += SESSION_MAX_AGE_SECONDS * 1000 + 1
    expect(sessions.has(second)).toBe(false)
    expect(invalidated).toContain(second)
  })

  it('caps concurrent password work and blocks repeated failures', () => {
    let now = 5_000
    const guard = new LoginGuard({ maxFailures: 2, maxConcurrent: 1, windowMs: 60_000, blockMs: 30_000, now: () => now })
    const release = guard.acquire('client-a')
    expect(() => guard.acquire('client-b')).toThrowError(expect.objectContaining({ code: 'login_busy' }))
    release()

    guard.failed('client-a')
    expect(() => guard.failed('client-a')).toThrowError(expect.objectContaining({ code: 'login_rate_limited' }))
    expect(() => guard.acquire('client-a')).toThrowError(ApiError)

    now += 30_001
    expect(() => guard.acquire('client-a')()).not.toThrow()
  })
})
