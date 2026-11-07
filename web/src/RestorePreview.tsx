import { useEffect, useState } from 'react'
import type { Backup, BackupRestorePreview } from '../../shared/contracts'
import type { RunAction } from './App'
import { api } from './api'
import { ConfirmDialog, ErrorBlock, LoadingBlock } from './components'
import { formatFullDate } from './format'
import './restore-preview.css'

const actionLabels = { create: '新建', replace: '替换', remove: '移除', untouched: '保留原状' }

export function RestorePreview({ backup, operationActive, refreshToken, runAction, onClose }: {
  backup: Backup; operationActive: boolean; refreshToken: number; runAction: RunAction; onClose: () => void
}) {
  const [preview, setPreview] = useState<BackupRestorePreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    setPreview(null)
    setError(null)
    api<BackupRestorePreview>(`/backups/${encodeURIComponent(backup.id)}/restore-preview`, { signal: controller.signal }).then(
      result => { if (!controller.signal.aborted) setPreview(result) },
      reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '恢复预览暂时无法读取。') },
    )
    return () => controller.abort()
  }, [backup.id, refreshToken, attempt])

  const canRestore = preview !== null && preview.blockers.length === 0 && !operationActive
  const confirm = () => {
    if (!canRestore) return
    runAction('restore', { backupId: preview.backupId, previewKey: preview.previewKey })
    onClose()
  }
  return <ConfirmDialog title={`恢复 ${backup.saveName}？`} description={`备份创建于 ${formatFullDate(backup.createdAt)}。确认后会校验备份内容，再执行恢复。`}
    confirmLabel="确认恢复" danger confirmDisabled={!canRestore} onCancel={onClose} onConfirm={confirm}>
    <div className="restore-preview">
      {error ? <ErrorBlock message={error} retry={() => setAttempt(value => value + 1)} /> : !preview ? <LoadingBlock rows={3} /> : <>
        <ul className="restore-members" aria-label="存档文件变更">{preview.members.map(member => <li key={member.fileName}>
          <span>{member.fileName}</span><strong className={`restore-member-${member.action}`}>{actionLabels[member.action]}</strong>
        </li>)}</ul>
        <dl className="restore-effects">
          <div><dt>服务器</dt><dd>{preview.serverRunning ? '会先保存游戏并停服，在线玩家将断开连接。恢复完成后重新启动。' : '当前已停止，恢复完成后保持停止。'}</dd></div>
          <div><dt>保护备份</dt><dd>
            {preview.protectedSaveNames.length > 0 && <span>先备份 {preview.protectedSaveNames.join('、')}。</span>}
            {preview.protectRunningSave && <span>保护运行中世界实际保存的存档。</span>}
            {!preview.protectedSaveNames.length && !preview.protectRunningSave && <span>{preview.blockers.length ? '请先处理下方问题。' : '目标位置没有需要备份的存档文件。'}</span>}
          </dd></div>
          <div><dt>启动存档</dt><dd>{preview.previousStartupSaveName === preview.saveName ? preview.saveName
            : `${preview.previousStartupSaveName || '自动选择'} → ${preview.saveName}`}</dd></div>
        </dl>
        {preview.blockers.length > 0 && <ul className="restore-blockers" role="alert">{preview.blockers.map(message => <li key={message}>{message}</li>)}</ul>}
        {operationActive && <p className="restore-wait" role="status">请等待当前操作完成，再确认恢复。</p>}
      </>}
    </div>
  </ConfirmDialog>
}
