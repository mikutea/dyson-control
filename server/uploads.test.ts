import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { BackupUploadStore } from './uploads.js'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('backup upload staging', () => {
  it('persists request id, size and digest and reuses the durable idempotency record', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dyson-upload-'))
    directories.push(directory)
    const uploads = new BackupUploadStore(directory)
    await uploads.initialize(() => null)
    const first = await uploads.stage('request-1', Readable.from(Buffer.from('fixture zip')), new AbortController().signal)
    const duplicate = await uploads.stage('request-1', Readable.from(Buffer.from('ignored')), new AbortController().signal)
    expect(duplicate).toEqual(first)
    expect(first).toMatchObject({ schema: 1, requestId: 'request-1', bytes: 11 })
    expect(first.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect((await readdir(uploads.directory)).sort()).toEqual([`${first.uploadId}.json`, `${first.uploadId}.zip`])
  })
})
