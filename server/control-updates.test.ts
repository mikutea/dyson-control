import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ControlConfig } from '../shared/contracts.js'
import { buildStoredZip } from './game/zip.js'
import { ControlUpdateError, ControlUpdateManager, type ControlUpdateOperation } from './control-updates.js'

const roots: string[] = []
const repository = 'example/dyson-control'

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })))
})

async function fixtureRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dyson-control-self-update-'))
  roots.push(root)
  return root
}

function config(root: string, mode: 'demo' | 'windows' = 'demo'): ControlConfig & { controlUpdates: { repository: string } } {
  return {
    host: '127.0.0.1', port: 13_020, dataDirectory: path.join(root, 'data'), mode,
    adminPasswordHash: `scrypt$v1$16384$8$1$${'a'.repeat(22)}$${'b'.repeat(43)}`,
    controlUpdates: { repository },
    game: {
      root: path.join(root, 'game'), saveDirectory: path.join(root, 'saves'), backupDirectory: path.join(root, 'backups'),
      logFile: path.join(root, 'game.log'), bridgeDirectory: path.join(root, 'bridge'), bridgeSecretFile: path.join(root, 'secret'),
      startTaskName: 'Dyson-Game-Fixture', address: '127.0.0.1:8469', serverName: 'Fixture',
    },
  }
}

function panelArchive(version: string): Buffer {
  const files: Array<{ name: string; data: string }> = [
    { name: 'package.json', data: JSON.stringify({ name: 'dyson-control', version }) },
    { name: 'package-lock.json', data: JSON.stringify({ name: 'dyson-control', version, lockfileVersion: 3, packages: { '': { name: 'dyson-control', version } } }) },
    { name: 'control.config.example.json', data: '{}' }, { name: 'LICENSE', data: 'GPL fixture' },
    { name: 'README.md', data: '# fixture' }, { name: 'GOAL.md', data: '# fixture' },
    { name: 'dist/server/index.js', data: 'export {}' }, { name: 'dist/shared/contracts.js', data: 'export {}' },
    { name: 'dist/web/index.html', data: '<!doctype html>' },
    ...['install-control.ps1', 'upgrade-control.ps1', 'uninstall-control.ps1', 'configure-game.ps1', 'control-update-helper.ps1']
      .map(name => ({ name: `scripts/windows/${name}`, data: '# fixture' })),
    { name: 'release-manifest.json', data: JSON.stringify({ schema: 1, product: 'dyson-control', packageVersion: version, kind: 'panel-only', bridge: null }) },
  ]
  return buildStoredZip(files)
}

function releaseFetch(version: string, archive = panelArchive(version), checksum = createHash('sha256').update(archive).digest('hex')): typeof fetch {
  const archiveName = `dyson-control-v${version}-windows-panel-only.zip`
  const archiveUrl = `https://github.com/${repository}/releases/download/v${version}/${archiveName}`
  const checksumUrl = `${archiveUrl}.sha256`
  const checksumBody = `${checksum}  ${archiveName}\n`
  const release = {
    tag_name: `v${version}`, draft: false, prerelease: false, published_at: '2026-10-17T00:00:00.000Z',
    html_url: `https://github.com/${repository}/releases/tag/v${version}`,
    assets: [
      { name: archiveName, browser_download_url: archiveUrl, size: archive.length },
      { name: `${archiveName}.sha256`, browser_download_url: checksumUrl, size: Buffer.byteLength(checksumBody) },
    ],
  }
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input)
    if (url === `https://api.github.com/repos/${repository}/releases/latest`) return response(JSON.stringify(release), 'application/json')
    if (url === archiveUrl) return response(archive)
    if (url === checksumUrl) return response(checksumBody)
    return new Response('missing', { status: 404 })
  }) as unknown as typeof fetch
}

