import type { ControlConfig, GameAdapter } from '../../shared/contracts.js'
import { DemoGameAdapter } from './demo.js'
import { GameAdapterError } from './errors.js'
import { WindowsGameAdapter } from './windows.js'

export { GameAdapterError } from './errors.js'

export function createGameAdapter(config: ControlConfig): GameAdapter {
  if (config.mode === 'demo') return new DemoGameAdapter(config)
  if (config.mode === 'windows') return new WindowsGameAdapter(config)
  throw new GameAdapterError('INVALID_MODE', `Unsupported game adapter mode: ${String(config.mode)}`)
}
