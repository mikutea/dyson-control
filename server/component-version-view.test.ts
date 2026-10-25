import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ComponentVersion } from '../shared/contracts.js'
import { ComponentVersionCard } from '../web/src/ComponentVersionCard.js'

const fixture: ComponentVersion = {
  id: 'bepinex', name: 'BepInEx', current: 'unknown', runtimeVersion: '5.4.17.0',
  latest: '5.4.17', checkedAt: null, channel: 'Thunderstore', canInstall: true, note: 'fixture'
}
function render(changes: Partial<ComponentVersion> = {}) {
  return renderToStaticMarkup(createElement(ComponentVersionCard, { component: { ...fixture, ...changes }, locks: [], runAction: () => undefined }))
}

describe('component version display', () => {
  it('shows verified runtime evidence without mistaking it for a package update or a lockable version', () => {
    const html = render()
    expect(html).toContain('<dt>当前运行版本</dt><dd>5.4.17.0</dd>')
    expect(html).toContain('<dt>安装包版本</dt><dd>未记录</dd>')
    expect(html).toContain('版本待核验')
    expect(html).not.toContain('unknown')
    expect(html).not.toContain('可更新')
    expect(html).not.toContain('已是最新版本')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*?锁定版本/)
    expect(html).toContain('安装最新版本')
  })

  it('compares exact package versions even when runtime versions have an extra revision', () => {
    const html = render({ current: '5.4.17' })
    expect(html).toContain('<dt>安装包版本</dt><dd>5.4.17</dd>')
    expect(html).toContain('已是最新版本')
    expect(html).not.toContain('可更新')
    expect(html).not.toContain('disabled=""')
    expect(html).not.toContain('安装更新')
    expect(render({ current: '5.4.16' })).toContain('可更新')
  })

  it('does not present an installed version as running when runtime evidence is absent', () => {
    const html = render({ current: '5.4.17', runtimeVersion: null, latest: null, canInstall: false })
    expect(html).toContain('<dt>当前运行版本</dt><dd>未核验</dd>')
    expect(html).toContain('<dt>安装包版本</dt><dd>5.4.17</dd>')
    expect(html).toContain('未检查更新')
    expect(html).not.toContain('已是最新版本')
    expect(html).not.toContain('安装更新')
  })
})