function response(body: string | Buffer, contentType = 'application/octet-stream'): Response {
  const bytes = typeof body === 'string' ? Buffer.from(body) : body
  return new Response(new Uint8Array(bytes), { status: 200, headers: { 'content-type': contentType, 'content-length': String(bytes.length) } })
}

async function waitForTerminal(manager: ControlUpdateManager, id: string): Promise<ControlUpdateOperation> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const operation = await manager.read(id)
    if (['ready', 'succeeded', 'rolledBack', 'failed'].includes(operation.state)) return operation
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('operation did not settle')
}

async function installedLayout(root: string, version: string, taskName = 'Dyson-Control-Fixture'): Promise<{ installRoot: string; versionRoot: string }> {
  const installRoot = path.join(root, 'installed')
  const versionRoot = path.join(installRoot, 'versions', version)
  await fs.mkdir(path.join(versionRoot, 'scripts', 'windows'), { recursive: true })
  await fs.writeFile(path.join(versionRoot, 'scripts', 'windows', 'control-update-helper.ps1'), '# fixture')
  await fs.writeFile(path.join(versionRoot, 'scripts', 'windows', 'upgrade-control.ps1'), '# fixture')
  await fs.writeFile(path.join(installRoot, 'install-state.json'), JSON.stringify({
    schema: 1, product: 'dyson-control', taskName, taskPath: '\\', installRoot,
    configPath: path.join(root, 'config.json'), dataDirectory: path.join(root, 'data'), nodePath: 'node.exe', npmPath: 'npm.cmd',
    activeVersion: version, releaseKind: 'panel-only', bridgeCandidate: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  }))
  return { installRoot, versionRoot }
}

