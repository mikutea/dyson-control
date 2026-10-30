import cookie from '@fastify/cookie'
import fastifyStatic from '@fastify/static'
import Fastify, { LogController, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import { createReadStream, existsSync } from 'node:fs'
import { lstat } from 'node:fs/promises'
import { resolve, basename, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { z, ZodError } from 'zod'
import type { Action, ActionRequest, ControlConfig, GameAdapter, Session } from '../shared/contracts.js'
import { LoginGuard, SESSION_COOKIE, SESSION_MAX_AGE_SECONDS, SessionStore, verifyPassword } from './auth.js'
import { ApiError } from './errors.js'
import { EventHub } from './events.js'
import { loadHealthIdentity, MaintenanceGate } from './health.js'
import { JobQueue, JobStore } from './jobs.js'
import { RuntimeMonitor, runtimeSettingsSchema } from './runtime.js'
import { PlayerHistoryStore } from './player-history.js'
import { BackupUploadStore, MAX_BACKUP_UPLOAD_BYTES } from './uploads.js'
import { createGameAdapter, GameAdapterError } from './game/index.js'
import { playerIdPattern } from './game/bridge.js'
import { ControlUpdateError, ControlUpdateManager } from './control-updates.js'
import { SteamAuthManager } from './steam-auth.js'
import { ServerSetupManager } from './server-setup.js'

const emptyObjectSchema = z.object({}).strict()
const REQUEST_TIMEOUT_MS = 30 * 60 * 1_000
const idSchema = z.string().trim().min(1).max(256)
const requestIdSchema = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/)
const actionSchema = z.enum(['start', 'save', 'stop', 'restart', 'load-save', 'backup', 'verify-backup', 'restore', 'import-backup', 'install-update', 'set-version-lock', 'set-mod-side', 'install-mod', 'rollback-update', 'toggle-mod', 'remove-mod', 'restore-removed-mod', 'write-mod-config', 'rollback-mod-config', 'write-settings', 'rollback-settings', 'create-client-package', 'kick-player', 'prepare-steamcmd', 'install-server'])
const settingsSchema = z.object({
  serverName: z.string().trim().min(1).max(80).regex(/^[^\r\n\0]+$/u),
  maxPlayers: z.number().int().min(1).max(256).nullable(),
  targetUps: z.number().int().min(1).max(240),
  autosaveMinutes: z.number().int().min(1).max(24 * 60).nullable(),
  backupKeep: z.number().int().min(1).max(1_000),
  address: z.string().trim().min(1).max(255).regex(/^[^\s\0]+$/u),
  readOnlyFields: z.array(z.enum(['maxPlayers', 'targetUps', 'autosaveMinutes'])).max(3).optional(),
}).strict().transform(({ readOnlyFields: _readOnlyFields, ...settings }) => settings)

const actionInputSchemas: Record<Action, z.ZodType<Record<string, unknown>>> = {
  'prepare-steamcmd': emptyObjectSchema,
  'install-server': z.object({ gameUser: z.string().trim().min(1).max(80).regex(/^[^\\/\r\n\0]+$/u) }).strict(),
  start: emptyObjectSchema,
  save: emptyObjectSchema,
  stop: emptyObjectSchema,
  restart: emptyObjectSchema,
  'load-save': z.object({ saveId: idSchema }).strict(),
  backup: z.object({ saveId: idSchema.optional() }).strict(),
  'verify-backup': z.object({ backupId: idSchema }).strict(),
  restore: z.object({ backupId: idSchema }).strict(),
  'import-backup': z.object({ uploadId: z.string().uuid() }).strict(),
  'install-update': z.object({ component: z.enum(['game', 'nebula', 'bepinex']), version: z.string().trim().min(1).max(100).optional() }).strict(),
  'set-version-lock': z.object({ component: z.enum(['game', 'nebula', 'bepinex']).optional(), modId: idSchema.optional(), locked: z.boolean() }).strict().refine(value => Boolean(value.component) !== Boolean(value.modId), '指定一个组件或模组。'),
  'set-mod-side': z.object({ modId: idSchema, expectedVersion: z.string().min(1).max(100), side: z.enum(['both', 'server', 'client']) }).strict(),
  'install-mod': z.object({ package: z.string().regex(/^[A-Za-z0-9_]+-[A-Za-z0-9_]+$/).max(200), version: z.string().trim().min(1).max(100).optional() }).strict(),
  'rollback-update': z.object({ historyId: idSchema }).strict(),
  'toggle-mod': z.object({ modId: idSchema, enabled: z.boolean() }).strict(),
  'remove-mod': z.object({ modId: idSchema, expectedVersion: z.string().min(1).max(100) }).strict(),
  'restore-removed-mod': z.object({ historyId: idSchema }).strict(),
  'write-mod-config': z.object({ configId: idSchema, content: z.string().max(256 * 1024), expectedRevision: z.string().regex(/^[0-9a-f]{64}$/) }).strict(),
  'rollback-mod-config': z.object({ historyId: idSchema, expectedRevision: z.string().regex(/^[0-9a-f]{64}$/) }).strict(),
  'write-settings': z.object({ settings: settingsSchema }).strict(),
  'rollback-settings': z.object({ historyId: idSchema }).strict(),
  'create-client-package': emptyObjectSchema,
  'kick-player': z.object({ playerId: z.string().regex(playerIdPattern) }).strict(),
}

export interface BuildAppOptions {
  config: ControlConfig
  adapter?: GameAdapter
  databasePath?: string
  webRoot?: string
  logger?: boolean
  loginGuard?: LoginGuard
  maxSessions?: number
  maxSseClients?: number
  maxOutstandingJobs?: number
  jobTimeoutMs?: number
  runtimeOptions?: { clock?: () => number; intervalMs?: number }
  steamAuth?: SteamAuthManager
  serverSetup?: Pick<ServerSetupManager, 'status' | 'prepareSteam' | 'install'>
  controlUpdates?: Pick<ControlUpdateManager, 'initialize' | 'discover' | 'prepare' | 'apply' | 'discard' | 'read' | 'readWithReceipt' | 'history' | 'close'>
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const healthIdentity = await loadHealthIdentity()
  const app = Fastify({
    logger: options.logger ?? false,
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 64 * 1024,
    requestTimeout: REQUEST_TIMEOUT_MS,
    trustProxy: (address, hop) => hop === 0 && isLoopbackAddress(address),
  })
  const steamAuth = options.steamAuth ?? new SteamAuthManager(options.config)
  await steamAuth.initialize()
  const setup = options.serverSetup ?? new ServerSetupManager(options.config, steamAuth)
  const adapter = options.adapter ?? await createGameAdapter(options.config)
  const store = new JobStore(options.databasePath ?? resolve(options.config.dataDirectory, 'control.sqlite'))
  const recoveredJobs = store.recoverInterruptedJobs()
  const uploads = new BackupUploadStore(options.config.dataDirectory)
  await uploads.initialize((requestId) => store.findByRequestId(requestId))
  const queue = new JobQueue(store, adapter, {
    maxOutstandingJobs: options.maxOutstandingJobs,
    jobTimeoutMs: options.jobTimeoutMs,
    execute: (action, input, report, signal) => action === 'prepare-steamcmd' ? setup.prepareSteam(report, signal)
      : action === 'install-server' ? setup.install(String(input.gameUser), report, signal)
      : adapter.run(action, input, report, signal),
  })
  const maintenance = new MaintenanceGate(
    options.config.dataDirectory,
    () => queue.pauseAccepting(),
    () => queue.resumeAccepting(),
  )
  await maintenance.refresh()
  const runtime = new RuntimeMonitor(resolve(options.config.dataDirectory, 'runtime.sqlite'), adapter, queue, store, { ...options.runtimeOptions, recoveredJobs })
  const playerHistory = new PlayerHistoryStore(resolve(options.config.dataDirectory, 'players.sqlite'), adapter)
  const controlUpdates = options.controlUpdates ?? new ControlUpdateManager({ config: options.config, currentVersion: healthIdentity.version })
  await controlUpdates.initialize()
  let events: EventHub
  const sessions = new SessionStore({ maxSessions: options.maxSessions, onInvalidate: (token) => { events.closeSession(token); steamAuth.invalidate(token) } })
  events = new EventHub(adapter, (token) => sessions.has(token), { maxClients: options.maxSseClients })
  const loginGuard = options.loginGuard ?? new LoginGuard()
  const activeUploads = new Map<string, AbortController>()
  queue.on('job', (job) => events.publishJob(job))

  app.addContentTypeParser('application/zip', (_request, payload, done) => done(null, payload))
  await app.register(cookie)

  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff')
    reply.header('x-frame-options', 'DENY')
    reply.header('referrer-policy', 'no-referrer')
    reply.header('permissions-policy', 'camera=(), microphone=(), geolocation=()')
    reply.header('content-security-policy', "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'")
    if (request.routeOptions.url?.startsWith('/api/') || request.url.startsWith('/api/')) reply.header('cache-control', 'no-store')
    return payload
  })

  app.addHook('preHandler', async (request) => {
    if (!request.routeOptions.url?.startsWith('/api/') && !request.url.startsWith('/api/')) return
    const maintenanceStatus = await maintenance.refresh()
    if (!maintenanceStatus.accepting && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) {
      throw new ApiError(503, 'maintenance_active', '控制服务正在等待维护，暂不接受新操作。', { 'retry-after': '5' })
    }
    validateSameOrigin(request)
    const route = request.routeOptions.url
    if (route === '/api/session' && (request.method === 'GET' || request.method === 'POST')) return
    if (route === '/api/control-updates/:id/receipt' && request.method === 'GET') return
    if (!sessions.has(request.cookies[SESSION_COOKIE])) {
      throw new ApiError(401, 'authentication_required', '请先登录管理员账号。')
    }
  })

  app.get('/healthz', async (request, reply) => {
    assertNoQuery(request)
    reply.header('cache-control', 'no-store')
    return { ...healthIdentity, processId: process.pid, ...await maintenance.refresh() }
  })

  app.setErrorHandler((error, request, reply) => {
    if (reply.sent) return
    if (error instanceof ZodError || isZodError(error)) {
      void reply.code(400).send({ error: { code: 'validation_error', message: '请求参数不正确。' } })
      return
    }
    if (error instanceof ApiError || isApiError(error)) {
      if (error.headers) reply.headers(error.headers)
      void reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } })
      return
    }
    if (error instanceof GameAdapterError) {
      void reply.code(gameErrorStatus(error.code)).send({ error: { code: error.code, message: error.message } })
      return
    }
    if (error instanceof ControlUpdateError) {
      const status = error.code === 'RECEIPT_INVALID' || error.code === 'RECEIPT_EXPIRED' ? 401
        : error.code === 'UPDATE_NOT_FOUND' ? 404
        : error.code === 'INVALID_INPUT' ? 400
        : error.code === 'UPDATE_SCHEDULE_FAILED' ? 503 : 409
      void reply.code(status).send({ error: { code: error.code, message: error.message } })
      return
    }
    const statusCode = typeof error === 'object' && error !== null && 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : 0
    if (statusCode >= 400 && statusCode < 500) {
      const message = statusCode === 413 ? '请求内容过大。' : '请求格式不正确。'
      void reply.code(statusCode).send({ error: { code: statusCode === 413 ? 'payload_too_large' : 'bad_request', message } })
      return
    }
    request.log.error(error)
    void reply.code(500).send({ error: { code: 'internal_error', message: '控制服务未能完成请求。' } })
  })

  app.get('/api/session', async (request) => {
    assertNoQuery(request)
    return data(sessionDto(sessions.has(request.cookies[SESSION_COOKIE]), adapter))
  })

  app.post('/api/session', async (request, reply) => {
    assertNoQuery(request)
    const body = z.object({ password: z.string().min(1).max(4_096) }).strict().parse(request.body)
    const release = loginGuard.acquire(request.ip)
    try {
      if (!await verifyPassword(body.password, options.config.adminPasswordHash)) {
        loginGuard.failed(request.ip)
        throw new ApiError(401, 'invalid_credentials', '管理员密码错误。')
      }
      loginGuard.succeeded(request.ip)
    } finally {
      release()
    }
    sessions.delete(request.cookies[SESSION_COOKIE])
    const token = sessions.create()
    reply.setCookie(SESSION_COOKIE, token, cookieOptions(request))
    return data(sessionDto(true, adapter))
  })

  app.delete('/api/session', async (request, reply) => {
    assertNoQuery(request)
    sessions.delete(request.cookies[SESSION_COOKIE])
    reply.clearCookie(SESSION_COOKIE, { path: '/', httpOnly: true, sameSite: 'strict', secure: isSecure(request) })
    return data(sessionDto(false, adapter))
  })

  app.get('/api/overview', async (request) => {
    assertNoQuery(request)
    const overview = await adapter.overview()
    events.publishOverview(overview)
    return data(overview)
  })
  app.get('/api/setup', async request => { assertNoQuery(request); return data(await setup.status(request.cookies[SESSION_COOKIE]!)) })
  app.get('/api/steam-auth', async request => { assertNoQuery(request); return data(steamAuth.status(request.cookies[SESSION_COOKIE]!)) })
  app.post('/api/steam-auth', { bodyLimit: 1024 }, async request => {
    assertNoQuery(request)
    assertSteamTransport(request)
    if (options.config.mode !== 'windows') throw new ApiError(501, 'windows_required', 'Steam 授权需要 Windows 服务器。')
    if (!queue.isIdle) throw new ApiError(409, 'job_in_progress', '请等待当前服务器任务结束后再授权。')
    const body = z.object({ accountName: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/) }).strict().parse(request.body)
    return data(await steamAuth.start(request.cookies[SESSION_COOKIE]!, body.accountName))
  })
  app.post('/api/steam-auth/:id/input', { bodyLimit: 2048 }, async request => {
    assertNoQuery(request)
    assertSteamTransport(request)
    try {
      const { id } = z.object({ id: z.string().uuid() }).strict().parse(request.params)
      const body = z.object({ promptId: z.number().int().nonnegative(), value: z.string().min(1).max(256) }).strict().parse(request.body)
      return data(steamAuth.input(request.cookies[SESSION_COOKIE]!, id, body.promptId, body.value))
    } finally { request.body = undefined }
  })
  app.delete('/api/steam-auth/:id', async request => {
    assertNoQuery(request)
    const { id } = z.object({ id: z.string().uuid() }).strict().parse(request.params)
    return data(await steamAuth.cancel(request.cookies[SESSION_COOKIE]!, id))
  })
  app.get('/api/players', async (request) => { assertNoQuery(request); return data(await adapter.players()) })
  app.get('/api/player-history', async request => {
    const query = z.object({ limit: z.coerce.number().int().min(1).max(200).default(100), offset: z.coerce.number().int().min(0).max(10_000).default(0) }).strict().parse(request.query)
    return data(playerHistory.read(query.limit, query.offset))
  })
  app.get('/api/logs', async (request) => { assertNoQuery(request); return data(await adapter.logs()) })
  app.get('/api/logs/download', async (request, reply) => {
    if (adapter.source === 'demo') {
      assertNoQuery(request)
      reply.header('content-type', 'text/plain; charset=utf-8').header('content-disposition', 'attachment; filename="dyson-demo.log"')
      return (await adapter.logs()).map((entry) => `${entry.time ? `${entry.time} ` : ''}[${entry.level}] ${entry.message}`).join('\n') + '\n'
    }
    return sendLogDownload(options.config.game.logFile, request, reply)
  })
  app.get('/api/mods', async (request) => { assertNoQuery(request); return data(await adapter.mods()) })
  app.get('/api/mod-catalog', async (request) => {
    const query = z.object({ search: z.string().trim().max(128).default('') }).strict().parse(request.query)
    return data(await adapter.modCatalog(query.search))
  })
  app.get('/api/mod-configs', async (request) => { assertNoQuery(request); return data(await adapter.modConfigs()) })
  app.get('/api/mod-removal-history', async request => { assertNoQuery(request); return data(await adapter.modRemovalHistory()) })
  app.get('/api/mod-config-history', async (request) => {
    const { configId } = z.object({ configId: idSchema.optional() }).strict().parse(request.query)
    return data(await adapter.modConfigHistory(configId))
  })
  app.get('/api/versions', async (request) => { assertNoQuery(request); return data(await adapter.versions()) })
  app.get('/api/control-version', async (request) => { assertNoQuery(request); return data(healthIdentity) })
  app.get('/api/control-updates', async (request) => { assertNoQuery(request); return data(await controlUpdates.discover()) })
  app.get('/api/control-updates/history', async (request) => { assertNoQuery(request); return data(await controlUpdates.history()) })
  app.get('/api/control-updates/:id', async (request) => {
    assertNoQuery(request)
    const { id } = z.object({ id: z.string().uuid() }).strict().parse(request.params)
    return data(await controlUpdates.read(id))
  })
  app.get('/api/control-updates/:id/receipt', async (request) => {
    assertNoQuery(request)
    const { id } = z.object({ id: z.string().uuid() }).strict().parse(request.params)
    const token = z.string().regex(/^[A-Za-z0-9_-]{43}$/).parse(request.headers['x-update-receipt'])
    return data(await controlUpdates.readWithReceipt(id, token))
  })
  app.post('/api/control-updates/prepare', async (request, reply) => {
    assertNoQuery(request)
    const input = z.object({ requestId: requestIdSchema, expectedVersion: z.string().min(1).max(100) }).strict().parse(request.body)
    const result = await controlUpdates.prepare(input)
    return reply.code(202).send(data(result))
  })
  app.post('/api/control-updates/:id/apply', async (request, reply) => {
    assertNoQuery(request)
    const { id } = z.object({ id: z.string().uuid() }).strict().parse(request.params)
    const { requestId } = z.object({ requestId: requestIdSchema }).strict().parse(request.body)
    const result = await controlUpdates.apply({ operationId: id, requestId })
    return reply.code(202).send(data(result))
  })
  app.post('/api/control-updates/:id/discard', async (request) => {
    assertNoQuery(request)
    const { id } = z.object({ id: z.string().uuid() }).strict().parse(request.params)
    emptyObjectSchema.parse(request.body)
    return data(await controlUpdates.discard(id))
  })
  app.get('/api/version-locks', async request => { assertNoQuery(request); return data(await adapter.versionLocks()) })
  app.get('/api/update-history', async (request) => { assertNoQuery(request); return data(await adapter.updateHistory()) })
  app.get('/api/saves', async (request) => { assertNoQuery(request); return data(await adapter.saves()) })
  app.get('/api/backups', async (request) => { assertNoQuery(request); return data(await adapter.backups()) })
  app.get('/api/settings', async (request) => { assertNoQuery(request); return data(await adapter.settings()) })
  app.get('/api/settings-history', async request => { assertNoQuery(request); return data(await adapter.settingsHistory()) })
  app.get('/api/client-packages', async (request) => { assertNoQuery(request); return data(await adapter.clientPackages()) })
  app.get('/api/jobs', async (request) => { assertNoQuery(request); return data(store.list()) })
  app.get('/api/runtime', async (request) => { assertNoQuery(request); return data(runtime.status()) })
  app.get('/api/runtime/history', async (request) => {
    const { hours } = z.object({ hours: z.coerce.number().int().min(1).max(168).default(24) }).strict().parse(request.query)
    return data(runtime.history(hours))
  })
  app.put('/api/runtime/settings', async (request) => {
    assertNoQuery(request)
    return data(runtime.updateSettings(runtimeSettingsSchema.parse(request.body)))
  })
  app.get('/api/runtime/settings-history', async request => { assertNoQuery(request); return data(runtime.settingsHistory()) })
  app.post('/api/runtime/settings/restore', async request => {
    assertNoQuery(request)
    const { historyId } = z.object({ historyId: z.number().int().positive().safe() }).strict().parse(request.body)
    return data(runtime.restoreSettings(historyId))
  })

  app.get('/api/jobs/:id', async (request) => {
    assertNoQuery(request)
    const { id } = z.object({ id: idSchema }).strict().parse(request.params)
    return data(store.require(id))
  })

  app.post('/api/actions', { bodyLimit: 300 * 1024 }, async (request, reply) => {
    assertNoQuery(request)
    const parsed = z.object({ requestId: requestIdSchema, action: actionSchema, input: z.unknown().optional() }).strict().parse(request.body)
    const input = actionInputSchemas[parsed.action].parse(parsed.input ?? {})
    const actionRequest: ActionRequest = { requestId: parsed.requestId, action: parsed.action, input }
    const job = queue.enqueue({ requestId: actionRequest.requestId, action: actionRequest.action, input })
    return reply.code(202).send(data(job))
  })

  app.post('/api/backups/import', async (request, reply) => {
    assertNoQuery(request)
    const requestId = requestIdSchema.parse(request.headers['x-request-id'])
    if (!(request.body instanceof Readable)) throw new ApiError(415, 'unsupported_media_type', '请以 application/zip 上传备份文件。')
    const source = request.body
    const existingJob = store.findByRequestId(requestId)
    if (existingJob) {
      source.resume()
      if (existingJob.action !== 'import-backup') throw new ApiError(409, 'request_id_conflict', '该 requestId 已用于另一项操作。')
      return reply.code(202).send(data(existingJob))
    }
    if (activeUploads.has(requestId)) {
      source.resume()
      throw new ApiError(409, 'upload_in_progress', '同一 requestId 的备份正在上传。', { 'retry-after': '2' })
    }
    if (activeUploads.size > 0) {
      source.resume()
      throw new ApiError(429, 'upload_busy', '已有备份正在上传，请稍后重试。', { 'retry-after': '5' })
    }

    const contentLength = request.headers['content-length'] === undefined ? null : Number(request.headers['content-length'])
    if (contentLength !== null && (!Number.isSafeInteger(contentLength) || contentLength < 1)) {
      source.resume()
      throw new ApiError(400, 'invalid_content_length', 'Content-Length 无效。')
    }
    if (contentLength !== null && contentLength > MAX_BACKUP_UPLOAD_BYTES) {
      source.resume()
      throw new ApiError(413, 'upload_too_large', '备份文件超过 8 GiB 上传上限。')
    }

    try {
      queue.assertCanEnqueue()
    } catch (error) {
      source.resume()
      throw error
    }
    const staged = await uploads.findByRequestId(requestId)
    if (staged) {
      source.resume()
      const job = queue.enqueue({ requestId, action: 'import-backup', input: { uploadId: staged.uploadId } })
      return reply.code(202).send(data(job))
    }

    if (activeUploads.size > 0) {
      source.resume()
      throw new ApiError(429, 'upload_busy', '已有备份正在上传，请稍后重试。', { 'retry-after': '5' })
    }

    const abort = new AbortController()
    activeUploads.set(requestId, abort)
    const abortUpload = () => abort.abort(new Error('上传连接已中断。'))
    request.raw.once('aborted', abortUpload)
    let uploadId: string | null = null
    try {
      const metadata = await uploads.stage(requestId, source, abort.signal)
      uploadId = metadata.uploadId
      const job = queue.enqueue({ requestId, action: 'import-backup', input: { uploadId } })
      return reply.code(202).send(data(job))
    } catch (error) {
      if (!source.destroyed && !source.readableEnded) source.resume()
      if (uploadId) await uploads.remove(uploadId)
      throw error
    } finally {
      request.raw.off('aborted', abortUpload)
      activeUploads.delete(requestId)
    }
  })

  app.get('/api/events', async (request, reply) => {
    assertNoQuery(request)
    if (!events.hasCapacity) throw new ApiError(503, 'event_stream_capacity', '实时连接数量已达上限，请关闭其他管理页面后重试。', { 'retry-after': '5' })
    const sessionToken = request.cookies[SESSION_COOKIE]
    if (!sessionToken) throw new ApiError(401, 'authentication_required', '请先登录管理员账号。')
    reply.hijack()
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
    })
    const unsubscribe = events.subscribe(reply.raw, sessionToken)
    reply.raw.once('close', unsubscribe)
    reply.raw.once('error', unsubscribe)
  })

  app.get('/api/backups/:id/download', async (request, reply) => {
    const { id } = z.object({ id: idSchema }).strict().parse(request.params)
    return sendDownload(adapter, 'backup', id, request, reply)
  })
  app.get('/api/client-packages/:id/download', async (request, reply) => {
    const { id } = z.object({ id: idSchema }).strict().parse(request.params)
    return sendDownload(adapter, 'client', id, request, reply)
  })

  const moduleDirectory = dirname(fileURLToPath(import.meta.url))
  const webRoot = options.webRoot ?? (import.meta.url.endsWith('.ts')
    ? resolve(moduleDirectory, '../dist/web')
    : resolve(moduleDirectory, '../web'))
  if (existsSync(resolve(webRoot, 'index.html'))) {
    await app.register(fastifyStatic, { root: webRoot, prefix: '/', wildcard: false })
  }

  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith('/api/')) throw new ApiError(404, 'route_not_found', 'API 路由不存在。')
    if (existsSync(resolve(webRoot, 'index.html')) && request.headers.accept?.includes('text/html')) {
      return reply.sendFile('index.html')
    }
    throw new ApiError(404, 'not_found', '请求的资源不存在。')
  })

  app.addHook('onClose', async () => {
    events.close()
    await controlUpdates.close()
    await queue.shutdown()
    await runtime.close()
    await playerHistory.close()
    await adapter.close?.()
    sessions.close()
    store.close()
  })

  app.addHook('preClose', async () => {
    await steamAuth.close()
    runtime.stop()
    playerHistory.stop()
    for (const controller of activeUploads.values()) controller.abort(new Error('控制服务正在关闭。'))
  })

  app.addHook('onReady', async () => { runtime.start(); playerHistory.start() })

  return app
}

