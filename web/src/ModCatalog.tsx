import { useState } from 'react'
import { CloudDownload, Search } from 'lucide-react'
import type { ModCatalogEntry } from '../../shared/contracts'
import type { RunAction } from './App'
import { Button, EmptyBlock, ErrorBlock, LoadingBlock } from './components'
import { useResource } from './hooks'

export function ModCatalog({ refreshToken, runAction }: { refreshToken: number; runAction: RunAction }) {
  const [text, setText] = useState('')
  const [search, setSearch] = useState('')
  const catalog = useResource<ModCatalogEntry[]>(`/mod-catalog?search=${encodeURIComponent(search)}`, refreshToken)
  return <div className="mod-catalog">
    <form className="catalog-search" onSubmit={(event) => { event.preventDefault(); if (text.trim() === search) void catalog.reload(); else setSearch(text.trim()) }}>
      <label><span>搜索模组</span><input type="search" value={text} onChange={(event) => setText(event.target.value)} maxLength={128} placeholder="名称、作者或关键词" /></label>
      <Button type="submit" icon={<Search />}>搜索</Button>
    </form>
    <p className="catalog-hint">从 Thunderstore 查找模组。安装时会一并处理依赖；多人兼容性请以模组作者说明为准。</p>
    {catalog.loading && !catalog.data ? <LoadingBlock rows={4} /> : catalog.error ? <ErrorBlock message={catalog.error} retry={catalog.reload} /> : !catalog.data?.length ? <EmptyBlock title="没有找到模组" description="试试其他名称或关键词" /> : <div className="catalog-list">{catalog.data.map((mod) => <article key={mod.package}>
      <div className="catalog-copy"><h3>{mod.name}</h3><p>{mod.description}</p><small>{mod.owner} · {mod.latestVersion} · {mod.dependencies.length} 项依赖{mod.installedVersion ? ` · 已安装 ${mod.installedVersion}` : ''}</small></div>
      <div className="catalog-actions">
        {mod.packageUrl && <a href={mod.packageUrl} target="_blank" rel="noreferrer" className="button button-quiet">作者说明</a>}
        <Button icon={<CloudDownload />} disabled={mod.installedVersion === mod.latestVersion} onClick={() => runAction('install-mod', { package: mod.package, version: mod.latestVersion }, {
          title: `安装 ${mod.name}？`, description: `将安装 ${mod.latestVersion} 和所需依赖。运行中的游戏会先保存并备份，再停服安装和重新启动。`, label: '安装模组', danger: true
        })}>{mod.installedVersion === mod.latestVersion ? '已安装' : mod.installedVersion ? '更新模组' : '安装'}</Button>
      </div>
    </article>)}</div>}
  </div>
}
