import type { Action, Job, JobState, ServerState } from '../../shared/contracts'

export const actionLabels: Record<Action, string> = {
  'prepare-steamcmd': '准备 SteamCMD',
  'install-server': '首次安装服务器',
  start: '启动服务器',
  save: '保存游戏',
  stop: '停止服务器',
  restart: '重新启动',
  'load-save': '加载存档',
  backup: '创建备份',
  'verify-backup': '校验备份',
  restore: '恢复备份',
  'import-backup': '导入备份',
  'install-update': '安装更新',
  'set-version-lock': '设置版本锁定',
  'set-mod-side': '设置模组适用端',
  'install-mod': '安装模组',
  'rollback-update': '回滚更新',
  'toggle-mod': '更改模组',
  'remove-mod': '移除模组',
  'restore-removed-mod': '恢复已移除模组',
  'write-mod-config': '保存模组配置',
  'rollback-mod-config': '恢复模组配置',
  'write-settings': '保存设置',
  'rollback-settings': '恢复服务器设置',
  'create-client-package': '创建客户端包',
  'kick-player': '断开玩家连接',
}

export const jobStateLabels: Record<JobState, string> = {
  queued: '等待执行',
  running: '正在执行',
  succeeded: '已完成',
  failed: '未完成',
  interrupted: '已中断',
}

export const serverStateLabels: Record<ServerState, string> = {
  running: '服务器运行中',
  stopped: '服务器已停止',
  starting: '服务器正在启动',
  stopping: '服务器正在停止',
  unknown: '服务器状态未知',
}

export function formatBytes(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let number = value
  let unit = 0
  while (number >= 1024 && unit < units.length - 1) {
    number /= 1024
    unit += 1
  }
  return `${number >= 10 || unit === 0 ? number.toFixed(0) : number.toFixed(1)} ${units[unit]}`
}

export function formatDate(value: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date)
}

export function formatFullDate(value: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(date)
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 1) return '不到 1 分钟'
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (days) return `${days} 天 ${hours} 小时`
  if (hours) return `${hours} 小时 ${minutes} 分钟`
  return `${minutes} 分钟`
}

export function percent(value: number | null, total: number | null): number | null {
  if (value === null || total === null || total <= 0) return null
  return Math.max(0, Math.min(100, (value / total) * 100))
}

export function formatJobResult(job: Job): string | null {
  if (job.state !== 'succeeded' || !job.result) return null
  const text = (key: string) => typeof job.result?.[key] === 'string' ? String(job.result[key]) : null
  switch (job.action) {
    case 'prepare-steamcmd': return 'SteamCMD 已就绪，可继续授权'
    case 'install-server': return '服务器安装完成，等待手动首次启动'
    case 'start': return '服务器已启动'
    case 'load-save': return text('saveName') ? `已从存档 ${text('saveName')} 启动服务器` : '已加载所选存档'
    case 'stop': return '服务器已安全停止'
    case 'restart': return '服务器已重新启动'
    case 'kick-player': return '玩家已离线，游戏已完成连接清理'
    case 'save': return text('saveName') ? `存档 ${text('saveName')} 已保存` : '游戏已保存'
    case 'backup': return text('saveName') ? `${text('saveName')} 已完整备份` : '备份已创建'
    case 'verify-backup': return text('saveName') ? `${text('saveName')} 备份完整性校验通过` : '备份完整性校验通过'
    case 'restore': return text('saveName') ? `${text('saveName')} 已恢复` : '备份已恢复'
    case 'import-backup': return text('saveName') ? `${text('saveName')} 已导入，可在存档页面恢复` : '备份已导入，可在存档页面恢复'
    case 'install-update': return text('version') ? `已更新至 ${text('version')}` : '更新已安装'
    case 'install-mod': return text('package') ? `${text('package')} 已安装` : '模组已安装'
    case 'rollback-update': return '已恢复更新前的组件和模组版本'
    case 'toggle-mod': return job.result.enabled === true ? '模组已启用' : '模组已停用'
    case 'remove-mod': return '模组已移除，恢复副本已保存'
    case 'restore-removed-mod': return '模组已恢复'
    case 'rollback-settings': return '服务器设置已恢复'
    case 'set-version-lock': return job.result.locked === true ? '当前版本已锁定' : '版本锁定已解除'
    case 'set-mod-side': return '已保存当前模组版本的适用端'
    case 'write-mod-config': return text('path') ? `${text('path')} 已保存` : '模组配置已保存'
    case 'rollback-mod-config': return '模组配置已恢复，当前密钥保持不变'
    case 'write-settings': return '服务器设置已保存'
    case 'create-client-package': {
      const fileName = text('fileName')
      const count = typeof job.result.modCount === 'number' ? job.result.modCount : null
      return fileName ? `${fileName}${count === null ? ' 已创建' : ` 已创建，包含 ${count} 个模组`}` : '客户端包已创建'
    }
  }
}
