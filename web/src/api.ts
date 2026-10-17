import type { ActionRequest, ApiErrorBody, Job } from '../../shared/contracts'

type Envelope<T> = { data: T }

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'ApiError'
  }
}

async function parseError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as Partial<ApiErrorBody>
    const code = body.error?.code
    const messages: Record<string, string> = {
      invalid_credentials: '管理员密码不正确',
      authentication_required: '登录已过期，请重新登录',
      validation_error: '提交的内容有误，请检查后重试',
      origin_forbidden: '此页面无法提交管理操作',
      request_id_conflict: '操作没有开始，请重新提交',
      job_not_found: '没有找到这项操作记录',
      shutting_down: '控制服务正在关闭，请稍后重试',
      download_not_available: '当前文件无法下载',
      download_not_found: '下载文件已经不存在',
      internal_error: '控制服务暂时无法完成请求',
    }
    return code && messages[code] ? messages[code] : body.error?.message || `请求失败（${response.status}）`
  } catch {
    return `请求失败（${response.status}）`
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    credentials: 'same-origin',
    ...init,
    headers: init?.body ? { 'Content-Type': 'application/json', ...init.headers } : init?.headers,
  })
  if (!response.ok) {
    const message = await parseError(response)
    if (response.status === 401 && path !== '/session') window.dispatchEvent(new CustomEvent('dyson-auth-required'))
    throw new ApiError(message, response.status)
  }
  if (response.status === 204) return undefined as T
  const body = (await response.json()) as Envelope<T>
  return body.data
}

export function get<T>(path: string) {
  return api<T>(path)
}

export function post<T>(path: string, body: unknown) {
  return api<T>(path, { method: 'POST', body: JSON.stringify(body) })
}

export function remove<T>(path: string) {
  return api<T>(path, { method: 'DELETE' })
}

export function submitAction(action: ActionRequest['action'], input: Record<string, unknown> = {}) {
  return post<Job>('/actions', { requestId: crypto.randomUUID(), action, input } satisfies ActionRequest)
}

export function uploadBackup(file: File, requestId: string, signal: AbortSignal, onProgress: (percent: number) => void): Promise<Job> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest()
    const abort = () => request.abort()
    request.open('POST', '/api/backups/import')
    request.setRequestHeader('Content-Type', 'application/zip')
    request.setRequestHeader('x-request-id', requestId)
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.round(event.loaded / event.total * 100))
    }
    request.onload = () => {
      try {
        const body = JSON.parse(request.responseText) as Envelope<Job> & Partial<ApiErrorBody>
        if (request.status === 401) window.dispatchEvent(new CustomEvent('dyson-auth-required'))
        if (request.status < 200 || request.status >= 300) throw new ApiError(body.error?.message || `上传失败（${request.status}）`, request.status)
        if (!body.data?.id) throw new Error('未收到导入任务，请重试确认结果。')
        resolve(body.data)
      } catch (error) { reject(error) }
    }
    request.onerror = () => reject(new Error('上传连接中断，请重试确认结果。'))
    request.onabort = () => reject(new Error('上传已取消。'))
    request.onloadend = () => signal.removeEventListener('abort', abort)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) { signal.removeEventListener('abort', abort); reject(new Error('上传已取消。')); return }
    request.send(file)
  })
}
