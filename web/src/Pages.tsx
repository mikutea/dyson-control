import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  Activity, Archive, Box, CheckCircle2, CircleGauge, Clock3, CloudDownload, Cpu, Database,
  Download, FileArchive, Gamepad2, HardDrive, MemoryStick, PackageCheck, Play, Power,
  RefreshCw, RotateCcw, Save as SaveIcon, Server as ServerIcon, Settings2, ShieldCheck,
  Square, TimerReset, UserRound, Users, Wifi,
} from 'lucide-react'
import type {
  Backup, ClientPackage, ComponentVersion, GameSettings, Job, LogEntry, Mod, Overview,
  Page, Player, Save, VersionLock,
} from '../../shared/contracts'
import type { RunAction } from './App'
import { Button, EmptyBlock, ErrorBlock, LoadingBlock, MetricBar, PageHeader, Panel, StatusDot } from './components'
import { actionLabels, formatBytes, formatDate, formatDuration, formatFullDate, formatJobResult, jobStateLabels, percent, serverStateLabels } from './format'
import { useResource } from './hooks'
import { BackupImport } from './BackupImport'
import { ModCatalog } from './ModCatalog'
import { UpdateHistory } from './UpdateHistory'
import { RuntimeSettingsPanel, RuntimeStatusPanel } from './RuntimePanel'
import { ModConfigEditor } from './ModConfigEditor'
import { PlayerHistory } from './PlayerHistory'
import { ModRemovalHistory } from './ModRemovalHistory'
import { SettingsHistory } from './SettingsHistory'
import { VersionLockButton } from './VersionLockButton'
import { ModSideControl } from './ModSideControl'
import { ControlUpdates } from './ControlUpdates'
import { ComponentVersionCard } from './ComponentVersionCard'

interface PagesProps { page: Page; refreshToken: number; overview: Overview | null; onOverview: (overview: Overview) => void; runAction: RunAction; onJob: (job: Job) => void }

export function Pages(props: PagesProps) {
  switch (props.page) {
    case 'overview': return <OverviewPage {...props} />
    case 'players': return <PlayersPage {...props} />
    case 'versions': return <VersionsPage {...props} />
    case 'mods': return <ModsPage {...props} />
    case 'saves': return <SavesPage {...props} />
    case 'clients': return <ClientsPage {...props} />
    case 'server': return <ServerPage {...props} />
    case 'settings': return <SettingsPage {...props} />
    case 'activity': return <ActivityPage {...props} />
  }
}

