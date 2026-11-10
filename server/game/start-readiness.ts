import type { RecoveryStartReadiness } from '../../shared/contracts.js'

export const startReadinessMessages: Record<RecoveryStartReadiness, string> = {
  ready: '已确认受管启动任务和游戏用户的桌面 Steam 会话，可以尝试启动。',
  'game-present': '检查时发现受管游戏进程，请查看服务器当前状态。',
  'task-unavailable': '受管启动任务未就绪。请检查任务名称是否唯一、大小写是否匹配，再核对启用状态、运行身份和启动配置。',
  'steam-missing': '等待游戏用户登录 Windows，并在交互会话中打开桌面 Steam。',
  'steam-other-user': '检测到其他 Windows 用户的 Steam，请在运行游戏的用户会话中打开桌面 Steam。',
  'session-ambiguous': '游戏用户在多个 Windows 会话中运行 Steam，暂时无法确定启动任务会使用哪个会话。',
  unknown: '未能确认 Windows 任务或桌面 Steam 会话，请检查面板服务的读取权限。',
}
