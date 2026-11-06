import { useState } from 'react'
import { Download, RotateCw } from 'lucide-react'
import type { RuntimeHistoryWindow, RuntimeSample } from '../../shared/contracts'
import { Button, EmptyBlock, ErrorBlock, LoadingBlock } from './components'
import { formatBytes, formatDate, formatFullDate, serverStateLabels } from './format'
import { useResource } from './hooks'
import './runtime-trend.css'

const metrics = {
  ups: 'UPS', tps: 'TPS', cpuPercent: 'CPU', memoryBytes: '进程内存', diskFreeBytes: '可用磁盘',
  networkReceiveBytesPerSecond: '网络接收', networkSendBytesPerSecond: '网络发送', playerCount: '在线玩家',
}
type Metric = keyof typeof metrics
const metricKeys = Object.keys(metrics) as Metric[]

function metricValue(metric: Metric, value: number | null | undefined): string {
  if (value == null) return '—'
  switch (metric) {
    case 'memoryBytes': case 'diskFreeBytes': return formatBytes(value)
    case 'networkReceiveBytesPerSecond': case 'networkSendBytesPerSecond': return `${formatBytes(value)}/s`
    case 'cpuPercent': return `${value.toFixed(1)}%`
    case 'playerCount': return String(value)
    default: return value.toFixed(1)
  }
}

function Trend({ history, metric }: { history: RuntimeHistoryWindow; metric: Metric }) {
  const from = Date.parse(history.from), until = Date.parse(history.to)
  const values = history.samples.map(row => row[metric]).filter((value): value is number => value != null)
  if (!values.length) return <EmptyBlock title={`${metrics[metric]} 暂无读数`} description="可切换指标，或从下方表格查看同期其他读数。" />
  const maximum = Math.max(1, ...values)
  const runs: Array<Array<{ x: number; y: number }>> = []
  let previous: RuntimeSample | null = null
  let previousBucket = -1
  for (const sample of history.samples) {
    const value = sample[metric]
    if (value == null) { previous = null; continue }
    const offset = Date.parse(sample.sampledAt) - from
    const bucket = Math.floor(offset / history.bucketMs)
    if (!previous || previous.pid !== sample.pid || previous.state !== sample.state || bucket > previousBucket + 1) runs.push([])
    runs[runs.length - 1].push({ x: offset * 1000 / (until - from), y: 100 - Math.max(0, value) * 100 / maximum })
    previous = sample; previousBucket = bucket
  }
  const path = runs.filter(run => run.length > 1).map(run =>
    run.map(({ x, y }, index) => `${index === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`).join(' ')).join(' ')
  return <figure className="runtime-trend">
    <figcaption><strong>{metrics[metric]} 趋势</strong><span>最近读数 {metricValue(metric, history.samples.at(-1)?.[metric])}</span></figcaption>
    <div className="runtime-plot"><div className="runtime-scale" aria-hidden="true"><span>{metricValue(metric, maximum)}</span><span>{metricValue(metric, 0)}</span></div>
      <svg viewBox="0 -4 1000 108" preserveAspectRatio="none" role="img" aria-label={`${metrics[metric]}，${values.length} 个有效展示点，最低 ${metricValue(metric, Math.min(...values))}，最高 ${metricValue(metric, Math.max(...values))}。缺失区间留空。`}>
        {[0, 50, 100].map(y => <line className="runtime-grid" key={y} x1="0" x2="1000" y1={y} y2={y} vectorEffect="non-scaling-stroke" />)}
        <path className="runtime-trace" d={path} vectorEffect="non-scaling-stroke" />
        {runs.filter(run => run.length === 1).map(([point]) => <ellipse className="runtime-point" key={point.x} cx={point.x} cy={point.y} rx="1.4" ry="1.4" />)}
      </svg></div>
    <div className="runtime-axis"><time dateTime={history.from}>{formatDate(history.from)}</time><time dateTime={history.to}>{formatDate(history.to)}</time></div>
  </figure>
}

const pageSize = 20

function HistoryWindow({ hours, metric, refreshToken }: { hours: number; metric: Metric; refreshToken: number }) {
  const history = useResource<RuntimeHistoryWindow>(`/runtime/history/trend?hours=${hours}`, refreshToken)
  const [page, setPage] = useState(0)
  if (!history.data) return history.error ? <ErrorBlock message={history.error} retry={history.reload} /> : <LoadingBlock />
  const data = history.data
  const pages = Math.max(1, Math.ceil(data.samples.length / pageSize))
  const index = Math.min(page, pages - 1)
  const end = data.samples.length - index * pageSize
  const rows = data.samples.slice(Math.max(0, end - pageSize), end).reverse()
  return <>
    {history.error && <p className="runtime-notice" role="status">刷新失败，保留上次读数。{history.error}</p>}
    {!rows.length ? <EmptyBlock title="所选时间内没有运行采样" description="可以选择更长的时间范围，或在后台采样后刷新。" /> : <>
      <Trend history={data} metric={metric} />
      <div className="runtime-history-scroll" role="region" aria-label="运行采样明细" tabIndex={0}><table><caption>每个时间段取最后一次采样，空值显示为 —。网络为主机活动物理网卡合计。</caption><thead><tr><th>时间</th><th>状态</th>{metricKeys.map(key => <th key={key}>{metrics[key]}</th>)}</tr></thead>
        <tbody>{rows.map(row => <tr key={row.sampledAt}><td>{formatFullDate(row.sampledAt)}</td><td>{serverStateLabels[row.state]}</td>{metricKeys.map(key => <td key={key}>{metricValue(key, row[key])}</td>)}</tr>)}</tbody></table></div>
      {pages > 1 && <nav className="runtime-pager" aria-label="采样翻页">
        <Button type="button" disabled={index === 0} onClick={() => setPage(index - 1)}>较新采样</Button><span>{index + 1} / {pages}</span>
        <Button type="button" disabled={index === pages - 1} onClick={() => setPage(index + 1)}>较早采样</Button></nav>}
    </>}
  </>
}

export function RuntimeHistory({ refreshToken }: { refreshToken: number }) {
  const [hours, setHours] = useState(24)
  const [metric, setMetric] = useState<Metric>('ups')
  const [revision, setRevision] = useState(0)
  return <>
    <div className="runtime-history-controls">
      <label className="runtime-period">时间范围<select aria-label="时间范围" value={hours} onChange={event => setHours(Number(event.target.value))}><option value={1}>最近一小时</option><option value={24}>最近一天</option><option value={168}>最近一周</option></select></label>
      <label className="runtime-period">指标<select aria-label="运行指标" value={metric} onChange={event => setMetric(event.target.value as Metric)}>{metricKeys.map(key => <option key={key} value={key}>{metrics[key]}</option>)}</select></label>
      <Button type="button" icon={<RotateCw />} onClick={() => setRevision(value => value + 1)}>刷新采样</Button>
      <a className="button button-secondary" href={`/api/runtime/history/download?hours=${hours}`} download><Download aria-hidden="true" />原始 CSV</a>
    </div>
    <HistoryWindow key={hours} hours={hours} metric={metric} refreshToken={refreshToken + revision} />
  </>
}