describe('control update discovery and preparation', () => {
  it('does not invent a latest version when no source is configured', async () => {
    const root = await fixtureRoot()
    const withoutSource = { ...config(root), controlUpdates: undefined }
    const manager = new ControlUpdateManager({ config: withoutSource, currentVersion: '0.1.0', fetch: vi.fn() as unknown as typeof fetch })
    await manager.initialize()
    await expect(manager.discover()).resolves.toMatchObject({ availability: 'unavailable', latestVersion: null, canPrepare: false, canApply: false })
    await manager.close()
  })

  it('prepares one hash-pinned panel-only candidate and keeps requestId idempotent', async () => {
    const root = await fixtureRoot()
    const manager = new ControlUpdateManager({ config: config(root), currentVersion: '0.1.0', fetch: releaseFetch('0.2.0') })
    await manager.initialize()
    await expect(manager.discover()).resolves.toMatchObject({ availability: 'available', latestVersion: '0.2.0', canPrepare: true, canApply: false })
    const first = await manager.prepare({ requestId: 'prepare-1', expectedVersion: '0.2.0' })
    expect(first.receiptToken).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const duplicate = await manager.prepare({ requestId: 'prepare-1', expectedVersion: '0.2.0' })
    expect(duplicate.operation.id).toBe(first.operation.id)
    expect(duplicate.receiptToken).toBeNull()
    const settled = await waitForTerminal(manager, first.operation.id)
    expect(settled.state, settled.message).toBe('ready')
    expect(settled).toMatchObject({ step: 'prepared', sha256: expect.stringMatching(/^[0-9a-f]{64}$/) })
    await expect(manager.readWithReceipt(first.operation.id, first.receiptToken!)).resolves.toMatchObject({ state: 'ready' })
    await manager.acknowledgeReceipt(first.operation.id, first.receiptToken!)
    await expect(manager.readWithReceipt(first.operation.id, first.receiptToken!)).rejects.toMatchObject({ code: 'RECEIPT_INVALID' })
    await manager.close()
  })

  it('fails closed for a checksum mismatch and retains a terminal history record', async () => {
    const root = await fixtureRoot()
    const manager = new ControlUpdateManager({ config: config(root), currentVersion: '0.1.0', fetch: releaseFetch('0.2.0', panelArchive('0.2.0'), '0'.repeat(64)) })
    await manager.initialize()
    const started = await manager.prepare({ requestId: 'bad-checksum', expectedVersion: '0.2.0' })
    await expect(waitForTerminal(manager, started.operation.id)).resolves.toMatchObject({ state: 'failed', message: '面板更新包 SHA-256 校验失败。' })
    await expect(manager.history()).resolves.toHaveLength(1)
    await manager.close()
  })

  it('expires an unapplied ready candidate after 24 hours and removes staged files', async () => {
    const root = await fixtureRoot()
    let now = Date.parse('2026-10-17T00:00:00.000Z')
    const manager = new ControlUpdateManager({ config: config(root), currentVersion: '0.1.0', fetch: releaseFetch('0.2.0'), clock: () => now })
    await manager.initialize()
    const started = await manager.prepare({ requestId: 'expire-ready', expectedVersion: '0.2.0' })
    await waitForTerminal(manager, started.operation.id)
    now += 24 * 60 * 60 * 1000 + 1
    await expect(manager.read(started.operation.id)).resolves.toMatchObject({ state: 'failed', message: expect.stringContaining('24 小时') })
    await expect(fs.stat(path.join(root, 'data', 'control-updates', 'operations', started.operation.id, 'source'))).rejects.toMatchObject({ code: 'ENOENT' })
    await manager.close()
  })

  it('marks an in-flight download interrupted when close aborts preparation', async () => {
    const root = await fixtureRoot()
    const base = releaseFetch('0.2.0')
    const archiveUrl = `https://github.com/${repository}/releases/download/v0.2.0/dyson-control-v0.2.0-windows-panel-only.zip`
    const blocked = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input) !== archiveUrl) return base(input, init)
      return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }))
    }) as unknown as typeof fetch
    const manager = new ControlUpdateManager({ config: config(root), currentVersion: '0.1.0', fetch: blocked })
    await manager.initialize()
    const started = await manager.prepare({ requestId: 'abort-prepare', expectedVersion: '0.2.0' })
    await manager.close()
    await expect(manager.read(started.operation.id)).resolves.toMatchObject({ state: 'failed', message: '更新准备已中断。' })
  })

  it('aborts an in-flight latest-release discovery when the manager closes', async () => {
    const root = await fixtureRoot()
    let notifyStarted!: () => void
    const started = new Promise<void>(resolve => { notifyStarted = resolve })
    const blocked = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      notifyStarted()
      return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }))
    }) as unknown as typeof fetch
    const manager = new ControlUpdateManager({ config: config(root), currentVersion: '0.1.0', fetch: blocked })
    await manager.initialize()
    const preparing = manager.prepare({ requestId: 'abort-discovery', expectedVersion: '0.2.0' })
    await started
    await manager.close()
    await expect(preparing).rejects.toMatchObject({ code: 'UPDATE_MANAGER_CLOSED' })
    await expect(manager.history()).resolves.toEqual([])
  })
})

