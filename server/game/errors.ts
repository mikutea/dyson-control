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

export function backupExportStorageError(cause: unknown): GameAdapterError {
  const code = (cause as NodeJS.ErrnoException | null)?.code
  if (code === 'ENOSPC' || code === 'EDQUOT') {
    return new GameAdapterError('BACKUP_EXPORT_SPACE', '面板的系统临时卷空间不足。释放足够的空间后，可重新下载这份备份。', { cause })
  }
  return new GameAdapterError('BACKUP_EXPORT_STORAGE', '无法准备备份下载文件。请检查面板进程的系统临时目录及其写入、删除权限。', { cause })
}
