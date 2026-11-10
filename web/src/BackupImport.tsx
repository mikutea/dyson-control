import { useEffect, useRef, useState } from 'react'
import { Upload } from 'lucide-react'
import type { Job } from '../../shared/contracts'
import { newRequestId } from './api'
import { findPendingReceipts, submitBackup, usePendingReceiptActions } from './action-receipts'
import { Button, Panel } from './components'
import { formatBytes } from './format'

export function BackupImport({ onJob }: { onJob: (job: Job) => void }) {
  const [selection, setSelection] = useState<{ file: File; requestId: string } | null>(null)
  const file = selection?.file
  const [progress, setProgress] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const controller = useRef<AbortController | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const pending = usePendingReceiptActions().includes('import-backup')
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    let active = true
    void findPendingReceipts({ action: 'import-backup' }).then(jobs => {
      if (!active || !jobs.length) return
      onJob(jobs[0]!)
      setMessage(`已找回 ${jobs.length} 项上次上传的导入任务，可在活动中查看。`)
    }).catch(() => { if (active) setError('暂时无法核对上次上传，请恢复连接后核对回执。') })
    return () => { active = false; mounted.current = false; controller.current?.abort('page-left') }
  }, [onJob])

  const clearMissing = async () => {
    if (controller.current) return
    setBusy(true)
    setError(null)
    try {
      const jobs = await findPendingReceipts({ action: 'import-backup', clearMissingImports: true })
      if (!mounted.current) return
      if (jobs.length) onJob(jobs[0]!)
      setMessage(jobs.length ? `已找回 ${jobs.length} 项导入任务，可在活动中查看。` : '已清除没有任务记录的上传请求号。')
    } catch { if (mounted.current) setError('暂时无法核对上传，已保留请求号。') }
    finally { if (mounted.current) setBusy(false) }
  }

  const submit = async () => {
    if (!selection || !file || controller.current) return
    if (!file.size || file.size > 8 * 1024 ** 3) { setError('请选择不超过 8 GiB 的备份 ZIP 文件。'); return }
    const abort = new AbortController()
    controller.current = abort
    setBusy(true)
    setProgress(0)
    setError(null)
    setMessage(null)
    try {
      const previous = await findPendingReceipts({ action: 'import-backup', exceptId: selection.requestId })
      if (!mounted.current) return
      if (previous.length) {
        onJob(previous[0]!)
        setMessage(`已找回 ${previous.length} 项之前的上传任务。当前所选文件仍待上传，要导入它请再次点击“上传并导入”。`)
        return
      }
      const { job, recovered } = await submitBackup(file, selection.requestId, abort.signal, setProgress)
      if (!mounted.current) return
      onJob(job)
      const current = abort.signal.aborted ? '已停止发送文件，服务端已创建这次导入任务。' :
        recovered ? '已找回这次上传的导入任务。' : '上传完成，已创建导入任务。'
      setMessage(current + '可在活动中查看结果。')
      setSelection(null)
      if (input.current) input.current.value = ''
    } catch (reason) {
      if (mounted.current) setError(reason instanceof Error ? reason.message : '备份上传失败。')
    } finally {
      controller.current = null
      if (mounted.current) setBusy(false)
    }
  }

  return <Panel title="导入备份" icon={<Upload />}>
    <div className="backup-import">
      <p>可上传 Dyson Control 备份，或把同名的 <code>.dsv</code>、<code>.server</code> 和已有的 <code>.moddsv</code> 压成 ZIP。普通存档组应放在 ZIP 根目录或同一个一级文件夹内。</p>
      <p>导入后可在备份列表中预览恢复。只有确认恢复后才会写入游戏存档。</p>
      {pending && <p>有上传请求等待核对。重新选择文件会使用新的请求号。 <Button variant="quiet" disabled={busy} onClick={() => void clearMissing()}>清除未找到任务的请求号</Button></p>}
      <div className="backup-import-controls">
        <label className="backup-file"><span>备份文件</span><input ref={input} type="file" accept=".zip,application/zip" disabled={busy} onChange={(event) => {
          const chosen = event.target.files?.[0]
          setSelection(chosen ? { file: chosen, requestId: newRequestId() } : null)
          setError(null)
          setMessage(null)
        }} /></label>
        <Button icon={<Upload />} disabled={!file} busy={busy} onClick={() => void submit()}>上传并导入</Button>
        {busy && controller.current && <Button onClick={() => controller.current?.abort()}>取消上传</Button>}
      </div>
      {file && <small>{file.name} · {formatBytes(file.size)}</small>}
      {busy && controller.current && <div className="upload-progress" role="status"><progress aria-label="备份上传进度" max={100} value={progress} /><span>{progress === 100 ? '上传完成，正在接收…' : `已上传 ${progress}%`}</span></div>}
      {error && <p className="text-danger" role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
    </div>
  </Panel>
}
