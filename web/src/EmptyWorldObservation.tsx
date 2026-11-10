import type { EmptyWorldInterval, EmptyWorldObservation as Observation } from '../../shared/contracts'
import { formatFullDate } from './format'
import './empty-world.css'

const reasons: Record<Observation['reason'], string> = {
  observing: '', waiting: '等待新的空服采样。', 'players-online': '最近采样时有玩家在线。',
  'roster-unavailable': '无法确认当前在线人数。', 'clock-unavailable': '缺少同一进程的新鲜签名数据。世界暂停或 Bridge 尚未就绪时也会出现这种情况。',
  'server-not-running': '尚未确认游戏正在运行。', operation: '管理操作中断了观测，正在等待新的空服样本。',
  gap: '采样已经中断，需要新的连续读数。', 'monitor-unavailable': '监控暂时无法读取服务器状态。', demo: '演示环境不提供 Windows Bridge 的签名观测。',
}
const labels: Record<EmptyWorldInterval['status'], string> = { sampling: '仍在采样', advancing: '有进展', stalled: '至少一分钟未推进' }

function elapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分 ${seconds % 60} 秒`
}

function Interval({ value, label }: { value: EmptyWorldInterval; label: string }) {
  return <div className="world-interval" data-state={value.status}>
    <div className="world-interval-title"><strong>{label}</strong><span>{labels[value.status]}</span></div>
    <dl className="world-clock-points">
      <div><dt>起始 tick</dt><dd>{value.firstTick.toLocaleString('zh-CN')}</dd><small>{formatFullDate(value.startedAt)}</small></div>
      <div><dt>末次 tick</dt><dd>{value.lastTick.toLocaleString('zh-CN')}</dd><small>{formatFullDate(value.lastObservedAt)}</small></div>
    </dl>
    <p>跨度 {elapsed(value.durationMs)}，共 {value.samples} 个独立样本，世界时钟增加 <strong>{value.tickDelta.toLocaleString('zh-CN')}</strong> tick。</p>
    {value.status === 'stalled' && value.lastAdvanceAt && <p>上一次读到 tick 增长是在 {formatFullDate(value.lastAdvanceAt)}。</p>}
  </div>
}

export function EmptyWorldObservation({ data, stale }: { data?: Observation; stale: boolean }) {
  return <section className="world-observation" aria-label="空服世界推进">
    <h3>空服世界推进</h3>
    {data?.source === 'demo' ? <p>{reasons.demo}</p> : <>
      {data?.current ? <Interval value={data.current} label={stale ? '上次读取时的无人区间' : '当前观测的无人区间'} /> :
        <p>{data?.reason === 'waiting' || !data ? '等待签名采样。' : `当前不可判断。${reasons[data.reason]}`}</p>}
      {data?.previous && <details className="world-previous" open={!data.current}><summary>最近一次已结束的无人区间</summary>
        <Interval value={data.previous} label="已结束区间" /></details>}
      <p className="world-observation-note">仅统计在线人数采样均为零的时段。tick 衡量世界时钟，工厂产量需单独验证。</p>
    </>}
  </section>
}
