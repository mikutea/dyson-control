import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Player, PlayerEventBatch } from '../../shared/contracts.js'
import { GameAdapterError } from './errors.js'

const REQUEST_PROTOCOL = 'DYSON_CONTROL_REQUEST_V1'
const RECEIPT_PROTOCOL = 'DYSON_CONTROL_RECEIPT_V3'
const HEARTBEAT_PROTOCOL = 'DYSON_CONTROL_HEARTBEAT_V1'
const ACTION_PROTOCOL = 'DYSON_CONTROL_ACTION_V1'
const METRICS_PROTOCOL = 'DYSON_CONTROL_METRICS_V1'
const VERSIONS_PROTOCOL = 'DYSON_CONTROL_VERSIONS_V1'
const requestKeys = ['protocol', 'requestId', 'createdAtUnixMs', 'expiresAtUnixMs', 'action', 'nonce', 'hmac'] as const
const receiptKeys = ['protocol', 'requestId', 'action', 'state', 'startedAtUnixMs', 'finishedAtUnixMs', 'saveName', 'saveTimeBefore', 'saveTimeAfter', 'dsvBytes', 'dsvWriteTimeUtcTicks', 'serverBytes', 'serverWriteTimeUtcTicks', 'moddsvBytes', 'moddsvWriteTimeUtcTicks', 'dsvChanged', 'serverChanged', 'moddsvChanged', 'errorCode', 'hmac'] as const
const heartbeatKeys = ['protocol', 'pluginVersion', 'processId', 'startedAtUnixMs', 'writtenAtUnixMs', 'state', 'hmac'] as const
const actionKeys = ['protocol', 'requestId', 'action', 'state', 'startedAtUnixMs', 'finishedAtUnixMs', 'errorCode', 'hmac'] as const
const metricsKeys = ['protocol', 'sessionId', 'processId', 'writtenAtUnixMs', 'state', 'ups', 'tps', 'gameTick', 'hmac'] as const
const versionsKeys = ['protocol', 'processId', 'writtenAtUnixMs', 'game', 'nebula', 'bepinex', 'bridge', 'hmac'] as const

interface Heartbeat {
  protocol: string; pluginVersion: string; processId: number; startedAtUnixMs: number
  writtenAtUnixMs: number; state: string; hmac: string
}

interface BridgeContext { root: string; secret: string; heartbeat: Heartbeat }

export interface SaveReceipt {
  requestId: string; state: 'succeeded' | 'failed'; saveName: string; errorCode: string
  dsvBytes: number; serverBytes: number; moddsvBytes: number; finishedAtUnixMs: number
  dsvWriteTimeUtcTicks: bigint; serverWriteTimeUtcTicks: bigint; moddsvWriteTimeUtcTicks: bigint
}

export interface StopReceipt {
  requestId: string; state: 'succeeded' | 'failed'; errorCode: string
  startedAtUnixMs: number; finishedAtUnixMs: number
}

export interface BridgeTelemetry {
  sessionId: string; processId: number; sampledAt: string
  ups: number; tps: number; gameTick: number
}

export interface BridgeVersions {
  processId: number; writtenAtUnixMs: number
  game: string; nebula: string; bepinex: string; bridge: string
}

function protocolError(code: string, message = code): never {
  throw new GameAdapterError(code, message)
}

function parseLines<K extends readonly string[]>(payload: string, keys: K, maximumBytes = 4096): Record<K[number], string> {
  if (Buffer.byteLength(payload) > maximumBytes || payload.includes('\0') || payload.includes('\ufeff')) protocolError('BRIDGE_PAYLOAD_INVALID')
  const lines = payload.split(/\r?\n/)
  if (lines.at(-1) === '') lines.pop()
  if (lines.length !== keys.length) protocolError('BRIDGE_PAYLOAD_INVALID')
  const result: Record<string, string> = {}
  keys.forEach((key, index) => {
    const prefix = `${key}=`
    const line = lines[index]!
    if (!line.startsWith(prefix) || line.length === prefix.length) protocolError('BRIDGE_PAYLOAD_INVALID')
    result[key] = line.slice(prefix.length)
  })
  return result as Record<K[number], string>
}

function hmac(secret: string, parts: string[]): string {
  return createHmac('sha256', Buffer.from(secret, 'utf8')).update(parts.join('\n'), 'utf8').digest('hex')
}

