import { History, RotateCcw } from 'lucide-react'
import type { UpdateHistoryEntry } from '../../shared/contracts'
import type { RunAction } from './App'
import { Button, EmptyBlock, ErrorBlock, LoadingBlock, Panel } from './components'
import { formatFullDate } from './format'
import { useResource } from './hooks'

const stateLabels: Record<UpdateHistoryEntry['state'], string> = { prepared: '操作未完成', installed: '已完成', 'rolled-back': '失败后已还原', 'rollback-failed': '需要恢复', invalid: '记录损坏' }

export function UpdateHistory({ refreshToken, runAction }: { refreshToken: number; runAction: RunAction }) {
  const history = useResource<UpdateHistoryEntry[]>('/update-history', refreshToken)
  return <Panel title="更新历史" icon={<History />}>
    {history.loading && !history.data ? <LoadingBlock /> : history.error ? <ErrorBlock message={history.error} retry={history.reload} /> : !history.data?.length ? <EmptyBlock title="还没有更新记录" description="安装、更新和回滚的结果会保存在这里" /> : <div className="update-history">{history.data.map((entry) => <article key={entry.id}>
      <div><h3>{entry.operation === 'rollback' ? '版本回滚' : entry.packages.map((pkg) => `${pkg.package} ${pkg.version}`).join('、') || '组件变更'}</h3><p>{formatFullDate(entry.createdAt)} · {stateLabels[entry.state]}</p>{entry.error && <p className="text-warning">{entry.error}</p>}</div>
      {entry.canRollback && <Button icon={<RotateCcw />} onClick={() => runAction('rollback-update', { historyId: entry.id }, {
        title: '恢复此次更新前的版本？', description: '系统会保存并备份游戏，然后停服恢复组件和模组版本。现有模组配置会保留，完成后恢复原来的运行状态。', label: '回滚版本', danger: true
      })}>回滚</Button>}
    </article>)}</div>}
  </Panel>
}
