import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import { fileURLToPath } from 'node:url'
import type { ControlConfig, SteamAuthState, SteamAuthStatus } from '../shared/contracts.js'
import { ApiError } from './errors.js'
import { acquireSteamProcess } from './game/steam-process.js'
import { parsePublicBuild, runSteamCommand, type SteamCommandRunner } from './game/steam-update.js'

const accountPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/
const activeStates = new Set<SteamAuthState>(['starting', 'password', 'guard', 'approval', 'verifying'])
const messages: Record<SteamAuthState, string> = {
  idle: '尚未验证 Steam 授权。', starting: '正在连接 Steam…', password: '请输入 Steam 密码。',
  guard: '请输入 Steam Guard 验证码。', approval: '请在 Steam 手机应用中批准登录。',
  verifying: '正在验证无需再次输入密码的版本查询…', authorized: '授权可用，已完成只读版本查询。',
  failed: '登录未完成。请检查账号、密码或验证码后重新开始。', cancelled: '本次授权已取消。',
}

export function steamExecutable(config: ControlConfig): string {
  return config.game.steam?.executable ?? path.join(config.dataDirectory, 'steamcmd', 'steamcmd.exe')
}

export interface SteamAuthOptions {
  spawn?: (executable: string, args: string[], cwd: string) => ChildProcessWithoutNullStreams
  run?: SteamCommandRunner
  timeoutMs?: number
  clock?: () => number
}

interface Attempt {
  owner: string; account: string; status: SteamAuthStatus; child: ChildProcessWithoutNullStreams | null
  controller: AbortController; done: Promise<void>; finish: () => void; timer: NodeJS.Timeout
  buffer: string; outputBytes: number; release: (() => void) | null; stopping: boolean
}

/** Only structured prompt states leave this class. Steam output, password and Guard codes never enter jobs or logs. */
export class SteamAuthManager {
  readonly #config: ControlConfig
  readonly #options: SteamAuthOptions
  readonly #clock: () => number
  readonly #configuredAccount: string | null
  #attempt: Attempt | null = null
  #lastStart = -Infinity
  #closed = false
  #verifiedAt: string | null = null
  #latestBuild: string | null = null

  constructor(config: ControlConfig, options: SteamAuthOptions = {}) {
    this.#config = config
    this.#options = options
    this.#clock = options.clock ?? Date.now
    this.#configuredAccount = config.game.steam?.accountName ?? null
  }