function assertSignature(actual: string, expected: string): void {
  if (!/^[0-9a-f]{64}$/i.test(actual)) protocolError('BRIDGE_HMAC_INVALID')
  const left = Buffer.from(actual, 'hex')
  const right = Buffer.from(expected, 'hex')
  if (left.length !== right.length || !timingSafeEqual(left, right)) protocolError('BRIDGE_SIGNATURE_INVALID')
}

function integer(value: string, minimum = 0): number {
  if (!/^(?:0|[1-9]\d*)$/.test(value)) protocolError('BRIDGE_NUMBER_INVALID')
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum) protocolError('BRIDGE_NUMBER_INVALID')
  return parsed
}

function signedInteger(value: string): number {
  if (!/^(?:-1|0|[1-9]\d*)$/.test(value)) protocolError('BRIDGE_NUMBER_INVALID')
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < -1) protocolError('BRIDGE_NUMBER_INVALID')
  return parsed
}

function validateSecret(value: string): string {
  const secret = value.trim()
  if (secret.length < 32 || secret.length > 512 || /[\r\n\0]/.test(secret)) protocolError('BRIDGE_SECRET_INVALID')
  return secret
}

async function readPlainFile(filePath: string, code: string): Promise<string> {
  let stat
  try { stat = await fs.lstat(filePath) } catch { protocolError(`${code}_UNAVAILABLE`) }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 4096) protocolError(`${code}_FILE_INVALID`)
  return fs.readFile(filePath, 'utf8')
}

function parseHeartbeat(payload: string, secret: string, now: number): Heartbeat {
  const row = parseLines(payload, heartbeatKeys)
  const heartbeat: Heartbeat = {
    protocol: row.protocol, pluginVersion: row.pluginVersion, processId: integer(row.processId, 1),
    startedAtUnixMs: integer(row.startedAtUnixMs, 1), writtenAtUnixMs: integer(row.writtenAtUnixMs, 1),
    state: row.state, hmac: row.hmac.toLowerCase()
  }
  if (heartbeat.protocol !== HEARTBEAT_PROTOCOL || heartbeat.state !== 'ready' || heartbeat.writtenAtUnixMs < heartbeat.startedAtUnixMs) protocolError('BRIDGE_HEARTBEAT_INVALID')
  assertSignature(heartbeat.hmac, hmac(secret, [HEARTBEAT_PROTOCOL, heartbeat.pluginVersion, String(heartbeat.processId), String(heartbeat.startedAtUnixMs), String(heartbeat.writtenAtUnixMs), heartbeat.state]))
  const age = now - heartbeat.writtenAtUnixMs
  if (age < -5_000 || age > 10_000) protocolError('BRIDGE_HEARTBEAT_STALE')
  return heartbeat
}

async function readBridgeContext(bridgeDirectory: string, secretFile: string, expectedProcessId?: number): Promise<BridgeContext> {
  const root = path.resolve(bridgeDirectory)
  const requestDirectory = path.join(root, 'requests')
  const receiptDirectory = path.join(root, 'receipts')
  for (const directory of [root, requestDirectory, receiptDirectory]) {
    const stat = await fs.lstat(directory).catch(() => null)
    if (!stat?.isDirectory() || stat.isSymbolicLink()) protocolError('BRIDGE_DIRECTORY_INVALID', `Bridge directory is unavailable: ${directory}`)
  }
  const secret = validateSecret(await readPlainFile(secretFile, 'BRIDGE_SECRET'))
  const heartbeat = parseHeartbeat(await readPlainFile(path.join(root, 'heartbeat'), 'BRIDGE_HEARTBEAT'), secret, Date.now())
  if (expectedProcessId !== undefined && heartbeat.processId !== expectedProcessId) {
    protocolError('BRIDGE_PROCESS_MISMATCH', 'The Bridge heartbeat belongs to a different game process.')
  }
  return { root, secret, heartbeat }
}

export async function assertBridgeReady(bridgeDirectory: string, secretFile: string, expectedProcessId?: number): Promise<void> {
  await readBridgeContext(bridgeDirectory, secretFile, expectedProcessId)
}