function isZodError(error: unknown): error is ZodError {
  return typeof error === 'object' && error !== null && 'issues' in error && Array.isArray(error.issues)
}

function isApiError(error: unknown): error is ApiError {
  return typeof error === 'object' && error !== null
    && 'name' in error && error.name === 'ApiError'
    && 'statusCode' in error && typeof error.statusCode === 'number'
    && 'code' in error && typeof error.code === 'string'
    && 'message' in error && typeof error.message === 'string'
}

function sessionDto(authenticated: boolean, adapter: GameAdapter): Session {
  return { authenticated, username: 'administrator', source: adapter.source }
}

function data<T>(value: T): { data: T } {
  return { data: value }
}

function assertNoQuery(request: FastifyRequest): void {
  if (Object.keys(request.query as Record<string, unknown>).length > 0) {
    throw new ApiError(400, 'validation_error', '此接口不接受查询参数。')
  }
}

function validateSameOrigin(request: FastifyRequest): void {
  if (request.method !== 'POST' && request.method !== 'PUT' && request.method !== 'PATCH' && request.method !== 'DELETE') return
  if (request.headers['sec-fetch-site'] === 'cross-site') {
    throw new ApiError(403, 'origin_forbidden', '不允许跨站请求。')
  }
  const origin = request.headers.origin
  if (!origin) return
  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    throw new ApiError(403, 'origin_forbidden', '请求来源无效。')
  }
  const host = request.headers.host
  const protocol = request.protocol
  if (!host || parsed.host !== host || parsed.protocol !== `${protocol}:`) {
    throw new ApiError(403, 'origin_forbidden', '不允许跨站请求。')
  }
}

