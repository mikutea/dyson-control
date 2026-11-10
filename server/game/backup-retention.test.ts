import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { buffer } from 'node:stream/consumers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ControlConfig, GameAdapter } from '../../shared/contracts.js'
import { buildApp } from '../app.js'
import { hashPassword } from '../auth.js'
import { BackupRetention } from './backup-retention.js'
import { DemoGameAdapter } from './demo.js'
import { WindowsGameAdapter } from './windows.js'
import { extractZipBuffer } from './updates.js'
import { buildStoredZip } from './zip.js'

let root: string
let config: ControlConfig
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'dyson-rotation-'))
  config = {
    mode: 'windows', host: '127.0.0.1', port: 4173, dataDirectory: path.join(root, 'data'), adminPasswordHash: 'fixture',
    game: { root: path.join(root, 'game'), saveDirectory: path.join(root, 'saves'), backupDirectory: path.join(root, 'backups'),
      bridgeDirectory: path.join(root, 'bridge'), bridgeSecretFile: path.join(root, 'secret'), logFile: path.join(root, 'log'),
      startTaskName: 'fixture', address: 'fixture.test', serverName: 'Fixture' }
  }
  await Promise.all([fs.mkdir(config.dataDirectory), fs.mkdir(config.game.saveDirectory), fs.mkdir(config.game.backupDirectory)])
  for (const ext of ['dsv', 'server', 'moddsv']) await fs.writeFile(path.join(config.game.saveDirectory, 'World.' + ext), 'live-' + ext)
})
afterEach(async () => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  await fs.rm(root, { recursive: true, force: true })
})

const run = (adapter: GameAdapter, action: Parameters<GameAdapter['run']>[0], input = {}) =>
  adapter.run(action, input, () => {}, new AbortController().signal)
const openAdapter = (): GameAdapter => config.mode === 'demo' ? new DemoGameAdapter(config) : new WindowsGameAdapter(config, {
  inspect: async () => ({ process: null, versions: { game: null, nebula: null, bepinex: null }, tasks: { start: true, startManaged: true, configuredTargetUps: null } }),
  runScript: async () => { throw new Error('Retention must not operate on the host') }
})

async function seedBackup(id: string, date: string, reason = 'automatic-scheduled') {
  const dir = path.join(config.game.backupDirectory, id)
  await fs.mkdir(dir)
  const members = []
  for (const ext of ['dsv', 'server', 'moddsv']) {
    const fileName = 'World.' + ext
    const content = Buffer.from(id + '-' + ext)
    await fs.writeFile(path.join(dir, fileName), content)
    members.push({ fileName, bytes: content.length, sha256: createHash('sha256').update(content).digest('hex') })
  }
  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ schema: 1, id, saveName: 'World', createdAt: date, reason, members }))
  return dir
}

async function groupSnapshot(dir: string) {
  const names = (await fs.readdir(dir)).sort()
  return Promise.all(names.map(async name => [name, await fs.readFile(path.join(dir, name))]))
}

