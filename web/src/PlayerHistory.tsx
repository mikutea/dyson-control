import { useEffect, useState } from 'react'
import { History } from 'lucide-react'
import type { PlayerHistory as HistoryData, PlayerHistoryEntry } from '../../shared/contracts'
import { Button, EmptyBlock, ErrorBlock, LoadingBlock, Panel } from './components'
import { formatFullDate } from './format'
import { useResource } from './hooks'
import './player-history.css'

const labels = { join: '加入', leave: '离开', firstObserved: '首次观测在线', gap: '记录缺失' }
type EventType = PlayerHistoryEntry['type'] | ''

export function PlayerHistory({ refreshToken }: { refreshToken: number }) {
  const [type, setType] = useState<EventType>('')
  const [name, setName] = useState('')
  const [draft, setDraft] = useState('')
  const [cursors, setCursors] = useState<string[]>([])
  const filtered = !!(type || name)
  const params = new URLSearchParams({ limit: '50' })
  if (type) params.set('type', type)
  if (name) params.set('name', name)
  if (cursors.length) params.set('cursor', cursors[cursors.length - 1]!)
  const resource = '/player-history?' + params
  function filter(nextType: EventType, nextName: string) {
    setType(nextType); setName(nextName.trim()); setCursors([])
  }
  return <Panel title="进出记录" icon={<History />}>
    <p className="runtime-notice">保留最近 30 天，最多 10,000 条。首次观测表示当时在线，记录缺失表示有事件未能采集。</p>
    <form role="search" aria-label="筛选进出记录" className="player-history-filters" onSubmit={event => { event.preventDefault(); filter(type, draft) }}>
      <label className="field"><span>事件类型</span><select value={type} onChange={event => filter(event.target.value as EventType, draft)}>
        <option value="">全部事件</option>{Object.entries(labels).map(([key, label]) => <option value={key} key={key}>{label}</option>)}
      </select></label>
      <label className="field"><span>玩家显示名</span><input type="search" autoComplete="off" maxLength={128} value={draft} placeholder="输入全部或部分显示名" onChange={event => setDraft(event.target.value)} /></label>
      <div className="player-history-actions"><Button type="submit">搜索</Button>
        <Button type="button" variant="quiet" disabled={!filtered && !draft} onClick={() => { setDraft(''); filter('', '') }}>清除筛选</Button></div>
    </form>
    <HistoryPage key={resource} resource={resource} refreshToken={refreshToken} filtered={filtered} page={cursors.length || 1} pinned={cursors.length > 0}
      latest={() => setCursors([])} previous={() => setCursors(values => values.slice(0, -1))}
      next={(head, after) => setCursors(values => values.length ? [...values, after] : [head, after])} />
  </Panel>
}

function HistoryPage({ resource, refreshToken, filtered, page, pinned, latest, previous, next }: {
  resource: string; refreshToken: number; filtered: boolean; page: number; pinned: boolean
  latest: () => void; previous: () => void; next: (head: string, after: string) => void
}) {
  const history = useResource<HistoryData>(resource, refreshToken)
  useEffect(() => {
    const timer = window.setInterval(() => { void history.poll() }, 5000)
    return () => window.clearInterval(timer)
  }, [history.poll])
  const data = history.data
  return <>
    <nav className="player-history-pagination" aria-label="进出记录分页">
      <span role="status">{pinned ? '第 ' + page + ' 页' : '最新一页'}{data && ' · 本页 ' + data.entries.length + ' 条 / 共 ' + data.total + ' 条'}</span>
      <Button variant="quiet" disabled={page === 1} onClick={previous}>上一页</Button>
      <Button variant="quiet" disabled={!data?.nextCursor || !!history.error} onClick={() => data?.nextCursor && next(data.pageCursor, data.nextCursor)}>下一页</Button>
      {pinned && <Button variant="quiet" onClick={latest}>回到最新</Button>}
    </nav>
    {!data ? history.loading ? <LoadingBlock /> : <ErrorBlock message={history.error || '记录读取失败'} retry={history.reload} /> : <>
      {data.status !== 'available' && <p role="status" className="runtime-notice">{data.status === 'waiting' ? '等待 Bridge 的首次记录。' : '暂时无法读取新的进出事件，已有历史仍然保留。'}</p>}
      {history.error && <p role="status" className="runtime-notice">刷新失败，以下为上次读取的历史。 <Button variant="quiet" onClick={() => void history.reload()}>重试读取</Button></p>}
      {!data.entries.length ? pinned ? <EmptyBlock title="这页已没有保留的记录" description="回到最新或返回较新的一页，查看仍在保留期内的记录。" />
        : filtered ? <EmptyBlock title="没有匹配的进出记录" description="可更换显示名、事件类型，或清除筛选查看全部记录。" />
          : <EmptyBlock title="暂无进出记录" description="只有 Bridge 确认的事件会记入历史。" />
        : <ol className="player-history-list">{data.entries.map(entry => <li key={entry.id}>
          <span className={'player-event player-event-' + entry.type}>{labels[entry.type]}</span>
          <strong>{entry.type === 'gap' ? entry.missingCount + ' 条事件未能采集' : entry.name}</strong>
          <time dateTime={entry.occurredAt}>{formatFullDate(entry.occurredAt)}</time>
        </li>)}</ol>}
    </>}
  </>
}