function OverviewPage({ refreshToken, overview: streamedOverview, onOverview, runAction }: PagesProps) {
  const overviewResource = useResource<Overview>('/overview', refreshToken)
  const logs = useResource<LogEntry[]>('/logs', refreshToken)
  const overview = streamedOverview || overviewResource.data

  useEffect(() => { if (overviewResource.data) onOverview(overviewResource.data) }, [overviewResource.data, onOverview])

  if (!overview && overviewResource.loading) return <><PageHeader title="概览" description="服务器的实时状态与运行情况" /><LoadingBlock rows={6} /></>
  if (!overview) return <><PageHeader title="概览" description="服务器的实时状态与运行情况" /><ErrorBlock message={overviewResource.error || '未收到服务器状态'} retry={overviewResource.reload} /></>

  const running = overview.state === 'running'
  const memory = percent(overview.metrics.memoryBytes, overview.metrics.totalMemoryBytes)
  const metrics = [
    { label: '在线玩家', value: overview.playerCount === null ? '—' : overview.maxPlayers === null ? `${overview.playerCount}` : `${overview.playerCount} / ${overview.maxPlayers}`, detail: overview.playerStatus === 'unavailable' ? '暂未取得在线状态' : '当前在线', icon: Users, bar: overview.playerCount === null || overview.maxPlayers === null ? null : (overview.playerCount / Math.max(overview.maxPlayers, 1)) * 100, tone: 'green' as const },
    { label: 'CPU', value: overview.metrics.cpuPercent === null ? '—' : `${overview.metrics.cpuPercent.toFixed(0)}%`, detail: '使用率', icon: Cpu, bar: overview.metrics.cpuPercent, tone: 'green' as const },
    { label: '内存', value: formatBytes(overview.metrics.memoryBytes), detail: overview.metrics.totalMemoryBytes ? `共 ${formatBytes(overview.metrics.totalMemoryBytes)}` : '暂无数据', icon: MemoryStick, bar: memory, tone: 'blue' as const },
    { label: '可用磁盘', value: formatBytes(overview.metrics.diskFreeBytes), detail: '剩余空间', icon: HardDrive, bar: null, tone: 'blue' as const },
    { label: 'UPS', value: overview.metrics.ups === null ? '—' : overview.metrics.ups.toFixed(1), detail: overview.metrics.tps === null ? '实际 TPS 暂不可用' : `实际 TPS ${overview.metrics.tps.toFixed(1)}`, icon: CircleGauge, bar: overview.metrics.ups === null ? null : (overview.metrics.ups / Math.max(overview.metrics.ups, 60)) * 100, tone: 'blue' as const },
    { label: '主机网络', value: overview.metrics.networkReceiveBytesPerSecond == null ? '—' : `↓ ${formatBytes(overview.metrics.networkReceiveBytesPerSecond)}/s`, detail: overview.metrics.networkSendBytesPerSecond == null ? '活动物理网卡合计' : `↑ ${formatBytes(overview.metrics.networkSendBytesPerSecond)}/s · 主机合计`, icon: Wifi, bar: null, tone: 'blue' as const },
  ]

  return (
    <>
      <PageHeader title="概览" description="服务器的实时状态与运行情况" />
      <section className={`server-hero state-${overview.state}`}>
        <div className="server-hero-status"><span className="hero-signal"><StatusDot state={running ? 'good' : overview.state === 'unknown' ? 'warning' : 'muted'} /></span><div><h2>{serverStateLabels[overview.state]}</h2><p>{running ? overview.playerCount === null ? '在线玩家状态暂不可用' : `${overview.playerCount} 位玩家在线` : '日常操作仍可从这里开始'}</p></div></div>
        <div className="server-hero-meta"><span>运行时间</span><strong>{running ? formatDuration(overview.uptimeSeconds) : '—'}</strong><small>{overview.address}</small></div>
        <div className="server-hero-actions">
          <Button icon={<SaveIcon />} disabled={!overview.capabilities.save || !running} onClick={() => runAction('save')}>保存游戏</Button>
          {running ? <Button variant="primary" icon={<RefreshCw />} disabled={!overview.capabilities.lifecycle} onClick={() => runAction('restart', {}, { title: '重新启动服务器？', description: '在线玩家会暂时断开。系统会先保存游戏，再重新启动服务器。', label: '重新启动', danger: true })}>重新启动</Button>
            : <Button variant="primary" icon={<Play />} disabled={!overview.capabilities.lifecycle} onClick={() => runAction('start')}>启动服务器</Button>}
        </div>
      </section>

      <section className="metrics-band">
        {metrics.map(({ label, value, detail, icon: Icon, bar, tone }) => <div className="metric" key={label}><Icon /><div><span>{label}</span><strong>{value}</strong><small>{detail}</small><MetricBar value={bar} tone={tone} /></div></div>)}
      </section>

      <div className="overview-grid">
        <div className="overview-stack">
          <Panel title="版本信息" icon={<PackageCheck />}>
            <DataRows rows={[
              ['游戏版本', overview.versions.game], ['Nebula', overview.versions.nebula], ['BepInEx', overview.versions.bepinex],
            ]} />
          </Panel>
          <Panel title="当前存档" icon={<FileArchive />}>
            <div className="save-highlight"><span><Database /></span><div><strong>{overview.currentSave || '未识别到存档'}</strong><p>{overview.lastSavedAt ? `最近保存于 ${formatFullDate(overview.lastSavedAt)}` : '暂无保存时间'}</p></div></div>
          </Panel>
        </div>
        <Panel title="最近活动" icon={<Activity />}>
          {logs.loading && !logs.data ? <LoadingBlock /> : logs.error && !logs.data ? <ErrorBlock message={logs.error} retry={logs.reload} /> : !logs.data?.length ? <EmptyBlock title="暂时没有活动" description="服务器的新消息会显示在这里" /> : <div className="activity-list">{logs.data.slice(0, 6).map((entry) => <div key={entry.id}><StatusDot state={entry.level === 'error' ? 'bad' : entry.level === 'warning' ? 'warning' : 'good'} /><p>{entry.message}</p><time>{entry.time ? formatDate(entry.time) : '时间未记录'}</time></div>)}</div>}
        </Panel>
      </div>
    </>
  )
}

