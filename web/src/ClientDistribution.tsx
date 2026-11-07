import { useEffect, useRef, useState } from 'react'
import { FileText } from 'lucide-react'
import type { ClientPackage, ClientPackageDetails } from '../../shared/contracts'
import { api } from './api'
import { Button } from './components'
import { downloadText } from './download-text'

export function ClientJoinGuide({ item, digest }: { item: ClientPackage; digest: string }) {
  const active = useRef<AbortController | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => () => active.current?.abort(), [])

  const download = async () => {
    if (active.current) return
    const request = new AbortController()
    active.current = request
    setBusy(true)
    setError('')
    try {
      const details = await api<ClientPackageDetails>('/client-packages/' + encodeURIComponent(item.id), { signal: request.signal })
      if (details.id !== item.id || !details.downloadable || details.status !== 'current' || !details.profile || details.sha256 !== digest) {
        throw new Error('所选包与当前配置的匹配状态已变化。请刷新客户端页后重新核对。')
      }
      const { address, mods } = details.profile
      const guide = [
        '戴森球计划 · 多人联机入服说明', '',
        '游戏地址  ' + address,
        '客户端配置包  ' + item.name,
        '文件大小  ' + item.bytes + ' 字节',
        'SHA-256  ' + digest, '',
        '1. 准备与服务器版本一致的正版戴森球计划。将配置包保存到本机。',
        '2. 在 PowerShell 运行下面的命令，并按提示输入配置包的完整路径。核对结果与上方 SHA-256 一致。',
        "(Get-FileHash -Algorithm SHA256 -LiteralPath (Read-Host '请输入配置包的完整路径')).Hash", '',
        '3. 在 r2modman 选择 Dyson Sphere Program。在配置选择页点 Import / Update → From file，选择上方 .r2z。在 Packages to be installed 页核对下面列出的版本，点 Import → Import new profile。确认配置名后点 Create，并等待所有模组下载完成。',
        '4. 选中刚导入的配置，点击 Start modded。进入 Nebula 多人联机界面，使用游戏地址 ' + address + ' 加入。有密码时向管理员取得，密码不包含在配置包中。',
        '5. 等待世界和出生星球加载完成。需要重连时，退出联机并返回菜单，再用同一配置和地址加入；连接中断时先确认提示，再重新加入。',
        '如果提示游戏或模组版本不匹配，先核对服务器当前版本并取得对应配置包。重连时保持原有模组版本。', '',
        '配置包锁定的模组版本', ...mods.map(mod => mod.name + '  ' + mod.version), '',
      ].join('\r\n')
      downloadText(item.name.replace(/\.r2z$/i, '') + '-入服说明.txt', guide)
    } catch (reason) {
      if (!request.signal.aborted) setError(reason instanceof Error ? reason.message : '无法生成入服说明。')
    } finally {
      active.current = null
      if (!request.signal.aborted) setBusy(false)
    }
  }
  return <div className="client-guide">
    <Button icon={<FileText />} busy={busy} onClick={() => void download()}>下载入服说明</Button>
    {error && <p className="text-danger" role="alert">{error}</p>}
  </div>
}

export function ClientFileCheck({ digest, bytes }: { digest: string; bytes: number }) {
  const latest = useRef(0)
  const [result, setResult] = useState('')
  const compare = async (file: File | undefined) => {
    const selection = ++latest.current
    if (!file) { setResult(''); return }
    if (file.size !== bytes) {
      setResult('文件大小不同。所选包为 ' + bytes + ' 字节，本地文件为 ' + file.size + ' 字节。')
      return
    }
    setResult('正在核对文件…')
    try {
      const hash = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
      if (selection !== latest.current) return
      const actual = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('')
      setResult(actual === digest ? '文件与所选包完全一致。' : '文件大小相同，但 SHA-256 不一致。请重新取得所选包。')
    } catch {
      if (selection === latest.current) setResult('无法读取所选文件，请重新选择。')
    }
  }
  return <details className="client-digest">
    <summary>文件 SHA-256 与本地核对</summary><code>{digest}</code>
    {globalThis.crypto?.subtle ? <label className="client-check-file">选择本机的配置包进行比对，文件只在浏览器中读取。
      <input aria-label="选择要核对的客户端包" type="file" accept=".r2z,.zip" onChange={event => void compare(event.target.files?.[0])} />
    </label> : <p>可在 Windows PowerShell 用 <code>Get-FileHash -Algorithm SHA256 -LiteralPath (Read-Host '配置包路径')</code> 核对文件。</p>}
    {result && <p role="status">{result}</p>}
  </details>
}
