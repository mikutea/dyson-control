import { Lock, Unlock } from 'lucide-react'
import type { VersionLock } from '../../shared/contracts'
import type { RunAction } from './App'
import { Button } from './components'

export function VersionLockButton({ packageId, component, modId, currentVersion, locks, disabled, runAction }: {
  packageId: string; component?: 'game' | 'nebula' | 'bepinex'; modId?: string; currentVersion: string
  locks: VersionLock[] | null; disabled?: boolean; runAction: RunAction
}) {
  const lock = locks?.find(item => item.package === packageId.toLowerCase())
  return <div className="version-lock-control">
    {lock && <small>已锁定 {lock.version}</small>}
    <Button variant="quiet" icon={lock ? <Unlock /> : <Lock />} disabled={!locks || (!lock && (disabled || currentVersion === 'unknown'))}
      onClick={() => runAction('set-version-lock', { ...(component ? { component } : { modId }), locked: !lock }, {
        title: lock ? '解除版本锁定？' : '锁定当前版本？',
        description: lock ? '后续更新和依赖安装可以更改此版本。' : '安装、依赖更新和回滚若会更改此版本，将停止操作。需要更新时可先解除锁定。',
        label: lock ? '解除锁定' : '锁定版本',
      })}>{lock ? '解除锁定' : '锁定版本'}</Button>
  </div>
}
