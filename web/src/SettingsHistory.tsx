import { History, RotateCcw } from 'lucide-react'
import type { GameSettingsHistoryEntry } from '../../shared/contracts'
import type { RunAction } from './App'
import { Button, EmptyBlock, ErrorBlock, LoadingBlock, Panel } from './components'
import { formatFullDate } from './format'
import { useResource } from './hooks'

export function SettingsHistory({ refreshToken, dirty, runAction }: { refreshToken: number; dirty: boolean; runAction: RunAction }) {
  const history = useResource<GameSettingsHistoryEntry[]>('/settings-history', refreshToken)
  return <Panel title="设置历史" icon={<History />}>
    {history.loading && !history.data ? <LoadingBlock rows={2} /> : history.error ? <ErrorBlock message={history.error} retry={history.reload} /> : !history.data?.length ? <EmptyBlock title="还没有设置历史" description="每次修改前的设置会自动保留，最多 100 条。" /> : <div className="update-history">{history.data.map(entry => <article key={entry.id}>
      <div><h3>{entry.settings.serverName}</h3><p>{formatFullDate(entry.createdAt)} · {entry.operation === 'write' ? '修改前' : '恢复前'}</p><p>目标 UPS {entry.settings.targetUps} · 保留备份 {entry.settings.backupKeep} · {entry.settings.address}</p></div>
      <Button disabled={dirty} icon={<RotateCcw />} onClick={() => runAction('rollback-settings', { historyId: entry.id }, { title: '恢复此版本的服务器设置？', description: '当前设置会先保存到历史。面板信息和备份策略立即生效，目标 UPS 在下次启动时生效。', label: '恢复设置' })}>恢复设置</Button>
    </article>)}</div>}
  </Panel>
}
