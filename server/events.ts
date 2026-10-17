import type { ServerResponse } from 'node:http'
import type { GameAdapter, Job, Overview } from '../shared/contracts.js'

interface EventClient {
  response: ServerResponse
  sessionToken: string
}

export interface EventHubOptions {
  maxClients?: number
  pollIntervalMs?: number
}

export class EventHub {
  readonly #clients = new Set<EventClient>()
  readonly #maxClients: number
  readonly #pollIntervalMs: number
  #pollTimer: NodeJS.Timeout | null = null
  #sampling = false

  constructor(
    private readonly adapter: GameAdapter,
    private readonly isSessionValid: (token: string) => boolean = () => true,
    options: EventHubOptions = {},
  ) {
    this.#maxClients = options.maxClients ?? 32
    this.#pollIntervalMs = options.pollIntervalMs ?? 5_000
    if (!Number.isSafeInteger(this.#maxClients) || this.#maxClients < 1) throw new Error('maxClients must be a positive integer.')
    if (!Number.isSafeInteger(this.#pollIntervalMs) || this.#pollIntervalMs < 10) throw new Error('pollIntervalMs must be at least 10.')
  }

  get hasCapacity(): boolean {
    return this.#clients.size < this.#maxClients
  }

  subscribe(response: ServerResponse, sessionToken = ''): () => void {
    if (!this.hasCapacity) throw new Error('SSE client capacity exceeded.')
    const client = { response, sessionToken }
    this.#clients.add(client)
    if (!this.#write(client, 'retry: 3000\n\n')) return () => undefined
    this.#ensurePolling()
    void this.sampleOverview()
    return () => {
      this.#clients.delete(client)
      if (this.#clients.size === 0 && this.#pollTimer) {
        clearInterval(this.#pollTimer)
        this.#pollTimer = null
      }
    }
  }

  closeSession(sessionToken: string): void {
    for (const client of [...this.#clients]) {
      if (client.sessionToken === sessionToken) this.#closeClient(client)
    }
  }

  publishJob(job: Job): void {
    this.#publish('job', job)
    if (job.state === 'succeeded' || job.state === 'failed' || job.state === 'interrupted') {
      void this.sampleOverview()
    }
  }

  publishOverview(overview: Overview): void {
    this.#publish('overview', overview)
  }

  async sampleOverview(): Promise<void> {
    this.#removeInvalidClients()
    if (this.#sampling || this.#clients.size === 0) return
    this.#sampling = true
    try {
      this.publishOverview(await this.adapter.overview())
    } catch {
      // A failed sample is exposed by the regular overview endpoint; the stream stays usable.
    } finally {
      this.#sampling = false
    }
  }

  close(): void {
    if (this.#pollTimer) clearInterval(this.#pollTimer)
    this.#pollTimer = null
    for (const client of [...this.#clients]) this.#closeClient(client)
    this.#clients.clear()
  }

  #ensurePolling(): void {
    if (this.#pollTimer) return
    this.#pollTimer = setInterval(() => {
      this.#removeInvalidClients()
      for (const client of [...this.#clients]) {
        this.#write(client, ': keep-alive\n\n')
      }
      void this.sampleOverview()
    }, this.#pollIntervalMs)
    this.#pollTimer.unref()
  }

  #publish(event: 'job' | 'overview', value: Job | Overview): void {
    const frame = `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`
    for (const client of [...this.#clients]) {
      if (!this.isSessionValid(client.sessionToken) || client.response.destroyed || client.response.writableEnded) {
        this.#closeClient(client)
      } else {
        this.#write(client, frame)
      }
    }
  }

  #removeInvalidClients(): void {
    for (const client of [...this.#clients]) {
      if (!this.isSessionValid(client.sessionToken) || client.response.destroyed || client.response.writableEnded) {
        this.#closeClient(client)
      }
    }
  }

  #closeClient(client: EventClient): void {
    if (!this.#clients.delete(client)) return
    try {
      if (!client.response.writableEnded) client.response.end()
    } catch {
      client.response.destroy()
    }
    if (this.#clients.size === 0 && this.#pollTimer) {
      clearInterval(this.#pollTimer)
      this.#pollTimer = null
    }
  }

  #write(client: EventClient, value: string): boolean {
    try {
      if (client.response.write(value)) return true
    } catch {
      // The connection disappeared between validation and write.
    }
    this.#closeClient(client)
    return false
  }
}
