import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const unauthorized = () => new Response(JSON.stringify({ error: { code: 'authentication_required', message: 'Expired' } }), { status: 401 })
const session = () => new Response(JSON.stringify({ data: { authenticated: true, username: 'administrator', source: 'demo' } }))
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

describe('browser session responses', () => {
  const dispatchEvent = vi.fn()
  beforeEach(() => {
    vi.resetModules()
    dispatchEvent.mockReset()
    vi.stubGlobal('window', { dispatchEvent })
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('expires the current session once when several requests are rejected together', async () => {
    const { get } = await import('../web/src/api')
    vi.stubGlobal('fetch', vi.fn(async () => unauthorized()))
    const results = await Promise.allSettled([get('/overview'), get('/jobs/current')])
    expect(results.every(result => result.status === 'rejected')).toBe(true)
    expect(dispatchEvent).toHaveBeenCalledTimes(1)
    expect(dispatchEvent.mock.calls[0]![0].type).toBe('dyson-auth-required')
  })

  it.each(['POST', 'DELETE'])('ignores an older rejection after a successful session %s', async method => {
    const { api, get } = await import('../web/src/api')
    const old = deferred<Response>()
    vi.stubGlobal('fetch', vi.fn().mockImplementationOnce(() => old.promise).mockImplementationOnce(async () => session()))
    const pending = get('/players').catch(error => error)
    await api('/session', { method })
    old.resolve(unauthorized())
    expect(await pending).toMatchObject({ status: 401 })
    expect(dispatchEvent).not.toHaveBeenCalled()
  })

  it('still expires requests from the new session after a successful login', async () => {
    const { get, post } = await import('../web/src/api')
    vi.stubGlobal('fetch', vi.fn().mockImplementationOnce(async () => session()).mockImplementationOnce(async () => unauthorized()))
    await post('/session', { password: 'synthetic-test-password' })
    await expect(get('/overview')).rejects.toMatchObject({ status: 401 })
    expect(dispatchEvent).toHaveBeenCalledTimes(1)
  })

  it('keeps invalid credentials in the login form without suppressing a current-session rejection', async () => {
    const { get, post } = await import('../web/src/api')
    const old = deferred<Response>()
    vi.stubGlobal('fetch', vi.fn().mockImplementationOnce(() => old.promise).mockImplementationOnce(async () => unauthorized()))
    const pending = get('/players').catch(error => error)
    await expect(post('/session', { password: 'wrong' })).rejects.toMatchObject({ status: 401 })
    expect(dispatchEvent).not.toHaveBeenCalled()
    old.resolve(unauthorized())
    await pending
    expect(dispatchEvent).toHaveBeenCalledTimes(1)
  })

  it('returns to login when logout finds an already expired cookie', async () => {
    const { remove } = await import('../web/src/api')
    vi.stubGlobal('fetch', vi.fn(async () => unauthorized()))
    await expect(remove('/session')).rejects.toMatchObject({ status: 401 })
    expect(dispatchEvent).toHaveBeenCalledTimes(1)
  })

  it('does not expire the session for a cancelled read', async () => {
    const { api } = await import('../web/src/api')
    const old = deferred<Response>()
    vi.stubGlobal('fetch', vi.fn(() => old.promise))
    const controller = new AbortController()
    const pending = api('/players', { signal: controller.signal }).catch(error => error)
    controller.abort()
    old.resolve(unauthorized())
    await pending
    expect(dispatchEvent).not.toHaveBeenCalled()
  })

  it.each([false, true])('handles upload authorization against its original session (new login: %s)', async loggedInAgain => {
    const { post, uploadBackup } = await import('../web/src/api')
    let request!: XMLHttpRequest
    vi.stubGlobal('XMLHttpRequest', class {
      upload = {}
      status = 401
      responseText = JSON.stringify({ error: { code: 'authentication_required', message: 'Expired' } })
      constructor() { request = this as unknown as XMLHttpRequest }
      open() {}
      setRequestHeader() {}
      send() {}
    })
    vi.stubGlobal('fetch', vi.fn(async () => session()))
    const pending = uploadBackup(new File(['test'], 'backup.zip'), '0'.repeat(32), new AbortController().signal, () => {}).catch(error => error)
    if (loggedInAgain) await post('/session', { password: 'synthetic-test-password' })
    request.onload?.call(request, new Event('load') as ProgressEvent)
    request.onloadend?.call(request, new Event('loadend') as ProgressEvent)
    expect(await pending).toMatchObject({ status: 401, code: 'authentication_required' })
    expect(dispatchEvent).toHaveBeenCalledTimes(loggedInAgain ? 0 : 1)
  })
})
