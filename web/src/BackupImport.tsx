import { useEffect, useRef, useState } from 'react'
import { Upload } from 'lucide-react'
import type { Job } from '../../shared/contracts'
import { uploadBackup } from './api'
import { Button, Panel } from './components'
import { formatBytes } from './format'

export function BackupImport({ onJob }: { onJob: (job: Job) => void }) {
  const [file, setFile] = useState<File | null>(null)
  const [progress, setProgress] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const requestId = useRef('')
  const controller = useRef<AbortController | null>(null)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => () => controller.current?.abort(), [])

  const submit = async () => {
    if (!file || controller.current) return
    if (!file.size || file.size > 8 * 1024 ** 3) { setError('请选择不超过 8 GiB 的备份 ZIP 文件。'); return }
    const abort = new AbortController()
    controller.current = abort
    setBusy(true)
    setProgress(0)
    setError(null)
    setMessage(null)
    try {
      const job = await uploadBackup(file, requestId.current, abort.signal, setProgress)
      onJob(job)
      setMessage('上传完成，正在检查备份。结果会显示在操作记录中。')
      setFile(null)
      if (input.current) input.current.value = ''
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '备份上传失败。')
    } finally {
      controller.current = null
      setBusy(false)
    }
  }

  return <Panel title="导入备份" icon={<Upload />}>
    <div className="backup-import">
      <p>选择从 Dyson Control 下载的备份 ZIP。导入后可在备份列表中选择恢复。</p>
      <div className="backup-import-controls">
        <label className="backup-file"><span>备份文件</span><input ref={input} type="file" accept=".zip,application/zip" disabled={busy} onChange={(event) => {
          setFile(event.target.files?.[0] ?? null)
          requestId.current = crypto.randomUUID()
          setError(null)
          setMessage(null)
        }} /></label>
        <Button icon={<Upload />} disabled={!file} busy={busy} onClick={() => void submit()}>上传并导入</Button>
        {busy && <Button onClick={() => controller.current?.abort()}>取消上传</Button>}
      </div>
      {file && <small>{file.name} · {formatBytes(file.size)}</small>}
      {busy && <div className="upload-progress" role="status"><progress aria-label="备份上传进度" max={100} value={progress} /><span>{progress === 100 ? '上传完成，正在接收…' : `已上传 ${progress}%`}</span></div>}
      {error && <p className="text-danger" role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
    </div>
  </Panel>
}
