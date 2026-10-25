import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WindowsGameAdapter } from './windows.js'

const temporaryDirectories: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })))
})

async function fixture(content: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dyson-logs-test-'))
  temporaryDirectories.push(root)
  const logFile = path.join(root, 'game.log')
  await fs.writeFile(logFile, content)
  const adapter = new WindowsGameAdapter({
    host: '127.0.0.1', port: 4173, dataDirectory: path.join(root, 'data'), mode: 'windows', adminPasswordHash: 'test',
    game: {
      root: path.join(root, 'game'), saveDirectory: path.join(root, 'saves'), backupDirectory: path.join(root, 'backups'),
      logFile, bridgeDirectory: path.join(root, 'bridge'), bridgeSecretFile: path.join(root, 'secret'),
      startTaskName: 'Fixture Start', address: 'fixture.example.test', serverName: 'Fixture Server'
    }
  })
  return { adapter, logFile }
}

describe('Windows game log tail', () => {
  it('omits NUL padding rows without consuming the 500-message limit or changing the file', async () => {
    const lines = Array.from({ length: 500 }, (_, index) => `[Info] Message ${index}`)
    const content = `${lines.join('\r\n')}\r\n${'\0'.repeat(8000)}\r\n\0 \t\0\r\n\0\0`
    const { adapter, logFile } = await fixture(content)
    const entries = await adapter.logs()
    expect(entries).toHaveLength(500)
    expect(entries[0]?.message).toBe('[Info] Message 499')
    expect(entries[499]?.message).toBe('[Info] Message 0')
    expect(entries.every(entry => !entry.message.includes('\0'))).toBe(true)
    expect(await fs.readFile(logFile, 'utf8')).toBe(content)
  })

  it('removes NUL padding before parsing and truncating a meaningful record', async () => {
    const line = '[2026-10-25T10:07:09Z] Warning: 保留中文\t与缩进'
    const { adapter, logFile } = await fixture(`${'\0'.repeat(2500)}${line}\0\r\n${line}\r\n`)
    const before = await adapter.logs()
    expect(before).toHaveLength(2)
    expect(before[0]?.id).not.toBe(before[1]?.id)
    for (const entry of before) expect(entry).toMatchObject({ time: '2026-10-25T10:07:09.000Z', level: 'warning', message: line })
    await fs.appendFile(logFile, '\0\0\0')
    expect(await adapter.logs()).toEqual(before)
  })

  it('returns no messages for a file containing only NUL padding', async () => {
    const { adapter } = await fixture('\0'.repeat(4096))
    expect(await adapter.logs()).toEqual([])
  })

  it.each([
    '[Info   :Nebula] Started server',
    '[18:07:09] Started server',
    '[Info] Loaded snapshot from 2026-10-25T10:07:09Z',
    '[2026-02-30T10:07:09Z] Invalid date',
    '[2026-10-25T25:07:09Z] Invalid hour',
    '2026-10-25T10:07:09Zsuffix is not a timestamp header'
  ])('keeps an unknown event time for %s', async line => {
    const { adapter } = await fixture(`${line}\r\n`)
    expect(await adapter.logs()).toEqual([expect.objectContaining({ time: null, message: line })])
  })

  it.each([
    ['[2026-10-25T10:07:09Z] Ready', '2026-10-25T10:07:09.000Z'],
    ['[2026-10-25 18:07:09.125+08:00] Ready', '2026-10-25T10:07:09.125Z'],
    ['2026-10-25T06:37:09-0330 Ready', '2026-10-25T10:07:09.000Z'],
    ['2026-10-25 18:07:09 Ready', new Date(2026, 9, 25, 18, 7, 9).toISOString()]
  ])('reads the actual leading timestamp in %s', async (line, time) => {
    const { adapter } = await fixture(`${line}\n`)
    expect(await adapter.logs()).toEqual([expect.objectContaining({ time, message: line })])
  })

  it('keeps old times and distinct duplicate-line IDs stable when the file is appended', async () => {
    const lines = ['[Info] 重复消息', '[2026-10-25T10:07:09Z] Ready', '[Info] 重复消息']
    const { adapter, logFile } = await fixture(`${lines.join('\r\n')}\r\n`)
    await fs.utimes(logFile, new Date('2026-10-25T10:10:00Z'), new Date('2026-10-25T10:10:00Z'))
    const before = await adapter.logs()
    expect(new Set(before.map(entry => entry.id)).size).toBe(3)
    await fs.appendFile(logFile, '[Warning] 新消息\r\n')
    await fs.utimes(logFile, new Date('2026-10-25T10:20:00Z'), new Date('2026-10-25T10:20:00Z'))
    const after = await adapter.logs()
    expect(after.slice(1)).toEqual(before)
    expect(after[0]).toMatchObject({ time: null, level: 'warning', message: '[Warning] 新消息' })
  })

  it('keeps the last 500 complete UTF-8 lines and stable IDs as the 512 KiB window advances', async () => {
    const lines = Array.from({ length: 560 }, (_, index) => `[Info] 第 ${index} 行 ${'星'.repeat(340)}`)
    const { adapter, logFile } = await fixture(`${lines.join('\r\n')}\r\n`)
    const before = await adapter.logs()
    expect(before).toHaveLength(500)
    for (let index = 0; index < before.length; index++) expect(before[index]?.message).toBe(lines[lines.length - 1 - index])
    await fs.appendFile(logFile, '[Info] 新增一行\r\n')
    const after = await adapter.logs()
    expect(after).toHaveLength(500)
    for (let index = 0; index < before.length - 1; index++) expect(after[index + 1]).toEqual(before[index])
    expect(after.some(entry => entry.message.includes('\uFFFD'))).toBe(false)
  })

  it('drops a partial UTF-8 first line before decoding the tail and preserves CRLF records', async () => {
    const { adapter } = await fixture(`${'星'.repeat(200_000)}\r\n\r\n[Info] 保留一\r\n[Error] 保留二\r\n`)
    expect(await adapter.logs()).toEqual([
      expect.objectContaining({ message: '[Error] 保留二', level: 'error', time: null }),
      expect.objectContaining({ message: '[Info] 保留一', level: 'info', time: null })
    ])
  })

  it('preserves the first complete record when a truncated tail begins at a newline', async () => {
    const prefix = '\n[Info] First complete record\n[Info] '
    const tail = `${prefix}${'x'.repeat(512 * 1024 - Buffer.byteLength(prefix) - 1)}\n`
    const { adapter } = await fixture(`discarded prefix${tail}`)
    const entries = await adapter.logs()
    expect(entries).toHaveLength(2)
    expect(entries[1]?.message).toBe('[Info] First complete record')
    expect(entries[0]?.message).toHaveLength(2000)
  })

  it('only decodes the actual bytes read when the file shrinks during a read', async () => {
    const { adapter, logFile } = await fixture('old contents with room for unread bytes\n')
    await adapter.logs()
    const stat = await fs.stat(logFile, { bigint: true })
    const actual = Buffer.from('[Info] Short read\n')
    const read = vi.fn(async (buffer: Buffer) => {
      buffer.fill(0x58)
      actual.copy(buffer)
      return { buffer, bytesRead: actual.length }
    })
    const close = vi.fn(async () => undefined)
    vi.spyOn(fs, 'open').mockResolvedValue({ stat: async () => stat, read, close } as unknown as Awaited<ReturnType<typeof fs.open>>)
    expect(await adapter.logs()).toEqual([expect.objectContaining({ message: '[Info] Short read' })])
    expect(read).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
  })

  it('changes IDs when the configured path is replaced by a different log file', async () => {
    const content = '[2026-10-25T10:07:09Z] Same content\n'
    const { adapter, logFile } = await fixture(content)
    const modifiedAt = new Date('2026-10-25T10:10:00Z')
    await fs.utimes(logFile, modifiedAt, modifiedAt)
    const before = await adapter.logs()
    await fs.rename(logFile, `${logFile}.old`)
    await fs.writeFile(logFile, content)
    await fs.utimes(logFile, modifiedAt, modifiedAt)
    const after = await adapter.logs()
    expect(after[0]?.time).toBe(before[0]?.time)
    expect(after[0]?.message).toBe(before[0]?.message)
    expect(after[0]?.id).not.toBe(before[0]?.id)
  })
})