function PlayersPage({ refreshToken, overview, runAction }: PagesProps) {
  const players = useResource<Player[]>('/players', refreshToken)
  useEffect(() => {
    const timer = window.setInterval(() => { void players.reload() }, 5_000)
    return () => window.clearInterval(timer)
  }, [players.reload])
  return <><PageHeader title="玩家" description="查看当前在线玩家；在线时长从 Bridge 首次观测到该连接时计算" />
    <Panel className="table-panel">
      <ResourceBody resource={players} emptyTitle="当前没有玩家在线" emptyDescription="玩家加入服务器后会显示在这里">
        {(items) => <div className={`data-table player-table ${overview?.capabilities.playerActions ? 'player-actions-enabled' : ''}`}><div className="table-head"><span>玩家</span><span>所在星球</span><span>延迟</span><span>已观测在线</span>{overview?.capabilities.playerActions && <span>管理</span>}</div>{items.map((player) => <div className="table-row" key={player.id}><span className="primary-cell"><i className="avatar"><UserRound /></i><strong>{player.name}</strong></span><span data-label="所在星球">{player.planet || '未知'}</span><span data-label="延迟" className={player.pingMs !== null && player.pingMs > 160 ? 'text-warning' : ''}>{player.pingMs === null ? '—' : `${player.pingMs} ms`}</span><span data-label="已观测在线">{formatDuration(Math.max(0, (Date.now() - new Date(player.connectedAt).getTime()) / 1000))}</span>{overview?.capabilities.playerActions && <span className="player-action"><Button variant="quiet" disabled={Boolean(players.error)} onClick={() => runAction('kick-player', { playerId: player.id }, { title: `断开 ${player.name} 的连接？`, description: '此操作只断开所选的当前连接，玩家仍可以重新加入。游戏确认离线清理后才会显示完成。', label: '断开连接', danger: true })}>断开连接</Button></span>}</div>)}</div>}
      </ResourceBody>
    </Panel><PlayerHistory refreshToken={refreshToken} /></>
}

function VersionsPage({ refreshToken, runAction }: PagesProps) {
  const versions = useResource<ComponentVersion[]>('/versions', refreshToken)
  const locks = useResource<VersionLock[]>('/version-locks', refreshToken)
  return <><PageHeader title="版本" description="查看游戏、联机组件和管理面板的版本" />
    <ControlUpdates refreshToken={refreshToken} />
    <Panel className="table-panel">
      <ResourceBody resource={versions} emptyTitle="没有版本信息" emptyDescription="检查服务器配置后再试一次">
        {(items) => <div className="version-list">{items.map(component => <ComponentVersionCard key={component.id}
          component={component} locks={locks.error ? null : locks.data} runAction={runAction} />)}</div>}
      </ResourceBody>
    </Panel><UpdateHistory refreshToken={refreshToken} runAction={runAction} /></>
}

