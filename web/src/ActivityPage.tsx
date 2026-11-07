import { useCallback, useEffect, useRef, useState } from 'react'
import { Download, Pause, Play, RefreshCw } from 'lucide-react'
import type { LogEntry } from '../../shared/contracts'
import { api } from './api'
import { downloadText } from './download-text'
import { Button, EmptyBlock, ErrorBlock, LoadingBlock, PageHeader, Panel } from './components'
import { formatFullDate } from './format'
import { OperationHistory } from './OperationHistory'
import './activity.css'

const logLevelLabels = { all: '全部级别', info: '信息', warning: '提醒', error: '错误' }
type LogLevel = keyof typeof logLevelLabels

export function ActivityPage({ refreshToken }: { refreshToken: number }) {
  const [tab, setTab] = useState<'operations' | 'logs'>('operations')
  const [logs, setLogs] = useState<LogEntry[] | null>(null)
  const [logError, setLogError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [updatedAt, setUpdatedAt] = useState<string | null>(null)
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [logLevel, setLogLevel] = useState<LogLevel>('all')
  const [logSearch, setLogSearch] = useState('')
  const request = useRef<AbortController | null>(null)

  const refreshLogs = useCallback(async () => {
    if (request.current && !request.current.signal.aborted) return
    const controller = new AbortController()
    request.current = controller
    setRefreshing(true)
    try {
      const next = await api<LogEntry[]>('/logs', { signal: controller.signal })
      if (!controller.signal.aborted) {
        setLogs(next)
        setUpdatedAt(new Date().toISOString())
        setLogError(null)
      }
    } catch (reason) {
      if (!controller.signal.aborted) setLogError(reason instanceof Error ? reason.message : '暂时无法读取服务器消息')
    } finally {
      if (request.current === controller) {
        request.current = null
        setRefreshing(false)
      }
    }
  }, [])

  useEffect(() => {
    if (tab !== 'logs') return
    if (autoRefresh) void refreshLogs()
    const timer = autoRefresh ? window.setInterval(() => void refreshLogs(), 5000) : undefined
    return () => {
      window.clearInterval(timer)
      request.current?.abort()
    }
  }, [tab, autoRefresh, refreshLogs])

  const search = logSearch.trim().toLocaleLowerCase()
  const filteredLogs = logs?.filter(entry => (logLevel === 'all' || entry.level === logLevel) && entry.message.toLocaleLowerCase().includes(search)) ?? []
  const downloadSnapshot = () => {
    const downloadedAt = new Date().toISOString()
    const contents = [
      'Dyson Control 服务器消息筛选快照',
      `下载时间：${formatFullDate(downloadedAt)}`,
      `最近刷新：${formatFullDate(updatedAt)}`,
      `级别：${logLevelLabels[logLevel]}`,
      `关键词：${logSearch.trim() || '无'}`,
      `显示 ${filteredLogs.length} / ${logs?.length ?? 0} 条；按最新消息在前排列。`,
      '范围：最近日志快照，最多 500 条，长消息可能截短。此文件仅包含当前筛选结果，并非完整日志。',
      '',
      ...filteredLogs.map(entry => `${entry.time ? formatFullDate(entry.time) : '时间未记录'} [${logLevelLabels[entry.level]}] ${entry.message}`),
      '',
    ].join('\r\n')
    downloadText(`dyson-log-snapshot-${downloadedAt.replace(/[:.]/g, '-')}.txt`, contents)
  }

  return <>
    <PageHeader title="活动" description="查看管理操作和服务器消息" actions={<div className="segmented" aria-label="活动类型">
      <button className={tab === 'operations' ? 'selected' : ''} aria-pressed={tab === 'operations'} onClick={() => setTab('operations')}>管理操作</button>
      <button className={tab === 'logs' ? 'selected' : ''} aria-pressed={tab === 'logs'} onClick={() => setTab('logs')}>服务器消息</button>
    </div>} />
    <Panel className="table-panel activity-panel">
      <OperationHistory visible={tab === 'operations'} refreshToken={refreshToken} />
      {tab === 'logs' && <>
        <div className="activity-log-toolbar">
          <p className="activity-log-status" role="status"><strong>{autoRefresh ? '每 5 秒自动更新' : '自动更新已暂停'}</strong><span>{updatedAt ? `最近刷新 ${formatFullDate(updatedAt)}` : '尚未读取消息'}</span></p>
          <div className="activity-log-actions">
            <Button icon={autoRefresh ? <Pause /> : <Play />} onClick={() => setAutoRefresh(value => !value)}>{autoRefresh ? '暂停自动更新' : '继续自动更新'}</Button>
            <Button icon={<RefreshCw />} busy={refreshing} onClick={() => void refreshLogs()}>刷新消息</Button>
            <Button icon={<Download />} disabled={!filteredLogs.length} onClick={downloadSnapshot}>下载筛选快照</Button>
          </div>
        </div>
        <div className="log-filters activity-log-filters">
          <label><span>消息级别</span><select value={logLevel} onChange={event => setLogLevel(event.target.value as LogLevel)}>{Object.entries(logLevelLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label><span>搜索消息</span><input type="search" value={logSearch} onChange={event => setLogSearch(event.target.value)} placeholder="输入关键词" /></label>
          <small>显示 {filteredLogs.length} / {logs?.length ?? 0} 条</small>
        </div>
        <p className="activity-log-scope">这里只显示最近最多 500 条消息，长消息可能截短；下载仅包含当前筛选快照，并非完整日志。</p>
        {logError && logs !== null && <p className="connection-warning activity-log-warning" role="status">刷新失败：{logError} 当前保留上次读取的消息。{autoRefresh ? '将继续自动重试。' : '可手动刷新，或继续自动更新。'}</p>}
        {logs === null ? logError ? <ErrorBlock message={logError} retry={() => void refreshLogs()} /> : !autoRefresh && !refreshing ? <EmptyBlock title="尚未读取服务器消息" description="点击刷新消息读取一次，或继续自动更新。" /> : <LoadingBlock rows={5} />
          : !logs.length ? <EmptyBlock title="暂无服务器消息" description="服务器的新消息会显示在这里" />
            : !filteredLogs.length ? <EmptyBlock title="没有匹配的消息" description="调整消息级别或关键词查看其他消息" />
              : <div className="log-list activity-log-list">{filteredLogs.map(entry => <div key={entry.id}>
                <time>{entry.time ? formatFullDate(entry.time) : '时间未记录'}</time>
                <span className={`log-level log-${entry.level}`}>{logLevelLabels[entry.level]}</span>
                <p>{entry.message}</p>
              </div>)}</div>}
      </>}
    </Panel>
  </>
}
