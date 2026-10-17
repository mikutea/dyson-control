import { describe, expect, it } from 'vitest'
import { HostNetworkRateTracker, type HostNetworkCounterSample } from './network-metrics.js'

function sample(sampledAtUnixMs: number, adapters: HostNetworkCounterSample['adapters']): HostNetworkCounterSample {
  return { sampledAtUnixMs, adapters }
}

describe('host network rate tracker', () => {
  it('sums deltas from a stable set of physical adapters', () => {
    const tracker = new HostNetworkRateTracker()
    expect(tracker.update(sample(1_000, [
      { id: 'ethernet', receivedBytes: '1000', sentBytes: '500' },
      { id: 'wifi', receivedBytes: '2000', sentBytes: '1000' }
    ]))).toEqual({ receiveBytesPerSecond: null, sendBytesPerSecond: null })
    expect(tracker.update(sample(3_000, [
      { id: 'wifi', receivedBytes: '2600', sentBytes: '1200' },
      { id: 'ethernet', receivedBytes: '1400', sentBytes: '700' }
    ]))).toEqual({ receiveBytesPerSecond: 500, sendBytesPerSecond: 200 })
  })

  it('returns null across counter resets and establishes a fresh baseline', () => {
    const tracker = new HostNetworkRateTracker()
    tracker.update(sample(1_000, [{ id: 'ethernet', receivedBytes: '1000', sentBytes: '1000' }]))
    expect(tracker.update(sample(2_000, [{ id: 'ethernet', receivedBytes: '10', sentBytes: '20' }]))).toEqual({
      receiveBytesPerSecond: null, sendBytesPerSecond: null
    })
    expect(tracker.update(sample(3_000, [{ id: 'ethernet', receivedBytes: '110', sentBytes: '70' }]))).toEqual({
      receiveBytesPerSecond: 100, sendBytesPerSecond: 50
    })
  })

  it('returns null when the active adapter set or timestamp changes unexpectedly', () => {
    const tracker = new HostNetworkRateTracker()
    tracker.update(sample(1_000, [{ id: 'ethernet', receivedBytes: '100', sentBytes: '100' }]))
    expect(tracker.update(sample(2_000, [{ id: 'wifi', receivedBytes: '200', sentBytes: '200' }]))).toEqual({
      receiveBytesPerSecond: null, sendBytesPerSecond: null
    })
    expect(tracker.update(sample(1_500, [{ id: 'wifi', receivedBytes: '250', sentBytes: '250' }]))).toEqual({
      receiveBytesPerSecond: null, sendBytesPerSecond: null
    })
    expect(tracker.update(sample(2_500, [{ id: 'wifi', receivedBytes: '350', sentBytes: '450' }]))).toEqual({
      receiveBytesPerSecond: 100, sendBytesPerSecond: 200
    })
  })

  it('does not consume a cached sample with the same timestamp', () => {
    const tracker = new HostNetworkRateTracker()
    tracker.update(sample(1_000, [{ id: 'ethernet', receivedBytes: '100', sentBytes: '100' }]))
    expect(tracker.update(sample(1_000, [{ id: 'ethernet', receivedBytes: '100', sentBytes: '100' }]))).toEqual({
      receiveBytesPerSecond: null, sendBytesPerSecond: null
    })
    expect(tracker.update(sample(2_000, [{ id: 'ethernet', receivedBytes: '250', sentBytes: '300' }]))).toEqual({
      receiveBytesPerSecond: 150, sendBytesPerSecond: 200
    })
  })

  it('rejects malformed and duplicate counters without retaining a stale baseline', () => {
    const tracker = new HostNetworkRateTracker()
    tracker.update(sample(1_000, [{ id: 'ethernet', receivedBytes: '100', sentBytes: '100' }]))
    expect(tracker.update(sample(2_000, [
      { id: 'ethernet', receivedBytes: '200', sentBytes: '200' },
      { id: 'ethernet', receivedBytes: '300', sentBytes: '300' }
    ]))).toEqual({ receiveBytesPerSecond: null, sendBytesPerSecond: null })
    expect(tracker.update(sample(3_000, [{ id: 'ethernet', receivedBytes: '400', sentBytes: '400' }]))).toEqual({
      receiveBytesPerSecond: null, sendBytesPerSecond: null
    })
  })

  it('keeps rates unavailable when the host reports no active physical adapters', () => {
    const tracker = new HostNetworkRateTracker()
    expect(tracker.update(sample(1_000, []))).toEqual({ receiveBytesPerSecond: null, sendBytesPerSecond: null })
    expect(tracker.update(sample(2_000, []))).toEqual({ receiveBytesPerSecond: null, sendBytesPerSecond: null })
  })
})
