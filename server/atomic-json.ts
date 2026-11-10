import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'

export async function writeAtomicJson(filePath: string, value: unknown): Promise<void> {
  const temporary = `${filePath}.partial-${randomUUID()}`
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    // Windows can temporarily hold a sharing lock on the destination. Retry only the rename, never the update.
    const delays = [25, 50, 100, 200, 400, 800]
    for (let attempt = 0; ; attempt += 1) {
      try { await fs.rename(temporary, filePath); break }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (attempt === delays.length || (code !== 'EPERM' && code !== 'EBUSY')) throw error
        await new Promise(resolve => setTimeout(resolve, delays[attempt]))
      }
    }
  } finally { await fs.rm(temporary, { force: true }).catch(() => undefined) }
}