function isLoopbackAddress(address: string): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function assertSteamTransport(request: FastifyRequest): void {
  if (!isSecure(request) && !isLoopbackAddress(request.ip)) throw new ApiError(403, 'https_required', '输入 Steam 凭据需要 HTTPS 或服务器本机访问。')
}

function isSecure(request: FastifyRequest): boolean {
  return request.protocol === 'https'
}

function cookieOptions(request: FastifyRequest) {
  return {
    path: '/', httpOnly: true, sameSite: 'strict' as const,
    secure: isSecure(request), maxAge: SESSION_MAX_AGE_SECONDS,
  }
}

function gameErrorStatus(code: string): number {
  if (code === 'STEAM_BUSY' || code.startsWith('SETUP_') || code === 'STEAM_AUTH_REQUIRED' || code === 'STEAM_ACCOUNT_REQUIRED') return 409
  if (['MOD_SIDE_BUILTIN', 'MOD_SIDE_UNCONFIRMED', 'MOD_SIDE_LIMIT_EXCEEDED'].includes(code)) return 409
  if (code === 'VERSION_LOCK_CONFLICT') return 409
  if (code === 'SETTINGS_HISTORY_NOT_FOUND') return 404
  if (['MOD_NOT_FOUND', 'MOD_REMOVAL_HISTORY_NOT_FOUND'].includes(code)) return 404
  if (['MOD_VERSION_CHANGED', 'MOD_DEPENDENCY_ACTIVE', 'MOD_DEPENDENCY_MISSING', 'MOD_REMOVAL_DESTINATION_EXISTS', 'MOD_REMOVAL_PATH_INVALID', 'MOD_REMOVAL_LIMIT_EXCEEDED', 'MOD_CHANGED'].includes(code)) return 409
  if (['MOD_CONFIG_NOT_FOUND', 'MOD_CONFIG_HISTORY_NOT_FOUND'].includes(code)) return 404
  if (['MOD_CONFIG_CHANGED', 'MOD_CONFIG_SECRET_WRITE_FORBIDDEN', 'MOD_CONFIG_SECRET_SCHEMA_CHANGED', 'MOD_CONFIG_PROTECTED', 'MOD_CONFIG_LIMIT_EXCEEDED', 'MOD_CONFIG_PATH_INVALID'].includes(code)) return 409
  if (['INVALID_INPUT', 'INVALID_MODE', 'MOD_VERSION_UNSUPPORTED', 'NO_CLIENT_MODS'].includes(code)) return 400
  if (['DOWNLOAD_NOT_FOUND', 'BACKUP_NOT_FOUND', 'SAVE_NOT_FOUND'].includes(code)) return 404
  if (['GAME_RUNNING', 'GAME_NOT_RUNNING', 'REQUIRED_MOD', 'MOD_DESTINATION_EXISTS', 'SAVE_SET_INCOMPLETE'].includes(code)) return 409
  if (['UNSUPPORTED_OPERATION', 'UPDATE_BACKEND_UNAVAILABLE', 'WINDOWS_REQUIRED'].includes(code)) return 501
  if (code.startsWith('BRIDGE_') || code.startsWith('WINDOWS_SCRIPT_') || code === 'GAME_START_TIMEOUT' || code === 'GAME_STOP_TIMEOUT') return 502
  return 500
}

