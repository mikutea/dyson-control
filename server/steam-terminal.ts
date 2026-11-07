// A private child process for the Windows console SteamCMD needs for password input.
// Only SteamCMD is executable here; the panel never exposes a terminal or raw output.
import path from 'node:path'
import { spawn } from 'node-pty'

const [executable, account, ...extra] = process.argv.slice(2)
if (process.platform !== 'win32' || !executable || !path.isAbsolute(executable) || path.basename(executable).toLowerCase() !== 'steamcmd.exe' ||
    !account || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(account) || extra.length) process.exit(1)

let input = ''
let stopping = false
try {
  const terminal = spawn(executable, ['+login', account, '+quit'], {
    cwd: path.dirname(executable), cols: 160, rows: 40, name: 'xterm',
    useConpty: true, conptyInheritCursor: false,
  })
  const stop = () => {
    if (stopping) return
    stopping = true; input = ''
    try { terminal.kill() } catch { /* the owned console may already be closed */ }
    setTimeout(() => process.exit(1), 2_000).unref()
  }
  terminal.onData(value => { if (!stopping) process.stdout.write(value) })
  terminal.onExit(({ exitCode }) => {
    // node-pty can retain its native I/O worker after the console exits. The helper
    // lifetime ends here; keeping it separate also isolates native failures from the panel.
    input = ''; stopping = true
    process.stdout.write('', () => process.exit(exitCode === 0 ? 0 : 1))
    setTimeout(() => process.exit(1), 2_000).unref()
  })
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk: string) => {
    if (stopping) return
    input += chunk
    if (input.length > 1024) { stop(); return }
    for (let end = input.indexOf('\n'); end !== -1; end = input.indexOf('\n')) {
      const value = input.slice(0, end); input = input.slice(end + 1)
      if (!value || value.length > 256 || /[\x00-\x1f\x7f]/.test(value)) { stop(); return }
      try { terminal.write(`${value}\r`) } catch { stop(); return }
    }
  })
  process.stdin.on('end', stop)
  process.stdin.on('error', stop)
  process.stdout.on('error', stop)
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
} catch {
  // Never serialize native errors or console content into server logs.
  process.exit(1)
}