function validSaveName(value: string): boolean {
  return value.length >= 1 && value.length <= 120 && value !== '.' && value !== '..' && !/[\\/:*?"<>|\u0000-\u001f]/u.test(value)
}

function receiptTimes(start: string, finish: string, createdAt: number): { startedAtUnixMs: number; finishedAtUnixMs: number } {
  const startedAtUnixMs = integer(start, 1)
  const finishedAtUnixMs = integer(finish, 1)
  if (startedAtUnixMs < createdAt - 5_000 || finishedAtUnixMs < startedAtUnixMs || finishedAtUnixMs > Date.now() + 5_000) protocolError('BRIDGE_RECEIPT_TIME_INVALID')
  return { startedAtUnixMs, finishedAtUnixMs }
}

function parseReceipt(payload: string, secret: string, requestId: string, createdAt: number): SaveReceipt {
  const row = parseLines(payload, receiptKeys)
  if (row.protocol !== RECEIPT_PROTOCOL || row.requestId !== requestId || row.action !== 'save') protocolError('BRIDGE_RECEIPT_MISMATCH')
  const state = row.state
  if (state !== 'succeeded' && state !== 'failed') protocolError('BRIDGE_RECEIPT_INVALID')
  if (!validSaveName(row.saveName)) protocolError('BRIDGE_RECEIPT_INVALID')
  const parts = receiptKeys.slice(0, -1).map((key) => row[key])
  assertSignature(row.hmac, hmac(secret, parts))
  const { finishedAtUnixMs } = receiptTimes(row.startedAtUnixMs, row.finishedAtUnixMs, createdAt)
  const dsvBytes = signedInteger(row.dsvBytes)
  const serverBytes = signedInteger(row.serverBytes)
  const moddsvBytes = signedInteger(row.moddsvBytes)
  const booleans = [row.dsvChanged, row.serverChanged, row.moddsvChanged]
  if (booleans.some((value) => value !== 'true' && value !== 'false')) protocolError('BRIDGE_RECEIPT_INVALID')
  for (const value of [row.saveTimeBefore, row.saveTimeAfter, row.dsvWriteTimeUtcTicks, row.serverWriteTimeUtcTicks, row.moddsvWriteTimeUtcTicks]) {
    if (!/^(?:-1|0|[1-9]\d{0,18})$/.test(value)) protocolError('BRIDGE_RECEIPT_INVALID')
  }
  if (state === 'succeeded' && (row.errorCode !== 'NONE' || dsvBytes <= 0 || serverBytes <= 0 ||
      row.dsvChanged !== 'true' || row.serverChanged !== 'true' ||
      BigInt(row.saveTimeAfter) <= BigInt(row.saveTimeBefore) ||
      BigInt(row.dsvWriteTimeUtcTicks) <= 0n || BigInt(row.serverWriteTimeUtcTicks) <= 0n ||
      (moddsvBytes >= 0 && (moddsvBytes === 0 || row.moddsvChanged !== 'true' || BigInt(row.moddsvWriteTimeUtcTicks) <= 0n)) ||
      (moddsvBytes === -1 && (row.moddsvWriteTimeUtcTicks !== '-1' || row.moddsvChanged !== 'false')))) protocolError('BRIDGE_RECEIPT_INVALID')
  if (state === 'failed' && row.errorCode === 'NONE') protocolError('BRIDGE_RECEIPT_INVALID')
  return {
    requestId, state, saveName: row.saveName, errorCode: row.errorCode, dsvBytes, serverBytes, moddsvBytes, finishedAtUnixMs,
    dsvWriteTimeUtcTicks: BigInt(row.dsvWriteTimeUtcTicks), serverWriteTimeUtcTicks: BigInt(row.serverWriteTimeUtcTicks),
    moddsvWriteTimeUtcTicks: BigInt(row.moddsvWriteTimeUtcTicks)
  }
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason)
    const onAbort = () => { clearTimeout(timer); reject(signal.reason) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve() }, milliseconds)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

