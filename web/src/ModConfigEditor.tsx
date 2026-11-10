import { useEffect, useState } from 'react'
import { FileText, RotateCcw, Save } from 'lucide-react'
import type { ModConfigFile, ModConfigHistoryEntry, ModConfigRollbackPreview } from '../../shared/contracts'
import type { RunAction } from './App'
import { Button, ConfirmDialog, EmptyBlock, ErrorBlock, LoadingBlock, Panel } from './components'
import { formatBytes, formatFullDate } from './format'
import { useResource } from './hooks'
import './mod-config-preview.css'

export function ModConfigEditor({ refreshToken, runAction }: { refreshToken: number; runAction: RunAction }) {
  const configs = useResource<ModConfigFile[]>('/mod-configs', refreshToken)
  const [editor, setEditor] = useState<{ file: ModConfigFile; draft: string } | null>(null)
  const file = editor?.file ?? null
  const draft = editor?.draft ?? ''
  const dirty = Boolean(file && draft !== file.content)
  const current = configs.data?.find(item => item.id === file?.id) ?? null
  useEffect(() => {
    const files = configs.data
    if (!files) return
    setEditor(previous => {
      const next = files.find(item => item.id === previous?.file.id)
      if (previous && previous.draft !== previous.file.content && next?.content !== previous.draft) return previous
      const selected = next ?? files[0]
      return selected ? { file: selected, draft: selected.content } : null
    })
  }, [configs.data, dirty])
  const select = (id: string) => {
    const next = configs.data?.find(item => item.id === id)
    setEditor(next ? { file: next, draft: next.content } : null)
  }
  return <Panel title="模组配置" icon={<FileText />} action={<Button onClick={() => void configs.reload()}>刷新配置</Button>}>
    {configs.loading && !configs.data ? <LoadingBlock /> : configs.error ? <ErrorBlock message={configs.error} retry={configs.reload} /> : !file ? <EmptyBlock title="没有可编辑的模组配置" description="模组生成 .cfg 配置后会显示在这里。Bridge 连接配置由安装工具管理。" /> : <div className="mod-config-editor">
      <label className="field"><span>配置文件</span><select value={file.id} disabled={dirty} onChange={event => select(event.target.value)}>{!current && <option value={file.id}>{file.path} · 当前不可用</option>}{configs.data?.map(item => <option key={item.id} value={item.id}>{item.path}</option>)}</select><small>{formatBytes(file.bytes)} · 修改于 {formatFullDate(file.modifiedAt)}</small></label>
      {file.redactedKeys.length > 0 && <p className="config-hint">{file.redactedKeys.length} 个密码或密钥字段已隐藏。保留 [REDACTED] 占位文本，保存和恢复时会沿用当前密钥。</p>}
      {!current ? <p className="runtime-notice" role="status">原配置文件已不存在或暂不可用。草稿仍保留；文件重新出现前无法保存，请先核对文件。</p> : current.revision !== file.revision && dirty && <p className="runtime-notice" role="status">服务器上的配置已变化。当前草稿仍保留；撤销更改可重新载入最新版本。</p>}
      <label className="field"><span>配置内容</span><textarea aria-label="配置内容" value={draft} onChange={event => setEditor({ file, draft: event.target.value })} rows={16} spellCheck={false} maxLength={256 * 1024} /></label>
      {dirty && <details className="config-diff"><summary>查看本次更改</summary><div><section><h3>原内容</h3><pre>{file.content}</pre></section><section><h3>修改后</h3><pre>{draft}</pre></section></div></details>}
      <div className="settings-actions"><Button disabled={!dirty} onClick={() => select(current?.id ?? configs.data?.[0]?.id ?? '')}>{current ? '撤销配置更改' : '放弃草稿并重新选择'}</Button><Button variant="primary" disabled={!dirty || !current || current.revision !== file.revision} icon={<Save />} onClick={() => {
        if (!current || current.id !== file.id || current.revision !== file.revision) return
        runAction('write-mod-config', { configId: file.id, content: draft, expectedRevision: file.revision }, { title: `保存 ${file.path}？`, description: '运行中的游戏会先保存并备份，再停服应用配置和重新启动。原配置会保存在历史记录中。', label: '保存模组配置', danger: true })
      }}>保存模组配置</Button></div>
      {current && <ConfigHistory key={file.id} config={current} refreshToken={refreshToken} dirty={dirty} runAction={runAction} />}
    </div>}
  </Panel>
}

