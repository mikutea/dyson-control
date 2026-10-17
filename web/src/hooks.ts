import { useCallback, useEffect, useRef, useState } from 'react'
import { get } from './api'

export interface Resource<T> {
  data: T | null
  loading: boolean
  error: string | null
  reload: () => Promise<void>
}

export function useResource<T>(path: string, refreshToken = 0): Resource<T> {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const request = useRef(0)

  const reload = useCallback(async () => {
    const current = ++request.current
    if (data === null) setLoading(true)
    try {
      const next = await get<T>(path)
      if (current === request.current) {
        setData(next)
        setError(null)
      }
    } catch (reason) {
      if (current === request.current) {
        setError(reason instanceof Error ? reason.message : '暂时无法读取数据')
      }
    } finally {
      if (current === request.current) setLoading(false)
    }
  }, [path, data])

  useEffect(() => { void reload() }, [path, refreshToken]) // eslint-disable-line react-hooks/exhaustive-deps

  return { data, loading, error, reload }
}