async function requestBridgeAction<T>(
  action: 'save' | 'stop',
  parse: (payload: string, secret: string, requestId: string, createdAt: number) => T,
  bridgeDirectory: string,
  secretFile: string,
  signal: AbortSignal,
  timeoutMs = 45_000,
  expectedProcessId?: number
): Promise<T> {
  signal.throwIfAborted()
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120_000) protocolError('BRIDGE_TIMEOUT_INVALID')
  const { root, secret } = await readBridgeContext(bridgeDirectory, secretFile, expectedProcessId)
  const requestDirectory = path.join(root, 'requests')
  const receiptDirectory = path.join(root, 'receipts')

  const requestId = randomUUID().toLowerCase()
  const createdAtUnixMs = Date.now()
  const expiresAtUnixMs = createdAtUnixMs + timeoutMs
  const nonce = randomBytes(18).toString('base64url')
  const unsigned = [REQUEST_PROTOCOL, requestId, String(createdAtUnixMs), String(expiresAtUnixMs), action, nonce]
  const values = [...unsigned, hmac(secret, unsigned)]
  const payload = `${requestKeys.map((key, index) => `${key}=${values[index]}`).join('\n')}\n`
  const requestPath = path.join(requestDirectory, `${requestId}.request`)
  const tempPath = path.join(requestDirectory, `.partial-${requestId}-${randomUUID()}`)
  await fs.writeFile(tempPath, payload, { flag: 'wx', mode: 0o600 })
  try { await fs.rename(tempPath, requestPath) } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined)
    throw new GameAdapterError('BRIDGE_REQUEST_WRITE_FAILED', `Could not publish the signed ${action} request.`, { cause: error })
  }

  const receiptPath = path.join(receiptDirectory, `${requestId}.receipt`)
  try {
    while (Date.now() < expiresAtUnixMs) {
      signal.throwIfAborted()
      const payload = await readPlainFile(receiptPath, 'BRIDGE_RECEIPT').catch((error: unknown) => {
        if (error instanceof GameAdapterError && error.code === 'BRIDGE_RECEIPT_UNAVAILABLE') return null
        throw error
      })
      if (payload !== null) return parse(payload, secret, requestId, createdAtUnixMs)
      await wait(Math.min(200, Math.max(1, expiresAtUnixMs - Date.now())), signal)
    }
    protocolError('BRIDGE_RECEIPT_TIMEOUT', `The game did not return a signed ${action} receipt before the timeout.`)
  } finally {
    // A claimed request is owned by the Bridge. Remove only an unclaimed request;
    // a timeout cannot prove that an in-game operation did not execute.
    await fs.rm(requestPath, { force: true }).catch(() => undefined)
  }
}

export function requestBridgeSave(bridgeDirectory: string, secretFile: string, signal: AbortSignal, timeoutMs = 45_000, expectedProcessId?: number): Promise<SaveReceipt> {
  return requestBridgeAction('save', parseReceipt, bridgeDirectory, secretFile, signal, timeoutMs, expectedProcessId)
}

/** A successful receipt acknowledges Application.Quit; the caller must also observe process exit. */
export function requestBridgeStop(bridgeDirectory: string, secretFile: string, signal: AbortSignal, timeoutMs = 15_000, expectedProcessId?: number): Promise<StopReceipt> {
  return requestBridgeAction('stop', (payload, secret, requestId, createdAt) => {
    const row = parseLines(payload, actionKeys)
    if (row.protocol !== ACTION_PROTOCOL || row.requestId !== requestId || row.action !== 'stop') protocolError('BRIDGE_RECEIPT_MISMATCH')
    assertSignature(row.hmac, hmac(secret, actionKeys.slice(0, -1).map(key => row[key])))
    if ((row.state !== 'succeeded' && row.state !== 'failed') || !/^[A-Z][A-Z0-9_]{0,79}$/.test(row.errorCode) ||
        (row.state === 'succeeded') !== (row.errorCode === 'NONE')) protocolError('BRIDGE_RECEIPT_INVALID')
    return { requestId, state: row.state, errorCode: row.errorCode, ...receiptTimes(row.startedAtUnixMs, row.finishedAtUnixMs, createdAt) }
  }, bridgeDirectory, secretFile, signal, timeoutMs, expectedProcessId)
}

const playerActionRequestKeys = ['protocol', 'requestId', 'createdAtUnixMs', 'expiresAtUnixMs', 'action', 'sessionId', 'sessionPlayerId', 'nonce', 'hmac'] as const
const playerActionReceiptKeys = ['protocol', 'requestId', 'action', 'sessionId', 'sessionPlayerId', 'state', 'startedAtUnixMs', 'finishedAtUnixMs', 'errorCode', 'hmac'] as const
const playerCapabilityKeys = ['protocol', 'sessionId', 'processId', 'writtenAtUnixMs', 'state', 'hmac'] as const
const canonicalUuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
export const playerIdPattern = new RegExp(`^(${canonicalUuid}):(player-[0-9]{6,12})$`)