describe('control update application evidence', () => {
  it('rejects apply in source/demo mode after allowing preparation', async () => {
    const root = await fixtureRoot()
    const manager = new ControlUpdateManager({ config: config(root), currentVersion: '0.1.0', fetch: releaseFetch('0.2.0') })
    await manager.initialize()
    const started = await manager.prepare({ requestId: 'prepare-demo', expectedVersion: '0.2.0' })
    await waitForTerminal(manager, started.operation.id)
    await expect(manager.apply({ operationId: started.operation.id, requestId: 'apply-demo' }))
      .rejects.toMatchObject({ code: 'UPDATE_EXECUTION_UNAVAILABLE' } satisfies Partial<ControlUpdateError>)
    await manager.close()
  })

  it('does not treat helper scheduling as success and accepts only a new-process healthy terminal receipt', async () => {
    const root = await fixtureRoot()
    const oldLayout = await installedLayout(root, '0.1.0')
    let handoffPath = ''
    let schedules = 0
    const manager = new ControlUpdateManager({
      config: config(root, 'windows'), currentVersion: '0.1.0', packageRoot: oldLayout.versionRoot,
      platform: 'win32', processId: 111, fetch: releaseFetch('0.2.0'),
      schedule: async (_helper, operationFile) => { handoffPath = operationFile; schedules += 1 },
    })
    await manager.initialize()
    const started = await manager.prepare({ requestId: 'prepare-real', expectedVersion: '0.2.0' })
    await waitForTerminal(manager, started.operation.id)
    const applied = await manager.apply({ operationId: started.operation.id, requestId: 'apply-real' })
    expect(applied.operation.state).toBe('scheduled')
    await expect(manager.apply({ operationId: started.operation.id, requestId: 'apply-real' })).resolves.toMatchObject({ operation: { id: started.operation.id, state: 'scheduled' } })
    expect(schedules).toBe(2)
    const handoff = JSON.parse(await fs.readFile(handoffPath, 'utf8')) as { statusPath: string; installRoot: string }

    const newLayout = await installedLayout(root, '0.2.0')
    await fs.writeFile(handoff.statusPath, JSON.stringify({
      schema: 1, product: 'dyson-control-control-update-result', operationId: started.operation.id,
      status: 'succeeded', step: 'complete', targetVersion: '0.2.0', activeVersion: '0.2.0',
      installRoot: handoff.installRoot, previousProcessId: 111, processId: 222, accepting: true,
      message: 'verified', updatedAt: new Date().toISOString(),
    }))
    await manager.close()

    const restarted = new ControlUpdateManager({
      config: config(root, 'windows'), currentVersion: '0.2.0', packageRoot: newLayout.versionRoot,
      platform: 'win32', processId: 222, fetch: releaseFetch('0.2.0'), schedule: async () => undefined,
    })
    await restarted.initialize()
    await expect(restarted.read(started.operation.id)).resolves.toMatchObject({ state: 'succeeded', targetVersion: '0.2.0' })
    await restarted.close()
  })

  it('records failed instead of rolledBack when old-version health evidence is inconsistent', async () => {
    const root = await fixtureRoot()
    const layout = await installedLayout(root, '0.1.0')
    let handoffPath = ''
    const manager = new ControlUpdateManager({
      config: config(root, 'windows'), currentVersion: '0.1.0', packageRoot: layout.versionRoot,
      platform: 'win32', processId: 301, fetch: releaseFetch('0.2.0'), schedule: async (_helper, operationFile) => { handoffPath = operationFile },
    })
    await manager.initialize()
    const started = await manager.prepare({ requestId: 'prepare-rollback', expectedVersion: '0.2.0' })
    await waitForTerminal(manager, started.operation.id)
    await manager.apply({ operationId: started.operation.id, requestId: 'apply-rollback' })
    const handoff = JSON.parse(await fs.readFile(handoffPath, 'utf8')) as { statusPath: string; installRoot: string }
    await fs.writeFile(handoff.statusPath, JSON.stringify({
      schema: 1, product: 'dyson-control-control-update-result', operationId: started.operation.id,
      status: 'rolledBack', step: 'complete', targetVersion: '0.2.0', activeVersion: '0.1.0',
      installRoot: handoff.installRoot, previousProcessId: 301, processId: 302, accepting: false,
      message: 'unverified', updatedAt: new Date().toISOString(),
    }))
    const restarted = new ControlUpdateManager({
      config: config(root, 'windows'), currentVersion: '0.1.0', packageRoot: layout.versionRoot,
      platform: 'win32', processId: 302, fetch: releaseFetch('0.2.0'), schedule: async () => undefined,
    })
    await restarted.initialize()
    await expect(restarted.read(started.operation.id)).resolves.toMatchObject({ state: 'failed' })
    await restarted.close()
    await manager.close()
  })
})
