import { History, RotateCcw } from 'lucide-react'
import type { ModRemovalHistoryEntry } from '../../shared/contracts'
import type { RunAction } from './App'
import { Button, EmptyBlock, ErrorBlock, LoadingBlock, Panel } from './components'
import { formatFullDate } from './format'
import { useResource } from './hooks'

export function ModRemovalHistory({ refreshToken, runAction }: { refreshToken: number; runAction: RunAction }) {
  const history = useResource<ModRemovalHistoryEntry[]>('/mod-removal-history', refreshToken)
  return <Panel title="已移除模组" icon={<History />}>
    {history.loading && !history.data ? <LoadingBlock /> : history.error ? <ErrorBlock message={history.error} retry={history.reload} /> : !history.data?.length ? <EmptyBlock title="没有移除记录" description="移除模组时会保留可恢复副本，配置文件也会保留。" /> : <div className="update-history">{history.data.map(entry => <article key={entry.id}>
      <div><h3>{entry.name}</h3><p>版本 {entry.version} · {formatFullDate(entry.createdAt)}</p><p>{entry.canRestore ? '可恢复至移除前的状态' : '当前不可恢复'}</p></div>
      {entry.canRestore && <Button icon={<RotateCcw />} onClick={() => runAction('restore-removed-mod', { historyId: entry.id }, { title: `恢复 ${entry.name}？`, description: '游戏运行中会先保存、备份并停服，恢复后重新启动；已有同名文件时会停止操作。', label: '恢复模组', danger: true })}>恢复模组</Button>}
    </article>)}</div>}
  </Panel>
}