function ConfigHistory({ config, refreshToken, dirty, runAction }: { config: ModConfigFile; refreshToken: number; dirty: boolean; runAction: RunAction }) {
  const history = useResource<ModConfigHistoryEntry[]>(`/mod-config-history?configId=${encodeURIComponent(config.id)}`, refreshToken)
  const [selected, setSelected] = useState<ModConfigHistoryEntry | null>(null)
  return <div className="config-history"><h3>配置历史</h3>
    {history.loading && !history.data ? <LoadingBlock rows={2} /> : history.error ? <ErrorBlock message={history.error} retry={history.reload} /> : !history.data?.length ? <p className="config-hint">首次修改后，原配置会保留在这里。</p> : <ul>{history.data.map(item => <li key={item.id}><div><strong>{item.operation === 'write' ? '保存前的配置' : '恢复前的配置'}</strong><small>{formatFullDate(item.createdAt)} · {formatBytes(item.bytes)}</small></div><Button icon={<RotateCcw />} disabled={dirty || !item.canRollback} onClick={() => setSelected(item)}>预览恢复</Button></li>)}</ul>}
    {selected && <RollbackDialog key={selected.id} entry={selected} onClose={() => setSelected(null)} runAction={runAction} />}
  </div>
}

function withLineEndings(text: string): string {
  const markers: Record<string, string> = { '\r\n': 'CRLF', '\r': 'CR', '\n': 'LF' }
  const marked = text.replace(/\r\n|\r|\n/g, eol => ` ⟨${markers[eol]}⟩\n`)
  return /[\r\n]$/.test(text) ? marked : `${marked} ⟨无换行⟩`
}

function RollbackDialog({ entry, onClose, runAction }: { entry: ModConfigHistoryEntry; onClose: () => void; runAction: RunAction }) {
  const preview = useResource<ModConfigRollbackPreview>(`/mod-config-history/${encodeURIComponent(entry.id)}/rollback-preview`)
  const [showEndings, setShowEndings] = useState(false)
  const result = preview.data
  const canRestore = Boolean(result?.changes.length && !preview.error)
  const confirm = () => {
    if (!canRestore || !result) return
    runAction('rollback-mod-config', { historyId: result.historyId, expectedRevision: result.expectedRevision })
    onClose()
  }
  return <ConfirmDialog title="恢复此版本的模组配置？" description={`${entry.path} · ${formatFullDate(entry.createdAt)}。当前配置会先存入历史。游戏运行时会先保存、备份并停服，在线玩家将断开连接，恢复完成后重新启动。`}
    confirmLabel="恢复模组配置" danger confirmDisabled={!canRestore} onCancel={onClose} onConfirm={confirm}>
    <div className="mod-rollback-preview">
      {preview.error ? <ErrorBlock message={preview.error} retry={preview.reload} /> : !result ? <LoadingBlock rows={3} /> : <>
        {result.preservedSecretKeys.length > 0 && <p>沿用当前密钥：{result.preservedSecretKeys.join('、')}。</p>}
        {result.changes.length === 0 ? <p role="status">当前配置与所选版本一致。</p> : <>
          <label className="rollback-line-endings"><input type="checkbox" checked={showEndings} onChange={e => setShowEndings(e.target.checked)} /> 显示换行符</label>
          <div className="rollback-lines" aria-label="配置行差异" role="list" tabIndex={0}>
            {result.changes.map(change => <section role="listitem" key={change.side + change.startLine} className={`rollback-${change.side}`}>
              <h3>{change.side === 'current' ? '当前配置' : '恢复后'} · 第 {change.startLine}{change.lineCount > 1 && `–${change.startLine + change.lineCount - 1}`} 行</h3>
              <pre>{showEndings ? withLineEndings(change.text) : change.text}</pre>
            </section>)}
          </div>
        </>}
      </>}
    </div>
  </ConfirmDialog>
}