export async function readBridgePlayerActionCapability(bridgeDirectory: string, secretFile: string, expectedProcessId: number): Promise<boolean> {
  const { root, secret, heartbeat } = await readBridgeContext(bridgeDirectory, secretFile, expectedProcessId)
  const row = parseLines(await readPlainFile(path.join(root, 'player-actions'), 'BRIDGE_PLAYER_ACTIONS'), playerCapabilityKeys)
  if (row.protocol !== 'DYSON_CONTROL_PLAYER_ACTIONS_V1' || !new RegExp(`^${canonicalUuid}$`).test(row.sessionId) || !['available', 'unavailable'].includes(row.state)) protocolError('BRIDGE_PLAYER_ACTIONS_INVALID')
  assertSignature(row.hmac, hmac(secret, playerCapabilityKeys.slice(0, -1).map(key => row[key])))
  const writtenAt = integer(row.writtenAtUnixMs, 1)
  if (integer(row.processId, 1) !== heartbeat.processId || writtenAt < heartbeat.startedAtUnixMs) protocolError('BRIDGE_PROCESS_MISMATCH')
  if (Date.now() - writtenAt > 10_000 || writtenAt > Date.now() + 5_000) protocolError('BRIDGE_PLAYER_ACTIONS_STALE')
  return row.state === 'available'
}

/** A kick is successful only after the Bridge observes Nebula's normal disconnect cleanup. */
export async function requestBridgeKickPlayer(bridgeDirectory: string, secretFile: string, playerId: string, signal: AbortSignal, expectedProcessId: number, timeoutMs = 30_000): Promise<StopReceipt> {
  signal.throwIfAborted()
  const identity = playerIdPattern.exec(playerId)
  if (!identity) protocolError('PLAYER_ID_INVALID', '请选择当前在线列表中的玩家。')
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 45_000) protocolError('BRIDGE_TIMEOUT_INVALID')
  if (!await readBridgePlayerActionCapability(bridgeDirectory, secretFile, expectedProcessId)) protocolError('PLAYER_ACTIONS_UNAVAILABLE', '当前 Bridge 不支持玩家操作。')
  const { root, secret } = await readBridgeContext(bridgeDirectory, secretFile, expectedProcessId)
  const requestDirectory = path.join(root, 'player-requests')
  const responseDirectory = path.join(root, 'player-responses')
  for (const directory of [requestDirectory, responseDirectory]) {
    const stat = await fs.lstat(directory).catch(() => null)
    if (!stat?.isDirectory() || stat.isSymbolicLink()) protocolError('PLAYER_ACTIONS_UNAVAILABLE', '当前 Bridge 不支持玩家操作。')
  }
  const requestId = randomUUID()
  const createdAt = Date.now(), expiresAt = createdAt + timeoutMs
  const unsigned = ['DYSON_CONTROL_PLAYER_ACTION_V1', requestId, String(createdAt), String(expiresAt), 'kick-player', identity[1]!, identity[2]!, randomBytes(16).toString('hex')]
  const values = [...unsigned, hmac(secret, unsigned)]
  const requestPath = path.join(requestDirectory, `${requestId}.request`)
  const temporaryPath = path.join(requestDirectory, `.partial-${requestId}`)
  await fs.writeFile(temporaryPath, `${playerActionRequestKeys.map((key, index) => `${key}=${values[index]}`).join('\n')}\n`, { flag: 'wx', mode: 0o600 })
  try { await fs.rename(temporaryPath, requestPath) } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined)
    throw new GameAdapterError('BRIDGE_REQUEST_WRITE_FAILED', '无法提交玩家操作。', { cause: error })
  }
  try {
    // The extra second only allows a final failure receipt to reach the reader; it never renews the signed request.
    while (Date.now() <= expiresAt + 1_000) {
      signal.throwIfAborted()
      const payload = await readPlainFile(path.join(responseDirectory, `${requestId}.receipt`), 'BRIDGE_RECEIPT').catch((error: unknown) => {
        if (error instanceof GameAdapterError && error.code === 'BRIDGE_RECEIPT_UNAVAILABLE') return null
        throw error
      })
      if (payload !== null) {
        const row = parseLines(payload, playerActionReceiptKeys)
        if (row.protocol !== 'DYSON_CONTROL_PLAYER_ACTION_RECEIPT_V1' || row.requestId !== requestId || row.action !== 'kick-player' || row.sessionId !== identity[1] || row.sessionPlayerId !== identity[2]) protocolError('BRIDGE_RECEIPT_MISMATCH')
        assertSignature(row.hmac, hmac(secret, playerActionReceiptKeys.slice(0, -1).map(key => row[key])))
        if (!['succeeded', 'failed'].includes(row.state) || !/^[A-Z][A-Z0-9_]{0,79}$/.test(row.errorCode) || (row.state === 'succeeded') !== (row.errorCode === 'NONE')) protocolError('BRIDGE_RECEIPT_INVALID')
        const times = receiptTimes(row.startedAtUnixMs, row.finishedAtUnixMs, createdAt)
        if (row.state === 'succeeded' && times.finishedAtUnixMs > expiresAt) protocolError('BRIDGE_RECEIPT_TIME_INVALID')
        return { requestId, state: row.state as 'succeeded' | 'failed', errorCode: row.errorCode, ...times }
      }
      await wait(100, signal)
    }
    protocolError('BRIDGE_RECEIPT_TIMEOUT', '未收到游戏的离线清理确认，请刷新玩家列表检查结果。')
  } finally { await fs.rm(requestPath, { force: true }).catch(() => undefined) }
}

