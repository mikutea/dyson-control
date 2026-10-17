import { useEffect, useState } from 'react'
import { FileText, RotateCcw, Save } from 'lucide-react'
import type { ModConfigFile, ModConfigHistoryEntry } from '../../shared/contracts'
import type { RunAction } from './App'
import { Button, EmptyBlock, ErrorBlock, LoadingBlock, Panel } from './components'
import { formatBytes, formatFullDate } from './format'
import { useResource } from './hooks'

export function ModConfigEditor({ refreshToken, runAction }: { refreshToken: number; runAction: RunAction }) {
  const configs = useResource<ModConfigFile[]>('/mod-configs', refreshToken)
  const [selected, setSelected] = useState('')
  const [draft, setDraft] = useState('')
  const [baseRevision, setBaseRevision] = useState('')
  const [baseContent, setBaseContent] = useState('')
  const dirty = draft !== baseContent
  const file = configs.data?.find(item => item.id === selected) ?? configs.data?.[0] ?? null
  useEffect(() => {
    if (!file || (dirty && file.content !== draft)) return
    setSelected(file.id); setDraft(file.content); setBaseContent(file.content); setBaseRevision(file.revision)
  }, [file, dirty, draft])
  const select = (id: string) => {
    const next = configs.data?.find(item => item.id === id)
    if (!next) return
    setSelected(id); setDraft(next.content); setBaseContent(next.content); setBaseRevision(next.revision)
  }
  return <Panel title="模组配置" icon={<FileText />}>
    {configs.loading && !configs.data ? <LoadingBlock /> : configs.error ? <ErrorBlock message={configs.error} retry={configs.reload} /> : !file ? <EmptyBlock title="没有可编辑的模组配置" description="模组生成 .cfg 配置后会显示在这里。Bridge 连接配置由安装工具管理。" /> : <div className="mod-config-editor">
      <label className="field"><span>配置文件</span><select value={file.id} disabled={dirty} onChange={event => select(event.target.value)}>{configs.data?.map(item => <option key={item.id} value={item.id}>{item.path}</option>)}</select><small>{formatBytes(file.bytes)} · 修改于 {formatFullDate(file.modifiedAt)}</small></label>
      {file.redactedKeys.length > 0 && <p className="config-hint">{file.redactedKeys.length} 个密码或密钥字段已隐藏。保留 [REDACTED] 占位文本，保存和恢复时会沿用当前密钥。</p>}
      {file.revision !== baseRevision && dirty && <p className="runtime-notice" role="status">服务器上的配置已变化。当前草稿仍保留；撤销更改可重新载入最新版本。</p>}
      <label className="field"><span>配置内容</span><textarea aria-label="配置内容" value={draft} onChange={event => setDraft(event.target.value)} rows={16} spellCheck={false} maxLength={256 * 1024} /></label>
      {dirty && <details className="config-diff"><summary>查看本次更改</summary><div><section><h3>原内容</h3><pre>{baseContent}</pre></section><section><h3>修改后</h3><pre>{draft}</pre></section></div></details>}
      <div className="settings-actions"><Button disabled={!dirty} onClick={() => select(file.id)}>撤销配置更改</Button><Button variant="primary" disabled={!dirty || file.revision !== baseRevision} icon={<Save />} onClick={() => runAction('write-mod-config', { configId: file.id, content: draft, expectedRevision: baseRevision }, { title: `保存 ${file.path}？`, description: '运行中的游戏会先保存并备份，再停服应用配置和重新启动。原配置会保存在历史记录中。', label: '保存模组配置', danger: true })}>保存模组配置</Button></div>
      <ConfigHistory config={file} refreshToken={refreshToken} dirty={dirty} runAction={runAction} />
    </div>}
  </Panel>
}

function ConfigHistory({ config, refreshToken, dirty, runAction }: { config: ModConfigFile; refreshToken: number; dirty: boolean; runAction: RunAction }) {
  const history = useResource<ModConfigHistoryEntry[]>(`/mod-config-history?configId=${encodeURIComponent(config.id)}`, refreshToken)
  return <div className="config-history"><h3>配置历史</h3>
    {history.loading && !history.data ? <LoadingBlock rows={2} /> : history.error ? <ErrorBlock message={history.error} retry={history.reload} /> : !history.data?.length ? <p className="config-hint">首次修改后，原配置会保留在这里。</p> : <ul>{history.data.map(item => <li key={item.id}><div><strong>{item.operation === 'write' ? '保存前的配置' : '恢复前的配置'}</strong><small>{formatFullDate(item.createdAt)} · {formatBytes(item.bytes)}</small></div><Button icon={<RotateCcw />} disabled={dirty || !item.canRollback} onClick={() => runAction('rollback-mod-config', { historyId: item.id, expectedRevision: config.revision }, { title: '恢复此版本的模组配置？', description: '当前配置会先备份。运行中的游戏会保存并重新启动，当前密码和密钥保持不变。', label: '恢复模组配置', danger: true })}>恢复此配置</Button></li>)}</ul>}
  </div>
}
