import { useState } from 'react'
import { Box, Download, FileArchive, RefreshCw } from 'lucide-react'
import type { ClientPackage, ClientPackageDetails } from '../../shared/contracts'
import type { RunAction } from './App'
import { Button, EmptyBlock, ErrorBlock, LoadingBlock, PageHeader, Panel } from './components'
import { formatBytes, formatFullDate } from './format'
import { useResource } from './hooks'
import './clients.css'

export function ClientsPage({ refreshToken, runAction, operationActive }: { refreshToken: number; runAction: RunAction; operationActive: boolean }) {
  const [selection, setSelection] = useState('')
  const [manualRefresh, setManualRefresh] = useState(0)
  const revision = refreshToken + manualRefresh
  const packages = useResource<ClientPackage[]>('/client-packages', revision)
  const selected = packages.data?.find(item => item.id === selection) ?? packages.data?.[0]
  return <>
    <PageHeader title="客户端" description="核对配置包内的连接地址和模组版本，再发给玩家。"
      actions={<Button variant="primary" icon={<Box />} disabled={operationActive} onClick={() => { setSelection(''); runAction('create-client-package') }}>创建客户端包</Button>} />
    <Panel title="已生成的客户端包" icon={<FileArchive />} action={<Button variant="quiet" icon={<RefreshCw />} onClick={() => setManualRefresh(value => value + 1)}>刷新</Button>}>
      {packages.error ? <ErrorBlock message={packages.error} retry={packages.reload} />
        : packages.loading ? <LoadingBlock />
        : !selected ? <EmptyBlock title="还没有客户端包" description="创建后即可核对配置并下载给玩家。" />
        : <>
          <div className="client-picker">
            <label>选择配置包<select value={selected.id} onChange={event => setSelection(event.target.value)}>
              {packages.data!.map(item => <option key={item.id} value={item.id}>{item.name} · {formatFullDate(item.createdAt)}</option>)}
            </select></label>
            <span>创建于 {formatFullDate(selected.createdAt)} · {selected.modCount} 个模组 · {formatBytes(selected.bytes)}</span>
          </div>
          <PackageDetails key={`${selected.id}-${revision}`} item={selected} />
        </>}
    </Panel>
    <p className="client-import-note">玩家可在 r2modman 配置选择页依次选择 <b>Import/Update → Import new profile → From file</b>，导入下载的 .r2z。模组下载完成后，用与服务器相同的游戏版本启动该配置并实际入服。</p>
  </>
}

const statusLabel = { current: '与当前配置一致', outdated: '与当前配置有差异', unknown: '配置匹配情况未知' }

function PackageDetails({ item }: { item: ClientPackage }) {
  const resource = useResource<ClientPackageDetails>(`/client-packages/${encodeURIComponent(item.id)}`)
  if (resource.error) return <ErrorBlock message={resource.error} retry={resource.reload} />
  const details = resource.data
  if (!details || resource.loading) return <LoadingBlock />
  const addressChanged = Boolean(details.profile && details.profile.address !== details.currentAddress)
  return <section className="client-detail" aria-label="所选配置包详情">
    <header className="client-detail-head">
      <div>
        <h3 className={`client-status client-status-${details.status}`}>{statusLabel[details.status]}</h3>
        {details.status === 'outdated' && <p>要分发当前配置，请创建新包。</p>}
        {details.reason && <p>{details.reason}</p>}
      </div>
      {details.downloadable && <a className="button button-primary" download href={item.downloadUrl}><Download /><span>下载所选包</span></a>}
    </header>
    <dl className={`client-address${addressChanged ? ' client-changed-address' : ''}`}>
      <div><dt>包内连接地址</dt><dd>{details.profile?.address ?? '未知'}</dd></div>
      <div><dt>当前连接地址</dt><dd>{details.currentAddress}</dd></div>
    </dl>
    {details.profile ? <ModComparison details={details} /> : <p className="client-unknown-mods">包内模组版本未知。</p>}
    {details.sha256 && <details className="client-digest"><summary>文件 SHA-256</summary><code>{details.sha256}</code></details>}
  </section>
}

function ModComparison({ details }: { details: ClientPackageDetails }) {
  const packed = new Map(details.profile!.mods.map(mod => [mod.name.toLowerCase(), mod]))
  const current = new Map(details.currentMods?.map(mod => [mod.name.toLowerCase(), mod]))
  const names = [...new Set([...packed.keys(), ...current.keys()])]
  const rows = names.map(name => {
    const before = packed.get(name)
    const after = current.get(name)
    let change = ''
    if (details.currentMods) {
      if (!before) change = '包内缺少'
      else if (!after) change = '当前不再需要'
      else if (before.version !== after.version) change = '版本已变'
    }
    return { name: (before ?? after)!.name, before: before?.version ?? '未收录', after: after?.version ?? (details.currentMods ? '无需安装' : '未知'), change }
  }).sort((a, b) => Number(Boolean(b.change)) - Number(Boolean(a.change)) || a.name.localeCompare(b.name))
  return <table className="client-mods" aria-label="包内模组版本与当前配置对照">
    <colgroup><col /><col /><col /></colgroup>
    <thead><tr><th scope="col">模组</th><th scope="col">包内版本</th><th scope="col">当前所需版本</th></tr></thead>
    <tbody>{rows.map(row => <tr key={row.name} className={row.change ? 'client-mod-changed' : undefined}>
      <th scope="row">{row.name}{row.change && <small>{row.change}</small>}</th>
      <td>{row.before}</td><td>{row.after}</td>
    </tr>)}</tbody>
  </table>
}