export async function readBridgeTelemetry(bridgeDirectory: string, secretFile: string, expectedProcessId?: number): Promise<BridgeTelemetry | null> {
  const { root, secret, heartbeat } = await readBridgeContext(bridgeDirectory, secretFile, expectedProcessId)
  const row = parseLines(await readPlainFile(path.join(root, 'metrics'), 'BRIDGE_METRICS'), metricsKeys)
  if (row.protocol !== METRICS_PROTOCOL || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row.sessionId) ||
      !['active', 'unavailable'].includes(row.state)) protocolError('BRIDGE_METRICS_INVALID')
  assertSignature(row.hmac, hmac(secret, metricsKeys.slice(0, -1).map(key => row[key])))
  const processId = integer(row.processId, 1)
  if (processId !== heartbeat.processId) protocolError('BRIDGE_PROCESS_MISMATCH')
  const writtenAt = integer(row.writtenAtUnixMs, 1)
  if (Date.now() - writtenAt > 10_000 || Date.now() - writtenAt < -5_000 || writtenAt < heartbeat.startedAtUnixMs) protocolError('BRIDGE_METRICS_STALE')
  if (row.state === 'unavailable') {
    if ([row.ups, row.tps, row.gameTick].some(value => value !== '-1')) protocolError('BRIDGE_METRICS_INVALID')
    return null
  }
  const rate = (value: string): number => {
    if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(value) || !Number.isFinite(Number(value))) protocolError('BRIDGE_METRICS_INVALID')
    return Number(value)
  }
  return { sessionId: row.sessionId, processId, sampledAt: new Date(writtenAt).toISOString(), ups: rate(row.ups), tps: rate(row.tps), gameTick: integer(row.gameTick) }
}

export async function readBridgeVersions(bridgeDirectory: string, secretFile: string, expectedProcessId: number): Promise<BridgeVersions> {
  const { root, secret, heartbeat } = await readBridgeContext(bridgeDirectory, secretFile, expectedProcessId)
  const row = parseLines(await readPlainFile(path.join(root, 'versions'), 'BRIDGE_VERSIONS'), versionsKeys)
  if (row.protocol !== VERSIONS_PROTOCOL) protocolError('BRIDGE_VERSIONS_INVALID')
  assertSignature(row.hmac, hmac(secret, versionsKeys.slice(0, -1).map(key => row[key])))
  const processId = integer(row.processId, 1)
  if (processId !== heartbeat.processId) protocolError('BRIDGE_PROCESS_MISMATCH')
  const writtenAtUnixMs = integer(row.writtenAtUnixMs, 1)
  const age = Date.now() - writtenAtUnixMs
  if (age < -5_000 || age > 10_000 || writtenAtUnixMs < heartbeat.startedAtUnixMs) protocolError('BRIDGE_VERSIONS_STALE')
  const validVersion = (value: string): boolean => /^[\x21-\x7e]{1,128}$/.test(value)
  if (![row.game, row.nebula, row.bepinex, row.bridge].every(validVersion)) protocolError('BRIDGE_VERSIONS_INVALID')
  return { processId, writtenAtUnixMs, game: row.game, nebula: row.nebula, bepinex: row.bepinex, bridge: row.bridge }
}