function ModsPage({ refreshToken, runAction }: PagesProps) {
  const mods = useResource<Mod[]>('/mods', refreshToken)
  const locks = useResource<VersionLock[]>('/version-locks', refreshToken)
  const [tab, setTab] = useState<'installed' | 'catalog' | 'config' | 'removed'>('installed')
  const [scope, setScope] = useState<'all' | Mod['side']>('all')
  const visible = useMemo(() => mods.data?.filter((mod) => scope === 'all' || mod.side === scope) || [], [mods.data, scope])
  return <><PageHeader title="模组" description="管理服务器和玩家需要的模组" actions={<div className="segmented" aria-label="模组视图"><button className={tab === 'installed' ? 'selected' : ''} onClick={() => setTab('installed')}>已安装</button><button className={tab === 'catalog' ? 'selected' : ''} onClick={() => setTab('catalog')}>发现模组</button><button className={tab === 'config' ? 'selected' : ''} onClick={() => setTab('config')}>配置</button><button className={tab === 'removed' ? 'selected' : ''} onClick={() => setTab('removed')}>已移除</button></div>} />
    {tab === 'removed' ? <ModRemovalHistory refreshToken={refreshToken} runAction={runAction} /> : tab === 'catalog' ? <Panel><ModCatalog refreshToken={refreshToken} runAction={runAction} /></Panel> : tab === 'config' ? <ModConfigEditor refreshToken={refreshToken} runAction={runAction} /> : <>
    <div className="mod-scope segmented" aria-label="模组范围">{([['all', '全部'], ['unknown', '待确认'], ['both', '双方'], ['server', '服务器'], ['client', '客户端']] as const).map(([value, label]) => <button key={value} className={scope === value ? 'selected' : ''} onClick={() => setScope(value)}>{label}</button>)}</div>
    <Panel className="table-panel">
      {mods.loading && !mods.data ? <LoadingBlock rows={6} /> : mods.error && !mods.data ? <ErrorBlock message={mods.error} retry={mods.reload} /> : !visible.length ? <EmptyBlock title="没有符合条件的模组" description="切换范围查看其他模组" /> : <div className="mod-list">{visible.map((mod) => <article key={mod.id}><div className="mod-status"><Box /></div><div className="mod-copy"><div><h2>{mod.name}</h2>{mod.required && <span className="required-label">必需</span>}</div><p>{mod.description}</p><span>版本 {mod.version} · {sideLabel(mod.side)}</span><ModSideControl mod={mod} runAction={runAction} />{mod.updateVersion && <small>可更新至 {mod.updateVersion}</small>}</div><div className="mod-actions">{/^[A-Za-z0-9_]+-[A-Za-z0-9_]+$/.test(mod.name) && <VersionLockButton packageId={mod.name} modId={mod.id} currentVersion={mod.version} locks={locks.error ? null : locks.data} runAction={runAction} />}{!mod.required && <Button variant="quiet" onClick={() => runAction('remove-mod', { modId: mod.id, expectedVersion: mod.version }, { title: `移除 ${mod.name}？`, description: '系统会保存模组恢复副本并保留配置。游戏运行中会先保存、备份和停服，移除后重新启动；其他模组依赖它时将停止操作。', label: '移除模组', danger: true })}>移除</Button>}<label className="switch"><input aria-label={`启用 ${mod.name}`} type="checkbox" checked={mod.enabled} disabled={mod.required} onChange={(event) => runAction('toggle-mod', { modId: mod.id, enabled: event.target.checked }, { title: `${event.target.checked ? '启用' : '停用'} ${mod.name}？`, description: '游戏运行中会先保存、备份并停服，变更后重新启动。若启动失败，会恢复原状态。请确认玩家使用相同的模组组合。', label: event.target.checked ? '启用模组' : '停用模组' })} /><span /></label></div></article>)}</div>}
    </Panel></>}</>
}

