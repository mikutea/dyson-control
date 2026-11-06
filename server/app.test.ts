import { createHash, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import fs, { link, mkdir, mkdtemp, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  Action, Backup, ClientPackage, ComponentVersion, ControlConfig, ControlUpdateOperation, GameAdapter,
  GameSettings, Job, LogEntry, Mod, Overview, Player, Save,
} from '../shared/contracts.js'
import { hashPassword } from './auth.js'
import { LoginGuard } from './auth.js'
import { buildApp } from './app.js'
import { JobStore } from './jobs.js'
import { readGameLogs } from './game/logs.js'
import { DemoGameAdapter } from './game/demo.js'
import { WindowsGameAdapter } from './game/windows.js'
import { extractZipBuffer } from './game/updates.js'
import { buildStoredZip } from './game/zip.js'
import { MAINTENANCE_MARKER } from './health.js'
import { ControlUpdateError } from './control-updates.js'
import { SteamAuthManager } from './steam-auth.js'

const tempDirectories: string[] = []

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('Dyson Control API', () => {
  it('authenticates the read-only mod configuration rollback preview and confirms its revision through the job queue', async () => {
    const fixture = await createFixture()
    const adapter = new DemoGameAdapter(fixture.config)
    const app = await buildApp({ config: fixture.config, adapter, databasePath: ':memory:' })
    try {
      const cookie = await loginCookie(app)
      const get = (url: string) => app.inject({ url, headers: { cookie } })
      const submit = (action: Action, input: Record<string, unknown>) => app.inject({
        method: 'POST', url: '/api/actions', headers: { cookie }, payload: { requestId: randomUUID(), action, input }
      })
      const file = (await get('/api/mod-configs')).json().data[0]
      const draft = file.content.replace('ShowTips = true', 'ShowTips = false')
      expect((await submit('write-mod-config', { configId: file.id, content: draft, expectedRevision: file.revision })).statusCode).toBe(202)
      await waitForJobs(app, cookie, 1)
      const [entry] = (await get('/api/mod-config-history')).json().data
      const url = `/api/mod-config-history/${entry.id}/rollback-preview`
      expect((await app.inject({ url })).statusCode).toBe(401)
      expect((await get(url + '?unexpected=1')).statusCode).toBe(400)
      expect((await get('/api/mod-config-history/' + randomUUID() + '/rollback-preview')).statusCode).toBe(404)
      const response = await get(url)
      expect(response.statusCode).toBe(200)
      expect(response.headers['cache-control']).toBe('no-store')
      const preview = response.json().data
      expect(preview).toMatchObject({ historyId: entry.id, configId: file.id, changes: [
        { side: 'current', text: 'ShowTips = false\n' }, { side: 'restored', text: 'ShowTips = true\n' }
      ] })
      expect((await get('/api/jobs')).json().data).toHaveLength(1)
      expect((await get('/api/mod-config-history')).json().data).toEqual([entry])
      expect((await submit('rollback-mod-config', { historyId: entry.id, expectedRevision: preview.expectedRevision })).statusCode).toBe(202)
      await waitForJobs(app, cookie, 2)
      expect((await get('/api/mod-configs')).json().data[0].content).toBe(file.content)
      expect((await get(url)).json().data.changes).toEqual([])
    } finally { await app.close() }
  })
  it('authenticates the single current-job snapshot and keeps a queued submission behind the running job', async () => {
    const f = await createFixture()
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    f.adapter.run = async (action, _input, report) => {
      if (action === 'save') { report('fixture active'); await pending }
      return { action }
    }
    const app = await buildApp({ config: f.config, adapter: f.adapter, databasePath: ':memory:' })
    try {
      const url = '/api/jobs/current'
      expect((await app.inject({ url })).statusCode).toBe(401)
      const cookie = await loginCookie(app)
      const headers = { cookie }
      expect((await app.inject({ url: url + '?limit=200', headers })).statusCode).toBe(400)
      const empty = await app.inject({ url, headers })
      expect(empty.json()).toEqual({ data: null })
      expect(empty.headers['cache-control']).toBe('no-store')
      const submit = (action: Action) => app.inject({ method: 'POST', url: '/api/actions', headers,
        payload: { action, requestId: 'dock-' + action, input: {} } })
      const first: Job = (await submit('save')).json().data
      const second: Job = (await submit('backup')).json().data
      expect((await app.inject({ url, headers })).json().data).toMatchObject({ id: first.id, state: 'running', message: 'fixture active' })
      expect((await app.inject({ url: '/api/jobs/by-request/dock-backup', headers })).json().data).toMatchObject({ id: second.id, state: 'queued' })
      release()
      await waitForJobs(app, cookie, 2)
      expect((await app.inject({ url, headers })).json().data).toMatchObject({ id: second.id, state: 'succeeded' })
    } finally { release(); await app.close() }
  })

  it('finds older filtered jobs and pages past a tied timestamp even when a new job arrives', async () => {
    const f = await createFixture()
    const databasePath = join(f.directory, 'history.sqlite')
    const seed = new JobStore(databasePath)
    const record = (action: Action, state: 'succeeded' | 'failed' | 'interrupted') => {
      const { job } = seed.create({ requestId: randomUUID(), action, input: {} })
      return seed.finish(job.id, state, 'fixture outcome', null)
    }
    const timestamp = vi.spyOn(Date.prototype, 'toISOString').mockReturnValue('2025-01-01T00:00:00.000Z')
    let matching: string[]
    try {
      matching = [record('backup', 'failed').id, record('backup', 'failed').id].sort().reverse()
      record('save', 'failed')
      record('backup', 'interrupted')
    } finally { timestamp.mockRestore() }
    for (let i = 0; i < 201; i++) record('save', 'succeeded')
    const app = await buildApp({ config: f.config, adapter: f.adapter, databasePath })
    try {
      const url = '/api/jobs?action=backup&state=failed&limit=1'
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401)
      const headers = { cookie: await loginCookie(app) }
      const get = (url: string) => app.inject({ method: 'GET', url, headers })
      const recent: Job[] = (await get('/api/jobs')).json().data
      expect(recent).toHaveLength(200)
      expect(recent.every(job => job.state === 'succeeded')).toBe(true)
      const first: Job[] = (await get(url)).json().data
      expect(first.map(job => job.id)).toEqual(matching.slice(0, 1))
      record('backup', 'failed')
      const next: Job[] = (await get(`${url}&before=${first[0].id}`)).json().data
      expect(next.map(job => job.id)).toEqual(matching.slice(1))
      expect((await get(`${url}&before=${next[0].id}`)).json().data).toEqual([])
      for (const invalid of ['limit=0', 'limit=201', 'action=unknown', 'state=unknown', 'before=invalid', 'offset=1']) {
        expect((await get(`/api/jobs?${invalid}`)).statusCode).toBe(400)
      }
      expect((await get(`/api/jobs?before=${randomUUID()}`)).statusCode).toBe(404)
      expect(f.adapter.calls).toHaveLength(0)
    } finally { await app.close(); seed.close() }
  })

  it('authenticates and deduplicates first-world preparation through the game action queue', async () => {
    const f = await createFixture()
    const prepared = { prepared: true, installationId: 'first-install-11111111-1111-1111-1111-111111111111', started: false }
    const run = f.adapter.run.bind(f.adapter)
    f.adapter.run = async (...args) => { await run(...args); return prepared }
    const app = await buildApp({ config: f.config, adapter: f.adapter, databasePath: ':memory:' })
    try {
      const payload = { requestId: 'prepare-first-world-1', action: 'prepare-first-world', input: {} }
      expect((await app.inject({ method: 'POST', url: '/api/actions', payload })).statusCode).toBe(401)
      expect((await app.inject({ method: 'GET', url: '/api/setup' })).statusCode).toBe(401)
      const cookie = await loginCookie(app)
      for (const input of [{ installationId: prepared.installationId }, { start: true }, []]) {
        expect((await app.inject({ method: 'POST', url: '/api/actions', headers: { cookie }, payload: { ...payload, input } })).statusCode).toBe(400)
      }
      expect((await app.inject({ method: 'POST', url: '/api/actions', headers: { cookie, origin: 'https://untrusted.example.test' }, payload })).statusCode).toBe(403)
      expect(f.adapter.calls).toHaveLength(0)
      const first = await app.inject({ method: 'POST', url: '/api/actions', headers: { cookie }, payload })
      const repeat = await app.inject({ method: 'POST', url: '/api/actions', headers: { cookie }, payload: { requestId: payload.requestId, action: payload.action } })
      expect(first.statusCode).toBe(202)
      expect(repeat.json().data.id).toBe(first.json().data.id)
      expect((await waitForJobs(app, cookie, 1))[0]).toMatchObject({ state: 'succeeded', result: prepared })
      expect(f.adapter.calls).toEqual([{ action: 'prepare-first-world', input: {} }])
      expect((await app.inject({ method: 'POST', url: '/api/actions', headers: { cookie }, payload: { ...payload, action: 'start' } })).statusCode).toBe(409)
      expect((await app.inject({ method: 'GET', url: '/api/setup', headers: { cookie } })).json().data.firstWorld).toEqual({ state: 'unavailable', message: '' })
    } finally { await app.close() }
  })

  it('authenticates and deduplicates read-only backup verification with strict input', async () => {
    const f = await createFixture()
    const app = await buildApp({ config: f.config, adapter: f.adapter, databasePath: ':memory:' })
    try {
      const payload = { requestId: 'verify-backup-1', action: 'verify-backup', input: { backupId: 'fixture-backup' } }
      expect((await app.inject({ method: 'POST', url: '/api/actions', payload })).statusCode).toBe(401)
      const cookie = await loginCookie(app)
      for (const input of [{}, { backupId: '' }, { backupId: 'fixture-backup', path: '../other' }]) {
        expect((await app.inject({ method: 'POST', url: '/api/actions', headers: { cookie }, payload: { ...payload, input } })).statusCode).toBe(400)
      }
      expect((await app.inject({ method: 'POST', url: '/api/actions', headers: { cookie, origin: 'https://untrusted.example.test' }, payload })).statusCode).toBe(403)
      const first = await app.inject({ method: 'POST', url: '/api/actions', headers: { cookie }, payload })
      expect(first.statusCode).toBe(202)
      const repeat = await app.inject({ method: 'POST', url: '/api/actions', headers: { cookie }, payload })
      expect(repeat.json().data.id).toBe(first.json().data.id)
      expect((await waitForJobs(app, cookie, 1))[0]?.state).toBe('succeeded')
      expect(f.adapter.calls).toEqual([{ action: 'verify-backup', input: { backupId: 'fixture-backup' } }])
    } finally { await app.close() }
  })

  it('reads restore impact only after login without enqueueing a job and validates the optional confirmation key', async () => {
    const f = await createFixture()
    const read = vi.spyOn(f.adapter, 'restorePreview')
    const app = await buildApp({ config: f.config, adapter: f.adapter, databasePath: ':memory:' })
    try {
      const url = '/api/backups/fixture-backup/restore-preview'
      expect((await app.inject({ url })).statusCode).toBe(401)
      const cookie = await loginCookie(app)
      expect((await app.inject({ url: url + '?run=true', headers: { cookie } })).statusCode).toBe(400)
      expect(read).not.toHaveBeenCalled()
      const response = await app.inject({ url, headers: { cookie } })
      expect(response.statusCode).toBe(200)
      expect(response.headers['cache-control']).toBe('no-store')
      const { data: preview } = response.json()
      expect(preview.backupId).toBe('fixture-backup')
      expect(read).toHaveBeenCalledWith('fixture-backup')
      expect((await app.inject({ url: '/api/jobs', headers: { cookie } })).json().data).toEqual([])
      const payload = { requestId: 'reviewed-restore', action: 'restore', input: { backupId: preview.backupId, previewKey: 'invalid' } }
      expect((await app.inject({ url: '/api/actions', method: 'POST', headers: { cookie }, payload })).statusCode).toBe(400)
      payload.input.previewKey = preview.previewKey
      expect((await app.inject({ url: '/api/actions', method: 'POST', headers: { cookie }, payload })).statusCode).toBe(202)
      await waitForJobs(app, cookie, 1)
      expect(f.adapter.calls).toEqual([{ action: 'restore', input: payload.input }])
    } finally { await app.close() }
  })

  it('authenticates, validates and deduplicates loading a save through the durable queue', async () => {
    const f = await createFixture()
    const app = await buildApp({ config: f.config, adapter: f.adapter, databasePath: ':memory:' })
    try {
      const payload = { requestId: 'load-save-1', action: 'load-save', input: { saveId: 'fixture-save' } }
      expect((await app.inject({ method: 'POST', url: '/api/actions', payload })).statusCode).toBe(401)
      const cookie = await loginCookie(app)
      for (const input of [{}, { saveId: '' }, { saveId: 'fixture-save', path: '../other' }]) {
        expect((await app.inject({ method: 'POST', url: '/api/actions', headers: { cookie }, payload: { ...payload, input } })).statusCode).toBe(400)
      }
      expect((await app.inject({ method: 'POST', url: '/api/actions', headers: { cookie, origin: 'https://untrusted.example.test' }, payload })).statusCode).toBe(403)
      const first = await app.inject({ method: 'POST', url: '/api/actions', headers: { cookie }, payload })
      const repeat = await app.inject({ method: 'POST', url: '/api/actions', headers: { cookie }, payload })
      expect(first.statusCode).toBe(202)
      expect(repeat.json().data.id).toBe(first.json().data.id)
      expect((await waitForJobs(app, cookie, 1))[0]?.state).toBe('succeeded')
      expect(f.adapter.calls).toEqual([{ action: 'load-save', input: { saveId: 'fixture-save' } }])
    } finally { await app.close() }
  })

  it('requires an admin, safe transport and the owning session for transient Steam credentials', async () => {
    const fixture = await createFixture()
    fixture.config.mode = 'windows'
    fixture.config.game.steam = { executable: join(fixture.directory, 'steamcmd.exe'), accountName: 'fixture_account' }
    await writeFile(fixture.config.game.steam.executable, 'FIXTURE ONLY')
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), exitCode: null, signalCode: null,
      kill() { queueMicrotask(() => child.emit('close', null)); return true },
    })
    let inputs = 0
    child.stdin.on('data', () => { inputs++ })
    const auth = new SteamAuthManager(fixture.config, { spawn: () => child as unknown as ChildProcessWithoutNullStreams })
    const app = await buildApp({ config: fixture.config, adapter: fixture.adapter, steamAuth: auth, maxSessions: 2, databasePath: ':memory:' })
    await app.ready()
    try {
      for (const url of ['/api/setup', '/api/steam-auth']) expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401)
      expect((await app.inject({ method: 'POST', url: '/api/steam-auth', payload: { accountName: 'fixture_account' } })).statusCode).toBe(401)
      const cookie = await loginCookie(app)
      const insecure = await app.inject({ method: 'POST', url: '/api/steam-auth', remoteAddress: '198.51.100.8', headers: { cookie, 'x-forwarded-proto': 'https' }, payload: { accountName: 'fixture_account' } })
      expect(insecure.statusCode).toBe(403)
      expect(insecure.json().error.code).toBe('https_required')
      expect((await app.inject({ method: 'POST', url: '/api/steam-auth', headers: { cookie, origin: 'https://untrusted.example.test' }, payload: { accountName: 'fixture_account' } })).statusCode).toBe(403)
      const started = await app.inject({ method: 'POST', url: '/api/steam-auth', headers: { cookie }, payload: { accountName: 'fixture_account' } })
      expect(started.statusCode).toBe(200)
      child.stdout.write('password:')
      const state = (await app.inject({ method: 'GET', url: '/api/steam-auth', headers: { cookie } })).json().data
      expect(state.state).toBe('password')
      const otherCookie = await loginCookie(app)
      const otherState = (await app.inject({ method: 'GET', url: '/api/steam-auth', headers: { cookie: otherCookie } })).json().data
      expect(otherState.id).toBeNull()
      const payload = { promptId: state.promptId, value: 'SYNTHETIC_PASSWORD_NO_REAL_ACCOUNT' }
      expect((await app.inject({ method: 'POST', url: `/api/steam-auth/${state.id}/input`, headers: { cookie: otherCookie }, payload })).statusCode).toBe(404)
      expect((await app.inject({ method: 'POST', url: '/api/actions', headers: { cookie }, payload: { requestId: 'no-password-job', action: 'install-server', input: { gameUser: 'FixtureUser', password: payload.value } } })).statusCode).toBe(400)
      const submitted = await app.inject({ method: 'POST', url: `/api/steam-auth/${state.id}/input`, headers: { cookie }, payload })
      expect(submitted.statusCode).toBe(200)
      expect(submitted.headers['cache-control']).toBe('no-store')
      expect(submitted.body).not.toContain(payload.value)
      expect(inputs).toBe(1)
      expect((await app.inject({ method: 'POST', url: `/api/steam-auth/${state.id}/input`, headers: { cookie }, payload })).statusCode).toBe(409)
      expect((await app.inject({ method: 'GET', url: '/api/jobs', headers: { cookie } })).json().data).toEqual([])
      await app.inject({ method: 'DELETE', url: '/api/session', headers: { cookie } })
      await new Promise(resolve => setImmediate(resolve))
      expect(auth.busy).toBe(false)
      expect(fixture.adapter.calls).toHaveLength(0)
    } finally { await app.close() }
  })

  it('runs installation in the existing durable queue, deduplicating requests before other game actions', async () => {
    const fixture = await createFixture()
    const calls: string[] = []
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const app = await buildApp({ config: fixture.config, adapter: fixture.adapter, databasePath: ':memory:', serverSetup: {
      status: async () => { throw new Error('Not needed') },
      prepareSteam: async report => { calls.push('prepare'); report('fixture preparation'); await gate; return { prepared: true } },
      install: async () => { calls.push('install'); return { installed: true, gameStarted: false } },
      prepareExisting: async () => { throw new Error('Unexpected existing-server preview') },
      adoptExisting: async () => { throw new Error('Unexpected existing-server apply') },
    } })
    await app.ready()
    try {
      const cookie = await loginCookie(app)
      const payload = { requestId: 'prepare-deduplicate', action: 'prepare-steamcmd', input: {} }
      const one = await app.inject({ method: 'POST', url: '/api/actions', headers: { cookie }, payload })
      const two = await app.inject({ method: 'POST', url: '/api/actions', headers: { cookie }, payload })
      expect(one.json().data.id).toBe(two.json().data.id)
      await app.inject({ method: 'POST', url: '/api/actions', headers: { cookie }, payload: { requestId: 'install-next', action: 'install-server', input: { gameUser: 'FixtureUser' } } })
      expect(calls).toEqual(['prepare'])
      release()
      for (let i = 0; i < 20 && calls.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 5))
      expect(calls).toEqual(['prepare', 'install'])
      expect(fixture.adapter.calls).toHaveLength(0)
      const jobs = (await app.inject({ method: 'GET', url: '/api/jobs', headers: { cookie } })).json().data
      expect(jobs).toHaveLength(2)
      expect(jobs.every((job: Job) => job.state === 'succeeded')).toBe(true)
    } finally { release(); await app.close() }
  })

  it('queues typed existing-server preview and apply requests once under administrator authentication', async () => {
    const f = await createFixture()
    const calls: string[] = []
    const planId = randomUUID()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const app = await buildApp({ config: f.config, adapter: f.adapter, databasePath: ':memory:', serverSetup: {
      status: async () => { throw new Error('Unused setup read') },
      prepareSteam: async () => { throw new Error('Unexpected Steam setup') },
      install: async () => { throw new Error('Unexpected fresh install') },
      prepareExisting: async user => { calls.push(`preview:${user}`); await gate; return { prepared: true, plan: { id: planId } } },
      adoptExisting: async id => { calls.push(`apply:${id}`); return { adopted: true, planId: id, gameStarted: false, savesMoved: false } },
    } })
    try {
      const preview = { requestId: 'adopt-preview', action: 'prepare-existing-server', input: { gameUser: 'FixtureUser' } }
      const apply = { requestId: 'adopt-apply', action: 'adopt-existing-server', input: { planId } }
      expect((await app.inject({ method: 'POST', url: '/api/actions', payload: preview })).statusCode).toBe(401)
      const headers = { cookie: await loginCookie(app) }
      const submit = (payload: Record<string, unknown>) => app.inject({ method: 'POST', url: '/api/actions', headers, payload })
      expect((await app.inject({ method: 'POST', url: '/api/actions', headers: { ...headers, origin: 'https://other.example.test' }, payload: apply })).statusCode).toBe(403)
      for (const payload of [{ ...preview, input: { gameUser: 'FixtureUser', configPath: 'foreign' } }, { ...apply, input: { planId: '../outside' } }]) {
        expect((await submit(payload)).statusCode).toBe(400)
      }
      const first = await submit(preview)
      expect(first.statusCode).toBe(202)
      expect((await submit(preview)).json().data.id).toBe(first.json().data.id)
      const second = await submit(apply)
      expect(second.statusCode).toBe(202)
      expect((await submit(apply)).json().data.id).toBe(second.json().data.id)
      expect(calls).toEqual(['preview:FixtureUser'])
      release()
      const jobs = await waitForJobs(app, headers.cookie, 2)
      expect(jobs.find(job => job.action === 'adopt-existing-server')?.result).toMatchObject({ gameStarted: false, savesMoved: false })
      expect(calls).toEqual(['preview:FixtureUser', `apply:${planId}`])
      expect(f.adapter.calls).toHaveLength(0)
    } finally { release(); await app.close() }
  })

  it('serves only public web assets and protects API routes with encoded paths', async () => {
    const fixture = await createFixture()
    const webRoot = join(fixture.directory, 'web')
    await mkdir(join(webRoot, 'assets'), { recursive: true })
    await writeFile(join(webRoot, 'index.html'), '<!doctype html><title>Public fixture</title>')
    await writeFile(join(webRoot, 'assets', 'app.js'), 'globalThis.publicFixture = true;')
    await writeFile(join(fixture.directory, 'private-fixture.txt'), 'PRIVATE_FIXTURE_DO_NOT_SERVE')
    const app = await buildApp({ config: fixture.config, adapter: fixture.adapter, databasePath: ':memory:', webRoot })
    await app.ready()
    try {
      expect((await app.inject({ method: 'GET', url: '/' })).body).toContain('Public fixture')
      const script = await app.inject({ method: 'GET', url: '/assets/app.js' })
      expect(script.statusCode).toBe(200)
      expect(script.headers['content-type']).toMatch(/javascript/)
      expect(script.body).toBe('globalThis.publicFixture = true;')
      for (const url of ['/private-fixture.txt', '/../private-fixture.txt', '/%2e%2e/private-fixture.txt', '/assets/%2e%2e/%2e%2e/private-fixture.txt', '/assets%2f..%2f..%2fprivate-fixture.txt']) {
        const response = await app.inject({ method: 'GET', url })
        expect(response.statusCode, url).toBeGreaterThanOrEqual(400)
        expect(response.body, url).not.toContain('PRIVATE_FIXTURE_DO_NOT_SERVE')
      }
      for (const url of ['/api/overview', '/%61pi/overview', '/api%2foverview', '//api/overview', '/api/./overview']) {
        const response = await app.inject({ method: 'GET', url })
        expect(response.statusCode, url).toBeGreaterThanOrEqual(400)
      }
      const action = { requestId: 'encoded-unauthenticated', action: 'start', input: {} }
      expect((await app.inject({ method: 'POST', url: '/%61pi/actions', payload: action })).statusCode).toBe(401)
      expect(fixture.adapter.calls).toHaveLength(0)
      const cookie = await loginCookie(app)
      expect((await app.inject({ method: 'GET', url: '/api/overview', headers: { cookie } })).statusCode).toBe(200)
      const encoded = await app.inject({ method: 'GET', url: '/%61pi/overview', headers: { cookie } })
      expect(encoded.statusCode).toBe(200)
      expect(encoded.headers['cache-control']).toBe('no-store')
      expect((await app.inject({ method: 'POST', url: '/%61pi/actions', headers: { cookie, origin: 'https://untrusted.example.test' }, payload: action })).statusCode).toBe(403)
      expect(fixture.adapter.calls).toHaveLength(0)
    } finally { await app.close() }
  })

  it('protects control updates while allowing only a token-bound read after session loss', async () => {
    const fixture = await createFixture()
    const id = randomUUID(), token = 'a'.repeat(43)
    const operation: ControlUpdateOperation = {
      id, requestId: 'prepare-1', applyRequestId: null, repository: 'example/control', fromVersion: '0.1.0', targetVersion: '0.2.0',
      state: 'ready', step: 'prepared', message: '校验完成', releaseUrl: 'https://github.com/example/control/releases/tag/v0.2.0',
      assetName: 'dyson-control-0.2.0-windows-panel-only.zip', sha256: 'b'.repeat(64), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), completedAt: null,
    }
    const calls: string[] = []
    const app = await buildApp({ config: fixture.config, adapter: fixture.adapter, databasePath: ':memory:', controlUpdates: {
      initialize: async () => {}, close: async () => {},
      discover: async () => ({ availability: 'available', currentVersion: '0.1.0', latestVersion: '0.2.0', releaseUrl: operation.releaseUrl, publishedAt: null, canPrepare: true, canApply: true, capabilityReason: null, checkedAt: new Date().toISOString() }),
      prepare: async () => { calls.push('prepare'); return { statusCode: 202, operation, receiptToken: token } },
      apply: async () => { calls.push('apply'); return { statusCode: 202, operation } },
      discard: async () => { calls.push('discard'); return operation },
      read: async () => operation, history: async () => [operation],
      readWithReceipt: async (operationId, receiptToken) => { if (operationId !== id || receiptToken !== token) throw new ControlUpdateError('RECEIPT_INVALID', '更新回执无效。'); return operation },
    } })
    await app.ready()
    try {
      for (const url of ['/api/control-updates', '/api/control-updates/history', `/api/control-updates/${id}`]) expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401)
      expect((await app.inject({ method: 'POST', url: `/api/control-updates/${id}/apply`, headers: { 'x-update-receipt': token }, payload: { requestId: 'apply-1' } })).statusCode).toBe(401)
      const receiptUrl = `/api/control-updates/${id}/receipt`
      expect((await app.inject({ method: 'GET', url: receiptUrl })).statusCode).toBe(400)
      expect((await app.inject({ method: 'GET', url: receiptUrl, headers: { 'x-update-receipt': 'b'.repeat(43) } })).statusCode).toBe(401)
      expect((await app.inject({ method: 'GET', url: `${receiptUrl}?token=${token}`, headers: { 'x-update-receipt': token } })).statusCode).toBe(400)
      for (let repeat = 0; repeat < 2; repeat++) {
        const response = await app.inject({ method: 'GET', url: receiptUrl, headers: { 'x-update-receipt': token } })
        expect(response.statusCode).toBe(200)
        expect(response.headers['cache-control']).toBe('no-store')
        expect(response.json().data).toEqual(operation)
      }
      const cookie = await loginCookie(app)
      expect((await app.inject({ method: 'POST', url: '/api/control-updates/prepare', headers: { cookie }, payload: { requestId: 'prepare-1', expectedVersion: '0.2.0' } })).statusCode).toBe(202)
      expect((await app.inject({ method: 'POST', url: `/api/control-updates/${id}/apply`, headers: { cookie }, payload: { requestId: 'apply-1' } })).statusCode).toBe(202)
      expect((await app.inject({ method: 'POST', url: `/api/control-updates/${id}/discard`, headers: { cookie }, payload: {} })).statusCode).toBe(200)
      expect(calls).toEqual(['prepare', 'apply', 'discard'])
    } finally { await app.close() }
  })

  it('requires the current session connection identifier for player actions', async () => {
    const fixture = await createFixture()
    const app = await buildApp({ config: fixture.config, adapter: fixture.adapter, databasePath: ':memory:' })
    await app.ready()
    try {
      const payload = { requestId: 'kick-fixture', action: 'kick-player', input: { playerId: '00000000-0000-4000-8000-000000000001:player-000001' } }
      expect((await app.inject({ method: 'POST', url: '/api/actions', payload })).statusCode).toBe(401)
      const cookie = await loginCookie(app)
      for (const playerId of ['Aurora', '1234', 'player-000001']) {
        expect((await app.inject({ method: 'POST', url: '/api/actions', headers: { cookie }, payload: { ...payload, input: { playerId } } })).statusCode).toBe(400)
      }
      const result = await app.inject({ method: 'POST', url: '/api/actions', headers: { cookie }, payload })
      expect(result.statusCode).toBe(202)
      await waitForJobs(app, cookie, 1)
      expect(fixture.adapter.calls).toEqual([{ action: 'kick-player', input: payload.input }])
    } finally { await app.close() }
  })

  it('collects player events without a browser and protects paged historical records', async () => {
    const fixture = await createFixture()
    fixture.adapter.playerEvents = async () => ({ sessionId: 'fixture-session', processId: 1, writtenAtUnixMs: Date.now(), firstSequence: 1, lastSequence: 1, events: [{ sequence: 1, type: 'join', sessionPlayerId: 'player-000001', displayName: 'Fixture player', observedAtUnixMs: Date.now() - 100 }] })
    const app = await buildApp({ config: fixture.config, adapter: fixture.adapter, databasePath: ':memory:' })
    await app.ready()
    try {
      expect((await app.inject({ method: 'GET', url: '/api/player-history' })).statusCode).toBe(401)
      const cookie = await loginCookie(app)
      const response = await app.inject({ method: 'GET', url: '/api/player-history?limit=1&offset=0', headers: { cookie } })
      expect(response.statusCode).toBe(200)
      expect(response.json().data).toMatchObject({ total: 1, status: 'available', entries: [{ type: 'join', name: 'Fixture player' }] })
      const pageCursor = response.json().data.pageCursor
      expect(pageCursor).toMatch(/^\d+$/)
      expect((await app.inject({ method: 'GET', url: '/api/player-history?type=join&name=PLAYER&cursor=' + pageCursor, headers: { cookie } })).json().data.total).toBe(1)
      expect((await app.inject({ method: 'GET', url: '/api/player-history?type=gap&name=PLAYER', headers: { cookie } })).json().data.total).toBe(0)
      for (const query of ['cursor=1.2', 'cursor=1.2.3', 'cursor=9007199254740992', 'cursor=0&offset=1', 'type=unknown']) {
        expect((await app.inject({ method: 'GET', url: '/api/player-history?' + query, headers: { cookie } })).statusCode).toBe(400)
      }
      expect((await app.inject({ method: 'GET', url: '/api/player-history?limit=10001', headers: { cookie } })).statusCode).toBe(400)
    } finally { await app.close() }
  })

  it('keeps background operations paused from startup until the maintenance handshake is released', async () => {
    const fixture = await createFixture()
    const baseOverview = fixture.adapter.overview.bind(fixture.adapter)
    fixture.adapter.overview = async () => ({ ...await baseOverview(), state: 'running', pid: 1234 })
    let clock = Date.now()
    const marker = join(fixture.directory, MAINTENANCE_MARKER)
    const token = 'abcdef0123456789abcdef0123456789'
    await writeFile(marker, JSON.stringify({ schema: 1, product: 'dyson-control-maintenance', token, requestedByProcessId: process.pid, createdAt: new Date().toISOString() }))
    const app = await buildApp({ config: fixture.config, adapter: fixture.adapter, databasePath: ':memory:', runtimeOptions: { clock: () => clock, intervalMs: 20 } })
    await app.ready()
    try {
      clock += 61 * 60_000
      await new Promise(resolve => setTimeout(resolve, 75))
      expect(fixture.adapter.calls).toHaveLength(0)
      expect((await app.inject({ method: 'GET', url: '/healthz' })).json()).toMatchObject({ accepting: false, maintenanceToken: token })
      await rm(marker)
      expect((await app.inject({ method: 'GET', url: '/healthz' })).json()).toMatchObject({ accepting: true, maintenanceToken: null })
      const cookie = await loginCookie(app)
      await waitForJobs(app, cookie, 1)
      expect(fixture.adapter.calls).toEqual([{ action: 'backup', input: { automatic: true } }])
      expect((await app.inject({ method: 'GET', url: '/api/runtime' })).statusCode).toBe(401)
      const runtime = (await app.inject({ method: 'GET', url: '/api/runtime', headers: { cookie } })).json().data
      expect(runtime.sampledAt).not.toBeNull()
      expect(runtime.lastBackupAt).not.toBeNull()
      expect((await app.inject({ method: 'GET', url: '/api/runtime/history?hours=24', headers: { cookie } })).json().data.length).toBeGreaterThan(0)
      const settings = { ...runtime.settings, backupEveryMinutes: 0 }
      const saved = await app.inject({ method: 'PUT', url: '/api/runtime/settings', headers: { cookie }, payload: settings })
      expect(saved.statusCode).toBe(200)
      expect(saved.json().data.nextBackupAt).toBeNull()
      expect((await app.inject({ method: 'GET', url: '/api/runtime/settings-history' })).statusCode).toBe(401)
      const settingHistory = (await app.inject({ method: 'GET', url: '/api/runtime/settings-history', headers: { cookie } })).json().data
      expect(settingHistory).toHaveLength(2)
      const restored = await app.inject({ method: 'POST', url: '/api/runtime/settings/restore', headers: { cookie }, payload: { historyId: settingHistory[1].id } })
      expect(restored.statusCode).toBe(200)
      expect(restored.json().data.settings).toEqual(runtime.settings)
      expect((await app.inject({ method: 'POST', url: '/api/runtime/settings/restore', headers: { cookie }, payload: { historyId: 999999 } })).statusCode).toBe(404)
      expect((await app.inject({ method: 'POST', url: '/api/runtime/settings/restore', headers: { cookie }, payload: { historyId: '1' } })).statusCode).toBe(400)
      expect((await app.inject({ method: 'PUT', url: '/api/runtime/settings', headers: { cookie }, payload: { ...settings, autoRestart: 'yes' } })).statusCode).toBe(400)
    } finally { await app.close() }
  })

  it('exposes the release identity and current process on the public health route', async () => {
    const fixture = await createFixture()
    const app = await buildApp({ config: fixture.config, adapter: fixture.adapter, databasePath: ':memory:' })
    await app.ready()
    try {
      const response = await app.inject({ method: 'GET', url: '/healthz' })
      expect(response.statusCode).toBe(200)
      expect(response.headers['cache-control']).toBe('no-store')
      expect(response.json()).toEqual({
        product: 'dyson-control', version: JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version, processId: process.pid,
        accepting: true, maintenanceToken: null,
      })
      expect((await app.inject({ method: 'GET', url: '/healthz?probe=1' })).statusCode).toBe(400)
    } finally { await app.close() }
  })

  it('acknowledges an atomic maintenance marker and rejects new writes until its owner removes it', async () => {
    const fixture = await createFixture()
    const app = await buildApp({ config: fixture.config, adapter: fixture.adapter, databasePath: ':memory:' })
    await app.ready()
    try {
      const cookie = await loginCookie(app)
      const token = '0123456789abcdef0123456789abcdef'
      const marker = join(fixture.directory, MAINTENANCE_MARKER)
      const partial = `${marker}.partial`
      await writeFile(partial, `${JSON.stringify({
        schema: 1, product: 'dyson-control-maintenance', token,
        requestedByProcessId: process.pid, createdAt: new Date().toISOString(),
      })}\n`, { flag: 'wx' })
      await rename(partial, marker)

      expect((await app.inject({ method: 'GET', url: '/healthz' })).json()).toMatchObject({
        processId: process.pid, accepting: false, maintenanceToken: token,
      })
      const action = await app.inject({
        method: 'POST', url: '/api/actions', headers: { cookie },
        payload: { requestId: 'blocked-by-maintenance', action: 'backup' },
      })
      expect(action.statusCode).toBe(503)
      expect(action.json().error.code).toBe('maintenance_active')
      const upload = await app.inject({
        method: 'POST', url: '/api/backups/import',
        headers: { cookie, 'content-type': 'application/zip', 'x-request-id': 'blocked-upload' },
        payload: Buffer.from('fixture'),
      })
      expect(upload.statusCode).toBe(503)
      expect(fixture.adapter.calls).toHaveLength(0)

      await rm(marker)
      expect((await app.inject({ method: 'GET', url: '/healthz' })).json()).toMatchObject({
        accepting: true, maintenanceToken: null,
      })
      expect((await app.inject({
        method: 'POST', url: '/api/actions', headers: { cookie },
        payload: { requestId: 'accepted-after-maintenance', action: 'backup' },
      })).statusCode).toBe(202)
      await waitForJobs(app, cookie, 1)
    } finally { await app.close() }
  })

  it('authenticates catalog and history reads and queues package operations with validated input', async () => {
    const fixture = await createFixture()
    let query: string | null = null
    fixture.adapter.modCatalog = async (search) => { query = search; return [] }
    const app = await buildApp({ config: fixture.config, adapter: fixture.adapter, databasePath: ':memory:' })
    await app.ready()
    try {
      expect((await app.inject({ method: 'GET', url: '/api/mod-catalog?search=foo' })).statusCode).toBe(401)
      expect((await app.inject({ method: 'GET', url: '/api/update-history' })).statusCode).toBe(401)
      const cookie = await loginCookie(app)
      expect((await app.inject({ method: 'GET', url: '/api/mod-catalog?search=UXAssist', headers: { cookie } })).statusCode).toBe(200)
      expect(query).toBe('UXAssist')
      expect((await app.inject({ method: 'GET', url: '/api/mod-catalog?search=foo&path=bar', headers: { cookie } })).statusCode).toBe(400)
      expect((await app.inject({ method: 'GET', url: '/api/update-history', headers: { cookie } })).json()).toEqual({ data: [] })
      expect((await app.inject({ method: 'POST', url: '/api/actions', headers: { cookie }, payload: {
        requestId: 'invalid-package', action: 'install-mod', input: { package: '../unmanaged' }
      } })).statusCode).toBe(400)
      for (const [action, input] of [['install-mod', { package: 'soarqin-UXAssist', version: '1.3.10' }], ['rollback-update', { historyId: 'installed-version' }]] as const) {
        expect((await app.inject({ method: 'POST', url: '/api/actions', headers: { cookie }, payload: { requestId: action, action, input } })).statusCode).toBe(202)
      }
      await waitForJobs(app, cookie, 2)
      expect(fixture.adapter.calls.map((entry) => entry.action)).toEqual(['install-mod', 'rollback-update'])
    } finally { await app.close() }
  })

  it('authenticates with a same-origin session cookie and protects control data', async () => {
    const fixture = await createFixture()
    const app = await buildApp({ config: fixture.config, adapter: fixture.adapter, databasePath: ':memory:' })
    await app.ready()

    expect((await app.inject({ method: 'GET', url: '/api/session' })).json()).toEqual({
      data: { authenticated: false, username: 'administrator', source: 'demo' },
    })
    expect((await app.inject({ method: 'GET', url: '/api/overview' })).statusCode).toBe(401)
    expect((await app.inject({ method: 'GET', url: '/api/control-version' })).statusCode).toBe(401)
    expect((await app.inject({
      method: 'POST', url: '/api/session',
      headers: { host: 'localhost:13020', origin: 'https://attacker.example' },
      payload: { password: 'correct horse battery staple' },
    })).statusCode).toBe(403)

    const login = await app.inject({ method: 'POST', url: '/api/session', payload: { password: 'correct horse battery staple' } })
    expect(login.statusCode).toBe(200)
    const cookie = firstSetCookie(login.headers['set-cookie'])
    const overview = await app.inject({ method: 'GET', url: '/api/overview', headers: { cookie } })
    expect(overview.statusCode).toBe(200)
    expect(overview.json().data.name).toBe('Fixture server')
    const controlVersion = await app.inject({ method: 'GET', url: '/api/control-version', headers: { cookie } })
    expect(controlVersion.json().data).toEqual({ product: 'dyson-control', version: expect.stringMatching(/^\d+\.\d+\.\d+/) })

    const logout = await app.inject({ method: 'DELETE', url: '/api/session', headers: { cookie } })
    expect(logout.statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: '/api/jobs', headers: { cookie } })).statusCode).toBe(401)
    await app.close()
  })

  it('validates action-specific input, deduplicates request IDs, and serializes adapter runs', async () => {
    const fixture = await createFixture(25)
    const app = await buildApp({ config: fixture.config, adapter: fixture.adapter, databasePath: ':memory:' })
    await app.ready()
    const cookie = await loginCookie(app)

    const invalid = await app.inject({
      method: 'POST', url: '/api/actions', headers: { cookie },
      payload: { requestId: 'bad-1', action: 'restore', input: { backupId: 'backup-1', extra: true } },
    })
    expect(invalid.statusCode).toBe(400)

    const firstRequest = { requestId: 'request-1', action: 'backup', input: { saveId: 'save-1' } }
    const first = await app.inject({ method: 'POST', url: '/api/actions', headers: { cookie }, payload: firstRequest })
    const duplicate = await app.inject({ method: 'POST', url: '/api/actions', headers: { cookie }, payload: firstRequest })
    const second = await app.inject({
      method: 'POST', url: '/api/actions', headers: { cookie },
      payload: { requestId: 'request-2', action: 'save' },
    })
    expect(first.statusCode).toBe(202)
    expect(duplicate.statusCode).toBe(202)
    expect(duplicate.json().data.id).toBe(first.json().data.id)
    expect(second.statusCode).toBe(202)

    const conflict = await app.inject({
      method: 'POST', url: '/api/actions', headers: { cookie },
      payload: { requestId: 'request-1', action: 'stop' },
    })
    expect(conflict.statusCode).toBe(409)

    await waitForJobs(app, cookie, 2)
    expect(fixture.adapter.maxActive).toBe(1)
    expect(fixture.adapter.calls.map(({ action }) => action)).toEqual(['backup', 'save'])
    await app.close()
  })

  it('compares the selected client package through authenticated routes after a demo runtime update', async () => {
    const fixture = await createFixture()
    const app = await buildApp({ config: fixture.config, databasePath: ':memory:' })
    await app.ready()
    try {
      expect((await app.inject({ method: 'GET', url: '/api/client-packages/unlisted' })).statusCode).toBe(401)
      expect((await app.inject({ method: 'GET', url: '/api/client-package-plan' })).statusCode).toBe(401)
      const cookie = await loginCookie(app)
      const headers = { cookie }
      const action = (name: Action, input = {}) => app.inject({ method: 'POST', url: '/api/actions', headers,
        payload: { action: name, requestId: randomUUID(), input } })
      expect((await app.inject({ method: 'GET', url: '/api/client-package-plan?extra=1', headers })).statusCode).toBe(400)
      const plan = (await app.inject({ method: 'GET', url: '/api/client-package-plan', headers })).json().data
      expect(plan).toMatchObject({ ready: true, blockers: [], mods: expect.arrayContaining([{ name: 'xiaoye97-BepInEx', version: '5.4.17' }]) })
      expect((await app.inject({ method: 'GET', url: '/api/client-packages', headers })).json().data).toEqual([])
      expect((await action('create-client-package')).statusCode).toBe(202)
      await waitForJobs(app, cookie, 1)
      const [item] = (await app.inject({ method: 'GET', url: '/api/client-packages', headers })).json().data as ClientPackage[]
      const url = `/api/client-packages/${item!.id}`
      expect((await app.inject({ method: 'GET', url: url + '?extra=1', headers })).statusCode).toBe(400)
      const original = (await app.inject({ method: 'GET', url, headers })).json().data
      expect(original).toMatchObject({ status: 'current', downloadable: true, profile: {
        address: fixture.config.game.address, mods: expect.arrayContaining([{ name: 'xiaoye97-BepInEx', version: '5.4.17' }])
      } })
      expect(original.profile.mods).not.toContainEqual(expect.objectContaining({ name: 'mikutea-DysonControlBridge' }))
      expect(original.profile.mods).toEqual(plan.mods)
      expect((await action('install-update', { component: 'bepinex', version: '5.4.23' })).statusCode).toBe(202)
      await waitForJobs(app, cookie, 2)
      const changed = (await app.inject({ method: 'GET', url, headers })).json().data
      expect(changed).toMatchObject({ status: 'outdated', profile: original.profile,
        currentMods: expect.arrayContaining([{ name: 'xiaoye97-BepInEx', version: '5.4.23' }]) })
      const download = await app.inject({ method: 'GET', url: item!.downloadUrl, headers })
      expect(download.statusCode).toBe(200)
      expect(createHash('sha256').update(download.rawPayload).digest('hex')).toBe(original.sha256)
    } finally { await app.close() }
  })

  it('serves the verified client bytes when the archive path changes after verification', async () => {
    const fixture = await createFixture()
    const adapter = new DemoGameAdapter(fixture.config)
    const item = await adapter.run('create-client-package', {}, () => {}, new AbortController().signal)
    const id = String(item.packageId)
    const expected = await adapter.clientPackageDetails(id)
    expect(expected.status).toBe('current')
    const readDownload = adapter.download.bind(adapter)
    vi.spyOn(adapter, 'download').mockImplementationOnce(async (kind, selectedId) => {
      const verified = await readDownload(kind, selectedId)
      expect(verified.verifiedBytes).toBeDefined()
      await writeFile(verified.path!, Buffer.alloc(verified.verifiedBytes!.length, 0x41))
      return verified
    })
    const app = await buildApp({ config: fixture.config, adapter, databasePath: ':memory:' })
    try {
      const headers = { cookie: await loginCookie(app) }
      const url = `/api/client-packages/${id}/download`
      const response = await app.inject({ method: 'GET', url, headers })
      expect(response.statusCode).toBe(200)
      expect(createHash('sha256').update(response.rawPayload).digest('hex')).toBe(expected.sha256)
      const next = await app.inject({ method: 'GET', url, headers })
      expect(next.statusCode).toBeGreaterThanOrEqual(400)
      expect(next.json().error.code).toBe('PACKAGE_CHECKSUM_FAILED')
    } finally { await app.close() }
  })

  it('serves adapter downloads only to authenticated sessions', async () => {
    const fixture = await createFixture()
    const file = join(fixture.directory, 'bundle.zip')
    await writeFile(file, 'fixture archive')
    fixture.adapter.download = async () => ({ path: file, fileName: 'client bundle.zip', contentType: 'application/zip' })
    const app = await buildApp({ config: fixture.config, adapter: fixture.adapter, databasePath: ':memory:' })
    await app.ready()
    expect((await app.inject({ method: 'GET', url: '/api/client-packages/package-1/download' })).statusCode).toBe(401)

    const response = await app.inject({ method: 'GET', url: '/api/client-packages/package-1/download', headers: { cookie: await loginCookie(app) } })
    expect(response.statusCode).toBe(200)
    expect(response.body).toBe('fixture archive')
    expect(response.headers['content-disposition']).toContain('client bundle.zip')
    await app.close()
  })

  it.each(['windows', 'demo'] as const)('exports verified members despite an unrelated linked ZIP in the %s cache', async mode => {
    const { config, directory } = await createFixture()
    config.mode = mode
    config.dataDirectory = join(directory, 'data')
    config.game.root = join(directory, 'game')
    config.game.saveDirectory = join(directory, 'saves')
    config.game.backupDirectory = join(directory, 'backups')
    config.game.bridgeDirectory = join(directory, 'bridge')
    const id = 'historic-backup', saveName = '旧星系'
    const group = join(config.game.backupDirectory, id)
    const downloads = join(config.dataDirectory, mode === 'windows' ? 'downloads' : 'demo-downloads')
    await Promise.all([mkdir(group, { recursive: true }), mkdir(downloads, { recursive: true })])
    const files = ['.dsv', '.server', '.moddsv'].map(ext => ({ name: saveName + ext, data: Buffer.from('verified-' + ext) }))
    const manifest = Buffer.from(JSON.stringify({ schema: 1, id, saveName, createdAt: '2020-01-01T00:00:00Z', reason: 'imported',
      members: files.map(({ name, data }) => ({ fileName: name, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') })) }))
    await writeFile(join(group, 'manifest.json'), manifest)
    for (const file of files) await writeFile(join(group, file.name), file.data)
    const foreign = join(directory, 'unrelated.zip')
    const wrong = buildStoredZip([{ name: 'manifest.json', data: manifest }, ...files.map(file => ({ ...file, data: Buffer.alloc(file.data.length, 0x41) }))])
    await writeFile(foreign, wrong)
    await link(foreign, join(downloads, id + '.zip'))
    await link(foreign, join(group, 'uploaded.zip'))
    const adapter = mode === 'demo' ? new DemoGameAdapter(config) : new WindowsGameAdapter(config, {
      inspect: async () => ({ process: null, tasks: { start: true, startManaged: true, configuredTargetUps: null },
        versions: { game: null, nebula: null, bepinex: null } })
    })
    const app = await buildApp({ config, adapter, databasePath: ':memory:' })
    try {
      const url = '/api/backups/' + id + '/download'
      expect((await app.inject({ url })).statusCode).toBe(401)
      const headers = { cookie: await loginCookie(app) }
      const get = () => app.inject({ url, headers })
      const [first, second] = await Promise.all([get(), get()])
      expect(first.statusCode).toBe(200)
      expect(Number(first.headers['content-length'])).toBe(first.rawPayload.length)
      expect(second.statusCode).toBe(200)
      expect(first.rawPayload).toEqual(second.rawPayload)
      expect(first.rawPayload).not.toEqual(wrong)
      const extracted = join(directory, 'exported')
      await extractZipBuffer(first.rawPayload, extracted)
      expect((await readdir(extracted)).sort()).toEqual(['manifest.json', ...files.map(file => file.name)].sort())
      expect(await readFile(join(extracted, 'manifest.json'))).toEqual(manifest)
      for (const file of files) expect(await readFile(join(extracted, file.name))).toEqual(file.data)

      const member = join(group, files[1]!.name)
      await writeFile(member, Buffer.alloc(files[1]!.data.length, 0x41))
      const damaged = await get()
      expect(damaged.statusCode).toBe(409)
      expect(damaged.json().error.code).toBe('BACKUP_VERIFICATION_FAILED')
      await unlink(member)
      const external = join(directory, 'linked-server')
      await writeFile(external, files[1]!.data)
      await link(external, member)
      expect((await get()).statusCode).toBe(409)
      expect(await readFile(external)).toEqual(files[1]!.data)
      expect(await readFile(foreign)).toEqual(wrong)
      expect(await readFile(join(downloads, id + '.zip'))).toEqual(wrong)
    } finally { await app.close() }
  })

  it('accepts unavailable settings as null and never forwards derived read-only metadata', async () => {
    const fixture = await createFixture()
    const app = await buildApp({ config: fixture.config, adapter: fixture.adapter, databasePath: ':memory:' })
    await app.ready()
    const cookie = await loginCookie(app)
    const response = await app.inject({
      method: 'POST', url: '/api/actions', headers: { cookie },
      payload: {
        requestId: 'settings-null', action: 'write-settings', input: {
          settings: {
            serverName: 'Fixture server', maxPlayers: null, targetUps: 60, autosaveMinutes: null,
            backupKeep: 20, address: '127.0.0.1:8469', readOnlyFields: ['maxPlayers', 'autosaveMinutes'],
          },
        },
      },
    })
    expect(response.statusCode).toBe(202)
    await waitForJobs(app, cookie, 1)
    expect(fixture.adapter.calls[0]?.input.settings).toEqual({
      serverName: 'Fixture server', maxPlayers: null, targetUps: 60, autosaveMinutes: null,
      backupKeep: 20, address: '127.0.0.1:8469',
    })
    await app.close()
  })

  it('authenticates cancellation, discards only the bound staged import, and replays the same SQLite receipt after restart', async () => {
    const fixture = await createFixture()
    const databasePath = join(fixture.directory, 'cancel-test.sqlite')
    let release = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    let running = false, aborted = false
    const calls: Action[] = []
    fixture.adapter.run = async (action, _input, _report, signal) => {
      calls.push(action)
      signal.addEventListener('abort', () => { aborted = true }, { once: true })
      running = true
      await gate
      return { action }
    }
    let app = await buildApp({ config: fixture.config, adapter: fixture.adapter, databasePath })
    try {
      let cookie = await loginCookie(app)
      const submit = (requestId: string, action: Action, input = {}) => app.inject({ method: 'POST', url: '/api/actions', headers: { cookie }, payload: { requestId, action, input } })
      const cancel = (id: string, headers = { cookie }) => app.inject({ method: 'POST', url: '/api/jobs/' + id + '/cancel', headers, payload: {} })
      const active = (await submit('hold-worker', 'save')).json().data as Job
      await vi.waitFor(() => expect(running).toBe(true))
      const runningReply = await cancel(active.id)
      expect(runningReply.statusCode).toBe(409)
      expect(runningReply.json().error.code).toBe('job_already_running')
      const headers = { cookie, 'content-type': 'application/zip', 'x-request-id': 'discard-upload' }
      const bytes = Buffer.from('staged fixture ZIP never used')
      const imported = (await app.inject({ method: 'POST', url: '/api/backups/import', headers, payload: bytes })).json().data as Job
      const store = new JobStore(databasePath)
      const uploadId = String(store.input(imported.id).uploadId)
      store.close()
      const uploadDir = join(fixture.config.dataDirectory, 'uploads')
      const metadata = await readFile(join(uploadDir, uploadId + '.json'))
      expect(await readFile(join(uploadDir, uploadId + '.zip'))).toEqual(bytes)
      expect((await submit('wrong-upload-owner', 'import-backup', { uploadId })).statusCode).toBe(409)

      const url = '/api/jobs/' + imported.id + '/cancel'
      expect((await app.inject({ method: 'POST', url, payload: {} })).statusCode).toBe(401)
      expect((await app.inject({ method: 'POST', url, headers: { cookie, origin: 'https://foreign.invalid' }, payload: {} })).statusCode).toBe(403)
      expect((await app.inject({ method: 'POST', url: url + '?extra=1', headers: { cookie }, payload: {} })).statusCode).toBe(400)
      expect((await app.inject({ method: 'POST', url, headers: { cookie }, payload: { force: true } })).statusCode).toBe(400)
      const remove = fs.rm.bind(fs)
      const lock = vi.spyOn(fs, 'rm').mockImplementation(async (file, options) => {
        if (file === join(uploadDir, uploadId + '.zip')) throw new Error('fixture: ZIP is temporarily locked')
        await remove(file, options)
      })
      try {
        const pending = await cancel(imported.id)
        expect(pending.statusCode).toBe(503)
        expect(pending.json().error.code).toBe('cancelled_upload_cleanup_pending')
        expect((await app.inject({ method: 'GET', url: '/api/jobs/' + imported.id, headers: { cookie } })).json().data.state).toBe('cancelled')
        expect(await readFile(join(uploadDir, uploadId + '.json'))).toEqual(metadata)
      } finally { lock.mockRestore() }
      const success = await cancel(imported.id)
      expect(success.statusCode).toBe(200)
      const receipt = success.json().data as Job
      expect(receipt).toMatchObject({ id: imported.id, requestId: 'discard-upload', state: 'cancelled', startedAt: null, finishedAt: expect.any(String) })
      expect((await cancel(imported.id)).json().data).toEqual(receipt)
      expect((await app.inject({ method: 'POST', url: '/api/backups/import', headers, payload: bytes })).json().data).toEqual(receipt)
      expect((await submit('discard-upload', 'import-backup', { uploadId })).json().data).toEqual(receipt)
      await expect(readFile(join(uploadDir, uploadId + '.zip'))).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(readFile(join(uploadDir, uploadId + '.json'))).rejects.toMatchObject({ code: 'ENOENT' })
      expect((await app.inject({ method: 'GET', url: '/api/jobs/current', headers: { cookie } })).json().data.id).toBe(active.id)
      const survivor = (await submit('after-cancel', 'backup')).json().data as Job
      release()
      await vi.waitFor(async () => expect((await app.inject({ method: 'GET', url: '/api/jobs/' + survivor.id, headers: { cookie } })).json().data.state).toBe('succeeded'))
      expect(calls).toEqual(['save','backup']); expect(aborted).toBe(false)
      await app.close()
      // Recreate the precise staging residue of a process exit between the DB commit and file cleanup.
      await writeFile(join(uploadDir, uploadId + '.json'), metadata)
      await writeFile(join(uploadDir, uploadId + '.zip'), bytes)
      app = await buildApp({ config: fixture.config, adapter: fixture.adapter, databasePath })
      cookie = await loginCookie(app)
      expect((await app.inject({ method: 'GET', url: '/api/jobs?state=cancelled', headers: { cookie } })).json().data).toEqual([receipt])
      expect((await cancel(imported.id)).json().data).toEqual(receipt)
      await expect(readFile(join(uploadDir, uploadId + '.zip'))).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(readFile(join(uploadDir, uploadId + '.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { release(); await app.close() }
  })

  it('streams backup uploads into an idempotent durable import job', async () => {
    const fixture = await createFixture()
    const app = await buildApp({ config: fixture.config, adapter: fixture.adapter, databasePath: ':memory:' })
    await app.ready()
    const cookie = await loginCookie(app)
    const headers = { cookie, 'content-type': 'application/zip', 'x-request-id': 'upload-request-1' }
    const first = await app.inject({ method: 'POST', url: '/api/backups/import', headers, payload: Buffer.alloc(128 * 1024, 1) })
    expect(first.statusCode).toBe(202)
    await waitForJobs(app, cookie, 1)
    expect(fixture.adapter.calls[0]?.action).toBe('import-backup')
    expect(fixture.adapter.calls[0]?.input.uploadId).toMatch(/^[0-9a-f-]{36}$/)

    const duplicate = await app.inject({ method: 'POST', url: '/api/backups/import', headers, payload: Buffer.from('different body') })
    expect(duplicate.statusCode).toBe(202)
    expect(duplicate.json().data.id).toBe(first.json().data.id)
    expect(fixture.adapter.calls).toHaveLength(1)
    await app.close()
  })

  it('downloads the configured real log file through an authenticated bounded route', async () => {
    const fixture = await createFixture()
    fixture.adapter.source = 'windows'
    await writeFile(fixture.config.game.logFile, 'first line\nlast line\n')
    const app = await buildApp({ config: fixture.config, adapter: fixture.adapter, databasePath: ':memory:' })
    await app.ready()
    expect((await app.inject({ method: 'GET', url: '/api/logs/download' })).statusCode).toBe(401)
    const response = await app.inject({ method: 'GET', url: '/api/logs/download', headers: { cookie: await loginCookie(app) } })
    expect(response.statusCode).toBe(200)
    expect(response.body).toBe('first line\nlast line\n')
    expect(response.headers['x-log-truncated']).toBe('false')
    await app.close()
  })

  it('distinguishes an absent log from an unreadable one and serves the recovered file', async () => {
    const fixture = await createFixture()
    const file = fixture.config.game.logFile
    fixture.adapter.source = 'windows'
    fixture.adapter.logs = () => readGameLogs(file)
    const app = await buildApp({ config: fixture.config, adapter: fixture.adapter, databasePath: ':memory:' })
    try {
      const headers = { cookie: await loginCookie(app) }
      const get = (url: string) => app.inject({ method: 'GET', url, headers })
      expect((await get('/api/logs')).json().data).toEqual([])
      expect((await get('/api/logs/download')).statusCode).toBe(404)
      await mkdir(file)
      for (const url of ['/api/logs', '/api/logs/download']) {
        const response = await get(url)
        expect(response.statusCode).toBe(503)
        expect(response.json().error.code).toBe('LOG_UNAVAILABLE')
        expect(response.body).not.toContain(fixture.directory)
      }
      await rename(file, join(fixture.directory, 'wrong-log-directory'))
      await writeFile(file, '')
      expect((await get('/api/logs/download')).rawPayload).toHaveLength(0)
      const limit = 16 * 1024 * 1024
      const suffix = Buffer.from('\n[Info] A\n')
      const content = Buffer.concat([Buffer.from('discarded prefix'), Buffer.alloc(limit - suffix.length, 32), suffix])
      await writeFile(file, content)
      expect((await get('/api/logs')).json().data[0].message).toBe('[Info] A')
      const recovered = await get('/api/logs/download')
      expect(recovered.statusCode).toBe(200)
      expect(recovered.headers['x-log-truncated']).toBe('true')
      expect(recovered.rawPayload.equals(content.subarray(-limit))).toBe(true)
    } finally { await app.close() }
  })

  it('lets an authenticated tab recover the receipt for a lost action response without replay', async () => {
    const f = await createFixture()
    const app = await buildApp({ config: f.config, adapter: f.adapter, databasePath: ':memory:' })
    try {
      const requestId = randomUUID()
      const url = `/api/jobs/by-request/${requestId}`
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401)
      const headers = { cookie: await loginCookie(app) }
      expect((await app.inject({ method: 'GET', url, headers })).json().data).toBeNull()
      const action = { requestId, action: 'backup', input: { saveId: 'save-1' } }
      const first = await app.inject({ method: 'POST', url: '/api/actions', headers, payload: action })
      expect(first.statusCode).toBe(202)
      await waitForJobs(app, headers.cookie, 1)
      const readback = (await app.inject({ method: 'GET', url, headers })).json().data
      expect(readback).toMatchObject({ id: first.json().data.id, requestId, state: 'succeeded' })
      expect(readback).not.toHaveProperty('input')
      const repeated = await app.inject({ method: 'POST', url: '/api/actions', headers, payload: action })
      expect(repeated.json().data.id).toBe(readback.id)
      expect(f.adapter.calls).toHaveLength(1)
    } finally { await app.close() }
  })

  it('rate limits repeated login failures and returns Chinese API errors', async () => {
    const fixture = await createFixture()
    let now = 1_000
    const app = await buildApp({
      config: fixture.config,
      adapter: fixture.adapter,
      databasePath: ':memory:',
      loginGuard: new LoginGuard({ maxFailures: 2, windowMs: 60_000, blockMs: 30_000, now: () => now }),
    })
    await app.ready()

    const first = await app.inject({ method: 'POST', url: '/api/session', payload: { password: 'wrong password' } })
    expect(first.statusCode).toBe(401)
    expect(first.json().error.message).toContain('密码错误')
    const blocked = await app.inject({ method: 'POST', url: '/api/session', payload: { password: 'wrong password' } })
    expect(blocked.statusCode).toBe(429)
    expect(blocked.headers['retry-after']).toBe('30')
    expect((await app.inject({ method: 'POST', url: '/api/session', payload: { password: 'correct horse battery staple' } })).statusCode).toBe(429)

    now += 30_001
    expect((await app.inject({ method: 'POST', url: '/api/session', payload: { password: 'correct horse battery staple' } })).statusCode).toBe(200)
    await app.close()
  })

  it('trusts forwarded client and protocol metadata only from the loopback proxy', async () => {
    const fixture = await createFixture()
    const app = await buildApp({
      config: fixture.config,
      adapter: fixture.adapter,
      databasePath: ':memory:',
      loginGuard: new LoginGuard({ maxFailures: 2, windowMs: 60_000, blockMs: 30_000 }),
    })
    await app.ready()
    try {
      const proxiedHeaders = { 'x-forwarded-for': '198.51.100.1', 'x-forwarded-proto': 'https' }
      expect((await app.inject({ method: 'POST', url: '/api/session', remoteAddress: '127.0.0.1', headers: proxiedHeaders, payload: { password: 'wrong password' } })).statusCode).toBe(401)
      expect((await app.inject({ method: 'POST', url: '/api/session', remoteAddress: '127.0.0.1', headers: proxiedHeaders, payload: { password: 'wrong password' } })).statusCode).toBe(429)

      const otherClient = await app.inject({
        method: 'POST', url: '/api/session', remoteAddress: '127.0.0.1',
        headers: { 'x-forwarded-for': '198.51.100.2', 'x-forwarded-proto': 'https' },
        payload: { password: 'correct horse battery staple' },
      })
      expect(otherClient.statusCode).toBe(200)
      expect(String(otherClient.headers['set-cookie'])).toMatch(/;\s*Secure\b/i)

      expect((await app.inject({
        method: 'POST', url: '/api/session', remoteAddress: '203.0.113.5',
        headers: { 'x-forwarded-for': '198.51.100.10' }, payload: { password: 'wrong password' },
      })).statusCode).toBe(401)
      expect((await app.inject({
        method: 'POST', url: '/api/session', remoteAddress: '203.0.113.5',
        headers: { 'x-forwarded-for': '198.51.100.11' }, payload: { password: 'wrong password' },
      })).statusCode).toBe(429)
      expect((await app.inject({
        method: 'POST', url: '/api/session', remoteAddress: '203.0.113.5',
        headers: { 'x-forwarded-for': '198.51.100.12' }, payload: { password: 'correct horse battery staple' },
      })).statusCode).toBe(429)

      const directLogin = await app.inject({
        method: 'POST', url: '/api/session', remoteAddress: '203.0.113.6',
        headers: { 'x-forwarded-for': '198.51.100.20', 'x-forwarded-proto': 'https' },
        payload: { password: 'correct horse battery staple' },
      })
      expect(directLogin.statusCode).toBe(200)
      expect(String(directLogin.headers['set-cookie'])).not.toMatch(/;\s*Secure\b/i)

      const originHeaders = { host: 'control.example.test', origin: 'https://control.example.test', 'x-forwarded-proto': 'https' }
      expect((await app.inject({
        method: 'POST', url: '/api/session', remoteAddress: '::1', headers: originHeaders,
        payload: { password: 'correct horse battery staple' },
      })).statusCode).toBe(200)
      expect((await app.inject({
        method: 'POST', url: '/api/session', remoteAddress: '203.0.113.7', headers: originHeaders,
        payload: { password: 'correct horse battery staple' },
      })).statusCode).toBe(403)
    } finally { await app.close() }
  })

  it('aborts the active adapter operation during a clean shutdown', async () => {
    const fixture = await createFixture()
    fixture.adapter.run = async (_action, _input, _report, signal) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => {
        fixture.adapter.abortObserved = true
        reject(signal.reason)
      }, { once: true })
    })
    const app = await buildApp({ config: fixture.config, adapter: fixture.adapter, databasePath: ':memory:' })
    await app.ready()
    const cookie = await loginCookie(app)
    await app.inject({
      method: 'POST', url: '/api/actions', headers: { cookie },
      payload: { requestId: randomUUID(), action: 'restart' },
    })
    await app.close()
    expect(fixture.adapter.abortObserved).toBe(true)
    expect(fixture.adapter.closed).toBe(true)
  })
})

it('exports every retained raw sample in the requested window, including legacy nulls and real zeros', async () => {
  const f = await createFixture()
  const until = Date.UTC(2026, 0, 8, 12)
  const since = until - 3_600_000
  const db = new DatabaseSync(join(f.directory, 'runtime.sqlite'))
  db.exec('CREATE TABLE runtime_samples (at INTEGER PRIMARY KEY, sample TEXT NOT NULL); BEGIN')
  const insert = db.prepare('INSERT INTO runtime_samples VALUES (?, ?)')
  const row = (at: number, value: number) => insert.run(at, JSON.stringify({
    sampledAt: new Date(at).toISOString(), state: 'running', pid: 345, playerCount: 0, ups: value, tps: null,
    cpuPercent: 0, memoryBytes: 1024, diskFreeBytes: null,
  }))
  row(since - 1, 7777)
  for (let i = 0; i < 1200; i++) row(since + i * 2000, i)
  row(until + 1, 8888)
  db.exec('COMMIT'); db.close()
  const app = await buildApp({ config: f.config, adapter: f.adapter, databasePath: ':memory:', runtimeOptions: { clock: () => until } })
  try {
    const csvUrl = '/api/runtime/history/download'
    expect((await app.inject({ url: csvUrl })).statusCode).toBe(401)
    const headers = { cookie: await loginCookie(app) }
    for (const query of ['?hours=0', '?hours=169', '?hours=1&offset=2']) {
      expect((await app.inject({ url: csvUrl + query, headers })).statusCode).toBe(400)
    }
    const csv = await app.inject({ url: csvUrl + '?hours=1', headers })
    expect(csv.statusCode).toBe(200)
    expect(csv.headers['content-type']).toContain('text/csv')
    expect(csv.headers['content-disposition']).toContain('dyson-runtime-1h.csv')
    expect(csv.headers['cache-control']).toBe('no-store')
    const lines = csv.payload.trimEnd().split('\r\n')
    expect(lines[0]).toContain('disk_free_bytes,network_receive_bytes_per_second,network_send_bytes_per_second,game_tick')
    for (let i = 0; i < 1200; i++) {
      expect(lines[i + 1]).toBe(`${new Date(since + i * 2000).toISOString()},running,345,0,${i},,0,1024,,,,`)
    }
    expect(csv.payload).not.toContain(',7777,')
    expect(csv.payload).not.toContain(',8888,')
    const trend = (await app.inject({ url: '/api/runtime/history/trend?hours=1', headers })).json().data
    expect(trend).toMatchObject({ from: new Date(since).toISOString(), to: new Date(until).toISOString(), bucketMs: 15000 })
    expect(trend.samples.length).toBeLessThanOrEqual(720)
    expect(trend.samples[0]).toMatchObject({ ups: 7, networkReceiveBytesPerSecond: null })
    expect(trend.samples.some((s: { ups: number }) => s.ups === 1199)).toBe(true)
    expect(trend.samples).toEqual((await app.inject({ url: '/api/runtime/history?hours=1', headers })).json().data)
  } finally { await app.close() }
})

it('checks Windows startup readiness on demand without queuing a game action', async () => {
  const f = await createFixture()
  let steamReady = false
  const probe = vi.fn(async () => steamReady ? 'ready' as const : 'steam-missing' as const)
  const app = await buildApp({ config: f.config, adapter: { ...f.adapter, source: 'windows', recoveryStartReadiness: probe }, databasePath: ':memory:' })
  try {
    const url = '/api/server/start-readiness'
    expect((await app.inject({ url })).statusCode).toBe(401)
    const headers = { cookie: await loginCookie(app) }
    expect((await app.inject({ url: url + '?task=external', headers })).statusCode).toBe(400)
    expect(probe).not.toHaveBeenCalled()
    const waiting = await app.inject({ url, headers })
    expect(waiting.json().data).toMatchObject({ state: 'steam-missing', message: expect.stringContaining('桌面 Steam') })
    expect(Number.isFinite(Date.parse(waiting.json().data.checkedAt))).toBe(true)
    steamReady = true
    expect((await app.inject({ url, headers })).json().data.state).toBe('ready')
    expect(probe).toHaveBeenCalledTimes(2)
    expect((await app.inject({ url: '/api/jobs', headers })).json().data).toEqual([])
  } finally { await app.close() }
})

it('reports a full export volume separately from a corrupt backup and allows a download retry', async () => {
  const f = await createFixture()
  f.config.dataDirectory = join(f.directory, 'data')
  f.config.game.backupDirectory = join(f.directory, 'backups')
  const adapter = new DemoGameAdapter(f.config)
  const id = String((await adapter.run('backup', {}, () => {}, new AbortController().signal)).backupId)
  const app = await buildApp({ config: f.config, adapter, databasePath: ':memory:' })
  const originalOpen = fs.open.bind(fs)
  try {
    const headers = { cookie: await loginCookie(app) }, url = '/api/backups/' + id + '/download'
    let attempted = 0
    const failWrite = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await originalOpen(...args)
      if (args[1] === 'wx+' && String(args[0]).includes('dyson-backup-export-')) {
        attempted++
        // Allow the manifest's compressed bytes and header. The next write is for a save member.
        const write = handle.write.bind(handle)
        vi.spyOn(handle, 'write').mockImplementationOnce(write).mockImplementationOnce(write)
          .mockRejectedValueOnce(Object.assign(new Error('synthetic temporary volume is full'), { code: 'ENOSPC' }))
      }
      return handle
    })
    let failed
    try { failed = await app.inject({ url, headers }) } finally { failWrite.mockRestore() }
    expect(attempted).toBe(1)
    expect(failed.statusCode).toBe(507)
    expect(failed.json().error).toMatchObject({ code: 'BACKUP_EXPORT_SPACE', message: expect.stringContaining('临时卷空间不足') })
    const unlinkFile = fs.unlink.bind(fs)
    let deniedPath = ''
    const denyOnce = vi.spyOn(fs, 'unlink').mockImplementation(async file => {
      if (!deniedPath && String(file).includes('dyson-backup-export-')) {
        deniedPath = String(file)
        throw Object.assign(new Error('synthetic volume cannot unlink an open handle'), { code: 'EPERM' })
      }
      return unlinkFile(file)
    })
    try {
      const denied = await app.inject({ url, headers })
      expect(denied.statusCode).toBe(503)
      expect(denied.json().error.code).toBe('BACKUP_EXPORT_STORAGE')
    } finally { denyOnce.mockRestore() }
    expect(deniedPath).toBeTruthy()
    await expect(fs.lstat(deniedPath)).rejects.toMatchObject({ code: 'ENOENT' })
    const retry = await app.inject({ url, headers })
    expect(retry.statusCode).toBe(200)
    expect(Number(retry.headers['content-length'])).toBe(retry.rawPayload.length)
  } finally { await app.close() }
})

async function loginCookie(app: Awaited<ReturnType<typeof buildApp>>): Promise<string> {
  const response = await app.inject({ method: 'POST', url: '/api/session', payload: { password: 'correct horse battery staple' } })
  return firstSetCookie(response.headers['set-cookie'])
}

function firstSetCookie(value: string | string[] | undefined): string {
  if (!value) throw new Error('Login response did not set a session cookie.')
  return (Array.isArray(value) ? value[0] : value).split(';', 1)[0]
}

async function waitForJobs(app: Awaited<ReturnType<typeof buildApp>>, cookie: string, expected: number): Promise<Job[]> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const jobs = (await app.inject({ method: 'GET', url: '/api/jobs', headers: { cookie } })).json().data as Job[]
    if (jobs.length === expected && jobs.every((job) => job.state === 'succeeded')) return jobs
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('Timed out waiting for fixture jobs.')
}

interface TestAdapter extends GameAdapter {
  calls: Array<{ action: Action; input: Record<string, unknown> }>
  maxActive: number
  abortObserved: boolean
  closed: boolean
}

async function createFixture(delayMs = 0): Promise<{ directory: string; config: ControlConfig; adapter: TestAdapter }> {
  const directory = await mkdtemp(join(tmpdir(), 'dyson-control-api-'))
  tempDirectories.push(directory)
  const config: ControlConfig = {
    host: '127.0.0.1', port: 13_020, dataDirectory: directory, mode: 'demo',
    adminPasswordHash: await hashPassword('correct horse battery staple'),
    game: {
      root: directory, saveDirectory: directory, backupDirectory: directory, logFile: join(directory, 'server.log'),
      bridgeDirectory: directory, bridgeSecretFile: join(directory, 'secret'), startTaskName: 'start',
      address: '127.0.0.1:8469', serverName: 'Fixture server',
    },
  }
  let active = 0
  const adapter: TestAdapter = {
    source: 'demo', calls: [], maxActive: 0, abortObserved: false, closed: false,
    async recoveryStartReadiness() { return 'ready' },
    async overview(): Promise<Overview> {
      return {
        name: 'Fixture server', source: 'demo', state: 'stopped', sampledAt: new Date().toISOString(), address: '127.0.0.1:8469',
        pid: null, uptimeSeconds: 0, playerCount: 0, maxPlayers: 16, playerStatus: 'available',
        versions: { game: '1.0', nebula: '1.0', bepinex: '1.0' },
        metrics: { cpuPercent: null, memoryBytes: null, totalMemoryBytes: null, diskFreeBytes: null, ups: null, tps: null, networkReceiveBytesPerSecond: null, networkSendBytesPerSecond: null },
        currentSave: 'save-1', lastSavedAt: null,
        capabilities: { lifecycle: true, save: true, restore: true, playerActions: false },
      }
    },
    async players(): Promise<Player[]> { return [] },
    async playerEvents() { return { sessionId: 'fixture-session', processId: 1, writtenAtUnixMs: Date.now(), firstSequence: 0, lastSequence: 0, events: [] } },
    async logs(): Promise<LogEntry[]> { return [] },
    async mods(): Promise<Mod[]> { return [] },
    async modCatalog() { return [] },
    async modInstallPlan() { return [] },
    async modConfigs() { return [] },
    async modConfigHistory() { return [] },
    async modConfigRollbackPreview(historyId) {
      return { historyId, configId: 'demo-config', path: 'demo.cfg', expectedRevision: 'a'.repeat(64), preservedSecretKeys: [], changes: [] }
    },
    async modRemovalHistory() { return [] },
    async versions(): Promise<ComponentVersion[]> { return [] },
    async versionLocks() { return [] },
    async updateHistory() { return [] },
    async saves(): Promise<Save[]> { return [] },
    async backups(): Promise<Backup[]> { return [] },
    async restorePreview(backupId) {
      return { backupId, saveName: 'Fixture', previewKey: 'a'.repeat(64), members: [], serverRunning: false,
        protectedSaveNames: [], protectRunningSave: false, previousStartupSaveName: null, blockers: [] }
    },
    async settings(): Promise<GameSettings> {
      return { serverName: 'Fixture server', maxPlayers: 16, targetUps: 60, autosaveMinutes: 10, backupKeep: 20, address: '127.0.0.1:8469' }
    },
    async settingsHistory() { return [] },
    async clientPackages(): Promise<ClientPackage[]> { return [] },
    async run(action, input, report, signal) {
      adapter.calls.push({ action, input })
      active += 1
      adapter.maxActive = Math.max(adapter.maxActive, active)
      report(`Started ${action}.`)
      try {
        if (delayMs) await abortableDelay(delayMs, signal)
        return { action }
      } finally {
        active -= 1
      }
    },
    async close() { adapter.closed = true },
  }
  return { directory, config, adapter }
}

async function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds)
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason) }, { once: true })
  })
}