describe('automatic backup retention', () => {
  it('shows and retains the newest instant across differently formatted time zone offsets', async () => {
    await seedBackup('older-utc', '2026-11-06T12:00:00+08:00')
    await seedBackup('newer-utc', '2026-11-06T06:00:00Z')
    const keeper = new BackupRetention(config.game.backupDirectory, config.dataDirectory, path.join(config.dataDirectory, 'downloads'))
    expect((await keeper.list()).map(backup => backup.id)).toEqual(['newer-utc', 'older-utc'])
    expect(await keeper.prune(1, new Set())).toBe(1)
    expect((await keeper.list()).map(backup => backup.id)).toEqual(['newer-utc'])
  })
  it.each(['windows', 'demo'] as const)('preserves retained backups beyond the rolling count, across %s restarts, until a later rotation after release', async mode => {
    config.mode = mode
    let adapter = openAdapter()
    const settings = await adapter.settings()
    await run(adapter, 'write-settings', { settings: { ...settings, backupKeep: 2 } })
    vi.useFakeTimers({ toFake: ['Date'] })
    const make = async (day: number) => {
      vi.setSystemTime(new Date(Date.UTC(2026, 0, day)))
      return String((await run(adapter, 'backup', { automatic: true })).backupId)
    }
    const id = await make(1)
    const dir = path.join(config.game.backupDirectory, id)
    const before = await groupSnapshot(dir)
    const downloads = path.join(config.dataDirectory, mode === 'demo' ? 'demo-downloads' : 'downloads')
    const cache = path.join(downloads, id + '.zip')
    await fs.mkdir(downloads, { recursive: true })
    await fs.writeFile(cache, buildStoredZip(before.map(([name, data]) => ({ name: String(name), data }))))
    const zipBefore = await fs.readFile(cache)
    expect(await run(adapter, 'set-backup-retained', { backupId: id, retained: true })).toEqual({ backupId: id, retained: true })
    await run(adapter, 'set-backup-retained', { backupId: id, retained: true })
    const b = await make(2)
    const c = await make(3)
    expect((await adapter.backups()).map(item => item.id)).toEqual([c, b, id])
    const d = await make(4)
    expect((await adapter.backups()).map(item => item.id)).toEqual([d, c, id])
    adapter = openAdapter()
    expect((await adapter.backups()).find(item => item.id === id)?.retained).toBe(true)
    const download = await adapter.download!('backup', id)
    const extracted = path.join(root, 'downloaded')
    await extractZipBuffer(await buffer(download.stream!), extracted)
    expect(await groupSnapshot(extracted)).toEqual(before)
    expect(await groupSnapshot(dir)).toEqual(before)

    await run(adapter, 'write-settings', { settings: { ...await adapter.settings(), backupKeep: 2 } })
    await run(adapter, 'set-backup-retained', { backupId: id, retained: false })
    await run(adapter, 'set-backup-retained', { backupId: id, retained: false })
    expect((await adapter.backups()).find(item => item.id === id)?.retained).toBe(false)
    expect(await groupSnapshot(dir)).toEqual(before)
    expect(await fs.readFile(cache)).toEqual(zipBefore)
    const e = await make(5)
    expect((await adapter.backups()).map(item => item.id)).toEqual([e, d])
    await expect(fs.lstat(dir)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.lstat(cache)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await fs.readFile(path.join(config.game.saveDirectory, 'World.dsv'), 'utf8')).toBe('live-dsv')
  })

  it('pins an existing pre-change protection group without altering its manifest, and leaves manual/imported groups outside the policy', async () => {
    const adapter = openAdapter()
    await adapter.backups()
    const old = await seedBackup('old-protection', '2020-01-01T00:00:00Z', 'automatic-before-update')
    const before = await groupSnapshot(old)
    for (const reason of ['manual', 'imported', 'automatic-unrecognized']) await seedBackup(reason, '2020-01-02T00:00:00Z', reason)
    expect((await adapter.backups()).find(item => item.id === 'old-protection')?.retained).toBe(false)
    await run(adapter, 'set-backup-retained', { backupId: 'old-protection', retained: true })
    for (const id of ['manual', 'imported', 'automatic-unrecognized']) {
      await expect(run(adapter, 'set-backup-retained', { backupId: id, retained: true })).rejects.toMatchObject({ code: 'BACKUP_RETENTION_INELIGIBLE' })
      expect((await adapter.backups()).find(item => item.id === id)).not.toHaveProperty('retained')
    }
    expect(await groupSnapshot(old)).toEqual(before)
  })

  it('leaves invalid markers, foreign files, damaged members, extra links, and anomalous caches intact', async () => {
    const downloads = path.join(config.dataDirectory, 'downloads'), markers = path.join(config.dataDirectory, 'backup-retention')
    await Promise.all([fs.mkdir(downloads), fs.mkdir(markers)])
    const keeper = new BackupRetention(config.game.backupDirectory, config.dataDirectory, downloads)
    for (const id of ['unclear', 'mixed', 'damaged', 'linked', 'cache-dir', 'cache-link', 'eligible-old', 'latest']) {
      await seedBackup(id, id === 'latest' ? '2026-03-01T00:00:00Z' : id === 'eligible-old' ? '2026-01-01T00:00:00Z' : '2026-02-01T00:00:00Z')
    }
    const marker = path.join(markers, 'unclear.json')
    await fs.writeFile(marker, 'user file')
    const file = (id: string, name: string) => path.join(config.game.backupDirectory, id, name)
    await fs.writeFile(file('mixed', 'notes.txt'), 'foreign')
    await fs.writeFile(file('damaged', 'World.dsv'), 'x'.repeat(Buffer.byteLength('damaged-dsv')))
    await fs.link(file('linked', 'World.dsv'), path.join(root, 'shared-file'))
    await fs.mkdir(path.join(downloads, 'cache-dir.zip'))
    await fs.writeFile(path.join(downloads, 'cache-dir.zip', 'keep.txt'), 'foreign cache directory')
    await fs.writeFile(path.join(root, 'outside'), 'foreign data')
    await fs.link(path.join(root, 'outside'), path.join(downloads, 'cache-link.zip'))
    await fs.writeFile(path.join(downloads, 'unclear.zip'), 'keep-cache')
    await fs.writeFile(path.join(downloads, 'eligible-old.zip'), 'expire-cache')
    expect((await keeper.list()).find(item => item.id === 'unclear')?.retained).toBeNull()
    for (const retained of [true, false]) await expect(keeper.set({ backupId: 'unclear', retained }, () => {})).rejects.toMatchObject({ code: 'BACKUP_RETENTION_UNKNOWN' })
    expect(await keeper.prune(1, new Set())).toBe(1)
    expect(await fs.readdir(config.game.backupDirectory)).toHaveLength(7)
    expect(await fs.readFile(file('mixed', 'notes.txt'), 'utf8')).toBe('foreign')
    expect(await fs.readFile(file('damaged', 'World.dsv'), 'utf8')).toBe('x'.repeat(11))
    expect(await fs.readFile(path.join(root, 'outside'), 'utf8')).toBe('foreign data')
    expect(await fs.readFile(path.join(downloads, 'cache-dir.zip', 'keep.txt'), 'utf8')).toBe('foreign cache directory')
    expect(await fs.readFile(marker, 'utf8')).toBe('user file')
    expect(await fs.readFile(path.join(downloads, 'unclear.zip'), 'utf8')).toBe('keep-cache')
    await expect(fs.lstat(path.join(downloads, 'eligible-old.zip'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('accepts a strict, authenticated idempotent action through the durable queue', async () => {
    config.mode = 'demo'
    config.adminPasswordHash = await hashPassword('retention-fixture')
    const adapter = openAdapter()
    const id = String((await run(adapter, 'backup', { automatic: true })).backupId)
    const app = await buildApp({ config, adapter, databasePath: ':memory:' })
    try {
      const payload = { action: 'set-backup-retained', requestId: 'retain-1', input: { backupId: id, retained: true } }
      const url = '/api/actions'
      expect((await app.inject({ method: 'POST', url, payload })).statusCode).toBe(401)
      const login = await app.inject({ method: 'POST', url: '/api/session', payload: { password: 'retention-fixture' } })
      const header = login.headers['set-cookie']
      const headers = { cookie: (Array.isArray(header) ? header[0]! : header!).split(';')[0]! }
      for (const input of [{ backupId: id, retained: 'false' }, { backupId: id, retained: true, force: true }]) {
        expect((await app.inject({ method: 'POST', url, headers, payload: { ...payload, input } })).statusCode).toBe(400)
      }
      const submitted = await app.inject({ method: 'POST', url, headers, payload })
      expect(submitted.statusCode).toBe(202)
      const jobId = submitted.json().data.id
      expect((await app.inject({ method: 'POST', url, headers, payload })).json().data.id).toBe(jobId)
      await vi.waitFor(async () => {
        const job = await app.inject({ method: 'GET', url: '/api/jobs/' + jobId, headers })
        expect(job.json().data).toMatchObject({ state: 'succeeded', result: { backupId: id, retained: true } })
      })
      expect((await app.inject({ method: 'GET', url: '/api/backups', headers })).json().data[0]).toMatchObject({ id, retained: true })
    } finally { await app.close() }
  })

  it('restores the backup unchanged when the matching download cache cannot be removed', async () => {
    const downloads = path.join(config.dataDirectory, 'downloads')
    await fs.mkdir(downloads)
    const keeper = new BackupRetention(config.game.backupDirectory, config.dataDirectory, downloads)
    const old = await seedBackup('old', '2025-01-01T00:00:00Z')
    await seedBackup('new', '2026-01-01T00:00:00Z')
    const before = await groupSnapshot(old)
    const cache = path.join(downloads, 'old.zip')
    await fs.writeFile(cache, 'in use')
    const unlink = fs.unlink.bind(fs)
    vi.spyOn(fs, 'unlink').mockImplementation(async file => {
      if (file === cache) throw new Error('fixture: file in use')
      await unlink(file)
    })
    const reports: string[] = []
    expect(await keeper.prune(1, new Set(), message => reports.push(message))).toBe(0)
    expect(reports.join(' ')).toContain('跳过 old')
    expect(await groupSnapshot(old)).toEqual(before)
    expect(await fs.readFile(cache, 'utf8')).toBe('in use')
    expect((await fs.readdir(config.game.backupDirectory)).sort()).toEqual(['new', 'old'])
  })

  it('restores the entire group when a marker or unrelated file appears between selecting it and pruning it', async () => {
    const downloads = path.join(config.dataDirectory, 'downloads'), markers = path.join(config.dataDirectory, 'backup-retention')
    await Promise.all([fs.mkdir(downloads), fs.mkdir(markers)])
    const keeper = new BackupRetention(config.game.backupDirectory, config.dataDirectory, downloads)
    const old = await seedBackup('old', '2025-01-01T00:00:00Z')
    const changed = await seedBackup('changed', '2025-01-02T00:00:00Z')
    await seedBackup('new', '2026-01-01T00:00:00Z')
    const before = await groupSnapshot(old)
    await fs.writeFile(path.join(downloads, 'old.zip'), 'old-cache')
    const move = fs.rename.bind(fs)
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      await move(from, to)
      if (from === old) await fs.writeFile(path.join(markers, 'old.json'), 'appeared-during-prune')
      if (from === changed) await fs.writeFile(path.join(String(to), 'do-not-remove'), 'late file')
    })
    expect(await keeper.prune(1, new Set())).toBe(0)
    expect(await groupSnapshot(old)).toEqual(before)
    expect(await fs.readFile(path.join(changed, 'do-not-remove'), 'utf8')).toBe('late file')
    expect(await fs.readFile(path.join(downloads, 'old.zip'), 'utf8')).toBe('old-cache')
    expect(await fs.readdir(config.game.backupDirectory)).not.toEqual(expect.arrayContaining([expect.stringMatching(/^\.prune-/)]))
  })
})
