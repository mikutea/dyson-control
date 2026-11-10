import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './api'

export interface Resource<T> {
  data: T | null
  loading: boolean
  error: string | null
  reload: () => Promise<void>
  poll: () => Promise<void>
}

export function useResource<T>(path: string, refreshToken = 0): Resource<T> {
  const [snapshot, setSnapshot] = useState<{ path: string; data: T | null; loading: boolean; error: string | null }>({
    path, data: null, loading: true, error: null,
  })
  const mountedPath = useRef<string | null>(null)
  const active = useRef<{ controller: AbortController; promise: Promise<void> } | null>(null)

  const read = useCallback((replace: boolean): Promise<void> => {
    if (mountedPath.current !== path) return Promise.resolve()
    if (active.current) {
      if (!replace) return active.current.promise
      active.current.controller.abort()
    }
    const current = { controller: new AbortController(), promise: Promise.resolve() }
    active.current = current
    setSnapshot(previous => previous.path === path && previous.data !== null ? previous
      : { path, data: null, loading: true, error: null })
    current.promise = (async () => {
      try {
        const next = await api<T>(path, { signal: current.controller.signal })
        if (!current.controller.signal.aborted) setSnapshot({ path, data: next, loading: false, error: null })
      } catch (reason) {
        if (!current.controller.signal.aborted) setSnapshot(previous => ({
          path, data: previous.path === path ? previous.data : null, loading: false,
          error: reason instanceof Error ? reason.message : '暂时无法读取数据',
        }))
      } finally {
        if (active.current === current) active.current = null
      }
    })()
    return current.promise
  }, [path])
  // Polling shares a slow read. Explicit refreshes start after the event they must observe.
  const reload = useCallback(() => read(true), [read])
  const poll = useCallback(() => read(false), [read])

  useEffect(() => {
    mountedPath.current = path
    return () => {
      mountedPath.current = null
      active.current?.controller.abort()
      active.current = null
    }
  }, [path])
  useEffect(() => { void reload() }, [reload, refreshToken])

  const { data, loading, error } = snapshot.path === path ? snapshot : { data: null, loading: true, error: null }
  return { data, loading, error, reload, poll }
}
