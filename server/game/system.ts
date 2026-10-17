import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { GameAdapterError } from './errors.js'

export function resolveWindowsScript(name: string, fromDirectory = path.dirname(fileURLToPath(import.meta.url))): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.ps1$/.test(name)) {
    throw new GameAdapterError('WINDOWS_SCRIPT_INVALID', 'The Windows script name is invalid.')
  }
  let directory = path.resolve(fromDirectory)
  for (let depth = 0; depth < 5; depth++) {
    const candidate = path.join(directory, 'scripts', 'windows', name)
    if (existsSync(candidate)) return candidate
    const parent = path.dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  throw new GameAdapterError('WINDOWS_SCRIPT_MISSING', `Required Windows script is missing: ${name}`)
}

export async function runPowerShell<T>(name: string, input: unknown, signal?: AbortSignal, timeoutMs = 30_000): Promise<T> {
  if (process.platform !== 'win32') throw new GameAdapterError('WINDOWS_REQUIRED', 'This operation requires Windows.')
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dyson-control-'))
  const argumentFile = path.join(directory, 'arguments.json')
  await fs.writeFile(argumentFile, JSON.stringify(input), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  try {
    return await new Promise<T>((resolve, reject) => {
      const child = spawn('powershell.exe', [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', resolveWindowsScript(name), '-ArgumentsPath', argumentFile
      ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], signal })
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      let outputBytes = 0
      const timer = setTimeout(() => child.kill(), timeoutMs)
      child.stdout.on('data', (chunk: Buffer) => {
        outputBytes += chunk.length
        if (outputBytes <= 1024 * 1024) stdout.push(chunk)
        else child.kill()
      })
      child.stderr.on('data', (chunk: Buffer) => { if (Buffer.concat(stderr).length < 64 * 1024) stderr.push(chunk) })
      child.on('error', (error) => { clearTimeout(timer); reject(error) })
      child.on('close', (code) => {
        clearTimeout(timer)
        const errorText = Buffer.concat(stderr).toString('utf8').trim()
        if (code !== 0) {
          reject(new GameAdapterError('WINDOWS_SCRIPT_FAILED', errorText || `${name} exited with code ${code}.`))
          return
        }
        try {
          const text = Buffer.concat(stdout).toString('utf8').replace(/^\uFEFF/, '').trim()
          resolve(JSON.parse(text) as T)
        } catch (error) {
          reject(new GameAdapterError('WINDOWS_SCRIPT_OUTPUT_INVALID', `${name} returned invalid JSON.`, { cause: error }))
        }
      })
    })
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
}

export async function pathExists(filePath: string): Promise<boolean> {
  try { await fs.access(filePath); return true } catch { return false }
}

export function safeId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(value)) {
    throw new GameAdapterError('INVALID_INPUT', `${label} is invalid.`)
  }
  return value
}

export function ensureInside(parent: string, child: string): string {
  const root = path.resolve(parent)
  const target = path.resolve(child)
  const relative = path.relative(root, target)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    if (target !== root) throw new GameAdapterError('PATH_OUTSIDE_ROOT', `Path is outside the managed root: ${target}`)
  }
  return target
}

export function timestampId(date = new Date()): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
}