function SavesPage({ refreshToken, runAction, onJob }: PagesProps) {
  const saves = useResource<Save[]>('/saves', refreshToken)
  const backups = useResource<Backup[]>('/backups', refreshToken)
  return <><PageHeader title="存档" description="管理当前存档与可恢复的备份" actions={<Button variant="primary" icon={<Archive />} onClick={() => runAction('backup')}>立即备份</Button>} />
    <div className="split-grid">
      <Panel title="游戏存档" icon={<Database />}>
        <ResourceBody resource={saves} emptyTitle="没有找到存档" emptyDescription="游戏创建存档后会显示在这里">
          {(items) => <div className="file-list">{items.map((save) => <div key={save.id}><span className="file-icon"><FileArchive /></span><div><strong>{save.name}</strong><p>{formatBytes(save.bytes)} · {save.members.length} 个文件</p><small>修改于 {formatFullDate(save.modifiedAt)}</small></div>{save.current && <span className="current-label">当前使用</span>}<Button variant="quiet" icon={<Archive />} onClick={() => runAction('backup', { saveId: save.id })}>备份</Button></div>)}</div>}
        </ResourceBody>
      </Panel>
      <Panel title="备份" icon={<Archive />}>
        <ResourceBody resource={backups} emptyTitle="还没有备份" emptyDescription="创建备份后可随时在这里恢复">
          {(items) => <div className="file-list">{items.map((backup) => <div key={backup.id}><span className="file-icon"><ShieldCheck /></span><div><strong>{backup.saveName}</strong><p>{formatBytes(backup.bytes)} · {backup.members.length} 个文件</p><small>{formatFullDate(backup.createdAt)} · {backup.reason}</small></div><a className="icon-link" href={`/api/backups/${encodeURIComponent(backup.id)}/download`} aria-label={`下载 ${backup.saveName}`}><Download /></a><Button variant="quiet" icon={<RotateCcw />} onClick={() => runAction('restore', { backupId: backup.id }, { title: `恢复 ${backup.saveName}？`, description: '当前存档将被替换。系统会先为当前存档创建一份可恢复的备份。', label: '恢复备份', danger: true })}>恢复</Button></div>)}</div>}
        </ResourceBody>
      </Panel>
    </div><BackupImport onJob={onJob} /></>
}

function ClientsPage({ refreshToken, runAction }: PagesProps) {
  const packages = useResource<ClientPackage[]>('/client-packages', refreshToken)
  return <><PageHeader title="客户端" description="为玩家准备与服务器一致的客户端包" actions={<Button variant="primary" icon={<Box />} onClick={() => runAction('create-client-package')}>创建客户端包</Button>} />
    <div className="client-intro"><Gamepad2 /><div><h2>让新玩家快速加入</h2><p>配置包记录所需模组和连接地址。下载后将文件发给玩家，在 r2modman 中导入。</p></div></div>
    <Panel title="可下载的客户端包" icon={<CloudDownload />}>
      <ResourceBody resource={packages} emptyTitle="还没有客户端包" emptyDescription="点击上方按钮创建第一份客户端包">
        {(items) => <div className="package-list">{items.map((item) => <div key={item.id}><span className="package-icon"><Box /></span><div><strong>{item.name}</strong><p>{item.modCount} 个模组 · {formatBytes(item.bytes)}</p><small>创建于 {formatFullDate(item.createdAt)}</small></div><a className="button button-primary" href={item.downloadUrl || `/api/client-packages/${encodeURIComponent(item.id)}/download`}><Download /><span>下载</span></a></div>)}</div>}
      </ResourceBody>
    </Panel></>
}

