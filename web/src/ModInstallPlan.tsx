import { useState } from 'react'
import type { ModPlanEntry } from '../../shared/contracts'
import { ErrorBlock, LoadingBlock } from './components'
import { useResource } from './hooks'
import { formatBytes } from './format'
import './mod-install-plan.css'

function PlanRows({ packageName, version }: { packageName: string; version: string }) {
  const plan = useResource<ModPlanEntry[]>(`/mod-catalog/plan?package=${encodeURIComponent(packageName)}&version=${encodeURIComponent(version)}`)
  if (plan.error) return <ErrorBlock message={plan.error} retry={plan.reload} />
  if (!plan.data) return <LoadingBlock rows={2} />
  return <ul className="mod-plan-rows">{plan.data.map(row => <li key={row.package}>
    <strong>{row.package}</strong><span>{row.installedVersion ? `已记录 ${row.installedVersion}` : '安装版本未记录'} → {row.version}{row.downloadBytes !== null && ` · ${formatBytes(row.downloadBytes)}`}</span>
    {row.lockedVersion && <small className={row.lockedVersion !== row.version ? 'mod-plan-conflict' : ''}>{row.lockedVersion === row.version
      ? `已锁定此版本` : `锁定在 ${row.lockedVersion}，当前计划无法安装。`}</small>}
  </li>)}</ul>
}

export function ModInstallPlan({ packageName, version }: { packageName: string; version: string }) {
  const [open, setOpen] = useState(false)
  return <details className="mod-install-plan" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>查看安装包与依赖版本</summary>
    {open && <PlanRows key={packageName + '@' + version} packageName={packageName} version={version} />}
  </details>
}
