import { lstat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Readable, Writable } from 'node:stream'
import type { ControlConfig } from '../shared/contracts.js'
import { hashPassword } from './auth.js'
import { controlConfigSchema, loadConfig } from './config.js'

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
  if (command === 'init-windows') {
    const { target, config } = windowsConfiguration(args.slice(1))
    const existing = await lstat(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (existing) throw new Error('配置文件已存在；初始化不会覆盖已有配置。')
    const parent = await lstat(dirname(target)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') throw new Error('请先创建私有配置目录，再运行初始化。')
      throw error
    })
    if (!parent.isDirectory()) throw new Error('配置文件的父路径必须是目录。')
    const password = await passwords.read('Administrator password: ')
    const confirmation = await passwords.read('Confirm password: ')
    if (password !== confirmation) throw new Error('两次输入的密码不一致。')
    const validated = controlConfigSchema.parse({ ...config, adminPasswordHash: await hashPassword(password) })
    await writeFile(target, `${JSON.stringify(validated, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    console.log(`Created ${target}`)
    console.log(`面板地址：http://127.0.0.1:${validated.port}`)
    console.log(`游戏目录：${validated.game.root}`)
    console.log('下一步：使用此配置运行 install-control.ps1，再打开“安装与授权”。')
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
  console.log('  node dist/server/admin.js hash-password')
  console.log('  node dist/server/admin.js init-demo [config-path]')
  console.log('  node dist/server/admin.js init-windows <config-path> --server-root <directory> [--address host:port] [--port 13020] [--name "Dyson Server"]')
  console.log('  node dist/server/admin.js validate-config [config-path]')
}

function windowsConfiguration(args: string[]): { target: string; config: Omit<ControlConfig, 'adminPasswordHash'> } {
  const [configPath, ...options] = args
  if (!configPath || !isAbsolute(configPath)) throw new Error('请指定配置文件的绝对路径。')
  const flags = new Map<string, string>()
  for (let index = 0; index < options.length; index += 2) {
    const key = options[index]
    const value = options[index + 1]
    if (!['--server-root', '--address', '--port', '--name'].includes(key) || flags.has(key) || !value || value.startsWith('--')) {
      throw new Error('初始化参数无效：支持 --server-root、--address、--port 和 --name，每项只能指定一次。')
    }
    flags.set(key, value)
  }
  const serverRoot = flags.get('--server-root')
  if (!serverRoot || !isAbsolute(serverRoot)) throw new Error('请用 --server-root 指定服务器存储目录的绝对路径。')
  const portValue = flags.get('--port') ?? '13020'
  if (!/^\d+$/.test(portValue) || Number(portValue) < 1 || Number(portValue) > 65_535) throw new Error('面板端口必须是 1 到 65535 之间的整数。')
  const address = (flags.get('--address') ?? '127.0.0.1:8469').trim()
  if (!address || address.length > 255 || /[\s\0]/u.test(address)) throw new Error('游戏地址不能为空或包含空白字符。')
  const serverName = (flags.get('--name') ?? 'Dyson Server').trim()
  if (!serverName || serverName.length > 80 || /[\r\n\0]/u.test(serverName)) throw new Error('服务器名称应为 1 到 80 个字符，且不能包含换行。')
  const target = resolve(configPath)
  const root = resolve(serverRoot)
  const dataDirectory = join(dirname(target), 'data')
  const game = {
    root: join(root, 'game'), saveDirectory: join(root, 'userdata', 'Save'), backupDirectory: join(root, 'backups'),
    logFile: join(root, 'game', 'BepInEx', 'LogOutput.log'), bridgeDirectory: join(root, 'bridge'),
    bridgeSecretFile: join(root, 'private', 'bridge-secret'), startTaskName: 'Dyson-Game-Start', address, serverName,
  }
  const inside = (child: string, parent: string) => {
    const suffix = relative(parent, child)
    return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`))
  }
  if (inside(target, dataDirectory)) throw new Error('配置文件不能占用面板数据目录。')
  for (const directory of [game.root, game.saveDirectory, game.backupDirectory, game.bridgeDirectory]) {
    if (inside(target, directory) || inside(dataDirectory, directory) || inside(directory, dataDirectory)) {
      throw new Error('配置和面板数据目录不能与游戏、存档、备份或 Bridge 目录重叠。')
    }
  }
  return { target, config: { host: '127.0.0.1', port: Number(portValue), dataDirectory, mode: 'windows', game } }
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
