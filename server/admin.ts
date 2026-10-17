import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Readable, Writable } from 'node:stream'
import type { ControlConfig } from '../shared/contracts.js'
import { hashPassword } from './auth.js'
import { loadConfig } from './config.js'

export async function runAdmin(
  args = process.argv.slice(2),
  environment: NodeJS.ProcessEnv = process.env,
  input: Readable & { isTTY?: boolean; setRawMode?: (mode: boolean) => void } = process.stdin,
  output: Writable = process.stderr,
): Promise<void> {
  const [command, argument] = args
  const passwords = new PasswordReader(environment, input, output)
  if (command === 'hash-password') {
    const password = await passwords.read('Administrator password: ')
    console.log(await hashPassword(password))
    return
  }
  if (command === 'init-demo') {
    const target = resolve(argument ?? 'control.config.json')
    const password = await passwords.read('Administrator password: ')
    const confirmation = await passwords.read('Confirm password: ')
    if (password !== confirmation) throw new Error('两次输入的密码不一致。')
    const config: ControlConfig = {
      host: '127.0.0.1',
      port: 13_020,
      dataDirectory: '.data',
      mode: 'demo',
      adminPasswordHash: await hashPassword(password),
      game: {
        root: join('.data', 'demo', 'game'),
        saveDirectory: join('.data', 'demo', 'saves'),
        backupDirectory: join('.data', 'demo', 'backups'),
        logFile: join('.data', 'demo', 'game', 'server.log'),
        bridgeDirectory: join('.data', 'demo', 'bridge'),
        bridgeSecretFile: join('.data', 'demo', 'bridge', 'secret'),
        startTaskName: 'Dyson-Control-Demo-Start',
        address: '127.0.0.1:8469',
        serverName: 'Dyson Control Demo',
      },
    }
    await writeFile(target, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
    console.log(`Created ${target}`)
    return
  }
  if (command === 'validate-config') {
    const config = await loadConfig(argument)
    console.log(`Valid ${config.mode} configuration for ${config.host}:${config.port}`)
    return
  }
  console.log('Usage:')
  console.log('  npm run admin -- hash-password')
  console.log('  npm run admin -- init-demo [config-path]')
  console.log('  npm run admin -- validate-config [config-path]')
}

export class PasswordReader {
  #pipedValues: Promise<string[]> | null = null
  #pipedIndex = 0

  constructor(
    private readonly environment: NodeJS.ProcessEnv,
    private readonly input: Readable & { isTTY?: boolean; setRawMode?: (mode: boolean) => void },
    private readonly output: Writable,
  ) {}

  async read(prompt: string): Promise<string> {
    const fromEnvironment = this.environment.DYSON_CONTROL_ADMIN_PASSWORD
    if (fromEnvironment !== undefined) return fromEnvironment
    if (!this.input.isTTY) {
      this.#pipedValues ??= this.#readPipedValues()
      const values = await this.#pipedValues
      const value = values[this.#pipedIndex]
      this.#pipedIndex += 1
      if (value === undefined) throw new Error('标准输入中没有足够的密码行。')
      return value
    }

    if (!this.input.setRawMode) throw new Error('当前终端不支持安全密码输入。')

    return new Promise((resolvePassword, reject) => {
      let password = ''
      this.output.write(prompt)
      this.input.setRawMode!(true)
      this.input.resume()
      this.input.setEncoding('utf8')

      const finish = (error?: Error) => {
        this.input.off('data', onData)
        this.input.setRawMode!(false)
        this.input.pause()
        this.output.write('\n')
        if (error) reject(error)
        else resolvePassword(password)
      }
      const onData = (chunk: string | Buffer) => {
        for (const character of String(chunk)) {
          if (character === '\r' || character === '\n') return finish()
          if (character === '\u0003') return finish(new Error('已取消。'))
          if (character === '\u007f' || character === '\b') password = password.slice(0, -1)
          else password += character
        }
      }
      this.input.on('data', onData)
    })
  }

  async #readPipedValues(): Promise<string[]> {
    let value = ''
    for await (const chunk of this.input) value += String(chunk)
    const lines = value.split(/\r?\n/)
    if (lines.at(-1) === '') lines.pop()
    return lines
  }
}

async function main(): Promise<void> {
  await runAdmin()
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : ''
if (import.meta.url === entry) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
