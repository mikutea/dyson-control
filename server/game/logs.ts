import { createHash } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import fs, { type FileHandle } from 'node:fs/promises'
import type { LogEntry } from '../../shared/contracts.js'
import { GameAdapterError } from './errors.js'

function recordedTime(line: string): string | null {
  const match = /^\uFEFF?\[?(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)(?=\]|\s|$)/.exec(line)
  if (!match) return null
  const timestamp = match[1]!
  const [year, month, day] = timestamp.slice(0, 10).split('-').map(Number)
  const leapYear = year! % 4 === 0 && (year! % 100 !== 0 || year! % 400 === 0)
  const monthDays = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  if (month! < 1 || month! > 12 || day! < 1 || day! > monthDays[month! - 1]! || Number(timestamp.slice(11, 13)) > 23) return null
  // A complete timestamp without an offset uses the server's local timezone.
  const parsed = Date.parse(timestamp.replace(' ', 'T'))
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null
}

function logReadFailed(cause: unknown): never {
  throw new GameAdapterError('LOG_UNAVAILABLE', '无法读取游戏日志，请检查日志路径、存储状态和控制服务的读取权限。', { cause })
}

function missingOrFailed(error: NodeJS.ErrnoException): null {
  if (error.code === 'ENOENT') return null
  return logReadFailed(error)
}

export async function openGameLog(filePath: string): Promise<{ handle: FileHandle; stat: BigIntStats } | null> {
  const pathStat = await fs.lstat(filePath, { bigint: true }).catch(missingOrFailed)
  if (!pathStat) return null
  if (!pathStat.isFile()) throw new GameAdapterError('LOG_UNAVAILABLE', '请检查日志路径，确保它指向普通文件。')
  const handle = await fs.open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(missingOrFailed)
  if (!handle) return null
  try {
    const stat = await handle.stat({ bigint: true }).catch(logReadFailed)
    // Windows lacks O_NOFOLLOW. Verify the handle refers to the file we inspected before reading any bytes.
    if (!stat.isFile() || stat.dev !== pathStat.dev || stat.ino !== pathStat.ino) {
      throw new GameAdapterError('LOG_UNAVAILABLE', '日志文件在打开时发生变化，请刷新后重试。')
    }
    return { handle, stat }
  } catch (error) {
    await handle.close().catch(logReadFailed)
    throw error
  }
}

export async function readGameLogs(filePath: string): Promise<LogEntry[]> {
  const log = await openGameLog(filePath)
  if (!log) return []
  const { handle, stat } = log
  try {
    const bytesToRead = Number(stat.size < 512n * 1024n ? stat.size : 512n * 1024n)
    const position = stat.size - BigInt(bytesToRead)
    const buffer = Buffer.alloc(bytesToRead)
    const { bytesRead } = await handle.read(buffer, 0, bytesToRead, position).catch(logReadFailed)
    const data = buffer.subarray(0, bytesRead)
    // Discard the possibly partial first line before decoding UTF-8.
    const firstLineStart = position > 0n ? data.indexOf(0x0a) + 1 : 0
    if (position > 0n && firstLineStart === 0) return []
    const identity = `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`
    const entries: LogEntry[] = []
    let end = data.length
    while (end > firstLineStart && entries.length < 500) {
      const newline = data.lastIndexOf(0x0a, end - 1)
      const start = Math.max(firstLineStart, newline + 1)
      const contentEnd = data[end - 1] === 0x0d ? end - 1 : end
      if (contentEnd > start) {
        const raw = data.subarray(start, contentEnd)
        // Ignore NUL padding in the display, preserving the source bytes and
        // offsets for identity. Padding-only rows must not displace real logs.
        const line = raw.toString('utf8').replace(/\0/g, '')
        if (line.trim()) {
          const level: LogEntry['level'] = /\b(?:error|fatal|exception)\b/i.test(line) ? 'error' : /\b(?:warn|warning)\b/i.test(line) ? 'warning' : 'info'
          const id = createHash('sha256').update(`${identity}:${position + BigInt(start)}:`).update(raw).digest('hex')
          entries.push({ id, time: recordedTime(line), level, message: line.slice(0, 2000) })
        }
      }
      end = newline
    }
    return entries
  } finally { await handle.close().catch(logReadFailed) }
}