function ServerPage({ refreshToken, overview: streamedOverview, onOverview, runAction }: PagesProps) {
  const overviewResource = useResource<Overview>('/overview', refreshToken)
  const logs = useResource<LogEntry[]>('/logs', refreshToken)
  const [logLevel, setLogLevel] = useState('all')
  const [logSearch, setLogSearch] = useState('')
  useEffect(() => {
    const timer = window.setTimeout(() => void logs.reload(), 5000)
    return () => window.clearTimeout(timer)
  }, [logs.reload])
  const filteredLogs = logs.data?.filter((entry) => (logLevel === 'all' || entry.level === logLevel) && entry.message.toLocaleLowerCase().includes(logSearch.toLocaleLowerCase())) ?? []
  const overview = streamedOverview || overviewResource.data
  useEffect(() => { if (overviewResource.data) onOverview(overviewResource.data) }, [overviewResource.data, onOverview])
  const running = overview?.state === 'running'
  return <><PageHeader title="服务器" description="启动、保存和停止游戏服务器" />
    {!overview ? (overviewResource.loading ? <LoadingBlock /> : <ErrorBlock message={overviewResource.error || '未收到服务器状态'} retry={overviewResource.reload} />) : <>
      <Panel className="server-control-panel">
        <div className="server-control-status"><span className="server-control-icon"><ServerIcon /></span><div><span><StatusDot state={running ? 'good' : overview.state === 'unknown' ? 'warning' : 'muted'} />{serverStateLabels[overview.state]}</span><h2>{overview.name}</h2><p><Wifi />{overview.address}</p></div></div>
        <div className="server-control-actions">
          {!running && <Button variant="primary" icon={<Play />} disabled={!overview.capabilities.lifecycle} onClick={() => runAction('start')}>启动服务器</Button>}
          <Button icon={<SaveIcon />} disabled={!running || !overview.capabilities.save} onClick={() => runAction('save')}>保存游戏</Button>
          {running && <Button icon={<RefreshCw />} disabled={!overview.capabilities.lifecycle} onClick={() => runAction('restart', {}, { title: '重新启动服务器？', description: '在线玩家会暂时断开。系统会先保存游戏，再重新启动服务器。', label: '重新启动', danger: true })}>重新启动</Button>}
          {running && <Button variant="danger" icon={<Square />} disabled={!overview.capabilities.lifecycle} onClick={() => runAction('stop', {}, { title: '停止服务器？', description: '在线玩家会断开。系统会先保存游戏，然后安全停止服务器。', label: '停止服务器', danger: true })}>停止服务器</Button>}
        </div>
      </Panel>
      <div className="server-facts"><Fact label="运行时间" value={running ? formatDuration(overview.uptimeSeconds) : '—'} icon={<Clock3 />} /><Fact label="进程" value={overview.pid ? '正在运行' : '未运行'} icon={<Power />} /><Fact label="当前存档" value={overview.currentSave || '未识别'} icon={<Database />} /><Fact label="最近保存" value={formatDate(overview.lastSavedAt)} icon={<TimerReset />} /></div>
    </>}
    <RuntimeStatusPanel refreshToken={refreshToken} />
    <Panel title="运行记录" icon={<Activity />} action={<a className="button button-quiet" href="/api/logs/download"><Download /><span>下载日志</span></a>}>
      <div className="log-filters"><label><span>级别</span><select value={logLevel} onChange={(event) => setLogLevel(event.target.value)}><option value="all">全部级别</option><option value="info">信息</option><option value="warning">提醒</option><option value="error">错误</option></select></label><label><span>搜索日志</span><input type="search" value={logSearch} onChange={(event) => setLogSearch(event.target.value)} placeholder="输入关键词" /></label><small>每 5 秒刷新</small></div>
      <ResourceBody resource={logs} emptyTitle="暂无运行记录" emptyDescription="服务器开始运行后会显示新消息">
        {() => filteredLogs.length ? <div className="log-list">{filteredLogs.map((entry) => <div key={entry.id}><time>{entry.time ? formatFullDate(entry.time) : '时间未记录'}</time><span className={`log-level log-${entry.level}`}>{entry.level === 'error' ? '错误' : entry.level === 'warning' ? '提醒' : '信息'}</span><p>{entry.message}</p></div>)}</div> : <EmptyBlock title="没有匹配的记录" description="调整级别或关键词查看其他记录" />}
      </ResourceBody>
    </Panel>
  </>
}

