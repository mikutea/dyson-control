import { CloudDownload, PackageCheck } from 'lucide-react'
import type { ComponentVersion, VersionLock } from '../../shared/contracts'
import type { RunAction } from './App'
import { Button } from './components'
import { formatDate } from './format'
import { VersionLockButton } from './VersionLockButton'

export function ComponentVersionCard({ component, locks, runAction }: {
  component: ComponentVersion; locks: VersionLock[] | null; runAction: RunAction
}) {
  const knownPackage = component.current !== 'unknown'
  const update = Boolean(knownPackage && component.latest && component.latest !== component.current)
  const packageId = component.id === 'game' ? 'steam:1366540' : component.id === 'nebula' ? 'nebula-NebulaMultiplayerMod' : 'xiaoye97-BepInEx'
  const installLabel = knownPackage ? '安装更新' : '安装最新版本'
  return <article>
    <div className="version-icon"><PackageCheck /></div>
    <div className="version-copy">
      <div><h2>{component.name}</h2>{update
        ? <span className="update-label">可更新</span>
        : <span className="quiet-label">{!knownPackage ? '版本待核验' : component.latest ? '已是最新版本' : '未检查更新'}</span>}</div>
      <p>{component.note}</p>
      {!knownPackage && component.runtimeVersion && <p>已读取当前运行版本；安装包版本尚未记录，暂时无法比较更新或锁定版本。</p>}
      <dl>
        {component.id !== 'game' && <div><dt>当前运行版本</dt><dd>{component.runtimeVersion || '未核验'}</dd></div>}
        <div><dt>{component.id === 'game' ? '当前版本' : '安装包版本'}</dt><dd>{knownPackage ? component.current : '未记录'}</dd></div>
        <div><dt>最新版本</dt><dd>{component.latest || '尚未检查'}</dd></div>
        <div><dt>更新通道</dt><dd>{component.channel}</dd></div>
        <div><dt>检查时间</dt><dd>{formatDate(component.checkedAt)}</dd></div>
      </dl>
    </div>
    <div className="version-action">
      <VersionLockButton packageId={packageId} component={component.id} currentVersion={component.current} locks={locks}
        disabled={component.id === 'game' && !component.canInstall} runAction={runAction} />
      {component.canInstall && component.latest && (!knownPackage || update) && <Button variant="primary" icon={<CloudDownload />} onClick={() => runAction('install-update', {
        component: component.id, version: component.latest
      }, {
        title: `${installLabel}：${component.name}？`,
        description: `${knownPackage ? '' : '尚未核实已安装的包版本。'}安装期间服务器可能会重新启动，在线玩家会暂时断开。`,
        label: installLabel, danger: true
      })}>{installLabel}</Button>}
    </div>
  </article>
}
