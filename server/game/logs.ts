import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import type { LogEntry } from '../../shared/contracts.js'

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

export async function readGameLogs(filePath: string): Promise<LogEntry[]> {
  const pathStat = await fs.stat(filePath).catch(() => null)
  if (!pathStat?.isFile()) return []
  const handle = await fs.open(filePath, 'r')
  try {
    const stat = await handle.stat({ bigint: true })
    if (!stat.isFile()) return []
    const bytesToRead = Number(stat.size < 512n * 1024n ? stat.size : 512n * 1024n)
    const position = stat.size - BigInt(bytesToRead)
    const buffer = Buffer.alloc(bytesToRead)
    const { bytesRead } = await handle.read(buffer, 0, bytesToRead, position)
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
        const line = raw.toString('utf8')
        const level: LogEntry['level'] = /\b(?:error|fatal|exception)\b/i.test(line) ? 'error' : /\b(?:warn|warning)\b/i.test(line) ? 'warning' : 'info'
        const id = createHash('sha256').update(`${identity}:${position + BigInt(start)}:`).update(raw).digest('hex')
        entries.push({ id, time: recordedTime(line), level, message: line.slice(0, 2000) })
      }
      end = newline
    }
    return entries
  } finally { await handle.close() }
}