const gameSettingKeys = ['serverName', 'address', 'maxPlayers', 'targetUps', 'autosaveMinutes', 'backupKeep'] as const
function sameGameSettings(left: GameSettings | null, right: GameSettings | null) {
  return left === right || Boolean(left && right && gameSettingKeys.every(key => left[key] === right[key]))
}

function SettingsPage({ refreshToken, runAction }: PagesProps) {
  const resource = useResource<GameSettings>('/settings', refreshToken)
  const [form, setForm] = useState<GameSettings | null>(null)
  const [baseForm, setBaseForm] = useState<GameSettings | null>(null)
  const dirty = !sameGameSettings(form, baseForm)
  useEffect(() => {
    if (resource.data && (!dirty || sameGameSettings(resource.data, form))) {
      setForm(resource.data); setBaseForm(resource.data)
    }
  }, [resource.data, dirty, form])
  const update = <K extends keyof GameSettings>(key: K, value: GameSettings[K]) => setForm((current) => current ? { ...current, [key]: value } : current)
  return <><PageHeader title="设置" description="调整面板信息、游戏启动参数与备份保留数量" />
    {!form ? resource.loading ? <LoadingBlock /> : <ErrorBlock message={resource.error || '未读取到设置'} retry={resource.reload} /> : <form className="settings-form" onSubmit={(event) => { event.preventDefault(); const { readOnlyFields: _readOnlyFields, ...settings } = form; runAction('write-settings', { settings }, { title: '保存服务器设置？', description: '启动参数在下次启动游戏时生效，面板信息和备份设置立即生效。', label: '保存设置' }) }}>
      <Panel title="基本信息" icon={<Settings2 />}>
        <div className="form-grid"><Field label="服务器名称" hint="显示在此管理面板中的名称"><input value={form.serverName} onChange={(event) => update('serverName', event.target.value)} maxLength={80} required /></Field><Field label="连接地址" hint="玩家用于加入服务器的地址"><input value={form.address} onChange={(event) => update('address', event.target.value)} required /></Field></div>
      </Panel>
      <Panel title="游戏与保存" icon={<Gamepad2 />}>
        <div className="form-grid form-grid-four"><NumberField label="最多玩家" value={form.maxPlayers} disabled={form.readOnlyFields?.includes('maxPlayers')} min={1} max={64} onChange={(value) => update('maxPlayers', value)} /><NumberField label="每秒更新" value={form.targetUps} disabled={form.readOnlyFields?.includes('targetUps')} min={10} max={240} onChange={(value) => update('targetUps', value)} /><NumberField label="自动保存（分钟）" value={form.autosaveMinutes} disabled={form.readOnlyFields?.includes('autosaveMinutes')} min={1} max={120} onChange={(value) => update('autosaveMinutes', value)} /><NumberField label="保留备份" value={form.backupKeep} min={1} max={500} onChange={(value) => update('backupKeep', value)} /></div>
        {Boolean(form.readOnlyFields?.length) && <p className="settings-note">灰色参数暂不支持由当前游戏或启动任务修改。</p>}
      </Panel>
      {dirty && baseForm && <details className="settings-preview"><summary>查看设置更改</summary><dl>{([['serverName', '服务器名称'], ['address', '连接地址'], ['maxPlayers', '最多玩家'], ['targetUps', '目标 UPS'], ['autosaveMinutes', '自动保存间隔'], ['backupKeep', '保留备份']] as const).filter(([key]) => form[key] !== baseForm[key]).map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{String(baseForm[key] ?? '—')} → {String(form[key] ?? '—')}</dd></div>)}</dl></details>}
      <div className="settings-actions"><Button type="button" disabled={!dirty} onClick={() => { if (resource.data) { setForm(resource.data); setBaseForm(resource.data) } }}>撤销更改</Button><Button type="submit" disabled={!dirty} variant="primary" icon={<SaveIcon />}>保存设置</Button></div>
    </form>}
    <SettingsHistory refreshToken={refreshToken} dirty={dirty} runAction={runAction} />
    <RuntimeSettingsPanel refreshToken={refreshToken} />
  </>
}

