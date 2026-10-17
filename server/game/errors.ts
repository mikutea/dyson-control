export class GameAdapterError extends Error {
  readonly code: string

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'GameAdapterError'
    this.code = code
  }
}

export function unsupported(operation: string, detail: string): never {
  throw new GameAdapterError('UNSUPPORTED_OPERATION', `${operation} is unavailable: ${detail}`)
}

export function invalidInput(message: string): never {
  throw new GameAdapterError('INVALID_INPUT', message)
}
