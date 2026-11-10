import { History, RotateCcw } from 'lucide-react'
import { useState } from 'react'
import type { GameSettingsHistoryEntry, ServerSettingKey, SettingsRollbackPreview } from '../../shared/contracts'
import type { RunAction } from './App'
import { Button, ConfirmDialog, EmptyBlock, ErrorBlock, LoadingBlock, Panel } from './components'
import { formatFullDate } from './format'
import { useResource } from './hooks'
import './settings-history.css'

const labels: Record<ServerSettingKey, string> = {
  serverName: '服务器名称', address: '连接地址', backupKeep: '保留备份', targetUps: '目标 UPS',
  maxPlayers: '最多玩家', autosaveMinutes: '自动保存间隔（分钟）'
}
const effects: Record<SettingsRollbackPreview['fields'][number]['effect'], string> = {
  panel: '立即更新面板', 'client-packages': '新生成的客户端包使用', 'backup-retention': '立即执行保留策略',
  'next-start': '下次启动游戏时生效', demo: '立即更新演示设置', 'read-only': '当前只读，保留原值'
}

export function SettingsHistory({ refreshToken, dirty, runAction }: { refreshToken: number; dirty: boolean; runAction: RunAction }) {
  const history = useResource<GameSettingsHistoryEntry[]>('/settings-history', refreshToken)
  const [selected, setSelected] = useState<GameSettingsHistoryEntry | null>(null)
  return <Panel title="设置历史" icon={<History />}>
    {history.loading && !history.data ? <LoadingBlock rows={2} /> : history.error ? <ErrorBlock message={history.error} retry={history.reload} /> : !history.data?.length ? <EmptyBlock title="还没有设置历史" description="每次修改前的设置会自动保留，最多 100 条。" /> : <div className="update-history">{history.data.map(entry => <article key={entry.id}>
      <div><h3>{entry.settings.serverName}</h3><p>{formatFullDate(entry.createdAt)} · {entry.operation === 'write' ? '修改前' : '恢复前'}</p><p>目标 UPS {entry.settings.targetUps} · 保留备份 {entry.settings.backupKeep} · {entry.settings.address}</p></div>
      <Button disabled={dirty} icon={<RotateCcw />} onClick={() => setSelected(entry)}>预览恢复</Button>
    </article>)}</div>}
    {selected && <SettingsRollbackDialog key={selected.id} entry={selected} refreshToken={refreshToken} onClose={() => setSelected(null)} runAction={runAction} />}
  </Panel>
}

function SettingsRollbackDialog({ entry, refreshToken, onClose, runAction }: { entry: GameSettingsHistoryEntry; refreshToken: number; onClose: () => void; runAction: RunAction }) {
  const preview = useResource<SettingsRollbackPreview>(`/settings-history/${encodeURIComponent(entry.id)}/rollback-preview`, refreshToken)
  const result = preview.data
  const canRestore = Boolean(result?.canRollback && !preview.error)
  const changes = result?.fields.filter(field => field.current !== field.selected) ?? []
  const readOnly = result?.fields.filter(field => field.effect === 'read-only' && field.current === field.selected) ?? []
  const lowerRetention = changes.some(field => field.key === 'backupKeep' && Number(field.selected) < Number(field.current))
  const confirm = () => {
    if (!canRestore || !result) return
    runAction('rollback-settings', { historyId: result.historyId, expectedRevision: result.expectedRevision })
    onClose()
  }
  return <ConfirmDialog title="恢复此版本的服务器设置？" description={`${formatFullDate(entry.createdAt)} · ${entry.operation === 'write' ? '修改前' : '恢复前'}。恢复前会保存当前设置。`}
    confirmLabel="恢复设置" confirmDisabled={!canRestore} onCancel={onClose} onConfirm={confirm}>
    <div className="settings-rollback">
      {preview.error ? <ErrorBlock message={preview.error} retry={preview.reload} /> : !result ? <LoadingBlock rows={3} /> : <>
        {changes.length ? <table aria-label="服务器设置差异"><thead><tr><th scope="col">设置 / 生效时间</th><th scope="col">当前</th><th scope="col">所选版本</th></tr></thead>
          <tbody>{changes.map(field => <tr key={field.key}><th scope="row">{labels[field.key]}<small>{effects[field.effect]}</small></th>
            <td>{field.current ?? '未提供'}</td><td className={field.effect === 'read-only' ? '' : 'settings-restored-value'}>{field.selected ?? '未提供'}</td>
          </tr>)}</tbody></table> : <p role="status">当前设置与所选版本一致。</p>}
        {changes.length > 0 && !result.canRollback && <p role="status">差异都属于当前只读字段，无法恢复。</p>}
        {readOnly.length > 0 && <p>当前只读 · {readOnly.map(field => labels[field.key]).join('、')}</p>}
        {lowerRetention && <p className="settings-retention-note">降低保留数量会立即轮换自动备份。超出数量且未标记保留的旧自动备份可能被清理。</p>}
      </>}
    </div>
  </ConfirmDialog>
}
