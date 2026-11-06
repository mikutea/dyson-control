import { useState } from 'react'
import { Download, Pin, RotateCcw, ShieldCheck } from 'lucide-react'
import type { Backup } from '../../shared/contracts'
import type { RunAction } from './App'
import { Button, EmptyBlock } from './components'
import { formatBackupReason, formatBytes, formatFullDate } from './format'
import './backup-library.css'

const pageSize = 20
const kinds = { all: '全部', retained: '已保留', manual: '手动', imported: '导入', scheduled: '定时', protection: '保护副本' }
type Kind = keyof typeof kinds
function matchesKind(backup: Backup, kind: Kind): boolean {
  switch (kind) {
    case 'all': return true
    case 'retained': return backup.retained === true
    case 'scheduled': return backup.reason === 'automatic-scheduled'
    case 'protection': return backup.reason.startsWith('automatic-before-')
    default: return backup.reason === kind
  }
}

export function BackupLibrary({ items, disabled, onRestore, runAction }: {
  items: Backup[]; disabled: boolean; onRestore: (backup: Backup) => void; runAction: RunAction
}) {
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<Kind>('all')
  const [snapshot, setSnapshot] = useState<{ ids: string[]; page: number } | null>(null)
  const needle = query.trim().toLocaleLowerCase()
  const matches = items.filter(item => matchesKind(item, kind) && item.saveName.toLocaleLowerCase().includes(needle))
  const page = snapshot?.page ?? 0
  let rows = matches.slice(0, pageSize)
  if (snapshot) {
    const byId = new Map(matches.map(item => [item.id, item]))
    rows = snapshot.ids.slice(page * pageSize, (page + 1) * pageSize)
      .map(id => byId.get(id)).filter((item): item is Backup => item !== undefined)
  }
  const pageCount = Math.ceil((snapshot?.ids.length ?? matches.length) / pageSize)
  const clear = () => { setQuery(''); setKind('all'); setSnapshot(null) }
  return <>
    <div className="backup-filters">
      <label>查找存档<input type="search" aria-label="查找存档" placeholder="存档名称" value={query} onChange={event => { setQuery(event.target.value); setSnapshot(null) }} /></label>
      <label>备份种类<select aria-label="备份种类" value={kind} onChange={event => { setKind(event.target.value as Kind); setSnapshot(null) }}>
        {Object.entries(kinds).map(([key, title]) => <option key={key} value={key}>{title}</option>)}
      </select></label>
      {(query || kind !== 'all') && <Button type="button" variant="quiet" onClick={clear}>清除筛选</Button>}
    </div>
    {!rows.length && <EmptyBlock title={snapshot ? '本页备份已移除或不再符合筛选' : '没有匹配的备份'} description={snapshot ? '可以翻页或回到最新备份。' : '调整存档名称或备份种类。'} />}
    {rows.length > 0 && <div className="file-list backup-library-list">
      {rows.map(backup => <div key={backup.id}>
        <span className="file-icon"><ShieldCheck /></span>
        <div><strong>{backup.saveName}</strong><p>{formatBytes(backup.bytes)} · {backup.members.length} 个文件{backup.retained ? ' · 已保留' : ''}</p>
          <small id={`backup-meta-${backup.id}`}>{formatFullDate(backup.createdAt)} · {formatBackupReason(backup.reason)}</small>
          {backup.retained === null && <small>保留标记待核对，自动轮换已跳过</small>}
          {typeof backup.retained === 'boolean' && <Button className="backup-retention-toggle" variant="quiet" icon={<Pin />} aria-pressed={backup.retained}
            title={backup.retained ? '取消后，此备份将重新参与自动轮换' : '保留这份备份，自动轮换会跳过它'}
            aria-label={`${backup.retained ? '取消保留' : '保留此备份'} · ${backup.saveName} · ${formatFullDate(backup.createdAt)}`} disabled={disabled}
            onClick={() => runAction('set-backup-retained', { backupId: backup.id, retained: !backup.retained }, backup.retained ? {
              title: `取消保留 ${backup.saveName} 的备份？`, label: '取消保留',
              description: `创建于 ${formatFullDate(backup.createdAt)} 的副本将重新参与自动轮换。本次只撤销标记，以后超出保留数量时可能清理这份备份及其下载缓存。`,
            } : undefined)}>{backup.retained ? '取消保留' : '保留此备份'}</Button>}
        </div>
        <a className="icon-link" href={`/api/backups/${encodeURIComponent(backup.id)}/download`} aria-label={`下载 ${backup.saveName}`} aria-describedby={`backup-meta-${backup.id}`}><Download /></a>
        <Button variant="quiet" icon={<ShieldCheck />} aria-label={`校验备份 ${backup.saveName}`} aria-describedby={`backup-meta-${backup.id}`} disabled={disabled} onClick={() => runAction('verify-backup', { backupId: backup.id })}>校验</Button>
        <Button variant="quiet" icon={<RotateCcw />} aria-label={`预览恢复 ${backup.saveName}`} aria-describedby={`backup-meta-${backup.id}`} onClick={() => onRestore(backup)}>恢复</Button>
      </div>)}
    </div>}
    {(snapshot || pageCount > 1) && <nav className="backup-library-pages" aria-label="备份翻页">
      <Button type="button" variant="quiet" disabled={!snapshot} onClick={() => setSnapshot(page > 1 && snapshot ? { ...snapshot, page: page - 1 } : null)}>较新备份</Button>
      <span>{page + 1} / {pageCount}</span>
      <Button type="button" variant="quiet" disabled={page + 1 >= pageCount} onClick={() => setSnapshot({ ids: snapshot?.ids ?? matches.map(item => item.id), page: page + 1 })}>较早备份</Button>
      {snapshot && page > 1 && <Button type="button" variant="quiet" onClick={() => setSnapshot(null)}>回到最新</Button>}
    </nav>}
  </>
}