export async function readBridgePlayers(bridgeDirectory: string, secretFile: string, expectedProcessId?: number): Promise<Player[]> {
  const { root, secret } = await readBridgeContext(bridgeDirectory, secretFile, expectedProcessId)
  const playerPath = path.join(root, 'players')
  const stat = await fs.lstat(playerPath).catch(() => null)
  if (!stat?.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 32_768) protocolError('PLAYER_SNAPSHOT_UNAVAILABLE')
  const payload = new TextDecoder('utf-8', { fatal: true }).decode(await fs.readFile(playerPath))
  const keys = ['protocol', 'sessionId', 'writtenAtUnixMs', 'sequence', 'state', 'truncated', 'playerCount', 'playersJsonB64', 'hmac'] as const
  const lines = payload.replace(/^\ufeff/, '').split(/\r?\n/)
  if (lines.at(-1) === '') lines.pop()
  if (lines.length !== keys.length) protocolError('PLAYER_SNAPSHOT_INVALID')
  const row = {} as Record<(typeof keys)[number], string>
  keys.forEach((key, index) => {
    const prefix = `${key}=`
    const line = lines[index]!
    if (!line.startsWith(prefix) || line.length === prefix.length) protocolError('PLAYER_SNAPSHOT_INVALID')
    row[key] = line.slice(prefix.length)
  })
  if (row.protocol !== 'DYSON_CONTROL_PLAYERS_V1' || !/^[0-9a-f-]{36}$/i.test(row.sessionId) || !/^(?:active|inactive|unavailable)$/.test(row.state) || !/^(?:true|false)$/.test(row.truncated)) protocolError('PLAYER_SNAPSHOT_INVALID')
  const writtenAt = integer(row.writtenAtUnixMs, 1)
  integer(row.sequence, 1)
  const count = integer(row.playerCount)
  if (count > 64 || !/^[A-Za-z0-9_-]{2,30000}$/.test(row.playersJsonB64) || Buffer.from(row.playersJsonB64, 'base64url').toString('base64url') !== row.playersJsonB64) protocolError('PLAYER_SNAPSHOT_INVALID')
  assertSignature(row.hmac, hmac(secret, keys.slice(0, -1).map((key) => row[key])))
  const age = Date.now() - writtenAt
  if (age < -5_000 || age > 10_000) protocolError('PLAYER_SNAPSHOT_STALE')
  let decoded: unknown
  let canonical: string
  try { canonical = Buffer.from(row.playersJsonB64, 'base64url').toString('utf8'); decoded = JSON.parse(canonical) } catch { protocolError('PLAYER_SNAPSHOT_INVALID') }
  if (!Array.isArray(decoded) || decoded.length !== count || (row.state !== 'active' && (count !== 0 || row.truncated !== 'false'))) protocolError('PLAYER_SNAPSHOT_INVALID')
  if (row.state !== 'active') protocolError('PLAYER_SNAPSHOT_UNAVAILABLE')
  if (row.truncated === 'true') protocolError('PLAYER_SNAPSHOT_TRUNCATED')
  const players = decoded.map((value, index): Player => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) protocolError('PLAYER_SNAPSHOT_INVALID')
    const player = value as Record<string, unknown>
    const expectedKeys = ['sessionPlayerId', 'displayName', 'online', 'joinedAtUnixMs', 'location']
    if (JSON.stringify(Object.keys(player)) !== JSON.stringify(expectedKeys) || typeof player.sessionPlayerId !== 'string' || !/^player-[0-9]{6,12}$/.test(player.sessionPlayerId) ||
        typeof player.displayName !== 'string' || player.displayName.trim().length === 0 || [...player.displayName].length > 64 || Buffer.byteLength(player.displayName, 'utf8') > 128 || /[\0\r\n]/.test(player.displayName) ||
        player.online !== true || !Number.isSafeInteger(player.joinedAtUnixMs) || (player.joinedAtUnixMs as number) <= 0 || (player.joinedAtUnixMs as number) > writtenAt + 5_000 ||
        typeof player.location !== 'string' || !/^(?:deep-space|planet:[1-9][0-9]{0,9}|star:[1-9][0-9]{0,9})$/.test(player.location)) protocolError('PLAYER_SNAPSHOT_INVALID')
    if (index > 0 && String((decoded[index - 1] as Record<string, unknown>).sessionPlayerId) >= player.sessionPlayerId) protocolError('PLAYER_SNAPSHOT_INVALID')
    const location = player.location === 'deep-space' ? '深空' : player.location.startsWith('planet:') ? `星球 ${player.location.slice(7)}` : `恒星 ${player.location.slice(5)}`
    return { id: `${row.sessionId.toLowerCase()}:${player.sessionPlayerId}`, name: player.displayName, connectedAt: new Date(player.joinedAtUnixMs as number).toISOString(), planet: location, pingMs: null }
  })
  const normalized = JSON.stringify(decoded.map((player: Record<string, unknown>) => ({ sessionPlayerId: player.sessionPlayerId, displayName: player.displayName, online: true, joinedAtUnixMs: player.joinedAtUnixMs, location: player.location })))
  if (normalized !== canonical) protocolError('PLAYER_SNAPSHOT_NONCANONICAL')
  return players
}

