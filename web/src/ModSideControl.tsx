import type { Mod } from '../../shared/contracts'
import type { RunAction } from './App'

export function ModSideControl({ mod, runAction }: { mod: Mod; runAction: RunAction }) {
  if (mod.sideSource === 'builtin') return null
  return <label className="mod-side-control">适用端
    <select aria-label={`${mod.name} 适用端`} value={mod.side} onChange={event => runAction('set-mod-side', {
      modId: mod.id, expectedVersion: mod.version, side: event.target.value,
    }, { title: `确认 ${mod.name} 的适用端？`, description: '请依据该版本作者的说明选择。客户端包将包含“两端使用”和“仅客户端”的已启用模组；此设置不移动或停用服务器文件。', label: '保存适用端' })}>
      {mod.side === 'unknown' && <option value="unknown" disabled>待确认</option>}
      <option value="both">两端使用</option><option value="server">仅服务器</option><option value="client">仅客户端</option>
    </select>
    <small>{mod.sideSource === 'administrator' ? '管理员确认' : mod.side === 'unknown' ? '生成客户端包前需确认' : ''}</small>
  </label>
}
