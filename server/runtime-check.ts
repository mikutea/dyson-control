// Run in a disposable child: native console failures must not terminate a panel
// or leave its worker thread alive. No game, Steam account or network is used.
import { DatabaseSync } from 'node:sqlite'
import { release } from 'node:os'
import type { IPty } from 'node-pty'

let terminal: IPty | undefined
let ended = false
let finished = false
let output = ''
const marker = 'DYSON_CONSOLE_READY'
const timer = setTimeout(() => finish(false), 10_000)

function finish(ok: boolean): void {
  if (finished) return
  finished = true
  clearTimeout(timer)
  if (!ended) {
    try { terminal?.kill() } catch { /* the owned child may already have exited */ }
  }
  process.stdout.write(ok ? 'DYSON_RUNTIME_OK\n' : 'DYSON_RUNTIME_FAILED\n', () => process.exit(ok ? 0 : 1))
  setTimeout(() => process.exit(1), 1000).unref()
  // stdout's callback exits even if node-pty keeps its native worker alive.
}

try {
  const [major, , build] = release().split('.').map(Number)
  if (process.platform !== 'win32' || Number(process.versions.node.split('.')[0]) < 24 ||
      !Number.isInteger(major) || !Number.isInteger(build) || major < 10 || (major === 10 && build < 17763)) {
    throw new Error('Unsupported runtime')
  }
  const database = new DatabaseSync(':memory:')
  try {
    if (database.prepare('SELECT 1 AS ready').get()?.ready !== 1) throw new Error('SQLite unavailable')
  } finally { database.close() }
  const { spawn } = await import('node-pty')
  terminal = spawn(process.execPath, ['-e', `process.stdout.write('${marker}\\n')`], {
    cwd: process.cwd(), cols: 80, rows: 24, name: 'xterm', useConpty: true, conptyInheritCursor: false,
  })
  terminal.onData(value => { output = (output + value).slice(-4096) })
  terminal.onExit(({ exitCode }) => { ended = true; finish(exitCode === 0 && output.includes(marker)) })
} catch { finish(false) }