/** Historical events remain readable after game exit; they never imply a live player. */
export async function readBridgePlayerEvents(bridgeDirectory: string, secretFile: string, expectedProcessId?: number): Promise<PlayerEventBatch> {
  const root = path.resolve(bridgeDirectory)
  const directory = await fs.lstat(root).catch(() => null)
  if (!directory?.isDirectory() || directory.isSymbolicLink()) protocolError('BRIDGE_DIRECTORY_INVALID')
  const secret = validateSecret(await readPlainFile(secretFile, 'BRIDGE_SECRET'))
  const file = path.join(root, 'player-events')
  const stat = await fs.lstat(file).catch(() => null)
  if (!stat?.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 196_608) protocolError('PLAYER_EVENTS_UNAVAILABLE')
  const keys = ['protocol', 'sessionId', 'processId', 'writtenAtUnixMs', 'firstSequence', 'lastSequence', 'eventCount', 'eventsJsonB64', 'hmac'] as const
  let payload: string
  try { payload = new TextDecoder('utf-8', { fatal: true }).decode(await fs.readFile(file)) } catch { protocolError('PLAYER_EVENTS_INVALID') }
  const row = parseLines(payload, keys, 196_608)
  if (row.protocol !== 'DYSON_CONTROL_PLAYER_EVENTS_V1' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row.sessionId)) protocolError('PLAYER_EVENTS_INVALID')
  assertSignature(row.hmac, hmac(secret, keys.slice(0, -1).map(key => row[key])))
  const processId = integer(row.processId, 1)
  if (expectedProcessId !== undefined && processId !== expectedProcessId) protocolError('BRIDGE_PROCESS_MISMATCH')
  const writtenAtUnixMs = integer(row.writtenAtUnixMs, 1)
  const firstSequence = integer(row.firstSequence)
  const lastSequence = integer(row.lastSequence)
  const count = integer(row.eventCount)
  if (writtenAtUnixMs > Date.now() + 5_000 || count > 256 || (count === 0 ? firstSequence !== 0 || lastSequence !== 0 : firstSequence < 1 || lastSequence - firstSequence + 1 !== count)) protocolError('PLAYER_EVENTS_INVALID')
  if (!/^[A-Za-z0-9_-]+$/.test(row.eventsJsonB64) || Buffer.from(row.eventsJsonB64, 'base64url').toString('base64url') !== row.eventsJsonB64) protocolError('PLAYER_EVENTS_INVALID')
  let canonical: string
  let values: unknown
  try { canonical = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(row.eventsJsonB64, 'base64url')); values = JSON.parse(canonical) } catch { protocolError('PLAYER_EVENTS_INVALID') }
  if (!Array.isArray(values) || values.length !== count) protocolError('PLAYER_EVENTS_INVALID')
  const expectedKeys = ['sequence', 'type', 'sessionPlayerId', 'displayName', 'observedAtUnixMs']
  const events = values.map((value, index): PlayerEventBatch['events'][number] => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || JSON.stringify(Object.keys(value)) !== JSON.stringify(expectedKeys)) protocolError('PLAYER_EVENTS_INVALID')
    const item = value as Record<string, unknown>
    if (item.sequence !== firstSequence + index || !['join', 'leave', 'firstObserved'].includes(String(item.type)) ||
        typeof item.sessionPlayerId !== 'string' || !/^player-[0-9]{6,12}$/.test(item.sessionPlayerId) ||
        typeof item.displayName !== 'string' || !item.displayName.trim() || [...item.displayName].length > 64 || Buffer.byteLength(item.displayName, 'utf8') > 128 || /[\0\r\n]/.test(item.displayName) ||
        !Number.isSafeInteger(item.observedAtUnixMs) || (item.observedAtUnixMs as number) < 1 || (item.observedAtUnixMs as number) > writtenAtUnixMs) protocolError('PLAYER_EVENTS_INVALID')
    return { sequence: item.sequence as number, type: item.type as PlayerEventBatch['events'][number]['type'], sessionPlayerId: item.sessionPlayerId, displayName: item.displayName, observedAtUnixMs: item.observedAtUnixMs as number }
  })
  if (JSON.stringify(events) !== canonical) protocolError('PLAYER_EVENTS_NONCANONICAL')
  return { sessionId: row.sessionId.toLowerCase(), processId, writtenAtUnixMs, firstSequence, lastSequence, events }
}