function ActivityPage({ refreshToken }: PagesProps) {
  const jobs = useResource<Job[]>('/jobs', refreshToken)
  const logs = useResource<LogEntry[]>('/logs', refreshToken)
  const [tab, setTab] = useState<'operations' | 'logs'>('operations')
  return <><PageHeader title="活动" description="查看管理操作和服务器消息" actions={<div className="segmented"><button className={tab === 'operations' ? 'selected' : ''} onClick={() => setTab('operations')}>管理操作</button><button className={tab === 'logs' ? 'selected' : ''} onClick={() => setTab('logs')}>服务器消息</button></div>} />
    <Panel className="table-panel">
      {tab === 'operations' ? <ResourceBody resource={jobs} emptyTitle="还没有管理操作" emptyDescription="启动、保存或备份后会记录在这里">{(items) => <div className="job-history">{items.map((job) => <article key={job.id}><div className="job-history-head"><span className={`operation-icon operation-${job.state}`}>{job.state === 'succeeded' ? <CheckCircle2 /> : job.state === 'failed' || job.state === 'interrupted' ? <Square /> : <RefreshCw />}</span><div><h2>{actionLabels[job.action]}</h2><p>{formatJobResult(job) || job.message || jobStateLabels[job.state]}</p></div><span className={`job-state state-${job.state}`}>{jobStateLabels[job.state]}</span><time>{formatFullDate(job.createdAt)}</time></div>{job.steps.length > 0 && <details><summary>查看 {job.steps.length} 个步骤</summary><ol>{job.steps.map((step, index) => <li key={`${step.time}-${index}`}><time>{formatDate(step.time)}</time><span>{step.message}</span></li>)}</ol></details>}</article>)}</div>}</ResourceBody>
        : <ResourceBody resource={logs} emptyTitle="暂无服务器消息" emptyDescription="服务器的新消息会显示在这里">{(items) => <div className="log-list">{items.map((entry) => <div key={entry.id}><time>{entry.time ? formatFullDate(entry.time) : '时间未记录'}</time><span className={`log-level log-${entry.level}`}>{entry.level === 'error' ? '错误' : entry.level === 'warning' ? '提醒' : '信息'}</span><p>{entry.message}</p></div>)}</div>}</ResourceBody>}
    </Panel></>
}

function ResourceBody<T>({ resource, emptyTitle, emptyDescription, children }: { resource: ReturnType<typeof useResource<T>>; emptyTitle: string; emptyDescription: string; children: (data: T & { length: number }) => ReactNode }) {
  if (resource.loading && !resource.data) return <LoadingBlock rows={5} />
  if (resource.error && !resource.data) return <ErrorBlock message={resource.error} retry={resource.reload} />
  const data = resource.data as (T & { length: number }) | null
  if (!data?.length) return <EmptyBlock title={emptyTitle} description={emptyDescription} />
  return <>{children(data)}</>
}

function DataRows({ rows }: { rows: Array<[string, string]> }) { return <div className="data-rows">{rows.map(([label, value]) => <div key={label}><span>{label}</span><strong>{value || '—'}</strong></div>)}</div> }
function Fact({ label, value, icon }: { label: string; value: string; icon: ReactNode }) { return <div className="fact">{icon}<span>{label}</span><strong>{value}</strong></div> }
function sideLabel(side: Mod['side']) { return side === 'both' ? '服务器与客户端' : side === 'server' ? '仅服务器' : side === 'client' ? '仅客户端' : '适用端待确认' }
function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) { return <label className="field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label> }
function NumberField({ label, value, min, max, disabled, onChange }: { label: string; value: number | null; min: number; max: number; disabled?: boolean; onChange: (value: number) => void }) { return <Field label={label}><input type="number" value={value ?? ''} placeholder="不可用" disabled={disabled || value === null} min={min} max={max} onChange={(event) => onChange(Number(event.target.value))} required /></Field> }
