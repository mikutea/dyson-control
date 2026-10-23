export interface HostNetworkCounterSample {
  sampledAtUnixMs: number
  adapters: Array<{ id: string; receivedBytes: string; sentBytes: string }>
}

export interface HostNetworkRates {
  receiveBytesPerSecond: number | null
  sendBytesPerSecond: number | null
}

interface NormalizedSample {
  sampledAtUnixMs: number
  adapters: Map<string, { receivedBytes: bigint; sentBytes: bigint }>
}

const unsigned64Pattern = /^(?:0|[1-9]\d{0,19})$/
const unsigned64Maximum = 18_446_744_073_709_551_615n

function normalize(sample: HostNetworkCounterSample | null | undefined): NormalizedSample | null {
  if (!sample || !Number.isSafeInteger(sample.sampledAtUnixMs) || sample.sampledAtUnixMs <= 0 ||
      !Array.isArray(sample.adapters) || sample.adapters.length === 0) return null
  const adapters = new Map<string, { receivedBytes: bigint; sentBytes: bigint }>()
  for (const adapter of sample.adapters) {
    if (!adapter || typeof adapter.id !== 'string' || adapter.id.length < 1 || adapter.id.length > 200 || adapters.has(adapter.id) ||
        !unsigned64Pattern.test(adapter.receivedBytes) || !unsigned64Pattern.test(adapter.sentBytes)) return null
    const receivedBytes = BigInt(adapter.receivedBytes)
    const sentBytes = BigInt(adapter.sentBytes)
    if (receivedBytes > unsigned64Maximum || sentBytes > unsigned64Maximum) return null
    adapters.set(adapter.id, { receivedBytes, sentBytes })
  }
  return { sampledAtUnixMs: sample.sampledAtUnixMs, adapters }
}

/** Converts host-wide cumulative physical-adapter counters into rates without bridging adapter/reset boundaries. */
export class HostNetworkRateTracker {
  #previous: NormalizedSample | null = null
  #rates: HostNetworkRates = { receiveBytesPerSecond: null, sendBytesPerSecond: null }

  update(sample: HostNetworkCounterSample | null | undefined): HostNetworkRates {
    const current = normalize(sample)
    if (!current) {
      this.#previous = null
      return this.#rates = { receiveBytesPerSecond: null, sendBytesPerSecond: null }
    }
    const previous = this.#previous
    if (!previous) {
      this.#previous = current
      return this.#rates = { receiveBytesPerSecond: null, sendBytesPerSecond: null }
    }
    if (current.sampledAtUnixMs === previous.sampledAtUnixMs) {
      return this.#rates
    }
    this.#previous = current
    this.#rates = { receiveBytesPerSecond: null, sendBytesPerSecond: null }
    const elapsedSeconds = (current.sampledAtUnixMs - previous.sampledAtUnixMs) / 1000
    if (elapsedSeconds <= 0 || current.adapters.size !== previous.adapters.size) {
      return { receiveBytesPerSecond: null, sendBytesPerSecond: null }
    }
    let receivedDelta = 0n
    let sentDelta = 0n
    for (const [id, counters] of current.adapters) {
      const prior = previous.adapters.get(id)
      if (!prior || counters.receivedBytes < prior.receivedBytes || counters.sentBytes < prior.sentBytes) {
        return { receiveBytesPerSecond: null, sendBytesPerSecond: null }
      }
      receivedDelta += counters.receivedBytes - prior.receivedBytes
      sentDelta += counters.sentBytes - prior.sentBytes
    }
    return this.#rates = {
      receiveBytesPerSecond: Number(receivedDelta) / elapsedSeconds,
      sendBytesPerSecond: Number(sentDelta) / elapsedSeconds
    }
  }
}
