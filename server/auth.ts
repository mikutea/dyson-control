import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import { ApiError } from './errors.js'

const SCRYPT_N = 16_384
const SCRYPT_R = 8
const SCRYPT_P = 1
const KEY_LENGTH = 32
const MAX_MEMORY = 64 * 1024 * 1024

export const SESSION_COOKIE = 'dyson_control_session'
export const SESSION_MAX_AGE_SECONDS = 12 * 60 * 60
export const DEFAULT_MAX_SESSIONS = 32

const DEFAULT_LOGIN_MAX_FAILURES = 5
const DEFAULT_LOGIN_WINDOW_MS = 15 * 60 * 1000
const DEFAULT_LOGIN_BLOCK_MS = 15 * 60 * 1000
const DEFAULT_LOGIN_MAX_CLIENTS = 2_048
const DEFAULT_LOGIN_MAX_CONCURRENT = 2

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 12) throw new Error('管理员密码至少需要 12 个字符。')
  const salt = randomBytes(16)
  const derived = await deriveKey(password, salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: MAX_MEMORY,
  })
  return ['scrypt', 'v1', SCRYPT_N, SCRYPT_R, SCRYPT_P, salt.toString('base64url'), derived.toString('base64url')].join('$')
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split('$')
  if (parts.length !== 7 || parts[0] !== 'scrypt' || parts[1] !== 'v1') return false
  const n = Number(parts[2])
  const r = Number(parts[3])
  const p = Number(parts[4])
  if (n !== SCRYPT_N || r !== SCRYPT_R || p !== SCRYPT_P) return false

  let salt: Buffer
  let expected: Buffer
  try {
    salt = Buffer.from(parts[5], 'base64url')
    expected = Buffer.from(parts[6], 'base64url')
  } catch {
    return false
  }
  if (salt.length !== 16 || expected.length !== KEY_LENGTH) return false

  const actual = await deriveKey(password, salt, expected.length, { N: n, r, p, maxmem: MAX_MEMORY })
  return timingSafeEqual(actual, expected)
}

function deriveKey(password: string, salt: Buffer, length: number, options: { N: number; r: number; p: number; maxmem: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, length, options, (error, derived) => {
      if (error) reject(error)
      else resolve(derived)
    })
  })
}

interface SessionRecord { expiresAt: number }

export interface SessionStoreOptions {
  maxSessions?: number
  now?: () => number
  onInvalidate?: (token: string) => void
}

export class SessionStore {
  readonly #sessions = new Map<string, SessionRecord>()
  readonly #maxSessions: number
  readonly #now: () => number
  readonly #onInvalidate?: (token: string) => void

  constructor(options: SessionStoreOptions = {}) {
    this.#maxSessions = positiveInteger(options.maxSessions ?? DEFAULT_MAX_SESSIONS, 'maxSessions')
    this.#now = options.now ?? Date.now
    this.#onInvalidate = options.onInvalidate
  }

  create(): string {
    this.#pruneExpired()
    while (this.#sessions.size >= this.#maxSessions) {
      const oldest = this.#sessions.keys().next().value as string | undefined
      if (!oldest) break
      this.#remove(oldest)
    }
    const token = randomBytes(32).toString('base64url')
    this.#sessions.set(token, { expiresAt: this.#now() + SESSION_MAX_AGE_SECONDS * 1000 })
    return token
  }

  has(token: string | undefined): boolean {
    if (!token) return false
    const session = this.#sessions.get(token)
    if (!session) return false
    if (session.expiresAt <= this.#now()) {
      this.#remove(token)
      return false
    }
    return true
  }

  delete(token: string | undefined): void {
    if (token) this.#remove(token)
  }

  close(): void {
    this.#sessions.clear()
  }

  #pruneExpired(): void {
    const now = this.#now()
    for (const [token, session] of this.#sessions) {
      if (session.expiresAt <= now) this.#remove(token)
    }
  }

  #remove(token: string): void {
    if (!this.#sessions.delete(token)) return
    this.#onInvalidate?.(token)
  }
}

interface LoginRecord {
  failures: number
  windowStartedAt: number
  blockedUntil: number
  lastSeenAt: number
}

export interface LoginGuardOptions {
  maxFailures?: number
  windowMs?: number
  blockMs?: number
  maxTrackedClients?: number
  maxConcurrent?: number
  now?: () => number
}

/** Bounds expensive password checks and failed-login state without trusting proxy headers. */
export class LoginGuard {
  readonly #records = new Map<string, LoginRecord>()
  readonly #maxFailures: number
  readonly #windowMs: number
  readonly #blockMs: number
  readonly #maxTrackedClients: number
  readonly #maxConcurrent: number
  readonly #now: () => number
  #active = 0

  constructor(options: LoginGuardOptions = {}) {
    this.#maxFailures = positiveInteger(options.maxFailures ?? DEFAULT_LOGIN_MAX_FAILURES, 'maxFailures')
    this.#windowMs = positiveInteger(options.windowMs ?? DEFAULT_LOGIN_WINDOW_MS, 'windowMs')
    this.#blockMs = positiveInteger(options.blockMs ?? DEFAULT_LOGIN_BLOCK_MS, 'blockMs')
    this.#maxTrackedClients = positiveInteger(options.maxTrackedClients ?? DEFAULT_LOGIN_MAX_CLIENTS, 'maxTrackedClients')
    this.#maxConcurrent = positiveInteger(options.maxConcurrent ?? DEFAULT_LOGIN_MAX_CONCURRENT, 'maxConcurrent')
    this.#now = options.now ?? Date.now
  }

  acquire(client: string): () => void {
    const key = this.#key(client)
    const record = this.#records.get(key)
    const now = this.#now()
    if (record?.blockedUntil && record.blockedUntil > now) {
      throw rateLimitError(record.blockedUntil - now)
    }
    if (this.#active >= this.#maxConcurrent) {
      throw new ApiError(429, 'login_busy', '登录校验正忙，请稍后重试。', { 'retry-after': '1' })
    }
    this.#active += 1
    let released = false
    return () => {
      if (released) return
      released = true
      this.#active -= 1
    }
  }

  failed(client: string): void {
    const now = this.#now()
    const key = this.#key(client)
    const previous = this.#records.get(key)
    const record = !previous || now - previous.windowStartedAt >= this.#windowMs
      ? { failures: 0, windowStartedAt: now, blockedUntil: 0, lastSeenAt: now }
      : previous
    record.failures += 1
    record.lastSeenAt = now
    if (record.failures >= this.#maxFailures) record.blockedUntil = now + this.#blockMs
    this.#records.set(key, record)
    if (record.blockedUntil > now) throw rateLimitError(record.blockedUntil - now)
  }

  succeeded(client: string): void {
    this.#records.delete(client)
  }

  #key(client: string): string {
    this.#prune()
    if (this.#records.has(client)) return client
    // Keep one shared overflow bucket so rotating client identifiers cannot grow
    // this map or evict an existing block.
    if (this.#records.size < this.#maxTrackedClients - 1) return client
    return '__overflow__'
  }

  #prune(): void {
    const now = this.#now()
    for (const [key, record] of this.#records) {
      if (record.blockedUntil <= now && now - record.lastSeenAt >= this.#windowMs) this.#records.delete(key)
    }
  }
}

function rateLimitError(milliseconds: number): ApiError {
  const seconds = Math.max(1, Math.ceil(milliseconds / 1000))
  return new ApiError(429, 'login_rate_limited', '登录失败次数过多，请稍后重试。', { 'retry-after': String(seconds) })
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`)
  return value
}