  async initialize(): Promise<void> {
    if (this.#config.game.steam) return
    const file = path.join(this.#config.dataDirectory, 'steam-account.json')
    const stat = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error))
    if (!stat) return
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024) throw new Error('Steam account settings are invalid.')
    const value = JSON.parse(await fs.readFile(file, 'utf8')) as { schema?: unknown; accountName?: unknown }
    if (value.schema !== 1 || typeof value.accountName !== 'string' || !accountPattern.test(value.accountName)) throw new Error('Steam account settings are invalid.')
    this.#config.game.steam = { executable: steamExecutable(this.#config), accountName: value.accountName }
  }

  get busy(): boolean { return !!this.#attempt && (activeStates.has(this.#attempt.status.state) || this.#attempt.child !== null) }

  status(owner: string): SteamAuthStatus {
    if (this.#attempt && this.#attempt.owner === owner) return { ...this.#attempt.status }
    return { id: null, state: this.#verifiedAt ? 'authorized' : 'idle', promptId: 0,
      message: this.busy ? '另一个管理会话正在授权。' : this.#verifiedAt ? messages.authorized : messages.idle,
      expiresAt: null, verifiedAt: this.#verifiedAt, latestBuild: this.#latestBuild }
  }

  async start(owner: string, account: string): Promise<SteamAuthStatus> {
    if (this.#config.mode !== 'windows') throw new ApiError(501, 'windows_required', 'Steam 授权需要 Windows 服务器。')
    if (this.#closed) throw new ApiError(503, 'shutting_down', '控制服务正在关闭。')
    if (!accountPattern.test(account)) throw new ApiError(400, 'invalid_account', 'Steam 账号格式不正确。')
    if (this.#configuredAccount && this.#configuredAccount !== account) throw new ApiError(409, 'account_mismatch', '请使用当前配置中的 Steam 账号。')
    if (this.busy) throw new ApiError(409, 'steam_auth_busy', '已有授权或版本查询正在进行。')
    if (this.#clock() - this.#lastStart < 3000) throw new ApiError(429, 'steam_auth_rate_limit', '请稍等片刻再重新授权。')
    this.#lastStart = this.#clock()
    const executable = steamExecutable(this.#config)
    const stat = await fs.lstat(executable).catch(() => null)
    if (!stat?.isFile() || stat.isSymbolicLink()) throw new ApiError(409, 'steamcmd_missing', '请先准备 SteamCMD。')
    const release = acquireSteamProcess(executable)
    let finish!: () => void
    const done = new Promise<void>(resolve => { finish = resolve })
    const timeoutMs = this.#options.timeoutMs ?? 10 * 60_000
    const attempt: Attempt = {
      owner, account, child: null, controller: new AbortController(), done, finish, buffer: '', outputBytes: 0, release, stopping: false,
      status: { id: randomUUID(), state: 'starting', promptId: 0, message: messages.starting,
        expiresAt: new Date(this.#clock() + timeoutMs).toISOString(), verifiedAt: null, latestBuild: null },
      timer: setTimeout(() => this.#stop(attempt, 'failed', '授权已超时，请重新开始。'), timeoutMs),
    }
    attempt.timer.unref()
    this.#attempt = attempt
    this.#verifiedAt = null
    this.#latestBuild = null
    try {
      const child = this.#options.spawn
        ? this.#options.spawn(executable, ['+login', account, '+quit'], path.dirname(executable))
        : spawn(process.execPath, [fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './steam-terminal.ts' : './steam-terminal.js', import.meta.url)), executable, account], {
          cwd: path.dirname(executable), windowsHide: true, shell: false, stdio: 'pipe',
        })
      attempt.child = child
      child.stdin.on('error', () => this.#stop(attempt, 'failed'))
      child.stdout.on('data', (chunk: Buffer) => this.#output(attempt, chunk))
      child.stderr.on('data', (chunk: Buffer) => this.#output(attempt, chunk))
      child.once('error', () => this.#stop(attempt, 'failed', 'SteamCMD 未能启动。'))
      child.once('close', code => { void this.#exited(attempt, code) })
    } catch {
      release(); attempt.release = null; clearTimeout(attempt.timer)
      this.#set(attempt, 'failed', 'SteamCMD 未能启动。'); finish()
    }
    return this.status(owner)
  }

  input(owner: string, id: string, promptId: number, value: string): SteamAuthStatus {
    const attempt = this.#owned(owner, id)
    if (!['password', 'guard'].includes(attempt.status.state) || attempt.status.promptId !== promptId || attempt.stopping) {
      throw new ApiError(409, 'steam_prompt_changed', '授权提示已改变，请按当前提示输入。')
    }
    if (!value || value.length > 256 || /[\x00-\x1f\x7f]/.test(value) || (attempt.status.state === 'guard' && !/^[A-Za-z0-9]{4,16}$/.test(value))) {
      throw new ApiError(400, 'steam_input_invalid', '输入格式不正确。')
    }
    // Never pass credentials as command arguments, environment variables, or durable job input.
    attempt.buffer = ''
    this.#set(attempt, 'starting')
    try { attempt.child!.stdin.write(`${value}\n`) }
    catch { this.#stop(attempt, 'failed') }
    return this.status(owner)
  }

  async cancel(owner: string, id: string): Promise<SteamAuthStatus> {
    const attempt = this.#owned(owner, id)
    this.#stop(attempt, 'cancelled')
    await attempt.done
    return this.status(owner)
  }

  invalidate(owner: string): void {
    if (this.#attempt?.owner === owner && this.busy) this.#stop(this.#attempt, 'cancelled')
  }

  async close(): Promise<void> {
    this.#closed = true
    if (this.#attempt) { this.#stop(this.#attempt, 'cancelled'); await this.#attempt.done }
  }

  #owned(owner: string, id: string): Attempt {
    if (!this.#attempt || this.#attempt.owner !== owner || this.#attempt.status.id !== id) throw new ApiError(404, 'steam_auth_not_found', '授权会话不存在或已过期。')
    return this.#attempt
  }

  #set(attempt: Attempt, state: SteamAuthState, message = messages[state]): void {
    if (attempt.status.state !== state) attempt.status.promptId++
    attempt.status.state = state
    attempt.status.message = message
    if (!activeStates.has(state)) attempt.status.expiresAt = null
  }

  #output(attempt: Attempt, chunk: Buffer): void {
    if (attempt.stopping) return
    attempt.outputBytes += chunk.length
    if (attempt.outputBytes > 1024 * 1024) { this.#stop(attempt, 'failed', 'SteamCMD 输出异常，授权已停止。'); return }
    attempt.buffer = (attempt.buffer + stripVTControlCharacters(chunk.toString('utf8'))).slice(-8192)
    if (/(?:invalid password|invalid login auth code|incorrect[^\r\n]*code|account logon denied|login failure|rate limit exceeded|too many login failures|(?:^|\n)Steam>)/i.test(attempt.buffer)) {
      this.#stop(attempt, 'failed'); return
    }
    if (/(?:Steam Guard code|two[- ]factor (?:auth(?:entication)? )?code|auth(?:entication)? code)\s*:/i.test(attempt.buffer)) this.#set(attempt, 'guard')
    else if (/(?:password\s*:|enter (?:your )?password\s*:)/i.test(attempt.buffer)) this.#set(attempt, 'password')
    else if (/(?:confirm.*(?:mobile|Steam app)|check.*Steam.*app|waiting for.*(?:confirmation|approval))/i.test(attempt.buffer)) this.#set(attempt, 'approval')
  }

  #stop(attempt: Attempt, state: 'failed' | 'cancelled', message?: string): void {
    if (!activeStates.has(attempt.status.state) && !attempt.child) return
    if (attempt.stopping) return
    attempt.stopping = true
    this.#set(attempt, state, message)
    attempt.buffer = ''
    attempt.controller.abort()
    const child = attempt.child
    if (child && child.exitCode === null && child.signalCode === null) {
      if (process.platform === 'win32' && child.pid) {
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' })
        killer.once('error', () => { child.kill() })
        killer.once('close', () => { if (child.exitCode === null && child.signalCode === null) child.kill() })
      } else child.kill('SIGKILL')
    }
  }

  async #exited(attempt: Attempt, code: number | null): Promise<void> {
    attempt.child = null
    attempt.buffer = ''
    attempt.release?.(); attempt.release = null
    try {
      if (attempt.stopping) return
      if (code !== 0) { this.#set(attempt, 'failed'); return }
      this.#set(attempt, 'verifying')
      const result = await (this.#options.run ?? runSteamCommand)({
        executable: steamExecutable(this.#config), args: ['+login', attempt.account, '+app_info_update', '1', '+app_info_print', '1366540', '+quit'],
        cwd: path.dirname(steamExecutable(this.#config)), signal: attempt.controller.signal, timeoutMs: 90_000,
      })
      attempt.controller.signal.throwIfAborted()
      if (result.exitCode !== 0 || result.timedOut) throw new Error('Verification failed')
      const latestBuild = parsePublicBuild(`${result.stdout}\n${result.stderr}`)
      if (/(?:invalid password|cached credentials not found|Steam Guard code:|password\s*:)/i.test(`${result.stdout}\n${result.stderr}`)) throw new Error('Authorization was not reusable')
      if (!this.#configuredAccount) {
        await fs.mkdir(this.#config.dataDirectory, { recursive: true })
        const file = path.join(this.#config.dataDirectory, 'steam-account.json')
        const temporary = `${file}.${randomUUID()}.tmp`
        await fs.writeFile(temporary, JSON.stringify({ schema: 1, accountName: attempt.account }) + '\n', { mode: 0o600, flag: 'wx' })
        try { await fs.rename(temporary, file) } finally { await fs.rm(temporary, { force: true }) }
        this.#config.game.steam = { executable: steamExecutable(this.#config), accountName: attempt.account }
      }
      attempt.controller.signal.throwIfAborted()
      this.#verifiedAt = new Date(this.#clock()).toISOString()
      this.#latestBuild = latestBuild
      attempt.status.verifiedAt = this.#verifiedAt
      attempt.status.latestBuild = latestBuild
      this.#set(attempt, 'authorized')
    } catch {
      if (!attempt.stopping) this.#set(attempt, 'failed', '登录后仍无法复用授权查询版本，请重新授权。')
    } finally { clearTimeout(attempt.timer); attempt.finish() }
  }
}
