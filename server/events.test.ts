import type { ServerResponse } from 'node:http'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import type { GameAdapter, Overview } from '../shared/contracts.js'
import { EventHub } from './events.js'

const overview: Overview = {
  name: 'Fixture', source: 'demo', state: 'stopped', sampledAt: new Date(0).toISOString(), address: '127.0.0.1:8469',
  pid: null, uptimeSeconds: 0, playerCount: 0, playerStatus: 'available', maxPlayers: 16,
  versions: { game: '1', nebula: '1', bepinex: '1' },
  metrics: { cpuPercent: null, memoryBytes: null, totalMemoryBytes: null, diskFreeBytes: null, ups: null, tps: null, networkReceiveBytesPerSecond: null, networkSendBytesPerSecond: null },
  currentSave: null, lastSavedAt: null, capabilities: { lifecycle: true, save: true, restore: true, playerActions: false },
}

describe('authenticated server-sent events', () => {
  it('does not reopen a stream after shutdown while a final sample is pending', async () => {
    let finish!: (value: Overview) => void
    const adapter = { overview: () => new Promise<Overview>(resolve => { finish = resolve }) } as GameAdapter
    const hub = new EventHub(adapter)
    const response = new PassThrough()
    response.resume()
    hub.subscribe(response as unknown as ServerResponse, 'session-a')
    hub.close()
    finish(overview)
    await Promise.resolve()
    expect(response.writableEnded).toBe(true)
    expect(hub.hasCapacity).toBe(false)
    const late = new PassThrough()
    expect(() => hub.subscribe(late as unknown as ServerResponse, 'session-a')).toThrow()
    expect(late.writableLength).toBe(0)
    late.destroy()
  })

  it('closes streams immediately when their session is invalidated', async () => {
    const adapter = { overview: async () => overview } as GameAdapter
    const hub = new EventHub(adapter, () => true, { pollIntervalMs: 10 })
    const response = new PassThrough()
    const ended = new Promise<void>((resolve) => response.once('end', resolve))
    response.resume()
    hub.subscribe(response as unknown as ServerResponse, 'session-a')
    hub.closeSession('session-a')
    await ended
    expect(response.writableEnded).toBe(true)
    hub.close()
  })

  it('rechecks session validity while a stream remains open', async () => {
    let valid = true
    const adapter = { overview: async () => overview } as GameAdapter
    const hub = new EventHub(adapter, () => valid, { pollIntervalMs: 10 })
    const response = new PassThrough()
    const ended = new Promise<void>((resolve) => response.once('end', resolve))
    response.resume()
    hub.subscribe(response as unknown as ServerResponse, 'session-a')
    valid = false
    await ended
    expect(response.writableEnded).toBe(true)
    hub.close()
  })
})