async function sendDownload(
  adapter: GameAdapter,
  kind: 'backup' | 'client',
  id: string,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  assertNoQuery(request)
  if (!adapter.download) throw new ApiError(404, 'download_not_available', '当前下载不可用。')
  const download = await adapter.download(kind, id)
  if (!existsSync(download.path)) throw new ApiError(404, 'download_not_found', '下载文件不存在。')
  const name = basename(download.fileName)
  const fallback = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  reply.type(download.contentType)
  reply.header('content-disposition', `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`)
  return reply.send(createReadStream(download.path))
}

const MAX_LOG_DOWNLOAD_BYTES = 16 * 1024 * 1024

async function sendLogDownload(logPath: string, request: FastifyRequest, reply: FastifyReply) {
  assertNoQuery(request)
  const stat = await lstat(logPath).catch(() => null)
  if (!stat?.isFile() || stat.isSymbolicLink()) throw new ApiError(404, 'log_not_found', '服务器日志文件不存在。')
  const start = Math.max(0, stat.size - MAX_LOG_DOWNLOAD_BYTES)
  const name = basename(logPath).replace(/[^A-Za-z0-9._-]/g, '_') || 'server.log'
  reply.type('text/plain; charset=utf-8')
  reply.header('content-disposition', `attachment; filename="${name}"`)
  reply.header('x-log-truncated', start > 0 ? 'true' : 'false')
  return reply.send(createReadStream(logPath, stat.size === 0 ? undefined : { start, end: stat.size - 1 }))
}
